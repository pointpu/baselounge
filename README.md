# SHOWDOWN · poker club

Telegram-бот и Mini App для покерного клуба: афиша турниров, запись в один тап, лист ожидания,
живые часы блайндов, рейтинг, профили игроков и админка — всё внутри Telegram.

Это **MVP для проверки идеи**: минимум зависимостей, без тестов и CI. Один язык — TypeScript
(сервер, бот и Mini App), Node.js запускает `.ts` напрямую, база — **PostgreSQL 17** (в Docker).

## Чем лучше обычного бота клуба

| Обычный бот | SHOWDOWN |
|---|---|
| Список турниров текстом, запись командой | Mini App: карточки, запись одной кнопкой (нативная MainButton Telegram) |
| «Мест нет» — и всё | **Лист ожидания**: при отмене первый в очереди получает место и сообщение |
| Забыли про турнир | **Напоминания** за 24 ч и за 2 ч + кнопка «Добавить в календарь» (.ics) |
| Блайнды на бумажке у дилера | **Живые часы**: текущий уровень, следующий, обратный отсчёт — у всех в телефоне |
| Рассадка вручную | **Авторассадка** в один клик, каждому приходит «стол 2 · место 5» |
| Рейтинг в таблице | Рейтинг месяца и за всё время, пьедестал, **автоматические ачивки** |
| Админка — отдельный сайт с паролем | **Админка внутри Mini App** — по Telegram ID, без паролей |
| Не работает в Telegram Web | Работает в мобильном, десктопном и веб-клиенте Telegram |

Плюс: тема Telegram (светлая/тёмная), BackButton, haptics, нативные диалоги, подтверждение телефона через `requestContact`.

## Быстрый старт (локально, без Telegram)

Нужны **Node.js 24+** (рекомендуется 26) и **Docker** (для PostgreSQL).

```bash
npm i
cp .env.example .env  # задайте POSTGRES_PASSWORD и тот же пароль в DATABASE_URL
docker compose up -d  # PostgreSQL 17 на 127.0.0.1:5432, данные — в томе pgdata
npm run seed          # демо-данные: 12 игроков, идущий турнир с часами, предстоящие и завершённые турниры
npm run build         # сборка Mini App в dist/webapp
DEV_MODE=true ADMIN_IDS=1 npm start
```

**Миграции применяются автоматически** при старте сервера (а также перед `seed` и импортом):
файлы `src/server/migrations/NNN_name.sql` выполняются по порядку, применённые записываются в
таблицу `schema_migrations`. Изменение схемы — всегда новый файл (`002_…sql`), старые не редактируются.
Если PostgreSQL недоступен, сервер не стартует и пишет, что проверить.

Откройте <http://localhost:8000/?dev_user=1> — вы dev-пользователь с Telegram ID `1`.
С `ADMIN_IDS=1` он же админ (появится вкладка «Админ»). Другой игрок — `?dev_user=2` и т. д.

> `DEV_MODE=true` разрешает входить без подписи Telegram (заголовок `X-Dev-User`). Только для локальной машины!

`npm run seed` можно запускать повторно: он удаляет **все турниры** и демо-игроков и создаёт данные заново
(даты — относительно текущего момента). Не запускайте его на боевой базе.

## Режим разработки

Два терминала:

```bash
npm run dev:server    # API на :8000, перезапуск при изменениях (нужен DEV_MODE=true в .env)
npm run dev:web       # Vite на :5173 с hot reload, /api и /media проксируются на :8000
```

Mini App: <http://localhost:5173/?dev_user=1>. Проверка типов: `npm run typecheck`.

## Подключение к Telegram

1. **Создайте бота**: в [@BotFather](https://t.me/BotFather) — `/newbot`, получите токен → `BOT_TOKEN` в `.env`.
2. **HTTPS-адрес**. Telegram открывает Mini App только по https. Локально проще всего туннель:
   ```bash
   cloudflared tunnel --url http://localhost:8000
   ```
   Полученный адрес `https://….trycloudflare.com` пропишите в `WEBAPP_URL` (без слеша в конце).
3. **Админы**: свой Telegram ID (например, через @userinfobot) — в `ADMIN_IDS`, или username — в `ADMIN_USERNAMES` (например, `ADMIN_USERNAMES=club_admin`).
4. Уберите `DEV_MODE` (или `false`), соберите и запустите:
   ```bash
   npm run build && npm start
   ```
5. **Кнопка меню** ставится автоматически при старте (`setChatMenuButton` → «Клуб»), если `WEBAPP_URL` — https.
   Можно и вручную: в BotFather `/setmenubutton` → выберите бота → URL из `WEBAPP_URL`.
   При желании: `/setdescription`, `/setuserpic`, а в `/mybots → Bot Settings → Configure Mini App` — тот же URL.

Бот работает через long polling — вебхук и открытый порт для бота не нужны.
Команды: `/start` (кнопка «Открыть клуб»), `/phone` (подтвердить телефон), `/help`. Deep link записи на турнир: `https://t.me/<бот>?start=t_<id>`.

Адрес туннеля `trycloudflare.com` меняется при каждом запуске — после смены обновите `WEBAPP_URL` и перезапустите сервер.

## База данных (PostgreSQL)

```bash
docker compose up -d                 # запустить (порт открыт только на 127.0.0.1)
docker compose ps                    # статус и healthcheck
docker compose exec db psql -U baselounge baselounge   # консоль SQL
docker compose down                  # остановить (данные в томе pgdata сохраняются)
```

`docker compose down -v` **удаляет том с данными** — не делайте так на боевой машине.

### Перенос данных со старой SQLite-базы

Раньше данные хранились в `data/showdown.db`. Перенос — одной транзакцией, с сохранением id:

```bash
npm run import:sqlite                                  # из data/showdown.db
npm run import:sqlite -- path/to/backup.db             # из другого файла
npm run import:sqlite -- path/to/backup.db --force     # заменить уже имеющиеся данные
```

Файл SQLite открывается только на чтение. Если в PostgreSQL уже есть игроки или турниры, импорт
ничего не меняет и просит `--force` (тот очищает таблицы перед переносом). В конце печатаются счётчики
строк — сверьте их с исходной базой. Порядок переезда: остановить сервер → сделать копию `data/showdown.db`
→ `npm run import:sqlite` → запустить сервер.

### Бэкапы

```bash
# Снимок базы (сжатый custom-формат):
docker compose exec -T db pg_dump -U baselounge -Fc baselounge > backup/baselounge-$(date +%F).dump

# Восстановление в пустую базу (сервер остановлен):
docker compose exec -T db pg_restore -U baselounge -d baselounge --clean --if-exists < backup/baselounge-2026-10-21.dump
```

Делайте снимок по cron (например, раз в сутки) и храните копии вне сервера. Аватары хранятся в самой
базе (таблица `avatars`), так что дамп — это полный бэкап; папка на диске серверу не нужна.

Перенос старых аватаров-файлов (версии до миграции 002 хранили их в `MEDIA_DIR/avatars`) — один раз,
повторный запуск безопасен: `node --env-file-if-exists=.env src/server/import-avatars.ts [папка медиа]`.

## Деплой на VPS (кратко)

1. Установите Node.js 26, скопируйте проект, `npm ci && npm run build`, заполните `.env` (`DEV_MODE=false`!).
2. Запуск как сервис — **systemd** (`/etc/systemd/system/showdown.service`):
   ```ini
   [Unit]
   Description=SHOWDOWN poker club
   After=network.target docker.service

   [Service]
   WorkingDirectory=/opt/showdown
   ExecStart=/usr/bin/node --env-file=.env src/server/main.ts
   Restart=always
   User=showdown

   [Install]
   WantedBy=multi-user.target
   ```
   `systemctl enable --now showdown`. Альтернатива — `pm2 start npm --name showdown -- start`.
3. HTTPS — **Caddy** (сертификат получит сам), `/etc/caddy/Caddyfile`:
   ```
   club.example.com {
     reverse_proxy localhost:8000
   }
   ```
   `WEBAPP_URL=https://club.example.com`.
4. База — `docker compose up -d` на той же машине (или управляемый PostgreSQL: укажите его адрес в `DATABASE_URL`).
   Бэкапы — `pg_dump` (см. «Бэкапы»), аватары внутри базы.

## Структура проекта

```
src/
  shared/types.ts       # DTO API — общий контракт сервера и Mini App
  server/
    main.ts             # HTTP (Hono), статика, бот, graceful shutdown
    config.ts           # env → валидированный config (zod)
    db.ts, repo.ts      # PostgreSQL (postgres.js): пул, транзакции, SQL-запросы
    migrate.ts          # раннер миграций (advisory lock, schema_migrations)
    migrations/         # 001_init.sql, … — схема БД
    import-sqlite.ts    # перенос данных из старой SQLite-базы
    import-avatars.ts   # разовый перенос старых файлов-аватаров из MEDIA_DIR в таблицу avatars
    auth.ts             # проверка initData Telegram, DEV_MODE
    http.ts             # ошибки, security-заголовки, валидация
    time.ts             # даты, сезон (месяц в CLUB_TZ)
    services/           # бизнес-логика: турниры, лист ожидания, часы, рассадка, очки, рейтинг, .ics
    routes/             # public.ts (/api/...), admin.ts (/api/admin/...)
    bot/                # grammY: команды, уведомления, напоминания, тексты
    seed.ts             # демо-данные
  webapp/               # Mini App: vanilla TS + Vite, hash-роутер, views/*
data/                   # (в .gitignore) старый showdown.db и media/avatars (только для импорта)
```

Подробная архитектура и контракт — в [DESIGN.md](DESIGN.md).

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

`GET /healthz` → `{ "ok": true }` (503, если база недоступна).

**Очки** за турнир: `round(100 × (поле − место + 1) / поле) + нокауты × цена нокаута`, +25 за победу.
**Ачивки**: 🏆 первая победа, 🎯 финалист (3+ финальных стола), 🔪 охотник (10+ нокаутов), ♣ завсегдатай (10+ турниров).
