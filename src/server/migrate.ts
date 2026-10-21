/**
 * Миграции схемы ведёт goose (pressly/goose): SQL-файлы `src/server/migrations/NNN_name.sql`
 * с секциями `-- +goose Up` / `-- +goose Down`, применённые версии — в таблице `goose_db_version`.
 *
 * Приложение миграции НЕ применяет: в Kubernetes это делает initContainer `migrate` до старта
 * пода, локально — `npm run migrate`. Здесь только проверка, что схема не отстаёт от кода:
 * сервер, сид и импорт отказываются работать со старой схемой и подсказывают, что запустить.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from './db.ts';

export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');
const FILE_RE = /^(\d+)_[a-z0-9_]+\.sql$/;

/** Номер последней миграции в коде (наибольший NNN среди файлов). */
async function latestVersionInCode(): Promise<number> {
  const versions = (await readdir(MIGRATIONS_DIR))
    .map((f) => FILE_RE.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number);
  const dup = versions.find((v, i) => versions.indexOf(v) !== i);
  if (dup !== undefined) throw new Error(`Две миграции с номером ${dup} в ${MIGRATIONS_DIR}`);
  return versions.length ? Math.max(...versions) : 0;
}

/** Текущая версия схемы по goose (0 — goose ещё не запускался). */
async function currentDbVersion(): Promise<number> {
  const [exists] = await sql<{ ok: boolean }[]>`SELECT to_regclass('goose_db_version') IS NOT NULL AS ok`;
  if (!exists?.ok) return 0;
  // goose пишет и откаты (is_applied = false): берём последнюю запись по каждой версии.
  const [row] = await sql<{ version: string | null }[]>`
    SELECT max(version_id)::text AS version FROM (
      SELECT DISTINCT ON (version_id) version_id, is_applied
      FROM goose_db_version ORDER BY version_id, id DESC
    ) v WHERE is_applied`;
  return Number(row?.version ?? 0);
}

/** Бросает понятную ошибку, если в базе применены не все миграции из кода. */
export async function assertSchemaUpToDate(): Promise<number> {
  const [code, db] = await Promise.all([latestVersionInCode(), currentDbVersion()]);
  if (db < code) {
    throw new Error(
      `Схема базы устарела: в базе версия ${db}, в коде ${code}. ` +
        'Примените миграции: локально `npm run migrate`, в Kubernetes их применяет initContainer migrate.',
    );
  }
  return db;
}
