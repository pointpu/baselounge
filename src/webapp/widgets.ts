/**
 * Доменные виджеты, общие для нескольких экранов: аватар, карточка турнира,
 * живые часы, пьедестал, статистика игрока.
 */
import type {
  BlindLevel,
  ClockState,
  LeaderboardRow,
  PlayerStats,
  TournamentCard,
  TournamentStatus,
} from '../shared/types.ts';
import {
  chip,
  dateBlock,
  fmtDate,
  fmtMoney,
  fmtNum,
  fmtTime,
  fmtTimer,
  h,
  icon,
  plural,
  sectionTitle,
  svgEl,
} from './ui.ts';

/* ───────────────────────── Аватар ───────────────────────── */

type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : name.slice(0, 2);
  return letters.toUpperCase() || '?';
}

function hue(name: string): number {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return hash % 360;
}

/** Аватар игрока: фото или цветной кружок с инициалами (и при ошибке загрузки фото). */
export function avatar(player: { name: string; avatarUrl: string | null }, size: AvatarSize = 'md'): HTMLElement {
  const fallback = h(
    'span',
    { class: ['avatar', `avatar--${size}`], style: `--hue:${hue(player.name)}`, attrs: { 'aria-hidden': 'true' } },
    initials(player.name),
  );
  const url = player.avatarUrl;
  if (!url || !/^(https:\/\/|\/)/.test(url)) return fallback;
  const img = h('img', {
    class: ['avatar', `avatar--${size}`],
    src: url,
    alt: '',
    loading: 'lazy',
    decoding: 'async',
    referrerPolicy: 'no-referrer',
  });
  img.addEventListener('error', () => img.replaceWith(fallback), { once: true });
  return img;
}

/* ───────────────────────── Статусы ───────────────────────── */

const STATUS_LABELS: Record<TournamentStatus, string> = {
  draft: 'Черновик',
  registration: 'Регистрация',
  running: 'LIVE',
  completed: 'Завершён',
  cancelled: 'Отменён',
};

export function statusBadge(status: TournamentStatus): HTMLElement {
  return h(
    'span',
    { class: ['badge', `badge--${status}`] },
    status === 'running' ? h('span', { class: 'live-dot', attrs: { 'aria-hidden': 'true' } }) : null,
    STATUS_LABELS[status],
  );
}

/** Бейдж «моего» статуса записи. */
export function myStatusBadge(card: TournamentCard): HTMLElement | null {
  if (card.myStatus === 'registered') return h('span', { class: 'badge badge--mine' }, icon('check', 14), 'Вы в игре');
  if (card.myStatus === 'waitlist')
    return h('span', { class: 'badge badge--wait' }, `Очередь${card.myWaitlistPosition ? ` №${card.myWaitlistPosition}` : ''}`);
  return null;
}

/** «12 / 40», «Мест нет · очередь 3», «18 игроков». */
export function seatsLabel(card: TournamentCard): string {
  if (card.status === 'completed' || card.status === 'cancelled') {
    return `${card.registeredCount} ${plural(card.registeredCount, 'игрок', 'игрока', 'игроков')}`;
  }
  if (card.freeSeats > 0) return `${card.registeredCount} / ${card.capacity}`;
  return `Мест нет${card.waitlistCount ? ` · очередь ${card.waitlistCount}` : ''}`;
}

/* ───────────────────────── Карточка турнира ───────────────────────── */

/** Карточка турнира в списках; href по умолчанию ведёт на публичную страницу. */
export function tournamentCard(card: TournamentCard, href = `#/t/${card.id}`): HTMLElement {
  const date = dateBlock(card.startsAt);
  const showStatus = card.status !== 'registration';
  const live = card.status === 'running';
  return h(
    'a',
    { class: ['tcard', `tcard--${card.status}`], href },
    h(
      'div',
      { class: 'tcard__date', attrs: { 'aria-hidden': 'true' } },
      h('span', { class: 'tcard__day' }, date.day),
      h('span', { class: 'tcard__month' }, date.month),
    ),
    h(
      'div',
      { class: 'tcard__body' },
      h('div', { class: 'tcard__title' }, card.title),
      card.subtitle ? h('div', { class: 'tcard__sub' }, card.subtitle) : null,
    ),
    h('span', { class: 'tcard__chevron' }, icon('chevron', 20)),
    // Теги — отдельной строкой во всю ширину карточки, всегда в одну линию.
    h(
      'div',
      { class: 'chips tcard__chips' },
      h('span', { class: 'sr-only' }, fmtDate(card.startsAt)),
      // Идущий турнир: первым — LIVE, время старта уже не важно и не показывается.
      live ? statusBadge(card.status) : chip('clock', fmtTime(card.startsAt)),
      chip('coin', fmtMoney(card.buyIn), card.buyIn === 0 ? 'felt' : undefined),
      chip('people', seatsLabel(card)),
      showStatus && !live ? statusBadge(card.status) : null,
      myStatusBadge(card),
    ),
  );
}

/* ───────────────────────── Живые часы ───────────────────────── */

/**
 * Локальная проекция состояния часов: сервер присылает снимок, клиент «доматывает»
 * его на прошедшие секунды, переходя на следующие уровни по структуре блайндов.
 */
export function projectClock(clock: ClockState, levels: readonly BlindLevel[], sinceSec: number): ClockState {
  if (clock.paused || clock.finished || sinceSec <= 0) return clock;
  let index = clock.levelIndex;
  let remaining = clock.remainingSec - sinceSec;
  while (remaining <= 0 && index + 1 < levels.length) {
    index += 1;
    remaining += (levels[index]?.minutes ?? 0) * 60;
  }
  return {
    ...clock,
    levelIndex: index,
    level: levels[index] ?? clock.level,
    nextLevel: levels[index + 1] ?? (index === clock.levelIndex ? clock.nextLevel : null),
    remainingSec: Math.max(0, remaining),
    elapsedSec: clock.elapsedSec + sinceSec,
    finished: remaining <= 0 && index + 1 >= levels.length,
  };
}

export function blindsText(level: BlindLevel): string {
  return `${fmtNum(level.sb)} / ${fmtNum(level.bb)}`;
}

/** Покерное сокращение для крупных чисел: 2 500 → «2 500», 12 500 → «12.5K», 1 500 000 → «1.5M». */
function compactChips(n: number): string {
  const short = (v: number, suffix: string): string => `${Number(v.toFixed(1))}${suffix}`;
  if (n >= 1_000_000) return short(n / 1_000_000, 'M');
  if (n >= 10_000) return short(n / 1_000, 'K');
  return fmtNum(n);
}

/** Блайнды для крупной строки в часах: «200/400», «100K/200K» — всегда в одну строку. */
function blindsCompact(level: BlindLevel): string {
  return `${compactChips(level.sb)}/${compactChips(level.bb)}`;
}

const BLINDS_MAX_PX = 40;
const BLINDS_MIN_PX = 14;

/**
 * Подгоняет размер шрифта, чтобы строка блайндов всегда помещалась в одну строку
 * (и «50 / 100», и «100 000 / 200 000»). Начинает с максимума и уменьшает, пока не влезет.
 */
function fitOneLine(el: HTMLElement): void {
  if (!el.isConnected || el.clientWidth === 0) return;
  let size = BLINDS_MAX_PX;
  el.style.fontSize = `${size}px`;
  while (el.scrollWidth > el.clientWidth && size > BLINDS_MIN_PX) {
    size -= 1;
    el.style.fontSize = `${size}px`;
  }
}

function nextText(level: BlindLevel | null): string {
  if (!level) return 'Последний уровень';
  if (level.isBreak) return `Далее: перерыв ${level.minutes} мин`;
  return `Далее: ${blindsText(level)}${level.ante ? ` · анте ${fmtNum(level.ante)}` : ''}`;
}

const RING_R = 54;
const RING_C = 2 * Math.PI * RING_R;

export interface ClockWidget {
  el: HTMLElement;
  /** Новый снимок с сервера. */
  set(clock: ClockState): void;
  /** Перерисовка по локальному времени (вызывать раз в секунду). */
  tick(): void;
}

/** LIVE-карточка часов: крупные блайнды, кольцо прогресса уровня, следующий уровень. */
export function clockWidget(levels: readonly BlindLevel[], initial: ClockState): ClockWidget {
  let snapshot = initial;
  let fetchedAt = Date.now();

  const progress = svgEl('circle', {
    cx: 60, cy: 60, r: RING_R, fill: 'none', 'stroke-width': 8, 'stroke-linecap': 'round',
    'stroke-dasharray': RING_C.toFixed(2), class: 'clock__ring-value', transform: 'rotate(-90 60 60)',
  });
  const ring = svgEl('svg', { viewBox: '0 0 120 120', class: 'clock__ring', 'aria-hidden': 'true' });
  ring.append(svgEl('circle', { cx: 60, cy: 60, r: RING_R, fill: 'none', 'stroke-width': 8, class: 'clock__ring-track' }), progress);

  const timer = h('div', { class: 'clock__timer tabular' });
  const timerCaption = h('div', { class: 'clock__timer-caption' });
  const levelLabel = h('span', { class: 'clock__level' });
  const pausedBadge = h('span', { class: 'badge badge--paused' }, 'Пауза');
  const blinds = h('div', { class: 'clock__blinds tabular' });
  const ante = h('div', { class: 'clock__ante tabular' });
  const next = h('div', { class: 'clock__next tabular' });
  const bar = h('div', { class: 'clock__bar-value' });

  const el = h(
    'div',
    { class: 'clock', attrs: { role: 'timer', 'aria-live': 'off' } },
    h('div', { class: 'clock__head' }, h('span', { class: 'badge badge--running' }, h('span', { class: 'live-dot' }), 'LIVE'), levelLabel, pausedBadge),
    h(
      'div',
      { class: 'clock__main' },
      h('div', { class: 'clock__dial' }, ring, h('div', { class: 'clock__dial-text' }, timer, timerCaption)),
      h('div', { class: 'clock__info' }, h('div', { class: 'clock__caption' }, 'Блайнды'), blinds, ante),
    ),
    h('div', { class: 'clock__bar' }, bar),
    next,
  );

  const draw = (): void => {
    const c = projectClock(snapshot, levels, (Date.now() - fetchedAt) / 1000);
    const levelSec = Math.max(1, c.level.minutes * 60);
    const done = c.finished ? 1 : Math.min(1, Math.max(0, 1 - c.remainingSec / levelSec));
    progress.setAttribute('stroke-dashoffset', (RING_C * (1 - done)).toFixed(2));
    bar.style.width = `${(((c.levelIndex + done) / Math.max(1, c.totalLevels)) * 100).toFixed(1)}%`;
    timer.textContent = c.finished ? '00:00' : fmtTimer(c.remainingSec);
    timerCaption.textContent = c.paused ? 'на паузе' : c.finished ? 'структура окончена' : 'до конца уровня';
    levelLabel.textContent = c.level.isBreak ? 'Перерыв' : `Уровень ${c.levelIndex + 1} из ${c.totalLevels}`;
    pausedBadge.hidden = !c.paused;
    el.classList.toggle('is-paused', c.paused);
    el.classList.toggle('is-break', c.level.isBreak);
    blinds.textContent = c.level.isBreak ? 'Перерыв' : blindsCompact(c.level);
    // Полные числа — в подсказке (для экранных читалок и при наведении).
    blinds.title = c.level.isBreak ? '' : blindsText(c.level);
    ante.textContent = c.level.isBreak ? `${c.level.minutes} мин` : c.level.ante ? `анте ${compactChips(c.level.ante)}` : 'без анте';
    next.textContent = nextText(c.nextLevel);
  };

  // Перемеряем только при смене текста блайндов или ширины карточки — не на каждом тике.
  let fittedText = '';
  const refit = (): void => {
    fittedText = blinds.textContent ?? '';
    fitOneLine(blinds);
  };
  const resizeObserver = new ResizeObserver(() => {
    if (!el.isConnected) return resizeObserver.disconnect();
    refit();
  });
  resizeObserver.observe(blinds);

  const drawAndFit = (): void => {
    draw();
    if ((blinds.textContent ?? '') !== fittedText) refit();
  };

  drawAndFit();
  return {
    el,
    set(clock) {
      snapshot = clock;
      fetchedAt = Date.now();
      drawAndFit();
    },
    tick: drawAndFit,
  };
}

/* ───────────────────────── Пьедестал ───────────────────────── */

/** Пьедестал топ-3 (порядок колонок 2 · 1 · 3). */
export function podium(rows: readonly LeaderboardRow[], meId: number | null): HTMLElement {
  const top = rows.slice(0, 3);
  const order = [top[1], top[0], top[2]];
  return h(
    'ol',
    { class: 'podium', attrs: { 'aria-label': 'Топ-3' } },
    order.map((row) =>
      row
        ? h(
            'li',
            { class: ['podium__item', `podium__item--${row.place}`, row.player.id === meId && 'is-me'] },
            h(
              'a',
              { href: `#/p/${row.player.id}`, class: 'podium__link' },
              h('span', { class: 'podium__avatar' }, avatar(row.player, row.place === 1 ? 'xl' : 'lg'), h('span', { class: 'podium__medal' }, String(row.place))),
              h('span', { class: 'podium__name' }, row.player.name),
              h('span', { class: 'podium__points tabular' }, `${fmtNum(row.points)} очк.`),
              h('span', { class: 'podium__step', attrs: { 'aria-hidden': 'true' } }),
            ),
          )
        : h('li', { class: 'podium__item podium__item--empty', attrs: { 'aria-hidden': 'true' } }),
    ),
  );
}

/* ───────────────────────── Статистика игрока ───────────────────────── */

/** Все возможные ачивки (см. DESIGN.md): показываем и закрытые — как цель. */
const ACHIEVEMENTS = [
  { code: 'first_win', icon: '🏆', title: 'Первая победа', hint: 'Выиграйте турнир' },
  { code: 'finalist', icon: '🎯', title: 'Финалист', hint: '3 финальных стола' },
  { code: 'hunter', icon: '🔪', title: 'Охотник', hint: '10 нокаутов' },
  { code: 'regular', icon: '♣', title: 'Завсегдатай', hint: '10 турниров' },
] as const;

function tile(label: string, value: string, accent = false): HTMLElement {
  return h(
    'div',
    { class: ['tile', accent && 'tile--accent'] },
    h('div', { class: 'tile__value tabular' }, value),
    h('div', { class: 'tile__label' }, label),
  );
}

/** Плитки статистики, ачивки и история турниров. */
export function statsBlock(data: PlayerStats): HTMLElement {
  const s = data.stats;
  const earned = new Set(data.player.achievements.map((a) => a.code));
  const known = new Set<string>(ACHIEVEMENTS.map((a) => a.code));
  const extra = data.player.achievements.filter((a) => !known.has(a.code));

  return h(
    'div',
    { class: 'stack stack--lg' },
    h(
      'div',
      { class: 'tiles' },
      tile('Очки за месяц', fmtNum(s.seasonPoints), true),
      tile('Очки всего', fmtNum(s.points)),
      tile('Место за всё время', data.placeAll ? `№ ${data.placeAll}` : '—'),
      tile('Турниров', fmtNum(s.events)),
      tile('Побед', fmtNum(s.wins)),
      tile('Финальных столов', fmtNum(s.finalTables)),
      tile('Нокаутов', fmtNum(s.knockouts)),
      tile('Лучшее место', s.bestPlace ? `${s.bestPlace}-е` : '—'),
    ),
    h(
      'section',
      null,
      sectionTitle('Достижения'),
      h(
        'div',
        { class: 'achievements' },
        ACHIEVEMENTS.map((a) =>
          h(
            'div',
            { class: ['achievement', !earned.has(a.code) && 'is-locked'] },
            h('span', { class: 'achievement__icon', attrs: { 'aria-hidden': 'true' } }, a.icon),
            h('span', { class: 'achievement__title' }, a.title),
            h('span', { class: 'achievement__hint' }, earned.has(a.code) ? 'Получено' : a.hint),
          ),
        ),
        extra.map((a) =>
          h(
            'div',
            { class: 'achievement' },
            h('span', { class: 'achievement__icon', attrs: { 'aria-hidden': 'true' } }, a.icon),
            h('span', { class: 'achievement__title' }, a.title),
            h('span', { class: 'achievement__hint' }, 'Получено'),
          ),
        ),
      ),
    ),
    h(
      'section',
      null,
      sectionTitle('История'),
      data.history.length
        ? h(
            'div',
            { class: 'list' },
            data.history.map((row) =>
              h(
                'a',
                { class: 'list__row', href: `#/t/${row.tournamentId}` },
                h('span', { class: ['place-pill', row.place <= 3 && `place-pill--${row.place}`] }, String(row.place)),
                h(
                  'span',
                  { class: 'list__main' },
                  h('span', { class: 'list__title' }, row.title),
                  h('span', { class: 'list__sub' }, `${fmtDate(row.startsAt)}${row.knockouts ? ` · нокаутов: ${row.knockouts}` : ''}`),
                ),
                h('span', { class: 'list__value tabular' }, `+${fmtNum(row.points)}`),
              ),
            ),
          )
        : h('p', { class: 'muted' }, 'Сыгранных турниров пока нет — самое время записаться.'),
    ),
  );
}
