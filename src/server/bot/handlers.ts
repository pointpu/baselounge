/**
 * Обработчики бота: /start (+ deep link `t_<id>` — запись на турнир), /help, /phone, /notify,
 * приём контакта, кнопки «Отменить запись» и переключатели уведомлений.
 */
import { type Bot, type Context, GrammyError, InlineKeyboard, Keyboard } from 'grammy';
import type { InlineKeyboardButton, InlineKeyboardMarkup, User } from 'grammy/types';
import { config, isAdminPlayer } from '../config.ts';
import { HttpError } from '../http.ts';
import * as repo from '../repo.ts';
import type { PlayerRow } from '../repo.ts';
import { cancelRegistration, registerPlayer } from '../services/tournaments.ts';
import { cancelAllowed, clubKeyboard, markReachable, markUnreachable, tournamentKeyboard, webAppEnabled } from './notifier.ts';
import { type NotifyPrefs, texts } from './texts.ts';

/** Общие параметры ответа: HTML и без превью ссылок. */
const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } } as const;

/** Игрок по отправителю апдейта (фото из бота не приходит — сохраняем имеющееся). */
function playerFrom(user: User): Promise<PlayerRow> {
  return repo.upsertPlayerFromTelegram(
    { tgId: user.id, firstName: user.first_name || user.username || `Игрок ${user.id}`, username: user.username ?? null, photoUrl: null },
    { keepPhoto: true },
  );
}

/** Сообщение «нет изменений» при редактировании — не ошибка. */
function isNotModified(err: unknown): boolean {
  return err instanceof GrammyError && /message is not modified/i.test(err.description);
}

/** Редактирует сообщение с кнопкой, игнорируя «нет изменений» и слишком старые сообщения. */
async function safeEdit(ctx: Context, text: string, keyboard: InlineKeyboard | undefined): Promise<void> {
  try {
    await ctx.editMessageText(text, { ...HTML, reply_markup: keyboard ?? new InlineKeyboard() });
  } catch (err) {
    if (!isNotModified(err)) console.warn('[bot] не удалось отредактировать сообщение:', err instanceof Error ? err.message : err);
  }
}

/**
 * Ответ на нажатие кнопки. Ошибку («query is too old» после простоя и т.п.) только логируем:
 * действие уже выполнено, и сообщение всё равно нужно обновить.
 */
async function safeAnswer(ctx: Context, opts?: { text?: string; show_alert?: boolean }): Promise<void> {
  try {
    await ctx.answerCallbackQuery(opts);
  } catch (err) {
    console.warn('[bot] answerCallbackQuery:', err instanceof Error ? err.message : err);
  }
}

/** Ответ с необязательной клавиатурой. */
const withKeyboard = (kb: InlineKeyboard | undefined) => ({ ...HTML, ...(kb ? { reply_markup: kb } : {}) });

// ───────────────────────────── /start ─────────────────────────────

async function handleStart(ctx: Context & { match: string }): Promise<void> {
  if (!ctx.from) return;
  const player = await playerFrom(ctx.from);
  await markReachable(ctx.from.id);
  const deepLink = /^t_(\d+)$/.exec(ctx.match.trim());

  if (!deepLink) {
    const name = player.nickname ?? player.first_name;
    if (!webAppEnabled) {
      await ctx.reply(texts.welcomeNoWebApp(name), HTML);
      return;
    }
    await ctx.reply(texts.welcome(name), { ...HTML, reply_markup: new InlineKeyboard().webApp(texts.openClub, config.webappUrl) });
    return;
  }

  const tournamentId = Number(deepLink[1]);
  try {
    const r = await registerPlayer(tournamentId, player, { isAdmin: isAdminPlayer(player), notify: false });
    const waitlist = r.status === 'waitlist';
    const text = r.unchanged
      ? texts.alreadyIn(r.tournament, waitlist, r.waitlistPosition)
      : waitlist
        ? texts.waitlisted(r.tournament, r.waitlistPosition)
        : texts.registered(r.tournament);
    const kb = tournamentKeyboard(tournamentId, { calendar: !waitlist, cancel: cancelAllowed(r.tournament, r.status) });
    await ctx.reply(text, { ...HTML, ...(kb ? { reply_markup: kb } : {}) });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      await ctx.reply(texts.tournamentNotFound, withKeyboard(clubKeyboard()));
      return;
    }
    if (err instanceof HttpError) {
      // Запись закрыта (409) и т.п.: причина от сервера + карточка турнира, если он виден.
      const t = await repo.findTournament(tournamentId).catch(() => undefined);
      const visible = t && t.status !== 'draft' ? t : undefined;
      const kb = visible ? tournamentKeyboard(visible.id) : clubKeyboard();
      await ctx.reply(texts.registrationClosed(err.message, visible), withKeyboard(kb));
      return;
    }
    console.error('[bot] запись по deep link:', err);
    await ctx.reply(texts.genericError, HTML);
  }
}

// ───────────────────────────── Отмена записи ─────────────────────────────

const CANCEL_RE = /^cancel:(\d+)(?::([yn]))?$/;

/**
 * Клавиатура сообщения с заменой строки, где есть кнопка отмены этого турнира, на `row`
 * (остальные кнопки — календарь, Mini App — остаются как были). Если сообщение недоступно — `fallback`.
 */
function replaceCancelRow(ctx: Context, id: number, row: InlineKeyboardButton[], fallback: InlineKeyboard): InlineKeyboardMarkup {
  const rows = ctx.callbackQuery?.message?.reply_markup?.inline_keyboard;
  const isCancelRow = (r: InlineKeyboardButton[]) =>
    r.some((b) => 'callback_data' in b && typeof b.callback_data === 'string' && b.callback_data.startsWith(`cancel:${id}`));
  if (!rows || !rows.some(isCancelRow)) return { inline_keyboard: [...fallback.inline_keyboard, row] };
  return { inline_keyboard: rows.map((r) => (isCancelRow(r) ? row : r)) };
}

async function safeEditMarkup(ctx: Context, markup: InlineKeyboardMarkup): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: markup });
  } catch (err) {
    if (!isNotModified(err)) console.warn('[bot] не удалось обновить кнопки:', err instanceof Error ? err.message : err);
  }
}

/**
 * «❌ Отменить запись» → кнопки подтверждения «Да, отменить» (`cancel:<id>:y`) / «Нет» (`cancel:<id>:n`):
 * случайное нажатие в напоминании не должно отдавать место следующему.
 */
async function handleCancel(ctx: Context): Promise<void> {
  const m = CANCEL_RE.exec(ctx.callbackQuery?.data ?? '');
  const id = Number(m?.[1]);
  if (!ctx.from || !m || !Number.isSafeInteger(id)) {
    await safeAnswer(ctx);
    return;
  }
  const step = m[2];
  if (step === undefined) {
    await safeAnswer(ctx);
    await safeEditMarkup(
      ctx,
      replaceCancelRow(
        ctx,
        id,
        [
          { text: texts.cancelConfirmButton, callback_data: `cancel:${id}:y` },
          { text: texts.cancelKeepButton, callback_data: `cancel:${id}:n` },
        ],
        tournamentKeyboard(id) ?? new InlineKeyboard(),
      ),
    );
    return;
  }
  if (step === 'n') {
    await safeAnswer(ctx, { text: texts.cancelKeptToast });
    await safeEditMarkup(
      ctx,
      replaceCancelRow(ctx, id, [{ text: texts.cancelButton, callback_data: `cancel:${id}` }], tournamentKeyboard(id) ?? new InlineKeyboard()),
    );
    return;
  }
  try {
    const player = await playerFrom(ctx.from);
    const r = await cancelRegistration(id, player, { isAdmin: isAdminPlayer(player) });
    await safeAnswer(ctx, { text: r.cancelled ? texts.cancelToast : texts.cancelNothingToast });
    await safeEdit(ctx, r.cancelled ? texts.cancelDone(r.tournament) : texts.cancelNothing(r.tournament), tournamentKeyboard(id));
  } catch (err) {
    if (err instanceof HttpError) {
      // Например, турнир уже начался: объясняем и убираем кнопки отмены, текст не трогаем.
      await safeAnswer(ctx, { text: err.message, show_alert: true });
      await safeEditMarkup(ctx, tournamentKeyboard(id) ?? new InlineKeyboard());
      return;
    }
    console.error('[bot] отмена записи:', err);
    await safeAnswer(ctx, { text: texts.genericErrorToast, show_alert: true });
  }
}

// ───────────────────────────── /notify ─────────────────────────────

const PREF_KEYS = ['announcements', 'reminders'] as const satisfies readonly (keyof NotifyPrefs)[];

function prefsKeyboard(p: NotifyPrefs): InlineKeyboard {
  const kb = new InlineKeyboard();
  // В callback — целевое значение: двойное нажатие или старая кнопка не «отменяют» друг друга.
  for (const [i, key] of PREF_KEYS.entries()) {
    if (i > 0) kb.row();
    kb.text(texts.prefButton(key, p[key]), `notify:${key}:${p[key] ? 0 : 1}`);
  }
  return kb;
}

async function handleNotify(ctx: Context & { match: string }): Promise<void> {
  if (!ctx.from) return;
  await playerFrom(ctx.from);
  const arg = ctx.match.trim().toLowerCase();
  // `/notify off|on` — только анонсы (так и написано в подсказке анонса); напоминания — кнопкой.
  const prefs =
    arg === 'off' || arg === 'выкл'
      ? await repo.setNotifyPrefs(ctx.from.id, { announcements: false })
      : arg === 'on' || arg === 'вкл'
        ? await repo.setNotifyPrefs(ctx.from.id, { announcements: true })
        : await repo.getNotifyPrefs(ctx.from.id);
  await ctx.reply(texts.notifyPrefs(prefs), { ...HTML, reply_markup: prefsKeyboard(prefs) });
}

async function handleNotifyToggle(ctx: Context): Promise<void> {
  const m = /^notify:(announcements|reminders):([01])$/.exec(ctx.callbackQuery?.data ?? '');
  if (!ctx.from || !m) {
    await safeAnswer(ctx);
    return;
  }
  const key = m[1] as keyof NotifyPrefs;
  try {
    await playerFrom(ctx.from);
    const prefs = await repo.setNotifyPrefs(ctx.from.id, { [key]: m[2] === '1' });
    await safeAnswer(ctx, { text: texts.notifyToast(key, prefs[key]) });
    await safeEdit(ctx, texts.notifyPrefs(prefs), prefsKeyboard(prefs));
  } catch (err) {
    console.error('[bot] настройки уведомлений:', err);
    await safeAnswer(ctx, { text: texts.genericErrorToast, show_alert: true });
  }
}

// ───────────────────────────── Телефон ─────────────────────────────

function phoneKeyboard(): Keyboard {
  return new Keyboard().requestContact(texts.phoneButton).resized().oneTime();
}

async function handleContact(ctx: Context): Promise<void> {
  const contact = ctx.message?.contact;
  if (!ctx.from || !contact) return;
  if (contact.user_id !== ctx.from.id) {
    await ctx.reply(texts.phoneForeign, { ...HTML, reply_markup: phoneKeyboard() });
    return;
  }
  await playerFrom(ctx.from);
  await repo.setVerifiedPhone(ctx.from.id, contact.phone_number);
  await ctx.reply(texts.phoneVerified, { ...HTML, reply_markup: { remove_keyboard: true } });
}

// ───────────────────────────── Регистрация ─────────────────────────────

/** Регистрирует все обработчики на боте. */
export function registerHandlers(bot: Bot): void {
  // Любое действие пользователя = бот снова доступен (снимаем отметку «заблокирован»).
  // my_chat_member обрабатывается отдельно: «kicked» — это как раз блокировка.
  // Только личный чат: сообщение в группе не значит, что пользователь разблокировал бота в личке.
  bot.use(async (ctx, next) => {
    await next();
    if (ctx.chat?.type === 'private' && ctx.from && !ctx.from.is_bot && !ctx.myChatMember) await markReachable(ctx.from.id);
  });
  // Блокировка/разблокировка бота в личном чате — сразу, не дожидаясь 403 на следующей отправке.
  bot.on('my_chat_member', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const status = ctx.myChatMember.new_chat_member.status;
    if (status === 'kicked') await markUnreachable(ctx.chat.id);
    else if (status === 'member') await markReachable(ctx.chat.id);
  });
  // Группы и каналы: кнопки Mini App (web_app) и запрос телефона Telegram там запрещает
  // (BUTTON_TYPE_INVALID). На команды отвечаем ссылкой в личку, остальное молча пропускаем.
  bot.use(async (ctx, next) => {
    if (!ctx.chat || ctx.chat.type === 'private') return next();
    if (ctx.callbackQuery) return safeAnswer(ctx);
    if (ctx.message?.text?.startsWith('/')) {
      await ctx.reply(texts.privateOnly, {
        ...HTML,
        reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true },
        reply_markup: new InlineKeyboard().url(texts.privateOnlyButton, `https://t.me/${ctx.me.username}?start`),
      });
    }
  });
  bot.command('start', handleStart);
  bot.command('help', (ctx) => ctx.reply(texts.help(webAppEnabled), HTML));
  bot.command('phone', (ctx) => ctx.reply(texts.phoneAsk, { ...HTML, reply_markup: phoneKeyboard() }));
  bot.command('notify', handleNotify);
  bot.callbackQuery(CANCEL_RE, handleCancel);
  bot.callbackQuery(/^notify:(announcements|reminders):[01]$/, handleNotifyToggle);
  bot.on('message:contact', handleContact);
  // Устаревшие/неизвестные кнопки — просто гасим «часики».
  bot.on('callback_query:data', (ctx) => safeAnswer(ctx));
}
