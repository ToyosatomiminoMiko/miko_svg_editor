/**
 * 架构依赖检查：扫描 src/ 下所有 .ts 的相对 import/export，验证「依赖只能向下」且没有运行期环。
 *
 * 为什么单靠 ESLint 不够：no-restricted-imports 能挡住反向 import（core → render 等），
 * 但挡不住同层/跨层互相 import 形成的环（TypeScript 允许，运行期却会拿到半初始化的模块）。
 * 这里按目录分层做兜底：类型依赖（import type / export type）在运行期会被擦除，不算边，
 * 只有值导入/值再导出（import x from、import './x'、export * from 等）参与检查。
 *
 * 允许的层间边（箭头 = 允许 import）：
 *   app → app, ui, render, core, config
 *   ui → ui, render, core, config
 *   render → render, core, config
 *   core → core, config
 *   config → config
 * 说明：config 允许 type-only 引用 core 的类型（constraints-meta 需要 Constraint/EntityKind），
 * 但运行期引用 core 会被本脚本判为违规。
 *
 * 用法：node scripts/check_architecture.mjs（在项目根执行；npm run arch）
 */

import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SRC = 'src';

/** 允许的层间依赖：key 是来源层，value 是允许被依赖的层（同层 import 已隐含在 value 里） */
const ALLOWED = {
  app: ['app', 'ui', 'render', 'core', 'config'],
  ui: ['ui', 'render', 'core', 'config'],
  render: ['render', 'core', 'config'],
  core: ['core', 'config'],
  config: ['config'],
};

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** 解析一个文件里的运行期相对依赖（类型导入/类型再导出被剔除） */
function runtimeDeps(file) {
  const text = fs
    .readFileSync(file, 'utf8')
    .replace(/import\s+type\s+[\s\S]*?from\s+['"][^'"]+['"]\s*;?/g, '')
    .replace(/export\s+type\s+[\s\S]*?from\s+['"][^'"]+['"]\s*;?/g, '');
  const deps = new Set();
  const re = /(?:import|export)\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const spec = match[1];
    if (!spec.startsWith('.')) continue;
    const base = path.resolve(path.dirname(file), spec);
    const resolved = [base, `${base}.ts`, path.join(base, 'index.ts')].find(
      (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
    );
    if (resolved) deps.add(path.relative(process.cwd(), resolved).split(path.sep).join('/'));
  }
  return [...deps];
}

/** src/core/model.ts → 'core'；src 根目录散落文件返回 null（重构后不应存在） */
function layerOf(file) {
  const parts = file.split('/');
  if (parts[0] !== SRC || parts.length < 3) return null;
  return parts[1];
}

const files = walk(SRC).map((file) => file.split(path.sep).join('/'));
const graph = new Map(files.map((file) => [file, runtimeDeps(file)]));

const violations = [];
for (const [file, deps] of graph) {
  const from = layerOf(file);
  if (from === null) {
    violations.push(`${file}: 不在任何层目录下（应归入 app/core/render/ui/config）`);
    continue;
  }
  for (const dep of deps) {
    const to = layerOf(dep);
    if (to === null) continue;
    if (!ALLOWED[from].includes(to)) {
      violations.push(`${file}: ${from} 层禁止运行期依赖 ${to} 层（${dep}）`);
    }
  }
}

// 运行期环：DFS 三色标记，回到「当前递归栈上」的节点才算环
const color = new Map();
const stack = [];
const cycles = [];
function dfs(file) {
  color.set(file, 1);
  stack.push(file);
  for (const dep of graph.get(file) ?? []) {
    if (color.get(dep) === 1) {
      cycles.push([...stack.slice(stack.indexOf(dep)), dep].join(' → '));
    } else if (!color.get(dep)) {
      dfs(dep);
    }
  }
  stack.pop();
  color.set(file, 2);
}
for (const file of files) if (!color.get(file)) dfs(file);
for (const cycle of cycles) violations.push(`运行期循环依赖：${cycle}`);

if (violations.length > 0) {
  console.error('架构依赖检查失败：');
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log(`架构依赖检查通过：${files.length} 个文件、0 个反向依赖、0 个运行期环。`);
