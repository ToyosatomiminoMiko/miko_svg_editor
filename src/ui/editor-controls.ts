/**
 * 工具栏命令与统一同步：从 Editor 拆出的「动作实现 + 提示 + 刷新」层。
 * Editor 只保留事件接线与手势状态机；这里的命令同样只做编排，领域逻辑在 sketch-actions.ts，
 * 参数槽位与执行顺序在 operations.ts。
 *
 * 统一命令模型（填满即执行）：
 * - 工具 / 约束 / 固定 / 构造按钮都只是「启动一个操作」，操作从选择集预填参数；
 * - 参数没齐时，画布点击交给 operations.clickCommand 补槽位（只消费能填的候选）；
 * - 参数填满后立即执行（正常不再需要 Enter）；repeat 操作（删除/固定/构造/水平/竖直）
 *   每点一个对象就执行一次、命令保持可继续点，Esc/右键结束；Backspace 回退、Esc 放弃；
 * - 执行成功后，工具类操作自动重新进入同一操作（直线以终点接续，可连续画）；
 *   repeat 操作保持可继续点；其余约束/编辑操作回到选择工具。
 */

import { cam } from '../camera';
import { EXPORT_EMPTY_MESSAGE, ITER_FULL } from '../config';
import { buildSVG } from '../export-svg';
import { clearModel, isEmpty } from '../model';
import {
  cancelCommand as cancelOperationSession,
  clickCommand as clickCommandOperation,
  commandStatus,
  continuationOf,
  createSession,
  executeCommand as executeOperation,
  fillFromOperands,
  isComplete,
  isRepeatOperation,
  operationById,
  operationForTool,
  operandsFromSelection,
  popCommandValue as popOperationValue,
  type ClickInput,
  type OperationId,
} from '../operations';
import type { Renderer } from '../renderer';
import { pruneSelection, selectionEntries, selectionSummary } from '../selection';
import {
  commitDim,
  deleteSelected,
  rollbackDim,
  solve,
  type ActionResult,
  type Notice,
} from '../sketch-actions';
import { clearSelection, deselect, resetInteraction, state } from '../state';
import { TOOLS } from '../tools';
import type { ToolbarHandle, ToolbarHandlers } from '../toolbar';
import type { SelectionKind, ToolId } from '../types';
import { fitView as fitViewport } from '../viewport';
import { downloadSvg } from './download';
import type { HintEditor } from './hint-editor';
import { notify, notifyAll, askConfirm } from './notify';
import { SelectionListView } from './selection-list';

export interface EditorControlsDeps {
  readonly canvas: HTMLCanvasElement;
  readonly hintEditor: HintEditor;
  readonly renderer: Renderer;
  /** 左侧状态栏里「已选择」区块的宿主节点（status-panel.ts 的上半区插槽） */
  readonly selectionSlot: HTMLElement;
  /** 读取当前工具栏引用：bindToolbar 在构造之后才发生 */
  getToolbar(): ToolbarHandle | null;
}

/** 执行触发来源：失败时决定会话是回退一击、重开连续模式还是保留可执行态 */
type ExecuteSource = 'click' | 'arm' | 'keyboard';

export class EditorControls implements ToolbarHandlers {
  /** 已选择列表：选中集变化时由 sync() 推给面板，行内「移除」回调走 removeSelection */
  private readonly selectionList: SelectionListView;

  constructor(private readonly deps: EditorControlsDeps) {
    this.selectionList = new SelectionListView(deps.selectionSlot, {
      remove: (kind, id) => this.removeSelection(kind, id),
    });
  }

  /** 唯一同步入口：先清掉悬空选择，再重绘画布、推已选列表、更新状态栏（命令优先） */
  sync(): void {
    // 删除等路径不经过选择逻辑，这里兜底摘掉模型里已不存在的选择项
    pruneSelection();
    this.deps.renderer.render();
    this.selectionList.update(selectionEntries());
    const command = state.command;
    const hint = command
      ? commandStatus(command)
      : (() => {
          const tool = TOOLS.find((t) => t.id === state.tool);
          return tool ? `${tool.label}（${tool.key.toUpperCase()}） · ${tool.hint}` : '';
        })();
    this.deps.hintEditor.updateStatus(hint, selectionSummary(), state.snapEnabled);
  }

  /** 已选列表行内「移除」：只从选择集摘掉这一项，不改模型 */
  removeSelection(kind: SelectionKind, id: number): void {
    deselect(kind, id);
    this.sync();
  }

  /** 领域操作结果：失败/求解提示统一走 notify，然后同步画面与提示 */
  apply(result: ActionResult): void {
    if (!result.ok) notify(result.reason, 'error');
    else notifyAll(result.notices);
    this.sync();
  }

  /** 批量提示（拖拽结束后的一次性求解结果等） */
  report(notices: readonly Notice[]): void {
    notifyAll(notices);
  }

  /* ======================= 命令生命周期 ======================= */

  /** 工具分段：select = 取消命令回到选择；其余工具 = 启动对应操作 */
  setTool(id: ToolId): void {
    this.commitDimEditor();
    if (id === 'select') {
      this.cancelCommand();
      return;
    }
    this.armOperation(operationForTool(id).id);
  }

  /**
   * 启动操作（工具栏约束/编辑按钮或工具分段）：
   * 先把选择集按槽位类型装进去；装不满就留在收集态等画布点击，一次填满则立即执行。
   */
  armOperation(id: OperationId): void {
    this.commitDimEditor();
    this.endCommand();

    const op = operationById(id);
    const session = createSession(id);
    const operands = operandsFromSelection(state.selection);
    const fill = fillFromOperands(session, operands);

    state.command = session;
    state.tool = op.tool ?? 'select';
    state.snap = null;
    state.marquee = null;
    this.deps.getToolbar()?.setActiveTool(state.tool);
    this.deps.getToolbar()?.setActiveOperation(op.tool === null ? id : null);
    this.updateCursor();

    const ignored = operands.length - fill.used;
    if (ignored > 0) notify(`已忽略 ${ignored} 个不适用于「${op.label}」的选中对象`, 'info');
    if (fill.reasons[0] !== undefined) notify(fill.reasons[0], 'info');

    // 选择集一次就填满（如选好两条直线点「平行」）：立即执行，不再等 Enter
    if (isComplete(session)) {
      this.runCommand(cam.z, 'arm');
      return;
    }
    this.sync();
  }

  /** 画布点击：补当前命令的下一个参数槽位；填满立即执行 */
  clickCommand(input: ClickInput): void {
    const session = state.command;
    if (!session) return;
    const result = clickCommandOperation(session, input);
    for (const notice of result.notices) notify(notice.message, notice.kind);
    if (result.reason !== undefined) notify(result.reason, 'info');
    if (result.filled && isComplete(session)) {
      this.runCommand(input.zoom, 'click');
      return;
    }
    this.sync();
  }

  /** Enter 兜底执行当前命令（参数填满后已自动执行，正常不需要按） */
  executeCommand(zoom: number): void {
    this.runCommand(zoom, 'keyboard');
  }

  /**
   * 执行当前命令：所有触发路径（点击填满 / 选择集预填 / Enter）的唯一出口。
   * 成功走 afterSuccessfulTool 决定续接；失败按来源走 recoverFailedCommand。
   */
  private runCommand(zoom: number, source: ExecuteSource): void {
    const session = state.command;
    if (!session) return;
    if (!isComplete(session)) {
      notify('命令参数还没选齐', 'info');
      this.sync();
      return;
    }

    const outcome = executeOperation(session, zoom);
    if (outcome.kind === 'dim') {
      if (!outcome.result.ok) {
        notify(outcome.result.reason, 'error');
        this.recoverFailedCommand(session.opId, source);
        return;
      }
      // 尺寸输入框接管后续交互；命令重新起步，便于连续标注
      this.afterSuccessfulTool(session.opId, false);
      this.deps.hintEditor.openResult(outcome.result);
      this.sync();
      return;
    }

    if (!outcome.result.ok) {
      notify(outcome.result.reason, 'error');
      this.recoverFailedCommand(session.opId, source);
      return;
    }
    this.afterSuccessfulTool(session.opId, true);
    this.apply(outcome.result);
  }

  /**
   * 执行失败后的恢复：
   * - 点击触发：repeat 操作重开命令（连续模式不中断）；其余回退这一击，保留已填参数直接再点；
   * - 选择集预填触发：命令已经没法靠继续点击修复，直接放弃并回到选择工具；
   * - Enter 触发：保留可执行态，由用户 Backspace 回退或重按 Enter 重试。
   */
  private recoverFailedCommand(opId: OperationId, source: ExecuteSource): void {
    if (source === 'keyboard') {
      this.sync();
      return;
    }
    if (source === 'arm') {
      this.cancelCommand();
      return;
    }
    if (isRepeatOperation(opId)) {
      this.restartOperation(opId);
      this.sync();
      return;
    }
    this.popCommandValue();
  }

  /** 执行成功后的命令去向：repeat 操作继续同一模式，约束/编辑类回到选择，工具类续接 */
  private afterSuccessfulTool(opId: OperationId, allowContinuation: boolean): void {
    const op = operationById(opId);
    if (isRepeatOperation(opId)) {
      this.restartOperation(opId);
      return;
    }
    if (op.tool === null) {
      state.command = null;
      state.tool = 'select';
      this.deps.getToolbar()?.setActiveTool('select');
      this.deps.getToolbar()?.setActiveOperation(null);
      this.updateCursor();
      return;
    }
    const session = state.command;
    const next = allowContinuation && session ? continuationOf(session) : null;
    state.command = next ?? createSession(opId);
    state.tool = op.tool;
    this.deps.getToolbar()?.setActiveTool(op.tool);
    this.deps.getToolbar()?.setActiveOperation(null);
    this.updateCursor();
  }

  /** 重开同一操作的空会话：repeat 操作连续点、工具类操作执行成功后的公共出口 */
  private restartOperation(id: OperationId): void {
    const op = operationById(id);
    state.command = createSession(id);
    state.tool = op.tool ?? 'select';
    state.snap = null;
    state.marquee = null;
    this.deps.getToolbar()?.setActiveTool(state.tool);
    this.deps.getToolbar()?.setActiveOperation(op.tool === null ? id : null);
    this.updateCursor();
  }

  /** Backspace：回退当前命令最后一个参数 */
  popCommandValue(): void {
    const session = state.command;
    if (!session) return;
    if (popOperationValue(session)) this.sync();
  }

  /** Esc / 右键单击 / 切到选择工具：放弃命令并删掉会话新建的孤立点 */
  cancelCommand(): void {
    this.endCommand();
    state.tool = 'select';
    state.snap = null;
    state.marquee = null;
    this.deps.getToolbar()?.setActiveTool('select');
    this.deps.getToolbar()?.setActiveOperation(null);
    this.updateCursor();
    this.sync();
  }

  /** 结束会话但不动工具/工具栏（armOperation 内部用） */
  private endCommand(): void {
    const session = state.command;
    if (!session) return;
    cancelOperationSession(session);
    state.command = null;
  }

  /** 切工具/启动操作前结算尺寸输入框：合法提交、非法放弃（与旧 setTool 一致） */
  private commitDimEditor(): void {
    if (this.deps.hintEditor.editing && !this.deps.hintEditor.commit()) {
      this.deps.hintEditor.cancel();
    }
  }

  /** 命令进行中或非选择工具时用十字光标 */
  private updateCursor(): void {
    this.deps.canvas.classList.toggle(
      'is-drawing',
      state.command !== null || state.tool !== 'select',
    );
  }

  /* ======================= 其他工具栏命令 ======================= */

  toggleSnap(): void {
    state.snapEnabled = !state.snapEnabled;
    if (!state.snapEnabled) state.snap = null;
    this.deps.getToolbar()?.setSnap(state.snapEnabled);
    this.sync();
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

  /** Delete/Backspace（无命令时）：删除选中对象（级联由 model 负责），选择集清空 */
  deleteSelection(): void {
    if (state.command) {
      this.cancelCommand();
      notify('已取消当前命令', 'info');
      return;
    }
    const selection = state.selection;
    clearSelection();
    this.apply(deleteSelected(selection));
  }

  /** Esc 的清选择分支 */
  clearSelection(): void {
    clearSelection();
    this.sync();
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
    this.endCommand();
    clearModel();
    resetInteraction();
    resetToolUi(this.deps);
    this.sync();
  }

  /** 尺寸输入框提交/取消的模型侧回调 */
  commitDimValue(con: Parameters<typeof commitDim>[0], value: number): void {
    this.apply(commitDim(con, value));
  }

  rollbackDimValue(con: Parameters<typeof rollbackDim>[0], pointId?: number): void {
    this.apply(rollbackDim(con, pointId));
  }
}

/** 清空后把工具栏与光标复位到选择工具（模型/状态已由调用方清空） */
function resetToolUi(deps: EditorControlsDeps): void {
  state.tool = 'select';
  deps.getToolbar()?.setActiveTool('select');
  deps.getToolbar()?.setActiveOperation(null);
  deps.canvas.classList.remove('is-drawing');
}

/**
 * 工具栏回调适配器：main.ts 把 `editor.handlers` 交给 buildToolbar。
 * 放在本文件而不是 Editor 里，保证 editor.ts 只保留事件接线与手势状态机（§5.2 ≤250 行）。
 */
export function createToolbarHandlers(controls: EditorControls): ToolbarHandlers {
  return {
    setTool: (id) => controls.setTool(id),
    armOperation: (id) => controls.armOperation(id),
    toggleSnap: () => controls.toggleSnap(),
    fitView: () => controls.fitView(),
    exportSVG: () => controls.exportSVG(),
    clearAll: () => controls.clearAll(),
  };
}
