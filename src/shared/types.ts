/**
 * Общие типы API: используются и сервером, и Mini App.
 * Единственный источник правды для контракта (см. DESIGN.md).
 */

export type TournamentStatus = 'draft' | 'registration' | 'running' | 'completed' | 'cancelled';
export type RegistrationStatus = 'registered' | 'waitlist' | 'cancelled';
export type MyStatus = 'registered' | 'waitlist' | null;
export type LeaderboardPeriod = 'season' | 'all';
export type ClockAction = 'start' | 'pause' | 'resume' | 'reset';
/** Разновидность техасского холдема: No-Limit, Pot-Limit, Fixed-Limit. */
export type GameType = 'nlh' | 'plh' | 'flh';
/** Формат турнира — выводится из структуры (см. `formatTags` в rules.ts), в базе не хранится. */
export type FormatTag = 'bounty' | 'reentry' | 'freezeout' | 'turbo' | 'deepstack' | 'addon';

export interface Achievement {
  code: string;
  icon: string;
  title: string;
}

export interface PlayerBrief {
  id: number;
  name: string;
  avatarUrl: string | null;
  achievements: Achievement[];
}

export interface BlindLevel {
  sb: number;
  bb: number;
  ante: number;
  minutes: number;
  isBreak: boolean;
}

/** Ре-энтри или add-on: сколько фишек и за сколько ₽. */
export interface Bullet {
  stack: number;
  price: number;
  note: string;
}

export interface ClockState {
  levelIndex: number;
  level: BlindLevel;
  nextLevel: BlindLevel | null;
  remainingSec: number;
  elapsedSec: number;
  paused: boolean;
  finished: boolean;
  totalLevels: number;
}

export interface Seat {
  table: number;
  seat: number;
}

export interface TournamentCard {
  id: number;
  title: string;
  subtitle: string;
  /** Разновидность холдема. */
  game: GameType;
  /** Форматы турнира в порядке показа (Bounty, Re-entry/Freezeout, Turbo, Deepstack, Add-on). */
  formats: FormatTag[];
  startsAt: string;
  lateRegUntil: string | null;
  status: TournamentStatus;
  capacity: number;
  registeredCount: number;
  waitlistCount: number;
  freeSeats: number;
  buyIn: number;
  startingStack: number | null;
  myStatus: MyStatus;
  myWaitlistPosition: number | null;
  mySeat: Seat | null;
  canRegister: boolean;
  /** Можно ли отменить свою запись (после старта — нельзя; из листа ожидания — можно). */
  canCancel: boolean;
}

export interface ResultRow {
  place: number;
  player: PlayerBrief;
  knockouts: number;
  points: number;
}

export interface TournamentDetail extends TournamentCard {
  description: string;
  knockoutPoints: number;
  /** Игроков за столом при рассадке (2..10). */
  tableSize: number;
  /** Дилер турнира — свободный текст; пустая строка, если не указан. */
  dealer: string;
  reentries: Bullet[];
  addons: Bullet[];
  blindLevels: BlindLevel[];
  clock: ClockState | null;
  participants: PlayerBrief[];
  waitlist: PlayerBrief[];
  results: ResultRow[] | null;
}

export interface Me {
  player: {
    id: number;
    tgId: number;
    name: string;
    nickname: string | null;
    avatarUrl: string | null;
    phoneVerified: boolean;
  };
  isAdmin: boolean;
  club: { name: string; city: string; tz: string };
}

export interface LeaderboardRow {
  place: number;
  player: PlayerBrief;
  points: number;
  events: number;
  wins: number;
}

export interface Leaderboard {
  period: LeaderboardPeriod;
  seasonLabel: string;
  rows: LeaderboardRow[];
}

export interface HistoryRow {
  tournamentId: number;
  title: string;
  startsAt: string;
  place: number;
  points: number;
  knockouts: number;
}

export interface PlayerStats {
  player: PlayerBrief;
  placeAll: number | null;
  stats: {
    points: number;
    seasonPoints: number;
    events: number;
    wins: number;
    finalTables: number;
    knockouts: number;
    bestPlace: number | null;
  };
  history: HistoryRow[];
}

export interface TournamentInput {
  title: string;
  subtitle?: string;
  description?: string;
  /** По умолчанию — 'nlh'. */
  game?: GameType;
  startsAt: string;
  lateRegUntil?: string | null;
  capacity: number;
  buyIn: number;
  startingStack?: number | null;
  knockoutPoints?: number;
  tableSize?: number;
  dealer?: string;
  reentries?: Bullet[];
  addons?: Bullet[];
  blindLevels?: BlindLevel[];
  status?: 'draft' | 'registration';
}

export interface AdminRegistration {
  player: PlayerBrief;
  status: RegistrationStatus;
  createdAt: string;
  table: number | null;
  seat: number | null;
  phone: string | null;
  phoneVerified: boolean;
  username: string | null;
}

export interface ResultEntryInput {
  playerId: number;
  place: number;
  knockouts: number;
}

export interface ApiError {
  error: string;
}
