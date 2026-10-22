/**
 * 编辑器的交互状态。只有一份，由 editor.ts 修改、renderer.ts 读取。
 */

import type { EditorState } from './types';

export const state: EditorState = {
  tool: 'select',
  cursorW: { x: 0, y: 0 },
  snap: null,
  snapEnabled: true,
  hoverPt: null,
  hoverEnt: null,
  pending: null,
  sel: [],
  marquee: null,
};
