/**
 * Репозиторий: все SQL-запросы приложения. Возвращает «сырые» строки БД (snake_case),
 * сборкой DTO занимаются сервисы.
 *
 * Все функции асинхронные и работают через `db()`: внутри `tx()` — в текущей транзакции,
 * иначе — через пул. Значения передаются только параметрами (tagged templates postgres.js).
 * Время — ISO-строки UTC, jsonb-поля — уже разобранные массивы.
 */
import type postgres from 'postgres';
import type { BlindLevel, Bullet, GameType, RegistrationStatus, TournamentStatus } from '../shared/types.ts';
import { db } from './db.ts';
import { nowIso } from './time.ts';

// ───────────────────────────── Строки таблиц ─────────────────────────────

export interface PlayerRow {
  id: number;
  tg_id: number;
  username: string | null;
  first_name: string;
  nickname: string | null;
  tg_photo_url: string | null;
  avatar_file: string | null;
  phone: string | null;
  phone_verified: boolean;
  created_at: string;
  /** Подписка на анонсы новых турниров (migration 004). */
  notify_announcements: boolean;
  /** Подписка на напоминания о своих турнирах (migration 004). */
  notify_reminders: boolean;
  /** Когда Telegram ответил «бот заблокирован» (403); null — можно писать. */
  bot_blocked_at: string | null;
}

export interface TournamentRow {
  id: number;
  title: string;
  subtitle: string;
  description: string;
  /** Разновидность холдема (migration 003). */
  game: GameType;
  starts_at: string;
  late_reg_until: string | null;
  status: TournamentStatus;
  capacity: number;
  buy_in: number;
  starting_stack: number | null;
  knockout_points: number;
  /** Игроков за столом при рассадке (2..10). */
  table_size: number;
  /** Дилер турнира (свободный текст, например имя или «два дилера»). */
  dealer: string;
  /** jsonb: ре-энтри. */
  reentries: Bullet[];
  /** jsonb: аддоны. */
  addons: Bullet[];
  /** jsonb: структура блайндов. */
  blind_levels: BlindLevel[];
  clock_started_at: string | null;
  clock_paused_at: string | null;
  clock_paused_total: number;
  results_published_at: string | null;
  created_at: string;
  /** Напоминания: минуты до старта (migration 004). */
  reminder_offsets: number[];
  /** Когда разослан анонс (одна рассылка за жизнь турнира); null — не рассылался. */
  announced_at: string | null;
}

export interface RegistrationRow {
  id: number;
  tournament_id: number;
  player_id: number;
  status: RegistrationStatus;
  created_at: string;
  updated_at: string;
  table_no: number | null;
  seat_no: number | null;
}

export interface ResultRowDb {
  id: number;
  tournament_id: number;
  player_id: number;
  place: number;
  knockouts: number;
  points: number;
}

/** Агрегаты по результатам игрока — основа для ачивок и рейтинга. */
export interface PlayerAggregate {
  player_id: number;
  events: number;
  wins: number;
  final_tables: number;
  knockouts: number;
  points: number;
  best_place: number | null;
}

/**
 * jsonb-параметр. Сериализует драйвер (ровно один раз): передавать `JSON.stringify(...)` нельзя —
 * параметр типа jsonb получил бы строку и сохранил бы её JSON-строкой, а не массивом.
 * Копия `{ ...v }` — ради типов: интерфейсы без индексной сигнатуры TS не считает JSONValue.
 */
const jsonb = (value: readonly (Bullet | BlindLevel)[]): postgres.Parameter => db().json(value.map((v) => ({ ...v })));

/**
 * Восстанавливает порядок ключей в объектах из jsonb. Postgres хранит ключи jsonb в своём
 * порядке (сначала короткие), а API исторически отдавал их в порядке типов `BlindLevel`/`Bullet`.
 * Mini App и сервер сравнивают структуру через `JSON.stringify`, поэтому порядок важен:
 * без нормализации любая правка турнира выглядела бы как «структура изменилась».
 * Известные ключи идут первыми в каноническом порядке, остальные (если есть) — следом, без изменений.
 */
function orderKeys<T>(items: readonly T[], keys: readonly string[]): T[] {
  return items.map((item) => {
    const src = item as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of keys) if (k in src) out[k] = src[k];
    for (const k of Object.keys(src)) if (!(k in out)) out[k] = src[k];
    return out as T;
  });
}

const BLIND_LEVEL_KEYS = ['sb', 'bb', 'ante', 'minutes', 'isBreak'] as const;
const BULLET_KEYS = ['stack', 'price', 'note'] as const;

/** Приводит jsonb-поля строки турнира к каноническому порядку ключей (см. `orderKeys`). */
function normalizeTournament(row: TournamentRow): TournamentRow {
  row.blind_levels = orderKeys(row.blind_levels, BLIND_LEVEL_KEYS);
  row.reentries = orderKeys(row.reentries, BULLET_KEYS);
  row.addons = orderKeys(row.addons, BULLET_KEYS);
  return row;
}

// ───────────────────────────── Игроки ─────────────────────────────

export interface TelegramProfile {
  tgId: number;
  firstName: string;
  username: string | null;
  photoUrl: string | null;
}

export async function findPlayerById(id: number): Promise<PlayerRow | undefined> {
  const [row] = await db()<PlayerRow[]>`SELECT * FROM players WHERE id = ${id}`;
  return row;
}

export async function findPlayerByTgId(tgId: number): Promise<PlayerRow | undefined> {
  const [row] = await db()<PlayerRow[]>`SELECT * FROM players WHERE tg_id = ${tgId}`;
  return row;
}

/**
 * Создаёт игрока или обновляет данные из Telegram (username, имя, фото) одним атомарным
 * `INSERT … ON CONFLICT`. Кастомный nickname никогда не перетирается. `keepPhoto` — не трогать
 * фото (в апдейтах бота фото нет, а initData Mini App его содержит).
 */
export async function upsertPlayerFromTelegram(p: TelegramProfile, opts: { keepPhoto?: boolean } = {}): Promise<PlayerRow> {
  const keepPhoto = opts.keepPhoto === true;
  const [row] = await db()<PlayerRow[]>`
    INSERT INTO players (tg_id, username, first_name, tg_photo_url, created_at)
    VALUES (${p.tgId}, ${p.username}, ${p.firstName}, ${p.photoUrl}, ${nowIso()})
    ON CONFLICT (tg_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      tg_photo_url = CASE WHEN ${keepPhoto}::boolean THEN players.tg_photo_url ELSE excluded.tg_photo_url END
    RETURNING *`;
  return row!;
}

/** Создаёт игрока, только если его ещё нет (DEV_MODE: не портим сид-данные). */
export async function ensurePlayer(tgId: number, firstName: string): Promise<PlayerRow> {
  await db()`INSERT INTO players (tg_id, first_name, created_at) VALUES (${tgId}, ${firstName}, ${nowIso()}) ON CONFLICT (tg_id) DO NOTHING`;
  return (await findPlayerByTgId(tgId))!;
}

export async function setNickname(playerId: number, nickname: string | null): Promise<void> {
  await db()`UPDATE players SET nickname = ${nickname} WHERE id = ${playerId}`;
}

export type AvatarMime = 'image/jpeg' | 'image/png' | 'image/webp';

export interface AvatarRow {
  player_id: number;
  mime: AvatarMime;
  data: Buffer;
  version: number;
  updated_at: string;
}

/**
 * Записывает аватар игрока (вставка или замена с version + 1) и возвращает новую версию.
 * Вызывать внутри `tx()` вместе с `setAvatarFile()`, чтобы имя и данные менялись атомарно.
 */
export async function upsertAvatar(playerId: number, mime: AvatarMime, data: Uint8Array): Promise<number> {
  const [row] = await db()<{ version: number }[]>`
    INSERT INTO avatars (player_id, mime, data, version, updated_at)
    VALUES (${playerId}, ${mime}, ${Buffer.from(data.buffer, data.byteOffset, data.byteLength)}, 1, ${nowIso()})
    ON CONFLICT (player_id) DO UPDATE
      SET mime = EXCLUDED.mime, data = EXCLUDED.data, version = avatars.version + 1, updated_at = EXCLUDED.updated_at
    RETURNING version`;
  return row!.version;
}

/** Аватар конкретной версии (устаревшие версии не отдаём — у них другое имя в avatarUrl). */
export async function findAvatar(playerId: number, version: number): Promise<AvatarRow | null> {
  const [row] = await db()<AvatarRow[]>`
    SELECT player_id, mime, data, version, updated_at FROM avatars
    WHERE player_id = ${playerId} AND version = ${version}`;
  return row ?? null;
}

export async function setAvatarFile(playerId: number, file: string | null): Promise<void> {
  await db()`UPDATE players SET avatar_file = ${file} WHERE id = ${playerId}`;
}

/** Подписки на уведомления игрока. */
export interface NotifyPrefsRow {
  announcements: boolean;
  reminders: boolean;
}

/** Telegram ответил 403 (бот заблокирован / аккаунт удалён) — больше не пишем до следующего /start. */
export async function markBotBlocked(tgId: number): Promise<void> {
  await db()`UPDATE players SET bot_blocked_at = now() WHERE tg_id = ${tgId} AND bot_blocked_at IS NULL`;
}

/** Игрок снова общается с ботом (/start и т.п.) — снимаем отметку о блокировке. */
export async function clearBotBlocked(tgId: number): Promise<void> {
  await db()`UPDATE players SET bot_blocked_at = NULL WHERE tg_id = ${tgId} AND bot_blocked_at IS NOT NULL`;
}

export async function getNotifyPrefs(tgId: number): Promise<NotifyPrefsRow> {
  const [row] = await db()<NotifyPrefsRow[]>`
    SELECT notify_announcements AS announcements, notify_reminders AS reminders FROM players WHERE tg_id = ${tgId}`;
  return row ?? { announcements: true, reminders: true };
}

/** Меняет только переданные подписки и возвращает итоговые. */
export async function setNotifyPrefs(tgId: number, prefs: { announcements?: boolean; reminders?: boolean }): Promise<NotifyPrefsRow> {
  const [row] = await db()<NotifyPrefsRow[]>`
    UPDATE players SET
      notify_announcements = coalesce(${prefs.announcements ?? null}::boolean, notify_announcements),
      notify_reminders = coalesce(${prefs.reminders ?? null}::boolean, notify_reminders)
    WHERE tg_id = ${tgId}
    RETURNING notify_announcements AS announcements, notify_reminders AS reminders`;
  return row ?? { announcements: true, reminders: true };
}

/** Получатели анонсов: подписаны и не заблокировали бота. По id — стабильный порядок. */
export async function listAnnouncementRecipients(): Promise<number[]> {
  const rows = await db()<{ tg_id: number }[]>`
    SELECT tg_id FROM players WHERE notify_announcements AND bot_blocked_at IS NULL ORDER BY id`;
  return rows.map((r) => r.tg_id);
}

export async function setVerifiedPhone(tgId: number, phone: string): Promise<void> {
  await db()`UPDATE players SET phone = ${phone}, phone_verified = true WHERE tg_id = ${tgId}`;
}

export async function findPlayersByIds(ids: readonly number[]): Promise<PlayerRow[]> {
  if (ids.length === 0) return [];
  const q = db();
  return q<PlayerRow[]>`SELECT * FROM players WHERE id IN ${q([...new Set(ids)])}`;
}

// ───────────────────────────── Турниры ─────────────────────────────

export async function findTournament(id: number): Promise<TournamentRow | undefined> {
  const [row] = await db()<TournamentRow[]>`SELECT * FROM tournaments WHERE id = ${id}`;
  return row && normalizeTournament(row);
}

/**
 * Турнир с блокировкой строки до конца транзакции (`FOR UPDATE`). Все изменения турнира и
 * его регистраций начинаются с неё — так конкурентные запросы выполняются по очереди:
 * вместимость не превышается, а лист ожидания повышается строго по FIFO.
 * Вызывать только внутри `tx()`.
 */
export async function lockTournament(id: number): Promise<TournamentRow | undefined> {
  const [row] = await db()<TournamentRow[]>`SELECT * FROM tournaments WHERE id = ${id} FOR UPDATE`;
  return row && normalizeTournament(row);
}

export async function listTournamentsByStatus(statuses: readonly TournamentStatus[], order: 'asc' | 'desc'): Promise<TournamentRow[]> {
  if (statuses.length === 0) return [];
  const q = db();
  const dir = order === 'asc' ? q`ASC` : q`DESC`;
  const rows = await q<TournamentRow[]>`
    SELECT * FROM tournaments WHERE status IN ${q([...statuses])}
    ORDER BY starts_at ${dir}, id ${dir}`;
  return rows.map(normalizeTournament);
}

export async function listAllTournaments(): Promise<TournamentRow[]> {
  const rows = await db()<TournamentRow[]>`SELECT * FROM tournaments ORDER BY starts_at DESC, id DESC`;
  return rows.map(normalizeTournament);
}

/** Поля турнира, которые задаёт админ (все в формате БД). */
export interface TournamentFields {
  title: string;
  subtitle: string;
  description: string;
  game: GameType;
  starts_at: string;
  late_reg_until: string | null;
  status: TournamentStatus;
  capacity: number;
  buy_in: number;
  starting_stack: number | null;
  knockout_points: number;
  table_size: number;
  dealer: string;
  reentries: Bullet[];
  addons: Bullet[];
  blind_levels: BlindLevel[];
  /** Минуты до старта. */
  reminder_offsets: number[];
}

/** integer[]-параметр (тип указан явно, чтобы и пустой массив передавался корректно). */
const intArray = (value: readonly number[]): postgres.Parameter => db().array([...value], 23) as unknown as postgres.Parameter;

export async function insertTournament(f: TournamentFields): Promise<number> {
  const [row] = await db()<{ id: number }[]>`
    INSERT INTO tournaments (title, subtitle, description, game, starts_at, late_reg_until, status, capacity, buy_in,
      starting_stack, knockout_points, table_size, dealer, reentries, addons, blind_levels, reminder_offsets, created_at)
    VALUES (${f.title}, ${f.subtitle}, ${f.description}, ${f.game}, ${f.starts_at}, ${f.late_reg_until}, ${f.status}, ${f.capacity},
      ${f.buy_in}, ${f.starting_stack}, ${f.knockout_points}, ${f.table_size}, ${f.dealer},
      ${jsonb(f.reentries)}, ${jsonb(f.addons)}, ${jsonb(f.blind_levels)}, ${intArray(f.reminder_offsets)}, ${nowIso()})
    RETURNING id`;
  return row!.id;
}

export async function updateTournamentFields(id: number, f: TournamentFields): Promise<void> {
  await db()`
    UPDATE tournaments SET
      title = ${f.title}, subtitle = ${f.subtitle}, description = ${f.description}, game = ${f.game}, starts_at = ${f.starts_at},
      late_reg_until = ${f.late_reg_until}, status = ${f.status}, capacity = ${f.capacity}, buy_in = ${f.buy_in},
      starting_stack = ${f.starting_stack}, knockout_points = ${f.knockout_points}, table_size = ${f.table_size},
      dealer = ${f.dealer}, reentries = ${jsonb(f.reentries)}, addons = ${jsonb(f.addons)},
      blind_levels = ${jsonb(f.blind_levels)}, reminder_offsets = ${intArray(f.reminder_offsets)}
    WHERE id = ${id}`;
}

export async function setTableSize(id: number, tableSize: number): Promise<void> {
  await db()`UPDATE tournaments SET table_size = ${tableSize} WHERE id = ${id}`;
}

export async function setTournamentStatus(id: number, status: TournamentStatus): Promise<void> {
  await db()`UPDATE tournaments SET status = ${status} WHERE id = ${id}`;
}

export async function setClock(id: number, startedAt: string | null, pausedAt: string | null, pausedTotalSec: number): Promise<void> {
  await db()`
    UPDATE tournaments SET clock_started_at = ${startedAt}, clock_paused_at = ${pausedAt}, clock_paused_total = ${pausedTotalSec}
    WHERE id = ${id}`;
}

/**
 * «Забирает» право разослать анонс: ставит announced_at, только если анонса ещё не было, турнир
 * открыт для записи и старт впереди. Возвращает турнир, если анонс нужно отправить (ровно один раз за жизнь турнира).
 */
export async function claimAnnouncement(id: number): Promise<TournamentRow | undefined> {
  const [row] = await db()<TournamentRow[]>`
    UPDATE tournaments SET announced_at = now()
    WHERE id = ${id} AND announced_at IS NULL AND status = 'registration' AND starts_at > now()
    RETURNING *`;
  return row && normalizeTournament(row);
}

export async function markResultsPublished(id: number, at: string): Promise<void> {
  await db()`UPDATE tournaments SET status = 'completed', results_published_at = ${at} WHERE id = ${id}`;
}

// ───────────────────────────── Регистрации ─────────────────────────────

export async function findRegistration(tournamentId: number, playerId: number): Promise<RegistrationRow | undefined> {
  const [row] = await db()<RegistrationRow[]>`
    SELECT * FROM registrations WHERE tournament_id = ${tournamentId} AND player_id = ${playerId}`;
  return row;
}

/** Активные (registered/waitlist) регистрации игрока — для карточек «моё». */
export async function listActiveRegistrationsOfPlayer(playerId: number): Promise<RegistrationRow[]> {
  return db()<RegistrationRow[]>`SELECT * FROM registrations WHERE player_id = ${playerId} AND status <> 'cancelled'`;
}

/** Регистрации турнира в заданном статусе; лист ожидания — строго FIFO. */
export async function listRegistrations(tournamentId: number, status: RegistrationStatus): Promise<RegistrationRow[]> {
  return db()<RegistrationRow[]>`
    SELECT * FROM registrations WHERE tournament_id = ${tournamentId} AND status = ${status}
    ORDER BY updated_at, id`;
}

export async function listAllRegistrations(tournamentId: number): Promise<RegistrationRow[]> {
  return db()<RegistrationRow[]>`
    SELECT * FROM registrations WHERE tournament_id = ${tournamentId}
    ORDER BY CASE status WHEN 'registered' THEN 0 WHEN 'waitlist' THEN 1 ELSE 2 END, updated_at, id`;
}

export interface RegistrationCounts {
  tournament_id: number;
  registered: number;
  waitlist: number;
}

export async function registrationCounts(): Promise<Map<number, RegistrationCounts>> {
  const rows = await db()<RegistrationCounts[]>`
    SELECT tournament_id,
           count(*) FILTER (WHERE status = 'registered')::int AS registered,
           count(*) FILTER (WHERE status = 'waitlist')::int AS waitlist
    FROM registrations GROUP BY tournament_id`;
  return new Map(rows.map((r) => [r.tournament_id, r]));
}

export async function countRegistered(tournamentId: number): Promise<number> {
  const [row] = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM registrations WHERE tournament_id = ${tournamentId} AND status = 'registered'`;
  return row!.n;
}

/** Позиция в листе ожидания (1-based) или null. Порядок — как в `listRegistrations`: (updated_at, id). */
export async function waitlistPosition(reg: RegistrationRow): Promise<number | null> {
  if (reg.status !== 'waitlist') return null;
  const [row] = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM registrations w, registrations me
    WHERE me.id = ${reg.id} AND w.tournament_id = me.tournament_id AND w.status = 'waitlist'
      AND (w.updated_at, w.id) < (me.updated_at, me.id)`;
  return row!.n + 1;
}

/**
 * Создаёт или переиспользует регистрацию (после отмены — та же строка); место за столом сбрасывается.
 * Возвращает id регистрации. Уже отправленные напоминания (reminder_deliveries) сохраняются — повторно не уйдут.
 */
export async function upsertRegistration(tournamentId: number, playerId: number, status: RegistrationStatus): Promise<number> {
  const now = nowIso();
  const [row] = await db()<{ id: number }[]>`
    INSERT INTO registrations (tournament_id, player_id, status, created_at, updated_at)
    VALUES (${tournamentId}, ${playerId}, ${status}, ${now}, ${now})
    ON CONFLICT (tournament_id, player_id) DO UPDATE SET
      status = excluded.status, updated_at = excluded.updated_at, created_at = excluded.created_at,
      table_no = NULL, seat_no = NULL
    RETURNING id`;
  return row!.id;
}

export async function setRegistrationStatus(id: number, status: RegistrationStatus): Promise<void> {
  await db()`
    UPDATE registrations SET status = ${status}, updated_at = ${nowIso()}, table_no = NULL, seat_no = NULL
    WHERE id = ${id}`;
}

/**
 * Переводит до `limit` первых (FIFO) из листа ожидания в участники.
 * Возвращает Telegram ID повышенных — для уведомлений после коммита.
 * Вызывать внутри транзакции, взявшей `lockTournament()`.
 */
export async function promoteWaitlist(tournamentId: number, limit: number): Promise<Array<{ id: number; tg_id: number }>> {
  if (limit <= 0) return [];
  return db()<Array<{ id: number; tg_id: number }>>`
    WITH next AS (
      SELECT id FROM registrations
      WHERE tournament_id = ${tournamentId} AND status = 'waitlist'
      ORDER BY updated_at, id
      LIMIT ${limit}
    )
    UPDATE registrations r
    SET status = 'registered', updated_at = ${nowIso()}, table_no = NULL, seat_no = NULL
    FROM next, players p
    WHERE r.id = next.id AND p.id = r.player_id
    RETURNING r.id, p.tg_id`;
}

export async function setSeat(id: number, table: number | null, seat: number | null): Promise<void> {
  await db()`UPDATE registrations SET table_no = ${table}, seat_no = ${seat} WHERE id = ${id}`;
}

// ───────────────────────────── Напоминания ─────────────────────────────

export interface ClaimedReminder {
  tg_id: number;
  tournament_id: number;
  offset_min: number;
  /** true — окно давно прошло (или есть более свежее напоминание): учтено, но не отправляется. */
  skipped: boolean;
}

/**
 * Атомарно «забирает» напоминания, которые пора отправить: для каждой записи `registered` на турнир
 * `registration` (запущенному досрочно турниру «Через 25 минут!» не шлём) и каждого сдвига из `reminder_offsets`, у которого окно открылось
 * (now ≥ старт − сдвиг) и старт ещё не наступил, вставляет строку reminder_deliveries.
 * `INSERT … ON CONFLICT DO NOTHING RETURNING` по первичному ключу (registration_id, offset_min):
 * даже два процесса не заберут одно напоминание дважды, перезапуск его не повторит.
 *
 * Не шлём (skipped = true): окно открылось больше `graceMin` минут назад (простой, перенос старта),
 * а также более ранние сдвиги, если у той же записи одновременно «созрел» более поздний (60 вместо 120).
 * Игроки без подписки на напоминания и заблокировавшие бота не выбираются вовсе.
 * Строки registrations не меняются и не блокируются — с рассадкой взаимных блокировок нет.
 */
export async function claimDueReminders(now: string, graceMin: number): Promise<ClaimedReminder[]> {
  return db()<ClaimedReminder[]>`
    WITH candidates AS (
      SELECT r.id AS registration_id, o.offset_min, p.tg_id, t.id AS tournament_id,
             ${now}::timestamptz > t.starts_at - make_interval(mins => o.offset_min - ${graceMin}::int) AS stale
      FROM registrations r
      JOIN tournaments t ON t.id = r.tournament_id
      JOIN players p ON p.id = r.player_id
      CROSS JOIN LATERAL unnest(t.reminder_offsets) AS o(offset_min)
      WHERE r.status = 'registered' AND t.status = 'registration'
        AND p.notify_reminders AND p.bot_blocked_at IS NULL
        AND t.starts_at > ${now}::timestamptz
        AND t.starts_at - make_interval(mins => o.offset_min) <= ${now}::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM reminder_deliveries d WHERE d.registration_id = r.id AND d.offset_min = o.offset_min
        )
    ),
    due AS (
      SELECT c.*, (c.stale OR c.offset_min > min(c.offset_min) OVER (PARTITION BY c.registration_id)) AS skip
      FROM candidates c
    ),
    ins AS (
      INSERT INTO reminder_deliveries (registration_id, offset_min, skipped, sent_at)
      SELECT registration_id, offset_min, skip, ${now}::timestamptz FROM due
      ON CONFLICT DO NOTHING
      RETURNING registration_id, offset_min, skipped
    )
    SELECT due.tg_id, due.tournament_id, ins.offset_min, ins.skipped
    FROM ins JOIN due ON due.registration_id = ins.registration_id AND due.offset_min = ins.offset_min
    ORDER BY due.tournament_id, ins.offset_min`;
}

/**
 * Отмечает как пропущенные напоминания, чьё окно уже открылось, — для только что записанных
 * (или повышенных из очереди): им пришло сообщение о записи, «за 2 ч» сразу следом не нужно.
 */
export async function skipStartedReminders(registrationIds: readonly number[], now: string): Promise<void> {
  if (registrationIds.length === 0) return;
  const q = db();
  await q`
    INSERT INTO reminder_deliveries (registration_id, offset_min, skipped, sent_at)
    SELECT r.id, o.offset_min, true, ${now}::timestamptz
    FROM registrations r
    JOIN tournaments t ON t.id = r.tournament_id
    CROSS JOIN LATERAL unnest(t.reminder_offsets) AS o(offset_min)
    WHERE r.id IN ${q([...registrationIds])}
      AND t.starts_at - make_interval(mins => o.offset_min) <= ${now}::timestamptz
    ON CONFLICT DO NOTHING`;
}

/** Отмечает все напоминания турнира как пропущенные (демо-данные: не писать сид-игрокам). */
export async function skipAllReminders(tournamentId: number): Promise<void> {
  await db()`
    INSERT INTO reminder_deliveries (registration_id, offset_min, skipped)
    SELECT r.id, o.offset_min, true
    FROM registrations r
    JOIN tournaments t ON t.id = r.tournament_id
    CROSS JOIN LATERAL unnest(t.reminder_offsets) AS o(offset_min)
    WHERE t.id = ${tournamentId}
    ON CONFLICT DO NOTHING`;
}

/** Старт перенесли — забываем отправленные напоминания турнира, чтобы они пришли к новому времени. */
export async function resetReminders(tournamentId: number): Promise<void> {
  await db()`
    DELETE FROM reminder_deliveries d USING registrations r
    WHERE d.registration_id = r.id AND r.tournament_id = ${tournamentId}`;
}

// ───────────────────────────── Результаты ─────────────────────────────

export async function listResults(tournamentId: number): Promise<ResultRowDb[]> {
  return db()<ResultRowDb[]>`SELECT * FROM results WHERE tournament_id = ${tournamentId} ORDER BY place`;
}

export async function deleteResults(tournamentId: number): Promise<void> {
  await db()`DELETE FROM results WHERE tournament_id = ${tournamentId}`;
}

export async function insertResult(tournamentId: number, playerId: number, place: number, knockouts: number, points: number): Promise<void> {
  await db()`
    INSERT INTO results (tournament_id, player_id, place, knockouts, points)
    VALUES (${tournamentId}, ${playerId}, ${place}, ${knockouts}, ${points})`;
}

/**
 * Агрегаты по всем игрокам с результатами. `since`/`until` (ISO) ограничивают период
 * по дате старта турнира; без них — за всё время.
 */
export async function playerAggregates(since?: string, until?: string): Promise<PlayerAggregate[]> {
  return db()<PlayerAggregate[]>`
    SELECT r.player_id,
           count(*)::int                                AS events,
           count(*) FILTER (WHERE r.place = 1)::int     AS wins,
           count(*) FILTER (WHERE r.place <= 9)::int    AS final_tables,
           sum(r.knockouts)::int                        AS knockouts,
           sum(r.points)::int                           AS points,
           min(r.place)                                 AS best_place
    FROM results r JOIN tournaments t ON t.id = r.tournament_id
    WHERE t.starts_at >= ${since ?? '-infinity'} AND t.starts_at < ${until ?? 'infinity'}
    GROUP BY r.player_id`;
}

export interface HistoryDbRow {
  tournament_id: number;
  title: string;
  starts_at: string;
  place: number;
  points: number;
  knockouts: number;
}

export async function playerHistory(playerId: number): Promise<HistoryDbRow[]> {
  return db()<HistoryDbRow[]>`
    SELECT t.id AS tournament_id, t.title, t.starts_at, r.place, r.points, r.knockouts
    FROM results r JOIN tournaments t ON t.id = r.tournament_id
    WHERE r.player_id = ${playerId} ORDER BY t.starts_at DESC, t.id DESC`;
}

// ───────────────────────────── Шаблоны структуры блайндов ─────────────────────────────

export interface BlindTemplateRow {
  id: number;
  name: string;
  /** jsonb: структура блайндов. */
  levels: BlindLevel[];
  starting_stack: number | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

function normalizeTemplate(row: BlindTemplateRow): BlindTemplateRow {
  row.levels = orderKeys(row.levels, BLIND_LEVEL_KEYS);
  return row;
}

/**
 * Сериализует изменения шаблонов до конца транзакции (проверки «имя занято», «не больше 50»
 * и смена базового шаблона идут строго по очереди). Вызывать только внутри `tx()`.
 */
export async function lockBlindTemplates(): Promise<void> {
  await db()`SELECT pg_advisory_xact_lock(hashtext('blind_templates'))`;
}

/** Все шаблоны: сначала базовый, затем по имени. */
export async function listBlindTemplates(): Promise<BlindTemplateRow[]> {
  const rows = await db()<BlindTemplateRow[]>`
    SELECT * FROM blind_templates ORDER BY is_default DESC, lower(name), id`;
  return rows.map(normalizeTemplate);
}

export async function findBlindTemplate(id: number): Promise<BlindTemplateRow | undefined> {
  const [row] = await db()<BlindTemplateRow[]>`SELECT * FROM blind_templates WHERE id = ${id}`;
  return row && normalizeTemplate(row);
}

export async function findBlindTemplateByName(name: string): Promise<BlindTemplateRow | undefined> {
  const [row] = await db()<BlindTemplateRow[]>`SELECT * FROM blind_templates WHERE lower(name) = lower(${name})`;
  return row && normalizeTemplate(row);
}

export async function countBlindTemplates(): Promise<number> {
  const [row] = await db()<{ n: number }[]>`SELECT count(*) AS n FROM blind_templates`;
  return row?.n ?? 0;
}

export interface BlindTemplateFields {
  name: string;
  levels: BlindLevel[];
  starting_stack: number | null;
  is_default: boolean;
}

export async function insertBlindTemplate(f: BlindTemplateFields): Promise<number> {
  const [row] = await db()<{ id: number }[]>`
    INSERT INTO blind_templates (name, levels, starting_stack, is_default)
    VALUES (${f.name}, ${jsonb(f.levels)}, ${f.starting_stack}, ${f.is_default})
    RETURNING id`;
  return row!.id;
}

export async function updateBlindTemplate(id: number, f: BlindTemplateFields): Promise<void> {
  await db()`
    UPDATE blind_templates SET name = ${f.name}, levels = ${jsonb(f.levels)}, starting_stack = ${f.starting_stack},
      is_default = ${f.is_default}, updated_at = now()
    WHERE id = ${id}`;
}

/** Снимает отметку «базовый» со всех шаблонов, кроме `exceptId`. */
export async function clearDefaultBlindTemplate(exceptId: number | null): Promise<void> {
  await db()`
    UPDATE blind_templates SET is_default = false, updated_at = now()
    WHERE is_default AND id IS DISTINCT FROM ${exceptId}`;
}

export async function deleteBlindTemplate(id: number): Promise<boolean> {
  const rows = await db()`DELETE FROM blind_templates WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}
