/**
 * Публичный профиль игрока (только просмотр).
 */
import { api, errorMessage } from '../api.ts';
import { me } from '../state.ts';
import { emptyState, errorState, h, refreshView, setChildren, skeleton } from '../ui.ts';
import type { Params } from '../ui.ts';
import { avatar, statsBlock } from '../widgets.ts';

export async function render(root: HTMLElement, params: Params): Promise<void> {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    setChildren(root, emptyState({ emoji: '🃏', title: 'Игрок не найден' }));
    return;
  }
  if (id === me().player.id) {
    window.location.replace('#/me');
    return;
  }

  setChildren(root, skeleton(1, 160), skeleton(1, 200));
  try {
    const data = await api.player(id);
    if (!root.isConnected) return;
    setChildren(
      root,
      h(
        'header',
        { class: 'profile-head' },
        avatar(data.player, 'xl'),
        h('h1', { class: 'page-title' }, data.player.name),
        h('p', { class: 'page-sub' }, data.placeAll ? `№ ${data.placeAll} в клубном рейтинге` : 'Пока без места в рейтинге'),
      ),
      statsBlock(data),
    );
  } catch (error) {
    if (root.isConnected) setChildren(root, errorState(errorMessage(error), refreshView));
  }
}
