/**
 * 统一操作引擎：每个操作 = 若干「参数槽位」+ 一个「执行函数」。
 *
 * 设计要点（这是编辑器交互的唯一入口，不再有按工具分叉的 pending 状态机）：
 * - 槽位声明**接受什么**（点 / 位置 / 直线 / 圆或弧 / 图元 / 尺寸），以及空白点击是否落一个
 *   新建点（`place`）。适用性校验因此只有一份，工具与约束按钮不再各写一套数量/类型判断。
 * - 选中对象先按类型装进槽位；装不满就进入收集态，画布点击只消费「能填进当前空槽位」的候选，
 *   因此选错对象/顺序不对不会先写模型再报错。
 * - 槽位填满后立即执行（正常交互不再需要 Enter）；repeat 槽位（删除/固定/构造/水平/竖直）
 *   每填一个对象就执行一次、命令保持可继续点，Esc/右键结束。
 *   Backspace 回退最后一个参数，Esc 放弃整个命令；会话里由点击新建、还没并入图元的点记在
 *   `owned`，回退/取消时一并删除（不留孤立点）。
 * - 约束种类到残差/去重的映射仍由 config/constraints-meta 与 sketch-actions.addConstraints 提供。
 */

import type { CameraView } from './camera';
import { MIN_RADIUS, formatDimValue, type ResolvedConstraint } from './config';
import { dimLabel, pickDim, type DimConstraint } from './dimensions';
import { entityLabel, isCurveEntity } from './entities';
import { pickEntity, pickPoint, pickPointEntity } from './geometry';
import { addPt, discardPoint, getEntity, getPoint, pointEntityOf } from './model';
import {
  actionFail,
  addConstraints,
  createArc,
  createCircle,
  createLine,
  createRect,
  deleteSelected,
  dimForEntity,
  dimForPoints,
  placePointEntity,
  toggleConstruction,
  toggleFixed,
  type ActionResult,
  type DimResult,
  type Notice,
} from './sketch-actions';
import type { Entity, MeasureText, Point, Selection, Snap, ToolId, Vec } from './types';
import { vec } from './vec';

/* ======================= 操作数 ======================= */

/**
 * 一个参数槽位里装的东西。
 * - point：模型里的几何点（独立点 / 端点 / 圆心 / 点图元引用的点）；
 * - position：只有世界坐标的位置（圆半径点、弧起终点、矩形对角点用，不创建模型点）；
 * - entity：图元对象（含点图元——构造/删除这类按图元身份处理的槽位需要它）；
 * - dim：已有尺寸标注。
 */
export type Operand =
  | { readonly kind: 'point'; readonly point: Point; readonly at: Vec }
  | { readonly kind: 'position'; readonly pos: Vec }
  | { readonly kind: 'entity'; readonly entity: Entity }
  | { readonly kind: 'dim'; readonly con: DimConstraint };

const pointOperand = (point: Point, at: Vec = point): Operand => ({ kind: 'point', point, at });
const positionOperand = (pos: Vec): Operand => ({ kind: 'position', pos });
const entityOperand = (entity: Entity): Operand => ({ kind: 'entity', entity });
const dimOperand = (con: DimConstraint): Operand => ({ kind: 'dim', con });

const isPointOperand = (op: Operand | undefined): op is Extract<Operand, { kind: 'point' }> =>
  op?.kind === 'point';
const isEntityOperand = (op: Operand | undefined): op is Extract<Operand, { kind: 'entity' }> =>
  op?.kind === 'entity';
const isPositionOperand = (op: Operand | undefined): op is Extract<Operand, { kind: 'position' }> =>
  op?.kind === 'position';

/** 操作数的世界坐标（只对 point / position 有意义） */
const operandPos = (op: Operand | undefined): Vec | undefined => {
  if (op?.kind === 'point') return op.point;
  if (op?.kind === 'position') return op.pos;
  return undefined;
};

/** 状态栏里一个参数的可读标签 */
export function operandLabel(op: Operand): string {
  switch (op.kind) {
    case 'point':
      return `点 #${op.point.id}`;
    case 'position':
      return `位置 (${formatDimValue(op.pos.x)}, ${formatDimValue(op.pos.y)})`;
    case 'entity':
      return `${entityLabel(op.entity)} #${op.entity.id}`;
    case 'dim':
      return `${dimLabel(op.con)} #${op.con.id}`;
  }
}

/* ======================= 槽位 ======================= */

/**
 * 一个参数槽位。
 * - `accepts` 只看操作数类型（不含上下文）；
 * - `place` 决定空白点击的落参方式：`point` = 新建/复用几何点，`position` = 只取位置；
 *   缺省 = 只拾取已有对象（约束/删除/固定等槽位）。
 * - `reject` 是上下文排除（如「点已经是该直线的端点」），返回非空字符串即不可填，
 *   文字会作为点击提示；它让「点不进去」发生在写模型之前。
 */
export interface SlotSpec {
  readonly key: string;
  readonly prompt: string;
  readonly accepts: (operand: Operand) => boolean;
  readonly place?: 'point' | 'position';
  /** 可变参数槽位（必须最后）：可继续追加；点击填一个即执行一次，执行后保持可继续点 */
  readonly repeat?: boolean;
  readonly reject?: (
    operand: Operand,
    values: readonly (Operand | undefined)[],
  ) => string | undefined;
  /** 同一对象被重复填进本槽位时的提示；缺省用通用文案 */
  readonly duplicateReason?: string;
}

const acceptsPoint = (op: Operand): boolean => op.kind === 'point';
const acceptsPosition = (op: Operand): boolean => op.kind === 'position';
const acceptsEntity = (op: Operand): boolean => op.kind === 'entity';
const acceptsLine = (op: Operand): boolean => op.kind === 'entity' && op.entity.type === 'line';
const acceptsCurve = (op: Operand): boolean => op.kind === 'entity' && isCurveEntity(op.entity);
const acceptsLineOrCurve = (op: Operand): boolean => acceptsLine(op) || acceptsCurve(op);
const acceptsPointOrEntity = (op: Operand): boolean => op.kind === 'point' || op.kind === 'entity';
const acceptsDim = (op: Operand): boolean => op.kind === 'dim';
const acceptsPointLineCurve = (op: Operand): boolean =>
  op.kind === 'point' || acceptsLineOrCurve(op);

/** 点击可新建点的槽位（绘图起点/终点、尺寸第二点） */
const createPointSlot = (key: string, prompt: string): SlotSpec => ({
  key,
  prompt,
  accepts: acceptsPoint,
  place: 'point',
});
/** 只取位置的槽位（圆半径、弧起终点、矩形对角点） */
const positionSlot = (key: string, prompt: string): SlotSpec => ({
  key,
  prompt,
  accepts: acceptsPosition,
  place: 'position',
});
const lineSlot = (key: string, prompt: string, repeat = false): SlotSpec => ({
  key,
  prompt,
  accepts: acceptsLine,
  ...(repeat ? { repeat } : {}),
});
const curveSlot = (key: string, prompt: string): SlotSpec => ({
  key,
  prompt,
  accepts: acceptsCurve,
});

/* ======================= 操作元数据 ======================= */

export type ConstraintOperationId =
  | 'coincident'
  | 'horizontal'
  | 'vertical'
  | 'parallel'
  | 'perpendicular'
  | 'equalLength'
  | 'tangent'
  | 'concentric'
  | 'equalRadius';

export type EditOperationId = 'fix' | 'construction';

export type ToolOperationId = Exclude<ToolId, 'select'>;

export type OperationId = ToolOperationId | ConstraintOperationId | EditOperationId;

/** 执行上下文：owned 用来区分「本次会话新建的点」与「复用已有点」（点工具提示不同） */
export interface OperationContext {
  readonly zoom: number;
  readonly owned: ReadonlySet<number>;
}

/** 执行结果：要么是普通领域动作，要么是尺寸输入会话（打开输入框） */
export type OperationOutcome =
  | { readonly kind: 'action'; readonly result: ActionResult }
  | { readonly kind: 'dim'; readonly result: DimResult };

const actionOut = (result: ActionResult): OperationOutcome => ({ kind: 'action', result });
const dimOut = (result: DimResult): OperationOutcome => ({ kind: 'dim', result });

export interface OperationMeta {
  readonly id: OperationId;
  readonly label: string;
  readonly group: 'draw' | 'constraint' | 'edit';
  /** 工具栏「工具」分段里的对应工具 id；约束/编辑操作为 null */
  readonly tool: ToolId | null;
  /** 槽位表可以依赖已填参数（尺寸：目标类型决定是否还需要第二个点） */
  readonly slots: (values: readonly (Operand | undefined)[]) => readonly SlotSpec[];
  readonly execute: (values: readonly Operand[], ctx: OperationContext) => OperationOutcome;
  /** 成功后接续的下一组参数（直线连续画：以刚画的终点为下一段起点） */
  readonly continueWith?: (values: readonly Operand[]) => readonly Operand[] | null;
}

/* -------- 绘图 -------- */

const pointOperation: OperationMeta = {
  id: 'point',
  label: '点',
  group: 'draw',
  tool: 'point',
  slots: () => [createPointSlot('位置', '点一个位置（可吸附已有点）')],
  execute(values, ctx) {
    const v = values[0];
    if (!isPointOperand(v)) return actionOut(actionFail('缺少点参数'));
    return actionOut(placePointEntity(v.point, ctx.owned.has(v.point.id)));
  },
};

const lineOperation: OperationMeta = {
  id: 'line',
  label: '直线',
  group: 'draw',
  tool: 'line',
  slots: () => [createPointSlot('起点', '点一个起点'), createPointSlot('终点', '点一个终点')],
  execute(values) {
    const a = values[0];
    const b = values[1];
    if (!isPointOperand(a) || !isPointOperand(b)) {
      return actionOut(actionFail('缺少起点或终点'));
    }
    return actionOut(createLine(a.point, b.point));
  },
  // 连续画：刚画的终点就是下一段的起点（点已并入图元，不再计入 owned）
  continueWith(values) {
    const b = values[1];
    return isPointOperand(b) ? [pointOperand(b.point)] : null;
  },
};

const circleOperation: OperationMeta = {
  id: 'circle',
  label: '圆',
  group: 'draw',
  tool: 'circle',
  slots: () => [createPointSlot('圆心', '点一个圆心'), positionSlot('半径', '点一个半径位置')],
  execute(values) {
    const center = values[0];
    const radius = values[1];
    if (!isPointOperand(center) || !isPositionOperand(radius)) {
      return actionOut(actionFail('缺少圆心或半径'));
    }
    return actionOut(createCircle(center.point, vec.dist(center.point, radius.pos)));
  },
};

const arcOperation: OperationMeta = {
  id: 'arc',
  label: '圆弧',
  group: 'draw',
  tool: 'arc',
  slots: () => [
    createPointSlot('圆心', '点一个圆心'),
    positionSlot('起点', '点一个起点（决定半径与起始角）'),
    positionSlot('终点', '点一个终点（与起点同角即整圆）'),
  ],
  execute(values) {
    const center = values[0];
    const start = values[1];
    const end = values[2];
    if (!isPointOperand(center) || !isPositionOperand(start) || !isPositionOperand(end)) {
      return actionOut(actionFail('缺少圆心或起终点'));
    }
    const c = center.point;
    // 半径退化时按 MIN_RADIUS 创建（与旧 arc 状态机一致），避免零半径图元
    const r = Math.max(MIN_RADIUS, vec.dist(c, start.pos));
    const a0 = Math.atan2(start.pos.y - c.y, start.pos.x - c.x);
    const a1 = Math.atan2(end.pos.y - c.y, end.pos.x - c.x);
    return actionOut(createArc(c, r, a0, a1));
  },
};

const rectOperation: OperationMeta = {
  id: 'rect',
  label: '矩形',
  group: 'draw',
  tool: 'rect',
  slots: () => [
    positionSlot('对角点 1', '点一个对角点'),
    positionSlot('对角点 2', '点另一个对角点'),
  ],
  execute(values) {
    const a = values[0];
    const b = values[1];
    if (!isPositionOperand(a) || !isPositionOperand(b)) {
      return actionOut(actionFail('缺少两个对角点'));
    }
    return actionOut(createRect(a.pos, b.pos));
  },
};

/* -------- 尺寸 -------- */

/** 尺寸目标槽位：点、直线、圆/弧、已有尺寸都可能是「要点」的对象 */
const dimTargetSlot: SlotSpec = {
  key: '目标',
  prompt: '点一个点、直线、圆/弧或已有尺寸',
  accepts: (op) => acceptsDim(op) || acceptsPointLineCurve(op),
};

const dimOperation: OperationMeta = {
  id: 'dim',
  label: '尺寸',
  group: 'draw',
  tool: 'dim',
  slots(values) {
    const first = values[0];
    // 第一参数是点时才需要第二个点；其余目标（线长/半径/已有尺寸）一次点击就够
    if (isPointOperand(first)) {
      return [
        dimTargetSlot,
        {
          ...createPointSlot('第二点', '点第二个点（可在空白处取点）'),
        },
      ];
    }
    return [dimTargetSlot];
  },
  execute(values, ctx) {
    const first = values[0];
    if (!first) return dimOut({ ok: false, reason: '缺少尺寸目标' });
    switch (first.kind) {
      case 'dim':
        return dimOut({ ok: true, con: first.con, created: false, notices: [] });
      case 'entity':
        // 点图元只能作为两点距离的一端，不能直接标半径/线长
        if (first.entity.type === 'point') {
          return dimOut({ ok: false, reason: '点图元只能作为两点距离的一端' });
        }
        return dimOut(dimForEntity(first.entity, ctx.zoom));
      case 'point': {
        const second = values[1];
        if (!isPointOperand(second)) {
          return dimOut({ ok: false, reason: '还需要第二个点' });
        }
        // 第二点的 at 是点击位置：距离尺寸的 offset 取它相对连线的法向投影
        return dimOut(
          dimForPoints(first.point, second.point, second.at, ctx.owned.has(second.point.id)),
        );
      }
      case 'position':
        return dimOut({ ok: false, reason: '该对象不能标注尺寸' });
    }
  },
};

/* -------- 编辑 -------- */

const eraseOperation: OperationMeta = {
  id: 'erase',
  label: '删除',
  group: 'edit',
  tool: 'erase',
  slots: () => [
    {
      key: '对象',
      prompt: '点要删除的点或图元（点一个立即删除，可继续点）',
      accepts: acceptsPointOrEntity,
      repeat: true,
    },
  ],
  execute(values) {
    return actionOut(deleteSelected(operandSelection(values)));
  },
};

const fixOperation: OperationMeta = {
  id: 'fix',
  label: '固定',
  group: 'edit',
  tool: null,
  slots: () => [
    {
      key: '对象',
      prompt: '点要固定的点或图元（点一个立即生效，可继续点）',
      accepts: acceptsPointOrEntity,
      repeat: true,
    },
  ],
  execute(values) {
    return actionOut(toggleFixed(operandSelection(values)));
  },
};

const constructionOperation: OperationMeta = {
  id: 'construction',
  label: '构造',
  group: 'edit',
  tool: null,
  slots: () => [
    {
      key: '图元',
      prompt: '点要切换构造的图元（点一个立即切换，可继续点）',
      accepts: acceptsEntity,
      repeat: true,
    },
  ],
  execute(values) {
    return actionOut(toggleConstruction(operandSelection(values)));
  },
};

/* -------- 约束 -------- */

/**
 * 「重合」的上下文排除（写模型前就挡住无意义约束）：
 * - 同一个点不能和自己重合；
 * - 点已经是目标直线的端点 → pointOnLine 恒成立，是假约束；
 * - 点已经是目标圆/弧的圆心 → pointOnCircle 会把半径挤成 0。
 */
function coincidentConflict(anchor: Point, target: Operand): string | undefined {
  if (target.kind === 'point') {
    return target.point.id === anchor.id ? '同一个点不能和自己重合' : undefined;
  }
  if (target.kind !== 'entity') return undefined;
  const e = target.entity;
  if (e.type === 'line' && (e.a === anchor.id || e.b === anchor.id)) {
    return '这个点已经是该直线的端点';
  }
  if (isCurveEntity(e) && e.c === anchor.id) return '这个点已经是该圆/弧的圆心';
  return undefined;
}

const coincidentOperation: OperationMeta = {
  id: 'coincident',
  label: '重合',
  group: 'constraint',
  tool: null,
  slots: () => [
    {
      key: '点',
      prompt: '点一个点（独立点/端点/圆心/点图元）',
      accepts: acceptsPoint,
      duplicateReason: '同一个点不能和自己重合',
      reject: (operand, values) => {
        const target = values[1];
        if (!isPointOperand(operand) || !target) return undefined;
        return coincidentConflict(operand.point, target);
      },
    },
    {
      key: '目标',
      prompt: '点另一个点、直线或圆/弧',
      accepts: acceptsPointLineCurve,
      duplicateReason: '同一个点不能和自己重合',
      reject: (operand, values) => {
        const anchor = values[0];
        if (!isPointOperand(anchor)) return undefined;
        return coincidentConflict(anchor.point, operand);
      },
    },
  ],
  execute(values) {
    const anchor = values[0];
    const target = values[1];
    if (!isPointOperand(anchor) || !target) return actionOut(actionFail('缺少重合的两个对象'));
    if (target.kind === 'point') {
      return actionOut(
        addConstraints([{ kind: 'coincident', props: { a: anchor.point.id, b: target.point.id } }]),
      );
    }
    if (target.kind === 'entity') {
      if (target.entity.type === 'line') {
        return actionOut(
          addConstraints([
            { kind: 'pointOnLine', props: { p: anchor.point.id, e: target.entity.id } },
          ]),
        );
      }
      if (isCurveEntity(target.entity)) {
        return actionOut(
          addConstraints([
            { kind: 'pointOnCircle', props: { p: anchor.point.id, e: target.entity.id } },
          ]),
        );
      }
    }
    return actionOut(actionFail('重合的目标只能是点、直线或圆/弧'));
  },
};

/** 多选直线 → 每条一条水平/竖直约束（repeat 槽位的统一出口） */
function lineConstraints(
  values: readonly Operand[],
  kind: 'horizontal' | 'vertical',
): ResolvedConstraint[] {
  const items: ResolvedConstraint[] = [];
  for (const value of values) {
    if (isEntityOperand(value)) items.push({ kind, props: { e: value.entity.id } });
  }
  return items;
}

const horizontalOperation: OperationMeta = {
  id: 'horizontal',
  label: '水平',
  group: 'constraint',
  tool: null,
  slots: () => [lineSlot('直线', '点一条直线立即生效（可继续点）', true)],
  execute(values) {
    return actionOut(addConstraints(lineConstraints(values, 'horizontal')));
  },
};

const verticalOperation: OperationMeta = {
  id: 'vertical',
  label: '竖直',
  group: 'constraint',
  tool: null,
  slots: () => [lineSlot('直线', '点一条直线立即生效（可继续点）', true)],
  execute(values) {
    return actionOut(addConstraints(lineConstraints(values, 'vertical')));
  },
};

/** 双直线约束：平行 / 垂直 / 等长只有种类不同 */
const twoLineOperation = (
  id: 'parallel' | 'perpendicular' | 'equalLength',
  label: string,
): OperationMeta => ({
  id,
  label,
  group: 'constraint',
  tool: null,
  slots: () => [lineSlot('直线 1', '点第一条直线'), lineSlot('直线 2', '点第二条直线')],
  execute(values) {
    const a = values[0];
    const b = values[1];
    if (!isEntityOperand(a) || !isEntityOperand(b)) return actionOut(actionFail('缺少两条直线'));
    return actionOut(addConstraints([{ kind: id, props: { e1: a.entity.id, e2: b.entity.id } }]));
  },
});

const tangentOperation: OperationMeta = {
  id: 'tangent',
  label: '相切',
  group: 'constraint',
  tool: null,
  // 动态槽位：第一条是直线时第二条只能是圆/弧；第一条是圆/弧时第二条可直线或圆/弧。
  // 这样「两条直线相切」从拾取阶段就不可能，不需要执行时再报错。
  slots(values) {
    const first = values[0];
    if (first === undefined) {
      return [{ key: '对象 1', prompt: '点一条直线或圆/弧', accepts: acceptsLineOrCurve }];
    }
    if (acceptsLine(first)) {
      return [
        { key: '对象 1', prompt: '点一条直线或圆/弧', accepts: acceptsLineOrCurve },
        { key: '对象 2', prompt: '点一个圆/弧（与直线相切）', accepts: acceptsCurve },
      ];
    }
    return [
      { key: '对象 1', prompt: '点一条直线或圆/弧', accepts: acceptsLineOrCurve },
      { key: '对象 2', prompt: '点一条直线或另一个圆/弧', accepts: acceptsLineOrCurve },
    ];
  },
  execute(values) {
    const a = values[0];
    const b = values[1];
    if (!isEntityOperand(a) || !isEntityOperand(b)) return actionOut(actionFail('缺少两个图元'));
    const ea = a.entity;
    const eb = b.entity;
    if (ea.type === 'line' && isCurveEntity(eb)) {
      return actionOut(
        addConstraints([{ kind: 'tangentLineCircle', props: { line: ea.id, circ: eb.id } }]),
      );
    }
    if (eb.type === 'line' && isCurveEntity(ea)) {
      return actionOut(
        addConstraints([{ kind: 'tangentLineCircle', props: { line: eb.id, circ: ea.id } }]),
      );
    }
    if (isCurveEntity(ea) && isCurveEntity(eb)) {
      return actionOut(
        addConstraints([{ kind: 'tangentCircleCircle', props: { e1: ea.id, e2: eb.id } }]),
      );
    }
    return actionOut(actionFail('相切需要 1 条直线 + 1 个圆/弧，或 2 个圆/弧'));
  },
};

const curvePairOperation = (id: 'concentric' | 'equalRadius', label: string): OperationMeta => ({
  id,
  label,
  group: 'constraint',
  tool: null,
  slots: () => [curveSlot('圆/弧 1', '点第一个圆/弧'), curveSlot('圆/弧 2', '点第二个圆/弧')],
  execute(values) {
    const a = values[0];
    const b = values[1];
    if (!isEntityOperand(a) || !isEntityOperand(b)) return actionOut(actionFail('缺少两个圆/弧'));
    return actionOut(addConstraints([{ kind: id, props: { e1: a.entity.id, e2: b.entity.id } }]));
  },
});

/** 全部操作；工具栏/命令分发都从这里查表（顺序即按钮顺序） */
export const OPERATIONS: readonly OperationMeta[] = [
  pointOperation,
  lineOperation,
  circleOperation,
  arcOperation,
  rectOperation,
  dimOperation,
  eraseOperation,
  coincidentOperation,
  horizontalOperation,
  verticalOperation,
  twoLineOperation('parallel', '平行'),
  twoLineOperation('perpendicular', '垂直'),
  twoLineOperation('equalLength', '等长'),
  tangentOperation,
  curvePairOperation('concentric', '同心'),
  curvePairOperation('equalRadius', '等半径'),
  fixOperation,
  constructionOperation,
];

export const CONSTRAINT_OPERATIONS: readonly OperationMeta[] = OPERATIONS.filter(
  (op) => op.group === 'constraint',
);

export const EDIT_OPERATIONS: readonly OperationMeta[] = OPERATIONS.filter(
  (op) => op.group === 'edit' && op.tool === null,
);

const OPERATION_BY_ID = new Map<OperationId, OperationMeta>(OPERATIONS.map((op) => [op.id, op]));

export function operationById(id: OperationId): OperationMeta {
  const meta = OPERATION_BY_ID.get(id);
  if (!meta) throw new Error(`未知操作: ${id}`);
  return meta;
}

/** 工具 id → 对应操作（select 没有操作） */
export function operationForTool(tool: Exclude<ToolId, 'select'>): OperationMeta {
  const meta = OPERATIONS.find((op) => op.tool === tool);
  if (!meta) throw new Error(`工具缺少操作: ${tool}`);
  return meta;
}

/**
 * 操作是否以 repeat 槽位结尾：每点一个对象就执行一次，成功后保持会话继续点
 * （删除 / 固定 / 构造 / 水平 / 竖直）。交互层用它决定「执行后是重开同一命令还是收尾」。
 */
export function isRepeatOperation(id: OperationId): boolean {
  return operationById(id)
    .slots([])
    .some((slot) => slot.repeat === true);
}

/* ======================= 命令会话 ======================= */

/**
 * 正在填参数的命令会话。
 * `values` 按槽位下标存值，允许空洞：选择集预填时，先选直线再点「重合」会直接落到目标槽位，
 * 锚点槽位留空等画布点击。末位 repeat 槽位的值可以超过槽位表长度。
 */
export interface CommandSession {
  readonly opId: OperationId;
  values: (Operand | undefined)[];
  /** 本次会话中由点击新建、还没并入图元的点：回退/取消时删除，避免孤立点 */
  owned: Set<number>;
}

export function createSession(opId: OperationId): CommandSession {
  return { opId, values: [], owned: new Set<number>() };
}

export const sessionSlots = (session: CommandSession): readonly SlotSpec[] =>
  operationById(session.opId).slots(session.values);

const filledValues = (session: CommandSession): Operand[] =>
  session.values.filter((v): v is Operand => v !== undefined);

/** 命令是否已填满全部槽位（repeat 槽位至少一个值即算填满） */
export function isComplete(session: CommandSession): boolean {
  const slots = sessionSlots(session);
  return slots.length === 0 || slots.every((_, i) => session.values[i] !== undefined);
}

/** 两个操作数是否指向同一个对象（同一个点不能填两个槽位） */
function sameOperand(a: Operand, b: Operand): boolean {
  if (a.kind === 'point' && b.kind === 'point') return a.point.id === b.point.id;
  if (a.kind === 'entity' && b.kind === 'entity') return a.entity.id === b.entity.id;
  if (a.kind === 'dim' && b.kind === 'dim') return a.con.id === b.con.id;
  return false;
}

const isOperandUsed = (session: CommandSession, operand: Operand): boolean =>
  filledValues(session).some((v) => sameOperand(v, operand));

/** 选择集预填结果：用掉多少、为什么有对象没装进去（给状态栏提示用） */
export interface FillFromResult {
  readonly used: number;
  readonly reasons: readonly string[];
}

/**
 * 把选择集对象装进槽位：按类型匹配，不按用户选择顺序硬编码。
 * repeat 槽位会吃掉所有兼容的剩余对象；装不进去的对象把原因收集起来
 * （例如「同一个点不能和自己重合」），由调用方提示，而不是静默忽略。
 */
export function fillFromOperands(
  session: CommandSession,
  operands: readonly Operand[],
): FillFromResult {
  let used = 0;
  const reasons: string[] = [];
  for (const operand of operands) {
    if (fillOne(session, operand, reasons)) used++;
  }
  return { used, reasons };
}

function fillOne(session: CommandSession, operand: Operand, reasons: string[]): boolean {
  const slots = sessionSlots(session);
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (!slot || session.values[i] !== undefined) continue;
    if (!slot.accepts(operand)) continue;
    if (isOperandUsed(session, operand)) {
      reasons.push(slot.duplicateReason ?? '同一个对象不能重复作为参数');
      continue;
    }
    const rejectReason = slot.reject?.(operand, session.values);
    if (rejectReason !== undefined) {
      reasons.push(rejectReason);
      continue;
    }
    session.values[i] = operand;
    return true;
  }
  // 末位 repeat 槽位：已有一个值后继续追加
  const last = slots[slots.length - 1];
  if (last?.repeat && isComplete(session)) {
    if (!last.accepts(operand) || isOperandUsed(session, operand)) return false;
    if (last.reject?.(operand, session.values)) return false;
    session.values.push(operand);
    return true;
  }
  return false;
}

/** 选择集 → 操作数。点图元同时给出图元身份与它引用的点，由槽位决定用哪一个 */
export function operandsFromSelection(selection: Selection): Operand[] {
  const operands: Operand[] = [];
  for (const item of selection.items) {
    if (item.kind === 'pt') {
      const p = getPoint(item.id);
      if (p) operands.push(pointOperand(p));
      continue;
    }
    const e = getEntity(item.id);
    if (!e) continue;
    operands.push(entityOperand(e));
    if (e.type === 'point') {
      const p = getPoint(e.p);
      if (p) operands.push(pointOperand(p));
    }
  }
  return operands;
}

/* ======================= 画布点击 → 候选操作数 ======================= */

/** 点击上下文：几何拾取只需要世界坐标与 zoom，尺寸命中还需要视图/字体 */
export interface ClickInput {
  readonly w: Vec;
  readonly zoom: number;
  readonly view: CameraView;
  readonly snap: Snap | null;
  readonly measureText: MeasureText;
  readonly font: string;
}

interface ClickCandidates {
  /** 非新建候选：按优先级排列（尺寸 > 点 > 图元） */
  readonly operands: readonly Operand[];
  /** 空白点击的落点（吸附位置优先） */
  readonly position: Vec;
  /** 吸附到的已有点（有则新建点复用该点） */
  readonly snapPoint: Point | undefined;
}

/**
 * 一次点击能提供哪些操作数。
 * 优先级沿用各工具的旧语义：尺寸命中 > 点 > 图元；点图元同时给出「点」与「图元」两种身份，
 * 由槽位决定取哪种。位置槽位与新建点槽位不在这里产出（由 fill 时按 place 决定）。
 */
function clickCandidates(input: ClickInput): ClickCandidates {
  const { w, zoom, view, snap, measureText, font } = input;
  const operands: Operand[] = [];

  const dim = pickDim(w, view, measureText, font);
  if (dim) operands.push(dimOperand(dim));

  const snapped = snap?.pt;
  if (snapped) operands.push(pointOperand(snapped, w));

  const pickedPoint = pickPoint(w, zoom);
  if (pickedPoint && pickedPoint.id !== snapped?.id) {
    operands.push(pointOperand(pickedPoint, w));
  }

  const pointEntity = pickPointEntity(w, zoom);
  if (pointEntity) {
    const p = getPoint(pointEntity.p);
    if (p && !operands.some((op) => op.kind === 'point' && op.point.id === p.id)) {
      operands.push(pointOperand(p, w));
    }
    operands.push(entityOperand(pointEntity));
  }

  const entity = pickEntity(w, zoom);
  if (entity && !operands.some((op) => op.kind === 'entity' && op.entity.id === entity.id)) {
    operands.push(entityOperand(entity));
  }

  return { operands, position: snap ? snap.pos : w, snapPoint: snapped };
}

/** 点击补参数的反馈：filled = 是否消耗了这次点击 */
export interface FillResult {
  readonly filled: boolean;
  readonly notices: readonly Notice[];
  /** 没填上时给用户的原因（不适用目标 / 已达可执行态） */
  readonly reason?: string;
}

/**
 * 已可执行时仍在点击的提示。
 * 正常交互填满即执行，只有 Enter 重试失败后会话会停在可执行态（交互层保留会话供回退/重试）。
 */
const completeNotice: Notice = { kind: 'info', message: '参数已齐：Enter 重试，Backspace 回退' };

/** 画布点击：只消费能填进空槽位的候选；交互层在填满后立即执行 */
export function clickCommand(session: CommandSession, input: ClickInput): FillResult {
  const slots = sessionSlots(session);

  // 已可执行：只有末位 repeat 槽位还能继续追加对象
  if (isComplete(session)) {
    if (appendRepeat(session, slots, input)) return { filled: true, notices: [] };
    return { filled: false, notices: [completeNotice] };
  }

  const cands = clickCandidates(input);
  const reasons: string[] = [];

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (!slot || session.values[i] !== undefined) continue;

    if (slot.place === 'point') {
      // 先尝试已有点（普通点 / 点图元 / 吸附点）：尺寸第二点、从已有点起画都走这里
      let filled = false;
      for (const operand of cands.operands) {
        if (isOperandUsed(session, operand)) {
          if (slot.accepts(operand)) {
            reasons.push(slot.duplicateReason ?? '同一个对象不能重复作为参数');
          }
          continue;
        }
        if (tryFill(session, i, slot, operand, reasons)) {
          filled = true;
          break;
        }
      }
      if (filled) return afterFill();
      if (cands.operands.some((op) => op.kind === 'point')) continue;

      // 没有可复用的点：在吸附位置/指针位置新建（会话结束时未使用会被回收）
      const point = addPt(cands.position.x, cands.position.y);
      session.owned.add(point.id);
      if (tryFill(session, i, slot, pointOperand(point, input.w), reasons)) {
        return afterFill();
      }
      // 没填进去（上下文拒绝等）：回收临时点，避免留下孤立点
      session.owned.delete(point.id);
      discardPoint(point);
      continue;
    }

    if (slot.place === 'position') {
      if (tryFill(session, i, slot, positionOperand(cands.position), reasons)) {
        return afterFill();
      }
      continue;
    }

    for (const operand of cands.operands) {
      if (isOperandUsed(session, operand)) {
        // 只对「这个槽位本来会接受它」的重复对象给提示，避免噪声
        if (slot.accepts(operand)) {
          reasons.push(slot.duplicateReason ?? '同一个对象不能重复作为参数');
        }
        continue;
      }
      if (tryFill(session, i, slot, operand, reasons)) return afterFill();
    }
  }

  const reason = reasons[0] ?? `还需要：${firstEmptySlotLabel(session)}`;
  return { filled: false, notices: [], reason };
}

function tryFill(
  session: CommandSession,
  index: number,
  slot: SlotSpec,
  operand: Operand,
  reasons: string[],
): boolean {
  if (!slot.accepts(operand)) return false;
  const reason = slot.reject?.(operand, session.values);
  if (reason !== undefined) {
    reasons.push(reason);
    return false;
  }
  session.values[index] = operand;
  return true;
}

/** 填槽位后的反馈：填满即由交互层立即执行，这里不再提示按键（避免成功时闪一条多余提示） */
function afterFill(): FillResult {
  return { filled: true, notices: [] };
}

/** 末位 repeat 槽位追加一个兼容对象（已可执行时点击仍可继续加） */
function appendRepeat(
  session: CommandSession,
  slots: readonly SlotSpec[],
  input: ClickInput,
): boolean {
  const last = slots[slots.length - 1];
  if (!last?.repeat) return false;
  const cands = clickCandidates(input);
  for (const operand of cands.operands) {
    if (isOperandUsed(session, operand)) continue;
    if (!last.accepts(operand)) continue;
    if (last.reject?.(operand, session.values)) continue;
    session.values.push(operand);
    return true;
  }
  return false;
}

function firstEmptySlotLabel(session: CommandSession): string {
  const slots = sessionSlots(session);
  for (let i = 0; i < slots.length; i++) {
    if (session.values[i] === undefined) return `${slots[i]!.key}（${slots[i]!.prompt}）`;
  }
  return '（无）';
}

/** 指针悬停时该高亮的对象：只亮「点下去真的会填进某个空槽位」的对象 */
export function commandHover(
  session: CommandSession,
  input: ClickInput,
): { pt?: Point; ent?: Entity } {
  const slots = sessionSlots(session);
  const cands = clickCandidates(input);

  // 新建点/位置槽位：吸附到已有点时高亮那个点，给「会复用它」的反馈
  const wantsPlace = isComplete(session)
    ? slots[slots.length - 1]?.repeat === true
    : slots.some((slot, i) => slot.place !== undefined && session.values[i] === undefined);
  if (wantsPlace && cands.snapPoint) return highlightPoint(cands.snapPoint);

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (!slot || session.values[i] !== undefined) continue;
    if (slot.place !== undefined) continue;
    for (const operand of cands.operands) {
      if (isOperandUsed(session, operand)) continue;
      if (!slot.accepts(operand)) continue;
      if (slot.reject?.(operand, session.values)) continue;
      return highlightOperand(operand);
    }
  }

  // 已可执行但末位是 repeat：继续可加
  const last = slots[slots.length - 1];
  if (isComplete(session) && last?.repeat) {
    for (const operand of cands.operands) {
      if (isOperandUsed(session, operand)) continue;
      if (last.accepts(operand) && !last.reject?.(operand, session.values)) {
        return highlightOperand(operand);
      }
    }
  }
  return {};
}

function highlightPoint(p: Point): { pt?: Point; ent?: Entity } {
  const owner = pointEntityOf(p.id);
  return owner ? { ent: owner } : { pt: p };
}

function highlightOperand(op: Operand): { pt?: Point; ent?: Entity } {
  if (op.kind === 'point') return highlightPoint(op.point);
  if (op.kind === 'entity') return { ent: op.entity };
  return {};
}

/* ======================= 回退 / 取消 / 执行 ======================= */

/** Backspace：回退最后一个已填参数；顺带删掉本次会话新建、已不在槽位里的点 */
export function popCommandValue(session: CommandSession): boolean {
  for (let i = session.values.length - 1; i >= 0; i--) {
    const value = session.values[i];
    if (!value) continue;
    session.values.splice(i, 1);
    if (value.kind === 'point' && session.owned.delete(value.point.id)) {
      removeOwnedPoint(value.point.id);
    }
    return true;
  }
  return false;
}

/** Esc/切工具：放弃命令，删掉会话里新建但还没并入图元的点 */
export function cancelCommand(session: CommandSession): void {
  for (const id of [...session.owned]) removeOwnedPoint(id);
  session.owned.clear();
}

function removeOwnedPoint(id: number): void {
  const p = getPoint(id);
  // owned 里的点一定还没并入图元/约束：只从模型移除，避免 pruneOrphanPoints 误删同会话其它点
  if (p) discardPoint(p);
}

/** 执行命令；参数没齐时返回失败原因（不写模型）。交互层在槽位填满或按下 Enter 时调用 */
export function executeCommand(session: CommandSession, zoom: number): OperationOutcome {
  if (!isComplete(session)) {
    return actionOut(actionFail(`命令参数还没选齐：${firstEmptySlotLabel(session)}`));
  }
  const op = operationById(session.opId);
  return op.execute(filledValues(session), { zoom, owned: session.owned });
}

/** 执行成功后的接续会话（目前只有直线连续画）；没有接续返回 null */
export function continuationOf(session: CommandSession): CommandSession | null {
  const op = operationById(session.opId);
  const nextValues = op.continueWith?.(filledValues(session));
  if (!nextValues) return null;
  const next = createSession(session.opId);
  next.values.push(...nextValues);
  return next;
}

/* ======================= 状态栏 / 预览 ======================= */

/** 状态栏的命令行文案：显示当前操作、每个参数的值/待选，以及可用按键 */
export function commandStatus(session: CommandSession): string {
  const op = operationById(session.opId);
  const slots = sessionSlots(session);
  const segments: string[] = [`命令 ${op.label}`];

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    if (slot.repeat) {
      const values = session.values.slice(i).filter((v): v is Operand => v !== undefined);
      segments.push(
        values.length === 0
          ? `${slot.key}：待选（${slot.prompt}）`
          : `${slot.key}：${values.map(operandLabel).join('、')}`,
      );
      continue;
    }
    const value = session.values[i];
    segments.push(
      value === undefined
        ? `${slot.key}：待选（${slot.prompt}）`
        : `${slot.key}：${operandLabel(value)}`,
    );
  }

  const actions: string[] = [isComplete(session) ? '参数已齐' : '点击画布补参数'];
  if (filledValues(session).length > 0) actions.push('Backspace 回退');
  actions.push('Esc 取消');
  return `${segments.join(' ▸ ')} · ${actions.join(' · ')}`;
}

/** 画布预览形状（世界坐标）：操作自己描述预览，renderer 只负责画 */
export type PreviewShape =
  | { readonly kind: 'line'; readonly a: Vec; readonly b: Vec }
  | { readonly kind: 'circle'; readonly c: Vec; readonly r: number }
  | {
      readonly kind: 'arc';
      readonly c: Vec;
      readonly r: number;
      readonly a0: number;
      readonly a1: number;
    }
  | { readonly kind: 'rect'; readonly a: Vec; readonly b: Vec };

/** 命令预览：已填参数 + 光标位置推演「按下去会画出什么」 */
export function commandPreview(session: CommandSession, cursor: Vec): PreviewShape[] {
  const values = filledValues(session);
  const op = operationById(session.opId);

  switch (op.id) {
    case 'line': {
      const a = operandPos(values[0]);
      if (!a) return [];
      const b = operandPos(values[1]) ?? cursor;
      return [{ kind: 'line', a, b }];
    }
    case 'circle': {
      const c = operandPos(values[0]);
      if (!c) return [];
      const edge = operandPos(values[1]) ?? cursor;
      return [{ kind: 'circle', c, r: vec.dist(c, edge) }];
    }
    case 'arc': {
      const c = operandPos(values[0]);
      if (!c) return [];
      const start = operandPos(values[1]);
      if (!start) return [{ kind: 'circle', c, r: vec.dist(c, cursor) }];
      const end = operandPos(values[2]) ?? cursor;
      return [
        {
          kind: 'arc',
          c,
          r: vec.dist(c, start),
          a0: Math.atan2(start.y - c.y, start.x - c.x),
          a1: Math.atan2(end.y - c.y, end.x - c.x),
        },
      ];
    }
    case 'rect': {
      const a = operandPos(values[0]);
      if (!a) return [];
      const b = operandPos(values[1]) ?? cursor;
      return [{ kind: 'rect', a, b }];
    }
    case 'dim': {
      // 两点距离：第一点已填、第二点未填时从它拉一条预览线（与旧尺寸工具一致）
      const first = values[0];
      if (!isPointOperand(first)) return [];
      if (sessionSlots(session).length <= 1 || values[1] !== undefined) return [];
      return [{ kind: 'line', a: first.point, b: cursor }];
    }
    // 其余操作没有几何预览：约束/固定/构造/删除只改约束与属性，点工具由吸附标记反馈
    case 'point':
    case 'erase':
    case 'fix':
    case 'construction':
    case 'coincident':
    case 'horizontal':
    case 'vertical':
    case 'parallel':
    case 'perpendicular':
    case 'equalLength':
    case 'tangent':
    case 'concentric':
    case 'equalRadius':
      return [];
  }
}

/** 操作数 → Selection（删除/固定/构造这些复用选择集级联逻辑的动作） */
function operandSelection(values: readonly Operand[]): Selection {
  const items: Selection['items'] = [];
  for (const value of values) {
    if (value.kind === 'point') items.push({ kind: 'pt', id: value.point.id });
    else if (value.kind === 'entity') items.push({ kind: 'ent', id: value.entity.id });
  }
  return { items };
}
