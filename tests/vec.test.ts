/**
 * vec.ts 的二维向量纯函数。
 * 重点覆盖求解器/几何依赖的性质：safeLen 零向量返回 1（残差归一化分母不为 0）、
 * unitPerp 零向量返回零向量、unitPerp 与输入正交且单位长度。
 */

import { describe, expect, it } from 'vitest';
import { vec } from '../src/vec';

describe('vec.sub', () => {
  it('逐分量相减', () => {
    expect(vec.sub({ x: 3, y: 4 }, { x: 1, y: 1 })).toEqual({ x: 2, y: 3 });
    expect(vec.sub({ x: 0, y: 0 }, { x: -2, y: 5 })).toEqual({ x: 2, y: -5 });
  });
});

describe('vec.dot / vec.crs', () => {
  it('点积：正交为 0，同向为正，反向为负', () => {
    expect(vec.dot({ x: 1, y: 0 }, { x: 0, y: 1 })).toBe(0);
    expect(vec.dot({ x: 1, y: 0 }, { x: 1, y: 0 })).toBe(1);
    expect(vec.dot({ x: 1, y: 1 }, { x: 1, y: 1 })).toBe(2);
    expect(vec.dot({ x: 1, y: 0 }, { x: -1, y: 0 })).toBe(-1);
  });

  it('叉积：y 向下的坐标系里正负号由绕向决定', () => {
    expect(vec.crs({ x: 1, y: 0 }, { x: 0, y: 1 })).toBe(1);
    expect(vec.crs({ x: 0, y: 1 }, { x: 1, y: 0 })).toBe(-1);
    expect(vec.crs({ x: 1, y: 1 }, { x: 2, y: 2 })).toBe(0);
  });
});

describe('vec.len / vec.safeLen / vec.dist', () => {
  it('len 用 hypot，3-4-5 直角三角形', () => {
    expect(vec.len({ x: 3, y: 4 })).toBe(5);
    expect(vec.len({ x: 0, y: 0 })).toBe(0);
    expect(vec.len({ x: -3, y: -4 })).toBe(5);
  });

  it('safeLen 零向量返回 1，非零时与 len 一致', () => {
    expect(vec.safeLen({ x: 0, y: 0 })).toBe(1);
    expect(vec.safeLen({ x: 3, y: 4 })).toBe(5);
  });

  it('dist 是两点距离', () => {
    expect(vec.dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(vec.dist({ x: 2, y: 2 }, { x: 2, y: 2 })).toBe(0);
  });
});

describe('vec.unitPerp', () => {
  it('逆时针 90° 的单位左法线', () => {
    expect(vec.unitPerp({ x: 1, y: 0 })).toEqual({ x: 0, y: 1 });
    expect(vec.unitPerp({ x: 0, y: 1 })).toEqual({ x: -1, y: 0 });
  });

  it('零分量归一成 +0，不会产出 -0', () => {
    // -a.y / l 在 a.y = 0 时是 -0；-0 会出现在坐标比较、序列化与 SVG 输出里
    expect(vec.unitPerp({ x: 1, y: 0 }).x).toBe(0);
    expect(vec.unitPerp({ x: -1, y: 0 }).x).toBe(0);
    expect(vec.unitPerp({ x: 0, y: 1 }).y).toBe(0);
    expect(vec.unitPerp({ x: 0, y: -1 }).y).toBe(0);
  });

  it('长度归一到 1（方向不变，与输入长度无关）', () => {
    for (const input of [
      { x: 3, y: 4 },
      { x: -3, y: 4 },
      { x: 0.5, y: -0.25 },
    ]) {
      const perpendicular = vec.unitPerp(input);
      expect(vec.len(perpendicular)).toBeCloseTo(1, 12);
      expect(vec.dot(input, perpendicular)).toBeCloseTo(0, 12);
    }
  });

  it('零向量返回零向量（不做除零）', () => {
    expect(vec.unitPerp({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });
});
