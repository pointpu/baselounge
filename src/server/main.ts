/**
 * Точка входа: миграции БД, HTTP-сервер (API + статика Mini App + аватары), бот и graceful shutdown.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import type { ApiError } from '../shared/types.ts';
import { type RunningBot, startBot } from './bot/bot.ts';
import { config } from './config.ts';
import { closeDb, sql } from './db.ts';
import { type AppEnv, onError, securityHeaders } from './http.ts';
import { runMigrations } from './migrate.ts';
import { adminApi } from './routes/admin.ts';
import { publicApi } from './routes/public.ts';
import { findAvatar } from './repo.ts';
import { AVATAR_MIME, parseAvatarFileName } from './services/players.ts';

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', securityHeaders);
  app.use('/api/*', logger());
  app.onError(onError);

  app.get('/healthz', async (c) => {
    try {
      await sql`SELECT 1`;
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false, error: 'База данных недоступна' }, 503);
    }
  });

  app.route('/api/admin', adminApi);
  app.route('/api', publicApi);
  app.all('/api/*', (c) => c.json<ApiError>({ error: 'Метод API не найден' }, 404));

  // Аватары — из таблицы avatars. Имя содержит версию, поэтому ответ неизменяем и кэшируется «навсегда».
  app.get('/media/avatars/:file', async (c) => {
    const parsed = parseAvatarFileName(c.req.param('file'));
    const avatar = parsed && (await findAvatar(parsed.playerId, parsed.version));
    if (!parsed || !avatar || AVATAR_MIME[parsed.ext] !== avatar.mime) return c.json<ApiError>({ error: 'Файл не найден' }, 404);
    const etag = `"${avatar.player_id}-${avatar.version}"`;
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    c.header('ETag', etag);
    c.header('Last-Modified', new Date(avatar.updated_at).toUTCString());
    const inm = c.req.header('If-None-Match');
    if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) return c.body(null, 304);
    c.header('Content-Type', avatar.mime);
    c.header('Content-Length', String(avatar.data.byteLength));
    return c.body(new Uint8Array(avatar.data)); // копия: Hono ждёт Uint8Array<ArrayBuffer>
  });
  app.all('/media/*', (c) => c.json<ApiError>({ error: 'Файл не найден' }, 404));

  // Mini App: собранные файлы + SPA-фолбэк на index.html.
  const indexHtml = join(config.webDistDir, 'index.html');
  app.use('/assets/*', async (c, next) => {
    await next();
    if (c.res.status === 200) c.header('Cache-Control', 'public, max-age=31536000, immutable');
  });
  // HTML (в т.ч. `/` → index.html) не кэшируем: после пересборки он ссылается на новые хэши ассетов.
  app.use('*', async (c, next) => {
    await next();
    if (c.res.headers.get('Content-Type')?.startsWith('text/html')) c.header('Cache-Control', 'no-cache');
  });
  app.use('*', serveStatic({ root: config.webDistDir }));
  const serveIndex = serveStatic<AppEnv>({ path: indexHtml });
  app.get('*', async (c, next) => {
    if (!existsSync(indexHtml)) {
      return c.text('Mini App ещё не собран. Выполните `npm run build` (или используйте `npm run dev:web`).', 503);
    }
    c.header('Cache-Control', 'no-cache');
    const res = await serveIndex(c, next);
    return res ?? c.notFound();
  });

  return app;
}

async function main(): Promise<void> {
  if (config.devMode) {
    console.warn('⚠️  DEV_MODE включён: принимается заголовок X-Dev-User без проверки подписи. Не используйте в продакшене!');
  }

  try {
    const applied = await runMigrations();
    console.log(applied.length > 0 ? `[db] применены миграции: ${applied.join(', ')}` : '[db] схема актуальна');
  } catch (err) {
    console.error('[db] не удалось подключиться к PostgreSQL или применить миграции:', err instanceof Error ? err.message : err);
    console.error('[db] проверьте DATABASE_URL и что база запущена (docker compose up -d)');
    await closeDb().catch(() => {});
    process.exit(1);
  }

  const app = buildApp();
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[http] ${config.clubName} слушает http://localhost:${info.port} (WEBAPP_URL=${config.webappUrl})`);
  });

  let bot: RunningBot | null = null;
  if (config.botToken) {
    try {
      bot = await startBot(config.botToken);
    } catch (err) {
      console.error('[bot] не удалось запустить бота (API продолжает работать):', err instanceof Error ? err.message : err);
    }
  } else {
    console.log('[bot] BOT_TOKEN не задан — бот выключен, API работает');
  }

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`[main] ${signal}: останавливаемся…`);
    const force = setTimeout(() => process.exit(1), 8000);
    force.unref();
    try {
      await bot?.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeDb();
    } catch (err) {
      console.error('[main] ошибка при остановке:', err);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

await main();
