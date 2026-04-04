/**
 * User session store (in-memory)
 * Stores: { telegramId -> { driverId, driverName, role, registeredAt } }
 */
const sessions = new Map();

function getSession(telegramId) {
  return sessions.get(String(telegramId)) || null;
}

function setSession(telegramId, data) {
  sessions.set(String(telegramId), { ...data, updatedAt: Date.now() });
}

function clearSession(telegramId) {
  sessions.delete(String(telegramId));
}

function isDispatcher(telegramId) {
  const ids = (process.env.DISPATCHER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return ids.includes(String(telegramId));
}

function isRegistered(telegramId) {
  return sessions.has(String(telegramId));
}

module.exports = { getSession, setSession, clearSession, isDispatcher, isRegistered };
