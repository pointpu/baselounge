/**
 * Турнирные часы (чистая функция). Сервер хранит только момент старта, момент паузы
 * и накопленное время пауз; текущий уровень и остаток считаются на лету.
 */
import type { BlindLevel, ClockState } from '../../shared/types.ts';

/**
 * Состояние часов на момент `now`. Возвращает null, если часы не запущены или уровней нет.
 * @param pausedTotalSec суммарная длительность завершённых пауз, сек
 */
export function clockState(
  levels: readonly BlindLevel[],
  startedAt: string | null,
  pausedAt: string | null,
  pausedTotalSec: number,
  now: Date = new Date(),
): ClockState | null {
  if (!startedAt || levels.length === 0) return null;
  const until = pausedAt ? Date.parse(pausedAt) : now.getTime();
  const elapsedSec = Math.max(0, Math.floor((until - Date.parse(startedAt)) / 1000) - pausedTotalSec);

  let acc = 0;
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i]!;
    const duration = level.minutes * 60;
    if (elapsedSec < acc + duration) {
      return {
        levelIndex: i,
        level,
        nextLevel: levels[i + 1] ?? null,
        remainingSec: acc + duration - elapsedSec,
        elapsedSec,
        paused: pausedAt !== null,
        finished: false,
        totalLevels: levels.length,
      };
    }
    acc += duration;
  }

  const last = levels.length - 1;
  return {
    levelIndex: last,
    level: levels[last]!,
    nextLevel: null,
    remainingSec: 0,
    elapsedSec,
    paused: pausedAt !== null,
    finished: true,
    totalLevels: levels.length,
  };
}
