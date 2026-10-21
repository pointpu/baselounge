/**
 * Базовые UI-примитивы: DOM-хелпер h(), иконки, toast, скелетоны, пустые состояния,
 * bottom sheet, сегмент-контрол и форматирование (даты, деньги, таймеры).
 *
 * Безопасность: данные попадают в DOM только через textContent/атрибуты — никакого innerHTML.
 */
import { clubTz } from './state.ts';
import { haptic } from './tg.ts';

/* ───────────────────────── Типы экранов ───────────────────────── */

export type Cleanup = () => void;
export type Params = Readonly<Record<string, string>>;
/** Экран рисуется в root и может вернуть функцию очистки (таймеры, слушатели). */
export type ViewRender = (root: HTMLElement, params: Params) => void | Cleanup | Promise<void | Cleanup>;

/* ───────────────────────── h() ───────────────────────── */

export type Child = Node | string | number | null | undefined | false | readonly Child[];
type ClassValue = string | null | undefined | false | readonly ClassValue[];
type Handlers = { [E in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[E]) => void };

interface BaseProps {
  class?: ClassValue;
  style?: string;
  dataset?: Record<string, string>;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  on?: Handlers;
}

/** Свойства элемента: всё, что есть у DOM-узла (кроме innerHTML и т.п.), плюс удобные поля. */
export type Props<K extends keyof HTMLElementTagNameMap> = BaseProps &
  Partial<Omit<HTMLElementTagNameMap[K], keyof BaseProps | 'innerHTML' | 'outerHTML' | 'children' | 'className'>>;

function classNames(value: ClassValue): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.map(classNames).filter(Boolean).join(' ');
}

export function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child as readonly Child[]);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

/** Крошечный аналог JSX: h('div', { class: 'card' }, 'текст', h('b', null, 'жирный')). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props<K> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined) continue;
      if (key === 'class') {
        const cls = classNames(value as ClassValue);
        if (cls) el.className = cls;
      } else if (key === 'style') {
        el.style.cssText = String(value);
      } else if (key === 'dataset') {
        Object.assign(el.dataset, value);
      } else if (key === 'attrs') {
        for (const [name, attr] of Object.entries(value as NonNullable<BaseProps['attrs']>)) {
          // ARIA-атрибуты — перечислимые ("true"/"false"), а не булевы HTML-атрибуты.
          if (name.startsWith('aria-') && typeof attr === 'boolean') {
            el.setAttribute(name, String(attr));
            continue;
          }
          if (attr === false || attr === null || attr === undefined) continue;
          el.setAttribute(name, attr === true ? '' : String(attr));
        }
      } else if (key === 'on') {
        for (const [event, handler] of Object.entries(value as Handlers)) {
          if (handler) el.addEventListener(event, handler as EventListener);
        }
      } else {
        (el as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }
  append(el, children);
  return el;
}

/** Заменяет содержимое элемента. */
export function setChildren(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

/* ───────────────────────── Иконки ───────────────────────── */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Собственный минимальный набор иконок (stroke 2, сетка 24×24). */
const ICONS = {
  home: ['M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z'],
  cards: ['M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M9 9h6M9 13h6M9 17h3'],
  trophy: [
    'M8 4h8v6a4 4 0 0 1-8 0z',
    'M8 6H5.5a2.5 2.5 0 0 0 2.6 4.2M16 6h2.5a2.5 2.5 0 0 1-2.6 4.2',
    'M12 14v3M8.5 20h7M10 17h4',
  ],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 20a7.5 7.5 0 0 1 15 0'],
  shield: ['M12 3.5 19 6v5.5c0 4.4-3 7.7-7 9-4-1.3-7-4.6-7-9V6z', 'M9 12l2 2 4-4'],
  chevron: ['M9.5 6l6 6-6 6'],
  back: ['M14.5 6l-6 6 6 6'],
  calendar: ['M5 6h14v14H5z', 'M5 10h14M9 3.5V7M15 3.5V7', 'M12 13v4M10 15h4'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7.5V12l3 2'],
  coin: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v10M14.5 9.5c-.4-.9-1.4-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1.2 0-2.2-.6-2.6-1.6'],
  people: ['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M2.5 20a6.5 6.5 0 0 1 13 0', 'M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14.5a6.5 6.5 0 0 1 3.5 5.5'],
  stack: ['M12 4 3 8.5l9 4.5 9-4.5z', 'M3 12.5 12 17l9-4.5', 'M3 16.5 12 21l9-4.5'],
  plus: ['M12 5v14M5 12h14'],
  minus: ['M5 12h14'],
  close: ['M6 6l12 12M18 6 6 18'],
  camera: ['M4 8h3l2-3h6l2 3h3v11H4z', 'M12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z'],
  phone: ['M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 4.5 5.5a2 2 0 0 1 2-2z'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  book: ['M4 5h5.5A2.5 2.5 0 0 1 12 7.5V20a2 2 0 0 0-2-2H4z', 'M20 5h-5.5A2.5 2.5 0 0 0 12 7.5V20a2 2 0 0 1 2-2h6z'],
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  seat: ['M6 11V5h12v6', 'M4 11h16v4H4z', 'M6 15v5M18 15v5'],
  spark: ['M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6'],
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 24): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/** Создаёт SVG-элемент с атрибутами (для прогресс-кольца и т.п.). */
export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  return el;
}

/* ───────────────────────── Обратная связь ───────────────────────── */

type ToastKind = 'info' | 'success' | 'error';

function toastHost(): HTMLElement {
  let host = document.getElementById('toasts');
  if (!host) {
    host = h('div', { id: 'toasts', class: 'toasts', attrs: { 'aria-live': 'polite', role: 'status' } });
    document.body.append(host);
  }
  return host;
}

/** Короткое всплывающее сообщение; ошибки и успехи сопровождаются haptics. */
export function toast(message: string, kind: ToastKind = 'info'): void {
  if (kind === 'success') haptic.success();
  if (kind === 'error') haptic.error();
  const host = toastHost();
  const el = h('div', { class: ['toast', `toast--${kind}`] }, message);
  host.append(el);
  while (host.children.length > 3) host.firstElementChild?.remove();
  window.setTimeout(() => {
    el.classList.add('is-leaving');
    window.setTimeout(() => el.remove(), 250);
  }, kind === 'error' ? 4500 : 2800);
}

/** Скелетон-заглушки на время загрузки. */
export function skeleton(count = 3, height = 76): HTMLElement {
  const items: HTMLElement[] = [];
  for (let i = 0; i < count; i++) items.push(h('div', { class: 'skeleton', style: `height:${height}px` }));
  return h('div', { class: 'stack', attrs: { 'aria-busy': 'true', 'aria-label': 'Загрузка' } }, items);
}

interface EmptyOptions {
  emoji: string;
  title: string;
  text?: string;
  action?: { label: string; onClick: () => void };
}

/** Дружелюбное пустое состояние. */
export function emptyState(options: EmptyOptions): HTMLElement {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty__emoji', attrs: { 'aria-hidden': 'true' } }, options.emoji),
    h('div', { class: 'empty__title' }, options.title),
    options.text ? h('div', { class: 'empty__text' }, options.text) : null,
    options.action
      ? h('button', { type: 'button', class: 'btn btn--soft', on: { click: options.action.onClick } }, options.action.label)
      : null,
  );
}

/** Состояние ошибки загрузки с кнопкой «Повторить». */
export function errorState(message: string, retry?: () => void): HTMLElement {
  return emptyState({
    emoji: '🃏',
    title: 'Не удалось загрузить',
    text: message,
    action: retry ? { label: 'Повторить', onClick: retry } : undefined,
  });
}

/** Заголовок секции с необязательной ссылкой справа. */
export function sectionTitle(title: string, link?: { label: string; href: string }): HTMLElement {
  return h(
    'div',
    { class: 'section-title' },
    h('h2', null, title),
    link ? h('a', { class: 'section-title__link', href: link.href }, link.label) : null,
  );
}

/** Чип (дата, бай-ин, места). */
export function chip(iconName: IconName | null, text: string, tone?: 'gold' | 'felt' | 'live'): HTMLElement {
  return h('span', { class: ['chip', tone && `chip--${tone}`] }, iconName ? icon(iconName, 16) : null, text);
}

interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

/** Сегмент-контрол (переключатель вкладок внутри экрана). */
export function segmented<T extends string>(
  options: readonly SegmentOption<T>[],
  value: T,
  onChange: (value: T) => void,
  label = 'Переключатель',
): HTMLElement {
  const buttons = options.map((option) =>
    h(
      'button',
      {
        type: 'button',
        class: 'segmented__item',
        attrs: { 'aria-pressed': option.value === value },
        on: {
          click: () => {
            if (option.value === value) return;
            value = option.value;
            for (const [i, b] of buttons.entries()) b.setAttribute('aria-pressed', String(options[i]?.value === value));
            haptic.select();
            onChange(option.value);
          },
        },
      },
      option.label,
    ),
  );
  return h('div', { class: 'segmented', attrs: { role: 'group', 'aria-label': label } }, buttons);
}

interface SheetOptions {
  title: string;
  content: Child;
  /** Возвращает false, чтобы не закрывать окно (например, при ошибке валидации). */
  onSubmit?: () => Promise<boolean | void> | boolean | void;
  submitLabel?: string;
}

/** Bottom sheet на базе <dialog>: фокус-ловушка и Esc — бесплатно от браузера. */
export function openSheet(options: SheetOptions): { close: () => void } {
  const submit = h('button', { type: 'submit', class: 'btn btn--primary btn--block' }, options.submitLabel ?? 'Сохранить');
  const form = h(
    'form',
    { class: 'sheet__panel', method: 'dialog' },
    h(
      'div',
      { class: 'sheet__head' },
      h('h2', null, options.title),
      h(
        'button',
        { type: 'button', class: 'icon-btn', ariaLabel: 'Закрыть', on: { click: () => close() } },
        icon('close', 20),
      ),
    ),
    h('div', { class: 'sheet__body' }, options.content),
    options.onSubmit ? submit : null,
  );
  const dialog = h('dialog', { class: 'sheet' }, form);
  const close = (): void => {
    dialog.close();
  };
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!options.onSubmit) return close();
    submit.disabled = true;
    void Promise.resolve(options.onSubmit())
      .then((result) => {
        if (result !== false) close();
      })
      .finally(() => {
        submit.disabled = false;
      });
  });
  document.body.append(dialog);
  dialog.showModal();
  return { close };
}

/* ───────────────────────── Форматирование ───────────────────────── */

const formatters = new Map<string, Intl.DateTimeFormat>();

function dtf(options: Intl.DateTimeFormatOptions, tz = clubTz()): Intl.DateTimeFormat {
  const key = `${tz}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('ru-RU', { ...options, timeZone: tz });
    formatters.set(key, f);
  }
  return f;
}

/** Склонение: plural(5, 'игрок', 'игрока', 'игроков') → «игроков». */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function fmtNum(n: number): string {
  return n.toLocaleString('ru-RU');
}

/** «500 ₽» или «FREE». */
export function fmtMoney(rub: number): string {
  return rub === 0 ? 'FREE' : `${fmtNum(rub)} ₽`;
}

/** Ключ календарного дня (YYYY-MM-DD) в часовом поясе клуба. */
function dayKey(date: Date): string {
  return dtf({ year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** «19:00». */
export function fmtTime(iso: string): string {
  return dtf({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** «пт, 24 октября». */
export function fmtDate(iso: string): string {
  return dtf({ weekday: 'short', day: 'numeric', month: 'long' }).format(new Date(iso));
}

/** «Сегодня · 19:00», «Завтра · 19:00» или «пт, 24 октября · 19:00». */
export function fmtWhen(iso: string): string {
  const date = new Date(iso);
  const key = dayKey(date);
  const now = Date.now();
  let day: string;
  if (key === dayKey(new Date(now))) day = 'Сегодня';
  else if (key === dayKey(new Date(now + 86_400_000))) day = 'Завтра';
  else if (key === dayKey(new Date(now - 86_400_000))) day = 'Вчера';
  else day = fmtDate(iso);
  return `${day} · ${fmtTime(iso)}`;
}

/** Части даты для «календарного» блока карточки: { day: '24', month: 'окт' }. */
export function dateBlock(iso: string): { day: string; month: string } {
  const date = new Date(iso);
  return {
    day: dtf({ day: 'numeric' }).format(date),
    month: dtf({ month: 'short' }).format(date).replace('.', ''),
  };
}

/** «через 2 ч 14 мин», «через 3 дня 4 ч», «через 5 мин». */
export function fmtUntil(ms: number): string {
  if (ms <= 0) return 'уже начался';
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return 'меньше чем через минуту';
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const minutes = totalMin % 60;
  if (days > 0) return `через ${days} ${plural(days, 'день', 'дня', 'дней')}${hours ? ` ${hours} ч` : ''}`;
  if (hours > 0) return `через ${hours} ч${minutes ? ` ${minutes} мин` : ''}`;
  return `через ${minutes} мин`;
}

/** Таймер: «07:05» или «1:07:05». */
export function fmtTimer(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** «4 ч 20 мин» — длительность из минут. */
export function fmtDuration(totalMin: number): string {
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (!hours) return `${minutes} мин`;
  return minutes ? `${hours} ч ${minutes} мин` : `${hours} ч`;
}

/** Приветствие по времени суток в поясе клуба. */
export function greeting(): string {
  const hour = Number(dtf({ hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  if (hour >= 5 && hour < 12) return 'Доброе утро';
  if (hour >= 12 && hour < 18) return 'Добрый день';
  if (hour >= 18 && hour < 23) return 'Добрый вечер';
  return 'Доброй ночи';
}

/* ─────────────── Время клуба ↔ <input type="datetime-local"> ─────────────── */

function zonedParts(utcMs: number, tz: string): number[] {
  const parts = dtf(
    { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' },
    tz,
  ).formatToParts(new Date(utcMs));
  const pick = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return [pick('year'), pick('month'), pick('day'), pick('hour'), pick('minute'), pick('second')];
}

function tzOffsetMs(utcMs: number, tz: string): number {
  const [y = 0, mo = 1, d = 1, hh = 0, mi = 0, ss = 0] = zonedParts(utcMs, tz);
  return Date.UTC(y, mo - 1, d, hh, mi, ss) - Math.floor(utcMs / 1000) * 1000;
}

/** «2026-10-24T19:00» (время клуба) → ISO UTC. Null, если строка некорректна. */
export function clubInputToIso(value: string, tz = clubTz()): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  let ts = guess - tzOffsetMs(guess, tz);
  ts = guess - tzOffsetMs(ts, tz);
  return Number.isNaN(ts) ? null : new Date(ts).toISOString();
}

/** ISO UTC → значение для datetime-local во времени клуба. */
export function isoToClubInput(iso: string, tz = clubTz()): string {
  const [y = 0, mo = 1, d = 1, hh = 0, mi = 0] = zonedParts(new Date(iso).getTime(), tz);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)}T${p(hh)}:${p(mi)}`;
}

/** Перерисовать текущий экран (роутер слушает hashchange). */
export function refreshView(): void {
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
