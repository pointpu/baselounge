-- 001: исходная схема BASE LOUNGE (перенос со SQLite, включая table_size и dealer).
-- Все моменты времени — timestamptz (UTC), структуры турнира — jsonb-массивы.

-- +goose Up
CREATE TABLE players (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tg_id          bigint      NOT NULL UNIQUE CHECK (tg_id > 0),
  username       text,
  first_name     text        NOT NULL,
  nickname       text,
  tg_photo_url   text,
  avatar_file    text,
  phone          text,
  phone_verified boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tournaments (
  id                   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title                text        NOT NULL,
  subtitle             text        NOT NULL DEFAULT '',
  description          text        NOT NULL DEFAULT '',
  starts_at            timestamptz NOT NULL,
  late_reg_until       timestamptz,
  status               text        NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'registration', 'running', 'completed', 'cancelled')),
  capacity             integer     NOT NULL CHECK (capacity > 0),
  buy_in               integer     NOT NULL DEFAULT 0 CHECK (buy_in >= 0),
  starting_stack       integer     CHECK (starting_stack > 0),
  knockout_points      integer     NOT NULL DEFAULT 0 CHECK (knockout_points >= 0),
  table_size           integer     NOT NULL DEFAULT 9 CHECK (table_size BETWEEN 2 AND 10),
  dealer               text        NOT NULL DEFAULT '',
  reentries            jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(reentries) = 'array'),
  addons               jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(addons) = 'array'),
  blind_levels         jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(blind_levels) = 'array'),
  clock_started_at     timestamptz,
  clock_paused_at      timestamptz,
  clock_paused_total   integer     NOT NULL DEFAULT 0 CHECK (clock_paused_total >= 0),
  results_published_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tournaments_status_starts_at_idx ON tournaments (status, starts_at);

CREATE TABLE registrations (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tournament_id integer     NOT NULL REFERENCES tournaments (id) ON DELETE CASCADE,
  player_id     integer     NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  status        text        NOT NULL CHECK (status IN ('registered', 'waitlist', 'cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  table_no      integer     CHECK (table_no > 0),
  seat_no       integer     CHECK (seat_no > 0),
  reminded_24h  boolean     NOT NULL DEFAULT false,
  reminded_2h   boolean     NOT NULL DEFAULT false,
  UNIQUE (tournament_id, player_id)
);
-- Списки участников / листа ожидания (FIFO по updated_at) и счётчики по турниру.
CREATE INDEX registrations_tournament_status_updated_idx ON registrations (tournament_id, status, updated_at, id);
CREATE INDEX registrations_player_idx ON registrations (player_id);

CREATE TABLE results (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tournament_id integer NOT NULL REFERENCES tournaments (id) ON DELETE CASCADE,
  player_id     integer NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  place         integer NOT NULL CHECK (place > 0),
  knockouts     integer NOT NULL DEFAULT 0 CHECK (knockouts >= 0),
  points        integer NOT NULL,
  UNIQUE (tournament_id, player_id),
  UNIQUE (tournament_id, place)
);
CREATE INDEX results_player_idx ON results (player_id);

-- +goose Down
DROP TABLE IF EXISTS results;
DROP TABLE IF EXISTS registrations;
DROP TABLE IF EXISTS tournaments;
DROP TABLE IF EXISTS players;
