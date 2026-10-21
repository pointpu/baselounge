/**
 * Турниры: запись, отмена, лист ожидания с автоповышением, админские операции
 * (создание/правка, статусы, рассадка, часы, результаты) и сборка DTO.
 *
 * Правило: каждое изменение — в одной транзакции `tx()`, которая начинается с блокировки строки
 * турнира (`repo.lockTournament`, `SELECT … FOR UPDATE`): конкурентные запросы по одному турниру
 * выполняются по очереди, поэтому вместимость не превышается, а лист ожидания идёт по FIFO.
 * Уведомления — только после коммита.
 */
import type {
  AdminRegistration,
  ClockAction,
  MyStatus,
  ResultEntryInput,
  ResultRow,
  TournamentCard,
  TournamentDetail,
  TournamentInput,
  TournamentStatus,
} from '../../shared/types.ts';
import { tx } from '../db.ts';
import { badRequest, conflict, notFound } from '../http.ts';
import * as repo from '../repo.ts';
import type { PlayerRow, RegistrationRow, TournamentFields, TournamentRow } from '../repo.ts';
import { config } from '../config.ts';
import { clubTimeFormat, nowIso, toIso } from '../time.ts';
import {
  DEFAULT_REMINDER_OFFSETS,
  START_GRACE_MIN,
  capacityError,
  earlySeatingError,
  earlyStartError,
  levelsError,
  registrationClosedReason,
  registrationOpen,
  reminderOffsetsError,
  resultsTimeError,
  sameLevels,
  sameMinute,
  scheduleError,
  sortOffsets,
  stackError,
} from '../../shared/rules.ts';
import type { TimingInput } from '../../shared/rules.ts';
import { scheduleAnnouncement } from './announcements.ts';
import { rowFormats } from './formats.ts';
import { clockState } from './clock.ts';
import { notificationsEnabled, notifyLater } from './notifier.ts';
import { briefBuilder } from './ratings.ts';
import { pointsFor } from './scoring.ts';
import { balancedSeating } from './seating.ts';

// ───────────────────────────── Вспомогательное ─────────────────────────────

function timing(t: TournamentRow): TimingInput {
  return { status: t.status, startsAt: t.starts_at, lateRegUntil: t.late_reg_until };
}

/**
 * Открыта ли запись (правило — `registrationOpen` в shared/rules.ts): статус registration и старт
 * не наступил, либо (registration | running) и не закончилась поздняя регистрация.
 */
export function isRegistrationOpen(t: TournamentRow, now: string = nowIso()): boolean {
  return registrationOpen(timing(t), Date.parse(now));
}

/** Форматирование времени в поясе клуба для текстов ошибок. */
const fmt = () => clubTimeFormat(config.clubTz);

/** Турнир начался: часы/статус «идёт» или уже наступило время старта. */
export function hasStarted(t: TournamentRow, now: string = nowIso()): boolean {
  return t.status === 'running' || now >= t.starts_at;
}

/**
 * Можно ли отменить свою запись: занявшему место — только до старта;
 * из листа ожидания выйти можно в любой момент до завершения (места за столом у него нет).
 */
export function canCancelRegistration(t: TournamentRow, status: MyStatus, now: string = nowIso()): boolean {
  if (status === null || t.status === 'completed' || t.status === 'cancelled') return false;
  return status === 'waitlist' || !hasStarted(t, now);
}

function assertVisible(t: TournamentRow | undefined, isAdmin: boolean): TournamentRow {
  if (!t || (t.status === 'draft' && !isAdmin)) throw notFound('Турнир не найден');
  return t;
}

/** Турнир, видимый пользователю (черновики — только админам, остальным 404). */
export async function getVisibleTournament(id: number, isAdmin: boolean): Promise<TournamentRow> {
  return assertVisible(await repo.findTournament(id), isAdmin);
}

async function requireTournament(id: number): Promise<TournamentRow> {
  const t = await repo.findTournament(id);
  if (!t) throw notFound('Турнир не найден');
  return t;
}

/** Блокирует строку турнира до конца транзакции (или 404). Первый запрос любой транзакции-изменения. */
async function lockTournament(id: number): Promise<TournamentRow> {
  const t = await repo.lockTournament(id);
  if (!t) throw notFound('Турнир не найден');
  return t;
}

/**
 * Переводит людей из листа ожидания в участники, пока есть свободные места (FIFO).
 * Только пока запись открыта: после старта — лишь во время поздней регистрации, после её
 * закрытия очередь «замораживается» (место за столом уже не получить).
 * Вызывать внутри транзакции после `lockTournament()`. Возвращает Telegram ID повышенных.
 */
async function promoteFromWaitlist(t: TournamentRow): Promise<number[]> {
  if (!isRegistrationOpen(t)) return [];
  const free = t.capacity - (await repo.countRegistered(t.id));
  const promoted = await repo.promoteWaitlist(t.id, free);
  // Повышенному придёт «вы в игре» — уже открывшиеся окна напоминаний ему не нужны.
  await repo.skipStartedReminders(promoted.map((r) => r.id), nowIso());
  return promoted.map((r) => r.tg_id);
}

function notifyPromoted(t: TournamentRow, promotedTgIds: readonly number[]): void {
  for (const tgId of promotedTgIds) notifyLater((n) => n.waitlistPromoted(tgId, t));
}

// ───────────────────────────── DTO ─────────────────────────────

interface ViewerContext {
  /** Активные регистрации зрителя по id турнира. */
  regs: Map<number, RegistrationRow>;
  /** Позиции зрителя в листах ожидания по id турнира. */
  waitlistPositions: Map<number, number>;
  counts: Map<number, repo.RegistrationCounts>;
  now: string;
}

async function viewerContext(viewer: PlayerRow): Promise<ViewerContext> {
  const [regs, counts] = await Promise.all([repo.listActiveRegistrationsOfPlayer(viewer.id), repo.registrationCounts()]);
  const waitlistPositions = new Map<number, number>();
  for (const r of regs) {
    const pos = await repo.waitlistPosition(r);
    if (pos !== null) waitlistPositions.set(r.tournament_id, pos);
  }
  return {
    regs: new Map(regs.map((r) => [r.tournament_id, r])),
    waitlistPositions,
    counts,
    now: nowIso(),
  };
}

function toCard(t: TournamentRow, ctx: ViewerContext): TournamentCard {
  const counts = ctx.counts.get(t.id);
  const registeredCount = counts?.registered ?? 0;
  const reg = ctx.regs.get(t.id);
  const myStatus: MyStatus = reg && reg.status !== 'cancelled' ? reg.status : null;
  return {
    id: t.id,
    title: t.title,
    subtitle: t.subtitle,
    game: t.game,
    formats: rowFormats(t),
    startsAt: t.starts_at,
    lateRegUntil: t.late_reg_until,
    status: t.status,
    capacity: t.capacity,
    registeredCount,
    waitlistCount: counts?.waitlist ?? 0,
    freeSeats: Math.max(0, t.capacity - registeredCount),
    buyIn: t.buy_in,
    startingStack: t.starting_stack,
    myStatus,
    myWaitlistPosition: ctx.waitlistPositions.get(t.id) ?? null,
    mySeat: reg?.status === 'registered' && reg.table_no !== null && reg.seat_no !== null ? { table: reg.table_no, seat: reg.seat_no } : null,
    canRegister: myStatus === null && isRegistrationOpen(t, ctx.now),
    canCancel: canCancelRegistration(t, myStatus, ctx.now),
  };
}

async function playersOf(regs: readonly RegistrationRow[]): Promise<PlayerRow[]> {
  const byId = new Map((await repo.findPlayersByIds(regs.map((r) => r.player_id))).map((p) => [p.id, p]));
  return regs.map((r) => byId.get(r.player_id)).filter((p): p is PlayerRow => p !== undefined);
}

/** Полный DTO турнира. `isAdmin` — показывать ли служебные поля (announcedAt). */
export async function buildDetail(t: TournamentRow, viewer: PlayerRow, isAdmin = false): Promise<TournamentDetail> {
  const [brief, ctx, registered, waitlisted] = await Promise.all([
    briefBuilder(),
    viewerContext(viewer),
    repo.listRegistrations(t.id, 'registered').then(playersOf),
    repo.listRegistrations(t.id, 'waitlist').then(playersOf),
  ]);
  let results: ResultRow[] | null = null;
  if (t.results_published_at) {
    const rows = await repo.listResults(t.id);
    const byId = new Map((await repo.findPlayersByIds(rows.map((r) => r.player_id))).map((p) => [p.id, p]));
    results = rows.flatMap((r) => {
      const p = byId.get(r.player_id);
      return p ? [{ place: r.place, player: brief(p), knockouts: r.knockouts, points: r.points }] : [];
    });
  }
  return {
    ...toCard(t, ctx),
    description: t.description,
    knockoutPoints: t.knockout_points,
    tableSize: t.table_size,
    dealer: t.dealer,
    reentries: t.reentries,
    addons: t.addons,
    blindLevels: t.blind_levels,
    clock: clockState(t.blind_levels, t.clock_started_at, t.clock_paused_at, t.clock_paused_total),
    participants: registered.map(brief),
    waitlist: waitlisted.map(brief),
    results,
    reminderOffsets: sortOffsets(t.reminder_offsets),
    announcedAt: isAdmin ? t.announced_at : null,
  };
}

export async function getTournamentDetail(id: number, viewer: PlayerRow, isAdmin: boolean): Promise<TournamentDetail> {
  return buildDetail(await getVisibleTournament(id, isAdmin), viewer, isAdmin);
}

const UPCOMING: readonly TournamentStatus[] = ['registration', 'running'];
const PAST: readonly TournamentStatus[] = ['completed', 'cancelled'];

/** Афиша: upcoming — по возрастанию даты (админам ещё черновики), past — по убыванию. */
export async function listTournamentCards(scope: 'upcoming' | 'past', viewer: PlayerRow, isAdmin: boolean): Promise<TournamentCard[]> {
  const [rows, ctx] = await Promise.all([
    scope === 'past'
      ? repo.listTournamentsByStatus(PAST, 'desc')
      : repo.listTournamentsByStatus(isAdmin ? [...UPCOMING, 'draft'] : UPCOMING, 'asc'),
    viewerContext(viewer),
  ]);
  return rows.map((t) => toCard(t, ctx));
}

export async function listAllTournamentCards(viewer: PlayerRow): Promise<TournamentCard[]> {
  const [rows, ctx] = await Promise.all([repo.listAllTournaments(), viewerContext(viewer)]);
  return rows.map((t) => toCard(t, ctx));
}

// ───────────────────────────── Запись и отмена ─────────────────────────────

export interface RegisterOutcome {
  tournament: TournamentRow;
  status: 'registered' | 'waitlist';
  waitlistPosition: number | null;
  /** true — игрок уже был записан, ничего не изменилось. */
  unchanged: boolean;
}

/**
 * Запись на турнир (идемпотентно). Есть места — участник, нет — лист ожидания.
 * `notify: false` — не слать «Вы записаны» (бот отвечает сам).
 */
export async function registerPlayer(
  tournamentId: number,
  player: PlayerRow,
  opts: { isAdmin: boolean; notify?: boolean },
): Promise<RegisterOutcome> {
  const outcome = await tx(async (): Promise<RegisterOutcome> => {
    const t = assertVisible(await repo.lockTournament(tournamentId), opts.isAdmin);
    const existing = await repo.findRegistration(t.id, player.id);
    if (existing && existing.status !== 'cancelled') {
      return { tournament: t, status: existing.status, waitlistPosition: await repo.waitlistPosition(existing), unchanged: true };
    }
    const now = nowIso();
    const closed = registrationClosedReason(timing(t), Date.parse(now));
    if (closed) throw conflict(closed);
    const status = (await repo.countRegistered(t.id)) < t.capacity ? 'registered' : 'waitlist';
    const regId = await repo.upsertRegistration(t.id, player.id, status);
    // Окна напоминаний, которые уже открылись, не нужны: игрок только что получил «Вы записаны».
    await repo.skipStartedReminders([regId], now);
    const reg = (await repo.findRegistration(t.id, player.id))!;
    return { tournament: t, status, waitlistPosition: await repo.waitlistPosition(reg), unchanged: false };
  });

  if (!outcome.unchanged && opts.notify !== false) {
    notifyLater((n) => n.registered(player.tg_id, outcome.tournament, outcome.waitlistPosition));
  }
  return outcome;
}

export interface CancelOutcome {
  tournament: TournamentRow;
  /** Была ли активная запись, которую отменили. */
  cancelled: boolean;
}

/** Отмена записи (идемпотентно). Освободившееся место получает первый из листа ожидания. */
export async function cancelRegistration(tournamentId: number, player: PlayerRow, opts: { isAdmin: boolean }): Promise<CancelOutcome> {
  let promoted: number[] = [];
  const outcome = await tx(async (): Promise<CancelOutcome> => {
    const t = assertVisible(await repo.lockTournament(tournamentId), opts.isAdmin);
    const reg = await repo.findRegistration(t.id, player.id);
    if (!reg || reg.status === 'cancelled') return { tournament: t, cancelled: false };
    if (t.status === 'completed' || t.status === 'cancelled') throw conflict('Турнир уже завершён — отменить запись нельзя');
    if (reg.status === 'registered' && hasStarted(t)) throw conflict('Турнир уже начался — отменить запись нельзя');
    await repo.setRegistrationStatus(reg.id, 'cancelled');
    if (reg.status === 'registered') promoted = await promoteFromWaitlist(t);
    return { tournament: t, cancelled: true };
  });
  notifyPromoted(outcome.tournament, promoted);
  return outcome;
}

// ───────────────────────────── Админ: создание и правка ─────────────────────────────

interface FieldChecks {
  /** Проверять время и структуру (false — они не менялись, старые данные не блокируют правку). */
  validate: boolean;
  /** Старт не должен быть в прошлом (новый турнир, перенос даты, открытие регистрации). */
  requireFuture: boolean;
  /** Проверять стеки (стартовый > BB первого уровня, ре-энтри/add-on > 0) — если они или структура менялись. */
  validateStacks: boolean;
}

/** Проверяет логику времени и структуры (общие правила из shared/rules.ts) и собирает поля для БД. */
function toFields(input: TournamentInput, status: TournamentStatus, checks: FieldChecks): TournamentFields {
  const startsAt = toIso(input.startsAt);
  const lateRegUntil = input.lateRegUntil ? toIso(input.lateRegUntil) : null;
  const levels = input.blindLevels ?? [];
  const reentries = input.reentries ?? [];
  const addons = input.addons ?? [];
  const startingStack = input.startingStack ?? null;
  const offsets = input.reminderOffsets ?? [...DEFAULT_REMINDER_OFFSETS];
  if (checks.validate) {
    const problem =
      levelsError(levels) ??
      scheduleError({ startsAt, lateRegUntil, levels, now: Date.now(), requireFuture: checks.requireFuture });
    if (problem) throw badRequest(problem);
  }
  if (checks.validateStacks) {
    const problem = stackError({ startingStack, levels, reentries, addons });
    if (problem) throw badRequest(problem);
  }
  const offsetsProblem = reminderOffsetsError(offsets);
  if (offsetsProblem) throw badRequest(offsetsProblem);
  return {
    title: input.title.trim(),
    subtitle: input.subtitle?.trim() ?? '',
    description: input.description?.trim() ?? '',
    game: input.game ?? 'nlh',
    starts_at: startsAt,
    late_reg_until: lateRegUntil,
    status,
    capacity: input.capacity,
    buy_in: input.buyIn,
    starting_stack: startingStack,
    knockout_points: input.knockoutPoints ?? 0,
    // Стол не больше вместимости турнира: на 6 мест — один стол на 6.
    table_size: Math.max(2, Math.min(input.tableSize ?? 9, input.capacity)),
    dealer: input.dealer?.trim() ?? '',
    reentries,
    addons,
    blind_levels: levels,
    reminder_offsets: sortOffsets(offsets),
  };
}

function rowToInput(t: TournamentRow): TournamentInput {
  return {
    title: t.title,
    subtitle: t.subtitle,
    description: t.description,
    game: t.game,
    startsAt: t.starts_at,
    lateRegUntil: t.late_reg_until,
    capacity: t.capacity,
    buyIn: t.buy_in,
    startingStack: t.starting_stack,
    knockoutPoints: t.knockout_points,
    tableSize: t.table_size,
    dealer: t.dealer,
    reentries: t.reentries,
    addons: t.addons,
    blindLevels: t.blind_levels,
    reminderOffsets: t.reminder_offsets,
  };
}

/**
 * Анонс при открытии регистрации: вызывать внутри транзакции, уже поставившей статус registration.
 * Возвращает турнир, если анонс «забран» этой транзакцией (разослать после коммита), иначе null.
 */
async function claimAnnouncementIf(id: number, announce: boolean | undefined): Promise<TournamentRow | null> {
  if (announce === false) return null;
  if (!notificationsEnabled()) {
    // Бот выключен: не ставим announced_at, иначе турнир навсегда числился бы «анонсированным».
    console.warn(`[announce] t=${id}: бот выключен (нет BOT_TOKEN) — анонс не рассылается`);
    return null;
  }
  return (await repo.claimAnnouncement(id)) ?? null;
}

function sendAnnouncement(t: TournamentRow | null): void {
  if (t) void scheduleAnnouncement(t).catch((err: unknown) => console.error('[announce]', err));
}

export async function createTournament(input: TournamentInput): Promise<TournamentRow> {
  let announce: TournamentRow | null = null;
  const t = await tx(async () => {
    const status = input.status ?? 'draft';
    const id = await repo.insertTournament(toFields(input, status, { validate: true, requireFuture: true, validateStacks: true }));
    if (status === 'registration') announce = await claimAnnouncementIf(id, input.announce);
    return requireTournament(id);
  });
  sendAnnouncement(announce);
  return t;
}

/**
 * Частичная правка. Capacity нельзя опустить ниже числа записанных (409); увеличение — повышает
 * очередь (пока запись открыта). Перенос старта сбрасывает отметки напоминаний турнира.
 * Смена статуса draft → registration рассылает анонс (если `patch.announce !== false`).
 */
export async function updateTournament(id: number, patch: Partial<TournamentInput>): Promise<TournamentRow> {
  let promoted: number[] = [];
  let announce: TournamentRow | null = null;
  const t = await tx(async () => {
    const current = await lockTournament(id);
    let status = current.status;
    if (patch.status && patch.status !== current.status) {
      assertTransition(current.status, patch.status);
      status = patch.status;
    }
    const { status: _ignored, announce: announceFlag, ...rest } = patch;
    const next = { ...rowToInput(current), ...rest };
    // Сравниваем с точностью до минуты: секунды в форме не вводятся и не должны считаться «переносом».
    const startMoved = !sameMinute(toIso(next.startsAt), current.starts_at);
    const lateMoved = !sameMinute(next.lateRegUntil ? toIso(next.lateRegUntil) : null, current.late_reg_until);
    const levelsChanged = !sameLevels(next.blindLevels ?? [], current.blind_levels);
    const stacksChanged =
      levelsChanged ||
      (next.startingStack ?? null) !== current.starting_stack ||
      JSON.stringify(next.reentries ?? []) !== JSON.stringify(current.reentries) ||
      JSON.stringify(next.addons ?? []) !== JSON.stringify(current.addons);
    const opening = current.status === 'draft' && status === 'registration';
    const notStarted = status === 'draft' || status === 'registration';

    if (next.capacity !== current.capacity) {
      const problem = capacityError(next.capacity, await repo.countRegistered(id));
      if (problem) throw conflict(problem);
    }

    if (startMoved && (status === 'completed' || status === 'cancelled')) {
      throw conflict('Турнир завершён — дату старта менять нельзя');
    }
    if (startMoved && status === 'running' && Date.parse(toIso(next.startsAt)) > Date.now() + START_GRACE_MIN * 60_000) {
      throw badRequest('Турнир уже идёт — время старта не может быть в будущем');
    }
    // Правила применяем, только если время или структура реально меняются (или открывают регистрацию):
    // так старые турниры, созданные до новых правил, можно править (например, описание).
    await repo.updateTournamentFields(
      id,
      toFields(next, status, {
        validate: startMoved || lateMoved || levelsChanged || opening,
        requireFuture: notStarted && (startMoved || opening),
        validateStacks: stacksChanged || opening,
      }),
    );
    if (startMoved) await repo.resetReminders(id);
    if (opening) announce = await claimAnnouncementIf(id, announceFlag);
    const updated = await requireTournament(id);
    if (updated.status === 'registration' || updated.status === 'running') promoted = await promoteFromWaitlist(updated);
    return updated;
  });
  notifyPromoted(t, promoted);
  sendAnnouncement(announce);
  return t;
}

// ───────────────────────────── Админ: статусы ─────────────────────────────

const TRANSITIONS: Record<TournamentStatus, readonly TournamentStatus[]> = {
  draft: ['registration'],
  registration: ['running', 'cancelled'],
  running: ['cancelled'],
  completed: [],
  cancelled: [],
};

function assertTransition(from: TournamentStatus, to: TournamentStatus): void {
  if (TRANSITIONS[from].includes(to)) return;
  if (to === 'completed') throw conflict('Завершить турнир можно только публикацией результатов');
  throw conflict(`Нельзя перевести турнир из «${STATUS_LABELS[from]}» в «${STATUS_LABELS[to]}»`);
}

const STATUS_LABELS: Record<TournamentStatus, string> = {
  draft: 'черновик',
  registration: 'регистрация',
  running: 'идёт',
  completed: 'завершён',
  cancelled: 'отменён',
};

/**
 * Смена статуса по правилам; при отмене уведомляем всех записавшихся и очередь.
 * registration → running — не раньше чем за EARLY_START_MIN до старта (409).
 * draft → registration — анонс игрокам, если `opts.announce !== false` (один раз за жизнь турнира).
 */
export async function changeStatus(id: number, to: TournamentStatus, opts: { announce?: boolean } = {}): Promise<TournamentRow> {
  let notifyTgIds: number[] = [];
  let announce: TournamentRow | null = null;
  const t = await tx(async () => {
    const current = await lockTournament(id);
    if (current.status === to) return current;
    assertTransition(current.status, to);
    if (current.status === 'draft' && to === 'registration') {
      const problem =
        levelsError(current.blind_levels) ??
        scheduleError({
          startsAt: current.starts_at,
          lateRegUntil: current.late_reg_until,
          levels: current.blind_levels,
          now: Date.now(),
          requireFuture: true,
        }) ??
        stackError({ startingStack: current.starting_stack, levels: current.blind_levels, reentries: current.reentries, addons: current.addons });
      if (problem) throw badRequest(`Нельзя открыть регистрацию: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`);
    }
    if (to === 'running') {
      const early = earlyStartError(current.starts_at, Date.now(), fmt());
      if (early) throw conflict(early);
    }
    await repo.setTournamentStatus(id, to);
    if (to === 'registration') announce = await claimAnnouncementIf(id, opts.announce);
    if (to === 'cancelled') {
      const regs = [...(await repo.listRegistrations(id, 'registered')), ...(await repo.listRegistrations(id, 'waitlist'))];
      notifyTgIds = (await playersOf(regs)).map((p) => p.tg_id);
    }
    return requireTournament(id);
  });
  for (const tgId of notifyTgIds) notifyLater((n) => n.tournamentCancelled(tgId, t));
  sendAnnouncement(announce);
  return t;
}

// ───────────────────────────── Админ: рассадка ─────────────────────────────

/**
 * Случайная сбалансированная рассадка всех участников; каждому — сообщение «стол · место».
 * Размер стола берётся из запроса (и запоминается в турнире) или из настроек турнира.
 */
export async function seatPlayers(id: number, tableSize?: number): Promise<TournamentRow> {
  const assignments: Array<{ tgId: number; table: number; seat: number }> = [];
  const t = await tx(async () => {
    const t = await lockTournament(id);
    if (t.status !== 'registration' && t.status !== 'running') throw conflict('Рассадка доступна только до завершения турнира');
    const regs = await repo.listRegistrations(id, 'registered');
    if (regs.length === 0) throw conflict('Некого рассаживать — нет участников');
    const early = earlySeatingError(t.starts_at, Date.now(), fmt());
    if (early) throw conflict(early);
    const size = Math.max(2, Math.min(tableSize ?? t.table_size, t.capacity));
    if (size !== t.table_size) await repo.setTableSize(id, size);
    const seating = balancedSeating(
      regs.map((r) => r.player_id),
      size,
    );
    const players = new Map((await playersOf(regs)).map((p) => [p.id, p]));
    // Строки регистраций блокируем в порядке id — так же, как claimDueReminders(),
    // иначе параллельная рассылка напоминаний могла бы взаимно заблокироваться с рассадкой.
    for (const reg of [...regs].sort((a, b) => a.id - b.id)) {
      const s = seating.get(reg.player_id);
      if (!s) continue;
      await repo.setSeat(reg.id, s.table, s.seat);
      const p = players.get(reg.player_id);
      if (p) assignments.push({ tgId: p.tg_id, table: s.table, seat: s.seat });
    }
    return requireTournament(id);
  });
  for (const a of assignments) notifyLater((n) => n.seatAssigned(a.tgId, t, a.table, a.seat));
  return t;
}

// ───────────────────────────── Админ: часы ─────────────────────────────

/**
 * Управление часами. `start` из статуса registration заодно переводит турнир в running.
 */
export async function controlClock(id: number, action: ClockAction): Promise<TournamentRow> {
  return tx(async () => {
    const t = await lockTournament(id);
    const now = nowIso();
    switch (action) {
      case 'start': {
        if (t.status !== 'registration' && t.status !== 'running') throw conflict('Часы можно запустить только у открытого или идущего турнира');
        if (t.clock_started_at) throw conflict('Часы уже запущены');
        if (t.blind_levels.length === 0) throw conflict('Сначала задайте структуру блайндов');
        const early = earlyStartError(t.starts_at, Date.parse(now), fmt());
        if (early) throw conflict(early);
        await repo.setClock(id, now, null, 0);
        if (t.status === 'registration') await repo.setTournamentStatus(id, 'running');
        break;
      }
      case 'pause': {
        if (!t.clock_started_at) throw conflict('Часы ещё не запущены');
        if (t.clock_paused_at) throw conflict('Часы уже на паузе');
        await repo.setClock(id, t.clock_started_at, now, t.clock_paused_total);
        break;
      }
      case 'resume': {
        if (!t.clock_started_at || !t.clock_paused_at) throw conflict('Часы не на паузе');
        const pausedSec = Math.max(0, Math.floor((Date.parse(now) - Date.parse(t.clock_paused_at)) / 1000));
        await repo.setClock(id, t.clock_started_at, null, t.clock_paused_total + pausedSec);
        break;
      }
      case 'reset': {
        await repo.setClock(id, null, null, 0);
        break;
      }
    }
    return requireTournament(id);
  });
}

// ───────────────────────────── Админ: результаты ─────────────────────────────

/**
 * Публикация (или исправление) результатов: турнир идёт (или уже завершён — исправление) и старт
 * наступил (409). Места уникальны и идут 1..n, все игроки — участники турнира (registered).
 * Можно внести не всех записанных: не пришедших оставляют без места, поэтому размер поля
 * (fieldSize для очков и сообщения) — число игроков в итогах, n.
 * Очки считаются по формуле; турнир становится completed.
 */
export async function publishResults(id: number, entries: ResultEntryInput[]): Promise<TournamentRow> {
  const n = entries.length;
  if (n === 0) throw badRequest('Добавьте хотя бы одного игрока в результаты');
  const places = new Set(entries.map((e) => e.place));
  if (places.size !== n || [...places].some((p) => p < 1 || p > n)) {
    throw badRequest(`Места должны быть уникальными и идти от 1 до ${n}`);
  }
  if (new Set(entries.map((e) => e.playerId)).size !== n) throw badRequest('Игрок указан в результатах дважды');

  const sent: Array<{ tgId: number; place: number; points: number }> = [];
  const t = await tx(async () => {
    const t = await lockTournament(id);
    const timeProblem = resultsTimeError(timing(t), Date.now(), fmt());
    if (timeProblem) throw conflict(timeProblem);
    const registered = new Set((await repo.listRegistrations(id, 'registered')).map((r) => r.player_id));
    const stranger = entries.find((e) => !registered.has(e.playerId));
    if (stranger) throw badRequest(`Игрок #${stranger.playerId} не зарегистрирован на турнир`);

    await repo.deleteResults(id);
    const players = new Map((await repo.findPlayersByIds(entries.map((e) => e.playerId))).map((p) => [p.id, p]));
    for (const e of entries) {
      const points = pointsFor(e.place, n, e.knockouts, t.knockout_points);
      await repo.insertResult(id, e.playerId, e.place, e.knockouts, points);
      const p = players.get(e.playerId);
      if (p) sent.push({ tgId: p.tg_id, place: e.place, points });
    }
    await repo.markResultsPublished(id, nowIso());
    return requireTournament(id);
  });
  for (const s of sent) notifyLater((notifier) => notifier.resultsPublished(s.tgId, t, s.place, s.points, n));
  return t;
}

// ───────────────────────────── Админ: список регистраций ─────────────────────────────

export async function adminRegistrations(id: number): Promise<AdminRegistration[]> {
  await requireTournament(id);
  const regs = await repo.listAllRegistrations(id);
  const [brief, players] = await Promise.all([briefBuilder(), playersOf(regs).then((ps) => new Map(ps.map((p) => [p.id, p])))]);
  return regs.flatMap((r) => {
    const p = players.get(r.player_id);
    if (!p) return [];
    return [
      {
        player: brief(p),
        status: r.status,
        createdAt: r.created_at,
        table: r.table_no,
        seat: r.seat_no,
        phone: p.phone,
        phoneVerified: p.phone_verified,
        username: p.username,
      },
    ];
  });
}

