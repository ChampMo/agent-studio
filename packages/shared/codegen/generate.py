#!/usr/bin/env python
"""Generate Pydantic models from events.schema.json.

PROJECT_BRIEF.md §2.2: the schema is the ONE contract. Both sides are
generated from it; neither side is ever hand-written.

    python generate.py           write the file
    python generate.py --check   exit 1 if the file on disk is stale or edited
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SCHEMA = ROOT / "packages" / "shared" / "events.schema.json"
OUT = ROOT / "services" / "agentd" / "agentd" / "core" / "events_generated.py"

BANNER = '''"""GENERATED FILE - DO NOT EDIT.

Source:     packages/shared/events.schema.json
Regenerate: npm run codegen
Verify:     npm run codegen:check

Editing this file by hand breaks the single-contract rule in
PROJECT_BRIEF.md section 2.2, and codegen:check will fail in CI.
"""

'''


def render() -> str:
    """Run datamodel-codegen into a temp file and return the rendered source."""
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "events_generated.py"
        subprocess.run(
            [
                sys.executable,
                "-m",
                "datamodel_code_generator",
                "--input",
                str(SCHEMA),
                "--input-file-type",
                "jsonschema",
                "--output",
                str(target),
                "--output-model-type",
                "pydantic_v2.BaseModel",
                "--target-python-version",
                "3.13",
                "--use-annotated",
                "--use-union-operator",
                "--use-standard-collections",
                "--enum-field-as-literal",
                "all",
                "--collapse-root-models",
                "--use-title-as-name",
                "--disable-timestamp",
                # Pinned explicitly: the default formatter set is scheduled to
                # change, and a silent change would make codegen:check fail for
                # everyone at once with no schema edit to explain it.
                "--formatters",
                "black",
                "isort",
            ],
            check=True,
        )
        body = target.read_text(encoding="utf-8")

    # datamodel-codegen writes its own two-line header; replace it with ours.
    lines = body.splitlines(keepends=True)
    while lines and (lines[0].startswith("#") or not lines[0].strip()):
        lines.pop(0)
    return BANNER + "".join(lines)


def main() -> int:
    generated = render()
    if "--check" in sys.argv:
        if not OUT.exists():
            print(f"codegen:check FAILED - {OUT} does not exist. Run: npm run codegen")
            return 1
        if OUT.read_text(encoding="utf-8") != generated:
            print(
                "codegen:check FAILED - services/agentd/agentd/core/events_generated.py\n"
                "  is out of sync with packages/shared/events.schema.json.\n"
                "  Either the schema changed, or the generated file was hand-edited.\n"
                "  Fix: npm run codegen"
            )
            return 1
        print("codegen:check OK - Pydantic models match the schema.")
        return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(generated, encoding="utf-8")
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
