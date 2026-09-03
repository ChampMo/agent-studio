"""Reading the workspace, and the limits that make it usable (§16.7).

The interesting assertions here are not "it read the file". They are the limits:
a tool that returns a 50MB file spends the whole mission budget in one call, and
one that silently returns half a file makes the model conclude that what it was
looking for is not there.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agentd.tools import fs
from agentd.tools.base import ToolContext, ToolFailed


@pytest.fixture
def ctx(tmp_path: Path) -> ToolContext:
    root = tmp_path / "workspace"
    (root / "src").mkdir(parents=True)
    (root / "src" / "main.py").write_text(
        "\n".join(f"line {i}" for i in range(1, 51)), encoding="utf-8"
    )
    (root / "README.md").write_text("# Project\n\nHello.\n", encoding="utf-8")
    (root / "node_modules").mkdir()
    (root / "node_modules" / "junk.py").write_text("secret_marker\n", encoding="utf-8")
    return ToolContext(mission_id="m-1", agent_id="a-1", workspace_root=str(root))


async def test_read_file_numbers_lines_from_the_real_position(ctx: ToolContext):
    result = await fs.read_file(ctx, path="src/main.py", offset=10, limit=3)
    assert result.content.splitlines()[:3] == ["11\tline 11", "12\tline 12", "13\tline 13"]
    # Truncation is stated in the content, not only in a flag the model cannot
    # see: a silent cut reads as "this is the whole file".
    assert result.truncated is True
    assert "offset=13" in result.content


async def test_read_file_stops_at_the_default_limit(ctx: ToolContext, tmp_path: Path):
    big = Path(ctx.workspace_root) / "big.txt"
    big.write_text("\n".join(str(i) for i in range(fs.DEFAULT_READ_LIMIT + 500)), encoding="utf-8")

    result = await fs.read_file(ctx, path="big.txt")
    assert len(result.content.splitlines()) <= fs.DEFAULT_READ_LIMIT + 3
    assert result.truncated is True


async def test_read_file_clips_a_single_enormous_line(ctx: ToolContext):
    minified = Path(ctx.workspace_root) / "bundle.js"
    minified.write_text("x" * (fs.MAX_LINE_CHARS * 3), encoding="utf-8")

    result = await fs.read_file(ctx, path="bundle.js")
    assert "[line truncated]" in result.content
    assert len(result.content) < fs.MAX_LINE_CHARS * 2


async def test_read_file_refuses_a_directory_and_a_missing_file(ctx: ToolContext):
    with pytest.raises(ToolFailed) as as_dir:
        await fs.read_file(ctx, path="src")
    assert as_dir.value.code == "is_a_directory"

    with pytest.raises(ToolFailed) as missing:
        await fs.read_file(ctx, path="nope.txt")
    assert missing.value.code == "not_found"


async def test_read_file_says_a_binary_is_a_binary(ctx: ToolContext):
    blob = Path(ctx.workspace_root) / "image.png"
    blob.write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00\x00")
    with pytest.raises(ToolFailed) as caught:
        await fs.read_file(ctx, path="image.png")
    assert caught.value.code == "binary_file"


async def test_read_file_cannot_leave_the_workspace(ctx: ToolContext, tmp_path: Path):
    (tmp_path / "secret.txt").write_text("the key", encoding="utf-8")
    with pytest.raises(ToolFailed) as caught:
        await fs.read_file(ctx, path="../secret.txt")
    assert caught.value.code == "path_rejected"
    # The message must not name what it resolved to — that is the location the
    # check exists to keep out of reach.
    assert "secret.txt" in caught.value.message
    assert str(tmp_path) not in caught.value.message


async def test_a_mission_with_no_workspace_cannot_use_a_file_tool():
    naked = ToolContext(mission_id="m-1", agent_id="a-1", workspace_root=None)
    with pytest.raises(ToolFailed) as caught:
        await fs.read_file(naked, path="anything.txt")
    assert caught.value.code == "no_workspace"


async def test_list_dir_shows_folders_first(ctx: ToolContext):
    result = await fs.list_dir(ctx)
    lines = result.content.splitlines()
    assert lines[0].endswith("/")
    assert any(line.startswith("README.md") for line in lines)


async def test_glob_skips_the_folders_nobody_means(ctx: ToolContext):
    result = await fs.glob(ctx, pattern="**/*.py")
    assert "src/main.py" in result.content
    # node_modules is not what "find the Python files" meant.
    assert "node_modules" not in result.content


async def test_glob_reports_a_bad_pattern_rather_than_raising(ctx: ToolContext):
    with pytest.raises(ToolFailed) as caught:
        await fs.glob(ctx, pattern="")
    assert caught.value.code == "bad_pattern"


# ---- braces ------------------------------------------------------------
#
# Found by a real run. A worker wrote package.json, tsconfig.json,
# next.config.mjs, app/globals.css and lib/data.ts, then asked for
# `**/*.{ts,tsx,json,md}` — the ordinary way to say "the source files" — and
# was told `0 file(s) matched`. Not an error: a false statement about a folder
# holding two .json and one .ts (§1). It went to `bash` and `find` instead,
# which raised an approval question, which is where that run stopped.


def test_braces_expand_to_one_pattern_per_option():
    assert fs.expand_braces("**/*.{ts,tsx}") == ["**/*.ts", "**/*.tsx"]


def test_a_pattern_with_no_braces_is_itself():
    assert fs.expand_braces("**/*.py") == ["**/*.py"]


def test_nested_braces_expand_too():
    assert fs.expand_braces("{a,{b,c}}.ts") == ["a.ts", "b.ts", "c.ts"]


def test_an_unbalanced_brace_is_left_alone():
    # `{` is a legal character in a filename. Guessing what was meant would be
    # worse than matching what was typed.
    assert fs.expand_braces("weird{name.ts") == ["weird{name.ts"]


async def test_glob_finds_both_extensions(ctx: ToolContext):
    result = await fs.glob(ctx, pattern="**/*.{py,md}")
    assert "src/main.py" in result.content
    assert "README.md" in result.content


async def test_a_file_matching_two_branches_is_listed_once(ctx: ToolContext):
    result = await fs.glob(ctx, pattern="**/*.{py,py}")
    assert result.content.count("src/main.py") == 1


async def test_grep_returns_file_and_line(ctx: ToolContext):
    result = await fs.grep(ctx, pattern=r"line 4[0-9]")
    assert "src/main.py:40:" in result.content
    assert result.details["matches"] == 10


async def test_grep_skips_build_directories_and_binaries(ctx: ToolContext):
    blob = Path(ctx.workspace_root) / "data.bin"
    blob.write_bytes(b"secret_marker\x00\x00binary")

    result = await fs.grep(ctx, pattern="secret_marker")
    assert result.content == "[no matches]"


async def test_grep_rejects_a_pattern_that_is_not_a_regex(ctx: ToolContext):
    with pytest.raises(ToolFailed) as caught:
        await fs.grep(ctx, pattern="([unclosed")
    assert caught.value.code == "bad_pattern"


async def test_grep_can_be_narrowed_by_glob(ctx: ToolContext):
    result = await fs.grep(ctx, pattern="line", glob="*.md")
    assert result.content == "[no matches]"
