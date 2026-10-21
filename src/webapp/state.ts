/**
 * Единое состояние приложения: текущий пользователь («me»).
 * Подписчики узнают об изменениях (например, таб-бар — о появлении прав админа).
 */
import type { Me } from '../shared/types.ts';

type Listener = (me: Me) => void;

const listeners = new Set<Listener>();

export const state: { me: Me | null } = { me: null };

/** Текущий пользователь; вызывать только после загрузки (main.ts гарантирует это до роутинга). */
export function me(): Me {
  if (!state.me) throw new Error('Профиль ещё не загружен');
  return state.me;
}

export function setMe(value: Me): void {
  state.me = value;
  for (const listener of listeners) listener(value);
}

/** Подписка на изменения профиля; возвращает функцию отписки. */
export function onMeChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Часовой пояс клуба: все даты показываем в нём, а не в поясе устройства. */
export function clubTz(): string {
  return state.me?.club.tz ?? 'Europe/Moscow';
}
