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
3. **Напоминания** — бот напоминает за 24 ч и за 2 ч; кнопка «Добавить в календарь» (.ics).
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
        reminded_24h boolean DEFAULT false, reminded_2h boolean DEFAULT false, UNIQUE(tournament_id, player_id))
  INDEX (tournament_id, status, updated_at, id), INDEX (player_id)

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
- Напоминания «забираются» атомарно: `UPDATE registrations SET reminded_… = true WHERE … AND NOT reminded_… RETURNING …`
  — одно напоминание не уйдёт дважды даже при двух процессах.
- Перенос со старой SQLite-базы — `npm run import:sqlite` (`import-sqlite.ts`): одна транзакция, id сохраняются
  (`OVERRIDING SYSTEM VALUE`), затем identity-последовательности сдвигаются; непустые таблицы — только с `--force`.

Бизнес-правила:
- Регистрация открыта, если `status = registration`, или `running` и `now < late_reg_until`.
- register: уже registered/waitlist → идемпотентно. Если registered < capacity → registered, иначе waitlist.
  Повторная регистрация после отмены переиспользует строку.
- cancel: до завершения; если отменяет `registered` и есть очередь → повысить первого, событие `waitlistPromoted`. Место за столом сбрасывается.
- Уменьшение capacity никого не выкидывает.
- Каждое изменение — в одной транзакции `tx()` с блокировкой строки турнира (`FOR UPDATE`); уведомления — после коммита.

## Чистые функции

- `pointsFor(place, fieldSize, knockouts, knockoutPoints)` = `round(100 * (fieldSize - place + 1) / fieldSize) + knockouts * knockoutPoints`, плюс **+25** за 1-е место. Финальный стол = place ≤ 9.
- `balancedSeating(playerIds, tableSize = 9, random = Math.random)` → `Map<playerId, {table, seat}>`:
  столов = ceil(n / tableSize); перемешать, раздать по кругу (размеры столов отличаются ≤ 1), места внутри стола перемешать.
- `clockState(levels, startedAt, pausedAt, pausedTotalSec, now)` → `ClockState | null`.
- `tournamentIcs(t, url)` → строка VCALENDAR/VEVENT (UID `showdown-t<id>`, длительность 4 ч, CRLF, экранирование).
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
interface TournamentCard { id; title; subtitle; startsAt: string; lateRegUntil: string | null; status;
  capacity; registeredCount; waitlistCount; freeSeats; buyIn; startingStack: number | null;
  myStatus: MyStatus; myWaitlistPosition: number | null; mySeat: { table: number; seat: number } | null;
  canRegister: boolean }
interface ResultRow { place: number; player: PlayerBrief; knockouts: number; points: number }
interface TournamentDetail extends TournamentCard { description; knockoutPoints; reentries: Bullet[]; addons: Bullet[];
  blindLevels: BlindLevel[]; clock: ClockState | null; participants: PlayerBrief[]; waitlist: PlayerBrief[];
  results: ResultRow[] | null }
interface Me { player: { id; tgId; name; nickname: string | null; avatarUrl; phoneVerified: boolean };
  isAdmin: boolean; club: { name; city; tz } }
interface LeaderboardRow { place; player: PlayerBrief; points; events; wins }
interface Leaderboard { period: 'season' | 'all'; seasonLabel: string; rows: LeaderboardRow[] }
interface PlayerStats { player: PlayerBrief; placeAll: number | null;
  stats: { points; seasonPoints; events; wins; finalTables; knockouts; bestPlace: number | null };
  history: { tournamentId; title; startsAt; place; points; knockouts }[] }
interface TournamentInput { title; subtitle?; description?; startsAt; lateRegUntil?: string | null; capacity; buyIn;
  startingStack?: number | null; knockoutPoints?; reentries?; addons?; blindLevels?; status?: 'draft' | 'registration' }
interface AdminRegistration { player: PlayerBrief; status; createdAt; table: number | null; seat: number | null;
  phone: string | null; phoneVerified: boolean; username: string | null }
interface ApiError { error: string }
```

Публичные (с авторизацией):
- `GET  /api/me` → `Me`
- `PATCH /api/me` `{ nickname }` (trim, 2..32, без управляющих символов) → `Me`
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
- `POST   /api/admin/tournaments/:id/status` `{ status }`: draft→registration, registration→running, registration|running→cancelled (уведомить), running→completed только через результаты
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
  resultsPublished(tgId: number, t: TournamentRow, place: number, points: number): Promise<void>;
  tournamentCancelled(tgId: number, t: TournamentRow): Promise<void>;
  reminder(tgId: number, t: TournamentRow, hours: number): Promise<void>;
}
```
`NullNotifier` — когда нет BOT_TOKEN. Уведомления отправляются **после** коммита, fire-and-forget
(`void notify().catch(log)`); TelegramNotifier логирует и глотает ошибки (бот заблокирован и т.п.).
Регистрация через Mini App тоже шлёт сообщение «Вы записаны…» (как у River).

## Бот (grammY, long polling)

- `/start` → приветствие + inline-кнопка WebApp «Открыть клуб» (WEBAPP_URL); upsert игрока.
- `/start t_<id>` (deep link) → запись через services, ответ с карточкой турнира +
  кнопки [Открыть турнир (WebApp `WEBAPP_URL#/t/<id>`)] [Отменить запись (callback `cancel:<id>`)].
- callback `cancel:<id>` → отмена через services, редактирование сообщения.
- `message:contact` → только если `contact.user_id === from.id`: сохранить телефон, phone_verified=1,
  ответ «Телефон подтверждён ✓» с `remove_keyboard`.
- `/help`. При старте: `setMyCommands`, `setChatMenuButton({ menu_button: { type: 'web_app', text: 'Клуб', web_app: { url } } })`.
- Напоминания: раз в 60 с — регистрации `registered` для турниров `registration|running`, старт в пределах 24 ч
  (не reminded_24h) / 2 ч (не reminded_2h) → отправить, выставить флаг.

## UX Mini App

- Hash-роутер: `#/`, `#/tournaments`, `#/t/:id`, `#/rating`, `#/me`, `#/p/:id`, `#/admin`, `#/admin/t/:id`, `#/admin/new`.
- Таб-бар: Афиша · Турниры · Рейтинг · Профиль (+ Админ, если isAdmin). На детальных экранах — Telegram BackButton.
- MainButton = главное действие на экране турнира (Записаться / Встать в лист ожидания / Отменить запись — с `showConfirm`).
  В обычном браузере — кнопка на странице.
- Тема: CSS-переменные `--tg-theme-*` с фолбэками; акцент «сукно» #1E9E6A и «фишка» #E8B04B; системный шрифт;
  сетка 8 pt; карточки с тонкой рамкой; тач-цели ≥ 44 px; `prefers-reduced-motion`.
- Афиша: приветствие; hero «ближайший турнир» с живым отсчётом («через 2 ч 14 мин») или LIVE-карточка часов
  (крупные блайнды, таймер, следующий уровень), «Мои записи», мини-пьедестал топ-3 месяца.
- Турнир: шапка, чипы (дата, бай-ин/FREE, места), баннер «Ваше место», живые часы, структура, таблица блайндов (сворачиваемая),
  ре-энтри/add-on, участники с аватарами (+ очередь), результаты, «Добавить в календарь» (.ics).
- Рейтинг: сегмент Месяц/Всё время, пьедестал топ-3, поиск, строки → профиль игрока.
- Профиль: аватар (тап — сменить), никнейм (bottom sheet), подтверждение телефона (`requestContact`), плитки статистики, ачивки, история.
- Админ: список со статусами + «Новый турнир»; форма (все поля; редактор уровней блайндов с пресетами «Турбо / Стандарт»);
  действия: открыть регистрацию, старт, отмена, рассадка, часы, ввод результатов (список зарегистрированных: место + нокауты).
- Состояния: скелетоны, понятные пустые состояния, ошибки, toast, haptics.
- Разработка в браузере: без initData — параметр `?dev_user=<id>` (сохранять в sessionStorage) → заголовок `X-Dev-User`.
- **Никакого innerHTML с данными** — DOM строится через `h()` / `textContent`.
- На экране турнира со статусом running — опрос каждые 15 с; часы тикают на клиенте каждую секунду.

## Планка качества (MVP)

- Без тестов/CI/Docker (решение пользователя). `npm run typecheck` должен проходить без ошибок.
- Строгий TS, без `any` (кроме границы с Telegram SDK), маленькие функции, логика в services, роуты тонкие.
- `npm run seed` создаёт ~12 демо-игроков, 3 предстоящих турнира (один running с часами) и 1 завершённый с результатами.
