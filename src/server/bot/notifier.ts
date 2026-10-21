/**
 * Отправка уведомлений игрокам через Telegram. Ошибки (бот заблокирован, чат не найден)
 * логируются и проглатываются: уведомление — не повод ронять запрос.
 */
import { type Api, InlineKeyboard } from 'grammy';
import { config } from '../config.ts';
import type { TournamentRow } from '../repo.ts';
import type { Notifier } from '../services/notifier.ts';
import { texts } from './texts.ts';

/** Кнопки web_app работают только с https-адресом. */
export const webAppEnabled = config.webappUrl.startsWith('https://');

/** Ссылка на турнир для кнопок бота: маршрут в query (`?route=`), т.к. `#` Telegram перезаписывает. */
export const tournamentUrl = (id: number): string => `${config.webappUrl}/?route=${encodeURIComponent(`/t/${id}`)}`;

/** Клавиатура под сообщением о турнире: открыть в Mini App и (опционально) отменить запись. */
export function tournamentKeyboard(tournamentId: number, opts: { cancel: boolean }): InlineKeyboard | undefined {
  const kb = new InlineKeyboard();
  if (webAppEnabled) kb.webApp(texts.openTournament, tournamentUrl(tournamentId));
  if (opts.cancel) {
    if (webAppEnabled) kb.row();
    kb.text(texts.cancelButton, `cancel:${tournamentId}`);
  }
  return kb.inline_keyboard.flat().length > 0 ? kb : undefined;
}

export class TelegramNotifier implements Notifier {
  readonly #api: Api;

  constructor(api: Api) {
    this.#api = api;
  }

  async #send(tgId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
    try {
      await this.#api.sendMessage(tgId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
    } catch (err) {
      console.warn(`[bot] не удалось отправить сообщение ${tgId}:`, err instanceof Error ? err.message : err);
    }
  }

  registered(tgId: number, t: TournamentRow, waitlistPosition: number | null): Promise<void> {
    const text = waitlistPosition === null ? texts.registered(t) : texts.waitlisted(t, waitlistPosition);
    return this.#send(tgId, text, tournamentKeyboard(t.id, { cancel: true }));
  }

  waitlistPromoted(tgId: number, t: TournamentRow): Promise<void> {
    return this.#send(tgId, texts.promoted(t), tournamentKeyboard(t.id, { cancel: true }));
  }

  seatAssigned(tgId: number, t: TournamentRow, table: number, seat: number): Promise<void> {
    return this.#send(tgId, texts.seat(t, table, seat), tournamentKeyboard(t.id, { cancel: false }));
  }

  resultsPublished(tgId: number, t: TournamentRow, place: number, points: number): Promise<void> {
    return this.#send(tgId, texts.results(t, place, points), tournamentKeyboard(t.id, { cancel: false }));
  }

  tournamentCancelled(tgId: number, t: TournamentRow): Promise<void> {
    return this.#send(tgId, texts.cancelledByClub(t));
  }

  reminder(tgId: number, t: TournamentRow, hours: number): Promise<void> {
    return this.#send(tgId, texts.reminder(t, hours), tournamentKeyboard(t.id, { cancel: true }));
  }
}
