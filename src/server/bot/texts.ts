/**
 * Все тексты бота (HTML parse_mode). Пользовательские данные всегда проходят через `esc()`.
 */
import { config } from '../config.ts';
import type { TournamentRow } from '../repo.ts';
import { formatDateTime } from '../time.ts';

/** Экранирование для parse_mode=HTML. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const when = (t: TournamentRow): string => formatDateTime(t.starts_at, config.clubTz);
const buyIn = (t: TournamentRow): string => (t.buy_in > 0 ? `${t.buy_in.toLocaleString('ru-RU')} ₽` : 'бесплатно');

/** Короткая карточка турнира: название, дата, вход. */
export function tournamentLine(t: TournamentRow): string {
  return `<b>${esc(t.title)}</b>\n🗓 ${esc(when(t))} · 💰 ${buyIn(t)}`;
}

export const texts = {
  welcome: (name: string) =>
    `♠ <b>${esc(config.clubName)} · poker club</b>\n\n` +
    `Привет, ${esc(name)}! Здесь расписание турниров, запись в один тап, живые часы, рассадка и клубный рейтинг.\n\n` +
    `Жмите «Открыть клуб» 👇`,
  welcomeNoWebApp: (name: string) =>
    `♠ <b>${esc(config.clubName)} · poker club</b>\n\nПривет, ${esc(name)}! Mini App пока не подключён (нужен https-адрес в WEBAPP_URL).`,
  openClub: 'Открыть клуб',
  openTournament: 'Открыть турнир',
  cancelButton: 'Отменить запись',
  help:
    `<b>Что умеет бот</b>\n\n` +
    `/start — открыть клуб\n` +
    `/phone — подтвердить номер телефона\n` +
    `/help — эта справка\n\n` +
    `Запись, отмена, рейтинг и профиль — в Mini App (кнопка «Клуб» слева от поля ввода). ` +
    `Бот напомнит о турнире за сутки и за 2 часа, пришлёт рассадку и итоги.`,
  phoneAsk: 'Нажмите кнопку ниже, чтобы поделиться номером — так администратор сможет связаться с вами.',
  phoneButton: '📱 Отправить мой номер',
  phoneVerified: 'Телефон подтверждён ✓',
  phoneForeign: 'Пожалуйста, отправьте свой собственный контакт кнопкой ниже.',
  registered: (t: TournamentRow) =>
    `✅ Вы записаны на турнир\n${tournamentLine(t)}\n\nЕсли не получится прийти — пожалуйста, отмените запись, чтобы место досталось другому.`,
  waitlisted: (t: TournamentRow, position: number | null) =>
    `⏳ Мест нет — вы в листе ожидания${position ? ` (№${position})` : ''}\n${tournamentLine(t)}\n\n` +
    `Как только место освободится, запишу автоматически и сообщу.`,
  alreadyIn: (t: TournamentRow, waitlist: boolean) =>
    `${waitlist ? '⏳ Вы уже в листе ожидания' : '✅ Вы уже записаны'}\n${tournamentLine(t)}`,
  promoted: (t: TournamentRow) => `🎉 Освободилось место — вы в составе!\n${tournamentLine(t)}\n\nЖдём вас за столом.`,
  seat: (t: TournamentRow, table: number, seat: number) =>
    `🪑 Рассадка готова\n${tournamentLine(t)}\n\nВаше место: <b>стол ${table} · место ${seat}</b>`,
  results: (t: TournamentRow, place: number, points: number) =>
    `🏁 Итоги турнира «${esc(t.title)}»\n\nВаше место: <b>${place}</b> · +${points} очков в рейтинг.` +
    (place === 1 ? '\n\n🏆 Поздравляем с победой!' : ''),
  cancelledByClub: (t: TournamentRow) => `❌ Турнир отменён\n${tournamentLine(t)}\n\nПриносим извинения — следите за афишей.`,
  reminder: (t: TournamentRow, hours: number) =>
    `⏰ ${hours >= 24 ? 'Завтра' : `Через ${hours} ч`} — турнир\n${tournamentLine(t)}\n\nНе сможете прийти? Отмените запись — место ждёт кто-то из очереди.`,
  cancelDone: (t: TournamentRow) => `Запись на «${esc(t.title)}» отменена. Будем ждать на следующем турнире!`,
  cancelNothing: 'Активной записи на этот турнир нет.',
  tournamentNotFound: 'Турнир не найден — возможно, ссылка устарела.',
  genericError: 'Что-то пошло не так. Попробуйте ещё раз чуть позже.',
} as const;

export const commands = [
  { command: 'start', description: 'Открыть клуб' },
  { command: 'phone', description: 'Подтвердить телефон' },
  { command: 'help', description: 'Справка' },
];
