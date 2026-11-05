/**
 * 出版排版编辑器的消息区与确认框(替代 `alert/confirm`,页面独立于草图模式).
 *
 * 是什么:错误提示进 miko_ui 消息区(自动消失);info 提示写进底部状态行;
 * `ask` 用 miko_ui 面板 + 按钮自绘阻塞式确认(Promise<boolean>).
 * 为什么另有一份模块:本模式的初始化入口与 `.page-*` 样式绑定在一起;map.html 只加载
 * `styles-page.css`,需要 `.page-*` 自己的消息区与确认框类名,同时保持「不弹原生 alert」
 * 的同一条约定.确认框与错误条目清单的公共实现见 `ui/notify-core.ts`,本模块只保留
 * `.page-*` 宿主,状态行文案(info 覆盖/持久状态)与 PageNotifier 的对外 API.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-05.
 */

import { TOAST_DURATION_MS } from '../config/ui';
import { askConfirmDialog, NoticeEntryList } from './notify-core';

/** 通知区的宿主节点:消息区 + 底部状态行两段文案 */
export interface PageNotifierHosts {
  /** 消息区宿主(固定定位的 `.page-notices`) */
  readonly noticesHost: HTMLElement;
  /** 状态行左侧的瞬时提示文案(info) */
  readonly messageEl: HTMLElement;
  /** 状态行右侧的持久状态(元素数/选中项/未导出标记) */
  readonly stateEl: HTMLElement;
}

/** 简单消息出口:错误自动消失,info 在状态行闪示 */
export class PageNotifier {
  private readonly entries: NoticeEntryList;
  private readonly hosts: PageNotifierHosts;
  /** info 文案的自动清除计时器:新消息覆盖旧消息时先取消旧的 */
  private messageTimer: number | null = null;
  private disposed = false;

  constructor(hosts: PageNotifierHosts) {
    this.hosts = hosts;
    this.entries = new NoticeEntryList(hosts.noticesHost, 'page-notice-list');
  }

  /** 瞬时提示:写状态行,TOAST_DURATION_MS 后清空(不覆盖状态行右侧的持久状态) */
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

  /** 持久状态:元素数/选中项/未导出标记(不会被 info 的计时器清掉) */
  setState(text: string): void {
    if (this.disposed) return;
    this.hosts.stateEl.textContent = text;
  }

  /** 错误提示:进消息区并自动消失 */
  error(message: string): void {
    if (this.disposed) return;
    this.entries.add(message);
  }

  /**
   * 自绘确认框:确定/Enter -> true;取消/Esc/点遮罩 -> false.
   * 用 capture 监听键盘,避免同一次按键再触发编辑器的 Delete/方向键快捷键.
   */
  ask(message: string): Promise<boolean> {
    return askConfirmDialog(message, 'page');
  }

  /** 卸载:清消息与计时器(页面关闭/单次卸载用) */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.messageTimer !== null) window.clearTimeout(this.messageTimer);
    this.entries.dispose();
  }
}
