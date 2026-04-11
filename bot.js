require('dotenv').config();
const http = require('http');
const cron = require('node-cron');
const { Telegraf, Markup, Scenes, session } = require('telegraf');

const db = require('./services/db');
const fmt = require('./utils/format');

// ─── Config ───────────────────────────────────────────────────────────────────
const WEBHOOK_URL     = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET || '';
const PORT            = process.env.PORT || 3000;
const SESSION_TTL_MS  = 30 * 60 * 1000; // 30 minutes

// Dispatcher Telegram IDs (comma-separated in .env)
// e.g. DISPATCHER_IDS=123456789,987654321
const DISPATCHER_IDS = (process.env.DISPATCHER_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!process.env.BOT_TOKEN || process.env.BOT_TOKEN === 'ВСТАВЬТЕ_ВАШ_ТОКЕН_ТУТ') {
  console.error('BOT_TOKEN не вказаний у файлі .env');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// ─── Logger ───────────────────────────────────────────────────────────────────
const log = {
  info:  (...a) => console.log('[INFO]',  ...a),
  warn:  (...a) => console.warn('[WARN]',  ...a),
  error: (...a) => console.error('[ERROR]', ...a),
};

// ─── Session cache (with TTL) ─────────────────────────────────────────────────
const sessions = new Map(); // telegramId → { driverId, driverName, cachedAt }

async function getSession(telegramId) {
  const key    = String(telegramId);
  const cached = sessions.get(key);

  if (cached) {
    // Invalidate if TTL exceeded
    if (Date.now() - cached.cachedAt < SESSION_TTL_MS) {
      return cached;
    }
    sessions.delete(key);
  }

  const linked = await db.getLinkedDriver(telegramId);
  if (!linked) return null;

  const s = { driverId: linked.driverId, driverName: linked.driverName, cachedAt: Date.now() };
  sessions.set(key, s);
  return s;
}

function setSession(id, data) {
  sessions.set(String(id), { ...data, cachedAt: Date.now() });
}

function clearSession(id) {
  sessions.delete(String(id));
}

// ─── Rate limiting (10 requests per 10 seconds) ───────────────────────────────
const rateLimit = new Map();

function checkRateLimit(userId) {
  const now  = Date.now();
  const key  = String(userId);
  const hits = (rateLimit.get(key) || []).filter(t => now - t < 10_000);

  if (hits.length >= 10) {
    throw new Error('Занадто багато запитів. Зачекайте трохи ⏳');
  }

  hits.push(now);
  rateLimit.set(key, hits);

  setTimeout(() => {
    const cur = rateLimit.get(key);
    if (!cur) return;
    const filtered = cur.filter(t => Date.now() - t < 10_000);
    filtered.length ? rateLimit.set(key, filtered) : rateLimit.delete(key);
  }, 11_000);
}

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

function isDispatcher(userId) {
  return DISPATCHER_IDS.includes(String(userId));
}

// ─── Keyboards ────────────────────────────────────────────────────────────────
const mainMenu = Markup.keyboard([
  ['Мої поїздки', 'Статистика'],
  ['За місяць', 'Минулий місяць'],
  ['Цей тиждень', 'Сьогодні'],
  ['Власний період', 'Профіль'],
]).resize();

const dispatcherMenu = Markup.keyboard([
  ['📋 Всі водії (місяць)', '📋 Всі водії (тиждень)'],
  ['➕ Створити поїздку', '✅ Завершити поїздку'],
  ['📢 Розсилка', '⚙️ Статус'],
  ['◀️ Головне меню'],
]).resize();

function tripsPageKeyboard(offset, limit, total, contextKey = 'recent') {
  const buttons = [];
  if (offset > 0) {
    buttons.push(Markup.button.callback('← Попередні', `trips_page_${contextKey}_${offset - limit}`));
  }
  if (offset + limit < total) {
    buttons.push(Markup.button.callback('Ще поїздки →', `trips_page_${contextKey}_${offset + limit}`));
  }
  return buttons.length ? Markup.inlineKeyboard([buttons]) : null;
}

// ─── Pending state with TTL (10 min auto-expiry) ─────────────────────────────
// Map: telegramId → { type, data, expiresAt }
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

const pendingState = {
  _map: new Map(),

  set(id, value) {
    this._map.set(String(id), { ...value, expiresAt: Date.now() + PENDING_TTL_MS });
  },

  get(id) {
    const key   = String(id);
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this._map.delete(key);
      return undefined;
    }
    return entry;
  },

  delete(id) {
    this._map.delete(String(id));
  },

  // Purge expired entries (called periodically)
  purge() {
    const now = Date.now();
    for (const [k, v] of this._map) {
      if (now > v.expiresAt) this._map.delete(k);
    }
  },
};

// Purge expired pending states every 5 minutes
setInterval(() => pendingState.purge(), 5 * 60 * 1000);

// ─── /start ───────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const userId     = ctx.from.id;
  const startParam = ctx.startPayload;

  // Clear any stale pending flow
  pendingState.delete(userId);

  if (startParam && startParam.length >= 6) {
    await ctx.reply('Перевіряємо код...');
    try {
      const { driverId, driverName } = await db.validateLinkToken(startParam);
      await db.linkTelegramUser(userId, driverId, buildName(ctx.from));
      await db.consumeToken(startParam);
      setSession(userId, { driverId, driverName });
      await ctx.reply(
        `✅ Прив'язано успішно!\n\nВи увійшли як: <b>${fmt.escapeHtml(driverName)}</b>\n\nОберіть дію:`,
        { parse_mode: 'HTML', ...mainMenu }
      );
    } catch (e) {
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
  const lines = [
    '<b>Доступні дії:</b>', '',
    '<b>Мої поїздки</b> — останні поїздки з пагінацією',
    '<b>Статистика</b> — пробіг за поточний місяць',
    '<b>Сьогодні / Тиждень / Місяць</b> — поїздки за обраний період',
    '<b>Власний період</b> — поїздки за довільні дати (макс. 366 днів)',
    '<b>Профіль</b> — інформація про акаунт',
    '',
    '<b>/menu</b> — показати головне меню',
    '<b>/unlink</b> — відключити Telegram від аккаунту',
    isDispatcher(ctx.from.id) ? '<b>/status</b> — статус бота (диспетчер)' : '',
    '',
    '⚠️ Управління акаунтом також доступне через сайт.',
  ].filter(Boolean);
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
});

// ─── /menu ────────────────────────────────────────────────────────────────────
bot.command('menu', async (ctx) => {
  pendingState.delete(ctx.from.id);
  const session = await getSession(ctx.from.id);
  if (session) {
    const menu = isDispatcher(ctx.from.id) ? dispatcherMenu : mainMenu;
    await ctx.reply('Головне меню:', { ...menu });
  } else if (isDispatcher(ctx.from.id)) {
    await ctx.reply('Меню диспетчера:', { ...dispatcherMenu });
  } else {
    await ctx.reply(
      'Ваш акаунт не прив\'язаний. Перейдіть на сайт — <b>Профіль — Telegram</b>.',
      { parse_mode: 'HTML', ...Markup.removeKeyboard() }
    );
  }
});

// ─── /status (dispatcher only) ───────────────────────────────────────────────
bot.command('status', async (ctx) => {
  if (!isDispatcher(ctx.from.id)) {
    await ctx.reply('⛔ Доступно лише для диспетчерів.');
    return;
  }
  try {
    const users    = await db.getAllLinkedUsers();
    const uptime   = process.uptime();
    const mem      = process.memoryUsage();

    await ctx.reply(fmt.formatBotStatus({
      driverCount:   users.length,
      uptimeHours:   Math.floor(uptime / 3600),
      uptimeMinutes: Math.floor((uptime % 3600) / 60),
      memoryMb:      Math.round(mem.rss / 1024 / 1024),
      channels:      realtimeChannels.map(ch => ({ topic: ch.topic, state: ch.state })),
    }), { parse_mode: 'HTML' });
  } catch (e) {
    log.error('/status error:', e.message);
    await ctx.reply('Помилка отримання статусу.');
  }
});
// ─── /unlink ──────────────────────────────────────────────────────────────────
bot.command('unlink', async (ctx) => {
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

// ─── Broadcast confirm/cancel ─────────────────────────────────────────────────
bot.action('broadcast_confirm', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isDispatcher(ctx.from.id)) return;
  const pending = pendingState.get(String(ctx.from.id));
  if (!pending || pending.type !== 'broadcast_confirm') {
    await ctx.editMessageText('❌ Сесія розсилки застаріла. Почніть заново.');
    return;
  }
  pendingState.delete(String(ctx.from.id));
  await ctx.editMessageText('⏳ Розсилка виконується...');
  try {
    const { sent, failed } = await executeBroadcast(pending.broadcastText);
    await ctx.reply(
      `✅ Розсилку завершено.\n✉️ Надіслано: <b>${sent}</b>\n❌ Помилок: <b>${failed}</b>`,
      { parse_mode: 'HTML', ...dispatcherMenu }
    );
  } catch (e) {
    log.error('broadcast_confirm execute error:', e.message);
    await ctx.reply('❌ Помилка при розсилці. Спробуйте пізніше.', dispatcherMenu);
  }
});

bot.action('broadcast_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  pendingState.delete(String(ctx.from.id));
  await ctx.editMessageText('❌ Розсилку скасовано.');
  await ctx.reply('Оберіть дію:', dispatcherMenu);
});

bot.action('confirm_unlink', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await db.unlinkTelegramUser(ctx.from.id);
    clearSession(ctx.from.id);
    await ctx.editMessageText('✅ Telegram відключено. Щоб повторно підключитись — скористайтесь посиланням з сайту.');
  } catch (e) {
    log.error('unlink error:', e.message);
    await ctx.editMessageText('❌ Помилка при відключенні. Спробуйте пізніше або зверніться через сайт.');
  }
});

bot.action('cancel_unlink', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Скасовано. Ваш акаунт залишається підключеним ✅');
});

// ─── Trip create/complete: cancel ────────────────────────────────────────────
bot.action('trip_create_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  pendingState.delete(String(ctx.from.id));
  await ctx.editMessageText('Скасовано.');
  await ctx.reply('Оберіть дію:', dispatcherMenu);
});

// ─── Trip create: pick driver ─────────────────────────────────────────────────
bot.action(/^pick_driver_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isDispatcher(ctx.from.id)) return;

  const driverId = parseInt(ctx.match[1], 10);
  const pending  = pendingState.get(String(ctx.from.id));
  if (!pending || pending.type !== 'trip_create_driver') {
    await ctx.editMessageText('Сесія застаріла. Почніть заново.');
    return;
  }

  const driverName = (pending.drivers || []).find(d => d.id === driverId)?.name || String(driverId);

  try {
    const cars = await db.getActiveCars();
    if (!cars.length) {
      await ctx.editMessageText('Немає активних автомобілів.');
      await ctx.reply('Оберіть дію:', dispatcherMenu);
      return;
    }
    pendingState.set(String(ctx.from.id), { type: 'trip_create_car', driverId, driverName, cars });
    const buttons = cars.map(c => {
      const label = `${c.brand} ${c.model} (${c.plate})`;
      return [Markup.button.callback(label, `pick_car_${c.id}`)];
    });
    buttons.push([Markup.button.callback('❌ Скасувати', 'trip_create_cancel')]);
    await ctx.editMessageText(
      `Водій: ${fmt.bold(fmt.escapeHtml(driverName))}\n\nОберіть автомобіль:`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
    );
  } catch (e) {
    log.error('pick_driver — load cars:', e.message);
    await ctx.editMessageText('Помилка завантаження автомобілів.');
  }
});

// ─── Trip create: pick car ────────────────────────────────────────────────────
bot.action(/^pick_car_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isDispatcher(ctx.from.id)) return;

  const carId   = parseInt(ctx.match[1], 10);
  const pending = pendingState.get(String(ctx.from.id));

  if (!pending || pending.type !== 'trip_create_car') {
    await ctx.editMessageText('Сесія застаріла. Почніть заново.');
    return;
  }

  const carObj  = (pending.cars || []).find(c => c.id === carId);
  const carName = carObj ? `${carObj.brand} ${carObj.model} (${carObj.plate})` : String(carId);

  pendingState.set(String(ctx.from.id), { ...pending, type: 'trip_create_route', carId, carName });
  await ctx.editMessageText(
    `Водій: ${fmt.bold(fmt.escapeHtml(pending.driverName))}\nАвто: ${fmt.bold(fmt.escapeHtml(carName))}`,
    { parse_mode: 'HTML' }
  );
  await ctx.reply('Введіть маршрут (наприклад: Київ — Львів):', Markup.keyboard([['❌ Скасувати']]).resize());
});

// ─── Trip complete: pick trip ─────────────────────────────────────────────────
bot.action(/^pick_trip_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isDispatcher(ctx.from.id)) return;

  const tripId = parseInt(ctx.match[1], 10);

  try {
    const trip = await db.getTripById(tripId);
    if (!trip) {
      await ctx.editMessageText('Поїздку не знайдено.');
      return;
    }
    const carStr = trip.car ? `${trip.car.brand} ${trip.car.model} (${trip.car.plate})` : '—';
    pendingState.set(String(ctx.from.id), { type: 'trip_complete_mileage', tripId, trip });
    await ctx.editMessageText(
      [
        fmt.bold('Завершення поїздки'),
        fmt.divider(),
        `Водій: ${fmt.bold(trip.driver?.name || '—')}`,
        `Маршрут: ${fmt.bold(trip.route || '—')}`,
        `Авто: ${fmt.bold(carStr)}`,
        `Початок: ${fmt.bold(trip.start_mileage + ' км')}`,
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
    await ctx.reply('Введіть кінцевий пробіг (км):', Markup.keyboard([['❌ Скасувати']]).resize());
  } catch (e) {
    log.error('pick_trip:', e.message);
    await ctx.editMessageText('Помилка завантаження поїздки.');
  }
});

// ─── Trip create: overnight choice ───────────────────────────────────────────
bot.action('trip_overnight_yes', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isDispatcher(ctx.from.id)) return;
  const pending = pendingState.get(String(ctx.from.id));
  if (!pending || pending.type !== 'trip_create_overnight') return;
  pendingState.set(String(ctx.from.id), { ...pending, type: 'trip_create_notes', isOvernight: true });
  await ctx.editMessageText('Нічна поїздка ✓');
  await ctx.reply(
    'Додайте нотатку або надішліть "без нотаток":',
    Markup.keyboard([['без нотаток'], ['❌ Скасувати']]).resize()
  );
});

bot.action('trip_overnight_no', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isDispatcher(ctx.from.id)) return;
  const pending = pendingState.get(String(ctx.from.id));
  if (!pending || pending.type !== 'trip_create_overnight') return;
  pendingState.set(String(ctx.from.id), { ...pending, type: 'trip_create_notes', isOvernight: false });
  await ctx.editMessageText('Звичайна поїздка ✓');
  await ctx.reply(
    'Додайте нотатку або надішліть "без нотаток":',
    Markup.keyboard([['без нотаток'], ['❌ Скасувати']]).resize()
  );
});

// ─── Trip create: execute ─────────────────────────────────────────────────────
async function doCreateTrip(ctx, userId, pending) {
  try {
    const tripId = await db.createTrip({
      driverId:     pending.driverId,
      carId:        pending.carId,
      date:         pending.date,
      route:        pending.route,
      startMileage: pending.startMileage,
      tariff:       0,
      notes:        pending.notes || '',
      isOvernight:  pending.isOvernight,
    });
    pendingState.delete(String(userId));
    await ctx.reply(
      [
        fmt.bold('Поїздку створено'),
        fmt.divider(),
        `Водій: ${fmt.bold(pending.driverName)}`,
        `Авто: ${fmt.bold(pending.carName)}`,
        `Дата: ${fmt.bold(formatDateDisplay(pending.date))}`,
        `Маршрут: ${fmt.bold(pending.route)}`,
        `Початок: ${fmt.bold(pending.startMileage + ' км')}`,
        pending.isOvernight ? fmt.italic('Нічна — пробіг буде внесено пізніше') : '',
        pending.notes ? fmt.italic(pending.notes) : '',
      ].filter(Boolean).join('\n'),
      { parse_mode: 'HTML', ...dispatcherMenu }
    );
    log.info(`[Trip] created id=${tripId} driver=${pending.driverId} by dispatcher=${userId}`);
  } catch (e) {
    log.error('doCreateTrip:', e.message);
    pendingState.delete(String(userId));
    await ctx.reply('❌ Помилка при створенні поїздки.', dispatcherMenu);
  }
}
// contextKey: 'recent' | 'today' | 'week' | 'month' | 'last_month' | 'custom_START_END'
// Regex: everything up to the LAST underscore+digits at end = offset
bot.action(/^trips_page_(.+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const contextKey = ctx.match[1];
  const offset     = parseInt(ctx.match[2], 10);
  const session    = await getSession(ctx.from.id);

  if (!session) {
    await ctx.reply('Сесія закінчилась. Натисніть /start');
    return;
  }

  try {
    const LIMIT = 10;
    let trips = [], total = 0;

    if (contextKey === 'recent') {
      const result = await db.getDriverRecentTrips(session.driverId, LIMIT, offset);
      trips = result.trips;
      total = result.total;
    } else if (contextKey.startsWith('custom')) {
      // custom_YYYY-MM-DD_YYYY-MM-DD  (but '_' is in date too — split carefully)
      const dateMatch = contextKey.match(/^custom_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/);
      if (dateMatch) {
        const all = await db.getDriverTrips(session.driverId, dateMatch[1], dateMatch[2]);
        total = all.length;
        trips = all.slice(offset, offset + LIMIT);
      }
    } else {
      const { start, end } = db.getDateRange(contextKey);
      const all = await db.getDriverTrips(session.driverId, start, end);
      total = all.length;
      trips = all.slice(offset, offset + LIMIT);
    }

    const hasMore = offset + LIMIT < total;
    const title   = `<b>Поїздки — ${fmt.escapeHtml(session.driverName)}</b>`;
    const msg     = fmt.formatTripList(trips, title, {
      current: Math.min(offset + LIMIT, total),
      total,
      hasMore,
    });

    const keyboard = tripsPageKeyboard(offset, LIMIT, total, contextKey);
    const opts     = { parse_mode: 'HTML', ...(keyboard || {}) };

    await ctx.editMessageText(msg, opts).catch(() => ctx.reply(msg, opts));
  } catch (e) {
    log.error('pagination error:', e.message);
    await ctx.reply('Помилка при завантаженні. Спробуйте ще раз.');
  }
});

// ─── Text handler ─────────────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text   = ctx.message.text.trim();

  try {
    checkRateLimit(userId);
  } catch (e) {
    await ctx.reply(e.message);
    return;
  }

  // ── Dispatcher commands ──────────────────────────────────────────────────────
  if (isDispatcher(userId)) {
    if (text === '📋 Всі водії (місяць)') {
      await handleDispatcherStats(ctx, 'month');
      return;
    }
    if (text === '📋 Всі водії (тиждень)') {
      await handleDispatcherStats(ctx, 'week');
      return;
    }
    if (text === '◀️ Головне меню') {
      // Dispatcher may also be a driver
      const session = await getSession(userId);
      const menu    = session ? mainMenu : dispatcherMenu;
      await ctx.reply('Головне меню:', menu);
      return;
    }
    if (text === '📢 Розсилка') {
      pendingState.set(String(userId), { type: 'broadcast' });
      await ctx.reply(
        '📢 Введіть текст повідомлення для розсилки всім водіям:',
        Markup.keyboard([['❌ Скасувати']]).resize()
      );
      return;
    }
    if (text === '➕ Створити поїздку') {
      try {
        const drivers = await db.getActiveDrivers();
        if (!drivers.length) {
          await ctx.reply('Немає активних водіїв.', dispatcherMenu);
          return;
        }
        const buttons = drivers.map(d => [Markup.button.callback(d.name, `pick_driver_${d.id}`)]);
        buttons.push([Markup.button.callback('❌ Скасувати', 'trip_create_cancel')]);
        await ctx.reply('Оберіть водія:', Markup.inlineKeyboard(buttons));
        // Store drivers list in pending so we can resolve name by id later
        pendingState.set(String(userId), { type: 'trip_create_driver', drivers });
      } catch (e) {
        log.error('create trip — load drivers:', e.message);
        await ctx.reply('Помилка завантаження водіїв.', dispatcherMenu);
      }
      return;
    }

    if (text === '✅ Завершити поїздку') {
      try {
        const open = await db.getOpenOvernightTrips();
        if (!open.length) {
          await ctx.reply('Немає незавершених нічних поїздок.', dispatcherMenu);
          return;
        }
        pendingState.set(String(userId), { type: 'trip_complete_pick' });
        const buttons = open.map(t => {
          const label = `${t.driver.name} — ${t.route || '—'} (${t.date})`;
          return [Markup.button.callback(label, `pick_trip_${t.id}`)];
        });
        buttons.push([Markup.button.callback('❌ Скасувати', 'trip_create_cancel')]);
        await ctx.reply('Оберіть поїздку для завершення:', Markup.inlineKeyboard(buttons));
      } catch (e) {
        log.error('complete trip — load open trips:', e.message);
        await ctx.reply('Помилка завантаження поїздок.', dispatcherMenu);
      }
      return;
    }

    if (text === '⚙️ Статус') {
      try {
        const users  = await db.getAllLinkedUsers();
        const uptime = process.uptime();
        const mem    = process.memoryUsage();
        await ctx.reply(fmt.formatBotStatus({
          driverCount:   users.length,
          uptimeHours:   Math.floor(uptime / 3600),
          uptimeMinutes: Math.floor((uptime % 3600) / 60),
          memoryMb:      Math.round(mem.rss / 1024 / 1024),
          channels:      realtimeChannels.map(ch => ({ topic: ch.topic, state: ch.state })),
        }), { parse_mode: 'HTML' });
      } catch (e) {
        log.error('status button error:', e.message);
        await ctx.reply('Помилка отримання статусу.');
      }
      return;
    }
  }

  // ── Cancel any pending flow ────────────────────────────────────────────────
  if (text === '❌ Скасувати') {
    pendingState.delete(String(userId));
    const session = await getSession(userId);
    const menu    = session ? mainMenu : (isDispatcher(userId) ? dispatcherMenu : Markup.removeKeyboard());
    await ctx.reply('Скасовано.', menu);
    return;
  }

  // ── Handle pending states (FSM) ────────────────────────────────────────────
  const pending = pendingState.get(String(userId));

  if (pending) {
    if (pending.type === 'broadcast') {
      // Store text, ask for confirmation
      const users = await db.getAllLinkedUsers().catch(() => []);
      pendingState.set(String(userId), { type: 'broadcast_confirm', broadcastText: text });
      await ctx.reply(
        `📢 <b>Попередній перегляд розсилки:</b>\n\n${fmt.escapeHtml(text)}\n\n${fmt.divider()}\n📬 Буде надіслано: <b>${users.length}</b> водіям`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ Надіслати', 'broadcast_confirm'),
              Markup.button.callback('❌ Скасувати', 'broadcast_cancel'),
            ],
          ]),
        }
      );
      return;
    }

    if (pending.type === 'broadcast_confirm') {
      // User typed something while waiting for confirmation — remind them
      await ctx.reply(
        '⏳ Очікується підтвердження розсилки. Натисніть кнопку вище або скасуйте.',
        Markup.inlineKeyboard([[
          Markup.button.callback('✅ Надіслати', 'broadcast_confirm'),
          Markup.button.callback('❌ Скасувати', 'broadcast_cancel'),
        ]])
      );
      return;
    }

    if (pending.type === 'date_range_start') {
      const date = parseDate(text);
      if (!date) {
        await ctx.reply('❌ Невірний формат. Введіть дату у форматі ДД.ММ.РРРР:');
        return;
      }
      pendingState.set(String(userId), { type: 'date_range_end', startDate: date });
      await ctx.reply('📅 Тепер введіть кінцеву дату (ДД.ММ.РРРР):');
      return;
    }

    if (pending.type === 'date_range_end') {
      const date = parseDate(text);
      if (!date) {
        await ctx.reply('❌ Невірний формат. Введіть дату у форматі ДД.ММ.РРРР:');
        return;
      }
      if (new Date(date) < new Date(pending.startDate)) {
        await ctx.reply('❌ Кінцева дата має бути після початкової. Введіть ще раз:');
        return;
      }
      pendingState.delete(String(userId));
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

    // ── Trip create FSM ──────────────────────────────────────────────────────

    if (pending.type === 'trip_create_route') {
      if (!text.trim()) {
        await ctx.reply('Маршрут не може бути порожнім. Введіть ще раз:');
        return;
      }
      pendingState.set(String(userId), { ...pending, type: 'trip_create_mileage', route: text.trim() });
      await ctx.reply('Введіть початковий пробіг (км):');
      return;
    }

    if (pending.type === 'trip_create_mileage') {
      const km = parseInt(text.trim(), 10);
      if (isNaN(km) || km < 0) {
        await ctx.reply('❌ Введіть коректне число (км):');
        return;
      }
      pendingState.set(String(userId), { ...pending, type: 'trip_create_date', startMileage: km });
      await ctx.reply(`Введіть дату поїздки у форматі ДД.ММ.РРРР\n(або надішліть ${fmt.mono('сьогодні')}):`, { parse_mode: 'HTML' });
      return;
    }

    if (pending.type === 'trip_create_date') {
      const raw  = text.trim().toLowerCase();
      const date = raw === 'сьогодні' ? db.toISODate(new Date()) : parseDate(text);
      if (!date) {
        await ctx.reply('❌ Невірний формат. Введіть дату ДД.ММ.РРРР або "сьогодні":');
        return;
      }
      pendingState.set(String(userId), { ...pending, type: 'trip_create_overnight', date });
      await ctx.reply(
        'Це нічна поїздка? (пробіг буде внесено пізніше)',
        Markup.inlineKeyboard([[
          Markup.button.callback('Так, нічна', 'trip_overnight_yes'),
          Markup.button.callback('Ні, звичайна', 'trip_overnight_no'),
        ]])
      );
      return;
    }

    if (pending.type === 'trip_create_notes') {
      const notes = text.trim().toLowerCase() === 'без нотаток' ? '' : text.trim();
      await doCreateTrip(ctx, userId, { ...pending, notes });
      return;
    }

    // ── Trip complete FSM ────────────────────────────────────────────────────

    if (pending.type === 'trip_complete_mileage') {
      const km = parseInt(text.trim(), 10);
      if (isNaN(km) || km < 0) {
        await ctx.reply('❌ Введіть коректне число (км):');
        return;
      }
      if (km <= pending.trip.start_mileage) {
        await ctx.reply(`❌ Кінцевий пробіг має бути більше початкового (${pending.trip.start_mileage} км). Введіть ще раз:`);
        return;
      }
      try {
        await db.completeTrip(pending.tripId, km);
        pendingState.delete(String(userId));
        const distance = km - pending.trip.start_mileage;
        await ctx.reply(
          [
            fmt.bold('Поїздку завершено'),
            fmt.divider(),
            `Водій: ${fmt.bold(pending.trip.driver?.name || '—')}`,
            `Маршрут: ${fmt.bold(pending.trip.route || '—')}`,
            `Пробіг: ${fmt.bold(distance + ' км')} ${fmt.italic(`(${pending.trip.start_mileage} → ${km})`)}`,
          ].join('\n'),
          { parse_mode: 'HTML', ...dispatcherMenu }
        );
      } catch (e) {
        log.error('trip_complete_mileage:', e.message);
        await ctx.reply('❌ Помилка при завершенні поїздки.', dispatcherMenu);
      }
      return;
    }

  } // end if (pending)

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
    // Dispatcher without driver account
    if (!isDispatcher(userId)) return;
    await ctx.reply('Оберіть дію:', dispatcherMenu);
    return;
  }

  switch (text) {
    case 'Мої поїздки': {
      await ctx.reply('Завантаження...');
      try {
        const LIMIT = 10;
        const { trips, total, hasMore } = await db.getDriverRecentTrips(session.driverId, LIMIT, 0);
        const title = `<b>Поїздки — ${fmt.escapeHtml(session.driverName)}</b>`;
        const msg   = fmt.formatTripList(trips, title, { current: Math.min(LIMIT, total), total, hasMore });
        const keyboard = tripsPageKeyboard(0, LIMIT, total, 'recent');
        await ctx.reply(msg, { parse_mode: 'HTML', ...(keyboard || {}) });
      } catch (e) {
        log.error('getDriverRecentTrips:', e.message);
        await ctx.reply('Помилка завантаження поїздок. Спробуйте пізніше.');
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
        log.error('Статистика:', e.message);
        await ctx.reply('Помилка завантаження статистики. Спробуйте пізніше.');
      }
      break;
    }

    case 'Сьогодні':       await handlePeriod(ctx, 'today',      session); break;
    case 'Цей тиждень':    await handlePeriod(ctx, 'week',       session); break;
    case 'За місяць':      await handlePeriod(ctx, 'month',      session); break;
    case 'Минулий місяць': await handlePeriod(ctx, 'last_month', session); break;

    case 'Власний період': {
      pendingState.set(String(userId), { type: 'date_range_start' });
      await ctx.reply(
        '📅 Введіть початкову дату у форматі <b>ДД.ММ.РРРР</b>:',
        { parse_mode: 'HTML', ...Markup.keyboard([['❌ Скасувати']]).resize() }
      );
      break;
    }

    case 'Профіль': {
      await ctx.reply([
        fmt.bold('Профіль'),
        fmt.divider(),
        `Імʼя: ${fmt.bold(session.driverName)}`,
        `Telegram: ${fmt.mono(buildName(ctx.from))}`,
        `ID: ${fmt.mono(String(userId))}`,
        ``,
        fmt.italic('Щоб відключити Telegram — команда /unlink'),
      ].join('\n'), { parse_mode: 'HTML' });
      break;
    }

    default:
      // Silently ignore unknown text — don't confuse user with errors
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
      const LIMIT = 10;
      const slice = trips.slice(0, LIMIT);
      const msg   = fmt.formatTripList(
        slice,
        `<b>Поїздки — ${label}</b>`,
        { current: Math.min(LIMIT, trips.length), total: trips.length, hasMore: trips.length > LIMIT }
      );
      const keyboard = tripsPageKeyboard(0, LIMIT, trips.length, period);
      await ctx.reply(msg, { parse_mode: 'HTML', ...(keyboard || {}) });
    }
  } catch (e) {
    log.error(`handlePeriod(${period}):`, e.message);
    await ctx.reply('Помилка завантаження. Спробуйте пізніше.');
  }
}

// ─── Custom date range handler ────────────────────────────────────────────────
const MAX_DATE_RANGE_DAYS = 366;

async function handleCustomRange(ctx, session, startDate, endDate) {
  // Validate range length
  const msPerDay = 24 * 60 * 60 * 1000;
  const days = Math.round((new Date(endDate) - new Date(startDate)) / msPerDay);
  if (days > MAX_DATE_RANGE_DAYS) {
    await ctx.reply(
      `❌ Максимальний діапазон — ${MAX_DATE_RANGE_DAYS} днів.\nВи обрали ${days} днів. Введіть менший діапазон.`,
      isDispatcher(ctx.from.id) ? dispatcherMenu : mainMenu
    );
    return;
  }

  try {
    const trips = await db.getDriverTrips(session.driverId, startDate, endDate);
    const stats = db.calcStats(trips);
    const label = `${formatDateDisplay(startDate)} — ${formatDateDisplay(endDate)}`;

    await ctx.reply(
      fmt.formatStatsWithoutAmount(stats, `${session.driverName} — ${label}`),
      { parse_mode: 'HTML' }
    );

    if (trips.length > 0) {
      const LIMIT      = 10;
      const slice      = trips.slice(0, LIMIT);
      const contextKey = `custom_${startDate}_${endDate}`;
      const msg        = fmt.formatTripList(
        slice,
        `<b>Поїздки — ${label}</b>`,
        { current: Math.min(LIMIT, trips.length), total: trips.length, hasMore: trips.length > LIMIT }
      );
      const keyboard = tripsPageKeyboard(0, LIMIT, trips.length, contextKey);
      await ctx.reply(msg, { parse_mode: 'HTML', ...(keyboard || {}) });
    }
  } catch (e) {
    log.error('handleCustomRange:', e.message);
    await ctx.reply('Помилка завантаження. Спробуйте пізніше.');
  }
}

// ─── Dispatcher: all drivers stats ───────────────────────────────────────────
async function handleDispatcherStats(ctx, period) {
  await ctx.reply('Завантаження...');
  try {
    const { start, end } = db.getDateRange(period);
    const allStats = await db.getAllDriversStats(start, end);
    const label    = period === 'month' ? 'Всі водії — цей місяць' : 'Всі водії — цей тиждень';
    await ctx.reply(
      fmt.formatDispatcherStats(allStats, label),
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    log.error('handleDispatcherStats:', e.message);
    await ctx.reply('Помилка завантаження статистики.');
  }
}

// ─── Dispatcher: broadcast (execute) ─────────────────────────────────────────
async function executeBroadcast(text) {
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
    } catch {
      failed++;
    }
  }

  log.info(`[Broadcast] sent=${sent} failed=${failed}`);
  return { sent, failed };
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
      log.info(`[Notify] driver_id=${driverId} not linked to Telegram, skipping`);
      return;
    }
    const msg = buildMsg();
    await bot.telegram.sendMessage(telegramId, msg, { parse_mode: 'HTML' });
    log.info(`[Notify] sent to telegramId=${telegramId} for trip id=${tripId}`);
  } catch (e) {
    log.error(`[Notify] failed for trip id=${tripId}:`, e.message);
  }
}

// ─── Trip created notification ────────────────────────────────────────────────
async function notifyTripCreated(trip) {
  if (!trip.driver_id) return;

  await sendNotification(trip.driver_id, trip.id, () => {
    const carStr = trip.car ? `${trip.car.brand} ${trip.car.model} (${trip.car.plate})` : '—';
    return fmt.formatTripCreatedNotification({
      dateFormatted: formatDateUk(trip.date),
      route:         trip.route || '—',
      car:           carStr,
      notes:         trip.notes || '',
      is_overnight:  trip.is_overnight,
    });
  });
}

// ─── Trip completed notification ──────────────────────────────────────────────
async function notifyTripCompleted(trip) {
  if (!trip.driver_id) return;

  await sendNotification(trip.driver_id, trip.id, () => {
    const distance = Math.max(0, (trip.end_mileage || 0) - (trip.start_mileage || 0));
    return fmt.formatTripCompletedNotification({
      dateFormatted: formatDateUk(trip.date),
      route:         trip.route || '—',
      distance,
      startMileage:  trip.start_mileage,
      endMileage:    trip.end_mileage,
    });
  });
}

// ─── Trip deleted notification ────────────────────────────────────────────────
async function notifyTripDeleted(trip) {
  if (!trip.driver_id) return;

  const car = trip.car_id ? await db.getCarById(trip.car_id).catch(() => null) : null;
  const carStr = car ? `${car.brand} ${car.model} (${car.plate})` : null;

  await sendNotification(trip.driver_id, trip.id, () => {
    return fmt.formatTripDeletedNotification({
      dateFormatted: formatDateUk(trip.date),
      route:         trip.route || '—',
      car:           carStr,
    });
  });
}

// ─── Weekly digest cron ───────────────────────────────────────────────────────
// Runs every Monday at 09:00
function startWeeklyDigest() {
  cron.schedule('0 9 * * 1', async () => {
    log.info('[Digest] Starting weekly digest...');
    try {
      const users = await db.getAllLinkedUsers();
      const now   = new Date();

      // Last 7 days
      const end   = db.toISODate(now);
      const d7    = new Date(now); d7.setDate(d7.getDate() - 6);
      const start = db.toISODate(d7);

      const weekLabel = `${formatDateDisplay(start)} — ${formatDateDisplay(end)}`;

      for (const u of users) {
        try {
          const trips = await db.getDriverTrips(u.driver_id, start, end);
          const stats = db.calcStats(trips);
          const msg   = fmt.formatWeeklyDigest(stats, u.driver.name, weekLabel);
          await bot.telegram.sendMessage(u.telegram_id, msg, { parse_mode: 'HTML' });
          log.info(`[Digest] sent to driver_id=${u.driver_id}`);
        } catch (e) {
          log.error(`[Digest] failed for driver_id=${u.driver_id}:`, e.message);
        }
      }

      log.info(`[Digest] Done. Sent to ${users.length} users.`);
    } catch (e) {
      log.error('[Digest] Fatal:', e.message);
    }
  }, { timezone: 'Europe/Kyiv' });

  log.info('[Digest] Weekly digest cron scheduled (Mon 09:00 Kyiv)');
}

// ─── Realtime listener with auto-reconnect ────────────────────────────────────
let realtimeChannels   = [];
let healthCheckInterval = null;
let keepaliveInterval   = null;
let server             = null;

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

  // ── INSERT (trip created) ──────────────────────────────────────────────────
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
        }
      })
    .subscribe((status, err) => {
      log.info('[Realtime] trips-created status:', status);
      if (err) log.error('[Realtime] trips-created error:', err.message);
    });

  // ── UPDATE (trip completed) ────────────────────────────────────────────────
  const chCompleted = db.supabase
    .channel('trips-completed')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'trips' },
      (payload) => {
        const { new: newRow, old: oldRow } = payload;
        log.info(`[Realtime] trip UPDATE id=${newRow.id} | old.end_mileage=${oldRow.end_mileage} | new.end_mileage=${newRow.end_mileage}`);
        if (oldRow.end_mileage == null && newRow.end_mileage != null) {
          notifyTripCompleted(newRow).catch(e =>
            log.error(`[Realtime] Error processing UPDATE:`, e.message)
          );
        }
      })
    .subscribe((status, err) => {
      log.info('[Realtime] trips-completed status:', status);
      if (err) log.error('[Realtime] trips-completed error:', err.message);
    });

  // ── DELETE (trip deleted) ──────────────────────────────────────────────────
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
        }
      })
    .subscribe((status, err) => {
      log.info('[Realtime] trips-deleted status:', status);
      if (err) log.error('[Realtime] trips-deleted error:', err.message);
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
        log.info(`[Keepalive] ping ${res.status}`);
      } catch (e) {
        log.warn('[Keepalive] ping failed:', e.message);
      }
    }, 10 * 60 * 1000);
  }
}

// ─── Error handler ────────────────────────────────────────────────────────────
bot.catch((err, ctx) => {
  log.error(`Unhandled bot error [user=${ctx.from?.id}]:`, err.message);
  ctx.reply('Виникла помилка. Спробуйте /start').catch(() => { });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal) {
  log.info(`${signal} received. Shutting down gracefully...`);

  if (healthCheckInterval) clearInterval(healthCheckInterval);
  if (keepaliveInterval)   clearInterval(keepaliveInterval);

  cleanupChannels();

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

/** Parse DD.MM.YYYY → YYYY-MM-DD string or null */
function parseDate(str) {
  const m = str.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const date = new Date(`${y}-${mo}-${d}`);
  if (isNaN(date.getTime())) return null;
  return `${y}-${mo}-${d}`;
}

/** YYYY-MM-DD → DD.MM.YYYY for display */
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
      domain:       WEBHOOK_URL,
      path:         webhookPath,
      secret_token: WEBHOOK_SECRET || undefined,
    });

    server = http.createServer(async (req, res) => {
      if (req.url.startsWith(webhookPath) && req.method === 'POST') {
        await webhookHandler(req, res);
      } else if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status:           'ok',
          timestamp:        new Date().toISOString(),
          uptime:           process.uptime(),
          realtimeChannels: realtimeChannels.map(ch => ({ topic: ch.topic, state: ch.state })),
          memory:           process.memoryUsage(),
        }));
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
    startWeeklyDigest();

  } else {
    log.info('WEBHOOK_URL not set — falling back to long polling (local dev mode)');
    await bot.launch();
    const name = bot.botInfo?.username ? `@${bot.botInfo.username}` : '...';
    log.info(`Bot started (polling): ${name}`);
    startRealtimeListener();
    startWeeklyDigest();
  }
}

process.once('SIGINT',  () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

start().catch(e => {
  log.error('Startup error:', e.message);
  process.exit(1);
});
