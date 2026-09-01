"""Reading the workspace: read_file, list_dir, glob, grep (§16.7).

All four are `safe` — they change nothing — but "safe" is about permission, not
about care. Each has a limit, and every limit is here for a specific way of
being useless:

* `read_file` without one pulls a 50MB log into the context window and spends
  the mission's whole token budget in a single call. It takes `offset` and
  `limit` in lines so a large file can be read the way a person reads one.
* `list_dir` in `node_modules` returns a hundred thousand entries.
* `glob` and `grep` can match the same.

Every limit that bites says so in the output. A truncated result the model
believes is complete is worse than no result: it will conclude the string it was
looking for is absent.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from .base import ToolContext, ToolFailed, ToolResult
from .paths import PathRejected, canonical, resolve_within

#: Lines returned by `read_file` when the caller does not say. Two thousand is
#: most source files whole, and about 80KB of prose — large enough to be useful,
#: small enough that a mistake is not the whole budget.
DEFAULT_READ_LIMIT = 2000
MAX_READ_LIMIT = 5000
#: A single line longer than this is a minified bundle or a binary; the model
#: gains nothing from the rest of it.
MAX_LINE_CHARS = 2000

MAX_ENTRIES = 500
MAX_MATCHES = 200
#: Files bigger than this are not searched. A 200MB database file is not what
#: anyone means by "grep the project".
MAX_SEARCHABLE_BYTES = 5 * 1024 * 1024

#: Directories skipped by glob and grep unless asked for by name. These are
#: where a project keeps things it did not write.
SKIP_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv",
    ".mypy_cache", ".pytest_cache", ".ruff_cache", "dist", "build", "target",
    ".next", ".cache", ".idea", ".vscode",
}


def _rejected(exc: PathRejected) -> ToolFailed:
    # The reason, never the resolved path: naming what it resolved to would
    # hand back the location the check exists to keep out of reach.
    return ToolFailed("path_rejected", f"{exc.reason}: {exc.given!r}")


def _relative(root: Path, path: Path) -> str:
    try:
        return str(path.relative_to(root)).replace(os.sep, "/")
    except ValueError:  # pragma: no cover - callers resolve within root first
        return str(path)


def _read_text(path: Path) -> str:
    """Read a file as text, or say plainly that it is not one."""
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ToolFailed("read_failed", f"could not read the file: {exc}") from exc
    if b"\x00" in raw[:8192]:
        raise ToolFailed("binary_file", "this looks like a binary file, not text")
    return raw.decode("utf-8", errors="replace")


async def read_file(
    ctx: ToolContext, *, path: str, offset: int = 0, limit: int | None = None
) -> ToolResult:
    """Read part of a text file, by line."""
    root = canonical(ctx.require_workspace())
    try:
        target = resolve_within(root, path)
    except PathRejected as exc:
        raise _rejected(exc) from exc

    if not target.exists():
        raise ToolFailed("not_found", f"no such file: {path}")
    if target.is_dir():
        raise ToolFailed("is_a_directory", f"{path} is a directory; use list_dir")

    limit = DEFAULT_READ_LIMIT if limit is None else max(1, min(int(limit), MAX_READ_LIMIT))
    offset = max(0, int(offset))

    lines = _read_text(target).splitlines()
    window = lines[offset : offset + limit]
    clipped = [
        line if len(line) <= MAX_LINE_CHARS else line[:MAX_LINE_CHARS] + " …[line truncated]"
        for line in window
    ]

    # Numbered from the real position in the file, so a second call with a new
    # offset lines up with the first.
    body = "\n".join(f"{offset + i + 1}\t{line}" for i, line in enumerate(clipped))
    more = offset + len(window) < len(lines)
    if more:
        body += (
            f"\n\n[showing lines {offset + 1}-{offset + len(window)} of {len(lines)}. "
            f"Call read_file again with offset={offset + len(window)} for the rest.]"
        )

    rel = _relative(root, target)
    return ToolResult(
        content=body or "[this file is empty]",
        summary=f"read {len(window)} line(s) of {rel}",
        truncated=more,
        details={"path": rel, "lines": len(lines)},
    )


async def list_dir(ctx: ToolContext, *, path: str = ".") -> ToolResult:
    """List one directory, without descending."""
    root = canonical(ctx.require_workspace())
    try:
        target = resolve_within(root, path or ".")
    except PathRejected as exc:
        raise _rejected(exc) from exc

    if not target.exists():
        raise ToolFailed("not_found", f"no such directory: {path}")
    if not target.is_dir():
        raise ToolFailed("not_a_directory", f"{path} is a file; use read_file")

    entries = []
    for entry in sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        if len(entries) >= MAX_ENTRIES:
            break
        try:
            if entry.is_dir():
                entries.append(f"{entry.name}/")
            else:
                entries.append(f"{entry.name}\t{entry.stat().st_size}B")
        except OSError:
            # A link to nowhere, or something that vanished mid-listing.
            entries.append(f"{entry.name}\t[unreadable]")

    total = sum(1 for _ in target.iterdir())
    truncated = total > len(entries)
    body = "\n".join(entries) or "[this directory is empty]"
    if truncated:
        body += f"\n\n[{total - len(entries)} more entries not shown]"

    rel = _relative(root, target)
    return ToolResult(
        content=body,
        summary=f"listed {len(entries)} entr(ies) in {rel or '.'}",
        truncated=truncated,
        details={"path": rel, "entries": len(entries)},
    )


def _walk(root: Path, start: Path):
    """Every file under `start`, skipping the directories nobody means."""
    for current, dirnames, filenames in os.walk(start):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            yield Path(current) / name


async def glob(ctx: ToolContext, *, pattern: str, path: str = ".") -> ToolResult:
    """Find files by name pattern, most recently changed first."""
    root = canonical(ctx.require_workspace())
    try:
        start = resolve_within(root, path or ".")
    except PathRejected as exc:
        raise _rejected(exc) from exc
    if not start.is_dir():
        raise ToolFailed("not_a_directory", f"{path} is not a directory")
    if not pattern:
        raise ToolFailed("bad_pattern", "a glob pattern is required")

    matches: list[Path] = []
    try:
        for found in start.glob(pattern):
            if any(part in SKIP_DIRS for part in found.parts):
                continue
            if found.is_file():
                matches.append(found)
            if len(matches) > MAX_ENTRIES * 4:
                break
    except (OSError, ValueError) as exc:
        raise ToolFailed("bad_pattern", f"that pattern could not be used: {exc}") from exc

    # Newest first: when a pattern matches a hundred files, the ones just
    # touched are the ones being worked on.
    def mtime(p: Path) -> float:
        try:
            return p.stat().st_mtime
        except OSError:
            return 0.0

    matches.sort(key=mtime, reverse=True)
    shown = matches[:MAX_ENTRIES]
    body = "\n".join(_relative(root, m) for m in shown) or "[no files matched]"
    if len(matches) > len(shown):
        body += f"\n\n[{len(matches) - len(shown)} more matches not shown]"

    return ToolResult(
        content=body,
        summary=f"{len(shown)} file(s) matched {pattern!r}",
        truncated=len(matches) > len(shown),
        details={"matches": len(shown)},
    )


async def grep(
    ctx: ToolContext, *, pattern: str, path: str = ".", glob: str | None = None
) -> ToolResult:
    """Search file contents for a regular expression."""
    root = canonical(ctx.require_workspace())
    try:
        start = resolve_within(root, path or ".")
    except PathRejected as exc:
        raise _rejected(exc) from exc
    if not pattern:
        raise ToolFailed("bad_pattern", "a search pattern is required")

    try:
        expression = re.compile(pattern)
    except re.error as exc:
        raise ToolFailed("bad_pattern", f"that is not a valid regular expression: {exc}") from exc

    candidates = [start] if start.is_file() else list(_walk(root, start))
    if glob:
        candidates = [c for c in candidates if c.match(glob)]

    hits: list[str] = []
    scanned = 0
    for candidate in candidates:
        if len(hits) >= MAX_MATCHES:
            break
        try:
            if candidate.stat().st_size > MAX_SEARCHABLE_BYTES:
                continue
            raw = candidate.read_bytes()
        except OSError:
            continue
        if b"\x00" in raw[:8192]:
            continue
        scanned += 1
        text = raw.decode("utf-8", errors="replace")
        for number, line in enumerate(text.splitlines(), start=1):
            if expression.search(line):
                clipped = line if len(line) <= 300 else line[:300] + " …"
                hits.append(f"{_relative(root, candidate)}:{number}: {clipped.strip()}")
                if len(hits) >= MAX_MATCHES:
                    break

    body = "\n".join(hits) or "[no matches]"
    truncated = len(hits) >= MAX_MATCHES
    if truncated:
        body += "\n\n[stopped at the match limit; narrow the pattern or the path]"

    return ToolResult(
        content=body,
        summary=f"{len(hits)} match(es) for {pattern!r} in {scanned} file(s)",
        truncated=truncated,
        details={"matches": len(hits), "filesScanned": scanned},
    )
