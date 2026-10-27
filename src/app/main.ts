/**
 * 草图编辑器入口：装配应用外壳（左侧状态栏 / 顶部 dock / 画布 / 通知区），读主题与文本
 * 测量适配器，然后装配草图编辑器。
 *
 * 是什么：`index.html` 唯一入口，只装配约束草图编辑器。
 * 为什么地图出版排版编辑器不在这里：它是一条平行的产品线（`map.html` →
 * `src/app/page-main.ts`），有独立的纸张/文字/图例数据流（见 docs/PAGE-EDITOR.md），
 * 与草图内核不共享模块级单例，因此入口、外壳与样式都独立装配。
 * 外壳的网格与宿主由 ui/app-shell.ts 建；样式加载顺序是契约：先引库的 token + 字体 +
 * 控件 + 反馈样式，再引应用自己的页面与布局样式。
 */

import 'miko_ui/styles.css';
import '../styles.css';
import { readTheme } from '../render/theme';
import { mountAppShell } from '../ui/app-shell';
import { createTextMeasurer } from '../ui/measure-text';
import { buildToolbar } from '../ui/toolbar';
import { initNotifications } from '../ui/notify';
import { Editor } from './editor';

const found = document.getElementById('app');
if (!found) throw new Error('index.html 缺少 #app');
// 显式标注类型：TS 的收窄不会带进闭包（boot 里要用），这里把它们钉成非空类型
const appRoot: HTMLElement = found;

// 画布、状态栏、dock、通知区的宿主与画布节点都在外壳里；网格定位见 styles.css
const shell = mountAppShell(appRoot);

// 主题只在这里读一次，之后由 Renderer/Editor 通过构造参数使用（依赖注入，见 docs/ARCHITECTURE.md）
const theme = readTheme();
const measureText = createTextMeasurer();

/** 草图编辑器装配 */
function startSketchMode(): void {
  const editor = new Editor(shell.canvas, shell.sidebarRoot, theme, measureText);
  // info 级提示走状态行闪示，error 级进 miko_ui 的消息区（见 ui/notify.ts）
  initNotifications(shell.noticesRoot, (message) => editor.flashInfo(message));
  const toolbar = buildToolbar(shell.dockRoot, editor.handlers);
  editor.bindToolbar(toolbar);
}

startSketchMode();
