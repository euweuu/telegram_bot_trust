require('dotenv').config();
const http    = require('http');
const { Telegraf, Markup } = require('telegraf');

const db  = require('./services/db');
const fmt = require('./utils/format');

// WEBHOOK_URL must be the public HTTPS URL of this service on Render,
// e.g. https://your-service-name.onrender.com
const WEBHOOK_URL    = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';   // optional extra security
const PORT           = process.env.PORT || 3000;

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
  ['Профіль'],
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
    '<b>Сьогодні / Тиждень / Місяць</b> — поїздки за обраний період',
    '<b>Профіль</b> — інформація про акаунт',
    '',
    '⚠️ Відключити Telegram можна тільки через сайт (Профіль → Telegram).',
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

// ─── Trip completion notifications ───────────────────────────────────────────

async function notifyTripCompleted(trip) {
  try {
    const telegramId = await db.getDriverTelegramId(trip.driver_id);
    if (!telegramId) return; // driver not linked to Telegram

    const distance = Math.max(0, (trip.end_mileage || 0) - (trip.start_mileage || 0));
    const amount   = Math.round(distance * (trip.tariff || 0));
    const dateStr  = trip.date
      ? new Date(trip.date).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '—';

    const msg = [
      `✅ <b>Поїздку завершено!</b>`,
      fmt.divider(),
      `📅 Дата:    ${fmt.bold(dateStr)}`,
      `📍 Маршрут: ${fmt.bold(trip.route || '—')}`,
      `🛣 Пробіг:  ${fmt.bold(distance + ' км')}`,
      `         (${trip.start_mileage} → ${trip.end_mileage})`,
      `💰 Сума:   ${fmt.bold(amount.toLocaleString('uk-UA') + ' грн')}`,
    ].join('\n');

    await bot.telegram.sendMessage(telegramId, msg, { parse_mode: 'HTML' });
    console.log(`Notification sent to telegramId=${telegramId} for trip id=${trip.id}`);
  } catch (e) {
    console.error('Failed to send trip completion notification:', e.message);
  }
}

function startRealtimeListener() {
  db.supabase
    .channel('trips-overnight-completed')
    .on('postgres_changes', {
      event:  'UPDATE',
      schema: 'public',
      table:  'trips',
      filter: 'is_overnight=eq.true',
    }, (payload) => {
      const { new: newRow, old: oldRow } = payload;
      console.log(`[Realtime] trip UPDATE id=${newRow.id} | old.end_mileage=${oldRow.end_mileage} | new.end_mileage=${newRow.end_mileage}`);

      if ((oldRow.end_mileage == null) && (newRow.end_mileage != null)) {
        console.log(`[Realtime] Triggering notification for trip id=${newRow.id}`);
        notifyTripCompleted(newRow);
      }
    })
    .subscribe((status, err) => {
      console.log('Realtime subscription status:', status);
      if (err) console.error('Realtime subscription error:', err.message);
    });
}

// ─── Webhook server + launch ──────────────────────────────────────────────────

async function start() {
  if (WEBHOOK_URL) {
    // ── Webhook mode (production on Render) ───────────────────────────────────
    const webhookPath = `/webhook/${process.env.BOT_TOKEN}`;
    const callbackUrl = `${WEBHOOK_URL}${webhookPath}`;

    // Ask Telegraf to create the middleware that processes incoming updates
    const webhookHandler = await bot.createWebhook({
      domain:      WEBHOOK_URL,
      path:        webhookPath,
      secret_token: WEBHOOK_SECRET || undefined,
    });

    // One HTTP server: handles both the webhook path and a /health check
    const server = http.createServer(async (req, res) => {
      if (req.url.startsWith(webhookPath) && req.method === 'POST') {
        await webhookHandler(req, res);
      } else {
        res.writeHead(200);
        res.end('OK');
      }
    });

    server.listen(PORT, () => {
      console.log(`Webhook server listening on port ${PORT}`);
      console.log(`Webhook registered at ${callbackUrl}`);
    });

    startRealtimeListener();

  } else {
    // ── Polling mode (local development) ─────────────────────────────────────
    console.log('WEBHOOK_URL not set — falling back to long polling (local dev mode)');
    await bot.launch();
    const name = bot.botInfo?.username ? `@${bot.botInfo.username}` : '...';
    console.log(`Bot started (polling): ${name}`);
    startRealtimeListener();
  }
}

start().catch(e => {
  console.error('Startup error:', e.message);
  process.exit(1);
});

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
