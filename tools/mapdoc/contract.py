"""底图(SVG)契约检查、viewBox 解析与 final marker 编解码.

是什么: 只读地检查一张底图是否满足 C1/C3/C6/C8, 提供 sha256、``</svg>`` 插入位置,
以及 ``<!-- mapdoc-final:...>`` marker 的生成/解析.
为什么: compose 之前必须把"旧版/半成品底图"(缺字体、缺 labels、已被写过 marker)挡在外面;
marker 用 base64 包 JSON 是因为 XML 注释里不能出现 ``--``, 而 JSON 里概率出现.
元信息: 2026-10, mapdoc 垂直切片; 契约见 docs/merge/DESIGN.md 3.1/3.5.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# 根 SVG 收尾标记: C3 要求它唯一且位于文件末尾(最后 7 字节).
SVG_CLOSE = b"</svg>"
# 叠加层身份与 final marker 前缀: C6 要求底图里两者都不出现.
OVERLAY_MARK = b"mapdoc-overlay"
FINAL_MARK = b"mapdoc-final"
# marker 注释: 前缀 + 标准 base64 + 空格 + -->; 抽取正则与契约 §4 完全一致.
MARKER_PATTERN = re.compile(rb"<!-- mapdoc-final:([A-Za-z0-9+/=]+) -->")
# 底图 sha256 声明与 marker 里 scene/base 的十六进制形状.
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")


@dataclass(frozen=True)
class BaseCheck:
    """一次底图契约检查的结果; errors 为空即通过(C1/C3/C6/C8)."""

    width_pt: float
    height_pt: float
    errors: tuple[str, ...]
    warnings: tuple[str, ...]
    text_count: int
    font_face_count: int
    viewbox: tuple[float, float, float, float] | None

    @property
    def ok(self) -> bool:
        return not self.errors


def sha256(data: bytes) -> str:
    """返回 bytes 的 sha256 十六进制小写摘要."""
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
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

    为什么不能直接 find('>'): 属性值(data URI 字体)里可能含 '>', 只按引号状态扫描才安全.
    """
    quote: int | None = None
    index = start
    while index < len(data):
        byte = data[index]
        if quote is not None:
            if byte == quote:
                quote = None
        elif byte in (0x22, 0x27):  # 双引号 / 单引号
            quote = byte
        elif byte == 0x3E:  # '>'
            return index
        index += 1
    return -1


def _parse_viewbox(tag: bytes) -> tuple[float, float, float, float] | None:
    """从根 <svg> 起始标签里解析 viewBox="minx miny w h"; 形状不对返回 None."""
    match = re.search(rb'viewBox\s*=\s*"([^"]*)"', tag)
    if match is None:
        match = re.search(rb"viewBox\s*=\s*'([^']*)'", tag)
    if match is None:
        return None
    parts = match.group(1).split()
    if len(parts) != 4:
        return None
    try:
        values = tuple(float(part) for part in parts)
    except ValueError:
        return None
    if not all(value == value and abs(value) != float("inf") for value in values):
        return None
    return values  # type: ignore[return-value]


def read_base_check(data: bytes) -> BaseCheck:
    """检查底图字节是否满足 C1/C3/C6/C8, 并返回 viewBox 尺寸与发现的问题.

    这是纯函数, 不解析整棵 XML 树: 只读根标签、数收尾标记、扫字体/marker 关键字,
    所以在 10 MB 底图上也是毫秒级.
    """
    errors: list[str] = []
    warnings: list[str] = []
    viewbox: tuple[float, float, float, float] | None = None
    width_pt = 0.0
    height_pt = 0.0

    # C1: 根 <svg> 必须有合法 viewBox, W/H > 0, 且根级不许有 transform.
    start = data.find(b"<svg")
    if start < 0:
        errors.append("C1: 找不到根 <svg> 元素")
    else:
        end = _find_tag_end(data, start)
        if end < 0:
            errors.append("C1: 根 <svg> 起始标签没有闭合")
        else:
            root = data[start : end + 1]
            if b"transform" in root:
                errors.append("C1: 根 <svg> 上不允许出现 transform")
            viewbox = _parse_viewbox(root)
            if viewbox is None:
                errors.append("C1: 根 <svg> 缺少合法的 viewBox=\"0 0 W H\"")
            else:
                width_pt, height_pt = viewbox[2], viewbox[3]
                if not width_pt > 0 or not height_pt > 0:
                    errors.append(f"C1: viewBox 宽高必须 > 0, 得到 {width_pt}x{height_pt}")

    # C3: </svg> 唯一且位于文件末尾(契约实测 offset = len - 7, 即后缀 "</svg>\n").
    close_count = data.count(SVG_CLOSE)
    if close_count != 1:
        errors.append(f"C3: </svg> 应恰好出现 1 次, 实际 {close_count} 次")
    elif data.rfind(SVG_CLOSE) != len(data) - len(SVG_CLOSE) - 1:
        errors.append("C3: </svg> 不在文件末尾(要求紧邻最后一个换行)")

    # C6: 底图不能带叠加层痕迹, 否则 compose 不再从干净底图出发.
    if OVERLAY_MARK in data:
        errors.append("C6: 底图包含 mapdoc-overlay 痕迹")
    if FINAL_MARK in data:
        errors.append("C6: 底图包含 mapdoc-final marker")

    # C8: 含 <text> 时必须内嵌 WOFF 字体(data URI), 挡住旧版/半成品底图.
    text_count = len(re.findall(rb"<text\b", data))
    font_face_count = len(re.findall(rb"@font-face", data))
    if text_count and not font_face_count:
        errors.append("C8: 底图含 <text> 但没有 @font-face 字体块")
    elif text_count and b"data:font/woff" not in data:
        errors.append("C8: 底图 @font-face 的 src 不是 data:font/woff 内嵌字体")
    if text_count and font_face_count:
        warnings.append(f"底图含 {text_count} 个 text 元素与 {font_face_count} 个 @font-face")

    return BaseCheck(
        width_pt=width_pt,
        height_pt=height_pt,
        errors=tuple(errors),
        warnings=tuple(warnings),
        text_count=text_count,
        font_face_count=font_face_count,
        viewbox=viewbox,
    )


def check_base_file(path: Path) -> BaseCheck:
    """读取文件并做底图契约检查; 读不到时返回带错误的结果而不是抛异常."""
    try:
        data = path.read_bytes()
    except OSError as exc:
        return BaseCheck(
            width_pt=0.0,
            height_pt=0.0,
            errors=(f"无法读取底图 {path}: {exc}",),
            warnings=(),
            text_count=0,
            font_face_count=0,
            viewbox=None,
        )
    return read_base_check(data)


def insert_position(data: bytes) -> int:
    """返回 compose 插入位置 = 最后一个 </svg> 的下标; 不满足 C3 时抛 ValueError."""
    if data.count(SVG_CLOSE) != 1:
        raise ValueError("底图里 </svg> 不唯一, 不能拼接")
    position = data.rfind(SVG_CLOSE)
    if position != len(data) - len(SVG_CLOSE) - 1:
        raise ValueError("底图 </svg> 不在文件末尾, 不能拼接")
    return position


def make_marker(scene_sha: str, base_sha: str, counts: dict[str, int]) -> str:
    """生成 final marker 注释; JSON 用 sort_keys/紧凑分隔符保证同输入同字节."""
    if not is_sha256(scene_sha):
        raise ValueError(f"scene sha256 不合法: {scene_sha!r}")
    if not is_sha256(base_sha):
        raise ValueError(f"base sha256 不合法: {base_sha!r}")
    payload = {
        "format": "mapdoc-final",
        "version": 1,
        "scene": scene_sha,
        "base": base_sha,
        "counts": {
            "points": int(counts.get("points", 0)),
            "entities": int(counts.get("entities", 0)),
            "constraints": int(counts.get("constraints", 0)),
            "texts": int(counts.get("texts", 0)),
        },
    }
    raw = json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    encoded = base64.b64encode(raw).decode("ascii")
    return f"<!-- mapdoc-final:{encoded} -->"


def parse_marker(data: bytes | str) -> dict[str, Any] | None:
    """抽取并解码 final marker; 没有 marker 或内容不合法返回 None."""
    if isinstance(data, str):
        raw = data.encode("utf-8")
    else:
        raw = data
    match = MARKER_PATTERN.search(raw)
    if match is None:
        return None
    try:
        decoded = base64.b64decode(match.group(1), validate=True)
        payload = json.loads(decoded.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    if payload.get("format") != "mapdoc-final" or payload.get("version") != 1:
        return None
    return payload


def marker_scene_sha(marker: dict[str, Any] | None) -> str | None:
    """从 marker 里取 scene sha256; 形状不对返回 None."""
    if not isinstance(marker, dict):
        return None
    value = marker.get("scene")
    return value if is_sha256(value) else None


def marker_base_sha(marker: dict[str, Any] | None) -> str | None:
    """从 marker 里取 base sha256; 形状不对返回 None."""
    if not isinstance(marker, dict):
        return None
    value = marker.get("base")
    return value if is_sha256(value) else None
