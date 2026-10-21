/**
 * Рейтинг: сегмент «Месяц / Всё время», пьедестал топ-3, поиск, строки → профиль игрока.
 */
import type { Leaderboard, LeaderboardPeriod, LeaderboardRow } from '../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import { me } from '../state.ts';
import { emptyState, errorState, fmtNum, h, icon, plural, segmented, setChildren, skeleton } from '../ui.ts';
import { avatar, podium } from '../widgets.ts';

let lastPeriod: LeaderboardPeriod = 'season';

function row(r: LeaderboardRow, meId: number): HTMLElement {
  return h(
    'a',
    { class: ['list__row', r.player.id === meId && 'is-me'], href: `#/p/${r.player.id}` },
    h('span', { class: ['place-pill', r.place <= 3 && `place-pill--${r.place}`] }, String(r.place)),
    avatar(r.player, 'sm'),
    h(
      'span',
      { class: 'list__main' },
      h(
        'span',
        { class: 'list__title' },
        r.player.name,
        r.player.achievements.length
          ? h('span', { class: 'list__icons', attrs: { 'aria-label': r.player.achievements.map((a) => a.title).join(', ') } }, r.player.achievements.map((a) => a.icon).join(''))
          : null,
      ),
      h(
        'span',
        { class: 'list__sub' },
        `${r.events} ${plural(r.events, 'турнир', 'турнира', 'турниров')}${r.wins ? ` · ${r.wins} ${plural(r.wins, 'победа', 'победы', 'побед')}` : ''}`,
      ),
    ),
    h('span', { class: 'list__value tabular' }, fmtNum(r.points)),
  );
}

function board(data: Leaderboard): HTMLElement {
  const meId = me().player.id;
  if (!data.rows.length) {
    return emptyState({
      emoji: '🏆',
      title: data.period === 'season' ? 'В этом месяце пока пусто' : 'Рейтинг пока пуст',
      text: 'Очки появятся после первого завершённого турнира.',
      action: { label: 'К турнирам', onClick: () => window.location.assign('#/tournaments') },
    });
  }

  const list = h('div', { class: 'card list' });
  const nothing = h('p', { class: 'muted center', hidden: true }, 'Никого не нашли');
  const fill = (query: string): void => {
    const q = query.trim().toLocaleLowerCase('ru-RU');
    const rows = q ? data.rows.filter((r) => r.player.name.toLocaleLowerCase('ru-RU').includes(q)) : data.rows;
    setChildren(list, rows.map((r) => row(r, meId)));
    list.hidden = rows.length === 0;
    nothing.hidden = rows.length > 0;
  };
  const search = h('input', {
    type: 'search',
    class: 'input',
    placeholder: 'Поиск игрока',
    ariaLabel: 'Поиск игрока',
    autocomplete: 'off',
    on: { input: () => fill(search.value) },
  });
  fill('');

  const mine = data.rows.find((r) => r.player.id === meId);
  return h(
    'div',
    { class: 'stack stack--lg' },
    h('div', { class: 'card card--pad' }, podium(data.rows, meId)),
    mine
      ? h('div', { class: 'banner banner--ok' }, icon('trophy', 24), h('div', null, h('div', { class: 'banner__title tabular' }, `Вы — ${mine.place}-е место · ${fmtNum(mine.points)} очк.`)))
      : null,
    h('label', { class: 'search' }, icon('search', 20), search),
    list,
    nothing,
  );
}

export function render(root: HTMLElement): void {
  const content = h('div');
  const caption = h('p', { class: 'page-sub' });
  let seq = 0;

  const load = async (period: LeaderboardPeriod): Promise<void> => {
    lastPeriod = period;
    const mySeq = ++seq;
    setChildren(content, skeleton(1, 200), skeleton(6, 56));
    try {
      const data = await api.leaderboard(period);
      if (mySeq !== seq) return;
      caption.textContent = period === 'season' ? `Сезон: ${data.seasonLabel}` : 'За всё время';
      setChildren(content, board(data));
    } catch (error) {
      if (mySeq === seq) setChildren(content, errorState(errorMessage(error), () => void load(period)));
    }
  };

  setChildren(
    root,
    h('h1', { class: 'page-title' }, 'Рейтинг'),
    caption,
    segmented(
      [
        { value: 'season', label: 'Месяц' },
        { value: 'all', label: 'Всё время' },
      ],
      lastPeriod,
      (period) => void load(period),
      'Период рейтинга',
    ),
    content,
  );
  void load(lastPeriod);
}
