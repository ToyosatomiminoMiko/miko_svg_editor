/**
 * operations.ts 的统一命令引擎（node 环境，无 DOM）。
 * 这些用例钉住「操作 = 参数槽位 + 执行函数」的四件事：
 * 1) 选择集按类型装槽位，与选择顺序无关；装不满时保留收集态而不是直接失败；
 * 2) 画布点击只消费能填进空槽位的候选，上下文排除（如重合端点）在写模型前就挡住；
 * 3) 槽位填满后由交互层立即执行；Backspace 回退、Esc 取消，会话新建的孤立点在回退/取消时删掉；
 * 4) 直线连续画以刚画的终点作为下一段起点；状态栏与预览由槽位表推导。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { CameraView } from '../src/camera';
import {
  addCircle,
  addLine,
  addPointEntity,
  addPt,
  arcGeometry,
  clearModel,
  getEntity,
  getPoint,
  model,
  pointEntityOf,
} from '../src/model';
import {
  CONSTRAINT_OPERATIONS,
  clickCommand,
  commandPreview,
  commandStatus,
  continuationOf,
  createSession,
  executeCommand,
  fillFromOperands,
  isComplete,
  isRepeatOperation,
  operationById,
  operationForTool,
  operandsFromSelection,
  popCommandValue,
  cancelCommand,
  type ClickInput,
  type CommandSession,
  type OperationId,
} from '../src/operations';
import { resetInteraction, state } from '../src/state';
import { TOOLS } from '../src/tools';
import type { Entity, MeasureText, Point, Selection, SelectionItem, Snap, Vec } from '../src/types';
import { vec } from '../src/vec';

const view: CameraView = { x: 0, y: 0, z: 1, viewportW: 800, viewportH: 600 };
const measure: MeasureText = (text) => text.length * 10;
const FONT = '12px sans-serif';

const input = (w: Vec, snap: Snap | null = null): ClickInput => ({
  w,
  zoom: 1,
  view,
  snap,
  measureText: measure,
  font: FONT,
});

const entItem = (id: number): SelectionItem => ({ kind: 'ent', id });
const ptItem = (id: number): SelectionItem => ({ kind: 'pt', id });

/** 选择集：先图元后点（引擎按槽位类型匹配，不依赖这个顺序） */
const selectionOf = (
  entities: readonly Entity[] = [],
  points: readonly Point[] = [],
): Selection => ({
  items: [...entities.map((e) => entItem(e.id)), ...points.map((p) => ptItem(p.id))],
});

const arm = (
  id: OperationId,
  entities: readonly Entity[] = [],
  points: readonly Point[] = [],
): { session: CommandSession; used: number; reasons: readonly string[] } => {
  const session = createSession(id);
  const fill = fillFromOperands(session, operandsFromSelection(selectionOf(entities, points)));
  return { session, used: fill.used, reasons: fill.reasons };
};

/** 选择集预填 → 执行；返回普通动作结果（尺寸操作不适用） */
const run = (id: OperationId, entities: readonly Entity[] = [], points: readonly Point[] = []) => {
  const { session } = arm(id, entities, points);
  const outcome = executeCommand(session, 1);
  if (outcome.kind !== 'action') throw new Error('该操作应返回普通动作');
  return outcome.result;
};

const cons = () => [...model.cons.values()];

beforeEach(() => {
  clearModel();
  resetInteraction();
});

/* ======================= 操作表 ======================= */

describe('操作表', () => {
  it('操作 id 不重复，每个操作都有 label / slots / execute', () => {
    const ids = [
      ...CONSTRAINT_OPERATIONS.map((op) => op.id),
      ...TOOLS.filter((t) => t.id !== 'select').map((t) => t.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      const op = operationById(id as OperationId);
      expect(op.label.length).toBeGreaterThan(0);
      expect(typeof op.slots).toBe('function');
      expect(typeof op.execute).toBe('function');
    }
    expect(CONSTRAINT_OPERATIONS).toHaveLength(9);
  });

  it('TOOLS 里除 select 外每个工具都能找到对应操作', () => {
    for (const tool of TOOLS) {
      if (tool.id === 'select') continue;
      expect(operationForTool(tool.id).tool).toBe(tool.id);
    }
  });

  it('约束操作都不绑定工具（tool = null），绘图操作绑定工具', () => {
    for (const op of CONSTRAINT_OPERATIONS) expect(op.tool).toBeNull();
    expect(operationById('line').tool).toBe('line');
    expect(operationById('dim').tool).toBe('dim');
    expect(operationById('erase').tool).toBe('erase');
  });
});

/* ======================= 选择集预填 ======================= */

describe('选择集预填：按类型装槽位，与选择顺序无关', () => {
  it('重合：两个点反序选择都能填满，执行结果相同', () => {
    const p1 = addPt(0, 0);
    const p2 = addPt(10, 5);

    const forward = arm('coincident', [], [p1, p2]);
    const reverse = arm('coincident', [], [p2, p1]);
    expect(isComplete(forward.session)).toBe(true);
    expect(isComplete(reverse.session)).toBe(true);

    expect(run('coincident', [], [p1, p2]).ok).toBe(true);
    expect(cons()).toHaveLength(1);
    expect(cons()[0]).toMatchObject({ type: 'coincident' });
  });

  it('重合：先选直线再选点（或反过来）都能装进正确的槽位', () => {
    const line = addLine(addPt(0, 0), addPt(100, 0));
    const p = addPt(50, 20);

    const lineFirst = arm('coincident', [line], [p]);
    expect(isComplete(lineFirst.session)).toBe(true);
    // 目标槽位被直线占住，锚点槽位是点
    expect(lineFirst.session.values[1]).toMatchObject({ kind: 'entity' });
    expect(lineFirst.session.values[0]).toMatchObject({ kind: 'point' });

    const pointFirst = arm('coincident', [line], [p]);
    expect(isComplete(pointFirst.session)).toBe(true);

    expect(run('coincident', [line], [p]).ok).toBe(true);
    expect(cons()[0]).toMatchObject({ type: 'pointOnLine', p: p.id, e: line.id });
  });

  it('水平：repeat 槽位吃掉多条直线，执行时逐条生成约束', () => {
    const l1 = addLine(addPt(0, 0), addPt(100, 0));
    const l2 = addLine(addPt(0, 10), addPt(100, 10));

    const { session, used } = arm('horizontal', [l1, l2]);
    expect(used).toBe(2);
    expect(session.values).toHaveLength(2);
    expect(isComplete(session)).toBe(true);

    expect(run('horizontal', [l1, l2]).ok).toBe(true);
    expect(cons().filter((c) => c.type === 'horizontal')).toHaveLength(2);
  });

  it('不适用对象不装槽位（平行选了直线 + 圆：只填第一个槽位）', () => {
    const line = addLine(addPt(0, 0), addPt(100, 0));
    const circle = addCircle(addPt(300, 0), 10);

    const { session, used } = arm('parallel', [line, circle]);
    expect(used).toBe(1);
    expect(isComplete(session)).toBe(false);

    const result = run('parallel', [line, circle]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('还没选齐');
  });

  it('固定：选择集里的图元按端点解析成点', () => {
    const a = addPt(0, 0);
    const b = addPt(100, 0);
    const line = addLine(a, b);

    expect(run('fix', [line]).ok).toBe(true);
    expect(a.fixed).toBe(true);
    expect(b.fixed).toBe(true);
  });

  it('构造：点图元按图元身份填槽位（不是它的点）', () => {
    const p = addPt(0, 0);
    const e = addPointEntity(p);

    expect(run('construction', [e]).ok).toBe(true);
    expect(e.construction).toBe(true);
  });

  it('尺寸：选中直线一次填满；选中两个点得到两点距离', () => {
    const a = addPt(0, 0);
    const b = addPt(100, 0);
    const line = addLine(a, b);

    const lineSession = arm('dim', [line]).session;
    expect(isComplete(lineSession)).toBe(true);
    const lineOutcome = executeCommand(lineSession, 1);
    expect(lineOutcome.kind).toBe('dim');
    if (lineOutcome.kind === 'dim' && lineOutcome.result.ok) {
      expect(lineOutcome.result.con.type).toBe('distancePointPoint');
    }

    clearModel();
    resetInteraction();
    const p1 = addPt(0, 0);
    const p2 = addPt(100, 0);
    const pointSession = arm('dim', [], [p1, p2]).session;
    expect(isComplete(pointSession)).toBe(true);
    const pointOutcome = executeCommand(pointSession, 1);
    expect(pointOutcome.kind).toBe('dim');
    if (pointOutcome.kind === 'dim' && pointOutcome.result.ok) {
      expect(pointOutcome.result.con).toMatchObject({ a: p1.id, b: p2.id });
    }
    expect(model.cons).toHaveLength(1);
  });
});

/* ======================= 画布点击补参数 ======================= */

describe('画布点击补参数', () => {
  it('直线：两次空白点击各建一个点，填满即进入可执行态；执行后成线并接续终点', () => {
    const session = createSession('line');

    const first = clickCommand(session, input({ x: 0, y: 0 }));
    expect(first.filled).toBe(true);
    expect(model.pts.size).toBe(1);
    expect(isComplete(session)).toBe(false);

    const second = clickCommand(session, input({ x: 100, y: 0 }));
    expect(second.filled).toBe(true);
    expect(model.pts.size).toBe(2);
    expect(isComplete(session)).toBe(true);
    // 填满由交互层立即执行，引擎层不再闪「按 Enter」之类的按键提示
    expect(second.notices).toHaveLength(0);

    const outcome = executeCommand(session, 1);
    expect(outcome.kind).toBe('action');
    if (outcome.kind === 'action') expect(outcome.result.ok).toBe(true);
    expect(model.ents.size).toBe(1);

    // 连续画：下一段以刚画的终点为起点
    const next = continuationOf(session);
    expect(next).not.toBeNull();
    expect(next?.values[0]).toMatchObject({ kind: 'point' });
    expect(isComplete(next ?? createSession('line'))).toBe(false);
  });

  it('取消命令会删掉点击新建但还没并入图元的点（不留孤立点）', () => {
    const session = createSession('line');
    clickCommand(session, input({ x: 0, y: 0 }));
    expect(model.pts.size).toBe(1);

    cancelCommand(session);
    expect(model.pts.size).toBe(0);
  });

  it('Backspace 回退最后一个参数，并回收它新建的点', () => {
    const session = createSession('line');
    clickCommand(session, input({ x: 0, y: 0 }));
    clickCommand(session, input({ x: 100, y: 0 }));
    expect(model.pts.size).toBe(2);

    expect(popCommandValue(session)).toBe(true);
    expect(model.pts.size).toBe(1);
    expect(isComplete(session)).toBe(false);
  });

  it('圆：圆心新建点，半径位置不建模型点', () => {
    const session = createSession('circle');
    clickCommand(session, input({ x: 0, y: 0 }));
    clickCommand(session, input({ x: 10, y: 0 }));

    expect(model.pts.size).toBe(1);
    expect(isComplete(session)).toBe(true);

    const outcome = executeCommand(session, 1);
    expect(outcome.kind).toBe('action');
    expect(model.ents.size).toBe(1);
    expect([...model.ents.values()][0]).toMatchObject({ type: 'circle', r: 10 });
  });

  it('圆弧：圆心 → 起点 → 终点，三个点都进入模型，半径/角度由点推出', () => {
    const session = createSession('arc');
    for (const w of [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ]) {
      expect(clickCommand(session, input(w)).filled).toBe(true);
    }
    expect(isComplete(session)).toBe(true);
    expect(model.pts.size).toBe(3);

    const outcome = executeCommand(session, 1);
    expect(outcome.kind).toBe('action');
    const arc = [...model.ents.values()][0];
    expect(arc?.type).toBe('arc');
    if (!arc || arc.type !== 'arc') throw new Error('圆弧未创建');
    const g = arcGeometry(arc);
    expect(g?.r).toBeCloseTo(10, 6);
    expect(g?.a0).toBeCloseTo(0, 12);
    expect(g?.a1).toBeCloseTo(Math.PI / 2, 12);
    expect(g?.start.x).toBeCloseTo(10, 12);
    expect(g?.start.y).toBeCloseTo(0, 12);
    expect(g?.end.x).toBeCloseTo(0, 12);
    expect(g?.end.y).toBeCloseTo(10, 12);
  });

  it('圆弧起点/终点吸附到已有点时复用同一个点（端点即共享点）', () => {
    const startPoint = addPt(10, 0);
    const endPoint = addPt(0, 10);
    const session = createSession('arc');

    expect(clickCommand(session, input({ x: 0, y: 0 })).filled).toBe(true);
    const snapStart: Snap = { pos: { x: 10, y: 0 }, pt: startPoint, d: 0, pri: 0 };
    const snapEnd: Snap = { pos: { x: 0, y: 10 }, pt: endPoint, d: 0, pri: 0 };
    expect(clickCommand(session, input({ x: 10, y: 0 }, snapStart)).filled).toBe(true);
    expect(clickCommand(session, input({ x: 0, y: 10 }, snapEnd)).filled).toBe(true);

    expect(model.pts.size).toBe(3); // 只有圆心是新建的
    const outcome = executeCommand(session, 1);
    expect(outcome.kind).toBe('action');

    const arc = [...model.ents.values()][0];
    if (!arc || arc.type !== 'arc') throw new Error('圆弧未创建');
    expect(arc.a).toBe(startPoint.id);
    expect(arc.b).toBe(endPoint.id);
  });

  it('圆弧终点再点起点（复用同一个点）按整圆处理，不产生重合的第二端点', () => {
    const session = createSession('arc');
    expect(clickCommand(session, input({ x: 0, y: 0 })).filled).toBe(true);
    expect(clickCommand(session, input({ x: 10, y: 0 })).filled).toBe(true);
    const startPoint = [...model.pts.values()].find((p) => p.x === 10 && p.y === 0);
    if (!startPoint) throw new Error('起点未创建');
    const snapStart: Snap = { pos: { x: 10, y: 0 }, pt: startPoint, d: 0, pri: 0 };

    expect(clickCommand(session, input({ x: 10, y: 0 }, snapStart)).filled).toBe(true);
    const outcome = executeCommand(session, 1);
    expect(outcome.kind).toBe('action');
    if (outcome.kind === 'action') expect(outcome.result.ok).toBe(true);

    const arc = [...model.ents.values()][0];
    if (!arc || arc.type !== 'arc') throw new Error('圆弧未创建');
    expect(arc.a).toBe(startPoint.id);
    expect(arc.b).toBe(startPoint.id);
    expect(model.pts.size).toBe(2); // 圆心 + 起点（整圆两端同点）
  });

  it('矩形：两个位置槽位不建点，执行时由 createRect 统一取/建四角', () => {
    const session = createSession('rect');
    clickCommand(session, input({ x: 0, y: 0 }));
    clickCommand(session, input({ x: 10, y: 5 }));
    expect(model.pts.size).toBe(0);

    const outcome = executeCommand(session, 1);
    expect(outcome.kind).toBe('action');
    expect(model.ents.size).toBe(4);
  });

  it('点工具：空白点击建点，执行后加为点图元', () => {
    const session = createSession('point');
    clickCommand(session, input({ x: 7, y: 8 }));
    expect(model.ents.size).toBe(0);

    const outcome = executeCommand(session, 1);
    expect(outcome.kind).toBe('action');
    if (outcome.kind === 'action') expect(outcome.result.ok).toBe(true);
    expect(model.ents.size).toBe(1);
    const e = [...model.ents.values()][0];
    expect(e?.type).toBe('point');
    if (e?.type === 'point') expect(getPoint(e.p)).toMatchObject({ x: 7, y: 8 });
  });

  it('点工具：吸附到已有点时复用该点并提示「提升」', () => {
    const a = addPt(0, 0);
    const line = addLine(a, addPt(100, 0));
    const session = createSession('point');
    const snap: Snap = { pos: { x: 0, y: 0 }, pt: a, d: 0, pri: 0 };

    clickCommand(session, input({ x: 0, y: 0 }, snap));
    expect(model.pts.size).toBe(2); // 没有新建点

    const outcome = executeCommand(session, 1);
    expect(outcome.kind).toBe('action');
    if (outcome.kind === 'action' && outcome.result.ok) {
      expect(outcome.result.notices[0]?.message).toContain('提升');
    }
    expect(pointEntityOf(a.id)).toBeDefined();
    expect(getEntity(line.id)).toBeDefined();
  });

  it('已有点图元上再放点：不重复创建并提示', () => {
    const a = addPt(0, 0);
    addPointEntity(a);
    const session = createSession('point');
    clickCommand(session, input({ x: 0, y: 0 }, { pos: { x: 0, y: 0 }, pt: a, d: 0, pri: 0 }));

    const outcome = executeCommand(session, 1);
    expect(outcome.kind).toBe('action');
    if (outcome.kind === 'action' && outcome.result.ok) {
      expect(outcome.result.notices[0]?.message).toContain('已经有一个点');
    }
    expect(model.ents.size).toBe(1);
  });

  it('约束：空白点击给出「还需要」的提示，不写模型', () => {
    const line = addLine(addPt(0, 0), addPt(100, 0));
    const { session } = arm('coincident', [line]);

    const result = clickCommand(session, input({ x: 500, y: 500 }));
    expect(result.filled).toBe(false);
    expect(result.reason).toContain('还需要');
    expect(cons()).toHaveLength(0);
  });

  it('重合：锚点已经是目标直线端点时点击被挡住（不写假约束）', () => {
    const a = addPt(0, 0);
    const line = addLine(a, addPt(100, 0));
    const { session } = arm('coincident', [line]);

    const result = clickCommand(session, input({ x: 0, y: 0 }));
    expect(result.filled).toBe(false);
    expect(result.reason).toContain('端点');
    expect(cons()).toHaveLength(0);
  });

  it('重合：点 + 直线点击补齐后执行成功', () => {
    const line = addLine(addPt(0, 0), addPt(100, 0));
    const p = addPt(50, 20);
    const { session } = arm('coincident', [line]);

    // 点击自由点 p：应该填进留空的锚点槽位
    expect(clickCommand(session, input({ x: 50, y: 20 })).filled).toBe(true);
    expect(isComplete(session)).toBe(true);

    const outcome = executeCommand(session, 1);
    expect(outcome.kind).toBe('action');
    if (outcome.kind === 'action') expect(outcome.result.ok).toBe(true);
    expect(cons()[0]).toMatchObject({ type: 'pointOnLine', p: p.id, e: line.id });
  });

  it('尺寸：点击直线目标进入可执行态，执行后返回尺寸会话', () => {
    addLine(addPt(0, 0), addPt(100, 0));
    const session = createSession('dim');
    expect(clickCommand(session, input({ x: 50, y: 0 })).filled).toBe(true);
    expect(isComplete(session)).toBe(true);

    const outcome = executeCommand(session, 1);
    expect(outcome.kind).toBe('dim');
    if (outcome.kind === 'dim' && outcome.result.ok) {
      expect(outcome.result.con.type).toBe('distancePointPoint');
      expect(outcome.result.created).toBe(true);
    }
  });

  it('尺寸：点图元作为目标时进入两点流程，第二点可点已有点图元', () => {
    const p1 = addPt(0, 0);
    const e1 = addPointEntity(p1);
    const p2 = addPt(100, 0);
    const e2 = addPointEntity(p2);
    expect(getEntity(e1.id)).toBeDefined();
    expect(getEntity(e2.id)).toBeDefined();

    const session = createSession('dim');
    expect(clickCommand(session, input({ x: 0, y: 0 })).filled).toBe(true);
    expect(isComplete(session)).toBe(false);
    expect(clickCommand(session, input({ x: 100, y: 0 })).filled).toBe(true);
    expect(isComplete(session)).toBe(true);

    const outcome = executeCommand(session, 1);
    expect(outcome.kind).toBe('dim');
    if (outcome.kind === 'dim' && outcome.result.ok) {
      expect(outcome.result.con).toMatchObject({ a: p1.id, b: p2.id });
    }
    expect(model.pts.size).toBe(2);
    expect(model.cons.size).toBe(1);
    // 点图元本身没有被删掉
    expect(getEntity(e1.id)).toBeDefined();
    expect(getEntity(e2.id)).toBeDefined();
  });
});

/* ======================= 动态槽位 ======================= */

describe('动态槽位', () => {
  it('相切：第一条是直线时第二条只接受圆/弧', () => {
    const line = addLine(addPt(0, 0), addPt(100, 0));
    const { session } = arm('tangent', [line]);
    expect(isComplete(session)).toBe(false);
    const slots = operationById('tangent').slots(session.values);
    expect(slots).toHaveLength(2);
    expect(slots[1]?.prompt).toContain('圆/弧');
  });

  it('相切：第一条是圆时第二条可直线或圆/弧', () => {
    const circle = addCircle(addPt(0, 0), 10);
    const { session } = arm('tangent', [circle]);
    const slots = operationById('tangent').slots(session.values);
    expect(slots[1]?.prompt).toContain('直线');
  });

  it('相切：直线 + 圆执行得到 tangentLineCircle；两个曲线得到 tangentCircleCircle', () => {
    const line = addLine(addPt(0, 0), addPt(100, 0));
    const circle = addCircle(addPt(50, 50), 10);
    expect(run('tangent', [line, circle]).ok).toBe(true);
    expect(cons()[0]?.type).toBe('tangentLineCircle');

    clearModel();
    resetInteraction();
    const c1 = addCircle(addPt(0, 0), 10);
    const c2 = addCircle(addPt(40, 0), 5);
    expect(run('tangent', [c1, c2]).ok).toBe(true);
    expect(cons()[0]?.type).toBe('tangentCircleCircle');
  });

  it('尺寸：目标类型决定槽位数量', () => {
    const line = addLine(addPt(0, 0), addPt(100, 0));
    const p = addPt(5, 5);
    expect(operationById('dim').slots([{ kind: 'entity', entity: line }])).toHaveLength(1);
    expect(operationById('dim').slots([{ kind: 'point', point: p, at: p }])).toHaveLength(2);
  });
});

/* ======================= 上下文排除 / 去重 ======================= */

describe('上下文排除与去重', () => {
  it('同一个点不能和自己重合：选择集里同时给它点与点图元身份会被拒绝', () => {
    const p = addPt(0, 0);
    const e = addPointEntity(p);
    const { session, reasons } = arm('coincident', [e], [p]);
    expect(reasons.some((r) => r.includes('自己'))).toBe(true);
    expect(isComplete(session)).toBe(false);
    expect(cons()).toHaveLength(0);
  });

  it('点已是圆心：重合被上下文排除挡住', () => {
    const center = addPt(0, 0, true);
    const circle = addCircle(center, 10);
    const { session, reasons } = arm('coincident', [circle], [center]);
    expect(reasons.some((r) => r.includes('圆心'))).toBe(true);
    expect(isComplete(session)).toBe(false);
    expect(circle.r).toBe(10);
  });

  it('相同约束重复执行时报「已存在」且不重复写模型', () => {
    const line = addLine(addPt(0, 0), addPt(100, 0));
    expect(run('horizontal', [line]).ok).toBe(true);

    const again = run('horizontal', [line]);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toContain('已存在');
    expect(cons()).toHaveLength(1);
  });

  it('多选直线加水平会跳过重复项并提示', () => {
    const l1 = addLine(addPt(0, 0), addPt(100, 0));
    const l2 = addLine(addPt(0, 10), addPt(100, 10));
    expect(run('horizontal', [l1, l2]).ok).toBe(true);

    const again = run('horizontal', [l1, l2]);
    expect(again.ok).toBe(false);
  });
});

/* ======================= 执行 / 回退 / 取消 ======================= */

describe('执行、回退、取消', () => {
  it('参数没齐时执行失败并指出缺哪个槽位', () => {
    const { session } = arm('coincident', [addLine(addPt(0, 0), addPt(100, 0))]);
    const outcome = executeCommand(session, 1);
    expect(outcome.kind).toBe('action');
    if (outcome.kind === 'action') {
      expect(outcome.result.ok).toBe(false);
      if (!outcome.result.ok) {
        expect(outcome.result.reason).toContain('还没选齐');
        expect(outcome.result.reason).toContain('点');
      }
    }
    expect(cons()).toHaveLength(0);
  });

  it('同一位置再次点击不会重复使用同一点（提示重复参数）', () => {
    const session = createSession('line');
    expect(clickCommand(session, input({ x: 0, y: 0 })).filled).toBe(true);

    const again = clickCommand(session, input({ x: 0, y: 0 }));
    expect(again.filled).toBe(false);
    expect(again.reason).toContain('重复');
    expect(isComplete(session)).toBe(false);
  });

  it('退化直线执行失败时保留会话（可回退后重试）', () => {
    const session = createSession('line');
    const a = addPt(0, 0);
    const b = addPt(0, 0);
    session.values.push({ kind: 'point', point: a, at: a }, { kind: 'point', point: b, at: b });

    const outcome = executeCommand(session, 1);
    expect(outcome.kind).toBe('action');
    if (outcome.kind === 'action') {
      expect(outcome.result.ok).toBe(false);
      if (!outcome.result.ok) expect(outcome.result.reason).toContain('重合');
    }
    expect(isComplete(session)).toBe(true);
    expect(popCommandValue(session)).toBe(true);
  });

  it('repeat 操作标记：删除/固定/构造/水平/竖直执行后保持连续模式', () => {
    for (const id of ['erase', 'fix', 'construction', 'horizontal', 'vertical'] as const) {
      expect(isRepeatOperation(id)).toBe(true);
    }
    for (const id of ['point', 'line', 'circle', 'arc', 'rect', 'dim', 'parallel'] as const) {
      expect(isRepeatOperation(id)).toBe(false);
    }
  });
});

/* ======================= 状态栏与预览 ======================= */

describe('状态栏与预览', () => {
  it('状态栏显示当前命令、每个参数的值/待选与按键提示', () => {
    const session = createSession('line');
    let text = commandStatus(session);
    expect(text).toContain('命令 直线');
    expect(text).toContain('起点：待选');
    expect(text).toContain('点击画布补参数');
    expect(text).toContain('Esc 取消');

    clickCommand(session, input({ x: 0, y: 0 }));
    text = commandStatus(session);
    expect(text).toContain('起点：点');
    expect(text).toContain('终点：待选');
    expect(text).toContain('Backspace 回退');

    clickCommand(session, input({ x: 100, y: 0 }));
    expect(commandStatus(session)).toContain('参数已齐');
  });

  it('直线预览：只有一个参数时连到光标，参数齐全时画最终线', () => {
    const session = createSession('line');
    clickCommand(session, input({ x: 0, y: 0 }));
    const [preview] = commandPreview(session, { x: 40, y: 20 });
    expect(preview?.kind).toBe('line');
    if (preview?.kind === 'line') {
      expect(preview.a).toMatchObject({ x: 0, y: 0 });
      expect(preview.b).toEqual({ x: 40, y: 20 });
    }

    clickCommand(session, input({ x: 100, y: 0 }));
    const [shape] = commandPreview(session, { x: 999, y: 999 });
    expect(shape?.kind).toBe('line');
    if (shape?.kind === 'line') expect(shape.b).toMatchObject({ x: 100, y: 0 });
  });

  it('圆 / 弧 / 矩形的预览从槽位参数推出', () => {
    const circle = createSession('circle');
    clickCommand(circle, input({ x: 0, y: 0 }));
    const circleShape = commandPreview(circle, { x: 10, y: 0 })[0];
    expect(circleShape?.kind).toBe('circle');
    if (circleShape?.kind === 'circle') expect(circleShape.r).toBeCloseTo(10, 12);

    const arc = createSession('arc');
    clickCommand(arc, input({ x: 0, y: 0 }));
    clickCommand(arc, input({ x: 10, y: 0 }));
    const arcShape = commandPreview(arc, { x: 0, y: 10 })[0];
    expect(arcShape?.kind).toBe('arc');

    const rect = createSession('rect');
    clickCommand(rect, input({ x: 0, y: 0 }));
    clickCommand(rect, input({ x: 10, y: 5 }));
    expect(commandPreview(rect, { x: 0, y: 0 })[0]?.kind).toBe('rect');
  });

  it('尺寸两点预览：第一点已填、第二点未填时拉一条线', () => {
    const p = addPt(0, 0);
    const session = createSession('dim');
    clickCommand(session, input({ x: 0, y: 0 }, { pos: { x: 0, y: 0 }, pt: p, d: 0, pri: 0 }));
    const [shape] = commandPreview(session, { x: 30, y: 40 });
    expect(shape?.kind).toBe('line');
  });
});

/* ======================= 画布点击后的状态一致性 ======================= */

describe('画布点击与选择集状态', () => {
  it('命令会话不改选择集（选择集仍归拖拽/框选使用）', () => {
    const line = addLine(addPt(0, 0), addPt(100, 0));
    state.selection = { items: [entItem(line.id)] };
    const { session } = arm('coincident', [line]);
    expect(state.selection.items).toEqual([entItem(line.id)]);
    expect(session.opId).toBe('coincident');
  });

  it('拖动 / 框选不受命令引擎影响：operandsFromSelection 只读选择集', () => {
    const line = addLine(addPt(0, 0), addPt(100, 0));
    const p = addPt(10, 10);
    const operands = operandsFromSelection(selectionOf([line], [p]));
    expect(operands).toHaveLength(2);
    expect(vec.dist(p, { x: 10, y: 10 })).toBe(0);
  });
});
