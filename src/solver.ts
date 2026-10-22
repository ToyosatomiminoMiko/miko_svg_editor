/**
 * 约束求解器：LM（Levenberg–Marquardt）+ 数值雅可比。
 * 自由度 = 未固定/未拖拽的点的 x,y + 圆的 r + 圆弧的 r,a0,a1。
 */

import { RESID } from './constraints';
import { model } from './model';

interface Param {
  get: () => number;
  set: (v: number) => void;
}

/** 组装当前自由度向量（fixed / dragging 的点不参与求解） */
function buildParams(): Param[] {
  const ps: Param[] = [];
  for (const p of model.pts.values()) {
    if (p.fixed || p.dragging) continue;
    ps.push({ get: () => p.x, set: (v) => { p.x = v; } });
    ps.push({ get: () => p.y, set: (v) => { p.y = v; } });
  }
  for (const e of model.ents.values()) {
    if (e.type === 'circle') {
      ps.push({ get: () => e.r, set: (v) => { e.r = v; } });
    } else if (e.type === 'arc') {
      ps.push({ get: () => e.r, set: (v) => { e.r = v; } });
      ps.push({ get: () => e.a0, set: (v) => { e.a0 = v; } });
      ps.push({ get: () => e.a1, set: (v) => { e.a1 = v; } });
    }
  }
  return ps;
}

function evalResiduals(): number[] {
  const out: number[] = [];
  for (const c of model.cons.values()) {
    const f = RESID[c.type];
    if (!f) continue;
    let r: number[];
    try {
      r = f(c);
    } catch {
      r = [];
    }
    for (let i = 0; i < r.length; i++) out.push(Number.isFinite(r[i]) ? r[i] : 0);
  }
  return out;
}

/** 高斯消元（部分主元），A 为 row-major n×n，返回解或 null */
function gauss(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(A[k * n + i]) > Math.abs(A[piv * n + i])) piv = k;
    }
    if (Math.abs(A[piv * n + i]) < 1e-15) return null;
    if (piv !== i) {
      for (let j = 0; j < n; j++) {
        const t = A[i * n + j];
        A[i * n + j] = A[piv * n + j];
        A[piv * n + j] = t;
      }
      const t = b[i];
      b[i] = b[piv];
      b[piv] = t;
    }
    const d = A[i * n + i];
    for (let k = i + 1; k < n; k++) {
      const f = A[k * n + i] / d;
      if (!f) continue;
      for (let j = i; j < n; j++) A[k * n + j] -= f * A[i * n + j];
      b[k] -= f * b[i];
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= A[i * n + j] * x[j];
    x[i] = s / A[i * n + i];
  }
  return x;
}

/**
 * 求解整个草图。
 * @param maxIter 迭代上限；拖拽时给小一点保证流畅
 * @returns 最终残差平方和
 */
export function solveSketch(maxIter = 80): number {
  const params = buildParams();
  const n = params.length;
  if (n === 0) return 0;

  const write = (v: Float64Array): void => {
    for (let i = 0; i < n; i++) params[i].set(v[i]);
  };

  let q = new Float64Array(n);
  for (let i = 0; i < n; i++) q[i] = params[i].get();

  let r = evalResiduals();
  let err = 0;
  for (const v of r) err += v * v;
  let lambda = 1e-4;

  for (let it = 0; it < maxIter && err > 1e-13; it++) {
    const m = r.length;
    if (m === 0) break;

    /* 数值雅可比 (m x n, row-major) */
    const J = new Float64Array(m * n);
    const base = Float64Array.from(q);
    for (let j = 0; j < n; j++) {
      const h = 1e-7 * Math.max(1, Math.abs(base[j]));
      base[j] += h;
      write(base);
      const rp = evalResiduals();
      base[j] -= h;
      for (let i = 0; i < m; i++) J[i * n + j] = (rp[i] - r[i]) / h;
    }
    write(base);

    /* 正规方程 JᵀJ · δ = -Jᵀr，只算上三角再对称 */
    const A = new Float64Array(n * n);
    const g = new Float64Array(n);
    for (let i = 0; i < m; i++) {
      const ri = r[i];
      const off = i * n;
      for (let a = 0; a < n; a++) {
        const Ja = J[off + a];
        if (Ja === 0) continue;
        g[a] += Ja * ri;
        for (let b = a; b < n; b++) A[a * n + b] += Ja * J[off + b];
      }
    }
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < a; b++) A[a * n + b] = A[b * n + a];
    }

    /* 阻尼试探：成功则接受并减小 λ，失败则增大 λ 重试 */
    let improved = false;
    for (let t = 0; t < 10; t++) {
      const Ad = Float64Array.from(A);
      for (let a = 0; a < n; a++) Ad[a * n + a] += lambda * (1 + A[a * n + a]);
      const rhs = new Float64Array(n);
      for (let a = 0; a < n; a++) rhs[a] = -g[a];
      const dx = gauss(Ad, rhs, n);
      if (!dx) break;

      const trial = new Float64Array(n);
      for (let a = 0; a < n; a++) trial[a] = base[a] + dx[a];
      write(trial);
      const rt = evalResiduals();
      let et = 0;
      for (const v of rt) et += v * v;

      if (et < err) {
        err = et;
        r = rt;
        q = trial;
        lambda = Math.max(lambda * 0.25, 1e-12);
        improved = true;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  write(q);
  return err;
}
