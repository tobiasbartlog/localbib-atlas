"""Tectonic compile wrapper for the manuscript preview (the LaTeX editor).

Tectonic is a single self-contained binary: it fetches packages on demand and
runs the multi-pass bibtex dance itself, so one subprocess call yields the PDF.
The binary is not bundled — it is discovered via ``TECTONIC_PATH``, the PATH,
or the LocalBib app-data dir (where a one-time download places it).

Compilation happens in a throwaway temp dir: ``main.tex`` (the manuscript) and
``literatur.bib`` (the library bibliography, provided by the host's LibraryApi)
in, ``main.pdf`` out. Nothing touches the archive (P2).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

COMPILE_TIMEOUT_SECONDS = 180  # first run may download packages


class CompileError(Exception):
    """Compilation failed; ``log`` carries the tail of Tectonic's output."""

    def __init__(self, log: str) -> None:
        super().__init__("LaTeX-Kompilierung fehlgeschlagen")
        self.log = log


def app_data_binary() -> Path:
    """Where the one-time download puts tectonic (no install required)."""
    if os.name == "nt":
        base = Path(os.getenv("LOCALAPPDATA", "~")).expanduser()
    else:
        base = Path(os.getenv("XDG_DATA_HOME", "~/.local/share")).expanduser()
    exe = "tectonic.exe" if os.name == "nt" else "tectonic"
    return base / "LocalBib" / "tectonic" / exe


def find_tectonic() -> Optional[str]:
    env_path = os.getenv("TECTONIC_PATH", "").strip()
    if env_path and Path(env_path).expanduser().is_file():
        return str(Path(env_path).expanduser())
    on_path = shutil.which("tectonic")
    if on_path:
        return on_path
    candidate = app_data_binary()
    if candidate.is_file():
        return str(candidate)
    return None


def compile_manuscript(tex_source: str, bibliography: str) -> bytes:
    """Compile to PDF bytes; raises CompileError (with log) or RuntimeError
    when no Tectonic binary is available."""
    exe = find_tectonic()
    if exe is None:
        raise RuntimeError("Tectonic nicht gefunden")

    with tempfile.TemporaryDirectory(prefix="localbib-tex-") as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "main.tex").write_text(tex_source, encoding="utf-8")
        (tmp_path / "literatur.bib").write_text(bibliography, encoding="utf-8")
        try:
            result = subprocess.run(
                [exe, "-X", "compile", "main.tex"],
                cwd=tmp,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=COMPILE_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            raise CompileError(
                f"Zeitlimit ({COMPILE_TIMEOUT_SECONDS}s) ueberschritten — "
                "haengt der Paket-Download?"
            )
        if result.returncode != 0:
            log = (result.stderr or "") + (result.stdout or "")
            raise CompileError(log[-4000:])
        pdf = tmp_path / "main.pdf"
        if not pdf.is_file():
            raise CompileError("Tectonic meldete Erfolg, aber kein PDF erzeugt")
        return pdf.read_bytes()
