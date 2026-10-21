/**
 * Напоминания о турнире по настраиваемым сдвигам (`tournaments.reminder_offsets`, минуты до старта;
 * по умолчанию за 1 день и за 2 ч). Раз в минуту «забираем» созревшие напоминания одним
 * `INSERT … ON CONFLICT DO NOTHING RETURNING` в reminder_deliveries (`repo.claimDueReminders`) —
 * до отправки: лучше пропустить напоминание при сбое, чем прислать его дважды (в том числе
 * при нескольких процессах и перезапусках).
 *
 * - Окно открылось больше `REMINDER_GRACE_MIN` минут назад (сервер был выключен, старт перенесли
 *   вплотную) — напоминание отмечается пропущенным и не отправляется.
 * - Частоту отправки ограничивает TelegramNotifier (общий лимит бота).
 * - Игроки, отключившие напоминания в профиле или заблокировавшие бота, не выбираются.
 * - При переносе старта отметки турнира сбрасываются (services/tournaments.ts → repo.resetReminders).
 */
import * as repo from '../repo.ts';
import type { TournamentRow } from '../repo.ts';
import { REMINDER_GRACE_MIN } from '../../shared/rules.ts';
import { getNotifier } from '../services/notifier.ts';
import { nowIso } from '../time.ts';

const INTERVAL_MS = 60_000;

export interface ReminderPass {
  sent: number;
  /** Не доставлено: бот заблокирован (403) или другая ошибка Telegram. */
  failed: number;
  skipped: number;
}

/** Один проход: забрать и отправить всё, что пора. */
export async function sendDueReminders(now: Date = new Date()): Promise<ReminderPass> {
  const claimed = await repo.claimDueReminders(nowIso(now), REMINDER_GRACE_MIN);
  const pass: ReminderPass = { sent: 0, failed: 0, skipped: 0 };
  const tournaments = new Map<number, TournamentRow | undefined>();
  for (const c of claimed) {
    if (c.skipped) {
      pass.skipped += 1;
      continue;
    }
    if (!tournaments.has(c.tournament_id)) tournaments.set(c.tournament_id, await repo.findTournament(c.tournament_id));
    const t = tournaments.get(c.tournament_id);
    if (!t) continue;
    try {
      const outcome = await getNotifier().reminder(c.tg_id, t, c.offset_min);
      if (outcome === 'sent') pass.sent += 1;
      else pass.failed += 1;
    } catch (err) {
      pass.failed += 1;
      console.error('[reminders] ошибка отправки', c.tg_id, err);
    }
  }
  return pass;
}

/** Запускает цикл напоминаний; возвращает функцию остановки. Проходы не накладываются друг на друга. */
export function startReminders(): () => void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const { sent, failed, skipped } = await sendDueReminders();
      if (sent > 0 || failed > 0 || skipped > 0) {
        console.log(`[reminders] отправлено: ${sent}, не доставлено: ${failed}, пропущено устаревших: ${skipped}`);
      }
    } catch (err) {
      console.error('[reminders]', err);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
