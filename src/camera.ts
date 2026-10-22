/**
 * 视图/相机。
 * 世界坐标 y 向下（与 SVG 一致）；cam.x / cam.y 是画布中心对应的世界坐标。
 */

import type { Vec } from './types';

export interface Camera {
  x: number;
  y: number;
  z: number;
  /** 视口尺寸（CSS 像素），由 Renderer.resize 同步 */
  W: number;
  H: number;
}

export const cam: Camera = { x: 0, y: 0, z: 1, W: 0, H: 0 };

export const w2s = (p: Vec): Vec => ({
  x: (p.x - cam.x) * cam.z + cam.W / 2,
  y: (p.y - cam.y) * cam.z + cam.H / 2,
});

export const s2w = (p: Vec): Vec => ({
  x: (p.x - cam.W / 2) / cam.z + cam.x,
  y: (p.y - cam.H / 2) / cam.z + cam.y,
});

/** 以屏幕点 sp 为锚点缩放，保证锚点下的世界坐标不动 */
export function zoomAt(sp: Vec, factor: number): void {
  const before = s2w(sp);
  cam.z = Math.min(80, Math.max(0.02, cam.z * factor));
  const after = s2w(sp);
  cam.x += before.x - after.x;
  cam.y += before.y - after.y;
}

/** 网格间距取 10 的 2 倍幂，使屏幕间距保持在 20~60px */
export function gridSize(): number {
  let g = 10;
  while (g * cam.z < 20) g *= 2;
  while (g * cam.z > 60) g /= 2;
  return g;
}
