import { ROOM_CODE_LENGTH } from "@nailed-it/protocol";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_PATTERN = new RegExp(`^[A-Z]{${ROOM_CODE_LENGTH}}$`);

export const normalizeRoomCode = (input: string): string =>
  input.toUpperCase().replace(/[^A-Z]/g, "").slice(0, ROOM_CODE_LENGTH);

export const isValidRoomCode = (code: string): boolean => CODE_PATTERN.test(code);

export const generateRoomCode = (random: () => number = Math.random): string =>
  Array.from({ length: ROOM_CODE_LENGTH }, () => {
    const index = Math.floor(random() * CODE_ALPHABET.length);
    return CODE_ALPHABET[index] ?? "A";
  }).join("");

export const NICKNAME_MAX = 20;

export type NicknameCheck = { ok: true; nickname: string } | { ok: false; reason: string };

export const checkNickname = (input: string): NicknameCheck => {
  const nickname = input.trim().replace(/\s+/g, " ");
  if (nickname.length === 0) return { ok: false, reason: "Enter a nickname." };
  if (nickname.length > NICKNAME_MAX) {
    return { ok: false, reason: `Keep it to ${NICKNAME_MAX} characters.` };
  }
  return { ok: true, nickname };
};
