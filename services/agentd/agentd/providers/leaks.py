"""Spotting a tool call the model wrote as prose instead of calling (§8, §1).

Seen on a real run. DeepSeek ended a round with this as its entire reply:

    <｜｜DSML｜｜tool_calls>
    <｜｜DSML｜｜invoke name="read_file">
    <｜｜DSML｜｜parameter name="file" string="true">index.html</｜｜DSML｜｜parameter>
    </｜｜DSML｜｜invoke>
    </｜｜DSML｜｜tool_calls>

That is the model's own tool-call template, emitted as **text** rather than as a
structured call. No tool ran. And because a round's summary is its last message,
that markup became the summary — so the mission's one-line record of what
happened was a broken template.

The event is still published: the model really did say it, and the log is the
record (§2.1). What changes is that it is *named* — an `error` says the call was
lost — and that it is never mistaken for the agent's answer.

Detection is deliberately narrow. It matches only text that is essentially
nothing but the markup, so a reply that happens to *discuss* tool calls, or
quotes one in a code block alongside real prose, is left alone. A false positive
here would hide something a person wrote.
"""

from __future__ import annotations

import re

#: The delimiters seen in the wild. `｜` is U+FF5C, the full-width vertical bar
#: these templates use; the ASCII form covers the other families that wrap tool
#: calls in pipes.
_MARKERS = (
    "｜tool_calls｜",
    "｜｜DSML｜｜",
    "<|tool_calls|>",
    "<|tool▁calls▁begin|>",
)

#: What is left once the markup is stripped out. If almost nothing remains, the
#: message was the template and not a sentence.
_TAG = re.compile(r"<[^<>]{0,200}?>")


def leaked_tool_call(text: str) -> bool:
    """Whether this reply is a tool-call template rather than something said."""
    if not text or not any(marker in text for marker in _MARKERS):
        return False
    # Everything outside the tags. A genuine paragraph that mentions the syntax
    # leaves plenty behind; a bare template leaves almost none.
    remainder = _TAG.sub(" ", text)
    for marker in _MARKERS:
        remainder = remainder.replace(marker, " ")
    return len(remainder.split()) <= 8


#: Phrases endpoints use when they will not take a picture. Matched loosely and
#: case-insensitively, because every provider words it differently and none of
#: them promises the wording will not change.
_NO_VISION = (
    "does not support image",
    "does not support images",
    "image input is not supported",
    "unsupported content type: image",
    "vision is not supported",
    "no support for image",
)


def refused_images(message: str) -> bool:
    """Whether a provider error says this model will not accept images.

    Used to write down a fact we have just learned — the model has no vision —
    so the next attempt can say so *before* spending a round finding out. Same
    rule as the capability probe: only record what an endpoint actually
    established, never what we assumed (§3.1).
    """
    lowered = (message or "").lower()
    return any(phrase in lowered for phrase in _NO_VISION)
