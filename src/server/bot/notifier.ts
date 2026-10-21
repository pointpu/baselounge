/**
 * Отправка уведомлений игрокам через Telegram (реализация интерфейса `Notifier`).
 *
 * Ошибки никогда не выбрасываются наружу: уведомление — не повод ронять запрос.
 * Если пользователь заблокировал бота или удалил аккаунт (Telegram 403), помечаем это
 * в БД (`repo.markBotBlocked`), чтобы рассылки его пропускали.
 */
import { type Api, GrammyError, InlineKeyboard } from 'grammy';
import { config } from '../config.ts';
import * as repo from '../repo.ts';
import type { TournamentRow } from '../repo.ts';
import type { Notifier, SendOutcome } from '../services/notifier.ts';
import { canCancelRegistration } from '../services/tournaments.ts';
import { texts } from './texts.ts';

/** Кнопки web_app и url работают только с https-адресом. */
export const webAppEnabled = config.webappUrl.startsWith('https://');

/**
 * Ссылка на экран Mini App для кнопок бота. Маршрут — в query (`?route=/t/12`), а не после `#`:
 * Telegram при открытии Mini App перезаписывает или дописывает `#` своими параметрами.
 */
export const routeUrl = (route: string): string => `${config.webappUrl}/?route=${encodeURIComponent(route)}`;
export const tournamentUrl = (id: number): string => routeUrl(`/t/${id}`);
export const ratingUrl = (): string => routeUrl('/rating');
export const calendarUrl = (id: number): string => `${config.webappUrl}/api/tournaments/${id}/calendar.ics`;

export interface KeyboardOptions {
  /** Предложить «Отменить запись» (кнопка-callback, работает и без https). */
  cancel?: boolean;
  /** «📅 В календарь». */
  calendar?: boolean;
  /** «🏆 Рейтинг». */
  rating?: boolean;
  /** Подпись главной кнопки (по умолчанию «Открыть турнир»). */
  openLabel?: string;
}

/**
 * Клавиатура под сообщением о турнире. Первая строка — «Открыть турнир» (Mini App),
 * вторая — контекстные кнопки (календарь/рейтинг), третья — отмена записи.
 */
export function tournamentKeyboard(tournamentId: number, opts: KeyboardOptions = {}): InlineKeyboard | undefined {
  const kb = new InlineKeyboard();
  if (webAppEnabled) {
    kb.webApp(opts.openLabel ?? texts.openTournament, tournamentUrl(tournamentId));
    if (opts.rating || opts.calendar) {
      kb.row();
      if (opts.rating) kb.webApp(texts.ratingButton, ratingUrl());
      if (opts.calendar) kb.url(texts.calendarButton, calendarUrl(tournamentId));
    }
  }
  if (opts.cancel) {
    if (kb.inline_keyboard.flat().length > 0) kb.row();
    kb.text(texts.cancelButton, `cancel:${tournamentId}`);
  }
  return kb.inline_keyboard.flat().length > 0 ? kb : undefined;
}

/** Deep link на запись: `/start t_<id>` в чате с ботом (работает и без https у Mini App). */
export const signUpUrl = (botUsername: string, id: number): string => `https://t.me/${botUsername}?start=t_${id}`;

/**
 * Клавиатура анонса: «✍️ Записаться» — deep link (запись в один тап), «🃏 Открыть турнир» — Mini App.
 * Без имени бота — как раньше, только Mini App.
 */
export function announceKeyboard(tournamentId: number, botUsername: string | undefined): InlineKeyboard | undefined {
  if (!botUsername) return tournamentKeyboard(tournamentId, { openLabel: texts.signUp });
  const kb = new InlineKeyboard().url(texts.signUp, signUpUrl(botUsername, tournamentId));
  if (webAppEnabled) kb.row().webApp(texts.openTournament, tournamentUrl(tournamentId));
  return kb;
}

/** Кнопка «Открыть клуб» (Mini App) — для сообщений без карточки турнира. */
export function clubKeyboard(): InlineKeyboard | undefined {
  return webAppEnabled ? new InlineKeyboard().webApp(texts.openClub, config.webappUrl) : undefined;
}

/** Можно ли сейчас предложить отмену записи (правило сервиса турниров). */
export function cancelAllowed(t: TournamentRow, status: 'registered' | 'waitlist'): boolean {
  return canCancelRegistration(t, status);
}

/** 403 «bot was blocked by the user» / «user is deactivated» / «bot can't initiate conversation». */
export function isBlockedError(err: unknown): boolean {
  if (!(err instanceof GrammyError) || err.error_code !== 403) return false;
  return /blocked by the user|user is deactivated|can't initiate conversation/i.test(err.description);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Общий лимит всех сообщений бота (у Telegram — около 30 в секунду на бота). */
export const RATE_PER_SEC = 25;
/** Дольше этого (с) по 429 не ждём — сообщение считается недоставленным. */
const MAX_RETRY_AFTER_SEC = 60;
/** Сколько раз повторяем сообщение после 429. */
const MAX_RETRIES = 2;

/**
 * Ограничитель частоты на весь процесс: `await take()` перед каждым sendMessage держит интервал
 * ≥ 1000 / perSec мс между отправками (очередь «бронируется» синхронно — безопасно при параллельных
 * вызовах). `pause(ms)` по 429 сдвигает все следующие отправки, а не только повтор этой.
 */
export function rateLimiter(perSec: number): { take(): Promise<void>; pause(ms: number): void } {
  const interval = 1000 / perSec;
  let next = 0;
  return {
    async take() {
      const now = Date.now();
      const wait = next - now;
      next = Math.max(now, next) + interval;
      if (wait > 0) await sleep(wait);
    },
    pause(ms: number) {
      next = Math.max(next, Date.now() + ms);
    },
  };
}

const limiter = rateLimiter(RATE_PER_SEC);

/** Пользователи, про которых мы уже знаем, что они «живые» (чтобы не писать в БД на каждый апдейт). */
const knownReachable = new Set<number>();

/** Снять отметку «бот заблокирован» — при любом взаимодействии пользователя с ботом. */
export async function markReachable(tgId: number): Promise<void> {
  if (knownReachable.has(tgId)) return;
  try {
    await repo.clearBotBlocked(tgId);
    knownReachable.add(tgId);
  } catch (err) {
    console.warn(`[bot] clearBotBlocked(${tgId}):`, err instanceof Error ? err.message : err);
  }
}

/** Пользователь заблокировал бота (403 или my_chat_member → kicked): помечаем в БД, забываем кэш. */
export async function markUnreachable(tgId: number): Promise<void> {
  knownReachable.delete(tgId);
  try {
    await repo.markBotBlocked(tgId);
  } catch (err) {
    console.warn(`[bot] markBotBlocked(${tgId}):`, err instanceof Error ? err.message : err);
  }
}

export class TelegramNotifier implements Notifier {
  readonly #api: Api;
  /** Имя бота — для deep link «Записаться» (`t.me/<bot>?start=t_<id>`). */
  readonly #botUsername: string | undefined;

  constructor(api: Api, botUsername?: string) {
    this.#api = api;
    this.#botUsername = botUsername;
  }

  /**
   * Отправляет сообщение через общий лимит частоты. На 429 ставит на паузу весь лимит на retry_after
   * (не дольше 60 с) и повторяет — до двух раз.
   */
  async #send(tgId: number, text: string, keyboard?: InlineKeyboard): Promise<SendOutcome> {
    const attempt = async () => {
      await limiter.take();
      await this.#api.sendMessage(tgId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
    };
    try {
      for (let retry = 0; ; retry += 1) {
        try {
          await attempt();
          break;
        } catch (err) {
          const retryAfter = err instanceof GrammyError && err.error_code === 429 ? (err.parameters.retry_after ?? 1) : null;
          if (retryAfter === null || retryAfter > MAX_RETRY_AFTER_SEC || retry >= MAX_RETRIES) throw err;
          console.warn(`[bot] 429: пауза ${retryAfter} с`);
          limiter.pause(retryAfter * 1000);
        }
      }
      return 'sent';
    } catch (err) {
      if (isBlockedError(err)) {
        await markUnreachable(tgId);
        console.info(`[bot] ${tgId} недоступен (бот заблокирован или аккаунт удалён)`);
        return 'blocked';
      }
      console.warn(`[bot] не удалось отправить сообщение ${tgId}:`, err instanceof Error ? err.message : err);
      return 'failed';
    }
  }

  async registered(tgId: number, t: TournamentRow, waitlistPosition: number | null): Promise<void> {
    const waitlist = waitlistPosition !== null;
    const text = waitlist ? texts.waitlisted(t, waitlistPosition) : texts.registered(t);
    await this.#send(
      tgId,
      text,
      tournamentKeyboard(t.id, { calendar: !waitlist, cancel: cancelAllowed(t, waitlist ? 'waitlist' : 'registered') }),
    );
  }

  async waitlistPromoted(tgId: number, t: TournamentRow): Promise<void> {
    await this.#send(tgId, texts.promoted(t), tournamentKeyboard(t.id, { calendar: true, cancel: cancelAllowed(t, 'registered') }));
  }

  async seatAssigned(tgId: number, t: TournamentRow, table: number, seat: number): Promise<void> {
    await this.#send(tgId, texts.seat(t, table, seat), tournamentKeyboard(t.id));
  }

  async resultsPublished(tgId: number, t: TournamentRow, place: number, points: number, fieldSize: number): Promise<void> {
    await this.#send(tgId, texts.results(t, place, points, fieldSize), tournamentKeyboard(t.id, { rating: true }));
  }

  async tournamentCancelled(tgId: number, t: TournamentRow): Promise<void> {
    await this.#send(tgId, texts.cancelledByClub(t), tournamentKeyboard(t.id));
  }

  reminder(tgId: number, t: TournamentRow, minutesBefore: number): Promise<SendOutcome> {
    // Напоминания получают только участники (не лист ожидания).
    return this.#send(
      tgId,
      texts.reminder(t, minutesBefore),
      tournamentKeyboard(t.id, { calendar: minutesBefore >= 60, cancel: cancelAllowed(t, 'registered') }),
    );
  }

  announce(tgId: number, t: TournamentRow): Promise<SendOutcome> {
    return this.#send(tgId, texts.announce(t), announceKeyboard(t.id, this.#botUsername));
  }
}
