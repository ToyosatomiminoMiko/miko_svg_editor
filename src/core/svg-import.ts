/**
 * SVG 导入的领域逻辑(纯逻辑,不碰 DOM):把一份 SVG 元素树映射成草图图元,再写进模型.
 *
 * 数据流:`ui/svg-file.ts` 用浏览器 DOMParser 把文件解析成 `SvgNode` 树(这一层是 DOM 适配,
 * 不进 core);本文件分两步 -- `planSvgImport` 只读树,产出「已变换到世界坐标的图元计划」
 * (线段/圆/圆弧/点 + construction),`applySvgImport` 才把计划写进 model,并按坐标复用共享点.
 *
 * 为什么分两步:计划阶段完成所有校验/警告/上限截断,用户确认「替换当前草图」前模型一个字节
 * 都不动;确认后 apply 只做纯粹的容器写入,不会再出现「解析到一半失败,旧草图已被清掉」.
 *
 * 为什么导入是有损的:草图模型只有线段/圆/圆弧/点三种几何基元.文字,图片,<use> 引用,
 * 裁剪/蒙版,填充图案都无法表达;贝塞尔与椭圆只能离散成折线.所有损失都记在
 * `SvgImportPlan.warnings` 里提示用户,不做静默近似.
 *
 * 坐标:SVG 用户坐标(y 向下)直接当世界坐标(1 用户单位 = 1 世界单位).根元素的
 * viewBox 只决定用户单位,不参与缩放;导入后由 ui 侧调用「适应视图」把内容放进视口.
 * transform 属性按「父矩阵 x 本元素矩阵」逐层累乘后直接作用到点坐标,不在模型里保留.
 */

import {
  IMPORT_CURVE_SEGMENTS,
  IMPORT_ELLIPSE_SEGMENTS,
  IMPORT_MAX_NODES,
  IMPORT_MAX_SHAPES,
  IMPORT_WARN_LIMIT,
  MIN_DRAW_LENGTH,
  MIN_RADIUS,
} from '../config';
import {
  IDENTITY_MATRIX,
  applyMatrix,
  isConformal,
  matrixDeterminant,
  matrixScale,
  multiplyMatrix,
  parsePathData,
  parseTransform,
  type Matrix,
  type PathSegment,
} from './svg-path';
import { addArc, addCircle, addLine, addPointEntity, addPt } from './model';
import type { Point, Vec } from './types';

/* ============================ 输入树与输出计划 ============================ */

/**
 * DOM 无关的 SVG 元素树:ui 层用 DOMParser 建出同构对象后交给 core.
 * tag 是元素本地名(小写,如 `g`/`linearGradient`);attrs 只保留字符串属性,
 * style 属性里的声明已由 ui 层摊平进 attrs(style 优先),core 不解析 CSS.
 */
export interface SvgNode {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly SvgNode[];
}

/**
 * 导入计划里的几何基元(世界坐标).
 * 与 entities.ts 的 EntityPrimitive 不同:圆弧保留圆心+半径+两个端点(模型里圆弧由三个点定义),
 * 圆保留半径(模型里圆半径是独立参数),点单独一种(点图元只能由显式填充圆识别).
 */
export type ImportPrimitive =
  | { readonly kind: 'segment'; readonly a: Vec; readonly b: Vec }
  | { readonly kind: 'circle'; readonly center: Vec; readonly radius: number }
  | {
      readonly kind: 'arc';
      readonly center: Vec;
      readonly radius: number;
      readonly start: Vec;
      readonly end: Vec;
    }
  | { readonly kind: 'point'; readonly at: Vec };

/** 一个待导入图元;construction 来自继承后的 stroke-dasharray(虚线 = 构造几何) */
export interface ImportedShape {
  readonly primitive: ImportPrimitive;
  readonly construction: boolean;
}

/** 一次导入的完整计划:形状列表 + 跳过统计 + 面向用户的警告(全部在写模型前算好) */
export interface SvgImportPlan {
  readonly shapes: readonly ImportedShape[];
  /** 被跳过的可见元素按标签计数(如 `text: 2`),用于提示与测试 */
  readonly skipped: Readonly<Record<string, number>>;
  /** 中文警告(损失说明,上限截断等);没有损失时为空数组 */
  readonly warnings: readonly string[];
}

/* ============================ 遍历上下文 ============================ */

/** 可继承的呈现属性快照;每个元素在父快照上覆盖自己的属性 */
interface InheritedStyle {
  readonly matrix: Matrix;
  /** 继承后的 stroke-dasharray 原文;构造几何靠它判定 */
  readonly dashArray: string | undefined;
  readonly visibility: string;
  /** opacity 不是继承属性,但逐层相乘才是有效不透明度 */
  readonly opacity: number;
}

interface ImportContext {
  readonly shapes: ImportedShape[];
  readonly skipped: Map<string, number>;
  readonly warnings: string[];
  readonly pathWarnings: string[];
  invalidTransforms: number;
  nonConformal: number;
  roundedRects: number;
  flattenedCurves: number;
  flattenedEllipses: number;
  percentLengths: number;
  pointListIssues: number;
  nestedSvg: number;
  nodes: number;
  truncated: boolean;
}

const createContext = (): ImportContext => ({
  shapes: [],
  skipped: new Map(),
  warnings: [],
  pathWarnings: [],
  invalidTransforms: 0,
  nonConformal: 0,
  roundedRects: 0,
  flattenedCurves: 0,
  flattenedEllipses: 0,
  percentLengths: 0,
  pointListIssues: 0,
  nestedSvg: 0,
  nodes: 0,
  truncated: false,
});

const INITIAL_STYLE: InheritedStyle = {
  matrix: IDENTITY_MATRIX,
  dashArray: undefined,
  visibility: 'visible',
  opacity: 1,
};

/* ============================ 计划阶段 ============================ */

/**
 * 把 SVG 元素树映射成导入计划.纯函数:不动 model,不抛异常;所有不支持/截断/损失都进 warnings.
 * 只识别 SVG 的几何图元(线段/圆/椭圆/矩形/折线/多边形/路径);文字,图片,<use> 等可见内容
 * 记入 skipped,<defs>/<style> 等不可见内容静默跳过.
 */
export function planSvgImport(root: SvgNode): SvgImportPlan {
  const ctx = createContext();
  visitNode(root, INITIAL_STYLE, ctx);
  return {
    shapes: ctx.shapes,
    skipped: Object.fromEntries([...ctx.skipped.entries()].sort((a, b) => b[1] - a[1])),
    warnings: buildWarnings(ctx),
  };
}

/** 容器元素:只继承样式并递归子节点,自身没有几何 */
const CONTAINER_TAGS = new Set(['svg', 'g', 'a', 'switch']);

/** 不可见/资源类元素:不是「用户能看到但导不进来」的内容,静默跳过,不产生警告 */
const SILENT_TAGS = new Set([
  'defs',
  'style',
  'script',
  'title',
  'desc',
  'metadata',
  'symbol',
  'clippath',
  'mask',
  'pattern',
  'marker',
  'filter',
  'lineargradient',
  'radialgradient',
  'stop',
  'font',
  'font-face',
  'glyph',
  'missing-glyph',
]);

/** 用户能在 SVG 里看到,但草图模型表达不了的元素:按标签计数并提示「已跳过」 */
const VISIBLE_SKIP_TAGS = new Set([
  'text',
  'tspan',
  'textpath',
  'image',
  'use',
  'foreignobject',
  'video',
  'canvas',
]);

/** 一个元素的遍历入口:先算有效样式/可见性,再按标签分派 */
function visitNode(node: SvgNode, parent: InheritedStyle, ctx: ImportContext): void {
  if (ctx.truncated || ctx.nodes >= IMPORT_MAX_NODES) {
    if (ctx.nodes >= IMPORT_MAX_NODES) ctx.truncated = true;
    return;
  }
  ctx.nodes++;
  const tag = node.tag.toLowerCase();
  const attrs = node.attrs;

  // display:none 会隐藏整棵子树(子元素无法覆盖),直接剪枝
  if (sameToken(attrs.display, 'none')) return;

  const style = resolveStyle(node, parent, ctx);
  if (style.opacity <= 0) return;

  if (CONTAINER_TAGS.has(tag)) {
    // 嵌套 <svg> 的 viewBox/x/y 会再建一层用户坐标系,导入不做换算,提示一次
    // (根 <svg> 是第一个被访问的节点,ctx.nodes === 1;之后的 <svg> 都是嵌套坐标系)
    if (tag === 'svg' && ctx.nodes > 1 && attrs.viewBox !== undefined) ctx.nestedSvg++;
    for (const child of node.children) visitNode(child, style, ctx);
    return;
  }
  if (SILENT_TAGS.has(tag)) return;
  if (VISIBLE_SKIP_TAGS.has(tag)) {
    bumpSkipped(ctx, tag);
    return;
  }
  if (sameToken(style.visibility, 'hidden') || sameToken(style.visibility, 'collapse')) return;

  switch (tag) {
    case 'line':
      visitLine(attrs, style, ctx);
      return;
    case 'rect':
      visitRect(attrs, style, ctx);
      return;
    case 'circle':
      visitCircle(attrs, style, ctx);
      return;
    case 'ellipse':
      visitEllipse(attrs, style, ctx);
      return;
    case 'polyline':
      visitPolyline(attrs, style, ctx, false);
      return;
    case 'polygon':
      visitPolyline(attrs, style, ctx, true);
      return;
    case 'path':
      visitPath(attrs, style, ctx);
      return;
    default:
      // 未知标签无法判断语义:计入跳过统计,让用户知道有内容没导进来
      bumpSkipped(ctx, tag);
      return;
  }
}

/** 在父快照上应用本元素属性:transform 累乘,虚线与可见性继承,opacity 相乘 */
function resolveStyle(node: SvgNode, parent: InheritedStyle, ctx: ImportContext): InheritedStyle {
  const attrs = node.attrs;
  let matrix = parent.matrix;
  if (attrs.transform !== undefined) {
    const parsed = parseTransform(attrs.transform);
    if (parsed.valid) matrix = multiplyMatrix(parent.matrix, parsed.matrix);
    else ctx.invalidTransforms++;
  }
  const opacityText = attrs.opacity;
  const opacity = opacityText === undefined ? 1 : parseOpacity(opacityText);
  return {
    matrix,
    dashArray: attrs['stroke-dasharray'] ?? parent.dashArray,
    visibility: attrs.visibility ?? parent.visibility,
    opacity: parent.opacity * opacity,
  };
}

/** opacity 解析失败按 1 处理(可见性不能因为坏属性把图形藏掉) */
function parseOpacity(raw: string): number {
  const value = Number.parseFloat(raw.trim());
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/** 虚线的有效值 = 构造几何:空/none/全零都不算虚线 */
function isDashed(dashArray: string | undefined): boolean {
  if (dashArray === undefined) return false;
  const text = dashArray.trim().toLowerCase();
  return text !== '' && text !== 'none' && /[1-9]/.test(text);
}

/** 把属性里的长度解析成数值;缺失/空串用 fallback,百分比与非法值返回 null(调用方跳过该元素) */
function parseLength(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw.trim() === '') return fallback;
  const text = raw.trim();
  if (text.includes('%')) return null;
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? value : null;
}

function bumpSkipped(ctx: ImportContext, tag: string): void {
  ctx.skipped.set(tag, (ctx.skipped.get(tag) ?? 0) + 1);
}

function pushShape(ctx: ImportContext, primitive: ImportPrimitive, construction: boolean): void {
  if (ctx.shapes.length >= IMPORT_MAX_SHAPES) {
    ctx.truncated = true;
    return;
  }
  ctx.shapes.push({ primitive, construction });
}

function pointOf(matrix: Matrix, p: Vec): Vec {
  return applyMatrix(matrix, p);
}

/* ---------------------------- 各图元 ---------------------------- */

function visitLine(
  attrs: Readonly<Record<string, string>>,
  style: InheritedStyle,
  ctx: ImportContext,
): void {
  const x1 = parseLength(attrs.x1, 0);
  const y1 = parseLength(attrs.y1, 0);
  const x2 = parseLength(attrs.x2, 0);
  const y2 = parseLength(attrs.y2, 0);
  if (x1 === null || y1 === null || x2 === null || y2 === null) {
    ctx.percentLengths++;
    return;
  }
  pushShape(
    ctx,
    {
      kind: 'segment',
      a: pointOf(style.matrix, { x: x1, y: y1 }),
      b: pointOf(style.matrix, { x: x2, y: y2 }),
    },
    isDashed(style.dashArray),
  );
}

function visitRect(
  attrs: Readonly<Record<string, string>>,
  style: InheritedStyle,
  ctx: ImportContext,
): void {
  const x = parseLength(attrs.x, 0);
  const y = parseLength(attrs.y, 0);
  const width = parseLength(attrs.width, 0);
  const height = parseLength(attrs.height, 0);
  if (x === null || y === null || width === null || height === null) {
    ctx.percentLengths++;
    return;
  }
  if (width <= 0 || height <= 0) return;
  // 圆角矩形没有对应图元:按四个直角处理,并记一次损失提示
  const rx = parseLength(attrs.rx, 0);
  const ry = parseLength(attrs.ry, 0);
  if ((rx !== null && rx > 0) || (ry !== null && ry > 0)) ctx.roundedRects++;

  const corners: Vec[] = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
  pushClosedLoop(corners, style, ctx);
}

function visitCircle(
  attrs: Readonly<Record<string, string>>,
  style: InheritedStyle,
  ctx: ImportContext,
): void {
  const cx = parseLength(attrs.cx, 0);
  const cy = parseLength(attrs.cy, 0);
  const r = parseLength(attrs.r, 0);
  if (cx === null || cy === null || r === null) {
    ctx.percentLengths++;
    return;
  }
  if (r <= 0) return;
  const center = pointOf(style.matrix, { x: cx, y: cy });
  // 草图导出把点图元写成「显式填充,显式无描边」的小圆;只有这种成对属性才是点图元,
  // 普通圆(靠继承的 fill:none / stroke)保持圆.这样同编辑器导出/导入往返不丢点图元.
  if (isExplicitDotCircle(attrs)) {
    pushShape(ctx, { kind: 'point', at: center }, false);
    return;
  }
  if (!isConformal(style.matrix)) ctx.nonConformal++;
  pushShape(
    ctx,
    { kind: 'circle', center, radius: r * matrixScale(style.matrix) },
    isDashed(style.dashArray),
  );
}

function visitEllipse(
  attrs: Readonly<Record<string, string>>,
  style: InheritedStyle,
  ctx: ImportContext,
): void {
  const cx = parseLength(attrs.cx, 0);
  const cy = parseLength(attrs.cy, 0);
  const rx = parseLength(attrs.rx, 0);
  const ry = parseLength(attrs.ry, 0);
  if (cx === null || cy === null || rx === null || ry === null) {
    ctx.percentLengths++;
    return;
  }
  if (rx <= 0 || ry <= 0) return;
  const construction = isDashed(style.dashArray);
  // 正圆直接复用圆图元;真正的椭圆没有对应基元,只能离散成折线
  if (Math.abs(rx - ry) <= 1e-9 * Math.max(rx, ry)) {
    if (!isConformal(style.matrix)) ctx.nonConformal++;
    pushShape(
      ctx,
      {
        kind: 'circle',
        center: pointOf(style.matrix, { x: cx, y: cy }),
        radius: rx * matrixScale(style.matrix),
      },
      construction,
    );
    return;
  }
  // 采样不含终点(i < N,与 i=0 重合),闭合段由 pushClosedLoop 补,避免多出一条零长度段
  const points: Vec[] = [];
  for (let i = 0; i < IMPORT_ELLIPSE_SEGMENTS; i++) {
    const angle = (i / IMPORT_ELLIPSE_SEGMENTS) * Math.PI * 2;
    points.push(
      pointOf(style.matrix, { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) }),
    );
  }
  ctx.flattenedEllipses++;
  pushClosedLoop(points, style, ctx, construction);
}

function visitPolyline(
  attrs: Readonly<Record<string, string>>,
  style: InheritedStyle,
  ctx: ImportContext,
  close: boolean,
): void {
  const raw = attrs.points;
  if (raw === undefined || raw.trim() === '') return;
  if (raw.includes('%')) {
    ctx.percentLengths++;
    return;
  }
  const numbers = splitNumbers(raw);
  if (numbers.length < 4) return;
  if (numbers.length % 2 !== 0) ctx.pointListIssues++;
  const points: Vec[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    const x = numbers[i];
    const y = numbers[i + 1];
    if (x === undefined || y === undefined) break;
    points.push(pointOf(style.matrix, { x, y }));
  }
  pushOpenPolyline(points, style, ctx, close);
}

function visitPath(
  attrs: Readonly<Record<string, string>>,
  style: InheritedStyle,
  ctx: ImportContext,
): void {
  const parsed = parsePathData(attrs.d, {
    curveSegments: IMPORT_CURVE_SEGMENTS,
    ellipseSegments: IMPORT_ELLIPSE_SEGMENTS,
  });
  ctx.flattenedCurves += parsed.flattened;
  for (const warning of parsed.warnings) ctx.pathWarnings.push(warning);
  const construction = isDashed(style.dashArray);
  for (const segment of parsed.segments) {
    pushPathSegment(segment, style, construction, ctx);
  }
}

/** 路径段 -> 图元:线段/折线直接按点变换;圆弧要处理变换后的半径与扫向 */
function pushPathSegment(
  segment: PathSegment,
  style: InheritedStyle,
  construction: boolean,
  ctx: ImportContext,
): void {
  switch (segment.kind) {
    case 'line':
      pushShape(
        ctx,
        {
          kind: 'segment',
          a: pointOf(style.matrix, segment.from),
          b: pointOf(style.matrix, segment.to),
        },
        construction,
      );
      return;
    case 'curve': {
      const points = segment.points.map((p) => pointOf(style.matrix, p));
      pushOpenPolyline(points, style, ctx, false, construction);
      return;
    }
    case 'arc':
      pushArc(segment, style, construction, ctx);
      return;
  }
}

/**
 * 圆弧导入.
 *
 * 模型圆弧只有「圆心 + 起点 + 终点 + 正向扫角(角增大方向)」一种表示,SVG 弧还有
 * sweep-flag 与 large-arc-flag 决定走哪一侧.数学约定:
 * - sweep-flag=1 的弧 = 从 start 到 end 的正向弧;=0 则是反向弧,等价于「end -> start 的正向弧」;
 * - 变换矩阵行列式 < 0(翻转)会把正向弧映成反向弧,所以再交换一次.
 * 因此当 `sweep flag 的正向性` 与 `det > 0` 不一致时交换起点/终点.交换不改变几何集合,
 * 草图圆弧也不带箭头方向,所以视觉/后续编辑都等价.
 *
 * 非均匀缩放下圆会变成椭圆:把圆心/端点方向按变换后的方向重新投影到半径 = r*scale 的圆上
 * (保证模型里 start/end 到圆心等距,不破坏圆弧的结构残差),并提示已做近似.
 */
function pushArc(
  segment: Extract<PathSegment, { kind: 'arc' }>,
  style: InheritedStyle,
  construction: boolean,
  ctx: ImportContext,
): void {
  const matrix = style.matrix;
  const center = pointOf(matrix, segment.center);
  const radius = segment.radius * matrixScale(matrix);
  if (!(radius > 0) || !Number.isFinite(radius)) return;

  const startLocal = pointOf(matrix, segment.start);
  const endLocal = pointOf(matrix, segment.end);
  const startDir = unitAround(center, startLocal);
  const endDir = unitAround(center, endLocal);
  if (startDir === null || endDir === null) return;

  const detPositive = matrixDeterminant(matrix) > 0;
  const swap = segment.sweepPositive !== detPositive;
  const forward = swap ? endDir : startDir;
  const backward = swap ? startDir : endDir;
  if (!isConformal(matrix)) ctx.nonConformal++;

  pushShape(
    ctx,
    {
      kind: 'arc',
      center,
      radius,
      start: { x: center.x + forward.x * radius, y: center.y + forward.y * radius },
      end: { x: center.x + backward.x * radius, y: center.y + backward.y * radius },
    },
    construction,
  );
}

/** 单位方向向量;端点与圆心重合(退化)返回 null */
function unitAround(center: Vec, point: Vec): Vec | null {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const length = Math.hypot(dx, dy);
  if (!(length > 0) || !Number.isFinite(length)) return null;
  return { x: dx / length, y: dy / length };
}

/* ---------------------------- 折线辅助 ---------------------------- */

/** 依次连接相邻点;close=true 时补最后一段回到首点(多边形/椭圆/矩形) */
function pushOpenPolyline(
  points: readonly Vec[],
  style: InheritedStyle,
  ctx: ImportContext,
  close: boolean,
  construction = isDashed(style.dashArray),
): void {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a === undefined || b === undefined) continue;
    pushShape(ctx, { kind: 'segment', a, b }, construction);
  }
  if (close && points.length > 2) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first !== undefined && last !== undefined)
      pushShape(ctx, { kind: 'segment', a: last, b: first }, construction);
  }
}

/** 首尾闭合的折线环(矩形/椭圆) */
function pushClosedLoop(
  points: readonly Vec[],
  style: InheritedStyle,
  ctx: ImportContext,
  construction = isDashed(style.dashArray),
): void {
  pushOpenPolyline(points, style, ctx, true, construction);
}

/* ---------------------------- 属性与警告 ---------------------------- */

/** 比较小写的属性 token(display:none / visibility:hidden 等) */
function sameToken(value: string | undefined, expected: string): boolean {
  return value !== undefined && value.trim().toLowerCase() === expected;
}

/** 导出格式里的点图元是小实心圆;必须同时显式写 fill(非 none)与 stroke="none" */
function isExplicitDotCircle(attrs: Readonly<Record<string, string>>): boolean {
  const fill = attrs.fill?.trim().toLowerCase();
  const stroke = attrs.stroke?.trim().toLowerCase();
  if (fill === undefined || fill === '' || fill === 'none' || fill === 'transparent') return false;
  return stroke === 'none';
}

/** 从 points 属性里取出所有数值 token(逗号/空白分隔,支持指数与小数的连写) */
function splitNumbers(raw: string): number[] {
  const numbers: number[] = [];
  const re = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
  let match = re.exec(raw);
  while (match !== null) {
    const value = Number.parseFloat(match[0]);
    if (Number.isFinite(value)) numbers.push(value);
    match = re.exec(raw);
  }
  return numbers;
}

/** 把遍历中收集的损失汇总成用户可读的警告,顺序按严重度(截断 > 结构性损失 > 细节) */
function buildWarnings(ctx: ImportContext): string[] {
  const warnings: string[] = [];
  if (ctx.truncated) {
    // 节点上限与图元上限共用 truncated 标记,文案按哪个先到区分
    if (ctx.nodes >= IMPORT_MAX_NODES) {
      warnings.push(`SVG 结构超过 ${IMPORT_MAX_NODES} 个节点,其余内容已忽略`);
    } else {
      warnings.push(`图元数量达到上限 ${IMPORT_MAX_SHAPES},其余内容已忽略`);
    }
  }
  const skippedParts = [...ctx.skipped.entries()]
    .slice(0, IMPORT_WARN_LIMIT)
    .map(([tag, count]) => `<${tag}> ${count} 个`);
  if (skippedParts.length > 0) {
    const more = ctx.skipped.size > IMPORT_WARN_LIMIT ? ' 等' : '';
    warnings.push(`跳过 ${skippedParts.join(', ')}${more}元素:草图只支持直线/圆/圆弧/点/路径轮廓`);
  }
  if (ctx.flattenedCurves > 0) {
    warnings.push(
      `有 ${ctx.flattenedCurves} 段曲线被离散成 ${IMPORT_CURVE_SEGMENTS} 段折线,可编辑但不再是原始曲线`,
    );
  }
  if (ctx.flattenedEllipses > 0) {
    warnings.push(`有 ${ctx.flattenedEllipses} 个椭圆被离散成 ${IMPORT_ELLIPSE_SEGMENTS} 段折线`);
  }
  if (ctx.nonConformal > 0) {
    warnings.push(`有 ${ctx.nonConformal} 个圆/圆弧处于非均匀缩放下,已按近似圆导入`);
  }
  if (ctx.roundedRects > 0) warnings.push(`有 ${ctx.roundedRects} 个圆角矩形按直角矩形导入`);
  if (ctx.invalidTransforms > 0) {
    warnings.push(`有 ${ctx.invalidTransforms} 个元素的 transform 无法解析,已按无变换处理`);
  }
  if (ctx.nestedSvg > 0) warnings.push(`嵌套 <svg> 的 viewBox/坐标未换算,已按根坐标导入`);
  if (ctx.percentLengths > 0)
    warnings.push(`有 ${ctx.percentLengths} 个元素使用百分比长度,无法换算已跳过`);
  if (ctx.pointListIssues > 0)
    warnings.push(`有 ${ctx.pointListIssues} 个 points 列表坐标数为奇数,末尾坐标已忽略`);
  // 路径解析警告最多带两条,避免一条坏路径刷满状态栏
  for (const warning of ctx.pathWarnings.slice(0, 2)) warnings.push(warning);
  return warnings;
}

/* ============================ 写模型 ============================ */

/** apply 的统计结果;ui 用它拼「已导入 N 个图元」提示 */
export interface SvgImportApplied {
  /** 实际写进模型的图元数(不含退化的) */
  readonly entities: number;
  /** 新建的点数(线端点/圆心/圆弧三点按坐标复用) */
  readonly points: number;
  /** 因长度/半径过小被丢弃的图元数 */
  readonly skipped: number;
}

/**
 * 单条计划图元是否能写进模型:退化线段(长度 < MIN_DRAW_LENGTH)与退化圆/弧(半径 < MIN_RADIUS)
 * 在写入时丢弃.这个判定单独导出给 ui 做「替换前预检」--确认框不能承诺 N 个却只写进 M 个,
 * 更不能出现「计划非空但全是退化图元」时先清空旧草图,结果什么都没导入(无撤销的数据丢失).
 */
function isImportable(primitive: ImportPrimitive): boolean {
  switch (primitive.kind) {
    case 'segment':
      return (
        Math.hypot(primitive.b.x - primitive.a.x, primitive.b.y - primitive.a.y) >= MIN_DRAW_LENGTH
      );
    case 'circle':
    case 'arc':
      return primitive.radius >= MIN_RADIUS;
    case 'point':
      return true;
  }
}

/**
 * 计划里真正能写进模型的图元数(排除退化几何).
 * ui 在「替换当前草图」确认前用它:为 0 时直接报空/无效且不清模型;确认框里的 N 也用它.
 */
export function countImportableShapes(plan: SvgImportPlan): number {
  let count = 0;
  for (const shape of plan.shapes) if (isImportable(shape.primitive)) count++;
  return count;
}

/**
 * 把计划写进全局 model.调用方负责先清空/确认(本函数只追加,不做「替换」决策).
 * 按「坐标完全相同」复用点:导出的 SVG 共享端点坐标逐字节相同,因此导入后相邻线段
 * 自动共享点,可以继续加重合/水平等约束;容差内但不相等的坐标不合并,避免静默改写几何.
 */
export function applySvgImport(plan: SvgImportPlan): SvgImportApplied {
  const points = new Map<string, Point>();
  let entities = 0;
  let skipped = 0;

  const pointFor = (at: Vec): Point => {
    // +0 把 -0 归一成 0,避免同一个点因负零得到两个 key
    const key = `${at.x + 0},${at.y + 0}`;
    let point = points.get(key);
    if (point === undefined) {
      point = addPt(at.x, at.y);
      points.set(key, point);
    }
    return point;
  };

  for (const shape of plan.shapes) {
    const primitive = shape.primitive;
    if (!isImportable(primitive)) {
      skipped++;
      continue;
    }
    switch (primitive.kind) {
      case 'segment': {
        const line = addLine(pointFor(primitive.a), pointFor(primitive.b));
        line.construction = shape.construction;
        entities++;
        break;
      }
      case 'circle': {
        const circle = addCircle(pointFor(primitive.center), primitive.radius);
        circle.construction = shape.construction;
        entities++;
        break;
      }
      case 'arc': {
        const center = pointFor(primitive.center);
        const start = pointFor(primitive.start);
        // 起点与终点重合时模型按整圆处理(sweepOf 返回 TAU),复用同一个点即可
        const end = pointFor(primitive.end);
        const arc = addArc(center, start, end);
        arc.construction = shape.construction;
        entities++;
        break;
      }
      case 'point': {
        const entity = addPointEntity(pointFor(primitive.at));
        entity.construction = shape.construction;
        entities++;
        break;
      }
    }
  }

  return { entities, points: points.size, skipped };
}
