/**
 * 入口：用 miko_ui 的 DOM 原语装配应用外壳（画布 + 工具栏 / 状态栏 / 通知区宿主），
 * 读主题与文本测量适配器，组装 Editor 与工具栏。
 *
 * 样式加载顺序是契约：先引库的 token + 字体 + 控件 + 反馈样式，
 * 再引应用自己的页面与布局样式（后者可以覆盖 token，也可以给消费者类写规则）。
 */

import 'miko_ui/styles.css';
import './styles.css';
import { create_element } from 'miko_ui';
import { Editor } from './editor';
import { readTheme } from './theme';
import { buildToolbar } from './toolbar';
import { initNotifications } from './ui/notify';
import { createTextMeasurer } from './ui/measure-text';

const app = document.getElementById('app');
if (!app) throw new Error('index.html 缺少 #app');

// 画布是应用自己的背景层（不是库的组件）：铺满 #app，交互事件归 Editor。
const canvas = create_element(
  { tag: 'canvas', into: app },
  { id: 'canvas', class: 'app-canvas', 'aria-label': 'SVG 草图编辑画布' },
);
const toolbarRoot = create_element({ tag: 'div', into: app }, { class: 'app-toolbar' });
const selectionRoot = create_element({ tag: 'div', into: app }, { class: 'app-selection' });
const statusRoot = create_element({ tag: 'div', into: app }, { class: 'app-status' });
const noticesRoot = create_element({ tag: 'div', into: app }, { class: 'app-notices' });

// 主题只在这里读一次，之后由 Renderer/Editor 通过构造参数使用（§5.1 依赖注入）
const theme = readTheme();
const measureText = createTextMeasurer();

const editor = new Editor(canvas, statusRoot, selectionRoot, theme, measureText);
// info 级提示走状态栏闪示，error 级进 miko_ui 的消息区（见 ui/notify.ts）
initNotifications(noticesRoot, (message) => editor.flashInfo(message));

const toolbar = buildToolbar(toolbarRoot, editor.handlers);
editor.bindToolbar(toolbar);
