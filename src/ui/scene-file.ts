/**
 * 地图模式的持久化传输层：`/api/doc`、`/api/scene`（GET/PUT）、`/api/compose` 的薄封装，
 * 以及「保存 = 当前内存模型 + 记住的底图声明」这份 payload 的拼装。
 *
 * 是什么：把 studio 的 HTTP 语义翻译成前端的两个类型——`MapDoc`（只读文档信息）与
 * `SaveOutcome`（保存/合成的归一结果）。所有失败（409/400、其它非 2xx、超时、断网）
 * 都落在 `SaveOutcome.ok === false`，**不向调用方抛异常**，调用方只做分支不做 catch。
 * 唯一会抛的是 `fetchDoc`/`fetchScene`：它们是地图模式的探测/载入入口（契约 §5 GET 总是
 * 200），失败意味着 studio 不可用，由 app/map-mode.ts 捕获后回退草图模式。
 *
 * 为什么 base 声明要记忆：PUT 语义体里必须带 `base{sha256,width_pt,height_pt}` 作为变更检测
 * 依据（服务器用真实 base 校验），而这份声明只出现在 `/api/doc` 的响应里；由本模块记住，
 * 调用方保存时不必自己拼、也不会把「画布尺寸」与「底图尺寸」两份数字搞混。
 * 为什么用 encodeURIComponent/URLSearchParams：figure key 来自服务器，但拼 URL 时不信任它
 * 只含安全字符；同时保留「未加载 doc 时不带 figure」的降级路径（单图 studio 的默认图）。
 *
 * 元信息：作者 fe-render-ui，2026-10-27 随地图模式竖切片加入（impl-contract.md §6）。
 */

import {
  MAPDOC_COMPOSE_URL,
  MAPDOC_DOC_URL,
  MAPDOC_REQUEST_TIMEOUT_MS,
  MAPDOC_SCENE_URL,
} from '../config';
import { mapStyle, serializeScene } from '../core/scene';
import type {
  SceneBaseClaim,
  SceneConstraint,
  SceneDoc,
  SceneEntity,
  ScenePoint,
  SceneStyle,
} from '../core/scene';

/** 成品 marker（契约 §4）：final.svg 里 `<!-- mapdoc-final:<base64> -->` 解出的 JSON */
export interface FinalCounts {
  readonly points: number;
  readonly entities: number;
  readonly constraints: number;
  readonly texts: number;
}

export interface FinalMarker {
  readonly format: 'mapdoc-final';
  readonly version: number;
  /** 生成该成品时 scene.json 的 canonical sha256 */
  readonly scene: string;
  /** 生成该成品时 base.svg 的 sha256 */
  readonly base: string;
  readonly counts: FinalCounts;
}

/** compose 报告（契约 §5）：越界对象/缺字/底图变化等告警的数据源 */
export interface ComposeReport {
  readonly counts: FinalCounts;
  readonly warnings: readonly string[];
  readonly out_of_canvas: readonly number[];
  readonly missing_glyphs: readonly string[];
  readonly base_changed: boolean;
  readonly base_size_changed: boolean;
}

/** `/api/doc` 的图标识（figure key 用于后续查询参数，path 仅展示） */
export interface MapDocFigure {
  readonly key: string;
  readonly path: string;
}

/** `/api/doc` 的画布尺寸（= 底图 viewBox 尺寸，用户单位 pt） */
export interface MapDocCanvas {
  readonly width_pt: number;
  readonly height_pt: number;
}

/** `/api/doc` 的底图描述：url 是浏览器可直接当 `<img src>` 的相对地址 */
export interface MapDocBase {
  readonly url: string;
  readonly sha256: string;
  readonly width_pt: number;
  readonly height_pt: number;
}

/** `/api/doc` 的成品描述；final.svg 还不存在时 sha256 为 null */
export interface MapDocFinal {
  readonly url: string;
  readonly sha256: string | null;
  readonly marker: FinalMarker | null;
}

/** `/api/doc` 的当前 scene 摘要 */
export interface MapDocScene {
  readonly sha256: string;
}

/** `/api/doc` 的「还需要做什么」：底图缺失/成品过期/底图待确认 */
export interface MapDocNeeds {
  readonly render: boolean;
  readonly compose: boolean;
  readonly ack: boolean;
}

/** `GET /api/doc` 的完整响应（契约 §5，一一对应） */
export interface MapDoc {
  readonly figure: MapDocFigure;
  readonly canvas: MapDocCanvas;
  readonly base: MapDocBase;
  readonly final: MapDocFinal;
  readonly scene: MapDocScene;
  readonly needs: MapDocNeeds;
  readonly style_defaults: SceneStyle;
  readonly warnings: readonly string[];
}

/**
 * 保存/合成的归一结果。
 * 成功分支的 `composed=false + code='rendering'` 表示「已写盘但拿不到锁」，不是失败；
 * 失败分支只保留契约里能区分的三个业务码，其余（含 compose 的 409 `rendering`）
 * 一律 `http`，原始码保留在 message 里。
 */
export type SaveOutcome =
  | {
      readonly ok: true;
      readonly composed: boolean;
      readonly code?: 'rendering';
      readonly sceneSha: string;
      readonly marker: FinalMarker | null;
      readonly report: ComposeReport | null;
    }
  | {
      readonly ok: false;
      readonly code: 'canvas_changed' | 'base_changed' | 'invalid_scene' | 'http' | 'network';
      readonly message: string;
      readonly base?: SceneBaseClaim;
    };

/** JSON 对象的最小结构：响应体是「对象」才继续读字段 */
type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 已知业务失败码：其它码（rendering 等）不单独暴露，归到 http */
const isFailureCode = (code: string): code is 'canvas_changed' | 'base_changed' | 'invalid_scene' =>
  code === 'canvas_changed' || code === 'base_changed' || code === 'invalid_scene';

/**
 * 数据段取值：结构由契约 §5 保证（对端是本地 studio），这里只验证「是对象」，
 * 不复制第二套 JSON schema；字段缺失时返回 null，让调用方走「无 marker/report」分支。
 */
const asObject = <T>(value: unknown): T | null =>
  isObject(value) ? (value as unknown as T) : null;

/** 底图声明：服务器在 409 响应里回传，三个字段都必须是正确类型才采用 */
function asBaseClaim(value: unknown): SceneBaseClaim | null {
  if (!isObject(value)) return null;
  // 不直接解构 width_pt/height_pt：那会引入 snake_case 局部变量（命名规则要求 camelCase）
  const sha256 = value.sha256;
  const width = value.width_pt;
  const height = value.height_pt;
  if (typeof sha256 !== 'string') return null;
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  return { sha256, width_pt: width, height_pt: height };
}

/** 网络/超时/解析异常统一成一句中文，供 SaveOutcome.message 与 Error 共用 */
function describeError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return `请求超时（>${MAPDOC_REQUEST_TIMEOUT_MS} ms）`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * 带超时的 fetch：只把「拿到响应」交回调用方，传输层异常转成带中文 message 的 Error。
 * 用 AbortSignal.timeout 而不是手写 AbortController + setTimeout：后者要在成功路径上清定时器，
 * 漏清会让页面在请求结束后还挂着一个待触发的 abort。
 */
async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(MAPDOC_REQUEST_TIMEOUT_MS) });
  } catch (error) {
    // cause 保留原始 DOMException/fetch 异常，便于排查是超时还是网络层失败
    throw new Error(describeError(error), { cause: error });
  }
}

/** 读 JSON 响应体：非对象/解析失败返回 null（失败路径要的是错误码，不该再抛解析异常） */
async function readJson(response: Response): Promise<JsonObject | null> {
  try {
    const body = (await response.json()) as unknown;
    return isObject(body) ? body : null;
  } catch {
    return null;
  }
}

/** GET JSON（/api/doc、/api/scene）：非 2xx 与传输异常都抛，由 app 层决定是否回退草图模式 */
async function getJson<T>(url: string): Promise<T> {
  const response = await request(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`GET ${url} 失败：HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** 记住的文档三要素：PUT 必填的底图声明、figure key、scene 摘要（compose 结果回填） */
interface RememberedDoc {
  readonly figureKey: string;
  readonly base: SceneBaseClaim;
  readonly sceneSha: string;
}

/** null = 还没成功读过 /api/doc；此时 saveScene 缺 base 声明，只能返回失败而不是乱猜 */
let remembered: RememberedDoc | null = null;

/** 记住 `/api/doc` 的底图声明（地图模式在 fetchDoc 之后、applyScene 之前调用一次） */
export function rememberDoc(doc: MapDoc): void {
  remembered = {
    figureKey: doc.figure.key,
    base: {
      sha256: doc.base.sha256,
      width_pt: doc.base.width_pt,
      height_pt: doc.base.height_pt,
    },
    sceneSha: doc.scene.sha256,
  };
}

/** 探测并读取 `/api/doc`：studio 没起时抛，app/map-mode.ts 捕获后回退草图模式 */
export function fetchDoc(): Promise<MapDoc> {
  return getJson<MapDoc>(MAPDOC_DOC_URL);
}

/** 读取规范化 scene；服务端保证总是 200（文件不存在时给空场景 + 当前 base 声明与默认样式） */
export function fetchScene(): Promise<SceneDoc> {
  return getJson<SceneDoc>(MAPDOC_SCENE_URL);
}

/**
 * 拼 figure 查询参数。
 * 未加载 doc 时不带参数：单图 studio 会落到默认图，这条降级路径只服务「理论上不该发生」
 * 的调用顺序错误，不会把未编码的 key 拼进 URL。
 */
function withFigure(url: string): string {
  if (!remembered) return url;
  const query = new URLSearchParams({ figure: remembered.figureKey });
  return `${url}?${query.toString()}`;
}

/** PUT 语义体：顶层只允许这些字段，figure/format/version 由服务器补齐（契约 §5） */
interface ScenePutBody {
  readonly base: SceneBaseClaim;
  readonly ack_base_change?: boolean;
  readonly style: SceneStyle;
  readonly seq: number;
  readonly points: readonly ScenePoint[];
  readonly entities: readonly SceneEntity[];
  readonly constraints: readonly SceneConstraint[];
}

/**
 * 当前模型 + 场景样式 + 记住的底图声明 → PUT 语义体。
 * style 直接取场景级单例 `mapStyle`（`serializeScene()` 的 style 就是它的一份拷贝），
 * 其余容器用序列化结果：保存的就是「内存里此刻的文档」，不额外引入第二份样式真值。
 */
function buildPutBody(ackBaseChange: boolean | undefined): ScenePutBody | null {
  if (!remembered) return null;
  const content = serializeScene();
  return {
    base: remembered.base,
    ...(ackBaseChange === true ? { ack_base_change: true } : {}),
    style: mapStyle,
    seq: content.seq,
    points: content.points,
    entities: content.entities,
    constraints: content.constraints,
  };
}

/** 失败归一：业务码映射 + 可读 message + 可选的新底图声明 */
function failureFrom(response: Response, body: JsonObject | null): SaveOutcome {
  const rawCode = body && typeof body.code === 'string' ? body.code : '';
  const code = isFailureCode(rawCode) ? rawCode : 'http';
  let message: string;
  if (body && typeof body.message === 'string' && body.message !== '') {
    message = body.message;
  } else if (rawCode !== '') {
    message = `${rawCode}（HTTP ${response.status}）`;
  } else if (response.ok) {
    message = `服务器响应缺少 ok:true（HTTP ${response.status}）`;
  } else {
    message = `HTTP ${response.status}`;
  }
  const base = body ? asBaseClaim(body.base) : null;
  return base ? { ok: false, code, message, base } : { ok: false, code, message };
}

/**
 * 成功归一：写盘路径会带回 scene_sha，回填进 remembered 供 composeNow 报告；
 * compose 响应没有 scene_sha，沿用记住的值而不是编一个。
 */
function successFrom(body: JsonObject, fallbackSceneSha: string): SaveOutcome {
  const sceneSha = typeof body.scene_sha === 'string' ? body.scene_sha : fallbackSceneSha;
  if (typeof body.scene_sha === 'string' && remembered) {
    remembered = { ...remembered, sceneSha: body.scene_sha };
  }
  return {
    ok: true,
    composed: body.composed === true,
    ...(body.code === 'rendering' ? { code: 'rendering' as const } : {}),
    sceneSha,
    marker: asObject<FinalMarker>(body.marker),
    report: asObject<ComposeReport>(body.report),
  };
}

/** 200 且 ok:true 才算成功；其余（含 200 却没有 ok 字段的异常响应）都走失败归一 */
function normalizeResponse(
  response: Response,
  body: JsonObject | null,
  fallbackSceneSha: string,
): SaveOutcome {
  if (response.ok && body !== null && body.ok === true) return successFrom(body, fallbackSceneSha);
  return failureFrom(response, body);
}

/**
 * 保存 scene（PUT /api/scene）。
 * `ackBaseChange=true` 是 base_changed 409 之后的显式确认重提（用户在确认框里点了确定）。
 * 任何失败都归一成 SaveOutcome.ok=false，不抛给调用方。
 */
export async function saveScene(ackBaseChange?: boolean): Promise<SaveOutcome> {
  const body = buildPutBody(ackBaseChange);
  if (!body) {
    // 调用顺序错误（没先 fetchDoc + rememberDoc），不是传输/服务端失败；SaveOutcome 的失败码
    // 没有「前置条件」这一项，归到 http 并给可读 message，避免把调用方炸掉。
    return { ok: false, code: 'http', message: '尚未加载 /api/doc（缺少底图声明），无法保存' };
  }
  let response: Response;
  try {
    response = await request(withFigure(MAPDOC_SCENE_URL), {
      method: 'PUT',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch (error) {
    return { ok: false, code: 'network', message: describeError(error) };
  }
  const json = await readJson(response);
  return normalizeResponse(response, json, remembered?.sceneSha ?? '');
}

/**
 * 强制合成（POST /api/compose）。
 * 409 的 `{ok:false,code:"rendering"}`（抢不到锁）在 SaveOutcome 的失败码里没有对应项，
 * 归一成 code='http'，message 保留原始码，调用方按 message 展示即可。
 */
export async function composeNow(): Promise<SaveOutcome> {
  let response: Response;
  try {
    response = await request(withFigure(MAPDOC_COMPOSE_URL), {
      method: 'POST',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
  } catch (error) {
    return { ok: false, code: 'network', message: describeError(error) };
  }
  const json = await readJson(response);
  return normalizeResponse(response, json, remembered?.sceneSha ?? '');
}
