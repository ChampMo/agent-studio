"""The user's own terminal (§2.7).

The part worth testing here is not "does a shell run" — `test_dangerous_tools`
covers the runner, and both now share it. It is the marker protocol that makes
`cd` persist across one-shot commands, because that is the only piece invented
for this endpoint and the only one that can silently do nothing.

It nearly did. The first version printed `$PWD`, which Git Bash reports in MSYS
form (`/c/Users/...`). Python cannot pass that back as a working directory, so
the next command fell back to the workspace and `cd` appeared to be ignored —
with no error anywhere, because every individual step had worked.
"""

from __future__ import annotations

from agentd.api.terminal import CWD_MARK, _split_cwd


def test_the_marker_is_taken_off_the_output():
    out, cwd = _split_cwd(f"hello{CWD_MARK}C:/work", "C:/fallback")
    assert out == "hello"
    assert cwd == "C:/work"


def test_a_trailing_newline_before_the_marker_goes_too():
    # The shell prints "\n" + marker so it starts on its own line; that newline
    # is punctuation for the marker, not part of what the command said.
    out, _ = _split_cwd(f"line one\nline two\n{CWD_MARK}C:/work", "C:/fallback")
    assert out == "line one\nline two"


def test_output_with_no_marker_keeps_the_directory_it_had():
    """The marker can genuinely be missing — the output was clipped at 30k, or
    the command replaced the shell with `exec`. Staying put is a better answer
    than guessing, and much better than reporting an empty path."""
    out, cwd = _split_cwd("no marker here", "C:/fallback")
    assert out == "no marker here"
    assert cwd == "C:/fallback"


def test_the_last_marker_wins():
    # A command that echoes the marker itself must not be able to move the
    # shell somewhere else; the real one is always last.
    _, cwd = _split_cwd(
        f"{CWD_MARK}C:/spoofed\nreal output\n{CWD_MARK}C:/actual", "C:/fallback"
    )
    assert cwd == "C:/actual"


def test_an_empty_path_falls_back_rather_than_reporting_nothing():
    _, cwd = _split_cwd(f"out{CWD_MARK}   ", "C:/fallback")
    assert cwd == "C:/fallback"


def test_the_wrapper_asks_for_a_path_python_can_use():
    """`pwd -W` before plain `pwd`.

    Asserted on the source because the alternative is a live Git Bash, and the
    failure this guards against is silent: the wrong flag order gives an MSYS
    path, `Path(...).is_dir()` says no, and the endpoint quietly resets to the
    workspace on every command.
    """
    from pathlib import Path as _Path

    import agentd.api.terminal as terminal

    source = _Path(terminal.__file__).read_text(encoding="utf-8")
    assert "pwd -W 2>/dev/null || pwd" in source
