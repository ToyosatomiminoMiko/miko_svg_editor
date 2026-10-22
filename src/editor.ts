/**
 * 编辑器控制器：事件接线 + 手势状态机 + 工具栏回调委托。
 * 领域操作在 sketch-actions.ts，选择/悬停语义在 selection.ts，视图在 viewport.ts，
 * 工具栏命令与统一同步在 ui/editor-controls.ts，输入框在 ui/hint-editor.ts。
 */

import { cam, s2w } from './camera';
import { Renderer } from './renderer';
import { applyMarquee, clearHover, clickSelect, updateHover, updateMarquee } from './selection';
import {
  cancelPending,
  commitDim,
  moveDrag,
  rollbackDim,
  toolClick,
  type DragGesture,
} from './sketch-actions';
import { state } from './state';
import type { Theme } from './theme';
import { TOOLS } from './tools';
import type { ToolbarHandle, ToolbarHandlers } from './toolbar';
import type { HintHandle } from './ui/hint-editor';
import type { MeasureText, Point, Vec } from './types';
import { EditorControls, createToolbarHandlers } from './ui/editor-controls';
import { HintEditor } from './ui/hint-editor';
import { applyPan, beginPan, wheelZoom, type PanAnchor } from './viewport';

type Gesture = { kind: 'pan'; pan: PanAnchor } | { kind: 'drag'; drag: DragGesture };
export class Editor {
  private readonly canvas: HTMLCanvasElement;
  private readonly hintEditor: HintEditor;
  private readonly controls: EditorControls;
  private readonly measureText: MeasureText;
  private readonly dimFont: string;
  /** 工具栏回调：由 EditorControls 生成，main.ts 交给 buildToolbar */
  readonly handlers: ToolbarHandlers;
  private toolbar: ToolbarHandle | null = null;
  /** 手势瞬态：拖拽/平移，结束即清；Point 不再有 dragging 标记（§5.3） */
  private gesture: Gesture | null = null;

  constructor(canvas: HTMLCanvasElement, hint: HintHandle, theme: Theme, measureText: MeasureText) {
    this.canvas = canvas;
    this.measureText = measureText;
    this.dimFont = theme.dimFont;
    const renderer = new Renderer(canvas, theme);
    this.hintEditor = new HintEditor(hint, {
      onCommit: (con, value) => this.controls.apply(commitDim(con, value)),
      onCancel: (session) => {
        if (session.created) this.controls.apply(rollbackDim(session.con, session.pointId));
        else this.controls.sync();
      },
    });
    this.controls = new EditorControls({
      canvas,
      hintEditor: this.hintEditor,
      renderer,
      getToolbar: () => this.toolbar,
      clearPending: () => this.clearPending(),
    });
    this.handlers = createToolbarHandlers(this.controls);
    this.attachEvents();
    window.addEventListener('resize', () => renderer.resize());
    renderer.resize();
  }

  /** 工具栏构建完成后回填引用，并设置默认工具 */
  bindToolbar(toolbar: ToolbarHandle): void {
    this.toolbar = toolbar;
    toolbar.setSnap(state.snapEnabled);
    this.controls.setTool('select');
  }

  /* ======================= 事件接线 ======================= */

  private attachEvents(): void {
    this.canvas.addEventListener('pointerdown', (ev) => this.onPointerDown(ev));
    this.canvas.addEventListener('pointermove', (ev) => this.onPointerMove(ev));
    this.canvas.addEventListener('pointerup', (ev) => this.finishGesture(ev, false));
    // 系统手势/多指中断：与 pointerup 同一收尾，避免 capture/手势状态残留（BUG-12）
    this.canvas.addEventListener('pointercancel', (ev) => this.finishGesture(ev, true));
    this.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
    this.canvas.addEventListener('wheel', (ev) => this.onWheel(ev), { passive: false });
    window.addEventListener('keydown', (ev) => this.onKeyDown(ev));
  }

  /** 指针屏幕坐标；顺带刷新世界坐标指针位置 */
  private pointerS(ev: PointerEvent): Vec {
    const rect = this.canvas.getBoundingClientRect();
    const sp = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    state.cursorWorld = s2w(sp);
    return sp;
  }

  private onPointerDown(ev: PointerEvent): void {
    this.canvas.setPointerCapture(ev.pointerId);
    const sp = this.pointerS(ev);
    if (ev.button === 1 || ev.button === 2) {
      this.gesture = { kind: 'pan', pan: beginPan(sp) };
      clearHover();
      this.controls.sync();
    } else if (ev.button === 0) this.onPrimaryClick(sp, ev.shiftKey);
  }

  /** 左键按下：选择工具走选择/拖拽/框选，其余工具交给 sketch-actions 的点击状态机 */
  private onPrimaryClick(sp: Vec, shift: boolean): void {
    if (state.tool === 'select') {
      const result = clickSelect(state.cursorWorld, cam.z, shift);
      if (result.dragPoints.length > 0) this.startDrag(result.dragPoints);
      if (result.startMarquee) {
        // 框选也是一种手势：先清掉悬停/吸附标记，避免十字停在旧位置（BUG-11）
        clearHover();
        state.marquee = { s0: { ...sp }, currentS: { ...sp }, active: false, add: shift };
      }
      this.controls.sync();
      return;
    }
    const view = cam;
    const out = toolClick(
      state.tool,
      state.pending,
      state.cursorWorld,
      state.snap,
      view,
      this.measureText,
      this.dimFont,
    );
    state.pending = out.pending;
    if (out.action) this.controls.apply(out.action);
    else if (out.dim) {
      this.hintEditor.openResult(out.dim);
      this.controls.sync();
    } else this.controls.sync();
  }

  private onPointerMove(ev: PointerEvent): void {
    const sp = this.pointerS(ev);
    const gesture = this.gesture;
    if (gesture?.kind === 'pan') {
      applyPan(gesture.pan, sp);
      this.controls.sync();
      return;
    }
    if (gesture?.kind === 'drag') {
      moveDrag(gesture.drag, state.cursorWorld);
      this.controls.sync();
      return;
    }
    if (state.marquee) {
      updateMarquee(sp);
      this.controls.sync();
      return;
    }
    updateHover(state.cursorWorld, cam.z);
    this.controls.sync();
  }

  private finishGesture(ev: PointerEvent, cancelled: boolean): void {
    if (this.canvas.hasPointerCapture(ev.pointerId))
      this.canvas.releasePointerCapture(ev.pointerId);
    const gesture = this.gesture;
    const marquee = state.marquee;
    this.gesture = null;
    state.marquee = null;
    if (gesture?.kind === 'pan') {
      // 右键没拖动 = 取消当前操作
      if (!cancelled && ev.type === 'pointerup' && ev.button === 2 && !gesture.pan.moved) {
        this.cancelAction();
      }
      this.controls.sync();
    } else if (gesture?.kind === 'drag') {
      this.controls.finishDrag(cancelled);
    } else if (marquee) {
      // 结算用捕获的手势参数；state.marquee 只负责手势进行中的 live 状态
      if (marquee.active && !cancelled) applyMarquee(marquee);
      this.controls.sync();
    }
  }

  private onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    wheelZoom({ x: ev.clientX - rect.left, y: ev.clientY - rect.top }, ev.deltaY);
    this.controls.sync();
  }

  private onKeyDown(ev: KeyboardEvent): void {
    if (this.hintEditor.editing) return; // 输入框自己处理按键
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === 'Escape') {
      this.cancelAction();
      return;
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      ev.preventDefault();
      this.controls.deleteSelection();
      return;
    }
    const key = ev.key.toLowerCase();
    if (key === 's') {
      this.controls.toggleSnap();
      return;
    }
    const tool = TOOLS.find((t) => t.key === key);
    if (tool) this.controls.setTool(tool.id);
  }

  /* ======================= 手势与状态 ======================= */

  private startDrag(points: Point[]): void {
    const w = state.cursorWorld;
    const items = points.map((p) => ({ p, ox: p.x, oy: p.y }));
    this.gesture = {
      kind: 'drag',
      drag: { startW: { x: w.x, y: w.y }, items, exclude: new Set(points.map((p) => p.id)) },
    };
    clearHover();
  }

  /** Esc 优先级阶梯：输入框 → 框选 → 未完成操作 → 工具 → 选择 */
  private cancelAction(): void {
    // 兜底：正常事件顺序下不可达（输入框聚焦时 Esc 被 input 的 keydown 拦下且 stopPropagation），
    // 保留以便将来 cancelAction 被其它路径调用时仍能先收尾输入框。
    if (this.hintEditor.editing) {
      this.hintEditor.cancel();
      return;
    }
    if (state.marquee) {
      state.marquee = null;
      this.controls.sync();
      return;
    }
    if (state.pending) {
      this.clearPending();
      this.controls.sync();
      return;
    }
    if (state.tool !== 'select') {
      this.controls.setTool('select');
      return;
    }
    this.controls.clearSelection();
  }

  /** 清空未完成操作；顺手删掉这次点击新建、还没并入图元的孤立点 */
  private clearPending(): void {
    const pending = state.pending;
    state.pending = null;
    if (pending) cancelPending(pending);
  }
}
