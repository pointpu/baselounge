/**
 * Работа со временем. В БД всё хранится в ISO UTC (`toISOString()`), поэтому строки
 * сравниваются лексикографически. Часовой пояс клуба нужен только для границ сезона
 * (календарный месяц) и для человекочитаемых дат в сообщениях бота.
 */

/** Текущий момент в ISO UTC. */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

/** Нормализует любую корректную дату-строку в ISO UTC. */
export function toIso(value: string | Date): string {
  return new Date(value).toISOString();
}

/** Сдвигает ISO-время на заданное число миллисекунд. */
export function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

/** Календарные компоненты момента `date` в часовом поясе `tz`. */
function zonedParts(date: Date, tz: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(fmt.formatToParts(date).find((p) => p.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** Смещение пояса `tz` относительно UTC в момент `utcMs` (мс). */
function tzOffsetMs(utcMs: number, tz: string): number {
  const p = zonedParts(new Date(utcMs), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Переводит «настенное» время в поясе `tz` в UTC (две итерации — корректно и около перехода на летнее время). */
function zonedToUtc(year: number, month: number, day: number, tz: string, hour = 0, minute = 0): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ts = guess - tzOffsetMs(guess, tz);
  ts = guess - tzOffsetMs(ts, tz);
  return new Date(ts);
}

export interface Season {
  /** Начало месяца (включительно), ISO UTC. */
  start: string;
  /** Начало следующего месяца (не включительно), ISO UTC. */
  end: string;
  /** Например, «Октябрь 2026». */
  label: string;
}

/** Текущий сезон = календарный месяц в часовом поясе клуба. */
export function currentSeason(tz: string, now: Date = new Date()): Season {
  const { year, month } = zonedParts(now, tz);
  const start = zonedToUtc(year, month, 1, tz);
  const end = month === 12 ? zonedToUtc(year + 1, 1, 1, tz) : zonedToUtc(year, month + 1, 1, tz);
  const monthName = new Intl.DateTimeFormat('ru-RU', { month: 'long', timeZone: tz }).format(now);
  const label = `${monthName.charAt(0).toUpperCase()}${monthName.slice(1)} ${year}`;
  return { start: start.toISOString(), end: end.toISOString(), label };
}

/** Момент «через `daysFromNow` дней в hh:mm по часам клуба» (ISO UTC) — для сид-данных и пресетов. */
export function clubTimeInDays(daysFromNow: number, hour: number, minute: number, tz: string, now: Date = new Date()): string {
  const p = zonedParts(new Date(now.getTime() + daysFromNow * 24 * HOUR_MS), tz);
  return zonedToUtc(p.year, p.month, p.day, tz, hour, minute).toISOString();
}

/** «пт, 24 октября, 19:00» — для сообщений бота. */
export function formatDateTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/**
 * Форматирование для текстов ошибок правил (`TimeFormat` из shared/rules.ts) в поясе клуба:
 * время «19:00», день «24 октября» — только если момент не сегодня.
 */
export function clubTimeFormat(tz: string, now: Date = new Date()): { time(iso: string): string; day(iso: string): string | null } {
  const timeFmt = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dayFmt = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: 'numeric', month: 'long' });
  const today = dayFmt.format(now);
  return {
    time: (iso) => timeFmt.format(new Date(iso)),
    day: (iso) => {
      const d = dayFmt.format(new Date(iso));
      return d === today ? null : d;
    },
  };
}
