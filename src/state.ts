/**
 * 编辑器的交互状态。只有一份，由 editor.ts / editor-controls.ts / selection.ts 修改、renderer.ts 读取。
 * 选择集是有序的 SelectionItem 列表：顺序即用户选中顺序，已选择列表的展示顺序与
 * 「拖动任一已选图元移动全部已选」的点集都直接消费这一份顺序。
 * 框选只存屏幕坐标；手势瞬态（拖拽/平移）放在 Editor 的 gesture 字段，不写进模型。
 */

import type { EditorState, SelectionItem, SelectionKind } from './types';

export const state: EditorState = {
  tool: 'select',
  cursorWorld: { x: 0, y: 0 },
  snap: null,
  snapEnabled: true,
  hoverPt: null,
  hoverEnt: null,
  pending: null,
  selection: { items: [] },
  marquee: null,
};

/** 选择集整体替换：复制一份，调用方之后改自己的数组不会脏读 state */
export const setSelection = (items: readonly SelectionItem[]): void => {
  state.selection = { items: [...items] };
};

export const clearSelection = (): void => {
  state.selection = { items: [] };
};

/** 清空所有交互状态（不碰模型） */
export const resetInteraction = (): void => {
  state.snap = null;
  state.hoverPt = null;
  state.hoverEnt = null;
  state.pending = null;
  state.marquee = null;
  clearSelection();
};

/** 只选中给定的项；items 的顺序就是选择集顺序（框选与单击都走这一条） */
export const selectOnly = (items: readonly SelectionItem[] = []): void => {
  setSelection(items);
};

/** 从选择集里移除单项（已选列表的「移除」按钮与 Shift 反选共用） */
export const deselect = (kind: SelectionKind, id: number): void => {
  state.selection = {
    items: state.selection.items.filter((item) => item.kind !== kind || item.id !== id),
  };
};

/** Shift 加选：已有项保持原顺序，新项按传入顺序追加，重复项只保留一份 */
export const addSelection = (items: readonly SelectionItem[]): void => {
  const merged = [...state.selection.items];
  for (const item of items) {
    if (!merged.some((x) => x.kind === item.kind && x.id === item.id)) merged.push(item);
  }
  state.selection = { items: merged };
};

/** 某一项是否被显式选中（图元端点属于隐含选中，见 selection.isPointSelected） */
export const hasSelected = (kind: SelectionKind, id: number): boolean =>
  state.selection.items.some((item) => item.kind === kind && item.id === id);

/** Shift 单击：在对应种类的 id 集合里切换单项 */
export const toggleSelected = (kind: SelectionKind, id: number): void => {
  if (hasSelected(kind, id)) deselect(kind, id);
  else addSelection([{ kind, id }]);
};

/** 选中数量：底部提示文案只读这里，不反查模型 */
export const selectionCounts = (): { ents: number; pts: number } => {
  let ents = 0;
  let pts = 0;
  for (const item of state.selection.items) {
    if (item.kind === 'ent') ents++;
    else pts++;
  }
  return { ents, pts };
};
