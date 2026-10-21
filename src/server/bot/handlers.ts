/**
 * Обработчики бота: /start (+ deep link `t_<id>` — запись на турнир), /help, /phone,
 * приём контакта и кнопка «Отменить запись».
 */
import { type Bot, type Context, InlineKeyboard, Keyboard } from 'grammy';
import type { User } from 'grammy/types';
import { config, isAdminPlayer } from '../config.ts';
import { HttpError } from '../http.ts';
import * as repo from '../repo.ts';
import type { PlayerRow } from '../repo.ts';
import { cancelRegistration, registerPlayer } from '../services/tournaments.ts';
import { tournamentKeyboard, webAppEnabled } from './notifier.ts';
import { texts } from './texts.ts';

/** Игрок по отправителю апдейта (фото из бота не приходит — сохраняем имеющееся). */
function playerFrom(user: User): Promise<PlayerRow> {
  return repo.upsertPlayerFromTelegram(
    { tgId: user.id, firstName: user.first_name || user.username || `Игрок ${user.id}`, username: user.username ?? null, photoUrl: null },
    { keepPhoto: true },
  );
}

/** Текст ошибки для пользователя: наши HttpError — как есть, остальное — общая фраза. */
function errorText(err: unknown): string {
  if (err instanceof HttpError) return err.message;
  console.error('[bot]', err);
  return texts.genericError;
}

async function handleStart(ctx: Context & { match: string }): Promise<void> {
  if (!ctx.from) return;
  const player = await playerFrom(ctx.from);
  const deepLink = /^t_(\d+)$/.exec(ctx.match.trim());

  if (!deepLink) {
    const name = player.nickname ?? player.first_name;
    if (!webAppEnabled) {
      await ctx.reply(texts.welcomeNoWebApp(name), { parse_mode: 'HTML' });
      return;
    }
    await ctx.reply(texts.welcome(name), {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().webApp(texts.openClub, config.webappUrl),
    });
    return;
  }

  const tournamentId = Number(deepLink[1]);
  try {
    const r = await registerPlayer(tournamentId, player, { isAdmin: isAdminPlayer(player), notify: false });
    const text = r.unchanged
      ? texts.alreadyIn(r.tournament, r.status === 'waitlist')
      : r.status === 'waitlist'
        ? texts.waitlisted(r.tournament, r.waitlistPosition)
        : texts.registered(r.tournament);
    const kb = tournamentKeyboard(tournamentId, { cancel: true });
    await ctx.reply(text, { parse_mode: 'HTML', ...(kb ? { reply_markup: kb } : {}) });
  } catch (err) {
    await ctx.reply(errorText(err));
  }
}

async function handleCancel(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? '';
  const id = Number(/^cancel:(\d+)$/.exec(data)?.[1]);
  if (!ctx.from || !Number.isSafeInteger(id)) {
    await ctx.answerCallbackQuery();
    return;
  }
  const player = await playerFrom(ctx.from);
  try {
    const r = await cancelRegistration(id, player, { isAdmin: isAdminPlayer(player) });
    await ctx.answerCallbackQuery({ text: r.cancelled ? 'Запись отменена' : texts.cancelNothing });
    const kb = tournamentKeyboard(id, { cancel: false });
    await ctx.editMessageText(r.cancelled ? texts.cancelDone(r.tournament) : texts.cancelNothing, {
      parse_mode: 'HTML',
      ...(kb ? { reply_markup: kb } : {}),
    });
  } catch (err) {
    await ctx.answerCallbackQuery({ text: errorText(err), show_alert: true });
  }
}

async function handleContact(ctx: Context): Promise<void> {
  const contact = ctx.message?.contact;
  if (!ctx.from || !contact) return;
  if (contact.user_id !== ctx.from.id) {
    await ctx.reply(texts.phoneForeign, { reply_markup: phoneKeyboard() });
    return;
  }
  await playerFrom(ctx.from);
  await repo.setVerifiedPhone(ctx.from.id, contact.phone_number);
  await ctx.reply(texts.phoneVerified, { reply_markup: { remove_keyboard: true } });
}

function phoneKeyboard(): Keyboard {
  return new Keyboard().requestContact(texts.phoneButton).resized().oneTime();
}

/** Регистрирует все обработчики на боте. */
export function registerHandlers(bot: Bot): void {
  bot.command('start', handleStart);
  bot.command('help', (ctx) => ctx.reply(texts.help, { parse_mode: 'HTML' }));
  bot.command('phone', (ctx) => ctx.reply(texts.phoneAsk, { reply_markup: phoneKeyboard() }));
  bot.callbackQuery(/^cancel:\d+$/, handleCancel);
  bot.on('message:contact', handleContact);
}
