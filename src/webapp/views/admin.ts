/**
 * Админка внутри Mini App:
 * - `#/admin` — список турниров по группам (черновики / активные / архив) и «Новый турнир»;
 * - `#/admin/new` — форма создания;
 * - `#/admin/t/:id` — управление: статус, часы, рассадка, результаты, записи; вкладка «Параметры» — форма.
 */
import type {
  AdminRegistration,
  BlindLevel,
  BlindTemplate,
  Bullet,
  ClockAction,
  GameType,
  ResultEntryInput,
  TournamentCard,
  TournamentDetail,
  TournamentInput,
  TournamentStatus,
} from '../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import { confirmDialog, haptic, setMainAction } from '../tg.ts';
import {
  clubInputToIso,
  emptyState,
  errorState,
  fmtNum,
  fmtTime,
  fmtWhen,
  h,
  icon,
  isoToClubInput,
  openSheet,
  plural,
  refreshView,
  sectionTitle,
  segmented,
  setChildren,
  skeleton,
  toast,
} from '../ui.ts';
import type { Cleanup, Params } from '../ui.ts';
import { clubTz } from '../state.ts';
import {
  DEFAULT_REMINDER_OFFSETS,
  EARLY_SEATING_MIN,
  EARLY_START_MIN,
  GAME_LABELS,
  MAX_DAYS_AHEAD,
  MAX_REMINDER_MIN,
  MAX_REMINDERS,
  REMINDER_PRESETS,
  START_GRACE_MIN,
  capacityError,
  earlySeatingError,
  earlyStartError,
  lateRegOptions,
  levelsError,
  reminderLabel,
  reminderOffsetsError,
  resultsTimeError,
  sameLevels,
  sameMinute,
  scheduleError,
  shortDuration,
  sortOffsets,
  stackError,
  structureMinutes,
} from '../../shared/rules.ts';
import type { TimeFormat } from '../../shared/rules.ts';
import { avatar, blindsText, clockWidget, statusBadge, tournamentCard } from '../widgets.ts';
import type { ClockWidget } from '../widgets.ts';

/* ───────────────────────── Мелкие помощники форм ───────────────────────── */

let fieldSeq = 0;

/** Поле формы: подпись + контрол + необязательная подсказка. */
function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const id = `f${++fieldSeq}`;
  control.id = id;
  return h(
    'div',
    { class: 'field' },
    h('label', { class: 'field__label', htmlFor: id }, label),
    control,
    hint ? h('p', { class: 'field__hint' }, hint) : null,
  );
}

interface NumOptions {
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  placeholder?: string;
}

function numInput(value: number | null | undefined, options: NumOptions = {}): HTMLInputElement {
  return h('input', {
    type: 'number',
    class: 'input tabular',
    inputMode: 'numeric',
    value: value === null || value === undefined ? '' : String(value),
    min: options.min === undefined ? '' : String(options.min),
    max: options.max === undefined ? '' : String(options.max),
    step: String(options.step ?? 1),
    required: options.required ?? false,
    placeholder: options.placeholder ?? '',
  });
}

/** Целое из числового поля; null — пусто или не число. */
function intOf(input: HTMLInputElement): number | null {
  if (input.value.trim() === '') return null;
  const n = input.valueAsNumber;
  return Number.isFinite(n) ? Math.round(n) : null;
}

function errorLine(): HTMLParagraphElement {
  return h('p', { class: 'field__error', hidden: true, attrs: { role: 'alert' } });
}

function showError(el: HTMLElement, message: string | null): void {
  el.textContent = message ?? '';
  el.hidden = !message;
  if (message) haptic.error();
}

/** Показывает ошибку и возвращает null — для коротких `return fail(...)` в валидации. */
function fail(el: HTMLElement, message: string): null {
  showError(el, message);
  return null;
}

/** Кнопка, которая на время асинхронного действия блокируется и показывает «занято». */
function actionButton(
  label: string,
  run: () => Promise<void>,
  options: { tone?: 'primary' | 'soft' | 'danger' | 'ghost'; iconName?: Parameters<typeof icon>[0] } = {},
): HTMLButtonElement {
  const button = h(
    'button',
    { type: 'button', class: ['btn', `btn--${options.tone ?? 'soft'}`] },
    options.iconName ? icon(options.iconName, 20) : null,
    label,
  );
  button.addEventListener('click', () => {
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add('is-busy');
    void run().finally(() => {
      button.disabled = false;
      button.classList.remove('is-busy');
    });
  });
  return button;
}

/* ───────────────────────── Пресеты структуры ───────────────────────── */

type LevelTuple = readonly [sb: number, bb: number, ante: number];

const LADDER: readonly LevelTuple[] = [
  [100, 200, 0],
  [200, 400, 0],
  [300, 600, 0],
  [400, 800, 800],
  [500, 1000, 1000],
  [600, 1200, 1200],
  [800, 1600, 1600],
  [1000, 2000, 2000],
  [1500, 3000, 3000],
  [2000, 4000, 4000],
  [3000, 6000, 6000],
  [4000, 8000, 8000],
  [5000, 10000, 10000],
  [6000, 12000, 12000],
  [8000, 16000, 16000],
  [10000, 20000, 20000],
];

/** Структура: уровни по `minutes` мин и перерыв `breakMin` после каждых `breakEvery` уровней. */
function preset(minutes: number, breakEvery: number, breakMin: number): BlindLevel[] {
  const levels: BlindLevel[] = [];
  LADDER.forEach(([sb, bb, ante], i) => {
    levels.push({ sb, bb, ante, minutes, isBreak: false });
    if ((i + 1) % breakEvery === 0 && i + 1 < LADDER.length) {
      levels.push({ sb: 0, bb: 0, ante: 0, minutes: breakMin, isBreak: true });
    }
  });
  return levels;
}

/** Округление до «красивых» значений блайндов. */
function niceRound(n: number): number {
  const step = n >= 10_000 ? 1000 : n >= 1000 ? 100 : n >= 100 ? 25 : 5;
  return Math.max(step, Math.round(n / step) * step);
}

/* ───────────────────────── Шаблоны структуры ───────────────────────── */

const TEMPLATE_NAME_MAX = 40;

/** Кэш списка шаблонов на время сессии (форма и список админки читают один запрос). */
let templatesCache: Promise<BlindTemplate[]> | null = null;

function loadTemplates(force = false): Promise<BlindTemplate[]> {
  if (force || !templatesCache) {
    const request = api.admin.templates();
    templatesCache = request;
    request.catch(() => {
      if (templatesCache === request) templatesCache = null;
    });
  }
  return templatesCache;
}

/** «19 ур. · 6 ч 20 мин» — игровые уровни и общая длительность с перерывами. */
function templateSummary(levels: readonly BlindLevel[]): string {
  const n = levels.filter((l) => !l.isBreak).length;
  return `${n} ур. · ${shortDuration(structureMinutes(levels))}`;
}

function templateLabel(t: BlindTemplate): string {
  return t.isDefault ? `★ ${t.name}` : t.name;
}

interface SaveTemplateOptions {
  /** Проверка структуры перед отправкой: текст ошибки или null. */
  check(): string | null;
  save(name: string, isDefault: boolean): Promise<BlindTemplate>;
  onSaved?(t: BlindTemplate): void;
}

/** Bottom sheet «Сохранить как шаблон»: название и «Сделать базовым». */
function openSaveTemplateSheet(opts: SaveTemplateOptions): void {
  const problem = opts.check();
  if (problem) {
    haptic.error();
    toast(problem, 'error');
    return;
  }
  const name = h('input', { class: 'input', required: true, maxLength: TEMPLATE_NAME_MAX, placeholder: 'Например, Пятничный дипстек' });
  const makeDefault = h('input', { type: 'checkbox', class: 'check__input' });
  const error = errorLine();
  openSheet({
    title: 'Сохранить как шаблон',
    submitLabel: 'Сохранить шаблон',
    content: h(
      'div',
      { class: 'stack' },
      field('Название', name, `До ${TEMPLATE_NAME_MAX} символов`),
      h('label', { class: 'check' }, makeDefault, h('span', null, 'Сделать базовым'), h('span', { class: 'check__hint' }, 'с него начнётся новый турнир')),
      error,
    ),
    onSubmit: async () => {
      const value = name.value.trim();
      if (!value || value.length > TEMPLATE_NAME_MAX) return fail(error, `Название — от 1 до ${TEMPLATE_NAME_MAX} символов`) ?? false;
      const again = opts.check();
      if (again) return fail(error, again) ?? false;
      try {
        const saved = await opts.save(value, makeDefault.checked);
        templatesCache = null;
        haptic.success();
        toast(`Шаблон «${saved.name}» сохранён`, 'success');
        opts.onSaved?.(saved);
        return true;
      } catch (e) {
        haptic.error();
        showError(error, errorMessage(e));
        return false;
      }
    },
  });
  name.focus();
}

/** Ошибка структуры для шаблона (те же правила, что на сервере) или null. */
function templateStructureError(levels: readonly BlindLevel[], startingStack: number | null): string | null {
  if (!levels.length) return 'Структура пуста — добавьте уровни';
  return levelsError(levels) ?? stackError({ startingStack, levels, reentries: [], addons: [] });
}

/* ───────────────────────── Редактор уровней блайндов ───────────────────────── */

interface Editor<T> {
  el: HTMLElement;
  /** Значения или текст ошибки. */
  read(): T[] | string;
}

interface LevelsEditor extends Editor<BlindLevel> {
  /** Тайминг уровней «как есть» (даже если блайнды ещё не заполнены) — для поздней регистрации. */
  peek(): BlindLevel[];
}

interface LevelsEditorOptions {
  onChange?: () => void;
  /** Стартовый стек из формы — сохраняется в шаблон. */
  getStack?: () => number | null;
  /** Подставить стек шаблона в форму. */
  setStack?: (stack: number) => void;
}

function blindLevelsEditor(initial: readonly BlindLevel[], options: LevelsEditorOptions = {}): LevelsEditor {
  const onChange = options.onChange ?? ((): void => {});
  interface Row {
    el: HTMLElement;
    isBreak: boolean;
    sb: HTMLInputElement;
    bb: HTMLInputElement;
    ante: HTMLInputElement;
    minutes: HTMLInputElement;
  }
  const rows: Row[] = [];
  const list = h('ol', { class: 'levels' });
  const summary = h('p', { class: 'field__hint tabular' });

  const renumber = (): void => {
    let n = 0;
    let total = 0;
    for (const row of rows) {
      if (!row.isBreak) n += 1;
      const num = row.el.querySelector<HTMLElement>('.level__num');
      if (num) num.textContent = row.isBreak ? '☕' : String(n);
      total += intOf(row.minutes) ?? 0;
    }
    const hours = Math.floor(total / 60);
    summary.textContent = rows.length
      ? `${n} ${plural(n, 'уровень', 'уровня', 'уровней')} · ${hours ? `${hours} ч ` : ''}${total % 60} мин`
      : 'Структура не задана — часы запустить не получится.';
    onChange();
  };

  const makeRow = (level: BlindLevel): Row => {
    const sb = numInput(level.isBreak ? null : level.sb, { min: 0, placeholder: 'SB' });
    const bb = numInput(level.isBreak ? null : level.bb, { min: 0, placeholder: 'BB' });
    const ante = numInput(level.isBreak ? null : level.ante, { min: 0, placeholder: 'Анте' });
    const minutes = numInput(level.minutes, { min: 1, max: 240, required: true, placeholder: 'Мин' });
    sb.ariaLabel = 'Малый блайнд';
    bb.ariaLabel = 'Большой блайнд';
    ante.ariaLabel = 'Анте';
    minutes.ariaLabel = 'Минут';
    // Удобство: ввели SB — BB подставится как 2×SB, если BB ещё пуст.
    sb.addEventListener('change', () => {
      const v = intOf(sb);
      if (v !== null && bb.value === '') bb.value = String(v * 2);
    });
    minutes.addEventListener('input', renumber);

    const row: Row = {
      el: h('li'),
      isBreak: level.isBreak,
      sb,
      bb,
      ante,
      minutes,
    };
    const remove = h(
      'button',
      {
        type: 'button',
        class: 'icon-btn icon-btn--sm',
        ariaLabel: 'Удалить уровень',
        on: {
          click: () => {
            const i = rows.indexOf(row);
            if (i >= 0) rows.splice(i, 1);
            row.el.remove();
            renumber();
          },
        },
      },
      icon('close', 18),
    );
    row.el = h(
      'li',
      { class: ['level', level.isBreak && 'level--break'] },
      h('span', { class: 'level__num tabular', attrs: { 'aria-hidden': 'true' } }),
      level.isBreak
        ? h('span', { class: 'level__break-label' }, 'Перерыв')
        : h('span', { class: 'level__inputs' }, sb, bb, ante),
      h('span', { class: 'level__minutes' }, minutes, h('span', { class: 'level__unit' }, 'мин')),
      remove,
    );
    return row;
  };

  const setAll = (levels: readonly BlindLevel[]): void => {
    rows.length = 0;
    for (const level of levels) rows.push(makeRow(level));
    setChildren(list, rows.map((r) => r.el));
    renumber();
  };

  const addLevel = (isBreak: boolean): void => {
    const last = [...rows].reverse().find((r) => !r.isBreak);
    let level: BlindLevel;
    if (isBreak) {
      level = { sb: 0, bb: 0, ante: 0, minutes: 10, isBreak: true };
    } else if (last) {
      // Следующий уровень ≈ ×1.5 от предыдущего.
      const sb = niceRound((intOf(last.sb) ?? 100) * 1.5);
      const lastAnte = intOf(last.ante) ?? 0;
      level = { sb, bb: sb * 2, ante: lastAnte ? sb * 2 : 0, minutes: intOf(last.minutes) ?? 20, isBreak: false };
    } else {
      level = { sb: 100, bb: 200, ante: 0, minutes: 20, isBreak: false };
    }
    const row = makeRow(level);
    rows.push(row);
    list.append(row.el);
    renumber();
    row.el.querySelector<HTMLInputElement>('input')?.focus();
  };

  /* Шаблоны: строка сохранённых структур (★ — базовый) и «Сохранить как шаблон». */
  const templateRow = h('div', { class: 'pick-row editor__templates-row' });
  const templateHint = h('p', { class: 'field__hint' }, 'Сохраните структуру, чтобы применять её в один тап.');
  const applyTemplate = async (t: BlindTemplate): Promise<void> => {
    if (rows.length && !(await confirmDialog(`Заменить структуру шаблоном «${t.name}»?`))) return;
    setAll(t.levels);
    if (t.startingStack !== null) options.setStack?.(t.startingStack);
    // Шаблон из старых данных мог перестать проходить текущие правила — сразу говорим, что поправить.
    const problem = templateStructureError(t.levels, t.startingStack ?? options.getStack?.() ?? null);
    if (problem) {
      haptic.error();
      toast(`Шаблон «${t.name}» нужно поправить: ${problem}`, 'error');
      return;
    }
    haptic.select();
    toast(`Структура из шаблона «${t.name}»`, 'success');
  };
  const drawTemplates = (list: readonly BlindTemplate[]): void => {
    templateRow.hidden = !list.length;
    templateHint.hidden = list.length > 0;
    setChildren(
      templateRow,
      list.map((t) =>
        h('button', { type: 'button', class: 'pick editor__template', title: t.name, on: { click: () => void applyTemplate(t) } }, templateLabel(t)),
      ),
    );
  };
  const refreshTemplates = (force = false): void => {
    loadTemplates(force)
      .then(drawTemplates)
      .catch(() => {
        templateHint.textContent = 'Не удалось загрузить шаблоны.';
      });
  };
  const saveTemplate = (): void => {
    let levels: BlindLevel[] = [];
    const stackNow = (): number | null => options.getStack?.() ?? null;
    openSaveTemplateSheet({
      check: () => {
        const lv = readLevels();
        if (typeof lv === 'string') return lv;
        levels = lv;
        return templateStructureError(lv, stackNow());
      },
      save: (name, isDefault) => api.admin.createTemplate({ name, levels, startingStack: stackNow(), isDefault }),
      onSaved: () => refreshTemplates(true),
    });
  };
  templateRow.hidden = true;

  setAll(initial);

  const el = h(
    'div',
    { class: 'editor' },
    h(
      'div',
      { class: 'editor__templates' },
      h(
        'div',
        { class: 'editor__templates-head' },
        h('span', { class: 'field__label' }, 'Шаблоны'),
        h('button', { type: 'button', class: 'btn btn--ghost btn--sm editor__save-template', on: { click: saveTemplate } }, h('span', { attrs: { 'aria-hidden': 'true' } }, '💾'), 'Сохранить как шаблон'),
      ),
      templateRow,
      templateHint,
    ),
    h(
      'div',
      { class: 'levels__head', attrs: { 'aria-hidden': 'true' } },
      h('span', null, '#'),
      h('span', null, 'SB'),
      h('span', null, 'BB'),
      h('span', null, 'Анте'),
      h('span', null, 'Мин'),
      h('span'),
    ),
    list,
    summary,
    h(
      'div',
      { class: 'editor__toolbar' },
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', on: { click: () => addLevel(false) } }, icon('plus', 16), 'Уровень'),
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', on: { click: () => addLevel(true) } }, icon('plus', 16), 'Перерыв'),
    ),
  );

  refreshTemplates();

  return {
    el,
    peek() {
      return rows.map((r) => ({ sb: 0, bb: 0, ante: 0, minutes: intOf(r.minutes) ?? 0, isBreak: r.isBreak }));
    },
    read: readLevels,
  };

  /** Значения уровней или текст ошибки (вызывается и из «Сохранить как шаблон»). */
  function readLevels(): BlindLevel[] | string {
    const out: BlindLevel[] = [];
    let n = 0;
    for (const row of rows) {
      const minutes = intOf(row.minutes);
      if (minutes === null || minutes < 1 || minutes > 240) return 'Длительность уровня — от 1 до 240 минут';
      if (row.isBreak) {
        out.push({ sb: 0, bb: 0, ante: 0, minutes, isBreak: true });
        continue;
      }
      n += 1;
      const sb = intOf(row.sb);
      const bb = intOf(row.bb);
      const ante = intOf(row.ante) ?? 0;
      if (sb === null || bb === null || sb < 0 || bb <= 0 || ante < 0) return `Уровень ${n}: укажите блайнды`;
      out.push({ sb, bb, ante, minutes, isBreak: false });
    }
    // Логика структуры (рост блайндов, анте, перерывы) проверяется при сохранении — общими правилами.
    return out;
  }
}

/* ───────────────────────── Редактор ре-энтри / add-on ───────────────────────── */

function bulletsEditor(initial: readonly Bullet[], noun: string): Editor<Bullet> {
  interface Row {
    el: HTMLElement;
    stack: HTMLInputElement;
    price: HTMLInputElement;
    note: HTMLInputElement;
  }
  const rows: Row[] = [];
  const list = h('div', { class: 'bullets' });

  const add = (b: Bullet | null): Row => {
    const stack = numInput(b?.stack, { min: 1, placeholder: 'Фишек' });
    const price = numInput(b?.price, { min: 0, placeholder: '₽' });
    const note = h('input', { class: 'input', value: b?.note ?? '', maxLength: 200, placeholder: 'Условие (необязательно)' });
    stack.ariaLabel = 'Фишек';
    price.ariaLabel = 'Цена, ₽';
    note.ariaLabel = 'Условие';
    const row: Row = { el: h('div'), stack, price, note };
    row.el = h(
      'div',
      { class: 'bullet' },
      h('div', { class: 'bullet__nums' }, stack, price),
      note,
      h(
        'button',
        {
          type: 'button',
          class: 'icon-btn icon-btn--sm',
          ariaLabel: `Удалить ${noun}`,
          on: {
            click: () => {
              rows.splice(rows.indexOf(row), 1);
              row.el.remove();
            },
          },
        },
        icon('close', 18),
      ),
    );
    rows.push(row);
    list.append(row.el);
    return row;
  };
  for (const b of initial) add(b);

  const el = h(
    'div',
    { class: 'editor' },
    list,
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        on: { click: () => add(null).stack.focus() },
      },
      icon('plus', 16),
      `Добавить ${noun}`,
    ),
  );

  return {
    el,
    read() {
      const out: Bullet[] = [];
      for (const [i, row] of rows.entries()) {
        const stack = intOf(row.stack);
        const price = intOf(row.price);
        if (stack === null && price === null && !row.note.value.trim()) continue;
        if (stack === null || stack <= 0) return `${noun} ${i + 1}: укажите количество фишек`;
        if (price === null || price < 0) return `${noun} ${i + 1}: укажите цену`;
        out.push({ stack, price, note: row.note.value.trim() });
      }
      return out;
    },
  };
}

/* ───────────────────────── Выбор даты и времени ───────────────────────── */

const MINUTE_MS = 60_000;
const DAY_CHIPS = 14;
const TIME_PRESETS = ['18:00', '18:30', '19:00', '19:30', '20:00', '21:00'] as const;

/** «YYYY-MM-DD» в часовом поясе клуба, сдвинутое на offsetDays от сегодня. */
function clubDay(offsetDays = 0): string {
  return isoToClubInput(new Date(Date.now() + offsetDays * 86_400_000).toISOString()).slice(0, 10);
}

/** Подписи кнопки дня: верх — «Сегодня»/«Завтра»/«пт», низ — число. */
function dayLabels(date: string): { top: string; day: string } {
  const noonIso = clubInputToIso(`${date}T12:00`) ?? new Date().toISOString();
  const fmt = (o: Intl.DateTimeFormatOptions): string =>
    new Intl.DateTimeFormat('ru-RU', { ...o, timeZone: clubTz() }).format(new Date(noonIso));
  const top = date === clubDay(0) ? 'Сегодня' : date === clubDay(1) ? 'Завтра' : fmt({ weekday: 'short' }).replace('.', '');
  return { top, day: fmt({ day: 'numeric' }) };
}

/** «Пт, 23 октября · 19:00» во времени клуба (коротко, чтобы помещалось в строку). */
function fmtFullWhen(iso: string): string {
  const f = new Intl.DateTimeFormat('ru-RU', {
    weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: clubTz(),
  }).formatToParts(new Date(iso));
  const get = (t: Intl.DateTimeFormatPartTypes): string => f.find((p) => p.type === t)?.value ?? '';
  const weekday = get('weekday').replace('.', '');
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${get('day')} ${get('month')} · ${get('hour')}:${get('minute')}`;
}

/** «через 3 дня», «через 5 ч 20 мин», «уже прошло». */
function fmtRelative(iso: string): string {
  const diffMin = Math.round((Date.parse(iso) - Date.now()) / MINUTE_MS);
  if (diffMin < -START_GRACE_MIN) return 'уже прошло';
  if (diffMin < 60) return diffMin <= 0 ? 'прямо сейчас' : `через ${diffMin} мин`;
  const hours = Math.floor(diffMin / 60);
  // Минуты важны только когда старт совсем скоро.
  if (hours < 3) return `через ${hours} ч${diffMin % 60 ? ` ${diffMin % 60} мин` : ''}`;
  if (hours < 24) return `через ${hours} ч`;
  const days = Math.round(hours / 24);
  return `через ${days} ${plural(days, 'день', 'дня', 'дней')}`;
}

interface StartPicker {
  el: HTMLElement;
  /** ISO старта или null, если дата/время не заданы. */
  value(): string | null;
}

/**
 * Старт турнира: обычные поля даты и времени (можно ввести что угодно) +
 * кнопки-подсказки ближайших дней и частого времени. Прошлое не блокируется —
 * только подсвечивается; решает общая проверка при сохранении.
 */
function startPicker(initialIso: string | null, warnPast: boolean, onChange: () => void): StartPicker {
  const initial = initialIso ? isoToClubInput(initialIso) : `${clubDay(1)}T19:00`;
  const dateInput = h('input', { type: 'date', class: 'input tabular', value: initial.slice(0, 10), required: true, max: clubDay(MAX_DAYS_AHEAD - 1) });
  const timeInput = h('input', { type: 'time', class: 'input tabular', value: initial.slice(11, 16), required: true, step: '60' });
  dateInput.ariaLabel = 'Дата старта';
  timeInput.ariaLabel = 'Время старта';
  const dayRow = h('div', { class: 'pick-row', attrs: { role: 'group', 'aria-label': 'Быстрый выбор дня' } });
  const timeRow = h('div', { class: 'pick-row', attrs: { role: 'group', 'aria-label': 'Быстрый выбор времени' } });
  const summary = h('p', { class: 'pick-summary tabular', attrs: { 'aria-live': 'polite' } });

  const iso = (): string | null =>
    /^\d{4}-\d{2}-\d{2}$/.test(dateInput.value) && /^\d{2}:\d{2}$/.test(timeInput.value)
      ? clubInputToIso(`${dateInput.value}T${timeInput.value}`)
      : null;
  const pickButton = (content: Array<HTMLElement | string>, active: boolean, onClick: () => void, extra?: string): HTMLButtonElement =>
    h('button', { type: 'button', class: ['pick', extra, active && 'is-active'], attrs: { 'aria-pressed': active }, on: { click: onClick } }, ...content);

  const render = (): void => {
    setChildren(
      dayRow,
      ...Array.from({ length: DAY_CHIPS }, (_, i) => clubDay(i)).map((d) => {
        const l = dayLabels(d);
        return pickButton(
          [h('span', { class: 'pick__top' }, l.top), h('span', { class: 'pick__day tabular' }, l.day)],
          d === dateInput.value,
          () => {
            dateInput.value = d;
            changed();
          },
          'pick--day',
        );
      }),
    );
    setChildren(
      timeRow,
      ...TIME_PRESETS.map((t) =>
        pickButton([t], t === timeInput.value, () => {
          timeInput.value = t;
          changed();
        }, 'tabular'),
      ),
    );
    const v = iso();
    const past = warnPast && v !== null && Date.parse(v) < Date.now() - START_GRACE_MIN * MINUTE_MS;
    summary.classList.toggle('is-error', past);
    summary.textContent = v ? `${fmtFullWhen(v)} · ${fmtRelative(v)}` : 'Укажите дату и время';
  };

  const changed = (): void => {
    haptic.select();
    render();
    onChange();
  };
  dateInput.addEventListener('change', changed);
  timeInput.addEventListener('change', changed);

  render();
  return {
    el: h(
      'div',
      { class: 'stack' },
      h('div', { class: 'form-grid' }, field('Дата', dateInput), field('Время', timeInput, 'Время клуба')),
      dayRow,
      timeRow,
      summary,
    ),
    value: iso,
  };
}

interface LateRegPicker {
  el: HTMLElement;
  /** ISO окончания поздней регистрации, null — без поздней; строка — ошибка выбора. */
  value(): string | null | { error: string };
  /** Пересчитать варианты (изменился старт или структура). */
  refresh(): void;
}

/**
 * Поздняя регистрация: «до конца уровня N» (время считается из структуры) или «Своё время» —
 * любая дата и время. Своё время хранится как сдвиг от старта: при переносе старта поздняя
 * регистрация переезжает вместе с ним и сохраняет длительность.
 */
function lateRegPicker(initialIso: string | null, initialStartIso: string | null, getStart: () => string | null, getLevels: () => BlindLevel[]): LateRegPicker {
  type Choice = { kind: 'none' } | { kind: 'level'; level: number } | { kind: 'custom'; offsetMin: number };
  const select = h('select', { class: 'input select tabular' });
  const customDate = h('input', { type: 'date', class: 'input tabular' });
  const customTime = h('input', { type: 'time', class: 'input tabular', step: '60' });
  customDate.ariaLabel = 'Дата окончания поздней регистрации';
  customTime.ariaLabel = 'Время окончания поздней регистрации';
  const customRow = h('div', { class: 'form-grid' }, customDate, customTime);
  const hint = h('p', { class: 'field__hint tabular' });

  let chosen: Choice = { kind: 'none' };
  if (initialIso && initialStartIso) {
    const offset = Math.round((Date.parse(initialIso) - Date.parse(initialStartIso)) / MINUTE_MS);
    const match = lateRegOptions(getLevels()).find((o) => o.offsetMin === offset);
    chosen = match ? { kind: 'level', level: match.level } : { kind: 'custom', offsetMin: offset };
  }

  const startMs = (): number | null => {
    const s = getStart();
    return s ? Date.parse(s) : null;
  };

  const value = (): string | null | { error: string } => {
    const start = startMs();
    if (chosen.kind === 'none' || start === null) return null;
    if (chosen.kind === 'custom') return new Date(start + chosen.offsetMin * MINUTE_MS).toISOString();
    const level = chosen.level;
    const opt = lateRegOptions(getLevels()).find((o) => o.level === level);
    if (!opt) return { error: `Поздняя регистрация выбрана до конца ${level}-го уровня, а такого уровня больше нет — выберите заново` };
    return new Date(start + opt.offsetMin * MINUTE_MS).toISOString();
  };

  /** Показать своё время в полях (из сдвига относительно текущего старта). */
  const syncCustomInputs = (): void => {
    const start = startMs();
    if (chosen.kind !== 'custom' || start === null) return;
    const local = isoToClubInput(new Date(start + chosen.offsetMin * MINUTE_MS).toISOString());
    customDate.value = local.slice(0, 10);
    customTime.value = local.slice(11, 16);
  };

  const refresh = (): void => {
    const start = startMs();
    const opts = lateRegOptions(getLevels());
    const at = (offsetMin: number): string => (start !== null ? ` · до ${fmtTime(new Date(start + offsetMin * MINUTE_MS).toISOString())}` : '');
    const levelMissing = chosen.kind === 'level' && !opts.some((o) => o.level === (chosen as { level: number }).level);
    setChildren(
      select,
      h('option', { value: 'none', selected: chosen.kind === 'none' }, 'Без поздней регистрации'),
      ...opts.map((o) => h('option', { value: `level:${o.level}`, selected: chosen.kind === 'level' && chosen.level === o.level }, `До конца ${o.level}-го уровня${at(o.offsetMin)}`)),
      levelMissing ? h('option', { value: 'missing', selected: true, disabled: true }, `До конца ${(chosen as { level: number }).level}-го уровня — уровень удалён`) : null,
      h('option', { value: 'custom', selected: chosen.kind === 'custom' }, 'Своё время…'),
    );
    customRow.hidden = chosen.kind !== 'custom';
    syncCustomInputs();
    const v = value();
    hint.classList.toggle('is-error', typeof v === 'object' && v !== null);
    hint.textContent =
      typeof v === 'object' && v !== null
        ? v.error
        : v
          ? `Регистрация закроется ${fmtWhen(v).toLowerCase()}`
          : 'Записаться можно только до старта';
  };

  select.addEventListener('change', () => {
    const v = select.value;
    if (v === 'none') chosen = { kind: 'none' };
    else if (v.startsWith('level:')) chosen = { kind: 'level', level: Number(v.slice(6)) };
    else if (v === 'custom') {
      // По умолчанию — через 2 часа после старта; дальше админ ставит что угодно.
      const prev = value();
      const start = startMs();
      const offset = typeof prev === 'string' && start !== null ? Math.round((Date.parse(prev) - start) / MINUTE_MS) : 120;
      chosen = { kind: 'custom', offsetMin: offset };
    }
    refresh();
  });
  const customChanged = (): void => {
    const start = startMs();
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(customDate.value) && /^\d{2}:\d{2}$/.test(customTime.value)
      ? clubInputToIso(`${customDate.value}T${customTime.value}`)
      : null;
    if (iso && start !== null) chosen = { kind: 'custom', offsetMin: Math.round((Date.parse(iso) - start) / MINUTE_MS) };
    refresh();
  };
  customDate.addEventListener('change', customChanged);
  customTime.addEventListener('change', customChanged);

  refresh();
  return { el: field('Поздняя регистрация', h('div', { class: 'stack stack--sm' }, select, customRow, hint)), value, refresh };
}

/* ───────────────────────── Напоминания ───────────────────────── */

interface RemindersPicker {
  el: HTMLElement;
  /** Минуты до старта (по убыванию) или текст ошибки. */
  value(): number[] | string;
}

/**
 * Напоминания игрокам: пресеты-чипы с множественным выбором (одна строка, горизонтальная
 * прокрутка — без переносов) + «Своё…» (минуты или часы). Выбранные нестандартные значения
 * показываются отдельными чипами, тап — убрать.
 */
function remindersPicker(initial: readonly number[]): RemindersPicker {
  const selected = new Set<number>(initial);
  const row = h('div', { class: 'pick-row', attrs: { role: 'group', 'aria-label': 'Когда напомнить' } });
  const summary = h('p', { class: 'field__hint' });
  const amount = numInput(null, { min: 1, placeholder: 'Сколько' });
  amount.ariaLabel = 'Своё напоминание: сколько';
  const unit = h(
    'select',
    { class: 'input select', ariaLabel: 'Единицы' },
    h('option', { value: '60' }, 'ч'),
    h('option', { value: '1' }, 'мин'),
  );
  const addButton = h('button', { type: 'button', class: 'btn btn--soft btn--sm' }, 'Добавить');
  const customRow = h('div', { class: 'remind-custom', hidden: true }, amount, unit, addButton);
  const error = errorLine();
  let customOpen = false;

  const toggle = (minutes: number): void => {
    if (selected.has(minutes)) selected.delete(minutes);
    else if (selected.size >= MAX_REMINDERS) return void showError(error, `Напоминаний — не больше ${MAX_REMINDERS}`);
    else selected.add(minutes);
    showError(error, null);
    haptic.select();
    render();
  };

  const chip = (label: string, active: boolean, onClick: () => void, extra?: HTMLElement): HTMLButtonElement =>
    h('button', { type: 'button', class: ['pick', active && 'is-active'], attrs: { 'aria-pressed': active }, on: { click: onClick } }, label, extra ?? null);

  const render = (): void => {
    const presetSet = new Set(REMINDER_PRESETS.map((p) => p.minutes));
    const custom = sortOffsets([...selected].filter((m) => !presetSet.has(m)));
    setChildren(
      row,
      ...REMINDER_PRESETS.map((p) => chip(p.label, selected.has(p.minutes), () => toggle(p.minutes))),
      ...custom.map((m) => chip(reminderLabel(m), true, () => toggle(m), h('span', { class: 'pick__x', attrs: { 'aria-hidden': 'true' } }, '×'))),
      chip('Своё…', customOpen, () => {
        customOpen = !customOpen;
        customRow.hidden = !customOpen;
        render();
        if (customOpen) amount.focus();
      }),
    );
    const list = sortOffsets([...selected]);
    summary.textContent = list.length ? `Бот напомнит ${list.map(reminderLabel).join(', ')} до старта` : 'Без напоминаний';
  };

  addButton.addEventListener('click', () => {
    const n = intOf(amount);
    const minutes = n === null ? null : n * Number(unit.value);
    if (minutes === null || minutes <= 0) return void showError(error, 'Укажите, за сколько напомнить');
    if (minutes > MAX_REMINDER_MIN) return void showError(error, 'Напоминание — не раньше чем за 7 дней до старта');
    if (selected.has(minutes)) return void showError(error, 'Такое напоминание уже есть');
    if (selected.size >= MAX_REMINDERS) return void showError(error, `Напоминаний — не больше ${MAX_REMINDERS}`);
    selected.add(minutes);
    amount.value = '';
    customOpen = false;
    customRow.hidden = true;
    showError(error, null);
    haptic.success();
    render();
  });

  render();
  return {
    el: h('div', { class: 'field' }, h('span', { class: 'field__label' }, 'Напоминания'), row, customRow, summary, error),
    value() {
      const list = sortOffsets([...selected]);
      return reminderOffsetsError(list) ?? list;
    },
  };
}

/* ───────────────────────── Время в текстах правил ───────────────────────── */

/** `TimeFormat` для общих правил: «19:00» и «24 октября» (если не сегодня) в поясе клуба. */
function clubFormat(): TimeFormat {
  const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: clubTz() });
  const today = dayFmt.format(new Date());
  return {
    time: fmtTime,
    day: (iso) => {
      const d = dayFmt.format(new Date(iso));
      return d === today ? null : d;
    },
  };
}

/** Проверка времени перед действием: ошибка — toast и false. */
function timeOk(problem: string | null): boolean {
  if (!problem) return true;
  haptic.error();
  toast(problem, 'error');
  return false;
}

/** Однострочная подсказка «доступно с …», если действие пока рано. */
function earlyHint(startsAt: string, minutes: number, label: string): HTMLElement | null {
  const from = Date.parse(startsAt) - minutes * MINUTE_MS;
  if (Date.now() >= from) return null;
  const iso = new Date(from).toISOString();
  return h('p', { class: 'action-hint tabular' }, `${label} — ${fmtWhen(iso).toLowerCase()}`);
}

/* ───────────────────────── Форма турнира ───────────────────────── */

interface TournamentForm {
  el: HTMLFormElement;
  submit(): void;
}

/** Начальная структура нового турнира (из базового шаблона). */
interface FormDefaults {
  levels: BlindLevel[];
  startingStack: number | null;
}

function tournamentForm(
  initial: TournamentDetail | null,
  save: (input: TournamentInput) => Promise<void>,
  defaults: FormDefaults | null = null,
): TournamentForm {
  const title = h('input', { class: 'input', value: initial?.title ?? '', required: true, minLength: 2, maxLength: 80, placeholder: 'Например, Friday Deepstack' });
  const subtitle = h('input', { class: 'input', value: initial?.subtitle ?? '', maxLength: 120, placeholder: 'Короткая строка под названием' });
  const description = h('textarea', { class: 'input textarea', value: initial?.description ?? '', maxLength: 4000, rows: 4, placeholder: 'Правила, адрес, что взять с собой' });
  const capacity = numInput(initial?.capacity ?? 27, { min: 2, max: 1000, required: true });
  const buyIn = numInput(initial?.buyIn ?? 0, { min: 0, max: 10_000_000, required: true });
  const stack = numInput(initial ? initial.startingStack : (defaults?.startingStack ?? 20_000), { min: 1, placeholder: 'Не указан' });
  const koPoints = numInput(initial?.knockoutPoints ?? 0, { min: 0, max: 1000 });
  const tableSize = numInput(initial?.tableSize ?? 9, { min: 2, max: 10, required: true });
  const dealer = h('input', { class: 'input', value: initial?.dealer ?? '', maxLength: 80, placeholder: 'Например, Анна' });
  const openNow = h('input', { type: 'checkbox', class: 'check__input', checked: true });
  const announceNow = h('input', { type: 'checkbox', class: 'check__input', checked: true });
  const announceRow = h('label', { class: 'check' }, announceNow, h('span', null, 'Отправить анонс игрокам'), h('span', { class: 'check__hint' }, 'всем, кто подписан на анонсы'));
  openNow.addEventListener('change', () => {
    announceRow.hidden = !openNow.checked;
  });
  const reminders = remindersPicker(initial?.reminderOffsets ?? DEFAULT_REMINDER_OFFSETS);
  let game: GameType = initial?.game ?? 'nlh';
  const gameHint = h('p', { class: 'field__hint' }, GAME_LABELS[game]);
  const gameSwitch = segmented<GameType>(
    [
      { value: 'nlh', label: 'No-Limit' },
      { value: 'plh', label: 'Pot-Limit' },
      { value: 'flh', label: 'Fixed-Limit' },
    ],
    game,
    (v) => {
      game = v;
      gameHint.textContent = GAME_LABELS[v];
    },
    'Разновидность холдема',
  );

  // Поздняя регистрация зависит и от старта, и от структуры — пересчитываем при любом изменении.
  let lateReg: LateRegPicker | null = null;
  const refreshLate = (): void => lateReg?.refresh();
  // Предупреждать о прошлом, только пока турнир не начался (идущему/завершённому прошлое нормально).
  const notStarted = !initial || initial.status === 'draft' || initial.status === 'registration';
  const start = startPicker(initial?.startsAt ?? null, notStarted, refreshLate);
  const levels = blindLevelsEditor(initial?.blindLevels ?? defaults?.levels ?? preset(20, 4, 10), {
    onChange: refreshLate,
    getStack: () => intOf(stack),
    setStack: (value) => {
      stack.value = String(value);
    },
  });
  lateReg = lateRegPicker(initial?.lateRegUntil ?? null, initial?.startsAt ?? null, start.value, () => levels.peek());
  const reentries = bulletsEditor(initial?.reentries ?? [], 'ре-энтри');
  const addons = bulletsEditor(initial?.addons ?? [], 'add-on');
  const error = errorLine();

  const form = h(
    'form',
    { class: 'stack stack--lg admin-form', },
    h(
      'section',
      { class: 'card card--pad stack' },
      field('Название', title),
      field('Подзаголовок', subtitle),
      field('Описание', description),
    ),
    h(
      'section',
      { class: 'card card--pad stack' },
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, 'Игра'), gameSwitch, gameHint),
      start.el,
      lateReg.el,
      h(
        'div',
        { class: 'form-grid' },
        field('Мест', capacity),
        field('Бай-ин, ₽', buyIn, '0 — бесплатно'),
        field('Стартовый стек', stack),
        field('Очков за нокаут', koPoints),
        field('Игроков за столом', tableSize, 'От 2 до 10'),
        field('Дилер', dealer, 'Пусто — не показывать'),
      ),
      reminders.el,
      initial
        ? null
        : h('label', { class: 'check' }, openNow, h('span', null, 'Сразу открыть регистрацию'), h('span', { class: 'check__hint' }, 'иначе сохранится черновиком')),
      initial ? null : announceRow,
    ),
    h('section', null, sectionTitle('Структура блайндов'), h('div', { class: 'card card--pad' }, levels.el)),
    h('section', null, sectionTitle('Ре-энтри'), h('div', { class: 'card card--pad' }, reentries.el)),
    h('section', null, sectionTitle('Add-on'), h('div', { class: 'card card--pad' }, addons.el)),
    error,
  );

  /** Собирает и проверяет ввод; при ошибке показывает её и возвращает null. */
  const collect = (): TournamentInput | null => {
    if (!form.reportValidity()) {
      haptic.error();
      return null;
    }
    const startIso = start.value();
    if (!startIso) return fail(error, 'Укажите дату и время старта');
    const late = lateReg?.value() ?? null;
    if (late !== null && typeof late === 'object') return fail(error, late.error);
    const lateIso = late;
    const lv = levels.read();
    if (typeof lv === 'string') return fail(error, lv);
    // Те же правила, что на сервере: проверяем, только если время/структура реально менялись,
    // будущее время требуем для нового турнира и при переносе даты (с точностью до минуты).
    const moved = !initial || !sameMinute(startIso, initial.startsAt);
    const changed =
      !initial || moved || !sameMinute(lateIso, initial.lateRegUntil) || !sameLevels(lv, initial.blindLevels);
    if (changed) {
      const levelsProblem = levelsError(lv);
      if (levelsProblem) return fail(error, levelsProblem);
      const timeProblem = scheduleError({ startsAt: startIso, lateRegUntil: lateIso, levels: lv, now: Date.now(), requireFuture: notStarted && moved });
      if (timeProblem) return fail(error, timeProblem);
    }
    const re = reentries.read();
    if (typeof re === 'string') return fail(error, re);
    const ad = addons.read();
    if (typeof ad === 'string') return fail(error, ad);
    const perTable = intOf(tableSize);
    if (perTable === null || perTable < 2 || perTable > 10) return fail(error, 'За столом может быть от 2 до 10 игроков');
    const startingStack = intOf(stack);
    const stacksChanged =
      !initial ||
      startingStack !== initial.startingStack ||
      !sameLevels(lv, initial.blindLevels) ||
      JSON.stringify(re) !== JSON.stringify(initial.reentries) ||
      JSON.stringify(ad) !== JSON.stringify(initial.addons);
    if (stacksChanged) {
      const stackProblem = stackError({ startingStack, levels: lv, reentries: re, addons: ad });
      if (stackProblem) return fail(error, stackProblem);
    }
    const seats = intOf(capacity) ?? 2;
    if (initial && seats !== initial.capacity) {
      const capProblem = capacityError(seats, initial.registeredCount);
      if (capProblem) return fail(error, capProblem);
    }
    const offsets = reminders.value();
    if (typeof offsets === 'string') return fail(error, offsets);
    showError(error, null);

    const input: TournamentInput = {
      title: title.value.trim(),
      subtitle: subtitle.value.trim(),
      description: description.value.trim(),
      game,
      startsAt: startIso,
      lateRegUntil: lateIso,
      capacity: seats,
      buyIn: intOf(buyIn) ?? 0,
      startingStack,
      knockoutPoints: intOf(koPoints) ?? 0,
      tableSize: perTable,
      dealer: dealer.value.trim(),
      blindLevels: lv,
      reentries: re,
      addons: ad,
      reminderOffsets: offsets,
    };
    if (!initial) {
      input.status = openNow.checked ? 'registration' : 'draft';
      if (openNow.checked) input.announce = announceNow.checked;
    }
    return input;
  };

  let saving = false;
  const submit = (): void => {
    if (saving) return;
    const input = collect();
    if (!input) return;
    saving = true;
    void save(input)
      .catch((e: unknown) => showError(error, errorMessage(e)))
      .finally(() => {
        saving = false;
      });
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });

  return { el: form, submit };
}

/* ───────────────────────── Список ───────────────────────── */

const GROUPS: readonly { title: string; statuses: readonly TournamentStatus[] }[] = [
  { title: 'Идут и открыты', statuses: ['running', 'registration'] },
  { title: 'Черновики', statuses: ['draft'] },
  { title: 'Архив', statuses: ['completed', 'cancelled'] },
];

function adminCard(card: TournamentCard): HTMLElement {
  const el = tournamentCard(card, `#/admin/t/${card.id}`);
  // В админке статус показываем всегда, включая «Регистрация».
  if (card.status === 'registration') el.querySelector('.chips')?.append(statusBadge(card.status));
  return el;
}

async function listScreen(root: HTMLElement): Promise<void> {
  const newButton = h('a', { class: 'btn btn--primary btn--block', href: '#/admin/new' }, icon('plus', 20), 'Новый турнир');
  const content = h('div', { class: 'stack stack--lg' }, skeleton(4, 92));
  const templates = h('section', { class: 'admin-templates' });
  setChildren(root, h('h1', { class: 'page-title' }, 'Админ'), h('p', { class: 'page-sub' }, 'Турниры клуба, все статусы'), newButton, content, templates);
  void templatesSection(templates);

  let items: TournamentCard[];
  try {
    items = await api.admin.tournaments();
  } catch (error) {
    if (root.isConnected) setChildren(content, errorState(errorMessage(error), refreshView));
    return;
  }
  if (!root.isConnected) return;
  if (!items.length) {
    setChildren(content, emptyState({ emoji: '🂠', title: 'Турниров пока нет', text: 'Создайте первый — это займёт минуту.' }));
    return;
  }
  setChildren(
    content,
    GROUPS.map((g) => {
      const group = items.filter((t) => g.statuses.includes(t.status));
      if (!group.length) return null;
      // Архив — от новых к старым, остальное — по дате старта.
      const sorted = [...group].sort((a, b) =>
        g.title === 'Архив' ? b.startsAt.localeCompare(a.startsAt) : a.startsAt.localeCompare(b.startsAt),
      );
      return h('section', null, sectionTitle(`${g.title} · ${group.length}`), h('div', { class: 'stack' }, sorted.map(adminCard)));
    }),
  );
}

/* ───────────────────────── Шаблоны структур (список) ───────────────────────── */

/** Секция «Шаблоны структур» на `#/admin`: базовый, переименование, удаление. */
async function templatesSection(el: HTMLElement, force = true): Promise<void> {
  const title = (n?: number): HTMLElement => sectionTitle(n === undefined ? 'Шаблоны структур' : `Шаблоны структур · ${n}`);
  if (force) setChildren(el, title(), skeleton(2, 56));
  let list: BlindTemplate[];
  try {
    list = await loadTemplates(force);
  } catch (error) {
    if (el.isConnected) setChildren(el, title(), h('p', { class: 'muted' }, errorMessage(error)));
    return;
  }
  if (!el.isConnected) return;
  const redraw = (): void => void templatesSection(el);
  setChildren(
    el,
    title(list.length),
    list.length
      ? h('div', { class: 'card tpl-list' }, list.map((t) => templateRow(t, redraw)))
      : h('p', { class: 'muted' }, 'Шаблонов пока нет. В форме турнира — «💾 Сохранить как шаблон».'),
  );
}

function templateRow(t: BlindTemplate, redraw: () => void): HTMLElement {
  const meta = templateSummary(t.levels) + (t.startingStack !== null ? ` · стек ${fmtNum(t.startingStack)}` : '');
  return h(
    'div',
    { class: 'tpl' },
    h(
      'div',
      { class: 'tpl__main' },
      h('span', { class: 'tpl__name', title: t.name }, templateLabel(t)),
      h('span', { class: 'tpl__meta tabular' }, meta),
    ),
    h(
      'button',
      { type: 'button', class: 'icon-btn icon-btn--sm', ariaLabel: `Действия с шаблоном «${t.name}»`, on: { click: () => templateActions(t, redraw) } },
      icon('edit', 18),
    ),
  );
}

/** Шторка действий с шаблоном. */
function templateActions(t: BlindTemplate, redraw: () => void): void {
  const run = async (call: () => Promise<unknown>, message: string): Promise<void> => {
    try {
      await call();
      templatesCache = null;
      haptic.success();
      toast(message, 'success');
      redraw();
    } catch (error) {
      haptic.error();
      toast(errorMessage(error), 'error');
    }
  };
  const sheet = openSheet({
    title: templateLabel(t),
    content: h(
      'div',
      { class: 'stack tpl-actions' },
      h('p', { class: 'muted tabular' }, templateSummary(t.levels) + (t.startingStack !== null ? ` · стек ${fmtNum(t.startingStack)}` : '')),
      t.isDefault
        ? h('p', { class: 'field__hint' }, 'Базовый шаблон — с него начинается новый турнир.')
        : actionButton('★ Сделать базовым', async () => {
            sheet.close();
            await run(() => api.admin.updateTemplate(t.id, { isDefault: true }), `«${t.name}» — базовый шаблон`);
          }),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn--soft btn--nowrap',
          on: {
            click: () => {
              sheet.close();
              renameTemplate(t, redraw);
            },
          },
        },
        icon('edit', 20),
        'Переименовать',
      ),
      actionButton(
        'Удалить',
        async () => {
          haptic.warning();
          if (!(await confirmDialog(`Удалить шаблон «${t.name}»? Турниры, созданные по нему, не изменятся.`))) return;
          sheet.close();
          await run(() => api.admin.deleteTemplate(t.id), 'Шаблон удалён');
        },
        { tone: 'danger', iconName: 'close' },
      ),
    ),
  });
}

/** Шторка переименования: ошибка (например, имя занято) остаётся в шторке. */
function renameTemplate(t: BlindTemplate, onDone: () => void): void {
  const name = h('input', { class: 'input', required: true, maxLength: TEMPLATE_NAME_MAX, value: t.name });
  const error = errorLine();
  openSheet({
    title: 'Переименовать шаблон',
    content: h('div', { class: 'stack' }, field('Название', name, `До ${TEMPLATE_NAME_MAX} символов`), error),
    onSubmit: async () => {
      const value = name.value.trim();
      if (!value || value.length > TEMPLATE_NAME_MAX) return fail(error, `Название — от 1 до ${TEMPLATE_NAME_MAX} символов`) ?? false;
      if (value === t.name) return true;
      try {
        await api.admin.updateTemplate(t.id, { name: value });
      } catch (e) {
        haptic.error();
        showError(error, errorMessage(e));
        return false;
      }
      templatesCache = null;
      haptic.success();
      toast('Шаблон переименован', 'success');
      onDone();
      return true;
    },
  });
  name.select();
}

/* ───────────────────────── Создание ───────────────────────── */

async function newScreen(root: HTMLElement): Promise<Cleanup | void> {
  const heading = h('h1', { class: 'page-title' }, 'Новый турнир');
  setChildren(root, heading, skeleton(3, 120));
  // Базовый шаблон — начальная структура; без него (или если список не загрузился) — встроенная стандартная.
  const templates = await loadTemplates(true).catch((): BlindTemplate[] => []);
  if (!root.isConnected) return;
  const base = templates.find((t) => t.isDefault) ?? null;
  const baseProblem = base ? templateStructureError(base.levels, base.startingStack) : null;
  const form = tournamentForm(
    null,
    async (input) => {
      const created = await api.admin.create(input);
      toast(input.status === 'registration' ? 'Турнир создан, регистрация открыта' : 'Черновик сохранён', 'success');
      window.location.replace(`#/admin/t/${created.id}`);
    },
    base ? { levels: base.levels, startingStack: base.startingStack } : null,
  );
  setChildren(
    root,
    heading,
    base ? h('p', { class: 'page-sub' }, `Структура — из базового шаблона «${base.name}»`) : null,
    baseProblem ? h('p', { class: 'field__error' }, `Структура шаблона не проходит проверку: ${baseProblem}`) : null,
    form.el,
  );
  setMainAction({ text: 'Создать турнир', onClick: () => form.submit() });
  return () => setMainAction(null);
}

/* ───────────────────────── Управление турниром ───────────────────────── */

const REG_LABELS: Record<AdminRegistration['status'], string> = {
  registered: 'В игре',
  waitlist: 'Очередь',
  cancelled: 'Отменил',
};

interface Ctx {
  id: number;
  detail: TournamentDetail;
  regs: AdminRegistration[];
  /** Выполнить действие, вернувшее новый TournamentDetail, и перерисовать экран. */
  apply(call: () => Promise<TournamentDetail>, message: string): Promise<void>;
}

function statusActions(ctx: Ctx): HTMLElement {
  const d = ctx.detail;
  const setStatus = (status: TournamentStatus, message: string, opts: { announce?: boolean } = {}) => () =>
    ctx.apply(() => api.admin.setStatus(ctx.id, status, opts), message);
  const confirmThen = (question: string, run: () => Promise<void>) => async (): Promise<void> => {
    haptic.warning();
    if (await confirmDialog(question)) await run();
  };
  const cancel = actionButton(
    'Отменить турнир',
    confirmThen(`Отменить «${d.title}»? Все записанные получат уведомление.`, setStatus('cancelled', 'Турнир отменён')),
    { tone: 'danger', iconName: 'close' },
  );

  let buttons: HTMLElement[] = [];
  let text = '';
  let extra: HTMLElement | null = null;
  switch (d.status) {
    case 'draft': {
      text = 'Черновик видят только админы. Откройте регистрацию, когда всё готово.';
      const announce = h('input', { type: 'checkbox', class: 'check__input', checked: true });
      extra = h('label', { class: 'check' }, announce, h('span', null, 'Отправить анонс игрокам'), h('span', { class: 'check__hint' }, 'всем, кто подписан на анонсы'));
      buttons = [
        actionButton(
          'Открыть регистрацию',
          () => setStatus('registration', announce.checked ? 'Регистрация открыта, анонс отправляется' : 'Регистрация открыта', { announce: announce.checked })(),
          { tone: 'primary', iconName: 'check' },
        ),
      ];
      break;
    }
    case 'registration':
      text = 'Идёт регистрация. Старт турнира закроет её (кроме поздней регистрации).';
      extra = earlyHint(d.startsAt, EARLY_START_MIN, 'Начать можно');
      buttons = [
        actionButton(
          'Начать турнир',
          async () => {
            if (!timeOk(earlyStartError(d.startsAt, Date.now(), clubFormat()))) return;
            await confirmThen('Начать турнир сейчас?', setStatus('running', 'Турнир начался'))();
          },
          { tone: 'primary', iconName: 'spark' },
        ),
        cancel,
      ];
      break;
    case 'running':
      text = 'Турнир идёт. Завершите его вводом результатов ниже.';
      buttons = [cancel];
      break;
    case 'completed':
      text = 'Турнир завершён, результаты опубликованы. Их можно исправить ниже.';
      break;
    case 'cancelled':
      text = 'Турнир отменён.';
      break;
  }
  return h(
    'section',
    { class: 'card card--pad stack' },
    h('div', { class: 'admin-status' }, statusBadge(d.status), h('span', { class: 'muted' }, `${d.registeredCount} / ${d.capacity} · очередь ${d.waitlistCount}`)),
    h('p', { class: 'muted' }, text),
    d.status !== 'draft'
      ? h('p', { class: 'action-hint tabular' }, d.announcedAt ? `Анонс разослан ${fmtWhen(d.announcedAt).toLowerCase()}` : 'Анонс не рассылался')
      : null,
    extra,
    buttons.length ? h('div', { class: 'btn-row' }, buttons) : null,
  );
}

function clockSection(ctx: Ctx, onWidget: (w: ClockWidget | null) => void): HTMLElement | null {
  const d = ctx.detail;
  if (d.status !== 'registration' && d.status !== 'running') {
    onWidget(null);
    return null;
  }
  const run = (action: ClockAction, message: string) => () => ctx.apply(() => api.admin.clock(ctx.id, action), message);
  const c = d.clock;
  const widget = c ? clockWidget(d.blindLevels, c) : null;
  onWidget(widget);

  const buttons: HTMLElement[] = [];
  if (!c) {
    buttons.push(
      actionButton(
        'Запустить часы',
        async () => {
          if (!timeOk(earlyStartError(d.startsAt, Date.now(), clubFormat()))) return;
          await run('start', 'Часы запущены')();
        },
        { tone: 'primary', iconName: 'clock' },
      ),
    );
  } else {
    if (c.paused) buttons.push(actionButton('Продолжить', run('resume', 'Часы идут'), { tone: 'primary', iconName: 'clock' }));
    else if (!c.finished) buttons.push(actionButton('Пауза', run('pause', 'Часы на паузе'), { tone: 'soft', iconName: 'clock' }));
    buttons.push(
      actionButton(
        'Сбросить',
        async () => {
          if (await confirmDialog('Сбросить часы? Отсчёт уровней начнётся заново.')) await run('reset', 'Часы сброшены')();
        },
        { tone: 'ghost' },
      ),
    );
  }
  return h(
    'section',
    { class: 'admin-clock' },
    sectionTitle('Часы'),
    widget ? widget.el : null,
    !d.blindLevels.length
      ? h('p', { class: 'muted' }, 'Сначала задайте структуру блайндов во вкладке «Параметры».')
      : !c && d.status === 'registration'
        ? h('p', { class: 'muted' }, 'Запуск часов переведёт турнир в статус LIVE.')
        : null,
    d.blindLevels.length && !c ? earlyHint(d.startsAt, EARLY_START_MIN, 'Запуск часов') : null,
    d.blindLevels.length ? h('div', { class: 'btn-row' }, buttons) : null,
  );
}

function seatingSection(ctx: Ctx): HTMLElement | null {
  const d = ctx.detail;
  if (d.status !== 'registration' && d.status !== 'running') return null;
  const size = h(
    'select',
    { class: 'input select tabular' },
    // По умолчанию — размер стола из настроек турнира (и последний использованный при рассадке).
    // Варианты не больше вместимости турнира: на 6 мест стол на 9 не предлагаем.
    [2, 3, 4, 5, 6, 7, 8, 9, 10]
      .filter((n) => n <= Math.max(2, d.capacity))
      .map((n) => h('option', { value: String(n), selected: n === Math.min(d.tableSize, d.capacity) }, `${n} за столом`)),
  );
  const tables = h('p', { class: 'field__hint tabular' });
  const updateHint = (): void => {
    const n = d.registeredCount;
    const t = n ? Math.ceil(n / Number(size.value)) : 0;
    tables.textContent = n ? `${n} ${plural(n, 'игрок', 'игрока', 'игроков')} → ${t} ${plural(t, 'стол', 'стола', 'столов')}` : 'Пока некого рассаживать';
  };
  size.addEventListener('change', updateHint);
  updateHint();
  const seated = ctx.regs.some((r) => r.status === 'registered' && r.table !== null);
  return h(
    'section',
    null,
    sectionTitle('Рассадка'),
    h(
      'div',
      { class: 'card card--pad stack' },
      field('Размер стола', size),
      tables,
      earlyHint(d.startsAt, EARLY_SEATING_MIN, 'Рассадка доступна'),
      actionButton(
        seated ? 'Пересадить заново' : 'Рассадить случайно',
        async () => {
          if (!timeOk(earlySeatingError(d.startsAt, Date.now(), clubFormat()))) return;
          if (seated && !(await confirmDialog('Рассадка уже есть. Перемешать игроков заново? Всем придут новые места.'))) return;
          await ctx.apply(() => api.admin.seating(ctx.id, Number(size.value)), 'Игроки рассажены, места отправлены');
        },
        { tone: 'primary', iconName: 'seat' },
      ),
    ),
  );
}

function resultsSection(ctx: Ctx): HTMLElement | null {
  const d = ctx.detail;
  if (d.status === 'draft' || d.status === 'cancelled') return null;
  if (!d.participants.length) return null;
  if (d.status === 'registration') return null;

  const prev = new Map((d.results ?? []).map((r) => [r.player.id, r]));
  const rows = d.participants.map((p) => {
    const r = prev.get(p.id);
    const place = numInput(r?.place, { min: 1, max: d.participants.length, placeholder: '—' });
    const ko = numInput(r?.knockouts ?? 0, { min: 0, max: 1000 });
    place.ariaLabel = `Место: ${p.name}`;
    ko.ariaLabel = `Нокауты: ${p.name}`;
    return {
      player: p,
      place,
      ko,
      el: h(
        'div',
        { class: 'result-row' },
        avatar(p, 'sm'),
        h('span', { class: 'result-row__name' }, p.name),
        h('label', { class: 'result-row__field' }, h('span', null, 'Место'), place),
        h('label', { class: 'result-row__field' }, h('span', null, 'KO'), ko),
      ),
    };
  });
  const error = errorLine();

  const validate = (): ResultEntryInput[] | null => {
    for (const r of rows) r.place.removeAttribute('aria-invalid');
    const filled = rows.filter((r) => r.place.value.trim() !== '');
    const n = filled.length;
    if (!n) return fail(error, 'Укажите места хотя бы для одного игрока');
    const seen = new Map<number, (typeof rows)[number]>();
    for (const r of filled) {
      const place = intOf(r.place);
      if (place === null || place < 1 || place > n) {
        r.place.setAttribute('aria-invalid', 'true');
        return fail(error, `${r.player.name}: место должно быть от 1 до ${n}`);
      }
      const dup = seen.get(place);
      if (dup) {
        r.place.setAttribute('aria-invalid', 'true');
        dup.place.setAttribute('aria-invalid', 'true');
        return fail(error, `Место ${place} указано дважды: ${dup.player.name} и ${r.player.name}`);
      }
      seen.set(place, r);
    }
    let koTotal = 0;
    for (const r of filled) {
      const ko = intOf(r.ko) ?? 0;
      if (ko < 0) return fail(error, `${r.player.name}: нокауты не могут быть отрицательными`);
      koTotal += ko;
    }
    if (koTotal > n - 1) return fail(error, `Нокаутов (${koTotal}) больше, чем выбывших игроков (${n - 1})`);
    showError(error, null);
    return filled.map((r) => ({ playerId: r.player.id, place: intOf(r.place) ?? 0, knockouts: intOf(r.ko) ?? 0 }));
  };

  /** Быстрое заполнение: пустым местам — следующие свободные номера по порядку списка. */
  const autofill = (): void => {
    const used = new Set(rows.map((r) => intOf(r.place)).filter((v): v is number => v !== null));
    let next = 1;
    for (const r of rows) {
      if (r.place.value.trim() !== '') continue;
      while (used.has(next)) next += 1;
      r.place.value = String(next);
      used.add(next);
    }
    haptic.select();
  };

  const missing = d.participants.length - rows.filter((r) => r.place.value).length;
  return h(
    'section',
    null,
    sectionTitle(d.results ? 'Результаты (исправление)' : 'Результаты'),
    h(
      'div',
      { class: 'card card--pad stack' },
      h(
        'p',
        { class: 'field__hint' },
        'Места — уникальные, от 1 подряд. Игроков без места (не пришли) оставьте пустыми. Очки посчитаются автоматически.',
      ),
      h('div', { class: 'results-editor' }, rows.map((r) => r.el)),
      error,
      h(
        'div',
        { class: 'btn-row' },
        missing > 0 ? h('button', { type: 'button', class: 'btn btn--ghost', on: { click: autofill } }, 'Заполнить пустые') : null,
        actionButton(
          d.results ? 'Пересчитать и опубликовать' : 'Опубликовать результаты',
          async () => {
            if (!timeOk(resultsTimeError(d, Date.now(), clubFormat()))) return;
            const entries = validate();
            if (!entries) return;
            const ok = await confirmDialog(
              d.results
                ? 'Обновить результаты? Очки и рейтинг пересчитаются.'
                : 'Опубликовать результаты? Турнир будет завершён, игроки получат уведомления.',
            );
            if (ok) await ctx.apply(() => api.admin.results(ctx.id, entries), 'Результаты опубликованы');
          },
          { tone: 'primary', iconName: 'trophy' },
        ),
      ),
    ),
  );
}

/** Только цифры и ведущий «+» — для ссылки tel:. */
function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

function registrationsSection(ctx: Ctx): HTMLElement {
  const active = ctx.regs.filter((r) => r.status !== 'cancelled');
  const cancelled = ctx.regs.length - active.length;
  return h(
    'section',
    null,
    sectionTitle(`Записи · ${active.length}${cancelled ? ` (+${cancelled} отмен)` : ''}`),
    active.length
      ? h(
          'div',
          { class: 'card list' },
          active.map((r) =>
            h(
              'div',
              { class: 'list__row' },
              avatar(r.player, 'sm'),
              h(
                'span',
                { class: 'list__main' },
                h('a', { class: 'list__title', href: `#/p/${r.player.id}` }, r.player.name),
                h(
                  'span',
                  { class: 'list__sub' },
                  r.username ? `@${r.username}` : null,
                  r.username && r.phone ? ' · ' : null,
                  r.phone ? h('a', { href: telHref(r.phone), class: 'tabular' }, r.phone) : null,
                  r.phone && r.phoneVerified ? h('span', { class: 'verified', ariaLabel: 'подтверждён' }, ' ✓') : null,
                  !r.username && !r.phone ? 'Нет контактов' : null,
                ),
              ),
              h(
                'span',
                { class: 'list__aside' },
                r.table !== null && r.seat !== null ? h('span', { class: 'chip tabular' }, `С${r.table} · М${r.seat}`) : null,
                h('span', { class: ['badge', r.status === 'registered' ? 'badge--mine' : 'badge--wait'] }, REG_LABELS[r.status]),
              ),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'Пока никто не записался.'),
  );
}

function blindsPreview(d: TournamentDetail): HTMLElement | null {
  const playable = d.blindLevels.filter((l) => !l.isBreak);
  if (!playable.length) return null;
  const first = playable[0];
  const last = playable[playable.length - 1];
  const saveAsTemplate = (): void =>
    openSaveTemplateSheet({
      check: () => templateStructureError(d.blindLevels, d.startingStack),
      save: (name, isDefault) => api.admin.createTemplate({ name, fromTournamentId: d.id, isDefault }),
    });
  return h(
    'section',
    { class: 'stack' },
    h(
      'p',
      { class: 'muted tabular' },
      `Структура: ${playable.length} ${plural(playable.length, 'уровень', 'уровня', 'уровней')}`,
      first && last ? ` · ${blindsText(first)} → ${blindsText(last)}` : null,
    ),
    h('button', { type: 'button', class: 'btn btn--ghost btn--nowrap', on: { click: saveAsTemplate } }, h('span', { attrs: { 'aria-hidden': 'true' } }, '💾'), 'Сохранить структуру как шаблон'),
  );
}

type Tab = 'manage' | 'edit';

async function manageScreen(root: HTMLElement, id: number): Promise<Cleanup | void> {
  if (!Number.isInteger(id) || id <= 0) {
    setChildren(root, emptyState({ emoji: '🃏', title: 'Турнир не найден' }));
    return;
  }
  setChildren(root, skeleton(1, 96), skeleton(1, 160), skeleton(4, 56));

  let detail: TournamentDetail;
  let regs: AdminRegistration[];
  try {
    [detail, regs] = await Promise.all([api.tournament(id), api.admin.registrations(id)]);
  } catch (error) {
    if (root.isConnected) setChildren(root, errorState(errorMessage(error), refreshView));
    return;
  }
  if (!root.isConnected) return;

  let tab: Tab = 'manage';
  let clock: ClockWidget | null = null;
  const head = h('header', { class: 'detail-head' });
  const body = h('div', { class: 'stack stack--lg' });

  const ctx: Ctx = {
    id,
    get detail() {
      return detail;
    },
    get regs() {
      return regs;
    },
    async apply(call, message) {
      try {
        const next = await call();
        // Рассадка и статусы меняют записи — перечитываем их (ошибку здесь не считаем фатальной).
        const nextRegs = await api.admin.registrations(id).catch(() => regs);
        if (!root.isConnected) return;
        detail = next;
        regs = nextRegs;
        draw();
        toast(message, 'success');
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    },
  };

  const drawHead = (): void => {
    setChildren(
      head,
      h('div', { class: 'detail-head__badges' }, statusBadge(detail.status)),
      h('h1', { class: 'page-title' }, detail.title),
      h('p', { class: 'detail-head__sub tabular' }, `${fmtWhen(detail.startsAt)} · ${fmtNum(detail.registeredCount)} / ${fmtNum(detail.capacity)}`),
      detail.status !== 'draft'
        ? h('a', { class: 'section-title__link', href: `#/t/${detail.id}` }, 'Открыть страницу турнира')
        : null,
    );
  };

  const drawBody = (): void => {
    if (tab === 'manage') {
      setMainAction(null);
      setChildren(
        body,
        statusActions(ctx),
        clockSection(ctx, (w) => {
          clock = w;
        }),
        seatingSection(ctx),
        resultsSection(ctx),
        registrationsSection(ctx),
        blindsPreview(detail),
      );
      return;
    }
    clock = null;
    const form = tournamentForm(detail, async (input) => {
      const next = await api.admin.update(id, input);
      if (!root.isConnected) return;
      detail = next;
      drawHead();
      toast('Изменения сохранены', 'success');
    });
    const locked = detail.status === 'completed' || detail.status === 'cancelled';
    setChildren(
      body,
      locked ? h('div', { class: 'banner banner--muted' }, 'Турнир в архиве — изменения отразятся в истории и карточке турнира.') : null,
      form.el,
    );
    setMainAction({ text: 'Сохранить изменения', onClick: () => form.submit() });
  };

  const draw = (): void => {
    drawHead();
    drawBody();
  };

  setChildren(
    root,
    head,
    segmented<Tab>(
      [
        { value: 'manage', label: 'Управление' },
        { value: 'edit', label: 'Параметры' },
      ],
      tab,
      (value) => {
        tab = value;
        drawBody();
      },
      'Раздел',
    ),
    body,
  );
  draw();

  const tick = window.setInterval(() => clock?.tick(), 1000);
  return () => {
    window.clearInterval(tick);
    setMainAction(null);
  };
}

/* ───────────────────────── Точка входа ───────────────────────── */

export function render(root: HTMLElement, params: Params): Promise<Cleanup | void> | Cleanup {
  if (params.mode === 'new') return newScreen(root);
  if (params.id !== undefined) return manageScreen(root, Number(params.id));
  return listScreen(root);
}
