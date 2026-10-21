# SHOWDOWN Poker Club — архитектура и контракт (MVP)

Собственный продукт по мотивам разобранного бота River (см. `../SPEC.md`). **Не визуальная копия**:
своё название (**SHOWDOWN · poker club**), свой логотип (простая SVG-монограмма), своя палитра и тексты.

- Язык интерфейса, документации, комментариев и JSDoc — **русский**. Идентификаторы — английские.
- Цель — **MVP для проверки гипотезы**: без тестов и CI (Docker — только для PostgreSQL). Код чистый, типизированный, читаемый.
- **Один язык — TypeScript** везде: сервер, бот, Mini App. Общие типы API в `src/shared/types.ts`.

## Стек

| Слой | Выбор | Почему |
|---|---|---|
| Рантайм | **Node.js 26** | запускает `.ts` напрямую (type stripping) |
| HTTP | **Hono** 4 + `@hono/node-server` | лёгкий, TS-first |
| Валидация | **zod** 4 | схемы входных данных |
| Бот | **grammY** 1.x | TS-first, простой |
| БД | **PostgreSQL 17** (Docker) + драйвер **`postgres`** (postgres.js 3.4) | надёжность, бэкапы `pg_dump`, без нативных зависимостей |
| Mini App | **Vanilla TS + Vite** 8 | без фреймворка, сборка в `dist/webapp` |
| Типы | `typescript` ^5.9 (`tsc --noEmit`) | только проверка, не транспиляция |

Ограничение type stripping: только «стираемый» синтаксис — **никаких `enum`, `namespace`,
parameter properties**; относительные импорты с расширением `.ts`. В `tsconfig`: `strict`, `erasableSyntaxOnly`,
`allowImportingTsExtensions`, `verbatimModuleSyntax`, `noEmit`, `module`/`moduleResolution`: `nodenext`,
`lib` включает `DOM` (для webapp). Для типов — `import type`.

## «Инновационно, но без оверинжиниринга» — что лучше, чем у River

1. **Живые часы турнира** — админ запускает/ставит на паузу; все видят текущие блайнды,
   следующий уровень и обратный отсчёт (сервер считает состояние, клиент тикает локально).
2. **Лист ожидания** — при заполнении можно встать в очередь; при отмене первый в очереди
   автоматически получает место и сообщение от бота.
3. **Напоминания** — бот напоминает перед стартом (у каждого турнира свой набор: по умолчанию за 1 день и за 2 ч); кнопка «Добавить в календарь» (.ics).
   **Анонсы** — когда турнир открывает регистрацию, бот сообщает о нём подписанным игрокам (подписки — в профиле).
4. **Авторассадка** — одна кнопка у админа: сбалансированная случайная рассадка по столам,
   каждому игроку приходит «стол 2 · место 5».
5. **Автоматические ачивки** — считаются из результатов, без работы админа.
6. **Нативный Telegram UX** — тема Telegram (светлая/тёмная), BackButton, MainButton для
   главного действия, haptics, нативные confirm-диалоги, requestContact.
7. **Админка внутри Mini App** — у админов (Telegram ID из env) появляется вкладка; без отдельного сайта и паролей.
8. **Работает и в Telegram Web** — в отличие от River не запрещаем показ во фрейме Telegram.

## Структура репозитория

```
showdown/
  package.json            # "type": "module"; scripts ниже
  tsconfig.json
  vite.config.ts          # root: src/webapp, outDir: ../../dist/webapp, proxy /api и /media → :8000
  .env.example
  .gitignore
  README.md               # на русском: что это, BotFather, локальный запуск, туннель, деплой
  src/
    shared/
      types.ts            # DTO API (общие для сервера и webapp), литеральные union-типы статусов
    server/
      main.ts             # сборка Hono-приложения, статика, старт HTTP, бот, напоминания, graceful shutdown
      config.ts           # чтение и валидация env (zod), объект config
      db.ts               # DatabaseSync, PRAGMA (WAL, foreign_keys), схема (CREATE TABLE IF NOT EXISTS), helper tx()
      repo.ts             # SQL-запросы (prepared statements) → типизированные строки
      auth.ts             # проверка initData, middleware auth/admin
      http.ts             # HttpError, единый обработчик ошибок, security headers
      time.ts             # границы месяца в CLUB_TZ (через Intl), форматирование
      services/
        tournaments.ts    # регистрация/отмена/лист ожидания/повышение, сборка DTO
        seating.ts        # чистый алгоритм рассадки
        scoring.ts        # чистая формула очков
        clock.ts          # чистый расчёт состояния часов
        ratings.ts        # лидерборды, статистика игрока, ачивки
        calendar.ts       # генерация .ics
        notifier.ts       # интерфейс Notifier + NullNotifier
      routes/
        public.ts         # /api/me, /api/tournaments..., /api/leaderboard, /api/players/:id
        admin.ts          # /api/admin/...
      bot/
        bot.ts            # создание Bot, команды, menu button, start/stop (long polling)
        handlers.ts       # /start (+deep link), /help, contact, callback отмены
        notifier.ts       # TelegramNotifier implements Notifier
        reminders.ts      # цикл напоминаний 24ч/2ч
        texts.ts          # все тексты бота
      seed.ts             # демо-данные
    webapp/
      index.html
      logo.svg
      styles.css
      main.ts             # загрузка, роутер, таб-бар
      api.ts              # fetch-обёртка (заголовок авторизации, ApiError с русским сообщением)
      tg.ts               # тонкая обёртка над Telegram.WebApp + минимальные типы + фолбэки для браузера
      ui.ts               # h() — DOM-хелпер, toast, скелетоны, форматирование дат/денег/таймеров
      views/home.ts, tournaments.ts, tournament.ts, rating.ts, profile.ts, player.ts, admin.ts
  data/                   # (gitignored) showdown.db, media/avatars
```

`package.json` scripts:
- `dev:server` → `node --env-file-if-exists=.env --watch src/server/main.ts`
- `dev:web` → `vite` (порт 5173, прокси на 8000)
- `build` → `vite build`
- `start` → `node --env-file-if-exists=.env src/server/main.ts` (раздаёт `dist/webapp`)
- `seed` → `node --env-file-if-exists=.env src/server/seed.ts`
- `typecheck` → `tsc --noEmit`

Зависимости: `hono`, `@hono/node-server`, `grammy`, `zod`, `postgres`. Dev: `typescript`, `vite`, `@types/node`.
Больше ничего не добавлять без крайней необходимости.

## Конфигурация (env)

| переменная | по умолчанию | смысл |
|---|---|---|
| PORT | 8000 | |
| BOT_TOKEN | "" | пусто → бот выключен, API работает |
| WEBAPP_URL | http://localhost:8000 | публичный https-URL Mini App |
| ADMIN_IDS | "" | Telegram ID через запятую |
| DATABASE_URL | — (обязательно) | `postgres://baselounge:…@127.0.0.1:5432/baselounge` |
| DB_POOL_MAX | 10 | размер пула соединений |
| MEDIA_DIR | ./data/media | только для import-avatars.ts (старые файлы-аватары); сервер не использует |
| CLUB_NAME | SHOWDOWN | |
| CLUB_CITY | Москва | |
| CLUB_TZ | Europe/Moscow | |
| DEV_MODE | false | разрешает заголовок `X-Dev-User: <tg_id>` (только локально, громкое предупреждение в лог) |
| INIT_DATA_TTL | 86400 | сек |

## Авторизация

Заголовок `X-Telegram-Init-Data: <Telegram.WebApp.initData>`. Проверка по документации Telegram:
`secret = HMAC_SHA256(key="WebAppData", data=BOT_TOKEN)`, `hash' = hex(HMAC_SHA256(secret, data_check_string))`,
сравнение через `crypto.timingSafeEqual`; `data_check_string` — отсортированные `k=v` (кроме `hash`), через `\n`;
отклонять, если `auth_date` старше `INIT_DATA_TTL`. Из `user` — upsert игрока по `tg_id`
(обновлять username/first_name/photo_url; **никогда** не перетирать кастомный nickname).
DEV_MODE: `X-Dev-User: 123` → игрок tg_id=123 (first_name «Dev 123»).
`isAdmin = ADMIN_IDS.includes(tgId)`. 401 — нет/невалидно, 403 — не админ на `/api/admin`.
Ошибки — JSON `{ "error": "<человеческое сообщение на русском>" }`.

## Модель данных (PostgreSQL, snake_case в БД, camelCase в DTO)

Схема — `src/server/migrations/001_init.sql`. Миграции применяет `migrate.ts` при старте сервера:
файлы `NNN_name.sql` по порядку, в одной транзакции под `pg_advisory_xact_lock` (два процесса не
применят миграцию дважды), учёт — в `schema_migrations(name, applied_at)`. Изменение схемы — новый файл.

```
players(id integer identity PK, tg_id bigint UNIQUE NOT NULL, username text, first_name text NOT NULL,
        nickname text, tg_photo_url text, avatar_file text, phone text,
        phone_verified boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL)
  name = nickname ?? username ?? first_name
  avatars(player_id PK FK→players ON DELETE CASCADE, mime jpeg|png|webp, data bytea ≤ 2 МБ, version, updated_at)
  avatar_file = `<player_id>-<version>.<ext>` (version растёт при замене → новый URL)
  avatarUrl = avatar_file нового формата ? `/media/avatars/${avatar_file}` : tg_photo_url

tournaments(id integer identity PK, title text, subtitle text DEFAULT '', description text DEFAULT '',
        game text DEFAULT 'nlh' CHECK in (nlh,plh,flh)  -- миграция 003: No-Limit / Pot-Limit / Fixed-Limit Hold'em
        starts_at timestamptz, late_reg_until timestamptz NULL,
        status text CHECK in (draft,registration,running,completed,cancelled),
        capacity integer CHECK > 0, buy_in integer (₽, 0 = бесплатно), starting_stack integer NULL,
        knockout_points integer DEFAULT 0, table_size integer DEFAULT 9 CHECK 2..10, dealer text DEFAULT '',
        reentries jsonb ([{stack,price,note}]), addons jsonb, blind_levels jsonb ([{sb,bb,ante,minutes,isBreak}]),
        -- у jsonb-полей CHECK jsonb_typeof = 'array'
        clock_started_at timestamptz NULL, clock_paused_at timestamptz NULL, clock_paused_total integer DEFAULT 0 (сек),
        results_published_at timestamptz NULL, created_at timestamptz)
  INDEX (status, starts_at)

registrations(id identity PK, tournament_id FK → tournaments ON DELETE CASCADE, player_id FK → players ON DELETE CASCADE,
        status text in (registered,waitlist,cancelled), created_at timestamptz, updated_at timestamptz,
        table_no integer NULL, seat_no integer NULL,
        UNIQUE(tournament_id, player_id))
  INDEX (tournament_id, status, updated_at, id), INDEX (player_id)

-- migration 004 (004_notifications.sql):
tournaments + reminder_offsets integer[] DEFAULT '{1440,120}' (минуты до старта; ≤ 5 шт., 1..10080),
              announced_at timestamptz NULL (анонс разослан — один раз за жизнь турнира)
players     + notify_announcements boolean DEFAULT true, notify_reminders boolean DEFAULT true,
              bot_blocked_at timestamptz NULL (Telegram 403 — не пишем до следующего /start)
reminder_deliveries(registration_id FK → registrations ON DELETE CASCADE, offset_min integer, skipped boolean,
        sent_at timestamptz, PRIMARY KEY(registration_id, offset_min))   -- флаги reminded_24h/2h перенесены сюда и удалены

results(id identity PK, tournament_id FK CASCADE, player_id FK CASCADE, place integer CHECK > 0,
        knockouts integer DEFAULT 0, points integer,
        UNIQUE(tournament_id, player_id), UNIQUE(tournament_id, place))
  INDEX (player_id)
```
Порядок в листе ожидания — по `(updated_at, id)` перехода в waitlist (FIFO).

Слой доступа (`db.ts`, `repo.ts`):
- Пул postgres.js; сессия в `TimeZone=UTC`. `timestamptz` возвращается ISO-строкой UTC
  (`2026-10-24T16:00:00.000Z`, как `nowIso()`), `bigint` — числом (Telegram ID < 2^53), `boolean` — boolean.
- jsonb-поля репозиторий отдаёт и принимает **готовыми массивами** (`Bullet[]`, `BlindLevel[]`) —
  сервисы не делают `JSON.parse`/`JSON.stringify`.
- Все запросы — tagged templates postgres.js (только параметры, никакой конкатенации значений).
- `tx(fn)` — транзакция (`sql.begin`); текущая транзакция хранится в `AsyncLocalStorage`, поэтому функции
  репозитория (через `db()`) внутри `tx()` автоматически работают в ней. Вложенный `tx()` — часть внешней.
- **Блокировки**: каждая транзакция-изменение турнира (запись, отмена, правка, статус, рассадка, часы,
  результаты) начинается с `SELECT … FROM tournaments WHERE id = $1 FOR UPDATE` (`repo.lockTournament`).
  Так запросы по одному турниру идут строго по очереди: вместимость не превышается, повышение из листа
  ожидания — FIFO.
- Игрок — `INSERT … ON CONFLICT (tg_id) DO UPDATE` (nickname не трогается).
- Напоминания «забираются» атомарно: `INSERT INTO reminder_deliveries … ON CONFLICT DO NOTHING RETURNING …`
  (`repo.claimDueReminders`) — одно напоминание не уйдёт дважды даже при двух процессах и перезапусках.
- Анонс «забирается» так же: `UPDATE tournaments SET announced_at = now() WHERE id = $1 AND announced_at IS NULL … RETURNING`.
- Перенос со старой SQLite-базы — `npm run import:sqlite` (`import-sqlite.ts`): одна транзакция, id сохраняются
  (`OVERRIDING SYSTEM VALUE`), затем identity-последовательности сдвигаются; непустые таблицы — только с `--force`.

Бизнес-правила:
- Время (сервер — источник правды, те же функции из `shared/rules.ts` проверяет форма админки; 409 — конфликт
  состояния/времени, 400 — некорректный ввод; тексты — по-русски, время — в CLUB_TZ):
  - Регистрация открыта, если (`status = registration` и `now < starts_at`) или (`status ∈ {registration, running}`
    и `late_reg_until` задан и `now < late_reg_until`) — `registrationOpen`. Так же считается `canRegister`, запись
    через API и deep link бота.
  - Лист ожидания повышается только пока запись открыта: после старта — лишь во время поздней регистрации,
    затем очередь «замораживается» (выйти из неё можно).
  - registration → running и запуск часов — не раньше чем за `EARLY_START_MIN` = 60 мин до старта
    («Рано: турнир начинается в 19:00 — запустить можно с 18:00»). Досрочный запуск = старт: без поздней
    регистрации запись закрывается, а отменить занятое место уже нельзя (`hasStarted`), даже если `starts_at` впереди.
  - Рассадка — есть участники, статус registration|running и не раньше чем за `EARLY_SEATING_MIN` = 180 мин до старта.
  - Результаты — статус running (или completed — исправление) и `now ≥ starts_at`. Места уникальны 1..n, каждый —
    зарегистрированный участник; вносить можно не всех (не пришедшие — без места), размер поля для очков и
    сообщения (`fieldSize`) — n.
  - Стартовый стек > BB первого игрового уровня (если оба заданы), стеки ре-энтри/add-on > 0 (`stackError`, 400).
  - Capacity нельзя опустить ниже числа записанных (`capacityError`, 409).
  - Напоминания: каждое > 0 и ≤ 7 дней, без повторов, не больше 5 (`reminderOffsetsError`, 400); «прошедшие»
    сдвиги не отклоняются — они просто не отправляются.
- register: уже registered/waitlist → идемпотентно. Если registered < capacity → registered, иначе waitlist.
  Повторная регистрация после отмены переиспользует строку.
- cancel: до завершения; если отменяет `registered` и есть очередь → повысить первого, событие `waitlistPromoted`. Место за столом сбрасывается.
- Каждое изменение — в одной транзакции `tx()` с блокировкой строки турнира (`FOR UPDATE`); уведомления — после коммита.

## Чистые функции

- `pointsFor(place, fieldSize, knockouts, knockoutPoints)` = `round(100 * (fieldSize - place + 1) / fieldSize) + knockouts * knockoutPoints`, плюс **+25** за 1-е место. Финальный стол = place ≤ 9.
- `balancedSeating(playerIds, tableSize = 9, random = Math.random)` → `Map<playerId, {table, seat}>`:
  столов = ceil(n / tableSize); перемешать, раздать по кругу (размеры столов отличаются ≤ 1), места внутри стола перемешать.
- `clockState(levels, startedAt, pausedAt, pausedTotalSec, now)` → `ClockState | null`.
- `tournamentIcs(t, url)` → строка VCALENDAR/VEVENT (UID `showdown-t<id>`, длительность 4 ч, CRLF, экранирование).
- `src/shared/rules.ts` (общие для сервера и Mini App, без БД):
  - `formatTags(t)` → `FormatTag[]`: Bounty (`knockoutPoints > 0`), Re-entry (есть ре-энтри) иначе Freezeout,
    Turbo (первый игровой уровень ≤ 12 мин), Deepstack (стек / BB первого уровня ≥ 200), Add-on (есть аддоны).
    Форматы в базе не хранятся — сервер отдаёт их в `TournamentCard.formats`, бот пишет строкой «NLH · Bounty · Re-entry».
  - `isBbAnte(level)` — анте = BB («BB-анте» в таблице блайндов, часах и подсказках).
  - `gameHints(detail, clock, nowMs, { fmtTime, limit })` → 1–3 подсказки «Ход игры» `{ icon, text, tone }` по убыванию
    важности: пауза, лист ожидания, закрытие поздней регистрации, перерыв/add-on, удвоение блайндов, старт анте,
    последний уровень, свободные места; до старта — «До старта …», «Поздняя рег. до …». Тексты рассчитаны на одну строку.
  - `phaseTimeline(detail, clock, nowMs)` → лента фаз Регистрация → Игра → Рег. закрыта / Перерыв (Add-on) → Итоги
    (средние шаги — в хронологическом порядке, отсутствующие пропускаются).
- `achievements(stats)`: first_win 🏆 «Первая победа» (wins ≥ 1), finalist 🎯 «Финалист» (финальных столов ≥ 3),
  hunter 🔪 «Охотник» (нокаутов ≥ 10), regular ♣ «Завсегдатай» (турниров ≥ 10).

## REST API (префикс /api, JSON, camelCase) — типы в `src/shared/types.ts`

```ts
type TournamentStatus = 'draft' | 'registration' | 'running' | 'completed' | 'cancelled';
type MyStatus = 'registered' | 'waitlist' | null;
interface Achievement { code: string; icon: string; title: string }
interface PlayerBrief { id: number; name: string; avatarUrl: string | null; achievements: Achievement[] }
interface BlindLevel { sb: number; bb: number; ante: number; minutes: number; isBreak: boolean }
interface Bullet { stack: number; price: number; note: string }
interface ClockState { levelIndex: number; level: BlindLevel; nextLevel: BlindLevel | null;
  remainingSec: number; elapsedSec: number; paused: boolean; finished: boolean; totalLevels: number }
type GameType = 'nlh' | 'plh' | 'flh';
type FormatTag = 'bounty' | 'reentry' | 'freezeout' | 'turbo' | 'deepstack' | 'addon';
interface TournamentCard { id; title; subtitle; game: GameType; formats: FormatTag[]; startsAt: string; lateRegUntil: string | null; status;
  capacity; registeredCount; waitlistCount; freeSeats; buyIn; startingStack: number | null;
  myStatus: MyStatus; myWaitlistPosition: number | null; mySeat: { table: number; seat: number } | null;
  canRegister: boolean }
interface ResultRow { place: number; player: PlayerBrief; knockouts: number; points: number }
interface TournamentDetail extends TournamentCard { description; knockoutPoints; reentries: Bullet[]; addons: Bullet[];
  blindLevels: BlindLevel[]; clock: ClockState | null; participants: PlayerBrief[]; waitlist: PlayerBrief[];
  results: ResultRow[] | null; reminderOffsets: number[]; announcedAt: string | null /* только админам */ }
interface Me { player: { id; tgId; name; nickname: string | null; avatarUrl; phoneVerified: boolean };
  isAdmin: boolean; club: { name; city; tz }; notify: { announcements: boolean; reminders: boolean } }
interface LeaderboardRow { place; player: PlayerBrief; points; events; wins }
interface Leaderboard { period: 'season' | 'all'; seasonLabel: string; rows: LeaderboardRow[] }
interface PlayerStats { player: PlayerBrief; placeAll: number | null;
  stats: { points; seasonPoints; events; wins; finalTables; knockouts; bestPlace: number | null };
  history: { tournamentId; title; startsAt; place; points; knockouts }[] }
interface TournamentInput { title; subtitle?; description?; startsAt; lateRegUntil?: string | null; capacity; buyIn;
  startingStack?: number | null; knockoutPoints?; reentries?; addons?; blindLevels?; reminderOffsets?: number[];
  status?: 'draft' | 'registration'; announce?: boolean /* по умолчанию true */ }
interface AdminRegistration { player: PlayerBrief; status; createdAt; table: number | null; seat: number | null;
  phone: string | null; phoneVerified: boolean; username: string | null }
interface ApiError { error: string }
```

Публичные (с авторизацией):
- `GET  /api/me` → `Me`
- `PATCH /api/me` `{ nickname?, notifyAnnouncements?, notifyReminders? }` (nickname: trim, 2..32, без управляющих
  символов; меняются только переданные поля) → `Me`
- `POST /api/me/avatar` multipart `file` (jpeg/png/webp по сигнатуре байт, ≤ 2 МБ, upsert в таблицу avatars, version + 1) → `Me`
- `GET  /api/tournaments?scope=upcoming|past` → `TournamentCard[]` (upcoming: registration/running по возрастанию даты, админам ещё draft; past: completed/cancelled по убыванию)
- `GET  /api/tournaments/:id` → `TournamentDetail` (draft → 404 для не-админа)
- `POST /api/tournaments/:id/registration` → `TournamentDetail`
- `DELETE /api/tournaments/:id/registration` → `TournamentDetail`
- `GET  /api/tournaments/:id/calendar.ics` → `text/calendar` (**без** авторизации, draft → 404)
- `GET  /api/leaderboard?period=season|all` → `Leaderboard` (сезон = текущий месяц в CLUB_TZ; в списке — игроки с ≥ 1 результатом; поиск на клиенте)
- `GET  /api/players/:id` → `PlayerStats`;  `GET /api/me/stats` → `PlayerStats` для себя

Админские (`/api/admin`, только админы):
- `GET    /api/admin/tournaments` → `TournamentCard[]` (все статусы)
- `POST   /api/admin/tournaments` `TournamentInput` → `TournamentDetail`
- `PATCH  /api/admin/tournaments/:id` `Partial<TournamentInput>` → `TournamentDetail`
- `POST   /api/admin/tournaments/:id/status` `{ status, announce? }`: draft→registration (+ анонс, если announce ≠ false), registration→running, registration|running→cancelled (уведомить), running→completed только через результаты
- `GET    /api/admin/tournaments/:id/registrations` → `AdminRegistration[]`
- `POST   /api/admin/tournaments/:id/seating` `{ tableSize: 6..10 }` → `TournamentDetail` + уведомления
- `POST   /api/admin/tournaments/:id/clock` `{ action: 'start'|'pause'|'resume'|'reset' }` → `TournamentDetail`
- `PUT    /api/admin/tournaments/:id/results` `{ entries: { playerId, place, knockouts }[] }` — места уникальны 1..n,
  игроки зарегистрированы; очки считаются; status=completed; results_published_at=now; уведомления → `TournamentDetail`

Статика: `/` → `dist/webapp` (SPA, index.html), `/media/avatars/<id>-<version>.<ext>` из таблицы avatars (Cache-Control immutable на год, ETag, 304; иначе 404). `GET /healthz` → `{ ok: true }`.
Security headers: CSP `default-src 'self'; script-src 'self' https://telegram.org; img-src 'self' data: https:;
style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.

## Notifier (`services/notifier.ts`)

```ts
interface Notifier {
  registered(tgId: number, t: TournamentRow, waitlistPosition: number | null): Promise<void>;
  waitlistPromoted(tgId: number, t: TournamentRow): Promise<void>;
  seatAssigned(tgId: number, t: TournamentRow, table: number, seat: number): Promise<void>;
  resultsPublished(tgId: number, t: TournamentRow, place: number, points: number, fieldSize: number): Promise<void>;
  tournamentCancelled(tgId: number, t: TournamentRow): Promise<void>;
  reminder(tgId: number, t: TournamentRow, minutesBefore: number): Promise<'sent' | 'blocked' | 'failed'>;
  announce(tgId: number, t: TournamentRow): Promise<'sent' | 'blocked' | 'failed'>;
}
```
TelegramNotifier на 403 («bot was blocked by the user», «user is deactivated», «can't initiate conversation»)
и на `my_chat_member` → `kicked` вызывает `repo.markBotBlocked`; `/start`, другие обращения к боту и
`my_chat_member` → `member` снимают отметку (`repo.clearBotBlocked`). Все сообщения бота идут через один
лимит процесса (≤ 25/с); на 429 лимит ставится на паузу на `retry_after` (≤ 60 с), сообщение повторяется до 2 раз. Подписки (`notify_*`) отключают только
анонсы и напоминания — рассадка, итоги и отмена турнира приходят всегда.

**Анонсы** (`services/announcements.ts`): турнир становится `registration` (создание сразу с регистрацией,
draft → registration через статус или PATCH) и старт впереди → в той же транзакции `claimAnnouncement`, после
коммита — фоновая рассылка: получатели `notify_announcements AND bot_blocked_at IS NULL`, последовательно,
(частоту держит общий лимит TelegramNotifier), очередь в процессе (после перезапуска недосланное не продолжается), ошибки не прерывают;
в лог — `[announce] t=ID sent=N blocked=M failed=K`. Флаг `announce: false` в теле — без рассылки.
Без бота (`NullNotifier`) анонс не «забирается»: `announced_at` остаётся пустым, в лог — предупреждение.
Кнопка анонса «✍️ Записаться» — deep link `t.me/<bot>?start=t_<id>` (запись в один тап), рядом — «Открыть турнир».
`NullNotifier` — когда нет BOT_TOKEN. Уведомления отправляются **после** коммита, fire-and-forget
(`void notify().catch(log)`); TelegramNotifier логирует и глотает ошибки (бот заблокирован и т.п.).
Регистрация через Mini App тоже шлёт сообщение «Вы записаны…» (как у River).

## Бот (grammY, long polling)

- `/start` → приветствие + inline-кнопка WebApp «Открыть клуб» (WEBAPP_URL); upsert игрока.
- `/start t_<id>` (deep link) → запись через services, ответ с карточкой турнира +
  кнопки [Открыть турнир (WebApp `WEBAPP_URL#/t/<id>`)] [Отменить запись (callback `cancel:<id>`)].
- callback `cancel:<id>` → кнопки подтверждения «Да, отменить» (`cancel:<id>:y`) / «Нет, остаюсь» (`cancel:<id>:n`);
  `:y` → отмена через services, редактирование сообщения.
- `/notify` → настройки с кнопками `notify:<key>:<0|1>` (целевое значение в callback); `/notify off|on` — только анонсы.
- `message:contact` → только если `contact.user_id === from.id`: сохранить телефон, phone_verified=1,
  ответ «Телефон подтверждён ✓» с `remove_keyboard`.
- `/help`. При старте: `setMyCommands`, `setChatMenuButton({ menu_button: { type: 'web_app', text: 'Клуб', web_app: { url } } })`.
- Напоминания (`bot/reminders.ts`): раз в 60 с — для записей `registered` на турниры `registration`
  (запущенному досрочно турниру напоминания «через 25 минут» уже не шлются)
  (игрок с `notify_reminders` и без `bot_blocked_at`) и каждого сдвига из `reminder_offsets`, у которого
  `now ≥ starts_at − offset` и `now < starts_at`, вставляется строка reminder_deliveries и вызывается
  `notifier.reminder(tgId, t, offset)`. Окно открылось больше 30 мин назад (простой) — отмечается `skipped` без
  отправки; из нескольких созревших сразу уходит только самое позднее. Запись незадолго до старта сразу
  отмечает уже открытые окна. Перенос старта удаляет отметки турнира — напоминания придут к новому времени.

## UX Mini App

- Hash-роутер: `#/`, `#/tournaments`, `#/t/:id`, `#/rating`, `#/me`, `#/p/:id`, `#/rules`, `#/admin`, `#/admin/t/:id`, `#/admin/new`.
- Таб-бар: Афиша · Турниры · Рейтинг · Профиль (+ Админ, если isAdmin). На детальных экранах — Telegram BackButton.
- MainButton = главное действие на экране турнира (Записаться / Встать в лист ожидания / Отменить запись — с `showConfirm`).
  В обычном браузере — кнопка на странице.
- Тема: CSS-переменные `--tg-theme-*` с фолбэками; акцент «сукно» #1E9E6A и «фишка» #E8B04B; системный шрифт;
  сетка 8 pt; карточки с тонкой рамкой; тач-цели ≥ 44 px; `prefers-reduced-motion`.
- Афиша: приветствие; hero «ближайший турнир» с живым отсчётом («через 2 ч 14 мин») или LIVE-карточка часов
  (крупные блайнды, таймер, следующий уровень, одна главная подсказка «Ход игры»), «Мои записи», мини-пьедестал топ-3 месяца.
  В карточках турниров — строка «NLH · Bounty · Re-entry» (одна строка, лишнее — многоточием).
- Турнир: шапка, чипы (дата, бай-ин/FREE, места), теги игры и формата, лента фаз, баннер «Ваше место», живые часы,
  «Ход игры» (1–3 подсказки, обновляются каждую секунду), структура (игра, анте/BB-анте), таблица блайндов (сворачиваемая),
  ре-энтри/add-on, участники с аватарами (+ очередь), результаты, «Добавить в календарь» (.ics), ссылка на правила.
- Правила (`#/rules`): ход раздачи, комбинации с мини-картами, позиции, термины турнира, NLH/PLH/FLH, очки рейтинга;
  сворачиваемые разделы. Ссылки — с афиши, профиля и экрана турнира.
- Рейтинг: сегмент Месяц/Всё время, пьедестал топ-3, поиск, строки → профиль игрока.
- Профиль: аватар (тап — сменить), никнейм (bottom sheet), подтверждение телефона (`requestContact`), плитки статистики, ачивки, история.
  Раздел «Уведомления»: переключатели (role=switch) «Анонсы турниров» и «Напоминания» — оптимистично, с откатом при ошибке;
  подпись: рассадка, итоги и отмена приходят всегда.
- Админ: список со статусами + «Новый турнир»; форма (все поля, включая игру No-Limit / Pot-Limit / Fixed-Limit; редактор уровней
  блайндов с пресетами «Турбо / Стандарт / BB-анте» — последний ставит анте = BB с выбранного уровня текущей структуры);
  действия: открыть регистрацию, старт, отмена, рассадка, часы, ввод результатов (список зарегистрированных: место + нокауты).
  В форме — «Напоминания»: чипы-пресеты (за 1 день / 3 ч / 2 ч / 1 ч / 30 мин / 15 мин, множественный выбор, одна строка с
  прокруткой) + «Своё…» (минуты или часы); галочка «Отправить анонс игрокам» при открытии регистрации (и у черновика).
  Время действий проверяется теми же правилами до запроса (toast с причиной), под кнопками — «доступно с …»; статус анонса.
- Состояния: скелетоны, понятные пустые состояния, ошибки, toast, haptics.
- Разработка в браузере: без initData — параметр `?dev_user=<id>` (сохранять в sessionStorage) → заголовок `X-Dev-User`.
- **Никакого innerHTML с данными** — DOM строится через `h()` / `textContent`.
- На экране турнира со статусом running — опрос каждые 15 с; часы тикают на клиенте каждую секунду.

## Планка качества (MVP)

- Без тестов/CI/Docker (решение пользователя). `npm run typecheck` должен проходить без ошибок.
- Строгий TS, без `any` (кроме границы с Telegram SDK), маленькие функции, логика в services, роуты тонкие.
- `npm run seed` создаёт ~12 демо-игроков, 3 предстоящих турнира (один running с часами) и 1 завершённый с результатами.
