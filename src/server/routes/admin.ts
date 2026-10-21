/**
 * Админское API (`/api/admin/...`): доступно только Telegram ID из ADMIN_IDS.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AdminRegistration, TournamentCard, TournamentDetail } from '../../shared/types.ts';
import { requireAdmin, requireAuth } from '../auth.ts';
import { type AppEnv, jsonBody, parseInput } from '../http.ts';
import {
  adminRegistrations,
  buildDetail,
  changeStatus,
  controlClock,
  createTournament,
  listAllTournamentCards,
  publishResults,
  seatPlayers,
  updateTournament,
} from '../services/tournaments.ts';
import { IdParam } from './public.ts';

const isoDate = z.iso.datetime({ offset: true, message: 'Ожидается дата в формате ISO 8601' });
const money = z.number().int().min(0).max(10_000_000);
const chips = z.number().int().positive().max(1_000_000_000);

const BulletSchema = z.object({
  stack: chips,
  price: money,
  note: z.string().trim().max(200).default(''),
});

const BlindLevelSchema = z.object({
  sb: z.number().int().min(0),
  bb: z.number().int().min(0),
  ante: z.number().int().min(0).default(0),
  minutes: z.number().int().min(1).max(240),
  isBreak: z.boolean().default(false),
});

const TournamentInputSchema = z.object({
  title: z.string().trim().min(2, 'Название — минимум 2 символа').max(80),
  subtitle: z.string().trim().max(120).optional(),
  description: z.string().trim().max(4000).optional(),
  startsAt: isoDate,
  lateRegUntil: isoDate.nullable().optional(),
  capacity: z.number().int().min(2, 'Минимум 2 места').max(1000),
  buyIn: money,
  startingStack: chips.nullable().optional(),
  knockoutPoints: z.number().int().min(0).max(1000).optional(),
  tableSize: z.number().int().min(2, 'За столом минимум 2 игрока').max(10, 'За столом максимум 10 игроков').optional(),
  dealer: z.string().trim().max(80, 'Дилер — не длиннее 80 символов').optional(),
  reentries: z.array(BulletSchema).max(10).optional(),
  addons: z.array(BulletSchema).max(10).optional(),
  blindLevels: z.array(BlindLevelSchema).max(100).optional(),
  status: z.enum(['draft', 'registration']).optional(),
});

const StatusBody = z.object({ status: z.enum(['draft', 'registration', 'running', 'completed', 'cancelled']) });
const SeatingBody = z.object({ tableSize: z.number().int().min(2).max(10).optional() });
const ClockBody = z.object({ action: z.enum(['start', 'pause', 'resume', 'reset']) });
const ResultsBody = z.object({
  entries: z
    .array(
      z.object({
        playerId: z.number().int().positive(),
        place: z.number().int().positive(),
        knockouts: z.number().int().min(0).max(1000).default(0),
      }),
    )
    .max(1000),
});

export const adminApi = new Hono<AppEnv>();

adminApi.use('*', requireAuth, requireAdmin);

adminApi.get('/tournaments', async (c) => c.json<TournamentCard[]>(await listAllTournamentCards(c.get('player'))));

adminApi.post('/tournaments', async (c) => {
  const input = parseInput(TournamentInputSchema, await jsonBody(c));
  const t = await createTournament(input);
  return c.json<TournamentDetail>(await buildDetail(t, c.get('player')), 201);
});

adminApi.patch('/tournaments/:id', async (c) => {
  const { id } = parseInput(IdParam, c.req.param());
  const patch = parseInput(TournamentInputSchema.partial(), await jsonBody(c));
  return c.json<TournamentDetail>(await buildDetail(await updateTournament(id, patch), c.get('player')));
});

adminApi.post('/tournaments/:id/status', async (c) => {
  const { id } = parseInput(IdParam, c.req.param());
  const { status } = parseInput(StatusBody, await jsonBody(c));
  return c.json<TournamentDetail>(await buildDetail(await changeStatus(id, status), c.get('player')));
});

adminApi.get('/tournaments/:id/registrations', async (c) => {
  const { id } = parseInput(IdParam, c.req.param());
  return c.json<AdminRegistration[]>(await adminRegistrations(id));
});

adminApi.post('/tournaments/:id/seating', async (c) => {
  const { id } = parseInput(IdParam, c.req.param());
  const { tableSize } = parseInput(SeatingBody, await jsonBody(c));
  return c.json<TournamentDetail>(await buildDetail(await seatPlayers(id, tableSize), c.get('player')));
});

adminApi.post('/tournaments/:id/clock', async (c) => {
  const { id } = parseInput(IdParam, c.req.param());
  const { action } = parseInput(ClockBody, await jsonBody(c));
  return c.json<TournamentDetail>(await buildDetail(await controlClock(id, action), c.get('player')));
});

adminApi.put('/tournaments/:id/results', async (c) => {
  const { id } = parseInput(IdParam, c.req.param());
  const { entries } = parseInput(ResultsBody, await jsonBody(c));
  return c.json<TournamentDetail>(await buildDetail(await publishResults(id, entries), c.get('player')));
});
