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

export const CHAIN_TARGET: Rect = { x: 80, y: 40, width: 1760, height: 880 };
export const CHAIN_MAX_UPSCALE = 1.8;
const CHAIN_PADDING = 32;

export const even = (n: number): number => 2 * Math.floor(n / 2);
const evenUp = (n: number): number => 2 * Math.ceil(n / 2);

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

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

const sizeForAspect = (padded: Size, aspect: number, minWidth: number, frame: Size): Size => {
  let width = Math.max(padded.width, padded.height * aspect, minWidth);
  let height = width / aspect;
  if (width > frame.width) {
    width = frame.width;
    height = width / aspect;
  }
  if (height > frame.height) {
    height = frame.height;
    width = height * aspect;
  }
  return { width: Math.min(evenUp(width), even(frame.width)), height: Math.min(evenUp(height), even(frame.height)) };
};

export const cropForChain = (box: Rect, frame: Size, target: Rect, maxUpscale: number): Rect => {
  const padded = { width: box.width + 2 * CHAIN_PADDING, height: box.height + 2 * CHAIN_PADDING };
  const size = sizeForAspect(padded, target.width / target.height, target.width / maxUpscale, frame);
  const centreX = box.x + box.width / 2;
  const centreY = box.y + box.height / 2;
  return {
    x: Math.round(clamp(centreX - size.width / 2, 0, frame.width - size.width)),
    y: Math.round(clamp(centreY - size.height / 2, 0, frame.height - size.height)),
    ...size,
  };
};
