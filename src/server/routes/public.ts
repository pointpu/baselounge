/**
 * Публичное API Mini App (`/api/...`). Роуты тонкие: валидация → сервис → DTO.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Leaderboard, Me, PlayerStats, TournamentCard, TournamentDetail } from '../../shared/types.ts';
import { requireAuth } from '../auth.ts';
import { config } from '../config.ts';
import { type AppEnv, badRequest, HttpError, jsonBody, parseInput } from '../http.ts';
import { tournamentIcs } from '../services/calendar.ts';
import { AVATAR_MAX_BYTES, buildMe, saveAvatar, updateNickname } from '../services/players.ts';
import { leaderboard, playerStats } from '../services/ratings.ts';
import { buildDetail, cancelRegistration, getTournamentDetail, getVisibleTournament, listTournamentCards, registerPlayer } from '../services/tournaments.ts';

export const IdParam = z.object({ id: z.coerce.number().int().positive() });

const ScopeQuery = z.object({ scope: z.enum(['upcoming', 'past']).default('upcoming') });
const PeriodQuery = z.object({ period: z.enum(['season', 'all']).default('season') });

const NicknameBody = z.object({
  nickname: z
    .string()
    .trim()
    .max(32, 'Никнейм — не длиннее 32 символов')
    .refine((v) => v.length === 0 || v.length >= 2, 'Никнейм — минимум 2 символа')
    .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), 'Никнейм содержит недопустимые символы')
    .nullable(),
});

export const publicApi = new Hono<AppEnv>();

// .ics открывается браузером/календарём напрямую, поэтому без авторизации (черновики — 404).
publicApi.get('/tournaments/:id/calendar.ics', async (c) => {
  const { id } = parseInput(IdParam, c.req.param());
  const t = await getVisibleTournament(id, false);
  const ics = tournamentIcs(t, { url: `${config.webappUrl}/?route=${encodeURIComponent(`/t/${t.id}`)}`, location: `${config.clubName}, ${config.clubCity}` });
  return c.body(ics, 200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `attachment; filename="showdown-${t.id}.ics"`,
  });
});

publicApi.use('*', requireAuth);

// ── Профиль ──

publicApi.get('/me', (c) => c.json<Me>(buildMe(c.get('player'), c.get('isAdmin'))));

publicApi.patch('/me', async (c) => {
  const { nickname } = parseInput(NicknameBody, await jsonBody(c));
  const player = await updateNickname(c.get('player'), nickname);
  return c.json<Me>(buildMe(player, c.get('isAdmin')));
});

publicApi.post(
  '/me/avatar',
  bodyLimit({
    maxSize: AVATAR_MAX_BYTES + 64 * 1024, // запас на multipart-обвязку
    onError: () => {
      throw new HttpError(413, 'Фото больше 2 МБ — выберите файл поменьше');
    },
  }),
  async (c) => {
    const body = await c.req.parseBody().catch(() => {
      throw badRequest('Ожидалась форма multipart/form-data с полем file');
    });
    const file = body['file'];
    if (!(file instanceof File)) throw badRequest('Прикрепите фото в поле file');
    const player = await saveAvatar(c.get('player'), file);
    return c.json<Me>(buildMe(player, c.get('isAdmin')));
  },
);

publicApi.get('/me/stats', async (c) => c.json<PlayerStats>(await playerStats(c.get('player').id)));

// ── Турниры ──

publicApi.get('/tournaments', async (c) => {
  const { scope } = parseInput(ScopeQuery, c.req.query());
  return c.json<TournamentCard[]>(await listTournamentCards(scope, c.get('player'), c.get('isAdmin')));
});

publicApi.get('/tournaments/:id', async (c) => {
  const { id } = parseInput(IdParam, c.req.param());
  return c.json<TournamentDetail>(await getTournamentDetail(id, c.get('player'), c.get('isAdmin')));
});

publicApi.post('/tournaments/:id/registration', async (c) => {
  const { id } = parseInput(IdParam, c.req.param());
  const { tournament } = await registerPlayer(id, c.get('player'), { isAdmin: c.get('isAdmin') });
  return c.json<TournamentDetail>(await buildDetail(tournament, c.get('player')));
});

publicApi.delete('/tournaments/:id/registration', async (c) => {
  const { id } = parseInput(IdParam, c.req.param());
  const { tournament } = await cancelRegistration(id, c.get('player'), { isAdmin: c.get('isAdmin') });
  return c.json<TournamentDetail>(await buildDetail(tournament, c.get('player')));
});

// ── Рейтинг ──

publicApi.get('/leaderboard', async (c) => {
  const { period } = parseInput(PeriodQuery, c.req.query());
  return c.json<Leaderboard>(await leaderboard(period));
});

publicApi.get('/players/:id', async (c) => {
  const { id } = parseInput(IdParam, c.req.param());
  return c.json<PlayerStats>(await playerStats(id));
});
