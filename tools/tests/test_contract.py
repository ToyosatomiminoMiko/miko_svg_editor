"""底图契约(C1/C3/C6/C8)与 marker 编解码的单测.

覆盖: 每条规则的通过与拒绝、viewBox 解析、插入位置、marker 生成/解析往返与非法输入、
以及 demo 底图存在时的真实契约检查(不存在则 skip, 由 prepare_demo.py 生成).
"""

from __future__ import annotations

import unittest
from pathlib import Path

from mapdoc import contract

from . import helpers

REPO_ROOT = Path(__file__).resolve().parents[2]
DEMO_BASE = (
    REPO_ROOT
    / "demo"
    / "figures"
    / "Volga"
    / ".build"
    / "volga_basin_topography_etopo2022_lambert_conformal.base.svg"
)


class BaseContractTest(unittest.TestCase):
    def test_valid_fixture_passes(self) -> None:
        check = contract.read_base_check(helpers.BASE_SVG)
        self.assertTrue(check.ok, check.errors)
        self.assertEqual((check.width_pt, check.height_pt), (200.0, 100.0))
        self.assertEqual(check.text_count, 0)
        self.assertEqual(check.font_face_count, 0)

    def test_c1_missing_viewbox(self) -> None:
        data = helpers.BASE_SVG.replace(b'viewBox="0 0 200 100" ', b"")
        check = contract.read_base_check(data)
        self.assertFalse(check.ok)
        self.assertTrue(any("C1" in message for message in check.errors))

    def test_c1_root_transform_rejected(self) -> None:
        data = helpers.BASE_SVG.replace(
            b'<svg xmlns="http://www.w3.org/2000/svg"',
            b'<svg transform="scale(1)" xmlns="http://www.w3.org/2000/svg"',
        )
        check = contract.read_base_check(data)
        self.assertTrue(any("transform" in message for message in check.errors))

    def test_c1_zero_or_negative_size(self) -> None:
        for viewbox in ('viewBox="0 0 0 100"', 'viewBox="0 0 -5 100"'):
            data = helpers.BASE_SVG.replace(b'viewBox="0 0 200 100"', viewbox.encode())
            check = contract.read_base_check(data)
            self.assertTrue(any("宽高" in message for message in check.errors), viewbox)

    def test_c1_malformed_viewbox(self) -> None:
        data = helpers.BASE_SVG.replace(
            b'viewBox="0 0 200 100"', b'viewBox="0 0 200"'
        )
        check = contract.read_base_check(data)
        self.assertTrue(any("viewBox" in message for message in check.errors))

    def test_c3_duplicate_close_rejected(self) -> None:
        data = helpers.BASE_SVG.replace(b"</svg>\n", b"</svg></svg>\n")
        check = contract.read_base_check(data)
        self.assertTrue(any("C3" in message for message in check.errors))

    def test_c3_missing_trailing_newline_rejected(self) -> None:
        data = helpers.BASE_SVG.rstrip(b"\n")
        check = contract.read_base_check(data)
        self.assertTrue(any("C3" in message for message in check.errors))

    def test_c6_overlay_and_marker_rejected(self) -> None:
        overlay_marked = helpers.BASE_SVG.replace(
            b"</svg>\n", b'<g id="mapdoc-overlay"></g>\n</svg>\n'
        )
        self.assertTrue(
            any("C6" in message for message in contract.read_base_check(overlay_marked).errors)
        )
        final_marked = helpers.BASE_SVG.replace(
            b"</svg>\n", b"<!-- mapdoc-final:AAAA -->\n</svg>\n"
        )
        self.assertTrue(
            any("C6" in message for message in contract.read_base_check(final_marked).errors)
        )

    def test_c8_text_with_font_passes(self) -> None:
        check = contract.read_base_check(helpers.TEXT_BASE_SVG)
        self.assertTrue(check.ok, check.errors)
        self.assertGreater(check.text_count, 0)
        self.assertEqual(check.font_face_count, 1)

    def test_c8_text_without_font_rejected(self) -> None:
        data = (
            b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">\n'
            b'<text x="1" y="1">x</text>\n</svg>\n'
        )
        check = contract.read_base_check(data)
        self.assertTrue(any("C8" in message for message in check.errors))

    def test_c8_non_woff_font_rejected(self) -> None:
        data = helpers.TEXT_BASE_SVG.replace(
            b"data:font/woff;base64,", b"data:text/plain;base64,"
        )
        check = contract.read_base_check(data)
        self.assertTrue(any("C8" in message for message in check.errors))

    def test_check_base_file_missing(self) -> None:
        check = contract.check_base_file(REPO_ROOT / "no-such-base.svg")
        self.assertFalse(check.ok)

    def test_insert_position(self) -> None:
        position = contract.insert_position(helpers.BASE_SVG)
        self.assertEqual(position, len(helpers.BASE_SVG) - 7)
        with self.assertRaises(ValueError):
            contract.insert_position(helpers.BASE_SVG.replace(b"</svg>\n", b"</svg></svg>\n"))


class MarkerTest(unittest.TestCase):
    def test_roundtrip(self) -> None:
        scene_sha = "a" * 64
        base_sha = "b" * 64
        counts = {"points": 3, "entities": 6, "constraints": 3, "texts": 0}
        marker = contract.make_marker(scene_sha, base_sha, counts)
        self.assertTrue(marker.startswith("<!-- mapdoc-final:"))
        self.assertTrue(marker.endswith(" -->"))
        parsed = contract.parse_marker(marker.encode("utf-8"))
        assert parsed is not None
        self.assertEqual(parsed["format"], "mapdoc-final")
        self.assertEqual(parsed["version"], 1)
        self.assertEqual(parsed["scene"], scene_sha)
        self.assertEqual(parsed["base"], base_sha)
        self.assertEqual(parsed["counts"], counts)
        self.assertEqual(contract.marker_scene_sha(parsed), scene_sha)
        self.assertEqual(contract.marker_base_sha(parsed), base_sha)

    def test_marker_inside_svg_bytes(self) -> None:
        marker = contract.make_marker("a" * 64, "b" * 64, {})
        data = helpers.BASE_SVG.replace(b"</svg>\n", marker.encode() + b"</svg>\n")
        parsed = contract.parse_marker(data)
        assert parsed is not None
        self.assertEqual(parsed["counts"], {"points": 0, "entities": 0, "constraints": 0, "texts": 0})

    def test_parse_missing_or_invalid(self) -> None:
        self.assertIsNone(contract.parse_marker(helpers.BASE_SVG))
        self.assertIsNone(contract.parse_marker(b"<!-- mapdoc-final:!!!! -->"))
        self.assertIsNone(contract.parse_marker(b"<!-- mapdoc-final:AAAA -->"))
        # 合法 base64 但不是约定 JSON.
        other = contract.make_marker("a" * 64, "b" * 64, {})
        broken = other.replace("mapdoc-final", "cartopy-file-labels")
        self.assertIsNone(contract.parse_marker(broken.encode()))

    def test_make_marker_rejects_bad_sha(self) -> None:
        with self.assertRaises(ValueError):
            contract.make_marker("not-a-hash", "b" * 64, {})
        with self.assertRaises(ValueError):
            contract.make_marker("a" * 64, "not-a-hash", {})


class HashTest(unittest.TestCase):
    def test_sha256_helpers(self) -> None:
        self.assertEqual(contract.sha256(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        self.assertTrue(contract.is_sha256(contract.sha256(b"abc")))
        self.assertFalse(contract.is_sha256("ABC"))
        self.assertFalse(contract.is_sha256("a" * 63))


@unittest.skipUnless(DEMO_BASE.is_file(), "demo 底图不存在; 先运行 python3 tools/prepare_demo.py")
class DemoBaseContractTest(unittest.TestCase):
    def test_demo_base_satisfies_c1_c3_c6_c8(self) -> None:
        data = DEMO_BASE.read_bytes()
        check = contract.read_base_check(data)
        self.assertTrue(check.ok, check.errors)
        self.assertEqual(data.count(b"</svg>"), 1)
        self.assertEqual(contract.insert_position(data), len(data) - 7)
        self.assertNotIn(b"mapdoc-overlay", data)
        self.assertNotIn(b"mapdoc-final", data)
        # 真实底图含 text, 因此必须自带内嵌 WOFF 字体.
        self.assertGreater(check.text_count, 0)
        self.assertGreaterEqual(check.font_face_count, 1)
        self.assertIn(b"data:font/woff", data)


if __name__ == "__main__":
    unittest.main()
