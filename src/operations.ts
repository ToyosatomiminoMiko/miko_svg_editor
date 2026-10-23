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
import { TAU, formatDimValue, sweepOf, type ResolvedConstraint } from './config';
import { dimLabel, pickDim, type DimConstraint } from './dimensions';
import { isCurveEntity, type Entity, type EntityPrimitive } from './entities';
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
import type { MeasureText, Point, Selection, Snap, ToolId, Vec } from './types';
import { vec } from './vec';

/* ======================= 操作数 ======================= */

/**
 * 一个参数槽位里装的东西。
 * - point：模型里的几何点（独立点 / 直线端点 / 圆或圆弧圆心 / 圆弧端点 / 点图元引用的点）；
 * - position：只有世界坐标的位置（圆半径点、矩形对角点用，不创建模型点）；
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

/** 执行函数里的类型收窄：槽位已保证类型，取不到只可能是参数缺失（正常流程不会发生） */
const pointOf = (op: Operand | undefined): Point | undefined =>
  op?.kind === 'point' ? op.point : undefined;
const posOf = (op: Operand | undefined): Vec | undefined =>
  op?.kind === 'position' ? op.pos : undefined;
const entityOf = (op: Operand | undefined): Entity | undefined =>
  op?.kind === 'entity' ? op.entity : undefined;

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
      return `${op.entity.label} #${op.entity.id}`;
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
  /**
   * 允许复用已填进其它槽位的同一个点（圆弧终点复用起点 = 整圆）。
   * 只对点操作数有意义：把「同一个点不能重复作为参数」的通用去重让给 execute 判断。
   */
  readonly allowDuplicate?: boolean;
}

const acceptsPoint = (op: Operand): boolean => op.kind === 'point';
const acceptsPosition = (op: Operand): boolean => op.kind === 'position';
const acceptsEntity = (op: Operand): boolean => op.kind === 'entity';
const acceptsLine = (op: Operand): boolean => op.kind === 'entity' && op.entity.category === 'line';
const acceptsCurve = (op: Operand): boolean => op.kind === 'entity' && isCurveEntity(op.entity);
const acceptsLineOrCurve = (op: Operand): boolean => acceptsLine(op) || acceptsCurve(op);
const acceptsPointOrEntity = (op: Operand): boolean => op.kind === 'point' || op.kind === 'entity';
const acceptsDim = (op: Operand): boolean => op.kind === 'dim';
const acceptsPointLineCurve = (op: Operand): boolean =>
  op.kind === 'point' || acceptsLineOrCurve(op);

/** 点击可新建点的槽位（直线/圆弧起点终点、圆心、尺寸点） */
const createPointSlot = (key: string, prompt: string): SlotSpec => ({
  key,
  prompt,
  accepts: acceptsPoint,
  place: 'point',
});
/** 只取位置的槽位（圆半径位置、矩形对角点） */
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
  | 'collinear'
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

/** 绘图操作：id 与工具相同，group 固定 draw；只差槽位/执行/接续 */
const drawOperation = (
  id: ToolOperationId,
  label: string,
  slots: OperationMeta['slots'],
  execute: OperationMeta['execute'],
  continueWith?: OperationMeta['continueWith'],
): OperationMeta => ({ id, label, group: 'draw', tool: id, slots, execute, continueWith });

const pointOperation = drawOperation(
  'point',
  '点',
  () => [createPointSlot('位置', '点一个位置（可吸附已有点）')],
  (values, ctx) => {
    const p = pointOf(values[0]);
    if (!p) return actionOut(actionFail('缺少点参数'));
    return actionOut(placePointEntity(p, ctx.owned.has(p.id)));
  },
);

const lineOperation = drawOperation(
  'line',
  '直线',
  () => [createPointSlot('起点', '点一个起点'), createPointSlot('终点', '点一个终点')],
  (values) => {
    const a = pointOf(values[0]);
    const b = pointOf(values[1]);
    if (!a || !b) return actionOut(actionFail('缺少起点或终点'));
    return actionOut(createLine(a, b));
  },
  // 连续画：刚画的终点就是下一段的起点（点已并入图元，不再计入 owned）
  (values) => {
    const b = pointOf(values[1]);
    return b ? [pointOperand(b)] : null;
  },
);

const circleOperation = drawOperation(
  'circle',
  '圆',
  () => [createPointSlot('圆心', '点一个圆心'), positionSlot('半径', '点一个半径位置')],
  (values) => {
    const center = pointOf(values[0]);
    const edge = posOf(values[1]);
    if (!center || !edge) return actionOut(actionFail('缺少圆心或半径'));
    return actionOut(createCircle(center, vec.dist(center, edge)));
  },
);

const arcOperation = drawOperation(
  'arc',
  '圆弧',
  // 圆心/起点/终点都是真实点：空白点击会建点，吸附到已有点时复用同一个 Point
  () => [
    createPointSlot('圆心', '点一个圆心'),
    createPointSlot('起点', '点一个起点（决定半径与起始角）'),
    // 终点允许直接复用起点（同一个点 → a0 === a1 → 整圆），所以打开 allowDuplicate
    { ...createPointSlot('终点', '点一个终点（再点起点即整圆）'), allowDuplicate: true },
  ],
  (values, ctx) => {
    const center = pointOf(values[0]);
    const start = pointOf(values[1]);
    const end = pointOf(values[2]);
    if (!center || !start || !end) return actionOut(actionFail('缺少圆心或起终点'));
    return actionOut(createArc(center, start, end, ctx.owned));
  },
);

const rectOperation = drawOperation(
  'rect',
  '矩形',
  () => [positionSlot('对角点 1', '点一个对角点'), positionSlot('对角点 2', '点另一个对角点')],
  (values) => {
    const a = posOf(values[0]);
    const b = posOf(values[1]);
    if (!a || !b) return actionOut(actionFail('缺少两个对角点'));
    return actionOut(createRect(a, b));
  },
);

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
        if (first.entity.category === 'point') {
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

/**
 * 可重复的选择集操作（删除/固定/构造）：点一个对象立即执行、命令保持可继续点。
 * 三个操作的差别只有「接受什么 / 交给哪个领域动作」，统一由这个工厂生成。
 */
const repeatSelectionOperation = (
  id: 'erase' | 'fix' | 'construction',
  label: string,
  key: string,
  prompt: string,
  accepts: (op: Operand) => boolean,
  run: (selection: Selection) => ActionResult,
): OperationMeta => ({
  id,
  label,
  group: 'edit',
  tool: id === 'erase' ? 'erase' : null,
  slots: () => [{ key, prompt, accepts, repeat: true }],
  execute: (values) => actionOut(run(operandSelection(values))),
});

const eraseOperation = repeatSelectionOperation(
  'erase',
  '删除',
  '对象',
  '点要删除的点或图元（点一个立即删除，可继续点）',
  acceptsPointOrEntity,
  deleteSelected,
);

const fixOperation = repeatSelectionOperation(
  'fix',
  '固定',
  '对象',
  '点要固定的点或图元（点一个立即生效，可继续点）',
  acceptsPointOrEntity,
  toggleFixed,
);

const constructionOperation = repeatSelectionOperation(
  'construction',
  '构造',
  '图元',
  '点要切换构造的图元（点一个立即切换，可继续点）',
  acceptsEntity,
  toggleConstruction,
);

/* -------- 约束 -------- */

/**
 * 「重合」的上下文排除（写模型前就挡住无意义约束）：
 * - 同一个点不能和自己重合；
 * - 点已经是目标图元的结构点（直线端点 / 圆或弧圆心 / 圆弧端点）时，
 *   对应约束恒成立或是把半径挤成 0 的假约束。
 * 结构角色由 target.entity.pointRole() 多态给出，这里不按图元种类分叉。
 */
function coincidentConflict(anchor: Point, target: Operand): string | undefined {
  if (target.kind === 'point') {
    return target.point.id === anchor.id ? '同一个点不能和自己重合' : undefined;
  }
  if (target.kind !== 'entity') return undefined;
  const role = target.entity.pointRole(anchor.id);
  return role === null ? undefined : `这个点已经是该${target.entity.label}的${role}`;
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
    const anchor = pointOf(values[0]);
    const target = values[1];
    if (!anchor || !target) return actionOut(actionFail('缺少重合的两个对象'));
    const targetPoint = pointOf(target);
    if (targetPoint) {
      return actionOut(
        addConstraints([{ kind: 'coincident', props: { a: anchor.id, b: targetPoint.id } }]),
      );
    }
    const targetEntity = entityOf(target);
    // 目标图元自己决定「点落在它上面」是哪种约束：直线 pointOnLine、圆/弧 pointOnCircle
    const con = targetEntity?.pointOnConstraint(anchor.id);
    if (con) return actionOut(addConstraints([con]));
    return actionOut(actionFail('重合的目标只能是点、直线或圆/弧'));
  },
};

/** 单条直线的水平/竖直约束：repeat 槽位逐条立即生效，只有 kind 不同 */
const axisOperation = (id: 'horizontal' | 'vertical', label: string): OperationMeta => ({
  id,
  label,
  group: 'constraint',
  tool: null,
  slots: () => [lineSlot('直线', '点一条直线立即生效（可继续点）', true)],
  execute(values) {
    const items: ResolvedConstraint[] = [];
    for (const value of values) {
      const line = entityOf(value);
      if (line) items.push({ kind: id, props: { e: line.id } });
    }
    return actionOut(addConstraints(items));
  },
});

const horizontalOperation = axisOperation('horizontal', '水平');
const verticalOperation = axisOperation('vertical', '竖直');

/** 双直线约束：平行 / 垂直 / 等长 / 共线只有种类不同 */
const twoLineOperation = (
  id: 'parallel' | 'perpendicular' | 'equalLength' | 'collinear',
  label: string,
): OperationMeta => ({
  id,
  label,
  group: 'constraint',
  tool: null,
  slots: () => [lineSlot('直线 1', '点第一条直线'), lineSlot('直线 2', '点第二条直线')],
  execute(values) {
    const a = entityOf(values[0]);
    const b = entityOf(values[1]);
    if (!a || !b) return actionOut(actionFail('缺少两条直线'));
    return actionOut(addConstraints([{ kind: id, props: { e1: a.id, e2: b.id } }]));
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
    const a = entityOf(values[0]);
    const b = entityOf(values[1]);
    if (!a || !b) return actionOut(actionFail('缺少两个图元'));
    // 相切种类由图元多态决定（直线-圆 / 圆-圆），执行函数只负责把组合交给图元
    const con = a.tangentWith(b);
    if (!con) return actionOut(actionFail('相切需要 1 条直线 + 1 个圆/弧，或 2 个圆/弧'));
    return actionOut(addConstraints([con]));
  },
};

const curvePairOperation = (id: 'concentric' | 'equalRadius', label: string): OperationMeta => ({
  id,
  label,
  group: 'constraint',
  tool: null,
  slots: () => [curveSlot('圆/弧 1', '点第一个圆/弧'), curveSlot('圆/弧 2', '点第二个圆/弧')],
  execute(values) {
    const a = entityOf(values[0]);
    const b = entityOf(values[1]);
    if (!a || !b) return actionOut(actionFail('缺少两个圆/弧'));
    return actionOut(addConstraints([{ kind: id, props: { e1: a.id, e2: b.id } }]));
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
  twoLineOperation('collinear', '共线'),
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

/* ======================= 工具元数据 ======================= */

/** 工具栏「工具」分段的顺序、单键快捷键与提示；label 来自对应操作（选择除外），不重复维护 */
export interface ToolMeta {
  readonly id: ToolId;
  readonly label: string;
  /** 单键快捷键（小写） */
  readonly key: string;
  readonly hint: string;
}

/** 工具顺序（选择工具固定最前，其余与 TOOL_HINTS 的键一一对应） */
const TOOL_ORDER = [
  'point',
  'line',
  'circle',
  'arc',
  'rect',
  'dim',
  'erase',
] as const satisfies readonly Exclude<ToolId, 'select'>[];

const TOOL_HINTS: Record<(typeof TOOL_ORDER)[number], { key: string; hint: string }> = {
  point: { key: 'p', hint: '点位置放独立点 · 吸附到已有点会把它提升为独立点' },
  line: { key: 'l', hint: '点起点、终点自动画线 · 连续画自动接上一段终点 · Esc/右键结束' },
  circle: { key: 'c', hint: '点圆心、半径位置自动创建' },
  arc: { key: 'a', hint: '圆心 → 起点 → 终点自动创建' },
  rect: { key: 'r', hint: '点两个对角点自动创建 · 自动补水平/竖直约束' },
  dim: { key: 'd', hint: '点目标即标注 · 两点距离 / 线长 / 半径 / 改已有尺寸' },
  erase: { key: 'e', hint: '点对象即删除 · 可继续点 · Esc/右键结束' },
};

/** 工具元数据：顺序即工具栏顺序；选择工具没有操作，文案单独给 */
export const TOOLS: readonly ToolMeta[] = [
  {
    id: 'select',
    label: '选择',
    key: 'v',
    hint: '点图元/点 · Shift 加选 · 空白拖框选（下→上交叉 / 上→下窗口） · Delete 删除',
  },
  ...TOOL_ORDER.map((id) => ({
    id,
    label: operationById(id).label,
    ...TOOL_HINTS[id],
  })),
];

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
    if (tryFill(session, i, slot, operand, reasons)) return true;
  }
  // 末位 repeat 槽位：已有一个值后继续追加（预填阶段不提示重复原因，避免噪声）
  const last = slots[slots.length - 1];
  if (last?.repeat && isComplete(session) && canFill(session, last, operand)) {
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
    // 点图元同时提供它包装的点：点槽位与图元槽位因此都能认出同一对象，由槽位类型决定用哪个
    const owned = e.ownedPointId;
    if (owned !== null) {
      const p = getPoint(owned);
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
      if (fillPointSlot(session, i, slot, cands, input, reasons)) return afterFill();
      continue;
    }

    // 位置槽位只消费落点；其余槽位消费拾取到的对象
    const candidates =
      slot.place === 'position' ? [positionOperand(cands.position)] : cands.operands;
    for (const operand of candidates) {
      if (tryFill(session, i, slot, operand, reasons)) return afterFill();
    }
  }

  const reason = reasons[0] ?? `还需要：${firstEmptySlotLabel(session)}`;
  return { filled: false, notices: [], reason };
}

/**
 * 操作数能否填进槽位：类型 → 通用去重 → 上下文排除。
 * 预填/点击/悬停/追加四条路径共用这一份判断；拒绝原因按需写进 reasons。
 */
function canFill(
  session: CommandSession,
  slot: SlotSpec,
  operand: Operand,
  reasons?: string[],
): boolean {
  if (!slot.accepts(operand)) return false;
  if (!slot.allowDuplicate && isOperandUsed(session, operand)) {
    reasons?.push(slot.duplicateReason ?? '同一个对象不能重复作为参数');
    return false;
  }
  const rejected = slot.reject?.(operand, session.values);
  if (rejected !== undefined) {
    reasons?.push(rejected);
    return false;
  }
  return true;
}

/** 把操作数写进第 index 个槽位；填不上时原因由 canFill 收集 */
function tryFill(
  session: CommandSession,
  index: number,
  slot: SlotSpec,
  operand: Operand,
  reasons: string[],
): boolean {
  if (!canFill(session, slot, operand, reasons)) return false;
  session.values[index] = operand;
  return true;
}

/** 点槽位：优先复用候选点；没有可复用的点才在落点新建（失败时回收，不留孤立点） */
function fillPointSlot(
  session: CommandSession,
  index: number,
  slot: SlotSpec,
  cands: ClickCandidates,
  input: ClickInput,
  reasons: string[],
): boolean {
  for (const operand of cands.operands) {
    if (tryFill(session, index, slot, operand, reasons)) return true;
  }
  // 候选里有可复用的点但被上下文排除：保持收集态，不再新建重合点
  if (cands.operands.some((op) => op.kind === 'point')) return false;

  const point = addPt(cands.position.x, cands.position.y);
  session.owned.add(point.id);
  if (tryFill(session, index, slot, pointOperand(point, input.w), reasons)) return true;
  // 没填进去（上下文拒绝等）：回收临时点，避免留下孤立点
  session.owned.delete(point.id);
  discardPoint(point);
  return false;
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
  for (const operand of clickCandidates(input).operands) {
    if (!canFill(session, last, operand)) continue;
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
      if (canFill(session, slot, operand)) return highlightOperand(operand);
    }
  }

  // 已可执行但末位是 repeat：继续可加
  const last = slots[slots.length - 1];
  if (isComplete(session) && last?.repeat) {
    for (const operand of cands.operands) {
      if (canFill(session, last, operand)) return highlightOperand(operand);
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

/**
 * 状态栏的命令文案：当前操作与它的提示分成两段，由 UI 分开显示（不能拼成一行）。
 * - `operation`：命令名 + 每个参数槽位的值/待选，回答「现在在做什么」；
 * - `hint`：下一步能做什么与可用按键，回答「接下来能怎么操作」。
 */
export interface CommandStatusText {
  /** 当前操作本身：命令名与参数槽位进度 */
  readonly operation: string;
  /** 操作提示：下一步动作与可用按键 */
  readonly hint: string;
}

/** 状态栏的命令文案：显示当前操作、每个参数的值/待选，以及可用按键 */
export function commandStatus(session: CommandSession): CommandStatusText {
  const op = operationById(session.opId);
  const slots = sessionSlots(session);
  const segments: string[] = [`命令 ${op.label}`];

  for (let i = 0; i < slots.length; i++) {
    // repeat 槽位从它开始收集全部值，其余槽位只有一个值；统一成「值列表」再生成文案
    const slot = slots[i]!;
    const values = (slot.repeat ? session.values.slice(i) : [session.values[i]]).filter(
      (v): v is Operand => v !== undefined,
    );
    segments.push(
      values.length === 0
        ? `${slot.key}：待选（${slot.prompt}）`
        : `${slot.key}：${values.map(operandLabel).join('、')}`,
    );
  }

  const actions: string[] = [isComplete(session) ? '参数已齐' : '点击画布补参数'];
  if (filledValues(session).length > 0) actions.push('Backspace 回退');
  actions.push('Esc 取消');
  return { operation: segments.join(' ▸ '), hint: actions.join(' · ') };
}

/**
 * 画布预览形状：直接复用图元几何基元（线段 / 圆弧），renderer 的画法与实体绘制共用。
 * 矩形预览是四条闭合线段；点工具由吸附标记反馈，不需要预览基元。
 */
export type PreviewShape = Extract<EntityPrimitive, { kind: 'segment' } | { kind: 'circular' }>;

/** 单个操作的预览构造：已填参数 + 光标位置 → 世界坐标基元 */
type PreviewBuilder = (
  values: readonly Operand[],
  cursor: Vec,
  session: CommandSession,
) => PreviewShape[];

/** 有几何预览的操作；未列出的操作（约束/删除/固定/构造/点）返回空数组 */
const PREVIEW_BUILDERS: Partial<Record<OperationId, PreviewBuilder>> = {
  line(values, cursor) {
    const a = operandPos(values[0]);
    return a ? [{ kind: 'segment', a, b: operandPos(values[1]) ?? cursor }] : [];
  },
  circle(values, cursor) {
    const c = operandPos(values[0]);
    if (!c) return [];
    const edge = operandPos(values[1]) ?? cursor;
    return [{ kind: 'circular', center: c, radius: vec.dist(c, edge), start: 0, sweep: TAU }];
  },
  arc(values, cursor) {
    const c = operandPos(values[0]);
    if (!c) return [];
    const start = operandPos(values[1]);
    if (!start) {
      return [{ kind: 'circular', center: c, radius: vec.dist(c, cursor), start: 0, sweep: TAU }];
    }
    const end = operandPos(values[2]) ?? cursor;
    const a0 = Math.atan2(start.y - c.y, start.x - c.x);
    const a1 = Math.atan2(end.y - c.y, end.x - c.x);
    return [
      {
        kind: 'circular',
        center: c,
        radius: vec.dist(c, start),
        start: a0,
        sweep: sweepOf(a0, a1),
      },
    ];
  },
  rect(values, cursor) {
    const a = operandPos(values[0]);
    if (!a) return [];
    const b = operandPos(values[1]) ?? cursor;
    // 矩形预览 = 四条闭合线段，与线段实体共用同一种基元画法
    const c = { x: b.x, y: a.y };
    const d = { x: a.x, y: b.y };
    return [
      { kind: 'segment', a, b: c },
      { kind: 'segment', a: c, b },
      { kind: 'segment', a: b, b: d },
      { kind: 'segment', a: d, b: a },
    ];
  },
  dim(values, cursor, session) {
    // 两点距离：第一点已填、第二点未填时从它拉一条预览线（与旧尺寸工具一致）
    const first = pointOf(values[0]);
    if (!first) return [];
    if (sessionSlots(session).length <= 1 || values[1] !== undefined) return [];
    return [{ kind: 'segment', a: first, b: cursor }];
  },
};

/** 命令预览：已填参数 + 光标位置推演「按下去会画出什么」 */
export function commandPreview(session: CommandSession, cursor: Vec): PreviewShape[] {
  const build = PREVIEW_BUILDERS[session.opId];
  return build ? build(filledValues(session), cursor, session) : [];
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
