-- 005: шаблоны структуры блайндов.
--
-- Админ сохраняет структуру (уровни + необязательный стартовый стек) под именем и применяет её
-- в форме турнира. Один шаблон может быть «базовым» — с него начинается форма нового турнира
-- (частичный уникальный индекс: базовый — не больше одного). Имена уникальны без учёта регистра.

-- +goose Up
CREATE TABLE blind_templates (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  levels         jsonb       NOT NULL CHECK (jsonb_typeof(levels) = 'array' AND jsonb_array_length(levels) > 0),
  starting_stack integer     CHECK (starting_stack > 0),
  is_default     boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX blind_templates_name_key ON blind_templates (lower(name));
CREATE UNIQUE INDEX blind_templates_default_key ON blind_templates (is_default) WHERE is_default;

-- +goose Down
DROP TABLE IF EXISTS blind_templates;
