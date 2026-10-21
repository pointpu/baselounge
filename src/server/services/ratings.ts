/**
 * Рейтинг клуба: ачивки, лидерборды (месяц / всё время), статистика игрока,
 * а также сборка PlayerBrief — карточки игрока, которая встречается во всех DTO.
 */
import type { Achievement, Leaderboard, LeaderboardPeriod, LeaderboardRow, PlayerBrief, PlayerStats } from '../../shared/types.ts';
import { config } from '../config.ts';
import { notFound } from '../http.ts';
import { findPlayerById, findPlayersByIds, type PlayerAggregate, type PlayerRow, playerAggregates, playerHistory } from '../repo.ts';
import { currentSeason } from '../time.ts';

// ───────────────────────────── Ачивки ─────────────────────────────

export interface AchievementStats {
  wins: number;
  finalTables: number;
  knockouts: number;
  events: number;
}

const ACHIEVEMENT_RULES: ReadonlyArray<Achievement & { earned: (s: AchievementStats) => boolean }> = [
  { code: 'first_win', icon: '🏆', title: 'Первая победа', earned: (s) => s.wins >= 1 },
  { code: 'finalist', icon: '🎯', title: 'Финалист', earned: (s) => s.finalTables >= 3 },
  { code: 'hunter', icon: '🔪', title: 'Охотник', earned: (s) => s.knockouts >= 10 },
  { code: 'regular', icon: '♣', title: 'Завсегдатай', earned: (s) => s.events >= 10 },
];

/** Ачивки считаются автоматически из результатов — админу ничего выдавать не нужно. */
export function achievements(stats: AchievementStats): Achievement[] {
  return ACHIEVEMENT_RULES.filter((r) => r.earned(stats)).map(({ code, icon, title }) => ({ code, icon, title }));
}

function aggregateToStats(a: PlayerAggregate | undefined): AchievementStats {
  return { wins: a?.wins ?? 0, finalTables: a?.final_tables ?? 0, knockouts: a?.knockouts ?? 0, events: a?.events ?? 0 };
}

// ───────────────────────────── Карточка игрока ─────────────────────────────

/** Отображаемое имя: никнейм → username → имя из Telegram. */
export function displayName(p: PlayerRow): string {
  return p.nickname ?? p.username ?? p.first_name;
}

/** Наш аватар (из таблицы avatars) → фото из Telegram. Старые имена файлов (до 002) не отдаём. */
const AVATAR_NAME_RE = /^\d+-\d+\.(?:jpg|png|webp)$/;

export function avatarUrl(p: PlayerRow): string | null {
  return p.avatar_file && AVATAR_NAME_RE.test(p.avatar_file) ? `/media/avatars/${p.avatar_file}` : p.tg_photo_url;
}

/**
 * Фабрика PlayerBrief с общим кэшем ачивок на один запрос:
 * агрегаты по всем игрокам считаются одним SQL-запросом.
 */
export async function briefBuilder(): Promise<(p: PlayerRow) => PlayerBrief> {
  const aggs = new Map((await playerAggregates()).map((a) => [a.player_id, a]));
  return (p) => ({
    id: p.id,
    name: displayName(p),
    avatarUrl: avatarUrl(p),
    achievements: achievements(aggregateToStats(aggs.get(p.id))),
  });
}

// ───────────────────────────── Лидерборд ─────────────────────────────

/** Ранжирование «1, 1, 3»: при равных очках и победах — одинаковое место. */
function rank(aggs: PlayerAggregate[]): Array<{ place: number; agg: PlayerAggregate }> {
  const sorted = [...aggs].sort((a, b) => b.points - a.points || b.wins - a.wins || a.events - b.events || a.player_id - b.player_id);
  let place = 0;
  return sorted.map((agg, i) => {
    const prev = sorted[i - 1];
    if (!prev || prev.points !== agg.points || prev.wins !== agg.wins) place = i + 1;
    return { place, agg };
  });
}

function aggregatesFor(period: LeaderboardPeriod): Promise<PlayerAggregate[]> {
  if (period === 'all') return playerAggregates();
  const season = currentSeason(config.clubTz);
  return playerAggregates(season.start, season.end);
}

export async function leaderboard(period: LeaderboardPeriod): Promise<Leaderboard> {
  const ranked = rank(await aggregatesFor(period));
  const [players, brief] = await Promise.all([
    findPlayersByIds(ranked.map((r) => r.agg.player_id)).then((ps) => new Map(ps.map((p) => [p.id, p]))),
    briefBuilder(),
  ]);
  const rows: LeaderboardRow[] = [];
  for (const { place, agg } of ranked) {
    const p = players.get(agg.player_id);
    if (p) rows.push({ place, player: brief(p), points: agg.points, events: agg.events, wins: agg.wins });
  }
  return { period, seasonLabel: currentSeason(config.clubTz).label, rows };
}

// ───────────────────────────── Статистика игрока ─────────────────────────────

export async function playerStats(playerId: number): Promise<PlayerStats> {
  const player = await findPlayerById(playerId);
  if (!player) throw notFound('Игрок не найден');

  const season = currentSeason(config.clubTz);
  const [allAggs, seasonAggs, history] = await Promise.all([
    playerAggregates(),
    playerAggregates(season.start, season.end),
    playerHistory(playerId),
  ]);
  const mine = rank(allAggs).find((r) => r.agg.player_id === playerId);
  const seasonAgg = seasonAggs.find((a) => a.player_id === playerId);
  const agg = mine?.agg;
  // Ачивки считаются из тех же агрегатов «за всё время», что и в briefBuilder().
  const brief: PlayerBrief = {
    id: player.id,
    name: displayName(player),
    avatarUrl: avatarUrl(player),
    achievements: achievements(aggregateToStats(agg)),
  };

  return {
    player: brief,
    placeAll: mine?.place ?? null,
    stats: {
      points: agg?.points ?? 0,
      seasonPoints: seasonAgg?.points ?? 0,
      events: agg?.events ?? 0,
      wins: agg?.wins ?? 0,
      finalTables: agg?.final_tables ?? 0,
      knockouts: agg?.knockouts ?? 0,
      bestPlace: agg?.best_place ?? null,
    },
    history: history.map((h) => ({
      tournamentId: h.tournament_id,
      title: h.title,
      startsAt: h.starts_at,
      place: h.place,
      points: h.points,
      knockouts: h.knockouts,
    })),
  };
}
