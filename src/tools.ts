/**
 * 工具与约束按钮的元数据。
 * 只放数据，DOM 构建见 toolbar.ts，快捷键与提示文案消费这里的定义。
 */

import type { ConstraintKind, ToolId } from './types';

export interface ToolMeta {
  id: ToolId;
  label: string;
  /** 单键快捷键（小写） */
  key: string;
  hint: string;
}

export const TOOLS: readonly ToolMeta[] = [
  { id: 'select', label: '选择', key: 'v', hint: '点图元/点 · Shift 加选 · 空白拖框选（下→上交叉 / 上→下窗口） · Delete 删除' },
  { id: 'line', label: '直线', key: 'l', hint: '点两下画直线，可连续画 · 右键/Esc 结束' },
  { id: 'circle', label: '圆', key: 'c', hint: '先点圆心，再点半径' },
  { id: 'arc', label: '圆弧', key: 'a', hint: '圆心 → 起点 → 终点' },
  { id: 'rect', label: '矩形', key: 'r', hint: '两个对角点，自动加水平/竖直约束' },
  { id: 'dim', label: '尺寸', key: 'd', hint: '点两点标距离 · 点线标长度 · 点圆/弧标半径 · 点已有尺寸改值' },
  { id: 'erase', label: '删除', key: 'e', hint: '点击要删的点或图形' },
];

/**
 * 约束按钮的动作名。
 * 注意 tangent 是 UI 动作，会按选中图元类型转成 tangentLC / tangentCC。
 */
export type ConstraintAction =
  | Extract<ConstraintKind, 'horizontal' | 'vertical' | 'parallel' | 'perpendicular' | 'equalLength'>
  | 'tangent'
  | Extract<ConstraintKind, 'concentric' | 'equalRadius'>;

export interface ConstraintButton {
  id: ConstraintAction;
  label: string;
}

export const CONSTRAINT_BUTTONS: readonly ConstraintButton[] = [
  { id: 'horizontal', label: '水平' },
  { id: 'vertical', label: '竖直' },
  { id: 'parallel', label: '平行' },
  { id: 'perpendicular', label: '垂直' },
  { id: 'equalLength', label: '等长' },
  { id: 'tangent', label: '相切' },
  { id: 'concentric', label: '同心' },
  { id: 'equalRadius', label: '等半径' },
];
