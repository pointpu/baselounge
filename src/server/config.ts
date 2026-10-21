/**
 * Конфигурация приложения: читается из переменных окружения и валидируется zod.
 * Файл `.env` подхватывается самим Node (`--env-file-if-exists=.env` в npm-скриптах).
 */
import { resolve } from 'node:path';
import { z } from 'zod';

/** Корень проекта (папка `showdown/`), чтобы относительные пути не зависели от cwd. */
export const PROJECT_ROOT = resolve(import.meta.dirname, '../..');

const boolFlag = z
  .string()
  .default('false')
  .transform((v) => ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()));

const idList = z
  .string()
  .default('')
  .transform((v, ctx) => {
    const ids = v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
    if (ids.some((n) => !Number.isSafeInteger(n) || n <= 0)) {
      ctx.addIssue({ code: 'custom', message: 'ADMIN_IDS — список числовых Telegram ID через запятую' });
      return z.NEVER;
    }
    return ids;
  });

const usernameList = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim().replace(/^@/, '').toLowerCase())
      .filter(Boolean),
  );

const timeZone = z
  .string()
  .default('Europe/Moscow')
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('ru-RU', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'CLUB_TZ — неизвестный часовой пояс (пример: Europe/Moscow)');

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  BOT_TOKEN: z.string().trim().default(''),
  WEBAPP_URL: z
    .url({ message: 'WEBAPP_URL — некорректный URL' })
    .default('http://localhost:8000')
    .transform((u) => u.replace(/\/+$/, '')),
  ADMIN_IDS: idList,
  ADMIN_USERNAMES: usernameList,
  DATABASE_URL: z
    .string({ message: 'DATABASE_URL не задан — укажите адрес PostgreSQL, например postgres://baselounge:пароль@127.0.0.1:5432/baselounge (см. .env.example)' })
    .trim()
    .refine((v) => /^postgres(?:ql)?:\/\/.+/.test(v), 'DATABASE_URL — ожидается адрес вида postgres://user:password@host:5432/db'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** Только для разового переноса старых файлов-аватаров (import-avatars.ts); сервер его не читает. */
  MEDIA_DIR: z.string().default('./data/media'),
  CLUB_NAME: z.string().default('BASE LOUNGE'),
  CLUB_CITY: z.string().default('Москва'),
  CLUB_TZ: timeZone,
  DEV_MODE: boolFlag,
  INIT_DATA_TTL: z.coerce.number().int().positive().default(86400),
});

/** Пустые строки в env считаем «не задано», чтобы срабатывали значения по умолчанию. */
function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') out[k] = v;
  return out;
}

function loadConfig() {
  const parsed = EnvSchema.safeParse(cleanEnv(process.env));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`);
    console.error(`Ошибка конфигурации:\n${lines.join('\n')}`);
    process.exit(1);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    botToken: e.BOT_TOKEN,
    webappUrl: e.WEBAPP_URL,
    adminIds: new Set(e.ADMIN_IDS),
    adminUsernames: new Set(e.ADMIN_USERNAMES),
    databaseUrl: e.DATABASE_URL,
    dbPoolMax: e.DB_POOL_MAX,
    /** Папка старых медиа-файлов — нужна только import-avatars.ts. */
    mediaDir: resolve(PROJECT_ROOT, e.MEDIA_DIR),
    webDistDir: resolve(PROJECT_ROOT, 'dist/webapp'),
    clubName: e.CLUB_NAME,
    clubCity: e.CLUB_CITY,
    clubTz: e.CLUB_TZ,
    devMode: e.DEV_MODE,
    initDataTtlSec: e.INIT_DATA_TTL,
  } as const;
}

export type Config = ReturnType<typeof loadConfig>;

export const config: Config = loadConfig();

/**
 * Админ ли игрок: по Telegram ID (надёжно) или по username (удобно, когда ID ещё неизвестен;
 * username в Telegram можно сменить, поэтому для постоянных админов лучше ADMIN_IDS).
 */
export function isAdminPlayer(p: { tg_id: number; username: string | null }): boolean {
  if (config.adminIds.has(p.tg_id)) return true;
  return p.username !== null && config.adminUsernames.has(p.username.toLowerCase());
}
