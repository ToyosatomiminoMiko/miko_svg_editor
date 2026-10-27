/**
 * 地图模式组合根：冻结底图 + 场景叠加层 + 保存即合成。
 *
 * 是什么：探测 studio（`GET /api/doc`）→ 载入 `scene.json` → 用显式 id 重建模型 →
 * 构造 Editor（地图主题 + 透明画布 + 每帧同步底图）→ 适应底图整幅 → 接上保存/快捷键/未保存保护。
 * 为什么组合根放在 app 层：模式装配要同时用到 core（scene/camera/viewport）、render（map-theme）、
 * ui（base-layer/scene-file/toolbar/notify）与 Editor，只有 app 层允许这样跨层组装。
 * 底图的硬边界（设计 D3）：这里只把底图 URL 交给 BaseLayer 当 `<img>` 显示，
 * 不解析、不读它的 SVG DOM、不回写——编辑不到比约定不编辑更强。
 * 单图单文档：model/state/cam 都是模块级单例，切图 = 重新载入页面（v1 明确非目标）。
 */

import { MAPDOC_ZOOM_MAX, MAPDOC_ZOOM_MIN } from '../config';
import { setZoomRange } from '../core/camera';
import {
  applyScene,
  mapStyle,
  sceneCounts,
  serializeScene,
  validateScene,
  type SceneDoc,
} from '../core/scene';
import { fitBounds } from '../core/viewport';
import type { MeasureText } from '../core/types';
import type { CameraView } from '../core/camera';
import { mapTheme } from '../render/map-theme';
import type { Theme } from '../render/theme';
import { BaseLayer } from '../ui/base-layer';
import { fetchDoc, fetchScene, rememberDoc, saveScene, type MapDoc } from '../ui/scene-file';
import { askConfirm, initNotifications, notify } from '../ui/notify';
import { buildToolbar, type ToolbarHandlers } from '../ui/toolbar';
import type { AppShellHandle } from '../ui/app-shell';
import { Editor } from './editor';

/** 地图模式启动所需的宿主与注入依赖（由 main.ts 提供，与草图模式共用外壳） */
export interface MapModeArgs {
  /** 页面根 `#app`：地图模式给它加 `is-map` 类（透明画布等规则挂在这个类下） */
  readonly root: HTMLElement;
  readonly shell: AppShellHandle;
  /** 基础主题：地图模式经 mapTheme() 覆盖线帽等差异项 */
  readonly theme: Theme;
  readonly measureText: MeasureText;
}

/** 未保存保护的比对基线：文档语义的 JSON 串，与长度/顺序一起覆盖 */
type SceneSignature = string;

const signature = (): SceneSignature => JSON.stringify(serializeScene());

/**
 * 尝试进入地图模式；studio 不可用（无 /api/doc）或场景无法载入时返回 false，
 * 由 main.ts 回退草图模式（`?mode=sketch` 则直接不尝试）。
 */
export async function startMapMode(args: MapModeArgs): Promise<boolean> {
  let doc: MapDoc;
  try {
    doc = await fetchDoc();
  } catch {
    // studio 没起时探测失败是正常路径（草图模式仍然可用），不打扰用户
    return false;
  }

  let sceneDoc: SceneDoc;
  try {
    sceneDoc = await fetchScene();
  } catch (error) {
    // 通知区还没初始化：notify 会先排队，随后 initNotifications（无论哪个模式）按序补发
    notify(`载入 scene.json 失败：${String(error)}`, 'error');
    return false;
  }

  rememberDoc(doc);
  const issues = validateScene(sceneDoc);
  applyScene(sceneDoc);
  let baseline = signature();

  // 缩放上限/下限必须在 Editor 构造（或首次 fit）之前设好：clampZoom 是单例状态
  setZoomRange(MAPDOC_ZOOM_MIN, MAPDOC_ZOOM_MAX);
  args.root.classList.add('is-map');

  // 底图声明尺寸与画布尺寸一致（canvas_changed 就是尺寸不一致）；底图按声明尺寸布局
  const width = doc.canvas.width_pt;
  const height = doc.canvas.height_pt;
  const baseLayer = new BaseLayer(args.shell.mapHost);
  baseLayer.setBase({
    url: doc.base.url,
    width_pt: doc.base.width_pt,
    height_pt: doc.base.height_pt,
  });

  // dock 的可访问名沿用草图说法会误导读屏用户；地图模式的 dock 仍是同一套工具
  args.shell.dockRoot.setAttribute('aria-label', '地图标注工具');

  const editor = new Editor(
    args.shell.canvas,
    args.shell.sidebarRoot,
    mapTheme(args.theme, mapStyle),
    args.measureText,
    {
      renderer: {
        // 地图模式：不铺底色、不画网格（底图自己就是背景），每帧末尾同步底图变换
        paintBackground: false,
        paintGrid: false,
        onFrame: (view: CameraView) => baseLayer.sync(view),
      },
    },
  );
  initNotifications(args.shell.noticesRoot, (message) => editor.flashInfo(message));

  /** 保存中标志：单飞，避免 Ctrl+S 连按写出两份不同的 scene */
  let saving = false;

  const updateTitle = (): void => {
    const now = sceneCounts();
    document.title = `${doc.figure.key} · ${now.entities} 图元 / ${now.constraints} 约束`;
  };

  const reportProblems = (): void => {
    for (const issue of issues) notify(`场景校验：${issue}`, 'error');
    for (const warning of doc.warnings) notify(warning, 'error');
    if (doc.needs.render) notify('底图缺失或不合法：请先在 Python 侧渲染生成 base.svg', 'error');
    if (doc.needs.ack) notify('底图已更新（同尺寸内容变化）：保存时需要确认', 'error');
  };

  /**
   * 保存：PUT scene → studio 规范化写盘 → 尝试 compose。
   * base_changed 走一次显式确认（409 + ack_base_change 重提），canvas_changed 要求刷新页面。
   */
  const save = async (): Promise<void> => {
    if (saving) return;
    saving = true;
    try {
      let ack = false;
      for (;;) {
        const outcome = await saveScene(ack);
        if (outcome.ok) {
          baseline = signature();
          updateTitle();
          const report = outcome.report;
          if (outcome.composed) editor.flashInfo('已保存并合成 final.svg');
          else editor.flashInfo('场景已保存，合成排队中（底图正在重渲染？）');
          if (outcome.marker) {
            editor.flashInfo(
              `final 已更新：${outcome.marker.counts.entities} 图元 / ${outcome.marker.counts.constraints} 约束`,
            );
          }
          for (const warning of report?.warnings ?? []) notify(warning, 'error');
          if (report && report.out_of_canvas.length > 0) {
            notify(`有 ${report.out_of_canvas.length} 个对象落在画布之外（成品会被裁掉）`, 'error');
          }
          return;
        }
        if (outcome.code === 'base_changed' && !ack) {
          const accepted = await askConfirm(
            '底图已更新（内容/投影可能变化），叠加层位置需复查。仍要保存？',
          );
          if (!accepted) return;
          ack = true;
          continue;
        }
        if (outcome.code === 'canvas_changed') {
          notify('画布尺寸已变（底图重新渲染过），请刷新页面后重试保存', 'error');
          return;
        }
        if (outcome.code === 'invalid_scene') {
          notify(`场景校验失败：${outcome.message}`, 'error');
          return;
        }
        notify(`保存失败：${outcome.message}`, 'error');
        return;
      }
    } finally {
      saving = false;
    }
  };

  // 地图模式的工具栏：适应/保存/成品；约束与绘图按钮沿用草图内核
  const handlers: ToolbarHandlers = {
    ...editor.handlers,
    fitView: () => {
      fitBounds(width, height);
      editor.refresh();
    },
    saveScene: () => void save(),
    openFinal: () => {
      window.open(doc.final.url, '_blank', 'noopener');
    },
  };
  const toolbar = buildToolbar(args.shell.dockRoot, handlers, 'map');
  editor.bindToolbar(toolbar);

  // 适应底图整幅必须在 Editor 构造之后（构造器里 renderer.resize() 才写真实视口尺寸）
  fitBounds(width, height);
  editor.refresh();
  updateTitle();
  reportProblems();
  editor.flashInfo(`地图模式：${Math.round(width)}×${Math.round(height)}pt，Ctrl+S 保存并合成`);

  // Ctrl+S：Editor 的按键路由对带修饰键的组合直接返回，所以这里单独监听不会冲突
  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    void save();
  });

  // 未保存保护：比对文档语义签名（不做浏览器本地持久化，避免第二份真值）
  window.addEventListener('beforeunload', (event) => {
    if (signature() === baseline) return;
    event.preventDefault();
  });

  return true;
}
