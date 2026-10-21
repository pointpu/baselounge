-- 004: настраиваемые напоминания, анонсы турниров и настройки уведомлений игрока.
--
-- Напоминания: у турнира список сдвигов reminder_offsets (минуты до старта, по умолчанию
-- «за 1 день» и «за 2 ч»). Факт отправки — строка reminder_deliveries(registration_id, offset_min):
-- первичный ключ + INSERT … ON CONFLICT DO NOTHING гарантирует, что одно напоминание не уйдёт
-- дважды (перезапуски, несколько реплик). skipped = true — окно давно прошло (простой сервера,
-- запись незадолго до старта), напоминание учтено, но не отправлялось.
-- Флаги registrations.reminded_24h / reminded_2h переносятся в reminder_deliveries и удаляются.
--
-- Анонсы: tournaments.announced_at — когда разослан анонс (одна рассылка за всю жизнь турнира).
-- Игрок: notify_announcements / notify_reminders — подписки; bot_blocked_at — бот заблокирован
-- (Telegram 403), таким не пишем до следующего /start.

-- +goose Up
ALTER TABLE tournaments
  ADD COLUMN reminder_offsets integer[] NOT NULL DEFAULT '{1440,120}'
    CHECK (cardinality(reminder_offsets) <= 5 AND 0 < ALL (reminder_offsets) AND 10080 >= ALL (reminder_offsets)),
  ADD COLUMN announced_at timestamptz;

-- Уже открытые/прошедшие турниры анонсировать не нужно — считаем, что анонс был.
UPDATE tournaments SET announced_at = created_at WHERE status <> 'draft';

ALTER TABLE players
  ADD COLUMN notify_announcements boolean NOT NULL DEFAULT true,
  ADD COLUMN notify_reminders     boolean NOT NULL DEFAULT true,
  ADD COLUMN bot_blocked_at       timestamptz;

CREATE TABLE reminder_deliveries (
  registration_id integer     NOT NULL REFERENCES registrations (id) ON DELETE CASCADE,
  offset_min      integer     NOT NULL CHECK (offset_min > 0),
  skipped         boolean     NOT NULL DEFAULT false,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (registration_id, offset_min)
);

INSERT INTO reminder_deliveries (registration_id, offset_min)
  SELECT id, 1440 FROM registrations WHERE reminded_24h;
INSERT INTO reminder_deliveries (registration_id, offset_min)
  SELECT id, 120 FROM registrations WHERE reminded_2h;

ALTER TABLE registrations
  DROP COLUMN reminded_24h,
  DROP COLUMN reminded_2h;

-- +goose Down
ALTER TABLE registrations
  ADD COLUMN reminded_24h boolean NOT NULL DEFAULT false,
  ADD COLUMN reminded_2h  boolean NOT NULL DEFAULT false;

UPDATE registrations r SET
  reminded_24h = EXISTS (SELECT 1 FROM reminder_deliveries d WHERE d.registration_id = r.id AND d.offset_min >= 1440),
  reminded_2h  = EXISTS (SELECT 1 FROM reminder_deliveries d WHERE d.registration_id = r.id AND d.offset_min <= 120);

DROP TABLE IF EXISTS reminder_deliveries;

ALTER TABLE players
  DROP COLUMN IF EXISTS bot_blocked_at,
  DROP COLUMN IF EXISTS notify_reminders,
  DROP COLUMN IF EXISTS notify_announcements;

ALTER TABLE tournaments
  DROP COLUMN IF EXISTS announced_at,
  DROP COLUMN IF EXISTS reminder_offsets;
