# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller build of the backend, for the Tauri sidecar (PROJECT_BRIEF.md §12 M7).

One file, because `externalBin` bundles a single executable. It costs a second
or two of unpacking at launch, which the frontend already has a waiting state
for — it has to, since the backend has always been a separate process.

Three kinds of thing PyInstaller cannot see by itself, all of them found by
running the result rather than by reading documentation:

* **Data loaded by path.** Alembic reads `alembic.ini`, `env.py` and every
  revision off disk. They are not imports, so nothing pulls them in.
* **Backends chosen at runtime.** `keyring` picks a backend through entry
  points, and SQLAlchemy imports its dialect by name. Neither appears in any
  import statement.
* **Package metadata.** Several libraries read their own version through
  `importlib.metadata`, which needs the `.dist-info` copied in.
"""

from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules, copy_metadata

HERE = Path(SPECPATH)  # noqa: F821 - PyInstaller injects SPECPATH

datas = [
    # Alembic opens this with configparser; it is ASCII-only for a reason
    # (see the comment at the top of the file).
    (str(HERE / "alembic.ini"), "."),
    (str(HERE / "agentd" / "db" / "migrations"), "agentd/db/migrations"),
]
binaries = []
hiddenimports = [
    # SQLAlchemy resolves this from the URL string, so no import mentions it.
    "aiosqlite",
    "sqlalchemy.dialects.sqlite.aiosqlite",
    # keyring's Windows backend is discovered through entry points.
    "keyring.backends.Windows",
    "keyring.backends.macOS",
    "keyring.backends.SecretService",
    "keyring.backends.chainer",
    "keyring.backends.fail",
]

# Servers, checkpointers and SDKs that import by name at runtime.
for package in ("uvicorn", "langgraph", "langgraph_checkpoint", "alembic"):
    hiddenimports += collect_submodules(package)

for package in ("keyring", "langgraph"):
    extra_datas, extra_binaries, extra_hidden = collect_all(package)
    datas += extra_datas
    binaries += extra_binaries
    hiddenimports += extra_hidden

# Read at runtime by libraries reporting their own version.
for package in ("openai", "anthropic", "keyring", "langgraph", "alembic"):
    try:
        datas += copy_metadata(package)
    except Exception:  # noqa: BLE001 - a missing dist-info is not fatal here
        pass


a = Analysis(  # noqa: F821
    # Not `agentd/__main__.py`: PyInstaller runs the entry script as a
    # top-level `__main__`, where its relative imports have no parent package.
    ["sidecar.py"],
    pathex=[str(HERE)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    # Nothing here needs a GUI toolkit; leaving them in doubles the size.
    excludes=["tkinter", "matplotlib", "PIL", "pytest", "IPython"],
    noarchive=False,
)

pyz = PYZ(a.pure)  # noqa: F821

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="agentd",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # A console subsystem binary: the parent talks to it over stdin and stdout
    # (the token in, the ready line out), and a windowed build has neither.
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    codesign_identity=None,
    entitlements_file=None,
)
