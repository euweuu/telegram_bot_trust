require('dotenv').config();
const http = require('http');
const { Telegraf, Markup } = require('telegraf');

const db  = require('./services/db');
const fmt = require('./utils/format');

if (!process.env.BOT_TOKEN || process.env.BOT_TOKEN === 'ВСТАВЬТЕ_ВАШ_ТОКЕН_ТУТ') {
  console.error('BOT_TOKEN не вказаний у файлі .env'); process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// ─── Session cache ────────────────────────────────────────────────────────────

const sessions = new Map();

async function getSession(telegramId) {
  const cached = sessions.get(String(telegramId));
  if (cached) return cached;
  const linked = await db.getLinkedDriver(telegramId);
  if (!linked) return null;
  const session = { driverId: linked.driverId, driverName: linked.driverName };
  sessions.set(String(telegramId), session);
  return session;
}

function setSession(id, data) { sessions.set(String(id), data); }
function clearSession(id)     { sessions.delete(String(id)); }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildName(from) {
  if (from.username) return `@${from.username}`;
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || String(from.id);
}

function periodLabel(p) {
  return {
    today:      'сьогодні',
    week:       'цей тиждень',
    month:      'цей місяць',
    last_month: 'минулий місяць',
  }[p] || p;
}

// ─── Keyboard ─────────────────────────────────────────────────────────────────

const mainMenu = Markup.keyboard([
  ['Мої поїздки', 'Статистика'],
  ['За місяць',   'Минулий місяць'],
  ['Цей тиждень', 'Сьогодні'],
  ['Профіль',    'Відключити Telegram'],
]).resize();

// ─── /start ───────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const userId     = ctx.from.id;
  const startParam = ctx.startPayload;

  if (startParam && startParam.length >= 6) {
    await ctx.reply('Перевіряємо код...');
    try {
      const { driverId, driverName } = await db.validateLinkToken(startParam);
      await db.linkTelegramUser(userId, driverId, buildName(ctx.from));
      await db.consumeToken(startParam);
      setSession(userId, { driverId, driverName });
      await ctx.reply(
        `Прив'язано успішно!\n\nВи увійшли як: <b>${fmt.escapeHtml(driverName)}</b>\n\nОберіть дію:`,
        { parse_mode: 'HTML', ...mainMenu }
      );
    } catch (e) {
      await ctx.reply(
        `Помилка: ${fmt.escapeHtml(e.message)}\n\nПерейдіть на сайт — Профіль — Telegram щоб отримати новий код.`,
        { parse_mode: 'HTML' }
      );
    }
    return;
  }

  const session = await getSession(userId);
  if (session) {
    await ctx.reply(
      `З поверненням, <b>${fmt.escapeHtml(session.driverName)}</b>! Оберіть дію:`,
      { parse_mode: 'HTML', ...mainMenu }
    );
    return;
  }

  await ctx.reply(
    'Цей бот — система обліку пробігу.\n\n' +
    'Щоб увійти, перейдіть на сайт — <b>Профіль — Telegram</b> і натисніть "Підключити".',
    { parse_mode: 'HTML', ...Markup.removeKeyboard() }
  );
});

// ─── /help ────────────────────────────────────────────────────────────────────

bot.command('help', async (ctx) => {
  await ctx.reply([
    '<b>Доступні дії:</b>', '',
    '<b>Мої поїздки</b> — останні 10 поїздок',
    '<b>Статистика</b> — пробіг та сума за місяць',
    '<b>Сьогодні / Тиждень / Місяць</b> — поїздки за period',
    '<b>Профіль</b> — інформація про акаунт',
    '<b>Відключити Telegram</b> — скасувати прив\'язку',
  ].join('\n'), { parse_mode: 'HTML' });
});

// ─── Text handler ─────────────────────────────────────────────────────────────

bot.on('text', async (ctx) => {
  const userId  = ctx.from.id;
  const text    = ctx.message.text.trim();
  const session = await getSession(userId);

  if (!session) {
    await ctx.reply(
      'Ваш Telegram ще не прив\'язаний.\n\nПерейдіть на сайт — <b>Профіль — Telegram</b>.',
      { parse_mode: 'HTML', ...Markup.removeKeyboard() }
    );
    return;
  }

  switch (text) {

    case 'Мої поїздки': {
      await ctx.reply('Завантаження...');
      try {
        const trips = await db.getDriverRecentTrips(session.driverId, 10);
        const msg   = fmt.formatTripList(
          trips,
          `<b>Останні 10 поїздок</b> — ${fmt.escapeHtml(session.driverName)}`
        );
        await ctx.reply(msg, { parse_mode: 'HTML' });
      } catch (e) { await ctx.reply(`Помилка: ${e.message}`); }
      break;
    }

    case 'Статистика': {
      await ctx.reply('Завантаження...');
      try {
        const { start, end } = db.getDateRange('month');
        const trips = await db.getDriverTrips(session.driverId, start, end);
        const stats = db.calcStats(trips);
        await ctx.reply(
          fmt.formatStats(stats, `Статистика — ${session.driverName} (цей місяць)`),
          { parse_mode: 'HTML' }
        );
      } catch (e) { await ctx.reply(`Помилка: ${e.message}`); }
      break;
    }

    case 'Сьогодні':       await handlePeriod(ctx, 'today',      session); break;
    case 'Цей тиждень':    await handlePeriod(ctx, 'week',       session); break;
    case 'За місяць':      await handlePeriod(ctx, 'month',      session); break;
    case 'Минулий місяць': await handlePeriod(ctx, 'last_month', session); break;

    case 'Профіль': {
      await ctx.reply([
        `<b>Профіль</b>`,
        fmt.divider(),
        `Ім'я:     ${fmt.bold(session.driverName)}`,
        `Telegram:  ${fmt.mono(buildName(ctx.from))}`,
        `ID:        ${fmt.mono(String(userId))}`,
      ].join('\n'), { parse_mode: 'HTML' });
      break;
    }

    case 'Відключити Telegram':
    case '\u0412\u0456\u0434\u2019\u0454\u0434\u043d\u0430\u0442\u0438 Telegram': {
      try {
        await db.unlinkTelegramUser(userId);
        clearSession(userId);
        await ctx.reply(
          'Telegram відключено.\n\nЩоб підключитися знову — перейдіть на сайт — Профіль — Telegram.',
          Markup.removeKeyboard()
        );
      } catch (e) { await ctx.reply(`Помилка: ${e.message}`); }
      break;
    }

    default:
      break;
  }
});

// ─── Period handler ───────────────────────────────────────────────────────────

async function handlePeriod(ctx, period, session) {
  await ctx.reply('Завантаження...');
  const label = periodLabel(period);
  try {
    const { start, end } = db.getDateRange(period);
    const trips = await db.getDriverTrips(session.driverId, start, end);
    const stats = db.calcStats(trips);
    await ctx.reply(
      fmt.formatStats(stats, `${session.driverName} — ${label}`),
      { parse_mode: 'HTML' }
    );
    if (trips.length > 0) {
      await ctx.reply(
        fmt.formatTripList(trips.slice(0, 10), `<b>Поїздки — ${label}</b>`),
        { parse_mode: 'HTML' }
      );
    }
  } catch (e) { await ctx.reply(`Помилка: ${e.message}`); }
}

// ─── Error handler ────────────────────────────────────────────────────────────

bot.catch((err, ctx) => {
  console.error(`Error [${ctx.from?.id}]:`, err.message);
  ctx.reply('Виникла помилка. Спробуйте /start').catch(() => {});
});

// ─── Health-check HTTP server (required by Render web services) ──────────────

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
}).listen(PORT, () => {
  console.log(`Health-check server listening on port ${PORT}`);
});

// ─── Launch ───────────────────────────────────────────────────────────────────

bot.launch().then(() => {
  const name = bot.botInfo?.username ? `@${bot.botInfo.username}` : '...';
  console.log(`Bot started: ${name}`);
}).catch(e => {
  console.error('Launch error:', e.message);
  process.exit(1);
});

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
