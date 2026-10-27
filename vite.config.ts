/**
 * Vite 配置：多页入口 + 本地库联调白名单。
 *
 * 是什么：
 *   - 两个 HTML 入口：`index.html`（约束草图编辑器）与 `map.html`（地图出版排版编辑器）；
 *   - base 固定为 './'，产物可放到任意静态目录预览；
 *   - 本地库（默认 /mnt/IVSTINIANVS/__projects_web/miko_ui，MIKO_UI_DIR 可覆盖）可用时，
 *     把它的真实路径加入 server.fs.allow：软链后的 miko_ui 位于项目根之外，
 *     Vite dev 默认只允许工作区根，会以 403 拒绝服务；
 *   - resolve.dedupe 固定 @preact/signals-core，避免根 node_modules 与链接库各解析出一份
 *     signals 实例（signal 身份不一致会让响应式失效）。
 *
 * 为什么没有代理与子进程：map.html 已改为纯静态前端——底图与 geo 由用户在浏览器里上传、
 * 终稿也在浏览器内合成，开发期只需要 Vite 本身，不再有后端要转发或拉起。
 *
 * 为什么用 process.getBuiltinModule 取 fs / path，而不是 import ...：
 *   本仓库 tsconfig 用 types: ["vite/client"] 且没装 @types/node，直接 import node 内置模块会让
 *   npm run typecheck 与 ESLint 的 no-unsafe-* 规则报「缺声明」；tsconfig 不在本文件可改范围内。
 *   Node 20.16+ / 22.3+ 的 process.getBuiltinModule 在运行期返回同一批内置模块，语义等价，
 *   这里用最小接口标注类型，不引入 any。
 *
 * 元信息：作者 deps-plumber，2026-10-22 加入本地库联调支持；线上 / CI 仍走 npm 发布版。
 *         作者 cleanup，2026-10-28 移除地图模式的后端代理与子进程管理（map.html 改为纯静态前端）。
 */
import { defineConfig, searchForWorkspaceRoot } from 'vite';

/** process 的最小结构：只声明运行期用到的成员，避免依赖 @types/node。 */
interface NodeProcessLike {
  cwd(): string;
  env: Record<string, string | undefined>;
  getBuiltinModule(id: string): unknown;
}

/** node:fs 的最小结构。 */
interface FsLike {
  existsSync(target: string): boolean;
}

/** node:path 的最小结构。 */
interface PathLike {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
}

const nodeProcess = (globalThis as unknown as { process: NodeProcessLike }).process;
const fs = nodeProcess.getBuiltinModule('fs') as FsLike;
const path = nodeProcess.getBuiltinModule('path') as PathLike;

/** 与 scripts/dev_ui_link.mjs 保持一致：本地库工作副本的默认位置。 */
const DEFAULT_LOCAL_UI_DIR = '/mnt/IVSTINIANVS/__projects_web/miko_ui';
const localUiDir = path.resolve(nodeProcess.env.MIKO_UI_DIR ?? DEFAULT_LOCAL_UI_DIR);

/** 本地库可用 = 存在构建产物 dist/index.js（软链指过去后消费者 import 的就是它）。 */
const hasLocalUi = fs.existsSync(path.join(localUiDir, 'dist', 'index.js'));

/**
 * 开发服务器端口：唯一真值就是本文件。
 *
 * 为什么写死在配置里：README 与文档都指向 http://localhost:5173/map.html；端口只在这里定义一次，
 * 就没有第二份真值可漂移。strictPort 让端口被占时直接报错，而不是像默认行为那样悄悄换成 5174
 * 让文档里的地址失真。
 */
const SITE_PORT = 5173;

export default defineConfig({
  // 产物用相对路径，方便直接把 dist 放到任意静态目录下预览
  base: './',

  build: {
    // 两个独立 HTML 入口：草图编辑器与地图出版排版编辑器，互不共享运行时状态。
    rollupOptions: {
      input: {
        main: path.resolve(nodeProcess.cwd(), 'index.html'),
        map: path.resolve(nodeProcess.cwd(), 'map.html'),
      },
    },
  },

  server: {
    port: SITE_PORT,
    strictPort: true,

    fs: {
      // 只在本地库存在时覆盖默认白名单；不存在时保持 undefined，行为与不配置时完全一致。
      // 必须显式带上 searchForWorkspaceRoot：一旦设置 allow 就不再自动搜索工作区根。
      allow: hasLocalUi ? [searchForWorkspaceRoot(nodeProcess.cwd()), localUiDir] : undefined,
    },
  },

  resolve: {
    // 链接库时 miko_ui 从项目根之外解析，避免与根 node_modules 里的副本各持一份 signals。
    dedupe: ['@preact/signals-core'],
  },
});
