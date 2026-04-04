/**
 * Text formatting helpers for Telegram messages (HTML parse mode)
 */

const PRIORITY_EMOJI = {
  urgent: '🔴',
  high: '🟠',
  medium: '🔵',
  low: '🟢',
};

const COL_LABEL = {
  new: '🆕 Нова',
  planned: '📋 Заплановано',
  in_transit: '🚚 В дорозі',
  done: '✅ Доставлено',
};

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

function formatDriverBreakdown(drivers, period) {
  if (!drivers.length) return '📊 Немає даних за цей період.';

  const header = `📊 ${bold('Звіт за ' + period)}\n${divider()}\n`;

  const rows = drivers.map((d, i) => {
    const s = d.stats;
    return [
      `${i + 1}. ${bold(d.name)}`,
      `   🚕 ${s.totalTrips} поїздок   🛣 ${s.totalKm} км   💰 ${s.totalAmount.toLocaleString('uk-UA')} грн`,
    ].join('\n');
  }).join('\n\n');

  return header + rows;
}

function formatDeliveries(tasks) {
  const grouped = { new: [], planned: [], in_transit: [], done: [] };
  tasks.forEach(t => {
    const col = t.col || 'new';
    if (grouped[col]) grouped[col].push(t);
  });

  const parts = [];

  for (const [col, items] of Object.entries(grouped)) {
    if (!items.length) continue;
    parts.push(`${COL_LABEL[col] || col} — ${bold(items.length + ' шт.')}`);
    items.slice(0, 5).forEach(t => {
      const prio = PRIORITY_EMOJI[t.priority] || '•';
      const city = t.city ? ` [${t.city}]` : '';
      const driver = t.assigned_driver?.name ? ` → ${t.assigned_driver.name}` : '';
      parts.push(`  ${prio} ${escapeHtml(t.title)}${escapeHtml(city)}${escapeHtml(driver)}`);
    });
    if (items.length > 5) {
      parts.push(`  ⋯ ще ${items.length - 5}`);
    }
  }

  return parts.length
    ? `🚚 ${bold('Дошка доставок')}\n${divider()}\n` + parts.join('\n')
    : '🚚 Дошка доставок порожня';
}

module.exports = {
  bold, mono, escapeHtml, line, divider,
  formatTripItem, formatTripList, formatStats,
  formatDriverBreakdown, formatDeliveries,
};
