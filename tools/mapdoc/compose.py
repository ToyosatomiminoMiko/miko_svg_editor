"""追加式合成: base + 叠加层 + marker → final.svg.

是什么: compose() 在 ``.build/<stem>.lock`` 上非阻塞取 flock, 读底图、校验 C1/C3/C6/C8
与 scene, 把叠加层与 final marker 插到最后一个 ``</svg>`` 之前, 再 ``.tmp + os.replace``
原子写交付物; build_final() 是不碰文件系统的纯函数版本, 供测试与 /overlay.svg 复用.
为什么: 契约 I1/I3/I5 要求"底图字节前缀/后缀原样保留"且不重序列化 XML, 所以全程按字节
拼接, 从不解析→改树→重写; 锁只覆盖秒级窗口, 绘制阶段不持锁(C7).
依赖: contract(底图检查/marker)、scene(校验/摘要)、overlay(叠加层)、fsutil(锁/原子写).
元信息: 2026-10, mapdoc 垂直切片; 契约见 docs/merge/DESIGN.md 3.4/5.4.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from . import contract, fsutil, overlay
from . import scene as scene_mod

# 底图尺寸变化判定容差: 与 scene.CANVAS_TOLERANCE_PT 同值, 避免两处各写一个数.
SIZE_TOLERANCE_PT = scene_mod.CANVAS_TOLERANCE_PT


class ComposeError(Exception):
    """合成失败的基类; 具体子类由 studio 映射成不同 HTTP 状态."""


class BaseInvalid(ComposeError):
    """底图缺失或不满足 C1/C3/C6/C8; studio 映射 503(请先 render)."""

    def __init__(self, errors: tuple[str, ...] | list[str]):
        self.errors = tuple(errors)
        super().__init__("; ".join(self.errors) or "底图不合法")


class SceneInvalid(ComposeError):
    """scene 不合法; studio 映射 400(invalid_scene), 且不写 final(I4)."""

    def __init__(self, errors: tuple[str, ...] | list[str]):
        self.errors = tuple(errors)
        super().__init__("; ".join(self.errors) or "scene 不合法")


class RenderingBusy(ComposeError):
    """拿不到合成锁(正在重渲染); 调用方决定是排队还是返回 rendering 状态."""


@dataclass(frozen=True)
class ComposeReport:
    """compose 的结构化报告; to_dict 是 /api/doc 与 PUT 响应里的 report 字段."""

    counts: dict[str, int]
    warnings: tuple[str, ...]
    out_of_canvas: tuple[int, ...]
    missing_glyphs: tuple[str, ...]
    base_changed: bool
    base_size_changed: bool

    def to_dict(self) -> dict[str, object]:
        return {
            "counts": dict(self.counts),
            "warnings": list(self.warnings),
            "out_of_canvas": list(self.out_of_canvas),
            "missing_glyphs": list(self.missing_glyphs),
            "base_changed": self.base_changed,
            "base_size_changed": self.base_size_changed,
        }


def derive_lock_path(base_path: Path) -> Path:
    """由 ``<stem>.base.svg`` 派生 ``.build/<stem>.lock``; 命名不符合时退回 stem + .lock."""
    suffix = ".base.svg"
    name = base_path.name
    stem = name[: -len(suffix)] if name.endswith(suffix) else base_path.stem
    return base_path.with_name(stem + ".lock")


def _base_size_changed(base_check: contract.BaseCheck, scan: scene_mod.Scene) -> bool:
    """scene 声明的画布尺寸与真实底图是否超过容差(0.01pt)."""
    return (
        abs(scene_mod.round3(scan.base.width_pt) - scene_mod.round3(base_check.width_pt))
        > SIZE_TOLERANCE_PT
        or abs(scene_mod.round3(scan.base.height_pt) - scene_mod.round3(base_check.height_pt))
        > SIZE_TOLERANCE_PT
    )


def build_final(base_bytes: bytes, scan: scene_mod.Scene) -> tuple[bytes, ComposeReport]:
    """纯函数合成: 返回 (final 字节, 报告); 底图或 scene 不合法时抛错且不产生输出.

    I1: final = base[:pos] + 追加块 + marker + base[pos:], 因此前后缀字节不变;
    I2: 空 scene 时追加块为空串, 只插入 marker。
    """
    base_check = contract.read_base_check(base_bytes)
    if base_check.errors:
        raise BaseInvalid(base_check.errors)
    scene_errors = scene_mod.validate_scene(scan)
    if scene_errors:
        raise SceneInvalid(scene_errors)

    position = contract.insert_position(base_bytes)
    base_sha = contract.sha256(base_bytes)
    rendered = overlay.render_overlay(scan, base_check.width_pt, base_check.height_pt)

    base_changed = scan.base.sha256 != base_sha
    base_size_changed = _base_size_changed(base_check, scan)

    marker = contract.make_marker(
        scene_mod.digest(scan), base_sha, rendered.counts
    )
    insertion = ""
    if rendered.defs_style:
        insertion += "\n" + rendered.defs_style
    if rendered.group:
        insertion += "\n" + rendered.group
    insertion += marker

    final_bytes = base_bytes[:position] + insertion.encode("utf-8") + base_bytes[position:]

    warnings = list(rendered.warnings)
    if base_changed:
        warnings.append("底图 sha256 与 scene 声明不一致（base_changed）")
    if base_size_changed:
        warnings.append("底图画布尺寸与 scene 声明不一致（base_size_changed）")
    report = ComposeReport(
        counts=dict(rendered.counts),
        warnings=tuple(warnings),
        out_of_canvas=rendered.out_of_canvas,
        missing_glyphs=rendered.missing_glyphs,
        base_changed=base_changed,
        base_size_changed=base_size_changed,
    )
    return final_bytes, report


def build_overlay_document(base_bytes: bytes, scan: scene_mod.Scene) -> bytes:
    """/overlay.svg 用: 只含叠加层与 marker 的最小独立 SVG(无内容时也是合法 SVG)."""
    base_check = contract.read_base_check(base_bytes)
    if base_check.errors:
        raise BaseInvalid(base_check.errors)
    scene_errors = scene_mod.validate_scene(scan)
    if scene_errors:
        raise SceneInvalid(scene_errors)

    rendered = overlay.render_overlay(scan, base_check.width_pt, base_check.height_pt)
    marker = contract.make_marker(
        scene_mod.digest(scan), contract.sha256(base_bytes), rendered.counts
    )
    width = overlay.format_number(base_check.width_pt)
    height = overlay.format_number(base_check.height_pt)
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="{width}" height="{height}">'
    ]
    if rendered.defs_style:
        parts.append(rendered.defs_style)
    if rendered.group:
        parts.append(rendered.group)
    parts.append(marker)
    parts.append("</svg>")
    return ("\n".join(parts) + "\n").encode("utf-8")


def compose(
    base_path: Path,
    scan: scene_mod.Scene,
    final_path: Path,
    lock_path: Path | None = None,
) -> ComposeReport:
    """持锁合成并原子写 final; 拿不到锁抛 RenderingBusy, 底图/场景不合法抛对应子类."""
    lock = lock_path if lock_path is not None else derive_lock_path(base_path)
    with fsutil.try_flock(lock) as acquired:
        if not acquired:
            raise RenderingBusy(f"合成锁被占用: {lock}")
        try:
            base_bytes = base_path.read_bytes()
        except FileNotFoundError as exc:
            raise BaseInvalid((f"底图不存在: {base_path}",)) from exc
        except OSError as exc:
            raise BaseInvalid((f"读取底图失败: {base_path}: {exc}",)) from exc
        final_bytes, report = build_final(base_bytes, scan)
        fsutil.atomic_write_bytes(final_path, final_bytes)
        return report


def marker_of(final_path: Path) -> dict[str, object] | None:
    """读取 final 里的 marker; final 不存在时返回 None."""
    try:
        data = final_path.read_bytes()
    except OSError:
        return None
    return contract.parse_marker(data)


def final_sha256(final_path: Path) -> str | None:
    """交付物 sha256; 不存在返回 None."""
    try:
        return contract.sha256_file(final_path)
    except OSError:
        return None


def is_empty(scan: scene_mod.Scene) -> bool:
    """空场景判定: 没有图元就没有叠加层内容(自由点不进成品)."""
    return not scan.entities


def assert_invariants(base_bytes: bytes, final_bytes: bytes) -> None:
    """自检 I1/I2: 供测试与 check_contract 复用; 不满足时断言失败并给出原因."""
    position = base_bytes.rfind(contract.SVG_CLOSE)
    if not final_bytes.startswith(base_bytes[:position]):
        raise AssertionError("I1 失败: final 不以 base 前缀开头")
    if not final_bytes.endswith(base_bytes[position:]):
        raise AssertionError("I1 失败: final 不以 base 后缀结尾")
