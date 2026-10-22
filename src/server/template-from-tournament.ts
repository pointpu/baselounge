/**
 * Шаблон структуры блайндов из существующего турнира:
 *
 *   node --env-file-if-exists=.env src/server/template-from-tournament.ts <id турнира> <название> [--default]
 *   npm run template:from-tournament -- 1 Базовая --default
 *   # в продакшн-контейнере (без npm, env уже задан): cd /app && node src/server/template-from-tournament.ts 1 Базовая --default
 *
 * Копирует blind_levels и starting_stack турнира. Если шаблон с таким названием (без учёта регистра)
 * уже есть — обновляет его уровни и стек, а не падает. `--default` — сделать шаблон базовым
 * (с него начинается форма нового турнира; прежний базовый перестаёт им быть).
 */
import { closeDb } from './db.ts';
import { HttpError } from './http.ts';
import { assertSchemaUpToDate } from './migrate.ts';
import { createFromTournament } from './services/templates.ts';

const USAGE = 'Использование: node src/server/template-from-tournament.ts <id турнира> <название> [--default]';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isDefault = args.includes('--default');
  const [rawId, ...nameParts] = args.filter((a) => a !== '--default');
  const id = Number(rawId);
  const name = nameParts.join(' ').trim();
  if (!Number.isInteger(id) || id <= 0 || !name) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  await assertSchemaUpToDate();
  const { template, created } = await createFromTournament(id, name, isDefault, { upsert: true });
  const playable = template.levels.filter((l) => !l.isBreak).length;
  console.log(
    `[templates] шаблон «${template.name}» (#${template.id}) ${created ? 'создан' : 'обновлён'} из турнира #${id}: ` +
      `${template.levels.length} строк (${playable} ур.), стек ${template.startingStack ?? 'не задан'}` +
      (template.isDefault ? ', базовый' : ''),
  );
}

try {
  await main();
} catch (err) {
  const message = err instanceof HttpError || err instanceof Error ? err.message : String(err);
  console.error(`[templates] ошибка: ${message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
