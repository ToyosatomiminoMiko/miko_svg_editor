/**
 * HarfBuzz 的 `hb-subset`(wasm)最小绑定:把整份字体裁成「只含给定字符」的子集(纯字节处理).
 *
 * 是什么:`createSubsetter(wasm)` 接收一个已实例化的 harfbuzz-subset wasm,返回
 * `subset(font, text)`:输入整份字体字节与要保留的文本,输出子集字体的 sfnt 字节.
 * 为什么自己写这层绑定:harfbuzzjs 只发布 wasm 与类型声明,没有「按文本裁字」的高层 API;
 * 官方推荐的 JS 封装 `subset-font` 是 node 专用(内部 `require('fs')` 读 wasm),浏览器里
 * 用不了.这里只包我们需要的 7 个 hb 调用,浏览器与 node 都能跑(WebAssembly 是 JS 标准).
 * 为什么输入输出都是「整份字节」:字体资产由调用方按 URL 取回,子集直接 base64 写进成品
 * `<defs><style>@font-face</style></defs>`;本模块不碰 DOM/网络,方便在 node 单测里直接跑.
 * 为什么在 wasm 内存增长后重新取视图:emscripten 的 memory 增长会 detach 旧的
 * `Uint8Array` 视图,复用旧视图会抛错;每次访问内存都取一份新视图.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-07.
 */

/** `hb_memory_mode_t` 的可写模式:wasm 拿到字节后可以就地改写 */
const HB_MEMORY_MODE_WRITABLE = 2;

/**
 * wasm 里与裁字相关的最小导出集合(名字与 harfbuzz 的 C API 逐字一致).
 * 为什么不改名:调用点要能对着 harfbuzz 头文件/文档核对参数顺序与返回值,改成 camelCase 反而
 * 多一层翻译,出错时更难查;这里用一段命名规则豁免把 C 名字原样保留.
 */
/* eslint-disable @typescript-eslint/naming-convention -- 导出名是 harfbuzz 的 C API,保留 snake_case 便于对照 */
interface HarfbuzzSubsetExports {
  readonly memory: WebAssembly.Memory;
  readonly malloc: (size: number) => number;
  readonly free: (pointer: number) => void;
  readonly hb_blob_create: (
    data: number,
    length: number,
    mode: number,
    userData: number,
    destroy: number,
  ) => number;
  readonly hb_blob_destroy: (blob: number) => void;
  readonly hb_blob_get_data: (blob: number, lengthPointer: number) => number;
  readonly hb_blob_get_length: (blob: number) => number;
  readonly hb_face_create: (blob: number, index: number) => number;
  readonly hb_face_destroy: (face: number) => void;
  readonly hb_face_reference_blob: (face: number) => number;
  readonly hb_subset_input_create_or_fail: () => number;
  readonly hb_subset_input_destroy: (input: number) => void;
  readonly hb_subset_input_unicode_set: (input: number) => number;
  readonly hb_set_add: (set: number, codepoint: number) => void;
  readonly hb_subset_or_fail: (face: number, input: number) => number;
}
/* eslint-enable @typescript-eslint/naming-convention */

/** 字体子集器:同一份 wasm 实例可以反复裁多份字体 */
export interface FontSubsetter {
  /**
   * 裁出子集字体.
   * `font` 是整份字体的 sfnt 字节(TrueType / OpenType 均可,不接受 woff/woff2 容器:
   * harfbuzzjs 的 subset wasm 没有编 brotli,读不了 woff2);`text` 里字体没有的字符会被
   * 静默丢弃(与 hb-subset 的 unicode 集语义一致).失败时抛中文 Error.
   */
  subset(font: Uint8Array, text: string): Uint8Array;
}

/**
 * 用已实例化的 harfbuzz-subset wasm 建一个子集器.
 * 为什么把实例当参数传:实例化是异步的且不同运行环境取 wasm 字节的方式不同
 * (浏览器 fetch,node 读文件),本模块只做内存布局与 API 调用,便于两边共用同一实现.
 */
export function createSubsetter(wasm: WebAssembly.Instance): FontSubsetter {
  const hb = wasm.exports as unknown as HarfbuzzSubsetExports;

  /** 取一份当前内存视图(wasm 内存增长后旧视图会 detach) */
  const heap = (): Uint8Array => new Uint8Array(hb.memory.buffer);

  return {
    subset(font: Uint8Array, text: string): Uint8Array {
      if (font.byteLength === 0) throw new Error('字体字节为空');
      const fontPointer = hb.malloc(font.byteLength);
      if (fontPointer === 0) throw new Error('字体过大:wasm 内存分配失败');
      try {
        heap().set(font, fontPointer);
        const blob = hb.hb_blob_create(fontPointer, font.byteLength, HB_MEMORY_MODE_WRITABLE, 0, 0);
        if (blob === 0) throw new Error('创建字体 blob 失败');
        const face = hb.hb_face_create(blob, 0);
        hb.hb_blob_destroy(blob);
        if (face === 0) throw new Error('创建字体 face 失败');
        try {
          return subsetFace(hb, face, text);
        } finally {
          hb.hb_face_destroy(face);
        }
      } finally {
        hb.free(fontPointer);
      }
    },
  };
}

/** 在给定 face 上执行一次 hb-subset,把结果字节拷出来 */
function subsetFace(hb: HarfbuzzSubsetExports, face: number, text: string): Uint8Array {
  const input = hb.hb_subset_input_create_or_fail();
  if (input === 0) throw new Error('hb-subset 初始化失败');
  try {
    const unicodeSet = hb.hb_subset_input_unicode_set(input);
    for (const character of text) {
      const codepoint = character.codePointAt(0);
      if (codepoint !== undefined) hb.hb_set_add(unicodeSet, codepoint);
    }
    const subsetFaceId = hb.hb_subset_or_fail(face, input);
    if (subsetFaceId === 0) throw new Error('hb-subset 裁字失败(字体数据可能损坏)');
    try {
      const result = hb.hb_face_reference_blob(subsetFaceId);
      if (result === 0) throw new Error('读取子集字体失败');
      try {
        const length = hb.hb_blob_get_length(result);
        if (length === 0) throw new Error('子集字体为空');
        const pointer = hb.hb_blob_get_data(result, 0);
        return copyIntoJs(hb, pointer, length);
      } finally {
        hb.hb_blob_destroy(result);
      }
    } finally {
      hb.hb_face_destroy(subsetFaceId);
    }
  } finally {
    hb.hb_subset_input_destroy(input);
  }
}

/** 把 wasm 内存区间拷成独立的 JS 字节数组 */
function copyIntoJs(hb: HarfbuzzSubsetExports, pointer: number, length: number): Uint8Array {
  return new Uint8Array(hb.memory.buffer, pointer, length).slice();
}
