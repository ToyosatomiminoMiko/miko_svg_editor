/**
 * scene.json 的纯 codec 与结构校验（core/scene.ts）。
 * 钉住四条契约：
 * 1) 显式 id / seq 往返：载入后模型不重新分配 id，seq 保持文档值；
 * 2) 16 种约束的全字段往返（重点 angleSector / offset / leaderAngle 这类作者态字段）；
 * 3) 空场景 = 空模型，且空文档 serialize 回去与空语义等价；
 * 4) validateScene 拒绝而非修复：坏引用、坏 seq、坏样式、圆弧半径 0 都进错误列表。
 * 每个用例先 applyScene 空文档，避免单例模型在用例间互相污染。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MAPDOC_STYLE_DEFAULTS } from '../../src/config';
import { addPt, model } from '../../src/core/model';
import {
  applyScene,
  mapStyle,
  sceneCounts,
  serializeScene,
  validateScene,
  type SceneContent,
  type SceneEntity,
  type SceneConstraint,
  type ScenePoint,
  type SceneStyle,
} from '../../src/core/scene';

const STYLE: SceneStyle = { ...MAPDOC_STYLE_DEFAULTS };

const point = (id: number, x: number, y: number, fixed = false): ScenePoint => ({
  id,
  x,
  y,
  fixed,
});

/** 覆盖 16 种约束种类的完整夹具；引用全部指向本文件里的点/图元 */
function fullScene(): SceneContent {
  const points: ScenePoint[] = [
    point(1, 0, 0),
    point(2, 100, 0),
    point(3, 100, 80, true),
    point(4, 50, 40),
    point(5, 20, 20),
  ];
  const entities: SceneEntity[] = [
    { id: 42, type: 'line', a: 1, b: 2, construction: false },
    { id: 43, type: 'circle', c: 1, r: 12.5, construction: false },
    { id: 44, type: 'arc', c: 1, a: 2, b: 3, construction: false },
    { id: 45, type: 'point', p: 4, construction: false },
    { id: 46, type: 'line', a: 2, b: 3, construction: true },
    { id: 47, type: 'line', a: 3, b: 5, construction: false },
  ];
  const constraints: SceneConstraint[] = [
    { id: 80, type: 'coincident', a: 1, b: 2 },
    { id: 81, type: 'horizontal', e: 42 },
    { id: 82, type: 'vertical', e: 46 },
    { id: 83, type: 'parallel', e1: 42, e2: 46 },
    { id: 84, type: 'perpendicular', e1: 42, e2: 47 },
    { id: 85, type: 'equalLength', e1: 42, e2: 46 },
    { id: 86, type: 'collinear', e1: 42, e2: 47 },
    { id: 87, type: 'pointOnLine', e: 42, p: 4 },
    { id: 88, type: 'pointOnCircle', e: 43, p: 5 },
    { id: 89, type: 'tangentLineCircle', line: 46, circ: 43 },
    { id: 90, type: 'tangentCircleCircle', e1: 43, e2: 44 },
    { id: 91, type: 'concentric', e1: 43, e2: 44 },
    { id: 92, type: 'equalRadius', e1: 43, e2: 44 },
    { id: 93, type: 'distancePointPoint', a: 1, b: 2, distance: 40, offset: -8 },
    { id: 94, type: 'radius', e: 43, radius: 12.5, leaderAngle: 0.7 },
    { id: 95, type: 'angleLineLine', e1: 42, e2: 47, angle: 30, offset: 30, angleSector: 1 },
  ];
  return {
    format: 'mapdoc-scene',
    version: 1,
    style: STYLE,
    seq: 100,
    points,
    entities,
    constraints,
  };
}

beforeEach(() => {
  applyScene({ ...fullScene(), points: [], entities: [], constraints: [], seq: 1 });
});

describe('serialize / apply 往返', () => {
  it('显式 id 与 seq 原样恢复', () => {
    applyScene(fullScene());
    expect([...model.pts.keys()]).toEqual([1, 2, 3, 4, 5]);
    expect([...model.ents.keys()]).toEqual([42, 43, 44, 45, 46, 47]);
    expect([...model.cons.keys()]).toEqual([
      80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95,
    ]);
    expect(model.seq).toBe(100);
    expect(model.pts.get(3)?.fixed).toBe(true);
    expect(model.ents.get(46)?.construction).toBe(true);
  });

  it('16 种约束全字段往返（作者态字段不丢）', () => {
    applyScene(fullScene());
    const back = serializeScene();
    expect(back.constraints).toEqual(fullScene().constraints);
    const radius = back.constraints.find((c) => c.id === 94);
    expect(radius).toMatchObject({ radius: 12.5, leaderAngle: 0.7 });
    const distance = back.constraints.find((c) => c.id === 93);
    expect(distance).toMatchObject({ distance: 40, offset: -8 });
    const angle = back.constraints.find((c) => c.id === 95);
    expect(angle).toMatchObject({ angle: 30, offset: 30, angleSector: 1 });
  });

  it('图元/点/样式逐字段往返，数组顺序 = 绘制顺序', () => {
    applyScene(fullScene());
    expect(serializeScene()).toEqual(fullScene());
  });

  it('同一文档两次 apply 再 serialize 结果稳定', () => {
    applyScene(fullScene());
    const once = serializeScene();
    applyScene(once);
    expect(serializeScene()).toEqual(once);
  });

  it('载入后新对象从文档 seq 继续分配，不撞已有 id', () => {
    applyScene(fullScene());
    const fresh = addPt(1, 1);
    expect(fresh.id).toBe(100);
    expect(model.seq).toBe(101);
  });

  it('场景样式载入后写进场景级单例', () => {
    applyScene({ ...fullScene(), style: { ...STYLE, stroke: '#112233', stroke_width_pt: 2.5 } });
    expect(mapStyle.stroke).toBe('#112233');
    expect(mapStyle.stroke_width_pt).toBe(2.5);
    // 数组是拷贝而不是共享引用：改回默认不会污染下一份文档
    expect(mapStyle.construction_dash_pt).toEqual([...STYLE.construction_dash_pt]);
  });

  it('空场景 = 空模型；counts 全 0', () => {
    expect(model.pts.size).toBe(0);
    expect(model.ents.size).toBe(0);
    expect(model.cons.size).toBe(0);
    expect(sceneCounts()).toEqual({ points: 0, entities: 0, constraints: 0 });
  });
});

describe('validateScene 拒绝而非修复', () => {
  it('完整夹具合法', () => {
    expect(validateScene(fullScene())).toEqual([]);
  });

  it('seq 不大于最大 id 时报错', () => {
    expect(validateScene({ ...fullScene(), seq: 42 }).join()).toContain('seq');
  });

  it('图元引用不存在的点时报错', () => {
    const bad = fullScene();
    const errors = validateScene({
      ...bad,
      entities: [{ id: 42, type: 'line', a: 1, b: 999, construction: false }],
    });
    expect(errors.join()).toContain('端点引用不存在');
  });

  it('约束引用不存在的图元时报错', () => {
    const doc = fullScene();
    const errors = validateScene({
      ...doc,
      constraints: [{ id: 90, type: 'horizontal', e: 999 }],
    });
    expect(errors.join()).toContain('图元引用');
  });

  it('圆半径必须 > 0、圆弧圆心不得与端点重合', () => {
    const doc = fullScene();
    expect(
      validateScene({
        ...doc,
        entities: [
          { id: 43, type: 'circle', c: 1, r: 0, construction: false },
          { id: 44, type: 'arc', c: 2, a: 2, b: 3, construction: false },
        ],
        constraints: [],
      }).join(),
    ).toContain('半径');
    expect(
      validateScene({
        ...doc,
        entities: [{ id: 44, type: 'arc', c: 2, a: 2, b: 3, construction: false }],
        constraints: [],
      }).join(),
    ).toContain('重合');
  });

  it('颜色/线宽/虚线取值域被校验', () => {
    const doc = fullScene();
    expect(validateScene({ ...doc, style: { ...STYLE, stroke: 'red' } }).join()).toContain(
      'stroke',
    );
    expect(validateScene({ ...doc, style: { ...STYLE, stroke_width_pt: 0 } }).join()).toContain(
      'stroke_width_pt',
    );
    expect(
      validateScene({ ...doc, style: { ...STYLE, construction_dash_pt: [0, 4] } }).join(),
    ).toContain('construction_dash_pt');
  });

  it('重复 id 与非法结构字段被拒绝', () => {
    const doc = fullScene();
    const errors = validateScene({
      ...doc,
      points: [point(1, 0, 0), point(1, 1, 1)],
      entities: [],
      constraints: [],
      seq: 2,
    });
    expect(errors.join()).toContain('重复');
    expect(
      validateScene({
        ...doc,
        points: [point(1, 0, 0)],
        entities: [],
        constraints: [],
        seq: 2,
        style: { ...STYLE },
        format: 'other',
      } as unknown as SceneContent).join(),
    ).toContain('format');
  });
});
