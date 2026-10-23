/**
 * config/format.ts 的数字格式化。
 * 显示与回填分开：这里只测显示格式——固定小数位、去尾零、-0 归一、非有限值兜底
 * （非有限值返回 "0"，避免把 NaN / Infinity 写进 SVG 或输入框）。
 */

import { describe, expect, it } from 'vitest';
import { DIM_DECIMALS, formatDimValue, formatNumber } from '../../src/config/format';

describe('formatNumber', () => {
  it('按固定小数位四舍五入', () => {
    expect(formatNumber(1.23456, 2)).toBe('1.23');
    expect(formatNumber(1.239, 2)).toBe('1.24');
    expect(formatNumber(1.26, 1)).toBe('1.3');
    expect(formatNumber(-1.26, 1)).toBe('-1.3');
    expect(formatNumber(2.6, 0)).toBe('3');
    expect(formatNumber(2.5, 0)).toBe('3');
  });

  it('去掉小数末尾多余的 0，也去掉整数后的小数点', () => {
    expect(formatNumber(2.5, 2)).toBe('2.5');
    expect(formatNumber(0.5, 2)).toBe('0.5');
    expect(formatNumber(2, 2)).toBe('2');
    expect(formatNumber(100, 3)).toBe('100');
    expect(formatNumber(1.25, 1)).toBe('1.3');
  });

  it('-0 归一成 0', () => {
    expect(formatNumber(-0, 2)).toBe('0');
    // 负数四舍五入到 0 时 toFixed 会给出 "-0.00"，必须归一，否则界面上出现 "-0"
    expect(formatNumber(-0.001, 2)).toBe('0');
  });

  it('非有限值返回 0', () => {
    expect(formatNumber(Number.NaN, 2)).toBe('0');
    expect(formatNumber(Number.POSITIVE_INFINITY, 2)).toBe('0');
    expect(formatNumber(Number.NEGATIVE_INFINITY, 2)).toBe('0');
  });

  it('decimals 为 0 时不带小数点', () => {
    expect(formatNumber(0, 0)).toBe('0');
    expect(formatNumber(-0.4, 0)).toBe('0');
    expect(formatNumber(12.3, 0)).toBe('12');
  });

  it('结果永远是合法数字字符串（可被 Number 解析且等于原值附近的显示值）', () => {
    const values = [0, 1, -1, 1.23456, -1.23456, 12345.6789, 1e-7, -1e-7];
    for (const value of values) {
      const text = formatNumber(value, DIM_DECIMALS);
      expect(text).not.toMatch(/^-0(\.0+)?$/);
      expect(Number.isFinite(Number(text))).toBe(true);
      expect(text).not.toContain('e');
    }
  });
});

describe('formatDimValue', () => {
  it('用 DIM_DECIMALS 位小数格式化尺寸显示值', () => {
    expect(DIM_DECIMALS).toBe(2);
    expect(formatDimValue(1.23456)).toBe('1.23');
    expect(formatDimValue(1.239)).toBe('1.24');
    expect(formatDimValue(42)).toBe('42');
    expect(formatDimValue(Number.NaN)).toBe('0');
  });
});
