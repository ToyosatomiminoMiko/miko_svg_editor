"""compose.py 单测: §6 成品结构、§6.1 marker、base 内联、加锁原子写与失败语义.

覆盖: build_final 的纸张根 svg/纸张底色/图层顺序/底图内联字节/无 <image>; 两次调用字节
相等; marker 的 scene+geo digest 与 counts 往返; base_changed/base_size_changed 报告;
BaseInvalid/SceneInvalid/GeoInvalid; compose() 的 flock 非阻塞竞争、原子写、不留 .tmp、
非法输入不写 final; derive_lock_path 命名.
"""

from __future__ import annotations

import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from mapdoc import compose, contract, fsutil, geo, page

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"
BASE_FIXTURE = FIXTURE_DIR / "pyrender_base.svg"


def base_bytes() -> bytes:
    """小型纯底图 fixture（200x100, 无 <text>, 含 defs/clipPath/rect/path）."""
    return BASE_FIXTURE.read_bytes()


def base_sha() -> str:
    """fixture 的真实 sha256."""
    return hashlib.sha256(base_bytes()).hexdigest()


def make_geo_doc() -> dict:
    """与 fixture 底图一致的 geo."""
    return {
        "format": geo.FORMAT,
        "version": geo.VERSION,
        "base": {
            "sha256": base_sha(),
            "view_box": [0, 0, 200, 100],
            "width_pt": 200.0,
            "height_pt": 100.0,
        },
        "graticule": {
            "lon": [
                {"value": 10, "label": "10°E", "x": 100.0, "y": 100.0, "side": "bottom"}
            ],
            "lat": [
                {"value": 40, "label": "40°N", "x": 0.0, "y": 50.0, "side": "left"}
            ],
        },
        "relief": {
            "title": "高程 / 水深",
            "unit": "m",
            "vmin": -10,
            "vmax": 10,
            "stops": [
                {"offset": 0, "color": "#08306b"},
                {"offset": 1, "color": "#ffffff"},
            ],
            "ticks": [-10, 0, 10],
        },
    }


def make_geo() -> geo.Geo:
    """typed geo."""
    return geo.parse_geo(make_geo_doc())


def make_scene_doc() -> dict:
    """200x100 纸张, 地图 180x90（scale=0.9, tx=ty=10）."""
    return {
        "format": page.FORMAT,
        "version": page.VERSION,
        "figure": "demo/figures/Volga/volga.svg",
        "base": {
            "sha256": base_sha(),
            "width_pt": 200.0,
            "height_pt": 100.0,
        },
        "paper": {
            "preset": "Custom",
            "orientation": "landscape",
            "width_pt": 200.0,
            "height_pt": 100.0,
        },
        "map": {"x": 10.0, "y": 10.0, "width_pt": 180.0},
        "frame": {
            "show": True,
            "stroke": "#000000",
            "width_pt": 0.8,
            "ticks": True,
            "tick_length_pt": 5.0,
            "tick_font_size_pt": 7.0,
            "tick_color": "#444444",
            "tick_gap_pt": 2.0,
        },
        "style": {
            "paper_color": "#ffffff",
            "font_family": "Test Sans",
            "color": "#111111",
        },
        "items": [
            {
                "id": 1,
                "kind": "text",
                "space": "page",
                "role": "title",
                "x": 100.0,
                "y": 20.0,
                "lines": ["标题"],
                "font_size_pt": 18.0,
                "font_family": None,
                "color": "#111111",
                "anchor": "middle",
                "rotation_deg": 0.0,
                "line_height": 1.35,
                "italic": False,
                "bold": False,
                "halo": None,
            },
            {
                "id": 2,
                "kind": "legend",
                "space": "page",
                "x": 10.0,
                "y": 40.0,
                "width_pt": 100.0,
                "title": "图例",
                "entries": [
                    {
                        "label": "国界",
                        "shape": "line",
                        "stroke": "#4a4a4a",
                        "width_pt": 1.4,
                        "dash": None,
                        "fill": None,
                        "opacity": 1.0,
                        "marker": None,
                    }
                ],
                "font_size_pt": 9.0,
                "title_size_pt": 12.0,
                "row_height_pt": 14.0,
                "padding_pt": 7.0,
                "swatch_width_pt": 24.0,
                "swatch_gap_pt": 6.0,
                "frame": {
                    "show": True,
                    "stroke": "#bbbbbb",
                    "width_pt": 0.8,
                    "fill": "#ffffff",
                    "opacity": 0.94,
                },
            },
            {
                "id": 3,
                "kind": "colorbar",
                "space": "page",
                "x": 150.0,
                "y": 10.0,
                "width_pt": 14.0,
                "height_pt": 60.0,
                "title": "高程 / 水深",
                "unit": "m",
                "show_title": True,
                "show_ticks": True,
                "title_size_pt": 8.0,
                "label_size_pt": 7.0,
            },
        ],
        "seq": 4,
    }


def make_scene() -> dict:
    """规范化后的 scene（compose 的真实输入口径）."""
    return page.normalize_scene(make_scene_doc(), figure=make_scene_doc()["figure"])


class BuildFinalTest(unittest.TestCase):
    def build(self, scene: dict | None = None, base: bytes | None = None):
        """跑一次 build_final, 返回 (final bytes, report)."""
        return compose.build_final(base or base_bytes(), scene or make_scene(), make_geo())

    def test_document_skeleton(self) -> None:
        final, _report = self.build()
        self.assertTrue(final.startswith(b'<?xml version="1.0" encoding="utf-8"?>\n'))
        self.assertIn(
            b'<svg xmlns="http://www.w3.org/2000/svg" '
            b'xmlns:xlink="http://www.w3.org/1999/xlink" '
            b'width="200pt" height="100pt" viewBox="0 0 200 100" version="1.1">',
            final,
        )
        self.assertTrue(final.endswith(b"</svg>\n"))
        self.assertFalse(final.endswith(b"\n\n"))
        self.assertEqual(final.count(b"</svg>"), 1)
        # 纸张底色矩形在图层最前.
        self.assertIn(
            b'<rect x="0" y="0" width="200" height="100" fill="#ffffff"/>', final
        )

    def test_layer_order(self) -> None:
        final, _report = self.build()
        map_index = final.index(b'<g id="mapdoc-map"')
        frame_index = final.index(b'<g id="mapdoc-frame">')
        overlay_index = final.index(b'<g id="mapdoc-overlay">')
        marker_index = final.index(b"mapdoc-final:")
        self.assertLess(map_index, frame_index)
        self.assertLess(frame_index, overlay_index)
        self.assertLess(overlay_index, marker_index)

    def test_base_inner_bytes_are_inlined_verbatim(self) -> None:
        raw = base_bytes()
        info = contract.read_base(raw)
        inner = raw[info.inner_start : info.inner_end]
        final, _report = self.build()
        # 内联的是原始切片: 整段内层字节必须原样出现, 且只出现一次.
        self.assertIn(inner, final)
        self.assertEqual(final.count(b'id="pyrender-clip"'), 1)
        self.assertLess(final.index(b'<g id="mapdoc-map"'), final.index(b'id="pyrender-clip"'))
        # 内层之后紧接地图组收尾, 不允许出现 <image> 底图引用.
        self.assertNotIn(b"<image", final)
        self.assertNotIn(b"xlink:href", final)

    def test_map_group_transform(self) -> None:
        final, _report = self.build()
        self.assertIn(
            b'<g id="mapdoc-map" transform="translate(10,10) scale(0.9)">', final
        )

    def test_frame_ticks_rendered(self) -> None:
        final, _report = self.build()
        self.assertIn("10°E".encode("utf-8"), final)
        self.assertIn("40°N".encode("utf-8"), final)
        self.assertIn(b'<rect x="10" y="10" width="180" height="90" fill="none"', final)

    def test_overlay_items_and_gradient(self) -> None:
        final, _report = self.build()
        self.assertIn(b'<g id="mapdoc-overlay">', final)
        self.assertIn("标题".encode("utf-8"), final)
        self.assertIn("图例".encode("utf-8"), final)
        self.assertIn(b'<linearGradient id="mapdoc-cbar-3"', final)
        self.assertIn(b'fill="url(#mapdoc-cbar-3)"', final)

    def test_marker_round_trip(self) -> None:
        final, report = self.build()
        marker = contract.read_marker(final)
        self.assertIsNotNone(marker)
        assert marker is not None
        self.assertEqual(marker["version"], 1)
        self.assertEqual(
            marker["counts"], {"text": 1, "legend": 1, "colorbar": 1, "total": 3}
        )
        self.assertEqual(marker["scene"], page.scene_digest(make_scene()))
        self.assertEqual(marker["geo"], geo.geo_digest(make_geo()))
        self.assertEqual(report["counts"], marker["counts"])

    def test_report_shape_when_clean(self) -> None:
        _final, report = self.build()
        self.assertEqual(
            set(report),
            {"counts", "warnings", "out_of_paper", "base_changed", "base_size_changed"},
        )
        self.assertEqual(report["warnings"], [])
        self.assertEqual(report["out_of_paper"], [])
        self.assertIs(report["base_changed"], False)
        self.assertIs(report["base_size_changed"], False)

    def test_two_calls_are_byte_identical(self) -> None:
        first, first_report = self.build()
        second, second_report = self.build()
        self.assertEqual(first, second)
        self.assertEqual(first_report, second_report)

    def test_base_changed_reported_but_output_still_built(self) -> None:
        scene = copy.deepcopy(make_scene())
        scene["base"]["sha256"] = "b" * 64
        final, report = self.build(scene)
        self.assertIs(report["base_changed"], True)
        self.assertTrue(any("base_changed" in warning for warning in report["warnings"]))
        self.assertIsNotNone(contract.read_marker(final))

    def test_base_size_changed_reported(self) -> None:
        scene = copy.deepcopy(make_scene())
        scene["base"]["width_pt"] = 300
        _final, report = self.build(scene)
        self.assertIs(report["base_size_changed"], True)
        self.assertTrue(
            any("base_size_changed" in warning for warning in report["warnings"])
        )

    def test_out_of_paper_map_only_warns(self) -> None:
        scene = copy.deepcopy(make_scene())
        scene["map"]["x"] = -50
        final, report = self.build(scene)
        self.assertTrue(
            any("地图超出纸张范围" in warning for warning in report["warnings"]),
            report["warnings"],
        )
        # 只告警: 仍然产出合法成品, out_of_paper 里只放 item id.
        self.assertEqual(report["out_of_paper"], [])
        self.assertIsNotNone(contract.read_marker(final))

    def test_out_of_paper_item_reported(self) -> None:
        scene = copy.deepcopy(make_scene())
        scene["items"][0]["x"] = 900
        _final, report = self.build(scene)
        self.assertEqual(report["out_of_paper"], [1])
        self.assertTrue(any("item 1(text)" in warning for warning in report["warnings"]))

    def test_invalid_base_rejected(self) -> None:
        raw = base_bytes()
        with_text = raw.replace(b"</svg>", b"<text>oops</text></svg>")
        with self.assertRaises(compose.BaseInvalid):
            self.build(base=with_text)
        with_marker = raw.replace(b"</svg>", b"<!-- mapdoc-final:AA== -->\n</svg>")
        with self.assertRaises(compose.BaseInvalid):
            self.build(base=with_marker)

    def test_invalid_scene_rejected(self) -> None:
        scene = make_scene_doc()
        scene["format"] = "wrong"
        with self.assertRaises(compose.SceneInvalid) as caught:
            compose.build_final(base_bytes(), scene, make_geo())
        self.assertTrue(caught.exception.errors)

    def test_stale_geo_rejected(self) -> None:
        doc = make_geo_doc()
        doc["base"]["sha256"] = "b" * 64
        stale = geo.parse_geo(doc)
        with self.assertRaises(compose.GeoInvalid) as caught:
            compose.build_final(base_bytes(), make_scene(), stale)
        self.assertTrue(
            any("sha256" in error for error in caught.exception.errors),
            caught.exception.errors,
        )

    def test_geo_view_box_mismatch_rejected(self) -> None:
        doc = make_geo_doc()
        doc["base"]["view_box"] = [1, 0, 200, 100]
        shifted = geo.parse_geo(doc)
        with self.assertRaises(compose.GeoInvalid) as caught:
            compose.build_final(base_bytes(), make_scene(), shifted)
        self.assertTrue(
            any("view_box" in error for error in caught.exception.errors),
            caught.exception.errors,
        )


class ComposeFileTest(unittest.TestCase):
    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.root = Path(self._directory.name)
        self.build_dir = self.root / ".build"
        self.build_dir.mkdir()
        self.base_path = self.build_dir / "map.base.svg"
        self.geo_path = self.root / "map.geo.json"
        self.final_path = self.root / "map.svg"
        self.base_path.write_bytes(base_bytes())
        self.geo_path.write_text(
            json.dumps(make_geo_doc(), ensure_ascii=False), encoding="utf-8"
        )
        self.scene = make_scene()

    def tearDown(self) -> None:
        self._directory.cleanup()

    def test_compose_writes_final_and_lock(self) -> None:
        report = compose.compose(self.scene, self.base_path, self.geo_path, self.final_path)
        self.assertTrue(self.final_path.exists())
        final = self.final_path.read_bytes()
        expected, expected_report = compose.build_final(
            base_bytes(), self.scene, make_geo()
        )
        self.assertEqual(final, expected)
        self.assertEqual(report, expected_report)
        lock_path = compose.derive_lock_path(self.base_path)
        self.assertEqual(lock_path, self.build_dir / "map.lock")
        self.assertTrue(lock_path.exists())
        self.assertEqual(list(self.root.rglob("*.tmp")), [])

    def test_compose_is_byte_identical_across_calls(self) -> None:
        compose.compose(self.scene, self.base_path, self.geo_path, self.final_path)
        first = self.final_path.read_bytes()
        compose.compose(self.scene, self.base_path, self.geo_path, self.final_path)
        self.assertEqual(self.final_path.read_bytes(), first)

    def test_busy_lock_raises_without_writing(self) -> None:
        lock_path = compose.derive_lock_path(self.base_path)
        with fsutil.try_flock(lock_path) as acquired:
            self.assertTrue(acquired)
            with self.assertRaises(compose.RenderingBusy):
                compose.compose(
                    self.scene, self.base_path, self.geo_path, self.final_path
                )
        self.assertFalse(self.final_path.exists())

    def test_invalid_scene_never_writes_final(self) -> None:
        self.final_path.write_bytes(b"sentinel")
        scene = make_scene_doc()
        scene["paper"]["width_pt"] = 10
        with self.assertRaises(compose.SceneInvalid):
            compose.compose(scene, self.base_path, self.geo_path, self.final_path)
        self.assertEqual(self.final_path.read_bytes(), b"sentinel")

    def test_missing_base_raises_base_invalid(self) -> None:
        with self.assertRaises(compose.BaseInvalid):
            compose.compose(
                self.scene,
                self.build_dir / "absent.base.svg",
                self.geo_path,
                self.final_path,
            )

    def test_missing_geo_raises_geo_invalid(self) -> None:
        with self.assertRaises(compose.GeoInvalid):
            compose.compose(
                self.scene,
                self.base_path,
                self.root / "absent.geo.json",
                self.final_path,
            )

    def test_invalid_geo_json_raises_geo_invalid(self) -> None:
        self.geo_path.write_text("{broken", encoding="utf-8")
        with self.assertRaises(compose.GeoInvalid):
            compose.compose(self.scene, self.base_path, self.geo_path, self.final_path)


class DeriveLockPathTest(unittest.TestCase):
    def test_base_suffix(self) -> None:
        self.assertEqual(
            compose.derive_lock_path(Path("/x/.build/volga.base.svg")),
            Path("/x/.build/volga.lock"),
        )

    def test_other_suffix_falls_back_to_stem(self) -> None:
        self.assertEqual(
            compose.derive_lock_path(Path("/x/.build/map.svg")),
            Path("/x/.build/map.lock"),
        )


if __name__ == "__main__":
    unittest.main()
