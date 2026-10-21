/**
 * Telegram-бот (grammY, long polling). Запускается из main.ts, только если задан BOT_TOKEN.
 */
import { Bot, GrammyError, HttpError as GrammyHttpError } from 'grammy';
import { config } from '../config.ts';
import { setNotifier } from '../services/notifier.ts';
import { registerHandlers } from './handlers.ts';
import { TelegramNotifier, webAppEnabled } from './notifier.ts';
import { startReminders } from './reminders.ts';
import { commands } from './texts.ts';

export interface RunningBot {
  stop(): Promise<void>;
}

/** Команды и кнопка меню «Клуб» (web_app) — один раз при старте. */
async function configureBot(bot: Bot): Promise<void> {
  await bot.api.setMyCommands(commands);
  if (webAppEnabled) {
    await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Клуб', web_app: { url: config.webappUrl } } });
  } else {
    console.warn(`[bot] WEBAPP_URL=${config.webappUrl} не https — кнопки Mini App отключены (нужен туннель, см. README)`);
  }
}

/** Создаёт бота, подключает TelegramNotifier и напоминания, запускает long polling. */
export async function startBot(token: string): Promise<RunningBot> {
  const bot = new Bot(token);
  registerHandlers(bot);
  bot.catch(({ error, ctx }) => {
    const where = `update ${ctx.update.update_id}`;
    if (error instanceof GrammyError) console.error(`[bot] ${where}: ошибка Telegram API — ${error.description}`);
    else if (error instanceof GrammyHttpError) console.error(`[bot] ${where}: нет связи с Telegram —`, error.error);
    else console.error(`[bot] ${where}:`, error);
  });

  await bot.init();
  await configureBot(bot).catch((err: unknown) => console.error('[bot] не удалось настроить команды/меню:', err));

  setNotifier(new TelegramNotifier(bot.api));
  const stopReminders = startReminders();

  void bot
    .start({
      allowed_updates: ['message', 'callback_query'],
      onStart: (me) => console.log(`[bot] @${me.username} запущен (long polling)`),
    })
    .catch((err: unknown) => console.error('[bot] polling остановлен с ошибкой:', err));

  return {
    async stop() {
      stopReminders();
      if (bot.isRunning()) await bot.stop();
    },
  };
}
