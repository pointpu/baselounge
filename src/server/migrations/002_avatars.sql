-- 002: аватары хранятся в PostgreSQL (в кластере нет постоянных томов, файлов на диске не держим).
-- players.avatar_file теперь — «имя» текущей версии аватара: `<player_id>-<version>.<ext>`.
-- Оно попадает в avatarUrl (/media/avatars/<имя>) и меняется при каждой замене фото — сброс кэша.
-- Старые имена (32 hex-символа, файлы из MEDIA_DIR) переносит src/server/import-avatars.ts.

CREATE TABLE avatars (
  player_id  integer     PRIMARY KEY REFERENCES players (id) ON DELETE CASCADE,
  mime       text        NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  data       bytea       NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 2097152),
  version    integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
