/**
 * Формула клубных очков (чистая функция, без БД).
 */

/** Финальный стол — места с 1-го по 9-е. */
export const FINAL_TABLE_MAX_PLACE = 9;

/** Бонус чемпиону. */
export const WINNER_BONUS = 25;

/**
 * Очки за турнир: доля обойдённого поля (0..100) + нокауты × цена нокаута, +25 за победу.
 *
 * `round(100 * (fieldSize - place + 1) / fieldSize) + knockouts * knockoutPoints (+25 за 1-е место)`
 */
export function pointsFor(place: number, fieldSize: number, knockouts: number, knockoutPoints: number): number {
  if (fieldSize <= 0 || place < 1 || place > fieldSize) throw new RangeError('Место должно быть в пределах 1..fieldSize');
  const base = Math.round((100 * (fieldSize - place + 1)) / fieldSize);
  return base + knockouts * knockoutPoints + (place === 1 ? WINNER_BONUS : 0);
}
