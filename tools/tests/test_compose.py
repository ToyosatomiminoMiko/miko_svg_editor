"""compose 不变量与失败语义的单测.

覆盖: I1(前后缀字节不变)、I2(空场景只插 marker)、I3(两次独立子进程字节一致)、
I4(非法 scene 不写 final)、I5(不重序列化/不调用 apply_svg_transforms)、
I6(flock 非阻塞竞争)、base 契约拒绝(C1/C3/C6/C8)、marker 往返、base_changed 报告.
"""

from __future__ import annotations

import dataclasses
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from mapdoc import compose, contract, fsutil
from mapdoc import scene as scene_mod

from . import helpers

WORKER = Path(__file__).resolve().parent / "_compose_worker.py"
TOOLS_DIR = Path(__file__).resolve().parents[1]


class ComposeInvariantTest(unittest.TestCase):
    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.root = Path(self._directory.name)
        self.base_path = self.root / "map.base.svg"
        self.final_path = self.root / "map.svg"
        self.base_path.write_bytes(helpers.BASE_SVG)
        self.lock_path = compose.derive_lock_path(self.base_path)

    def tearDown(self) -> None:
        self._directory.cleanup()

    def test_i1_base_prefix_and_suffix_preserved(self) -> None:
        scan = helpers.make_scene(
            helpers.payload(
                points=[helpers.point(1, 10.0, 10.0), helpers.point(2, 60.0, 40.0)],
                entities=[{"id": 3, "type": "line", "a": 1, "b": 2, "construction": False}],
                seq=4,
            )
        )
        report = compose.compose(self.base_path, scan, self.final_path)
        final = self.final_path.read_bytes()
        position = contract.insert_position(helpers.BASE_SVG)
        self.assertTrue(final.startswith(helpers.BASE_SVG[:position]))
        self.assertTrue(final.endswith(helpers.BASE_SVG[position:]))
        compose.assert_invariants(helpers.BASE_SVG, final)
        self.assertIn(b'<g id="mapdoc-overlay"', final)
        self.assertIn(b"mapdoc-final:", final)
        self.assertEqual(report.counts["entities"], 1)
        # final 里只有一个叠加层组, 且 marker 在 </svg> 之前.
        self.assertEqual(final.count(b'<g id="mapdoc-overlay"'), 1)
        self.assertLess(final.index(b"mapdoc-overlay"), final.index(b"mapdoc-final:"))
        # 写盘后不留 .tmp 中间文件.
        self.assertEqual(list(self.root.glob("*.tmp")), [])

    def test_i2_empty_scene_is_base_plus_marker_only(self) -> None:
        empty = scene_mod.empty_scene("demo/figures/Volga/map.svg", helpers.base_info())
        report = compose.compose(self.base_path, empty, self.final_path)
        final = self.final_path.read_bytes()
        position = contract.insert_position(helpers.BASE_SVG)
        prefix, suffix = helpers.BASE_SVG[:position], helpers.BASE_SVG[position:]
        self.assertTrue(final.startswith(prefix))
        self.assertTrue(final.endswith(suffix))
        inserted = final[len(prefix) : len(final) - len(suffix)]
        self.assertNotIn(b"<g", inserted)
        self.assertIsNotNone(contract.MARKER_PATTERN.fullmatch(inserted))
        marker = contract.parse_marker(final)
        assert marker is not None
        self.assertEqual(marker["format"], "mapdoc-final")
        self.assertEqual(marker["version"], 1)
        self.assertEqual(
            marker["counts"],
            {"points": 0, "entities": 0, "constraints": 0, "texts": 0},
        )
        self.assertEqual(marker["base"], contract.sha256(helpers.BASE_SVG))
        self.assertEqual(marker["scene"], scene_mod.digest(empty))
        self.assertEqual(report.counts["entities"], 0)

    def test_i3_two_independent_processes_are_byte_identical(self) -> None:
        scan = helpers.make_scene(helpers.full_constraint_payload())
        scene_path = self.root / "map.scene.json"
        scene_path.write_bytes(scene_mod.canonical_bytes(scan))
        first = self.root / "first.svg"
        second = self.root / "second.svg"
        # 两个独立子进程: 各自从 base + scene.json 重新合成, 不读旧 final.
        results = []
        for target in (first, second):
            completed = subprocess.run(
                [
                    sys.executable,
                    str(WORKER),
                    str(self.base_path),
                    str(scene_path),
                    str(target),
                ],
                check=True,
                capture_output=True,
                text=True,
                env=os.environ.copy(),
            )
            results.append(completed.stdout.strip().splitlines()[-1])
        self.assertEqual(results[0], results[1])
        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(results[0], contract.sha256(first.read_bytes()))

    def test_i4_invalid_scene_never_writes_final(self) -> None:
        self.final_path.write_bytes(b"sentinel-final")
        valid = helpers.make_scene()
        broken = scene_mod.Scene(
            figure=valid.figure,
            base=valid.base,
            style=valid.style,
            seq=valid.seq,
            points=valid.points,
            entities=(scene_mod.LineEntity(id=5, a=1, b=999, construction=False),),
            constraints=(),
        )
        with self.assertRaises(compose.SceneInvalid):
            compose.compose(self.base_path, broken, self.final_path)
        # 旧 final 必须保持原样, 不能被截断/覆盖(I4).
        self.assertEqual(self.final_path.read_bytes(), b"sentinel-final")

    def test_i5_no_xml_rewrite_in_production_path(self) -> None:
        sources = {
            path.name: path.read_text(encoding="utf-8")
            for path in (TOOLS_DIR / "mapdoc").glob("*.py")
            # __init__.py 是纯说明文档, 里面提到 ElementTree 只是描述"生产路径不用它".
            if path.name != "__init__.py"
        }
        for tool in ("studio.py", "prepare_demo.py", "check_contract.py"):
            sources[tool] = (TOOLS_DIR / tool).read_text(encoding="utf-8")
        for name, text in sources.items():
            self.assertNotIn("apply_svg_transforms", text, name)
            self.assertNotIn("xml.etree", text, name)
            self.assertNotIn("ElementTree", text, name)

    def test_i6_lock_contention_raises_busy(self) -> None:
        scan = helpers.make_scene()
        with fsutil.try_flock(self.lock_path) as acquired:
            self.assertTrue(acquired)
            with self.assertRaises(compose.RenderingBusy):
                compose.compose(self.base_path, scan, self.final_path)
            self.assertFalse(self.final_path.exists())
        # 释放后同一份 base+scene 可以正常合成.
        report = compose.compose(self.base_path, scan, self.final_path)
        self.assertEqual(report.counts["entities"], 0)

    def test_base_c6_marker_rejected(self) -> None:
        self.base_path.write_bytes(helpers.MARKED_BASE_SVG)
        with self.assertRaises(compose.BaseInvalid) as raised:
            compose.compose(self.base_path, helpers.make_scene(), self.final_path)
        self.assertTrue(any("C6" in message for message in raised.exception.errors))
        self.assertFalse(self.final_path.exists())

    def test_base_c8_missing_font_rejected(self) -> None:
        bad = helpers.TEXT_BASE_SVG.replace(b"data:font/woff;base64,", b"data:text/plain;base64,")
        self.base_path.write_bytes(bad)
        with self.assertRaises(compose.BaseInvalid) as raised:
            compose.compose(self.base_path, helpers.make_scene(), self.final_path)
        self.assertTrue(any("C8" in message for message in raised.exception.errors))

    def test_base_c3_and_c1_rejected(self) -> None:
        for name, data in (
            ("C3", helpers.BASE_SVG.replace(b"</svg>\n", b"</svg></svg>\n")),
            ("C1", helpers.BASE_SVG.replace(b'viewBox="0 0 200 100" ', b"")),
        ):
            self.base_path.write_bytes(data)
            with self.assertRaises(compose.BaseInvalid) as raised:
                compose.compose(self.base_path, helpers.make_scene(), self.final_path)
            self.assertTrue(any(name in message for message in raised.exception.errors), name)

    def test_missing_base_raises_base_invalid(self) -> None:
        with self.assertRaises(compose.BaseInvalid):
            compose.compose(self.root / "absent.base.svg", helpers.make_scene(), self.final_path)

    def test_base_font_block_bytes_untouched(self) -> None:
        self.base_path.write_bytes(helpers.TEXT_BASE_SVG)
        scan = helpers.make_scene(
            helpers.payload(
                base=helpers.base_claim(helpers.base_info(helpers.TEXT_BASE_SVG)),
                points=[helpers.point(1, 10.0, 10.0)],
                seq=2,
            ),
            base=helpers.base_info(helpers.TEXT_BASE_SVG),
        )
        compose.compose(self.base_path, scan, self.final_path)
        final = self.final_path.read_bytes()
        self.assertIn(b"@font-face", final)
        self.assertEqual(
            final.count(b"@font-face"), helpers.TEXT_BASE_SVG.count(b"@font-face")
        )
        # 原字体块的数据 URI 字节必须原样出现.
        block = helpers.TEXT_BASE_SVG.split(b"@font-face", 1)[1].split(b"}\n", 1)[0]
        self.assertIn(block, final)


class ComposeReportTest(unittest.TestCase):
    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.root = Path(self._directory.name)
        self.base_path = self.root / "map.base.svg"
        self.final_path = self.root / "map.svg"
        self.base_path.write_bytes(helpers.BASE_SVG)

    def tearDown(self) -> None:
        self._directory.cleanup()

    def test_base_changed_and_size_changed_flags(self) -> None:
        valid = helpers.make_scene()
        # 声明的 base 与真实底图不同: sha 不同 + 尺寸不同 → 报告两个 flag 且不拒绝合成.
        stale = dataclasses.replace(
            valid,
            base=scene_mod.BaseInfo(
                path=None,
                sha256="f" * 64,
                width_pt=300.0,
                height_pt=150.0,
            ),
        )
        final, report = compose.build_final(helpers.BASE_SVG, stale)
        self.assertTrue(report.base_changed)
        self.assertTrue(report.base_size_changed)
        self.assertTrue(any("base_changed" in message for message in report.warnings))
        self.assertIn(b"mapdoc-final:", final)

    def test_report_dict_shape(self) -> None:
        scan = helpers.make_scene(
            helpers.payload(
                points=[helpers.point(1, 10.0, 10.0), helpers.point(2, 210.0, 10.0)],
                entities=[{"id": 3, "type": "line", "a": 1, "b": 2, "construction": False}],
                seq=4,
            )
        )
        report = compose.compose(self.base_path, scan, self.final_path)
        payload = report.to_dict()
        self.assertEqual(
            set(payload),
            {
                "counts",
                "warnings",
                "out_of_canvas",
                "missing_glyphs",
                "base_changed",
                "base_size_changed",
            },
        )
        self.assertEqual(payload["counts"]["entities"], 1)
        self.assertEqual(payload["out_of_canvas"], [3])
        self.assertFalse(payload["base_changed"])

    def test_build_overlay_document_is_standalone_svg(self) -> None:
        scan = helpers.make_scene(
            helpers.payload(
                points=[helpers.point(1, 10.0, 10.0), helpers.point(2, 60.0, 40.0)],
                entities=[{"id": 3, "type": "line", "a": 1, "b": 2, "construction": False}],
                seq=4,
            )
        )
        document = compose.build_overlay_document(helpers.BASE_SVG, scan)
        text = document.decode("utf-8")
        self.assertTrue(text.startswith('<svg xmlns="http://www.w3.org/2000/svg"'))
        self.assertIn('viewBox="0 0 200 100"', text)
        self.assertIn('<g id="mapdoc-overlay"', text)
        self.assertIn("mapdoc-final:", text)
        self.assertTrue(text.endswith("</svg>\n"))
        # 空场景也是合法 SVG(只有 marker).
        empty_document = compose.build_overlay_document(
            helpers.BASE_SVG, scene_mod.empty_scene("demo/figures/Volga/map.svg", helpers.base_info())
        ).decode("utf-8")
        self.assertIn("<svg", empty_document)
        self.assertNotIn("<g", empty_document)
        self.assertIn("mapdoc-final:", empty_document)

    def test_derive_lock_path(self) -> None:
        self.assertEqual(
            compose.derive_lock_path(Path("/x/.build/stem.base.svg")),
            Path("/x/.build/stem.lock"),
        )
        self.assertEqual(
            compose.derive_lock_path(Path("/x/plain.svg")), Path("/x/plain.lock")
        )


if __name__ == "__main__":
    unittest.main()
