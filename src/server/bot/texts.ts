/**
 * Все тексты бота (parse_mode HTML). Пользовательские данные всегда проходят через `esc()`.
 *
 * Единый вид сообщения:
 *   ✅ <b>Заголовок</b>            ← эмодзи статуса + жирный заголовок
 *
 *   <b>Название турнира</b>        ← блок турнира (`tournamentBlock`)
 *   🗓 пт, 24 октября · 19:00 · через 2 ч
 *   💰 500 ₽
 *   🃏 NLH · Bounty · Re-entry
 *   📍 Стол 2 · место 5           ← необязательные строки
 *
 *   <i>Короткая подсказка</i>      ← только когда она действительно полезна
 *
 * Строки короткие — сообщение читают с телефона. Время — всегда в часовом поясе клуба.
 */
import { config } from '../config.ts';
import type { TournamentRow } from '../repo.ts';
import { gameLine } from '../services/formats.ts';

// ───────────────────────────── Базовые помощники ─────────────────────────────

/** Экранирование для parse_mode=HTML (в т.ч. для значений атрибутов). */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Источник «сейчас»: подменяется только в preview.ts, чтобы примеры были стабильными. */
let clock: () => Date = () => new Date();
export function setClockForPreview(fn: () => Date): void {
  clock = fn;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Русское склонение: plural(5, 'очко', 'очка', 'очков') → «очков». */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

const num = (n: number): string => n.toLocaleString('ru-RU');

/** Календарная дата (год, месяц, день) в поясе клуба — для «сегодня/завтра». */
function clubDayIndex(d: Date): number {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: config.clubTz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return Math.round(Date.parse(`${parts}T00:00:00Z`) / DAY);
}

/** «19:00» в поясе клуба. */
export function clubTime(iso: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: config.clubTz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** «пт, 24 октября» в поясе клуба. */
export function clubDate(iso: string): string {
  const parts = new Intl.DateTimeFormat('ru-RU', { timeZone: config.clubTz, weekday: 'short', day: 'numeric', month: 'long' }).formatToParts(
    new Date(iso),
  );
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('weekday').replace('.', '')}, ${get('day')} ${get('month')}`;
}

/** Сколько календарных дней (по часам клуба) от «сейчас» до момента `iso`. */
function daysUntil(iso: string): number {
  return clubDayIndex(new Date(iso)) - clubDayIndex(clock());
}

/** «1 ч 30 мин», «45 мин», «2 ч» — длительность, округлённая до 5 минут (до часа — до минуты). */
export function duration(minutes: number): string {
  const m = minutes < 60 ? Math.max(1, Math.round(minutes)) : Math.round(minutes / 5) * 5;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest} мин`;
  return rest === 0 ? `${h} ч` : `${h} ч ${rest} мин`;
}

/**
 * Относительное время до старта: «через 40 мин», «через 3 ч», «сегодня», «завтра»,
 * «через 3 дня». Пусто, если турнир уже начался или до него неделя и больше.
 */
export function relativeStart(iso: string): string {
  const minutes = (Date.parse(iso) - clock().getTime()) / MINUTE;
  if (minutes <= 0) return '';
  if (minutes < 60) return `через ${duration(minutes)}`;
  if (minutes < 12 * 60) return `через ${Math.round(minutes / 60)} ч`;
  const days = daysUntil(iso);
  if (days === 0) return 'сегодня';
  if (days === 1) return 'завтра';
  if (days < 7) return `через ${days} ${plural(days, 'день', 'дня', 'дней')}`;
  return '';
}

/** «пт, 24 октября · 19:00 · через 2 ч». */
export function whenLine(iso: string, opts: { relative?: boolean } = {}): string {
  const rel = opts.relative === false ? '' : relativeStart(iso);
  return [clubDate(iso), clubTime(iso), rel].filter(Boolean).join(' · ');
}

/** «Сегодня в 19:00» / «Завтра в 19:00» / «пт, 24 октября в 19:00». */
function dayAt(iso: string): string {
  const d = daysUntil(iso);
  const day = d === 0 ? 'Сегодня' : d === 1 ? 'Завтра' : clubDate(iso);
  return `${day} в ${clubTime(iso)}`;
}

export const buyIn = (t: TournamentRow): string => (t.buy_in > 0 ? `${num(t.buy_in)} ₽` : 'Бесплатно');

/** Отрезает текст до `max` символов по границе слова, добавляет «…». Возвращает НЕэкранированную строку. */
export function excerpt(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?—–-]+$/, '')}…`;
}

// ───────────────────────────── Сборка сообщения ─────────────────────────────

export interface BlockOptions {
  /** Показывать «через 2 ч» в строке даты (по умолчанию да). */
  relative?: boolean;
  /** Дополнительные строки в конце блока (уже в HTML). */
  extra?: string[];
}

/** Блок турнира: название, дата, вход, игра и формат. */
export function tournamentBlock(t: TournamentRow, opts: BlockOptions = {}): string {
  const lines = [`<b>${esc(t.title)}</b>`, `🗓 ${esc(whenLine(t.starts_at, opts))}`, `💰 ${buyIn(t)}`, `🃏 ${esc(gameLine(t))}`];
  return [...lines, ...(opts.extra ?? [])].join('\n');
}

/** Заголовок + блоки, разделённые пустой строкой; подсказка — курсивом в конце. */
function message(title: string, blocks: (string | null | undefined | false)[], hint?: string | null): string {
  const parts = [title, ...blocks.filter((b): b is string => typeof b === 'string' && b.length > 0)];
  if (hint) parts.push(`<i>${hint}</i>`);
  return parts.join('\n\n');
}

/** Добавляет точку в конце фразы, если там нет знака препинания (причины 409 приходят без неё). */
const withPeriod = (s: string): string => (/[.!?…]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

const brand = (): string => `♠ <b>${esc(config.clubName)}</b> · poker club`;

/** Медаль за место в топ-3. */
const medal = (place: number): string => (place === 1 ? '🥇' : place === 2 ? '🥈' : place === 3 ? '🥉' : '🏁');

/** Заголовок напоминания по сдвигу до старта. */
function reminderTitle(t: TournamentRow, minutesBefore: number): string {
  const left = (Date.parse(t.starts_at) - clock().getTime()) / MINUTE;
  const minutes = left > 0 ? left : minutesBefore;
  if (minutesBefore >= 1440) return `⏰ <b>${dayAt(t.starts_at)}</b>`;
  // Цикл напоминаний может опоздать на минуту-другую: округляем до четверти часа («1 ч 58 мин» → «2 ч»).
  if (minutesBefore >= 60) return `⏰ <b>Через ${duration(Math.max(60, Math.round(minutes / 15) * 15))} — в ${clubTime(t.starts_at)}</b>`;
  const m = Math.max(1, Math.round(minutes));
  const text = `Через ${m} ${plural(m, 'минуту', 'минуты', 'минут')}!`;
  return minutesBefore <= 30 ? `🔥 <b>${text}</b>` : `⏰ <b>${text}</b>`;
}

export interface NotifyPrefs {
  announcements: boolean;
  reminders: boolean;
}

const onOff = (v: boolean): string => (v ? 'вкл' : 'выкл');

// ───────────────────────────── Тексты ─────────────────────────────

export const texts = {
  privateOnly: '🤫 Я работаю в личных сообщениях — там запись на турниры, напоминания и клуб.',
  privateOnlyButton: '💬 Написать боту',
  // — Кнопки —
  openClub: '♠ Открыть клуб',
  openTournament: '🃏 Открыть турнир',
  signUp: '✍️ Записаться',
  cancelButton: '❌ Отменить запись',
  cancelConfirmButton: '✅ Да, отменить',
  cancelKeepButton: '↩️ Нет, остаюсь',
  ratingButton: '🏆 Рейтинг',
  calendarButton: '📅 В календарь',
  phoneButton: '📱 Отправить мой номер',
  prefButton: (key: keyof NotifyPrefs, on: boolean) => `${key === 'announcements' ? '🔔 Анонсы' : '⏰ Напоминания'}: ${onOff(on)}`,

  // — Приветствие и справка —
  welcome: (name: string) =>
    message(
      brand(),
      [
        `Привет, ${esc(name)}! 👋`,
        '🗓 Афиша и запись в один тап\n⏱ Живые часы и рассадка\n🏆 Клубный рейтинг и итоги',
      ],
      'Напомню о турнире и пришлю место за столом.',
    ),
  welcomeNoWebApp: (name: string) =>
    message(brand(), [`Привет, ${esc(name)}! 👋`], 'Mini App временно недоступен.'),
  help: (webApp: boolean) =>
    message(
      'ℹ️ <b>Команды</b>',
      [
        '/start — открыть клуб\n/notify — анонсы и напоминания\n/phone — подтвердить телефон\n/help — эта справка',
        webApp ? 'Запись, рейтинг и профиль — в Mini App: кнопка «Клуб» слева от поля ввода.' : null,
      ],
      'Пришлю напоминание, рассадку и итоги.',
    ),

  // — Телефон —
  phoneAsk: message('📱 <b>Подтвердите телефон</b>', ['Нажмите кнопку ниже — администратор сможет связаться с вами.']),
  phoneVerified: message('✅ <b>Телефон подтверждён</b>', [], 'Спасибо! Больше ничего делать не нужно.'),
  phoneForeign: message('⚠️ <b>Это чужой контакт</b>', ['Отправьте свой номер кнопкой ниже.']),

  // — Запись —
  registered: (t: TournamentRow) =>
    message('✅ <b>Вы записаны</b>', [tournamentBlock(t)], 'Не сможете прийти — отмените запись, место уйдёт следующему.'),
  waitlisted: (t: TournamentRow, position: number | null) =>
    message(
      `⏳ <b>Лист ожидания${position ? ` · №${position}` : ''}</b>`,
      ['Мест пока нет.', tournamentBlock(t)],
      'Освободится место — запишу автоматически и сообщу.',
    ),
  alreadyIn: (t: TournamentRow, waitlist: boolean, position: number | null) =>
    message(
      waitlist ? `⏳ <b>Вы уже в листе ожидания${position ? ` · №${position}` : ''}</b>` : '✅ <b>Вы уже записаны</b>',
      [tournamentBlock(t)],
    ),
  registrationClosed: (reason: string, t: TournamentRow | undefined) =>
    message('🔒 <b>Запись закрыта</b>', [esc(withPeriod(reason)), t ? tournamentBlock(t) : null], 'Другие турниры — в афише клуба.'),
  tournamentNotFound: message('🤷 <b>Турнир не найден</b>', ['Возможно, ссылка устарела.'], 'Актуальная афиша — в клубе.'),

  // — Отмена —
  cancelToast: 'Запись отменена',
  cancelDone: (t: TournamentRow) =>
    message('↩️ <b>Запись отменена</b>', [tournamentBlock(t, { relative: false })], 'Будем ждать вас на следующем турнире!'),
  cancelNothingToast: 'Активной записи нет',
  cancelKeptToast: 'Запись сохранена',
  cancelNothing: (t: TournamentRow) => message('ℹ️ <b>Записи нет</b>', [tournamentBlock(t, { relative: false })]),

  // — Уведомления —
  promoted: (t: TournamentRow) =>
    message('🎉 <b>Место освободилось — вы в игре!</b>', [tournamentBlock(t)], 'Ждём вас за столом.'),
  seat: (t: TournamentRow, table: number, seat: number) =>
    message('🪑 <b>Рассадка готова</b>', [`📍 <b>Стол ${table} · место ${seat}</b>`, tournamentBlock(t)]),
  results: (t: TournamentRow, place: number, points: number, fieldSize: number) => {
    const title = place === 1 ? '🥇 <b>Победа!</b>' : place <= 3 ? `${medal(place)} <b>${place}-е место</b>` : '🏁 <b>Итоги турнира</b>';
    const placeLine = `Место <b>${place}</b>${fieldSize > 0 ? ` из ${fieldSize}` : ''}`;
    const pointsLine = points > 0 ? `⭐ <b>+${num(points)}</b> ${plural(points, 'очко', 'очка', 'очков')} в рейтинг` : null;
    return message(
      title,
      [`<b>${esc(t.title)}</b>\n🗓 ${esc(whenLine(t.starts_at, { relative: false }))}`, [placeLine, pointsLine].filter(Boolean).join('\n')],
      place === 1 ? 'Поздравляем с победой!' : place <= 3 ? 'Отличная игра — поздравляем!' : 'Спасибо за игру!',
    );
  },
  cancelledByClub: (t: TournamentRow) =>
    message('🚫 <b>Турнир отменён</b>', [tournamentBlock(t, { relative: false })], 'Приносим извинения — следите за афишей.'),
  reminder: (t: TournamentRow, minutesBefore: number) =>
    message(
      reminderTitle(t, minutesBefore),
      [tournamentBlock(t, { relative: false })],
      minutesBefore < 60 ? 'Ждём за столом — не опаздывайте!' : 'Не сможете прийти? Отмените запись — место уйдёт следующему.',
    ),
  announce: (t: TournamentRow) => {
    const desc = t.description.trim() ? esc(excerpt(t.description, 160)) : t.subtitle.trim() ? esc(excerpt(t.subtitle, 160)) : null;
    return message('🆕 <b>Новый турнир</b>', [tournamentBlock(t), desc], 'Отключить анонсы: /notify off');
  },

  // — Настройки уведомлений —
  notifyPrefs: (p: NotifyPrefs) =>
    message(
      '🔔 <b>Уведомления</b>',
      [`Анонсы новых турниров — <b>${onOff(p.announcements)}</b>\nНапоминания перед стартом — <b>${onOff(p.reminders)}</b>`],
      'Запись, рассадка и итоги приходят всегда.',
    ),
  notifyToast: (key: keyof NotifyPrefs, on: boolean) => `${key === 'announcements' ? 'Анонсы' : 'Напоминания'}: ${onOff(on)}`,

  // — Ошибки —
  genericError: message('😕 <b>Что-то пошло не так</b>', [], 'Попробуйте ещё раз чуть позже.'),
  genericErrorToast: 'Что-то пошло не так, попробуйте позже',
} as const;

/** Меню команд (setMyCommands). */
export const commands = [
  { command: 'start', description: 'Открыть клуб' },
  { command: 'notify', description: 'Анонсы и напоминания' },
  { command: 'phone', description: 'Подтвердить телефон' },
  { command: 'help', description: 'Справка' },
];

/** Короткое описание (профиль бота, до 120 символов). Без HTML. */
export const botShortDescription = (): string => `${config.clubName} · poker club — афиша, запись на турниры и рейтинг`;

/** Описание на пустом экране чата (до 512 символов). Без HTML. */
export const botDescription = (): string =>
  `♠ ${config.clubName} · poker club\n\nАфиша турниров и запись в один тап, живые часы и рассадка, клубный рейтинг. ` +
  'Бот напомнит о турнире и пришлёт итоги.';
