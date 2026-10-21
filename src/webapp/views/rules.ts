/**
 * «Правила холдема» (#/rules): краткая шпаргалка клуба — ход раздачи, старшинство комбинаций
 * (с мини-картами), позиции за столом, турнирные термины и как считаются очки рейтинга.
 * Разделы сворачиваются (<details>), первый открыт. Весь текст — статичный, DOM через h().
 */
import { h, icon, setChildren } from '../ui.ts';
import type { Child } from '../ui.ts';

/* ───────────── Карты ───────────── */

type Suit = '♠' | '♥' | '♦' | '♣';

/** Мини-карта: «A♠» → номинал над мастью; червы и бубны — красные. */
function card(code: string): HTMLElement {
  const suit = code.slice(-1) as Suit;
  const rank = code.slice(0, -1);
  const red = suit === '♥' || suit === '♦';
  return h(
    'span',
    { class: ['pcard', red && 'pcard--red'], attrs: { 'aria-hidden': 'true' } },
    h('span', { class: 'pcard__rank' }, rank),
    h('span', { class: 'pcard__suit' }, suit),
  );
}

function cards(codes: string): HTMLElement {
  const list = codes.split(' ');
  return h('span', { class: 'pcards', role: 'img', ariaLabel: list.join(', ') }, list.map(card));
}

/* ───────────── Разделы ───────────── */

/** Какие разделы открыты — переживает повторный заход на экран. */
const openSections = new Set<string>(['deal']);

function section(id: string, title: string, sub: string, ...body: Child[]): HTMLElement {
  const details = h(
    'details',
    { class: 'card rules-sec', open: openSections.has(id) },
    h(
      'summary',
      null,
      h('span', { class: 'rules-sec__head' }, h('span', { class: 'rules-sec__title' }, title), h('span', { class: 'rules-sec__sub' }, sub)),
      icon('chevron', 18),
    ),
    h('div', { class: 'rules-sec__body' }, body),
  );
  details.addEventListener('toggle', () => {
    if (details.open) openSections.add(id);
    else openSections.delete(id);
  });
  return details;
}

/** Строка «термин — пояснение»: термин — короткая метка в одну строку, пояснение — обычный текст. */
function term(label: string, text: string): HTMLElement {
  return h('div', { class: 'term' }, h('span', { class: 'term__label' }, label), h('p', { class: 'term__text' }, text));
}

/* ───────────── Ход раздачи ───────────── */

const STREETS: ReadonlyArray<[string, string]> = [
  ['Баттон', 'Фишка дилера. Двигается по часовой стрелке после каждой раздачи и определяет порядок ходов.'],
  ['Блайнды', 'Обязательные ставки до раздачи карт: малый (SB) — слева от баттона, большой (BB) — следующий игрок. В турнире растут по уровням.'],
  ['Анте', 'Обязательный взнос в банк с поздних уровней. Чаще всего это BB‑анте: за весь стол платит игрок на большом блайнде, суммой в один BB.'],
  ['Префлоп', 'Каждый получает две закрытые карты. Первым ходит игрок слева от большого блайнда: фолд, колл или рейз.'],
  ['Флоп', 'На стол выкладываются три общие карты. Торговля начинается с первого активного игрока слева от баттона.'],
  ['Тёрн', 'Четвёртая общая карта и новый круг торговли.'],
  ['Ривер', 'Пятая, последняя общая карта и последний круг торговли.'],
  ['Шоудаун', 'Если осталось больше одного игрока — карты вскрываются. Каждый собирает лучшие пять карт из семи (две свои и пять общих; можно взять одну свою или ни одной). Сильнейшая комбинация забирает банк, равные делят его.'],
];

/* ───────────── Комбинации ───────────── */

const HANDS: ReadonlyArray<[name: string, example: string, note: string]> = [
  ['Роял-флеш', 'A♠ K♠ Q♠ J♠ 10♠', 'от десятки до туза одной масти'],
  ['Стрит-флеш', '9♥ 8♥ 7♥ 6♥ 5♥', 'пять по порядку одной масти'],
  ['Каре', 'Q♣ Q♦ Q♥ Q♠ 7♦', 'четыре карты одного номинала'],
  ['Фулл-хаус', 'K♠ K♥ K♦ 4♣ 4♠', 'тройка и пара'],
  ['Флеш', 'A♦ J♦ 8♦ 6♦ 2♦', 'пять карт одной масти'],
  ['Стрит', '10♣ 9♦ 8♠ 7♥ 6♣', 'пять по порядку, масти любые'],
  ['Сет / тройка', '7♠ 7♥ 7♣ K♦ 2♠', 'три карты одного номинала'],
  ['Две пары', 'J♥ J♣ 5♠ 5♦ A♣', 'две разные пары'],
  ['Пара', '10♥ 10♠ K♣ 6♦ 3♥', 'две карты одного номинала'],
  ['Старшая карта', 'A♣ Q♦ 9♠ 6♥ 3♣', 'ничего не собрано — решает старшая'],
];

function handsList(): HTMLElement {
  return h(
    'ol',
    { class: 'hands' },
    HANDS.map(([name, example, note], i) =>
      h(
        'li',
        { class: 'hand' },
        h('span', { class: 'hand__num tabular' }, String(i + 1)),
        h('span', { class: 'hand__name' }, name),
        cards(example),
        h('span', { class: 'hand__note' }, note),
      ),
    ),
  );
}

/* ───────────── Позиции ───────────── */

const POSITIONS: ReadonlyArray<[string, string]> = [
  ['BTN', 'Баттон — лучшая позиция: на флопе, тёрне и ривере ходит последним.'],
  ['SB', 'Малый блайнд — сразу слева от баттона, после флопа ходит первым.'],
  ['BB', 'Большой блайнд — на префлопе ходит последним, платит BB‑анте.'],
  ['UTG', 'Under the gun — первый ход на префлопе, нужна самая сильная рука.'],
  ['MP / HJ', 'Средние позиции между UTG и катоффом.'],
  ['CO', 'Катофф — справа от баттона, вторая по силе позиция.'],
];

/* ───────────── Термины турнира ───────────── */

const TERMS: ReadonlyArray<[string, string]> = [
  ['Стек', 'Ваши фишки. Стартовый стек одинаков у всех и указан в карточке турнира.'],
  ['BB', 'Большой блайнд — мера стека: «30 BB» значит, что фишек хватит на 30 больших блайндов текущего уровня.'],
  ['Уровень', 'Отрезок времени с фиксированными блайндами. По часам турнира видно, сколько осталось до следующего.'],
  ['Поздняя рег.', 'Записаться и сесть за стол можно и после старта — до конца указанного уровня.'],
  ['Ре-энтри', 'Вылетели до конца поздней регистрации — можно войти снова с новым стеком за отдельный взнос.'],
  ['Add-on', 'Докупка фишек, обычно в первом перерыве. Доступна всем, кто в игре.'],
  ['Freezeout', 'Турнир без ре-энтри: одна попытка на игрока.'],
  ['Нокаут', 'Вы выбили соперника. В Bounty-турнирах за каждый нокаут начисляются клубные очки.'],
  ['Финальный стол', 'Последний стол турнира — в клубе это места с 1-го по 9-е.'],
  ['ITM', 'In the money — место в призовой зоне.'],
];

const GAMES: ReadonlyArray<[string, string]> = [
  ['NLH', 'No-Limit Hold\'em — ставка может быть любой, вплоть до олл-ина. Основной формат клуба.'],
  ['PLH', 'Pot-Limit Hold\'em — максимальная ставка ограничена размером банка.'],
  ['FLH', 'Fixed-Limit Hold\'em — ставки и рейзы фиксированного размера.'],
];

/* ───────────── Очки рейтинга ───────────── */

/*
 * Формула продублирована из src/server/services/scoring.ts (pointsFor):
 * round(100 × (поле − место + 1) / поле) + нокауты × цена нокаута, +25 за 1-е место.
 */
function pointsSection(): HTMLElement[] {
  return [
    h('p', { class: 'rules-text' }, 'Очки за турнир складываются из трёх частей:'),
    h(
      'div',
      { class: 'formula' },
      h('div', { class: 'formula__row' }, h('span', { class: 'formula__key' }, 'Место'), h('span', { class: 'formula__val tabular' }, '100 × (N − место + 1) / N')),
      h('div', { class: 'formula__row' }, h('span', { class: 'formula__key' }, 'Нокауты'), h('span', { class: 'formula__val tabular' }, 'нокауты × цена нокаута')),
      h('div', { class: 'formula__row' }, h('span', { class: 'formula__key' }, 'Победа'), h('span', { class: 'formula__val tabular' }, '+25 очков')),
    ),
    h(
      'p',
      { class: 'rules-text' },
      'N — сколько игроков было в турнире; очки за место округляются. Победитель получает 100 + 25, последний — около 100 / N. ',
      'Цена нокаута своя у каждого турнира (видна в «Структуре»); если она 0 — нокауты очков не дают.',
    ),
    h(
      'div',
      { class: 'example' },
      h('div', { class: 'example__title' }, 'Пример'),
      h('p', { class: 'rules-text' }, '20 игроков, вы 3-й, выбили двоих, нокаут стоит 10 очков:'),
      h('p', { class: 'example__calc tabular' }, 'место: 100 × 18 / 20 = 90'),
      h('p', { class: 'example__calc tabular' }, 'итого: 90 + 2 × 10 = 110 очков'),
    ),
    h(
      'p',
      { class: 'rules-text' },
      'Рейтинг месяца — сумма очков за турниры текущего календарного месяца, «Всё время» — за всю историю. ',
      'При равенстве очков выше тот, у кого больше побед, затем — кто сыграл меньше турниров.',
    ),
  ];
}

/* ───────────── Экран ───────────── */

export function render(root: HTMLElement): void {
  setChildren(
    root,
    h(
      'header',
      { class: 'rules-head' },
      h('div', { class: 'eyebrow' }, 'Texas Hold\'em'),
      h('h1', { class: 'page-title' }, 'Правила холдема'),
      h('p', { class: 'muted' }, 'Коротко о раздаче, комбинациях и турнирах клуба.'),
    ),
    h(
      'div',
      { class: 'stack' },
      section(
        'deal',
        'Ход раздачи',
        'Баттон, блайнды, улицы',
        h('ol', { class: 'steps' }, STREETS.map(([name, text], i) =>
          h('li', { class: 'step' }, h('span', { class: 'step__num tabular' }, String(i + 1)), h('div', { class: 'step__main' }, h('span', { class: 'step__name' }, name), h('p', { class: 'step__text' }, text))),
        )),
      ),
      section('hands', 'Комбинации', 'От роял-флеша до старшей карты', handsList(), h('p', { class: 'rules-text muted' }, 'При равных комбинациях сравниваются номиналы, затем кикеры — оставшиеся карты. Масти по старшинству не различаются. Туз может быть и младшей картой: A‑2‑3‑4‑5 — самый младший стрит.')),
      section('positions', 'Позиции', 'BTN, SB, BB, UTG, CO', h('div', { class: 'terms' }, POSITIONS.map(([l, t]) => term(l, t)))),
      section('terms', 'Термины турнира', 'Стек, ре-энтри, add-on, ITM', h('div', { class: 'terms' }, TERMS.map(([l, t]) => term(l, t)))),
      section('games', 'Разновидности', 'NLH, PLH, FLH', h('div', { class: 'terms' }, GAMES.map(([l, t]) => term(l, t)))),
      section('points', 'Очки рейтинга', 'Как считается рейтинг клуба', pointsSection()),
    ),
  );
}
