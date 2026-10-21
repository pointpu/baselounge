/**
 * Уведомления игрокам. Сервисы знают только интерфейс; реализация через Telegram
 * подключается в main.ts, если задан BOT_TOKEN.
 */
import type { TournamentRow } from '../repo.ts';

export interface Notifier {
  registered(tgId: number, t: TournamentRow, waitlistPosition: number | null): Promise<void>;
  waitlistPromoted(tgId: number, t: TournamentRow): Promise<void>;
  seatAssigned(tgId: number, t: TournamentRow, table: number, seat: number): Promise<void>;
  resultsPublished(tgId: number, t: TournamentRow, place: number, points: number): Promise<void>;
  tournamentCancelled(tgId: number, t: TournamentRow): Promise<void>;
  reminder(tgId: number, t: TournamentRow, hours: number): Promise<void>;
}

/** Ничего не отправляет (бот выключен). */
export class NullNotifier implements Notifier {
  async registered(): Promise<void> {}
  async waitlistPromoted(): Promise<void> {}
  async seatAssigned(): Promise<void> {}
  async resultsPublished(): Promise<void> {}
  async tournamentCancelled(): Promise<void> {}
  async reminder(): Promise<void> {}
}

let current: Notifier = new NullNotifier();

export function setNotifier(n: Notifier): void {
  current = n;
}

export function getNotifier(): Notifier {
  return current;
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
