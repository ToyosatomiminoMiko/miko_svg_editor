/**
 * 出版排版编辑器的消息区与确认框（替代 `alert/confirm`，页面独立于草图模式）。
 *
 * 是什么：错误提示进 miko_ui 消息区（自动消失）；info 提示写进底部状态行；
 * `ask` 用 miko_ui 面板 + 按钮自绘阻塞式确认（Promise<boolean>）。
 * 为什么单独一份而不复用 `ui/notify.ts`：那个模块是草图模式的模块级单例，初始化与
 * `.app-*` 样式绑定在一起；map.html 只加载 `styles-page.css`，需要 `.page-*` 自己的
 * 消息区与确认框样式，同时保持「不弹原生 alert」的同一条约定。
 * 元信息：作者 frontend，2026-10-27。
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

/** 通知区的宿主节点：消息区 + 底部状态行两段文案 */
export interface PageNotifierHosts {
  /** 消息区宿主（固定定位的 `.page-notices`） */
  readonly noticesHost: HTMLElement;
  /** 状态行左侧的瞬时提示文案（info） */
  readonly messageEl: HTMLElement;
  /** 状态行右侧的持久状态（脏标记/保存中/元素数） */
  readonly stateEl: HTMLElement;
}

/** 简单消息出口：错误自动消失，info 在状态行闪示 */
export class PageNotifier {
  private readonly area: MessageAreaHandle;
  private readonly hosts: PageNotifierHosts;
  /** 消息区当前条目；`MessageList` 只接受整批 render，删除靠本模块维护清单 */
  private entries: MessageEntry[] = [];
  /** info 文案的自动清除计时器：新消息覆盖旧消息时先取消旧的 */
  private messageTimer: number | null = null;
  private disposed = false;

  constructor(hosts: PageNotifierHosts) {
    this.hosts = hosts;
    this.area = createMessageArea({
      modifier: 'message-area--unframed',
      class: 'page-notice-list',
    });
    hosts.noticesHost.append(this.area.element);
  }

  /** 瞬时提示：写状态行，TOAST_DURATION_MS 后清空（不覆盖状态行右侧的持久状态） */
  info(message: string): void {
    if (this.disposed) return;
    this.hosts.messageEl.textContent = message;
    this.hosts.messageEl.classList.add('is-flash');
    if (this.messageTimer !== null) window.clearTimeout(this.messageTimer);
    this.messageTimer = window.setTimeout(() => {
      this.messageTimer = null;
      this.hosts.messageEl.textContent = '';
      this.hosts.messageEl.classList.remove('is-flash');
    }, TOAST_DURATION_MS);
  }

  /** 持久状态：脏标记、保存中、元素数（不会被 info 的计时器清掉） */
  setState(text: string): void {
    if (this.disposed) return;
    this.hosts.stateEl.textContent = text;
  }

  /** 错误提示：进消息区并自动消失 */
  error(message: string): void {
    if (this.disposed) return;
    const entry: MessageEntry = { level: 'error', message };
    this.entries = [...this.entries, entry];
    this.area.list.render(this.entries);
    window.setTimeout(() => {
      if (this.disposed) return;
      this.entries = this.entries.filter((item) => item !== entry);
      this.area.list.render(this.entries);
    }, TOAST_DURATION_MS);
  }

  /**
   * 自绘确认框：确定/Enter → true；取消/Esc/点遮罩 → false。
   * 用 capture 监听键盘，避免同一次按键再触发编辑器的 Delete/方向键快捷键。
   */
  ask(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const overlay = create_element({ tag: 'div' }, { class: 'page-confirm-overlay' });
      const text = create_element({ tag: 'p' }, { class: 'page-confirm-text' }, message);
      const actions = create_element({ tag: 'div' }, { class: 'page-confirm-actions' });
      const cancel = createButton({ text: '取消' });
      const confirm = createButton({ text: '确定', class: 'page-confirm-primary' });
      actions.append(cancel.element, confirm.element);

      const panel = createPanel({
        title: '确认',
        class: 'page-confirm-panel',
        body: [text, actions],
      });
      panel.element.setAttribute('role', 'dialog');
      panel.element.setAttribute('aria-modal', 'true');
      overlay.append(panel.element);
      document.body.append(overlay);

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
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          finish(true);
        }
      };
      cancel.onClick(() => finish(false));
      confirm.onClick(() => finish(true));
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) finish(false);
      });
      window.addEventListener('keydown', onKey, true);
      confirm.element.focus();
    });
  }

  /** 卸载：清消息与计时器（页面关闭/单次卸载用） */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.messageTimer !== null) window.clearTimeout(this.messageTimer);
    this.entries = [];
    this.area.list.clear();
    this.area.element.remove();
  }
}
