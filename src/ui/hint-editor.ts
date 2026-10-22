/**
 * 尺寸数值输入框：DOM 生命周期、输入解析与非法态。
 * 只负责输入框本身，不碰模型：提交后的赋值与求解由宿主回调（Editor）完成。
 *
 * 回填必须用全精度 String(dimValue(con))。formatDimValue 是「画布标注显示」的格式，
 * 若拿它回填输入框，「打开已有尺寸再回车」会把 12.345 静默改成 12.35（BUG-2）。
 * 解析抽成独立纯模块 parse-dim-input.ts，便于在 node 环境单测；
 * 语义：空串/纯空白、非有限、<=0 都是非法，允许小数与指数写法（如 1.5e3），
 * 不再依赖 Number('') === 0 的隐式行为。
 */

import { dimLabel, dimValue } from '../dimensions';
import type { DimConstraint } from '../dimensions';
import type { DimResult } from '../sketch-actions';
import { notify, notifyAll } from './notify';
import { parseDimInput } from './parse-dim-input';
import type { ParseDimResult } from './parse-dim-input';

/** 保持 hint-editor 作为尺寸输入解析的对外入口，已有调用方不必改 import */
export { parseDimInput };
export type { ParseDimResult };

/** 底部提示栏里的尺寸输入框节点，由 main.ts 从 index.html 取出后传入 */
export interface HintHandle {
  root: HTMLElement;
  text: HTMLElement;
  editor: HTMLElement;
  label: HTMLElement;
  input: HTMLInputElement;
}

/** 一次尺寸编辑会话；created 表示本次刚创建，取消时要回滚约束（及新建的点） */
export interface DimSession {
  con: DimConstraint;
  created: boolean;
  pointId?: number;
}

/** 宿主回调：把「输入值」翻译成模型操作，输入框不直接 import model/solver */
export interface HintEditorHost {
  onCommit(con: DimConstraint, value: number): void;
  onCancel(session: DimSession): void;
}

export class HintEditor {
  private readonly hint: HintHandle;
  private readonly host: HintEditorHost;
  private session: DimSession | null = null;
  private lastStatus = '';

  constructor(hint: HintHandle, host: HintEditorHost) {
    this.hint = hint;
    this.host = host;
    this.bind();
  }

  /** 是否正在编辑（键盘路由据此把按键让给输入框） */
  get editing(): boolean {
    return this.session !== null;
  }

  /** 更新底部状态文案（工具说明 + 选中数 + 吸附）；文案没变就不写 DOM */
  updateStatus(toolHint: string | undefined, summary: string, snapEnabled: boolean): void {
    const parts: string[] = [];
    if (toolHint) parts.push(toolHint);
    if (summary) parts.push(summary);
    if (!snapEnabled) parts.push('吸附已关');
    const text = parts.join(' · ');
    if (text === this.lastStatus) return;
    this.lastStatus = text;
    this.hint.text.textContent = text;
  }

  /** 尺寸领域操作结果：失败提示，成功打开输入框（求解提示原样转成 toast） */
  openResult(result: DimResult): void {
    if (!result.ok) {
      notify(result.reason, 'error');
      return;
    }
    notifyAll(result.notices);
    this.open(result.con, result.created, result.pointId);
  }

  /** 打开输入框：回填当前值并延后聚焦；label 用 DIM_META 的文案 */
  open(con: DimConstraint, created = false, pointId?: number): void {
    this.session = { con, created, pointId };
    const { root, editor, label, input } = this.hint;
    root.classList.add('is-editing');
    editor.hidden = false;
    label.textContent = dimLabel(con);
    input.value = String(dimValue(con));
    input.classList.remove('is-invalid');
    input.removeAttribute('title');
    // 延后一个任务再聚焦：pointerdown 的默认行为会把焦点移到 body，立即 focus 会被立刻 blur
    window.setTimeout(() => {
      if (this.session?.con !== con) return;
      input.focus();
      input.select();
    }, 0);
  }

  /** 提交输入；非法时保持编辑（红框 + 焦点）并返回 false */
  commit(): boolean {
    const session = this.session;
    if (!session) return true;
    const parsed = parseDimInput(this.hint.input.value);
    if (!parsed.ok) {
      this.hint.input.classList.add('is-invalid');
      this.hint.input.title = parsed.reason;
      this.hint.input.focus();
      this.hint.input.select();
      return false;
    }
    this.session = null;
    this.hideDom();
    this.host.onCommit(session.con, parsed.value);
    return true;
  }

  /** 取消输入：DOM 收尾后把会话交给宿主做模型回滚 */
  cancel(): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    this.hideDom();
    this.host.onCancel(session);
  }

  private hideDom(): void {
    const { root, editor, input } = this.hint;
    editor.hidden = true;
    root.classList.remove('is-editing');
    input.blur();
  }

  private bind(): void {
    const { input } = this.hint;

    input.addEventListener('keydown', (ev) => {
      // 输入框聚焦时画布的单键快捷键（v/l/c/...）必须失效
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.commit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this.cancel();
      }
    });
    input.addEventListener('input', () => {
      input.classList.remove('is-invalid');
      input.removeAttribute('title');
    });
    // Tab 等失焦也按提交处理；hideDom 已先清 session，blur 回调不会重入
    input.addEventListener('blur', () => {
      if (this.session) this.commit();
    });

    // capture 阶段先于画布 pointerdown：点输入框以外先结算输入；
    // 非法输入保持编辑并吞掉这次点击，避免用户带着未确认的值继续操作
    window.addEventListener(
      'pointerdown',
      (ev) => {
        if (!this.session) return;
        if (this.hint.editor.contains(ev.target as Node | null)) return;
        if (!this.commit()) {
          ev.stopPropagation();
          ev.preventDefault();
        }
      },
      true,
    );
  }
}
