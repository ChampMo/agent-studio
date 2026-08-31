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

**M1.2 — providers: done.** `LLMProvider` protocol, OpenAI-compatible (DeepSeek et al.)
and Anthropic adapters on their own SDKs, registry, 4-step capability probe, pricing
table. 35 pytest green, no network in any of them.

**M1.3 — runtime and routes: done.** `run_agent_turn` (yields, never publishes),
`MissionRunner`, provider/mission/tools REST, the event socket with `since_seq` resume,
`POST /missions/{id}/cancel`. 55 pytest green.

**M1.4 — frontend: done (pending a real key).** Vite + React + Tailwind v4, pure
decoder with the §8 forward-compat tests, resuming socket client, Zustand stores,
onboarding gate, chat with a stop button, raw timeline. 70 pytest + 13 vitest green;
`npm run dev` brings up both processes and the onboarding screen renders.

Next: enter a provider key in the running app to finish M1's manual criteria, then M1.5
(Tauri shell + the secret-hygiene test).

### A capability probe must have three outcomes, not two

The structured-output check ran with `max_tokens=128`. DeepSeek spent 137 tokens
reasoning before its first visible character, so the reply was cut off at
`{"ok": true, "`, `json.loads` raised "Unterminated string", and the model was recorded
as `structured_output: "none"`. It was not: at a higher cap it answers
`{"ok": true, "note": "Ready"}` in 166 output tokens. Schema mode really is unavailable
there — a clean 400 — so the true value is `json_object`.

Three things came out of it, all of them structural rather than a number change:

- `PROBE_MAX_TOKENS = 2048`. A cap tight enough to cut off a reasoning model turns
  every probe into a false negative.
- A check is `pass | fail | inconclusive`. A truncated stream is evidence of nothing,
  and `ProbeResult.conclusive` names the capability fields a run actually established.
  `POST /providers/{id}/test` merges only those onto the stored profile, so our own bug
  can never be written down as a fact about a model.
- The probe used to discard `DoneChunk` (`text, _, _`), throwing away the
  `stop_reason: "length"` that explained the whole thing. It reads it now.

The same shape is waiting in M4: tool-call arguments are also assembled from streamed
fragments. `ToolCallChunk.truncated` marks a call whose arguments were cut off, the
runtime reports `tool_call_truncated` instead of executing it, and
`tests/test_truncation.py` forces a 4KB argument through a cut-off stream to keep that
honest.

### Cancellation was cancelling its own cleanup

`_run` caught `CancelledError` and then awaited `_finish`, which was itself cancelled
mid-write — a stopped mission could end with no `mission.ended` event and a row stuck at
status `running`. The `finally` block now only *schedules* finalisation as a separate
task (`_finalise`), so recording a cancellation cannot be cancelled by it. `wait()`
awaits both.

### CORS had to be added, and it is not the security boundary

The frontend runs on another port in dev and another scheme under Tauri, so the browser
blocked every REST call until `CORSMiddleware` landed. Worth being precise about what
that changed: nothing about who may call the backend. A non-browser client ignores CORS
entirely — the session token is what keeps callers out. CORS only decides whether a
*page* may read a response it managed to provoke, so the origin list is explicit rather
than `*`, and `tests/test_api_auth.py` pins that an allowed origin is still 401 without a
token.

### A zustand selector must not build a new object

`useEventStore(selectTurns)` built a fresh array on every call, so the store saw a new
snapshot each render and React hit "Maximum update depth exceeded" immediately. Derived
views now subscribe to the raw slices and `useMemo` on top. Anything that maps or
filters store state is the same trap.

### The WebSocket subscribes before it accepts

Found by a test that was checking something else. `accept()` is what unblocks the
client's connect call, so subscribing *after* it leaves a window where the client
believes it is listening and the bus has never heard of it.

Sequenced events survive that window — they are on disk, and the next reconnect
replays them. **Ephemeral deltas do not.** They are fire-and-forget, so they vanish, and
nothing downstream can tell they ever existed. The reproduction printed
`subscribers: {}` at the moment a delta was broadcast.

`api/ws.py` now registers with the bus first and accepts second. Anything published in
between waits in the queue and is delivered after the history replay, so ordering still
holds.

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
- **Never edit text files with PowerShell `Get-Content`/`Set-Content`.** On Windows
  PowerShell 5.1 it writes a UTF-8 **BOM** and corrupts every non-ASCII character on
  the way through: the file's UTF-8 bytes get decoded as the locale codepage (cp874
  here) and re-saved, so `§` became `ยง` and `—` became `โ€”`. Use the editor tooling,
  or Python with `open(..., encoding="utf-8", newline="\n")`. To reverse an instance:
  `ch.encode("utf-8").decode("cp874")` gives the corrupted form to search for.
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
