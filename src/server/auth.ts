/**
 * Авторизация Mini App.
 *
 * Клиент шлёт `X-Telegram-Init-Data: <Telegram.WebApp.initData>`. Подпись проверяется
 * по документации Telegram («Validating data received via the Mini App»):
 *   secret = HMAC_SHA256(key = "WebAppData", data = BOT_TOKEN)
 *   hash   = hex(HMAC_SHA256(key = secret, data = data_check_string))
 * В DEV_MODE дополнительно принимается `X-Dev-User: <tg_id>` — только для локальной разработки.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { config, isAdminPlayer } from './config.ts';
import { type AppEnv, HttpError } from './http.ts';
import { ensurePlayer, type PlayerRow, type TelegramProfile, upsertPlayerFromTelegram } from './repo.ts';

interface InitDataUser {
  id: number;
  first_name?: string;
  username?: string;
  photo_url?: string;
}

/**
 * Проверяет initData и возвращает профиль пользователя или null, если подпись
 * неверна, данные просрочены (старше `ttlSec`) или повреждены.
 */
export function validateInitData(initData: string, botToken: string, ttlSec: number, now: Date = new Date()): TelegramProfile | null {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest();
  const actual = Buffer.from(hash, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || now.getTime() / 1000 - authDate > ttlSec) return null;

  let user: InitDataUser;
  try {
    user = JSON.parse(params.get('user') ?? '') as InitDataUser;
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(user.id) || user.id <= 0) return null;

  return {
    tgId: user.id,
    firstName: user.first_name?.trim() || user.username || `Игрок ${user.id}`,
    username: user.username ?? null,
    photoUrl: user.photo_url?.startsWith('https://') ? user.photo_url : null,
  };
}

async function resolvePlayer(initData: string | undefined, devUser: string | undefined): Promise<PlayerRow> {
  if (initData) {
    if (!config.botToken) throw new HttpError(401, 'Сервер запущен без BOT_TOKEN — вход через Telegram недоступен');
    const profile = validateInitData(initData, config.botToken, config.initDataTtlSec);
    if (!profile) throw new HttpError(401, 'Сессия Telegram недействительна или устарела. Перезапустите Mini App.');
    return upsertPlayerFromTelegram(profile);
  }
  if (config.devMode && devUser) {
    const tgId = Number(devUser);
    if (!Number.isSafeInteger(tgId) || tgId <= 0) throw new HttpError(401, 'X-Dev-User должен быть положительным числом');
    return ensurePlayer(tgId, `Dev ${tgId}`);
  }
  throw new HttpError(401, 'Откройте приложение из Telegram');
}

/** Требует авторизованного игрока; кладёт его и флаг isAdmin в контекст. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const player = await resolvePlayer(c.req.header('X-Telegram-Init-Data'), c.req.header('X-Dev-User'));
  c.set('player', player);
  c.set('isAdmin', isAdminPlayer(player));
  await next();
};

/** Пропускает только админов (вызывать после requireAuth). */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('isAdmin')) throw new HttpError(403, 'Раздел доступен только администраторам клуба');
  await next();
};
