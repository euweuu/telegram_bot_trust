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

function italic(text) {
  return `<i>${escapeHtml(String(text))}</i>`;
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

function formatTripList(trips, title, pagination = null) {
  if (!trips || !trips.length) {
    return `${title}\n\nПоїздок не знайдено.`;
  }

  const items = trips.map((t, i) => formatTripItem(t, i)).join('\n\n');
  let msg = `${title}\n\n${items}`;

  if (pagination) {
    const { current, total, hasMore } = pagination;
    msg += `\n\n${italic(`Показано ${current} з ${total}`)}`;
    if (hasMore) {
      msg += `\n${italic('Натисніть "Ще поїздки" щоб побачити більше')}`;
    }
  }

  return msg;
}

// ─── Stats formatting ─────────────────────────────────────────────────────────

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

function formatStatsWithoutAmount(stats, label) {
  return formatStats(stats, label);
}

// ─── Dispatcher stats ─────────────────────────────────────────────────────────

function formatDispatcherStats(allStats, label) {
  if (!allStats || allStats.length === 0) {
    return `${bold(label)}\n\nНемає даних за обраний період.`;
  }

  const lines = [`📊 ${bold(label)}`, divider()];

  // Sort by totalKm descending
  const sorted = [...allStats].sort((a, b) => b.stats.totalKm - a.stats.totalKm);

  for (const d of sorted) {
    const s = d.stats;
    if (s.totalTrips === 0) continue;
    lines.push(
      `👤 ${bold(d.driverName)}`,
      `   🚕 ${s.totalTrips} поїздок · 🛣 ${s.totalKm} км · 📏 avg ${s.avgKm} км`,
    );
    if (s.overnightPending) {
      lines.push(`   ⏳ ${s.overnightPending} нічних не завершено`);
    }
  }

  const totals = allStats.reduce((acc, d) => ({
    trips: acc.trips + d.stats.totalTrips,
    km:    acc.km + d.stats.totalKm,
  }), { trips: 0, km: 0 });

  lines.push(
    divider(),
    `📦 Всього: ${bold(totals.trips + ' поїздок')}, ${bold(totals.km + ' км')}`,
  );

  return lines.join('\n');
}

// ─── Weekly digest ────────────────────────────────────────────────────────────

function formatWeeklyDigest(stats, driverName, weekLabel) {
  if (!stats || stats.totalTrips === 0) {
    return [
      `📬 ${bold('Тижневий звіт')}`,
      italic(weekLabel),
      divider(),
      `${escapeHtml(driverName)}, цього тижня поїздок не було.`,
    ].join('\n');
  }

  return [
    `📬 ${bold('Тижневий звіт')}`,
    italic(weekLabel),
    divider(),
    `👤 ${bold(escapeHtml(driverName))}`,
    `🚕 Поїздок: ${bold(String(stats.totalTrips))}`,
    `🛣 Пробіг: ${bold(stats.totalKm + ' км')}`,
    `📏 Середня: ${bold(stats.avgKm + ' км')}`,
    stats.overnightPending ? `⏳ Нічних без завершення: ${bold(String(stats.overnightPending))}` : '',
  ].filter(Boolean).join('\n');
}

// ─── Notification: trip deleted ───────────────────────────────────────────────

function formatTripDeletedNotification(trip) {
  const lines = [
    `🗑 ${bold('Поїздку видалено')}`,
    divider(),
    `📅 Дата:    ${bold(trip.dateFormatted || trip.date || '—')}`,
    `📍 Маршрут: ${bold(escapeHtml(trip.route || '—'))}`,
  ];
  if (trip.car) {
    lines.push(`🚗 Авто:    ${bold(escapeHtml(trip.car))}`);
  }
  lines.push(`\n${italic('Якщо це помилка — зверніться до диспетчера.')}`);
  return lines.join('\n');
}

module.exports = {
  escapeHtml,
  bold,
  mono,
  italic,
  line,
  divider,
  formatTripItem,
  formatTripList,
  formatStats,
  formatStatsWithoutAmount,
  formatDispatcherStats,
  formatWeeklyDigest,
  formatTripDeletedNotification,
};
