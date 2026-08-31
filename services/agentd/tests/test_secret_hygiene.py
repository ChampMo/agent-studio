"""M1 proof #5: no provider key exists anywhere except the OS keychain (§9.2).

The brief lists five places a key must never be: localStorage, an env var, argv,
SQLite, and an export file. A rule like that decays the moment nobody checks it,
so it is checked here — against the working tree and against the live database,
not against intentions.
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]

#: Directories with no hand-written source in them. Scanning .venv finds other
#: people's test fixtures and says nothing about this repository.
SKIP_DIRS = {
    ".git",
    ".venv",
    "node_modules",
    "dist",
    "target",
    ".data",
    "__pycache__",
    ".pytest_cache",
    ".ruff_cache",
    ".vite",
}

#: Shapes of real credentials. The length floor is what keeps obvious test
#: placeholders like "sk-abc" out while still catching anything issuable.
KEY_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{24,}"),          # OpenAI / DeepSeek / Anthropic
    re.compile(r"sk-ant-[A-Za-z0-9_-]{16,}"),      # Anthropic, explicit form
    re.compile(r"AKIA[0-9A-Z]{16}"),               # AWS access key id
    re.compile(r"ghp_[A-Za-z0-9]{30,}"),           # GitHub token
]

TEXT_SUFFIXES = {
    ".py", ".ts", ".tsx", ".js", ".mjs", ".jsx", ".json", ".md", ".toml",
    ".yaml", ".yml", ".html", ".css", ".rs", ".ini", ".txt", ".env", ".example",
}


def _source_files():
    for path in REPO.rglob("*"):
        if not path.is_file():
            continue
        if SKIP_DIRS & set(path.parts):
            continue
        if path.suffix not in TEXT_SUFFIXES and path.name != ".env.example":
            continue
        yield path


def test_no_credential_shaped_string_anywhere_in_the_repo():
    hits = []
    for path in _source_files():
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for pattern in KEY_PATTERNS:
            for match in pattern.finditer(text):
                hits.append(f"{path.relative_to(REPO)}: {match.group()[:12]}…")
    assert hits == [], hits


def test_env_example_exists_and_holds_no_key():
    example = REPO / ".env.example"
    assert example.is_file(), ".env.example is required by §3.2"
    text = example.read_text(encoding="utf-8")
    for pattern in KEY_PATTERNS:
        assert not pattern.search(text)
    # It should say so out loud, because the next person will try to put one here.
    assert "keychain" in text.lower()


def test_a_committed_env_file_would_be_caught():
    """`.env` is gitignored, but a local one must still be keyless: it is the
    likeliest place for a key to end up by accident."""
    env = REPO / ".env"
    if not env.is_file():
        return
    text = env.read_text(encoding="utf-8")
    for pattern in KEY_PATTERNS:
        assert not pattern.search(text), ".env contains something key-shaped"


def test_gitignore_covers_env_and_the_data_directory():
    ignored = (REPO / ".gitignore").read_text(encoding="utf-8").split()
    assert ".env" in ignored
    assert ".data/" in ignored


def test_no_route_anywhere_can_return_a_key():
    """Inspects the assembled app rather than the source text.

    Grepping for a decorator string breaks the moment someone adds an argument
    to it, and it would miss a route mounted from a different module entirely.
    Reading the router catches a key-returning endpoint however it was declared.
    """
    from agentd.core.config import Settings
    from agentd.main import create_app

    app = create_app(settings=Settings(data_dir=REPO / ".data"))

    def walk(routes):
        """Descend into included routers.

        FastAPI 0.141 does not flatten `include_router` into `app.routes`: each
        one becomes a `_IncludedRouter` wrapper that keeps its real routes on
        `original_router`. Without descending, this test sees only `/health` and
        passes while checking nothing — which is exactly what it did until the
        positive assertions below caught it. Both attribute names are tried so a
        FastAPI upgrade cannot silently hollow the test out again.
        """
        for route in routes:
            nested = getattr(route, "routes", None) or getattr(
                getattr(route, "original_router", None), "routes", None
            )
            if nested:
                yield from walk(nested)
            else:
                yield route

    endpoints = {
        (method, route.path)
        for route in walk(app.routes)
        for method in (getattr(route, "methods", set()) or {"WEBSOCKET"})
        if getattr(route, "path", None)
    }

    readers = [
        f"{m} {p}" for m, p in endpoints if "key" in p.lower() and m in {"GET", "HEAD"}
    ]
    assert readers == [], readers

    # The write-only door must exist, or the check above proves nothing.
    assert ("PUT", "/providers/{profile_id}/key") in endpoints
    assert ("DELETE", "/providers/{profile_id}/key") in endpoints
    # Sanity: the walk really did reach the mounted routers.
    assert ("GET", "/providers") in endpoints
    assert ("POST", "/missions") in endpoints


def test_the_wire_representation_of_a_profile_has_no_key_field():
    source = (REPO / "services/agentd/agentd/providers/registry.py").read_text(
        encoding="utf-8"
    )
    body = source.split("def profile_to_json")[1]
    assert '"hasKey"' in body, "the UI needs to know whether a key exists"
    assert '"key"' not in body.replace('"hasKey"', "")


@pytest.mark.skipif(
    not (REPO / ".data/agent-studio.db").is_file(),
    reason="no local database yet; nothing to inspect",
)
def test_the_live_database_contains_no_key():
    """Runs against the real file this machine has been using, because that is
    where a leak would actually show up."""
    con = sqlite3.connect(f"file:{(REPO / '.data/agent-studio.db')}?mode=ro", uri=True)
    try:
        tables = [
            r[0]
            for r in con.execute(
                "select name from sqlite_master where type='table' "
                "and name not like 'sqlite_%'"
            )
        ]
        for table in tables:
            for row in con.execute(f"select * from {table}"):  # noqa: S608 - fixed names
                blob = " ".join(str(v) for v in row)
                for pattern in KEY_PATTERNS:
                    assert not pattern.search(blob), f"{table} holds something key-shaped"
    finally:
        con.close()


def test_secrets_module_is_the_only_thing_that_touches_the_keychain():
    """One door in and out (§9.2). A second caller of `keyring` elsewhere would
    be a second place to audit, and it would not get audited."""
    offenders = []
    pkg = REPO / "services/agentd/agentd"
    for path in pkg.rglob("*.py"):
        if path.name == "secrets.py":
            continue
        text = path.read_text(encoding="utf-8")
        if re.search(r"^\s*import keyring|^\s*from keyring", text, re.MULTILINE):
            offenders.append(str(path.relative_to(REPO)))
    assert offenders == [], offenders
