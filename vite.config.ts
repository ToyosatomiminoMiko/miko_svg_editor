/**
 * Vite 配置：基础产物路径 + 本地库联调时的文件服务白名单 + 地图模式 studio 的代理与自动启动。
 *
 * 是什么：
 *   - base 固定为 './'，产物可放到任意静态目录预览；
 *   - 本地库（默认 /mnt/IVSTINIANVS/__projects_web/miko_ui，MIKO_UI_DIR 可覆盖）可用时，
 *     把它的真实路径加入 server.fs.allow：软链后的 miko_ui 位于项目根之外，
 *     Vite dev 默认只允许工作区根，会以 403 拒绝服务；
 *   - resolve.dedupe 固定 @preact/signals-core，避免根 node_modules 与链接库各解析出一份
 *     signals 实例（signal 身份不一致会让响应式失效）；
 *   - server.proxy 把 `/api`、`/base.svg`、`/final.svg`、`/overlay.svg` 代理到 studio
 *     （Python 侧 127.0.0.1:8791，MAPDOC_STUDIO_PORT 可覆盖）；
 *   - studioDevPlugin 在 dev server 启动时顺带拉起 `python3 tools/studio.py`，Vite 退出时
 *     一起结束，省掉「再开第二个终端跑后端」。
 *
 * 为什么需要 studio 代理：`npm run dev` 时页面在 Vite dev server 上，studio 在另一个端口；
 * scene-file 用的是同源相对 URL（`/api/doc`、`/base.svg`…），浏览器直连会跨域被打断，
 * 代理后开发期与「studio 直接服务 dist」的生产形态走同一批相对路径。
 * 为什么端口读 process 而不是写死 8791：端口是 tools/studio.toml 的配置项；studio.py 启动时
 * 也读同名环境变量 MAPDOC_STUDIO_PORT，所以代理目标与自动拉起的后端永远一致，测试同时起
 * 多个 studio 时不会互相抢端口。
 * 为什么自动拉起时要禁浏览器：studio.toml 的 open_browser = true 是给「直接跑 studio 服务
 * dist」的形态用的；开发期页面在 Vite 上，再弹一个 8791 的旧 dist 页只会让人困惑，因此子进程
 * 环境里默认写 MAPDOC_OPEN_BROWSER=0（外部显式设过就尊重外部值）。
 * 为什么启动前先探活：studio 可能已经在另一个终端里跑着（手工调试 / 多实例），复用比再起一个
 * （会因端口占用直接退出）更符合直觉。
 * 为什么自动拉起失败只告警不退出：前端草图模式不依赖 studio，拉不起来时页面仍可开发
 * （地图模式会回退草图模式），把原因打在 Vite 日志里比让 dev server 起不来更有用。
 * 为什么改 vite.config.ts 时 studio 不跟着重启：dev server 重建是「先建新实例、再关旧实例」，
 * 新实例探活会接管旧实例拉起的进程，旧实例关闭时发现世代已被接管就不再结束它（见 StudioDevState）。
 *
 * 为什么用 process.getBuiltinModule 取 fs / path / child_process，而不是 import ...：
 *   本仓库 tsconfig 用 types: ["vite/client"] 且没装 @types/node，直接 import node 内置模块会让
 *   npm run typecheck 与 ESLint 的 no-unsafe-* 规则报「缺声明」；tsconfig 不在本任务可改范围内。
 *   Node 20.16+ / 22.3+ 的 process.getBuiltinModule 在运行期返回同一批内置模块，语义等价，
 *   这里用最小接口标注类型，不引入 any。
 *
 * 元信息：作者 deps-plumber，2026-10-22 加入本地库联调支持；线上 / CI 仍走 npm 发布版。
 *         作者 fe-render-ui，2026-10-27 加入地图模式 studio 代理（impl-contract.md §6）、
 *         studio 自动启动与跨 dev server 重启的进程接管（studioDevPlugin）。
 */
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import type { Plugin, ViteDevServer } from 'vite';

/** process 的最小结构：只声明运行期用到的成员，避免依赖 @types/node。 */
interface NodeProcessLike {
  cwd(): string;
  env: Record<string, string | undefined>;
  getBuiltinModule(id: string): unknown;
  once(event: 'exit', listener: () => void): void;
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

/** node:child_process 的最小子进程结构：只声明自动拉起 studio 用到的成员。 */
interface ChildProcessLike {
  kill(signal?: string): boolean;
  on(event: 'error' | 'exit', listener: (payload?: unknown) => void): void;
}

/** node:child_process 的最小模块结构。 */
interface ChildProcessModuleLike {
  spawn(
    command: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: Record<string, string | undefined>;
      stdio: 'inherit';
    },
  ): ChildProcessLike;
}

const nodeProcess = (globalThis as unknown as { process: NodeProcessLike }).process;
const fs = nodeProcess.getBuiltinModule('fs') as FsLike;
const path = nodeProcess.getBuiltinModule('path') as PathLike;
const childProcessModule = nodeProcess.getBuiltinModule('child_process') as ChildProcessModuleLike;

/** 与 scripts/dev_ui_link.mjs 保持一致：本地库工作副本的默认位置。 */
const DEFAULT_LOCAL_UI_DIR = '/mnt/IVSTINIANVS/__projects_web/miko_ui';
const localUiDir = path.resolve(nodeProcess.env.MIKO_UI_DIR ?? DEFAULT_LOCAL_UI_DIR);

/** 本地库可用 = 存在构建产物 dist/index.js（软链指过去后消费者 import 的就是它）。 */
const hasLocalUi = fs.existsSync(path.join(localUiDir, 'dist', 'index.js'));

/** studio 的端口：与 tools/studio.toml 的 [studio].port 默认值一致，studio.py 也读同名环境变量。 */
const studioPort = nodeProcess.env.MAPDOC_STUDIO_PORT ?? '8791';
const studioOrigin = `http://127.0.0.1:${studioPort}`;
const studioHealthUrl = `${studioOrigin}/api/health`;

/** 健康探测：单次超时与轮询间隔（毫秒）。探测本身很快，间隔小一点能让 Vite 尽早进入就绪。 */
const STUDIO_PROBE_TIMEOUT_MS = 500;
const STUDIO_PROBE_INTERVAL_MS = 150;
/** 等 studio 就绪的上限：首次启动要跑一遍 startup compose，给足余量。 */
const STUDIO_READY_TIMEOUT_MS = 15000;
/** 启动尝试次数与间隔：首次没起来（端口刚释放/慢启动）时再试一次，避免一次抖动就回退草图模式。 */
const STUDIO_START_ATTEMPTS = 2;
const STUDIO_RETRY_DELAY_MS = 500;
/** python 解释器：默认 python3，特殊环境（如虚拟环境里的 python）用 MAPDOC_PYTHON 指定。 */
const pythonCommand = nodeProcess.env.MAPDOC_PYTHON ?? 'python3';

/** 等待若干毫秒（轮询用）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 单次探测 studio 健康端点：能连上且返回 2xx 才算就绪（含「已有实例在跑」）。 */
async function probeStudio(): Promise<boolean> {
  try {
    const response = await fetch(studioHealthUrl, {
      signal: AbortSignal.timeout(STUDIO_PROBE_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    // 连不上 / 超时 / 端口被非 studio 进程占用：都当作「没就绪」，由调用方决定启不启。
    return false;
  }
}

/**
 * 轮询健康端点直到 studio 就绪、子进程退出或超时。
 * isAlive 返回 false 表示本次拉起的子进程已经退出，此时不必等满超时（例如端口被占直接退出）。
 */
async function waitForStudioReady(isAlive: () => boolean): Promise<boolean> {
  const deadline = Date.now() + STUDIO_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeStudio()) return true;
    if (!isAlive()) return false;
    await sleep(STUDIO_PROBE_INTERVAL_MS);
  }
  return probeStudio();
}

/**
 * 编辑 vite.config.ts 会让 Vite 在同一个 Node 进程里重建 dev server（先建新实例、再关旧实例）。
 * 这份状态挂在 globalThis 上跨实例共享，让 studio 不跟着重启：重启要多跑一遍 startup compose，
 * 而且新实例先探活会看到旧 studio、旧实例随后关闭又把它杀掉（实测会留下一个死掉的后端）。
 */
interface StudioDevState {
  /** 每次 dev server 建立 +1；只有最新世代负责在关闭时结束 studio。 */
  generation: number;
  /** 本进程拉起过的 studio 子进程；外部手工起的 studio 不登记，也就不会被结束。 */
  child: ChildProcessLike | null;
  /** 是否已挂 process 'exit' 兜底清理（只挂一次，避免配置反复改动堆积监听器）。 */
  exitGuardInstalled: boolean;
}

const STUDIO_DEV_STATE_KEY = '__mapdocStudioDevState';
const globalScope = globalThis as unknown as Record<string, unknown>;

/** 取（或首次创建）跨 dev server 实例共享的 studio 进程状态。 */
function studioDevState(): StudioDevState {
  const existing = globalScope[STUDIO_DEV_STATE_KEY];
  if (existing !== undefined) return existing as StudioDevState;
  const created: StudioDevState = { generation: 0, child: null, exitGuardInstalled: false };
  globalScope[STUDIO_DEV_STATE_KEY] = created;
  return created;
}

/**
 * 在 dev server 启动 / 重启时确保 studio 在线：已在线就复用，否则拉起并在 Vite 退出时结束。
 *
 * 拉起失败（python 不在 PATH、TOML 写错、端口被别的进程占）只告警：草稿模式仍然可用，
 * 让 dev server 起不来会把排错成本推给用户。
 */
async function ensureStudio(server: ViteDevServer): Promise<void> {
  const { logger } = server.config;
  const state = studioDevState();
  const generation = state.generation + 1;
  state.generation = generation;

  if (!state.exitGuardInstalled) {
    state.exitGuardInstalled = true;
    // 兜底：SIGTERM / stdin 结束时 Vite 会先 server.close() 再 process.exit()，正常路径由下面的
    // close 钩子负责；这里覆盖没走到 close 的 process.exit。
    nodeProcess.once('exit', () => {
      state.child?.kill('SIGTERM');
    });
  }

  let closed = false;
  // vite 的 HttpServer 类型引用了 @types/node，本仓库没装；这里只用 once 挂一个关闭钩子。
  const httpServer = server.httpServer as unknown as CloseEventSourceLike | null;
  httpServer?.once('close', () => {
    closed = true;
    // 配置改动触发的 dev server 重启：新实例已经接管，不结束 studio，否则新实例会看到一个刚断开的后端。
    if (state.generation !== generation) return;
    const child = state.child;
    state.child = null;
    // 用 SIGTERM 而不是 SIGINT：Python 默认对 SIGTERM 直接终止，不依赖子进程没有把 SIGINT 设成忽略。
    child?.kill('SIGTERM');
  });

  if (await probeStudio()) {
    logger.info(`[mapdoc] 复用已在运行的 studio：${studioOrigin}`);
    return;
  }

  for (let attempt = 1; attempt <= STUDIO_START_ATTEMPTS; attempt += 1) {
    if (closed) return;
    // 上一轮尝试结束时旧实例可能刚好就绪（或手工起的 studio 还在），先复探一次再拉起。
    if (await probeStudio()) {
      logger.info(`[mapdoc] 复用已在运行的 studio：${studioOrigin}`);
      return;
    }

    let exited = false;
    let spawnFailed = false;
    let child: ChildProcessLike;
    try {
      logger.info(`[mapdoc] 启动 studio：${pythonCommand} tools/studio.py（${studioOrigin}）`);
      child = childProcessModule.spawn(pythonCommand, ['tools/studio.py'], {
        cwd: nodeProcess.cwd(),
        // stdio 继承：studio 的日志（含 startup compose 结果）与 Vite 日志在同一个终端。
        env: {
          ...nodeProcess.env,
          MAPDOC_OPEN_BROWSER: nodeProcess.env.MAPDOC_OPEN_BROWSER ?? '0',
        },
        stdio: 'inherit',
      });
    } catch (error) {
      logger.warn(
        `[mapdoc] 无法启动 studio（${pythonCommand}）：${String(error)}；地图模式会回退草图模式`,
      );
      return;
    }
    state.child = child;

    child.on('error', (error) => {
      exited = true;
      spawnFailed = true;
      if (state.child === child) state.child = null;
      logger.warn(
        `[mapdoc] studio 启动失败：${String(error)}（检查 ${pythonCommand} 是否在 PATH 上）`,
      );
    });
    child.on('exit', () => {
      exited = true;
      if (state.child === child) state.child = null;
    });

    if (await waitForStudioReady(() => !exited)) {
      logger.info(`[mapdoc] studio 已就绪：${studioOrigin}（Ctrl+C 会一起结束）`);
      return;
    }

    // 没就绪：结束本次尝试（spawnFailed 时进程本就起不来），需要的话再试一次。
    child.kill('SIGTERM');
    if (state.child === child) state.child = null;
    if (spawnFailed) return;
    if (attempt < STUDIO_START_ATTEMPTS) await sleep(STUDIO_RETRY_DELAY_MS);
  }

  if (!closed) {
    logger.warn(
      `[mapdoc] studio 未能就绪（${studioOrigin}）：单独运行 ${pythonCommand} tools/studio.py ` +
        '可看到完整报错；地图模式会回退草图模式',
    );
  }
}

/** HTTP server 的最小结构：只声明本文件用来挂「关闭时结束 studio」的 once。 */
interface CloseEventSourceLike {
  once(event: 'close', listener: () => void): void;
}

/** dev server 插件：让 `vite` / `npm run dev` 顺带管理 studio 进程（build / preview 不触发）。 */
function studioDevPlugin(): Plugin {
  return {
    name: 'mapdoc-studio-dev-server',
    apply: 'serve',
    async configureServer(server) {
      await ensureStudio(server);
    },
  };
}

export default defineConfig({
  // 产物用相对路径，方便直接把 dist 放到任意静态目录下预览
  base: './',

  plugins: [studioDevPlugin()],

  server: {
    fs: {
      // 只在本地库存在时覆盖默认白名单；不存在时保持 undefined，行为与不配置时完全一致。
      // 必须显式带上 searchForWorkspaceRoot：一旦设置 allow 就不再自动搜索工作区根。
      allow: hasLocalUi ? [searchForWorkspaceRoot(nodeProcess.cwd()), localUiDir] : undefined,
    },

    // 开发期把 studio 的端点转发到同一源：页面用相对 URL，与生产形态（studio 服务 dist）一致。
    // 注意 `/api` 是前缀匹配，/api/health、/api/doc 等都在其中。
    proxy: {
      '/api': studioOrigin,
      '/base.svg': studioOrigin,
      '/final.svg': studioOrigin,
      '/overlay.svg': studioOrigin,
    },
  },

  resolve: {
    // 链接库时 miko_ui 从项目根之外解析，避免与根 node_modules 里的副本各持一份 signals。
    dedupe: ['@preact/signals-core'],
  },
});
