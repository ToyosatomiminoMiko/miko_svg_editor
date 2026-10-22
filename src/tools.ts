/**
 * 绘图工具的元数据：工具栏顺序、单键快捷键与提示文案。
 * 只放数据，DOM 构建见 toolbar.ts；约束按钮表不在这里，
 * 单一来源是 config/constraints-meta 的 CONSTRAINT_ACTIONS。
 */

import type { ToolId } from './types';

interface ToolMeta {
  id: ToolId;
  label: string;
  /** 单键快捷键（小写） */
  key: string;
  hint: string;
}

export const TOOLS: readonly ToolMeta[] = [
  {
    id: 'select',
    label: '选择',
    key: 'v',
    hint: '点图元/点 · Shift 加选 · 空白拖框选（下→上交叉 / 上→下窗口） · Delete 删除',
  },
  { id: 'line', label: '直线', key: 'l', hint: '点两下画直线，可连续画 · 右键/Esc 结束' },
  { id: 'circle', label: '圆', key: 'c', hint: '先点圆心，再点半径' },
  { id: 'arc', label: '圆弧', key: 'a', hint: '圆心 → 起点 → 终点' },
  { id: 'rect', label: '矩形', key: 'r', hint: '两个对角点，自动加水平/竖直约束' },
  {
    id: 'dim',
    label: '尺寸',
    key: 'd',
    hint: '点两点标距离 · 点线标长度 · 点圆/弧标半径 · 点已有尺寸改值',
  },
  { id: 'erase', label: '删除', key: 'e', hint: '点击要删的点或图形' },
];

/** 约束动作 id：单一来源是 config/constraints-meta，这里转发便于 UI 层统一从工具元数据取类型 */
export type { ConstraintAction } from './config';
