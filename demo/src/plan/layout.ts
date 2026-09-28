export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };

export const FRAME: Size = { width: 1920, height: 1080 };
export const FPS = 30;
export const PHONE_VIEWPORT: Size = { width: 390, height: 844 };

export const FULL_FRAME: Rect = { x: 0, y: 0, ...FRAME };

export const PLAY_LAYOUT = {
  stage: { x: 48, y: 150, width: 1360, height: 766 },
  phone: { x: 1452, y: 70, width: 420, height: 908 },
  phoneRadius: 44,
  bezel: 14,
} as const;

export const SPOTLIGHT_PADDING = 24;

export const even = (n: number): number => 2 * Math.floor(n / 2);

export const fitInto = (content: Size, box: Rect): Rect => {
  const scale = Math.min(box.width / content.width, box.height / content.height);
  const width = even(content.width * scale);
  const height = even(content.height * scale);
  return {
    x: Math.round(box.x + (box.width - width) / 2),
    y: Math.round(box.y + (box.height - height) / 2),
    width,
    height,
  };
};

export const phoneCrop = (video: Size, viewport: Size): Rect | null => {
  if (video.width < viewport.width || video.height < viewport.height) {
    throw new Error(
      `The phone video is ${video.width}x${video.height}, smaller than the phone viewport ${viewport.width}x${viewport.height}.`,
    );
  }
  if (video.width === viewport.width && video.height === viewport.height) return null;
  return { x: 0, y: 0, ...viewport };
};

export const spotlight = (box: Rect, frame: Size, padding: number): Rect => {
  const left = Math.max(0, Math.round(box.x - padding));
  const top = Math.max(0, Math.round(box.y - padding));
  const right = Math.min(frame.width, Math.round(box.x + box.width + padding));
  const bottom = Math.min(frame.height, Math.round(box.y + box.height + padding));
  return { x: left, y: top, width: right - left, height: bottom - top };
};
