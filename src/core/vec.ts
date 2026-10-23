/**
 * 二维向量小工具，只做纯函数运算，不依赖模型。
 */

import type { Vec } from './types';

export const vec = {
  sub(a: Vec, b: Vec): Vec {
    return { x: a.x - b.x, y: a.y - b.y };
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
  /** 长度；零长度返回 1，作为残差归一化的分母（避免除零，且零长度时残差为 0） */
  safeLen(a: Vec): number {
    return Math.hypot(a.x, a.y) || 1;
  },
  dist(a: Vec, b: Vec): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  },
  /** 左法线（逆时针 90°）的单位向量；零向量返回零向量，零分量避免出现 -0 */
  unitPerp(a: Vec): Vec {
    const l = Math.hypot(a.x, a.y);
    if (!l) return { x: 0, y: 0 };
    return { x: a.y === 0 ? 0 : -a.y / l, y: a.x / l };
  },
};
