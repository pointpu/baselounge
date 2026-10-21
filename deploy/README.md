# Деплой BASE LOUNGE в Kubernetes (Helm)

Чарт: `deploy/helm/baselounge`. Ставит одно приложение (бот + API + Mini App в одном
Node-процессе на порту 8000) и всё, что нужно для доступа снаружи:

| Ресурс | Зачем |
|---|---|
| Deployment (1 реплика, `Recreate`) | приложение; миграции БД выполняются при старте |
| Service `ClusterIP` 80 → 8000 | бэкенд для HTTPRoute |
| Gateway (`envoy-gateway`) | listeners `http:80` и `https:443` для `gateway.hostname` |
| HTTPRoute ×2 | приложение на https; редирект http → https |
| Issuer + Certificate (cert-manager) | Let's Encrypt, HTTP-01 через Gateway API, Secret `<release>-tls` |
| NetworkPolicy | вход только от Envoy, выход: DNS, PostgreSQL, HTTPS |
| ConfigMap / Secret | переменные окружения (`envFrom`) |

## Важные ограничения

- **Только одна реплика.** Бот получает обновления через long polling (`getUpdates`):
  Telegram отдаёт их одному получателю на токен, второй экземпляр получает `409 Conflict`.
  Поэтому `replicas: 1` зашит в шаблон, а стратегия — `Recreate` (при обновлении будет
  короткий простой в несколько секунд). Не делайте `kubectl scale` и не ставьте второй
  релиз с тем же `BOT_TOKEN` (и не держите параллельно локальный бот с этим токеном).
- **PVC нет** (в кластере нет StorageClass) и они не нужны: все данные, включая
  загруженные аватары (таблица `avatars`), живут в managed PostgreSQL. Корневая ФС
  контейнера только для чтения, записываемый — лишь `/tmp` (`emptyDir`).
- **PostgreSQL — только по приватному IP** `10.16.0.10:5432`. Публичный hostname
  не используйте: NetworkPolicy разрешает egress на 5432 только в `database.privateCidr`.
- **Проверки.** `/healthz` делает `SELECT 1`. readiness при падении БД выводит под из
  балансировки; liveness щадящая (~5 минут подряд ошибок), чтобы короткий сбой БД не
  перезапускал бота. startup даёт до 150 с на миграции.

## Предварительные требования

- `kubectl` и `helm` 3.x, kubeconfig кластера (`export KUBECONFIG=...`).
- В кластере: GatewayClass `envoy-gateway` (Envoy Gateway), cert-manager ≥ 1.15
  с включённой поддержкой Gateway API (`--enable-gateway-api` /
  `config.enableGatewayAPI: true`) — без неё HTTP-01 через `gatewayHTTPRoute` не работает.
- Образ `ghcr.io/pointpu/baselounge:<tag>` (публичный, собирается GitHub Actions).
  Тег по умолчанию — `latest` (последний пуш в `main`, `pullPolicy: Always`). Для
  воспроизводимого релиза фиксируйте `--set image.tag=sha-<короткий sha>` (или версию
  из git-тега `v*`) — такие теги публикует workflow `.github/workflows/image.yml`.
- Managed PostgreSQL с созданной БД и пользователем; доступ из кластера по приватной сети.
- Домен, указывающий на внешний IP балансировщика Envoy. Для старта без своего домена
  подходит `sslip.io`: IP `203.0.113.10` → `203-0-113-10.sslip.io`. Внешний IP
  балансировщика появляется только после создания Gateway и может не совпадать с IP узла —
  сверяйте с `kubectl -n baselounge get gateway` (колонка ADDRESS) и при расхождении
  поменяйте `gateway.hostname`.

## 1. Namespace

```sh
kubectl create namespace baselounge
```

## 2. Secret с токеном и адресом БД

Секреты не храним в `values.yaml` и в git. Создаём Secret вручную (ключи — ровно имена
переменных окружения):

```sh
kubectl -n baselounge create secret generic baselounge-secrets \
  --from-literal BOT_TOKEN='123456:ABC...' \
  --from-literal DATABASE_URL='postgres://user:pass@10.16.0.10:5432/db'
```

Спецсимволы в пароле внутри `DATABASE_URL` кодируйте percent-encoding (`@` → `%40` и т.п.).
Чтобы не оставлять секреты в истории shell, можно `--from-env-file=./secrets.env`.

Поменять секрет позже: пересоздать его (`kubectl ... create secret ... --dry-run=client -o yaml | kubectl apply -f -`)
и перезапустить под: `kubectl -n baselounge rollout restart deploy/baselounge`
(чарт сам перезапускает под только при изменении Secret, созданного чартом).

Альтернатива: не задавать `existingSecret`, а передать `secrets.BOT_TOKEN` и
`secrets.DATABASE_URL` через `--set`/отдельный незакоммиченный values-файл — чарт
создаст Secret `<release>-secrets`.

## 3. Установка / обновление

Сначала рекомендуется выпустить **staging**-сертификат (лимиты Let's Encrypt мягкие),
убедиться, что всё работает, и переключиться на prod (раздел 5).

```sh
helm upgrade --install baselounge deploy/helm/baselounge \
  --namespace baselounge \
  --set gateway.hostname=203-0-113-10.sslip.io \
  --set tls.acme.email=admin@example.com \
  --set tls.acme.env=staging \
  --set existingSecret=baselounge-secrets \
  --set-string app.adminIds=123456789 \
  --set image.tag=latest   # или sha-<короткий sha> из GHCR
```

Несколько админов: `--set-string 'app.adminIds=111\,222'` (запятую внутри `--set` нужно экранировать).

Удобнее держать параметры в файле (без секретов), например `values-prod.yaml`:

```yaml
gateway:
  hostname: 203-0-113-10.sslip.io
tls:
  acme:
    env: prod
    email: admin@example.com
existingSecret: baselounge-secrets
app:
  adminIds: "123456789"
  adminUsernames: "owner"
  clubCity: "Москва"
```

```sh
helm upgrade --install baselounge deploy/helm/baselounge -n baselounge -f values-prod.yaml
```

Пример для проверки рендера: `deploy/helm/baselounge/ci/example-values.yaml`
(`helm lint` / `helm template ... -f ...`).

`ADMIN_IDS` передавайте строкой (`--set-string` или кавычки в YAML), иначе Helm
превратит число в float.

Проверка:

```sh
kubectl -n baselounge get pods,svc,gateway,httproute,certificate
kubectl -n baselounge logs deploy/baselounge -f
kubectl -n baselounge describe certificate baselounge   # события выпуска
curl -I http://203-0-113-10.sslip.io/                  # 301 → https
curl https://203-0-113-10.sslip.io/healthz             # {"ok":true}
```

`WEBAPP_URL` по умолчанию — `https://<gateway.hostname>`. Этот же адрес укажите в
BotFather для Mini App (кнопка меню / Web App).

### Как устроены HTTP-01 и редирект

Чарт создаёт на listener `http` HTTPRoute с `PathPrefix: /` и фильтром `RequestRedirect`
(→ https, 301). Во время выпуска сертификата cert-manager (солвер `gatewayHTTPRoute`,
`parentRefs` → наш Gateway, `sectionName: http`) создаёт **свой** HTTPRoute на тот же
listener с путём `/.well-known/acme-challenge/<token>`. По правилам Gateway API при
конфликте выигрывает более длинный (специфичный) префикс, поэтому запросы Let's Encrypt
попадают в солвер, а всё остальное — в редирект. Не меняйте редирект на `Exact`/regex
и не вешайте его на конкретные пути — это может перехватить ACME.

До выпуска сертификата listener `https` будет в статусе `ResolvedRefs=False`
(Secret `<release>-tls` ещё не существует) — это нормально, после выдачи он станет готов.

### NetworkPolicy

- Ingress: только поды Envoy-прокси (namespace `networkPolicy.ingressFrom.namespace`,
  по умолчанию `beget-envoy-gateway`; метки `app.kubernetes.io/name=envoy`,
  `app.kubernetes.io/component=proxy`) на порт 8000. Envoy Gateway запускает прокси
  в namespace своего контроллера, а не в namespace Gateway.
- Egress: DNS (CoreDNS в `beget-coredns`, `k8s-app=coredns`, 53/UDP+TCP), PostgreSQL
  (`database.privateCidr`, 5432), HTTPS 443 в `0.0.0.0/0` (api.telegram.org, аватары).

В другом кластере проверьте namespace и метки:
`kubectl get pods -A -l app.kubernetes.io/component=proxy --show-labels`,
`kubectl get pods -A -l k8s-app=kube-dns`. Отключить: `--set networkPolicy.enabled=false`.

## 4. Свой домен

1. Создайте A-запись домена (например `club.example.ru`) на внешний IP балансировщика:
   `kubectl -n baselounge get gateway baselounge -o jsonpath='{.status.addresses[0].value}'`.
2. Дождитесь, пока DNS разрешается (`dig +short club.example.ru`).
3. `helm upgrade ... --set gateway.hostname=club.example.ru` (или правка values-файла).
   Обновятся listeners, маршруты, Certificate (новый dnsName → перевыпуск) и `WEBAPP_URL`.
4. Обновите URL Mini App в BotFather.

## 5. Staging → prod сертификат

```sh
helm upgrade baselounge deploy/helm/baselounge -n baselounge --reuse-values --set tls.acme.env=prod
```

Имя Issuer по умолчанию содержит окружение (`<fullname>-letsencrypt-staging|prod`),
поэтому создаётся новый Issuer, Certificate переключает `issuerRef`, и cert-manager
перевыпускает сертификат в тот же Secret `<release>-tls`. Если перевыпуск не начался —
`kubectl -n baselounge delete secret baselounge-tls` (Secret пересоздастся).
Staging-сертификат недоверенный: Telegram Mini App с ним не откроется.

Использовать общий ClusterIssuer: `--set tls.issuer.create=false --set tls.issuer.kind=ClusterIssuer --set tls.issuer.name=letsencrypt-prod`
(его солвер должен уметь проходить HTTP-01 через этот Gateway).

## 6. Существующий Gateway

```sh
--set gateway.create=false \
--set gateway.existing.name=shared-gw \
--set gateway.existing.namespace=infra \
--set gateway.existing.sectionName=https \
--set gateway.existing.httpSectionName=http   # пусто → без редиректа
```

Listener общего Gateway должен разрешать маршруты из namespace релиза (`allowedRoutes`),
а Secret сертификата обычно управляется владельцем Gateway — тогда `--set tls.enabled=false`.

## 7. Перенос данных

Схема создаётся миграциями при старте пода. Данные из локальной БД переносятся
стандартно: `pg_dump` с локального PostgreSQL → `pg_restore`/`psql` в managed-БД
(до первого старта пода или при остановленном Deployment:
`kubectl -n baselounge scale deploy/baselounge --replicas=0`, затем `helm upgrade`
вернёт 1). Для старой SQLite-базы есть `npm run import:sqlite` (см. корневой README) —
запускать локально с `DATABASE_URL`, указывающим на managed-БД.

Аватары, загруженные вручную в старой версии (файлы в `data/media/avatars`), перед
переносом нужно один раз загрузить в БД: `node --env-file-if-exists=.env
src/server/import-avatars.ts [папка media]` (с `DATABASE_URL` той БД, где лежат игроки;
повторный запуск безопасен). Без этого у таких игроков показывается Telegram-фото.
После этого `pg_dump` переносит и таблицу `avatars`.

## Удаление

```sh
helm uninstall baselounge -n baselounge
kubectl -n baselounge delete secret baselounge-secrets baselounge-tls
```

Данные в managed PostgreSQL при этом не затрагиваются.
