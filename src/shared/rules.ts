/**
 * Правила расписания и структуры турнира — общие для сервера и Mini App.
 * Сервер проверяет ими каждое сохранение, форма — до отправки, поэтому тексты ошибок одинаковые.
 * Здесь же — производные «покерные» сведения: формат турнира (Bounty, Turbo…), подсказки
 * о ходе игры и фазы турнира. Только чистые функции без зависимостей от Node и DOM.
 */
import type { BlindLevel, Bullet, ClockState, FormatTag, GameType, MyStatus, TournamentStatus } from './types.ts';

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

// ───────────────────────────── Время: регистрация, старт, рассадка, итоги ─────────────────────────────

/** Запустить турнир (статус «идёт» / часы) можно не раньше чем за столько минут до старта. */
export const EARLY_START_MIN = 60;
/** Рассадка — не раньше чем за столько минут до старта (не рассаживаем за несколько дней). */
export const EARLY_SEATING_MIN = 180;

/** Что нужно правилам времени; `TournamentDetail`/`TournamentCard` подходят как есть. */
export interface TimingInput {
  status: TournamentStatus;
  startsAt: string;
  lateRegUntil: string | null;
}

/** Форматирование времени в поясе клуба для текстов ошибок. */
export interface TimeFormat {
  /** «19:00». */
  time(iso: string): string;
  /** «24 октября» — если момент не сегодня по часам клуба, иначе null. */
  day(iso: string): string | null;
}

/** «в 19:00» или «24 октября в 19:00». */
function atWhen(iso: string, fmt: TimeFormat): string {
  const day = fmt.day(iso);
  return `${day ? `${day} ` : ''}в ${fmt.time(iso)}`;
}

/**
 * Открыта ли запись: статус «регистрация» и старт ещё не наступил, либо (регистрация или турнир
 * идёт) и не закончилась поздняя регистрация. После закрытия записи лист ожидания «замораживается»:
 * из него никого не повышают (см. DESIGN.md).
 */
export function registrationOpen(t: TimingInput, nowMs: number): boolean {
  const start = Date.parse(t.startsAt);
  if (t.status === 'registration' && nowMs < start) return true;
  const late = t.lateRegUntil ? Date.parse(t.lateRegUntil) : null;
  return (t.status === 'registration' || t.status === 'running') && late !== null && nowMs < late;
}

/** Почему записаться нельзя (текст для 409) или null, если запись открыта. */
export function registrationClosedReason(t: TimingInput, nowMs: number): string | null {
  if (registrationOpen(t, nowMs)) return null;
  if (t.status === 'draft') return 'Регистрация на этот турнир ещё не открыта';
  if (t.status === 'completed' || t.status === 'cancelled') return 'Регистрация на этот турнир закрыта';
  if (t.lateRegUntil !== null) return 'Поздняя регистрация уже закрыта';
  return 'Регистрация закрыта — турнир уже начался';
}

/** Рано запускать турнир/часы: текст 409 или null. */
export function earlyStartError(startsAt: string, nowMs: number, fmt: TimeFormat): string | null {
  const from = Date.parse(startsAt) - EARLY_START_MIN * MINUTE_MS;
  if (nowMs >= from) return null;
  const fromIso = new Date(from).toISOString();
  return `Рано: турнир начинается ${atWhen(startsAt, fmt)} — запустить можно с ${fmt.time(fromIso)}`;
}

/** Рано рассаживать: текст 409 или null. */
export function earlySeatingError(startsAt: string, nowMs: number, fmt: TimeFormat): string | null {
  const from = Date.parse(startsAt) - EARLY_SEATING_MIN * MINUTE_MS;
  if (nowMs >= from) return null;
  const fromIso = new Date(from).toISOString();
  return `Рано для рассадки: она доступна за ${EARLY_SEATING_MIN / 60} ч до старта — ${atWhen(fromIso, fmt)}`;
}

/**
 * Можно ли вносить результаты: турнир идёт (или уже завершён — исправление) и старт наступил.
 * Текст 409 или null.
 */
export function resultsTimeError(t: TimingInput, nowMs: number, fmt: TimeFormat): string | null {
  if (t.status !== 'running' && t.status !== 'completed') {
    return t.status === 'registration'
      ? 'Результаты вносятся после начала турнира — сначала запустите его'
      : 'Результаты можно внести только у идущего или завершённого турнира';
  }
  if (nowMs < Date.parse(t.startsAt)) return `Результаты — не раньше старта турнира (${atWhen(t.startsAt, fmt)})`;
  return null;
}

// ───────────────────────────── Стеки и вместимость ─────────────────────────────

export interface StackInput {
  startingStack: number | null;
  levels: readonly BlindLevel[];
  reentries: readonly Bullet[];
  addons: readonly Bullet[];
}

/** Стартовый стек больше BB первого уровня, стеки ре-энтри и add-on положительные. Текст 400 или null. */
export function stackError(s: StackInput): string | null {
  const first = firstPlayable(s.levels);
  if (s.startingStack !== null) {
    if (!Number.isInteger(s.startingStack) || s.startingStack <= 0) return 'Стартовый стек должен быть больше нуля';
    if (first && first.bb > 0 && s.startingStack <= first.bb) {
      return `Стартовый стек (${s.startingStack}) должен быть больше большого блайнда первого уровня (${first.bb})`;
    }
  }
  const bad = (list: readonly Bullet[]): number => list.findIndex((b) => !Number.isInteger(b.stack) || b.stack <= 0);
  const re = bad(s.reentries);
  if (re >= 0) return `Ре-энтри ${re + 1}: стек должен быть больше нуля`;
  const ad = bad(s.addons);
  if (ad >= 0) return `Add-on ${ad + 1}: стек должен быть больше нуля`;
  return null;
}

/** Вместимость нельзя опустить ниже числа уже записанных. Текст 409 или null. */
export function capacityError(capacity: number, registered: number): string | null {
  if (capacity >= registered) return null;
  return `Нельзя уменьшить до ${capacity} ${ruPlural(capacity, 'места', 'мест', 'мест')}: уже записано ${registered} — сначала отмените лишние записи`;
}

// ───────────────────────────── Напоминания ─────────────────────────────

/** Напоминания по умолчанию: за 1 день и за 2 часа. */
export const DEFAULT_REMINDER_OFFSETS: readonly number[] = [1440, 120];
/** Не больше стольких напоминаний у турнира. */
export const MAX_REMINDERS = 5;
/** Самое раннее напоминание — за 7 дней. */
export const MAX_REMINDER_MIN = 7 * 24 * 60;
/**
 * Если окно напоминания открылось больше стольких минут назад (сервер был выключен, старт перенесли),
 * напоминание не шлём — только отмечаем, чтобы не засыпать игроков пачкой устаревших сообщений.
 */
export const REMINDER_GRACE_MIN = 30;

/** Быстрые варианты в форме турнира. */
export const REMINDER_PRESETS: ReadonlyArray<{ minutes: number; label: string }> = [
  { minutes: 1440, label: 'за 1 день' },
  { minutes: 180, label: 'за 3 ч' },
  { minutes: 120, label: 'за 2 ч' },
  { minutes: 60, label: 'за 1 ч' },
  { minutes: 30, label: 'за 30 мин' },
  { minutes: 15, label: 'за 15 мин' },
];

/** «за 1 день», «за 2 дн 3 ч», «за 1 ч 30 мин», «за 45 мин». */
export function reminderLabel(minutes: number): string {
  const preset = REMINDER_PRESETS.find((p) => p.minutes === minutes);
  if (preset) return preset.label;
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return `за ${d} ${ruPlural(d, 'день', 'дня', 'дней')}`;
  }
  return `за ${shortDuration(minutes)}`;
}

/** Список напоминаний корректен: каждое > 0 и ≤ 7 дней, без повторов, не больше 5. Текст 400 или null. */
export function reminderOffsetsError(offsets: readonly number[]): string | null {
  if (offsets.length > MAX_REMINDERS) return `Напоминаний — не больше ${MAX_REMINDERS}`;
  for (const m of offsets) {
    if (!Number.isInteger(m) || m <= 0) return 'Напоминание — целое число минут больше нуля';
    if (m > MAX_REMINDER_MIN) return 'Напоминание — не раньше чем за 7 дней до старта';
  }
  if (new Set(offsets).size !== offsets.length) return 'Напоминания повторяются — уберите одинаковые';
  return null;
}

/** Сортировка «сначала самое раннее» (1440, 120, 30). */
export function sortOffsets(offsets: readonly number[]): number[] {
  return [...offsets].sort((a, b) => b - a);
}

// ───────────────────────────── Игра и формат ─────────────────────────────

export const GAME_TYPES: readonly GameType[] = ['nlh', 'plh', 'flh'];

/** Полное название разновидности: «No-Limit Hold'em». */
export const GAME_LABELS: Record<GameType, string> = {
  nlh: "No-Limit Hold'em",
  plh: "Pot-Limit Hold'em",
  flh: "Fixed-Limit Hold'em",
};

/** Короткое обозначение для тегов: «NLH». */
export const GAME_SHORT: Record<GameType, string> = { nlh: 'NLH', plh: 'PLH', flh: 'FLH' };

export const FORMAT_LABELS: Record<FormatTag, string> = {
  bounty: 'Bounty',
  reentry: 'Re-entry',
  freezeout: 'Freezeout',
  turbo: 'Turbo',
  deepstack: 'Deepstack',
  addon: 'Add-on',
};

/** Турбо — первый игровой уровень не длиннее этого (мин). */
export const TURBO_MAX_LEVEL_MIN = 12;
/** Deepstack — стартовый стек не меньше стольких больших блайндов первого уровня. */
export const DEEPSTACK_MIN_BB = 200;

export interface FormatInput {
  knockoutPoints: number;
  startingStack: number | null;
  reentries: readonly Bullet[];
  addons: readonly Bullet[];
  blindLevels: readonly BlindLevel[];
}

/** Первый игровой (не перерыв) уровень структуры. */
export function firstPlayable(levels: readonly BlindLevel[]): BlindLevel | undefined {
  return levels.find((l) => !l.isBreak);
}

/**
 * Форматы турнира, выведенные из его параметров (в базе не хранятся):
 * Bounty — нокауты приносят очки; Re-entry — есть ре-энтри, иначе Freezeout;
 * Turbo — первый уровень ≤ 12 мин; Deepstack — стек ≥ 200 BB первого уровня; Add-on — есть аддоны.
 */
export function formatTags(t: FormatInput): FormatTag[] {
  const out: FormatTag[] = [];
  const first = firstPlayable(t.blindLevels);
  if (t.knockoutPoints > 0) out.push('bounty');
  out.push(t.reentries.length > 0 ? 'reentry' : 'freezeout');
  if (first && first.minutes <= TURBO_MAX_LEVEL_MIN) out.push('turbo');
  if (first && first.bb > 0 && t.startingStack !== null && t.startingStack / first.bb >= DEEPSTACK_MIN_BB) out.push('deepstack');
  if (t.addons.length > 0) out.push('addon');
  return out;
}

/** Анте равно большому блайнду — «BB-анте» (типичная современная структура NLH). */
export function isBbAnte(level: BlindLevel): boolean {
  return !level.isBreak && level.ante > 0 && level.ante === level.bb;
}

// ───────────────────────────── Подсказки «Ход игры» ─────────────────────────────

export type HintTone = 'info' | 'gold' | 'warn' | 'muted';

export interface GameHint {
  /** Эмодзи-иконка. */
  icon: string;
  /** Короткий текст — рассчитан на одну строку на экране 375 px. */
  text: string;
  tone: HintTone;
}

/** Всё, что нужно подсказкам; `TournamentDetail` подходит как есть. */
export interface HintInput {
  status: TournamentStatus;
  startsAt: string;
  lateRegUntil: string | null;
  blindLevels: readonly BlindLevel[];
  reentries: readonly Bullet[];
  addons: readonly Bullet[];
  freeSeats: number;
  waitlistCount: number;
  canRegister: boolean;
  myStatus: MyStatus;
  myWaitlistPosition: number | null;
}

export interface HintOptions {
  /** Форматирование времени в поясе клуба («21:40»); без него — относительное время. */
  fmtTime?: (iso: string) => string;
  /** Сколько подсказок вернуть (по умолчанию 3). */
  limit?: number;
}

function ruPlural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Длительность коротко: «45 мин», «2 ч 14 мин», «3 дн 4 ч». */
export function shortDuration(totalMin: number): string {
  const m = Math.max(0, Math.round(totalMin));
  if (m < 60) return `${m} мин`;
  if (m < 48 * 60) {
    const hours = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
  }
  const days = Math.floor(m / (24 * 60));
  const hours = Math.floor((m % (24 * 60)) / 60);
  return hours ? `${days} дн ${hours} ч` : `${days} дн`;
}

/** Номер игрового уровня (как в таблице блайндов: перерывы не считаются) по индексу в структуре. */
export function playableNumber(levels: readonly BlindLevel[], index: number): number {
  let n = 0;
  for (let i = 0; i <= index && i < levels.length; i++) if (!levels[i]?.isBreak) n += 1;
  return n;
}

/** До конца какого уровня поздняя регистрация (если её конец совпадает с концом уровня). */
export function lateRegLevel(startsAt: string, lateRegUntil: string | null, levels: readonly BlindLevel[]): number | null {
  if (lateRegUntil === null) return null;
  const offset = Math.round((Date.parse(lateRegUntil) - Date.parse(startsAt)) / MINUTE_MS);
  return lateRegOptions(levels).find((o) => o.offsetMin === offset)?.level ?? null;
}

/** Индекс первого перерыва — на нём по традиции берут add-on. */
function firstBreakIndex(levels: readonly BlindLevel[]): number {
  return levels.findIndex((l) => l.isBreak);
}

/** Минуты от «сейчас» до начала уровня `target` (> clock.levelIndex). */
function minutesUntil(levels: readonly BlindLevel[], clock: ClockState, target: number): number {
  let sec = clock.remainingSec;
  for (let i = clock.levelIndex + 1; i < target; i++) sec += (levels[i]?.minutes ?? 0) * 60;
  return Math.ceil(sec / 60);
}

/** Игровых уровней от текущего (включительно) до `target` (не включая). */
function levelsUntil(levels: readonly BlindLevel[], from: number, target: number): number {
  let n = 0;
  for (let i = from; i < target; i++) if (!levels[i]?.isBreak) n += 1;
  return n;
}

/**
 * Подсказки о ходе игры: 1–3 самых важных на текущий момент (по убыванию важности).
 * До старта — отсчёт и поздняя регистрация; во время игры — перерывы, add-on, рост блайндов,
 * анте, пауза, места и лист ожидания. `clock` — состояние часов на `nowMs` (клиент проецирует его сам).
 */
export function gameHints(d: HintInput, clock: ClockState | null, nowMs: number, opts: HintOptions = {}): GameHint[] {
  if (d.status === 'completed' || d.status === 'cancelled') return [];
  const items: Array<{ p: number; hint: GameHint }> = [];
  const add = (p: number, icon: string, text: string, tone: HintTone = 'info'): void => {
    items.push({ p, hint: { icon, text, tone } });
  };
  const levels = d.blindLevels;
  const start = Date.parse(d.startsAt);
  const late = d.lateRegUntil ? Date.parse(d.lateRegUntil) : null;
  const lateLevel = lateRegLevel(d.startsAt, d.lateRegUntil, levels);
  const running = d.status === 'running';
  const lateOpen = late !== null && nowMs < late;

  // Лист ожидания и свободные места — важны всегда, пока можно записаться.
  if (d.myStatus === 'waitlist') {
    add(90, '⏳', d.myWaitlistPosition ? `Вы №${d.myWaitlistPosition} в листе ожидания` : 'Вы в листе ожидания', 'warn');
  }
  if (d.canRegister && d.myStatus === null) {
    if (d.freeSeats > 0) add(45, '🎟', `Свободно ${d.freeSeats} ${ruPlural(d.freeSeats, 'место', 'места', 'мест')}`, 'gold');
    else add(45, '🎟', d.waitlistCount ? `Мест нет — в очереди ${d.waitlistCount}` : 'Мест нет — можно в лист ожидания', 'muted');
  }

  if (!running || !clock) {
    // До старта (или турнир начат, но часы ещё не запущены).
    if (nowMs < start) add(80, '⏱', `До старта ${shortDuration((start - nowMs) / MINUTE_MS)}`, 'gold');
    // Без структуры часов не будет вовсе — не обещаем, что их «скоро запустят».
    else if (running) add(80, '⏱', levels.length ? 'Часы скоро запустят' : 'Турнир идёт — без часов блайндов', 'muted');
    if (late !== null && lateOpen) {
      const when = opts.fmtTime ? `до ${opts.fmtTime(d.lateRegUntil!)}` : `${shortDuration((late - start) / MINUTE_MS)} от старта`;
      add(70, '📝', `Поздняя рег. ${when}${lateLevel ? ` · ур. ${lateLevel}` : ''}`);
    }
    if (d.reentries.length && lateOpen) add(30, '🔁', 'Ре-энтри — до конца поздней рег.', 'muted');
    if (d.addons.length && firstBreakIndex(levels) >= 0) add(25, '➕', 'Add-on — в первом перерыве', 'muted');
    return pick(items, opts.limit);
  }

  // ── Игра идёт, часы запущены.
  const i = clock.levelIndex;
  const current = clock.level;
  const addonBreak = d.addons.length ? firstBreakIndex(levels) : -1;

  if (clock.paused) add(100, '⏸', 'Турнир на паузе — часы стоят', 'warn');

  if (lateOpen && late !== null) {
    const left = Math.ceil((late - nowMs) / MINUTE_MS);
    add(left <= 15 ? 88 : 60, '📝', `Поздняя рег. ещё ${shortDuration(left)}${lateLevel ? ` · ур. ${lateLevel}` : ''}`, left <= 15 ? 'warn' : 'info');
    if (d.reentries.length) add(28, '🔁', 'Ре-энтри — до конца поздней рег.', 'muted');
  }
  if (late !== null && !lateOpen) add(20, '🔒', 'Поздняя регистрация закрыта', 'muted');

  if (clock.finished) {
    add(75, '🏁', 'Блайнды больше не растут', 'muted');
    return pick(items, opts.limit);
  }

  if (current.isBreak) {
    const mins = Math.ceil(clock.remainingSec / 60);
    add(85, '☕', i === addonBreak ? `Перерыв ещё ${mins} мин — время add-on` : `Перерыв ещё ${mins} мин`, 'gold');
  } else {
    const nextBreak = levels.findIndex((l, j) => j > i && l.isBreak);
    if (nextBreak > 0) {
      const n = levelsUntil(levels, i, nextBreak);
      const mins = minutesUntil(levels, clock, nextBreak);
      // Перерыв с аддоном называем «Add-on» — короче и важнее для игрока (строка должна влезать в 375 px).
      const what = nextBreak === addonBreak ? 'Add-on' : 'Перерыв';
      add(n <= 1 ? 72 : 40, '☕', n <= 1 ? `${what} через ${shortDuration(mins)}` : `${what} через ${n} ур. · ~${shortDuration(mins)}`, n <= 1 ? 'gold' : 'info');
    }
  }

  // Рост блайндов и анте считаем от текущего игрового уровня (в перерыве — от следующего).
  const baseIdx = current.isBreak ? levels.findIndex((l, j) => j > i && !l.isBreak) : i;
  const base = baseIdx >= 0 ? levels[baseIdx] : undefined;
  const lastPlayable = levels.reduce((acc, l, j) => (l.isBreak ? acc : j), -1);
  if (base && !current.isBreak && i === lastPlayable) {
    add(75, '🏁', 'Последний уровень структуры', 'warn');
  }
  if (base && baseIdx >= 0) {
    const dbl = levels.findIndex((l, j) => j > baseIdx && !l.isBreak && l.bb >= base.bb * 2);
    if (dbl > 0) {
      const n = levelsUntil(levels, i, dbl);
      const mins = minutesUntil(levels, clock, dbl);
      // n — игровые уровни до удвоения, включая текущий (в перерыве — включая следующий): «через X мин» верно в обоих случаях.
      add(n <= 1 ? 55 : 35, '📈', n <= 1 ? `Блайнды ×2 через ${shortDuration(mins)}` : `Блайнды ×2 через ${n} ур.${mins < 60 ? ` · ~${mins} мин` : ''}`);
    }
    if (base.ante === 0) {
      const anteIdx = levels.findIndex((l, j) => j > baseIdx && !l.isBreak && l.ante > 0);
      const anteLevel = anteIdx > 0 ? levels[anteIdx] : undefined;
      if (anteLevel) {
        const k = playableNumber(levels, anteIdx);
        const n = levelsUntil(levels, i, anteIdx);
        add(n <= 1 ? 58 : 32, '🪙', `Анте с уровня ${k}${isBbAnte(anteLevel) ? ' (BB-анте)' : ''}`);
      }
    }
  }
  return pick(items, opts.limit);
}

function pick(items: ReadonlyArray<{ p: number; hint: GameHint }>, limit = 3): GameHint[] {
  return [...items].sort((a, b) => b.p - a.p).slice(0, limit).map((x) => x.hint);
}

// ───────────────────────────── Фазы турнира ─────────────────────────────

export type PhaseKey = 'registration' | 'play' | 'lateClosed' | 'break' | 'results';

export interface PhaseStep {
  key: PhaseKey;
  label: string;
  state: 'done' | 'current' | 'todo';
}

/**
 * Лента фаз: Регистрация → Игра → Рег. закрыта → Перерыв (или Add-on, если он есть) → Итоги.
 * «Рег. закрыта» и «Перерыв» стоят в хронологическом порядке (что раньше по структуре)
 * и пропускаются, если поздней регистрации или перерывов нет. Для отменённого турнира — пусто.
 */
export function phaseTimeline(d: HintInput, clock: ClockState | null, nowMs: number): PhaseStep[] {
  if (d.status === 'cancelled') return [];
  const levels = d.blindLevels;
  const breakIdx = firstBreakIndex(levels);
  const start = Date.parse(d.startsAt);
  const late = d.lateRegUntil ? Date.parse(d.lateRegUntil) : null;

  const middle: Array<{ key: PhaseKey; label: string; offsetMin: number; reached: boolean }> = [];
  if (late !== null) {
    middle.push({ key: 'lateClosed', label: 'Рег. закрыта', offsetMin: (late - start) / MINUTE_MS, reached: nowMs >= late });
  }
  if (breakIdx > 0) {
    const offsetMin = structureMinutes(levels.slice(0, breakIdx));
    middle.push({
      key: 'break',
      // Коротко, чтобы лента влезала в 375 px: перерыв с аддоном — просто «Add-on».
      label: d.addons.length ? 'Add-on' : 'Перерыв',
      offsetMin,
      reached: clock !== null && clock.levelIndex >= breakIdx,
    });
  }
  middle.sort((a, b) => a.offsetMin - b.offsetMin);

  const steps: Array<{ key: PhaseKey; label: string; reached: boolean }> = [
    { key: 'registration', label: 'Регистрация', reached: true },
    { key: 'play', label: 'Игра', reached: d.status === 'running' || d.status === 'completed' },
    ...middle.map((m) => ({ ...m, reached: m.reached || d.status === 'completed' })),
    { key: 'results', label: 'Итоги', reached: d.status === 'completed' },
  ];
  let current = 0;
  steps.forEach((s, idx) => {
    if (s.reached) current = idx;
  });
  return steps.map((s, idx) => ({
    key: s.key,
    label: s.label,
    state: idx < current ? 'done' : idx === current ? 'current' : 'todo',
  }));
}
