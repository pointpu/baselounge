/**
 * Разовый перенос старых аватаров-файлов (до миграции 002) в таблицу avatars:
 *
 *   node --env-file-if-exists=.env src/server/import-avatars.ts [папка с медиа]
 *
 * Папка по умолчанию — MEDIA_DIR (`./data/media`), файлы ищутся в `<папка>/avatars/`.
 * Берутся игроки, у которых players.avatar_file — старое имя (32 hex-символа + расширение);
 * файл проверяется так же, как при загрузке (сигнатура JPEG/PNG/WebP, ≤ 2 МБ), записывается в БД,
 * а avatar_file получает новое имя `<id>-<version>.<ext>`. Повторный запуск безопасен: уже
 * перенесённые игроки пропускаются. Файлы на диске не удаляются.
 */
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { config, PROJECT_ROOT } from './config.ts';
import { closeDb, sql, tx } from './db.ts';
import { runMigrations } from './migrate.ts';
import * as repo from './repo.ts';
import { AVATAR_MAX_BYTES, AVATAR_MIME, avatarFileName, detectImageExt } from './services/players.ts';

/** Имена, которые генерировал сервер до 002 (только такие читаем с диска — без обхода путей). */
const LEGACY_FILE_RE = /^[0-9a-f]{32}\.(?:jpg|png|webp)$/;

async function main(): Promise<void> {
  const mediaDir = process.argv[2] ? resolve(PROJECT_ROOT, process.argv[2]) : config.mediaDir;
  const avatarsDir = join(mediaDir, 'avatars');
  await runMigrations();

  const players = await sql<{ id: number; avatar_file: string }[]>`
    SELECT id, avatar_file FROM players WHERE avatar_file IS NOT NULL ORDER BY id`;
  const stats = { imported: 0, skipped: 0, missing: 0, invalid: 0 };

  for (const p of players) {
    if (!LEGACY_FILE_RE.test(p.avatar_file)) {
      stats.skipped++; // уже в БД (новое имя) или неизвестный формат
      continue;
    }
    const path = join(avatarsDir, p.avatar_file);
    const size = await stat(path).then((s) => s.size).catch(() => null);
    if (size === null) {
      console.warn(`[avatars] игрок #${p.id}: файл ${p.avatar_file} не найден — пропуск`);
      stats.missing++;
      continue;
    }
    const bytes = size > 0 && size <= AVATAR_MAX_BYTES ? new Uint8Array(await readFile(path)) : null;
    const ext = bytes && detectImageExt(bytes);
    if (!bytes || !ext) {
      console.warn(`[avatars] игрок #${p.id}: ${p.avatar_file} — не JPEG/PNG/WebP или больше 2 МБ — пропуск`);
      stats.invalid++;
      continue;
    }
    const mime = AVATAR_MIME[ext];
    await tx(async (q) => {
      // Блокируем строку игрока и перепроверяем имя: параллельная загрузка через API важнее импорта.
      const [row] = await q<{ avatar_file: string | null }[]>`SELECT avatar_file FROM players WHERE id = ${p.id} FOR UPDATE`;
      if (row?.avatar_file !== p.avatar_file) return;
      const version = await repo.upsertAvatar(p.id, mime, bytes);
      await repo.setAvatarFile(p.id, avatarFileName(p.id, version, mime));
      stats.imported++;
    });
  }

  console.log(
    `[avatars] готово: перенесено ${stats.imported}, уже в БД/пропущено ${stats.skipped}, ` +
      `нет файла ${stats.missing}, некорректных ${stats.invalid} (папка ${avatarsDir})`,
  );
}

try {
  await main();
} catch (err) {
  console.error(`[avatars] ошибка: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
