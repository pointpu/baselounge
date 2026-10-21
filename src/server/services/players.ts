/**
 * Профиль игрока: DTO `Me`, смена никнейма и аватара.
 */
import type { Me, MePatch } from '../../shared/types.ts';
import { config } from '../config.ts';
import { tx } from '../db.ts';
import { badRequest, HttpError } from '../http.ts';
import * as repo from '../repo.ts';
import type { AvatarMime, PlayerRow } from '../repo.ts';
import { avatarUrl, displayName } from './ratings.ts';

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/**
 * Имя аватара в URL: `<player_id>-<version>.<ext>` (оно же хранится в players.avatar_file).
 * Версия растёт при каждой замене фото, поэтому URL меняется и кэш можно держать «вечно».
 */
export const AVATAR_FILE_RE = /^([1-9]\d{0,9})-([1-9]\d{0,9})\.(jpg|png|webp)$/;

export type AvatarExt = 'jpg' | 'png' | 'webp';
export const AVATAR_MIME: Record<AvatarExt, AvatarMime> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const EXT_BY_MIME: Record<AvatarMime, AvatarExt> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export function avatarFileName(playerId: number, version: number, mime: AvatarMime): string {
  return `${playerId}-${version}.${EXT_BY_MIME[mime]}`;
}

/** Разбирает имя из URL; null — имя не нашего формата. */
export function parseAvatarFileName(name: string): { playerId: number; version: number; ext: AvatarExt } | null {
  const m = AVATAR_FILE_RE.exec(name);
  if (!m) return null;
  const playerId = Number(m[1]);
  const version = Number(m[2]);
  if (playerId > 2_147_483_647 || version > 2_147_483_647) return null; // за пределами integer
  return { playerId, version, ext: m[3] as AvatarExt };
}

export function buildMe(player: PlayerRow, isAdmin: boolean): Me {
  return {
    player: {
      id: player.id,
      tgId: player.tg_id,
      name: displayName(player),
      nickname: player.nickname,
      avatarUrl: avatarUrl(player),
      phoneVerified: player.phone_verified,
    },
    isAdmin,
    club: { name: config.clubName, city: config.clubCity, tz: config.clubTz },
    notify: { announcements: player.notify_announcements, reminders: player.notify_reminders },
  };
}

/**
 * PATCH /api/me: никнейм (null/пустая строка — сбросить на имя из Telegram; длина проверена схемой
 * роута) и подписки на уведомления. Меняются только переданные поля.
 */
export async function updateMe(player: PlayerRow, patch: MePatch): Promise<PlayerRow> {
  await tx(async () => {
    if (patch.nickname !== undefined) await repo.setNickname(player.id, patch.nickname && patch.nickname.length > 0 ? patch.nickname : null);
    if (patch.notifyAnnouncements !== undefined || patch.notifyReminders !== undefined) {
      await repo.setNotifyPrefs(player.tg_id, { announcements: patch.notifyAnnouncements, reminders: patch.notifyReminders });
    }
  });
  return (await repo.findPlayerById(player.id))!;
}

/** Определяет формат картинки по сигнатуре (а не по заявленному MIME). */
export function detectImageExt(b: Uint8Array): AvatarExt | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length >= 8 && png.every((v, i) => b[i] === v)) return 'png';
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Сохраняет новый аватар в БД (таблица avatars) и обновляет его имя у игрока. */
export async function saveAvatar(player: PlayerRow, file: File): Promise<PlayerRow> {
  if (file.size === 0) throw badRequest('Файл пустой');
  if (file.size > AVATAR_MAX_BYTES) throw new HttpError(413, 'Фото больше 2 МБ — выберите файл поменьше');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = detectImageExt(bytes);
  if (!ext) throw new HttpError(415, 'Поддерживаются только JPEG, PNG и WebP');

  const mime = AVATAR_MIME[ext];
  await tx(async () => {
    const version = await repo.upsertAvatar(player.id, mime, bytes);
    await repo.setAvatarFile(player.id, avatarFileName(player.id, version, mime));
  });
  return (await repo.findPlayerById(player.id))!;
}
