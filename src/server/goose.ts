/**
 * Локальный запуск goose с DATABASE_URL из .env: `npm run migrate` (= up), `npm run migrate -- status`,
 * `npm run migrate -- down`. В Kubernetes миграции применяет initContainer чарта, этот скрипт не нужен.
 * Требуется goose v3.29+: `brew install goose` или `go install github.com/pressly/goose/v3/cmd/goose@v3.29.0`.
 */
import { spawnSync } from 'node:child_process';
import { MIGRATIONS_DIR } from './migrate.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL не задан — заполните .env (см. .env.example)');
  process.exit(1);
}
const args = process.argv.slice(2);
const result = spawnSync('goose', ['-dir', MIGRATIONS_DIR, ...(args.length ? args : ['up'])], {
  stdio: 'inherit',
  // Строка подключения — через окружение, чтобы пароль не попал в список процессов.
  env: { ...process.env, GOOSE_DRIVER: 'postgres', GOOSE_DBSTRING: url },
});
if (result.error) {
  console.error('Не удалось запустить goose:', result.error.message);
  console.error('Установите goose: brew install goose (или go install github.com/pressly/goose/v3/cmd/goose@v3.29.0)');
  process.exit(1);
}
process.exit(result.status ?? 1);
