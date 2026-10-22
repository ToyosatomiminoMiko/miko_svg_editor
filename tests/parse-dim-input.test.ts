/**
 * ui/parse-dim-input.ts 的尺寸输入解析（纯函数，node 环境）。
 * 尺寸工具要求「长度/半径」必须是有限正数：
 * 空串/空白、0、负数、非有限、十六进制、带千分位等一律拒绝；
 * 小数与指数写法接受；解析不做任何精度截断（回填 & 提交必须保留全精度，BUG-2）。
 */

import { describe, expect, it } from 'vitest';
import { parseDimInput } from '../src/ui/parse-dim-input';

describe('拒绝非法输入', () => {
  it.each(['', '   ', '\t\n'])('空白串 %j 拒绝', (raw) => {
    const result = parseDimInput(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it.each(['0', '-0', '0.0', '-5', '-1e3'])('非正数 %j 拒绝', (raw) => {
    const result = parseDimInput(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('大于 0');
  });

  it.each(['NaN', 'Infinity', '-Infinity', '1e999'])('非有限值 %j 拒绝', (raw) => {
    expect(parseDimInput(raw).ok).toBe(false);
  });

  it.each(['0x10', '1,5', 'abc', '1 2', '2px', '--1', '.', '1.2.3', '1e'])(
    '非十进制写法 %j 拒绝',
    (raw) => {
      expect(parseDimInput(raw).ok).toBe(false);
    },
  );
});

describe('接受合法输入', () => {
  it.each([
    ['2', 2],
    ['+2', 2],
    ['0.5', 0.5],
    ['.5', 0.5],
    ['3.5', 3.5],
    [' 3.5 ', 3.5],
    ['1.5e3', 1500],
    ['1E-3', 0.001],
    ['12.345', 12.345],
  ])('%j → %f', (raw, expected) => {
    const result = parseDimInput(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(expected);
  });

  it('保留输入数值的全精度，不做小数位截断', () => {
    const raw = '112.04500000000007';
    const result = parseDimInput(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 打开已有尺寸再回车时不能让 112.04500000000007 被改成 112.05
    expect(result.value).toBe(112.04500000000007);
    expect(String(result.value)).toBe(raw);
  });
});

describe('错误信息', () => {
  it('不同失败原因可区分：空白 / 非法格式 / 超范围 / 非正', () => {
    const blank = parseDimInput(' ');
    const format = parseDimInput('abc');
    const range = parseDimInput('1e999');
    const positive = parseDimInput('-1');
    if (blank.ok || format.ok || range.ok || positive.ok) throw new Error('应全部失败');
    expect(blank.reason).not.toBe(format.reason);
    expect(range.reason).not.toBe(format.reason);
    expect(positive.reason).not.toBe(range.reason);
  });
});
