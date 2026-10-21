/**
 * Напоминания о турнире за 24 ч и за 2 ч. Раз в минуту «забираем» записи, у которых старт
 * попал в окно, а напоминание ещё не отправлено. Флаг ставится тем же UPDATE … RETURNING,
 * что и выборка (`repo.claimDueReminders`), — до отправки: лучше пропустить напоминание
 * при сбое, чем прислать его дважды (в том числе если запущено несколько процессов).
 */
import * as repo from '../repo.ts';
import type { TournamentRow } from '../repo.ts';
import { notifyLater } from '../services/notifier.ts';
import { addMs, HOUR_MS, nowIso } from '../time.ts';

const INTERVAL_MS = 60_000;

/** Один проход: отправить всё, что пора. Возвращает число отправленных напоминаний. */
export async function sendDueReminders(now: Date = new Date()): Promise<number> {
  const nowStr = nowIso(now);
  const in2h = addMs(nowStr, 2 * HOUR_MS);
  const in24h = addMs(nowStr, 24 * HOUR_MS);
  // Сначала 2-часовые: они же гасят суточное, если оно не успело уйти.
  const due = [
    ...(await repo.claimDueReminders('2h', nowStr, in2h, in24h)).map((c) => ({ ...c, hours: 2 })),
    ...(await repo.claimDueReminders('24h', nowStr, in2h, in24h)).map((c) => ({ ...c, hours: 24 })),
  ];

  const tournaments = new Map<number, TournamentRow | undefined>();
  for (const d of due) {
    if (!tournaments.has(d.tournament_id)) tournaments.set(d.tournament_id, await repo.findTournament(d.tournament_id));
    const t = tournaments.get(d.tournament_id);
    if (t) notifyLater((n) => n.reminder(d.tg_id, t, d.hours));
  }
  return due.length;
}

/** Запускает цикл напоминаний; возвращает функцию остановки. Проходы не накладываются друг на друга. */
export function startReminders(): () => void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const n = await sendDueReminders();
      if (n > 0) console.log(`[reminders] отправлено напоминаний: ${n}`);
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
