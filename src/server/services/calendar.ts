/**
 * Генерация .ics (RFC 5545) для кнопки «Добавить в календарь».
 */
import type { TournamentRow } from '../repo.ts';

/** Средняя длительность турнира для события в календаре. */
const EVENT_DURATION_MS = 4 * 3_600_000;

/** Экранирование TEXT-значений: обратный слэш, `;`, `,`, переводы строк. */
function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** 2026-10-24T16:00:00.000Z → 20261024T160000Z */
function icsDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Складывание строк длиннее 75 октетов (с учётом UTF-8: многобайтные символы не рвём). */
function fold(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    const limit = parts.length === 0 ? 75 : 74; // продолжение начинается с пробела
    if (bytes + size > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

export interface IcsOptions {
  /** Ссылка на турнир (Mini App). */
  url: string;
  /** Место проведения, например «SHOWDOWN, Москва». */
  location: string;
}

/** VCALENDAR с одним VEVENT. UID стабилен (`showdown-t<id>`) — повторный импорт обновит событие. */
export function tournamentIcs(t: TournamentRow, opts: IcsOptions, now: Date = new Date()): string {
  const start = Date.parse(t.starts_at);
  const description = [t.subtitle, t.description, opts.url].filter(Boolean).join('\n\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BASE LOUNGE//Poker Club//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:showdown-t${t.id}`,
    `DTSTAMP:${icsDate(now.getTime())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(start + EVENT_DURATION_MS)}`,
    `SUMMARY:${escapeText(`♠ ${t.title}`)}`,
    `DESCRIPTION:${escapeText(description)}`,
    `LOCATION:${escapeText(opts.location)}`,
    `URL:${opts.url}`,
    t.status === 'cancelled' ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeText(t.title)}`,
    'TRIGGER:-PT2H',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}
