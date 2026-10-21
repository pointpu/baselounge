/**
 * Миграции схемы: SQL-файлы `src/server/migrations/NNN_name.sql`, применяются по порядку
 * при старте сервера (и перед сидом/импортом).
 *
 * Всё выполняется в одной транзакции под `pg_advisory_xact_lock`: два процесса, стартующие
 * одновременно, не применят миграцию дважды — второй дождётся первого и увидит, что всё готово.
 * Применённые миграции записываются в `schema_migrations`; уже применённый файл менять нельзя —
 * изменения схемы оформляются новым файлом.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from './db.ts';

const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');
const FILE_RE = /^(\d{3})_[a-z0-9_]+\.sql$/;
/** Произвольный, но постоянный ключ advisory-блокировки миграций. */
const MIGRATION_LOCK_KEY = 4_172_026_001;

async function migrationFiles(): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => FILE_RE.test(f)).sort();
  const numbers = files.map((f) => FILE_RE.exec(f)![1]);
  const dup = numbers.find((n, i) => numbers.indexOf(n) !== i);
  if (dup) throw new Error(`Две миграции с номером ${dup} в ${MIGRATIONS_DIR}`);
  return files;
}

/** Применяет недостающие миграции; возвращает имена применённых сейчас. */
export async function runMigrations(): Promise<string[]> {
  const files = await migrationFiles();
  return sql.begin(async (q) => {
    await q`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
    await q`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`;
    const done = new Set((await q<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await q.unsafe(body);
      } catch (err) {
        throw new Error(`Миграция ${file} не применилась: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      await q`INSERT INTO schema_migrations (name) VALUES (${file})`;
      applied.push(file);
    }
    return { applied };
  }).then((r) => r.applied);
}
