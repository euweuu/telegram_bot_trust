const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ─── Telegram Token Auth ──────────────────────────────────────────────────────

/**
 * Validate a link token from the site.
 * Returns { driverId, driverName } if valid, or throws.
 */
async function validateLinkToken(token) {
  const { data, error } = await supabase
    .from('telegram_link_tokens')
    .select('token, driver_id, expires_at, used, driver:drivers(id, name, active)')
    .eq('token', token.toUpperCase())
    .maybeSingle();

  if (error) throw new Error('Помилка бази даних');
  if (!data) throw new Error('Код не знайдено. Згенеруйте новий код на сайті.');
  if (data.used) throw new Error('Цей код вже використано. Згенеруйте новий на сайті.');
  if (new Date() > new Date(data.expires_at)) throw new Error('Термін дії коду вийшов. Згенеруйте новий на сайті.');
  if (!data.driver?.active) throw new Error('Водія не знайдено або він неактивний.');

  return { driverId: data.driver.id, driverName: data.driver.name };
}

/**
 * Mark a token as used (after successful linking).
 */
async function consumeToken(token) {
  await supabase
    .from('telegram_link_tokens')
    .update({ used: true })
    .eq('token', token.toUpperCase());
}

/**
 * Save or update the Telegram ↔ Driver mapping.
 */
async function linkTelegramUser(telegramId, driverId, telegramName) {
  const { error } = await supabase
    .from('telegram_users')
    .upsert([{
      telegram_id: telegramId,
      driver_id: driverId,
      telegram_name: telegramName,
      linked_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
    }], { onConflict: 'telegram_id' });

  if (error) throw error;
}

/**
 * Find driver linked to a Telegram ID (persistent session from DB).
 */
async function getLinkedDriver(telegramId) {
  const { data, error } = await supabase
    .from('telegram_users')
    .select('driver_id, driver:drivers(id, name, active)')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (error || !data) return null;
  if (!data.driver?.active) return null;

  // Update last_seen silently
  supabase
    .from('telegram_users')
    .update({ last_seen: new Date().toISOString() })
    .eq('telegram_id', telegramId)
    .then(() => { });

  return { driverId: data.driver.id, driverName: data.driver.name };
}

// ─── Trips ────────────────────────────────────────────────────────────────────

/**
 * Get trips for a specific driver in a date range.
 */
async function getDriverTrips(driverId, startDate, endDate) {
  const { data, error } = await supabase
    .from('trips')
    .select(`
      id,
      date,
      route,
      start_mileage,
      end_mileage,
      tariff,
      notes,
      is_overnight,
      car:cars(brand, model, plate)
    `)
    .eq('driver_id', driverId)
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: false });

  if (error) throw error;
  return (data || []).map(formatTrip);
}

/**
 * Get recent trips for a driver (last N trips).
 */
async function getDriverRecentTrips(driverId, limit = 10) {
  const { data, error } = await supabase
    .from('trips')
    .select(`
      id,
      date,
      route,
      start_mileage,
      end_mileage,
      tariff,
      notes,
      is_overnight,
      car:cars(brand, model, plate)
    `)
    .eq('driver_id', driverId)
    .order('date', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data || []).map(formatTrip);
}

// ─── Analytics ────────────────────────────────────────────────────────────────

/**
 * Calculate statistics from a trips array.
 */
function calcStats(trips) {
  const completed = trips.filter(t => !t.isOvernight || t.endMileage != null);
  const totalKm     = completed.reduce((s, t) => s + (t.distance || 0), 0);
  const totalAmount = completed.reduce((s, t) => s + (t.amount   || 0), 0);
  const overnight   = trips.filter(t => t.isOvernight && t.endMileage == null).length;

  return {
    totalTrips:      trips.length,
    completedTrips:  completed.length,
    overnightPending: overnight,
    totalKm:         Math.round(totalKm),
    totalAmount:     Math.round(totalAmount),
    avgKm:           completed.length > 0 ? Math.round(totalKm / completed.length) : 0,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTrip(trip) {
  const isOvernight = trip.is_overnight || false;
  const distance = (isOvernight && trip.end_mileage == null)
    ? null
    : Math.max(0, (trip.end_mileage || 0) - (trip.start_mileage || 0));
  const amount = distance != null ? distance * (trip.tariff || 0) : null;

  return {
    id:           trip.id,
    date:         trip.date,
    dateFormatted: trip.date
      ? new Date(trip.date).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '—',
    route:        trip.route || '—',
    startMileage: trip.start_mileage || 0,
    endMileage:   trip.end_mileage,
    distance,
    tariff:       trip.tariff || 0,
    amount,
    notes:        trip.notes || '',
    isOvernight,
    car:          trip.car ? `${trip.car.brand} ${trip.car.model} (${trip.car.plate})` : '—',
    driverName:   trip.driver?.name || null,
    driverId:     trip.driver?.id   || null,
  };
}

/**
 * Date helpers — returns ISO date string YYYY-MM-DD.
 */
function getDateRange(period) {
  const now = new Date();
  let start, end;

  end = toISODate(now);

  if (period === 'today') {
    start = toISODate(now);
  } else if (period === 'week') {
    const d = new Date(now);
    d.setDate(d.getDate() - 6);
    start = toISODate(d);
  } else if (period === 'month') {
    start = toISODate(new Date(now.getFullYear(), now.getMonth(), 1));
  } else if (period === 'last_month') {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last  = new Date(now.getFullYear(), now.getMonth(), 0);
    start = toISODate(first);
    end   = toISODate(last);
  }

  return { start, end };
}

function toISODate(d) {
  return d.toISOString().split('T')[0];
}

module.exports = {
  supabase,
  // Token-based linking
  validateLinkToken,
  consumeToken,
  linkTelegramUser,
  getLinkedDriver,
  // Trips
  getDriverTrips,
  getDriverRecentTrips,
  // Analytics
  calcStats,
  // Date utils
  getDateRange,
  toISODate,
};
