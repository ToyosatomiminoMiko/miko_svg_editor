#!/usr/bin/env node
/**
 * dev_ui_link.mjs —— 在「npm 发布版 miko_ui」与「本地库工作副本」之间切换 node_modules/miko_ui
 *
 * 是什么：
 *   本地开发时把 node_modules/miko_ui 换成指向本地库工作副本（默认
 *   /mnt/IVSTINIANVS/__projects_web/miko_ui，可用 MIKO_UI_DIR 覆盖）的符号链接；
 *   线上 / CI 仍然用 npm ci 装 registry 上的发布版。命令：link / unlink / status / auto。
 *
 * 为什么：
 *   - 库的 package.json exports 把 ./styles/*.css 直接映射到源码样式，链接后改 styles/ 零构建立即生效；
 *     但 dist/ 是构建产物，改库的 src/ 需要在库目录跑 npm run build:dist（或 tsc -p tsconfig.build.json --watch）。
 *   - 链接只发生在被 .gitignore 忽略的 node_modules/ 里，CI 与 GitHub Pages 的取用链路一个字节都不变；
 *     npm ci 即可还原成 npm 上的那一版。
 *   - MIKO_UI_LOCAL=0 让 auto 跳过（例如要验证 npm 版）；auto 的「跳过」不算失败。
 *   - 真正的失败（本地目录不合法、软链创建失败等）返回非零退出码，方便 npm script / CI 感知。
 *
 * 元信息：作者 deps-plumber（2026-10-22 创建），配合本地 / 线上两条取用链路。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** 本脚本所在目录与仓库根目录（脚本固定放在 <repo>/scripts/ 下）。 */
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

/** node_modules/miko_ui 的具体路径；link / unlink 只动这一个路径。 */
const NODE_MODULES_DIR = path.join(PROJECT_ROOT, 'node_modules');
const LINK_PATH = path.join(NODE_MODULES_DIR, 'miko_ui');

/** 本地库工作副本的默认位置，可用 MIKO_UI_DIR 覆盖。 */
const DEFAULT_LOCAL_UI_DIR = '/mnt/IVSTINIANVS/__projects_web/miko_ui';
const LOCAL_UI_DIR = path.resolve(process.env.MIKO_UI_DIR ?? DEFAULT_LOCAL_UI_DIR);
/** 库的构建产物入口；缺失说明本地副本还没 build:dist，链接过去会 import 失败。 */
const DIST_ENTRY = path.join(LOCAL_UI_DIR, 'dist', 'index.js');
const PACKAGE_NAME = 'miko_ui';

/** 统一走 stdout / stderr，避免 ESLint 的 no-console（仓库 lint 规则）与 CI 日志混杂。 */
const print = (line = '') => {
  process.stdout.write(`${line}\n`);
};
const printError = (line) => {
  process.stderr.write(`${line}\n`);
};

/** 读目录下的 package.json；不存在 / 解析失败返回 null，由调用方决定算错误还是算「未安装」。 */
function readPackageJson(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 取某个包目录的版本号，读不到时返回 'unknown'。 */
function readVersion(dir) {
  const pkg = readPackageJson(dir);
  return typeof pkg?.version === 'string' ? pkg.version : 'unknown';
}

/**
 * 检查本地库工作副本是否可以链接。三项缺一不可：
 *   1. 目录存在且是目录；
 *   2. package.json 可解析且 name === 'miko_ui'（防止 MIKO_UI_DIR 指错仓库）；
 *   3. dist/index.js 已构建（链接后消费者解析的就是构建产物）。
 */
function inspectLocalDir() {
  if (!fs.existsSync(LOCAL_UI_DIR)) {
    return { ok: false, reason: `本地库目录不存在：${LOCAL_UI_DIR}` };
  }
  if (!fs.statSync(LOCAL_UI_DIR).isDirectory()) {
    return { ok: false, reason: `本地库路径不是目录：${LOCAL_UI_DIR}` };
  }
  const pkg = readPackageJson(LOCAL_UI_DIR);
  if (pkg === null) {
    return { ok: false, reason: `本地库缺少可解析的 package.json：${LOCAL_UI_DIR}` };
  }
  if (pkg.name !== PACKAGE_NAME) {
    return {
      ok: false,
      reason: `本地库 package.json 的 name 是 "${pkg.name}"，不是 "${PACKAGE_NAME}"：${LOCAL_UI_DIR}`,
    };
  }
  if (!fs.existsSync(DIST_ENTRY)) {
    return {
      ok: false,
      reason: `本地库缺少构建产物 ${DIST_ENTRY}；请在库目录执行 npm run build:dist`,
    };
  }
  return { ok: true, version: typeof pkg.version === 'string' ? pkg.version : 'unknown' };
}

/** 判断 node_modules/miko_ui 当前形态：missing（未安装）/ link（软链）/ npm（npm 真实目录）/ other。 */
function inspectCurrent() {
  let stat;
  try {
    stat = fs.lstatSync(LINK_PATH);
  } catch {
    return { kind: 'missing' };
  }
  if (stat.isSymbolicLink()) {
    const rawTarget = fs.readlinkSync(LINK_PATH);
    // readlink 可能给相对路径（本脚本总是写绝对路径，但兼容手动创建的软链）。
    return { kind: 'link', target: path.resolve(NODE_MODULES_DIR, rawTarget) };
  }
  if (stat.isDirectory()) {
    return { kind: 'npm', version: readVersion(LINK_PATH) };
  }
  return { kind: 'other' };
}

/** 两个路径是否指向同一实体；realpath 兼容软链与真实路径写法不同、路径里含符号链接目录等情况。 */
function isSamePath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

/** link：把 node_modules/miko_ui 换成指向本地库的软链；已经正确链接则 no-op。 */
function link() {
  const local = inspectLocalDir();
  if (!local.ok) {
    printError(`[miko_ui] 无法链接本地库：${local.reason}`);
    return 1;
  }

  const current = inspectCurrent();
  if (current.kind === 'link' && isSamePath(current.target, LOCAL_UI_DIR)) {
    print(`[miko_ui] node_modules/miko_ui 已链接本地库（版本 ${local.version}），无需操作`);
    print(`  目标：${current.target}`);
    return 0;
  }

  fs.mkdirSync(NODE_MODULES_DIR, { recursive: true });
  if (current.kind === 'link') {
    // 只删软链本身，不跟随目标。
    print(`[miko_ui] 移除旧软链：${LINK_PATH} -> ${current.target}`);
    fs.unlinkSync(LINK_PATH);
  } else if (current.kind === 'npm') {
    print(`[miko_ui] 移除 node_modules 里的 npm 版 miko_ui（版本 ${current.version}）`);
    fs.rmSync(LINK_PATH, { recursive: true, force: true });
  } else if (current.kind === 'other') {
    print(`[miko_ui] 移除 node_modules/miko_ui 处的非目录文件：${LINK_PATH}`);
    fs.rmSync(LINK_PATH, { recursive: true, force: true });
  }

  fs.symlinkSync(LOCAL_UI_DIR, LINK_PATH, 'dir');
  print(`[miko_ui] 已链接本地库（版本 ${local.version}）`);
  print(`  node_modules/miko_ui -> ${LOCAL_UI_DIR}`);
  print('  提示：styles/ 改动零构建生效；改库的 src/ 需要在库目录 npm run build:dist');
  return 0;
}

/** unlink：只删除本地软链；npm 安装的真实目录不动（那是线上 / CI 的形态）。 */
function unlink() {
  const current = inspectCurrent();
  if (current.kind === 'link') {
    fs.unlinkSync(LINK_PATH);
    print(`[miko_ui] 已删除本地软链：${LINK_PATH}`);
    print('  node_modules/miko_ui 现在不存在，运行 npm ci（或 npm install）即可还原 npm 发布版');
    return 0;
  }
  if (current.kind === 'npm') {
    print(
      `[miko_ui] node_modules/miko_ui 是 npm 安装的真实目录（版本 ${current.version}），无需操作`,
    );
    return 0;
  }
  if (current.kind === 'missing') {
    print(
      '[miko_ui] node_modules/miko_ui 当前不存在；运行 npm ci（或 npm install）安装 npm 发布版',
    );
    return 0;
  }
  printError(`[miko_ui] node_modules/miko_ui 是未知文件，未删除：${LINK_PATH}`);
  return 1;
}

/** status：打印本地库可用性 + 当前 node_modules/miko_ui 是软链还是 npm 版（信息性命令，永远返回 0）。 */
function status() {
  print('[miko_ui] 取用状态');
  print(`  项目根：${PROJECT_ROOT}`);

  const local = inspectLocalDir();
  print(`  本地库目录：${LOCAL_UI_DIR}`);
  print(local.ok ? `    可用（版本 ${local.version}）` : `    不可用：${local.reason}`);

  const current = inspectCurrent();
  if (current.kind === 'link') {
    print(
      `  node_modules/miko_ui：软链 -> ${current.target}（版本 ${readVersion(current.target)}，本地开发态）`,
    );
  } else if (current.kind === 'npm') {
    print(`  node_modules/miko_ui：npm 发布版 ${current.version}（真实目录，线上 / CI 形态）`);
  } else if (current.kind === 'missing') {
    print('  node_modules/miko_ui：未安装（运行 npm ci / npm install）');
  } else {
    print(`  node_modules/miko_ui：未知文件 ${LINK_PATH}`);
  }

  print('  切换：npm run ui:link（本地库）/ npm run ui:unlink（移除软链）/ npm run ui:status');
  return 0;
}

/**
 * auto：predev 钩子用。
 * MIKO_UI_LOCAL=0 或本地库不可用时打印跳过原因并返回 0（不能挡住 npm run dev）。
 */
function auto() {
  if (process.env.MIKO_UI_LOCAL === '0') {
    print('[miko_ui] MIKO_UI_LOCAL=0，跳过自动链接（使用 npm 发布版）');
    return 0;
  }
  const local = inspectLocalDir();
  if (!local.ok) {
    print(`[miko_ui] 跳过自动链接（继续使用 npm 发布版）：${local.reason}`);
    return 0;
  }
  return link();
}

const COMMANDS = { link, unlink, status, auto };

function usage() {
  print('用法：node scripts/dev_ui_link.mjs <link|unlink|status|auto>');
  print('  link   把 node_modules/miko_ui 软链到本地库工作副本（已链接则 no-op）');
  print('  unlink 只删除本地软链；npm 安装的真实目录不动');
  print('  status 打印当前是软链还是 npm 版，以及本地库可用性');
  print('  auto   predev 钩子用：MIKO_UI_LOCAL=0 或本地库不可用时跳过（不失败）');
  print(
    `环境变量：MIKO_UI_DIR 覆盖本地库目录（默认 ${DEFAULT_LOCAL_UI_DIR}）；MIKO_UI_LOCAL=0 让 auto 跳过`,
  );
}

/** 入口：未知命令 / 命令执行抛错都返回非零退出码；命令自身的「跳过」语义由命令返回 0。 */
function main(argv) {
  const command = argv[2];
  if (command === undefined || !Object.hasOwn(COMMANDS, command)) {
    printError(`[miko_ui] 未知命令：${command ?? '（空）'}`);
    usage();
    return 1;
  }
  try {
    return COMMANDS[command]();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printError(`[miko_ui] ${command} 失败：${message}`);
    return 1;
  }
}

process.exitCode = main(process.argv);
