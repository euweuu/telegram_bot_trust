require('dotenv').config();
const http = require('http');
const cron = require('node-cron');
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const Redis = require('ioredis');

const db = require('./services/db');
const fmt = require('./utils/format');

// ─── Config ───────────────────────────────────────────────────────────────────
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const REDIS_URL = process.env.REDIS_URL || null;

// Dispatcher Telegram IDs (comma-separated in .env)
const DISPATCHER_IDS = (process.env.DISPATCHER_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!process.env.BOT_TOKEN || process.env.BOT_TOKEN === 'ВСТАВЬТЕ_ВАШ_ТОКЕН_ТУТ') {
  console.error('BOT_TOKEN не вказаний у файлі .env');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// ─── Webhook Secret Middleware ───────────────────────────────────────────────
if (WEBHOOK_SECRET) {
  bot.use(async (ctx, next) => {
    const receivedSecret = ctx.update?.webhook_secret ||
      ctx.request?.headers?.['x-telegram-bot-api-secret-token'];

    if (receivedSecret !== WEBHOOK_SECRET) {
      console.warn(`Invalid webhook secret from ${ctx.from?.id || 'unknown'}`);
      return;
    }
    await next();
  });
}

// ─── Redis Session Store ─────────────────────────────────────────────────────
class RedisSessionStore {
  constructor(redis, ttlMs) {
    this.redis = redis;
    this.ttlSeconds = Math.ceil(ttlMs / 1000);
  }

  async get(key) {
    const data = await this.redis.get(key);
    if (!data) return null;
    try {
      const parsed = JSON.parse(data);
      if (Date.now() - parsed.cachedAt < this.ttlSeconds * 1000) {
        return parsed;
      }
      await this.redis.del(key);
      return null;
    } catch {
      return null;
    }
  }

  async set(key, value) {
    await this.redis.set(key, JSON.stringify(value), 'EX', this.ttlSeconds);
  }

  async delete(key) {
    await this.redis.del(key);
  }
}

let sessionStore = null;
let redisClient = null;

if (REDIS_URL) {
  redisClient = new Redis(REDIS_URL);
  sessionStore = new RedisSessionStore(redisClient, SESSION_TTL_MS);
  console.log('[Redis] Connected to Redis for session storage');
} else {
  console.warn('[Redis] REDIS_URL not set, using in-memory sessions (will be lost on restart)');
}

// ─── Session management ─────────────────────────────────────────────────────
async function getSession(telegramId) {
  const key = `session:${telegramId}`;

  if (sessionStore) {
    return await sessionStore.get(key);
  }

  // Fallback to in-memory (original logic)
  const cached = sessions.get(key);
  if (cached && Date.now() - cached.cachedAt < SESSION_TTL_MS) {
    return cached;
  }
  if (cached) sessions.delete(key);

  const linked = await db.getLinkedDriver(telegramId);
  if (!linked) return null;

  const s = { driverId: linked.driverId, driverName: linked.driverName, cachedAt: Date.now() };
  sessions.set(key, s);
  return s;
}

async function setSession(telegramId, data) {
  const key = `session:${telegramId}`;
  const value = { ...data, cachedAt: Date.now() };

  if (sessionStore) {
    await sessionStore.set(key, value);
  } else {
    sessions.set(key, value);
  }
}

async function clearSession(telegramId) {
  const key = `session:${telegramId}`;
  if (sessionStore) {
    await sessionStore.delete(key);
  } else {
    sessions.delete(key);
  }
}

// In-memory fallback
const sessions = new Map();

// ─── Logger with levels ──────────────────────────────────────────────────────
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const log = {
  error: (...a) => { if (LOG_LEVELS[CURRENT_LOG_LEVEL] >= 0) console.error('[ERROR]', new Date().toISOString(), ...a); },
  warn: (...a) => { if (LOG_LEVELS[CURRENT_LOG_LEVEL] >= 1) console.warn('[WARN]', new Date().toISOString(), ...a); },
  info: (...a) => { if (LOG_LEVELS[CURRENT_LOG_LEVEL] >= 2) console.info('[INFO]', new Date().toISOString(), ...a); },
  debug: (...a) => { if (LOG_LEVELS[CURRENT_LOG_LEVEL] >= 3) console.debug('[DEBUG]', new Date().toISOString(), ...a); },
};

// ─── Metrics ─────────────────────────────────────────────────────────────────
const metrics = {
  commands: new Map(),
  errors: new Map(),
  startTime: Date.now(),
  messagesProcessed: 0,

  recordCommand(command) {
    this.commands.set(command, (this.commands.get(command) || 0) + 1);
  },

  recordError(errorType) {
    this.errors.set(errorType, (this.errors.get(errorType) || 0) + 1);
  },

  getStats() {
    return {
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      commands: Object.fromEntries(this.commands),
      errors: Object.fromEntries(this.errors),
      messagesProcessed: this.messagesProcessed,
    };
  }
};

// ─── Rate limiting (improved with cleanup) ───────────────────────────────────
const rateLimit = new Map();

function checkRateLimit(userId) {
  const now = Date.now();
  const key = String(userId);
  const hits = (rateLimit.get(key) || []).filter(t => now - t < 10_000);

  if (hits.length >= 10) {
    metrics.recordError('rate_limit_exceeded');
    throw new Error('Занадто багато запитів. Зачекайте трохи ⏳');
  }

  hits.push(now);
  rateLimit.set(key, hits);

  // Schedule cleanup
  setTimeout(() => {
    const cur = rateLimit.get(key);
    if (!cur) return;
    const filtered = cur.filter(t => Date.now() - t < 10_000);
    filtered.length ? rateLimit.set(key, filtered) : rateLimit.delete(key);
  }, 11_000);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function buildName(from) {
  if (from.username) {
    return `@${from.username}`;
  }
  // Don't lose first_name when username exists
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ');
  return name || String(from.id);
}

function periodLabel(p) {
  const labels = {
    today: 'сьогодні',
    week: 'цей тиждень',
    month: 'цей місяць',
    last_month: 'минулий місяць',
  };
  return labels[p] || p;
}

function isDispatcher(userId) {
  return DISPATCHER_IDS.includes(String(userId));
}

// ─── Keyboards ───────────────────────────────────────────────────────────────
const mainMenu = Markup.keyboard([
  ['Мої поїздки', 'Статистика'],
  ['За місяць', 'Минулий місяць'],
  ['Цей тиждень', 'Сьогодні'],
  ['Власний період', 'Профіль'],
]).resize();

const dispatcherMenu = Markup.keyboard([
  ['📋 Всі водії (місяць)', '📋 Всі водії (тиждень)'],
  ['📢 Розсилка'],
  ['◀️ Головне меню'],
]).resize();

function tripsPageKeyboard(offset, limit, total) {
  const buttons = [];
  if (offset > 0) {
    buttons.push(Markup.button.callback('← Попередні', `trips_page_${offset - limit}`));
  }
  if (offset + limit < total) {
    buttons.push(Markup.button.callback('Ще поїздки →', `trips_page_${offset + limit}`));
  }
  return buttons.length ? Markup.inlineKeyboard([buttons]) : null;
}

// ─── Pending state (Redis-backed for persistence) ────────────────────────────
class PendingStateManager {
  constructor(redis) {
    this.redis = redis;
  }

  async get(userId) {
    if (!this.redis) return pendingStateMem.get(String(userId));
    const data = await this.redis.get(`pending:${userId}`);
    return data ? JSON.parse(data) : null;
  }

  async set(userId, state) {
    if (!this.redis) {
      pendingStateMem.set(String(userId), state);
      return;
    }
    await this.redis.set(`pending:${userId}`, JSON.stringify(state), 'EX', 3600);
  }

  async delete(userId) {
    if (!this.redis) {
      pendingStateMem.delete(String(userId));
      return;
    }
    await this.redis.del(`pending:${userId}`);
  }
}

const pendingStateMem = new Map();
const pendingStateManager = new PendingStateManager(redisClient);

// ─── /start ───────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  metrics.recordCommand('start');
  metrics.messagesProcessed++;

  const userId = ctx.from.id;
  const startParam = ctx.startPayload;

  if (startParam && startParam.length >= 6) {
    await ctx.reply('Перевіряємо код...');
    try {
      // Use atomic token validation and consumption
      const { driverId, driverName } = await db.validateAndConsumeToken(startParam);
      await db.linkTelegramUser(userId, driverId, buildName(ctx.from));
      await setSession(userId, { driverId, driverName });
      await ctx.reply(
        `✅ Прив'язано успішно!\n\nВи увійшли як: <b>${fmt.escapeHtml(driverName)}</b>\n\nОберіть дію:`,
        { parse_mode: 'HTML', ...mainMenu }
      );
    } catch (e) {
      log.error('Start link error:', e.message);
      await ctx.reply(
        `❌ Помилка: ${fmt.escapeHtml(e.message)}\n\nПерейдіть на сайт — Профіль — Telegram щоб отримати новий код.`,
        { parse_mode: 'HTML' }
      );
    }
    return;
  }

  const session = await getSession(userId);
  if (session) {
    const menu = isDispatcher(userId) ? dispatcherMenu : mainMenu;
    await ctx.reply(
      `З поверненням, <b>${fmt.escapeHtml(session.driverName)}</b>! Оберіть дію:`,
      { parse_mode: 'HTML', ...menu }
    );
    return;
  }

  if (isDispatcher(userId)) {
    await ctx.reply(
      '👋 Вітаємо, диспетчере! Оберіть дію:',
      { parse_mode: 'HTML', ...dispatcherMenu }
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
  metrics.recordCommand('help');
  metrics.messagesProcessed++;

  const lines = [
    '<b>Доступні дії:</b>', '',
    '<b>Мої поїздки</b> — останні поїздки з пагінацією',
    '<b>Статистика</b> — пробіг за поточний місяць',
    '<b>Сьогодні / Тиждень / Місяць</b> — поїздки за обраний період',
    '<b>Власний період</b> — поїздки за довільні дати',
    '<b>Профіль</b> — інформація про акаунт',
    '',
    '<b>/unlink</b> — відключити Telegram від аккаунту',
    '',
    '⚠️ Управління акаунтом також доступне через сайт.',
  ];
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
});

// ─── /unlink ──────────────────────────────────────────────────────────────────
bot.command('unlink', async (ctx) => {
  metrics.recordCommand('unlink');
  metrics.messagesProcessed++;

  const session = await getSession(ctx.from.id);
  if (!session) {
    await ctx.reply('Ваш акаунт не прив\'язаний.');
    return;
  }

  await ctx.reply(
    `⚠️ Ви впевнені, що хочете відключити Telegram від акаунту <b>${fmt.escapeHtml(session.driverName)}</b>?\n\nПісля цього ви не будете отримувати сповіщення.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        Markup.button.callback('✅ Так, відключити', 'confirm_unlink'),
        Markup.button.callback('❌ Скасувати', 'cancel_unlink'),
      ]),
    }
  );
});

bot.action('confirm_unlink', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await db.unlinkTelegramUser(ctx.from.id);
    await clearSession(ctx.from.id);
    await ctx.editMessageText('✅ Telegram відключено. Щоб повторно підключитись — скористайтесь посиланням з сайту.');
  } catch (e) {
    log.error('unlink error:', e.message);
    metrics.recordError('unlink_failed');
    await ctx.editMessageText('❌ Помилка при відключенні. Спробуйте пізніше або зверніться через сайт.');
  }
});

bot.action('cancel_unlink', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Скасовано. Ваш акаунт залишається підключеним ✅');
});

// ─── Pagination callbacks ─────────────────────────────────────────────────────
bot.action(/^trips_page_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const offset = parseInt(ctx.match[1], 10);
  const session = await getSession(ctx.from.id);

  if (!session) {
    await ctx.reply('Сесія закінчилась. Натисніть /start');
    return;
  }

  try {
    const LIMIT = 10;
    const { trips, total, hasMore } = await db.getDriverRecentTrips(session.driverId, LIMIT, offset);
    const title = `<b>Поїздки — ${fmt.escapeHtml(session.driverName)}</b>`;
    const msg = fmt.formatTripList(trips, title, {
      current: Math.min(offset + LIMIT, total),
      total,
      hasMore,
    });

    const keyboard = tripsPageKeyboard(offset, LIMIT, total);
    const opts = { parse_mode: 'HTML', ...(keyboard || {}) };

    await ctx.editMessageText(msg, opts).catch(() =>
      ctx.reply(msg, opts)
    );
  } catch (e) {
    log.error('pagination error:', e.message);
    metrics.recordError('pagination_failed');
    await ctx.reply('Помилка при завантаженні. Спробуйте ще раз.');
  }
});

// ─── Text handler ─────────────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  metrics.messagesProcessed++;

  try {
    checkRateLimit(userId);
  } catch (e) {
    await ctx.reply(e.message);
    return;
  }

  // ── Dispatcher commands ──────────────────────────────────────────────────────
  if (isDispatcher(userId)) {
    if (text === '📋 Всі водії (місяць)') {
      metrics.recordCommand('dispatcher_stats_month');
      await handleDispatcherStats(ctx, 'month');
      return;
    }
    if (text === '📋 Всі водії (тиждень)') {
      metrics.recordCommand('dispatcher_stats_week');
      await handleDispatcherStats(ctx, 'week');
      return;
    }
    if (text === '◀️ Головне меню') {
      const session = await getSession(userId);
      const menu = session ? mainMenu : dispatcherMenu;
      await ctx.reply('Головне меню:', menu);
      return;
    }
    if (text === '📢 Розсилка') {
      metrics.recordCommand('broadcast_start');
      await pendingStateManager.set(String(userId), { type: 'broadcast' });
      await ctx.reply(
        '📢 Введіть текст повідомлення для розсилки всім водіям:',
        Markup.keyboard([['❌ Скасувати']]).resize()
      );
      return;
    }
  }

  // ── Cancel any pending flow ────────────────────────────────────────────────
  if (text === '❌ Скасувати') {
    await pendingStateManager.delete(String(userId));
    const session = await getSession(userId);
    const menu = session ? mainMenu : (isDispatcher(userId) ? dispatcherMenu : Markup.removeKeyboard());
    await ctx.reply('Скасовано.', menu);
    return;
  }

  // ── Handle pending states (FSM) ────────────────────────────────────────────
  const pending = await pendingStateManager.get(String(userId));

  if (pending) {
    if (pending.type === 'broadcast') {
      await handleBroadcast(ctx, text);
      await pendingStateManager.delete(String(userId));
      return;
    }

    if (pending.type === 'date_range_start') {
      const date = parseDate(text);
      if (!date) {
        await ctx.reply('❌ Невірний формат. Введіть дату у форматі ДД.ММ.РРРР:');
        return;
      }
      await pendingStateManager.set(String(userId), { type: 'date_range_end', startDate: date });
      await ctx.reply('📅 Тепер введіть кінцеву дату (ДД.ММ.РРРР):');
      return;
    }

    if (pending.type === 'date_range_end') {
      const date = parseDate(text);
      if (!date) {
        await ctx.reply('❌ Невірний формат. Введіть дату у форматі ДД.ММ.РРРР:');
        return;
      }
      if (date < pending.startDate) {
        await ctx.reply('❌ Кінцева дата має бути після початкової. Введіть ще раз:');
        return;
      }
      await pendingStateManager.delete(String(userId));
      const session = await getSession(userId);
      if (!session) {
        await ctx.reply('Сесія закінчилась. Натисніть /start');
        return;
      }
      const menu = isDispatcher(userId) ? dispatcherMenu : mainMenu;
      await ctx.reply('Завантаження...', menu);
      await handleCustomRange(ctx, session, pending.startDate, date);
      return;
    }
  }

  // ── Driver commands ────────────────────────────────────────────────────────
  const session = await getSession(userId);

  if (!session && !isDispatcher(userId)) {
    await ctx.reply(
      'Ваш Telegram ще не прив\'язаний.\n\nПерейдіть на сайт — <b>Профіль — Telegram</b>.',
      { parse_mode: 'HTML', ...Markup.removeKeyboard() }
    );
    return;
  }

  if (!session) {
    if (!isDispatcher(userId)) return;
    await ctx.reply('Оберіть дію:', dispatcherMenu);
    return;
  }

  switch (text) {
    case 'Мої поїздки': {
      metrics.recordCommand('my_trips');
      await ctx.reply('Завантаження...');
      try {
        const LIMIT = 10;
        const { trips, total, hasMore } = await db.getDriverRecentTrips(session.driverId, LIMIT, 0);
        const title = `<b>Поїздки — ${fmt.escapeHtml(session.driverName)}</b>`;
        const msg = fmt.formatTripList(trips, title, { current: Math.min(LIMIT, total), total, hasMore });
        const keyboard = tripsPageKeyboard(0, LIMIT, total);
        await ctx.reply(msg, { parse_mode: 'HTML', ...(keyboard || {}) });
      } catch (e) {
        log.error('getDriverRecentTrips:', e.message);
        metrics.recordError('my_trips_failed');
        await ctx.reply('Помилка завантаження поїздок. Спробуйте пізніше.');
      }
      break;
    }

    case 'Статистика': {
      metrics.recordCommand('stats');
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
        log.error('Статистика:', e.message);
        metrics.recordError('stats_failed');
        await ctx.reply('Помилка завантаження статистики. Спробуйте пізніше.');
      }
      break;
    }

    case 'Сьогодні': await handlePeriod(ctx, 'today', session); break;
    case 'Цей тиждень': await handlePeriod(ctx, 'week', session); break;
    case 'За місяць': await handlePeriod(ctx, 'month', session); break;
    case 'Минулий місяць': await handlePeriod(ctx, 'last_month', session); break;

    case 'Власний період': {
      metrics.recordCommand('custom_range');
      await pendingStateManager.set(String(userId), { type: 'date_range_start' });
      await ctx.reply(
        '📅 Введіть початкову дату у форматі <b>ДД.ММ.РРРР</b>:',
        { parse_mode: 'HTML', ...Markup.keyboard([['❌ Скасувати']]).resize() }
      );
      break;
    }

    case 'Профіль': {
      metrics.recordCommand('profile');
      await ctx.reply([
        `<b>Профіль</b>`,
        fmt.divider(),
        `Ім'я:      ${fmt.bold(session.driverName)}`,
        `Telegram:  ${fmt.mono(buildName(ctx.from))}`,
        `ID:        ${fmt.mono(String(userId))}`,
        ``,
        `Щоб відключити Telegram — команда /unlink`,
      ].join('\n'), { parse_mode: 'HTML' });
      break;
    }

    default:
      // Silently ignore unknown text
      break;
  }
});

// ─── Period handler ───────────────────────────────────────────────────────────
async function handlePeriod(ctx, period, session) {
  metrics.recordCommand(`period_${period}`);
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
      const LIMIT = 10;
      const slice = trips.slice(0, LIMIT);
      const msg = fmt.formatTripList(
        slice,
        `<b>Поїздки — ${label}</b>`,
        trips.length > LIMIT ? { current: LIMIT, total: trips.length, hasMore: true } : null
      );
      await ctx.reply(msg, { parse_mode: 'HTML' });
    }
  } catch (e) {
    log.error(`handlePeriod(${period}):`, e.message);
    metrics.recordError(`period_${period}_failed`);
    await ctx.reply('Помилка завантаження. Спробуйте пізніше.');
  }
}

// ─── Custom date range handler ────────────────────────────────────────────────
async function handleCustomRange(ctx, session, startDate, endDate) {
  try {
    const trips = await db.getDriverTrips(session.driverId, startDate, endDate);
    const stats = db.calcStats(trips);
    const label = `${formatDateDisplay(startDate)} — ${formatDateDisplay(endDate)}`;

    await ctx.reply(
      fmt.formatStatsWithoutAmount(stats, `${session.driverName} — ${label}`),
      { parse_mode: 'HTML' }
    );

    if (trips.length > 0) {
      const LIMIT = 10;
      const slice = trips.slice(0, LIMIT);
      const msg = fmt.formatTripList(
        slice,
        `<b>Поїздки — ${label}</b>`,
        trips.length > LIMIT ? { current: LIMIT, total: trips.length, hasMore: true } : null
      );
      await ctx.reply(msg, { parse_mode: 'HTML' });
    }
  } catch (e) {
    log.error('handleCustomRange:', e.message);
    metrics.recordError('custom_range_failed');
    await ctx.reply('Помилка завантаження. Спробуйте пізніше.');
  }
}

// ─── Dispatcher: all drivers stats ───────────────────────────────────────────
async function handleDispatcherStats(ctx, period) {
  await ctx.reply('Завантаження...');
  try {
    const { start, end } = db.getDateRange(period);
    const allStats = await db.getAllDriversStats(start, end);
    const label = period === 'month' ? 'Всі водії — цей місяць' : 'Всі водії — цей тиждень';
    await ctx.reply(
      fmt.formatDispatcherStats(allStats, label),
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    log.error('handleDispatcherStats:', e.message);
    metrics.recordError('dispatcher_stats_failed');
    await ctx.reply('Помилка завантаження статистики.');
  }
}

// ─── Dispatcher: broadcast ───────────────────────────────────────────────────
async function handleBroadcast(ctx, text) {
  metrics.recordCommand('broadcast_execute');
  await ctx.reply('Розсилка...');
  try {
    const users = await db.getAllLinkedUsers();
    let sent = 0, failed = 0;

    for (const u of users) {
      try {
        await bot.telegram.sendMessage(
          u.telegram_id,
          `📢 <b>Повідомлення від диспетчера:</b>\n\n${fmt.escapeHtml(text)}`,
          { parse_mode: 'HTML' }
        );
        sent++;
      } catch (e) {
        log.warn(`Broadcast failed to ${u.telegram_id}:`, e.message);
        failed++;
      }
    }

    await ctx.reply(
      `✅ Розсилку завершено.\n✉️ Надіслано: ${sent}\n❌ Помилок: ${failed}`,
      dispatcherMenu
    );
    metrics.recordCommand('broadcast_complete');
  } catch (e) {
    log.error('handleBroadcast:', e.message);
    metrics.recordError('broadcast_failed');
    await ctx.reply('Помилка при розсилці.', dispatcherMenu);
  }
}

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
      log.debug(`[Notify] driver_id=${driverId} not linked to Telegram, skipping`);
      return;
    }
    const msg = buildMsg();
    await bot.telegram.sendMessage(telegramId, msg, { parse_mode: 'HTML' });
    log.info(`[Notify] sent to telegramId=${telegramId} for trip id=${tripId}`);
  } catch (e) {
    log.error(`[Notify] failed for trip id=${tripId}:`, e.message);
    metrics.recordError('notification_failed');
  }
}

// ─── Trip created notification ────────────────────────────────────────────────
async function notifyTripCreated(trip) {
  if (!trip.driver_id) return;

  await sendNotification(trip.driver_id, trip.id, () => {
    const dateStr = formatDateUk(trip.date);
    const carStr = trip.car ? `${trip.car.brand} ${trip.car.model} (${trip.car.plate})` : '—';

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

// ─── Trip completed notification ──────────────────────────────────────────────
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

// ─── Trip deleted notification ────────────────────────────────────────────────
async function notifyTripDeleted(trip) {
  if (!trip.driver_id) return;

  await sendNotification(trip.driver_id, trip.id, () => {
    return fmt.formatTripDeletedNotification({
      dateFormatted: formatDateUk(trip.date),
      route: trip.route || '—',
      car: null,
    });
  });
}

// ─── Fallback poller for missed notifications ─────────────────────────────────
let fallbackInterval = null;

function startFallbackPoller() {
  // Check every 5 minutes for trips that might have missed notifications
  fallbackInterval = setInterval(async () => {
    try {
      const now = new Date();
      const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

      // Find trips created in last 5 minutes that might not have sent notifications
      const { data: recentTrips } = await db.supabase
        .from('trips')
        .select('*')
        .gte('created_at', fiveMinutesAgo.toISOString())
        .order('created_at', { ascending: false });

      if (recentTrips && recentTrips.length > 0) {
        for (const trip of recentTrips) {
          // Check if notification was already sent (you'd need a flag in DB)
          // For now, just log
          log.debug(`[Fallback] Found potential missed trip: ${trip.id}`);
        }
      }
    } catch (e) {
      log.error('[Fallback] Poller error:', e.message);
    }
  }, 5 * 60 * 1000);

  log.info('[Fallback] Started fallback poller (every 5 minutes)');
}

// ─── Weekly digest cron ───────────────────────────────────────────────────────
function startWeeklyDigest() {
  cron.schedule('0 9 * * 1', async () => {
    log.info('[Digest] Starting weekly digest...');
    metrics.recordCommand('weekly_digest');
    try {
      const users = await db.getAllLinkedUsers();
      const now = new Date();

      const end = db.toISODate(now);
      const d7 = new Date(now); d7.setDate(d7.getDate() - 6);
      const start = db.toISODate(d7);

      const weekLabel = `${formatDateDisplay(start)} — ${formatDateDisplay(end)}`;

      for (const u of users) {
        try {
          const trips = await db.getDriverTrips(u.driver_id, start, end);
          const stats = db.calcStats(trips);
          const msg = fmt.formatWeeklyDigest(stats, u.driver.name, weekLabel);
          await bot.telegram.sendMessage(u.telegram_id, msg, { parse_mode: 'HTML' });
          log.info(`[Digest] sent to driver_id=${u.driver_id}`);
        } catch (e) {
          log.error(`[Digest] failed for driver_id=${u.driver_id}:`, e.message);
          metrics.recordError('digest_failed');
        }
      }

      log.info(`[Digest] Done. Sent to ${users.length} users.`);
    } catch (e) {
      log.error('[Digest] Fatal:', e.message);
      metrics.recordError('digest_fatal');
    }
  }, { timezone: 'Europe/Kyiv' });

  log.info('[Digest] Weekly digest cron scheduled (Mon 09:00 Kyiv)');
}

// ─── Realtime listener with auto-reconnect ────────────────────────────────────
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
        log.warn('Channel cleanup error:', e.message);
      }
    });
    realtimeChannels = [];
  }
}

function setupChannels() {
  cleanupChannels();

  const chCreated = db.supabase
    .channel('trips-created')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'trips' },
      async (payload) => {
        const trip = payload.new;
        log.info(`[Realtime] trip INSERT id=${trip.id} driver_id=${trip.driver_id}`);
        if (!trip.driver_id) return;
        try {
          const car = trip.car_id ? await db.getCarById(trip.car_id) : null;
          await notifyTripCreated({ ...trip, car });
        } catch (e) {
          log.error(`[Realtime] Error processing INSERT:`, e.message);
          metrics.recordError('realtime_insert_failed');
        }
      })
    .subscribe((status, err) => {
      log.info('[Realtime] trips-created status:', status);
      if (err) {
        log.error('[Realtime] trips-created error:', err.message);
        metrics.recordError('realtime_subscribe_failed');
      }
    });

  const chCompleted = db.supabase
    .channel('trips-completed')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'trips' },
      (payload) => {
        const { new: newRow, old: oldRow } = payload;
        log.info(`[Realtime] trip UPDATE id=${newRow.id} | old.end_mileage=${oldRow.end_mileage} | new.end_mileage=${newRow.end_mileage}`);
        if (oldRow.end_mileage == null && newRow.end_mileage != null) {
          notifyTripCompleted(newRow).catch(e => {
            log.error(`[Realtime] Error processing UPDATE:`, e.message);
            metrics.recordError('realtime_update_failed');
          });
        }
      })
    .subscribe((status, err) => {
      log.info('[Realtime] trips-completed status:', status);
      if (err) {
        log.error('[Realtime] trips-completed error:', err.message);
        metrics.recordError('realtime_subscribe_failed');
      }
    });

  const chDeleted = db.supabase
    .channel('trips-deleted')
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'trips' },
      async (payload) => {
        const trip = payload.old;
        log.info(`[Realtime] trip DELETE id=${trip.id} driver_id=${trip.driver_id}`);
        if (!trip.driver_id) return;
        try {
          await notifyTripDeleted(trip);
        } catch (e) {
          log.error(`[Realtime] Error processing DELETE:`, e.message);
          metrics.recordError('realtime_delete_failed');
        }
      })
    .subscribe((status, err) => {
      log.info('[Realtime] trips-deleted status:', status);
      if (err) {
        log.error('[Realtime] trips-deleted error:', err.message);
        metrics.recordError('realtime_subscribe_failed');
      }
    });

  realtimeChannels = [chCreated, chCompleted, chDeleted];
}

function startRealtimeListener() {
  setupChannels();

  if (healthCheckInterval) clearInterval(healthCheckInterval);
  healthCheckInterval = setInterval(() => {
    let needsReconnect = false;
    realtimeChannels.forEach(ch => {
      if (ch.state !== 'subscribed') {
        log.warn(`[Realtime] Channel ${ch.topic} state: ${ch.state}, needs reconnect`);
        needsReconnect = true;
      }
    });
    if (needsReconnect) {
      log.info('[Realtime] Reconnecting all channels...');
      setupChannels();
    }
  }, 30 * 60 * 1000);

  if (WEBHOOK_URL) {
    if (keepaliveInterval) clearInterval(keepaliveInterval);
    keepaliveInterval = setInterval(async () => {
      try {
        const res = await fetch(`${WEBHOOK_URL}/health`);
        log.debug(`[Keepalive] ping ${res.status}`);
      } catch (e) {
        log.warn('[Keepalive] ping failed:', e.message);
      }
    }, 10 * 60 * 1000);
  }
}

// ─── Error handler ────────────────────────────────────────────────────────────
bot.catch((err, ctx) => {
  log.error(`Unhandled bot error [user=${ctx.from?.id}]:`, err.message);
  metrics.recordError('unhandled_bot_error');
  ctx.reply('Виникла помилка. Спробуйте /start').catch(() => { });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal) {
  log.info(`${signal} received. Shutting down gracefully...`);

  if (healthCheckInterval) clearInterval(healthCheckInterval);
  if (keepaliveInterval) clearInterval(keepaliveInterval);
  if (fallbackInterval) clearInterval(fallbackInterval);

  cleanupChannels();

  if (redisClient) {
    await redisClient.quit();
    log.info('[Redis] Connection closed');
  }

  if (server) {
    server.close(() => log.info('HTTP server closed'));
  }

  try {
    await bot.stop(signal);
  } catch (e) {
    log.error('Error stopping bot:', e.message);
  }

  process.exit(0);
}

// ─── Date utils (local) ───────────────────────────────────────────────────────
function parseDate(str) {
  const m = str.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const date = new Date(`${y}-${mo}-${d}`);
  if (isNaN(date.getTime())) return null;
  return `${y}-${mo}-${d}`;
}

function formatDateDisplay(isoDate) {
  if (!isoDate) return '—';
  const [y, m, d] = isoDate.split('-');
  return `${d}.${m}.${y}`;
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
        // Enhanced health check
        const checks = {
          supabase: false,
          realtime: realtimeChannels.length > 0 && realtimeChannels.every(ch => ch.state === 'subscribed'),
          bot: false,
          redis: !REDIS_URL || (redisClient && redisClient.status === 'ready'),
        };

        // Check Supabase
        try {
          const { error } = await db.supabase.from('drivers').select('count', { count: 'exact', head: true });
          checks.supabase = !error;
        } catch (e) {
          log.error('Health check - Supabase error:', e.message);
        }

        // Check Bot
        try {
          await bot.telegram.getMe();
          checks.bot = true;
        } catch (e) {
          log.error('Health check - Bot error:', e.message);
        }

        const healthy = Object.values(checks).every(Boolean);
        res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: healthy ? 'ok' : 'degraded',
          checks,
          metrics: metrics.getStats(),
          timestamp: new Date().toISOString(),
        }));
      } else if (req.url === '/metrics') {
        // Prometheus-style metrics endpoint
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        const stats = metrics.getStats();
        const lines = [
          `# HELP bot_uptime_seconds Bot uptime in seconds`,
          `# TYPE bot_uptime_seconds counter`,
          `bot_uptime_seconds ${stats.uptime}`,
          `# HELP bot_messages_processed_total Total messages processed`,
          `# TYPE bot_messages_processed_total counter`,
          `bot_messages_processed_total ${stats.messagesProcessed}`,
        ];

        for (const [cmd, count] of Object.entries(stats.commands)) {
          lines.push(`# HELP bot_commands_total Total commands executed`);
          lines.push(`# TYPE bot_commands_total counter`);
          lines.push(`bot_commands_total{command="${cmd}"} ${count}`);
        }

        res.end(lines.join('\n'));
      } else {
        res.writeHead(200);
        res.end('OK');
      }
    });

    server.listen(PORT, () => {
      log.info(`Webhook server listening on port ${PORT}`);
      log.info(`Webhook registered at ${callbackUrl}`);
    });

    startRealtimeListener();
    startFallbackPoller();
    startWeeklyDigest();

  } else {
    log.info('WEBHOOK_URL not set — falling back to long polling (local dev mode)');
    await bot.launch();
    const name = bot.botInfo?.username ? `@${bot.botInfo.username}` : '...';
    log.info(`Bot started (polling): ${name}`);
    startRealtimeListener();
    startFallbackPoller();
    startWeeklyDigest();
  }
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled Rejection at:', promise, 'reason:', reason);
  metrics.recordError('unhandled_rejection');
});

start().catch(e => {
  log.error('Startup error:', e.message);
  process.exit(1);
});