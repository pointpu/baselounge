/**
 * Экран турнира: шапка, чипы, теги игры/формата, лента фаз, «Ваше место», живые часы,
 * подсказки «Ход игры», структура и блайнды, участники и очередь, результаты, .ics.
 * Главное действие — MainButton.
 */
import type { BlindLevel, Bullet, TournamentDetail } from '../../shared/types.ts';
import { api, calendarUrl, errorMessage } from '../api.ts';
import { me } from '../state.ts';
import { confirmDialog, haptic, isTelegram, openLink, setMainAction } from '../tg.ts';
import type { MainAction } from '../tg.ts';
import {
  chip,
  emptyState,
  errorState,
  fmtDuration,
  fmtMoney,
  fmtNum,
  fmtTime,
  fmtWhen,
  h,
  icon,
  refreshView,
  sectionTitle,
  setChildren,
  skeleton,
  toast,
} from '../ui.ts';
import type { Cleanup, Params } from '../ui.ts';
import { GAME_LABELS, gameHints, isBbAnte, phaseTimeline, playableNumber } from '../../shared/rules.ts';
import { avatar, blindsText, clockWidget, formatTags, hintRows, phaseStrip, rulesLink, seatsLabel, statusBadge } from '../widgets.ts';
import type { ClockWidget } from '../widgets.ts';

const POLL_MS = 15_000;

/** Состояние «свёрнута ли таблица блайндов» переживает перерисовки при опросе. */
let blindsOpen = false;

function myBanner(d: TournamentDetail): HTMLElement | null {
  if (d.mySeat) {
    return h(
      'div',
      { class: 'banner banner--seat' },
      icon('seat', 28),
      h(
        'div',
        null,
        h('div', { class: 'banner__eyebrow' }, 'Ваше место'),
        h('div', { class: 'banner__title tabular' }, `Стол ${d.mySeat.table} · место ${d.mySeat.seat}`),
      ),
    );
  }
  if (d.myStatus === 'registered') {
    return h(
      'div',
      { class: 'banner banner--ok' },
      icon('check', 24),
      h(
        'div',
        null,
        h('div', { class: 'banner__title' }, 'Вы записаны'),
        h(
          'div',
          { class: 'banner__text' },
          d.canCancel
            ? 'Напомним за сутки и за 2 часа. Место за столом пришлём перед стартом.'
            : 'Турнир начался — отменить запись уже нельзя. Место за столом пришлёт бот.',
        ),
      ),
    );
  }
  if (d.myStatus === 'waitlist') {
    return h(
      'div',
      { class: 'banner banner--wait' },
      icon('people', 24),
      h(
        'div',
        null,
        h('div', { class: 'banner__title' }, `Вы в листе ожидания${d.myWaitlistPosition ? ` · №${d.myWaitlistPosition}` : ''}`),
        h('div', { class: 'banner__text' }, 'Если место освободится, вы займёте его автоматически — бот сообщит.'),
      ),
    );
  }
  return null;
}

function notice(d: TournamentDetail): HTMLElement | null {
  if (d.status === 'draft') return h('div', { class: 'banner banner--muted' }, 'Черновик — турнир видят только администраторы.');
  if (d.status === 'cancelled') return h('div', { class: 'banner banner--danger' }, 'Турнир отменён.');
  if (d.status === 'running' && !d.canRegister && !d.myStatus)
    return h('div', { class: 'banner banner--muted' }, 'Турнир уже идёт, регистрация закрыта.');
  return null;
}

function infoRow(label: string, value: string): HTMLElement {
  return h('div', { class: 'info__row' }, h('dt', null, label), h('dd', { class: 'tabular' }, value));
}

/**
 * Ре-энтри / add-on: «20 000 фишек · 1 500 ₽» — одной строкой, условие («до конца поздней
 * регистрации») — отдельной строкой-подписью под ценой, а не рваным переносом.
 */
function bulletsRows(title: string, bullets: readonly Bullet[]): HTMLElement[] {
  return bullets.map((b, i) =>
    h(
      'div',
      { class: 'info__row info__row--bullet' },
      h('dt', null, bullets.length > 1 ? `${title} ${i + 1}` : title),
      h(
        'dd',
        null,
        h('span', { class: 'info__main tabular' }, `${fmtNum(b.stack)} фишек · ${fmtMoney(b.price)}`),
        b.note ? h('span', { class: 'info__note' }, b.note) : null,
      ),
    ),
  );
}

function structure(d: TournamentDetail): HTMLElement {
  const totalMin = d.blindLevels.reduce((sum, l) => sum + l.minutes, 0);
  const playable = d.blindLevels.filter((l) => !l.isBreak);
  return h(
    'section',
    null,
    sectionTitle('Структура'),
    h(
      'dl',
      { class: 'card info' },
      infoRow('Игра', GAME_LABELS[d.game]),
      d.startingStack ? infoRow('Стартовый стек', `${fmtNum(d.startingStack)} фишек`) : null,
      infoRow('Бай-ин', fmtMoney(d.buyIn)),
      d.lateRegUntil ? infoRow('Поздняя регистрация', `до ${fmtTime(d.lateRegUntil)}`) : null,
      d.knockoutPoints ? infoRow('За нокаут', `+${d.knockoutPoints} очк.`) : null,
      d.dealer ? infoRow('Дилер', d.dealer) : null,
      playable.length
        ? infoRow('Уровни', `${playable.length} · ${playable[0]?.minutes ?? 0} мин`)
        : null,
      totalMin ? infoRow('Длительность структуры', fmtDuration(totalMin)) : null,
      anteRow(d.blindLevels),
      bulletsRows('Ре‑энтри', d.reentries),
      bulletsRows('Add-on', d.addons),
    ),
  );
}

/** «С уровня 4 · BB-анте» — когда в структуре появляется анте. */
function anteRow(levels: readonly BlindLevel[]): HTMLElement | null {
  const idx = levels.findIndex((l) => !l.isBreak && l.ante > 0);
  const level = levels[idx];
  if (!level) return null;
  const allBb = levels.slice(idx).every((l) => l.isBreak || isBbAnte(l));
  return infoRow('Анте', `с ур. ${playableNumber(levels, idx)}${allBb ? ' · BB-анте' : ''}`);
}

function blindsTable(levels: readonly BlindLevel[], currentIndex: number | null): HTMLElement | null {
  if (!levels.length) return null;
  let n = 0;
  const rows = levels.map((l, i) => {
    const current = i === currentIndex;
    if (l.isBreak) {
      return h('tr', { class: ['is-break', current && 'is-current'] }, h('td', { colSpan: 4 }, `Перерыв · ${l.minutes} мин`));
    }
    n += 1;
    return h(
      'tr',
      { class: current ? 'is-current' : null, attrs: { 'aria-current': current ? 'step' : null } },
      h('td', null, String(n)),
      h('td', null, blindsText(l)),
      h('td', { class: isBbAnte(l) ? 'is-bb-ante' : null }, isBbAnte(l) ? 'BB-анте' : l.ante ? fmtNum(l.ante) : '—'),
      h('td', null, String(l.minutes)),
    );
  });
  const details = h(
    'details',
    { class: 'card blinds', open: blindsOpen },
    h('summary', null, h('span', null, 'Таблица блайндов'), icon('chevron', 18)),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'table tabular' },
        h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Блайнды'), h('th', null, 'Анте'), h('th', null, 'Мин'))),
        h('tbody', null, rows),
      ),
    ),
  );
  details.addEventListener('toggle', () => {
    blindsOpen = details.open;
  });
  return details;
}

function people(d: TournamentDetail): HTMLElement {
  const meId = me().player.id;
  const grid = d.participants.length
    ? h(
        'div',
        { class: 'people' },
        d.participants.map((p) =>
          h(
            'a',
            { class: ['person', p.id === meId && 'is-me'], href: `#/p/${p.id}` },
            avatar(p, 'lg'),
            h('span', { class: 'person__name' }, p.name),
          ),
        ),
      )
    : h('p', { class: 'muted' }, 'Пока никто не записался — станьте первым!');
  return h(
    'section',
    null,
    sectionTitle(`Участники · ${d.registeredCount} / ${d.capacity}`),
    grid,
    d.waitlist.length
      ? h(
          'div',
          { class: 'card list waitlist' },
          h('div', { class: 'list__header' }, `Лист ожидания · ${d.waitlist.length}`),
          d.waitlist.map((p, i) =>
            h(
              'a',
              { class: ['list__row', p.id === meId && 'is-me'], href: `#/p/${p.id}` },
              h('span', { class: 'place-pill' }, String(i + 1)),
              avatar(p, 'sm'),
              h('span', { class: 'list__main' }, h('span', { class: 'list__title' }, p.name)),
            ),
          ),
        )
      : null,
  );
}

function results(d: TournamentDetail): HTMLElement | null {
  if (!d.results?.length) return null;
  const meId = me().player.id;
  return h(
    'section',
    null,
    sectionTitle('Результаты'),
    h(
      'div',
      { class: 'card list' },
      d.results.map((r) =>
        h(
          'a',
          { class: ['list__row', r.player.id === meId && 'is-me'], href: `#/p/${r.player.id}` },
          h('span', { class: ['place-pill', r.place <= 3 && `place-pill--${r.place}`] }, String(r.place)),
          avatar(r.player, 'sm'),
          h(
            'span',
            { class: 'list__main' },
            h('span', { class: 'list__title' }, r.player.name),
            r.knockouts ? h('span', { class: 'list__sub' }, `Нокаутов: ${r.knockouts}`) : null,
          ),
          h('span', { class: 'list__value tabular' }, `+${fmtNum(r.points)}`),
        ),
      ),
    ),
  );
}

function calendarButton(d: TournamentDetail): HTMLElement | null {
  if (d.status !== 'registration' && d.status !== 'running') return null;
  const url = calendarUrl(d.id);
  if (isTelegram) {
    return h(
      'button',
      { type: 'button', class: 'btn btn--soft btn--block', on: { click: () => openLink(url) } },
      icon('calendar', 20),
      'Добавить в календарь',
    );
  }
  return h(
    'a',
    { class: 'btn btn--soft btn--block', href: url, download: `showdown-${d.id}.ics` },
    icon('calendar', 20),
    'Добавить в календарь',
  );
}

export async function render(root: HTMLElement, params: Params): Promise<Cleanup | void> {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    setChildren(root, emptyState({ emoji: '🃏', title: 'Турнир не найден' }));
    return;
  }

  setChildren(root, skeleton(1, 120), skeleton(1, 220), skeleton(3, 56));
  let detail: TournamentDetail;
  let clock: ClockWidget | null = null;

  const mainAction = (d: TournamentDetail): MainAction | null => {
    if (d.status !== 'registration' && d.status !== 'running') return null;
    // Турнир начался — занявший место уже не может отменить запись (кнопку не показываем).
    if (d.myStatus && !d.canCancel) return null;
    if (d.myStatus) {
      return {
        text: d.myStatus === 'waitlist' ? 'Покинуть лист ожидания' : 'Отменить запись',
        tone: 'danger',
        onClick: async () => {
          haptic.warning();
          const ok = await confirmDialog(
            d.myStatus === 'waitlist' ? `Покинуть лист ожидания «${d.title}»?` : `Отменить запись на «${d.title}»?`,
          );
          if (ok) await act(() => api.unregister(id), () => 'Запись отменена');
        },
      };
    }
    if (!d.canRegister) return null;
    return {
      text: d.freeSeats > 0 ? `Записаться · ${fmtMoney(d.buyIn)}` : 'Встать в лист ожидания',
      onClick: () =>
        act(
          () => api.register(id),
          (next) =>
            next.myStatus === 'waitlist'
              ? `Вы в листе ожидания${next.myWaitlistPosition ? `, №${next.myWaitlistPosition}` : ''}`
              : 'Вы записаны! Бот пришлёт напоминание',
        ),
    };
  };

  // «Ход игры» и лента фаз пересчитываются каждую секунду (отсчёты), DOM меняется только при смене текста.
  const phasesSlot = h('div', { class: 'detail-head__phases' });
  const hintsList = h('div', { class: 'card hints' });
  const hintsSection = h('section', null, sectionTitle('Ход игры'), hintsList);
  let hintsKey = '';
  let phasesKey = '';
  const refreshLive = (): void => {
    const d = detail;
    const now = Date.now();
    const c = clock?.current() ?? null;
    const hints = gameHints(d, c, now, { fmtTime });
    const hk = JSON.stringify(hints);
    if (hk !== hintsKey) {
      hintsKey = hk;
      setChildren(hintsList, hintRows(hints));
      hintsSection.hidden = hints.length === 0;
    }
    const steps = phaseTimeline(d, c, now);
    const pk = JSON.stringify(steps);
    if (pk !== phasesKey) {
      phasesKey = pk;
      setChildren(phasesSlot, phaseStrip(steps));
    }
  };

  const draw = (): void => {
    const d = detail;
    clock = d.status === 'running' && d.clock ? clockWidget(d.blindLevels, d.clock) : null;
    hintsKey = '';
    phasesKey = '';
    refreshLive();
    setChildren(
      root,
      h(
        'header',
        { class: 'detail-head' },
        h('div', { class: 'detail-head__badges' }, statusBadge(d.status)),
        h('h1', { class: 'page-title' }, d.title),
        d.subtitle ? h('p', { class: 'detail-head__sub' }, d.subtitle) : null,
        h(
          'div',
          { class: 'chips' },
          chip('calendar', fmtWhen(d.startsAt)),
          chip('coin', fmtMoney(d.buyIn), d.buyIn === 0 ? 'felt' : 'gold'),
          chip('people', seatsLabel(d)),
          d.startingStack ? chip('stack', `${fmtNum(d.startingStack)} фишек`) : null,
        ),
        formatTags(d),
        phasesSlot,
      ),
      myBanner(d),
      notice(d),
      clock ? h('section', null, clock.el) : null,
      hintsSection,
      results(d),
      d.description ? h('section', { class: 'card card--pad prose' }, d.description) : null,
      structure(d),
      blindsTable(d.blindLevels, d.clock && d.status === 'running' ? d.clock.levelIndex : null),
      people(d),
      calendarButton(d),
      rulesLink(),
      me().isAdmin
        ? h('a', { class: 'btn btn--ghost btn--block', href: `#/admin/t/${d.id}` }, icon('shield', 20), 'Управлять турниром')
        : null,
    );
    setMainAction(mainAction(d));
  };

  /** Выполняет действие пользователя и перерисовывает экран по ответу сервера. */
  const act = async (call: () => Promise<TournamentDetail>, message: (d: TournamentDetail) => string): Promise<void> => {
    try {
      const next = await call();
      if (!root.isConnected) return;
      detail = next;
      draw();
      toast(message(next), 'success');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  try {
    detail = await api.tournament(id);
  } catch (error) {
    if (root.isConnected) setChildren(root, errorState(errorMessage(error), refreshView));
    return;
  }
  if (!root.isConnected) return;
  draw();

  const tick = window.setInterval(() => {
    clock?.tick();
    refreshLive();
  }, 1000);
  const poll = window.setInterval(() => {
    if (document.hidden || detail.status !== 'running') return;
    api
      .tournament(id)
      .then((next) => {
        if (!root.isConnected) return;
        const structural =
          next.status !== detail.status ||
          next.registeredCount !== detail.registeredCount ||
          next.myStatus !== detail.myStatus ||
          next.mySeat?.table !== detail.mySeat?.table ||
          next.mySeat?.seat !== detail.mySeat?.seat ||
          next.clock?.levelIndex !== detail.clock?.levelIndex ||
          Boolean(next.results) !== Boolean(detail.results);
        detail = next;
        if (structural || !clock || !next.clock) draw();
        else {
          clock.set(next.clock);
          refreshLive();
        }
      })
      .catch(() => undefined);
  }, POLL_MS);

  return () => {
    window.clearInterval(tick);
    window.clearInterval(poll);
    setMainAction(null);
  };
}
