/**
 * 两套通知 UI 的共享实现：自绘确认框 + 消息区错误条目清单。
 *
 * 是什么：`ui/notify.ts`（草图模式 `.app-*`）与 `ui/page-notify.ts`（出版排版 `.page-*`）
 * 曾经各写一份逐字相同的确认框和「追加错误条目、TOAST_DURATION_MS 后移除」的清单管理；
 * 差异只有宿主节点与 CSS 类名前缀，所以把公共行为收在这里，差异留给各自模块。
 * 为什么单独一层：两模块都要保持自己的对外 API 与 DOM 类名契约，不能合并成一个模块；
 * 共享实现只做 DOM/组件逻辑，不接触任何应用状态，宿主与类名前缀全部由调用方传入。
 * 分层：只依赖 miko_ui 与 config，不反向 import 应用层。
 */

import {
  create_element,
  createButton,
  createMessageArea,
  createPanel,
  type MessageAreaHandle,
  type MessageEntry,
} from 'miko_ui';
import { TOAST_DURATION_MS } from '../config/ui';

/**
 * 通知区 CSS 类名前缀：草图模式用 `app`（`.app-notice-list` / `.app-confirm-*`），
 * 出版排版用 `page`（`.page-notice-list` / `.page-confirm-*`）。
 * 只影响生成的类名，不影响任何行为；两套样式表各自按既有类名命中。
 */
export type NoticeStylePrefix = 'app' | 'page';

/**
 * 消息区错误条目清单。
 *
 * 为什么需要这个类：miko_ui 的 MessageList 只接受「整批替换」的 render()，没有按条删除的
 * 接口；所以「追加一条 → 到期只摘自己那一条」必须由调用方维护当前条目与计时器。
 * 每条提示的计时器独立：期间来了新错误，旧计时器到期时只过滤掉自己，不影响其他条目。
 */
export class NoticeEntryList {
  private readonly area: MessageAreaHandle;
  /** 当前消息区里的条目（render 的输入） */
  private entries: MessageEntry[] = [];
  /** 每条错误各自的移除计时器；clear/dispose 时一并取消，保证卸载后不再渲染 */
  private readonly timers = new Set<number>();

  /**
   * 在宿主里建消息区并接管条目渲染。
   *
   * @param host 消息区宿主（`.app-notices` / `.page-notices` 空 div）
   * @param listClass 消息区根上的消费方类名（`.app-notice-list` / `.page-notice-list`）
   */
  constructor(host: HTMLElement, listClass: string) {
    this.area = createMessageArea({
      // 宿主不是窗口正文，自己不带框体，所以用库的无框变体（避免两层描边 + 多余内边距）
      modifier: 'message-area--unframed',
      class: listClass,
    });
    host.append(this.area.element);
  }

  /** 消息区容器根，供调用方在卸载时移除 */
  get element(): HTMLElement {
    return this.area.element;
  }

  /** 追加一条错误提示，并在 TOAST_DURATION_MS 后摘掉它（期间新增的条目不受影响） */
  add(message: string): void {
    const entry: MessageEntry = { level: 'error', message };
    this.entries = [...this.entries, entry];
    this.area.list.render(this.entries);
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      this.entries = this.entries.filter((item) => item !== entry);
      this.area.list.render(this.entries);
    }, TOAST_DURATION_MS);
    this.timers.add(timer);
  }

  /** 清空条目并取消所有待触发的移除计时器（卸载语义的一半，另一半是移除容器根） */
  clear(): void {
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    this.entries = [];
    this.area.list.clear();
  }

  /** 卸载：先停掉计时器与条目，再把消息区容器根从宿主摘掉，之后不再有任何渲染 */
  dispose(): void {
    this.clear();
    this.area.element.remove();
  }
}

/**
 * 自绘确认框的公共实现：返回 Promise<boolean>，确定/Enter → true，取消/Esc/点遮罩 → false。
 * 用 capture 监听键盘，避免同一次按键再触发编辑器的单键快捷键；
 * 打开后焦点落在「确定」上，Enter 是默认动作。
 *
 * @param prefix 类名前缀（`app` / `page`），决定 `.app-confirm-*` 还是 `.page-confirm-*`
 */
export function askConfirmDialog(message: string, prefix: NoticeStylePrefix): Promise<boolean> {
  return new Promise((resolve) => {
    // 覆盖层没有宿主可挂，只能挂到 document.body；节点本身仍由 create_element 建
    const overlay = create_element({ tag: 'div' }, { class: `${prefix}-confirm-overlay` });
    const text = create_element({ tag: 'p' }, { class: `${prefix}-confirm-text` }, message);
    const actions = create_element({ tag: 'div' }, { class: `${prefix}-confirm-actions` });
    const cancel = createButton({ text: '取消' });
    const confirm = createButton({ text: '确定', class: `${prefix}-confirm-primary` });
    actions.append(cancel.element, confirm.element);

    const panel = createPanel({
      title: '确认',
      class: `${prefix}-confirm-panel`,
      body: [text, actions],
    });
    // 面板默认 role="region"；确认框是模态对话，改成 dialog 并保留标题作为可访问名
    panel.element.setAttribute('role', 'dialog');
    panel.element.setAttribute('aria-modal', 'true');
    overlay.append(panel.element);
    document.body.append(overlay);

    /** 只结算一次：清理监听与节点后 resolve */
    let done = false;
    const finish = (value: boolean): void => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', onKey, true);
      overlay.remove();
      cancel.dispose();
      confirm.dispose();
      resolve(value);
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        ev.stopPropagation();
        finish(true);
      }
    };

    cancel.onClick(() => finish(false));
    confirm.onClick(() => finish(true));
    overlay.addEventListener('click', (ev) => {
      // 只有点在遮罩本身（不是面板内部）才算取消
      if (ev.target === overlay) finish(false);
    });
    window.addEventListener('keydown', onKey, true);
    confirm.element.focus();
  });
}
