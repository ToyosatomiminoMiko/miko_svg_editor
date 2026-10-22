/**
 * 轻量 UI 反馈：错误/提示统一走 miko_ui 的消息区，确认框用 miko_ui 的面板 + 按钮自绘，
 * 替代散落的 window.alert/confirm（BUG-9）。
 *
 * 两级提示的分工：
 * - info 级不占位置：交给宿主回调（main.ts 接到状态栏闪示，见 HintEditor.flashInfo）；
 * - error 级进 MessageArea：库统一提供 aria-live 容器与条目外观，TOAST_DURATION_MS
 *   后自动移除并重渲染。
 *
 * 本模块的 UI 节点全部由 miko_ui 的 DOM 原语装配，只把 .app-* 类名交给应用样式表，
 * 不写内联样式、不 import CSS（样式加载顺序由 main.ts 负责）。
 * 初始化前产生的提示先排队，initNotifications 之后按到达顺序 flush，
 * 这样 main.ts「先构造 Editor 再接线通知」的装配顺序不会丢提示。
 */

import {
  create_element,
  createButton,
  createMessageArea,
  createPanel,
  type MessageAreaHandle,
  type MessageEntry,
} from 'miko_ui';
import { TOAST_DURATION_MS } from '../config';
import type { Notice } from '../sketch-actions';

export type NoticeKind = 'info' | 'error';

/** 初始化前到达的一条提示；等消息区/状态栏就位后按原顺序处理 */
interface PendingNotice {
  readonly message: string;
  readonly kind: NoticeKind;
}

/** 消息区句柄（`.app-notices` 宿主里的 `.app-notice-list`）；null = 尚未初始化 */
let area: MessageAreaHandle | null = null;
/** info 级提示的出口（状态栏首行闪示）；null = 尚未初始化 */
let infoHandler: ((message: string) => void) | null = null;
/**
 * 当前消息区里的条目。
 * MessageList 只接受「整批替换」的 render()，没有按 id 删除单条的接口，
 * 所以移除某一条由本模块自己维护这份清单：filter 后再整批 render。
 */
let entries: MessageEntry[] = [];
/** 初始化前的提示队列 */
const pending: PendingNotice[] = [];

/**
 * 渲染一条错误提示，并在 TOAST_DURATION_MS 后移除。
 * 计时器回调读的是最新的 entries（期间可能又来了新错误），只摘掉自己那一条。
 */
function renderError(message: string): void {
  const current = area;
  if (!current) return;
  const entry: MessageEntry = { level: 'error', message };
  entries = [...entries, entry];
  current.list.render(entries);
  window.setTimeout(() => {
    entries = entries.filter((item) => item !== entry);
    current.list.render(entries);
  }, TOAST_DURATION_MS);
}

/**
 * 初始化通知宿主：在 `.app-notices` 里建 miko_ui 消息区，并接上 info 级提示的出口。
 * 调用前 notify() 产生的提示会在这里按到达顺序补发（info 交给状态栏首行、error 进消息区）。
 *
 * @param host 通知宿主（`.app-notices` 空 div）
 * @param onInfo info 级提示的接收者；main.ts 传 `(message) => editor.flashInfo(message)`
 */
export function initNotifications(host: HTMLElement, onInfo: (message: string) => void): void {
  const created = createMessageArea({
    // 宿主不是窗口正文，自己不带框体，所以用库的无框变体（避免两层描边 + 多余内边距）
    modifier: 'message-area--unframed',
    class: 'app-notice-list',
  });
  host.append(created.element);
  area = created;
  infoHandler = onInfo;

  // flush 队列：顺序即到达顺序；处理时必须用局部变量，因为 notify 不再往队列里写
  const queued = pending.splice(0);
  for (const notice of queued) {
    if (notice.kind === 'info') onInfo(notice.message);
    else renderError(notice.message);
  }
}

/** 非阻塞提示：info 走状态栏首行闪示，error 自动消失，都不拦截任何点击 */
export function notify(message: string, kind: NoticeKind = 'info'): void {
  if (kind === 'info') {
    if (infoHandler) infoHandler(message);
    else pending.push({ message, kind });
    return;
  }
  if (area) renderError(message);
  else pending.push({ message, kind });
}

/** 批量发出领域操作产生的提示（求解失败、重复约束等） */
export function notifyAll(notices: readonly Notice[]): void {
  for (const notice of notices) notify(notice.message, notice.kind);
}

/**
 * 自绘确认框：返回 Promise<boolean>，确定/Enter → true，取消/Esc/点遮罩 → false。
 * 用 capture 监听键盘，避免同一次按键再触发编辑器的单键快捷键；
 * 打开后焦点落在「确定」上，Enter 是默认动作。
 */
export function askConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    // 覆盖层没有宿主可挂，只能挂到 document.body；节点本身仍由 create_element 建
    const overlay = create_element({ tag: 'div' }, { class: 'app-confirm-overlay' });
    const text = create_element({ tag: 'p' }, { class: 'app-confirm-text' }, message);
    const actions = create_element({ tag: 'div' }, { class: 'app-confirm-actions' });
    const cancel = createButton({ text: '取消' });
    const confirm = createButton({ text: '确定', class: 'app-confirm-primary' });
    actions.append(cancel.element, confirm.element);

    const panel = createPanel({
      title: '确认',
      class: 'app-confirm-panel',
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
