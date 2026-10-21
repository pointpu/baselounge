/**
 * Анонсы новых турниров: когда турнир открывает регистрацию, бот пишет всем подписанным игрокам.
 *
 * - Право на рассылку «забирается» в транзакции открытия (`repo.claimAnnouncement`: announced_at
 *   ставится один раз за жизнь турнира), сама рассылка запускается после коммита — `scheduleAnnouncement`.
 * - Получатели — игроки с notify_announcements и без отметки bot_blocked_at (больше никого не исключаем).
 * - Рассылки идут по очереди, сообщения — последовательно. Частоту ограничивает сам TelegramNotifier
 *   (общий лимит на все сообщения бота, с паузой по 429). Очередь живёт в процессе: при
 *   перезапуске недосланный анонс не продолжается (это лучше, чем отправить его дважды).
 * - Ошибки отдельных сообщений не прерывают рассылку; в лог — сводка
 *   `[announce] t=ID sent=N blocked=M failed=K`.
 */
import * as repo from '../repo.ts';
import type { TournamentRow } from '../repo.ts';
import { getNotifier } from './notifier.ts';

/** Как часто (в сообщениях) перепроверять, что турнир всё ещё открыт для записи. */
const RECHECK_EVERY = 200;

export interface AnnounceSummary {
  tournamentId: number;
  sent: number;
  blocked: number;
  failed: number;
  /** Рассылка прервана: турнир отменили или регистрация закрылась. */
  aborted: boolean;
}

/** Разослать анонс турнира (последовательно). Ошибки не выбрасывает. */
export async function broadcastAnnouncement(t: TournamentRow): Promise<AnnounceSummary> {
  const summary: AnnounceSummary = { tournamentId: t.id, sent: 0, blocked: 0, failed: 0, aborted: false };
  let recipients: number[];
  try {
    recipients = await repo.listAnnouncementRecipients();
  } catch (err) {
    console.error(`[announce] t=${t.id}: не удалось получить получателей`, err);
    return summary;
  }
  let current = t;
  for (const [i, tgId] of recipients.entries()) {
    if (i > 0 && i % RECHECK_EVERY === 0) {
      const fresh = await repo.findTournament(t.id).catch(() => current);
      if (!fresh || fresh.status !== 'registration') {
        summary.aborted = true;
        break;
      }
      current = fresh;
    }
    try {
      const outcome = await getNotifier().announce(tgId, current);
      summary[outcome] += 1;
    } catch (err) {
      summary.failed += 1;
      console.warn(`[announce] t=${t.id}: ошибка отправки ${tgId}:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(
    `[announce] t=${t.id} sent=${summary.sent} blocked=${summary.blocked} failed=${summary.failed}${summary.aborted ? ' (прервано: регистрация закрыта)' : ''}`,
  );
  return summary;
}

/** Очередь рассылок процесса: следующий анонс начинается после предыдущего. */
let queue: Promise<unknown> = Promise.resolve();

/** Поставить анонс в очередь. Вызывать строго после коммита транзакции, забравшей `claimAnnouncement`. */
export function scheduleAnnouncement(t: TournamentRow): Promise<AnnounceSummary> {
  const run = queue.then(() => broadcastAnnouncement(t));
  queue = run.catch(() => undefined);
  return run;
}
