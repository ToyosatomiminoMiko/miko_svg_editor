/**
 * 入口：装配应用外壳（左侧状态栏 / 顶部 dock / 画布 / 通知区），读主题与文本测量适配器，
 * 然后按模式装配编辑器。
 *
 * 是什么：`?mode=sketch` 强制草图模式；否则先探测 studio（`/api/doc`），可用就走地图模式
 * （app/map-mode.ts），不可用回退今天的草图 demo。
 * 为什么模式路由放在入口而不是各自判断：`model`/`state`/`cam` 是模块级单例，
 * 一次只允许装配一种模式；路由在唯一的装配点做分支，避免两套初始化互相踩。
 * 外壳的网格与宿主由 ui/app-shell.ts 建；样式加载顺序是契约：先引库的 token + 字体 +
 * 控件 + 反馈样式，再引应用自己的页面与布局样式。
 */

import 'miko_ui/styles.css';
import '../styles.css';
import { resetZoomRange } from '../core/camera';
import { readTheme } from '../render/theme';
import { mountAppShell } from '../ui/app-shell';
import { createTextMeasurer } from '../ui/measure-text';
import { buildToolbar } from '../ui/toolbar';
import { initNotifications } from '../ui/notify';
import { Editor } from './editor';
import { startMapMode } from './map-mode';

const found = document.getElementById('app');
if (!found) throw new Error('index.html 缺少 #app');
// 显式标注类型：TS 的收窄不会带进闭包（boot 里要用），这里把它们钉成非空类型
const appRoot: HTMLElement = found;

// 画布、状态栏、dock、通知区的宿主与画布节点都在外壳里；网格定位见 styles.css
const shell = mountAppShell(appRoot);

// 主题只在这里读一次，之后由 Renderer/Editor 通过构造参数使用（依赖注入，见 docs/ARCHITECTURE.md）
const theme = readTheme();
const measureText = createTextMeasurer();

/** 草图模式装配（与引入地图模式之前的行为完全一致） */
function startSketchMode(): void {
  // 地图模式若先设过缩放范围也不影响这里：草图模式显式恢复默认上下限
  resetZoomRange();
  const editor = new Editor(shell.canvas, shell.sidebarRoot, theme, measureText);
  // info 级提示走状态行闪示，error 级进 miko_ui 的消息区（见 ui/notify.ts）
  initNotifications(shell.noticesRoot, (message) => editor.flashInfo(message));
  const toolbar = buildToolbar(shell.dockRoot, editor.handlers);
  editor.bindToolbar(toolbar);
}

async function boot(): Promise<void> {
  const forced = new URLSearchParams(window.location.search).get('mode');
  if (forced === 'sketch') {
    startSketchMode();
    return;
  }
  const started = await startMapMode({ root: appRoot, shell, theme, measureText });
  if (!started) startSketchMode();
}

void boot();
