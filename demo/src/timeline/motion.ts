import { clamp01, cubicBezier, lerp, progress } from "./timeline";

const STAMP_SECONDS = 0.42;
const FEED_SECONDS = 0.52;
const stampCurve = cubicBezier(0.2, 1.4, 0.4, 1);
const feedCurve = cubicBezier(0.2, 0.8, 0.2, 1);

export type StampPose = { opacity: number; scale: number; rotate: number };

export const stampAt = (t: number, start: number, tiltDeg: number): StampPose => {
  if (t < start) return { opacity: 0, scale: 1.9, rotate: -3 };
  const raw = progress(t, start, STAMP_SECONDS);
  const eased = stampCurve(raw);
  const opacity = raw < 0.6 ? lerp(0, 1, raw / 0.6) : lerp(1, 0.94, (raw - 0.6) / 0.4);
  return { opacity: clamp01(opacity), scale: lerp(1.9, 1, eased), rotate: lerp(-3, tiltDeg, eased) };
};

export const stampStyle = (pose: StampPose): string =>
  `opacity:${pose.opacity.toFixed(3)};transform:rotate(${pose.rotate.toFixed(2)}deg) scale(${pose.scale.toFixed(3)})`;

export type FeedPose = { clipBottom: number; translateY: number };

export const feedAt = (t: number, start: number): FeedPose => {
  const eased = feedCurve(progress(t, start, FEED_SECONDS));
  return { clipBottom: lerp(100, 0, eased), translateY: lerp(-12, 0, eased) };
};

export const feedStyle = (pose: FeedPose): string =>
  `clip-path:inset(0 0 ${pose.clipBottom.toFixed(2)}% 0);transform:translateY(${pose.translateY.toFixed(2)}px)`;

export const fadeStyle = (t: number, start: number, duration = 0.35, rise = 10): string => {
  const eased = feedCurve(progress(t, start, duration));
  return `opacity:${eased.toFixed(3)};transform:translateY(${lerp(rise, 0, eased).toFixed(2)}px)`;
};
