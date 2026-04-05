/**
 * Text formatting helpers for Telegram messages (HTML parse mode)
 */

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bold(text) {
  return `<b>${escapeHtml(String(text))}</b>`;
}

function mono(text) {
  return `<code>${escapeHtml(String(text))}</code>`;
}

function line(label, value) {
  return `${escapeHtml(label)}: ${bold(value)}`;
}

function divider(char = '─') {
  return char.repeat(28);
}

// ─── Trip formatting (без суми) ───────────────────────────────────────────────

function formatTripItem(trip, index) {
  const distStr = trip.distance != null
    ? `${trip.distance} км`
    : '⏳ нічна (не завершена)';

  const lines = [
    `${bold(String(index + 1))}. ${escapeHtml(trip.dateFormatted)} — ${escapeHtml(trip.car)}`,
    `   📍 ${escapeHtml(trip.route)}`,
    `   🛣 ${distStr}`,
  ];

  if (trip.notes) {
    lines.push(`   📝 ${escapeHtml(trip.notes)}`);
  }

  return lines.join('\n');
}

function formatTripList(trips, title) {
  if (!trips || !trips.length) {
    return `${title}\n\nПоїздок не знайдено.`;
  }

  const items = trips.map((t, i) => formatTripItem(t, i)).join('\n\n');
  return `${title}\n\n${items}`;
}

// ─── Stats formatting (без суми) ──────────────────────────────────────────────

function formatStats(stats, label) {
  if (!stats || stats.totalTrips === 0) {
    return `${label}\n\nНемає поїздок за обраний період.`;
  }

  const lines = [
    `📊 ${bold(label)}`,
    divider(),
    `🚕 Поїздок: ${bold(String(stats.totalTrips))}${stats.overnightPending ? ` (${stats.overnightPending} нічних)` : ''}`,
    `🛣 Пробіг: ${bold(stats.totalKm + ' км')}`,
    `📏 Середня: ${bold(stats.avgKm + ' км')}`,
  ];

  return lines.join('\n');
}

// Додаткова функція для сумісності з іменами викликів у боті
function formatStatsWithoutAmount(stats, label) {
  return formatStats(stats, label);
}

module.exports = {
  escapeHtml,
  bold,
  mono,
  line,
  divider,
  formatTripItem,
  formatTripList,
  formatStats,
  formatStatsWithoutAmount, // Аліас для сумісності
};