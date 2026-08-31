# CLAUDE.md — working notes

`PROJECT_BRIEF.md` is the spec and the single source of truth. **Read it first, always.**
This file is the running log: what was decided while building, what broke, and what the
next session needs to know. Update it at the end of every milestone (brief §14).

---

## Where things are

| What | Where |
|---|---|
| The event contract | `packages/shared/events.schema.json` |
| Generated TS types | `apps/desktop/src/transport/events.generated.ts` — **DO NOT EDIT** |
| Generated Pydantic | `services/agentd/agentd/core/events_generated.py` — **DO NOT EDIT** |
| Backend | `services/agentd/agentd/` (installed as the `agentd` package) |
| Frontend | `apps/desktop/src/` |

## Commands

```bash
npm install                  # JS deps (workspaces: apps/desktop, packages/shared)
uv sync --project services/agentd   # Python deps into services/agentd/.venv
npm run codegen              # regenerate TS + Pydantic from the schema
npm run codegen:check        # fail if either generated file is stale or hand-edited
npm run test                 # codegen:check + pytest + vitest
```

`uv` installs to `C:\Users\<you>\.local\bin` and may not be on PATH in a fresh shell.

---

## Status

**M1.0 — skeleton + contract: done.**
Schema authored, both generators wired, `codegen:check` verified to fail on a hand-edit
(brief §12 M1, proof #1).

**M1.1 — backend core: done.** Event bus, budget guard, async SQLite + Alembic, keychain
adapter, per-launch token, `python -m agentd`, `scripts/dev.mjs`. 18 pytest green.
Verified end to end: no token → 401, wrong token → 401, real token → 200, token absent
from argv, migration creates all three tables.

Next: M1.2 (provider adapters + capability probe) — see the M1 plan.

---

## Decisions made while building

Anything here that contradicts `PROJECT_BRIEF.md` means the brief was already updated to
match — the brief wins, this is just the reasoning trail.

### The envelope nests `draft` instead of flattening `type` + `payload`

Brief §6.1 originally specified a flat envelope. It does not survive codegen.

Written as `allOf: [EnvelopeMeta, DraftX]`, `datamodel-code-generator` emits
`type: Literal['EnvMissionStarted']` — the **class name**, not the schema's `const`
(`'mission.started'`). The discriminator breaks silently: the model would reject every
real event. Separately, `json-schema-to-typescript` refused to emit `EventDraft` at all
under that shape.

Nesting the draft makes the union reachable from the root, so both generators produce a
correct discriminated union, with the meta fields written once instead of fourteen times.
Brief §6.1 and decision row 26 record this.

The alternative — fourteen explicit envelope branches with the five meta fields copied
into each — keeps the flat wire shape but duplicates the meta block fourteen ways. If
that is ever revisited, it needs a schema self-consistency test to stop the copies
drifting.

### `--formatters black isort` is pinned in `generate.py`

`datamodel-code-generator` warns that its default formatter set will change. Unpinned,
that change would make `codegen:check` fail on every machine at once with no schema edit
to explain it. Decision row 27.

### `additionalProperties` is left open in the schema

Deliberate, per brief §8: a v(N) producer's extra fields must not break a v(N-1)
consumer. The TS generator is run with `additionalProperties: false` so the *types* stay
closed and pleasant to work with — runtime tolerance lives in the decoder, which is where
the forward-compat test points.

---

## Gotchas hit so far

- **`uv` was not installed** and is not on PATH by default after install.
- **`enable_load_extension` is available** on this machine's Python 3.13 — `sqlite-vec`
  will work when memory lands. Checked, not assumed.
- **Git Bash here starts with an empty PATH.** Prefix commands with
  `export PATH="/usr/bin:/bin:/usr/local/bin:$PATH"` or use PowerShell.
- **Never edit text files with PowerShell `Set-Content -Encoding utf8`.** On Windows
  PowerShell 5.1 it writes a UTF-8 **BOM** and mangles non-ASCII on the way through
  (`§` became `ยง` twice). Use the editor tooling, or Python with
  `open(..., encoding="utf-8", newline="\n")`.
- **`alembic.ini` must be pure ASCII with no BOM.** Alembic hands it to `configparser`,
  which opens it with the *locale* encoding — cp874 on this machine — so one non-ASCII
  character makes every migration die with a `UnicodeDecodeError`. Cost an hour once;
  there is a comment at the top of the file now.
- **Alembic's async `env.py` calls `asyncio.run()`**, which cannot nest inside a running
  loop. The pytest fixture migrates via `asyncio.to_thread(upgrade_to_head, url)`.
- **A `@dataclass` is unhashable by default** (`eq=True` sets `__hash__ = None`), so
  `Subscriber` needs `eq=False` to live in a set.

---

## Open items

- `deepseek-v4-flash` / `deepseek-v4-pro` and the retirement of `deepseek-chat` /
  `deepseek-reasoner` are **unverified** (brief §3.1). The test-connection flow resolves
  this empirically via `GET /v1/models`; no model id is hardcoded anywhere.
- Haiku 4.5 has two ids in circulation (`claude-haiku-4-5` vs
  `claude-haiku-4-5-20251001`). Same resolution: ask the endpoint, don't guess.
