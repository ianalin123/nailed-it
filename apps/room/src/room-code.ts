import { ROOM_CODE_LENGTH } from "@nailed-it/protocol";

const ROOM_CODE_PATTERN = new RegExp(`^[A-Z]{${ROOM_CODE_LENGTH}}$`);

export const isValidRoomCode = (name: string): boolean => ROOM_CODE_PATTERN.test(name);
