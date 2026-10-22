/**
 * 入口：装配应用外壳（左侧状态栏 / 顶部 dock / 画布 / 通知区），读主题与文本测量
 * 适配器，组装 Editor 与工具栏。
 *
 * 外壳的网格与宿主由 ui/app-shell.ts 建（状态栏在左、dock 在顶、画布填剩余区域，
 * 侧栏宽度可拖拽）；状态面板把「已选择」列表与状态文案/尺寸输入合在同一栏里
 * （见 ui/status-panel.ts）。
 *
 * 样式加载顺序是契约：先引库的 token + 字体 + 控件 + 反馈样式，
 * 再引应用自己的页面与布局样式（后者可以覆盖 token，也可以给消费者类写规则）。
 */

import 'miko_ui/styles.css';
import './styles.css';
import { Editor } from './editor';
import { readTheme } from './theme';
import { buildToolbar } from './toolbar';
import { mountAppShell } from './ui/app-shell';
import { createTextMeasurer } from './ui/measure-text';
import { initNotifications } from './ui/notify';

const app = document.getElementById('app');
if (!app) throw new Error('index.html 缺少 #app');

// 画布、状态栏、dock、通知区的宿主与画布节点都在外壳里；网格定位见 styles.css
const shell = mountAppShell(app);

// 主题只在这里读一次，之后由 Renderer/Editor 通过构造参数使用（§5.1 依赖注入）
const theme = readTheme();
const measureText = createTextMeasurer();

const editor = new Editor(shell.canvas, shell.sidebarRoot, theme, measureText);
// info 级提示走状态行闪示，error 级进 miko_ui 的消息区（见 ui/notify.ts）
initNotifications(shell.noticesRoot, (message) => editor.flashInfo(message));

const toolbar = buildToolbar(shell.dockRoot, editor.handlers);
editor.bindToolbar(toolbar);
