/**
 * 状态区（当前操作 / 操作提示两行）与尺寸数值输入：DOM 生命周期、输入解析与非法态。
 * 只负责输入框本身，不碰模型：提交后的赋值与求解由宿主回调（Editor）完成。
 * 左侧栏外壳（标题、已选择列表与两个插槽）在 status-panel.ts；本类只往下半区插槽里装配。
 *
 * 结构全部用 miko_ui 的公开件装配（create_element / createNumberField /
 * createNumberRow / createValueDisplay）：状态区是两个 `<output>` 读数，各由一条 signal
 * 驱动 —— 上行是当前操作（命令进度或所选工具），下行是其他提示（按键说明、已选数、吸附），
 * 两者分处不同的 `<output>`，不拼进同一行。
 * info 级提示闪示时临时改写上行（操作）的 signal，到时恢复基础文案；下行提示不参与闪示。
 * 外观只靠类名（app-status-* / app-dim-*）交给应用样式表，本文件不写内联样式、不 import CSS。
 *
 * 回填必须用全精度 String(dimValue(con))。formatDimValue 是「画布标注显示」的格式，
 * 若拿它回填输入框，「打开已有尺寸再回车」会把 12.345 静默改成 12.35（BUG-2）。
 * NumberField 默认口径 NUMBER_TEXT_EDIT 就是无损最短往返，与 String(dimValue) 同口径。
 * 解析抽成独立纯模块 parse-dim-input.ts，便于在 node 环境单测；
 * 语义：空串/纯空白、非有限、<=0 都是非法，允许小数与指数写法（如 1.5e3），
 * 不再依赖 Number('') === 0 的隐式行为。
 */

import {
  create_element,
  createNumberField,
  createNumberRow,
  createValueDisplay,
  signal,
  type NumberFieldHandle,
  type Signal,
} from 'miko_ui';
import { TOAST_DURATION_MS } from '../config';
import { dimLabel, dimValue } from '../core/dimensions';
import type { DimConstraint } from '../core/dimensions';
import type { DimResult } from '../core/sketch-actions';
import { notify, notifyAll } from './notify';
import { parseDimInput } from './parse-dim-input';
import type { ParseDimResult } from './parse-dim-input';

/** 保持 hint-editor 作为尺寸输入解析的对外入口，已有调用方不必改 import */
export { parseDimInput };
export type { ParseDimResult };

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
  private readonly host: HintEditorHost;
  /** 状态区第一行「当前操作」读数：命令进度或所选工具；info 闪示临时改写它 */
  private readonly operationSignal: Signal<string>;
  /** 状态区第二行「操作提示」读数：按键说明、已选数、吸附状态；不受 info 闪示影响 */
  private readonly hintSignal: Signal<string>;
  /** 面板正文根 `.app-status-content`；尺寸编辑期间带 is-editing */
  private readonly content: HTMLElement;
  /** 尺寸编辑行容器 `.app-dim-editor`；默认带 is-hidden，open 时移除 */
  private readonly dimEditor: HTMLElement;
  /** 尺寸字段的可见标签（createNumberRow 产出）；打开时改成 DIM_META 的文案 */
  private readonly dimLabelEl: HTMLLabelElement;
  private readonly field: NumberFieldHandle;
  /** 当前基础操作文案：info 闪示结束后恢复到这一份（期间 updateStatus 会更新它） */
  private baseOperation = '';
  /** 最近一次写入状态区的两行文案，用于「文案没变不重复写」 */
  private lastStatus = '';
  /** info 闪示的定时器；null = 当前不在闪示 */
  private flashTimer: number | null = null;
  private session: DimSession | null = null;

  /**
   * @param root 左侧状态栏的下半区插槽（`.app-status-body`）；栏体外壳见 status-panel.ts
   * @param host 模型回滚/提交回调，由 Editor 提供
   */
  constructor(root: HTMLElement, host: HintEditorHost) {
    this.host = host;

    this.content = create_element({ tag: 'div' }, { class: 'app-status-content' });
    root.append(this.content);

    // 状态区分两行：上行「当前操作」、下行「其他提示」，各是一个独立读数
    const statusText = create_element({ tag: 'div' }, { class: 'app-status-text' });
    this.operationSignal = signal('');
    this.hintSignal = signal('');
    statusText.append(
      createValueDisplay<string>({
        value: this.operationSignal,
        class: 'app-status-line app-status-operation',
      }).element,
      createValueDisplay<string>({
        value: this.hintSignal,
        class: 'app-status-line app-status-hints',
      }).element,
    );
    this.content.append(statusText);

    // 尺寸编辑行：默认隐藏；数字框与「文字 + 控件」行复用库件，只补暴露给样式的类名
    this.dimEditor = create_element({ tag: 'div' }, { class: 'app-dim-editor is-hidden' });
    const field = createNumberField({ value: 0 });
    field.element.classList.add('app-dim-field');
    const { row, label } = createNumberRow('', field);
    row.classList.add('app-dim-row');
    this.dimLabelEl = label;
    this.field = field;
    this.dimEditor.append(
      row,
      create_element({ tag: 'span' }, { class: 'app-dim-keys' }, '回车确认 · Esc 取消'),
    );
    this.content.append(this.dimEditor);

    this.bind();
  }

  /** 是否正在编辑（键盘路由据此把按键让给输入框） */
  get editing(): boolean {
    return this.session !== null;
  }

  /**
   * 更新状态区两行文案（操作 / 提示），文案没变就不写 DOM。
   * info 闪示期间操作行让给消息、只记下新文案，闪示结束后自然恢复到这份新文案；
   * 提示行不参与闪示，随时更新（一条消息不该把按键提示一起盖掉）。
   */
  updateStatus(operation: string, hint: string): void {
    const text = `${operation}\n${hint}`;
    if (text === this.lastStatus) return;
    this.lastStatus = text;
    this.baseOperation = operation;
    this.hintSignal.value = hint;
    if (this.flashTimer === null) this.operationSignal.value = operation;
  }

  /**
   * info 级提示闪示：临时占用「当前操作」那一行，TOAST_DURATION_MS 后恢复基础文案。
   * 连续闪示时重置计时器（只保留最新一条），避免前一条的计时器提前把新消息抹掉。
   */
  flashInfo(message: string): void {
    if (this.flashTimer !== null) window.clearTimeout(this.flashTimer);
    this.operationSignal.value = message;
    this.flashTimer = window.setTimeout(() => {
      this.flashTimer = null;
      this.operationSignal.value = this.baseOperation;
    }, TOAST_DURATION_MS);
  }

  /** 尺寸领域操作结果：失败提示，成功打开输入框（求解提示原样发出） */
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
    this.content.classList.add('is-editing');
    this.dimEditor.classList.remove('is-hidden');
    this.dimLabelEl.textContent = dimLabel(con);
    this.field.write(dimValue(con));
    this.clearInvalid();
    // 延后一个任务再聚焦：pointerdown 的默认行为会把焦点移到 body，立即 focus 会被立刻 blur
    window.setTimeout(() => {
      if (this.session?.con !== con) return;
      this.field.input.focus();
      this.field.input.select();
    }, 0);
  }

  /** 提交输入；非法时保持编辑（红框 + 焦点）并返回 false */
  commit(): boolean {
    const session = this.session;
    if (!session) return true;
    const parsed = parseDimInput(this.field.readText());
    if (!parsed.ok) {
      this.markInvalid(parsed.reason);
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

  /** 隐藏编辑行并退出编辑态；先由调用方清 session，blur 回调不会因此重入 */
  private hideDom(): void {
    this.dimEditor.classList.add('is-hidden');
    this.content.classList.remove('is-editing');
    this.field.input.blur();
  }

  /** 清非法态：输入事件与重新打开时都要把上一轮的红框/提示一并抹掉 */
  private clearInvalid(): void {
    const input = this.field.input;
    input.classList.remove('is-invalid');
    input.removeAttribute('title');
    input.removeAttribute('aria-invalid');
  }

  /** 标非法态并把焦点留在输入框；title 与 aria-invalid 给读屏/悬停同一个原因 */
  private markInvalid(reason: string): void {
    const input = this.field.input;
    input.classList.add('is-invalid');
    input.title = reason;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    input.select();
  }

  private bind(): void {
    const input = this.field.input;

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
    input.addEventListener('input', () => this.clearInvalid());
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
        if (this.dimEditor.contains(ev.target as Node | null)) return;
        if (!this.commit()) {
          ev.stopPropagation();
          ev.preventDefault();
        }
      },
      true,
    );
  }
}
