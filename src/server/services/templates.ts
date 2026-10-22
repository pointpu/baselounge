/**
 * Шаблоны структуры блайндов: сохранённые админом структуры (уровни + необязательный стартовый стек),
 * которые применяются в форме турнира. «Базовый» шаблон (не больше одного) — начальная структура
 * формы нового турнира.
 *
 * Правила: имя — trim, 1..40 символов, уникально без учёта регистра (409); структура непустая и
 * проходит `levelsError`; стартовый стек > BB первого игрового уровня (`stackError`); шаблонов
 * не больше `MAX_BLIND_TEMPLATES` (409). Все изменения — в транзакции под общей блокировкой
 * шаблонов (`repo.lockBlindTemplates`), поэтому проверки и смена базового идут строго по очереди.
 */
import { levelsError, stackError } from '../../shared/rules.ts';
import type { BlindLevel, BlindTemplate } from '../../shared/types.ts';
import { tx } from '../db.ts';
import { badRequest, conflict, notFound } from '../http.ts';
import * as repo from '../repo.ts';
import type { BlindTemplateFields, BlindTemplateRow } from '../repo.ts';

/** Больше шаблонов в клубе не нужно — дальше их неудобно выбирать в строке формы. */
export const MAX_BLIND_TEMPLATES = 50;
export const TEMPLATE_NAME_MAX = 40;

const DUPLICATE_NAME = 'Шаблон с таким названием уже есть';

export function templateDto(row: BlindTemplateRow): BlindTemplate {
  return {
    id: row.id,
    name: row.name,
    levels: row.levels,
    startingStack: row.starting_stack,
    isDefault: row.is_default,
    updatedAt: row.updated_at,
  };
}

/** Нормализует и проверяет название (400 при ошибке). */
function cleanName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) throw badRequest('Укажите название шаблона');
  if (name.length > TEMPLATE_NAME_MAX) throw badRequest(`Название шаблона — не длиннее ${TEMPLATE_NAME_MAX} символов`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw badRequest('Название содержит недопустимые символы');
  return name;
}

/** Ошибка структуры или стека шаблона по текущим правилам, иначе null. */
function structureProblem(levels: readonly BlindLevel[], startingStack: number | null): string | null {
  if (!levels.length) return 'В шаблоне должен быть хотя бы один уровень';
  return levelsError(levels) ?? stackError({ startingStack, levels, reentries: [], addons: [] });
}

/** Проверяет структуру и стек шаблона (400 при ошибке). */
function checkStructure(levels: readonly BlindLevel[], startingStack: number | null, prefix = ''): void {
  const problem = structureProblem(levels, startingStack);
  if (problem) throw badRequest(prefix + problem);
}

/** Имя не занято другим шаблоном (409). */
async function assertNameFree(name: string, selfId: number | null): Promise<void> {
  const other = await repo.findBlindTemplateByName(name);
  if (other && other.id !== selfId) throw conflict(DUPLICATE_NAME);
}

/** Пишет шаблон (новый или существующий); базовый — единственный. Вызывать внутри tx() после lock. */
async function persist(id: number | null, f: BlindTemplateFields): Promise<BlindTemplateRow> {
  if (f.is_default) await repo.clearDefaultBlindTemplate(id);
  let savedId = id;
  if (savedId === null) savedId = await repo.insertBlindTemplate(f);
  else await repo.updateBlindTemplate(savedId, f);
  const row = await repo.findBlindTemplate(savedId);
  if (!row) throw notFound('Шаблон не найден');
  return row;
}

async function assertCapacity(): Promise<void> {
  if ((await repo.countBlindTemplates()) >= MAX_BLIND_TEMPLATES) {
    throw conflict(`Шаблонов уже ${MAX_BLIND_TEMPLATES} — удалите ненужные, чтобы сохранить новый`);
  }
}

/** Все шаблоны: сначала базовый, затем по названию. */
export async function listTemplates(): Promise<BlindTemplate[]> {
  return (await repo.listBlindTemplates()).map(templateDto);
}

export interface TemplateCreate {
  name: string;
  levels: BlindLevel[];
  startingStack?: number | null;
  isDefault?: boolean;
}

export async function createTemplate(input: TemplateCreate): Promise<BlindTemplate> {
  const name = cleanName(input.name);
  const startingStack = input.startingStack ?? null;
  checkStructure(input.levels, startingStack);
  return tx(async () => {
    await repo.lockBlindTemplates();
    await assertNameFree(name, null);
    await assertCapacity();
    const row = await persist(null, { name, levels: input.levels, starting_stack: startingStack, is_default: input.isDefault ?? false });
    return templateDto(row);
  });
}

export type TemplatePatch = Partial<TemplateCreate>;

/** Меняет только переданные поля; `isDefault: true` снимает отметку с прежнего базового. */
export async function updateTemplate(id: number, patch: TemplatePatch): Promise<BlindTemplate> {
  return tx(async () => {
    await repo.lockBlindTemplates();
    const current = await repo.findBlindTemplate(id);
    if (!current) throw notFound('Шаблон не найден');
    const name = patch.name !== undefined ? cleanName(patch.name) : current.name;
    const levels = patch.levels ?? current.levels;
    const startingStack = patch.startingStack !== undefined ? patch.startingStack : current.starting_stack;
    if (patch.levels !== undefined || patch.startingStack !== undefined) checkStructure(levels, startingStack);
    // Шаблон из старых данных мог перестать проходить правила — базовым (начальной структурой формы) его не делаем.
    else if (patch.isDefault === true && !current.is_default) checkStructure(levels, startingStack, 'Шаблон нельзя сделать базовым: ');
    if (patch.name !== undefined) await assertNameFree(name, id);
    const row = await persist(id, { name, levels, starting_stack: startingStack, is_default: patch.isDefault ?? current.is_default });
    return templateDto(row);
  });
}

/** Сделать шаблон базовым (прежний базовый перестаёт им быть). */
export async function setDefaultTemplate(id: number): Promise<BlindTemplate> {
  return updateTemplate(id, { isDefault: true });
}

export async function deleteTemplate(id: number): Promise<void> {
  if (!(await repo.deleteBlindTemplate(id))) throw notFound('Шаблон не найден');
}

export interface FromTournamentResult {
  template: BlindTemplate;
  /** false — шаблон с таким именем уже был и обновлён (только при `upsert`). */
  created: boolean;
}

/**
 * Шаблон из структуры турнира (blind_levels + starting_stack). При `upsert` существующий шаблон
 * с тем же названием обновляется (уровни, стек; базовым становится, только если `isDefault`),
 * иначе одноимённый шаблон — 409.
 */
export async function createFromTournament(
  tournamentId: number,
  rawName: string,
  isDefault = false,
  opts: { upsert?: boolean } = {},
): Promise<FromTournamentResult> {
  const name = cleanName(rawName);
  const t = await repo.findTournament(tournamentId);
  if (!t) throw notFound(`Турнир #${tournamentId} не найден`);
  if (!t.blind_levels.length) throw badRequest(`У турнира «${t.title}» не задана структура блайндов`);
  checkStructure(t.blind_levels, t.starting_stack);
  return tx(async () => {
    await repo.lockBlindTemplates();
    const existing = await repo.findBlindTemplateByName(name);
    if (existing && !opts.upsert) throw conflict(DUPLICATE_NAME);
    if (!existing) await assertCapacity();
    const row = await persist(existing?.id ?? null, {
      name: existing?.name ?? name,
      levels: t.blind_levels,
      starting_stack: t.starting_stack,
      is_default: isDefault || (existing?.is_default ?? false),
    });
    return { template: templateDto(row), created: !existing };
  });
}
