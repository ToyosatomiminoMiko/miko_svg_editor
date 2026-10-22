/**
 * 编辑器控制器：工具状态机、指针/键盘输入、约束按钮动作、视图操作。
 * 渲染交给 Renderer，拾取/吸附在 geometry.ts，求解在 solver.ts。
 */

import { cam, s2w, zoomAt } from './camera';
import {
  findDimForEntity,
  findDistanceDim,
  formatDimValue,
  dimValue,
  pickDim,
  setDimValue,
} from './dimensions';
import { entityDimTarget, entityPointIds } from './entities';
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
  model,
  modelBounds,
  removeConstraint,
  removeEntity,
  removePoint,
} from './model';
import { Renderer } from './renderer';
import { solveSketch } from './solver';
import { state } from './state';
import { TOOLS, type ConstraintAction } from './tools';
import type { ToolbarHandle, ToolbarHandlers } from './toolbar';
import type { Constraint, Entity, Point, Snap, ToolId, Vec } from './types';
import { vec } from './vec';

/** 底部提示栏里的尺寸输入框节点，由 main.ts 从 index.html 取出后传入 */
export interface HintHandle {
  root: HTMLElement;
  text: HTMLElement;
  editor: HTMLElement;
  label: HTMLElement;
  input: HTMLInputElement;
}

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
  private readonly hint: HintHandle;
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
  /** 正在编辑的尺寸；created 表示本次刚创建，Esc 要撤销掉 */
  private dimEdit: { con: Constraint; created: boolean; pointId?: number } | null = null;

  constructor(canvas: HTMLCanvasElement, hint: HintHandle) {
    this.canvas = canvas;
    this.hint = hint;
    this.renderer = new Renderer(canvas);
    this.attachEvents();
    this.bindHintEditor();
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
    // 切工具时先结算输入框：合法值提交，非法值放弃
    if (this.dimEdit && !this.commitDimEdit()) this.cancelDimEdit();
    state.tool = id;
    this.clearPending();
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
        for (const pid of entityPointIds(e)) ids.add(pid);
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
    if (this.dimEdit) this.cancelDimEdit();
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
    this.hint.text.textContent = parts.join(' · ');
  }

  /* ======================= 尺寸输入框 ======================= */

  /**
   * 输入框的按键与失焦处理。
   * 输入框聚焦时 stopPropagation，让画布的单键快捷键（v/l/c/a/r/d/e/s）失效；
   * 点击输入框以外的任何位置 = 先结算输入，再让这次点击继续生效。
   */
  private bindHintEditor(): void {
    const { input } = this.hint;

    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.commitDimEdit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this.cancelDimEdit();
      }
    });
    input.addEventListener('input', () => input.classList.remove('is-invalid'));
    // Tab 等失焦也按提交处理；hide 时已先清空 dimEdit，不会重复触发
    input.addEventListener('blur', () => {
      if (this.dimEdit) this.commitDimEdit();
    });

    window.addEventListener(
      'pointerdown',
      (ev) => {
        if (!this.dimEdit) return;
        if (this.hint.editor.contains(ev.target as Node | null)) return;
        // 非法输入保持编辑并吞掉这次点击，避免在不确定的值上继续操作
        if (!this.commitDimEdit()) {
          ev.stopPropagation();
          ev.preventDefault();
        }
      },
      true,
    );
  }

  /** 打开输入框：编辑刚创建的尺寸或点中的已有尺寸 */
  private openDimEdit(con: Constraint, created: boolean, label: string, pointId?: number): void {
    this.dimEdit = { con, created, pointId };
    this.hint.root.classList.add('is-editing');
    this.hint.editor.hidden = false;
    this.hint.label.textContent = label;
    this.hint.input.value = formatDimValue(dimValue(con));
    this.hint.input.classList.remove('is-invalid');
    // 延后一个任务再聚焦：pointerdown 的默认行为会把焦点移到 body，立即聚焦会被马上 blur 掉
    window.setTimeout(() => {
      if (this.dimEdit?.con !== con) return;
      this.hint.input.focus();
      this.hint.input.select();
    }, 0);
  }

  /**
   * 提交输入值。
   * @returns 是否已提交；数值非法时返回 false 并保持编辑状态
   */
  private commitDimEdit(): boolean {
    const edit = this.dimEdit;
    if (!edit) return true;

    const raw = this.hint.input.value.trim();
    const value = Number(raw);
    // 长度/半径必须是有限正数；空串 Number('') === 0，用 raw 兜住
    if (!raw || !Number.isFinite(value) || value <= 0) {
      this.hint.input.classList.add('is-invalid');
      this.hint.input.focus();
      this.hint.input.select();
      return false;
    }

    this.dimEdit = null;
    this.hideDimEditor();
    setDimValue(edit.con, value);
    solveSketch(120);
    this.render();
    return true;
  }

  /** 取消输入：新建的尺寸撤销掉（含这次顺手建的点），编辑已有的保持原值 */
  private cancelDimEdit(): void {
    const edit = this.dimEdit;
    if (!edit) return;
    this.dimEdit = null;
    this.hideDimEditor();
    if (edit.created) {
      removeConstraint(edit.con);
      if (edit.pointId !== undefined) {
        const p = P(edit.pointId);
        if (p) removePoint(p);
      }
      solveSketch(40);
    }
    this.render();
  }

  private hideDimEditor(): void {
    this.hint.editor.hidden = true;
    this.hint.root.classList.remove('is-editing');
    this.hint.input.blur();
    this.refreshHint();
  }

  /** 尺寸工具点中图元：按类型创建（或编辑已有）尺寸 */
  private startEntityDim(e: Entity): void {
    const target = entityDimTarget(e);

    if (target.kind === 'radius') {
      const existing = findDimForEntity(e);
      if (existing) {
        this.openDimEdit(existing, false, '半径');
        return;
      }
      const ent = E(target.e);
      if (!ent || ent.type === 'line') return;
      const con = addCon('radius', { e: target.e, r: ent.r });
      solveSketch(40);
      this.openDimEdit(con, true, '半径');
      return;
    }

    const existing = findDimForEntity(e);
    if (existing) {
      this.openDimEdit(existing, false, '长度');
      return;
    }
    const a = P(target.a);
    const b = P(target.b);
    if (!a || !b) return;
    const d = vec.dist(a, b);
    if (d < 1e-9) return;
    // 点击点就在线上，投影为 0，所以用固定屏幕偏移把尺寸线推离线本身
    const con = addCon('distancePP', { a: target.a, b: target.b, d, offset: 14 / cam.z });
    solveSketch(40);
    this.openDimEdit(con, true, '长度');
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
    // 输入框打开时键盘归输入框管，避免打数字时触发单键快捷键
    if (this.dimEdit) return;
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
    if (this.dimEdit) {
      this.cancelDimEdit();
      return;
    }
    if (this.marqueeStartS) {
      this.resetMarquee();
      this.render();
      return;
    }
    if (state.pending) {
      this.clearPending();
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

  /** 清空未完成操作；顺手删掉这次点击新建、但还没并入图元的孤立点 */
  private clearPending(): void {
    const pending = state.pending;
    if (pending && 'newPt' in pending && pending.newPt !== undefined) {
      const p = P(pending.newPt);
      if (p) removePoint(p);
    }
    state.pending = null;
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
          const startPt = this.acquirePoint(snap, w);
          state.pending = {
            type: 'line',
            start: pos,
            startPt,
            // 吸附到已有点时复用，不算新点
            newPt: snap?.pt ? undefined : startPt.id,
          };
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
          state.pending = { type: 'circle', center: c.id, newPt: snap?.pt ? undefined : c.id };
        } else {
          const c = P(pending.center);
          if (c) {
            const r = vec.dist(c, pos);
            if (r > 1e-4) {
              addCircle(c, r);
              state.pending = null;
              solveSketch(40);
            } else {
              // 半径太小没画出圆：把刚建的圆心点一起清掉
              this.clearPending();
            }
          } else {
            state.pending = null;
          }
        }
        break;
      }

      /* -------- 圆弧：圆心 → 起点 → 终点 -------- */
      case 'arc': {
        const pending = state.pending;
        if (!pending || pending.type !== 'arc') {
          const c = this.acquirePoint(snap, w);
          state.pending = { type: 'arc', c: c.id, stage: 1, newPt: snap?.pt ? undefined : c.id };
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
            newPt: pending.newPt,
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
        if (pending && pending.type === 'dim') {
          const a = P(pending.a);
          if (!a) {
            state.pending = null;
            break;
          }
          const p = pickPoint(w);
          if (p && p.id === a.id) {
            // 点回起点视为取消
            state.pending = null;
            break;
          }
          const b = p ?? addPt(pos.x, pos.y);
          const d = vec.dist(a, b);
          if (d > 1e-6) {
            const existing = p ? findDistanceDim(a.id, p.id) : undefined;
            if (existing) {
              this.openDimEdit(existing, false, '距离');
            } else {
              // 标注偏移：点击位置在法线方向的投影
              const dir = vec.sub(b, a);
              const L = vec.len(dir) || 1;
              const nrm = { x: -dir.y / L, y: dir.x / L };
              const off = vec.dot(vec.sub(w, a), nrm);
              const con = addCon('distancePP', { a: a.id, b: b.id, d, offset: off });
              solveSketch(60);
              // 第二点是这次点击新建的：Esc 撤销时连它一起删
              this.openDimEdit(con, true, '距离', p ? undefined : b.id);
            }
          } else if (!p) {
            // 退化成零距离：删掉刚建的点
            removePoint(b);
          }
          state.pending = null;
          break;
        }

        // 已有尺寸标注优先：单击进入编辑
        const dim = pickDim(w, this.renderer.getTheme());
        if (dim) {
          this.openDimEdit(dim, false, dim.type === 'radius' ? '半径' : '距离');
          break;
        }
        const p = pickPoint(w);
        if (p) {
          state.pending = { type: 'dim', a: p.id };
          break;
        }
        const e = pickEntity(w);
        if (e) this.startEntityDim(e);
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
          const pts = entityPointIds(ent)
            .map((id) => P(id))
            .filter((p): p is Point => Boolean(p));
          this.startDrag(pts);
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
