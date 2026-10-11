"""Shared fixtures of the Atlas tests — the contract package and its fakes only.

These tests never import the LocalBib core: the isolated CI job installs just
this Bundle, ``plugin_api`` and the Bundle's own third-party dependencies and
runs them there (#188). The Bundle root goes on ``sys.path`` the way the core
loader puts it there, so ``import atlas`` resolves to the package next to
``plugin.json``.

The HTTP tests talk to a small FastAPI app that hosts Atlas the way the core
does: ``activate()`` with a ``PluginApi`` from ``plugin_api.testing.make_api``
(gated by the Manifest's Berechtigungen, the Atlas folder handed over as the
``base_dir`` setting) inside the app's lifespan, the registered routers
mounted, ``deactivate()`` on shutdown. A ``with`` block is one app run, so two
blocks in a row are a restart.
"""

from __future__ import annotations

import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

import pytest

BUNDLE_ROOT = Path(__file__).resolve().parent.parent
if str(BUNDLE_ROOT) not in sys.path:
    sys.path.insert(0, str(BUNDLE_ROOT))

from plugin_api import load_manifest  # noqa: E402
from plugin_api.testing import InMemoryLibrary, TempSqliteStorage, make_api  # noqa: E402

MANIFEST = load_manifest(BUNDLE_ROOT)


def build_app(base_dir: Path, *, library: Any = None, llm: Any = None, storage: Any = None,
              settings: Optional[dict] = None):
    """A FastAPI app hosting a fresh ``AtlasPlugin`` on ``base_dir``;
    ``settings`` seeds further Add-on settings (e.g. ``own_name``)."""
    from fastapi import FastAPI

    import atlas

    plugin = atlas.AtlasPlugin()
    api = make_api(
        MANIFEST.permissions,
        library=library if library is not None else InMemoryLibrary(),
        llm=llm,
        storage=storage,
        settings={**(settings or {}), "base_dir": str(base_dir)},
    )
    if llm is False:  # a core without an LLM service: the Add-on must degrade
        api.llm = None

    @asynccontextmanager
    async def lifespan(app):
        await plugin.activate(api)
        for router in api.routes.routers:
            app.include_router(router)
        try:
            yield
        finally:
            await plugin.deactivate()

    app = FastAPI(lifespan=lifespan)
    app.state.atlas_api = api
    app.state.atlas_plugin = plugin
    return app


@pytest.fixture
def atlas_app(tmp_path, tmp_path_factory):
    """Factory: ``with atlas_app(base, library=..., llm=..., settings=...) as client:``.

    ``base`` defaults to ``tmp_path``; ``library`` to an empty
    ``InMemoryLibrary``; ``llm`` to the contract's ``DummyLlm`` (``False``:
    no LLM service at all); ``settings`` seeds Add-on settings next to
    ``base_dir``. The ``PluginApi`` handed to Atlas is
    ``client.app.state.atlas_api`` — patch its ``llm`` to script answers,
    ``settings.set(...)`` to change a setting while Atlas runs."""
    from fastapi.testclient import TestClient

    storages: list[TempSqliteStorage] = []

    def _open(base: Optional[Path] = None, *, library: Any = None, llm: Any = None,
              settings: Optional[dict] = None):
        storage = TempSqliteStorage(tmp_path_factory.mktemp("atlas-storage"))
        storages.append(storage)
        return TestClient(build_app(base or tmp_path, library=library, llm=llm, storage=storage,
                                    settings=settings))

    yield _open
    for storage in storages:
        storage.close()


@pytest.fixture
def atlas_client(atlas_app):
    """Atlas on ``tmp_path`` with an empty library — the common case."""
    with atlas_app() as client:
        yield client


def llm_of(client):
    """The LLM service the hosted Atlas talks to (patch ``complete``/``embed``)."""
    return client.app.state.atlas_api.llm
