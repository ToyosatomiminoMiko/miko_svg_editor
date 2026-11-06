/**
 * node 单测里读二进制文件的小工具(字体资产/wasm).
 *
 * 是什么:`readBytes(相对本文件的 URL)` 直接读出 `Uint8Array`.
 * 为什么不用 `import fs from 'node:fs'`:tsconfig 只带 `vite/client` 类型(没装 @types/node),
 * 直接 import 会让 typecheck 失败;Node 20.16+ 的 `process.getBuiltinModule('fs')` 在运行期
 * 返回同一批模块,这里只声明用到的成员(与 `tests/core/fonts.test.ts` 同一条路).
 * 元信息:作者 ToyosatomiminoMiko,2026-11-07.
 */

/** 只声明用到的 node:fs 成员 */
interface FsLike {
  readFileSync(target: URL | string): Uint8Array;
}

/** 只声明用到的 process 成员 */
interface NodeProcessLike {
  getBuiltinModule(id: string): unknown;
}

const fs = (globalThis as unknown as { process: NodeProcessLike }).process.getBuiltinModule(
  'fs',
) as FsLike;

/**
 * 读文件字节;路径用相对本文件的 `import.meta.url` 拼,避免依赖 vitest 的 cwd.
 * 返回值显式落到 `Uint8Array<ArrayBuffer>`:node 的 Buffer 背后是 `ArrayBufferLike`,
 * 而 `WebAssembly.compile` 只接受 `ArrayBuffer` 支撑的视图(TS 7 的泛型 Uint8Array 会拦).
 */
export function readBytes(target: URL): Uint8Array<ArrayBuffer> {
  return new Uint8Array(fs.readFileSync(target));
}
