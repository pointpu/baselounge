/**
 * Демо-данные для локального запуска: `npm run seed`.
 *
 * Скрипт идемпотентен: удаляет ВСЕ турниры (с регистрациями и результатами) и демо-игроков,
 * затем создаёт всё заново относительно текущего момента. Реальных игроков (кроме демо)
 * не трогает. Не запускайте на боевой базе — турниры будут удалены.
 *
 * Что получится:
 *  - 12 демо-игроков с никнеймами + dev-пользователь tg_id=1 (для `?dev_user=1`);
 *  - турнир «идёт» — часы запущены ~25 минут назад, открыта поздняя регистрация, есть рассадка;
 *  - турнир завтра вечером (dev-пользователь записан) и почти заполненный турнир;
 *  - три завершённых турнира с результатами (очки — через сервис публикации результатов),
 *    чтобы рейтинг, история и ачивки были не пустыми.
 */
import type { BlindLevel, Bullet, ResultEntryInput, TournamentStatus } from '../shared/types.ts';
import { config } from './config.ts';
import { closeDb, db, tx } from './db.ts';
import { assertSchemaUpToDate } from './migrate.ts';
import * as repo from './repo.ts';
import type { PlayerRow } from './repo.ts';
import { publishResults, seatPlayers } from './services/tournaments.ts';
import { addMs, clubTimeInDays, MINUTE_MS, nowIso } from './time.ts';

/** Telegram ID демо-игроков: заведомо не пересекаются с реальными пользователями. */
const DEMO_TG_BASE = 900_000_000_000;
const DEV_TG_ID = 1;

const DEMO_PLAYERS: ReadonlyArray<{ firstName: string; username: string; nickname: string }> = [
  { firstName: 'Алексей', username: 'alex_allin', nickname: 'Олл-ин Лёха' },
  { firstName: 'Марина', username: 'marina_ace', nickname: 'Туз Пик' },
  { firstName: 'Дмитрий', username: 'dima_bluff', nickname: 'Блефмастер' },
  { firstName: 'Екатерина', username: 'katya_nuts', nickname: 'Натсы' },
  { firstName: 'Игорь', username: 'igor_shark', nickname: 'Акула' },
  { firstName: 'Ольга', username: 'olga_flush', nickname: 'Флеш-Рояль' },
  { firstName: 'Сергей', username: 'serg_check', nickname: 'Чек-Рейз' },
  { firstName: 'Анна', username: 'anna_kicker', nickname: 'Кикер' },
  { firstName: 'Павел', username: 'pasha_tilt', nickname: 'Без Тильта' },
  { firstName: 'Наталья', username: 'nata_set', nickname: 'Сет-майнер' },
  { firstName: 'Роман', username: 'roma_fish', nickname: 'Золотая Рыбка' },
  { firstName: 'Виктория', username: 'vika_button', nickname: 'Баттон' },
];

/** Стандартная структура: уровни по 20 минут, перерывы после 4-го и 8-го уровня. */
const STANDARD_LEVELS: BlindLevel[] = [
  { sb: 25, bb: 50, ante: 0, minutes: 20, isBreak: false },
  { sb: 50, bb: 100, ante: 0, minutes: 20, isBreak: false },
  { sb: 75, bb: 150, ante: 0, minutes: 20, isBreak: false },
  { sb: 100, bb: 200, ante: 200, minutes: 20, isBreak: false },
  { sb: 0, bb: 0, ante: 0, minutes: 10, isBreak: true },
  { sb: 150, bb: 300, ante: 300, minutes: 20, isBreak: false },
  { sb: 200, bb: 400, ante: 400, minutes: 20, isBreak: false },
  { sb: 300, bb: 600, ante: 600, minutes: 20, isBreak: false },
  { sb: 400, bb: 800, ante: 800, minutes: 20, isBreak: false },
  { sb: 0, bb: 0, ante: 0, minutes: 15, isBreak: true },
  { sb: 500, bb: 1000, ante: 1000, minutes: 20, isBreak: false },
  { sb: 700, bb: 1400, ante: 1400, minutes: 20, isBreak: false },
  { sb: 1000, bb: 2000, ante: 2000, minutes: 20, isBreak: false },
  { sb: 1500, bb: 3000, ante: 3000, minutes: 20, isBreak: false },
];

/** Турбо: уровни по 10 минут, один перерыв. */
const TURBO_LEVELS: BlindLevel[] = [
  { sb: 50, bb: 100, ante: 0, minutes: 10, isBreak: false },
  { sb: 100, bb: 200, ante: 0, minutes: 10, isBreak: false },
  { sb: 150, bb: 300, ante: 300, minutes: 10, isBreak: false },
  { sb: 200, bb: 400, ante: 400, minutes: 10, isBreak: false },
  { sb: 0, bb: 0, ante: 0, minutes: 10, isBreak: true },
  { sb: 300, bb: 600, ante: 600, minutes: 10, isBreak: false },
  { sb: 500, bb: 1000, ante: 1000, minutes: 10, isBreak: false },
  { sb: 800, bb: 1600, ante: 1600, minutes: 10, isBreak: false },
  { sb: 1200, bb: 2400, ante: 2400, minutes: 10, isBreak: false },
];

const REENTRY: Bullet[] = [{ stack: 20_000, price: 1500, note: 'до конца поздней регистрации' }];
const ADDON: Bullet[] = [{ stack: 25_000, price: 1000, note: 'в первом перерыве' }];

interface DemoTournament {
  title: string;
  subtitle: string;
  description: string;
  startsAt: string;
  lateRegUntil: string | null;
  status: TournamentStatus;
  capacity: number;
  buyIn: number;
  startingStack: number;
  knockoutPoints: number;
  tableSize?: number;
  reentries: Bullet[];
  addons: Bullet[];
  levels: BlindLevel[];
}

async function createDemoTournament(d: DemoTournament): Promise<repo.TournamentRow> {
  const id = await repo.insertTournament({
    title: d.title,
    subtitle: d.subtitle,
    description: d.description,
    starts_at: d.startsAt,
    late_reg_until: d.lateRegUntil,
    status: d.status,
    capacity: d.capacity,
    buy_in: d.buyIn,
    starting_stack: d.startingStack,
    knockout_points: d.knockoutPoints,
    table_size: d.tableSize ?? 9,
    dealer: '',
    reentries: d.reentries,
    addons: d.addons,
    blind_levels: d.levels,
  });
  return (await repo.findTournament(id))!;
}

/** Записывает игроков (в порядке массива) как участников; напоминания помечены отправленными. */
async function registerAll(t: repo.TournamentRow, players: readonly PlayerRow[]): Promise<void> {
  for (const p of players) await repo.upsertRegistration(t.id, p.id, 'registered', { h24: true, h2: true });
}

/** Удаляет все турниры (каскадом — регистрации и результаты) и демо-игроков. */
async function wipe(): Promise<void> {
  const q = db();
  await q`DELETE FROM tournaments`;
  await q`DELETE FROM players WHERE tg_id >= ${DEMO_TG_BASE}`;
}

async function createPlayers(): Promise<PlayerRow[]> {
  const rows: PlayerRow[] = [];
  for (const [i, p] of DEMO_PLAYERS.entries()) {
    const row = await repo.upsertPlayerFromTelegram({
      tgId: DEMO_TG_BASE + i + 1,
      firstName: p.firstName,
      username: p.username,
      photoUrl: null,
    });
    await repo.setNickname(row.id, p.nickname);
    rows.push(row);
  }
  return rows;
}

/**
 * Завершённый турнир: записываем участников, публикуем результаты через сервис
 * (очки считает формула из scoring.ts). `order` — игроки по занятым местам.
 */
async function completedTournament(
  d: Omit<DemoTournament, 'status' | 'lateRegUntil'>,
  order: readonly PlayerRow[],
  knockouts: Readonly<Record<number, number>>,
): Promise<void> {
  const t = await createDemoTournament({ ...d, status: 'running', lateRegUntil: null });
  await registerAll(t, order);
  const entries: ResultEntryInput[] = order.map((p, i) => ({ playerId: p.id, place: i + 1, knockouts: knockouts[i] ?? 0 }));
  await publishResults(t.id, entries);
  // Публикация ставит results_published_at = сейчас; для истории правдоподобнее — вечер турнира.
  await db()`UPDATE tournaments SET results_published_at = ${addMs(d.startsAt, 5 * 60 * MINUTE_MS)} WHERE id = ${t.id}`;
}

async function seed(): Promise<void> {
  const tz = config.clubTz;
  await wipe();
  const dev = await repo.ensurePlayer(DEV_TG_ID, `Dev ${DEV_TG_ID}`);
  const players = await createPlayers();
  const [alex, marina, dima, katya, igor, olga, sergey, anna, pavel, nata, roma, vika] = players as [
    PlayerRow, PlayerRow, PlayerRow, PlayerRow, PlayerRow, PlayerRow,
    PlayerRow, PlayerRow, PlayerRow, PlayerRow, PlayerRow, PlayerRow,
  ];

  // ── Завершённые турниры (два в текущем месяце, один — в прошлом, для разницы «Месяц / Всё время»).
  await completedTournament(
    {
      title: 'Осенний Main Event',
      subtitle: 'Главный турнир месяца',
      description: 'Глубокие стеки, уровни по 20 минут, ре-энтри и add-on.',
      startsAt: clubTimeInDays(-35, 19, 0, tz),
      capacity: 30,
      buyIn: 3000,
      startingStack: 30_000,
      knockoutPoints: 5,
      reentries: REENTRY,
      addons: ADDON,
      levels: STANDARD_LEVELS,
    },
    [igor, marina, alex, katya, dima, olga, sergey, anna, pavel, nata, roma],
    { 0: 4, 1: 3, 2: 2, 3: 1 },
  );
  await completedTournament(
    {
      title: 'Турбо-вечер',
      subtitle: 'Быстрые блайнды',
      description: 'Уровни по 10 минут — успеть до полуночи.',
      startsAt: clubTimeInDays(-11, 19, 30, tz),
      capacity: 20,
      buyIn: 1500,
      startingStack: 15_000,
      knockoutPoints: 10,
      reentries: [],
      addons: [],
      levels: TURBO_LEVELS,
    },
    [marina, igor, dev, katya, alex, vika, dima, olga, sergey, roma],
    { 0: 3, 1: 4, 2: 1, 4: 1 },
  );
  await completedTournament(
    {
      title: 'Клубный фриролл',
      subtitle: 'Бесплатный вход',
      description: 'Без бай-ина — играем за рейтинговые очки.',
      startsAt: clubTimeInDays(-4, 16, 0, tz),
      capacity: 24,
      buyIn: 0,
      startingStack: 10_000,
      knockoutPoints: 5,
      reentries: [],
      addons: [],
      levels: STANDARD_LEVELS,
    },
    [igor, katya, marina, alex, nata, dima, anna, pavel, olga, vika, sergey, roma],
    { 0: 4, 1: 2, 2: 2, 3: 1, 4: 1 },
  );

  // ── Идёт прямо сейчас: часы запущены ~25 минут назад, поздняя регистрация ещё открыта.
  const startedAt = addMs(nowIso(), -25 * MINUTE_MS);
  const live = await createDemoTournament({
    title: 'Вечерний Deepstack',
    subtitle: 'LIVE · поздняя регистрация открыта',
    description: 'Турнир уже идёт — можно успеть на позднюю регистрацию.',
    startsAt: startedAt,
    lateRegUntil: addMs(startedAt, 100 * MINUTE_MS),
    status: 'running',
    capacity: 18,
    buyIn: 2000,
    startingStack: 25_000,
    knockoutPoints: 5,
    tableSize: 6,
    reentries: REENTRY,
    addons: ADDON,
    levels: STANDARD_LEVELS,
  });
  await registerAll(live, [alex, marina, dima, katya, igor, olga, sergey, anna, pavel, nata]);
  await repo.setClock(live.id, startedAt, null, 0);
  await seatPlayers(live.id);

  // ── Завтра вечером: открыта регистрация, dev-пользователь записан.
  const tomorrow = clubTimeInDays(1, 19, 0, tz);
  const next = await createDemoTournament({
    title: 'Bounty-вечер',
    subtitle: 'Нокауты приносят очки',
    description: 'За каждый выбитый соперник — +10 рейтинговых очков. Ре-энтри до конца 6-го уровня.',
    startsAt: tomorrow,
    lateRegUntil: addMs(tomorrow, 2 * 60 * MINUTE_MS),
    status: 'registration',
    capacity: 27,
    buyIn: 2500,
    startingStack: 25_000,
    knockoutPoints: 10,
    reentries: REENTRY,
    addons: ADDON,
    levels: STANDARD_LEVELS,
  });
  await registerAll(next, [dev, marina, igor, olga, roma, vika]);

  // ── Почти заполнен: осталось одно место (вторая запись уйдёт в лист ожидания).
  const weekend = clubTimeInDays(3, 15, 0, tz);
  const almostFull = await createDemoTournament({
    title: 'Хайроллер клуба',
    subtitle: 'Один стол · 10 мест',
    description: 'Камерный турнир на один стол. Если мест нет — встаньте в лист ожидания.',
    startsAt: weekend,
    lateRegUntil: null,
    status: 'registration',
    capacity: 10,
    buyIn: 10_000,
    startingStack: 50_000,
    knockoutPoints: 0,
    reentries: [],
    addons: [],
    levels: STANDARD_LEVELS,
  });
  await registerAll(almostFull, [igor, marina, alex, katya, dima, olga, sergey, nata, pavel]);

  console.log(
    `[seed] готово: ${players.length} демо-игроков + dev (tg_id=${DEV_TG_ID}); турниры: 3 завершённых, ` +
      `«${live.title}» (идёт, #${live.id}), «${next.title}» (#${next.id}), «${almostFull.title}» (#${almostFull.id})`,
  );
}

/** Адрес БД без пароля — для лога. */
function safeDbUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '(некорректный DATABASE_URL)';
  }
}

console.log(`[seed] база: ${safeDbUrl(config.databaseUrl)}`);
try {
  await assertSchemaUpToDate();
  await tx(seed);
} catch (err) {
  console.error('[seed] ошибка:', err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
