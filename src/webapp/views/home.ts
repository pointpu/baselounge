/**
 * Афиша: приветствие, hero «ближайший турнир» (живой отсчёт или LIVE-часы),
 * «Мои записи» и мини-пьедестал топ-3 месяца.
 */
import type { Leaderboard, TournamentCard } from '../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import logoUrl from '../logo.png';
import { me } from '../state.ts';
import {
  chip,
  emptyState,
  errorState,
  fmtMoney,
  fmtTime,
  fmtUntil,
  fmtWhen,
  greeting,
  refreshView,
  h,
  icon,
  sectionTitle,
  setChildren,
  skeleton,
} from '../ui.ts';
import type { Cleanup } from '../ui.ts';
import { gameHints } from '../../shared/rules.ts';
import { clockWidget, formatLine, hintRows, myStatusBadge, podium, rulesLink, seatsLabel, tournamentCard } from '../widgets.ts';

const POLL_MS = 15_000;

/** Плитки обратного отсчёта: дн · ч · мин · сек. */
function countdownTiles(): { el: HTMLElement; update: (ms: number) => void } {
  const units = [
    { label: 'дн', div: 86_400 },
    { label: 'ч', div: 3600 },
    { label: 'мин', div: 60 },
    { label: 'сек', div: 1 },
  ];
  const values = units.map(() => h('span', { class: 'countdown__value tabular' }, '00'));
  const el = h(
    'div',
    { class: 'countdown', attrs: { 'aria-hidden': 'true' } },
    units.map((u, i) => h('div', { class: 'countdown__cell' }, values[i], h('span', { class: 'countdown__label' }, u.label))),
  );
  const update = (ms: number): void => {
    let rest = Math.max(0, Math.floor(ms / 1000));
    units.forEach((u, i) => {
      const v = Math.floor(rest / u.div);
      rest -= v * u.div;
      const node = values[i];
      if (node) node.textContent = String(v).padStart(2, '0');
    });
  };
  return { el, update };
}

/** Hero для турнира, который ещё не начался. */
function upcomingHero(card: TournamentCard, timers: number[]): HTMLElement {
  const start = new Date(card.startsAt).getTime();
  const until = h('div', { class: 'hero__until' });
  const tiles = countdownTiles();
  const tick = (): void => {
    const ms = start - Date.now();
    until.textContent = ms > 0 ? `Старт ${fmtUntil(ms)}` : 'Турнир вот-вот начнётся';
    tiles.update(ms);
  };
  tick();
  timers.push(window.setInterval(tick, 1000));

  return h(
    'a',
    { class: 'hero', href: `#/t/${card.id}` },
    h('div', { class: 'hero__eyebrow' }, 'Ближайший турнир'),
    h('div', { class: 'hero__title' }, card.title),
    card.subtitle ? h('div', { class: 'hero__sub' }, card.subtitle) : null,
    h('div', { class: 'hero__meta' }, formatLine(card)),
    until,
    tiles.el,
    h(
      'div',
      { class: 'chips chips--on-felt' },
      chip('calendar', fmtWhen(card.startsAt)),
      chip('coin', fmtMoney(card.buyIn)),
      chip('people', seatsLabel(card)),
    ),
    h(
      'div',
      { class: 'hero__cta' },
      myStatusBadge(card) ?? h('span', { class: 'hero__cta-text' }, card.freeSeats > 0 ? 'Записаться' : 'Встать в очередь'),
      icon('chevron', 20),
    ),
  );
}

/** Hero с живыми часами для идущего турнира (сам себя обновляет). */
async function liveHero(card: TournamentCard, timers: number[]): Promise<HTMLElement> {
  const detail = await api.tournament(card.id);
  const header = h(
    'div',
    { class: 'hero__live-head' },
    h('div', null, h('div', { class: 'hero__eyebrow' }, 'Сейчас играем'), h('div', { class: 'hero__title' }, detail.title)),
    icon('chevron', 20),
  );
  if (!detail.clock) {
    return h('a', { class: 'hero', href: `#/t/${card.id}` }, header, h('div', { class: 'hero__until' }, detail.blindLevels.length ? 'Турнир идёт — часы скоро запустят' : 'Турнир идёт'));
  }
  const clock = clockWidget(detail.blindLevels, detail.clock);
  let current = detail;
  // Одна главная подсказка «Ход игры» под часами (перерыв, поздняя рег., рост блайндов…).
  const hintSlot = h('div', { class: 'hero__hint' });
  let hintKey = '';
  const refreshHint = (): void => {
    const hints = gameHints(current, clock.current(), Date.now(), { fmtTime, limit: 1 });
    const key = JSON.stringify(hints);
    if (key === hintKey) return;
    hintKey = key;
    setChildren(hintSlot, hintRows(hints));
    hintSlot.hidden = hints.length === 0;
  };
  refreshHint();
  timers.push(
    window.setInterval(() => {
      clock.tick();
      refreshHint();
    }, 1000),
  );
  timers.push(
    window.setInterval(() => {
      if (document.hidden) return;
      api
        .tournament(card.id)
        .then((d) => {
          current = d;
          if (d.clock) clock.set(d.clock);
          refreshHint();
        })
        .catch(() => undefined);
    }, POLL_MS),
  );
  return h('a', { class: 'hero hero--live', href: `#/t/${card.id}` }, header, clock.el, hintSlot);
}

function podiumSection(board: Leaderboard): HTMLElement {
  return h(
    'section',
    null,
    sectionTitle(`Топ месяца · ${board.seasonLabel}`, { label: 'Весь рейтинг', href: '#/rating' }),
    board.rows.length
      ? h('div', { class: 'card card--pad' }, podium(board.rows, me().player.id))
      : h('div', { class: 'card card--pad muted' }, 'В этом месяце ещё никто не набрал очков. Ваш шанс открыть счёт!'),
  );
}

export async function render(root: HTMLElement): Promise<Cleanup> {
  const timers: number[] = [];
  const cleanup = (): void => timers.forEach((t) => window.clearInterval(t));
  const user = me();

  const head = h(
    'header',
    { class: 'home-head' },
    h('img', { src: logoUrl, alt: '', class: 'home-head__logo', width: 44, height: 44 }),
    h(
      'div',
      null,
      h('div', { class: 'eyebrow' }, `${user.club.name} · poker club`),
      h('h1', { class: 'home-head__title' }, `${greeting()}, ${user.player.name}`),
    ),
  );
  const heroSlot = h('section', null, skeleton(1, 220));
  const mineSlot = h('section');
  const podiumSlot = h('section', null, skeleton(1, 180));
  setChildren(root, head, heroSlot, mineSlot, podiumSlot, h('section', null, rulesLink()));

  const [upcoming, board] = await Promise.allSettled([api.tournaments('upcoming'), api.leaderboard('season')]);
  if (!root.isConnected) return cleanup;

  if (upcoming.status === 'rejected') {
    setChildren(heroSlot, errorState(errorMessage(upcoming.reason), refreshView));
  } else {
    const list = upcoming.value.filter((t) => t.status === 'registration' || t.status === 'running');
    const next = list.find((t) => t.status === 'running') ?? list[0];
    if (!next) {
      setChildren(
        heroSlot,
        emptyState({
          emoji: '🂡',
          title: 'Скоро анонсируем новые турниры',
          text: 'Как только откроется регистрация — турнир появится здесь.',
        }),
      );
    } else if (next.status === 'running') {
      try {
        const hero = await liveHero(next, timers);
        if (root.isConnected) setChildren(heroSlot, hero);
      } catch {
        setChildren(heroSlot, upcomingHero(next, timers));
      }
    } else {
      setChildren(heroSlot, upcomingHero(next, timers));
    }

    const mine = upcoming.value.filter((t) => t.myStatus !== null);
    setChildren(
      mineSlot,
      sectionTitle('Мои записи', { label: 'Все турниры', href: '#/tournaments' }),
      mine.length
        ? h('div', { class: 'stack' }, mine.map((t) => tournamentCard(t)))
        : h('div', { class: 'card card--pad muted' }, 'Вы пока никуда не записаны. Выберите турнир в афише — займёт пару секунд.'),
    );
  }

  if (board.status === 'fulfilled') setChildren(podiumSlot, podiumSection(board.value));
  else podiumSlot.replaceChildren();

  return cleanup;
}
