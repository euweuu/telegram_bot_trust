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

function bold(text)   { return `<b>${escapeHtml(String(text))}</b>`; }
function mono(text)   { return `<code>${escapeHtml(String(text))}</code>`; }
function italic(text) { return `<i>${escapeHtml(String(text))}</i>`; }

function line(label, value) {
  return `${escapeHtml(label)}: ${bold(value)}`;
}

function divider() {
  return '—'.repeat(20);
}

function header(icon, title) {
  return `${icon} ${bold(title)}`;
}

// ─── Trip formatting ──────────────────────────────────────────────────────────

function formatTripItem(trip, index) {
  const distStr = trip.distance != null
    ? bold(trip.distance + ' км')
    : italic('нічна — не завершена');

  const lines = [
    `${bold(`${index + 1}.`)} ${italic(escapeHtml(trip.dateFormatted))}  ${escapeHtml(trip.car)}`,
    `${escapeHtml(trip.route)}`,
    `Пробіг: ${distStr}`,
  ];

  if (trip.notes) {
    lines.push(italic(escapeHtml(trip.notes)));
  }

  return lines.join('\n');
}

function formatTripList(trips, title, pagination = null) {
  if (!trips || !trips.length) {
    return `${title}\n\n${italic('Поїздок за цей період не знайдено.')}`;
  }

  const items = trips.map((t, i) => formatTripItem(t, i)).join('\n\n');
  let msg = `${title}\n\n${items}`;

  if (pagination) {
    const { current, total } = pagination;
    msg += `\n\n${italic(`Показано ${current} з ${total}`)}`;
  }

  return msg;
}

// ─── Stats formatting ─────────────────────────────────────────────────────────

function formatStats(stats, label) {
  if (!stats || stats.totalTrips === 0) {
    return `${bold(label)}\n\n${italic('Поїздок за обраний період не знайдено.')}`;
  }

  const lines = [
    bold(label),
    divider(),
    `Поїздок: ${bold(String(stats.totalTrips))}`,
  ];

  if (stats.overnightPending) {
    lines.push(italic(`${stats.overnightPending} нічних не завершено`));
  }

  lines.push(
    `Пробіг: ${bold(stats.totalKm + ' км')}`,
    `Середня: ${bold(stats.avgKm + ' км')}`,
  );

  return lines.join('\n');
}

function formatStatsWithoutAmount(stats, label) {
  return formatStats(stats, label);
}

// ─── Dispatcher stats ─────────────────────────────────────────────────────────

function formatDispatcherStats(allStats, label) {
  if (!allStats || allStats.length === 0) {
    return `${bold(label)}\n\n${italic('Немає даних за обраний період.')}`;
  }

  const lines = [bold(label), divider()];
  const sorted = [...allStats].sort((a, b) => b.stats.totalKm - a.stats.totalKm);
  const active = sorted.filter(d => d.stats.totalTrips > 0);

  for (const d of active) {
    const s = d.stats;
    lines.push(bold(escapeHtml(d.driverName)));
    lines.push(`${s.totalTrips} поїздок  ·  ${s.totalKm} км  ·  avg ${s.avgKm} км`);
    if (s.overnightPending) {
      lines.push(italic(`${s.overnightPending} нічних не завершено`));
    }
    lines.push('');
  }

  if (active.length === 0) {
    lines.push(italic('Усі водії без поїздок за цей період.'));
  }

  const totals = allStats.reduce((acc, d) => ({
    trips: acc.trips + d.stats.totalTrips,
    km:    acc.km + d.stats.totalKm,
  }), { trips: 0, km: 0 });

  lines.push(divider());
  lines.push(`Разом: ${bold(totals.trips + ' поїздок')}, ${bold(totals.km + ' км')}`);

  return lines.join('\n');
}

// ─── Weekly digest ────────────────────────────────────────────────────────────

function formatWeeklyDigest(stats, driverName, weekLabel) {
  if (!stats || stats.totalTrips === 0) {
    return [
      bold('Тижневий звіт'),
      italic(weekLabel),
      divider(),
      `${bold(escapeHtml(driverName))}, цього тижня поїздок не було.`,
    ].join('\n');
  }

  const lines = [
    bold('Тижневий звіт'),
    italic(weekLabel),
    divider(),
    bold(escapeHtml(driverName)),
    `Поїздок: ${bold(String(stats.totalTrips))}`,
    `Пробіг: ${bold(stats.totalKm + ' км')}`,
    `Середня: ${bold(stats.avgKm + ' км')}`,
  ];

  if (stats.overnightPending) {
    lines.push(italic(`${stats.overnightPending} нічних не завершено`));
  }

  return lines.join('\n');
}

// ─── Notification: trip created ───────────────────────────────────────────────

function formatTripCreatedNotification(trip) {
  const lines = [
    bold('Нова поїздка'),
    divider(),
    `Дата: ${bold(trip.dateFormatted || '—')}`,
    `Маршрут: ${bold(escapeHtml(trip.route || '—'))}`,
    `Авто: ${bold(escapeHtml(trip.car || '—'))}`,
  ];

  if (trip.notes) {
    lines.push(italic(escapeHtml(trip.notes)));
  }
  if (trip.is_overnight) {
    lines.push(italic('Нічна — пробіг буде внесено після завершення'));
  }

  return lines.join('\n');
}

// ─── Notification: trip completed ────────────────────────────────────────────

function formatTripCompletedNotification(trip) {
  return [
    bold('Поїздку завершено'),
    divider(),
    `Дата: ${bold(trip.dateFormatted || '—')}`,
    `Маршрут: ${bold(escapeHtml(trip.route || '—'))}`,
    `Пробіг: ${bold(trip.distance + ' км')} ${italic(`(${trip.startMileage} → ${trip.endMileage})`)}`,
  ].join('\n');
}

// ─── Notification: trip deleted ───────────────────────────────────────────────

function formatTripDeletedNotification(trip) {
  const lines = [
    bold('Поїздку видалено'),
    divider(),
    `Дата: ${bold(trip.dateFormatted || trip.date || '—')}`,
    `Маршрут: ${bold(escapeHtml(trip.route || '—'))}`,
  ];

  if (trip.car) {
    lines.push(`Авто: ${bold(escapeHtml(trip.car))}`);
  }

  lines.push('');
  lines.push(italic('Якщо це помилка — зверніться до диспетчера.'));
  return lines.join('\n');
}

// ─── Bot status (dispatcher) ──────────────────────────────────────────────────

function formatBotStatus({ driverCount, uptimeHours, uptimeMinutes, memoryMb, channels }) {
  const channelLines = channels.map(ch => {
    const status = ch.state === 'subscribed' ? 'OK' : 'OFFLINE';
    return `${ch.topic}: ${bold(status)}`;
  });

  return [
    bold('Статус бота'),
    divider(),
    `Водіїв: ${bold(String(driverCount))}`,
    `Uptime: ${bold(`${uptimeHours}г ${uptimeMinutes}хв`)}`,
    `Памʼять: ${bold(`${memoryMb} MB`)}`,
    divider(),
    bold('Realtime канали:'),
    ...channelLines,
  ].join('\n');
}

module.exports = {
  escapeHtml,
  bold,
  mono,
  italic,
  line,
  divider,
  header,
  formatTripItem,
  formatTripList,
  formatStats,
  formatStatsWithoutAmount,
  formatDispatcherStats,
  formatWeeklyDigest,
  formatTripCreatedNotification,
  formatTripCompletedNotification,
  formatTripDeletedNotification,
  formatBotStatus,
};
