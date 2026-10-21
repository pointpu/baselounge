-- 003: разновидность холдема у турнира. Форматы (Bounty, Re-entry, Turbo, Deepstack, Add-on)
-- в базе не храним — они выводятся из структуры функцией formatTags() в src/shared/rules.ts.
--   nlh — No-Limit Hold'em (по умолчанию: все существующие турниры — NLH),
--   plh — Pot-Limit Hold'em,
--   flh — Fixed-Limit Hold'em.

-- +goose Up
ALTER TABLE tournaments
  ADD COLUMN game text NOT NULL DEFAULT 'nlh' CHECK (game IN ('nlh', 'plh', 'flh'));

-- +goose Down
ALTER TABLE tournaments DROP COLUMN IF EXISTS game;
