"""studio HTTP 服务的端到端单测（真实监听 127.0.0.1 的临时端口）.

覆盖: 配置校验、``/api/health``、``/api/doc``、``/api/geo``、``/api/scene`` GET/PUT（含
409 base_changed/base_size_changed、400 invalid_scene、503 geo_missing）、``/api/compose``、
``/base.svg``/``/final.svg``/``/geo.json``、静态文件白名单与 ``..`` 拒绝、no-store 响应头。
用什么: 临时目录里造一份纯底图 + geo + scene；compose 走真实 page/geo/render/compose 链路，
因此本文件同时是「前端保存 → Python 合成」的集成测试。
"""

from __future__ import annotations

import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

import studio
from mapdoc import contract, geo as geo_mod, page as page_mod

from .fixtures_data import BASE_SVG, GEO_TEMPLATE, make_scene

CONFIG_TOML = """\
[studio]
port = 0
open_browser = false
web_dist = "web_dist"
base_dir = ".build"

[figures]
volga = "figures/Volga/map.svg"
"""


class _StudioCase(unittest.TestCase):
    """起一个真实 studio 线程；每个用例独立临时目录."""

    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.root = Path(self._directory.name)
        self.figure_dir = self.root / "figures" / "Volga"
        self.figure_dir.mkdir(parents=True)
        self.final_path = self.figure_dir / "map.svg"
        self.scene_path = self.figure_dir / "map.scene.json"
        self.geo_path = self.figure_dir / "map.geo.json"
        self.base_path = self.figure_dir / ".build" / "map.base.svg"
        self.base_path.parent.mkdir(parents=True)
        self.base_path.write_bytes(BASE_SVG)
        self.base_sha = contract.sha256(BASE_SVG)
        self.geo = json.loads(
            json.dumps(GEO_TEMPLATE).replace("__BASE_SHA__", self.base_sha)
        )
        self.geo_path.write_text(
            json.dumps(self.geo, ensure_ascii=False), encoding="utf-8"
        )

        web_dist = self.root / "web_dist"
        (web_dist / "assets").mkdir(parents=True)
        (web_dist / "index.html").write_text(
            "<!doctype html><html><body>sketch</body></html>", encoding="utf-8"
        )
        (web_dist / "map.html").write_text(
            "<!doctype html><html><body>map</body></html>", encoding="utf-8"
        )
        (web_dist / "assets" / "app.js").write_text(
            "export const ok = true;\n", encoding="utf-8"
        )

        self.config_path = self.root / "studio.toml"
        self.config_path.write_text(CONFIG_TOML, encoding="utf-8")
        self.config = studio.load_config(self.config_path)
        self.server = studio.make_server(self.config)
        self.server.quiet = True
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            kwargs={"poll_interval": 0.05},
            daemon=True,
        )
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self._directory.cleanup()

    # -- 请求辅助 ---------------------------------------------------------

    def request(
        self,
        method: str,
        path: str,
        body: object | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        payload = None
        headers: dict[str, str] = {}
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        connection.request(method, path, body=payload, headers=headers)
        response = connection.getresponse()
        data = response.read()
        status = response.status
        response_headers = dict(response.getheaders())
        connection.close()
        return status, response_headers, data

    def json_request(
        self, method: str, path: str, body: object | None = None
    ) -> tuple[int, dict[str, object]]:
        status, _headers, data = self.request(method, path, body)
        parsed = json.loads(data.decode("utf-8")) if data else None
        self.assertIsInstance(parsed, dict)
        return status, parsed  # type: ignore[return-value]

    def scene_payload(self) -> dict[str, object]:
        """当前底图 + geo 下的一份合法 scene（不含 figure：PUT 由服务器盖章）."""
        return make_scene(self.base_sha)

    # -- 基础端点 ---------------------------------------------------------

    def test_health(self) -> None:
        status, payload = self.json_request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["figures"], ["volga"])

    def test_doc_reports_base_and_geo(self) -> None:
        status, payload = self.json_request("GET", "/api/doc")
        self.assertEqual(status, 200)
        self.assertEqual(payload["base"]["sha256"], self.base_sha)
        self.assertEqual(payload["base"]["width_pt"], 200.0)
        self.assertIsNone(payload["scene"]["sha256"])
        self.assertFalse(payload["needs"]["base"])
        self.assertFalse(payload["needs"]["geo"])

    def test_geo_and_base_endpoints(self) -> None:
        status, headers, data = self.request("GET", "/api/geo")
        self.assertEqual(status, 200)
        self.assertIn("mapdoc-geo", data.decode("utf-8"))
        self.assertEqual(headers.get("Cache-Control"), "no-store")
        status, headers, data = self.request("GET", "/base.svg")
        self.assertEqual(status, 200)
        self.assertEqual(data, BASE_SVG)
        self.assertEqual(headers.get("Content-Type"), "image/svg+xml")

    def test_scene_missing_is_null(self) -> None:
        status, _headers, data = self.request("GET", "/api/scene")
        self.assertEqual(status, 200)
        self.assertEqual(data, b"null")

    # -- 保存与合成 -------------------------------------------------------

    def test_put_scene_composes_final(self) -> None:
        scene = self.scene_payload()
        status, payload = self.json_request("PUT", "/api/scene", scene)
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["saved"])
        self.assertTrue(payload["composed"])
        report = payload["report"]
        self.assertEqual(report["counts"]["text"], 1)
        self.assertEqual(report["counts"]["legend"], 1)
        self.assertEqual(report["counts"]["colorbar"], 1)
        self.assertEqual(report["counts"]["total"], 3)

        # scene 落盘: 服务器补齐 figure 并规范化.
        saved = json.loads(self.scene_path.read_text(encoding="utf-8"))
        self.assertEqual(saved["format"], "mapdoc-page")
        self.assertTrue(saved["figure"].endswith("figures/Volga/map.svg"))
        self.assertEqual(page_mod.validate_scene(saved), [])

        # final: 纸张尺寸、内联底图、文字存在、marker 与 scene 摘要一致.
        final = self.final_path.read_bytes()
        self.assertTrue(final.startswith(b'<?xml version="1.0" encoding="utf-8"?>'))
        self.assertIn(b'width="300pt"', final)
        inner = BASE_SVG[
            contract.read_base(BASE_SVG).inner_start : contract.read_base(BASE_SVG).inner_end
        ]
        self.assertIn(inner, final)
        self.assertIn("测试标题".encode("utf-8"), final)
        marker = contract.read_marker(final)
        self.assertIsNotNone(marker)
        assert marker is not None
        self.assertEqual(marker["scene"], page_mod.scene_digest(saved))
        self.assertEqual(marker["geo"], geo_mod.geo_digest(geo_mod.read_geo(self.geo_path)))

        # GET /api/doc 报告 scene 已同步.
        _status, doc = self.json_request("GET", "/api/doc")
        self.assertEqual(doc["scene"]["sha256"], page_mod.scene_digest(saved))
        self.assertFalse(doc["needs"]["compose"])

    def test_put_invalid_scene_does_not_write(self) -> None:
        scene = self.scene_payload()
        items = scene["items"]
        assert isinstance(items, list)
        items[0]["color"] = "red"  # type: ignore[index]
        status, payload = self.json_request("PUT", "/api/scene", scene)
        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "invalid_scene")
        self.assertFalse(self.scene_path.exists())
        self.assertFalse(self.final_path.exists())

    def test_put_base_changed_requires_ack(self) -> None:
        scene = self.scene_payload()
        base = scene["base"]
        assert isinstance(base, dict)
        stale = dict(base)
        stale["sha256"] = "0" * 64
        scene["base"] = stale
        status, payload = self.json_request("PUT", "/api/scene", scene)
        self.assertEqual(status, 409)
        self.assertEqual(payload["code"], "base_changed")

        scene["ack_base_change"] = True
        status, payload = self.json_request("PUT", "/api/scene", scene)
        self.assertEqual(status, 200, payload)
        saved = json.loads(self.scene_path.read_text(encoding="utf-8"))
        self.assertEqual(saved["base"]["sha256"], self.base_sha)

    def test_put_base_size_changed(self) -> None:
        scene = self.scene_payload()
        base = scene["base"]
        assert isinstance(base, dict)
        changed = dict(base)
        changed["width_pt"] = 201
        scene["base"] = changed
        status, payload = self.json_request("PUT", "/api/scene", scene)
        self.assertEqual(status, 409)
        self.assertEqual(payload["code"], "base_size_changed")

    def test_compose_after_final_removed(self) -> None:
        status, _payload = self.json_request(
            "PUT", "/api/scene", self.scene_payload()
        )
        self.assertEqual(status, 200)
        self.final_path.unlink()
        status, payload = self.json_request("POST", "/api/compose")
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["composed"])
        self.assertTrue(self.final_path.is_file())

    def test_compose_without_scene_is_rejected(self) -> None:
        status, payload = self.json_request("POST", "/api/compose")
        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "invalid_scene")

    # -- 静态文件 ---------------------------------------------------------

    def test_static_whitelist(self) -> None:
        status, _headers, data = self.request("GET", "/map.html")
        self.assertEqual(status, 200)
        self.assertIn(b"map", data)
        status, _headers, data = self.request("GET", "/assets/app.js")
        self.assertEqual(status, 200)
        self.assertIn(b"ok", data)
        status, _headers, _data = self.request("GET", "/../studio.toml")
        self.assertEqual(status, 404)
        status, _headers, _data = self.request("GET", "/assets/../studio.toml")
        self.assertEqual(status, 404)

    def test_geo_missing_degrades(self) -> None:
        self.geo_path.unlink()
        status, payload = self.json_request("GET", "/api/doc")
        self.assertEqual(status, 200)
        self.assertTrue(payload["needs"]["geo"])
        status, payload = self.json_request("PUT", "/api/scene", self.scene_payload())
        self.assertEqual(status, 503)
        self.assertEqual(payload["code"], "geo_missing")


class _ConfigCase(unittest.TestCase):
    """配置校验：站点端口只认 studio.toml，没有第二份默认值."""

    def _load(self, text: str) -> studio.StudioConfig:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "studio.toml"
        path.write_text(text, encoding="utf-8")
        return studio.load_config(path)

    def test_port_comes_from_toml(self) -> None:
        config = self._load(
            """\
[studio]
port = 12345
open_browser = false
web_dist = "web_dist"
base_dir = ".build"

[figures]
volga = "figures/Volga/map.svg"
"""
        )
        self.assertEqual(config.port, 12345)

    def test_missing_port_is_rejected(self) -> None:
        with self.assertRaises(studio.StudioConfigError) as context:
            self._load(
                """\
[studio]
open_browser = false
web_dist = "web_dist"
base_dir = ".build"

[figures]
volga = "figures/Volga/map.svg"
"""
            )
        self.assertIn("studio.port", str(context.exception))
