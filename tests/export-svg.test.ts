/**
 * export-svg.ts 的纯导出逻辑（node 环境，不碰 window/document）。
 * 关键语义：整圆弧（a0 == a1）导出 <circle>；部分弧用 A 命令且 large-arc/sweep 正确；
 * construction 图元带虚线；style 可覆盖；输出里不允许出现 NaN / Infinity。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_STYLE, EXPORT_DASH, EXPORT_STROKE } from '../src/config';
import { buildSVG } from '../src/export-svg';
import { addArc, addCircle, addLine, addPt, clearModel } from '../src/model';

beforeEach(() => {
  clearModel();
});

describe('空模型', () => {
  it('没有图元返回 null（点/约束不算可导出内容）', () => {
    expect(buildSVG()).toBeNull();
    addPt(0, 0);
    expect(buildSVG()).toBeNull();
  });
});

describe('图元导出', () => {
  it('直线导出 <line>，无虚线', () => {
    addLine(addPt(0, 0), addPt(10, 10));
    const svg = buildSVG();
    expect(svg).not.toBeNull();
    expect(svg).toContain('<line x1="0" y1="0" x2="10" y2="10"/>');
  });

  it('圆导出 <circle>', () => {
    addCircle(addPt(0, 0), 10);
    expect(buildSVG()).toContain('<circle cx="0" cy="0" r="10"/>');
  });

  it('整圆弧（a0 === a1）导出 <circle> 而不是退化的 path', () => {
    addArc(addPt(0, 0), 10, 0, 0);
    const svg = buildSVG();
    expect(svg).toContain('<circle cx="0" cy="0" r="10"/>');
    expect(svg).not.toContain('<path');
  });

  it('部分圆弧导出 <path>，小弧 large-arc=0、sweep=1', () => {
    addArc(addPt(0, 0), 10, 0, Math.PI / 2);
    const svg = buildSVG();
    // 起点 (10,0)、终点 (0,10)，扫角 π/2 < π → A rx ry rot large sweep x y 中为 0 0 1
    expect(svg).toContain('<path d="M 10 0 A 10 10 0 0 1 0 10"/>');
  });

  it('大弧导出 large-arc=1', () => {
    addArc(addPt(0, 0), 10, 0, (3 * Math.PI) / 2);
    const svg = buildSVG();
    // 扫角 3π/2 > π → large-arc=1、sweep=1
    expect(svg).toContain('A 10 10 0 1 1');
  });

  it('construction 图元带虚线，普通图元不带', () => {
    const line = addLine(addPt(0, 0), addPt(10, 0));
    line.construction = true;
    expect(buildSVG()).toContain(`stroke-dasharray="${EXPORT_DASH}"`);

    clearModel();
    addLine(addPt(0, 0), addPt(10, 0));
    expect(buildSVG()).not.toContain('stroke-dasharray');
  });

  it('输出不含 NaN / Infinity（含各类图元）', () => {
    addLine(addPt(0, 0), addPt(10, 10));
    addCircle(addPt(5, 5), 3);
    addArc(addPt(20, 20), 4, 0.5, 2.5);
    const svg = buildSVG();
    expect(svg).not.toBeNull();
    expect(svg).not.toMatch(/NaN|Infinity|-Infinity/);
  });
});

describe('样式覆盖', () => {
  it('默认描边来自 config/export', () => {
    addLine(addPt(0, 0), addPt(10, 0));
    expect(buildSVG()).toContain(`stroke="${EXPORT_STROKE}"`);
    expect(DEFAULT_EXPORT_STYLE.stroke).toBe(EXPORT_STROKE);
  });

  it('覆盖 stroke / lineCap / dash 后按覆盖值输出', () => {
    const line = addLine(addPt(0, 0), addPt(10, 0));
    line.construction = true;
    const svg = buildSVG({ stroke: '#f00', lineCap: 'butt', dash: '2 2' });
    expect(svg).toContain('stroke="#f00"');
    expect(svg).toContain('stroke-linecap="butt"');
    expect(svg).toContain('stroke-dasharray="2 2"');
  });

  it('部分覆盖时未覆盖字段保留默认值', () => {
    addLine(addPt(0, 0), addPt(10, 0));
    const svg = buildSVG({ stroke: '#123456' });
    expect(svg).toContain('stroke="#123456"');
    expect(svg).toContain(`stroke-linecap="${DEFAULT_EXPORT_STYLE.lineCap}"`);
  });
});

describe('画布标定', () => {
  it('根元素带 viewBox 与宽高，数值来自包围盒', () => {
    addCircle(addPt(0, 0), 10);
    const svg = buildSVG();
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="-12 -12 24 24"');
    expect(svg).toContain('width="24"');
    expect(svg).toContain('height="24"');
  });

  it('线宽取包围盒最长边比例并受最小值约束', () => {
    addCircle(addPt(0, 0), 10); // bw=24 → 24/500 < 0.2 → 最小线宽 0.2
    expect(buildSVG()).toContain('stroke-width="0.2"');
  });
});
