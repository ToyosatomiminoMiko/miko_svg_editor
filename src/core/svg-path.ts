/**
 * SVG 的 transform 属性与 path 数据的纯几何解析.
 *
 * 是什么:把浏览器层读到的属性字符串转成与视图,模型无关的纯数据--
 * `parseTransform` 把 transform 列表化成 2D 仿射矩阵,`parsePathData` 把 `d`
 * 化成「线段 / 圆圆弧 / 曲线离散折线」三类几何段.
 *
 * 为什么单独一层:DOMParser 只在浏览器层使用;坐标变换与路径语义是自包含数学,
 * 放在 core 里就能在 node 环境直接单测,导入功能的客户端只负责遍历元素树.
 *
 * 命令支持范围(绝对与相对):M L H V C S Q T A Z,含隐式重复参数
 *(`L` 之后可继续跟多对坐标,`M` 之后的多对坐标按 `L` / `l` 解释).
 * 语义遵循 SVG 1.1 实现说明 F.6(椭圆弧由端点参数转圆心参数),
 * 超出该范围的数据按「警告并停止」处理,已解析部分照常返回.
 *
 * 坐标约定:输出仍是 SVG 用户坐标(y 向下),不做视图翻转;
 * 矩阵采用列向量约定,详见 Matrix.
 */

import { DEG_TO_RAD, TAU } from '../config/angle';
import type { Vec } from './types';

/* ---------------- 仿射矩阵 ---------------- */

/**
 * 2D 仿射矩阵,列向量约定:x' = a*x + c*y + e,y' = b*x + d*y + f.
 *
 * 即 3x3 齐次矩阵 [a c e; b d f; 0 0 1].之所以把六个分量全部拍平进一个对象,
 * 是因为 SVG 的 matrix() 与 canvas transform 都用同一顺序,直接透传不会转置错.
 */
export interface Matrix {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

/** 单位矩阵;所有「无变换」与「解析失败」的返回值都复用它 */
export const IDENTITY_MATRIX: Matrix = Object.freeze({
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: 0,
  f: 0,
});

/**
 * 2D 仿射矩阵乘法:返回「先应用 right,再应用 left」的矩阵(left * right).
 *
 * 公式来自齐次矩阵乘法再取前两行;e/f 要额外乘 right 的平移分量,
 * 这是手写矩阵乘法最常见的漏项.顺序不能交换:变换列表里靠右的先作用到点上.
 */
export function multiplyMatrix(left: Matrix, right: Matrix): Matrix {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

/** 把矩阵作用到点上:按列向量约定算 x' / y',平移分量最后相加 */
export function applyMatrix(m: Matrix, p: Vec): Vec {
  return {
    x: m.a * p.x + m.c * p.y + m.e,
    y: m.b * p.x + m.d * p.y + m.f,
  };
}

/**
 * 矩阵行列式 a*d - b*c.
 *
 * 几何意义是有向面积缩放比:0 表示退化(压扁成线或点),
 * 符号表示是否翻转了手性(负值 = 镜像).
 */
export function matrixDeterminant(m: Matrix): number {
  return m.a * m.d - m.b * m.c;
}

/**
 * 各向同性缩放因子 sqrt(|det|).
 *
 * 均匀缩放 s 的矩阵行列式是 s²,开方还原 s;scale(2, 8) 的行列式是 16,
 * 返回 4(面积等效的正方形边长).旋转与翻转不改变它.
 */
export function matrixScale(m: Matrix): number {
  return Math.sqrt(Math.abs(matrixDeterminant(m)));
}

/** isConformal 的相对容差:列向量的模与点积都按互相乘以容差比较,量纲无关 */
const CONFORMAL_REL_TOL = 1e-9;

/**
 * 是否为「旋转 / 等比缩放 / 翻转 + 平移」的相似变换.
 *
 * 判据:矩阵的两列向量(a, b)与(c, d)正交且等长.此时任意两点距离按同一比例变化,
 * 圆仍是圆,圆弧可以安全地整体变换;错切或非等比缩放下圆会变椭圆,必须先折线化.
 * 容差取 1e-9 相对误差:既远大于三角函数与求逆的舍入误差,又远小于有意义的形变.
 * 退化矩阵(任一列长度为 0,或行列式为 0)返回 false,调用方应按不可逆处理.
 */
export function isConformal(m: Matrix): boolean {
  if (
    !Number.isFinite(m.a) ||
    !Number.isFinite(m.b) ||
    !Number.isFinite(m.c) ||
    !Number.isFinite(m.d) ||
    !Number.isFinite(m.e) ||
    !Number.isFinite(m.f)
  ) {
    return false;
  }
  const firstLength = Math.hypot(m.a, m.b);
  const secondLength = Math.hypot(m.c, m.d);
  const lengthRef = Math.max(firstLength, secondLength);
  if (lengthRef === 0) return false;
  // 两列等长(相对误差):等比缩放的充要条件之一
  if (Math.abs(firstLength - secondLength) > CONFORMAL_REL_TOL * lengthRef) return false;
  // 两列正交:点积相对两列模长的乘积应可忽略
  const dot = m.a * m.c + m.b * m.d;
  if (Math.abs(dot) > CONFORMAL_REL_TOL * firstLength * secondLength) return false;
  // 正交且等长时 |det| = 列长²,行列式为 0 只可能是退化矩阵
  return matrixDeterminant(m) !== 0;
}

/* ---------------- transform 属性解析 ---------------- */

/** transform 属性解析结果;valid=false 时 matrix 一定是 IDENTITY_MATRIX,不返回半截变换 */
export interface TransformParse {
  readonly matrix: Matrix;
  readonly valid: boolean;
}

/**
 * 按 SVG 语法匹配一个数值 token 的粘性正则.
 *
 * 粘性(y)配合 lastIndex 从当前位置原地匹配,不切片,不重建字符串;
 * 语法与 SVG 数字一致:可选符号 + 整数/小数 + 可选指数,可匹配 ".5" 与 "1.".
 */
const NUMBER_PATTERN = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;

/** SVG 允许的数值分隔符:空白或逗号(空白含换行与制表符) */
const SPACE_PATTERN = /\s/;

const isSpace = (ch: string): boolean => SPACE_PATTERN.test(ch);

/** 函数名只允许 ASCII 字母;SVG 的变换名区分大小写,这里只做词法切分 */
const LETTER_PATTERN = /[A-Za-z]/;

const isLetter = (ch: string): boolean => LETTER_PATTERN.test(ch);

/**
 * 读取变换矩阵列表时,transformOf 校验完参数个数后取第 index 个参数.
 * 调用约定:调用方已确认参数个数,且解析阶段只往数组里放有限数,
 * 所以这里可以断言 non-undefined;noUncheckedIndexedAccess 下必须显式收窄.
 */
const argumentAt = (values: readonly number[], index: number): number => values[index] as number;

/**
 * 把单个变换函数化成矩阵;名字未知或参数个数不合法返回 null.
 *
 * 各函数矩阵按 SVG 定义:
 * - matrix(a b c d e f) 直接是 [a c e; b d f];
 * - translate(tx [ty]) 是平移;
 * - scale(sx [sy]) 的 sy 缺省等于 sx;
 * - rotate(a [cx cy]) 是绕 (cx, cy) 旋转 = T(c) * R(a) * T(-c);
 * - skewX / skewY 用 tan(角度) 做错切.
 * 角度输入是度,矩阵内部用弧度,不要在这里做 y 翻转(SVG 用户坐标 y 向下).
 */
function transformOf(name: string, args: readonly number[]): Matrix | null {
  switch (name) {
    case 'matrix': {
      if (args.length !== 6) return null;
      return {
        a: argumentAt(args, 0),
        b: argumentAt(args, 1),
        c: argumentAt(args, 2),
        d: argumentAt(args, 3),
        e: argumentAt(args, 4),
        f: argumentAt(args, 5),
      };
    }
    case 'translate': {
      if (args.length !== 1 && args.length !== 2) return null;
      return {
        a: 1,
        b: 0,
        c: 0,
        d: 1,
        e: argumentAt(args, 0),
        f: args.length === 2 ? argumentAt(args, 1) : 0,
      };
    }
    case 'scale': {
      if (args.length !== 1 && args.length !== 2) return null;
      const sx = argumentAt(args, 0);
      const sy = args.length === 2 ? argumentAt(args, 1) : sx;
      return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
    }
    case 'rotate': {
      if (args.length !== 1 && args.length !== 3) return null;
      const radians = argumentAt(args, 0) * DEG_TO_RAD;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      if (args.length === 1) {
        return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
      }
      // 绕 (cx, cy) 旋转:点的旋转部分不变,平移由 cx/cy 修正到旋转中心
      const cx = argumentAt(args, 1);
      const cy = argumentAt(args, 2);
      return {
        a: cos,
        b: sin,
        c: -sin,
        d: cos,
        e: cx - cos * cx + sin * cy,
        f: cy - sin * cx - cos * cy,
      };
    }
    case 'skewX': {
      if (args.length !== 1) return null;
      return { a: 1, b: 0, c: Math.tan(argumentAt(args, 0) * DEG_TO_RAD), d: 1, e: 0, f: 0 };
    }
    case 'skewY': {
      if (args.length !== 1) return null;
      return { a: 1, b: Math.tan(argumentAt(args, 0) * DEG_TO_RAD), c: 0, d: 1, e: 0, f: 0 };
    }
    default:
      return null;
  }
}

/** 解析失败时的统一返回值:矩阵必须回到单位矩阵,否则调用方会拿到「半截变换」 */
const INVALID_TRANSFORM: TransformParse = Object.freeze({
  matrix: IDENTITY_MATRIX,
  valid: false,
});

/** 解析成功且没有任何变换时的返回值 */
const IDENTITY_TRANSFORM: TransformParse = Object.freeze({
  matrix: IDENTITY_MATRIX,
  valid: true,
});

/**
 * 解析 SVG transform 列表(空/undefined -> 单位矩阵 + valid).
 *
 * 语法是「函数名 + 括号参数」的序列,函数之间可以用空白或逗号分隔,
 * 列表按出现顺序从右往左作用到点上,所以累乘时新矩阵放右侧:
 * `translate(10 20) scale(2)` 先缩放再平移.
 * 任何一个函数名,参数个数或数字 token 不合法,整条属性返回 valid=false 且矩阵为单位矩阵;
 * 不返回「已解析的前半段」,因为变换链缺一环时几何完全错误,不如让调用方跳过该元素并提示.
 */
export function parseTransform(text: string | undefined): TransformParse {
  if (text === undefined) return IDENTITY_TRANSFORM;
  const source = text;
  const length = source.length;
  let index = 0;
  const skipSeparators = (): void => {
    while (index < length) {
      const ch = source.charAt(index);
      if (ch === ',' || isSpace(ch)) {
        index++;
        continue;
      }
      break;
    }
  };
  skipSeparators();
  // 空串或纯分隔符:视作没有变换(SVG 里空 transform 等价于缺省)
  if (index >= length) return IDENTITY_TRANSFORM;

  let matrix = IDENTITY_MATRIX;
  while (index < length) {
    skipSeparators();
    if (index >= length) break;
    // 函数名
    const nameStart = index;
    while (index < length && isLetter(source.charAt(index))) index++;
    if (index === nameStart) return INVALID_TRANSFORM;
    const name = source.slice(nameStart, index);
    // 名字与左括号之间只允许空白
    while (index < length && isSpace(source.charAt(index))) index++;
    if (source.charAt(index) !== '(') return INVALID_TRANSFORM;
    index++;
    // 参数:空白/逗号分隔的有限数,参数个数交给 transformOf 校验
    const args: number[] = [];
    for (;;) {
      while (index < length && isSpace(source.charAt(index))) index++;
      if (index >= length) return INVALID_TRANSFORM;
      const ch = source.charAt(index);
      if (ch === ')') {
        index++;
        break;
      }
      if (ch === ',') {
        // 逗号只能出现在两个参数之间,不允许开头就是逗号
        if (args.length === 0) return INVALID_TRANSFORM;
        index++;
        continue;
      }
      NUMBER_PATTERN.lastIndex = index;
      const match = NUMBER_PATTERN.exec(source);
      if (match === null) return INVALID_TRANSFORM;
      const value = Number(match[0]);
      // 指数过大时会解析成 Infinity;非有限数一律视为非法
      if (!Number.isFinite(value)) return INVALID_TRANSFORM;
      args.push(value);
      index += match[0].length;
      while (index < length && isSpace(source.charAt(index))) index++;
      if (source.charAt(index) === ',') index++;
    }
    const next = transformOf(name, args);
    if (next === null) return INVALID_TRANSFORM;
    matrix = multiplyMatrix(matrix, next);
  }
  return { matrix, valid: true };
}

/* ---------------- path 数据解析 ---------------- */

/**
 * 路径解析出的几何段,坐标仍是 SVG 用户坐标(y 向下).
 *
 * 为什么只有三类:线段的端点,圆弧的圆心/半径,折线的采样点是「导入到草图」时
 * 真正需要的全部几何信息;原命令的绝对/相对,S/T 的反射控制点等语法差异在这里已消解.
 */
export type PathSegment =
  | { readonly kind: 'line'; readonly from: Vec; readonly to: Vec }
  | {
      readonly kind: 'arc';
      readonly center: Vec;
      readonly radius: number;
      readonly start: Vec;
      readonly end: Vec;
      /** SVG 弧 sweep-flag === 1 时为 true:从 start 到 end 是正向扫角(atan2 角增大方向) */
      readonly sweepPositive: boolean;
    }
  | {
      readonly kind: 'curve';
      readonly from: Vec;
      readonly to: Vec;
      /** 离散折线:points[0] 必须等于 from,末点必须等于 to,长度 >= 2 */
      readonly points: readonly Vec[];
    };

/**
 * 曲线离散参数.
 *
 * `curveSegments` / `ellipseSegments` 是「每段曲线离散成多少条折线段」,
 * 即折线点数 = 段数 + 1;两者分开是因为贝塞尔在草图里通常只需少量折线,
 * 而椭圆弧跨度大,曲率变化快,需要更密才不显棱角.
 */
export interface PathParseOptions {
  /** 三次/二次贝塞尔每段离散出的折线段数(内部 `Math.max(1, Math.floor(...))`) */
  readonly curveSegments: number;
  /** 椭圆弧(rx != ry)每段离散出的折线段数 */
  readonly ellipseSegments: number;
}

/** path 解析结果 */
export interface PathParse {
  readonly segments: readonly PathSegment[];
  /** 被离散成折线的曲线段数(贝塞尔 + 椭圆弧,按「段」计数) */
  readonly flattened: number;
  /** 面向用户的中文警告(解析在出错命令处停止,已解析出的段仍返回) */
  readonly warnings: readonly string[];
}

/** 解析出的命令字母集合;小写表示相对坐标 */
type CommandLetter =
  | 'M'
  | 'm'
  | 'L'
  | 'l'
  | 'H'
  | 'h'
  | 'V'
  | 'v'
  | 'C'
  | 'c'
  | 'S'
  | 's'
  | 'Q'
  | 'q'
  | 'T'
  | 't'
  | 'A'
  | 'a'
  | 'Z'
  | 'z';

/** 带参数的命令(排除闭合命令 Z/z) */
type ParamCommand = Exclude<CommandLetter, 'Z' | 'z'>;

/** 词法 token:命令字母或数值 */
type PathToken = number | CommandLetter;

const PATH_COMMAND_SET = new Set<string>('MmLlHhVvCcSsQqTtAaZz');

const isCommandLetter = (ch: string): ch is CommandLetter =>
  ch.length === 1 && PATH_COMMAND_SET.has(ch);

const isParamCommand = (command: CommandLetter | null): command is ParamCommand =>
  command !== null && command !== 'Z' && command !== 'z';

/**
 * 把 `d` 切成命令字母与有限数值的 token 流,并推进索引.
 *
 * 为什么要单独一遍词法:命令语法规定参数个数随命令变化,而数字可以连写
 *(`10-5` 是 10 与 -5,`1.5.5` 是 1.5 与 .5),先统一切成 token 后,
 * 主循环只需按命令取固定个数的数值,不会为每个命令重复写「读一个数」的递归.
 * 遇到无法识别的字符或非有限数时返回已切出的前缀与中文错误说明,由主循环决定停止.
 */
function tokenizePathData(source: string): { tokens: PathToken[]; error: string | null } {
  const tokens: PathToken[] = [];
  const length = source.length;
  let index = 0;
  while (index < length) {
    const ch = source.charAt(index);
    if (ch === ',' || isSpace(ch)) {
      index++;
      continue;
    }
    if (isCommandLetter(ch)) {
      tokens.push(ch);
      index++;
      continue;
    }
    NUMBER_PATTERN.lastIndex = index;
    const match = NUMBER_PATTERN.exec(source);
    if (match === null) {
      return { tokens, error: `路径数据包含无法识别的字符 "${ch}"(偏移 ${index}),解析已停止.` };
    }
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      return {
        tokens,
        error: `路径数据包含非有限数字 "${match[0]}"(偏移 ${index}),解析已停止.`,
      };
    }
    tokens.push(value);
    index += match[0].length;
  }
  return { tokens, error: null };
}

/** 把离散段数夹到 >= 1 的整数;NaN/Infinity/0 一律按 1 处理,避免生成空折线 */
function normalizeSegmentCount(value: number): number {
  const count = Math.floor(value);
  return Number.isFinite(count) && count >= 1 ? count : 1;
}

/**
 * 三次贝塞尔离散成折线:首次与末次点直接取端点,保证 points 首尾与 from/to 精确一致.
 *
 * 采样用三次 Bernstein 基函数(权重 (1-t)³, 3(1-t)²t, 3(1-t)t², t³);
 * 端点特意不参与公式计算,避免 t=0/1 时因控制点与端点坐标相同而引入舍入差.
 */
function flattenCubic(
  from: Vec,
  control1: Vec,
  control2: Vec,
  to: Vec,
  segmentCount: number,
): Vec[] {
  const points: Vec[] = [{ x: from.x, y: from.y }];
  for (let step = 1; step < segmentCount; step++) {
    const t = step / segmentCount;
    const mt = 1 - t;
    const w0 = mt * mt * mt;
    const w1 = 3 * mt * mt * t;
    const w2 = 3 * mt * t * t;
    const w3 = t * t * t;
    points.push({
      x: w0 * from.x + w1 * control1.x + w2 * control2.x + w3 * to.x,
      y: w0 * from.y + w1 * control1.y + w2 * control2.y + w3 * to.y,
    });
  }
  points.push({ x: to.x, y: to.y });
  return points;
}

/** 二次贝塞尔离散,规则同 flattenCubic(权重 (1-t)², 2(1-t)t, t²) */
function flattenQuadratic(from: Vec, control: Vec, to: Vec, segmentCount: number): Vec[] {
  const points: Vec[] = [{ x: from.x, y: from.y }];
  for (let step = 1; step < segmentCount; step++) {
    const t = step / segmentCount;
    const mt = 1 - t;
    const w0 = mt * mt;
    const w1 = 2 * mt * t;
    const w2 = t * t;
    points.push({
      x: w0 * from.x + w1 * control.x + w2 * to.x,
      y: w0 * from.y + w1 * control.y + w2 * to.y,
    });
  }
  points.push({ x: to.x, y: to.y });
  return points;
}

/** 椭圆弧的圆心参数解:圆心,修正后的两半径,旋转角(弧度),起始参数角与有向扫角 */
interface ArcSolverResult {
  readonly center: Vec;
  readonly rx: number;
  readonly ry: number;
  readonly phi: number;
  readonly theta1: number;
  readonly deltaTheta: number;
}

/**
 * 椭圆弧端点参数 -> 圆心参数(SVG 1.1 实现说明 F.6.5).
 *
 * 输入 rx/ry 用绝对值(规范允许负半径,取绝对值仍画同一条弧),旋转角是度.
 * 核心公式:把两端点差旋转到椭圆自身坐标系,先按 F.6.5.2 在端距超过直径时
 * 把半径放大,否则根号内为负;再按 large-arc / sweep 的组合选两个圆心之一
 *(两者同号时取负号,否则取正号),最后用单位圆上的两向量叉积/点积求扫角.
 * 扫角符号由 sweep-flag 决定:正扫角是 atan2 角增大方向,输出仍是 y 向下的用户坐标.
 * 返回 null 表示端点重合等退化情况,调用方按规范忽略该弧.
 */
function solveArc(
  from: Vec,
  to: Vec,
  rxInput: number,
  ryInput: number,
  rotationDeg: number,
  largeArc: boolean,
  sweep: boolean,
): ArcSolverResult | null {
  const rx = Math.abs(rxInput);
  const ry = Math.abs(ryInput);
  if (rx === 0 || ry === 0) return null;
  const phi = (rotationDeg % 360) * DEG_TO_RAD;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  // 端点差的一半,旋转到椭圆坐标轴后以两点中点为原点
  const halfDx = (from.x - to.x) / 2;
  const halfDy = (from.y - to.y) / 2;
  const x1 = cosPhi * halfDx + sinPhi * halfDy;
  const y1 = -sinPhi * halfDx + cosPhi * halfDy;

  // F.6.5.2:端距超过直径时把两个半径同比例放大到刚好够长
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  let radiusX = rx;
  let radiusY = ry;
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    radiusX *= scale;
    radiusY *= scale;
  }
  const rxSq = radiusX * radiusX;
  const rySq = radiusY * radiusY;
  const denominator = rxSq * y1 * y1 + rySq * x1 * x1;
  let centerX = 0;
  let centerY = 0;
  if (denominator > 0) {
    const numerator = rxSq * rySq - rxSq * y1 * y1 - rySq * x1 * x1;
    const sign = largeArc === sweep ? -1 : 1;
    const factor = sign * Math.sqrt(Math.max(0, numerator / denominator));
    centerX = (factor * radiusX * y1) / radiusY;
    centerY = (-factor * radiusY * x1) / radiusX;
  }
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const center: Vec = {
    x: cosPhi * centerX - sinPhi * centerY + midX,
    y: sinPhi * centerX + cosPhi * centerY + midY,
  };
  // 起终点相对圆心的单位圆角;扫角取两向量叉积/点积,再按 sweep 定向
  const ux = (x1 - centerX) / radiusX;
  const uy = (y1 - centerY) / radiusY;
  const vx = (-x1 - centerX) / radiusX;
  const vy = (-y1 - centerY) / radiusY;
  const theta1 = Math.atan2(uy, ux);
  let deltaTheta = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  if (sweep && deltaTheta < 0) deltaTheta += TAU;
  if (!sweep && deltaTheta > 0) deltaTheta -= TAU;
  return { center, rx: radiusX, ry: radiusY, phi, theta1, deltaTheta };
}

/**
 * 椭圆弧按圆心参数化采样成折线;首末点直接取端点保证与 from/to 精确一致.
 *
 * 参数方程 p(θ) = c + R(φ) * (rx·cosθ, ry·sinθ),θ 从 theta1 走到 theta1 + deltaTheta.
 * 注意这里不能把 SVG 用户坐标的 y 向下当成数学坐标系处理--公式本身在 y 向下坐标里
 * 同样成立(只是视觉上扫角方向相反),所以直接采样即可,不要额外取负.
 */
function sampleEllipseArc(arc: ArcSolverResult, from: Vec, to: Vec, segmentCount: number): Vec[] {
  const cosPhi = Math.cos(arc.phi);
  const sinPhi = Math.sin(arc.phi);
  const points: Vec[] = [{ x: from.x, y: from.y }];
  for (let step = 1; step < segmentCount; step++) {
    const theta = arc.theta1 + (arc.deltaTheta * step) / segmentCount;
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);
    points.push({
      x: arc.center.x + arc.rx * cosTheta * cosPhi - arc.ry * sinTheta * sinPhi,
      y: arc.center.y + arc.rx * cosTheta * sinPhi + arc.ry * sinTheta * cosPhi,
    });
  }
  points.push({ x: to.x, y: to.y });
  return points;
}

/**
 * 圆与椭圆的分界:半径差在最大半径的 1e-9 相对量以内视为圆.
 *
 * 圆不需要旋转角,而且草图里「圆/圆弧的圆心 + 半径」是精确图元,比折线好得多;
 * 椭圆(哪怕只扁一点点)在草图里没有对应图元,只能离散.
 */
const CIRCLE_RADIUS_REL_TOL = 1e-9;

/**
 * 解析 SVG path 的 `d` 字符串.
 *
 * 输出三类段:直线,圆圆弧,曲线折线(贝塞尔与椭圆弧都折线化,并通过 flattened 计数).
 * 语义要点:
 * - 隐式重复:`M` 之后的多对坐标按 lineto 处理(相对 `m` 则按 `l`),其余命令可连续跟多组参数;
 * - `Z` 追加一条「当前点 -> 子路径起点」的线段,允许零长度(消费方自行过滤);
 * - S/T 的反射控制点用上一条同类曲线的控制点关于当前点镜像,上一条不是同类曲线时取当前点;
 * - `A` 在起终点重合时不产生段,rx/ry 为 0 时退化成直线,圆用精确圆心/半径表达,
 *   椭圆按参数方程离散;端点距超过直径时按规范放大半径;
 * - 任何语法或数值错误都在出错命令处停止,已解析出的段照常返回,并附中文警告.
 * 空串/undefined 返回空结果且没有警告.
 */
export function parsePathData(d: string | undefined, options: PathParseOptions): PathParse {
  const curveSegments = normalizeSegmentCount(options.curveSegments);
  const ellipseSegments = normalizeSegmentCount(options.ellipseSegments);
  if (d === undefined) return { segments: [], flattened: 0, warnings: [] };

  const { tokens, error } = tokenizePathData(d);
  const segments: PathSegment[] = [];
  const warnings: string[] = [];
  let flattened = 0;

  // 当前点,当前子路径起点(SVG 用户坐标)与上一条同类曲线的控制点(绝对坐标)
  let current: Vec = { x: 0, y: 0 };
  let subpathStart: Vec = { x: 0, y: 0 };
  let lastCubicControl: Vec | null = null;
  let lastQuadControl: Vec | null = null;
  let index = 0;
  let command: CommandLetter | null = null;

  /**
   * 读 count 个连续数值并推进索引;不足或中途遇到命令字母时返回 null(不推进).
   * 一次读全一组参数,是为了让「参数不完整」只有一种处理:停止解析.
   */
  const readArgs = (count: number): readonly number[] | null => {
    if (index + count > tokens.length) return null;
    const values: number[] = [];
    for (let offset = 0; offset < count; offset++) {
      const token = tokens[index + offset];
      if (typeof token !== 'number') return null;
      values.push(token);
    }
    index += count;
    return values;
  };

  /** 相对/绝对坐标统一解析成绝对点 */
  const resolvePoint = (relative: boolean, x: number, y: number): Vec =>
    relative ? { x: current.x + x, y: current.y + y } : { x, y };

  /** 参数缺失的统一警告;返回 false 便于在命令分支里直接 `return missingArgs(...)` */
  const missingArgs = (cmd: string, count: number): false => {
    warnings.push(`"${cmd}" 命令缺少 ${count} 个参数(或中途遇到其它命令),解析已停止.`);
    return false;
  };

  /** 追加圆弧:A 的语义分支集中在这里,主循环只负责取参数 */
  const appendArc = (
    from: Vec,
    to: Vec,
    rxInput: number,
    ryInput: number,
    rotationDeg: number,
    largeArc: boolean,
    sweep: boolean,
  ): void => {
    // 起终点重合:规范要求忽略这段弧,不产生任何几何
    if (from.x === to.x && from.y === to.y) return;
    const rx = Math.abs(rxInput);
    const ry = Math.abs(ryInput);
    // 半径为 0:规范要求退化成起终点之间的直线
    if (rx === 0 || ry === 0) {
      segments.push({ kind: 'line', from, to });
      return;
    }
    const radiusRef = Math.max(rx, ry);
    if (Math.abs(rx - ry) <= CIRCLE_RADIUS_REL_TOL * radiusRef) {
      // 圆:输出精确圆心与半径;半径可能因端距过长被放大,取解算后的 rx
      const solved = solveArc(from, to, rx, rx, rotationDeg, largeArc, sweep);
      if (solved === null) return;
      segments.push({
        kind: 'arc',
        center: solved.center,
        radius: solved.rx,
        start: from,
        end: to,
        sweepPositive: sweep,
      });
      return;
    }
    const solved = solveArc(from, to, rx, ry, rotationDeg, largeArc, sweep);
    if (solved === null) return;
    segments.push({
      kind: 'curve',
      from,
      to,
      points: sampleEllipseArc(solved, from, to, ellipseSegments),
    });
    flattened++;
  };

  /**
   * 执行一条带参数的命令;失败时写警告并返回 false.
   * 约定:进入时 index 指向该命令的第一个参数 token.
   */
  const runCommand = (cmd: ParamCommand): boolean => {
    switch (cmd) {
      case 'M':
      case 'm': {
        const args = readArgs(2);
        if (args === null) return missingArgs(cmd, 2);
        current = resolvePoint(cmd === 'm', argumentAt(args, 0), argumentAt(args, 1));
        subpathStart = { x: current.x, y: current.y };
        lastCubicControl = null;
        lastQuadControl = null;
        // 隐式重复:第一对坐标之后的数值按 lineto 解释(规范规定)
        command = cmd === 'm' ? 'l' : 'L';
        return true;
      }
      case 'L':
      case 'l': {
        const args = readArgs(2);
        if (args === null) return missingArgs(cmd, 2);
        const to = resolvePoint(cmd === 'l', argumentAt(args, 0), argumentAt(args, 1));
        segments.push({ kind: 'line', from: current, to });
        current = to;
        lastCubicControl = null;
        lastQuadControl = null;
        return true;
      }
      case 'H':
      case 'h': {
        const args = readArgs(1);
        if (args === null) return missingArgs(cmd, 1);
        const x = cmd === 'h' ? current.x + argumentAt(args, 0) : argumentAt(args, 0);
        const to = { x, y: current.y };
        segments.push({ kind: 'line', from: current, to });
        current = to;
        lastCubicControl = null;
        lastQuadControl = null;
        return true;
      }
      case 'V':
      case 'v': {
        const args = readArgs(1);
        if (args === null) return missingArgs(cmd, 1);
        const y = cmd === 'v' ? current.y + argumentAt(args, 0) : argumentAt(args, 0);
        const to = { x: current.x, y };
        segments.push({ kind: 'line', from: current, to });
        current = to;
        lastCubicControl = null;
        lastQuadControl = null;
        return true;
      }
      case 'C':
      case 'c': {
        const args = readArgs(6);
        if (args === null) return missingArgs(cmd, 6);
        const relative = cmd === 'c';
        const control1 = resolvePoint(relative, argumentAt(args, 0), argumentAt(args, 1));
        const control2 = resolvePoint(relative, argumentAt(args, 2), argumentAt(args, 3));
        const to = resolvePoint(relative, argumentAt(args, 4), argumentAt(args, 5));
        segments.push({
          kind: 'curve',
          from: current,
          to,
          points: flattenCubic(current, control1, control2, to, curveSegments),
        });
        flattened++;
        lastCubicControl = control2;
        lastQuadControl = null;
        current = to;
        return true;
      }
      case 'S':
      case 's': {
        const args = readArgs(4);
        if (args === null) return missingArgs(cmd, 4);
        const relative = cmd === 's';
        // 反射控制点:上一条是三次曲线时用其第二控制点关于当前点镜像,否则取当前点
        const control1: Vec =
          lastCubicControl === null
            ? { x: current.x, y: current.y }
            : {
                x: 2 * current.x - lastCubicControl.x,
                y: 2 * current.y - lastCubicControl.y,
              };
        const control2 = resolvePoint(relative, argumentAt(args, 0), argumentAt(args, 1));
        const to = resolvePoint(relative, argumentAt(args, 2), argumentAt(args, 3));
        segments.push({
          kind: 'curve',
          from: current,
          to,
          points: flattenCubic(current, control1, control2, to, curveSegments),
        });
        flattened++;
        lastCubicControl = control2;
        lastQuadControl = null;
        current = to;
        return true;
      }
      case 'Q':
      case 'q': {
        const args = readArgs(4);
        if (args === null) return missingArgs(cmd, 4);
        const relative = cmd === 'q';
        const control = resolvePoint(relative, argumentAt(args, 0), argumentAt(args, 1));
        const to = resolvePoint(relative, argumentAt(args, 2), argumentAt(args, 3));
        segments.push({
          kind: 'curve',
          from: current,
          to,
          points: flattenQuadratic(current, control, to, curveSegments),
        });
        flattened++;
        lastCubicControl = null;
        lastQuadControl = control;
        current = to;
        return true;
      }
      case 'T':
      case 't': {
        const args = readArgs(2);
        if (args === null) return missingArgs(cmd, 2);
        const relative = cmd === 't';
        // 二次曲线的反射控制点,规则与 S 相同但作用在二次控制点上
        const control: Vec =
          lastQuadControl === null
            ? { x: current.x, y: current.y }
            : {
                x: 2 * current.x - lastQuadControl.x,
                y: 2 * current.y - lastQuadControl.y,
              };
        const to = resolvePoint(relative, argumentAt(args, 0), argumentAt(args, 1));
        segments.push({
          kind: 'curve',
          from: current,
          to,
          points: flattenQuadratic(current, control, to, curveSegments),
        });
        flattened++;
        lastCubicControl = null;
        lastQuadControl = control;
        current = to;
        return true;
      }
      case 'A':
      case 'a': {
        const args = readArgs(7);
        if (args === null) return missingArgs(cmd, 7);
        const rx = argumentAt(args, 0);
        const ry = argumentAt(args, 1);
        const rotation = argumentAt(args, 2);
        const largeArcFlag = argumentAt(args, 3);
        const sweepFlag = argumentAt(args, 4);
        // 两个 flag 按规范只有 0/1 两种取值,其它数值视为语法错误而不是静默取非零
        if (largeArcFlag !== 0 && largeArcFlag !== 1) {
          warnings.push(`"A" 命令的 large-arc-flag 只能为 0 或 1,解析已停止.`);
          return false;
        }
        if (sweepFlag !== 0 && sweepFlag !== 1) {
          warnings.push(`"A" 命令的 sweep-flag 只能为 0 或 1,解析已停止.`);
          return false;
        }
        const to = resolvePoint(cmd === 'a', argumentAt(args, 5), argumentAt(args, 6));
        const from = { x: current.x, y: current.y };
        current = to;
        lastCubicControl = null;
        lastQuadControl = null;
        appendArc(from, to, rx, ry, rotation, largeArcFlag === 1, sweepFlag === 1);
        return true;
      }
    }
  };

  while (index < tokens.length) {
    const token: PathToken | undefined = tokens[index];
    // 循环条件已保证 index 在范围内;显式收窄是为了 noUncheckedIndexedAccess 下的类型安全
    if (token === undefined) break;
    if (typeof token === 'number') {
      // 隐式重复:沿用上一条命令;没有上一条命令(或上一条是 Z)说明数字没有归属
      if (!isParamCommand(command)) {
        warnings.push(`数字 ${token} 前缺少命令字母,解析已停止.`);
        break;
      }
      if (!runCommand(command)) break;
      continue;
    }
    command = token;
    index++;
    if (command === 'Z' || command === 'z') {
      // 闭合:从当前点连线回子路径起点(允许零长度),当前点回到起点
      segments.push({ kind: 'line', from: current, to: subpathStart });
      current = { x: subpathStart.x, y: subpathStart.y };
      lastCubicControl = null;
      lastQuadControl = null;
      command = null;
      continue;
    }
    if (!runCommand(command)) break;
  }

  // 词法错误发生在 token 流末尾,追加在解析警告之后,保持时间顺序
  if (error !== null) warnings.push(error);
  return { segments, flattened, warnings };
}
