#!/usr/bin/env python3
"""成品 matplotlib/Cartopy SVG → (纯底图字节, geo 对象) 的一次性适配器.

是什么: ``extract(source)`` 用字符串手术从成品 SVG 里剥掉所有非地理内容(文字/标题/图例/
色标/图框/纸白底/内嵌字体), 把根 viewBox 裁到地图框, 同时抽出 ``docs/PAGE-EDITOR.md §3``
定义的 geo 对象; ``extract_file(path)`` 是读文件版.

为什么不用 ElementTree 重序列化: 成品里有 8 MB 的 data URI 图片与 XML 命名空间, 重序列化
会重排属性/转义实体/改写 base64 换行, 破坏字节级一致性与体积; 这里只删字节区间、改根标签.
为什么用 expat 建带字节偏移的轻量树: expat 的 ``CurrentByteIndex`` 给出每个元素的精确
起止位置, 一次线性解析(10 MB/0.1 s)就能拿到删除区间与父子关系, 比字符串正则配对可靠.

元信息: 2026-10, 新数据流(纯底图 + geo); 契约见 docs/PAGE-EDITOR.md §1/§3/§7.
"""

from __future__ import annotations

import base64
import math
import re
import struct
import xml.parsers.expat
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

from mapdoc import contract

# 数字/命令/transform 的扫描器; 只在本文件内使用, 编译一次.
_NUMBER = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
_PATH_TOKEN = re.compile(
    r"([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)"
)
_PATH_COMMANDS = re.compile(r"[MmLlHhVvCcSsQqTtAaZz]")
_CMD_ARITY = {
    "M": 2,
    "L": 2,
    "T": 2,
    "C": 6,
    "S": 4,
    "Q": 4,
    "A": 7,
    "H": 1,
    "V": 1,
    "Z": 0,
}
_TRANSFORM_FUNC = re.compile(r"([A-Za-z]+)\s*\(([^)]*)\)")
_ROTATE_FUNC = re.compile(r"rotate\s*\(\s*([-+]?(?:\d+\.?\d*|\.\d+))")
_CLIP_URL = re.compile(r"url\(\s*#([^)\s]+)\s*\)")
_PNG_DATA_URI = re.compile(r"^data:image/png;base64,", re.IGNORECASE)
# 经/纬标签: "35°E" / "46°N" / "-5°W" / "46" 之类; 只取数值与方向字母.
_LABEL_VALUE = re.compile(r"^\s*([-+]?(?:\d+\.?\d*|\.\d+))\s*(?:°|deg)?\s*([NSEWnsew])?\s*$")
# 地名组 id 的 kind 段; 不在表里的 kind 归 other.
_LABEL_KINDS = {"country", "sea", "highland", "river", "city", "area", "other"}
# 色标采样点数: 21 个点给出 20 段线性渐变, offset 恰为 0.05 的整数倍(便于 JSON 可读).
_STOP_COUNT = 21
# 图框 bbox 与地图框比较的相对容差: 成品坐标以 pt 计, 1e-3 相对量远大于浮点噪声.
_BBOX_TOLERANCE_RATIO = 1e-3


class ExtractError(ValueError):
    """输入不满足「带 matplotlib axes 的成品图」结构时抛出; 由调用方转成可读错误."""


@dataclass(eq=False)
class _Node:
    """带精确字节区间的最小 XML 节点; 只保留抽取需要的字段."""

    tag: str
    attrs: dict[str, str]
    start: int
    tag_end: int
    self_closing: bool
    parent: "_Node | None"
    end: int = -1
    children: list["_Node"] = field(default_factory=list)
    text_parts: list[str] = field(default_factory=list)

    def get(self, key: str, default: str | None = None) -> str | None:
        return self.attrs.get(key, default)

    def node_id(self) -> str:
        """返回 id 属性; 没有 id 时返回空串, 让 ``startswith`` 判断无需 None 检查."""
        return self.attrs.get("id", "")


def _tag_end(data: bytes, start: int) -> int:
    """从 '<' 起找到标签结束的 '>' 下标(跳过引号内文本); 失败返回 -1.

    为什么按引号扫描: data URI 图片/字体属性值里可能有 '>', 直接 find 会切错标签.
    """
    index = start
    length = len(data)
    while index < length:
        byte = data[index]
        if byte == 0x3E:
            return index
        if byte in (0x22, 0x27):
            closing = data.find(bytes((byte,)), index + 1)
            if closing < 0:
                return -1
            index = closing + 1
        else:
            index += 1
    return -1


def _parse_document(data: bytes) -> _Node:
    """用 expat 建带字节偏移的轻量树, 返回虚拟根(#document).

    只记录 text/tspan 的字符数据; 其余元素的文本(如 88 KB 的 @font-face style)不保留,
    避免为样式表在内存里再存一份大字符串.
    """
    parser = xml.parsers.expat.ParserCreate()
    root = _Node("#document", {}, 0, 0, False, None)
    stack: list[_Node] = [root]

    def on_start(tag: str, attrs: dict[str, str]) -> None:
        start = parser.CurrentByteIndex
        tag_end = _tag_end(data, start)
        if tag_end < 0:
            raise ExtractError(f"XML 标签未闭合: offset {start}")
        self_closing = data[tag_end - 1 : tag_end] == b"/"
        node = _Node(tag, attrs, start, tag_end, self_closing, stack[-1])
        stack[-1].children.append(node)
        stack.append(node)

    def on_end(_tag: str) -> None:
        node = stack.pop()
        if node.self_closing:
            node.end = node.tag_end + 1
        else:
            node.end = data.find(b">", parser.CurrentByteIndex) + 1

    def on_chars(chars: str) -> None:
        if stack and stack[-1].tag in ("text", "tspan"):
            stack[-1].text_parts.append(chars)

    parser.StartElementHandler = on_start
    parser.EndElementHandler = on_end
    parser.CharacterDataHandler = on_chars
    try:
        parser.Parse(data, True)
    except xml.parsers.expat.ExpatError as exc:
        raise ExtractError(f"源 SVG 不是合法 XML: {exc}") from exc
    if not root.children:
        raise ExtractError("源 SVG 没有根元素")
    return root.children[0]


def _preorder(node: _Node) -> Iterator[_Node]:
    """按文档序(绘制序)遍历 node 及其后代, 含自身."""
    yield node
    for child in node.children:
        yield from _preorder(child)


def _style_map(value: str | None) -> dict[str, str]:
    """把 style="a: b; c: d" 拆成小写键的字典; 值保持原样(颜色大小写不敏感, 但保留原文)."""
    result: dict[str, str] = {}
    if not value:
        return result
    for part in value.split(";"):
        if ":" not in part:
            continue
        key, raw = part.split(":", 1)
        key = key.strip().lower()
        if key:
            result[key] = raw.strip()
    return result


def _number(value: object) -> float | None:
    """解析一个数值属性; 失败返回 None(而不是抛异常).

    ``12.5pt`` / ``-3`` / ``1.4`` 都接受; 只取第一个数字, 因为属性里可能带单位.
    """
    if value is None:
        return None
    match = _NUMBER.search(str(value))
    if match is None:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def _floats(value: str) -> list[float]:
    """抽出一串数字(用于 stroke-dasharray 之类)."""
    return [float(item) for item in _NUMBER.findall(value)]


def _clean(value: float | None, digits: int = 6) -> float | int | None:
    """把浮点写成 geo 里的数字: 最多 digits 位小数, 整数值写成 int, 消掉 -0.0."""
    if value is None:
        return None
    rounded = round(float(value), digits)
    if rounded == 0:
        return 0
    if rounded == int(rounded):
        return int(rounded)
    return rounded


def _fmt(value: float) -> str:
    """SVG 属性里的数字格式: 最多 6 位小数, 去掉尾零; 与 geo 的数值保持一致."""
    text = f"{float(value):.6f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def _set_attribute(tag: bytes, name: str, value: str) -> bytes:
    """在起始标签字节里替换/插入一个属性, 保留其它属性的原始写法与顺序."""
    pattern = re.compile(rb"(\s" + re.escape(name.encode()) + rb"\s*=\s*)(\"[^\"]*\"|'[^']*')")
    match = pattern.search(tag)
    if match is not None:
        return tag[: match.start()] + match.group(1) + b'"' + value.encode() + b'"' + tag[match.end() :]
    opening = re.match(rb"<[A-Za-z_][^\s/>]*", tag)
    if opening is None:
        raise ExtractError("根 <svg> 起始标签形状无法识别")
    insert_at = opening.end()
    return tag[:insert_at] + b" " + name.encode() + b'="' + value.encode() + b'"' + tag[insert_at:]


def _mat_mul(left: tuple, right: tuple) -> tuple:
    """2D 仿射矩阵乘法(列向量约定): 返回 left ∘ right, 即先 right 再 left."""
    a1, b1, c1, d1, e1, f1 = left
    a2, b2, c2, d2, e2, f2 = right
    return (
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * e2 + c1 * f2 + e1,
        b1 * e2 + d1 * f2 + f1,
    )


def _parse_transform(value: str | None) -> tuple[float, float, float, float, float, float]:
    """把 SVG transform 列表合成一个 2D 仿射矩阵; 未知函数跳过.

    为什么需要矩阵: 色标 <image> 用 ``scale(1 -1) translate(...)`` 把栅格上下翻转,
    只有乘出完整矩阵才能判断 PNG 第 0 行落在可见区域的顶部还是底部.
    """
    matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    if not value:
        return matrix
    for name, raw_args in _TRANSFORM_FUNC.findall(value):
        args = _floats(raw_args)
        name = name.lower()
        if name == "translate" and args:
            step = (1.0, 0.0, 0.0, 1.0, args[0], args[1] if len(args) > 1 else 0.0)
        elif name == "scale" and args:
            step = (args[0], 0.0, 0.0, args[1] if len(args) > 1 else args[0], 0.0, 0.0)
        elif name == "rotate" and args:
            angle = math.radians(args[0])
            cos, sin = math.cos(angle), math.sin(angle)
            step = (cos, sin, -sin, cos, 0.0, 0.0)
            if len(args) >= 3:
                cx, cy = args[1], args[2]
                step = _mat_mul((1.0, 0.0, 0.0, 1.0, cx, cy), step)
                step = _mat_mul(step, (1.0, 0.0, 0.0, 1.0, -cx, -cy))
        elif name == "matrix" and len(args) >= 6:
            step = (args[0], args[1], args[2], args[3], args[4], args[5])
        else:
            continue
        matrix = _mat_mul(matrix, step)
    return matrix


def _apply(matrix: tuple, x: float, y: float) -> tuple[float, float]:
    """对点应用 2D 仿射矩阵."""
    a, b, c, d, e, f = matrix
    return (a * x + c * y + e, b * x + d * y + f)


def _path_points(d: str) -> list[tuple[float, float]]:
    """解析 path 的 d, 返回所有顶点/控制点/端点(绝对坐标).

    曲线控制点会让 bbox 略大于真实包围盒; 本文件只用它量 matplotlib 用 M/L 画的矩形
    (海陆底色、图框、clipPath), 那些路径没有曲线, 因此结果精确.
    """
    tokens = list(_PATH_TOKEN.finditer(d))
    points: list[tuple[float, float]] = []
    current = (0.0, 0.0)
    command: str | None = None
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token.group(1):
            command = token.group(1)
            index += 1
        if command is None:
            break
        upper = command.upper()
        arity = _CMD_ARITY.get(upper)
        if arity is None:
            break
        if arity == 0:
            command = None
            continue
        numbers: list[float] = []
        while len(numbers) < arity and index < len(tokens) and tokens[index].group(1) is None:
            numbers.append(float(tokens[index].group(2)))
            index += 1
        if len(numbers) < arity:
            break
        relative = command.islower()

        def point(px: float, py: float) -> tuple[float, float]:
            if relative:
                return (current[0] + px, current[1] + py)
            return (px, py)

        if upper in ("M", "L", "T"):
            moved = point(numbers[0], numbers[1])
            points.append(moved)
            current = moved
            if upper == "M":
                command = "l" if relative else "L"
        elif upper in ("C", "S", "Q"):
            for offset in range(0, len(numbers), 2):
                moved = point(numbers[offset], numbers[offset + 1])
                points.append(moved)
                current = moved
        elif upper == "A":
            moved = point(numbers[5], numbers[6])
            points.append(moved)
            current = moved
        elif upper == "H":
            current = (current[0] + numbers[0] if relative else numbers[0], current[1])
            points.append(current)
        elif upper == "V":
            current = (current[0], current[1] + numbers[0] if relative else numbers[0])
            points.append(current)
    return points


def _path_commands(d: str) -> set[str]:
    """返回 path 里出现过的命令字母(大写); 只给 marker 形状启发式用."""
    return {item.upper() for item in _PATH_COMMANDS.findall(d)}


def _path_vertices(d: str) -> list[tuple[float, float]]:
    """返回 M/L 产生的多段线顶点(不含曲线控制点), 用于 marker 形状判定."""
    tokens = list(_PATH_TOKEN.finditer(d))
    points: list[tuple[float, float]] = []
    current = (0.0, 0.0)
    command: str | None = None
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token.group(1) is not None:
            command = token.group(1)
            index += 1
        if command is None:
            break
        upper = command.upper()
        arity = _CMD_ARITY.get(upper)
        if arity is None:
            break
        if arity == 0:
            command = None
            continue
        numbers: list[float] = []
        while len(numbers) < arity and index < len(tokens) and tokens[index].group(1) is None:
            numbers.append(float(tokens[index].group(2)))
            index += 1
        if len(numbers) < arity:
            break
        relative = command.islower()
        if upper in ("M", "L"):
            moved = (
                (current[0] + numbers[0], current[1] + numbers[1])
                if relative
                else (numbers[0], numbers[1])
            )
            points.append(moved)
            current = moved
            if upper == "M":
                command = "l" if relative else "L"
        elif upper in ("C", "S", "Q"):
            for offset in range(0, len(numbers), 2):
                current = (
                    (current[0] + numbers[offset], current[1] + numbers[offset + 1])
                    if relative
                    else (numbers[offset], numbers[offset + 1])
                )
        elif upper == "A":
            current = (
                (current[0] + numbers[5], current[1] + numbers[6])
                if relative
                else (numbers[5], numbers[6])
            )
        elif upper == "H":
            current = (current[0] + numbers[0] if relative else numbers[0], current[1])
        elif upper == "V":
            current = (current[0], current[1] + numbers[0] if relative else numbers[0])
    return points


def _bbox_of_path(node: _Node) -> tuple[float, float, float, float] | None:
    """path 元素的包围盒; 注意控制点会让曲线包围盒偏大(本文件的矩形路径无曲线)."""
    d = node.get("d")
    if not d:
        return None
    points = _path_points(d)
    if not points:
        return None
    xs = [x for x, _ in points]
    ys = [y for _, y in points]
    return (min(xs), min(ys), max(xs), max(ys))


def _image_bbox(node: _Node) -> tuple[float, float, float, float] | None:
    """<image> 在可见坐标里的包围盒(对 4 个角应用该元素的 transform)."""
    x = _number(node.get("x")) or 0.0
    y = _number(node.get("y")) or 0.0
    width = _number(node.get("width"))
    height = _number(node.get("height"))
    if width is None or height is None:
        return None
    matrix = _parse_transform(node.get("transform"))
    corners = [
        _apply(matrix, x, y),
        _apply(matrix, x + width, y),
        _apply(matrix, x, y + height),
        _apply(matrix, x + width, y + height),
    ]
    xs = [cx for cx, _ in corners]
    ys = [cy for _, cy in corners]
    return (min(xs), min(ys), max(xs), max(ys))


def _bbox(node: _Node) -> tuple[float, float, float, float] | None:
    """通用包围盒: rect/image/path 直接算, 其它元素取子元素并集."""
    if node.tag == "rect":
        x = _number(node.get("x")) or 0.0
        y = _number(node.get("y")) or 0.0
        width = _number(node.get("width"))
        height = _number(node.get("height"))
        if width is None or height is None:
            return None
        return (x, y, x + width, y + height)
    if node.tag == "path":
        return _bbox_of_path(node)
    if node.tag == "image":
        return _image_bbox(node)
    boxes = [box for child in node.children if (box := _bbox(child)) is not None]
    if not boxes:
        return None
    return (
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    )


def _bbox_close(
    left: tuple[float, float, float, float],
    right: tuple[float, float, float, float],
    tolerance: float,
) -> bool:
    """两个 bbox 的 4 条边都在 tolerance 内视为同一个框."""
    return all(abs(l - r) <= tolerance for l, r in zip(left, right))


def _bbox_area(box: tuple[float, float, float, float]) -> float:
    """bbox 面积(宽×高); 用于「外框比内容大一个量级」这类判定."""
    return abs(box[2] - box[0]) * abs(box[3] - box[1])


def _bbox_contains(
    outer: tuple[float, float, float, float],
    inner: tuple[float, float, float, float],
    tolerance: float,
) -> bool:
    """inner 是否落在 outer 内(允许 tolerance 的溢出)."""
    return (
        inner[0] >= outer[0] - tolerance
        and inner[1] >= outer[1] - tolerance
        and inner[2] <= outer[2] + tolerance
        and inner[3] <= outer[3] + tolerance
    )


def _node_text(node: _Node) -> str:
    """元素内的文字(合并嵌套 tspan 的字符数据), 去首尾空白."""
    parts = list(node.text_parts)
    for child in node.children:
        if child.tag in ("tspan", "textPath"):
            nested = _node_text(child)
            if nested:
                parts.append(nested)
    return "".join(parts).strip()


def _first_descendant(node: _Node, tag: str) -> _Node | None:
    """子树里第一个指定标签的后代."""
    for item in _preorder(node):
        if item is not node and item.tag == tag:
            return item
    return None


def _text_position(node: _Node) -> tuple[float | None, float | None]:
    """文字锚点: 优先 x/y 属性; 没有时取 transform 的平移量(matplotlib 的 suptitle 写法)."""
    x = _number(node.get("x"))
    y = _number(node.get("y"))
    if x is not None and y is not None:
        return x, y
    matrix = _parse_transform(node.get("transform"))
    if x is None:
        x = matrix[4]
    if y is None:
        y = matrix[5]
    return x, y


def _rotation_deg(node: _Node) -> float | int:
    """文字旋转角: 取 transform 里 rotate() 的第一个参数并归一到 (-180, 180].

    为什么归一化: matplotlib 会写 rotate(-351.4 ...), 直接落 scene 会让前端拿到大角度;
    SVG 的 rotate 是顺时针(屏幕坐标 y 向下), 归一化只改表示, 不改外观.
    """
    match = _ROTATE_FUNC.search(node.get("transform") or "")
    if match is None:
        return 0
    value = float(match.group(1)) % 360.0
    if value > 180.0:
        value -= 360.0
    cleaned = _clean(value)
    return 0 if cleaned is None else cleaned


def _classify_marker(path_node: _Node) -> str | None:
    """从 marker 的 defs 路径判定 star/square/circle.

    启发式: 有 C/A 曲线且没有 L 的是圆(圆的贝塞尔近似); 4 个顶点且轴对齐的是方块;
    10 个顶点的折线是五角星(matplotlib 星形 = 5 外点 + 5 内点). 判不出返回 None.
    """
    if path_node.tag == "rect":
        return "square"
    d = path_node.get("d")
    if not d:
        return None
    commands = _path_commands(d)
    if ("C" in commands or "A" in commands) and "L" not in commands:
        return "circle"
    if "L" not in commands:
        return None
    vertices = _path_vertices(d)
    if len(vertices) >= 8:
        return "star"
    if len(vertices) == 4:
        xs = sorted({round(x, 6) for x, _ in vertices})
        ys = sorted({round(y, 6) for _, y in vertices})
        if len(xs) == 2 and len(ys) == 2:
            return "square"
    return None


def _decode_png(png: bytes) -> tuple[int, int, int, list[bytes]]:
    """解码 8 位非隔行 PNG, 返回 (宽, 高, 通道数, 每行原始字节).

    只支持色标用到的形态: 8 位深、无隔行、色型 0/2/3/4/6. 调色板图会先展开成 RGB,
    灰度图展开成 RGB/灰度+alpha 各自处理, 调用方只关心前 3 个通道.
    """
    if not png.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ExtractError("色标图片不是 PNG")
    position = 8
    width = height = bit_depth = color_type = None
    palette = b""
    compressed = bytearray()
    while position + 8 <= len(png):
        length = struct.unpack(">I", png[position : position + 4])[0]
        chunk_type = png[position + 4 : position + 8]
        chunk = png[position + 8 : position + 8 + length]
        position += 12 + length
        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, _comp, _filt, interlace = struct.unpack(
                ">IIBBBBB", chunk
            )
            if interlace != 0:
                raise ExtractError("色标 PNG 不支持隔行扫描")
        elif chunk_type == b"PLTE":
            palette = chunk
        elif chunk_type == b"IDAT":
            compressed.extend(chunk)
        elif chunk_type == b"IEND":
            break
    if width is None or height is None or bit_depth is None or color_type is None:
        raise ExtractError("色标 PNG 缺少 IHDR")
    if bit_depth != 8:
        raise ExtractError(f"色标 PNG 位深 {bit_depth} 不受支持(只支持 8 位)")
    channels_by_type = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}
    if color_type not in channels_by_type:
        raise ExtractError(f"色标 PNG 色型 {color_type} 不受支持")
    channels = channels_by_type[color_type]
    raw = zlib.decompress(bytes(compressed))
    stride = width * channels
    rows: list[bytes] = []
    previous = bytearray(stride)
    offset = 0
    for _ in range(height):
        filter_type = raw[offset]
        offset += 1
        line = bytearray(raw[offset : offset + stride])
        offset += stride
        _unfilter(filter_type, line, previous, channels)
        rows.append(bytes(line))
        previous = line
    if color_type == 3:
        rows = [_expand_palette(row, width, palette) for row in rows]
        channels = 3
    return width, height, channels, rows


def _unfilter(filter_type: int, line: bytearray, previous: bytearray, channels: int) -> None:
    """PNG 反滤波(原地修改 line); 公式与 PNG 规范 §6.4 一致."""
    stride = len(line)
    if filter_type == 0:
        return
    if filter_type == 1:
        for index in range(channels, stride):
            line[index] = (line[index] + line[index - channels]) & 0xFF
    elif filter_type == 2:
        for index in range(stride):
            line[index] = (line[index] + previous[index]) & 0xFF
    elif filter_type == 3:
        for index in range(stride):
            left = line[index - channels] if index >= channels else 0
            line[index] = (line[index] + ((left + previous[index]) >> 1)) & 0xFF
    elif filter_type == 4:
        for index in range(stride):
            left = line[index - channels] if index >= channels else 0
            up = previous[index]
            up_left = previous[index - channels] if index >= channels else 0
            estimate = left + up - up_left
            distance_left = abs(estimate - left)
            distance_up = abs(estimate - up)
            distance_up_left = abs(estimate - up_left)
            if distance_left <= distance_up and distance_left <= distance_up_left:
                predictor = left
            elif distance_up <= distance_up_left:
                predictor = up
            else:
                predictor = up_left
            line[index] = (line[index] + predictor) & 0xFF
    else:
        raise ExtractError(f"色标 PNG 未知滤波类型 {filter_type}")


def _expand_palette(row: bytes, width: int, palette: bytes) -> bytes:
    """调色板索引行 → RGB 行."""
    if not palette:
        raise ExtractError("色标 PNG 是调色板图但缺少 PLTE")
    out = bytearray(width * 3)
    for index in range(width):
        base = row[index] * 3
        if base + 2 >= len(palette):
            raise ExtractError("色标 PNG 的调色板索引越界")
        out[index * 3 : index * 3 + 3] = palette[base : base + 3]
    return bytes(out)


def _decode_png_data_uri(href: str) -> bytes:
    """把 data:image/png;base64,... 解成 PNG 字节; 去掉 base64 里的换行/空白."""
    if not _PNG_DATA_URI.match(href):
        raise ExtractError("色标 <image> 的 href 不是 PNG data URI")
    encoded = href.split(",", 1)[1]
    encoded = re.sub(r"\s+", "", encoded)
    try:
        return base64.b64decode(encoded, validate=True)
    except ValueError as exc:
        raise ExtractError(f"色标 PNG base64 解码失败: {exc}") from exc


def _tick_value(label: str) -> tuple[float, str | None] | None:
    """经/纬刻度标签 → (数值, 轴). 轴由方向字母判定, 没有字母时返回 None 交给几何判定."""
    match = _LABEL_VALUE.match(label)
    if match is None:
        return None
    try:
        value = float(match.group(1))
    except ValueError:
        return None
    direction = (match.group(2) or "").upper()
    if direction in ("S", "W"):
        value = -value
    axis = "lat" if direction in ("N", "S") else "lon" if direction in ("E", "W") else None
    cleaned = _clean(value)
    return (cleaned if cleaned is not None else value), axis


def _snap_relief_value(value: float) -> float | int:
    """色标端点取整: tick 位置反推会带 ±0.05 的浮点噪声, 贴近整数时收敛成整数."""
    rounded = round(float(value), 3)
    nearest = round(rounded)
    if abs(rounded - nearest) <= 0.05:
        return int(nearest)
    return rounded


class _Extractor:
    """一次抽取的全部中间状态; 生命周期就是一次 extract() 调用."""

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.svg = _parse_document(data)
        if self.svg.tag != "svg":
            raise ExtractError("根元素不是 <svg>")
        self.viewbox = self._root_viewbox()
        self.figure = self._find_figure()
        self.axes = self._axes_nodes()
        self.map_axes = self._pick_map_axes()
        self.map_rect = self._map_rect()
        self.legend_axes = self._pick_legend_axes()
        self.colorbar_axes = self._pick_colorbar_axes()
        self.deletions: list[tuple[int, int]] = []

    # ---------------------------------------------------------------- 结构定位

    def _root_viewbox(self) -> tuple[float, float, float, float]:
        raw = self.svg.get("viewBox")
        if not raw:
            raise ExtractError("根 <svg> 缺少 viewBox")
        parts = raw.split()
        if len(parts) != 4:
            raise ExtractError(f"根 viewBox 不是 4 个数: {raw!r}")
        try:
            values = tuple(float(part) for part in parts)
        except ValueError as exc:
            raise ExtractError(f"根 viewBox 含非数字: {raw!r}") from exc
        return values  # type: ignore[return-value]

    def _find_figure(self) -> _Node:
        for child in self.svg.children:
            if child.tag == "g" and child.get("id") == "figure_1":
                return child
        for child in self.svg.children:
            if child.tag == "g" and any(
                item.tag == "g" and item.node_id().startswith("axes")
                for item in child.children
            ):
                return child
        raise ExtractError("找不到 matplotlib 的 figure 组(期望 <g id=\"figure_1\">)")

    def _axes_nodes(self) -> list[_Node]:
        axes = [
            child
            for child in self.figure.children
            if child.tag == "g" and child.node_id().startswith("axes")
        ]
        if not axes:
            raise ExtractError("figure 组里没有 axes 子组")
        return axes

    def _background_bbox(self, axes: _Node) -> tuple[float, float, float, float] | None:
        """axes 的背景 patch 包围盒: 第一个 patch 组/rect 子元素的 bbox."""
        for child in axes.children:
            if child.tag == "rect":
                return _bbox(child)
            if child.tag == "g" and child.node_id().startswith("patch"):
                return _bbox(child)
        return None

    def _pick_map_axes(self) -> _Node:
        """地图 axes = 背景 patch 面积最大的那组(图例/色标都远小于地图)."""
        best: _Node | None = None
        best_area = -1.0
        for axes in self.axes:
            box = self._background_bbox(axes)
            if box is None:
                continue
            area = abs(box[2] - box[0]) * abs(box[3] - box[1])
            if area > best_area:
                best, best_area = axes, area
        if best is None:
            raise ExtractError("找不到可识别的地图 axes(没有背景 patch)")
        return best

    def _node_by_id(self, wanted: str) -> _Node | None:
        for node in _preorder(self.svg):
            if node.get("id") == wanted:
                return node
        return None

    def _map_rect(self) -> tuple[float, float, float, float]:
        """地图框: 优先用 axes 内 clipPath 的矩形(权威裁剪区), 否则退回背景 patch 的 bbox."""
        clip_id: str | None = None
        for node in _preorder(self.map_axes):
            match = _CLIP_URL.search(node.get("clip-path") or "")
            if match is not None:
                clip_id = match.group(1)
                break
        background = self._background_bbox(self.map_axes)
        if clip_id is not None:
            clip_node = self._node_by_id(clip_id)
            if clip_node is not None:
                box = _bbox(clip_node)
                if box is not None:
                    self._check_frame(box, background)
                    return box
        if background is None:
            raise ExtractError("地图 axes 没有 clipPath 也没有背景 patch, 无法确定地图框")
        return background

    def _check_frame(
        self,
        frame: tuple[float, float, float, float],
        background: tuple[float, float, float, float] | None,
    ) -> None:
        """clipPath 与背景 patch 应当描述同一个框; 不一致说明结构变了, 需要人工看.

        为什么按 frame 自算容差: 此处 self.map_rect 尚未赋值, _tolerance() 拿不到地图尺度.
        """
        if background is None:
            return
        scale = max(abs(frame[2] - frame[0]), abs(frame[3] - frame[1]), 1.0)
        tolerance = max(0.01, _BBOX_TOLERANCE_RATIO * scale)
        if not _bbox_close(frame, background, tolerance):
            raise ExtractError(
                "clipPath 与背景 patch 的地图框不一致: "
                f"clip={tuple(round(v, 3) for v in frame)} bg={tuple(round(v, 3) for v in background)}"
            )

    def _tolerance(self) -> float:
        """bbox 比较容差: 与地图框尺度成比例, 防止绝对像素阈值在小图上过松."""
        width = abs(self.map_rect[2] - self.map_rect[0]) if hasattr(self, "map_rect") else 1.0
        height = abs(self.map_rect[3] - self.map_rect[1]) if hasattr(self, "map_rect") else 1.0
        return max(0.01, _BBOX_TOLERANCE_RATIO * max(width, height, 1.0))

    def _pick_legend_axes(self) -> _Node | None:
        """图例 axes: 非地图 axes 里含 id 以 legend 开头的后代(通常只有一个)."""
        for axes in self.axes:
            if axes is self.map_axes:
                continue
            for node in _preorder(axes):
                if node.node_id().startswith("legend"):
                    return axes
        return None

    def _pick_colorbar_axes(self) -> _Node | None:
        """色标 axes: 非地图 axes 里含 data:image/png 的 <image>."""
        for axes in self.axes:
            if axes is self.map_axes:
                continue
            for node in _preorder(axes):
                if node.tag != "image":
                    continue
                href = node.get("xlink:href") or node.get("href") or ""
                if _PNG_DATA_URI.match(href):
                    return axes
        return None

    def _axes_is(self, node: _Node) -> bool:
        """node 是否就是某个 axes 组(用于排除图例/色标内部节点)."""
        return any(node is axes for axes in self.axes)

    # ---------------------------------------------------------------- 删除登记

    def _mark(self, node: _Node) -> None:
        """登记一个待删除元素; end 尚未填好(解析失败)时跳过."""
        if node.end > node.start:
            self.deletions.append((node.start, node.end))

    def _map_nodes(self) -> Iterator[_Node]:
        """地图 axes 子树的文档序遍历(重复使用时不缓存, 节点数只有数百)."""
        return _preorder(self.map_axes)

    # ---------------------------------------------------------------- geo: 经纬网

    def _graticule(self) -> dict[str, Any]:
        """经纬网刻度与线型: 从地图 axes 内的刻度文字反推 side 与坐标."""
        x0, y0, x1, y1 = self.map_rect
        middle_x = (x0 + x1) / 2.0
        middle_y = (y0 + y1) / 2.0
        tolerance = self._tolerance()
        lon: list[dict[str, Any]] = []
        lat: list[dict[str, Any]] = []
        for child in self.map_axes.children:
            if child.tag != "g" or not child.node_id().startswith("text"):
                continue
            text_node = _first_descendant(child, "text")
            if text_node is None:
                continue
            label = _node_text(text_node)
            parsed = _tick_value(label)
            if parsed is None:
                continue
            value, axis = parsed
            x, y = _text_position(text_node)
            if x is None or y is None:
                continue
            if axis is None:
                axis = "lon" if (y < y0 - tolerance or y > y1 + tolerance) else "lat"
            entry = {
                "value": value,
                "label": label,
                "x": _clean(x),
                "y": _clean(y),
            }
            if axis == "lon":
                entry["side"] = "bottom" if y > middle_y else "top"
                lon.append(entry)
            else:
                entry["side"] = "left" if x < middle_x else "right"
                lat.append(entry)
        return {"lon": lon, "lat": lat, "style": self._graticule_style()}

    def _graticule_style(self) -> dict[str, Any]:
        """经纬线线型: 找地图 axes 内第一条带 stroke-dasharray 的 path 的 style."""
        style: dict[str, str] = {}
        for node in self._map_nodes():
            if node.tag != "path":
                continue
            candidate = _style_map(node.get("style"))
            if "stroke-dasharray" in candidate and "stroke" in candidate:
                style = candidate
                break
        dash: list[float] | None = None
        if style.get("stroke-dasharray", "none").lower() not in ("none", ""):
            dash = [_clean(item) for item in _floats(style["stroke-dasharray"])]
        width = _number(style.get("stroke-width"))
        opacity = _number(style.get("stroke-opacity"))
        if opacity is None:
            opacity = _number(style.get("opacity"))
        return {
            "stroke": style.get("stroke", "#808080"),
            "width_pt": _clean(width if width is not None else 0.5),
            "dash": dash,
            "opacity": _clean(opacity if opacity is not None else 1.0),
        }

    # ---------------------------------------------------------------- geo: 地名

    def _label_entry(self, group: _Node, order: int) -> dict[str, Any] | None:
        """把一个 label-* 组解析成 labels[] 条目; 没有可用文字/坐标时返回 None."""
        texts = [node for node in _preorder(group) if node.tag == "text"]
        lines = [text for node in texts if (text := _node_text(node))]
        if not lines:
            return None
        first = texts[0]
        x, y = _text_position(first)
        if x is None or y is None:
            return None
        style = _style_map(first.get("style"))
        font_size = _number(style.get("font-size"))
        anchor = style.get("text-anchor", "start")
        italic = style.get("font-style", "").lower() in ("italic", "oblique")
        stroke = style.get("stroke")
        halo = None
        halo_width = _number(style.get("stroke-width"))
        if stroke and stroke.lower() != "none":
            halo = {
                "color": stroke,
                "width_pt": _clean(halo_width if halo_width is not None else 1.0),
            }
        group_id = group.node_id()
        parts = group_id.split("-")
        kind = parts[1] if len(parts) >= 2 else "other"
        if kind not in _LABEL_KINDS:
            kind = "other"
        return {
            "id": group_id,
            "kind": kind,
            "text": lines[0],
            "lines": lines,
            "x": _clean(x),
            "y": _clean(y),
            "rotation_deg": _rotation_deg(first),
            "anchor": anchor,
            "font_size_pt": _clean(font_size if font_size is not None else 10.0),
            "color": style.get("fill", "#000000"),
            "italic": italic,
            "halo": halo,
            "order": order,
        }

    # ---------------------------------------------------------------- geo: 色标

    def _colorbar(self) -> dict[str, Any]:
        """高程色标: 标题/单位、vmin/vmax、stops(解码 PNG) 与 tick 值."""
        default = {
            "title": "",
            "unit": "",
            "vmin": 0,
            "vmax": 1,
            "stops": [{"offset": 0, "color": "#ffffff"}, {"offset": 1, "color": "#000000"}],
            "ticks": [],
        }
        axes = self.colorbar_axes
        if axes is None:
            return default
        image_node: _Node | None = None
        for node in _preorder(axes):
            if node.tag == "image":
                href = node.get("xlink:href") or node.get("href") or ""
                if _PNG_DATA_URI.match(href):
                    image_node = node
                    break
        title_text = ""
        for node in _preorder(axes):
            if node.tag != "text":
                continue
            if any(
                _is_tick_group(ancestor)
                for ancestor in _ancestors(node, axes)
            ):
                continue
            title_text = _node_text(node)
            break
        title, unit = _split_unit(title_text)
        box = self._background_bbox(axes)
        if box is None and image_node is not None:
            box = _image_bbox(image_node)
        orientation = self._colorbar_orientation(box)
        ticks: list[dict[str, Any]] = []
        pairs: list[tuple[float, float]] = []
        for node in _preorder(axes):
            if node.tag != "g" or not _is_tick_group(node):
                continue
            text_node = _first_descendant(node, "text")
            if text_node is None:
                continue
            value = _number(_node_text(text_node))
            if value is None:
                continue
            position = None
            use_node = _first_descendant(node, "use")
            if use_node is not None:
                position = _number(use_node.get("y" if orientation == "vertical" else "x"))
            if position is None:
                text_x, text_y = _text_position(text_node)
                position = text_y if orientation == "vertical" else text_x
            if position is None:
                continue
            cleaned = _clean(value)
            ticks.append(cleaned if cleaned is not None else value)
            pairs.append((float(cleaned if cleaned is not None else value), float(position)))
        vmin, vmax = self._relief_range(box, pairs, orientation)
        stops = self._relief_stops(image_node, orientation)
        if title_text == "":
            return default
        return {
            "title": title,
            "unit": unit,
            "vmin": vmin,
            "vmax": vmax,
            "stops": stops,
            "ticks": ticks,
        }

    def _colorbar_orientation(
        self,
        box: tuple[float, float, float, float] | None,
    ) -> str:
        """色标方向: 高比宽大是竖直条, 否则水平条(本图是竖直条)."""
        if box is not None:
            width = abs(box[2] - box[0])
            height = abs(box[3] - box[1])
            return "vertical" if height >= width else "horizontal"
        return "vertical"

    def _relief_range(
        self,
        box: tuple[float, float, float, float] | None,
        pairs: list[tuple[float, float]],
        orientation: str,
    ) -> tuple[float | int, float | int]:
        """用 tick 的 (value, 位置) 线性拟合, 再外推到色标矩形两端得到 vmin/vmax.

        竖直条: 位置是 y, 底边(y 大)是 vmin; 水平条: 位置是 x, 左边(x 小)是 vmin.
        """
        if box is None or len(pairs) < 2:
            return 0, 1
        mean_pos = sum(position for _, position in pairs) / len(pairs)
        mean_value = sum(value for value, _ in pairs) / len(pairs)
        sxx = sum((position - mean_pos) ** 2 for _, position in pairs)
        if sxx == 0:
            return 0, 1
        sxy = sum((position - mean_pos) * (value - mean_value) for value, position in pairs)
        slope = sxy / sxx
        intercept = mean_value - slope * mean_pos
        if orientation == "vertical":
            first_edge = box[1]
            second_edge = box[3]
        else:
            first_edge = box[0]
            second_edge = box[2]
        first_value = intercept + slope * first_edge
        second_value = intercept + slope * second_edge
        low, high = sorted((first_value, second_value))
        return _snap_relief_value(low), _snap_relief_value(high)

    def _relief_stops(self, image_node: _Node | None, orientation: str) -> list[dict[str, Any]]:
        """在色标 PNG 中线采样 STOP_COUNT 个颜色; offset=0 是 vmin, 1 是 vmax.

        为什么按矩阵 d/a 分量判定翻转: 色标 <image> 用 scale(1,-1) 把栅格上下翻转,
        不判翻转会把 vmin/vmax 的配色顺序弄反(深海蓝会跑到山峰一侧).
        """
        if image_node is None:
            raise ExtractError("色标 axes 里没有 PNG <image>, 无法采样 stops")
        href = image_node.get("xlink:href") or image_node.get("href") or ""
        png = _decode_png_data_uri(href)
        width, height, channels, rows = _decode_png(png)
        matrix = _parse_transform(image_node.get("transform"))
        stops: list[dict[str, Any]] = []
        for index in range(_STOP_COUNT):
            offset = index / (_STOP_COUNT - 1)
            if orientation == "vertical":
                if width < 1 or height < 2:
                    raise ExtractError(f"色标 PNG 尺寸异常: {width}x{height}")
                flipped = matrix[3] < 0
                row_index = (
                    round(offset * (height - 1))
                    if flipped
                    else round((1 - offset) * (height - 1))
                )
                pixel = rows[row_index][(width // 2) * channels : (width // 2) * channels + channels]
            else:
                if height < 1 or width < 2:
                    raise ExtractError(f"色标 PNG 尺寸异常: {width}x{height}")
                flipped = matrix[0] < 0
                column_index = (
                    round((1 - offset) * (width - 1))
                    if flipped
                    else round(offset * (width - 1))
                )
                pixel = rows[height // 2][column_index * channels : column_index * channels + channels]
            if channels <= 2:
                red = green = blue = pixel[0]
            else:
                red, green, blue = pixel[0], pixel[1], pixel[2]
            stops.append({"offset": _clean(offset), "color": f"#{red:02x}{green:02x}{blue:02x}"})
        return stops

    # ---------------------------------------------------------------- geo: 图例

    def _legend(self) -> dict[str, Any]:
        """图例标题与条目: 条目来自 legend 组直属的 patch/line2d 子组, 文字紧随其后."""
        default: dict[str, Any] = {"title": "", "entries": []}
        axes = self.legend_axes
        if axes is None:
            return default
        legend_root = axes
        for node in _preorder(axes):
            if node.node_id().startswith("legend"):
                legend_root = node
                break
        frame_node = self._legend_frame(legend_root)
        entries: list[dict[str, Any]] = []
        title = ""
        title_seen = False
        for child in legend_root.children:
            if child.tag == "text" or (
                child.tag == "g" and child.node_id().startswith("text")
            ):
                label = ""
                for node in _preorder(child):
                    text = _node_text(node)
                    if text:
                        label = text
                        break
                if not label:
                    continue
                if not title_seen and not entries:
                    title = label
                    title_seen = True
                elif entries and not entries[-1]["label"]:
                    entries[-1]["label"] = label
                continue
            if child.tag != "g" or child is frame_node:
                continue
            child_id = child.node_id()
            if child_id.startswith("patch"):
                entry = self._legend_patch_entry(child)
            elif child_id.startswith("line2d"):
                entry = self._legend_line_entry(child)
            else:
                continue
            if entry is not None:
                entries.append(entry)
        return {"title": title, "entries": entries}

    def _legend_frame(self, legend_root: _Node) -> _Node | None:
        """图例外框 patch: 面积明显最大、且几何上包含所有其它条目内容的那块.

        为什么不用 legend 组的并集 bbox: line2d 条目里有 <defs> 的 marker 路径,
        它们以 (0,0) 为中心(坐标为负), 并集会被拉大, 无法和框比较.
        """
        boxes: list[tuple[_Node, tuple[float, float, float, float]]] = []
        content: list[tuple[float, float, float, float]] = []
        for child in legend_root.children:
            if child.tag != "g":
                continue
            child_id = child.node_id()
            if child_id.startswith("patch"):
                box = _bbox(child)
                if box is not None:
                    boxes.append((child, box))
            elif child_id.startswith("line2d"):
                line_node = next((item for item in child.children if item.tag == "path"), None)
                if line_node is not None:
                    box = _bbox(line_node)
                    if box is not None:
                        content.append(box)
        if not boxes:
            return None
        tolerance = self._tolerance()
        ordered = sorted(boxes, key=lambda item: _bbox_area(item[1]), reverse=True)
        frame, frame_box = ordered[0]
        others = [box for _, box in ordered[1:]] + content
        if not others:
            return None
        if not all(_bbox_contains(frame_box, box, tolerance) for box in others):
            return None
        if _bbox_area(frame_box) < 4.0 * max(_bbox_area(box) for box in others):
            return None
        return frame

    def _legend_patch_entry(self, group: _Node) -> dict[str, Any] | None:
        """矩形色块条目: fill/opacity 来自 style, 线宽/描边也一并给出."""
        shape_node = _first_descendant(group, "path") or _first_descendant(group, "rect")
        if shape_node is None:
            return None
        style = _style_map(shape_node.get("style"))
        fill = style.get("fill")
        if fill and fill.lower() == "none":
            fill = None
        opacity = _number(style.get("opacity"))
        if opacity is None:
            opacity = _number(style.get("fill-opacity"))
        dash = self._dash(style)
        width = _number(style.get("stroke-width"))
        return {
            "label": "",
            "shape": "rect",
            "stroke": style.get("stroke"),
            "width_pt": _clean(width if width is not None else 1.0),
            "dash": dash,
            "fill": fill,
            "opacity": _clean(opacity if opacity is not None else 1.0),
            "marker": None,
        }

    def _legend_line_entry(self, group: _Node) -> dict[str, Any] | None:
        """线/点条目: 有 <use> 的是点(marker), 否则是线."""
        line_node = _first_descendant(group, "path") or _first_descendant(group, "rect")
        if line_node is None:
            return None
        style = _style_map(line_node.get("style"))
        use_node = _first_descendant(group, "use")
        if use_node is not None:
            marker_node = None
            for node in _preorder(group):
                if node is line_node or node.tag not in ("path", "rect"):
                    continue
                if node.get("id", "").startswith("m"):
                    marker_node = node
                    break
            use_style = _style_map(use_node.get("style"))
            marker_shape = _classify_marker(marker_node) if marker_node is not None else None
            width = _number(use_style.get("stroke-width"))
            if width is None:
                width = _number(style.get("stroke-width"))
            opacity = _number(use_style.get("opacity"))
            if opacity is None:
                opacity = _number(use_style.get("fill-opacity"))
            fill = use_style.get("fill")
            if fill and fill.lower() == "none":
                fill = None
            return {
                "label": "",
                "shape": "point",
                "stroke": use_style.get("stroke") or style.get("stroke"),
                "width_pt": _clean(width if width is not None else 1.0),
                "dash": None,
                "fill": fill,
                "opacity": _clean(opacity if opacity is not None else 1.0),
                "marker": marker_shape,
            }
        opacity = _number(style.get("stroke-opacity"))
        if opacity is None:
            opacity = _number(style.get("opacity"))
        width = _number(style.get("stroke-width"))
        return {
            "label": "",
            "shape": "line",
            "stroke": style.get("stroke"),
            "width_pt": _clean(width if width is not None else 1.0),
            "dash": self._dash(style),
            "fill": None,
            "opacity": _clean(opacity if opacity is not None else 1.0),
            "marker": None,
        }

    def _dash(self, style: dict[str, str]) -> list[float] | None:
        """stroke-dasharray → 列表; none/缺失返回 None."""
        raw = style.get("stroke-dasharray")
        if raw is None or raw.strip().lower() in ("", "none"):
            return None
        values = [_clean(item) for item in _floats(raw)]
        return [value for value in values if value is not None]

    # ---------------------------------------------------------------- geo: 文案建议

    def _suggestions(
        self,
        area_annotation: list[str],
        legend_title: str,
        colorbar_title: str,
    ) -> dict[str, Any]:
        """标题/副标题/注记/来源: 图外文字组的几何位置 + 字号最大者作为标题组."""
        title = ""
        subtitle = ""
        notes: list[str] = []
        source = ""
        x0, y0, x1, y1 = self.map_rect
        tolerance = self._tolerance()
        groups: list[tuple[_Node, list[str], float, list[tuple[float, float]]]] = []
        for child in self.figure.children:
            if child.tag != "g" or not child.node_id().startswith("text"):
                continue
            texts = [node for node in _preorder(child) if node.tag == "text"]
            lines = [text for node in texts if (text := _node_text(node))]
            if not lines:
                continue
            font_size = 0.0
            anchors: list[tuple[float, float]] = []
            for node in texts:
                size = _number(_style_map(node.get("style")).get("font-size"))
                if size is not None and size > font_size:
                    font_size = size
                x, y = _text_position(node)
                if x is not None and y is not None:
                    anchors.append((x, y))
            groups.append((child, lines, font_size, anchors))
        title_index = -1
        best_font = -1.0
        for index, (_child, _lines, font_size, _anchors) in enumerate(groups):
            if font_size > best_font:
                best_font, title_index = font_size, index
        for index, (_child, lines, _font_size, anchors) in enumerate(groups):
            if index == title_index:
                title = lines[0]
                subtitle = lines[1] if len(lines) > 1 else ""
                continue
            if anchors and all(
                x > x1 + tolerance and y0 - tolerance <= y <= y1 + tolerance
                for x, y in anchors
            ):
                notes.extend(lines)
            elif anchors and any(y > y1 + tolerance for _x, y in anchors):
                source = "\n".join(lines)
            else:
                notes.extend(lines)
        return {
            "title": title,
            "subtitle": subtitle,
            "notes": notes,
            "source": source,
            "area_annotation": area_annotation,
            "legend_title": legend_title,
            "colorbar_title": colorbar_title,
        }

    # ---------------------------------------------------------------- 删除与拼接

    def _collect_deletions(self) -> tuple[list[str], list[dict[str, Any]]]:
        """登记所有要删的元素, 同时收集区域注记文字(它来自 label-area-* 组)."""
        area_annotation: list[str] = []
        labels: list[dict[str, Any]] = []
        label_order = 0
        # 地图 axes 内: 刻度文字组、地名组、图框 path.
        for child in self.map_axes.children:
            child_id = child.node_id()
            if child.tag == "g" and child_id.startswith("text"):
                self._mark(child)
            elif child.tag == "g" and child_id.startswith("label-"):
                if child_id.startswith("label-area-"):
                    area_annotation.extend(
                        text for node in _preorder(child) if (text := _node_text(node))
                    )
                else:
                    entry = self._label_entry(child, label_order)
                    if entry is not None:
                        labels.append(entry)
                        label_order += 1
                self._mark(child)
            elif child.tag == "g" and child_id.startswith("patch"):
                self._mark_spines(child)
        # figure 级: 纸白底 patch、非地图 axes(图例/色标)、所有图外文字/地名组.
        for child in self.figure.children:
            if self._axes_is(child):
                if child is not self.map_axes:
                    self._mark(child)
                continue
            if child.tag != "g":
                continue
            child_id = child.node_id()
            if child_id.startswith("patch"):
                box = _bbox(child)
                if box is not None and _bbox_close(
                    box,
                    (self.viewbox[0], self.viewbox[1], self.viewbox[0] + self.viewbox[2], self.viewbox[1] + self.viewbox[3]),
                    self._tolerance() * 10,
                ):
                    self._mark(child)
            elif child_id.startswith("text"):
                self._mark(child)
            elif child_id.startswith("label-"):
                if child_id.startswith("label-area-"):
                    area_annotation.extend(
                        text for node in _preorder(child) if (text := _node_text(node))
                    )
                else:
                    entry = self._label_entry(child, label_order)
                    if entry is not None:
                        labels.append(entry)
                        label_order += 1
                self._mark(child)
        # 全域兜底: 任何残留的 text/tspan 与含 @font-face 的 style 都删掉(C2/字体).
        for node in _preorder(self.svg):
            if node.tag in ("text", "tspan", "textPath"):
                self._mark(node)
            elif node.tag == "style" and b"@font-face" in self.data[node.start : node.end]:
                self._mark(node)
        return area_annotation, labels

    def _mark_spines(self, group: _Node) -> None:
        """删除图框线: 矩形 path 的 bbox 与地图框一致且 stroke 非 none, fill 为 none.

        为什么按 path 粒度而不是整组: 不同 matplotlib 版本会把海陆底色与 spines 放进
        同一个 patch 组; 只删线条 path, 底色 path 必须保留.
        """
        tolerance = self._tolerance()
        paths = [child for child in group.children if child.tag == "path"]
        if not paths:
            return
        frame: list[_Node] = []
        for path in paths:
            style = _style_map(path.get("style"))
            fill = style.get("fill", "")
            stroke = style.get("stroke")
            if fill.lower() != "none":
                continue
            if not stroke or stroke.lower() == "none":
                continue
            box = _bbox(path)
            if box is not None and _bbox_close(
                box,
                (
                    self.map_rect[0],
                    self.map_rect[1],
                    self.map_rect[2],
                    self.map_rect[3],
                ),
                tolerance,
            ):
                frame.append(path)
        if len(frame) == len(paths):
            self._mark(group)
        else:
            for path in frame:
                self._mark(path)

    def _cut(self, body: bytes, offset: int, ranges: list[tuple[int, int]]) -> bytes:
        """按绝对坐标区间切掉 body 中对应字节; 区间会合并/裁剪, 允许重叠."""
        local: list[tuple[int, int]] = []
        limit = len(body)
        for start, end in ranges:
            left = max(0, start - offset)
            right = min(limit, end - offset)
            if right > left:
                local.append((left, right))
        if not local:
            return body
        local.sort()
        pieces: list[bytes] = []
        position = 0
        for left, right in local:
            if right <= position:
                continue
            if left > position:
                pieces.append(body[position:left])
            position = max(position, right)
        pieces.append(body[position:])
        return b"".join(pieces)

    def _build_base(self) -> bytes:
        """生成纯底图: 改根标签尺寸 + 删区间 + 保证末尾恰好一个换行."""
        root_start = self.svg.start
        root_tag_end = self.svg.tag_end + 1
        x0, y0, _x1, _y1 = self.map_rect
        width = self.map_rect[2] - self.map_rect[0]
        height = self.map_rect[3] - self.map_rect[1]
        root_tag = self.data[root_start:root_tag_end]
        root_tag = _set_attribute(root_tag, "viewBox", f"{_fmt(x0)} {_fmt(y0)} {_fmt(width)} {_fmt(height)}")
        root_tag = _set_attribute(root_tag, "width", f"{_fmt(width)}pt")
        root_tag = _set_attribute(root_tag, "height", f"{_fmt(height)}pt")
        body = self.data[root_tag_end:]
        body = self._cut(body, root_tag_end, self.deletions)
        base = self.data[:root_start] + root_tag + body
        base = base.rstrip(b"\r\n") + b"\n"
        return base

    # ---------------------------------------------------------------- 入口

    def run(self) -> tuple[bytes, dict[str, Any]]:
        """执行抽取并返回 (底图字节, geo dict)."""
        graticule = self._graticule()
        relief = self._colorbar()
        legend = self._legend()
        area_annotation, labels = self._collect_deletions()
        colorbar_title = relief["title"]
        suggestions = self._suggestions(area_annotation, legend["title"], colorbar_title)
        base = self._build_base()
        contract_check = _contract_check(base)
        if contract_check is not None:
            raise ExtractError("生成的底图不满足契约: " + "; ".join(contract_check))
        x0, y0, _x1, _y1 = self.map_rect
        width = self.map_rect[2] - self.map_rect[0]
        height = self.map_rect[3] - self.map_rect[1]
        geo: dict[str, Any] = {
            "format": "mapdoc-geo",
            "version": 1,
            "base": {
                "sha256": contract.sha256(base),
                "view_box": [_clean(x0), _clean(y0), _clean(width), _clean(height)],
                "width_pt": _clean(width),
                "height_pt": _clean(height),
            },
            "graticule": graticule,
            "labels": labels,
            "relief": relief,
            "legend": legend,
            "suggestions": suggestions,
        }
        return base, geo


def _is_tick_group(node: _Node) -> bool:
    """matplotlib 的刻度组: 竖条是 ytick_*, 横条是 xtick_*; 两者都要认."""
    node_id = node.node_id()
    return node_id.startswith("ytick") or node_id.startswith("xtick")


def _ancestors(node: _Node, stop: _Node) -> list[_Node]:
    """从 node 的父节点向上到 stop(不含)的祖先链; 用于判断文字是否属于 ytick 组."""
    result: list[_Node] = []
    cursor = node.parent
    while cursor is not None and cursor is not stop:
        result.append(cursor)
        cursor = cursor.parent
    return result


def _split_unit(text: str) -> tuple[str, str]:
    """把 "高程 / 水深 (m)" 拆成 ("高程 / 水深", "m"); 没有括号时单位为 ""."""
    match = re.match(r"^\s*(.*?)\s*\(\s*([^()]*)\s*\)\s*$", text)
    if match is None:
        return text.strip(), ""
    return match.group(1).strip(), match.group(2).strip()


def _contract_check(base: bytes) -> list[str] | None:
    """用 contract.read_base 自检生成的底图; 通过返回 None, 失败返回错误列表."""
    info = contract.read_base(base)
    if info.errors:
        return list(info.errors)
    return None


def extract(source: bytes) -> tuple[bytes, dict[str, Any]]:
    """成品 SVG bytes → (纯底图 bytes, geo dict); 结构不识别时抛 ExtractError."""
    return _Extractor(source).run()


def extract_file(path: Path | str) -> tuple[bytes, dict[str, Any]]:
    """读文件并抽取; 读失败转成 ExtractError, 便于 prepare 统一报错."""
    try:
        source = Path(path).read_bytes()
    except OSError as exc:
        raise ExtractError(f"读不到源 SVG {path}: {exc}") from exc
    return extract(source)
