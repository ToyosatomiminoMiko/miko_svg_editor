/**
 * 二维向量小工具，只做纯函数运算，不依赖模型。
 */

import type { Vec } from './types';

export const vec = {
  sub(a: Vec, b: Vec): Vec {
    return { x: a.x - b.x, y: a.y - b.y };
  },
  add(a: Vec, b: Vec): Vec {
    return { x: a.x + b.x, y: a.y + b.y };
  },
  mul(a: Vec, s: number): Vec {
    return { x: a.x * s, y: a.y * s };
  },
  dot(a: Vec, b: Vec): number {
    return a.x * b.x + a.y * b.y;
  },
  crs(a: Vec, b: Vec): number {
    return a.x * b.y - a.y * b.x;
  },
  len(a: Vec): number {
    return Math.hypot(a.x, a.y);
  },
  dist(a: Vec, b: Vec): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  },
  /** 单位化；零向量返回自身 */
  norm(a: Vec): Vec {
    const l = Math.hypot(a.x, a.y) || 1;
    return { x: a.x / l, y: a.y / l };
  },
  perp(a: Vec): Vec {
    return { x: -a.y, y: a.x };
  },
};
