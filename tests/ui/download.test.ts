/**
 * ui/download.ts 的保存策略(node 环境,用最小 DOM stub 充当浏览器).
 *
 * 覆盖四条分支:
 * 1) 有 `showSaveFilePicker` -> 写进用户选的句柄,返回 `saved`;
 * 2) 用户在保存对话框取消 -> `cancelled`,且绝不能悄悄退回下载(否则多下一份);
 * 3) 没有该 API -> 退回 `<a download>`,返回 `downloaded`;
 * 4) 对话框报错 / 写入失败 -> 也退回下载,导出成果不能丢.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadText } from '../../src/ui/download';

/** 保存对话框的入参只做结构断言,不 import 模块里的私有类型 */
interface PickerOptionsLike {
  readonly suggestedName?: string;
  readonly types?: readonly unknown[];
}

/** 只声明被调用到的句柄成员,返回 Promise 以满足 `require-await` 之外的规则 */
interface HandleLike {
  readonly createWritable: () => Promise<{
    readonly write: (blob: Blob) => Promise<void>;
    readonly close: () => Promise<void>;
  }>;
}

/** 记录 `<a download>` 回退是否真的点了 */
interface LegacyDownloadSpy {
  readonly anchor: {
    href: string;
    download: string;
    click: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
}

/** 装一个最小的浏览器下载环境:window 无保存对话框,document 只造 anchor */
function stubLegacyDownload(): LegacyDownloadSpy {
  const anchor = {
    href: '',
    download: '',
    click: vi.fn(),
    remove: vi.fn(),
  };
  vi.stubGlobal('window', {
    setTimeout: (handler: () => void) => handler(),
  });
  vi.stubGlobal('document', {
    createElement: vi.fn(() => anchor),
    body: { appendChild: vi.fn() },
  });
  return { anchor };
}

/** 构造一个 name=AbortError 的错误(用户点取消) */
function abortError(): Error {
  const error = new Error('用户取消');
  error.name = 'AbortError';
  return error;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('保存对话框可用', () => {
  it('写进用户选的句柄并返回 saved', async () => {
    const written: { blob?: Blob } = {};
    const picker = vi.fn((options?: PickerOptionsLike): Promise<HandleLike> => {
      expect(options?.suggestedName).toBe('volga.geo.json');
      expect(options?.types).toEqual([
        { description: 'JSON 文件', accept: { 'application/json': ['.json'] } },
      ]);
      return Promise.resolve({
        createWritable: () =>
          Promise.resolve({
            write: (blob: Blob) => {
              written.blob = blob;
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
          }),
      });
    });
    vi.stubGlobal('window', { showSaveFilePicker: picker });

    await expect(downloadText('{"a":1}', 'volga.geo.json', 'application/json')).resolves.toBe(
      'saved',
    );
    expect(picker).toHaveBeenCalledTimes(1);
    const blob = written.blob;
    expect(blob?.type).toBe('application/json');
    if (blob === undefined) return;
    await expect(blob.text()).resolves.toBe('{"a":1}');
  });

  it('SVG 导出用 image/svg+xml 过滤器', async () => {
    const picker = vi.fn((options?: PickerOptionsLike): Promise<HandleLike> => {
      expect(options?.types).toEqual([
        { description: 'SVG 图片', accept: { 'image/svg+xml': ['.svg'] } },
      ]);
      return Promise.resolve({
        createWritable: () =>
          Promise.resolve({ write: () => Promise.resolve(), close: () => Promise.resolve() }),
      });
    });
    vi.stubGlobal('window', { showSaveFilePicker: picker });

    await expect(downloadText('<svg/>', 'volga.svg', 'image/svg+xml')).resolves.toBe('saved');
  });

  it('用户取消返回 cancelled,不退回下载', async () => {
    const picker = vi.fn((): Promise<HandleLike> => Promise.reject(abortError()));
    vi.stubGlobal('window', { showSaveFilePicker: picker });

    await expect(downloadText('{}', 'a.geo.json', 'application/json')).resolves.toBe('cancelled');
    expect(picker).toHaveBeenCalledTimes(1);
  });

  it('对话框抛非取消错误时退回下载', async () => {
    const { anchor } = stubLegacyDownload();
    vi.stubGlobal('window', {
      showSaveFilePicker: vi.fn((): Promise<HandleLike> => Promise.reject(new Error('没有手势'))),
      setTimeout: (handler: () => void) => handler(),
    });

    await expect(downloadText('{}', 'a.geo.json', 'application/json')).resolves.toBe('downloaded');
    expect(anchor.download).toBe('a.geo.json');
    expect(anchor.click).toHaveBeenCalledTimes(1);
  });

  it('写入失败时退回下载', async () => {
    const { anchor } = stubLegacyDownload();
    vi.stubGlobal('window', {
      showSaveFilePicker: vi.fn((): Promise<HandleLike> =>
        Promise.resolve({ createWritable: () => Promise.reject(new Error('磁盘满')) }),
      ),
      setTimeout: (handler: () => void) => handler(),
    });

    await expect(downloadText('<svg/>', 'a.svg', 'image/svg+xml')).resolves.toBe('downloaded');
    expect(anchor.click).toHaveBeenCalledTimes(1);
  });
});

describe('保存对话框不可用', () => {
  it('退回 <a download> 并返回 downloaded', async () => {
    const { anchor } = stubLegacyDownload();

    await expect(downloadText('<svg/>', 'sketch.svg', 'image/svg+xml')).resolves.toBe('downloaded');
    expect(anchor.download).toBe('sketch.svg');
    expect(anchor.click).toHaveBeenCalledTimes(1);
  });
});
