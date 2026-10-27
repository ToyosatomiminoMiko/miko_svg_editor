"""底图(SVG)契约检查、根标签解析、sha256 与 final marker 编解码.

是什么: ``read_base(data)`` 对纯底图做 C1..C4 检查并给出 viewBox/尺寸/内联拼接偏移;
``sha256``/``sha256_file``/``is_sha256`` 是摘要工具; ``make_marker``/``read_marker``
处理 §6.1 的 ``<!-- mapdoc-final:<base64(JSON)> -->`` 注释.

为什么: compose 只在合格底图上内联排版层, 否则会把 "成品当底图" 的旧字节越嵌越深;
marker 用 base64 包 JSON, 是因为 XML 注释里不能出现 ``--``, 而 JSON 文本里完全可能.
检查全部是字符串级扫描(不解析整棵 XML), 所以 10 MB 底图也是毫秒级.

元信息: 2026-10, 新数据流(纯底图 + geo + 排版层); 契约见 docs/PAGE-EDITOR.md §6.1/§7.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# 根 SVG 收尾标记: C3 要求它唯一, 且后面最多跟一个换行.
SVG_OPEN = b"<svg"
SVG_CLOSE = b"</svg>"
# 叠加层身份与 final marker 前缀: C4 要求底图里两者都不出现.
OVERLAY_MARK = b"mapdoc-overlay"
FINAL_MARK = b"mapdoc-final"
# marker 注释: 前缀 + 标准 base64 + 可选空白 + -->; 与 §6.1 的写法对应.
MARKER_PATTERN = re.compile(rb"<!--\s*mapdoc-final:([A-Za-z0-9+/=]+)\s*-->")
# 底图 sha256 声明的十六进制形状.
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
# 根标签里 viewBox 属性(单/双引号).
_VIEWBOX_ATTR = re.compile(rb"""viewBox\s*=\s*(["'])(.*?)\1""")
# 根标签里 width/height 属性; 只用于「声明的画布尺寸是否与 viewBox 一致」的告警.
_ROOT_WIDTH_ATTR = re.compile(rb"""(?:^|\s)width\s*=\s*["']([0-9.]+)\s*(?:pt|px)?["']""")
_ROOT_HEIGHT_ATTR = re.compile(rb"""(?:^|\s)height\s*=\s*["']([0-9.]+)\s*(?:pt|px)?["']""")
# 数字: 用于解析根标签里的尺寸.
_NUMBER = re.compile(rb"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")


@dataclass(frozen=True)
class BaseInfo:
    """一次底图契约检查的完整结果; ``errors`` 为空即合格.

    C1 通过时 ``view_box``/``width_pt``/``height_pt``/``inner_start``/``inner_end`` 总是填好,
    即使 C2/C3/C4 失败 —— studio 需要读最终成品(含 ``<text>``)的根尺寸, 不能因为 C2 就丢数据.
    ``inner_start`` 是根起始标签 ``>`` 之后第一个字节, ``inner_end`` 是最后一个 ``</svg>``
    的 ``<`` 偏移; compose 用 ``data[:inner_start] + overlay + data[inner_end:]`` 内联.
    """

    view_box: tuple[float, float, float, float] | None
    width_pt: float
    height_pt: float
    inner_start: int
    inner_end: int
    errors: tuple[str, ...]
    warnings: tuple[str, ...]

    @property
    def ok(self) -> bool:
        """没有 errors 即合格; 只是便利属性, 不作为判定来源."""
        return not self.errors


def sha256(data: bytes) -> str:
    """返回 bytes 的 sha256 十六进制小写摘要."""
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path | str) -> str:
    """流式计算文件 sha256, 避免把 10 MB 底图整份读进内存第二遍."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_sha256(value: object) -> bool:
    """判断 value 是否是 64 位小写十六进制 sha256 字符串."""
    return isinstance(value, str) and SHA256_PATTERN.fullmatch(value) is not None


def _find_tag_end(data: bytes, start: int) -> int:
    """从 start 起找到未处于引号内的 '>' 下标; 找不到返回 -1.

    为什么不能直接 find('>'): 属性值(data URI 字体/图片)里可能含 '>', 只按引号状态扫描才安全.
    """
    index = start
    length = len(data)
    while index < length:
        byte = data[index]
        if byte == 0x3E:  # '>'
            return index
        if byte in (0x22, 0x27):  # 双引号 / 单引号
            closing = data.find(bytes((byte,)), index + 1)
            if closing < 0:
                return -1
            index = closing + 1
        else:
            index += 1
    return -1


def _find_root(data: bytes) -> int:
    """返回根 <svg 元素起始偏移; 找不到返回 -1(只接受 <svg 后紧跟空白/'/'/'>' 的写法)."""
    index = 0
    while True:
        index = data.find(SVG_OPEN, index)
        if index < 0:
            return -1
        following = data[index + len(SVG_OPEN) : index + len(SVG_OPEN) + 1]
        if following in (b" ", b"\t", b"\r", b"\n", b">", b"/"):
            return index
        index += len(SVG_OPEN)


def _parse_viewbox(root_tag: bytes) -> tuple[float, float, float, float] | None:
    """从根 <svg> 起始标签里解析 viewBox="minx miny w h"; 形状不对返回 None."""
    match = _VIEWBOX_ATTR.search(root_tag)
    if match is None:
        return None
    parts = match.group(2).split()
    if len(parts) != 4:
        return None
    values: list[float] = []
    for part in parts:
        try:
            values.append(float(part))
        except ValueError:
            return None
    if any(value != value or value in (float("inf"), float("-inf")) for value in values):
        return None
    return (values[0], values[1], values[2], values[3])


def _root_size_attrs(root_tag: bytes) -> tuple[float, float] | None:
    """取根标签上 width/height 属性的数值(去掉 pt/px), 用于和 viewBox 对账.

    分开匹配两个属性, 不依赖它们在起始标签里的先后顺序.
    """
    sizes: list[float] = []
    for pattern in (_ROOT_WIDTH_ATTR, _ROOT_HEIGHT_ATTR):
        match = pattern.search(root_tag)
        if match is None:
            return None
        try:
            sizes.append(float(match.group(1)))
        except ValueError:
            return None
    return (sizes[0], sizes[1])


def read_base(data: bytes) -> BaseInfo:
    """检查底图字节是否满足 C1..C4, 并返回 viewBox 尺寸与内联偏移(纯函数, 不解析 XML).

    C1: 有根 <svg>, 合法 viewBox, w/h > 0.
    C2: 不含 ``<text``(纯地图, 注释/标题/刻度文字都不允许).
    C3: ``</svg>`` 恰好 1 次, 位于文件末尾(允许最多一个换行).
    C4: 不含 mapdoc-overlay / mapdoc-final 痕迹.
    """
    errors: list[str] = []
    warnings: list[str] = []
    viewbox: tuple[float, float, float, float] | None = None
    width_pt = 0.0
    height_pt = 0.0
    inner_start = 0
    inner_end = 0

    # C1: 根 <svg> + 合法 viewBox. 偏移即使在 C1 失败时也尽量填(找不到时保持 0).
    root_start = _find_root(data)
    root_tag_end = -1
    if root_start < 0:
        errors.append("C1: 找不到根 <svg 元素")
    else:
        root_tag_end = _find_tag_end(data, root_start)
        if root_tag_end < 0:
            errors.append("C1: 根 <svg> 起始标签没有闭合")
        else:
            inner_start = root_tag_end + 1
            root_tag = data[root_start : root_tag_end + 1]
            viewbox = _parse_viewbox(root_tag)
            if viewbox is None:
                errors.append('C1: 根 <svg> 缺少合法的 viewBox="x y w h"')
            else:
                width_pt, height_pt = viewbox[2], viewbox[3]
                if not width_pt > 0 or not height_pt > 0:
                    errors.append(
                        f"C1: viewBox 宽高必须 > 0, 得到 {width_pt}x{height_pt}"
                    )
            declared = _root_size_attrs(root_tag)
            if viewbox is not None and declared is not None:
                if abs(declared[0] - viewbox[2]) > 0.01 or abs(
                    declared[1] - viewbox[3]
                ) > 0.01:
                    warnings.append(
                        "根 width/height 与 viewBox 尺寸不一致: "
                        f"{declared[0]}x{declared[1]} vs {viewbox[2]}x{viewbox[3]}"
                    )

    # C3: </svg> 唯一且在末尾(后缀允许空/一个 "\n"/"\r\n").
    close_count = data.count(SVG_CLOSE)
    if close_count != 1:
        errors.append(f"C3: </svg> 应恰好出现 1 次, 实际 {close_count} 次")
    else:
        inner_end = data.rfind(SVG_CLOSE)
        tail = data[inner_end + len(SVG_CLOSE) :]
        if tail not in (b"", b"\n", b"\r\n"):
            errors.append("C3: </svg> 之后只允许一个换行, 实际还有其它字节")

    # C2: 纯底图里不允许任何 <text>/<textPath>/<tspan> 之类文字元素(按前缀判断).
    if b"<text" in data:
        errors.append("C2: 底图里不允许出现 <text> 元素")

    # C4: 不允许叠加层/final marker 痕迹, 否则 compose 会从已被写过的字节继续拼.
    if OVERLAY_MARK in data:
        errors.append("C4: 底图包含 mapdoc-overlay 痕迹")
    if FINAL_MARK in data:
        errors.append("C4: 底图包含 mapdoc-final marker")

    return BaseInfo(
        view_box=viewbox,
        width_pt=width_pt,
        height_pt=height_pt,
        inner_start=inner_start,
        inner_end=inner_end,
        errors=tuple(errors),
        warnings=tuple(warnings),
    )


def check_base_file(path: Path | str) -> BaseInfo:
    """读取文件并做底图契约检查; 读不到时返回带错误的结果而不是抛异常."""
    try:
        data = Path(path).read_bytes()
    except OSError as exc:
        return BaseInfo(
            view_box=None,
            width_pt=0.0,
            height_pt=0.0,
            inner_start=0,
            inner_end=0,
            errors=(f"无法读取底图 {path}: {exc}",),
            warnings=(),
        )
    return read_base(data)


def make_marker(payload: dict[str, Any]) -> bytes:
    """生成 final marker 注释字节; JSON 键排序/紧凑分隔符保证同输入同字节.

    payload 形状见 §6.1: ``{"counts":{...},"geo":"<sha256>","scene":"<sha256>","version":1}``.
    返回完整的 ``<!-- mapdoc-final:BASE64 -->``(bytes), 便于 compose 直接拼接字节流.
    """
    if not isinstance(payload, dict):
        raise ValueError("marker payload 必须是 dict")
    if payload.get("version") != 1:
        raise ValueError(f"marker payload.version 必须是 1, 得到 {payload.get('version')!r}")
    for key in ("geo", "scene"):
        value = payload.get(key)
        if not is_sha256(value):
            raise ValueError(f"marker payload.{key} 必须是 sha256 十六进制, 得到 {value!r}")
    counts = payload.get("counts")
    if not isinstance(counts, dict):
        raise ValueError("marker payload.counts 必须是 dict")
    raw = json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return b"<!-- mapdoc-final:" + base64.b64encode(raw) + b" -->"


def read_marker(data: bytes | str) -> dict[str, Any] | None:
    """抽取并解码 final marker; 没有 marker 或内容不合法返回 None(不抛异常)."""
    raw = data.encode("utf-8") if isinstance(data, str) else data
    match = MARKER_PATTERN.search(raw)
    if match is None:
        return None
    try:
        decoded = base64.b64decode(match.group(1), validate=True)
        payload = json.loads(decoded.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("version") != 1:
        return None
    for key in ("geo", "scene"):
        if key in payload and not is_sha256(payload[key]):
            return None
    counts = payload.get("counts")
    if counts is not None and not isinstance(counts, dict):
        return None
    return payload
