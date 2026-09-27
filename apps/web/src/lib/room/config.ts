export type RoomConfig =
  | { mode: "mock" }
  | { mode: "party"; host: string; party: string | undefined }
  | { mode: "unconfigured"; reason: string };

export type RoomEnv = {
  mock: string | undefined;
  host: string | undefined;
  party: string | undefined;
};

export const readRoomEnv = (): RoomEnv => ({
  mock: process.env.NEXT_PUBLIC_ROOM_MOCK,
  host: process.env.NEXT_PUBLIC_ROOM_HOST,
  party: process.env.NEXT_PUBLIC_ROOM_PARTY,
});

const blankToUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export const resolveRoomConfig = (env: RoomEnv): RoomConfig => {
  if (env.mock?.trim() === "1") return { mode: "mock" };
  const host = blankToUndefined(env.host);
  if (!host) {
    return {
      mode: "unconfigured",
      reason:
        "NEXT_PUBLIC_ROOM_HOST is not set, so there is no room server to connect to. Set it, or set NEXT_PUBLIC_ROOM_MOCK=1 to play against simulated players.",
    };
  }
  return { mode: "party", host: host.replace(/^(wss?|https?):\/\//, ""), party: blankToUndefined(env.party) };
};
