/**
 * 绘图工具的元数据：工具栏顺序、单键快捷键与提示文案。
 * 只放数据，DOM 构建见 toolbar.ts；约束/编辑按钮表来自 operations.ts 的
 * CONSTRAINT_OPERATIONS / EDIT_OPERATIONS（单一来源），这里不重复。
 *
 * 提示文案按统一命令模型写：工具点击只是启动一个参数槽位化操作，
 * 参数在画布上补齐，填满立即执行、Backspace 回退、Esc 取消。
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
  {
    id: 'point',
    label: '点',
    key: 'p',
    hint: '点位置放独立点 · 吸附到已有点会把它提升为独立点',
  },
  {
    id: 'line',
    label: '直线',
    key: 'l',
    hint: '点起点、终点自动画线 · 连续画自动接上一段终点 · Esc/右键结束',
  },
  { id: 'circle', label: '圆', key: 'c', hint: '点圆心、半径位置自动创建' },
  { id: 'arc', label: '圆弧', key: 'a', hint: '圆心 → 起点 → 终点自动创建' },
  { id: 'rect', label: '矩形', key: 'r', hint: '点两个对角点自动创建 · 自动补水平/竖直约束' },
  {
    id: 'dim',
    label: '尺寸',
    key: 'd',
    hint: '点目标即标注 · 两点距离 / 线长 / 半径 / 改已有尺寸',
  },
  { id: 'erase', label: '删除', key: 'e', hint: '点对象即删除 · 可继续点 · Esc/右键结束' },
];

/** 约束操作 id：单一来源是 operations.ts，这里转发便于 UI 层统一取的措辞 */
export type { ConstraintOperationId } from './operations';
