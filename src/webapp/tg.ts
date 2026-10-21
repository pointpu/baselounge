/**
 * Тонкая обёртка над Telegram.WebApp с безопасными фолбэками для обычного браузера.
 *
 * Внутри Telegram используем нативные элементы (BackButton, MainButton, haptics, confirm),
 * снаружи — их браузерные аналоги, чтобы приложение работало и при локальной разработке.
 * Модуль не зависит от остального кода приложения (чтобы не было циклических импортов).
 */

type ImpactStyle = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft';
type NotificationType = 'error' | 'success' | 'warning';

/** Минимальное подмножество SDK, которое мы реально используем. */
interface TgBottomButton {
  setParams(params: {
    text?: string;
    color?: string;
    text_color?: string;
    is_active?: boolean;
    is_visible?: boolean;
  }): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
  showProgress(leaveActive?: boolean): void;
  hideProgress(): void;
  hide(): void;
}

interface TgBackButton {
  show(): void;
  hide(): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
}

interface TgWebApp {
  initData: string;
  initDataUnsafe: { start_param?: string };
  colorScheme: 'light' | 'dark';
  isVersionAtLeast(version: string): boolean;
  ready(): void;
  expand(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  setBottomBarColor?(color: string): void;
  onEvent(event: string, cb: () => void): void;
  BackButton: TgBackButton;
  MainButton: TgBottomButton;
  HapticFeedback: {
    impactOccurred(style: ImpactStyle): void;
    notificationOccurred(type: NotificationType): void;
    selectionChanged(): void;
  };
  showConfirm(message: string, cb: (ok: boolean) => void): void;
  requestContact?(cb: (ok: boolean) => void): void;
  openLink(url: string): void;
}

const raw = (window as unknown as { Telegram?: { WebApp?: TgWebApp } }).Telegram?.WebApp;

/** SDK загружается и в обычном браузере, но там initData пустая — считаем, что Telegram нет. */
const wa: TgWebApp | null = raw && raw.initData ? raw : null;

const atLeast = (version: string): boolean => wa !== null && wa.isVersionAtLeast(version);

/** Открыто ли приложение внутри Telegram. */
export const isTelegram = wa !== null;

/** Подписанная строка initData для заголовка авторизации (пустая вне Telegram). */
export function getInitData(): string {
  return wa?.initData ?? '';
}

/** Параметр deep link `startapp` (например, `t_12`), если приложение открыто по ссылке. */
export function getStartParam(): string | null {
  return wa?.initDataUnsafe.start_param ?? null;
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

/**
 * Бренд BASE LOUNGE — чёрный с золотом, поэтому тема всегда тёмная, независимо от темы Telegram.
 * data-scheme оставлен для CSS-токенов и на случай, если светлую тему вернут.
 */
function syncScheme(): void {
  document.documentElement.dataset.scheme = 'dark';
}

/** Цвет фона страницы — должен совпадать с --bg в styles.css. */
const PAGE_BG = '#0b0b0c';

/** Красит шапку и фон Telegram в цвет страницы, чтобы не было «шва». */
function paintChrome(): void {
  if (!wa || !atLeast('6.1')) return;
  try {
    // HEX поддерживается с Bot API 6.9; на более старых клиентах — ключевое слово темы.
    const color = atLeast('6.9') ? PAGE_BG : 'secondary_bg_color';
    wa.setHeaderColor?.(color);
    wa.setBackgroundColor?.(color);
    if (atLeast('7.10')) wa.setBottomBarColor?.(color);
  } catch {
    // Старые клиенты могут не поддерживать ключевые слова цветов — это не критично.
  }
}

/** Инициализация: ready/expand, синхронизация темы. Вызывать один раз при старте. */
export function initTelegram(): void {
  syncScheme();
  if (!wa) {
    darkQuery.addEventListener('change', syncScheme);
    return;
  }
  wa.ready();
  wa.expand();
  paintChrome();
  wa.onEvent('themeChanged', () => {
    syncScheme();
    paintChrome();
  });
}

/** Тактильная отдача. Вне Telegram — тихо ничего не делает. */
export const haptic = {
  impact(style: ImpactStyle = 'light'): void {
    if (atLeast('6.1')) wa?.HapticFeedback.impactOccurred(style);
  },
  success(): void {
    if (atLeast('6.1')) wa?.HapticFeedback.notificationOccurred('success');
  },
  error(): void {
    if (atLeast('6.1')) wa?.HapticFeedback.notificationOccurred('error');
  },
  warning(): void {
    if (atLeast('6.1')) wa?.HapticFeedback.notificationOccurred('warning');
  },
  select(): void {
    if (atLeast('6.1')) wa?.HapticFeedback.selectionChanged();
  },
};

let backHandler: (() => void) | null = null;

/**
 * Показывает нативную кнопку «Назад» с обработчиком или скрывает её (`null`).
 * @returns true, если используется нативная кнопка (иначе роутер рисует свою).
 */
export function setBackButton(handler: (() => void) | null): boolean {
  if (!wa || !atLeast('6.1')) return false;
  if (backHandler) wa.BackButton.offClick(backHandler);
  backHandler = handler;
  if (handler) {
    wa.BackButton.onClick(handler);
    wa.BackButton.show();
  } else {
    wa.BackButton.hide();
  }
  return true;
}

/** Нативный диалог подтверждения (или window.confirm в браузере). */
export function confirmDialog(message: string): Promise<boolean> {
  const app = wa;
  if (app && atLeast('6.2')) {
    return new Promise((resolve) => app.showConfirm(message, (ok) => resolve(ok)));
  }
  return Promise.resolve(window.confirm(message));
}

/**
 * Просит пользователя поделиться номером телефона (контакт уходит боту).
 * @returns true/false — согласился ли пользователь; null — функция недоступна (браузер/старый клиент).
 */
export function requestContact(): Promise<boolean | null> {
  const app = wa;
  if (!app || !atLeast('6.9') || !app.requestContact) return Promise.resolve(null);
  const request = app.requestContact.bind(app);
  return new Promise((resolve) => request((ok) => resolve(ok)));
}

/** Открывает внешнюю ссылку (в Telegram — через openLink, требуется абсолютный URL). */
export function openLink(url: string): void {
  const absolute = new URL(url, window.location.href).href;
  if (wa) wa.openLink(absolute);
  else window.open(absolute, '_blank', 'noopener');
}

/** Главное действие экрана: в Telegram — MainButton, в браузере — закреплённая кнопка внизу. */
export interface MainAction {
  text: string;
  tone?: 'primary' | 'danger';
  onClick: () => void | Promise<void>;
}

const TONE_COLORS = {
  primary: { color: '#D9AE5B', text: '#141008' },
  danger: { color: '#D9534F', text: '#FFFFFF' },
} as const;

let mainHandler: (() => void) | null = null;
let fallbackButton: HTMLButtonElement | null = null;
let busy = false;

function fallback(): HTMLButtonElement {
  if (!fallbackButton) {
    fallbackButton = document.createElement('button');
    fallbackButton.type = 'button';
    fallbackButton.className = 'main-action';
    fallbackButton.hidden = true;
    document.body.append(fallbackButton);
  }
  return fallbackButton;
}

function setBusy(value: boolean): void {
  if (wa) {
    if (value) wa.MainButton.showProgress(false);
    else wa.MainButton.hideProgress();
  } else if (fallbackButton) {
    fallbackButton.disabled = value;
    fallbackButton.classList.toggle('is-busy', value);
  }
}

/** Устанавливает (или убирает при `null`) главное действие текущего экрана. */
export function setMainAction(action: MainAction | null): void {
  const run = action
    ? async (): Promise<void> => {
        if (busy) return;
        busy = true;
        setBusy(true);
        try {
          await action.onClick();
        } finally {
          busy = false;
          setBusy(false);
        }
      }
    : null;
  const handler = run ? (): void => void run() : null;
  const tone = TONE_COLORS[action?.tone ?? 'primary'];

  if (wa) {
    if (mainHandler) wa.MainButton.offClick(mainHandler);
    mainHandler = handler;
    if (action && handler) {
      wa.MainButton.setParams({
        text: action.text,
        color: tone.color,
        text_color: tone.text,
        is_active: true,
        is_visible: true,
      });
      wa.MainButton.onClick(handler);
    } else {
      wa.MainButton.hide();
    }
    return;
  }

  const button = fallback();
  if (mainHandler) button.removeEventListener('click', mainHandler);
  mainHandler = handler;
  button.hidden = !action;
  document.body.classList.toggle('has-main-action', Boolean(action));
  if (action && handler) {
    button.textContent = action.text;
    button.classList.toggle('main-action--danger', action.tone === 'danger');
    button.addEventListener('click', handler);
  }
}
