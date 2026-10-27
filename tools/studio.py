#!/usr/bin/env python3
"""出版排版编辑器 studio: 纯底图/geo 服务 + scene 保存 + compose 的 HTTP 服务.

是什么: 在 127.0.0.1 上起一个标准库 ThreadingHTTPServer, 按 tools/studio.toml 的图配置提供
``/api/doc``、``/api/geo``、``/api/scene``(GET/PUT)、``/api/compose``、``/base.svg``、
``/final.svg``、``/geo.json``、``/api/health`` 与前端构建产物(dist/index.html、dist/map.html、
dist/assets/*)的静态服务.
为什么: scene 的规范化/写盘与 final 的合成必须只有一个 Python 实现; 浏览器只提交语义体,
服务器校验(含底图变更政策)→ 规范化原子写 → compose, 浏览器不直接写成品.
安全骨架沿用 label_editor.py: 只监听回环、配置未知键报错、静态白名单、请求体 ≤ 2 MB、
拒绝 ``..``、不接受命令行参数、所有响应 Cache-Control: no-store.
开发期(由 Vite 插件拉起)可用环境变量 MAPDOC_STUDIO_PORT / MAPDOC_OPEN_BROWSER 覆盖端口与
自动开浏览器, 见 apply_env_overrides.
元信息: 2026-10, 新数据流(纯底图 + geo + 排版层); 契约见 docs/PAGE-EDITOR.md.
"""

from __future__ import annotations

import json
import os
import platform
import re
import sys
import tomllib
import traceback
import webbrowser
from dataclasses import dataclass, replace
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlparse

from mapdoc import compose as compose_mod
from mapdoc import contract, fsutil, geo as geo_mod, page as page_mod

# 本文件所在目录: TOML 与相对路径的解析基准, 不依赖当前工作目录.
TOOL_DIR = Path(__file__).resolve().parent
CONFIG_FILE = TOOL_DIR / "studio.toml"
# 监听地址固定回环: 服务没有鉴权, 只靠 127.0.0.1 隔离, 因此不提供配置项.
HOST = "127.0.0.1"
# 请求体上限: 正常 scene 是几十 KB; 2 MB 足够, 同时挡住误传整张 SVG.
MAX_BODY_BYTES = 2 * 1024 * 1024
# 配置缺省值; 端口固定 8791 是为了 Vite 开发期代理(vite.config.ts).
DEFAULT_PORT = 8791
DEFAULT_OPEN_BROWSER = True
DEFAULT_WEB_DIST = "../dist"
DEFAULT_BASE_DIR = ".build"
# 画布尺寸容差(pt): 与旧实现一致, 挡住浮点回写造成的「差 1e-14 也算变了」.
SIZE_TOLERANCE_PT = 0.01

# 开发期环境变量: 只覆盖「必须在进程启动前定下」的两项, 供 Vite 插件并行拉起本服务用.
# 其余配置(图路径/静态目录)仍只认 TOML, 避免出现两份真相.
ENV_STUDIO_PORT = "MAPDOC_STUDIO_PORT"
ENV_OPEN_BROWSER = "MAPDOC_OPEN_BROWSER"

# 图 key 直接用于 URL 与文件名, 只允许安全字符.
_FIGURE_KEY_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*")
# 静态资源类型白名单; 未知后缀按 application/octet-stream 返回, 不允许可执行类型.
_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
}

_EXAMPLE_CONFIG = """\
[studio]
port = 8791
open_browser = true
web_dist = "../dist"
base_dir = ".build"

[figures]
volga = "../demo/figures/Volga/volga_basin_topography_etopo2022_lambert_conformal.svg"
"""


class StudioConfigError(Exception):
    """配置缺失或不合法; 消息直接面向用户, 由 main 打印后退出."""


class ApiError(Exception):
    """端点主动返回的 HTTP 错误(带 JSON 语义体), 由分发器统一发送."""

    def __init__(self, status: HTTPStatus, payload: dict[str, Any]):
        super().__init__(str(payload.get("code", status)))
        self.status = status
        self.payload = payload


def _error(status: HTTPStatus, code: str, message: str, **extra: Any) -> ApiError:
    payload: dict[str, Any] = {"ok": False, "code": code, "message": message}
    payload.update(extra)
    return ApiError(status, payload)


@dataclass(frozen=True)
class FigureConfig:
    """一张图的全部派生路径; scene/geo/base/final/lock 全部由 SVG 路径推导."""

    key: str
    figure_name: str
    final_path: Path
    scene_path: Path
    geo_path: Path
    base_path: Path
    lock_path: Path


@dataclass(frozen=True)
class StudioConfig:
    """一次 studio 会话的配置: 端口、静态目录与图白名单."""

    config_path: Path
    port: int
    open_browser: bool
    web_dist: Path
    base_dir: str
    figures: dict[str, FigureConfig]

    def figure(self, key: str) -> FigureConfig:
        figure = self.figures.get(key)
        if figure is None:
            raise _error(HTTPStatus.BAD_REQUEST, "unknown_figure", f"未知图: {key}")
        return figure


@dataclass(frozen=True)
class BaseState:
    """服务器侧底图声明: 只保留 doc 与 scene 复核要用到的字段."""

    sha256: str
    width_pt: float
    height_pt: float
    view_box: tuple[float, float, float, float]

    def to_dict(self) -> dict[str, Any]:
        return {
            "sha256": self.sha256,
            "width_pt": round(self.width_pt, 3),
            "height_pt": round(self.height_pt, 3),
        }


def _resolve(base: Path, value: str) -> Path:
    """把配置里的路径按配置文件所在目录解析; 支持 ~ 与绝对路径."""
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = base / path
    return path.resolve()


def load_config(path: Path = CONFIG_FILE) -> StudioConfig:
    """读取并校验 TOML; 未知键/未知节一律报错, 避免拼错键名后静默跑默认值."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise StudioConfigError(
            f"找不到配置文件: {path}\n请创建它, 内容示例:\n{_EXAMPLE_CONFIG}"
        ) from None
    except OSError as exc:
        raise StudioConfigError(f"读取配置文件失败: {path}: {exc}") from exc

    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        raise StudioConfigError(f"配置文件不是合法 TOML: {path}: {exc}") from exc

    unknown_sections = sorted(set(data) - {"studio", "figures"})
    if unknown_sections:
        raise StudioConfigError(
            f"配置文件里有不认识的节 {', '.join(unknown_sections)}: {path}"
            "(只支持 [studio] / [figures])"
        )

    studio = data.get("studio", {})
    if not isinstance(studio, dict):
        raise StudioConfigError(f"[studio] 必须是表: {path}")
    unknown = sorted(set(studio) - {"port", "open_browser", "web_dist", "base_dir"})
    if unknown:
        raise StudioConfigError(
            f"[studio] 里有不认识的键 {', '.join(unknown)}: {path}"
            "(只支持 port / open_browser / web_dist / base_dir)"
        )

    port = studio.get("port", DEFAULT_PORT)
    # bool 是 int 的子类, 必须先排除, 否则 port = true 会被当成 1.
    if isinstance(port, bool) or not isinstance(port, int):
        raise StudioConfigError(f"studio.port 必须是整数(0 表示系统分配): {path}")
    if not 0 <= port <= 65535:
        raise StudioConfigError(f"studio.port 超出 0..65535: {port}")

    open_browser = studio.get("open_browser", DEFAULT_OPEN_BROWSER)
    if not isinstance(open_browser, bool):
        raise StudioConfigError(f"studio.open_browser 必须是 true 或 false: {path}")

    web_dist_value = studio.get("web_dist", DEFAULT_WEB_DIST)
    if not isinstance(web_dist_value, str) or not web_dist_value.strip():
        raise StudioConfigError(f"studio.web_dist 必须是非空字符串: {path}")

    base_dir = studio.get("base_dir", DEFAULT_BASE_DIR)
    if not isinstance(base_dir, str) or not base_dir.strip():
        raise StudioConfigError(f"studio.base_dir 必须是非空字符串: {path}")
    base_dir_parts = base_dir.split("/")
    if Path(base_dir).is_absolute() or any(part in ("", ".", "..") for part in base_dir_parts):
        raise StudioConfigError(
            f"studio.base_dir 必须是图目录下的相对子目录(不能是绝对路径或含 ..): {base_dir}"
        )

    figures_value = data.get("figures")
    if not isinstance(figures_value, dict) or not figures_value:
        raise StudioConfigError(f"[figures] 至少要配置一张图: {path}")

    config_dir = path.resolve().parent
    web_dist = _resolve(config_dir, web_dist_value)
    figures: dict[str, FigureConfig] = {}
    for key, value in figures_value.items():
        if not _FIGURE_KEY_RE.fullmatch(key):
            raise StudioConfigError(
                f"图 key 只能是字母/数字/下划线/点/连字符: {key!r}"
            )
        if not isinstance(value, str) or not value.strip():
            raise StudioConfigError(f"图 {key} 的路径必须是非空字符串: {path}")
        final_path = _resolve(config_dir, value.strip())
        stem = final_path.stem
        scene_path = final_path.with_name(stem + ".scene.json")
        geo_path = final_path.with_name(stem + ".geo.json")
        base_dir_path = final_path.parent / base_dir
        base_path = base_dir_path / (stem + ".base.svg")
        lock_path = base_dir_path / (stem + ".lock")
        try:
            figure_name = final_path.relative_to(TOOL_DIR.parent).as_posix()
        except ValueError:
            # 图不在本仓库内时保留绝对路径: 仅用于显示, 不参与路径拼接.
            figure_name = final_path.as_posix()
        figures[key] = FigureConfig(
            key=key,
            figure_name=figure_name,
            final_path=final_path,
            scene_path=scene_path,
            geo_path=geo_path,
            base_path=base_path,
            lock_path=lock_path,
        )

    return StudioConfig(
        config_path=path.resolve(),
        port=port,
        open_browser=open_browser,
        web_dist=web_dist,
        base_dir=base_dir,
        figures=figures,
    )


def _env_port(fallback: int) -> int:
    """读 MAPDOC_STUDIO_PORT; 未设置时返回 fallback."""
    raw = os.environ.get(ENV_STUDIO_PORT)
    if raw is None:
        return fallback
    try:
        port = int(raw, 10)
    except ValueError:
        raise StudioConfigError(
            f"{ENV_STUDIO_PORT} 必须是整数(0 表示系统分配): {raw!r}"
        ) from None
    if not 0 <= port <= 65535:
        raise StudioConfigError(f"{ENV_STUDIO_PORT} 超出 0..65535: {port}")
    return port


def _env_open_browser(fallback: bool) -> bool:
    """读 MAPDOC_OPEN_BROWSER(0/false 或 1/true); 未设置时返回 fallback."""
    raw = os.environ.get(ENV_OPEN_BROWSER)
    if raw is None:
        return fallback
    value = raw.strip().lower()
    if value in ("0", "false", "no", "off"):
        return False
    if value in ("1", "true", "yes", "on"):
        return True
    raise StudioConfigError(f"{ENV_OPEN_BROWSER} 只接受 0/false 或 1/true: {raw!r}")


def apply_env_overrides(config: StudioConfig) -> StudioConfig:
    """按开发期环境变量覆盖端口与自动打开浏览器; 两项都没设时原样返回.

    为什么不在 load_config 里做: 环境变量是「这次启动怎么跑」的临时选择, 不是配置文件的
    语义; 单测直接调 load_config 时不该被宿主机环境影响.
    """
    port = _env_port(config.port)
    open_browser = _env_open_browser(config.open_browser)
    if port == config.port and open_browser == config.open_browser:
        return config
    return replace(config, port=port, open_browser=open_browser)


# ---------------------------------------------------------------- 底图 / geo / scene 读取


def _base_state(figure: FigureConfig) -> tuple[BaseState | None, tuple[str, ...]]:
    """读底图并做 C1-C4 检查; 返回 (服务器侧声明, 错误).

    底图缺失时返回 (None, ("底图缺失…",)); 存在但不合法时错误带回具体条目.
    """
    try:
        data = figure.base_path.read_bytes()
    except FileNotFoundError:
        return None, ("底图缺失: 请先运行 python3 tools/prepare_demo.py",)
    except OSError as exc:
        return None, (f"读取底图失败: {exc}",)
    info = contract.read_base(data)
    if info.errors:
        return None, tuple(info.errors)
    return (
        BaseState(
            sha256=contract.sha256(data),
            width_pt=info.width_pt,
            height_pt=info.height_pt,
            view_box=info.view_box,
        ),
        (),
    )


def _read_geo(figure: FigureConfig) -> geo_mod.Geo:
    """读 geo.json; 缺失/不合法统一转成 503, 让前端提示先跑 prepare."""
    if not figure.geo_path.is_file():
        raise _error(
            HTTPStatus.SERVICE_UNAVAILABLE,
            "geo_missing",
            "geo.json 缺失: 请先运行 python3 tools/prepare_demo.py",
        )
    try:
        return geo_mod.read_geo(figure.geo_path)
    except geo_mod.GeoError as exc:
        raise _error(
            HTTPStatus.SERVICE_UNAVAILABLE, "geo_invalid", f"geo.json 不合法: {exc}"
        ) from exc


def _load_scene(
    figure: FigureConfig,
) -> tuple[dict[str, Any] | None, bool, str | None]:
    """读 scene.json; 返回 (scene, 是否来自文件, 错误).

    文件不存在返回 (None, False, None) —— 前端会用 geo 生成初始排版.
    文件存在但不是合法 JSON/结构时返回错误字符串, 由调用方决定状态码.
    """
    try:
        raw = figure.scene_path.read_bytes()
    except FileNotFoundError:
        return None, False, None
    except OSError as exc:
        return None, False, f"读取 scene 失败: {exc}"
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return None, True, f"scene.json 不是合法 JSON: {exc}"
    if not isinstance(document, dict):
        return None, True, "scene.json 顶层必须是对象"
    errors = page_mod.validate_scene(document)
    if errors:
        return None, True, "; ".join(errors)
    return document, True, None


def _scene_size_changed(
    claim: dict[str, Any], base: BaseState
) -> bool:
    """scene 声明的底图尺寸与当前底图是否超过容差."""
    try:
        width = float(claim["width_pt"])
        height = float(claim["height_pt"])
    except (KeyError, TypeError, ValueError):
        return True
    return (
        abs(width - base.width_pt) > SIZE_TOLERANCE_PT
        or abs(height - base.height_pt) > SIZE_TOLERANCE_PT
    )


# ---------------------------------------------------------------- HTTP 服务


class StudioServer(ThreadingHTTPServer):
    """带配置的 ThreadingHTTPServer; daemon 线程避免 Ctrl+C 后残留连接阻塞退出."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], config: StudioConfig):
        super().__init__(address, StudioHandler)
        self.config = config


class StudioHandler(BaseHTTPRequestHandler):
    """所有端点的分发与响应; 业务错误统一走 ApiError."""

    server: StudioServer
    protocol_version = "HTTP/1.1"

    # -- 方法入口 ---------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler 约定
        self._dispatch(self._get)

    def do_PUT(self) -> None:  # noqa: N802
        self._dispatch(self._put)

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch(self._post)

    def do_HEAD(self) -> None:  # noqa: N802
        self._dispatch(self._method_not_allowed)

    def do_DELETE(self) -> None:  # noqa: N802
        self._dispatch(self._method_not_allowed)

    def do_PATCH(self) -> None:  # noqa: N802
        self._dispatch(self._method_not_allowed)

    def _dispatch(self, handler) -> None:  # noqa: ANN001 - 内部回调
        try:
            handler()
        except ApiError as exc:
            self._send_json(exc.status, exc.payload)
        except (BrokenPipeError, ConnectionResetError):
            # 浏览器关闭标签页时的正常竞态, 不算服务器错误.
            pass
        except Exception:  # noqa: BLE001 - 兜底, 避免线程静默死掉
            traceback.print_exc()
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"ok": False, "code": "internal", "message": "服务器内部错误"},
            )

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - 基类签名
        """请求日志; 测试里把 server.quiet 置 True 可静音(handlers 是同一进程的线程)."""
        if getattr(self.server, "quiet", False):
            return
        super().log_message(format, *args)

    def _method_not_allowed(self) -> None:
        self._discard_body()
        self._send_json(
            HTTPStatus.METHOD_NOT_ALLOWED,
            {"ok": False, "code": "method_not_allowed", "message": "方法不被支持"},
            extra_headers={"Allow": "GET, PUT, POST"},
        )

    # -- 响应辅助 ---------------------------------------------------------

    def _send_bytes(
        self,
        status: HTTPStatus,
        body: bytes,
        content_type: str,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_json(
        self,
        status: HTTPStatus,
        payload: dict[str, Any],
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        body = json.dumps(
            payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        self._send_bytes(
            status,
            body,
            "application/json; charset=utf-8",
            extra_headers=extra_headers,
        )

    # -- 请求解析 ---------------------------------------------------------

    @property
    def _config(self) -> StudioConfig:
        return self.server.config

    def _url_path(self) -> str:
        return unquote(urlparse(self.path).path)

    def _figure(self) -> FigureConfig:
        """解析 ?figure=; 单图配置可省略参数, 多图配置必须显式指定."""
        query = parse_qs(urlparse(self.path).query)
        values = query.get("figure", [])
        if len(values) > 1:
            raise _error(
                HTTPStatus.BAD_REQUEST, "invalid_request", "figure 参数重复"
            )
        figures = self._config.figures
        if not values:
            if len(figures) == 1:
                return next(iter(figures.values()))
            raise _error(
                HTTPStatus.BAD_REQUEST, "invalid_request", "多图配置必须带 ?figure="
            )
        key = values[0]
        if not _FIGURE_KEY_RE.fullmatch(key):
            raise _error(HTTPStatus.BAD_REQUEST, "unknown_figure", f"未知图: {key}")
        return self._config.figure(key)

    def _url_for(self, endpoint: str, figure: FigureConfig) -> str:
        return f"{endpoint}?figure={quote(figure.key)}"

    def _discard_body(self) -> None:
        """丢弃未读取的请求体, 避免它被当成下一个 keep-alive 请求的请求行.

        只用于"该端点本来就不接受请求体"的路径(405/404); 不读超大请求体, 直接关连接.
        """
        header = self.headers.get("Content-Length")
        if header is None:
            return
        try:
            length = int(header)
        except ValueError:
            self.close_connection = True
            return
        if length <= 0:
            return
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            return
        self.rfile.read(length)

    def _read_json_body(self) -> dict[str, Any]:
        """读并解析 JSON 请求体; 请求体超过上限时不读, 直接 413 并关连接."""
        header = self.headers.get("Content-Length")
        if header is None:
            raise _error(HTTPStatus.LENGTH_REQUIRED, "length_required", "缺少 Content-Length")
        try:
            length = int(header)
        except ValueError:
            raise _error(HTTPStatus.BAD_REQUEST, "invalid_request", "Content-Length 不合法")
        if length < 0:
            raise _error(HTTPStatus.BAD_REQUEST, "invalid_request", "Content-Length 不合法")
        if length > MAX_BODY_BYTES:
            # 不读超大请求体, 免得把整张 SVG 留在缓冲区里.
            self.close_connection = True
            raise _error(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                "payload_too_large",
                f"请求体超过 {MAX_BODY_BYTES} 字节上限",
            )
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise _error(
                HTTPStatus.BAD_REQUEST, "invalid_scene", f"请求体不是合法 JSON: {exc}"
            ) from exc
        if not isinstance(body, dict):
            raise _error(HTTPStatus.BAD_REQUEST, "invalid_scene", "请求体顶层必须是 JSON 对象")
        return body

    # -- GET --------------------------------------------------------------

    def _get(self) -> None:
        path = self._url_path()
        if path == "/api/doc":
            self._get_doc()
        elif path == "/api/geo":
            self._serve_file(self._figure().geo_path, "application/json; charset=utf-8")
        elif path == "/api/scene":
            self._get_scene()
        elif path == "/api/health":
            self._get_health()
        elif path == "/base.svg":
            self._serve_file(self._figure().base_path, "image/svg+xml")
        elif path == "/final.svg":
            self._serve_file(self._figure().final_path, "image/svg+xml")
        elif path == "/geo.json":
            self._serve_file(self._figure().geo_path, "application/json; charset=utf-8")
        elif path in ("/", "/map", "/map.html"):
            self._serve_static("/map.html")
        elif path == "/sketch":
            self._serve_static("/index.html")
        else:
            self._serve_static(path)

    def _get_health(self) -> None:
        self._send_json(
            HTTPStatus.OK,
            {
                "ok": True,
                "version": page_mod.VERSION,
                "figures": sorted(self._config.figures),
                "python": platform.python_version(),
                "cwd": str(Path.cwd()),
            },
        )

    def _get_doc(self) -> None:
        figure = self._figure()
        base, base_errors = _base_state(figure)
        warnings: list[str] = list(base_errors)
        geo_error: str | None = None
        geo = None
        try:
            geo = _read_geo(figure)
        except ApiError as exc:
            geo_error = str(exc.payload.get("message", "geo.json 不可用"))
            warnings.append(geo_error)

        scene, from_file, scene_error = _load_scene(figure)
        if scene_error:
            warnings.append(f"scene 文件不合法: {scene_error}")
        scene_digest = page_mod.scene_digest(scene) if scene is not None else None

        final_marker: dict[str, Any] | None = None
        if figure.final_path.is_file():
            try:
                final_marker = contract.read_marker(figure.final_path.read_bytes())
            except OSError as exc:
                warnings.append(f"读取 final 失败: {exc}")

        needs_ack = False
        if from_file and scene is not None and base is not None:
            claim = scene.get("base")
            if isinstance(claim, dict):
                if _scene_size_changed(claim, base):
                    warnings.append("底图尺寸已变: scene 需要重新排版后保存")
                elif claim.get("sha256") != base.sha256:
                    needs_ack = True
                    warnings.append("底图已更新: 保存时需要 ack_base_change 确认")

        marker_scene = final_marker.get("scene") if isinstance(final_marker, dict) else None
        self._send_json(
            HTTPStatus.OK,
            {
                "figure": {"key": figure.key, "path": figure.figure_name},
                "base": {
                    "url": "/base.svg",
                    "sha256": base.sha256 if base is not None else "",
                    "width_pt": round(base.width_pt, 3) if base is not None else 0.0,
                    "height_pt": round(base.height_pt, 3) if base is not None else 0.0,
                },
                "geo": {"url": "/geo.json"},
                "scene": {"url": "/api/scene", "sha256": scene_digest},
                "final": {"url": "/final.svg", "marker": final_marker},
                "needs": {
                    "base": base is None,
                    "geo": geo is None,
                    "compose": scene is not None and marker_scene != scene_digest,
                    "ack": needs_ack,
                },
                "warnings": warnings,
            },
        )

    def _get_scene(self) -> None:
        """scene.json 原样返回; 不存在时返回 JSON null, 由前端用 geo 生成初始排版."""
        figure = self._figure()
        try:
            body = figure.scene_path.read_bytes()
        except FileNotFoundError:
            self._send_bytes(HTTPStatus.OK, b"null", "application/json; charset=utf-8")
            return
        except OSError as exc:
            raise _error(
                HTTPStatus.INTERNAL_SERVER_ERROR, "internal", f"读取 scene 失败: {exc}"
            ) from exc
        self._send_bytes(HTTPStatus.OK, body, "application/json; charset=utf-8")

    def _serve_file(self, path: Path, content_type: str) -> None:
        try:
            body = path.read_bytes()
        except FileNotFoundError as exc:
            raise _error(HTTPStatus.NOT_FOUND, "not_found", f"文件不存在: {path.name}") from exc
        except OSError as exc:
            raise _error(
                HTTPStatus.INTERNAL_SERVER_ERROR, "internal", f"读取文件失败: {exc}"
            ) from exc
        self._send_bytes(HTTPStatus.OK, body, content_type)

    def _serve_static(self, url_path: str) -> None:
        """只服务 web_dist 的 index.html/map.html 与 assets/**, 其它一律 404."""
        target = _static_target(self._config.web_dist, url_path)
        if target is None:
            raise _error(HTTPStatus.NOT_FOUND, "not_found", f"没有这个资源: {url_path}")
        try:
            body = target.read_bytes()
        except FileNotFoundError as exc:
            message = f"文件不存在: {url_path}"
            if target.suffix == ".html":
                message += "(前端构建产物缺失, 请先 npm run build)"
            raise _error(HTTPStatus.NOT_FOUND, "not_found", message) from exc
        except OSError as exc:
            raise _error(
                HTTPStatus.INTERNAL_SERVER_ERROR, "internal", f"读取静态文件失败: {exc}"
            ) from exc
        content_type = _CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
        self._send_bytes(HTTPStatus.OK, body, content_type)

    # -- PUT / POST -------------------------------------------------------

    def _put(self) -> None:
        if self._url_path() != "/api/scene":
            self._discard_body()
            raise _error(HTTPStatus.NOT_FOUND, "not_found", "没有这个端点")
        self._put_scene()

    def _post(self) -> None:
        if self._url_path() != "/api/compose":
            self._discard_body()
            raise _error(HTTPStatus.NOT_FOUND, "not_found", "没有这个端点")
        # /api/compose 不需要请求体; 若客户端带了, 读掉以免污染 keep-alive 连接.
        self._discard_body()
        self._post_compose()

    def _compose_current(
        self, figure: FigureConfig, scene: dict[str, Any]
    ) -> dict[str, Any]:
        """跑一次 compose, 把错误映射成 HTTP; 返回响应体公共字段."""
        try:
            report = compose_mod.compose(
                scene, figure.base_path, figure.geo_path, figure.final_path
            )
        except compose_mod.RenderingBusy as exc:
            return {
                "ok": True,
                "composed": False,
                "code": "rendering",
                "message": "合成锁被占用, scene 已保存, 稍后重试",
            }
        except compose_mod.BaseInvalid as exc:
            raise _error(HTTPStatus.SERVICE_UNAVAILABLE, "base_missing", str(exc)) from exc
        except compose_mod.GeoInvalid as exc:
            raise _error(HTTPStatus.SERVICE_UNAVAILABLE, "geo_invalid", str(exc)) from exc
        except compose_mod.SceneInvalid as exc:
            raise _error(HTTPStatus.BAD_REQUEST, "invalid_scene", str(exc)) from exc
        return {
            "ok": True,
            "composed": True,
            "marker": contract.read_marker(figure.final_path.read_bytes()),
            "report": report,
        }

    def _put_scene(self) -> None:
        """校验 → 声明复核(auth 底图) → 规范化原子写 → compose."""
        figure = self._figure()
        body = self._read_json_body()
        # ack 是保存动作的元数据, 不属于 scene 契约; 先摘掉再校验.
        ack = body.pop("ack_base_change", False)
        if not isinstance(ack, bool):
            raise _error(HTTPStatus.BAD_REQUEST, "invalid_scene", "ack_base_change 必须是布尔")
        # figure 由服务器盖章: 浏览器提交的语义体不含 figure, 校验/规范化都需要它.
        body["figure"] = figure.figure_name

        base, base_errors = _base_state(figure)
        if base is None:
            raise _error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "base_missing",
                "底图不可用: " + "; ".join(base_errors),
            )
        try:
            _read_geo(figure)
        except ApiError:
            # geo 缺失时排版层无法可靠渲染刻度/色标; 只允许在持 ack 时省略? 不, 直接拒绝.
            raise

        claim = body.get("base")
        if not isinstance(claim, dict):
            raise _error(HTTPStatus.BAD_REQUEST, "invalid_scene", "scene.base 必须是对象")
        if _scene_size_changed(claim, base):
            raise ApiError(
                HTTPStatus.CONFLICT,
                {
                    "ok": False,
                    "code": "base_size_changed",
                    "message": "底图尺寸已变, 请刷新页面后重新排版保存",
                    "base": base.to_dict(),
                },
            )
        if claim.get("sha256") != base.sha256 and not ack:
            raise ApiError(
                HTTPStatus.CONFLICT,
                {
                    "ok": False,
                    "code": "base_changed",
                    "message": "底图已更新, 请复查排版后带 ack_base_change 重新保存",
                    "base": base.to_dict(),
                },
            )

        # 先做结构校验再规范化: normalize 假设字段形状正确, 不能拿它当类型检查.
        errors = page_mod.validate_scene(body)
        if errors:
            raise _error(HTTPStatus.BAD_REQUEST, "invalid_scene", "; ".join(errors))
        try:
            normalized = page_mod.normalize_scene(
                body, figure=figure.figure_name, base=base.to_dict()
            )
        except page_mod.SceneError as exc:
            raise _error(HTTPStatus.BAD_REQUEST, "invalid_scene", str(exc)) from exc

        data = page_mod.canonical_bytes(normalized)
        fsutil.atomic_write_bytes(figure.scene_path, data)
        scene_sha = page_mod.scene_digest(normalized)

        result = self._compose_current(figure, normalized)
        result.update({"saved": True, "scene_sha": scene_sha})
        self._send_json(HTTPStatus.OK, result)

    def _post_compose(self) -> None:
        figure = self._figure()
        scene, _from_file, error = _load_scene(figure)
        if error:
            raise _error(HTTPStatus.BAD_REQUEST, "invalid_scene", error)
        if scene is None:
            raise _error(
                HTTPStatus.BAD_REQUEST, "invalid_scene", "还没有 scene.json, 请先保存排版"
            )
        base, base_errors = _base_state(figure)
        if base is None:
            raise _error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "base_missing",
                "底图不可用: " + "; ".join(base_errors),
            )
        result = self._compose_current(figure, scene)
        self._send_json(HTTPStatus.OK, result)


def _static_target(web_dist: Path, url_path: str) -> Path | None:
    """把 URL 路径映射到 web_dist 内的白名单文件; 不命中返回 None.

    只允许 index.html / map.html 与 assets/ 子树, 并拒绝空段/./..; 最后用 resolve +
    relative_to 把符号链接逃逸也挡掉.
    """
    if "\x00" in url_path:
        return None
    if url_path in ("/", "/index.html"):
        return web_dist / "index.html"
    if url_path in ("/map", "/map.html"):
        return web_dist / "map.html"
    prefix = "/assets/"
    if not url_path.startswith(prefix):
        return None
    relative = url_path[len(prefix) :]
    if not relative:
        return None
    parts = relative.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return None
    assets_root = (web_dist / "assets").resolve()
    candidate = (assets_root / relative).resolve()
    try:
        candidate.relative_to(assets_root)
    except ValueError:
        return None
    return candidate


# ---------------------------------------------------------------- 启动


def make_server(config: StudioConfig) -> StudioServer:
    """创建并绑定监听套接字; 测试用 port=0 拿系统分配端口."""
    return StudioServer((HOST, config.port), config)


def _startup_compose(config: StudioConfig) -> None:
    """启动时若有 scene 且底图/geo 就绪, 自动合成一次; 失败只打印提示不阻止启动."""
    for figure in config.figures.values():
        base, base_errors = _base_state(figure)
        if base is None:
            print(f"提示: {figure.key} 跳过合成({'; '.join(base_errors)}); "
                  "请先运行 python3 tools/prepare_demo.py", flush=True)
            continue
        try:
            _read_geo(figure)
        except ApiError as exc:
            print(f"提示: {figure.key} 跳过合成({exc.payload.get('message')})", flush=True)
            continue
        scene, from_file, error = _load_scene(figure)
        if error:
            print(f"提示: {figure.key} scene 文件不合法, 跳过合成: {error}", flush=True)
            continue
        if not from_file or scene is None:
            print(f"提示: {figure.key} 还没有 scene.json, 跳过启动合成", flush=True)
            continue
        try:
            report = compose_mod.compose(
                scene, figure.base_path, figure.geo_path, figure.final_path
            )
        except compose_mod.ComposeError as exc:
            print(f"提示: {figure.key} 合成失败: {exc}", flush=True)
            continue
        print(
            f"已合成 {figure.final_path} (items={report['counts']['total']})",
            flush=True,
        )


def main() -> int:
    # 故意不接受命令行参数: 端口/图/静态目录都写在 TOML 里, 传参数只会让人以为生效了.
    if len(sys.argv) > 1:
        print(
            "错误: 这个工具不接受命令行参数, 配置写在 "
            f"{CONFIG_FILE} 里, 直接运行 python3 tools/studio.py",
            file=sys.stderr,
        )
        return 2

    try:
        # 环境变量覆盖只在启动时生效, 不进入 load_config(见 apply_env_overrides).
        config = apply_env_overrides(load_config())
    except StudioConfigError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 2

    try:
        server = make_server(config)
    except OSError as exc:
        print(f"错误: 无法监听 {HOST}:{config.port}: {exc}", file=sys.stderr)
        return 1

    _startup_compose(config)
    port = server.server_address[1]
    url = f"http://{HOST}:{port}/"
    print(
        f"mapdoc studio 已就绪: {url} "
        f"(figures: {', '.join(sorted(config.figures))}; 静态目录: {config.web_dist})",
        flush=True,
    )
    if config.open_browser:
        try:
            webbrowser.open(url)
        except Exception as exc:  # noqa: BLE001 - 打不开浏览器不该拖垮服务器
            print(f"提示: 无法自动打开浏览器({exc}), 请手动访问 {url}", flush=True)

    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        print("已停止", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
