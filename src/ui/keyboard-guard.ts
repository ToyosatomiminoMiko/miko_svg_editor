/**
 * 全局键盘守卫:模态层打开时,以及焦点落在"自己消费键盘"的控件上时,编辑器快捷键让路.
 *
 * 是什么:模块级模态计数(`acquireModalGuard` / `releaseModalGuard` / `isModalOpen`)与
 * `isEditableTarget`(输入框/下拉框/contenteditable 判定).
 * 为什么需要:样式设置窗口与确认对话框是**模态**的,但它们的焦点在 `div[role=dialog]` 或
 * 按钮上,画布编辑器挂在 window 上的 keydown(Delete/方向键/空格/工具字母)会穿透:
 * 样式窗口开着时按 Delete 会删掉画布选中的元素,而且页面编辑器没有撤销(数据丢失).
 * 确认框开着时同理(草图编辑器还会按工具字母切换工具).用计数器而不是布尔:模态可以叠加
 * (样式窗口上再弹确认框),最后一个关闭才恢复快捷键.
 * 为什么不把焦点陷阱也放这里:焦点循环由各模态自己的 Tab 处理,本文件只负责"快捷键让路"
 * 这一条跨模块契约,避免编辑器认识具体的窗口类.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-08.
 */

/** 当前打开的模态层数(0 = 没有模态,快捷键正常) */
let modalDepth = 0;

/** 模态层打开时调用(与 releaseModalGuard 成对,放在 try/finally 或 open/close 两处) */
export function acquireModalGuard(): void {
  modalDepth += 1;
}

/** 模态层关闭时调用;多于 acquire 时夹到 0,避免任何异常路径把快捷键永久锁死 */
export function releaseModalGuard(): void {
  modalDepth = Math.max(0, modalDepth - 1);
}

/** 是否有模态层打开(编辑器 keydown 的第一道放行检查) */
export function isModalOpen(): boolean {
  return modalDepth > 0;
}

/** 供编辑器判断焦点是否在可编辑控件/表单控件上(这些键不该被编辑器抢) */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}
