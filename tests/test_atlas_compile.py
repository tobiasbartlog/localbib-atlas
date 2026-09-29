"""Manuscript preview compile — Tectonic subprocess mocked, no LaTeX in CI."""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from atlas import compiler


@pytest.fixture
def manuscript_id(atlas_client):
    return atlas_client.post("/api/plugins/atlas/manuscripts", json={"title": "Probe"}).json()["id"]


class TestCompileEndpoint:
    def test_503_without_tectonic(self, atlas_client, manuscript_id, monkeypatch):
        monkeypatch.setattr(compiler, "find_tectonic", lambda: None)
        resp = atlas_client.post(f"/api/plugins/atlas/manuscripts/{manuscript_id}/compile")
        assert resp.status_code == 503
        assert "Tectonic" in resp.json()["detail"]

    def test_returns_pdf_and_passes_library_bib(
        self, atlas_client, manuscript_id, monkeypatch
    ):
        library = atlas_client.app.state.atlas_api.library
        library.add({"citekey": "Smith2020", "title": "T", "authors": "Smith, John", "year": 2020})

        captured = {}

        def fake_compile(tex_source, bibliography):
            captured["tex"] = tex_source
            captured["bib"] = bibliography
            return b"%PDF-fake"

        monkeypatch.setattr(compiler, "find_tectonic", lambda: "tectonic")
        monkeypatch.setattr(compiler, "compile_manuscript", fake_compile)

        resp = atlas_client.post(f"/api/plugins/atlas/manuscripts/{manuscript_id}/compile")
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "application/pdf"
        assert resp.content == b"%PDF-fake"
        assert "\\bibliography{literatur}" in captured["tex"]
        assert "{Smith2020," in captured["bib"]

    def test_422_with_log_on_compile_error(self, atlas_client, manuscript_id, monkeypatch):
        monkeypatch.setattr(compiler, "find_tectonic", lambda: "tectonic")

        def boom(tex_source, bibliography):
            raise compiler.CompileError("! Undefined control sequence.")

        monkeypatch.setattr(compiler, "compile_manuscript", boom)
        resp = atlas_client.post(f"/api/plugins/atlas/manuscripts/{manuscript_id}/compile")
        assert resp.status_code == 422
        assert "Undefined control sequence" in resp.json()["detail"]

    def test_404_for_unknown_manuscript(self, atlas_client):
        assert atlas_client.post("/api/plugins/atlas/manuscripts/nope/compile").status_code == 404


class TestCompilerSubprocess:
    def test_success_reads_pdf_from_tempdir(self, monkeypatch):
        monkeypatch.setattr(compiler, "find_tectonic", lambda: "tectonic-fake")

        def fake_run(cmd, cwd, **kwargs):
            assert Path(cwd, "main.tex").read_text(encoding="utf-8") == "TEX"
            assert Path(cwd, "literatur.bib").read_text(encoding="utf-8") == "BIB"
            Path(cwd, "main.pdf").write_bytes(b"%PDF-ok")
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

        monkeypatch.setattr(compiler.subprocess, "run", fake_run)
        assert compiler.compile_manuscript("TEX", "BIB") == b"%PDF-ok"

    def test_failure_raises_with_log_tail(self, monkeypatch):
        monkeypatch.setattr(compiler, "find_tectonic", lambda: "tectonic-fake")

        def fake_run(cmd, cwd, **kwargs):
            return subprocess.CompletedProcess(cmd, 1, stdout="out", stderr="err ")

        monkeypatch.setattr(compiler.subprocess, "run", fake_run)
        with pytest.raises(compiler.CompileError) as exc:
            compiler.compile_manuscript("TEX", "BIB")
        assert "err out" == exc.value.log

    def test_runtime_error_without_binary(self, monkeypatch):
        monkeypatch.setattr(compiler, "find_tectonic", lambda: None)
        with pytest.raises(RuntimeError):
            compiler.compile_manuscript("TEX", "BIB")


class TestFindTectonic:
    def test_env_var_wins(self, tmp_path, monkeypatch):
        exe = tmp_path / "tectonic.exe"
        exe.write_bytes(b"x")
        monkeypatch.setenv("TECTONIC_PATH", str(exe))
        assert compiler.find_tectonic() == str(exe)

    def test_none_when_nothing_found(self, tmp_path, monkeypatch):
        monkeypatch.delenv("TECTONIC_PATH", raising=False)
        monkeypatch.setattr(compiler.shutil, "which", lambda name: None)
        monkeypatch.setattr(compiler, "app_data_binary", lambda: tmp_path / "missing.exe")
        assert compiler.find_tectonic() is None
