/**
 * Правила расписания и структуры турнира — общие для сервера и Mini App.
 * Сервер проверяет ими каждое сохранение, форма — до отправки, поэтому тексты ошибок одинаковые.
 * Только чистые функции без зависимостей от Node и DOM.
 */
import type { BlindLevel } from './types.ts';

const MINUTE_MS = 60_000;

/** Старт можно поставить чуть в прошлое — на случай, если админ заполняет форму в момент начала. */
export const START_GRACE_MIN = 10;
/** Дальше трёх лет вперёд турниры не планируем — почти наверняка это опечатка в годе. */
export const MAX_DAYS_AHEAD = 3 * 365;
/** Если структура не задана, поздняя регистрация не дольше этого срока после старта. */
export const MAX_LATE_REG_HOURS_WITHOUT_STRUCTURE = 12;

/** Одинаковы ли два момента с точностью до минуты (секунды в форме не вводятся). */
export function sameMinute(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.floor(Date.parse(a) / MINUTE_MS) === Math.floor(Date.parse(b) / MINUTE_MS);
}

/** Одинаковы ли структуры по значениям (порядок ключей в объектах не важен — jsonb его не хранит). */
export function sameLevels(a: readonly BlindLevel[], b: readonly BlindLevel[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((l, i) => {
    const r = b[i];
    return r !== undefined && l.sb === r.sb && l.bb === r.bb && l.ante === r.ante && l.minutes === r.minutes && l.isBreak === r.isBreak;
  });
}

/** Суммарная длительность структуры в минутах (уровни + перерывы). */
export function structureMinutes(levels: readonly BlindLevel[]): number {
  return levels.reduce((sum, l) => sum + l.minutes, 0);
}

/**
 * Варианты окончания поздней регистрации: «до конца уровня N».
 * offsetMin — сколько минут от старта до конца этого уровня (с учётом перерывов перед ним).
 */
export function lateRegOptions(levels: readonly BlindLevel[]): Array<{ level: number; offsetMin: number }> {
  const out: Array<{ level: number; offsetMin: number }> = [];
  let elapsed = 0;
  let n = 0;
  for (const l of levels) {
    elapsed += l.minutes;
    if (l.isBreak) continue;
    n += 1;
    out.push({ level: n, offsetMin: elapsed });
  }
  return out;
}

/** Ошибка в структуре блайндов или null, если всё логично. */
export function levelsError(levels: readonly BlindLevel[]): string | null {
  if (!levels.length) return null;
  if (levels[0]?.isBreak) return 'Структура не может начинаться с перерыва';
  if (levels[levels.length - 1]?.isBreak) return 'Структура не может заканчиваться перерывом';
  let n = 0;
  let prevBb = 0;
  let prevWasBreak = false;
  for (const l of levels) {
    if (!Number.isInteger(l.minutes) || l.minutes < 1 || l.minutes > 240) return 'Длительность уровня — от 1 до 240 минут';
    if (l.isBreak) {
      if (prevWasBreak) return 'Два перерыва подряд — объедините их в один';
      prevWasBreak = true;
      continue;
    }
    prevWasBreak = false;
    n += 1;
    if (l.bb <= 0) return `Уровень ${n}: укажите большой блайнд`;
    if (l.sb < 0 || l.ante < 0) return `Уровень ${n}: блайнды и анте не могут быть отрицательными`;
    if (l.sb > l.bb) return `Уровень ${n}: малый блайнд больше большого`;
    if (l.ante > l.bb) return `Уровень ${n}: анте больше большого блайнда`;
    if (l.bb < prevBb) return `Уровень ${n}: блайнды не могут уменьшаться (было ${prevBb}, стало ${l.bb})`;
    prevBb = l.bb;
  }
  return null;
}

export interface ScheduleInput {
  startsAt: string;
  lateRegUntil: string | null;
  levels: readonly BlindLevel[];
  /** Текущее время (параметр — чтобы функция оставалась чистой). */
  now: number;
  /** Проверять, что старт не в прошлом (новый турнир, перенос даты, открытие регистрации). */
  requireFuture: boolean;
}

/** Ошибка во времени старта / поздней регистрации или null. */
export function scheduleError(s: ScheduleInput): string | null {
  const start = Date.parse(s.startsAt);
  if (Number.isNaN(start)) return 'Укажите дату и время старта';
  if (s.requireFuture && start < s.now - START_GRACE_MIN * MINUTE_MS) return 'Время старта уже прошло — выберите будущую дату';
  if (start > s.now + MAX_DAYS_AHEAD * 24 * 60 * MINUTE_MS) return 'Старт больше чем через три года — проверьте год';

  if (s.lateRegUntil === null) return null;
  const late = Date.parse(s.lateRegUntil);
  if (Number.isNaN(late)) return 'Некорректное время поздней регистрации';
  if (late <= start) return 'Поздняя регистрация должна заканчиваться после старта';
  const total = structureMinutes(s.levels);
  if (total > 0 && late > start + total * MINUTE_MS) {
    return 'Поздняя регистрация не может длиться дольше всей структуры блайндов';
  }
  if (total === 0 && late > start + MAX_LATE_REG_HOURS_WITHOUT_STRUCTURE * 60 * MINUTE_MS) {
    return `Поздняя регистрация — не дольше ${MAX_LATE_REG_HOURS_WITHOUT_STRUCTURE} ч после старта`;
  }
  return null;
}
