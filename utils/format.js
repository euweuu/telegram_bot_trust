/**
 * Text formatting helpers for Telegram messages (HTML parse mode)
 */

function bold(text) {
  return `<b>${escapeHtml(String(text))}</b>`;
}

function mono(text) {
  return `<code>${escapeHtml(String(text))}</code>`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function line(label, value) {
  return `${escapeHtml(label)}: ${bold(value)}`;
}

function divider(char = '─') {
  return char.repeat(28);
}

// ─── Trip formatting ──────────────────────────────────────────────────────────

function formatTripItem(trip, index) {
  const distStr = trip.distance != null
    ? `${trip.distance} км`
    : '⏳ нічна (не завершена)';

  const amountStr = trip.amount != null
    ? `${trip.amount.toLocaleString('uk-UA')} грн`
    : '—';

  const lines = [
    `${bold(index + 1 + '.')} ${escapeHtml(trip.dateFormatted)} — ${escapeHtml(trip.car)}`,
    `   📍 ${escapeHtml(trip.route)}`,
    `   🛣 ${distStr}   💰 ${amountStr}`,
  ];

  if (trip.notes) {
    lines.push(`   📝 ${escapeHtml(trip.notes)}`);
  }

  return lines.join('\n');
}

function formatTripList(trips, title) {
  if (!trips.length) {
    return `${title}\n\nПоїздок не знайдено.`;
  }

  const items = trips.map((t, i) => formatTripItem(t, i)).join('\n\n');
  return `${title}\n\n${items}`;
}

// ─── Stats formatting ─────────────────────────────────────────────────────────

function formatStats(stats, label) {
  return [
    `📊 ${bold(label)}`,
    divider(),
    `🚕 Поїздок: ${bold(stats.totalTrips)}${stats.overnightPending ? ` (${stats.overnightPending} нічних)` : ''}`,
    `🛣 Пробіг: ${bold(stats.totalKm + ' км')}`,
    `📏 Середня: ${bold(stats.avgKm + ' км')}`,
    `💰 Сума: ${bold(stats.totalAmount.toLocaleString('uk-UA') + ' грн')}`,
  ].join('\n');
}

module.exports = {
  bold, mono, escapeHtml, line, divider,
  formatTripItem, formatTripList, formatStats,
};
