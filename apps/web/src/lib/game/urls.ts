export type RoomUrls = { join: string; stage: string; display: string };

export const roomUrls = (origin: string, code: string): RoomUrls => {
  const base = origin.replace(/\/+$/, "");
  return {
    join: `${base}/room/${code}`,
    stage: `${base}/room/${code}/stage`,
    display: base.replace(/^https?:\/\//, ""),
  };
};
