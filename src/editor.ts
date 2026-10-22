/**
 * 编辑器控制器：工具状态机、指针/键盘输入、约束按钮动作、视图操作。
 * 渲染交给 Renderer，拾取/吸附在 geometry.ts，求解在 solver.ts。
 */

import { cam, s2w, zoomAt } from './camera';
import { exportSVG as downloadSVG } from './export-svg';
import {
  computeSnap,
  entityCrossesRect,
  entityInsideRect,
  pickEntity,
  pickPoint,
  pointInRect,
  rectOf,
} from './geometry';
import {
  E,
  P,
  addArc,
  addCircle,
  addCon,
  addLine,
  addPt,
  clearModel,
  ends,
  model,
  modelBounds,
  removeEntity,
  removePoint,
} from './model';
import { Renderer } from './renderer';
import { solveSketch } from './solver';
import { state } from './state';
import { TOOLS, type ConstraintAction } from './tools';
import type { ToolbarHandle, ToolbarHandlers } from './toolbar';
import type { Entity, Point, Snap, ToolId, Vec } from './types';
import { vec } from './vec';

interface DragState {
  items: { p: Point; ox: number; oy: number }[];
  sx: number;
  sy: number;
}

interface PanState {
  sx: number;
  sy: number;
  cx: number;
  cy: number;
  moved: boolean;
}

export class Editor implements ToolbarHandlers {
  private readonly canvas: HTMLCanvasElement;
  private readonly hint: HTMLElement;
  private readonly renderer: Renderer;
  private toolbar: ToolbarHandle | null = null;
  private drag: DragState | null = null;
  private pan: PanState | null = null;
  /** 最近一次指针的屏幕坐标 */
  private lastS: Vec = { x: 0, y: 0 };
  /** 框选起点（屏幕坐标）；非空表示正在准备/进行框选 */
  private marqueeStartS: Vec | null = null;
  private marqueeActive = false;
  private marqueeAdd = false;

  constructor(canvas: HTMLCanvasElement, hint: HTMLElement) {
    this.canvas = canvas;
    this.hint = hint;
    this.renderer = new Renderer(canvas);
    this.attachEvents();
    window.addEventListener('resize', () => this.renderer.resize());
    this.renderer.resize();
  }

  /** 工具栏构建完成后回填引用，并设置默认工具 */
  bindToolbar(toolbar: ToolbarHandle): void {
    this.toolbar = toolbar;
    toolbar.setSnap(state.snapEnabled);
    this.setTool('select');
  }

  /* ======================= 工具栏动作 ======================= */

  setTool(id: ToolId): void {
    state.tool = id;
    state.pending = null;
    state.snap = null;
    this.resetMarquee();
    if (id !== 'select') state.sel = [];
    this.toolbar?.setActive(id);
    this.canvas.classList.toggle('is-drawing', id !== 'select');
    this.refreshHint();
    this.render();
  }

  /** 吸附总开关：关掉后不再吸附到点/中点/曲线/网格 */
  toggleSnap(): void {
    state.snapEnabled = !state.snapEnabled;
    if (!state.snapEnabled) state.snap = null;
    this.toolbar?.setSnap(state.snapEnabled);
    this.refreshHint();
    this.render();
  }

  applyConstraint(kind: ConstraintAction): void {
    const sel = state.sel
      .map((id) => E(id))
      .filter((e): e is Entity => Boolean(e));
    if (sel.length === 0) return;

    if (kind === 'horizontal' || kind === 'vertical') {
      for (const e of sel) if (e.type === 'line') addCon(kind, { e: e.id });
    } else if (kind === 'parallel' || kind === 'perpendicular' || kind === 'equalLength') {
      if (sel.length === 2) addCon(kind, { e1: sel[0].id, e2: sel[1].id });
    } else if (kind === 'concentric' || kind === 'equalRadius') {
      if (sel.length === 2 && sel[0].type !== 'line' && sel[1].type !== 'line') {
        addCon(kind, { e1: sel[0].id, e2: sel[1].id });
      }
    } else if (kind === 'tangent') {
      const line = sel.find((e) => e.type === 'line');
      const curved = sel.filter((e) => e.type !== 'line');
      if (sel.length === 2) {
        if (line && curved.length === 1) {
          addCon('tangentLC', { line: line.id, circ: curved[0].id });
        } else if (curved.length === 2) {
          addCon('tangentCC', { e1: curved[0].id, e2: curved[1].id });
        }
      }
    }

    solveSketch(120);
    this.render();
  }

  toggleFixed(): void {
    const ids = new Set<number>();
    for (const id of state.sel) {
      const e = E(id);
      if (e) {
        if (e.type === 'line') {
          const [a, b] = ends(e);
          ids.add(a.id);
          ids.add(b.id);
        } else {
          ids.add(e.c);
        }
      } else if (P(id)) {
        ids.add(id);
      }
    }
    const pts = [...ids]
      .map((id) => P(id))
      .filter((p): p is Point => Boolean(p));
    if (pts.length === 0) {
      window.alert('先选中图形或点');
      return;
    }
    // 有的没锁 → 全锁；全锁 → 全解锁
    const toFix = !pts.every((p) => p.fixed);
    for (const p of pts) p.fixed = toFix;
    solveSketch(80);
    this.render();
  }

  fitView(): void {
    const bb = modelBounds(0.1);
    if (!bb) {
      cam.x = 0;
      cam.y = 0;
      cam.z = 1;
    } else {
      cam.z = Math.max(0.02, Math.min(80, Math.min(cam.W / bb.bw, cam.H / bb.bh) * 0.9));
      cam.x = (bb.minx + bb.maxx) / 2;
      cam.y = (bb.miny + bb.maxy) / 2;
    }
    this.render();
  }

  exportSVG(): void {
    downloadSVG();
  }

  clearAll(): void {
    // 只删图元后可能剩下孤立点，所以以点为准判断是否为空
    if (model.pts.size === 0) return;
    if (!window.confirm('清空整张草图？')) return;
    clearModel();
    state.sel = [];
    state.pending = null;
    state.snap = null;
    state.hoverPt = null;
    state.hoverEnt = null;
    this.resetMarquee();
    this.refreshHint();
    this.render();
  }

  /** 底部提示 = 当前工具说明 + 选中数量 + 吸附状态 */
  private refreshHint(): void {
    const tool = TOOLS.find((t) => t.id === state.tool);
    const parts: string[] = [];
    if (tool) parts.push(tool.hint);

    let ents = 0;
    let pts = 0;
    for (const id of state.sel) {
      if (E(id)) ents++;
      else if (P(id)) pts++;
    }
    if (ents > 0 && pts > 0) parts.push(`已选 ${ents} 图元 + ${pts} 点`);
    else if (ents > 0) parts.push(`已选 ${ents} 个图元`);
    else if (pts > 0) parts.push(`已选 ${pts} 个点`);

    if (!state.snapEnabled) parts.push('吸附已关');
    this.hint.textContent = parts.join(' · ');
  }

  /* ======================= 事件 ======================= */

  private attachEvents(): void {
    this.canvas.addEventListener('pointerdown', (ev) => this.onPointerDown(ev));
    this.canvas.addEventListener('pointermove', (ev) => this.onPointerMove(ev));
    this.canvas.addEventListener('pointerup', (ev) => this.onPointerUp(ev));
    this.canvas.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        const r = this.canvas.getBoundingClientRect();
        zoomAt({ x: ev.clientX - r.left, y: ev.clientY - r.top }, Math.exp(-ev.deltaY * 0.0015));
        this.render();
      },
      { passive: false },
    );
    this.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
    window.addEventListener('keydown', (ev) => this.onKeyDown(ev));
  }

  private updateMouse(ev: PointerEvent): Vec {
    const r = this.canvas.getBoundingClientRect();
    const sp = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    this.lastS = sp;
    state.cursorW = s2w(sp);
    return sp;
  }

  private onPointerDown(ev: PointerEvent): void {
    this.canvas.setPointerCapture(ev.pointerId);
    const sp = this.updateMouse(ev);

    if (ev.button === 1 || ev.button === 2) {
      this.pan = { sx: sp.x, sy: sp.y, cx: cam.x, cy: cam.y, moved: false };
      return;
    }
    if (ev.button === 0) this.handleClick(state.cursorW, ev.shiftKey);
  }

  private onPointerMove(ev: PointerEvent): void {
    const sp = this.updateMouse(ev);

    if (this.pan) {
      const dx = sp.x - this.pan.sx;
      const dy = sp.y - this.pan.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.pan.moved = true;
      cam.x = this.pan.cx - dx / cam.z;
      cam.y = this.pan.cy - dy / cam.z;
      this.render();
      return;
    }

    if (this.drag) {
      const dx = state.cursorW.x - this.drag.sx;
      const dy = state.cursorW.y - this.drag.sy;
      for (const it of this.drag.items) {
        it.p.x = it.ox + dx;
        it.p.y = it.oy + dy;
      }
      solveSketch(15);
      this.render();
      return;
    }

    if (this.marqueeStartS) {
      const dx = sp.x - this.marqueeStartS.x;
      const dy = sp.y - this.marqueeStartS.y;
      if (!this.marqueeActive && Math.hypot(dx, dy) > 3) this.marqueeActive = true;
      if (this.marqueeActive) {
        state.marquee = { a: s2w(this.marqueeStartS), b: state.cursorW };
        this.render();
        return;
      }
    }

    state.snap = state.snapEnabled ? computeSnap(state.cursorW) : null;
    state.hoverPt = pickPoint(state.cursorW);
    state.hoverEnt = state.hoverPt ? null : pickEntity(state.cursorW);
    this.render();
  }

  private onPointerUp(ev: PointerEvent): void {
    if (this.pan) {
      const wasMoved = this.pan.moved;
      this.pan = null;
      if (ev.button === 2 && !wasMoved) this.cancelAction();
      return;
    }
    if (this.marqueeStartS) {
      if (this.marqueeActive && state.marquee) {
        this.applyMarquee(state.marquee.a, state.marquee.b, this.marqueeAdd);
      }
      this.resetMarquee();
      this.render();
      return;
    }
    if (this.drag) {
      for (const it of this.drag.items) it.p.dragging = false;
      this.drag = null;
      solveSketch(120);
      this.render();
    }
  }

  private onKeyDown(ev: KeyboardEvent): void {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === 'Escape') {
      this.cancelAction();
      return;
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      ev.preventDefault();
      this.deleteSelection();
      return;
    }
    const key = ev.key.toLowerCase();
    if (key === 's') {
      this.toggleSnap();
      return;
    }
    const tool = TOOLS.find((t) => t.key === key);
    if (tool) this.setTool(tool.id);
  }

  /* ======================= 工具状态机 ======================= */

  private cancelAction(): void {
    if (this.marqueeStartS) {
      this.resetMarquee();
      this.render();
      return;
    }
    if (state.pending) {
      state.pending = null;
      this.render();
      return;
    }
    if (state.tool !== 'select') {
      this.setTool('select');
      return;
    }
    state.sel = [];
    this.refreshHint();
    this.render();
  }

  private resetMarquee(): void {
    this.marqueeStartS = null;
    this.marqueeActive = false;
    this.marqueeAdd = false;
    state.marquee = null;
  }

  /**
   * 框选方向决定选择方式：
   * 由下往上（终点 y 更小）= 交叉选择，框到图元任意一部分就选中整个图元；
   * 由上往下 = 窗口选择，必须完全包住图元才选中。
   */
  private applyMarquee(a: Vec, b: Vec, add: boolean): void {
    const rect = rectOf(a, b);
    const crossing = b.y < a.y;
    const found: number[] = [];
    for (const e of model.ents.values()) {
      if (crossing ? entityCrossesRect(e, rect) : entityInsideRect(e, rect)) found.push(e.id);
    }
    // 点没有部分相交的概念，两种框选都只看是否落在框内
    for (const p of model.pts.values()) {
      if (pointInRect(p, rect)) found.push(p.id);
    }
    state.sel = add ? [...new Set([...state.sel, ...found])] : found;
    this.refreshHint();
  }

  private toggleSelection(id: number): void {
    state.sel = state.sel.includes(id)
      ? state.sel.filter((x) => x !== id)
      : state.sel.concat(id);
    this.refreshHint();
  }

  /** 拿点：吸附到已有点时直接复用，否则新建 */
  private acquirePoint(snap: Snap | null, w: Vec): Point {
    if (snap?.pt) return snap.pt;
    const p = snap ? snap.pos : w;
    return addPt(p.x, p.y);
  }

  private handleClick(w: Vec, shift: boolean): void {
    const snap = state.snap;
    const pos = snap ? snap.pos : w;

    switch (state.tool) {
      /* -------- 直线（连续绘制） -------- */
      case 'line': {
        const pending = state.pending;
        if (!pending || pending.type !== 'line') {
          state.pending = { type: 'line', start: pos, startPt: this.acquirePoint(snap, w) };
        } else {
          const a = pending.start;
          if (vec.dist(a, pos) < 1e-6) return;
          const p1 = pending.startPt;
          const p2 = this.acquirePoint(snap, w);
          const line = addLine(p1, p2);

          // 近水平/竖直时自动加约束
          const dx = pos.x - a.x;
          const dy = pos.y - a.y;
          if (Math.abs(dy) < Math.abs(dx) * 0.02) addCon('horizontal', { e: line.id });
          else if (Math.abs(dx) < Math.abs(dy) * 0.02) addCon('vertical', { e: line.id });

          state.pending = { type: 'line', start: { x: p2.x, y: p2.y }, startPt: p2 };
          solveSketch(40);
        }
        break;
      }

      /* -------- 圆 -------- */
      case 'circle': {
        const pending = state.pending;
        if (!pending || pending.type !== 'circle') {
          const c = this.acquirePoint(snap, w);
          state.pending = { type: 'circle', center: c.id };
        } else {
          const c = P(pending.center);
          if (c) {
            const r = vec.dist(c, pos);
            if (r > 1e-4) addCircle(c, r);
          }
          state.pending = null;
          solveSketch(40);
        }
        break;
      }

      /* -------- 圆弧：圆心 → 起点 → 终点 -------- */
      case 'arc': {
        const pending = state.pending;
        if (!pending || pending.type !== 'arc') {
          const c = this.acquirePoint(snap, w);
          state.pending = { type: 'arc', c: c.id, stage: 1 };
        } else if (pending.stage === 1) {
          const c = P(pending.c);
          if (!c) {
            state.pending = null;
            break;
          }
          const r = Math.max(1e-4, vec.dist(c, pos));
          state.pending = {
            type: 'arc',
            c: pending.c,
            stage: 2,
            r,
            a0: Math.atan2(pos.y - c.y, pos.x - c.x),
          };
        } else {
          const c = P(pending.c);
          if (c && pending.r !== undefined && pending.a0 !== undefined) {
            const a1 = Math.atan2(pos.y - c.y, pos.x - c.x);
            let sw = a1 - pending.a0;
            while (sw <= 0) sw += Math.PI * 2;
            addArc(c, pending.r, pending.a0, pending.a0 + sw);
          }
          state.pending = null;
          solveSketch(40);
        }
        break;
      }

      /* -------- 矩形：对角两点 -------- */
      case 'rect': {
        const pending = state.pending;
        if (!pending || pending.type !== 'rect') {
          state.pending = { type: 'rect', p0: { x: pos.x, y: pos.y } };
        } else {
          const a = pending.p0;
          const b = pos;
          if (Math.abs(b.x - a.x) < 1e-4 || Math.abs(b.y - a.y) < 1e-4) {
            state.pending = null;
            break;
          }
          const q = [
            addPt(a.x, a.y),
            addPt(b.x, a.y),
            addPt(b.x, b.y),
            addPt(a.x, b.y),
          ];
          for (let i = 0; i < 4; i++) {
            const l = addLine(q[i], q[(i + 1) % 4]);
            addCon(i % 2 === 0 ? 'horizontal' : 'vertical', { e: l.id });
          }
          state.pending = null;
          solveSketch(60);
        }
        break;
      }

      /* -------- 尺寸 -------- */
      case 'dim': {
        const pending = state.pending;
        if (!pending || pending.type !== 'dim') {
          const p = pickPoint(w);
          if (p) {
            state.pending = { type: 'dim', a: p.id, startW: { x: p.x, y: p.y } };
            break;
          }
          const e = pickEntity(w);
          if (e && e.type !== 'line') {
            addCon('radius', { e: e.id, r: e.r });
            solveSketch(40);
          } else if (e && e.type === 'line') {
            const a = P(e.a);
            if (a) state.pending = { type: 'dim', a: e.a, b: e.b, startW: { x: a.x, y: a.y } };
          }
        } else {
          const a = P(pending.a);
          if (!a) {
            state.pending = null;
            break;
          }
          const p = pickPoint(w);
          const b = p ?? addPt(pos.x, pos.y);
          const d = vec.dist(a, b);
          if (d > 1e-6) {
            // 标注偏移：点击位置在法线方向的投影
            const dir = vec.sub(b, a);
            const L = vec.len(dir) || 1;
            const nrm = { x: -dir.y / L, y: dir.x / L };
            const off = vec.dot(vec.sub(w, a), nrm);
            addCon('distancePP', { a: a.id, b: b.id, d, offset: off });
            solveSketch(60);
          }
          state.pending = null;
        }
        break;
      }

      /* -------- 删除 -------- */
      case 'erase': {
        const p = pickPoint(w, 8);
        if (p) {
          removePoint(p);
        } else {
          const e = pickEntity(w);
          if (e) removeEntity(e);
        }
        solveSketch(40);
        break;
      }

      /* -------- 选择 -------- */
      case 'select': {
        const pt = pickPoint(w);
        if (shift) {
          // Shift 点击只加减选，不拖拽；点优先于图元
          if (pt) {
            this.toggleSelection(pt.id);
            break;
          }
          const ent = pickEntity(w);
          if (ent) {
            this.toggleSelection(ent.id);
            break;
          }
          // Shift + 空白：开始累加框选，选中集合保持不变
          this.marqueeStartS = { ...this.lastS };
          this.marqueeActive = false;
          this.marqueeAdd = true;
          break;
        }
        if (pt) {
          state.sel = [pt.id];
          this.refreshHint();
          this.startDrag([pt]);
          return;
        }
        const ent = pickEntity(w);
        if (ent) {
          const pts = ent.type === 'line' ? [P(ent.a), P(ent.b)] : [P(ent.c)];
          this.startDrag(pts.filter((p): p is Point => Boolean(p)));
          state.sel = [ent.id];
          this.refreshHint();
          return;
        }
        // 空白处按下：准备框选；松手时没拖动就当作点击空白（清空选择）
        this.marqueeStartS = { ...this.lastS };
        this.marqueeActive = false;
        this.marqueeAdd = false;
        if (state.sel.length > 0) {
          state.sel = [];
          this.refreshHint();
        }
        break;
      }
    }
    this.render();
  }

  private startDrag(pts: Point[]): void {
    if (pts.length === 0) return;
    this.drag = {
      items: pts.map((p) => ({ p, ox: p.x, oy: p.y })),
      sx: state.cursorW.x,
      sy: state.cursorW.y,
    };
    for (const it of this.drag.items) it.p.dragging = true;
  }

  private deleteSelection(): void {
    for (const id of [...state.sel]) {
      const e = E(id);
      if (e) {
        removeEntity(e);
        continue;
      }
      const p = P(id);
      if (p) removePoint(p);
    }
    state.sel = [];
    solveSketch(60);
    this.refreshHint();
    this.render();
  }

  private render(): void {
    this.renderer.render();
  }
}
