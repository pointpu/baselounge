# BASE LOUNGE · poker club

Telegram-бот и Mini App для покерного клуба: афиша турниров, запись в один тап, лист ожидания,
живые часы блайндов, рейтинг, профили игроков и админка — всё внутри Telegram.

Репозиторий: <https://github.com/pointpu/baselounge> · образ: `ghcr.io/pointpu/baselounge`.

## Возможности

- **Афиша и запись**: карточки турниров, запись одной кнопкой (нативная MainButton Telegram),
  deep link `https://t.me/<бот>?start=t_<id>`.
- **Лист ожидания**: при отмене первый в очереди получает место и сообщение от бота.
- **Напоминания** за 24 ч и за 2 ч, файл `.ics` «Добавить в календарь».
- **Живые часы блайндов**: текущий и следующий уровень, обратный отсчёт — у всех в телефоне.
- **Техасский холдем**: игра турнира (No-Limit / Pot-Limit / Fixed-Limit Hold'em), форматы выводятся
  автоматически (Bounty, Re-entry/Freezeout, Turbo, Deepstack, Add-on), подсказки «Ход игры» (перерыв и add-on,
  поздняя регистрация, рост блайндов, анте), лента фаз турнира и экран «Правила холдема». Приложение не играет
  в покер — это регистрация, рейтинг и подсказки по ходу турнира.
- **Авторассадка** в один клик, каждому приходит «стол 2 · место 5».
- **Рейтинг** месяца и за всё время, пьедестал, автоматические ачивки.
- **Профиль**: никнейм, свой аватар, подтверждение телефона через `requestContact`.
- **Админка внутри Mini App** — доступ по Telegram ID / username, без паролей.
- Тема Telegram (светлая/тёмная), BackButton, haptics, нативные диалоги; работает в мобильном,
  десктопном и веб-клиенте Telegram.

## Стек

- **TypeScript** везде; Node.js 26 запускает `.ts` напрямую (type stripping), сервер не компилируется.
- Сервер — **Hono** (`@hono/node-server`), валидация env и запросов — **zod**.
- Бот — **grammY**, long polling (вебхук и открытый порт для бота не нужны).
- Mini App — vanilla TS + **Vite** (сборка в `dist/webapp`, отдаётся тем же сервером).
- База — **PostgreSQL 17** (драйвер `postgres`), миграции — **goose**. Аватары хранятся в самой базе
  (таблица `avatars`) — ни файлов, ни томов приложению не нужно.

## Быстрый старт (локально, без Telegram)

Нужны **Node.js 26** (минимум 24), **Docker** и **goose** (см. «Миграции»).

```bash
docker compose up -d   # PostgreSQL 17 на 127.0.0.1:5432, данные — в томе pgdata
cp .env.example .env   # задайте POSTGRES_PASSWORD и тот же пароль в DATABASE_URL
npm i
npm run migrate        # применить миграции (goose)
npm run seed           # демо-данные (только локально! см. ниже)
npm run build          # сборка Mini App в dist/webapp
DEV_MODE=true ADMIN_IDS=1 npm start
```

> Пароль в `POSTGRES_PASSWORD` записывается в базу при **первом** `docker compose up -d` (создание
> тома). Удобнее сначала заполнить `.env`, потом поднимать контейнер. Спецсимволы пароля внутри
> `DATABASE_URL` кодируйте: `@` → `%40`, `:` → `%3A`, `/` → `%2F`.

Откройте <http://localhost:8000/?dev_user=1> — вы dev-пользователь с Telegram ID `1`.
С `ADMIN_IDS=1` он же админ (появится вкладка «Админ»). Другой игрок — `?dev_user=2` и т. д.

> `DEV_MODE=true` разрешает входить без подписи Telegram (заголовок `X-Dev-User`). **Только для
> локальной машины**, никогда не включайте на сервере.

**`npm run seed` стирает данные**: удаляет **все турниры** (с регистрациями и результатами) и
демо-игроков, затем создаёт заново 12 демо-игроков, идущий турнир с часами, предстоящие и
завершённые турниры (даты — относительно текущего момента). **Никогда не запускайте его на боевой базе.**

Если схема не актуальна (миграции не применены), сервер не стартует и пишет по-русски, что нужно
выполнить `npm run migrate`. То же делают `seed` и импорт.

## Режим разработки

Два терминала:

```bash
npm run dev:server    # API на :8000, перезапуск при изменениях (DEV_MODE=true в .env)
npm run dev:web       # Vite на :5173 с hot reload, /api и /media проксируются на :8000
```

Mini App: <http://localhost:5173/?dev_user=1>. Проверка типов: `npm run typecheck`.

### npm-скрипты

| Скрипт | Что делает |
|---|---|
| `dev:server` / `dev:web` | сервер с `--watch` / Vite dev server |
| `build` | сборка Mini App в `dist/webapp` |
| `start` | запуск сервера (бот + API + Mini App) на `PORT` (по умолчанию 8000) |
| `migrate` | goose поверх `DATABASE_URL`: `up` по умолчанию, `-- status`, `-- down` |
| `seed` | демо-данные; **стирает все турниры** — не для продакшена |
| `import:sqlite` | разовый перенос из старой SQLite-базы |
| `typecheck` | `tsc --noEmit` |

Все скрипты читают `.env` (`node --env-file-if-exists=.env`).

## Миграции (goose)

Схемой управляет [goose](https://github.com/pressly/goose) (v3.29.0). Файлы —
`src/server/migrations/NNN_name.sql`, в каждом секции `-- +goose Up` и `-- +goose Down`. Применённые
версии goose хранит в таблице `goose_db_version`.

Приложение **само миграции не применяет**: при старте оно проверяет, что схема актуальна, и
завершается с понятным сообщением, если нет. Применять миграции — отдельный шаг.

Установка goose:

```bash
brew install goose
# или
go install github.com/pressly/goose/v3/cmd/goose@v3.29.0
```

Команды:

```bash
npm run migrate              # применить все новые миграции (goose up)
npm run migrate -- status    # какие применены, какие нет
npm run migrate -- down      # откатить последнюю миграцию
```

Новая миграция (последовательная нумерация — флаг `-s`):

```bash
goose -s -dir src/server/migrations create add_something sql
```

Правила: уже применённый файл не редактируем — любое изменение схемы оформляется новым файлом;
секция `Down` должна откатывать ровно то, что сделал `Up`. Перед `npm run seed` и
`npm run import:sqlite` схема должна быть смигрирована (`npm run migrate`).

В Kubernetes миграции выполняет initContainer чарта перед стартом приложения — см.
[deploy/README.md](deploy/README.md).

## База данных и бэкапы

```bash
docker compose up -d                                    # запустить (порт открыт только на 127.0.0.1)
docker compose ps                                       # статус и healthcheck
docker compose exec db psql -U baselounge baselounge    # консоль SQL
docker compose down                                     # остановить (данные в томе pgdata сохраняются)
```

`docker compose down -v` **удаляет том с данными**.

`DATABASE_URL` может содержать параметры, например
`postgres://user:pass@host:5432/db?search_path=baselounge&sslmode=require` — так приложение
работает в отдельной схеме managed-PostgreSQL с TLS. Размер пула — `DB_POOL_MAX` (по умолчанию 10).

Бэкап и восстановление:

```bash
# Снимок (сжатый custom-формат):
docker compose exec -T db pg_dump -U baselounge -Fc baselounge > backup.dump

# Восстановление (сервер остановлен):
docker compose exec -T db pg_restore -U baselounge -d baselounge --clean --if-exists < backup.dump

# Удалённая / managed-база — напрямую по адресу:
pg_dump -Fc "$DATABASE_URL" > backup.dump
pg_restore --clean --if-exists -d "$DATABASE_URL" backup.dump
```

Аватары лежат в таблице `avatars`, поэтому дамп — полный бэкап (вместе с `goose_db_version`).
Делайте снимок по расписанию и храните копии вне сервера.

## Подключение к Telegram

1. **Бот**: в [@BotFather](https://t.me/BotFather) — `/newbot`, токен → `BOT_TOKEN` в `.env`
   (пусто — бот выключен, API и Mini App работают).
2. **HTTPS-адрес**. Telegram открывает Mini App только по https. Локально — quick tunnel:
   ```bash
   cloudflared tunnel --url http://localhost:8000
   ```
   Адрес `https://….trycloudflare.com` → `WEBAPP_URL` (без слеша в конце). Он **меняется при каждом
   запуске** туннеля — обновите `WEBAPP_URL` и перезапустите сервер.
3. **Админы**: Telegram ID (узнать, например, через @userinfobot) — в `ADMIN_IDS` через запятую,
   или username — в `ADMIN_USERNAMES` (например, `ADMIN_USERNAMES=club_admin`). ID надёжнее:
   username можно сменить.
4. Выключите `DEV_MODE`, соберите и запустите: `npm run build && npm start`.
5. **Кнопка меню** ставится автоматически при старте (`setChatMenuButton` → «Клуб»), если
   `WEBAPP_URL` — https. Вручную: BotFather `/setmenubutton`; там же `Configure Mini App` — тот же URL.

Команды бота: `/start` (кнопка «Открыть клуб»), `/phone` (подтвердить телефон), `/help`.

Остальные переменные (`CLUB_NAME`, `CLUB_CITY`, `CLUB_TZ` — сезон рейтинга = календарный месяц в
этом поясе, `INIT_DATA_TTL`, `PORT`) описаны в [.env.example](.env.example).

## Перенос со старой SQLite-базы

Ранние версии хранили данные в `data/showdown.db`, а аватары — файлами. Перенос разовый:

```bash
npm run migrate                                        # сначала схема
npm run import:sqlite                                  # из data/showdown.db
npm run import:sqlite -- path/to/backup.db             # из другого файла
npm run import:sqlite -- path/to/backup.db --force     # очистить таблицы и импортировать заново
```

Игроки, турниры, регистрации и результаты копируются одной транзакцией с сохранением id; файл SQLite
открывается только на чтение. Если в PostgreSQL уже есть данные, импорт отказывается работать без
`--force`. В конце печатаются счётчики строк — сверьте с исходной базой.

Старые файлы-аватары (папка `<медиа>/avatars`) загружаются в таблицу `avatars` отдельно, повторный
запуск безопасен:

```bash
node --env-file-if-exists=.env src/server/import-avatars.ts [папка медиа, по умолчанию ./data/media]
```

Порядок: остановить старый сервер → копия `data/showdown.db` → `npm run migrate` →
`npm run import:sqlite` → `import-avatars.ts` → запустить сервер.

## Деплой

Продакшн — Kubernetes, Helm-чарт `deploy/helm/baselounge`; подробно — в
[deploy/README.md](deploy/README.md). Кратко:

- образ `ghcr.io/pointpu/baselounge` собирает GitHub Actions при пуше в `main`: теги `latest`,
  `sha-<короткий sha>`, а для git-тегов `v*` — semver;
- доступ снаружи — Envoy Gateway (Gateway API), сертификат Let's Encrypt через cert-manager;
- **одна реплика, стратегия `Recreate`** — long polling допускает только одного получателя на токен;
- миграции — goose в initContainer до старта приложения;
- NetworkPolicy: вход только от Envoy, выход — DNS, PostgreSQL, HTTPS;
- Secret с `BOT_TOKEN` и `DATABASE_URL` (адрес БД — **приватный IP**, например `10.16.0.10`).

## Структура проекта

```
src/
  shared/types.ts       # DTO API — общий контракт сервера и Mini App
  server/
    main.ts             # HTTP (Hono), статика, /media/avatars, бот, graceful shutdown
    config.ts           # env → валидированный config (zod)
    db.ts, repo.ts      # PostgreSQL: пул, транзакции, SQL-запросы
    migrate.ts          # проверка актуальности схемы
    migrations/         # NNN_name.sql для goose (-- +goose Up / Down)
    seed.ts             # демо-данные (стирает турниры)
    import-sqlite.ts    # разовый перенос из SQLite
    import-avatars.ts   # разовый перенос файлов-аватаров в таблицу avatars
    auth.ts             # проверка initData Telegram, DEV_MODE
    http.ts             # ошибки, security-заголовки, валидация
    time.ts             # даты, сезон (месяц в CLUB_TZ)
    services/           # турниры, лист ожидания, часы, рассадка, очки, рейтинг, игроки, .ics
    routes/             # public.ts (/api/...), admin.ts (/api/admin/...)
    bot/                # grammY: команды, уведомления, напоминания, тексты
  webapp/               # Mini App: vanilla TS + Vite, hash-роутер, views/*
deploy/                 # Helm-чарт и инструкция по деплою
Dockerfile              # продакшн-образ (Node 26, только рантайм-зависимости)
docker-compose.yml      # локальный PostgreSQL 17
```

Архитектура, модель данных и контракт — в [DESIGN.md](DESIGN.md).

## API кратко

Все запросы — JSON, авторизация заголовком `X-Telegram-Init-Data: <Telegram.WebApp.initData>`
(в `DEV_MODE` — `X-Dev-User: <tg_id>`). Ошибки — `{ "error": "сообщение по-русски" }`.

| Метод | Путь | Что делает |
|---|---|---|
| GET / PATCH | `/api/me` | профиль; смена никнейма `{ nickname }` |
| POST | `/api/me/avatar` | загрузка аватара (multipart `file`, JPEG/PNG/WebP ≤ 2 МБ) |
| GET | `/api/me/stats`, `/api/players/:id` | статистика, история, ачивки |
| GET | `/api/tournaments?scope=upcoming\|past` | список турниров |
| GET | `/api/tournaments/:id` | турнир: участники, очередь, часы, результаты |
| POST / DELETE | `/api/tournaments/:id/registration` | записаться / отменить запись |
| GET | `/api/tournaments/:id/calendar.ics` | файл для календаря (без авторизации) |
| GET | `/api/leaderboard?period=season\|all` | рейтинг месяца / за всё время |
| GET / POST | `/api/admin/tournaments` | все турниры / создать |
| PATCH | `/api/admin/tournaments/:id` | изменить |
| POST | `/api/admin/tournaments/:id/status` | `{ status }`: открыть регистрацию, старт, отмена |
| GET | `/api/admin/tournaments/:id/registrations` | записи с телефонами и местами |
| POST | `/api/admin/tournaments/:id/seating` | авторассадка `{ tableSize: 6..10 }` |
| POST | `/api/admin/tournaments/:id/clock` | часы `{ action: start\|pause\|resume\|reset }` |
| PUT | `/api/admin/tournaments/:id/results` | результаты `{ entries: [{ playerId, place, knockouts }] }` |

`GET /media/avatars/<имя>` — аватар из базы. `GET /healthz` → `{ "ok": true }` (503, если база недоступна).

**Очки** за турнир: `round(100 × (поле − место + 1) / поле) + нокауты × цена нокаута`, +25 за победу.
**Ачивки**: 🏆 первая победа, 🎯 финалист (3+ финальных стола), 🔪 охотник (10+ нокаутов), ♣ завсегдатай (10+ турниров).
