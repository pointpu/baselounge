/**
 * HTTP-инфраструктура: тип окружения Hono, ошибки с человеческими сообщениями,
 * единый обработчик ошибок, security-заголовки и разбор входных данных через zod.
 */
import type { Context, ErrorHandler, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { ApiError } from '../shared/types.ts';
import type { PlayerRow } from './repo.ts';

// Сообщения валидации zod — по-русски.
z.config(z.locales.ru());

/** Переменные контекста, которые выставляет auth-middleware. */
export type AppEnv = {
  Variables: {
    player: PlayerRow;
    isAdmin: boolean;
  };
};

/** Ошибка, которую можно показать пользователю как есть. */
export class HttpError extends Error {
  readonly status: ContentfulStatusCode;

  constructor(status: ContentfulStatusCode, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export const badRequest = (msg: string): HttpError => new HttpError(400, msg);
export const notFound = (msg = 'Не найдено'): HttpError => new HttpError(404, msg);
export const conflict = (msg: string): HttpError => new HttpError(409, msg);

/** Превращает любые ошибки в JSON `{ error }`; неожиданные — логирует и прячет детали. */
export const onError: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof HttpError) return c.json<ApiError>({ error: err.message }, err.status);
  console.error(`[http] ${c.req.method} ${c.req.path}:`, err);
  return c.json<ApiError>({ error: 'Внутренняя ошибка сервера. Попробуйте ещё раз.' }, 500);
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://telegram.org",
  "img-src 'self' data: https:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  'frame-ancestors https://web.telegram.org https://*.telegram.org',
].join('; ');

/**
 * Security-заголовки. Показ во фрейме Telegram Web разрешён через `frame-ancestors`
 * (без X-Frame-Options — он бы запретил Telegram Web).
 */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header('Content-Security-Policy', CSP);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
};

/** Валидирует данные схемой zod; первая проблема — в тексте 400-й ошибки. */
export function parseInput<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  throw badRequest(`Некорректные данные — ${where}${issue?.message ?? 'проверьте поля'}`);
}

/** Тело запроса как JSON (или 400, если это не JSON). */
export async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw badRequest('Ожидался JSON в теле запроса');
  }
}
