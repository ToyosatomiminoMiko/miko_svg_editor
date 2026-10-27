"""base + 排版层 → final SVG 字节（加锁、原子写）.

是什么: ``build_final(base_bytes, scene, geo)`` 是纯函数——校验底图契约（C1–C4）、scene
（§4）与 geo 一致性, 渲染色标 defs/图框/items, 把底图根标签内的字节**原样**嵌进
``<g id="mapdoc-map" transform="translate(tx,ty) scale(s)">``, 再按 §6 的纸张尺寸拼出成品
字节与 report; ``compose(scene, base_path, geo_path, final_path)`` 在 ``.build/<stem>.lock``
上非阻塞取 flock、读 base/geo、合成并原子写 final。

为什么: 契约要求成品的底图部分是**原字节切片**而不是重序列化 XML, 所以全程按 bytes 拼接,
ElementTree 只在测试里用于自检; 锁只覆盖"读 base + 写 final"的秒级窗口, 绘制阶段不持锁。
marker（§6.1）用 contract.make_marker 生成, scene digest 与 geo digest 都由对方模块的规范
化 JSON 定义, 因此同一 (base, geo, scene) 输入两次 compose 得到同一字节。
base_changed/base_size_changed 是"scene.base 声明 vs 真实底图"的差异, 只报告不改变几何:
几何永远用真实底图（geo.base）计算; geo 本身与底图字节不一致时（stale geo）直接报
GeoInvalid, 避免拼出一张地图错位的成品。

依赖: contract（底图切分/校验/marker）、page（校验/规范化/digest）、geo（读取/校验/digest）、
render（§5 排版层字符串）、fsutil（flock + 原子写）。
元信息: 2026-10, 出版排版编辑器 Python 合成侧; 契约见 docs/PAGE-EDITOR.md §5/§6/§6.1/§7.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from . import contract, fsutil
from . import geo as geo_mod
from . import page as page_mod
from . import render

# 底图尺寸声明与真实底图的允许偏差（3 位小数舍入 + 浮点误差）; 超过就报告 base_size_changed.
SIZE_TOLERANCE_PT = 0.01


class ComposeError(Exception):
    """合成失败的基类; studio 按子类映射成 400/409/503."""


class BaseInvalid(ComposeError):
    """底图缺失或不满足 §7 C1–C4; studio 映射 503（提示先跑 prepare_demo）."""

    def __init__(self, errors: tuple[str, ...] | list[str]):
        self.errors = tuple(errors)
        super().__init__("; ".join(self.errors) or "底图不合法")


class SceneInvalid(ComposeError):
    """scene 不合法; studio 映射 400（invalid_scene）, 且不会写出任何文件."""

    def __init__(self, errors: tuple[str, ...] | list[str]):
        self.errors = tuple(errors)
        super().__init__("; ".join(self.errors) or "scene 不合法")


class GeoInvalid(ComposeError):
    """geo.json 缺失/不合法/与底图不一致; studio 映射 503（geo_missing/geo_stale）."""

    def __init__(self, errors: tuple[str, ...] | list[str]):
        self.errors = tuple(errors)
        super().__init__("; ".join(self.errors) or "geo 不合法")


class RenderingBusy(ComposeError):
    """拿不到合成锁（另一个进程正在 compose）; 调用方决定排队还是回 rendering 状态."""


def derive_lock_path(base_path: Path) -> Path:
    """由 ``.build/<stem>.base.svg`` 派生 ``.build/<stem>.lock``.

    为什么不是 base 文件本身加 .lock: 契约 §2 规定锁文件名是 ``<stem>.lock``, 与 base/final
    同目录层级, 这样 prepare 重写 base 时不会因为正在 compose 而互相踩到锁文件命名。
    """
    suffix = ".base.svg"
    name = base_path.name
    stem = name[: -len(suffix)] if name.endswith(suffix) else base_path.stem
    return base_path.with_name(stem + ".lock")


def _base_errors(base_info: Any) -> tuple[str, ...]:
    """从 contract.BaseInfo 取错误; 空元组即通过 C1–C4."""
    errors = getattr(base_info, "errors", ())
    return tuple(errors or ())


def _geo_consistency_errors(
    base_bytes: bytes, base_info: Any, geo: geo_mod.Geo
) -> list[str]:
    """geo 与真实底图必须描述同一张图（sha256/viewBox/宽高）.

    为什么 sha256 也要比: base_view 与 viewBox 相同但地形/水系可能已经重渲染, stale geo 会
    让前端按旧刻度摆图框; 直接拒绝比产出错位成品更安全（studio 会提示重跑 prepare）。
    """
    errors: list[str] = []
    actual_sha = contract.sha256(base_bytes)
    if geo.base.sha256 != actual_sha:
        errors.append(
            "geo.base.sha256 与底图不一致（geo 过期，请重跑 prepare_demo）"
        )
    view_box = getattr(base_info, "view_box", None)
    if view_box is None:
        # base_info.errors 为空时 C1 必然通过, viewBox 理论上不会缺席; 仍做显式防御.
        errors.append("底图 viewBox 不可用（C1 未通过）")
        return errors
    for index, (geo_value, base_value) in enumerate(zip(geo.base.view_box, view_box)):
        if abs(float(geo_value) - float(base_value)) > SIZE_TOLERANCE_PT:
            errors.append(
                f"geo.base.view_box[{index}] 与底图 viewBox 不一致"
                f"（{geo_value} vs {base_value}）"
            )
    for name, geo_value, base_value in (
        ("width_pt", geo.base.width_pt, getattr(base_info, "width_pt", None)),
        ("height_pt", geo.base.height_pt, getattr(base_info, "height_pt", None)),
    ):
        if base_value is None or abs(float(geo_value) - float(base_value)) > SIZE_TOLERANCE_PT:
            errors.append(
                f"geo.base.{name} 与底图尺寸不一致（{geo_value} vs {base_value}）"
            )
    return errors


def _marker_bytes(payload: dict[str, Any]) -> bytes:
    """调 contract.make_marker 并统一成 bytes（契约返回 bytes, 这里兼容 str 实现）."""
    marker = contract.make_marker(payload)
    if isinstance(marker, bytes):
        return marker.rstrip(b"\n")
    if isinstance(marker, str):  # pragma: no cover - 以 bytes 契约为准
        return marker.rstrip("\n").encode("utf-8")
    raise TypeError(f"contract.make_marker 返回了 {type(marker).__name__}, 需要 bytes")


def build_final(
    base_bytes: bytes, scene: dict[str, Any], geo: geo_mod.Geo
) -> tuple[bytes, dict[str, Any]]:
    """纯函数合成, 返回 (final 字节, report); 任何校验失败抛对应 ComposeError.

    report 形状（studio 原样嵌进 PUT /api/compose 响应）:
      counts: {"text": n, "legend": n, "colorbar": n, "total": n}
      warnings: 中文提示列表（越界 item / base_changed / base_size_changed）
      out_of_paper: 越界 item id 列表（items 顺序）
      base_changed / base_size_changed: scene.base 声明与真实底图的差异
    """
    raw = bytes(base_bytes)
    base_info = contract.read_base(raw)
    errors = _base_errors(base_info)
    if errors:
        raise BaseInvalid(errors)
    scene_errors = page_mod.validate_scene(scene)
    if scene_errors:
        raise SceneInvalid(scene_errors)
    # 先规范化: digest 与渲染都只接受契约字段 + 3 位小数, 避免同一语义多种字节.
    normalized = page_mod.normalize_scene(scene, figure=scene["figure"])
    geo_errors = _geo_consistency_errors(raw, base_info, geo)
    if geo_errors:
        raise GeoInvalid(geo_errors)

    inner_start = int(getattr(base_info, "inner_start"))
    inner_end = int(getattr(base_info, "inner_end"))
    if not 0 <= inner_start <= inner_end <= len(raw):
        raise BaseInvalid(
            (f"底图内联区间不合法（{inner_start}..{inner_end}, 总长 {len(raw)}）",)
        )

    paper = normalized["paper"]
    width_text = render.format_number(float(paper["width_pt"]))
    height_text = render.format_number(float(paper["height_pt"]))
    scale, tx, ty = render.map_transform(normalized, geo)

    # §6 文件头与纸张底色; 根 svg 的宽高带 pt 单位, viewBox 用无单位用户坐标（1 单位 = 1pt）.
    head = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<svg xmlns="http://www.w3.org/2000/svg" '
        'xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'width="{width_text}pt" height="{height_text}pt" '
        f'viewBox="0 0 {width_text} {height_text}" version="1.1">\n'
        f'<rect x="0" y="0" width="{width_text}" height="{height_text}" '
        f'fill="{normalized["style"]["paper_color"]}"/>\n'
    )
    defs = render.render_defs(normalized, geo)
    map_open = (
        '<g id="mapdoc-map" '
        f'transform="translate({render.format_number(tx)},{render.format_number(ty)}) '
        f'scale({render.format_number(scale)})">'
    )
    frame = render.render_frame(normalized, geo)
    overlay = render.render_overlay(normalized, geo)

    counts = page_mod.item_counts(normalized)
    actual_sha = contract.sha256(raw)
    base_changed = normalized["base"]["sha256"] != actual_sha
    base_size_changed = (
        abs(float(normalized["base"]["width_pt"]) - float(base_info.width_pt))
        > SIZE_TOLERANCE_PT
        or abs(float(normalized["base"]["height_pt"]) - float(base_info.height_pt))
        > SIZE_TOLERANCE_PT
    )

    out_of_paper, warnings = render.analyze(normalized, geo)
    # §4: map.x/y 只要求有限, 越界是告警而不是错误——成品里地图会被纸张裁掉, 由前端提示作者.
    map_x, map_y, map_width, map_height = render.map_rect(normalized, geo)
    if (
        map_x < -render.BBOX_EPS
        or map_y < -render.BBOX_EPS
        or map_x + map_width > float(paper["width_pt"]) + render.BBOX_EPS
        or map_y + map_height > float(paper["height_pt"]) + render.BBOX_EPS
    ):
        warnings.append("地图超出纸张范围（成品会被裁切，仅告警）")
    if base_changed:
        warnings.append("底图 sha256 与 scene 声明不一致（base_changed）")
    if base_size_changed:
        warnings.append("底图尺寸与 scene 声明不一致（base_size_changed）")

    marker = _marker_bytes(
        {
            "counts": {key: int(value) for key, value in counts.items()},
            "geo": geo_mod.geo_digest(geo),
            "scene": page_mod.scene_digest(normalized),
            "version": page_mod.VERSION,
        }
    )

    parts: list[bytes] = [
        head.encode("utf-8"),
        (defs + "\n").encode("utf-8") if defs else b"",
        map_open.encode("utf-8"),
        raw[inner_start:inner_end],
        b"</g>\n",
        (frame + "\n").encode("utf-8"),
        (overlay + "\n").encode("utf-8"),
        marker,
        b"\n</svg>\n",
    ]
    final_bytes = b"".join(parts)
    report: dict[str, Any] = {
        "counts": counts,
        "warnings": warnings,
        "out_of_paper": out_of_paper,
        "base_changed": base_changed,
        "base_size_changed": base_size_changed,
    }
    return final_bytes, report


def compose(
    scene: dict[str, Any],
    base_path: Path,
    geo_path: Path,
    final_path: Path,
) -> dict[str, Any]:
    """持锁读 base/geo → 合成 → 原子写 final, 返回 report.

    锁是非阻塞的: 另一个进程正在合成时抛 RenderingBusy, 由 studio 决定返回 409/稍后重试,
    绝不排队等待（HTTP 线程不该被文件锁卡住）。final 的写入用 fsutil.atomic_write_bytes,
    读者只会看到旧的完整文件或新的完整文件。
    """
    base = Path(base_path)
    geo_file = Path(geo_path)
    target = Path(final_path)
    lock = derive_lock_path(base)
    with fsutil.try_flock(lock) as acquired:
        if not acquired:
            raise RenderingBusy(f"合成锁被占用: {lock}")
        try:
            base_bytes = base.read_bytes()
        except OSError as exc:
            raise BaseInvalid((f"读取底图失败: {base}: {exc}",)) from exc
        try:
            geo = geo_mod.read_geo(geo_file)
        except geo_mod.GeoError as exc:
            raise GeoInvalid(exc.errors) from exc
        final_bytes, report = build_final(base_bytes, scene, geo)
        fsutil.atomic_write_bytes(target, final_bytes)
        return report
