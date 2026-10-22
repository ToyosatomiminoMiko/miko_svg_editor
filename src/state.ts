/**
 * 编辑器的交互状态。只有一份，由 editor.ts / editor-controls.ts / selection.ts 修改、renderer.ts 读取。
 * 选择集拆成 { ents, pts }；框选只存屏幕坐标；手势瞬态（拖拽/平移）放在 Editor 的 gesture 字段，
 * 不写进模型（Point 不再有 dragging 标记）。
 */

import type { EditorState, Selection } from './types';

export const state: EditorState = {
  tool: 'select',
  cursorWorld: { x: 0, y: 0 },
  snap: null,
  snapEnabled: true,
  hoverPt: null,
  hoverEnt: null,
  pending: null,
  selection: { ents: [], pts: [] },
  marquee: null,
};

export const setSelection = (selection: Selection): void => {
  state.selection = selection;
};

export const clearSelection = (): void => {
  state.selection = { ents: [], pts: [] };
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

/** 只选中给定 id（点/图元分开传，保持 Selection 的语义不混用） */
export const selectOnly = (ents: number[] = [], pts: number[] = []): void => {
  state.selection = { ents, pts };
};

/** Shift 加选：与已有选择求并集，重复 id 只保留一份 */
export const addSelection = (selection: Selection): void => {
  state.selection = {
    ents: [...new Set([...state.selection.ents, ...selection.ents])],
    pts: [...new Set([...state.selection.pts, ...selection.pts])],
  };
};

/** Shift 单击：在对应的 id 集合里切换单个选中项 */
export const toggleSelected = (kind: 'ent' | 'pt', id: number): void => {
  if (kind === 'ent') {
    const ents = state.selection.ents;
    state.selection = {
      ...state.selection,
      ents: ents.includes(id) ? ents.filter((x) => x !== id) : ents.concat(id),
    };
  } else {
    const pts = state.selection.pts;
    state.selection = {
      ...state.selection,
      pts: pts.includes(id) ? pts.filter((x) => x !== id) : pts.concat(id),
    };
  }
};

/** 选中数量：底部提示文案只读这里，不反查模型 */
export const selectionCounts = (): { ents: number; pts: number } => ({
  ents: state.selection.ents.length,
  pts: state.selection.pts.length,
});
