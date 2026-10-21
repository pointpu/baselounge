/**
 * Авторассадка (чистая функция): сбалансированно и случайно раскладывает игроков по столам.
 */
import type { Seat } from '../../shared/types.ts';

/** Перемешивание Фишера — Йетса (возвращает новый массив). */
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * Рассадка: столов = ceil(n / tableSize); игроки перемешиваются и раздаются по кругу,
 * поэтому размеры столов отличаются не больше чем на 1. Номера мест внутри стола тоже
 * случайны (из 1..tableSize), чтобы «баттон» не доставался всегда первым.
 */
export function balancedSeating(playerIds: readonly number[], tableSize = 9, random: () => number = Math.random): Map<number, Seat> {
  const result = new Map<number, Seat>();
  if (playerIds.length === 0) return result;
  const tables = Math.ceil(playerIds.length / tableSize);
  const byTable: number[][] = Array.from({ length: tables }, () => []);
  shuffle(playerIds, random).forEach((id, i) => byTable[i % tables]!.push(id));

  byTable.forEach((ids, t) => {
    const seats = shuffle(
      Array.from({ length: tableSize }, (_, i) => i + 1),
      random,
    );
    ids.forEach((id, i) => result.set(id, { table: t + 1, seat: seats[i]! }));
  });
  return result;
}
