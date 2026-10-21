/**
 * Уведомления игрокам. Сервисы знают только интерфейс; реализация через Telegram
 * подключается в main.ts, если задан BOT_TOKEN.
 */
import type { TournamentRow } from '../repo.ts';

export interface Notifier {
  registered(tgId: number, t: TournamentRow, waitlistPosition: number | null): Promise<void>;
  waitlistPromoted(tgId: number, t: TournamentRow): Promise<void>;
  seatAssigned(tgId: number, t: TournamentRow, table: number, seat: number): Promise<void>;
  /** fieldSize — сколько игроков в итогах турнира («3-е место из 18»). */
  resultsPublished(tgId: number, t: TournamentRow, place: number, points: number, fieldSize: number): Promise<void>;
  tournamentCancelled(tgId: number, t: TournamentRow): Promise<void>;
  /**
   * minutesBefore — за сколько минут до старта это напоминание (один из t.reminder_offsets).
   * Сообщает исход, как `announce`, — для честной статистики цикла напоминаний.
   */
  reminder(tgId: number, t: TournamentRow, minutesBefore: number): Promise<SendOutcome>;
  /**
   * Анонс нового турнира. В отличие от остальных методов сообщает исход:
   * 'blocked' — Telegram 403 (реализация сама вызывает repo.markBotBlocked), 'failed' — другая ошибка.
   */
  announce(tgId: number, t: TournamentRow): Promise<SendOutcome>;
}

/** Исход отправки одного сообщения. */
export type SendOutcome = 'sent' | 'blocked' | 'failed';

/** Ничего не отправляет (бот выключен). */
export class NullNotifier implements Notifier {
  async registered(): Promise<void> {}
  async waitlistPromoted(): Promise<void> {}
  async seatAssigned(): Promise<void> {}
  async resultsPublished(): Promise<void> {}
  async tournamentCancelled(): Promise<void> {}
  // Бот выключен — ничего не доставлено (не «sent»: статистика не должна врать).
  async reminder(): Promise<SendOutcome> {
    return 'failed';
  }
  async announce(): Promise<SendOutcome> {
    return 'failed';
  }
}

let current: Notifier = new NullNotifier();

export function setNotifier(n: Notifier): void {
  current = n;
}

export function getNotifier(): Notifier {
  return current;
}

/** Подключён ли настоящий канал доставки (бот). Без него анонсы не «забираются» и не тратятся впустую. */
export function notificationsEnabled(): boolean {
  return !(current instanceof NullNotifier);
}

/**
 * Отправить уведомление «в фоне»: вызывать строго после коммита транзакции.
 * Ошибки только логируются — запрос пользователя от них не падает.
 */
export function notifyLater(send: (n: Notifier) => Promise<void>): void {
  void Promise.resolve()
    .then(() => send(current))
    .catch((err: unknown) => console.error('[notify]', err));
}
