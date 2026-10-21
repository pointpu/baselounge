/**
 * Dev-скрипт (в проде не используется): печатает все сообщения бота на примерах данных,
 * чтобы тексты можно было оценить без Telegram.
 *
 *   DATABASE_URL=postgres://x@127.0.0.1/x WEBAPP_URL=https://club.example node src/server/bot/preview.ts [--html]
 *
 * По умолчанию HTML-теги убираются (жирный — *так*, курсив — _так_); `--html` — как уходит в Telegram.
 * К БД скрипт не подключается (DATABASE_URL нужен только для загрузки конфигурации).
 */
import { InlineKeyboard } from 'grammy';
import type { TournamentRow } from '../repo.ts';
import { announceKeyboard, clubKeyboard, tournamentKeyboard } from './notifier.ts';
import { commands, setClockForPreview, texts } from './texts.ts';

const NOW = new Date('2026-10-22T09:00:00Z'); // чт, 22 октября, 12:00 по Москве
setClockForPreview(() => NOW);

const at = (minutesFromNow: number): string => new Date(NOW.getTime() + minutesFromNow * 60_000).toISOString();

function sample(over: Partial<TournamentRow> = {}): TournamentRow {
  const base = {
    id: 42,
    title: 'Friday Bounty <Deep> & Co',
    subtitle: 'Пятничный баунти',
    description:
      'Классический пятничный турнир с баунти за каждого выбитого игрока. Глубокие стеки, уровни по 20 минут, ' +
      'ре-энтри до конца поздней регистрации и аддон на перерыве. Приходите заранее — welcome-drink с 18:30.',
    game: 'nlh',
    starts_at: '2026-10-23T16:00:00Z', // пт, 19:00 МСК
    late_reg_until: null,
    status: 'registration',
    capacity: 27,
    buy_in: 1500,
    starting_stack: 30000,
    knockout_points: 10,
    table_size: 9,
    dealer: '',
    reentries: [{ price: 1500, stack: 30000 }],
    addons: [],
    blind_levels: [],
    clock_started_at: null,
    clock_paused_at: null,
    clock_paused_total: 0,
    results_published_at: null,
    created_at: '2026-10-01T10:00:00Z',
    reminder_offsets: [1440, 120, 30],
    announced_at: null,
  };
  return { ...base, ...over } as unknown as TournamentRow;
}

const html = process.argv.includes('--html');

function render(text: string): string {
  if (html) return text;
  return text
    .replace(/<\/?b>/g, '*')
    .replace(/<\/?i>/g, '_')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function keyboard(kb: InlineKeyboard | undefined): string {
  if (!kb) return '';
  return kb.inline_keyboard
    .filter((row) => row.length > 0)
    .map((row) => row.map((b) => `[ ${b.text} ]`).join(' '))
    .join('\n');
}

function show(name: string, text: string, kb?: InlineKeyboard): void {
  console.log(`\n━━━━━━━━━━━━ ${name} ━━━━━━━━━━━━`);
  console.log(render(text));
  const k = keyboard(kb);
  if (k) console.log(`\n${k}`);
}

const t = sample();
const freeSoon = sample({ id: 7, title: 'Утренний фриролл', buy_in: 0, knockout_points: 0, reentries: [], starts_at: at(25) });

show('welcome', texts.welcome('Дима'));
show('welcomeNoWebApp', texts.welcomeNoWebApp('Дима'));
show('help', texts.help(true));
show('help (без Mini App)', texts.help(false));
show('phoneAsk', texts.phoneAsk);
show('phoneVerified', texts.phoneVerified);
show('phoneForeign', texts.phoneForeign);
show('registered', texts.registered(t), tournamentKeyboard(t.id, { calendar: true, cancel: true }));
show('waitlisted', texts.waitlisted(t, 3), tournamentKeyboard(t.id, { cancel: true }));
show('alreadyIn', texts.alreadyIn(t, false, null), tournamentKeyboard(t.id, { calendar: true, cancel: true }));
show('alreadyIn (waitlist)', texts.alreadyIn(t, true, 2), tournamentKeyboard(t.id, { cancel: true }));
show('registrationClosed', texts.registrationClosed('Регистрация на этот турнир закрыта', t), tournamentKeyboard(t.id));
show('tournamentNotFound', texts.tournamentNotFound, clubKeyboard());
show('cancelDone (toast: ' + texts.cancelToast + ')', texts.cancelDone(t), tournamentKeyboard(t.id));
show('cancelNothing', texts.cancelNothing(t), tournamentKeyboard(t.id));
show('promoted', texts.promoted(t), tournamentKeyboard(t.id, { calendar: true, cancel: true }));
show('seat', texts.seat(sample({ starts_at: at(20) }), 2, 5), tournamentKeyboard(t.id));
show('registrationClosed (без карточки)', texts.registrationClosed('Регистрация на этот турнир закрыта', undefined), clubKeyboard());
show('results #2', texts.results(t, 2, 180, 24), tournamentKeyboard(t.id, { rating: true }));
show('results #1', texts.results(t, 1, 250, 24), tournamentKeyboard(t.id, { rating: true }));
show('results #3', texts.results(t, 3, 120, 24), tournamentKeyboard(t.id, { rating: true }));
show('results #5', texts.results(t, 5, 40, 24), tournamentKeyboard(t.id, { rating: true }));
show('results #19 (0 pts)', texts.results(t, 19, 0, 24), tournamentKeyboard(t.id, { rating: true }));
show('cancelledByClub', texts.cancelledByClub(t), tournamentKeyboard(t.id));
show('reminder 1440', texts.reminder(sample({ starts_at: at(1440) }), 1440), tournamentKeyboard(t.id, { calendar: true, cancel: true }));
show('reminder 120', texts.reminder(sample({ starts_at: at(120) }), 120), tournamentKeyboard(t.id, { calendar: true, cancel: true }));
show('reminder 45', texts.reminder(sample({ starts_at: at(45) }), 45), tournamentKeyboard(t.id, { cancel: true }));
show('reminder 30', texts.reminder(freeSoon, 30), tournamentKeyboard(freeSoon.id, { cancel: true }));
show('announce', texts.announce(t), announceKeyboard(t.id, 'base_lounge_bot'));
show('cancel confirm (после «Отменить запись»)', texts.registered(t), new InlineKeyboard().text(texts.cancelConfirmButton).text(texts.cancelKeepButton));
show('announce (free, no description)', texts.announce(sample({ ...freeSoon, description: '', subtitle: '', starts_at: at(3 * 1440) })));
show('notifyPrefs', texts.notifyPrefs({ announcements: true, reminders: false }));
console.log(`  [ ${texts.prefButton('announcements', true)} ]\n  [ ${texts.prefButton('reminders', false)} ]`);
show('genericError', texts.genericError);
console.log('\n━━━━━━━━━━━━ commands ━━━━━━━━━━━━');
for (const c of commands) console.log(`/${c.command} — ${c.description}`);
