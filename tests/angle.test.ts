/**
 * config/angle.ts 的扫角与角度归一化约定。
 * 关键不变量：sweepOf 的返回值范围是 (0, TAU]，起点终点同角 → 整圆（TAU）而不是 0；
 * 整圆弧在预览、渲染、拾取、导出四处必须只有一种解释，所以这里把边界情况全钉住。
 */

import { describe, expect, it } from 'vitest';
import {
  ARC_MIN_SEGMENTS,
  ARC_SEGMENTS_PER_TURN,
  SWEEP_EPS,
  TAU,
  arcSegments,
  isFullSweep,
  normalizeAngle,
  sweepOf,
  wrapPi,
} from '../src/config/angle';

describe('normalizeAngle', () => {
  it('把角度归一化到 [0, TAU)', () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(TAU)).toBe(0);
    expect(normalizeAngle(-TAU)).toBe(0);
    expect(normalizeAngle(Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12);
    expect(normalizeAngle(-Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2, 12);
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
  });

  it('对任意角度，结果都落在 [0, TAU)', () => {
    const angles = [-10, -TAU, -TAU / 3, -1e-12, 0, 1e-12, Math.PI, TAU - 1e-12, 10, 123.456];
    for (const angle of angles) {
      const normalized = normalizeAngle(angle);
      expect(normalized).toBeGreaterThanOrEqual(0);
      expect(normalized).toBeLessThan(TAU);
    }
  });
});

describe('wrapPi', () => {
  it('把角度归一化到 (-π, π]', () => {
    expect(wrapPi(0)).toBe(0);
    expect(wrapPi(Math.PI)).toBe(Math.PI);
    // -π 经 normalizeAngle 变成 π，因此边界值取 +π（区间是左开右闭）
    expect(wrapPi(-Math.PI)).toBe(Math.PI);
    expect(wrapPi(TAU - 0.1)).toBeCloseTo(-0.1, 12);
    expect(wrapPi(Math.PI + 0.1)).toBeCloseTo(-Math.PI + 0.1, 12);
    expect(wrapPi(-Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 12);
  });

  it('对任意角度，结果都落在 (-π, π]', () => {
    const angles = [-10, -TAU, -Math.PI, -1e-12, 0, 1e-12, Math.PI, Math.PI + 1, 10, 123.456];
    for (const angle of angles) {
      const wrapped = wrapPi(angle);
      expect(wrapped).toBeGreaterThan(-Math.PI);
      expect(wrapped).toBeLessThanOrEqual(Math.PI);
    }
  });
});

describe('sweepOf', () => {
  it('顺向扫角直接取差值', () => {
    expect(sweepOf(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12);
    expect(sweepOf(Math.PI / 2, Math.PI)).toBeCloseTo(Math.PI / 2, 12);
    expect(sweepOf(0, Math.PI)).toBeCloseTo(Math.PI, 12);
  });

  it('终点在起点逆时针方向时的跨界扫角为正', () => {
    // 从 3π/2 到 π/2 是逆时针 180°，不是 -180°
    expect(sweepOf((3 * Math.PI) / 2, Math.PI / 2)).toBeCloseTo(Math.PI, 12);
    // 从 0 到 -π/2 等价于正向 270°
    expect(sweepOf(0, -Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2, 12);
    // 从 π/2 到 0 正向扫 270°
    expect(sweepOf(Math.PI / 2, 0)).toBeCloseTo((3 * Math.PI) / 2, 12);
  });

  it('起点终点同角（含浮点误差）返回整圈 TAU', () => {
    expect(sweepOf(0, 0)).toBe(TAU);
    expect(sweepOf(Math.PI, Math.PI)).toBe(TAU);
    expect(sweepOf(0, TAU)).toBe(TAU);
    expect(sweepOf(TAU, 0)).toBe(TAU);
    expect(sweepOf(-Math.PI / 3, -Math.PI / 3)).toBe(TAU);
    // 差值小于 SWEEP_EPS 视为重合（正负两个方向都要归一成整圆）
    expect(sweepOf(0, SWEEP_EPS / 2)).toBe(TAU);
    expect(sweepOf(0, -SWEEP_EPS / 2)).toBe(TAU);
  });

  it('差值大于 SWEEP_EPS 时正常返回，不被当成整圆', () => {
    expect(sweepOf(0, SWEEP_EPS * 10)).toBeCloseTo(SWEEP_EPS * 10, 15);
  });

  it('对任意起终点，结果都在 (0, TAU]', () => {
    const angles = [-TAU, -Math.PI, -1e-12, 0, 1e-12, Math.PI / 2, Math.PI, TAU];
    for (const a0 of angles) {
      for (const a1 of angles) {
        const sweep = sweepOf(a0, a1);
        expect(sweep).toBeGreaterThan(0);
        expect(sweep).toBeLessThanOrEqual(TAU);
      }
    }
  });
});

describe('isFullSweep', () => {
  it('整圈及其浮点边界判定为 true', () => {
    expect(isFullSweep(TAU)).toBe(true);
    expect(isFullSweep(TAU - SWEEP_EPS / 2)).toBe(true);
  });

  it('不足一圈判定为 false', () => {
    expect(isFullSweep(Math.PI)).toBe(false);
    expect(isFullSweep(0)).toBe(false);
    expect(isFullSweep(TAU - 2 * SWEEP_EPS)).toBe(false);
  });
});

describe('arcSegments', () => {
  it('整圈用 ARC_SEGMENTS_PER_TURN 段，半圈折半', () => {
    expect(arcSegments(TAU)).toBe(ARC_SEGMENTS_PER_TURN);
    expect(arcSegments(TAU / 2)).toBe(ARC_SEGMENTS_PER_TURN / 2);
    expect(arcSegments(TAU / 4)).toBe(ARC_SEGMENTS_PER_TURN / 4);
  });

  it('极小扫角也至少有 ARC_MIN_SEGMENTS 段', () => {
    expect(arcSegments(SWEEP_EPS * 10)).toBe(ARC_MIN_SEGMENTS);
    expect(arcSegments(1e-6)).toBe(ARC_MIN_SEGMENTS);
  });

  it('段数随扫角单调不减', () => {
    const sweeps = [1e-9, 1e-3, 0.1, 1, Math.PI, TAU / 2, TAU];
    let previous = 0;
    for (const sweep of sweeps) {
      const segments = arcSegments(sweep);
      expect(segments).toBeGreaterThanOrEqual(previous);
      expect(segments).toBeGreaterThanOrEqual(ARC_MIN_SEGMENTS);
      previous = segments;
    }
  });
});
