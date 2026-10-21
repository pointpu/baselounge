/**
 * Список турниров: «Предстоящие» / «Прошедшие».
 */
import { api, errorMessage } from '../api.ts';
import { emptyState, errorState, h, segmented, setChildren, skeleton } from '../ui.ts';
import { tournamentCard } from '../widgets.ts';

type Scope = 'upcoming' | 'past';

/** Последняя выбранная вкладка — чтобы «Назад» с карточки возвращал туда же. */
let lastScope: Scope = 'upcoming';

export function render(root: HTMLElement): void {
  const list = h('div', { class: 'stack' });
  let seq = 0;

  const load = async (scope: Scope): Promise<void> => {
    lastScope = scope;
    const mySeq = ++seq;
    setChildren(list, skeleton(4, 92));
    try {
      const items = await api.tournaments(scope);
      if (mySeq !== seq) return;
      if (!items.length) {
        setChildren(
          list,
          scope === 'upcoming'
            ? emptyState({ emoji: '🂮', title: 'Афиша пока пуста', text: 'Новые турниры появятся здесь, а бот пришлёт анонс.' })
            : emptyState({ emoji: '📜', title: 'Архив пуст', text: 'Здесь будут сыгранные турниры и их результаты.' }),
        );
        return;
      }
      setChildren(list, items.map((t) => tournamentCard(t)));
    } catch (error) {
      if (mySeq === seq) setChildren(list, errorState(errorMessage(error), () => void load(scope)));
    }
  };

  setChildren(
    root,
    h('h1', { class: 'page-title' }, 'Турниры'),
    segmented(
      [
        { value: 'upcoming', label: 'Предстоящие' },
        { value: 'past', label: 'Прошедшие' },
      ],
      lastScope,
      (scope) => void load(scope),
      'Период',
    ),
    list,
  );
  void load(lastScope);
}
