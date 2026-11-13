/**
 * svg-import.ts 的纯逻辑:SVG 元素树 -> 导入计划(世界坐标图元)-> 写模型.
 * 全部在 node 环境跑(不需要 DOMParser):树由本文件用最小构造器手工拼出,
 * 覆盖图元识别,点复用,transform 继承,圆弧扫向,损失警告与上限截断.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  IMPORT_CURVE_SEGMENTS,
  IMPORT_ELLIPSE_SEGMENTS,
  IMPORT_MAX_SHAPES,
  TAU,
} from '../../src/config';
import {
  applySvgImport,
  countImportableShapes,
  planSvgImport,
  type SvgNode,
} from '../../src/core/svg-import';
import { clearModel, model, primitiveOf } from '../../src/core/model';
import { PointEntity } from '../../src/core/entities';

beforeEach(() => {
  clearModel();
});

/** 最小元素构造器:tag + 属性 + 子节点 */
const node = (
  tag: string,
  attrs: Readonly<Record<string, string>> = {},
  children: readonly SvgNode[] = [],
): SvgNode => ({ tag, attrs, children });

/** 根 <svg>;导入只关心元素树,不需要 viewBox */
const svg = (...children: SvgNode[]): SvgNode => node('svg', {}, children);

const entities = (): ReturnType<typeof primitiveOf>[] =>
  [...model.ents.values()].map((e) => primitiveOf(e));

const importOf = (root: SvgNode): number => {
  const plan = planSvgImport(root);
  applySvgImport(plan);
  return model.ents.size;
};

describe('基础图元识别', () => {
  it('line 导入为直线,端点坐标原样保留', () => {
    const plan = planSvgImport(svg(node('line', { x1: '0', y1: '0', x2: '10', y2: '5' })));
    expect(plan.shapes).toHaveLength(1);
    expect(plan.shapes[0]?.primitive).toEqual({
      kind: 'segment',
      a: { x: 0, y: 0 },
      b: { x: 10, y: 5 },
    });
    expect(importOf(svg(node('line', { x1: '0', y1: '0', x2: '10', y2: '5' })))).toBe(1);
    // primitive 里的点是模型 Point(带 id/fixed),只比较几何坐标
    expect(entities()[0]).toMatchObject({ kind: 'segment', a: { x: 0, y: 0 }, b: { x: 10, y: 5 } });
  });

  it('circle 导入为圆,半径是独立参数', () => {
    importOf(svg(node('circle', { cx: '10', cy: '20', r: '5' })));
    expect(entities()[0]).toMatchObject({ kind: 'circular', radius: 5 });
  });

  it('矩形按四条边导入(直角)', () => {
    const plan = planSvgImport(svg(node('rect', { x: '0', y: '0', width: '10', height: '5' })));
    expect(plan.shapes).toHaveLength(4);
    expect(importOf(svg(node('rect', { x: '0', y: '0', width: '10', height: '5' })))).toBe(4);
  });

  it('圆角矩形按直角导入并给出损失警告', () => {
    const plan = planSvgImport(
      svg(node('rect', { x: '0', y: '0', width: '10', height: '5', rx: '2' })),
    );
    expect(plan.shapes).toHaveLength(4);
    expect(plan.warnings.some((w) => w.includes('圆角'))).toBe(true);
  });

  it('polyline 只连相邻点;polygon 额外闭合', () => {
    const polyline = planSvgImport(svg(node('polyline', { points: '0,0 10,0 10,10' })));
    const polygon = planSvgImport(svg(node('polygon', { points: '0,0 10,0 10,10' })));
    expect(polyline.shapes).toHaveLength(2);
    expect(polygon.shapes).toHaveLength(3);
  });

  it('ellipse 用折线逼近(正圆则复用圆图元)', () => {
    const ellipse = planSvgImport(svg(node('ellipse', { cx: '0', cy: '0', rx: '10', ry: '5' })));
    const circle = planSvgImport(svg(node('ellipse', { cx: '0', cy: '0', rx: '10', ry: '10' })));
    // 闭合折线:采样 n 个点,相邻 n-1 段 + 末尾回起点 1 段 = n 段
    expect(ellipse.shapes).toHaveLength(IMPORT_ELLIPSE_SEGMENTS);
    expect(circle.shapes).toHaveLength(1);
    expect(ellipse.warnings.some((w) => w.includes('椭圆'))).toBe(true);
  });
});

describe('构造几何与点图元', () => {
  it('继承的 stroke-dasharray 把图元标成构造', () => {
    const plan = planSvgImport(
      svg(
        node('g', { 'stroke-dasharray': '5 5' }, [
          node('line', { x1: '0', y1: '0', x2: '10', y2: '0' }),
        ]),
      ),
    );
    expect(plan.shapes[0]?.construction).toBe(true);
    importOf(
      svg(
        node('g', { 'stroke-dasharray': '5 5' }, [
          node('line', { x1: '0', y1: '0', x2: '10', y2: '0' }),
        ]),
      ),
    );
    const line = [...model.ents.values()][0];
    expect(line?.construction).toBe(true);
  });

  it('显式 fill + stroke="none" 的圆识别为点图元(导出往返)', () => {
    const plan = planSvgImport(
      svg(node('circle', { cx: '3', cy: '4', r: '0.32', fill: '#111', stroke: 'none' })),
    );
    expect(plan.shapes[0]?.primitive).toEqual({ kind: 'point', at: { x: 3, y: 4 } });
    importOf(svg(node('circle', { cx: '3', cy: '4', r: '0.32', fill: '#111', stroke: 'none' })));
    expect([...model.ents.values()][0]).toBeInstanceOf(PointEntity);
  });

  it('继承 fill=none 的普通圆不误判成点', () => {
    const plan = planSvgImport(
      svg(
        node('g', { fill: 'none', stroke: '#111' }, [node('circle', { cx: '0', cy: '0', r: '5' })]),
      ),
    );
    expect(plan.shapes[0]?.primitive.kind).toBe('circle');
  });
});

describe('点复用与退化图元', () => {
  it('坐标相同的共享端点复用同一个点', () => {
    const root = svg(
      node('line', { x1: '0', y1: '0', x2: '10', y2: '0' }),
      node('line', { x1: '10', y1: '0', x2: '10', y2: '10' }),
    );
    const applied = (() => {
      const plan = planSvgImport(root);
      return applySvgImport(plan);
    })();
    expect(applied.entities).toBe(2);
    expect(applied.points).toBe(3);
    expect(model.pts.size).toBe(3);
  });

  it('零长度线段与零半径圆被丢弃并计数', () => {
    const root = svg(
      node('line', { x1: '5', y1: '5', x2: '5', y2: '5' }),
      node('circle', { cx: '0', cy: '0', r: '0' }),
    );
    const applied = applySvgImport(planSvgImport(root));
    expect(applied.entities).toBe(0);
    // 零半径圆在计划阶段已被过滤;零长度线段保留到 apply 再丢弃
    expect(applied.skipped).toBe(1);
  });
});

describe('transform 继承', () => {
  it('g 上的 translate + scale 按 SVG 语义累乘到坐标', () => {
    const plan = planSvgImport(
      svg(
        node('g', { transform: 'translate(10 20) scale(2)' }, [
          node('line', { x1: '1', y1: '1', x2: '2', y2: '2' }),
        ]),
      ),
    );
    expect(plan.shapes[0]?.primitive).toEqual({
      kind: 'segment',
      a: { x: 12, y: 22 },
      b: { x: 14, y: 24 },
    });
  });

  it('嵌套 transform 逐层累乘', () => {
    const plan = planSvgImport(
      svg(
        node('g', { transform: 'translate(10 0)' }, [
          node('g', { transform: 'scale(2)' }, [
            node('line', { x1: '1', y1: '0', x2: '2', y2: '0' }),
          ]),
        ]),
      ),
    );
    expect(plan.shapes[0]?.primitive).toMatchObject({ a: { x: 12, y: 0 }, b: { x: 14, y: 0 } });
  });

  it('非法 transform 按无变换导入并警告', () => {
    const plan = planSvgImport(
      svg(
        node('g', { transform: 'bogus(1)' }, [
          node('line', { x1: '1', y1: '2', x2: '3', y2: '4' }),
        ]),
      ),
    );
    expect(plan.shapes[0]?.primitive).toMatchObject({ a: { x: 1, y: 2 } });
    expect(plan.warnings.some((w) => w.includes('transform'))).toBe(true);
  });

  it('非均匀缩放下的圆弧仍按「端点与圆心等距」的圆导入,可继续求解', () => {
    const plan = planSvgImport(
      svg(
        node('g', { transform: 'scale(2 1)' }, [node('path', { d: 'M 10 0 A 10 10 0 0 1 0 10' })]),
      ),
    );
    const primitive = plan.shapes[0]?.primitive;
    expect(primitive?.kind).toBe('arc');
    if (primitive === undefined || primitive.kind !== 'arc') return;
    // 面积缩放 sqrt(2);两个端点都被重新投影到同一半径上,结构残差为 0
    expect(primitive.radius).toBeCloseTo(10 * Math.SQRT2, 9);
    expect(
      Math.hypot(primitive.start.x - primitive.center.x, primitive.start.y - primitive.center.y),
    ).toBeCloseTo(primitive.radius, 9);
    expect(
      Math.hypot(primitive.end.x - primitive.center.x, primitive.end.y - primitive.center.y),
    ).toBeCloseTo(primitive.radius, 9);
  });

  it('非均匀缩放下的圆按近似圆导入并警告', () => {
    const plan = planSvgImport(
      svg(node('g', { transform: 'scale(2 1)' }, [node('circle', { cx: '0', cy: '0', r: '5' })])),
    );
    // 面积缩放因子 |det| = 2 -> 半径 5*sqrt(2)
    expect(plan.shapes[0]?.primitive).toMatchObject({ kind: 'circle', radius: 5 * Math.SQRT2 });
    expect(plan.warnings.some((w) => w.includes('非均匀'))).toBe(true);
  });
});

describe('path 导入', () => {
  it('直线路径导入为线段', () => {
    const plan = planSvgImport(svg(node('path', { d: 'M 0 0 L 10 0' })));
    expect(plan.shapes).toHaveLength(1);
    expect(plan.shapes[0]?.primitive).toEqual({
      kind: 'segment',
      a: { x: 0, y: 0 },
      b: { x: 10, y: 0 },
    });
  });

  it('A 命令导入为圆弧:sweep-flag=1 时起点终点原样', () => {
    const plan = planSvgImport(svg(node('path', { d: 'M 10 0 A 10 10 0 0 1 0 10' })));
    expect(plan.shapes).toHaveLength(1);
    const primitive = plan.shapes[0]?.primitive;
    expect(primitive?.kind).toBe('arc');
    if (primitive === undefined || primitive.kind !== 'arc') return;
    expect(primitive.center.x).toBeCloseTo(0, 9);
    expect(primitive.center.y).toBeCloseTo(0, 9);
    expect(primitive.radius).toBeCloseTo(10, 9);
    expect(primitive.start.x).toBeCloseTo(10, 9);
    expect(primitive.start.y).toBeCloseTo(0, 9);
    expect(primitive.end.x).toBeCloseTo(0, 9);
    expect(primitive.end.y).toBeCloseTo(10, 9);
  });

  it('sweep-flag=0 交换起终点(模型只有正向扫角),几何仍落在小弧上', () => {
    const plan = planSvgImport(svg(node('path', { d: 'M 10 0 A 10 10 0 0 0 0 10' })));
    const primitive = plan.shapes[0]?.primitive;
    expect(primitive?.kind).toBe('arc');
    if (primitive === undefined || primitive.kind !== 'arc') return;
    // 小弧 + 反向 -> 圆心在 (10,10),从 (0,10) 正向扫到 (10,0),扫角 90°
    expect(primitive.center.x).toBeCloseTo(10, 9);
    expect(primitive.center.y).toBeCloseTo(10, 9);
    expect(primitive.radius).toBeCloseTo(10, 9);
    const g = primitive;
    const a0 = Math.atan2(g.start.y - g.center.y, g.start.x - g.center.x);
    const a1 = Math.atan2(g.end.y - g.center.y, g.end.x - g.center.x);
    const sweep = (((a1 - a0) % TAU) + TAU) % TAU;
    expect(sweep).toBeCloseTo(Math.PI / 2, 9);
  });

  it('翻转矩阵(行列式 < 0)下的圆弧仍导入成镜像后的弧', () => {
    const plan = planSvgImport(
      svg(
        node('g', { transform: 'scale(-1 1)' }, [node('path', { d: 'M 10 0 A 10 10 0 0 1 0 10' })]),
      ),
    );
    const primitive = plan.shapes[0]?.primitive;
    expect(primitive?.kind).toBe('arc');
    if (primitive === undefined || primitive.kind !== 'arc') return;
    expect(primitive.center.x).toBeCloseTo(0, 9);
    expect(primitive.center.y).toBeCloseTo(0, 9);
    // 镜像后几何集合不变:圆心 (0,0) 半径 10,端点 (0,10) 与 (-10,0),正向扫角 90°
    const a0 = Math.atan2(
      primitive.start.y - primitive.center.y,
      primitive.start.x - primitive.center.x,
    );
    const a1 = Math.atan2(
      primitive.end.y - primitive.center.y,
      primitive.end.x - primitive.center.x,
    );
    const sweep = (((a1 - a0) % TAU) + TAU) % TAU;
    expect(sweep).toBeCloseTo(Math.PI / 2, 9);
  });

  it('贝塞尔曲线离散为折线并警告', () => {
    const plan = planSvgImport(svg(node('path', { d: 'M 0 0 C 10 0 10 10 0 10' })));
    expect(plan.shapes).toHaveLength(IMPORT_CURVE_SEGMENTS);
    expect(plan.warnings.some((w) => w.includes('折线'))).toBe(true);
    expect(importOf(svg(node('path', { d: 'M 0 0 C 10 0 10 10 0 10' })))).toBe(
      IMPORT_CURVE_SEGMENTS,
    );
  });

  it('路径数据非法时返回警告而不是抛异常', () => {
    const plan = planSvgImport(svg(node('path', { d: 'M 0 0 L oops' })));
    expect(plan.shapes).toHaveLength(0);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });
});

describe('可见性与跳过统计', () => {
  it('display:none 子树整体跳过', () => {
    const plan = planSvgImport(
      svg(node('g', { display: 'none' }, [node('line', { x1: '0', y1: '0', x2: '10', y2: '0' })])),
    );
    expect(plan.shapes).toHaveLength(0);
    expect(plan.warnings).toHaveLength(0);
  });

  it('visibility:hidden 的图元跳过', () => {
    const plan = planSvgImport(
      svg(node('line', { x1: '0', y1: '0', x2: '10', y2: '0', visibility: 'hidden' })),
    );
    expect(plan.shapes).toHaveLength(0);
  });

  it('text/image/未知标签计入跳过统计并提示', () => {
    const plan = planSvgImport(
      svg(
        node('text', { x: '0', y: '0' }, [node('tspan', {}, [])]),
        node('image', { href: 'a.png' }),
        node('widget'),
      ),
    );
    expect(plan.shapes).toHaveLength(0);
    expect(plan.skipped.text).toBe(1);
    expect(plan.skipped.image).toBe(1);
    expect(plan.skipped.widget).toBe(1);
    expect(plan.warnings.some((w) => w.includes('跳过'))).toBe(true);
  });

  it('defs/style 等不可见资源静默跳过,不产生警告', () => {
    const plan = planSvgImport(
      svg(
        node('defs', {}, [node('line', { x1: '0', y1: '0', x2: '1', y2: '1' })]),
        node('style', {}, []),
      ),
    );
    expect(plan.shapes).toHaveLength(0);
    expect(plan.warnings).toHaveLength(0);
  });

  it('百分比长度无法换算,跳过并警告', () => {
    const plan = planSvgImport(svg(node('line', { x1: '10%', y1: '0', x2: '20', y2: '0' })));
    expect(plan.shapes).toHaveLength(0);
    expect(plan.warnings.some((w) => w.includes('百分比'))).toBe(true);
  });
});

describe('可导入数量预检', () => {
  it('countImportableShapes 排除退化几何,与 apply.entities 一致', () => {
    const root = svg(
      node('line', { x1: '0', y1: '0', x2: '0', y2: '0' }),
      node('circle', { cx: '0', cy: '0', r: '1e-9' }),
      node('line', { x1: '0', y1: '0', x2: '10', y2: '0' }),
    );
    const plan = planSvgImport(root);
    // 退化图元仍留在计划里(它们带着损失信息),但「能写进模型」的只有最后一条线
    expect(plan.shapes).toHaveLength(3);
    expect(countImportableShapes(plan)).toBe(1);
    expect(applySvgImport(plan).entities).toBe(1);
  });

  it('全部退化时预检为 0:ui 据此在清空旧草图前拒绝替换', () => {
    const plan = planSvgImport(svg(node('line', { x1: '5', y1: '5', x2: '5', y2: '5' })));
    expect(plan.shapes).toHaveLength(1);
    expect(countImportableShapes(plan)).toBe(0);
  });
});

describe('上限与纯函数性', () => {
  it('图元数超过上限时截断并警告', () => {
    const children: SvgNode[] = [];
    for (let i = 0; i < IMPORT_MAX_SHAPES + 10; i++) {
      children.push(node('line', { x1: String(i), y1: '0', x2: String(i), y2: '1' }));
    }
    const plan = planSvgImport(svg(...children));
    expect(plan.shapes).toHaveLength(IMPORT_MAX_SHAPES);
    expect(plan.warnings.some((w) => w.includes('上限'))).toBe(true);
  });

  it('planSvgImport 不写模型:计划阶段模型保持为空', () => {
    planSvgImport(svg(node('line', { x1: '0', y1: '0', x2: '10', y2: '0' })));
    expect(model.ents.size).toBe(0);
    expect(model.pts.size).toBe(0);
    expect(model.seq).toBe(1);
  });

  it('空 SVG 得到空计划,apply 是 no-op', () => {
    const plan = planSvgImport(svg());
    expect(plan.shapes).toHaveLength(0);
    expect(applySvgImport(plan)).toEqual({ entities: 0, points: 0, skipped: 0 });
    expect(model.ents.size).toBe(0);
  });
});
