/**
 * 轻量 UI 反馈：非阻塞 toast 与自绘确认框，替代散落的 window.alert/confirm（BUG-9）。
 * DOM 结构与外观在 overlays.css 里定义，本文件只负责创建、排队、移除与焦点。
 */

import { TOAST_DURATION_MS } from '../config';
import './overlays.css';
import type { Notice } from '../sketch-actions';

export type NoticeKind = 'info' | 'error';

let toastHost: HTMLElement | null = null;

/** 延迟创建 toast 容器：通知是低频操作，文档加载完再建即可 */
function getToastHost(): HTMLElement {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }
  return toastHost;
}

/** 非阻塞提示：自动消失，不拦截任何点击 */
export function notify(message: string, kind: NoticeKind = 'info'): void {
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  getToastHost().appendChild(el);
  window.setTimeout(() => el.remove(), TOAST_DURATION_MS);
}

/** 批量发出领域操作产生的提示（求解失败、重复约束等） */
export function notifyAll(notices: readonly Notice[]): void {
  for (const notice of notices) notify(notice.message, notice.kind);
}

/**
 * 自绘确认框：返回 Promise<boolean>，确定/Enter → true，取消/Esc/点遮罩 → false。
 * 用 capture 监听键盘，避免同一次按键再触发编辑器的单键快捷键。
 */
export function askConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    const box = document.createElement('div');
    box.className = 'confirm-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    const text = document.createElement('p');
    text.className = 'confirm-text';
    text.textContent = message;

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'confirm-btn';
    cancel.textContent = '取消';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'confirm-btn confirm-btn--primary';
    confirm.textContent = '确定';
    actions.append(cancel, confirm);

    box.append(text, actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const finish = (value: boolean): void => {
      window.removeEventListener('keydown', onKey, true);
      overlay.remove();
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

    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) finish(false);
    });
    window.addEventListener('keydown', onKey, true);
    confirm.focus();
  });
}
