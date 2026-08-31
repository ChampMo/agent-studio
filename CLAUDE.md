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

**M1 — complete.** All thirteen criteria verified, the last one (the Tauri window showing
the same UI) confirmed by screenshot: chat streams, usage reads `84 in · 23 out`, probe
shows 4/4 with `structured: json_object`.

**M2 — agents: done.** `agents` table, CRUD with soft delete and duplicate, the closed
avatar catalogue, and `profile_gen` with validate-and-retry. Roster cards, the creator
flow and the avatar picker verified in the app, and profile generation confirmed against
the real endpoint.

**M3 — teams: done.** `teams` / `team_members`, one validator, the builder, and
export/import. 178 pytest green. Verified live: three teams at once sharing one agent,
a leaderless team saved anyway but marked `canRun: false`, an export with no
`provider_id` and nothing key-shaped, and an import producing entirely fresh ids.

**M4 — orchestration: backend done, live run pending.** LangGraph plan → work →
summarise, the roster snapshot in use, the validator as the launch gate, budget across
the whole team, and the Mission tab. 190 pytest + 16 vitest green. Not yet run against
the real endpoint with three agents.

**Gamification rolled back (brief §1.1, decision row 28).** `level` and `exp` are gone —
migration `0004_drop_exp` removes the column, and a test asserts the wire form carries no
invented score. Kept: `total_missions` (counted from runs that finished), usage and cost
(real money), `avatar_config`, character cards, the dark theme.

The criterion for every UI decision from here: **everything shown must be true about that
agent.** The game feel belongs in the presentation — portrait, card, appearance choices,
backstory, and the 2.5D scene in M5 reflecting real event-stream state — never in numbers
we made up. An invented score makes the UI lie, which §1 already forbids. Do not propose
level, exp, MP or HP back in.

---

## Decisions made while building

### The snapshot is what makes a replay honest

`missions.roster_snapshot` was created in migration 0001 and left unused until M4. It
holds the *effective* config — agent merged with `team_members.overrides` — resolved once
at launch by `teams/snapshot.py`, which is the only code that reads `agents` or
`team_members` for a mission.

Past that boundary nothing reads those tables again: not the orchestrator, not the
runner's provider lookup, not the timeline's agent names. A test renames an agent,
changes its model, swaps its avatar and archives a teammate after a run, then asserts the
replay still shows `One`, `m1`, `blazer` and seat 2. Without the snapshot every one of
those would have been rewritten retroactively, and the mission record would describe work
that never happened that way.

### The orchestrator yields; it does not publish

`run_team_mission` is an async generator like `run_agent_turn`, so `MissionRunner` routes
a team mission through the identical code path as a chat and the whole orchestrator is
testable with no bus, no database and no network. LangGraph nodes cannot yield, so they
push onto a queue the generator drains; closing the generator cancels the graph rather
than leaving a detached task spending money.

### The launch gate is the validator, not a second opinion

`start_mission` calls `validate()` and refuses on any `error`, returning **every**
blocking finding as a 409. One rejection at a time turns fixing a team into a guessing
game, and a separate list of launch preconditions is exactly the drift decision row 13
warns about.

### `total_missions` is credited only on `completed`

A cancelled or crashed run is not a mission the agent completed. Counting it would make
the one number on the card that is supposed to be a fact into something slightly untrue,
which is the whole reason it survived the gamification rollback.

### The leader rule needs both halves, in different places

SQL can express *at most one* leader — a partial unique index on `team_members(team_id)
WHERE role_in_team = 'leader'` — and cannot express *at least one*. So the second half is
in the validator, and both have their own test: the index raises `IntegrityError` on a
second leader, the validator reports `no_leader` on none. Either alone looks like the
rule is enforced and is not.

### One validator, or the two lists drift

`validate()` returns findings; `can_run()` is defined as "no error among them" and is the
only run gate. Decision row 13 is about which pair drifts when there are two: it is
always "what the builder warned about" versus "what the launcher refuses", and the user
finds out by saving a team the UI called fine and being rejected at launch for a
different reason. The frontend does not re-derive `canRun` either — it renders what the
backend sent.

Save accepts a team with errors on purpose. A half-built team is the normal state while
building one, and refusing the save throws the work away.

### A warning that always fires is not a warning

`tool_uncovered` only appears when the tool registry is non-empty. Until M4 there are no
tools, so "nobody covers web_search" would fire on every team forever and teach people
to skim past the whole findings list.

### The avatar catalogue is closed, and that is the point

§11 says an avatar is chosen from assets that exist. `agents/avatar.py` is the single
list: the prompt shows it to the model, `GeneratedProfile` rejects anything outside it,
`AgentService` re-checks on create *and* on edit — because the generator is not the only
door into the table — and the picker fetches the same list rather than keeping a copy. A
model that invents `hair: "silver_mane"` gets a correction naming the legal values; a
picker with its own hardcoded list would drift and only fail in M5 when a sprite did not
load.

### What the model is not allowed to decide

`GeneratedProfile` omits `provider_id`, `model`, `tools` and `total_missions`, and a
test asserts it. The model has no idea which endpoints this machine has configured, the
tool registry is still empty so any tool it named would be fiction, and `total_missions`
is recorded from what actually happened rather than claimed.

### M1.5 — Tauri shell + secret hygiene

`src-tauri/` builds the window in `setup()` rather than declaring it in the config, because the handshake has to go in as
an `initialization_script` — it must run before any page script, and `eval` after load
would be a race the frontend would have to code around.

Verified live in the app: chat streams token by token, the stop button ends a run with
`reason: "cancelled"` and closes the upstream HTTPS connection, and every mission in the
database has exactly one `mission.ended` matching its `end_reason`.

### An unknown value is not the only thing the scene has to survive

A cancelled run ends with the agent's last status still `thinking` — the runtime is
closed before it can yield `idle`. The record is correct: the agent really was thinking
when the user stopped it. So `scene/bindings` must treat `mission.ended` as the terminal
reset signal rather than waiting for a final `agent.status`, or a replayed cancellation
leaves a sprite stuck mid-thought forever.

Deliberately not fixed by emitting a synthetic `agent.status idle` on cancel: that would
be the runner inventing an event no agent produced, and §1 rules that out.

### A test that walks routes has to descend into included routers

`test_secret_hygiene.py` asserts no endpoint can return a key. FastAPI 0.141 does not
flatten `include_router` into `app.routes` — each becomes a `_IncludedRouter` keeping its
real routes on `original_router` — so the first version inspected `/health` alone and
passed while checking nothing. It was the *positive* assertions ("the PUT door exists",
"`GET /providers` was reached") that caught it. Any test that scans a collection needs
one.

### Redaction matched substrings and ate the token counts

`inputTokens` contains "token". The secret-key regex was a substring match, so the
bus wrote `{"inputTokens": "[redacted]", "outputTokens": "[redacted]"}` into the table
— destroying the exact numbers the cost display is built on (§6.2), in a table
that cannot be corrected. One row in the local database still carries it.

`is_secret_key()` now splits camelCase and snake_case and matches whole words, with two
deliberate asymmetries, both documented in the code: plural `tokens` is a count and is
never secret (while plural `credentials` is), and any key containing a counting word
(`count`, `used`, `limit`, `total`, `remaining`, …) is a measurement regardless. Over-
redaction is the more expensive direction of error here, because it is irreversible.

Invisible until a real message went through the UI: no test sent `usage` through the
bus, and `tests/test_events.py` only ever checked that secrets *were* removed.

### SQLite has no timezone, so replay disagreed with live

`DateTime(timezone=True)` writes a naive string on SQLite and reads one back. Live
events carried `+00:00`; replayed ones carried no offset, so the browser read them as
local time. The same seven events showed up split across a seven-hour gap in the
timeline depending on which path delivered them — exactly the failure §1 rules out.

`_wire()` labels a naive timestamp as UTC, which is what the bus wrote.

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
