/**
 * Точка входа Mini App: загрузка профиля, hash-роутер, таб-бар, кнопка «Назад».
 */
import './styles.css';
import { ApiError, api, errorMessage, hasCredentials } from './api.ts';
import { me, onMeChange, setMe } from './state.ts';
import { getStartParam, haptic, initTelegram, isTelegram, setBackButton, setMainAction } from './tg.ts';
import { emptyState, errorState, h, icon, setChildren, skeleton } from './ui.ts';
import type { Cleanup, IconName, Params, ViewRender } from './ui.ts';
import * as admin from './views/admin.ts';
import * as home from './views/home.ts';
import * as player from './views/player.ts';
import * as profile from './views/profile.ts';
import * as rating from './views/rating.ts';
import * as tournament from './views/tournament.ts';
import * as tournaments from './views/tournaments.ts';

type TabId = 'home' | 'tournaments' | 'rating' | 'me' | 'admin';

interface Route {
  re: RegExp;
  keys: readonly string[];
  tab: TabId;
  /** Куда вести «Назад», если истории нет; null — корневой экран вкладки. */
  parent: string | null;
  adminOnly?: boolean;
  extra?: Params;
  view: ViewRender;
}

/** '/t/:id' → регулярка и имена параметров. */
function route(pattern: string, config: Omit<Route, 're' | 'keys'>): Route {
  const keys: string[] = [];
  const source = pattern.replace(/:(\w+)/g, (_, key: string) => {
    keys.push(key);
    return '([^/]+)';
  });
  return { re: new RegExp(`^${source}$`), keys, ...config };
}

const ROUTES: readonly Route[] = [
  route('/', { tab: 'home', parent: null, view: home.render }),
  route('/tournaments', { tab: 'tournaments', parent: null, view: tournaments.render }),
  route('/t/:id', { tab: 'tournaments', parent: '/tournaments', view: tournament.render }),
  route('/rating', { tab: 'rating', parent: null, view: rating.render }),
  route('/p/:id', { tab: 'rating', parent: '/rating', view: player.render }),
  route('/me', { tab: 'me', parent: null, view: profile.render }),
  route('/admin', { tab: 'admin', parent: null, adminOnly: true, view: admin.render }),
  route('/admin/new', { tab: 'admin', parent: '/admin', adminOnly: true, extra: { mode: 'new' }, view: admin.render }),
  route('/admin/t/:id', { tab: 'admin', parent: '/admin', adminOnly: true, view: admin.render }),
];

const TABS: readonly { id: TabId; href: string; label: string; icon: IconName; adminOnly?: boolean }[] = [
  { id: 'home', href: '#/', label: 'Афиша', icon: 'home' },
  { id: 'tournaments', href: '#/tournaments', label: 'Турниры', icon: 'cards' },
  { id: 'rating', href: '#/rating', label: 'Рейтинг', icon: 'trophy' },
  { id: 'me', href: '#/me', label: 'Профиль', icon: 'user' },
  { id: 'admin', href: '#/admin', label: 'Админ', icon: 'shield', adminOnly: true },
];

const screen = h('div', { class: 'screen' });
const tabbar = h('nav', { class: 'tabbar', ariaLabel: 'Разделы' });

/**
 * Маршрут из части после `#`. Telegram при открытии Mini App пишет туда свои параметры
 * (`#tgWebAppData=…`) — либо заменяя наш маршрут, либо дописывая их через `&`/`?`.
 * Поэтому берём только путь до первого `?`/`&`, а служебный хвост Telegram отбрасываем.
 */
function currentPath(): string {
  const raw = window.location.hash.replace(/^#/, '');
  const path = raw.split(/[?&]/, 1)[0] ?? '';
  return path.startsWith('/') ? path : '/';
}

/** Допустимый маршрут из ссылки: только наши пути, без внешних адресов и спецсимволов. */
const SAFE_ROUTE = /^\/[a-z]+(?:\/[a-z0-9]+)*$/;

/**
 * Маршрут из ссылки бота: `https://…/?route=/t/12`. Query-строку Telegram не трогает
 * (в отличие от `#`), поэтому ссылки на турнир передают маршрут именно так.
 */
function applyRouteParam(): void {
  const route = new URLSearchParams(window.location.search).get('route');
  if (!route || !SAFE_ROUTE.test(route) || currentPath() !== '/') return;
  stack.push('/');
  window.history.replaceState(null, '', `${window.location.pathname}#${route}`);
}

function resolve(path: string): { route: Route; params: Params } | null {
  for (const r of ROUTES) {
    const m = r.re.exec(path);
    if (!m) continue;
    const params: Record<string, string> = { ...r.extra };
    r.keys.forEach((key, i) => {
      params[key] = decodeURIComponent(m[i + 1] ?? '');
    });
    return { route: r, params };
  }
  return null;
}

/* ───────────── Таб-бар ───────────── */

let activeTab: TabId = 'home';

function renderTabs(): void {
  const isAdmin = me().isAdmin;
  setChildren(
    tabbar,
    TABS.filter((t) => !t.adminOnly || isAdmin).map((t) =>
      h(
        'a',
        { class: 'tabbar__item', href: t.href, dataset: { tab: t.id }, on: { click: () => haptic.select() } },
        icon(t.icon, 24),
        h('span', { class: 'tabbar__label' }, t.label),
      ),
    ),
  );
  highlightTab(activeTab);
}

function highlightTab(tab: TabId): void {
  activeTab = tab;
  for (const link of tabbar.querySelectorAll<HTMLAnchorElement>('.tabbar__item')) {
    if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

/* ───────────── История и «Назад» ───────────── */

/** Собственный стек путей: понимаем, есть ли куда вернуться внутри приложения. */
const stack: string[] = [];

function trackHistory(path: string): void {
  if (stack.length > 1 && stack[stack.length - 2] === path) stack.pop();
  else if (stack[stack.length - 1] !== path) stack.push(path);
}

function goBack(parent: string): void {
  haptic.impact('light');
  if (stack.length > 1) window.history.back();
  else window.location.replace(`#${parent}`);
}

/* ───────────── Рендер маршрута ───────────── */

let cleanup: Cleanup | null = null;
let renderSeq = 0;

async function renderRoute(): Promise<void> {
  const path = currentPath();
  const match = resolve(path);
  if (!match || (match.route.adminOnly && !me().isAdmin)) {
    window.location.replace('#/');
    return;
  }
  trackHistory(path);
  const { route: r, params } = match;

  cleanup?.();
  cleanup = null;
  setMainAction(null);
  const seq = ++renderSeq;

  const root = h('main', { class: 'view', tabIndex: -1 });
  const parent = r.parent;
  const nativeBack = setBackButton(parent ? () => goBack(parent) : null);
  const inlineBack =
    parent && !nativeBack
      ? h('button', { type: 'button', class: 'back-link', on: { click: () => goBack(parent) } }, icon('back', 20), 'Назад')
      : null;
  setChildren(screen, inlineBack, root);
  highlightTab(r.tab);
  window.scrollTo({ top: 0 });

  try {
    const result = await r.view(root, params);
    if (seq !== renderSeq) result?.();
    else cleanup = result ?? null;
  } catch (error) {
    if (seq === renderSeq) setChildren(root, errorState(errorMessage(error), () => void renderRoute()));
  }
}

/* ───────────── Запуск ───────────── */

function fatal(error: unknown): void {
  const unauthorized = error instanceof ApiError && error.status === 401;
  const needTelegram = unauthorized || !hasCredentials();
  setChildren(
    screen,
    h(
      'main',
      { class: 'view view--center' },
      needTelegram
        ? emptyState({
            emoji: '♠',
            title: 'Откройте BASE LOUNGE из Telegram',
            text: isTelegram
              ? 'Сессия устарела. Закройте и снова откройте приложение.'
              : 'Приложение работает внутри Telegram. Для локальной разработки добавьте к адресу ?dev_user=1',
          })
        : errorState(errorMessage(error), () => void boot()),
    ),
  );
}

/** Deep link `startapp=t_12` → сразу открыть турнир. */
function applyStartParam(): void {
  const m = /^t_(\d+)$/.exec(getStartParam() ?? '');
  if (m && currentPath() === '/') {
    stack.push('/');
    window.history.pushState(null, '', `#/t/${m[1]}`);
  }
}

let started = false;

async function boot(): Promise<void> {
  setChildren(screen, h('main', { class: 'view' }, skeleton(1, 120), skeleton(3, 76)));
  try {
    setMe(await api.me());
  } catch (error) {
    fatal(error);
    return;
  }
  if (started) return void renderRoute();
  started = true;
  renderTabs();
  onMeChange(renderTabs);
  document.body.append(tabbar);
  applyStartParam();
  applyRouteParam();
  window.addEventListener('hashchange', () => void renderRoute());
  void renderRoute();
}

initTelegram();
document.getElementById('app')?.replaceChildren(screen);
void boot();
