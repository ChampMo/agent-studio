"""Getting the JSON object out of a reply that is mostly JSON.

Models in JSON mode wrap their answer in a markdown fence, or put a sentence in
front of it, often enough that treating either as a failure is a bug rather than
strictness. `profile_gen` has done this since M2 — "stripping that here costs one
regex; treating it as a failure costs a retry and the user's money" — and the
capability probe was doing its own strict `json.loads`.

That difference had a cost. A probe reply that did not parse was recorded as
`structured_output: none`, which says *this endpoint has no JSON mode* — about an
endpoint that had just accepted `response_format: json_object` without
complaint. Our own reading, written down as a fact about the model (§3.1).

One function, both callers, for the reason §2.1 gives everywhere else: two
readers of the same thing drift, and the one you are not looking at is the one
that is wrong.
"""

from __future__ import annotations

import re

_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)


def extract_json(text: str) -> str:
    """The JSON in a reply, without the fence or the throat-clearing.

    Falls back to the outermost `{...}` span, and to the text itself when there
    is no object at all — so the caller still gets the real parse error rather
    than one produced by this function.
    """
    fenced = _FENCE.search(text)
    if fenced:
        return fenced.group(1).strip()
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        return text[start : end + 1]
    return text.strip()
