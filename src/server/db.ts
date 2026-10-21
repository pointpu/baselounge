/**
 * Подключение к PostgreSQL (драйвер `postgres`, он же postgres.js) и транзакции.
 *
 * Типы на границе с БД приведены к тому, что ждёт остальной код:
 *  - `timestamptz`/`timestamp` приходят ISO-строками UTC (`2026-10-24T16:00:00.000Z`) — такими же,
 *    какие даёт `nowIso()`, поэтому строки по-прежнему можно сравнивать лексикографически;
 *  - `bigint` (Telegram ID, `count(*)`) приходит обычным числом (Telegram ID < 2^53);
 *  - `jsonb` разбирается драйвером в объекты, `boolean` — в true/false.
 *
 * Транзакция «запоминается» в AsyncLocalStorage: функции репозитория берут исполнителя
 * через `db()` и внутри `tx()` автоматически работают в текущей транзакции.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import postgres from 'postgres';
import { config } from './config.ts';

/** Нормализует текстовое значение timestamptz из PostgreSQL в ISO UTC. */
function parseTimestamptz(raw: string): string {
  return new Date(raw).toISOString();
}

/** `timestamp without time zone` трактуем как UTC (в схеме его нет, но не хотим сюрпризов). */
function parseTimestamp(raw: string): string {
  return new Date(`${raw.replace(' ', 'T')}Z`).toISOString();
}

/** Параметр-время: строки (ISO, а также `infinity`/`-infinity`) передаём как есть. */
function serializeTime(value: string | Date): string {
  return typeof value === 'string' ? value : value.toISOString();
}

function parseInt8(raw: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new RangeError(`bigint ${raw} не помещается в число JavaScript`);
  return n;
}

const OID = { int8: 20, timestamp: 1114, timestamptz: 1184 } as const;

function createClient() {
  return postgres(config.databaseUrl, {
    max: config.dbPoolMax,
    idle_timeout: 30,
    connect_timeout: 10,
    connection: { application_name: 'baselounge', TimeZone: 'UTC' },
    // NOTICE вида «relation already exists, skipping» в логах не нужны.
    onnotice: () => {},
    types: {
      int8: { to: OID.int8, from: [OID.int8], serialize: (v: number) => String(v), parse: parseInt8 },
      timestamptz: { to: OID.timestamptz, from: [OID.timestamptz], serialize: serializeTime, parse: parseTimestamptz },
      timestamp: { to: OID.timestamp, from: [OID.timestamp], serialize: serializeTime, parse: parseTimestamp },
    },
  });
}

/** Пул соединений приложения. */
export const sql = createClient();

type AppTypes = typeof sql extends postgres.Sql<infer T> ? T : never;

/** Транзакционный исполнитель запросов. */
export type TxSql = postgres.TransactionSql<AppTypes>;

/** Любой исполнитель запросов: пул или текущая транзакция. */
export type Queryable = postgres.ISql<AppTypes>;

const currentTx = new AsyncLocalStorage<TxSql>();

/** Исполнитель для запроса: текущая транзакция (если мы внутри `tx()`) или пул. */
export function db(): Queryable {
  return currentTx.getStore() ?? sql;
}

/**
 * Выполняет функцию в транзакции (READ COMMITTED). При исключении — ROLLBACK.
 * Вложенный вызов выполняется внутри внешней транзакции.
 *
 * Конкурентные read-modify-write обязаны брать блокировку (`SELECT … FOR UPDATE`) —
 * см. `repo.lockTournament()`.
 */
export async function tx<T>(fn: (q: TxSql) => Promise<T>): Promise<T> {
  const outer = currentTx.getStore();
  if (outer) return fn(outer);
  // Результат заворачиваем в объект: begin() по-особому обрабатывает массивы-результаты.
  const { value } = await sql.begin(async (q) => ({ value: await currentTx.run(q, () => fn(q)) }));
  return value;
}

/** Закрыть пул (graceful shutdown): ждём текущие запросы не дольше `timeoutSec`. */
export async function closeDb(timeoutSec = 5): Promise<void> {
  await sql.end({ timeout: timeoutSec });
}
