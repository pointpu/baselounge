/**
 * Форматы турнира (Bounty, Re-entry/Freezeout, Turbo, Deepstack, Add-on) для строки БД.
 * Сами правила — в shared/rules.ts (`formatTags`), здесь только адаптер snake_case → входные данные.
 */
import { FORMAT_LABELS, GAME_SHORT, formatTags } from '../../shared/rules.ts';
import type { FormatTag } from '../../shared/types.ts';
import type { TournamentRow } from '../repo.ts';

export function rowFormats(t: TournamentRow): FormatTag[] {
  return formatTags({
    knockoutPoints: t.knockout_points,
    startingStack: t.starting_stack,
    reentries: t.reentries,
    addons: t.addons,
    blindLevels: t.blind_levels,
  });
}

/** «NLH · Bounty · Re-entry · Add-on» — коротко для сообщений бота. */
export function gameLine(t: TournamentRow): string {
  return [GAME_SHORT[t.game], ...rowFormats(t).map((f) => FORMAT_LABELS[f])].join(' · ');
}
