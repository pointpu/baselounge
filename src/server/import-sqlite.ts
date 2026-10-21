/**
 * Перенос данных из старой SQLite-базы в PostgreSQL (`DATABASE_URL`):
 *
 *   npm run import:sqlite -- [путь к .db] [--force]
 *
 * По умолчанию читается `data/showdown.db` (только чтение — файл не меняется).
 * Игроки, турниры, регистрации и результаты копируются в ОДНОЙ транзакции с сохранением id
 * (`OVERRIDING SYSTEM VALUE`), после чего identity-последовательности сдвигаются за максимум.
 * Если в целевых таблицах уже есть данные, импорт отказывается работать; `--force` сначала
 * очищает их (TRUNCATE). Преобразования: 0/1 → boolean, JSON-текст → jsonb, ISO-текст → timestamptz.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type postgres from 'postgres';
import { PROJECT_ROOT } from './config.ts';
import { closeDb, sql, type TxSql } from './db.ts';
import { assertSchemaUpToDate } from './migrate.ts';

const TABLES = ['players', 'tournaments', 'registrations', 'results'] as const;
type Table = (typeof TABLES)[number];

type SqliteValue = string | number | bigint | null | Uint8Array;
type SqliteRow = Record<string, SqliteValue>;

class ImportError extends Error {
  override name = 'ImportError';
}

function parseArgs(argv: readonly string[]): { file: string; force: boolean } {
  const force = argv.includes('--force');
  const positional = argv.filter((a) => !a.startsWith('--'));
  const unknown = argv.filter((a) => a.startsWith('--') && a !== '--force');
  if (unknown.length > 0) throw new ImportError(`Неизвестные флаги: ${unknown.join(', ')}`);
  if (positional.length > 1) throw new ImportError('Укажите не больше одного пути к файлу SQLite');
  return { file: resolve(PROJECT_ROOT, positional[0] ?? 'data/showdown.db'), force };
}

// ───────────────────────────── Преобразования значений ─────────────────────────────

function where(table: Table, row: SqliteRow, column: string): string {
  return `${table}#${String(row['id'])}.${column}`;
}

function int(table: Table, row: SqliteRow, column: string): number {
  const v = row[column];
  const n = typeof v === 'bigint' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) throw new ImportError(`${where(table, row, column)}: ожидалось целое, получено ${String(v)}`);
  return n;
}

function intOrNull(table: Table, row: SqliteRow, column: string): number | null {
  return row[column] === null || row[column] === undefined ? null : int(table, row, column);
}

function text(table: Table, row: SqliteRow, column: string, fallback?: string): string {
  const v = row[column];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'string') throw new ImportError(`${where(table, row, column)}: ожидалась строка, получено ${String(v)}`);
  return v;
}

function textOrNull(table: Table, row: SqliteRow, column: string): string | null {
  const v = row[column];
  return v === null || v === undefined ? null : text(table, row, column);
}

/** 0/1 → boolean. */
function bool(table: Table, row: SqliteRow, column: string): boolean {
  const n = int(table, row, column);
  if (n !== 0 && n !== 1) throw new ImportError(`${where(table, row, column)}: ожидалось 0 или 1, получено ${n}`);
  return n === 1;
}

/** ISO-строка → нормализованный ISO UTC (PostgreSQL примет как timestamptz). */
function time(table: Table, row: SqliteRow, column: string): string {
  const v = text(table, row, column);
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new ImportError(`${where(table, row, column)}: некорректная дата «${v}»`);
  return new Date(ms).toISOString();
}

function timeOrNull(table: Table, row: SqliteRow, column: string): string | null {
  return row[column] === null || row[column] === undefined ? null : time(table, row, column);
}

/** JSON-текст → массив (jsonb). Пустое значение — пустой массив, как и раньше в приложении. */
function jsonArray(table: Table, row: SqliteRow, column: string): postgres.JSONValue[] {
  const v = row[column];
  if (v === null || v === undefined || v === '') return [];
  let parsed: postgres.JSONValue;
  try {
    parsed = JSON.parse(text(table, row, column));
  } catch {
    throw new ImportError(`${where(table, row, column)}: некорректный JSON`);
  }
  if (!Array.isArray(parsed)) throw new ImportError(`${where(table, row, column)}: ожидался JSON-массив`);
  return [...parsed];
}

// ───────────────────────────── Чтение SQLite ─────────────────────────────

function readTable(src: DatabaseSync, table: Table): SqliteRow[] {
  const exists = src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) throw new ImportError(`В файле SQLite нет таблицы ${table} — это точно база BASE LOUNGE?`);
  return src.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as SqliteRow[];
}

function convert(src: DatabaseSync) {
  const players = readTable(src, 'players').map((r) => ({
    id: int('players', r, 'id'),
    tg_id: int('players', r, 'tg_id'),
    username: textOrNull('players', r, 'username'),
    first_name: text('players', r, 'first_name'),
    nickname: textOrNull('players', r, 'nickname'),
    tg_photo_url: textOrNull('players', r, 'tg_photo_url'),
    avatar_file: textOrNull('players', r, 'avatar_file'),
    phone: textOrNull('players', r, 'phone'),
    phone_verified: bool('players', r, 'phone_verified'),
    created_at: time('players', r, 'created_at'),
  }));

  const tournaments = readTable(src, 'tournaments').map((r) => ({
    id: int('tournaments', r, 'id'),
    title: text('tournaments', r, 'title'),
    subtitle: text('tournaments', r, 'subtitle', ''),
    description: text('tournaments', r, 'description', ''),
    starts_at: time('tournaments', r, 'starts_at'),
    late_reg_until: timeOrNull('tournaments', r, 'late_reg_until'),
    status: text('tournaments', r, 'status'),
    capacity: int('tournaments', r, 'capacity'),
    buy_in: int('tournaments', r, 'buy_in'),
    starting_stack: intOrNull('tournaments', r, 'starting_stack'),
    knockout_points: int('tournaments', r, 'knockout_points'),
    // Колонки, появившиеся позже: в старых файлах их может не быть.
    table_size: r['table_size'] === undefined ? Math.max(2, Math.min(9, int('tournaments', r, 'capacity'))) : int('tournaments', r, 'table_size'),
    dealer: text('tournaments', r, 'dealer', ''),
    reentries: jsonArray('tournaments', r, 'reentries'),
    addons: jsonArray('tournaments', r, 'addons'),
    blind_levels: jsonArray('tournaments', r, 'blind_levels'),
    clock_started_at: timeOrNull('tournaments', r, 'clock_started_at'),
    clock_paused_at: timeOrNull('tournaments', r, 'clock_paused_at'),
    clock_paused_total: int('tournaments', r, 'clock_paused_total'),
    results_published_at: timeOrNull('tournaments', r, 'results_published_at'),
    created_at: time('tournaments', r, 'created_at'),
  }));

  const registrations = readTable(src, 'registrations').map((r) => ({
    id: int('registrations', r, 'id'),
    tournament_id: int('registrations', r, 'tournament_id'),
    player_id: int('registrations', r, 'player_id'),
    status: text('registrations', r, 'status'),
    created_at: time('registrations', r, 'created_at'),
    updated_at: time('registrations', r, 'updated_at'),
    table_no: intOrNull('registrations', r, 'table_no'),
    seat_no: intOrNull('registrations', r, 'seat_no'),
    reminded_24h: bool('registrations', r, 'reminded_24h'),
    reminded_2h: bool('registrations', r, 'reminded_2h'),
  }));

  const results = readTable(src, 'results').map((r) => ({
    id: int('results', r, 'id'),
    tournament_id: int('results', r, 'tournament_id'),
    player_id: int('results', r, 'player_id'),
    place: int('results', r, 'place'),
    knockouts: int('results', r, 'knockouts'),
    points: int('results', r, 'points'),
  }));

  return { players, tournaments, registrations, results };
}

type Converted = ReturnType<typeof convert>;

// ───────────────────────────── Запись в PostgreSQL ─────────────────────────────

/**
 * Строки передаются одним jsonb-параметром и раскладываются `jsonb_to_recordset` с явными типами
 * колонок: одна вставка на таблицу, все приведения (timestamptz, boolean, jsonb) делает PostgreSQL.
 */
async function insertAll(q: TxSql, data: Converted): Promise<void> {
  // Сериализует драйвер: параметр уже типа jsonb, JSON.stringify здесь дал бы JSON-строку вместо массива.
  const json = (rows: readonly postgres.JSONValue[]): postgres.Parameter => q.json(rows);

  await q`
    INSERT INTO players (id, tg_id, username, first_name, nickname, tg_photo_url, avatar_file, phone, phone_verified, created_at)
    OVERRIDING SYSTEM VALUE
    SELECT id, tg_id, username, first_name, nickname, tg_photo_url, avatar_file, phone, phone_verified, created_at
    FROM jsonb_to_recordset(${json(data.players)}) AS x(
      id integer, tg_id bigint, username text, first_name text, nickname text, tg_photo_url text,
      avatar_file text, phone text, phone_verified boolean, created_at timestamptz)`;

  await q`
    INSERT INTO tournaments (id, title, subtitle, description, starts_at, late_reg_until, status, capacity, buy_in,
      starting_stack, knockout_points, table_size, dealer, reentries, addons, blind_levels,
      clock_started_at, clock_paused_at, clock_paused_total, results_published_at, created_at)
    OVERRIDING SYSTEM VALUE
    SELECT id, title, subtitle, description, starts_at, late_reg_until, status, capacity, buy_in,
      starting_stack, knockout_points, table_size, dealer, reentries, addons, blind_levels,
      clock_started_at, clock_paused_at, clock_paused_total, results_published_at, created_at
    FROM jsonb_to_recordset(${json(data.tournaments)}) AS x(
      id integer, title text, subtitle text, description text, starts_at timestamptz, late_reg_until timestamptz,
      status text, capacity integer, buy_in integer, starting_stack integer, knockout_points integer,
      table_size integer, dealer text, reentries jsonb, addons jsonb, blind_levels jsonb,
      clock_started_at timestamptz, clock_paused_at timestamptz, clock_paused_total integer,
      results_published_at timestamptz, created_at timestamptz)`;

  await q`
    INSERT INTO registrations (id, tournament_id, player_id, status, created_at, updated_at, table_no, seat_no)
    OVERRIDING SYSTEM VALUE
    SELECT id, tournament_id, player_id, status, created_at, updated_at, table_no, seat_no
    FROM jsonb_to_recordset(${json(data.registrations)}) AS x(
      id integer, tournament_id integer, player_id integer, status text, created_at timestamptz,
      updated_at timestamptz, table_no integer, seat_no integer)`;

  // Флаги старой схемы reminded_24h / reminded_2h → отметки reminder_deliveries (migration 004).
  await q`
    INSERT INTO reminder_deliveries (registration_id, offset_min)
    SELECT x.id, o.offset_min
    FROM jsonb_to_recordset(${json(data.registrations)}) AS x(id integer, reminded_24h boolean, reminded_2h boolean)
    CROSS JOIN LATERAL (VALUES (1440, x.reminded_24h), (120, x.reminded_2h)) AS o(offset_min, sent)
    WHERE o.sent`;

  // Перенесённые открытые/прошедшие турниры повторно не анонсируем.
  await q`UPDATE tournaments SET announced_at = created_at WHERE status <> 'draft' AND announced_at IS NULL`;

  await q`
    INSERT INTO results (id, tournament_id, player_id, place, knockouts, points)
    OVERRIDING SYSTEM VALUE
    SELECT id, tournament_id, player_id, place, knockouts, points
    FROM jsonb_to_recordset(${json(data.results)}) AS x(
      id integer, tournament_id integer, player_id integer, place integer, knockouts integer, points integer)`;
}

/** Сдвигает identity-последовательности за максимальный id (иначе новые вставки упадут на дубликате). */
async function resetSequences(q: TxSql): Promise<void> {
  for (const table of TABLES) {
    // Имя таблицы — из константного списка TABLES, а не из пользовательского ввода.
    await q.unsafe(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), coalesce((SELECT max(id) FROM ${table}), 0) + 1, false)`);
  }
}

async function countRows(q: TxSql): Promise<Record<Table, number>> {
  const [row] = await q<Record<Table, number>[]>`
    SELECT (SELECT count(*) FROM players)::int       AS players,
           (SELECT count(*) FROM tournaments)::int   AS tournaments,
           (SELECT count(*) FROM registrations)::int AS registrations,
           (SELECT count(*) FROM results)::int       AS results`;
  return row!;
}

async function main(): Promise<void> {
  const { file, force } = parseArgs(process.argv.slice(2));
  if (!existsSync(file)) throw new ImportError(`Файл не найден: ${file}`);

  const src = new DatabaseSync(file, { readOnly: true });
  let data: Converted;
  try {
    data = convert(src);
  } finally {
    src.close();
  }
  console.log(
    `[import] SQLite ${file}: игроков ${data.players.length}, турниров ${data.tournaments.length}, ` +
      `регистраций ${data.registrations.length}, результатов ${data.results.length}`,
  );

  await assertSchemaUpToDate();
  const counts = await sql.begin(async (q) => {
    // Никто не должен писать в таблицы, пока идёт перенос.
    await q`LOCK TABLE players, tournaments, registrations, results IN ACCESS EXCLUSIVE MODE`;
    const before = await countRows(q);
    const nonEmpty = TABLES.filter((t) => before[t] > 0);
    if (nonEmpty.length > 0) {
      if (!force) {
        throw new ImportError(
          `В PostgreSQL уже есть данные (${nonEmpty.map((t) => `${t}: ${before[t]}`).join(', ')}). ` +
            'Импорт остановлен, ничего не изменено. Чтобы заменить данные, запустите с --force.',
        );
      }
      console.warn(`[import] --force: очищаем ${nonEmpty.join(', ')}`);
      await q`TRUNCATE avatars, players, tournaments, registrations, reminder_deliveries, results RESTART IDENTITY`;
    }
    await insertAll(q, data);
    await resetSequences(q);
    return countRows(q);
  });

  console.log(
    `[import] готово, в PostgreSQL: игроков ${counts.players}, турниров ${counts.tournaments}, ` +
      `регистраций ${counts.registrations}, результатов ${counts.results}`,
  );
}

try {
  await main();
} catch (err) {
  console.error(`[import] ошибка: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
