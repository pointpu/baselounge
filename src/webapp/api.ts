/**
 * Клиент REST API. Все запросы идут только на тот же origin (`/api/...`).
 * Авторизация: initData из Telegram, а вне Telegram — dev-пользователь (`?dev_user=<id>`).
 */
import type {
  AdminRegistration,
  BlindTemplate,
  BlindTemplateFromTournament,
  BlindTemplateInput,
  ClockAction,
  Leaderboard,
  LeaderboardPeriod,
  Me,
  MePatch,
  PlayerStats,
  ResultEntryInput,
  TournamentCard,
  TournamentDetail,
  TournamentInput,
  TournamentStatus,
} from '../shared/types.ts';
import { getInitData } from './tg.ts';

/** Ошибка API с человеческим сообщением на русском. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const DEV_USER_KEY = 'showdown.devUser';

/** Dev-пользователь: из `?dev_user=` (запоминаем в sessionStorage) или ранее сохранённый. */
function devUser(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('dev_user');
  try {
    if (fromUrl && /^\d{1,15}$/.test(fromUrl)) {
      sessionStorage.setItem(DEV_USER_KEY, fromUrl);
      return fromUrl;
    }
    return sessionStorage.getItem(DEV_USER_KEY);
  } catch {
    return fromUrl && /^\d{1,15}$/.test(fromUrl) ? fromUrl : null;
  }
}

/** Есть ли у клиента хоть какой-то способ авторизоваться. */
export function hasCredentials(): boolean {
  return getInitData() !== '' || devUser() !== null;
}

function authHeaders(): Record<string, string> {
  const initData = getInitData();
  if (initData) return { 'X-Telegram-Init-Data': initData };
  const dev = devUser();
  return dev ? { 'X-Dev-User': dev } : {};
}

const FALLBACK_MESSAGES: Record<number, string> = {
  400: 'Проверьте введённые данные',
  401: 'Не удалось войти. Откройте приложение из Telegram',
  403: 'Недостаточно прав',
  404: 'Не найдено',
  409: 'Действие сейчас недоступно',
  413: 'Файл слишком большой',
  429: 'Слишком много запросов, попробуйте чуть позже',
};

function fallbackMessage(status: number): string {
  return FALLBACK_MESSAGES[status] ?? (status >= 500 ? 'Сервер временно недоступен' : 'Что-то пошло не так');
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...authHeaders() };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: payload,
      credentials: 'same-origin',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ApiError(0, 'Нет связи с сервером. Проверьте интернет');
  }

  if (response.status === 204) return undefined as T;
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' && data.error
        ? data.error
        : fallbackMessage(response.status);
    throw new ApiError(response.status, message);
  }
  return data as T;
}

const get = <T>(path: string): Promise<T> => request<T>('GET', path);

/** Типизированные методы API (см. DESIGN.md → REST API). */
export const api = {
  me: () => get<Me>('/api/me'),
  updateMe: (patch: MePatch) => request<Me>('PATCH', '/api/me', patch),
  uploadAvatar(file: File): Promise<Me> {
    const form = new FormData();
    form.append('file', file);
    return request<Me>('POST', '/api/me/avatar', form);
  },
  myStats: () => get<PlayerStats>('/api/me/stats'),

  tournaments: (scope: 'upcoming' | 'past') => get<TournamentCard[]>(`/api/tournaments?scope=${scope}`),
  tournament: (id: number) => get<TournamentDetail>(`/api/tournaments/${id}`),
  register: (id: number) => request<TournamentDetail>('POST', `/api/tournaments/${id}/registration`),
  unregister: (id: number) => request<TournamentDetail>('DELETE', `/api/tournaments/${id}/registration`),

  leaderboard: (period: LeaderboardPeriod) => get<Leaderboard>(`/api/leaderboard?period=${period}`),
  player: (id: number) => get<PlayerStats>(`/api/players/${id}`),

  admin: {
    tournaments: () => get<TournamentCard[]>('/api/admin/tournaments'),
    create: (input: TournamentInput) => request<TournamentDetail>('POST', '/api/admin/tournaments', input),
    update: (id: number, patch: Partial<TournamentInput>) =>
      request<TournamentDetail>('PATCH', `/api/admin/tournaments/${id}`, patch),
    setStatus: (id: number, status: TournamentStatus, opts: { announce?: boolean } = {}) =>
      request<TournamentDetail>('POST', `/api/admin/tournaments/${id}/status`, { status, ...opts }),
    registrations: (id: number) => get<AdminRegistration[]>(`/api/admin/tournaments/${id}/registrations`),
    seating: (id: number, tableSize: number) =>
      request<TournamentDetail>('POST', `/api/admin/tournaments/${id}/seating`, { tableSize }),
    clock: (id: number, action: ClockAction) =>
      request<TournamentDetail>('POST', `/api/admin/tournaments/${id}/clock`, { action }),
    results: (id: number, entries: ResultEntryInput[]) =>
      request<TournamentDetail>('PUT', `/api/admin/tournaments/${id}/results`, { entries }),

    templates: () => get<BlindTemplate[]>('/api/admin/blind-templates'),
    createTemplate: (input: BlindTemplateInput | BlindTemplateFromTournament) =>
      request<BlindTemplate>('POST', '/api/admin/blind-templates', input),
    updateTemplate: (id: number, patch: Partial<BlindTemplateInput>) =>
      request<BlindTemplate>('PATCH', `/api/admin/blind-templates/${id}`, patch),
    deleteTemplate: (id: number) => request<void>('DELETE', `/api/admin/blind-templates/${id}`),
  },
};

/** Ссылка на .ics-файл турнира (эндпоинт без авторизации). */
export function calendarUrl(id: number): string {
  return `/api/tournaments/${id}/calendar.ics`;
}

/** Достаёт человеческое сообщение из любой ошибки. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Что-то пошло не так. Попробуйте ещё раз';
}
