require('dotenv').config();
const http = require('http');
const { Telegraf, Markup } = require('telegraf');

const db = require('./services/db');
const fmt = require('./utils/format');

// WEBHOOK_URL must be the public HTTPS URL of this service on Render,
// e.g. https://your-service-name.onrender.com
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';   // optional extra security
const PORT = process.env.PORT || 3000;

if (!process.env.BOT_TOKEN || process.env.BOT_TOKEN === 'ВСТАВЬТЕ_ВАШ_ТОКЕН_ТУТ') {
  console.error('BOT_TOKEN не вказаний у файлі .env');
  process.exit(1);
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

function setSession(id, data) {
  sessions.set(String(id), data);
}

// ─── Rate limiting ────────────────────────────────────────────────────────────
const rateLimit = new Map();

async function checkRateLimit(userId) {
  const now = Date.now();
  const userLimit = rateLimit.get(userId) || [];
  const recent = userLimit.filter(t => now - t < 1000);

  if (recent.length >= 2) {
    throw new Error('Занадто багато запитів. Зачекайте трохи.');
  }

  recent.push(now);
  rateLimit.set(userId, recent);

  setTimeout(() => {
    const current = rateLimit.get(userId);
    if (current) {
      const filtered = current.filter(t => now - t < 1000);
      if (filtered.length === 0) {
        rateLimit.delete(userId);
      } else {
        rateLimit.set(userId, filtered);
      }
    }
  }, 5000);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildName(from) {
  if (from.username) return `@${from.username}`;
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || String(from.id);
}

function periodLabel(p) {
  return {
    today: 'сьогодні',
    week: 'цей тиждень',
    month: 'цей місяць',
    last_month: 'минулий місяць',
  }[p] || p;
}

// ─── Keyboard ─────────────────────────────────────────────────────────────────
const mainMenu = Markup.keyboard([
  ['Мої поїздки', 'Статистика'],
  ['За місяць', 'Минулий місяць'],
  ['Цей тиждень', 'Сьогодні'],
  ['Профіль'],
]).resize();

// ─── /start ───────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const userId = ctx.from.id;
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
    '<b>Статистика</b> — пробіг за місяць',
    '<b>Сьогодні / Тиждень / Місяць</b> — поїздки за обраний період',
    '<b>Профіль</b> — інформація про акаунт',
    '',
    '⚠️ Відключити Telegram можна тільки через сайт euweuu.github.io/mileage-tracker/ (Профіль → Telegram).',
  ].join('\n'), { parse_mode: 'HTML' });
});

// ─── Text handler ─────────────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  try {
    await checkRateLimit(userId);
  } catch (e) {
    await ctx.reply(e.message);
    return;
  }

  const session = await getSession(userId);

  if (!session) {
    await ctx.reply(
      'Ваш Telegram ще не прив\'язаний.\n\nПерейдіть на сайт euweuu.github.io/mileage-tracker/ — <b>Профіль — Telegram</b>.',
      { parse_mode: 'HTML', ...Markup.removeKeyboard() }
    );
    return;
  }

  switch (text) {
    case 'Мої поїздки': {
      await ctx.reply('Завантаження...');
      try {
        const trips = await db.getDriverRecentTrips(session.driverId, 10);
        const msg = fmt.formatTripList(
          trips,
          `<b>Останні 10 поїздок</b> — ${fmt.escapeHtml(session.driverName)}`
        );
        await ctx.reply(msg, { parse_mode: 'HTML' });
      } catch (e) {
        await ctx.reply(`Помилка: ${e.message}`);
      }
      break;
    }

    case 'Статистика': {
      await ctx.reply('Завантаження...');
      try {
        const { start, end } = db.getDateRange('month');
        const trips = await db.getDriverTrips(session.driverId, start, end);
        const stats = db.calcStats(trips);
        await ctx.reply(
          fmt.formatStatsWithoutAmount(stats, `Статистика — ${session.driverName} (цей місяць)`),
          { parse_mode: 'HTML' }
        );
      } catch (e) {
        await ctx.reply(`Помилка: ${e.message}`);
      }
      break;
    }

    case 'Сьогодні':
      await handlePeriod(ctx, 'today', session);
      break;
    case 'Цей тиждень':
      await handlePeriod(ctx, 'week', session);
      break;
    case 'За місяць':
      await handlePeriod(ctx, 'month', session);
      break;
    case 'Минулий місяць':
      await handlePeriod(ctx, 'last_month', session);
      break;

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
      fmt.formatStatsWithoutAmount(stats, `${session.driverName} — ${label}`),
      { parse_mode: 'HTML' }
    );
    if (trips.length > 0) {
      await ctx.reply(
        fmt.formatTripList(trips.slice(0, 10), `<b>Поїздки — ${label}</b>`),
        { parse_mode: 'HTML' }
      );
    }
  } catch (e) {
    await ctx.reply(`Помилка: ${e.message}`);
  }
}

// ─── Error handler ────────────────────────────────────────────────────────────
bot.catch((err, ctx) => {
  console.error(`Error [${ctx.from?.id}]:`, err.message);
  ctx.reply('Виникла помилка. Спробуйте /start').catch(() => { });
});

// ─── Notification helpers ─────────────────────────────────────────────────────
function formatDateUk(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('uk-UA', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

async function sendNotification(driverId, tripId, buildMsg) {
  try {
    const telegramId = await db.getDriverTelegramId(driverId);
    if (!telegramId) {
      console.log(`[Notify] driver_id=${driverId} not linked to Telegram, skipping`);
      return;
    }
    const msg = buildMsg();
    await bot.telegram.sendMessage(telegramId, msg, { parse_mode: 'HTML' });
    console.log(`[Notify] sent to telegramId=${telegramId} for trip id=${tripId}`);
  } catch (e) {
    console.error(`[Notify] failed for trip id=${tripId}:`, e.message);
  }
}

// ─── Trip created notification (без суми) ─────────────────────────────────────
async function notifyTripCreated(trip) {
  if (!trip.driver_id) return;

  await sendNotification(trip.driver_id, trip.id, () => {
    const dateStr = formatDateUk(trip.date);
    const carStr = trip.car
      ? `${trip.car.brand} ${trip.car.model} (${trip.car.plate})`
      : '—';

    const lines = [
      `🆕 <b>Вам призначено поїздку!</b>`,
      fmt.divider(),
      `📅 Дата:    ${fmt.bold(dateStr)}`,
      `📍 Маршрут: ${fmt.bold(trip.route || '—')}`,
      `🚗 Авто:    ${fmt.bold(carStr)}`,
    ];

    if (trip.notes) {
      lines.push(`📝 Примітка: ${fmt.escapeHtml(trip.notes)}`);
    }

    if (trip.is_overnight) {
      lines.push(`🌙 Нічна поїздка — пробіг буде внесено після завершення`);
    }

    return lines.join('\n');
  });
}

// ─── Trip completed notification (без суми) ───────────────────────────────────
async function notifyTripCompleted(trip) {
  if (!trip.driver_id) return;

  await sendNotification(trip.driver_id, trip.id, () => {
    const dateStr = formatDateUk(trip.date);
    const distance = Math.max(0, (trip.end_mileage || 0) - (trip.start_mileage || 0));

    return [
      `✅ <b>Поїздку завершено!</b>`,
      fmt.divider(),
      `📅 Дата:    ${fmt.bold(dateStr)}`,
      `📍 Маршрут: ${fmt.bold(trip.route || '—')}`,
      `🛣 Пробіг:  ${fmt.bold(distance + ' км')}`,
      `         (${trip.start_mileage} → ${trip.end_mileage})`,
    ].join('\n');
  });
}

// ─── Realtime listener з авто-реконнектом ─────────────────────────────────────
let realtimeChannels = [];
let healthCheckInterval = null;
let keepaliveInterval = null;
let server = null;

function cleanupChannels() {
  if (realtimeChannels.length) {
    realtimeChannels.forEach(ch => {
      try {
        if (ch.unsubscribe) ch.unsubscribe();
        if (db.supabase.removeChannel) db.supabase.removeChannel(ch);
      } catch (e) {
        console.warn('Channel cleanup error:', e.message);
      }
    });
    realtimeChannels = [];
  }
}

function setupChannels() {
  cleanupChannels();

  const chCreated = db.supabase
    .channel('trips-created')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'trips',
    }, async (payload) => {
      const trip = payload.new;
      console.log(`[Realtime] trip INSERT id=${trip.id} driver_id=${trip.driver_id}`);
      if (!trip.driver_id) return;
      try {
        const car = trip.car_id ? await db.getCarById(trip.car_id) : null;
        await notifyTripCreated({ ...trip, car });
      } catch (e) {
        console.error(`[Realtime] Error processing INSERT:`, e.message);
      }
    })
    .subscribe((status, err) => {
      console.log('[Realtime] trips-created status:', status);
      if (err) console.error('[Realtime] trips-created error:', err.message);
    });

  const chCompleted = db.supabase
    .channel('trips-completed')
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'trips',
    }, (payload) => {
      const { new: newRow, old: oldRow } = payload;
      console.log(`[Realtime] trip UPDATE id=${newRow.id} | old.end_mileage=${oldRow.end_mileage} | new.end_mileage=${newRow.end_mileage}`);
      if ((oldRow.end_mileage == null) && (newRow.end_mileage != null)) {
        notifyTripCompleted(newRow).catch(e => {
          console.error(`[Realtime] Error processing UPDATE:`, e.message);
        });
      }
    })
    .subscribe((status, err) => {
      console.log('[Realtime] trips-completed status:', status);
      if (err) console.error('[Realtime] trips-completed error:', err.message);
    });

  realtimeChannels = [chCreated, chCompleted];
}

function startRealtimeListener() {
  setupChannels();

  if (healthCheckInterval) clearInterval(healthCheckInterval);
  healthCheckInterval = setInterval(() => {
    let needsReconnect = false;
    realtimeChannels.forEach(ch => {
      if (ch.state !== 'subscribed') {
        console.log(`[Realtime] Channel ${ch.topic} state: ${ch.state}, needs reconnect`);
        needsReconnect = true;
      }
    });

    if (needsReconnect) {
      console.log('[Realtime] Reconnecting all channels...');
      setupChannels();
    }
  }, 30 * 60 * 1000);

  if (WEBHOOK_URL) {
    if (keepaliveInterval) clearInterval(keepaliveInterval);
    keepaliveInterval = setInterval(async () => {
      try {
        const res = await fetch(`${WEBHOOK_URL}/health`);
        console.log(`[Keepalive] ping ${res.status}`);
      } catch (e) {
        console.warn('[Keepalive] ping failed:', e.message);
      }
    }, 10 * 60 * 1000);
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  if (healthCheckInterval) clearInterval(healthCheckInterval);
  if (keepaliveInterval) clearInterval(keepaliveInterval);

  cleanupChannels();

  if (server) {
    server.close(() => {
      console.log('HTTP server closed');
    });
  }

  try {
    await bot.stop(signal);
  } catch (e) {
    console.error('Error stopping bot:', e.message);
  }

  process.exit(0);
}

// ─── Webhook server + launch ──────────────────────────────────────────────────
async function start() {
  if (WEBHOOK_URL) {
    const webhookPath = `/webhook/${process.env.BOT_TOKEN}`;
    const callbackUrl = `${WEBHOOK_URL}${webhookPath}`;

    const webhookHandler = await bot.createWebhook({
      domain: WEBHOOK_URL,
      path: webhookPath,
      secret_token: WEBHOOK_SECRET || undefined,
    });

    server = http.createServer(async (req, res) => {
      if (req.url.startsWith(webhookPath) && req.method === 'POST') {
        await webhookHandler(req, res);
      } else if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          realtimeChannels: realtimeChannels.map(ch => ({
            topic: ch.topic,
            state: ch.state
          })),
          memory: process.memoryUsage(),
        }));
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
    console.log('WEBHOOK_URL not set — falling back to long polling (local dev mode)');
    await bot.launch();
    const name = bot.botInfo?.username ? `@${bot.botInfo.username}` : '...';
    console.log(`Bot started (polling): ${name}`);
    startRealtimeListener();
  }
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

start().catch(e => {
  console.error('Startup error:', e.message);
  process.exit(1);
});