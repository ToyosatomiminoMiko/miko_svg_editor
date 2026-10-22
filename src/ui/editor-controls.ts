/**
 * 工具栏命令与统一同步：从 Editor 拆出的「动作实现 + 提示 + 刷新」层。
 * Editor 只保留事件接线与手势状态机；这里的命令同样只做编排，领域逻辑在 sketch-actions.ts。
 * 目标：控制 editor.ts 行数（§5.2 ≤250），并让「render + 提示栏」只有一个刷新入口 sync()。
 */

import { EXPORT_EMPTY_MESSAGE, ITER_FULL, type ConstraintAction } from '../config';
import { buildSVG } from '../export-svg';
import { clearModel, getEntity, isEmpty } from '../model';
import type { Renderer } from '../renderer';
import { selectionSummary } from '../selection';
import {
  applyConstraint as applyConstraintAction,
  deleteSelected,
  solve,
  toggleConstruction as toggleConstructionAction,
  toggleFixed as toggleFixedAction,
  type ActionResult,
  type Notice,
} from '../sketch-actions';
import { clearSelection, resetInteraction, state } from '../state';
import { TOOLS } from '../tools';
import type { ToolbarHandle, ToolbarHandlers } from '../toolbar';
import type { Entity, ToolId } from '../types';
import { fitView as fitViewport } from '../viewport';
import { downloadSvg } from './download';
import type { HintEditor } from './hint-editor';
import { askConfirm, notify, notifyAll } from './notify';

export interface EditorControlsDeps {
  readonly canvas: HTMLCanvasElement;
  readonly hintEditor: HintEditor;
  readonly renderer: Renderer;
  /** 读取当前工具栏引用：bindToolbar 在构造之后才发生 */
  getToolbar(): ToolbarHandle | null;
  /** 清空未完成工具操作（Editor 的 pending 状态） */
  clearPending(): void;
}

export class EditorControls implements ToolbarHandlers {
  constructor(private readonly deps: EditorControlsDeps) {}

  /** 唯一同步入口：先重绘画布，再按当前 tool/selection/snap 更新提示栏 */
  sync(): void {
    this.deps.renderer.render();
    const tool = TOOLS.find((t) => t.id === state.tool);
    this.deps.hintEditor.updateStatus(tool?.hint, selectionSummary(), state.snapEnabled);
  }

  /** 领域操作结果：失败/求解提示统一 toast，然后同步画面与提示 */
  apply(result: ActionResult): void {
    if (!result.ok) notify(result.reason, 'error');
    else notifyAll(result.notices);
    this.sync();
  }

  /** 批量提示（拖拽结束后的一次性求解结果等） */
  report(notices: readonly Notice[]): void {
    notifyAll(notices);
  }

  setTool(id: ToolId): void {
    // 切工具先结算输入框：合法值提交，非法值直接放弃
    if (this.deps.hintEditor.editing && !this.deps.hintEditor.commit())
      this.deps.hintEditor.cancel();
    state.tool = id;
    this.deps.clearPending();
    state.snap = null;
    state.marquee = null;
    if (id !== 'select') clearSelection();
    this.deps.getToolbar()?.setActive(id);
    this.deps.canvas.classList.toggle('is-drawing', id !== 'select');
    this.sync();
  }

  toggleSnap(): void {
    state.snapEnabled = !state.snapEnabled;
    if (!state.snapEnabled) state.snap = null;
    this.deps.getToolbar()?.setSnap(state.snapEnabled);
    this.sync();
  }

  /** 约束按钮：选中图元交给 sketch-actions 查表校验（不适用/重复会有明确提示） */
  applyConstraint(action: ConstraintAction): void {
    const selected = state.selection.ents
      .map(getEntity)
      .filter((e): e is Entity => e !== undefined);
    this.apply(applyConstraintAction(action, selected));
  }

  /**
   * 拖拽收尾：正常松手时做一次完整求解并提示未满足的约束；
   * 手势被系统取消（pointercancel）时静默求解，不应弹错误提示。
   */
  finishDrag(cancelled = false): void {
    if (cancelled) solve(ITER_FULL, { silent: true });
    else this.report(solve(ITER_FULL));
    this.sync();
  }

  toggleFixed(): void {
    this.apply(toggleFixedAction(state.selection));
  }

  /** Delete/Backspace：删除选中对象（级联由 model 负责），选择集清空 */
  deleteSelection(): void {
    const selection = state.selection;
    clearSelection();
    this.apply(deleteSelected(selection));
  }

  /** Esc 的清选择分支 */
  clearSelection(): void {
    clearSelection();
    this.sync();
  }

  toggleConstruction(): void {
    this.apply(toggleConstructionAction(state.selection));
  }

  fitView(): void {
    fitViewport();
    this.sync();
  }

  exportSVG(): void {
    const svg = buildSVG();
    if (!svg) {
      notify(EXPORT_EMPTY_MESSAGE, 'error');
      return;
    }
    downloadSvg(svg);
    notify('已导出 SVG');
  }

  /** 清空：空判定与导出一致用 model.isEmpty()（BUG-4），确认框非阻塞自绘 */
  clearAll(): void {
    void this.confirmClearAll();
  }

  private async confirmClearAll(): Promise<void> {
    if (isEmpty()) {
      notify('草图已经是空的', 'info');
      return;
    }
    if (!(await askConfirm('清空整张草图？'))) return;
    this.deps.hintEditor.cancel();
    clearModel();
    resetInteraction();
    this.sync();
  }
}

/**
 * 工具栏回调适配器：main.ts 把 `editor.handlers` 交给 buildToolbar。
 * 放在本文件而不是 Editor 里，保证 editor.ts 只保留事件接线与手势状态机（§5.2 ≤250 行）。
 */
export function createToolbarHandlers(controls: EditorControls): ToolbarHandlers {
  return {
    setTool: (id) => controls.setTool(id),
    applyConstraint: (kind) => controls.applyConstraint(kind),
    toggleSnap: () => controls.toggleSnap(),
    toggleFixed: () => controls.toggleFixed(),
    toggleConstruction: () => controls.toggleConstruction(),
    fitView: () => controls.fitView(),
    exportSVG: () => controls.exportSVG(),
    clearAll: () => controls.clearAll(),
  };
}
