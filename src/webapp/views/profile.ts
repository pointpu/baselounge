/**
 * Мой профиль: аватар (тап — сменить), никнейм (bottom sheet), подтверждение телефона,
 * статистика, ачивки, история.
 */
import type { Me, NotifyPrefs } from '../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import { me, setMe } from '../state.ts';
import { haptic, requestContact } from '../tg.ts';
import { errorState, h, icon, openSheet, refreshView, setChildren, skeleton, toast } from '../ui.ts';
import { avatar, rulesLink, statsBlock } from '../widgets.ts';

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

function editNickname(onSaved: () => void): void {
  const current = me().player;
  const input = h('input', {
    class: 'input',
    value: current.nickname ?? current.name,
    minLength: 2,
    maxLength: 32,
    required: true,
    autocomplete: 'nickname' as AutoFill,
    enterKeyHint: 'done',
    ariaLabel: 'Никнейм',
  });
  const error = h('p', { class: 'field__error', hidden: true });
  openSheet({
    title: 'Никнейм',
    submitLabel: 'Сохранить',
    content: [input, h('p', { class: 'field__hint' }, '2–32 символа. Его видят в рейтинге и списках участников.'), error],
    onSubmit: async () => {
      const value = input.value.trim();
      if (value.length < 2 || value.length > 32) {
        error.textContent = 'Никнейм должен быть от 2 до 32 символов';
        error.hidden = false;
        haptic.error();
        return false;
      }
      try {
        setMe(await api.updateMe({ nickname: value }));
        toast('Никнейм обновлён', 'success');
        onSaved();
        return true;
      } catch (e) {
        error.textContent = errorMessage(e);
        error.hidden = false;
        haptic.error();
        return false;
      }
    },
  });
  window.setTimeout(() => input.select(), 50);
}

/** После requestContact бот получает контакт асинхронно — несколько раз перечитываем /api/me. */
async function verifyPhone(onVerified: () => void): Promise<void> {
  const shared = await requestContact();
  if (shared === null) {
    toast('Подтвердить телефон можно в Telegram: отправьте боту свой контакт', 'info');
    return;
  }
  if (!shared) return;
  toast('Проверяем номер…');
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(1500);
    try {
      const fresh: Me = await api.me();
      if (fresh.player.phoneVerified) {
        setMe(fresh);
        toast('Телефон подтверждён', 'success');
        onVerified();
        return;
      }
    } catch {
      // Пробуем ещё раз.
    }
  }
  toast('Контакт отправлен — подтверждение появится чуть позже');
}

function profileHead(redraw: () => void): HTMLElement {
  const user = me();
  const file = h('input', { type: 'file', accept: AVATAR_TYPES.join(','), class: 'sr-only', tabIndex: -1 });
  const avatarButton = h(
    'button',
    { type: 'button', class: 'avatar-edit', ariaLabel: 'Сменить аватар', on: { click: () => file.click() } },
    avatar(user.player, 'xl'),
    h('span', { class: 'avatar-edit__badge' }, icon('camera', 16)),
  );
  file.addEventListener('change', async () => {
    const picked = file.files?.[0];
    file.value = '';
    if (!picked) return;
    if (!AVATAR_TYPES.includes(picked.type)) return toast('Подойдёт JPEG, PNG или WebP', 'error');
    if (picked.size > MAX_AVATAR_BYTES) return toast('Файл больше 2 МБ', 'error');
    avatarButton.classList.add('is-busy');
    avatarButton.disabled = true;
    try {
      setMe(await api.uploadAvatar(picked));
      toast('Аватар обновлён', 'success');
      redraw();
    } catch (error) {
      toast(errorMessage(error), 'error');
      avatarButton.classList.remove('is-busy');
      avatarButton.disabled = false;
    }
  });

  return h(
    'header',
    { class: 'profile-head' },
    avatarButton,
    file,
    h('h1', { class: 'page-title' }, user.player.name),
    h(
      'button',
      { type: 'button', class: 'btn btn--ghost btn--sm', on: { click: () => editNickname(redraw) } },
      icon('edit', 16),
      'Изменить никнейм',
    ),
    user.player.phoneVerified
      ? h('span', { class: 'badge badge--mine' }, icon('check', 14), 'Телефон подтверждён')
      : null,
  );
}

function phoneCard(onVerified: () => void): HTMLElement | null {
  if (me().player.phoneVerified) return null;
  const button = h(
    'button',
    { type: 'button', class: 'btn btn--primary btn--block' },
    icon('phone', 20),
    'Подтвердить телефон',
  );
  button.addEventListener('click', () => {
    button.disabled = true;
    void verifyPhone(onVerified).finally(() => {
      button.disabled = false;
    });
  });
  return h(
    'section',
    { class: 'card card--pad stack' },
    h('div', { class: 'banner__title' }, 'Завершите регистрацию'),
    h('p', { class: 'muted' }, 'Подтвердите номер одним нажатием — так администратор сможет связаться с вами по поводу турнира.'),
    button,
  );
}

/**
 * Переключатель (role="switch"): мгновенно меняет вид (оптимистично), сохраняет на сервере,
 * при ошибке возвращает прежнее значение.
 */
function notifySwitch(key: keyof NotifyPrefs, title: string, hint: string): HTMLElement {
  const field = key === 'announcements' ? 'notifyAnnouncements' : 'notifyReminders';
  const titleId = `notify-${key}`;
  const button = h('button', {
    type: 'button',
    class: 'switch',
    attrs: { role: 'switch', 'aria-checked': me().notify[key], 'aria-labelledby': titleId },
  });
  const set = (on: boolean): void => button.setAttribute('aria-checked', String(on));
  let saving = false;
  button.addEventListener('click', () => {
    if (saving) return;
    const prev = me().notify[key];
    const next = !prev;
    set(next);
    haptic.select();
    saving = true;
    void api
      .updateMe({ [field]: next })
      .then((fresh) => {
        setMe(fresh);
        set(fresh.notify[key]);
      })
      .catch((error: unknown) => {
        set(prev);
        haptic.error();
        toast(errorMessage(error), 'error');
      })
      .finally(() => {
        saving = false;
      });
  });
  return h(
    'div',
    { class: 'toggle-row' },
    h('span', { class: 'toggle-row__text' }, h('span', { class: 'toggle-row__title', id: titleId }, title), h('span', { class: 'toggle-row__hint' }, hint)),
    button,
  );
}

function notifyCard(): HTMLElement {
  return h(
    'section',
    null,
    h('div', { class: 'section-title' }, h('h2', null, 'Уведомления')),
    h(
      'div',
      { class: 'card card--pad stack' },
      notifySwitch('announcements', 'Анонсы турниров', 'Когда открывается запись'),
      notifySwitch('reminders', 'Напоминания', 'Перед стартом ваших турниров'),
      h('p', { class: 'field__hint' }, 'Рассадка, итоги и отмена ваших турниров приходят всегда.'),
    ),
  );
}

export async function render(root: HTMLElement): Promise<void> {
  const headSlot = h('div');
  const phoneSlot = h('div');
  const statsSlot = h('div', null, skeleton(1, 200), skeleton(3, 56));

  const drawHead = (): void => {
    setChildren(headSlot, profileHead(drawHead));
    setChildren(phoneSlot, phoneCard(drawHead));
  };
  drawHead();
  setChildren(root, headSlot, phoneSlot, statsSlot, notifyCard(), rulesLink());

  try {
    const stats = await api.myStats();
    if (root.isConnected) setChildren(statsSlot, statsBlock(stats));
  } catch (error) {
    if (root.isConnected) setChildren(statsSlot, errorState(errorMessage(error), refreshView));
  }
}
