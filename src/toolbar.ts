/**
 * 工具栏 DOM 构建。按钮表来自 tools.ts 的 TOOLS 与 config/constraints-meta 的 CONSTRAINT_ACTIONS，
 * 动作由调用方（Editor）注入。
 */

import { CONSTRAINT_ACTIONS } from './config';
import { TOOLS, type ConstraintAction } from './tools';
import type { ToolId } from './types';

export interface ToolbarHandlers {
  setTool(id: ToolId): void;
  applyConstraint(kind: ConstraintAction): void;
  toggleSnap(): void;
  toggleFixed(): void;
  toggleConstruction(): void;
  fitView(): void;
  exportSVG(): void;
  clearAll(): void;
}

export interface ToolbarHandle {
  setActive(id: ToolId): void;
  setSnap(on: boolean): void;
}

export function buildToolbar(root: HTMLElement, handlers: ToolbarHandlers): ToolbarHandle {
  const toolButtons = new Map<ToolId, HTMLButtonElement>();

  const addButton = (
    label: string,
    title: string,
    onClick: () => void,
    className?: string,
  ): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    if (className) b.classList.add(className);
    b.addEventListener('click', onClick);
    root.appendChild(b);
    return b;
  };

  for (const t of TOOLS) {
    toolButtons.set(
      t.id,
      addButton(t.label, `${t.key.toUpperCase()} 键`, () => handlers.setTool(t.id)),
    );
  }

  const addSeparator = (): void => {
    const sep = document.createElement('div');
    sep.className = 'sep';
    root.appendChild(sep);
  };
  addSeparator();

  for (const c of CONSTRAINT_ACTIONS) {
    addButton(c.label, '给选中图形加约束', () => handlers.applyConstraint(c.id));
  }
  addSeparator();

  const snapBtn = addButton(
    '吸附',
    '开/关吸附（S 键切换）',
    () => handlers.toggleSnap(),
    'is-toggle',
  );
  addButton('固定', '固定/解锁选中图形的点', () => handlers.toggleFixed());
  addButton('构造', '切换选中图元的构造线虚显/导出虚线', () => handlers.toggleConstruction());
  addButton('适应', '缩放显示整张草图', () => handlers.fitView());
  addButton('导出SVG', '下载当前草图', () => handlers.exportSVG());
  addButton('清空', '删除所有图元', () => handlers.clearAll());

  return {
    setActive(id: ToolId): void {
      for (const [tid, b] of toolButtons) b.classList.toggle('is-active', tid === id);
    },
    setSnap(on: boolean): void {
      snapBtn.classList.toggle('is-active', on);
      snapBtn.title = on ? '吸附：开（S 键切换）' : '吸附：关（S 键切换）';
    },
  };
}
