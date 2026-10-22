/**
 * 约束求解器：LM（Levenberg–Marquardt）+ 数值雅可比，原地修改 model 里的参数。
 * 自由度 = 未 fixed 且不在 exclude 集合里的点的 x,y + 圆/圆弧的 r。
 * 圆弧的 a0/a1 不进入任何残差，因此不是自由度（BUG-14）；r 的 setter 钳制到 >= 0。
 *
 * 残差评估遇到无效约束（引用悬空/种类不符/数值缺失，或残差抛错/非有限）时，
 * 把约束 id 记入 invalidConstraints 并把该条残差按 0 计入，保证后续迭代仍可跑；
 * 调用方据此提示「有约束无法求解」，而不是静默当成已满足（BUG-5）。
 */

import {
  CONVERGE_EPS,
  ITER_FULL,
  JACOBIAN_STEP,
  LAMBDA_DECAY,
  LAMBDA_GROW,
  LAMBDA_INIT,
  LAMBDA_MIN,
  PIVOT_EPS,
  RETRY_LIMIT,
} from './config';
import { RESID, isConstraintRefsValid } from './constraints';
import { assertNever } from './entities';
import { model } from './model';

interface Param {
  get: () => number;
  set: (v: number) => void;
}

export interface SolveResult {
  /** 残差平方和；converged 为 residual <= CONVERGE_EPS */
  residual: number;
  converged: boolean;
  /** 无法求解的约束 id（引用无效或残差非有限），调用方应提示用户 */
  invalidConstraints: number[];
}

/**
 * 读取按下标访问的元素，集中处理 noUncheckedIndexedAccess。
 * 求解器里所有下标都由循环上界 / 矩阵阶数 n / 数组长度保证落在长度内
 * （例如 `i < n`、`k < n`、`a < n`，且矩阵是 n×n、向量是长度 n），
 * 逐处写 `?? 0` 反而会掩盖真正的越界 bug，所以把「下标有效」这个不变量集中在这里断言。
 */
const at = <T>(arr: ArrayLike<T>, i: number): T => arr[i]!;

/** 原地累加（`arr[i] += v` 的安全写法）：读改写都走 at，不变量同 at */
const addAt = (arr: Float64Array, i: number, v: number): void => {
  arr[i] = at(arr, i) + v;
};

/** 组装自由度向量；exclude 用于拖拽时临时排除被拖的点（不再写进模型） */
function buildParams(excludedPointIds?: ReadonlySet<number>): Param[] {
  const ps: Param[] = [];
  for (const p of model.pts.values()) {
    if (p.fixed || excludedPointIds?.has(p.id)) continue;
    ps.push({
      get: () => p.x,
      set: (v) => {
        p.x = v;
      },
    });
    ps.push({
      get: () => p.y,
      set: (v) => {
        p.y = v;
      },
    });
  }
  for (const e of model.ents.values()) {
    switch (e.type) {
      case 'line':
      case 'point':
        // 直线/点图元没有独立参数：坐标都在 model.pts 里，已经作为自由度加入
        break;
      case 'circle':
      case 'arc':
        ps.push({
          get: () => e.r,
          set: (v) => {
            e.r = Math.max(0, v);
          },
        });
        break;
      default:
        assertNever(e);
    }
  }
  return ps;
}

/** 逐条评估残差；无效约束记入 invalid 并把它的残差按 0 计入（这里直接跳过） */
function evalResiduals(invalid: Set<number>): number[] {
  const out: number[] = [];
  for (const c of model.cons.values()) {
    if (!isConstraintRefsValid(c)) {
      invalid.add(c.id);
      continue;
    }
    let r: number[];
    try {
      r = RESID[c.type](c);
    } catch {
      invalid.add(c.id);
      continue;
    }
    let finite = true;
    for (const v of r) {
      if (!Number.isFinite(v)) {
        finite = false;
        break;
      }
    }
    if (!finite) {
      invalid.add(c.id);
      continue;
    }
    for (const v of r) out.push(v);
  }
  return out;
}

const sumSquares = (r: readonly number[]): number => {
  let err = 0;
  for (const v of r) err += v * v;
  return err;
};

/** 高斯消元（部分主元），A 为 row-major n×n，返回解或 null */
function gauss(matrix: Float64Array, b: Float64Array, n: number): Float64Array | null {
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(at(matrix, k * n + i)) > Math.abs(at(matrix, piv * n + i))) piv = k;
    }
    if (Math.abs(at(matrix, piv * n + i)) < PIVOT_EPS) return null;
    if (piv !== i) {
      for (let j = 0; j < n; j++) {
        const t = at(matrix, i * n + j);
        matrix[i * n + j] = at(matrix, piv * n + j);
        matrix[piv * n + j] = t;
      }
      const t = at(b, i);
      b[i] = at(b, piv);
      b[piv] = t;
    }
    const d = at(matrix, i * n + i);
    for (let k = i + 1; k < n; k++) {
      const f = at(matrix, k * n + i) / d;
      if (!f) continue;
      for (let j = i; j < n; j++) addAt(matrix, k * n + j, -f * at(matrix, i * n + j));
      addAt(b, k, -f * at(b, i));
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = at(b, i);
    for (let j = i + 1; j < n; j++) s -= at(matrix, i * n + j) * at(x, j);
    x[i] = s / at(matrix, i * n + i);
  }
  return x;
}

/**
 * 求解整个草图。
 * @param maxIter 迭代上限；拖拽时给小值保证流畅（见 config/solver 的 ITER_*）
 * @param excludedPointIds 本次求解不参与的点（拖拽中的点），不写进模型
 */
export function solveSketch(
  maxIter = ITER_FULL,
  excludedPointIds?: ReadonlySet<number>,
): SolveResult {
  const invalid = new Set<number>();
  const params = buildParams(excludedPointIds);
  const n = params.length;

  // 没有自由度时参数位置为空，但仍要评估残差，才能报告「约束已满足 / 无效约束」
  if (n === 0) {
    const residual = sumSquares(evalResiduals(invalid));
    return { residual, converged: residual <= CONVERGE_EPS, invalidConstraints: [...invalid] };
  }

  const write = (v: Float64Array): void => {
    for (let i = 0; i < n; i++) at(params, i).set(at(v, i));
  };

  let q = new Float64Array(n);
  for (let i = 0; i < n; i++) q[i] = at(params, i).get();

  let r = evalResiduals(invalid);
  let err = sumSquares(r);
  let lambda = LAMBDA_INIT;

  for (let it = 0; it < maxIter && err > CONVERGE_EPS; it++) {
    const m = r.length;
    if (m === 0) break;

    /* 数值雅可比 (m x n, row-major) */
    const J = new Float64Array(m * n);
    const base = Float64Array.from(q);
    for (let j = 0; j < n; j++) {
      const h = JACOBIAN_STEP * Math.max(1, Math.abs(at(base, j)));
      addAt(base, j, h);
      write(base);
      // 残差条数在一次求解内保持稳定，rp 比 r 短只可能是无效约束集合变化；
      // 那时按 0 计，与 evalResiduals 的「跳过无效约束」语义保持一致
      const rp = evalResiduals(invalid);
      addAt(base, j, -h);
      for (let i = 0; i < m; i++) J[i * n + j] = ((rp[i] ?? 0) - at(r, i)) / h;
    }
    write(base);

    /* 正规方程 JᵀJ · δ = -Jᵀr，只算上三角再对称 */
    const normal = new Float64Array(n * n);
    const g = new Float64Array(n);
    for (let i = 0; i < m; i++) {
      const ri = at(r, i);
      const off = i * n;
      for (let a = 0; a < n; a++) {
        const ja = at(J, off + a);
        if (ja === 0) continue;
        addAt(g, a, ja * ri);
        for (let b = a; b < n; b++) addAt(normal, a * n + b, ja * at(J, off + b));
      }
    }
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < a; b++) normal[a * n + b] = at(normal, b * n + a);
    }

    /* 阻尼试探：成功则接受并减小 λ，失败则增大 λ 重试 */
    let improved = false;
    for (let t = 0; t < RETRY_LIMIT; t++) {
      const damped = Float64Array.from(normal);
      for (let a = 0; a < n; a++) addAt(damped, a * n + a, lambda * (1 + at(normal, a * n + a)));
      const rhs = new Float64Array(n);
      for (let a = 0; a < n; a++) rhs[a] = -at(g, a);
      const dx = gauss(damped, rhs, n);
      if (!dx) break;

      const trial = new Float64Array(n);
      for (let a = 0; a < n; a++) trial[a] = at(base, a) + at(dx, a);
      write(trial);
      const rt = evalResiduals(invalid);
      const et = sumSquares(rt);

      if (et < err) {
        err = et;
        r = rt;
        // setter 可能钳制参数（半径 >= 0），回读实际值作为下一轮基向量
        q = new Float64Array(n);
        for (let a = 0; a < n; a++) q[a] = at(params, a).get();
        lambda = Math.max(lambda * LAMBDA_DECAY, LAMBDA_MIN);
        improved = true;
        break;
      }
      lambda *= LAMBDA_GROW;
    }
    if (!improved) break;
  }
  write(q);
  return { residual: err, converged: err <= CONVERGE_EPS, invalidConstraints: [...invalid] };
}
