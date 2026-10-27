#!/usr/bin/env python3
"""契约自检 CLI: 对 studio.toml 里配置的每张图检查底图契约与 compose 不变量.

是什么: 读底图做 C1/C3/C6/C8 检查; 用空场景真实合成一份临时 final 验证 I2
(除 marker 外与 base 字节一致); 若已有 final, 再验证 I1(前后缀字节不变)与 marker 解析.
为什么: "check_contract 全绿"是本轮验收的一部分; 这里必须走真实 compose(而不是内存拼一遍),
否则测不到锁/原子写/报告这条真实路径.
用法: python3 tools/check_contract.py   (不接受命令行参数; 退出码 0=全绿, 1=有失败)
"""

from __future__ import annotations

import sys
from pathlib import Path

from mapdoc import compose as compose_mod
from mapdoc import contract, scene as scene_mod
from studio import StudioConfigError, load_config

TOOL_DIR = Path(__file__).resolve().parent


def _line(ok: bool | None, message: str) -> None:
    marker = "[ok]" if ok is True else "[fail]" if ok is False else "[warn]"
    print(f"{marker} {message}")


def _check_figure(key: str, figure) -> bool:
    """检查一张图; 打印逐项结果并返回是否全部通过."""
    print(f"\n== {key} ==")
    print(f"   final: {figure.final_path}")
    print(f"   base : {figure.base_path}")

    failures = 0
    try:
        base_bytes = figure.base_path.read_bytes()
    except OSError as exc:
        _line(False, f"底图不可读: {exc}")
        print("   提示: 先运行 python3 tools/prepare_demo.py")
        return False

    check = contract.read_base_check(base_bytes)
    if check.errors:
        failures += 1
        for message in check.errors:
            _line(False, message)
        # 底图不合法时后面的 I1/I2 都会因为同一原因失败, 不再重复合成.
        return False
    _line(
        True,
        f"C1/C3/C6/C8 通过 (viewBox {check.width_pt} x {check.height_pt} pt, "
        f"text {check.text_count}, @font-face {check.font_face_count})",
    )
    for message in check.warnings:
        _line(None, message)

    base_sha = contract.sha256(base_bytes)
    print(f"   base sha256: {base_sha}")
    base_info = scene_mod.BaseInfo(
        path=figure.base_path,
        sha256=base_sha,
        width_pt=scene_mod.round3(check.width_pt),
        height_pt=scene_mod.round3(check.height_pt),
    )

    # 读已落盘 scene(没有就是空场景); 损坏的 scene 直接算失败, 因为 compose 会拒绝它.
    try:
        loaded = scene_mod.load(figure.scene_path)
    except scene_mod.SceneError as exc:
        _line(False, f"scene 文件不合法: {exc}")
        return False
    current = loaded or scene_mod.empty_scene(figure.figure_name, base_info)
    if current.base.sha256 != base_sha:
        _line(None, "scene 声明的 base sha256 与当前底图不一致(保存时需要 ack_base_change)")

    # I2: 用空场景真实合成到 .build 下的临时文件, 再逐字节比较"除 marker 外与 base 一致".
    position = contract.insert_position(base_bytes)
    empty = scene_mod.empty_scene(figure.figure_name, base_info)
    temporary = figure.base_path.with_name(figure.base_path.name + ".check-final.svg")
    try:
        compose_mod.compose(
            figure.base_path, empty, temporary, lock_path=figure.lock_path
        )
        produced = temporary.read_bytes()
    except compose_mod.ComposeError as exc:
        _line(False, f"I2 空场景合成失败: {exc}")
        return False
    finally:
        temporary.unlink(missing_ok=True)
    prefix, suffix = base_bytes[:position], base_bytes[position:]
    if not (produced.startswith(prefix) and produced.endswith(suffix)):
        failures += 1
        _line(False, "I2: 空场景 final 的 base 前后缀字节被改动")
    else:
        inserted = produced[len(prefix) : len(produced) - len(suffix)]
        if b"<g" in inserted:
            failures += 1
            _line(False, "I2: 空场景不应追加空 <g> 组")
        elif contract.MARKER_PATTERN.fullmatch(inserted) is None:
            failures += 1
            _line(False, "I2: 空场景 final 里除 marker 外还插入了别的内容")
        else:
            _line(True, "I2 空场景 compose: 除 marker 外与 base 字节一致")

    # 已有 final 时检查 I1 与 marker 语义; 不一致只是"需要合成", 不算契约失败.
    if not figure.final_path.is_file():
        _line(None, "final 尚未生成(启动 studio 会自动合成)")
        return failures == 0
    final_bytes = figure.final_path.read_bytes()
    try:
        compose_mod.assert_invariants(base_bytes, final_bytes)
    except AssertionError as exc:
        failures += 1
        _line(False, str(exc))
    else:
        _line(True, "I1 final 的底图前缀/后缀字节不变")

    final_marker = contract.parse_marker(final_bytes)
    if final_marker is None:
        _line(None, "final 里还没有 marker(启动 studio 会自动合成)")
        return failures == 0
    final_base = contract.marker_base_sha(final_marker)
    if final_base != base_sha:
        _line(None, "final marker 的 base sha256 与当前底图不一致(需要重新合成)")
    else:
        _line(True, "final marker 的 base sha256 与底图一致")
    scene_sha = scene_mod.digest(current)
    if contract.marker_scene_sha(final_marker) != scene_sha:
        _line(None, "final marker 的 scene sha256 与当前 scene 不一致(需要合成)")
    else:
        _line(True, "final marker 的 scene sha256 与当前 scene 一致")
    return failures == 0


def main() -> int:
    if len(sys.argv) > 1:
        print("错误: 这个脚本不接受命令行参数(图列表读 tools/studio.toml)", file=sys.stderr)
        return 2
    try:
        config = load_config()
    except StudioConfigError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 2

    failures = 0
    for key, figure in sorted(config.figures.items()):
        if not _check_figure(key, figure):
            failures += 1

    print()
    if failures:
        print(f"契约检查失败: {failures} 张图有问题", file=sys.stderr)
        return 1
    print("契约检查全绿")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
