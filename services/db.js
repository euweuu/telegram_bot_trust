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
  if (!data) throw new Error('Код не знайдено. Zgenerujte новий код на сайті.');
  if (data.used) throw new Error('Цей код вже використано. Zgenerujte новий на сайті.');
  if (new Date() > new Date(data.expires_at)) throw new Error('Термін дії коду вийшов. Zgenerujte новий на сайті.');
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

/**
 * Unlink a Telegram user (self-service).
 */
async function unlinkTelegramUser(telegramId) {
  const { error, count } = await supabase
    .from('telegram_users')
    .delete({ count: 'exact' })
    .eq('telegram_id', telegramId);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Get last non-null end_mileage for a car (for pre-filling start mileage).
 */
async function getLastCarMileage(carId) {
  const { data, error } = await supabase
    .from('trips')
    .select('end_mileage, date')
    .eq('car_id', carId)
    .not('end_mileage', 'is', null)
    .order('date', { ascending: false })
    .order('id',   { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.end_mileage ?? null;
}


async function getAllDriversList() {
  const { data, error } = await supabase
    .from('drivers').select('id, name').eq('active', true).order('name');
  if (error) throw error;
  return data || [];
}

async function getAllCarsList() {
  const { data, error } = await supabase
    .from('cars').select('id, brand, model, plate').eq('active', true).order('brand');
  if (error) throw error;
  return data || [];
}

async function getAdminRecentTrips(limit = 10) {
  const { data, error } = await supabase
    .from('trips')
    .select(`id, date, route, start_mileage, end_mileage, tariff, is_overnight,
      driver:drivers(name), car:cars(brand, model, plate)`)
    .order('date', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(formatTrip);
}

async function getTripById(id) {
  const { data, error } = await supabase
    .from('trips')
    .select(`id, date, route, start_mileage, end_mileage, tariff, is_overnight,
      driver:drivers(id, name), car:cars(id, brand, model, plate)`)
    .eq('id', id).single();
  if (error) throw error;
  return formatTrip(data);
}

async function createTrip({ driverId, carId, date, route, startMileage, endMileage, isOvernight }) {
  // Get car tariff
  const { data: car } = await supabase.from('cars').select('tariff').eq('id', carId).single();
  const tariff = car?.tariff || 0;

  const { data, error } = await supabase
    .from('trips')
    .insert([{
      driver_id: driverId,
      car_id:    carId,
      date,
      route:        route || null,
      start_mileage: startMileage,
      end_mileage:   isOvernight ? null : endMileage,
      tariff,
      is_overnight:  isOvernight || false,
      created_at:    new Date().toISOString(),
    }])
    .select().single();
  if (error) throw error;
  return data;
}

async function deleteTrip(id) {
  const { error } = await supabase.from('trips').delete().eq('id', id);
  if (error) throw error;
  return true;
}

async function getDeliveryTasksList() {
  const { data, error } = await supabase
    .from('delivery_tasks')
    .select(`id, title, city, col, priority, planned_date,
      driver:drivers(name)`)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  return data || [];
}

async function updateDeliveryCol(taskId, col) {
  const { error } = await supabase
    .from('delivery_tasks')
    .update({ col, updated_at: new Date().toISOString() })
    .eq('id', taskId);
  if (error) throw error;
  return true;
}

/**
 * Find a driver by exact name (case-insensitive)
 */
async function findDriverByName(name) {
  const { data, error } = await supabase
    .from('drivers')
    .select('id, name, phone, active')
    .ilike('name', name.trim())
    .eq('active', true)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Search drivers by partial name
 */
async function searchDrivers(query) {
  const { data, error } = await supabase
    .from('drivers')
    .select('id, name, phone')
    .eq('active', true)
    .ilike('name', `%${query.trim()}%`)
    .order('name')
    .limit(10);
  if (error) throw error;
  return data || [];
}

/**
 * Get all active drivers
 */
async function getAllDrivers() {
  const { data, error } = await supabase
    .from('drivers')
    .select('id, name, phone')
    .eq('active', true)
    .order('name');
  if (error) throw error;
  return data || [];
}

// ─── Trips ───────────────────────────────────────────────────────────────────

/**
 * Get trips for a specific driver in a date range
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
 * Get all trips in a date range (for dispatchers)
 */
async function getAllTripsInRange(startDate, endDate, driverId = null) {
  let query = supabase
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
      driver:drivers(name, id),
      car:cars(brand, model, plate)
    `)
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: false });

  if (driverId) query = query.eq('driver_id', driverId);

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(formatTrip);
}

/**
 * Get recent trips for a driver (last N trips)
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

// ─── Delivery Board ───────────────────────────────────────────────────────────

/**
 * Get delivery tasks summary for dispatchers
 */
async function getDeliveryStats() {
  const { data, error } = await supabase
    .from('delivery_tasks')
    .select(`
      id,
      title,
      city,
      priority,
      col,
      planned_date,
      delivery_date,
      assigned_driver:drivers(name),
      assigned_car:cars(brand, model, plate)
    `)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

// ─── Analytics ───────────────────────────────────────────────────────────────

/**
 * Calculate statistics from trips array
 */
function calcStats(trips) {
  const completed = trips.filter(t => !t.isOvernight || t.endMileage != null);
  const totalKm = completed.reduce((s, t) => s + (t.distance || 0), 0);
  const totalAmount = completed.reduce((s, t) => s + (t.amount || 0), 0);
  const overnight = trips.filter(t => t.isOvernight && t.endMileage == null).length;

  return {
    totalTrips: trips.length,
    completedTrips: completed.length,
    overnightPending: overnight,
    totalKm: Math.round(totalKm),
    totalAmount: Math.round(totalAmount),
    avgKm: completed.length > 0 ? Math.round(totalKm / completed.length) : 0,
  };
}

/**
 * Get per-driver breakdown for dispatchers
 */
async function getDriversBreakdown(startDate, endDate) {
  const trips = await getAllTripsInRange(startDate, endDate);

  const byDriver = {};
  trips.forEach(t => {
    const name = t.driverName || 'Невідомий';
    if (!byDriver[name]) {
      byDriver[name] = { name, trips: [], driverId: t.driverId };
    }
    byDriver[name].trips.push(t);
  });

  return Object.values(byDriver).map(d => ({
    ...d,
    stats: calcStats(d.trips),
  })).sort((a, b) => b.stats.totalKm - a.stats.totalKm);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTrip(trip) {
  const isOvernight = trip.is_overnight || false;
  const distance = (isOvernight && trip.end_mileage == null)
    ? null
    : Math.max(0, (trip.end_mileage || 0) - (trip.start_mileage || 0));
  const amount = distance != null ? distance * (trip.tariff || 0) : null;

  return {
    id: trip.id,
    date: trip.date,
    dateFormatted: trip.date
      ? new Date(trip.date).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '—',
    route: trip.route || '—',
    startMileage: trip.start_mileage || 0,
    endMileage: trip.end_mileage,
    distance,
    tariff: trip.tariff || 0,
    amount,
    notes: trip.notes || '',
    isOvernight,
    car: trip.car ? `${trip.car.brand} ${trip.car.model} (${trip.car.plate})` : '—',
    driverName: trip.driver?.name || null,
    driverId: trip.driver?.id || null,
  };
}

/**
 * Date helpers — returns ISO date string YYYY-MM-DD
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
    const last = new Date(now.getFullYear(), now.getMonth(), 0);
    start = toISODate(first);
    end = toISODate(last);
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
  unlinkTelegramUser,
  // Drivers
  findDriverByName,
  searchDrivers,
  getAllDrivers,
  // Trips
  getDriverTrips,
  getAllTripsInRange,
  getDriverRecentTrips,
  // Delivery
  getDeliveryStats,
  // Analytics
  calcStats,
  getDriversBreakdown,
  // Date utils
  getDateRange,
  toISODate,
  // Car mileage
  getLastCarMileage,
  // Admin helpers (kept for potential future use)
  getAllDriversList,
  getAllCarsList,
  getAdminRecentTrips,
  getTripById,
  createTrip,
  deleteTrip,
  getDeliveryTasksList,
  updateDeliveryCol,
};

