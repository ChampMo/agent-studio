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
npm run test                 # codegen:check + pytest + vitest + cargo
npm run build:sidecar        # freeze the backend into src-tauri/binaries/
npm run package              # build:sidecar + a signed tauri build -> MSI + NSIS
npm run release:manifest     # write dist/latest.json from what the build produced
```

`npm run package` needs no running copy of the app: Windows locks the image of a running
process, and the build refuses rather than shipping the previous backend.

`uv` installs to `C:\Users\<you>\.local\bin` and may not be on PATH in a fresh shell.

## Cutting a release

The app updates itself, so a release is a **signed** build plus one extra asset.

1. Bump `version` in `src-tauri/tauri.conf.json`. That number is what an installed
   copy compares against; nothing else decides whether an update is offered.
2. `npm run package` — signs every bundle and writes a `.sig` beside each one.
3. `npm run release:manifest -- --notes-file <your notes>` — copies the
   bundles into `dist/` under their release names and writes
   `dist/latest.json`, reading each `.sig` off disk.
4. **Run a mission in the built app and watch it reach `ended`.** Not a
   screenshot: four releases were verified on still frames — a room drawn, a
   boot screen caught, a console with no errors — while no installed build
   could finish a run at all. `scratchpad/csptest/realrun.mjs` is the shape:
   launch with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`,
   start a mission through the app's own handshake, and poll until the row
   says `ended` with no `internal_error` on the log.
5. Publish the tag with everything in `dist/`:

```bash
gh release create v0.2.0 dist/* --notes-file NOTES.md
```

One command decides both the name in the manifest and the name of the uploaded
file, so the url in `latest.json` cannot point at a 404.

The endpoint is `releases/latest/download/latest.json`, so the asset has to be on
whichever release GitHub calls latest. A draft or a pre-release is not it.

**The signing key is at `~/.agent-studio/updater.key` and is not in this repo.**
Every installed copy verifies against the public half compiled into it, so losing the
private half means everyone reinstalls by hand. `*.key` is gitignored; the key lives
outside the tree anyway, so there is no path by which `git add -A` can publish it.

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

**M4 — orchestration: done, verified live.** LangGraph plan → work → summarise, the
roster snapshot in use, the validator as the launch gate, budget across the whole team,
and the Mission tab. 194 pytest + 16 vitest green.

A real three-agent run against DeepSeek: all three produced work, two tasks distributed
to seats 1 and 2, completed in 58s for 1,071 in / 6,164 out tokens. Then the agents were
renamed, re-modelled, re-avatared and one archived, and the replay still showed
`Source Scout` / `deepseek-v4-flash` / `blazer` / seat 2.

### Three things only a live run found

**The leader kept all the work.** The first run produced one task assigned to seat 0;
the other two agents never ran. Two causes, both ours. The plan had been truncated and
the correction said *"return fewer, shorter tasks"* — so the model returned exactly one.
And nothing stopped the leader assigning to itself. `_assignable()` now excludes the
leader whenever the team has workers (a solo team still assigns to itself), and the
truncation correction says *keep every task, write each instruction more briefly*.

**Generation took three attempts, every time.** DeepSeek is `json_object` only, so the
schema is never sent — the model sees the system prompt and nothing else, and that prompt
described only `avatar_config`. It was guessing the field names. The prompt now lists
every key with its type, including that `personality_traits` is an array.

**`MAX_TOKENS_PER_TASK = 4096` was too small.** A worker spent it all on reasoning and
emitted an empty answer; the next teammate correctly replied that there was nothing to
check. Raised to 8192 — and a task that produces nothing is now reported `failed`, not
`done`. The progress line saying `done 1/2` for a turn that emitted nothing was the only
untrue thing in that record.

### A mission cancelled before its task starts

A task cancelled before its body ever ran executes no `finally`, so it scheduled no
finaliser and the row would sit at `running` for ever with no `mission.ended`. Found by a
flake that cancelled a fraction too early. `_track()` now guarantees the terminal event
from the done-callback, and the test waits on an event the provider sets rather than on a
fixed number of loop turns — a race dressed as a delay.

**M5 — the scene: done.** Isometric 2.5D room, characters at their seats, poses driven
by `agent.status`, the current task labelled under whoever is on it. 196 pytest + 30
vitest + 2 cargo green. Verified live: work moved from Source Scout to Clara and the
scene followed, with the task label moving with it.

### The scene is a pure derivation plus a dumb renderer

`scene/bindings/sceneState.ts` turns events + the frozen roster into what to draw, and
knows nothing about PixiJS. `scene/engine` draws what it is given and decides nothing.
That split is what makes the M5 criterion — an unrecognised status falls back to the
default pose without crashing — a test rather than something checked by squinting at a
canvas. Fourteen tests cover unknown statuses, unknown avatar assets, unknown layouts,
and a layout that gained seats.

Characters are drawn from primitives, not sprites: no art exists yet, and every shape is
driven by real data — `avatar_config` from the closed catalogue, a pose from the stream.
Swapping in artwork later replaces `ActorView.redraw`, not the data path. Nothing on
screen is untrue: a name, the pose in words, and the task they are on. No bars, no
numbers (§1.1).

Seat *positions* live in `scene/engine/iso.ts` while the seat *count* stays on the
backend. Each side owns the number it needs: the validator rejects a member in a seat
that does not exist, and arranging desks is a rendering decision that would otherwise be
frozen into a migration.

### A mission whose process dies is not still running

The dev launcher restarted the backend mid-run — a `.pyc` write tripped the watcher — and
the mission row sat at `running` for ever, because a dead process cannot write its own
terminal event. `reap_orphans()` now runs at startup and closes them as `crashed`. A row
claiming to be running when nothing is driving it is the timeline lying about the
present rather than the past.

The watcher now ignores `__pycache__` and names the file that triggered a restart, so a
restart nobody asked for is traceable instead of looking like the backend falling over.

### A stable selector does not re-render

`useMissionStore((s) => s.nameOf)` selects a function whose identity never changes, so
the timeline kept printing raw agent ids until something else happened to re-render it.
It subscribes to `roster` as well now. Any selector that returns a resolver rather than
data has this shape.

**Gamification rolled back (brief §1.1, decision row 28).** `level` and `exp` are gone —
migration `0004_drop_exp` removes the column, and a test asserts the wire form carries no
invented score. Kept: `total_missions` (counted from runs that finished), usage and cost
(real money), `avatar_config`, character cards, the dark theme.

The criterion for every UI decision from here: **everything shown must be true about that
agent.** The game feel belongs in the presentation — portrait, card, appearance choices,
backstory, and the 2.5D scene in M5 reflecting real event-stream state — never in numbers
we made up. An invented score makes the UI lie, which §1 already forbids. Do not propose
level, exp, MP or HP back in.

**M6 — approval, artifacts, replay: done, verified live.** `interrupt()` against an
`AsyncSqliteSaver`, `agent.request` / `agent.request.resolved` on the log, the artifact
store, `GET /requests/pending`, the mission list and `GET /missions/{id}/events`. Backend
206 pytest; frontend adds the approval modal, the History tab with replay, and the
artifact viewer. 41 vitest green.

The milestone's criterion, done for real rather than simulated: a mission was launched
with the gate on, the whole app was killed at the pause — both processes — and after a
fresh start the question was on screen again before any tab was opened. Approving it
resumed the work, which finished and wrote `final-answer.md`. Opening the run from
History replayed it with the roster frozen at launch and the file readable.

### `return` does not skip `finally`

`_run_team` handled `Paused` by parking the mission and returning. The `finally` block
below it scheduled the finaliser anyway — with `reason` still holding its initial
`"completed"` — so a mission ended, with a summary, seconds after asking its question.
The pause itself had worked perfectly; the row said `ended` because of a `return`.

A `parked` flag now suppresses the ending explicitly. Anything that means "this is not an
ending" has to say so in the `finally`, not by leaving the block.

### Resuming rebuilt the graph without the gate

`resolve_request` called `_run_team(..., resume=answer)` and left `require_approval` at
its default, so `approve_node` returned before it read anything. The graph continued
either way: approval passed by accident, and **a rejected plan ran to completion**. Only
the reject test caught it — the approve test was green for the wrong reason the whole
time.

`require_approval = require_approval or resume is not None`: the gate is the only thing
that pauses a mission, so a resume implies it was there.

### Everything above `interrupt()` runs twice

LangGraph re-executes the interrupted node from the top on resume — the node's writes
were never committed, so there is nothing to pick up from mid-body. `approve_node`
published its question again, with a **fresh request id nothing was waiting on**: a live
client would raise a modal whose answer comes back 409, and a replay would show the
leader asking twice and being answered once. Found by reading the log of a real run
(seq 8 asked, seq 10 answered, seq 11 asked again).

The node takes `resuming` and skips the emits. Worth remembering for any future gate:
side effects belong *after* the `interrupt()`, and an LLM call above one is paid for
twice. `plan_node` is safe only because its writes were checkpointed before the gate ran.

### The client has to ask what is waiting, not only listen

The question is published as an event, and the process that published it is gone by the
time anyone reopens the app. `approvalStore` therefore has two sources: `refresh()` over
REST on mount, and `observe()` off the stream while the app is open. Neither alone works
— listening misses everything asked before this window existed, and polling alone makes
a live question wait for the next poll.

Replayed events are deliberately excluded from `observe()`. A mission cancelled while
waiting leaves an unanswered `agent.request` on its log forever; treating that like a
live one would put a dead run's modal in front of someone who is only reading, and
answering it returns 409 from a backend that agrees the question is gone.

### A replay is the same pipeline, not a second renderer

`eventStore.replay()` fetches `/missions/{id}/events` and pushes each row through the
same `decodeFrame` and the same `ingest` the socket feeds. The timeline and the scene
cannot disagree with a live run because there is only one derivation (§2.1) — and the
test asserts exactly that: `deriveSceneState` over replayed events equals the same
function over the live ones.

**M7 — polish and packaging: done, verified live.** Characters walk, speak, and
are followed by a camera; the app builds into an installer with the backend
frozen inside it. 209 pytest + 63 vitest + 4 cargo green.

Verified by running the packaged build, not the dev one: `agent-studio.exe`
started its own backend on an ephemeral port, the window came up on onboarding
against a fresh `%APPDATA%/AgentStudio` database, `/health` answered 401 without
the token it had never been told, and closing the window left no process behind.
`npm run package` produces `Agent Studio_0.1.0_x64_en-US.msi` (35 MB) and an
NSIS installer beside it.

### Walking is a position that changed, not an animation

The temptation in a milestone called "polish" is decoration, which §1.1 rules
out. So movement is derived like everything else: an actor's `place` is `seat`
or `floor`, and `floor` means the mission currently turns on them — the agent an
outstanding question is waiting on, or the one whose task is running. The
renderer's only job is to close the distance between where a character is and
where the derivation put them. Nothing walks anywhere for a reason that is not
on the log, and `movement.test.ts` asserts each rule, including that a question
outranks a running task and that `mission.ended` sits everyone down.

Speech bubbles are the same discipline: the agent's own words, shortened at
`BUBBLE_LIMIT` and never paraphrased, and only for whoever spoke last.

### A pose can outlive the fact that produced it

The leader publishes `agent.status waiting` when it asks for approval and
publishes nothing when the answer arrives — so it stood at the front of the room
captioned `waiting` for the rest of the run, describing a question that had been
answered minutes earlier.

Fixed in the derivation, not by emitting a status no agent produced: an
`agent.request.resolved` clears the asker's pose, and any real status published
afterwards still wins. That is the same shape as the `mission.ended` reset, and
the opposite of the synthetic `agent.status idle` on cancel that was rejected in
M5 — here the log itself says the wait is over.

### The scene only drew when something changed

Mounting PixiJS is async, so `scene.current` is set after the first state
exists. Every draw was triggered by a state change, and a mission that was
paused, finished or simply quiet produced none — so the room stayed black until
something happened. Live for two milestones, invisible because a running mission
never stops changing. The renderer now draws once as soon as it exists.

### Sound has to know what "just happened" means

A chime per event is trivial and wrong: the socket resumes from seq 0 on every
reconnect and History replays whole finished missions, so the naive version
fires thirty chimes for a run from last week. `shouldChime` is pure and takes
`now`: it refuses anything while replaying, anything older than five seconds,
and anything whose timestamp this build cannot read. Sound is off until asked
for, and the click that turns it on is also the gesture browsers require before
an `AudioContext` may start.

### What PyInstaller cannot see

Three kinds of thing, all found by running the result rather than by reading
about it. **Data loaded by path**: Alembic opens `alembic.ini`, `env.py` and
every revision off disk, so they are bundled as data and `migrate.py` resolves
them under `_MEIPASS` when frozen. **Backends chosen at runtime**: `keyring`
finds its backend through entry points and SQLAlchemy imports `aiosqlite` by
name — neither appears in an import statement. **Package metadata**, read by
libraries reporting their own version.

The entry script also cannot be `agentd/__main__.py`: PyInstaller runs it as a
top-level `__main__`, where its relative imports have no parent package and the
build dies on the first line it executes. `sidecar.py` imports the package
properly, which keeps `python -m agentd` and the frozen binary on one code path
with no `if frozen` branches inside the app.

### The backend must not outlive the app

`RunEvent::Exit` kills the process Tauri spawned — which, in a one-file
PyInstaller build, is a bootloader, not the server. The server carried on
listening, holding the database and the user's keychain access, with nothing on
screen to say so. Three of them were running before I noticed, and the way I
noticed was a build failing with `EBUSY`: Windows locks the image of a running
process, so the stale binary could not be overwritten and an installer would
have silently shipped yesterday's backend.

The fix is in the backend, not the shell: a watchdog thread reads stdin and
shuts the server down at EOF. The parent holds the write end, so this survives a
forced kill — which matters most on Windows, where a terminated process runs no
handler of its own. `scripts/build-sidecar.mjs` now also names the lock instead
of printing an `EBUSY` stack trace.

That makes an open pipe part of the contract, and `scripts/dev.mjs` was breaking
it: it called `child.stdin.end()` immediately after writing the token, so the
backend read EOF and stopped itself before the first request. It survived by
accident when launched from an interactive shell and died when launched without
one, which is exactly the shape of bug that gets blamed on the harness. **A
parent must hold the pipe open for as long as it wants the backend alive** —
Tauri does, and dev.mjs does now. The reward is that dev gets the same
guarantee: kill the launcher however you like, and the backend goes with it.

### Two things that looked like bugs and were not

A probe of the frozen backend returned 401 for the token it had just handed
over. The freeze was fine: the probe used a **fixed port**, and a leftover
backend from the previous run answered it with its own token. A fixed port in a
test harness is a shared global.

Then it returned `fetch failed`. The ready line is printed *before* uvicorn
binds — deliberately, since the parent needs the port before the socket exists —
so waiting for the message is not waiting for the server. The probe polls the
socket now.


**M8 — tools: done, verified live.** Thirteen tools, a workspace bound to the
mission, and an approval gate reusing M6 whole. Two search engines (Tavily,
Brave) plus DeepSeek's provider-side search, kept a separate kind on purpose.
326 pytest + 67 vitest + 4 cargo green.

Verified with a real run against DeepSeek: a three-agent team read a workspace
through `list_dir`, `grep` and `read_file` — sixteen tool calls — and answered
correctly, naming the file and line. A second run asked for `bash` under
`ask_dangerous`, showed the command in the modal, ran it when approved, and when
one attempt was rejected the agent said so and went back to the read-only tools
instead of asking again.

### The workspace is the boundary, so it comes first

`missions.workspace_root`, not the team's and not the agent's (§15 row 29): one
team has to be usable on several projects. It is frozen into the roster snapshot
and published on `mission.started`, so a replay can say where the work happened
rather than where this build would put it today.

`tools/paths.py` is the only resolver, and the rule it enforces is **resolve
first, compare second**. The tests build a real `..`, a real symlink, a real
Windows junction (`mklink /J`, which needs no privileges and is not a symlink),
a real 8.3 short name, and a drive-relative path, and check each is refused. The
last two are the ones that would have been missed by reading about the problem
instead of trying it.

### Approval could not use `interrupt()`

M6's gate is a LangGraph interrupt, and CLAUDE.md already records what that
costs: the node re-runs from the top on resume. For a tool call the node has
already paid for an LLM turn, so pausing there would buy it twice and publish
its events twice.

So a tool approval yields the same `agent.request`, is answered through the same
endpoint, and appears in the same modal — but the waiting is a future the runner
holds, not a checkpoint. The honest consequence is written into §16.4 and was
then seen live: the backend restarted mid-question, the mission was reaped as
`crashed`, and the tool never ran. That is the safe direction to fail in, and it
is now the documented behaviour rather than a surprise.

### Redaction has to happen where the spec is known

`write_file.content` would otherwise be copied whole into `mission_events`,
which is append-only forever (§9.3). The registry declares `redact_fields`, and
the runtime replaces the field with its byte count before the event is built —
so the timeline says *wrote 1,700 bytes to src/main.py*, which is what a
timeline is for, and the file itself is not in the database.

### A shell that exists is not a shell that runs

`bash` on Windows PATH is usually `System32ash.exe`, WSL's launcher, and on a
machine with no distribution installed it fails every command with
`CreateProcessEntryCommon`. The agent discovered this three approvals in a row,
and each failure read like the model's fault.

`find_shell()` now tries Git for Windows first and *runs* each candidate before
choosing it. Same rule as `web_search` with no key: a tool that cannot work is
not offered (§15 row 32).

### Two smaller things the live run found

**A nested `<form>`.** The workspace picker was rendered inside the launch form.
HTML has no nested forms — the parser drops the inner tag — so its buttons
submitted the outer one and the page reloaded. Everything inside a form that is
not the submit needs `type="button"`.

**A question can outlive its mission.** `pending_requests()` was widened to
include a live tool approval, which meant a crashed mission left a modal nobody
could answer — the backend would 409 it. `_finish` clears `pending_request` with
the ending.

### Two search engines, and one that is not a tool at all

Brave sits beside Tavily under `kind = "search"`, and which adapter runs is
decided by the base URL's host — a profile cannot hold a URL and a separate
"type" that disagrees with it. The difference between them reaches the model
rather than being smoothed over: Tavily returns extracted page text, Brave
returns a search engine's summary, and a Brave result says so and tells the
agent to `web_fetch` before quoting. Answering from a snippet as though it were
the page is how a confident wrong quote happens.

Several search keys can be configured at once, tried in the order they were
added, and a key that is rate limited, out of credit or simply refused moves to
the next one. That is the reason to have two: a free allowance is a monthly
number and a query a second. What it is not is silent — every skipped endpoint's
reason travels with the result the model sees and appears in the tool summary as
`fell back past 1`, because two runs that used different engines must not look
identical (§1).

**DeepSeek's own search is a different thing wearing the same word.** It works —
confirmed by reading the docs for the base URL and then sending Anthropic's
server-tool spec to `https://api.deepseek.com/anthropic` and reading the reply:
`server_tool_use` and `web_search_tool_result` blocks came back with the search
already done. What came back with them settles how it has to be presented: the
results carry `encrypted_content`. We cannot read what the agent read.

So it is not in the tool registry, the approval gate cannot stop it, and
`redact_fields` never sees its input. `agent.tool.start` and `agent.tool.end`
gained `origin`, the events for it are **synthesised from the provider's report
rather than observed**, the timeline says "its endpoint ran web_search itself",
and the `agent.tool.end` summary says the contents are not visible to this app.
The switch is off by default, is only offered on an endpoint known to answer to
it, and the UI states all three limits where it is turned on. §16.8 is the
section for this and for every other known gap, including the tool approval that
does not survive a restart.

### A `Literal` and a CHECK constraint are two places

`kind = "search"` was added to the request model, the profile serialiser, the
tool registry and the UI — and not to the CHECK constraint written in migration
0001. So **saving a search endpoint failed every time and had never once
worked**, from the moment the feature was written until someone tried to use it.

Nothing inserted one. The adapters are tested against recorded responses,
`_has_search_provider` only reads, and no test created a profile through the
API. `test_settings_api.py` does now, and it is the test that would have caught
this the day it was written.

Two things made it much harder to find than it should have been, and both are
now fixed:

**An unhandled 500 loses its CORS headers.** Starlette's error middleware sits
*outside* `CORSMiddleware`, so a crash is answered without
`Access-Control-Allow-Origin` — and the browser reports a CORS policy
violation, which points at the one thing that is not wrong. A catcher added
before the CORS middleware (making it the inner of the two) now turns a crash
into a JSON 500 that a page can actually read. Two rounds of debugging went
into "CORS is misconfigured" and "the port is stale" before the real error was
visible.

**A PATCH treated an absent field as null.** `if body.base_url != profile.base_url`
cannot tell "the caller did not send this" from "the caller sent null", so
renaming a provider erased its base URL and broke it. `model_fields_set` is the
distinction; null is still a real value, because an Anthropic profile has none.

### What is honest about the sandbox

There is not one. §2.7 now says so: file tools are workspace-scoped by a path
resolver, and `bash` starts in the workspace and can leave it. The only thing in
front of it is the approval question, which `trusted` removes — and the UI says
exactly that where the setting is, in those words.

Prompt injection is handled in three layers, and only the last two survive the
first failing: fetched text is wrapped in untrusted-content markers and the
agent is told what those mean; the validator warns when one agent holds both a
web tool and a way to change things, and suggests splitting the roles; and
`web_fetch` refuses every private address, re-checking each redirect hop,
because the backend on loopback holds the user's keys.


**Released: v0.2.5** (2026-09-24). v0.2.0 was the first build that could update
itself and the first that drew no room; it is marked superseded on its own
release page rather than left to be downloaded.

**M10 — the new shell: in progress.** Three columns, past runs down the left,
the run in front of you in the middle, what needs you on the right. 112 vitest +
354 pytest green.

### A run is named before it is asked anything

`missions.goal` used to do two jobs: the instruction the team was given, and the
name every list showed. That works while a run *is* one instruction and stops
the moment the run is a conversation — the first thing typed is a paragraph, and
the history list was showing paragraphs as titles.

Migration 0010 adds `missions.title`. The setup form now collects a name and
creates nothing; the run exists in the window as a `draft` until the first
message, and that message is what calls `POST /missions`. A draft costs nothing
and leaves no row, which is the point: naming a piece of work and deciding what
to ask are two different thoughts, and the old form made you have both at once.

`title` is nullable and is **not** backfilled. Every run recorded before 0010
falls back to its goal, because the goal is what it was called at the time —
writing a title into those rows would be putting something in the record that
was never true of it (§5.1).

### A chat view is a shape, not a filter

The timeline reads as a conversation now: bubbles for words, the agent left with
their portrait, the person right. The rule that made it safe to do is written
into `transcript.ts` and tested — **every event in produces exactly one row
out**, including types this build has never heard of (§8) and frames it could
not read at all. A chat that quietly drops the events that do not look like
speech is no longer the thing that lets you check what happened.

So there are three row shapes rather than one. `said` is a bubble. `did` is a
quiet line for tool calls and statuses, because "Source Scout calls grep" is not
something Source Scout *said* and a chat that dresses actions as dialogue is
inventing dialogue. `note` is centred and belongs to nobody: the run starting,
ending, a question waiting.

Portraits come from `avatar_config` through the same `lookFor` table the scene
uses, so the character in the room and the character in the transcript cannot
become two different people. It is a silhouette, not a likeness — that is all
the data says, and drawing more would be inventing a face (§1.1).

### The scene is not a tab

`Scene | Timeline | Files` made the room and the log mutually exclusive, and they
answer two different questions about the same moment: who is doing what, and
what exactly happened. M9.1's `SplitPane` came back to hold both — scene above,
record below, and the trade between them is the person's to make with a divider
that works from the keyboard (WCAG 2.1.1) and has a 24px hit area (2.5.8).

`Replayed from the log` moved out of the scene and into the chip row while doing
this. It had been a banner over the canvas, so dragging the scene shut hid the
fact that you were reading a record rather than watching a live run.

### The OS locale was writing Thai into an English app

`toLocaleDateString()` with no locale follows the operating system. On this
machine that is Thai *and* the Buddhist calendar, so a run from November 2025
grouped under `4 พ.ย. 2568` in an interface that is otherwise entirely English
(§13). Caught by a grouping test asserting the year "2025" against a string that
said 2568 — never by looking, because it looks deliberate.

`lib/format.ts` pins the locale, and every date, time and "last tested" stamp
goes through it. When this app is translated that is the one place that has to
learn where the language comes from, and it will be a choice rather than
whatever the OS happened to be set to.

### Two smaller things

**Scrollbars are chrome the design has to reach.** The Windows default is a
light-grey slab on a dark panel and reads as a rendering fault. Both syntaxes
are set — `scrollbar-color` for Firefox, `::-webkit-scrollbar` for the WebView2
this app actually ships inside — because neither alone covers where it runs.

**The transcript's scroll pin has to be keyed on the mission.** It opens at the
newest message, and follows new ones only while the reader is already at the
bottom. `TimelinePanel` does not unmount when you switch runs, so a pin left
`false` by scrolling up in one run would open the next one halfway through
somebody else's history.

### What a real run of the new shell found

Two bugs, both caught by reading the log of one mission (`Project web`, 22
minutes, ended `budget_exceeded`) rather than by any test.

**A 120-second timeout ran for 789 seconds.** `bash` wrote
`wait_for(process.communicate(), timeout)` and killed `process` on expiry. That
enforces nothing whenever bash **forks** instead of execing — which is every
pipeline. Killing the shell leaves the workers alive, they keep the write end of
the stdout pipe, and the cancelled read cannot complete until they exit, so
`wait_for` returns when the command finishes on its own. The row said "still
running after 120s and was stopped" beside `durationMs: 789197`: the record
contradicting itself on one line (§1). Two such calls spent the mission's entire
15-minute budget, and it produced no files at all.

Reproduced in three lines — `sleep 12 | cat` with a 2-second timeout returned
after 12.4s. Now: the shell gets its own process group (`taskkill /F /T` on
Windows, `killpg` elsewhere), the read is **shielded** so expiry does not cancel
the thing that is blocking, and the order is stop waiting → kill the tree →
collect, with a `KILL_GRACE_SEC` cap so the function always returns within
`timeout + grace`.

The old test asserted `code == "timed_out"` and passed the whole time, because
the error was correct and merely twelve seconds late. **"Was stopped" is a claim
about *when*, so the assertion has to be the clock.** The two new ones fail on
the old code with `took 25.2s to stop a 1s timeout` and `a child outlived the
timeout and kept working`.

**The header said "Working" over a mission that had ended.** `missionStore.endReason`
is the mission *row*, read once over REST — null at launch, and never updated.
`eventStore.endReason` is the *log*, set by `mission.ended` live and on replay
alike. The header read the row, so a run that ended while you watched kept a
live Stop button and a composer that refused to type.

`stores/runState.ts` takes the log first and the row as fallback — the fallback
matters for a mission reaped as `crashed` at startup, where a dead process
published no ending. The §2.1 argument in miniature: **the scene, derived from
the log, was right the whole time**, and captioned `mission ended —
budget_exceeded` directly above a header claiming the opposite.

**Worth knowing rather than fixing:** that run's workspace was empty — `list_dir`
returned 0 entries and `glob **/*` matched nothing — so the team used `bash` to
look elsewhere, reading across Documents, Desktop, Downloads and the home
directory. Every one of those went through the approval modal and was approved.
That is §2.7 working exactly as written, and it is the clearest demonstration so
far of why that section has to say *not a sandbox* in those words.

### A spinner is a derivation too

An agent that is thinking publishes `agent.status thinking` and then says
nothing at all until its whole reply is ready. On a reasoning model that is a
minute of a screen with no sign of life, which reads as a hang.

Two indicators, both derived from the log rather than from a local `isLoading`
flag. A tool call is **pending** when the log holds an `agent.tool.start` whose
`callId` never got its end — drawn as a turning ring instead of a dot, the
difference between "ran grep" and "is running grep". An agent is **busy** when
its latest `agent.status` is one that means work: portrait, three pulsing dots,
and the status word.

Three rules keep it from lying:

* `mission.ended` clears everything, the same terminal reset the scene uses. A
  cancelled run leaves a dangling `agent.tool.start` — true of the moment it was
  written — and a replay of it must not spin forever over a finished record.
* The end reaches back and clears its own start, so a replayed run shows no
  spinners at all.
* `waiting` and `blocked` do not spin. They are stopped, not slow, and the thing
  `waiting` is stopped on is the reader.

A status this build has never heard of spins and is labelled with the word that
was actually published (§8) — the agent said something is happening, and
inventing a friendlier word for it would be guessing.

### The Files tab counted zero over a file it had just written

`historyStore.artifacts` is fetched once by `openMission`, which is right for a
finished run and wrong for a live one: the timeline announced `artifact doc
final-answer.md` next to a tab reading **Files 0**. `MissionView` now refetches
when the count of `artifact.created` events overtakes the list it holds.

### The run that proved the fixes

Same team, same shape of task, a workspace with three real files in it:
**1m 16s, completed, 4 of 4 tasks, 41 tool calls, 6,079 in / 7,449 out**, and
`FINDING.md` written with the correct answer — `#5fc5e8` at `src/theme.css:2`.

The comparison is the point. The run before the timeout fix had an *empty*
workspace, so the agents went out through `bash` looking for the project, hit
two commands that ignored their 120-second limit, and spent the whole 15-minute
budget producing nothing. Every tool call in this one stayed inside the
workspace, because there was something in it to find.

### Opening a running mission replayed it

`openMission` called `eventStore.replay()` unconditionally. For a finished run
that is right. For one the backend is **still driving** it produced a static
snapshot with the socket detached, under a header saying "Working" beside a live
Stop button — and it was worse than cosmetic: `approvalStore.observe()` ignores
replayed events on purpose (a dead run's question must not raise a modal at
someone who is only reading), so a mission **paused on a question could not be
answered from the screen showing it**. Found on a real run parked at
`agent.status waiting` with a `pending_request` nobody could see.

`missionStore.live` carries the backend's own `running` flag — which means *this
process is driving it*, not merely that the row says `running` — and
`openMission` attaches to the stream instead. `attach` subscribes from seq 0, so
the history arrives first and the run continues live in the same stream: one
code path, no second renderer (§2.1).

### 8,192 output tokens is not a landing page

A worker asked to "Build the landing page (HTML/CSS/JS)" tried to return the
whole thing as its reply. First attempt: 8,192 output tokens, 7,488 characters,
cut off mid design-token list. Second attempt: 8,192 output tokens and **zero
characters** — all of it spent on reasoning. Reported `output_truncated`, then
`task_produced_nothing`, and the task marked `failed`.

That is the M4 failure recorded above, hit again at the raised cap, and raising
it again is not the answer. The team made exactly **one** `write_file` call in
seventy-eight events. A task that produces a file should write it; returning it
as chat pays for every byte twice and cannot survive a cap of any size.

### The question belongs in the rail, not over the top of the timeline

The approval was a modal. A modal is the wrong shape for it: a pause is a
*state of the run*, not an interruption to dismiss, and deciding almost always
means reading the timeline first — what was the agent doing, what did it read,
why does it want `bash` — which is exactly what a dialog covering the timeline
prevents. The "Later" button existed only to move the modal out of the way so
you could read.

`ApprovalCard` sits at the top of the right rail instead, above the members and
the budget, with a 3px edge in the waiting colour. The M6 criterion it had to
keep is that a question can belong to a run you are *not* looking at, or to one
from a previous session — so the card does not filter by the mission on screen:
a question from elsewhere is shown, labelled, with a button that opens that run.

`defer`/`resume`/`deferred` are gone from the store. Their stated reason —
"hides the modal so the user can go and look at whatever they need in order to
decide" — expired the moment the question stopped covering anything. A question
now leaves the list by being answered or by its mission ending, never by being
put aside, because the mission stays paused either way and a hidden pause is a
run that looks stuck for no reason.

### $0 was a lie, and it took a real run to see it

The budget block showed **Cost $0** under a run that had spent 13,528 tokens.
DeepSeek is not in the pricing table, so `cost_usd()` returns nothing and the
`usage` blocks carry token counts with no `costUsd` at all — summing an absent
field to zero and printing "$0" tells the user the run was free.

`Vitals.costUsd` is `number | null` now, and null renders as **Not priced**,
with a tooltip saying the tokens are counted and the cost is not known. Same
rule as `ProbeResult.conclusive`: our own missing data must never be written
down as a fact about the world.

The same pass removed the other quiet untruth in that block. There is no
**"model calls 18 / 60"** row, because the count cannot be derived: `agent.message`
is deliberately not published for a round that only asked for tools, so counting
messages undercounts calls, and a ratio built from the two would read
comfortably below a limit it was already close to. What is shown is what is
derivable, called what it is — **Replies** — with no limit beside it.

### Two components disagreed about one store

After deleting `ApprovalModal.tsx` while Vite was running, the right rail
insisted no mission was open while the middle column rendered one — same
selector, same store, two different answers. Not a state bug: the HMR graph
still held the deleted module, and the stack traces gave it away with two
different `?t=` timestamps in one tree. Vite was serving two copies of
`missionStore.ts`, which is two zustand stores.

Restarting the dev server fixed it, and the duplicate-React-key warnings in the
timeline went with it. **Delete a module and restart Vite** — the failure looks
exactly like a bug in the code you just wrote, and half an hour can go into
debugging state that was never wrong.

### An agent that can write files has to be told to write files

Three runs failed the same way. Asked to "build the landing page", a worker
returned the whole page as its reply — 8,192 output tokens, cut off partway
through a list of CSS variables — retried, spent the entire budget reasoning and
emitted nothing, and was reported `task_produced_nothing`. The mission then
failed for a second reason: no file had ever been written, so the next agent
looked in the workspace, found it empty, and asked the user where the page was.

The cap was never the problem. A reply is the wrong place for a deliverable at
any cap, and raising `MAX_TOKENS_PER_TASK` again would only move the failure.
`FILE_DELIVERABLE_RULE` is appended to the system prompt of any agent holding
`write_file` or `edit_file`, and the sentence that does the work is the reason
rather than the instruction: *your reply has a length limit and a file does
not; a reply that hits the limit is cut off and thrown away.*

`system_addendum` composes rules now instead of returning the first that
matches — a researcher who also writes the report needs the untrusted-content
rule **and** this one — in a fixed order, so two agents with the same tools get
byte-identical prompts and the provider's prompt cache still hits.

**The same brief, re-run:** eight file writes, `index.html` (8 KB),
`styles.css` (19.7 KB) and `script.js` (3.3 KB) on disk, all three required
sections rendering, and the vanilla-JS colour picker working when clicked. 31 KB
of deliverable, from a worker whose replies are capped at 8,192 tokens. It still
ran out of time during QA — the page exists, the review of it does not — and the
design agent chose an ember/violet palette over the cyan/magenta that was asked
for. That is the model's judgement, not the app's, and the record says exactly
which agent made it.

### The list has to notice the run that just started

The first message is what creates the mission, and `MissionList` had fetched its
rows on mount and never again — so after sending, the sidebar went on showing
the draft under "Not started", with the new run absent until the window was
reloaded. It reloads on the id of the run on screen now.

The selected row is keyed on `missionStore.missionId` rather than
`historyStore.openId` for the same reason: `openId` is only set by *clicking* a
row, so a run started from the composer left the list marking nothing — or worse,
still marking the run before it.

### A wait that was over, in a second place

`deriveVitals` kept each agent's latest `agent.status`, so the rail showed
"Waiting on you" for the rest of a run: an asker publishes `waiting` when it
asks and publishes nothing when the answer arrives. Beside it sat no approval
card, because nothing was actually pending — which is what made it look like the
card had failed to appear.

`scene/bindings` had fixed exactly this for the pose two milestones earlier, and
the fix is the same one: `agent.request.resolved` clears the asker's status, no
synthetic event is written, and a real status published afterwards still wins.
**Worth checking every other place that keeps a "latest status" per agent** —
this is now twice.

### An exploratory pass, and the seven things it found

Built two agents through the generator, made a team, and ran a creative brief in
`Documents/Project/lab-01`. Seven findings, six of them real.

**"Time used 7:00:05 / 15:00" on a run five seconds old.** `DateTime(timezone=True)`
is a no-op on SQLite, so `mission.started_at.isoformat()` went out with no
offset and the browser read it as *local* time — seven hours off, on the
machine's own timezone. `_wire` fixed exactly this for event timestamps in M1;
`as_utc_iso` is now the shared version and both mission serialisers use it. It
hid for as long as it did because a *finished* run is measured start-to-end, and
both ends were shifted equally.

**A mission where every task failed was recorded `completed`.** Three tasks
failed, nothing was written, and the leader's own summary said "the deliverables
were not produced" — over a row saying `completed`, which also credited both
agents with a mission they had not finished. `ending_for()` corrects that to
`failed` when nothing succeeded, and only then: a partly successful run is
honestly completed, and any more specific reason wins.

**The generator named two different agents "Mara".** It is never shown the
roster it is adding to, and nothing checked. That is not cosmetic:
`send_message` addresses teammates *by name* and `Mailbox.resolve` returned the
first match, so a message meant for one would be delivered to the other **and
the sender told it worked**. The validator now refuses such a team, and the
mailbox raises `Ambiguous` rather than guessing.

**The transcript printed raw agent ids for a whole run** while the rail and the
scene showed real names. `TimelinePanel` subscribes to `roster` — CLAUDE.md
already records that trap — but `roster` was missing from the `useMemo`
dependencies, and `nameOf` is a zustand action whose identity never changes. So
the component re-rendered and handed back rows built before the roster arrived.
**Subscribing to a value is not the same as depending on it.**

**Pressing Edit dropped you at the bottom of the form.** Both branches of
`RosterPanel` render a `<div>` in the same position, so React reconciles them to
the *same DOM node* and swaps only the children — and `scrollTop` is DOM state,
not a prop. Distinct `key`s make them different elements, mounted at the top.

**"1 missions"** on every card that had run once.

**And one that was not a bug:** Enter-to-send looked broken under automation.
The key events being delivered had `key: ""`, so the handler was right to ignore
them. Worth the check before the claim. The rewrite stands anyway — the handler
now reads `event.currentTarget.value` instead of a stale closure and only calls
`preventDefault()` once there is something to send, which removes a real
paste-then-Enter race.

### 8,192 was still too small, for a different reason

The file-deliverable rule from the last session did not save this run. The
worker never got as far as a tool call: it spent all 8,192 output tokens
*reasoning* and emitted neither text nor a call, three tasks running. A prompt
rule cannot help a turn that never acts.

`MAX_TOKENS_PER_TASK = 16384` now. A cap that is too low does not cost less — it
costs the whole turn and buys nothing, and then the next agent pays again to
discover there is no file. At 16k the same brief produced `index.html` (11.7 KB)
and `NOTES.md` (3.9 KB), all three tasks `done`, in 13,399 in / 5,962 out.

The piece works: a recursive SVG tree with blossoms, moon, stars, fireflies and
grass, and the determinism it claims is real — xmur3 hashes the seed text,
mulberry32 draws from it, and seed `42` grows the identical garden every time
while `sunset` grows a different one.

### You can talk to a team while it works

The composer was disabled for the whole run, with "stop the run to send
something new" underneath — so noticing a mistake thirty seconds in meant
throwing the run away and paying for it again.

It is **not** an interrupt, and the wording never pretends otherwise. Nothing
can reach a model mid-reply, so `POST /missions/{id}/message` puts the note in
the same `Mailbox` teammates use and every member collects it when their next
task starts. The hint reads *"Enter queues it · the team reads this when the
current step ends"*, the endpoint answers **202**, and the label underneath says
"Waiting for the next step" until a `mission.progress running` proves it was
picked up — counted off the log, because a guess at how long a step takes would
be the label lying by a different route.

Reusing the mailbox is the point: a second delivery path would be a second thing
to keep working, and this one is already collected in exactly the right place.
Verified live — a note sent mid-run ("keep the myths under 40 words") landed on
the log at seq 4 and the file written afterwards obeyed it.

### `npm test` was killing live missions

Three runs died as `crashed` before the cause was traced, each one costing real
tokens. `fs.watch` on Windows is imprecise: writing `__pycache__/x.pyc` produces
a notification naming **`x.py` itself**, and running the test suite imports the
whole package. The watcher's `__pycache__` filter cannot help, because the name
it is given is a real source file — the log showed restarts for
`0009_search_kind.py` and `providers/__init__.py`, which nobody had touched.

`scripts/dev.mjs` now remembers each file's size and mtime and ignores a
notification when neither changed. The full 388-test suite triggers zero
restarts where it used to trigger a dozen.

### A number and the limit beside it have to be the same measurement

The rail read **45,856 / 200,000** on a run the backend had just stopped for
spending **200,811**. `BudgetTracker.record_call` counts input, output *and*
cache read/write — cache reads dominate a long run — while `deriveVitals`
counted input and output only. So the meter sat a quarter full at the moment the
mission was killed for being over.

Fixed by counting the same four fields. The general rule, and the second time
this session it has come up: **anything drawn as `used / limit` must count what
the limit counts**, or the bar is decoration. It is the same reasoning that kept
"model calls" off that panel entirely.

### Any failed task means the run did not complete

The first version of `ending_for` only caught a run where *nothing* succeeded,
and the very next run walked through the gap: the atlas task failed, the notes
task succeeded, and the leader's own summary said *"index.html is missing, so
the mission is not complete"* — over a row saying `completed`, crediting both
agents again. There is no honest reading of that word which covers a run that
did not do what it was asked. The nuance belongs in the summary; the reason is
one word and has to be the true one.

### A cap cannot fix a model that reasons past it

At 8,192 a worker spent the whole budget thinking and emitted nothing. At
**16,384 it did exactly the same** — content length 0, no tool call, three tasks
in a row. Raising the number again is not a plan.

What worked was telling the model the shape of the way out, in
`FILE_DELIVERABLE_RULE`: the limit applies to one *turn*, not to the file, so
write a skeleton with `write_file` and then `edit_file` each section in its own
turn. *"Three small turns finish; one enormous turn gets cut off and you have
nothing."*

The next run did precisely that — a 328-byte skeleton, then an edit per section,
across five small tasks the planner had broken out itself — with no truncation
anywhere. It still ran out of *tokens* before the end, which is a budget
question rather than a broken one, and it said so.

### Two faces that were missing

The avatar picker was four dropdowns and no picture: you chose "sturdy / hooded
/ cloak / ink" and found out what it looked like when a mission was already
running. The roster — the one page whose whole job is choosing between agents —
showed no portraits either, while the scene, the transcript and the rail all
did. Both now draw the same `Portrait`, so what is previewed is what appears.

### Where the budget numbers come from, and why Cost said nothing

Two questions from using the app, both with the same shape of answer: the
figure was real, and the app was not explaining itself.

**200,000 tokens and 15:00** are `AppBudget` — `max_tokens`, `timeout_sec`,
plus `max_llm_calls = 40` and `max_supersteps = 60`. Resolved per field, mission
> team > app (§10), and since nothing in the UI has ever set a team or mission
budget, every run gets the app defaults. They are enforced — a run really was
stopped at 200,811/200,000 — but they are **ours**, not the provider's, and
there is still no screen that shows or changes them. Recorded as an open item.

**Cost said "Not priced" on every run** because `pricing.json` deliberately
omits DeepSeek: its rates were not verifiable when the file was written, and the
rule is that a guessed price in an append-only table reads as fact forever
(§6.2). That rule is right and stays. What was missing was a way out of it.

It cannot be fetched — no provider API returns its own pricing. So the only
honest source is the person who can open their own billing page. Migration 0011
adds `model_prices`, `cost_usd` takes an `overrides` map that wins over the
shipped table, and Settings gained a panel that lists every model this machine
runs with its rate, or **"No rate — runs show no cost"** where there is none.

Three details worth keeping:

* Rates are loaded **once per mission and frozen**, the same argument as the
  roster snapshot: editing a price mid-run must not make the first half of a
  run's cost disagree with the second.
* Each figure says where it came from — "Rate shipped with the app" versus
  "Your rate, entered <date>". Those are different claims and a stale one
  should look stale.
* Removing a rate does not rewrite finished runs. They were charged at the rate
  of the day, and that is what their events say.

A half-filled rate — input set, output left blank — is treated as *no* rate
rather than pricing one side, which would report a real-looking figure that is
quietly too small.

### A round ending is not the mission ending

The composer's only offer after `mission.ended` was to start a *different* run:
a new row, an empty timeline, and a team that had forgotten the workspace it had
just spent ten minutes learning. "Fix the spacing on the hero" is the most
ordinary next thing to want, and it was the one thing the app could not do.

`POST /missions/{id}/continue` reopens the row and runs the graph again over the
**same frozen roster** — never re-read from the agents table, because who did
the earlier rounds must not change retroactively (§5.1) — appending to the same
log. Every "Mission ended" now reads **Round finished**, which is what it always
was.

Two things follow, and both had to move with it. Each round gets a **fresh
budget**: one ceiling across every round means a second question is refused
because the first was answered thoroughly. And the rail counts a round's tokens
and a round's clock, because it draws them against a round's limits — measuring
elapsed from the mission's own `startedAt` reported **6:44:04 / 15:00** on a
round four seconds old, the clock counting the hours the conversation had sat
waiting to be continued.

### One permission setting, where the decision is made

`autonomy` was a dropdown in the agent editor, under the tool list. Wrong twice:
it asked a security question **once per agent**, so a team of five had five
answers to something a person means once; and it lived on a page nobody has open
while a run is going, which is exactly when you want to say "stop asking".

One value now, in `app_settings`, rendered beside the composer — and frozen into
each mission's snapshot at launch, so moving the switch mid-run cannot change
what the run in front of you is allowed to do. `agents.autonomy` stays in the
schema with its old values, because deleting it would rewrite what finished
missions were run under.

### Cost, built and then withdrawn

Migration 0011 originally added `model_prices` so a rate could be typed in for
models `pricing.json` does not carry, which is why every DeepSeek run said "Not
priced". It worked, and it was the wrong answer: a figure you look up on your
provider's billing page and copy into an app is a chore in exchange for a number
you were already looking at, and the app then owns a second place for it to go
stale. The Cost row is gone instead, and 0011 keeps its id while dropping the
table — so a database that ran the old version and a fresh install end in the
same state, which is the only property a migration chain has to have.

### Images

`attachment.added` on the wire, bytes on disk, content-addressed by SHA-256. The
log carries name, size, type and digest and never the picture: `mission_events`
is append-only forever and a few screenshots inlined as base64 would make it
unbounded (§9.3). The transcript fetches one back through the authenticated
request like everything else — a plain `<img src>` would need the session token
in a URL, and a URL is the one place a token must not go (§9.1).

Both adapters render images in the shape their own API documents — OpenAI a
parts array with a data URI, Anthropic content blocks with the image first —
with no shim pretending they are the same (§15 row 17). The test that protects
everything else is the negative one: a message with no images comes out exactly
as before, because every turn of every existing conversation goes through that
code.

**And the app now learns what a model cannot do.** DeepSeek answered the first
image with `400: This model does not support image`. That is a fact about the
model, established by the endpoint itself, so it is written to
`capabilities.vision = false` — and the composer warns *before* the next round
rather than after it. Same rule as the capability probe: record what was
established, never what was assumed (§3.1).

### Two smaller things testing turned up

**A tool call written as prose.** DeepSeek ended a round with nothing but its own
`<｜｜DSML｜｜tool_calls>` template as text. No tool ran, and because a round's
summary is its last message, that markup became the mission's one-line record.
`leaked_tool_call` names it — the event is still published, because the model
really did say it — and keeps it out of the summary. Detection is narrow on
purpose: a reply *discussing* tool calls must survive, since a false positive
would hide something a person wrote.

**Instructions belong to the control they describe.** The splitter's keyboard
help was a permanent line of text under the pane. It is the divider's `title`
and accessible description now: there when you reach for it, absent the rest of
the time.

### The right column is summoned, not permanent

The rail held the approval card, the members and the budget, and was always
there. Two things ended that. The question moved into the transcript, so the
rail stopped being the only place a paused mission could be answered — which
was the one reason it could not be given up. And the terminal needed room: 80
columns of monospace is about 580px, and a column sized for short rows of text
wraps every real command.

So two icon buttons in the mission header choose what the panel holds —
**Terminal** and **This run** — pressing the lit one closes it and gives the
whole window back to the work. Width is remembered **per mode** (560 and 316 by
default), because one number would be wrong for one of them every time you
switched. `ResizeHandle` drags it, with the same commitments `SplitPane` makes:
arrows and Home/End from the keyboard (WCAG 2.1.1), a 24px hit area around a 1px
line (2.5.8).

Verified live rather than by reading it: the terminal opened at 560 and This run
at 316, a drag took it to 789 and localStorage kept it, and `End` went to the
240 minimum.

### A stable selector does not re-render — the third time

`AppShell` read the width through `usePanelStore((s) => s.widthOf)`. Dragging
the divider recorded the new number and **the panel did not move**: a zustand
action's identity never changes, so a component subscribed to one is subscribed
to nothing. The store had `{"terminal": 680}` in it while `aria-valuenow` still
said 560.

This file already records the shape twice — the timeline's `nameOf`, the
transcript's `roster` — so the fix this time was to remove the trap rather than
step around it. There is no `widthOf` action any more: `widthFor` is a plain
function of state and `usePanelWidth` selects the *number*. A selector returning
a primitive cannot go quietly stale, and `panelStore.test.ts` fails if a
resolver comes back.

### Deleting the card took the fetch with it

`ApprovalCard` was the only caller of `approvalStore.refresh()`. Removing the
rail therefore removed the one thing that asks the backend what is waiting — and
the whole M6 criterion is that a question can outlive the process that asked it.
Nothing on screen would have looked wrong; a question from a previous session
would simply never have appeared again.

The call lives in `App.tsx` now, mounted for the life of the window. **A
capability that only one component performs disappears when that component
does**, and the loss is invisible exactly when the capability is about something
that has not happened yet.

### A run parked on a question is not "live"

`missionStore.live` means *this backend process is driving it*, and a mission
waiting on an interrupt has no task at all — so opening one reads it back off
the log, correctly, and it is answerable there because `approvalStore` holds the
question independently of the stream.

Answering restarts it, and at that moment the record on screen stops being the
present. Seen live: the run resumed, ran its task and finished, while the window
went on showing **Working**, a sidebar row saying **Waiting on you**, and a
transcript ending at `Ilse is waiting` — three surfaces describing a minute that
was over (§1). The backend meanwhile reported `completed`, `pendingRequest:
null`.

`resolveRequest` already returns `resumed`, so the answer is the moment to
attach — and only when this client was reading *that* mission, because a
question can belong to a run you are not looking at and answering it must not
drag the window away from what is in front of you.

### The list has to notice a run that stopped, too

`MissionList` reloaded on the id of the open run, which covers a run appearing.
It did not cover one *ending*: a row fetched while a run was working went on
saying "Working" after it finished in front of you. It reloads on `useEndReason`
as well now — the log first, so it fires on the `mission.ended` itself rather
than on a guess about timing.

Which is also why the sidebar's waiting marker is derived from
`approvalStore.pending` and **not** from the row's own `pendingRequest`. The row
is a fetched snapshot; the store is the live answer, refreshed over REST on
mount and updated off the stream. Reading both would be two answers to one
question (§2.1), and the stale one wins whenever the list has not been reloaded.

One thing had to move with it: `observe` now drops a mission's questions on
`mission.ended`. A run cancelled or reaped while parked publishes no
`agent.request.resolved`, and the entry used to sit in `pending` until something
happened to call `refresh()` — which was harmless while it only fed a card
nobody was looking at, and is a triangle on a dead run now that the sidebar
reads it.

### Three ways in, for a choice made once

The workspace picker offered a dashed drop-target, a text field and a list of
recent folders, stacked, inside a form whose other two fields are a name and a
dropdown. It was the tallest thing on the page for the least frequent decision
on it.

One field and one button now, and the button is whichever of the two things is
useful: **Browse** while the field is empty, **Use this folder** once there is a
path in it. The field is the same 38px control as the title above it — a folder
is not a more important thing to type than the name of the run.

`recent` and `loadRecent` went with the list. A store slice that fetches on
mount and feeds nothing is worse than an unused constant: it is a request per
render of that form. `api.recentWorkspaces` stays, because the backend still
records them and the client is the typed mirror of that API.

**The plan gate now defaults to on.** The old comment said "opt-in — a gate on
every run is a gate users switch off rather than one they read". That reasoning
was about a gate you *cannot* turn off; this one is a checkbox in the launch
form, one click, decided per run. Seeing the plan first is the only point where
stopping still saves the cost of the work, so the default that costs nothing to
refuse is the one that has it on.

### A meter is a claim that somebody measured something

"Can web search show how much allowance is left?" has a different answer per
endpoint, and the only way to find out was to ask them. One request each, with
the headers printed:

* **Brave** answers with `x-ratelimit-policy`, `-limit`, `-remaining` and
  `-reset` — several windows at once, a per-second cap beside a per-month one.
* **Tavily** answers with nothing at all. No header, no field in the body.

So the panel says three different things, and none of them is a zero:

* a **bar**, where a window has a real limit over a real period;
* a **sentence** — "up to 50 searches a second, no longer-term allowance
  reported" — where only a rate came back. This machine's Brave key declares
  its monthly window as `0;w=2592000`, and rendering that as 0 of 0 would say
  the account is exhausted, which is the opposite of true;
* **"this endpoint reports no allowance"**, for Tavily, permanently.

The window lengths come from the policy header and nowhere else. A build that
assumed "the second one is the month" would be wrong the day Brave adds a third.

**And a fourth state, which the app got wrong first.** Every key configured
before this existed showed *"this endpoint reports no allowance"* — a claim
about Brave that had never been checked, because the column was null and null
was being read as "reports none". It is three states now: null is *never asked*,
`[]` is *asked and it reports none*, and a list is what it declared. Same
distinction as `ProbeResult.conclusive`, and the same reason: our own gap must
never be written down as a fact about the world.

The bar fills with what has been **spent**, so full means gone. Drawn as
remaining it read as a battery — the opposite meaning from the same picture.
The sentence above it still says what is left, because that is the number
anyone is actually asking for, and the bar carries its own label for what the
bar draws.

The reading is taken by "Test connection", because it only arrives on the
response to a real search and there is nowhere to ask for it on its own. So the
line underneath says *measured when this key was last tested, not since* — a
meter that looked live would be the more comfortable lie.

### The dashboard has a number, so somebody must return it

"Can you fetch this?" — pointed at a Brave spend meter and a Tavily credit bar.
Two dashboards, two different answers, and the only way to know either was to
ask.

**Tavily: yes.** `GET /usage` with a Bearer token returns
`{"key": {"usage": 3, "limit": 1500, ...}, "account": {...}}`. Which corrects
something written here a few hours earlier: "Tavily reports no allowance" was
true of its *search response* and false about the endpoint. A search says
nothing; there is a second place to ask. `read_quota` is that second question,
and it is only asked when the search came back silent — Brave answers in headers
on the way past and never reaches it.

**Brave: no.** Every plausible account or usage path under
`api.search.brave.com` answers 301 to the dashboard, and the community feature
request asking for one is unanswered. Its postpaid ceiling is a *spend* limit in
dollars, and that is the same wall as provider pricing (§6.2): the number exists,
it is on a billing page, and no API hands it over.

Two things had to become explicit rather than assumed:

* **The unit.** Brave meters requests; Tavily meters credits, where a search is
  one credit and a crawl is not. Calling Tavily's number "searches" would be
  wrong the moment an agent uses another of its tools, so the unit travels with
  the numbers.
* **The period, or its absence.** Tavily states a total and never says over
  what. Its dashboard says "Monthly plan" — and the dashboard is not the API.
  `window_sec` is None there, the sentence ends after "credits left", and
  nobody writes "this month" on the app's behalf (§3.1).

A window with no period still gets a bar. It is an allowance — something you
spend down — which is what a bar is for; a per-second cap is not, and that is
the line `RATE_BELOW_SEC` draws.

### The model id was the one field with no feedback

Adding an endpoint was five text boxes, and `Model` was the one that went
wrong: a bare string whose correct spelling exists in exactly one place — the
endpoint — bought nothing until a mission failed on it three minutes in.

`POST /providers/models` builds a throwaway client and calls its `/models`. The
key travels in the body, is handed to the SDK for one call, and is stored
nowhere; a profile is created afterwards, separately, by the form that used it.

**No list of model names ships with this app**, and that is the point rather
than an omission. Names go stale in silence and a stale list looks exactly like
a fresh one — the mistake `pricing.json` is careful not to make with rates
(§6.2), and this file already records two model ids the project could not be
sure of. What ships is a base URL per preset, which the button then proves.

A preset is therefore *a guess at your setup that you confirm by pressing a
button*. "Ollama, port 11434" is that project's default, not a fact about this
machine, so every field stays editable. And the text field stays too: an
endpoint with no `/models` is a normal thing to meet and must not make the form
unusable, so the failure shows the endpoint's own words — "could not reach the
endpoint" and "invalid api key" need different fixes — and you type the id.

Asked against the real DeepSeek endpoint, it answered `deepseek-v4-flash`,
`deepseek-v4-flash-vision-exp`, `deepseek-v4-pro`. Which settles an open item
that had been guesswork since M1.2, and turns up a vision model on an account
whose main model refused an image (§12 M9.3).

### A parse failure is ours, not the model's

`deepseek-v4-pro` came back "3 of 4 passed · 1 failed — reply was not usable
JSON", and `structured: none` was written onto its profile. Asked the same
question again it answered `{"ok": false, "note": "No task was provided."}`,
which parses. The endpoint had never refused JSON mode; one reply had not come
back clean, and our reading of it became a recorded fact about the model.

This is the M1.2 lesson at a different spot. That one added `inconclusive` for a
*truncated* reply; a reply that arrived whole and did not parse was still a
conclusive `fail`. So now:

* **refused** — the endpoint errored on the mode. Its own answer, conclusive,
  and `none` is the honest record.
* **accepted, unparseable** — nothing was learned. Inconclusive, nothing
  written, so one bad sample cannot overwrite a good earlier reading.
* and the parse is lenient first: fenced or prefaced JSON is JSON.

`extract_json` moved to `core/jsonish.py`, because `profile_gen` had been doing
this since M2 — "stripping that here costs one regex; treating it as a failure
costs a retry and the user's money" — while the probe next door did a strict
`json.loads`. Two readers of the same thing, and the one nobody was looking at
was the wrong one (§2.1). Re-tested: **4 of 4, `structured_output: json_object`.**

### The summariser could not see the picture it was summarising

Asked for the colours of four squares, the worker read the image and answered
**`purple, yellow, teal, orange`** — correct, on the timeline, 259 input tokens
with the picture in them. The leader then wrote the run's final answer *without*
the image, and because the goal said "look at the image", it answered **"I
cannot see the image."**

That sentence became `mission.ended`'s summary and the text of
`final-answer.md`. A run that answered correctly was recorded as having failed,
which is the exact thing §1 forbids — and the comment above `images` said they
were "handed to every agent's turn" while only the work turn ever got them.

Fixed, and the comment now says what is true: work turns and the summary turn
get them, the planning turn does not. A plan is made from the goal and is the
one turn that never quotes the picture, so it is the one worth not paying for.
Re-run: the summariser's input went 170 → 275 tokens and the recorded summary is
`purple, yellow, teal, orange`.

### The workspace chip opens the folder

It had been a label for four milestones: the one path that says where the agents
may write, on screen for the whole run because §16.2 is only checkable if it is
visible — and the only way to act on it was to select the text.

`reveal_folder` is the shell's first custom command, and it is a command rather
than a shell permission for the webview because those are different offers: a
shell permission lets the page run anything, this lets it show a directory.
Three checks before anything spawns — the path exists, it is a **directory**
(revealing a folder and opening a file are different risks), and it is
canonicalised so `..` is resolved before it reaches the file manager. The
program is fixed per platform and the path is one argument, never interpolated,
so there is no string for a crafted path to break out of.

In a browser it copies the path instead and says so, the same split the folder
picker has. A button that silently does one of two different things would be
worse than one that does neither, so the outcome is announced in an `aria-live`
region rather than only implied by a taskbar the reader may not be looking at.

**Verified in the browser** (copies, and says why); the Rust guards have tests
for the three refusals. Explorer actually opening is the one part not checked
end to end — it needs a native window, which cannot be driven from here.

### A tool only the leader carries is a tool nobody can use

A research team was pointed at a real question with `web_search` and `web_fetch`
on its roster. It produced a well-formatted DECISION.md with quotes and URLs,
and buried in it:

> No live web access existed when either research file was produced.

Every task had gone to the one worker. The agent holding the web tools was the
**leader**, and `_assignable()` excludes the leader whenever a team has workers
— the M4 fix for a leader that kept all the work — while the two turns a leader
does take, planning and summarising, are handed no toolbox at all. So the tools
were on the roster, counted as covered by `tool_uncovered`, and dead. The worker
improvised by calling `read_file` on a URL, failed, and answered from memory.

Nothing on screen said why, because from the outside the team was correctly
equipped. `leader_only_tool` says it now, by name, with the fix in the message.
It immediately found a second case nobody had noticed: Art Lab's `ask_user` has
been unusable since the day that team was made.

**Writing the test found the sharper version of the rule.** The obvious fix —
swap the roles, put the web tools on a worker — reported `write_file` instead,
because the new leader was carrying that. What the warning is actually asking
for is a leader that carries **nothing**: it coordinates, and every tool lives
with the workers. That team then validated clean and the run fetched the pages.

### A round that only calls tools spent money nowhere on the log

The same research question, run again with the team fixed, ended
`budget_exceeded` having produced no files. Its timeline totalled **7,540
tokens** across two `web_fetch` results of 15,321 and 20,018 characters, which
cannot be true — 35KB of fetched text is several thousand tokens on its own, and
it is re-sent on every following turn.

**Correction, and it is the point of writing this down.** The first version of
this entry said those fetches "ate the whole 200,000". They did not: the run was
stopped by the **time** limit, and `mission.ended` says so in words — *stopped at
the time limit (1234.6/900)*. What the log undercounts is real; the number I put
next to it was invented, from the same habit of reading `budget_exceeded` as
"out of tokens". The true token spend of that run is still unknown, because the
log did not carry it. That is the bug.

`run_agent_turn` publishes no `agent.message` for a round that asked for tools
and said nothing — an empty bubble would suggest the agent said nothing when in
fact it acted, which is right — and the usage was *inside* that message. The
budget guard counted those tokens; the log never saw them. So the rail drew a
meter at 4% of a run being killed for being full.

This file already records fixing that symptom once, by making the rail count the
same four fields as the guard. That fix could not have closed this: whole rounds
emitted nothing to count.

`agent.usage` is the missing event — what a round cost, for a round with nothing
to say. Same numbers, kept, attributed, and tied to its round by `messageId`.
The message stays absent for the original good reason; only the cost is
recovered. Re-run: **95,902 tokens on the log, four `agent.usage` events**, and
the mission finished with the quotes and the URLs.

### The budget is a setting now, and Settings says where the work is kept

`AppBudget`'s four numbers enforced every run from the first release and were
editable from nowhere. A team was killed at 200,000 tokens with no screen saying
what that number was, where it came from, or how to raise it. `resolve_limits`
had taken an `app_default` since M4 and nothing had ever passed one.

Stored per field and read per field, the same rule the precedence chain already
follows: a value that is missing, out of range or the wrong type falls back to
the shipped one instead of taking the other three down with it. A corrupt row
does not stop the app launching.

Two details worth keeping:

* **`isinstance(True, int)` is True in Python**, so a budget of `True` would be
  a ceiling of one. Booleans are refused by name.
* The **shipped values come from the backend**, so "back to the shipped values"
  cannot drift from what a fresh install actually gets.

Precedence is untouched: mission > team > app. Raising the app default does not
overrule a run that asked for something specific, and it reaches the *next round*
of a continued conversation rather than only brand-new runs.

The panel says whose limits these are, because nothing on screen had: *they are
not limits your provider sets — they are the point at which Agent Studio stops
paying for a run*. And each row says what running out of **that** one looks
like, since "Out of budget" is one phrase for four problems with four fixes.

**Settings also stopped being only about credentials.** "Where your work is
kept" names the data folder, measures the three things inside it, and opens it
with the same `reveal_folder` the workspace chip uses. Runs, produced files and
attachments all lived in a folder nothing on screen had ever named. Sizes are
measured rather than estimated, and a folder that does not exist yet reports
zero rather than being omitted — "no artifacts yet" and "no such thing" read
very differently to someone hunting a missing file.

Verified end to end rather than by reading it: saved 400,000 / 1,800 in the
panel, and the next run's frozen budget row came back
`{"max_tokens": 400000, ..., "timeout_sec": 1800}`.

### The other two layers of the budget, and a settings page that is four pages

`resolve_limits` has picked mission > team > app **field by field** since M4,
and only the app layer had a screen. The other two were reachable by editing the
row yourself, which is to say not reachable.

`BudgetOverrides` is one component used by the team form and the launch form,
and the per-field rule is its whole design: a **blank box means inherit**, and
its placeholder is what inheriting gets you. Nobody has to work out the
effective limit, and nobody is made to fill in four numbers to change one —
which is exactly how two layers quietly stop agreeing. Empty and zero are
different things, so the value is held as a **string** rather than a number:
`Number("")` is 0, and a token ceiling of 0 is a run that cannot take a step.

The launch form's placeholder is the app's numbers **with the team's on top** —
precedence resolved for display the same way `resolve_limits` resolves it for
the run (§2.1). Its label follows: *the team's limits* when the team set
something, *the app default* when it did not.

**`validate_overrides` is now the single answer to "is this a legal limit".**
The mission endpoint had its own `ge=1` on each field, so a run could ask for a
ceiling of 1 token that a team was refused — two tables of the same numbers,
which is the drift that function exists to prevent. `BudgetIn` declares the
shape and nothing about the bounds.

An empty override set is sent as **no budget at all** rather than an empty one,
so the chain falls straight through instead of stopping at a layer that said
nothing.

**Settings is a row of tabs.** Four things share that page and nothing else: a
model endpoint is what an agent thinks with, a search key is what one of its
tools uses, the limits are this app's own ceilings, and storage is where the
work landed. Stacked they read as one pile. A left rail was tried first and was
worse — it sat immediately beside the app's own left sidebar, two columns of
vertical links against each other, with a whole column spent on four words. Not
`role="tablist"`: these are four places, and a real tablist owes the reader
arrow-key roving focus, which would be extra code to make Tab behave worse than
it already does.

### `taskkill /F` on "a Vite" is every Vite

`reclaimWebPort` frees port 5173 when a leftover of *ours* is holding it, and
decided ours by `cmd.includes("agent-studio") || cmd.includes("vite.js")`. Every
Vite dev server in the world has `vite.js` on its command line. Another
project's server was on 5173 on this machine, and `npm run dev` would have
killed it — force, whole tree, no warning.

Fixed to match this launcher by name, `/scripts[\\/]dev\.mjs/`, and the first
attempt at the fix is worth recording too: matching only the **repository root**
looked stricter and was wrong in the other direction, because our own command
line is usually the relative `node scripts/dev.mjs` with no path in it at all.
It failed to recognise a leftover of ours immediately.

`AGENT_STUDIO_WEB_PORT` came out of the same session — with 5173 legitimately
taken, a second copy has somewhere to go. Two things had to move with it, and
each was a separate failure to find out about:

* The port has to reach **Vite**, not just the log line. `strictPort` is on by
  design, so a port Vite silently moved off would be a page that cannot reach
  its own backend.
* The backend's CORS allowlist is explicit, so the page loaded on the new port
  and then failed **every** request — reported as a CORS violation, pointing at
  the one thing that was not wrong. `allowed_origins()` appends
  `AGENT_STUDIO_DEV_ORIGIN` when the launcher sets it, and a shipped build sets
  nothing. This file already carries that scar from M8; it is the second time
  the same misleading error has cost time.

### Running out no longer stops the run where it stands

`BudgetExceeded` was raised on the next call and propagated out of the graph, so
the summarise node never ran. A run that had written seven files and not started
six tasks ended with no account of itself beyond a number — and the files it did
write were left for whoever opened the folder to sort out.

A slice of each limit is held back now. Crossing the *working* share stops the
team **starting** anything new, lets whatever is running finish, and spends what
was kept on the leader writing a handover. The ceiling is unchanged: the reserve
is inside it, not on top of it, and `check()` still raises at the number the
user actually set.

Sized per limit, and the sizing came from a test failing. A flat 90 seconds
against a 60-second timeout left **no working share at all** — the run would
have stopped before it started. Tokens and seconds are `min(flat, 15% of the
limit)`; calls and supersteps reserve exactly one, because the summary is one of
each and there is no useful fraction of a call — unless the limit *is* one,
where reserving it would leave nothing able to run.

The summariser is told which situation it is in. A finished run gets "write the
final answer"; a run cut short gets "write the handover: what is finished and
where it is, what is missing, and what the next round should do first" — because
the reader's next question is *what do I still not have*, and only the leader can
answer it in the goal's own terms.

`_run_team` corrects the reason afterwards. No exception is raised on this path
— that is the point of it — so a run that ran out would otherwise be recorded
`completed`. The leader's text is kept and the numbers go in front of it.

**Verified on the run that motivated it**, the same mission continued:

    before   605,853 / 600,000   "5 of 11 tasks done. produced nothing: ..."
    after    593,338 / 600,000   a handover naming all 11 files, what was
                                 missing, and the order to do it in

Under the ceiling rather than through it. And the handover was better than
expected: it labelled its own list *"reported by team, not yet build-verified"*,
said plainly that `npx next build` had never been run so the exit code was
unknown, and **found a bug nobody had noticed** — the cart page's empty state
links to `/products`, which does not exist, because products are on `/`. Checked
against the route list: correct. That is precisely the kind of finding the
verification tasks always used to lose.

### A number and a limit, and the third time this rule has been needed

`BudgetTracker.elapsed_sec` subtracts time parked on a question — deliberately,
with two real runs measured at 93% and 90% parked behind it. `deriveVitals`
counted plain wall clock and drew it against that same limit.

So a run parked 58 minutes on an approval read **1:27:47 / 1:00:00**: past its
ceiling, still working, because the number and the limit beside it were
measuring two different things. A third run measured **91% parked** — 146
minutes wall, 133 waiting, 13 working — and was stopped by tokens, not the
clock, which is the backend's arithmetic being right while the screen's was not.

Fixed in the derivation, from the log rather than a new field: the waits are
`agent.request` → `agent.request.resolved`. Re-entrant like the tracker, a
question still on screen counts to now, and a wait that was never answered
because the run was cancelled closes at `mission.ended` rather than growing for
ever over a finished record. The panel says what was taken off, because a clock
that stalls looks broken and one that explains itself does not.

That is the same rule as the token meter counting the four fields the guard
counts, and as "model calls" being kept off the panel entirely. **Anything drawn
as `used / limit` has to count what the limit counts.**

### The scene was captioning a round that had ended hours earlier

`round finished — crashed` over a team three tasks into its next round, with
every character sat down. `sceneState` set `endReason` on `mission.ended` and
never cleared it — and `mission.ended` is the end of a *round*, since a
continued run appends to the same log.

`deriveVitals` had been given exactly this rule a few hours before, for its
counters: **the first event after an ending opens the next round.** Two places
derive per-round state from one log, and only one of them had it. Worth
assuming there is a third.

### Opening a run looked like watching a replay of it

Attaching subscribes from seq 0, so opening a mission that has been going for a
while delivers its whole history — 729 frames on the run this was noticed on —
as one socket message per event. Each one was its own `set`, so 729 renders,
each copying an array that was growing, and the transcript visibly typed itself
in.

React batches updates inside one task; these arrive in a task each. So the
batching has to be ours: frames are buffered and applied together on the next
animation frame. A frame is the fastest anything on screen can change anyway,
and live tokens still land inside one. The fallback is a microtask, for a test
runner and — the case that actually matters — **a hidden tab, where rAF does
not fire at all** and events would otherwise pile up unapplied until someone
looked.

`attach`, `replay` and `detach` throw the buffer away, because frames from the
run you just left must not land on the one you just opened.

### `glob` said a folder was empty when it was not

`**/*.{ts,tsx,json,md}` — the ordinary way to say "the source files", understood
by bash, ripgrep, fd, VS Code and every JS glob library — returned **0 matches**
over a folder holding two `.json` and one `.ts`. `pathlib` does not expand
braces, and the result was not an error: it was a false statement about the
workspace (§1).

What it cost is the interesting part. The agent had just written those files,
was told they were not there, went to `list_dir` a directory at a time, and then
reached for `bash` to run `find` — which raised an approval question, which is
where that run stopped. **A missing glob feature escalated a read to a dangerous
tool.**

`expand_braces` expands, unions the results and de-duplicates. Nested braces
work; an unbalanced one is left exactly as typed, because `{` is a legal
character in a filename and guessing would be worse than matching what was
written.

### An agent that mutates the workspace to diagnose it, and is then cut off

A worker suspected its own code was breaking a build, so it bisected:
`mv components /tmp/components.bak && mv app/admin /tmp/admin.bak && npm run
build`. Correct instinct. Then `tool_rounds_exhausted` stopped it at twelve
rounds — **in the middle of the bisect, with the directories still moved away**.

The next agent read a workspace that was a debugging artefact and reported on it
as though it were the deliverable. The run was recorded `failed` with a summary
saying the build was broken; the build passes. Nothing on the log was untrue,
and the conclusion drawn from it was.

Every stopping condition — `tool_rounds_exhausted`, `task_budget_spent`, the
budget — ends a turn where it stands, and none of them has any notion of undoing
what that turn had temporarily done. A half-written file is visible; a moved
directory is not. Recorded rather than fixed: the fix is either a cleanup
contract for tools that move things, or telling agents not to mutate the
workspace to test a hypothesis, and neither is a small change.

### A framework CLI works, and is cheaper than writing the framework out

Asked directly: can an agent run `create-next-app`, or must it write every file?
It can, and it should.

    npx create-next-app@latest . --typescript --eslint --app --no-tailwind \
      --no-src-dir --no-turbopack --no-git --import-alias "@/*" --use-npm --yes
    -> exit 0, 41 seconds, 344 packages

The model chose every flag itself, from a brief that said only that stdin is
closed. That constraint is the one that matters: `shell.py` passes
`stdin=DEVNULL`, so an interactive prompt gets EOF, and `create-next-app` asks
five questions unless every answer is on the command line. The other two are the
600-second cap on one call (an install takes ~40s, so it fits) and piping the
output through `tail`, since npm's log is thousands of lines and every one of
them is re-sent on the next turn.

Two runs of the same shape, one CLI-first and one hand-written:

    hand-written   605,853 tokens   5/11 tasks   7 files, no page renders
    CLI-first      379,270 tokens   4/5 tasks    scaffold + /admin, build passes

The hand-written run produced `Button`, `ProductCard`, `DataTable`, `Header`,
a data layer and a cart store — and no `app/layout.tsx` and no `app/page.tsx`,
so every route 404'd. Components with no house to live in. The CLI run had a
layout and a page 41 seconds in and spent its budget on the part that was
actually asked for.

**And `--no-git` was ignored.** The CLI initialised a repository and committed.
The agent flagged the discrepancy and said it had *not verified* whether `.git`
existed rather than asserting either way; it does exist. Saying which of two
things you checked is worth more than being right by accident.

### A shell command is grammar, not text

Not the app — a scratch approval script written to watch these runs — but the
same mistake five times, and the app has made it before (`is_secret_key`
matching substrings and redacting `inputTokens`, destroying usage numbers in an
append-only table).

    \bgit\b anywhere      caught `find . -not -path '*/.git/*'`
    split on a bare |     tore `grep -E '"(a|b)"'` apart inside its own quotes
    any > at all          caught `ls >/dev/null`, which writes nothing
    shlex.split           left `sort;` as one word, so `;` never separated
    no substitution rule  `cd "$(rm -rf x)"` hides a command in an argument

Each held a read-only command for a round trip, and the last one was a real
hole. The version that works reads the structure: redirections are judged by
where they point and then removed, `$(` and backticks refuse the whole line,
`shlex` runs with `punctuation_chars` so operators separate from words, and a
word only counts as a command at a position where a command may begin.

### The one thing a background log cannot do is ask

An `ask_user` question sat unanswered while a run was parked, because the
watcher printed it into a file nobody was reading. Printing is not asking.

Which is the same shape as the two failures in the app this week — a question
that outlives the process that asked it needs somewhere to be *found*, and a
run parked for 58 minutes was parked because the card was on a screen nobody had
open. The watcher exits on a question it cannot answer now, because exiting is
what produces a notification.

### The app could not show what a run had made

`artifact.created` was published from **exactly one place in the codebase** —
the `final-answer.md` written when a run completed. So every file an agent
produced was invisible: the Files tab read **Files 0** over a workspace holding
twenty files and a Next.js app that built and served eight routes. All day, the
only way to see what a team had done was Explorer, and the only way to know
whether it worked was to run the build by hand.

A workspace file is **recorded, not copied**. `write_text` puts a file under the
app's own artifact root and owns it from then on; this points at a file in the
folder the user chose, which the agents keep editing and the user can open in
their editor. A copy taken at write time would be a stale duplicate claiming to
be the work, and there would be two answers to "what did this run produce"
(§2.1). The honest cost is a row that can outlive its file, and `read_text` says
so plainly instead of crashing.

Watched in the runner rather than emitted by the runtime, which has no database
and should not grow one: the runner already reads every draft on its way to the
bus, so correlating an `agent.tool.start` with its end by `callId` is the whole
of it. A second write to the same path refreshes the row and publishes nothing
— a timeline saying a file was created four times would be describing four
files.

Reading one back resolves it through `resolve_within` against the mission's own
workspace, the same resolver and the same resolve-first-compare-second rule the
file tools use. A stored path is data, and data that chooses which file to open
is data that has to be checked — this process holds the keychain.

### "Out of budget" was one word for four different problems

Tokens, model calls, graph supersteps and wall-clock time all end a run as
`budget_exceeded`, and every list rendered that as one phrase. Three runs in a
row were stopped by the **clock** and read as having run out of tokens —
including by the person writing them up, who then went looking for the tokens
and wrote a number into this file that had to be corrected afterwards.

The real reason was on the log the whole time, inside the ending's summary
prose. `missions.end_limit` and a `limit` on `mission.ended` put it where a
label can read it: **Out of tokens**, **Out of time**, **Too many steps**, **Too
many model calls** — four different fixes, four different words.

Nullable and **not backfilled**. A run recorded before the column has no honest
value to put there, and a guess written into a column reads as a fact for ever
(§5.1). Those rows keep the general phrase, which was true of them.

### One task can be picked up again without paying for the round

A round that stops early leaves its plan half-executed, and the only way to
retry one task was to run the whole round again. On the run this came from what
was left was `Review pages against component contracts` — a *verification* task,
which is both the kind that gets cut most often and the kind whose absence
matters most, since it is what would have said whether the rest is true.

The blocker was that the instruction existed nowhere durable: the plan message
renders titles and seats, which is what a person needs to approve a plan and not
enough to run a task again. `mission.progress` carries it now, on the `pending`
event that announces the task and nowhere else — bounded by the plan's own task
limit, and on the append-only record where a plan belongs.

The button says what it does: **"Starts a new round with just that task."** It
is not a rewind into the round that stopped, because there is no way to resume
mid-plan, and a label implying otherwise would describe something that does not
happen. `failed` and `pending` are shown as different things, because *ran and
came back empty* needs a different approach and *never started* needs room.

### A continued round could not see the round before it

`make_plan` was handed one message: `Goal: {the new message}`. So "carry on" was
a goal that read, in full, "carry on" — the leader could not see the original
instruction, what the team had built, or **the handover it had itself written
one event earlier**. That last part is the sharp one: the handover names every
file, what is missing and what to do first, it is produced on every round that
runs out, and the only thing that ever read it was a person.

`earlier_rounds` assembles it off `mission_events` — each round's instruction and
each round's ending — and nothing is stored. The log is the record, and a second
place saying what a run achieved is a second place to be wrong: a status file
claiming the admin pages are done, when they were never written, is worse than
no file at all.

The prompt guards both directions, because they fail differently. *Do not re-do
what is already finished* stops the most expensive possible answer, which is the
original plan again. *Do not assume anything is finished that the record does
not say was* stops the cheapest wrong one, where a leader reads "most files are
created" as "done" and plans nothing.

### rAF exists here and does not fire

Opening a run delivers its whole history as one socket message per event — 729
on a real run — and each was its own `set`, so 729 renders over a growing array
and the transcript visibly typed itself in. Batching them is right; the first
attempt at *when* to flush was not.

It used `requestAnimationFrame`, with a microtask fallback for where the
function does not exist. That is the wrong test. In the browser this was
verified in, `requestAnimationFrame` exists, `document.hidden` is false,
`visibilityState` is `"visible"` — and **the callback never fires**. The
transcript stayed empty for as long as it was watched.

Which is `find_shell` again, already in this file: *a shell that exists is not a
shell that runs*. Present and working are two different questions, and only the
second one matters. A frame and a 32ms timer are scheduled together now and the
first to arrive wins.

`replay` does not go through the buffer at all. It has a finite list already in
hand — nothing to wait for, nothing to coalesce — and deferring it was what made
the transcript sit empty on a client where the frame never comes.

### A task could spend the whole run, and the checks were always last

The reading-log build wrote three correct files and then died at
`stopped at the tokens limit (201882/200000) — 1 of 4 tasks done`. The three
tasks that never started were the UI review, the requirements audit and the QA
pass.

That is not a random quarter of the value. **It is precisely the part that was
going to say whether the rest is true**, and it is last in every plan, so it is
first to go every time.

Where the 200,000 went, from the log rather than from a guess:

    call  1  out=21,509  cacheR= 1,536   writing the files
    call  5  out= 2,968  cacheR=11,648
    call 13  out=   303  cacheR=20,864   21k of context for 303 tokens of answer

**79% was `cacheReadTokens`** — the conversation being re-sent on every one of
thirteen rounds, growing as the files it had written accumulated inside it. The
deliverable was 21KB; re-sending it a dozen times was the bill. (Worth knowing:
the guard counts a cache read at the same weight as a fresh input token, so a
long conversation reaches a *token* ceiling far sooner than it reaches the
matching cost.)

`spend_ceiling` gives one turn a limit of its own, and reaching it ends **that
task** the way `tool_rounds_exhausted` does — not the mission. That difference
is the whole fix: `BudgetExceeded` leaves you files nobody checked, a task-level
stop leaves you files *and* three reviewers saying what is wrong with them.

`task_allowance()` is a **floor, not a share**. Splitting 200,000 four ways
would have capped the implementation at 50,000 and produced nothing at all; the
reserve only protects what the queued tasks need to run — 20,000 each — and
everything above that is still available. On the real numbers the implementation
would have had 140,000, which is more than it had spent by the time all three
files were on disk.

The two failures also get different codes. `tool_rounds_exhausted` is an agent
that stopped converging; `task_budget_spent` is one that ran out of money. They
need different answers from whoever reads the log.

**Still open, and the honest larger answer:** `AppBudget`'s 200,000 is not
editable anywhere. A four-task run with a reasoning model writing 21KB is simply
bigger than that default, and no amount of rationing inside the run fixes a
ceiling nobody can raise.

### The rail read 0 tokens under a run that had spent 201,882

Spotted by looking at the screen, not by a test. **Tokens used 0 / 200,000** and
**Replies 0**, three inches above an ending line reading *stopped at the tokens
limit (201882/200000)* — and a timeline row saying *Developer (Dev) used 21,201
tokens on tools*.

`deriveVitals` reset the counters inside its `mission.ended` branch, and
`mission.ended` is the **last event of a finished run**. Everything counted was
wiped one event before anyone could read it. Every finished run in this app has
shown 0 since that reset was written — including several in this session that I
looked straight at and did not question.

The reset itself is right: a round's tokens count against a round's limit,
because continuing a run gives it a fresh budget. It just belongs at the *start
of the next round*, which is where the same function already restarts the clock
— "the first event after a round ended opens the next one". Two halves of one
rule, and only one of them had it.

**Fifteen tests passed the whole time.** Every one of them ended its fixture
before the ending, so none ever saw the reset fire. The three new ones fail on
the old code with `expected +0 to be 1090`.

### A plan cut off three times needs room, not a shorter plan

A five-agent team was given a detailed brief — three files, six behaviours, two
constraints — and **failed all three planning attempts** with *the plan was cut
off before the JSON closed*. The mission never started; nothing but an error
reached the log.

The correction cannot help, and that is the whole point. The tokens went on
reasoning before the first visible character, so "write each instruction much
more briefly" is advice about output the model never reached. Same wall
`MAX_TOKENS_PER_TASK` hit twice, where raising the cap once did not fix it
either.

So the room grows where it was actually needed: `TOKENS_PER_RETRY` adds 8,192
per truncated attempt, and **only** for truncation. A plan rejected for naming a
seat nobody occupies is not short of budget, and on a reasoning model paying for
a bigger one is real money spent on the wrong problem. A plan that fits first
time still costs what it always did.

Re-run of the same brief: planned on the first attempt, and the plan was a good
one — build once, then three reviewers at the same time.

### The medium web build, and what it says about the shape of a run

Asked for a reading log: three files, no build step, no CDN, no account, must
work from `file://`, must not lose data when what is saved is corrupt.

**The code is good.** Checked by driving it, not by reading it: adding, changing
a status from a per-row `<select>`, deleting, filtering, and the counts — all
correct, all surviving a reload. `reading-log.v1` is a versioned key. Feeding it
`{not json at all` and reloading rendered an empty log with no console error,
which is exactly the promise that was made. No `http(s)` URL and no ES module
anywhere, so `file://` really works. It also falls back to memory when
localStorage is unavailable, which nobody asked for.

**And nobody on the team checked any of that.** The run stopped at
`stopped at the tokens limit (201882/200000) — 1 of 4 tasks done. never started:
Review UI/UX of reading log; Audit requirements and data robustness; Run QA
checks on delivered files`.

One implementation task spent the entire 200,000-token budget. The driver is
the tool loop: twelve rounds, each re-sending the whole conversation, and the
conversation contains the files as they are written. 21KB of deliverable is
cheap; 21KB re-sent a dozen times is not.

Two things follow, and the second is the uncomfortable one:

* The new ending line paid for itself on its first real run. Without it this
  would have read "Out of budget" and looked like a finished job with three
  files in the folder.
* **The verification steps are always last, so they are always what gets cut.**
  A run that stops early does not lose a random quarter of its value — it loses
  precisely the part that was going to tell you whether the rest is true.

### Tasks that do not need each other now run together

Work was strictly sequential: task n+1 started when n finished, whatever the two
had to do with each other. *Research A / research B / write it up* spent two
model calls' worth of waiting in a row for nothing.

The decision belongs to the plan, because the plan is the only thing that knows.
Each task may declare `depends_on`, and the field has **three** states:

    absent    after the task before it — what every plan did before this
              existed, and what a model that ignores the field still gets
    []        needs nothing; may start immediately
    ["t1"]    waits for t1

So parallelism never happens by accident. It happens because a leader said two
things are independent, and `plan_waves()` groups by that claim. `MAX_PARALLEL`
caps a wave at three, because every task in one is a separate conversation with
the same endpoint and five at once is a rate limit rather than five times the
speed.

The planner refuses a plan it cannot schedule, with the same validate-and-retry
the seats get: a dependency on a task that does not exist, a task waiting on
itself, duplicate ids, and cycles — **including the cycle a naive check misses**,
where `t1` waits for `t2` and `t2` says nothing and so implicitly waits for `t1`.

**And the plan message says what will run together.** Running two things at once
happens because someone claimed they were independent, and a claim nobody can
read is not one the approval gate can be used to check. A sequential plan says
nothing extra, because there is nothing extra to say.

Live, on a fan-out-then-gather brief: tasks 1 and 2 both `running` in the same
second, task 3 waiting for both, whole run **12 seconds**.

### The leader was choosing assignees blind

The same run gave "create INDEX.md" to the UX/UI Designer, whose tools are
`ask_user, glob, grep, list_dir, read_file, send_message`. It could not write
the file. It spent five turns trying to hand the work on — `implementer`,
`Dev`, `Developer`, `PM`, `Project Manager` — every one refused. The file was
never written and the run still ended `completed`.

Neither half was the model being careless.

**`_roster_text` never said who could do what.** The leader was picking an
assignee from a name and a title. It lists each member's tools now, and the
prompt says the obvious thing out loud: a task that writes a file goes to
someone with `write_file`, they cannot borrow each other's tools.

**And a teammate's name had to be typed in full.** The roster reads
`Developer (Dev)`, so every sensible shortening missed. `Mailbox.resolve` now
tries exact, then prefix, then contains — narrower before wider, so `Dev` prefers
the teammate whose name *starts* with it. The rule that has not moved: two
teammates that both fit still raises `Ambiguous`. Delivering to the wrong person
and telling the sender it worked is the worst failure available here.

Re-run: all three files written, dependencies respected, 12 seconds.

### An ending said why it stopped, never what was left

Asked for a tool, tests for it, and a test run. The leader planned all three
correctly — the plan is on the log, task 2 is *Write unit tests for
summarise.py*. The clock killed the run during task 1, and it ended honestly:
`budget_exceeded`, *stopped at the time limit (1302/900)*.

What it never said was **which two things you did not get**. Both the plan and
the task states were on the timeline, so the information was there; using it
meant reading the log and comparing it against what you had asked for. The way
it was actually noticed was looking in the folder for a test file.

`unfinished_note()` now names them, on every ending and not only on `completed`.
Nothing is judged or generated — the titles and states come straight off
`mission.progress`. Two kinds, named separately because they need different
fixes: a task that **never started** ran out of room, and a task that
**produced nothing** ran and came back empty.

The note goes on the ending, never into `final-answer.md`. That falls out of the
existing gating rather than a new rule: the artifact is only written on
`completed`, and a note only exists when something is unfinished, which forces
`failed`.

**And the shape of the fix broke everything for one commit.** The state map
became `(state, title)`, and `any(s != "done" for s in tasks)` compared a
*tuple* against a string — always true, so every finished mission was recorded
`failed`. Caught by the M6 test asserting a resumed mission completes. The
normaliser is now one function both readers share, which is what it should have
been from the first line.

### The clock was counting the time someone spent reading

Two builds, both stopped as `budget_exceeded` at the 900-second limit:

    Unit price comparer    ran 1314s, 1217s of it waiting for approval  (93%)
    Sales CSV summariser   ran 1302s, 1176s of it waiting for approval  (90%)

The work took **97 and 126 seconds**. Everything else was the mission timeout
running while a `bash` command sat on screen waiting to be read — which is
exactly what the approval gate is for. So turning the gate on made runs die of
the clock, and the harder someone looked at a command before approving it, the
more likely the mission was to be killed for it. A limit punishing the one thing
it should encourage.

`BudgetTracker.paused_for_a_person()` holds the clock across both places a run
stops for someone: a tool approval inside a turn, and `ask_user`. It is
re-entrant, because a tool approval can happen inside a turn that is itself
inside a paused graph, and an inner wait ending must not restart the timer while
the outer one is still open.

**Only the clock.** Tokens, calls and supersteps were spent and stay spent —
waiting does not give any of them back, and a test says so.

### `budget_exceeded` is one word for four different limits

`AppBudget` caps tokens, LLM calls, supersteps **and** wall-clock time, and all
four end a run as `budget_exceeded` — which the sidebar and the header render as
**Out of budget**. Three runs in a row were stopped by the 900-second clock and
read as though they had run out of tokens, including by the person writing this
file, who then went looking for the tokens.

The reason is on the log: `mission.ended` carries *stopped at the time limit
(1234.6/900)* in its summary. It is the label above it that flattens four
different things into one, and each has a different fix — more time, a smaller
task, fewer agents, a bigger allowance.

### One team, two missions at once

Asked whether it works. It does, and the reason is that per-mission state is
keyed by mission id everywhere it matters: the task, the finaliser, the mailbox,
the checkpointer thread, the frozen roster, the budget, the event stream. There
is no team-level guard in `start_mission` and there does not need to be —
`MissionAlreadyRunning` is per mission, which is the thing that actually cannot
happen twice.

Verified rather than reasoned: two runs of the same one-agent team, launched in
the same instant, answered `alpha` and `beta`, both `completed`, 18 events each,
**no event from either appearing on the other's log**.

What is genuinely shared, and worth knowing before running two of anything:

* **The workspace.** Nothing stops two missions being given the same folder, and
  then two agents write the same files. The path is validated, never claimed.
* **Agent memory.** `recall` is scoped to the agent, not the mission, so a note
  written in one run is visible in the other. That is what agent memory *is*,
  but it is cross-talk between runs that otherwise cannot see each other.
* **The budget is per mission**, so two runs is two ceilings — 400,000 tokens,
  not 200,000 split.
* **The provider and the search keys**, so both runs spend one allowance and
  share one rate limit.

`total_missions` was the one thing that could quietly come out wrong:
`total_missions += 1` read the value and wrote it back with an `await` in
between. **Not reproduced** — each session takes its own connection and SQLite
serialises the writes — but it is one `UPDATE ... SET total_missions =
total_missions + 1` now regardless. That number survived the gamification
rollback because it is the one figure on the card that is a fact, and
"probably fine given how the driver happens to schedule" is not the guarantee it
deserves.

### An image cannot reach the round that arrived with it

The first message is what creates the mission, so there is no id to attach to
until the round is already under way — the images land on the *next* one. The
composer says so in its hint and the code says so in a comment, and it is still
the first thing anyone hits: attach a picture, ask about it, and the model
answers that it cannot see an image.

Left as it is for now and written down here, because closing it means either
`POST /missions` accepting attachments or a create-without-starting mode, and
both are bigger than the sentence in the hint. **The vision path itself works** —
that was what this run was testing — and it works from the second message on.

### A local model could not be used at all

`build_from_profile` raised `no_api_key` before the endpoint had any say, and
`needsOnboarding` counted only providers with a key. Ollama and LM Studio
authenticate nothing, so anyone running one was held on the onboarding screen
for ever with a working endpoint already configured — and no error explaining
it, because from the app's point of view nothing had gone wrong.

Whether a key is required is a fact about the endpoint, and the endpoint is the
only thing that knows it. So the client is built either way, with
`NO_KEY_NEEDED` — a deliberately readable string, not a plausible-looking token,
so anyone who sees it in a request knows immediately that none was configured —
and a 401 comes back in the endpoint's own wording if it did want one.

Onboarding is satisfied by `hasKey || verifiedAt`: you supplied a key, or the
endpoint answered without one. Both are established facts rather than a guess
about which endpoints need what.

### "Tried in the order they were added" was never a decision

The fallback chain was `ORDER BY created_at`. That is not an ordering anyone
chose — it is a record of which key you happened to type in first — and the two
stop being the same thing the moment you want the cheaper allowance spent
before the metered one. There was no way to say so.

Migration 0015 adds `sort_order`, nullable, sorting last. A chain nobody has
touched still runs oldest-first, and there is **no backfill**: writing positions
into rows nobody ordered would be recording a decision that was never made
(§5.1). A key added later has no position either, so it falls in behind the ones
someone deliberately arranged rather than jumping the queue.

`registry.search_order()` is the one ORDER BY, used by the runner that spends
the keys and the panel that lists them. Two clauses would be two answers to
"which is tried first", and the one on screen would be the wrong one (§2.1) —
there is a test that reads the chain both ways and compares.

**The endpoint takes the whole chain, not one row's position.** Two reasons,
both deciding: a position is a claim about the other rows, so a per-row PATCH
leaves two keys briefly claiming one place with the runner reading the table in
between; and a partial list has no honest reading — naming two of three says
nothing about where the third goes. So `POST /providers/search-order` refuses
anything that is not a permutation of exactly the configured keys, and says
which ids were wrong.

In the panel it is two menu items, `Try this one earlier` / `Try this one
later`, disabled at the ends with a hint saying why rather than a dead row.
Keyboard-reachable for free, which a drag handle would not have been.

### Two engines, several keys

"Should we just fix it to these two?" is half right. The engines *are* fixed:
Brave and Tavily are the two APIs this build has adapters for, and a third means
writing one. What is not fixed is the number of **keys** — a second free account
of either is exactly what the fallback chain is for, and that was already built.
The button said "Add another search endpoint", which is what made it look
otherwise. It says "Add another key" now.

The section stopped being cards with it. A card says "a thing on its own", and
these are one ordered chain: tried top to bottom, and the only reason to have
two is that the first runs out. So a numbered list with hairlines, the position
drawn as the number it is, and "Test connection" on the surface with the two
things nobody does twice a year behind `⋯`.

### Every menu in the app opened the wrong way

`align === "end" ? "left-0" : "right-0"` — backwards. `end` means the panel's
end lines up with the trigger's, so it should grow *leftward*. Every menu had
been growing rightward from its trigger, and it was invisible for as long as no
trigger sat near the window edge. The search list's `⋯` does, and half the menu
was outside the window with a horizontal scrollbar underneath it.

`TeamsPanel` had `align="start"` on it, which cancelled the bug out. That is the
tell worth remembering: **a lone override of a shared default is usually
somebody working around it**, not a local preference.

**And fixing the direction was only half of it.** The composer's autonomy menu
sits 16px from the left edge of `main`, which is `overflow-hidden`. Opening
leftward — correct — a 362px panel started at x=12 and everything left of the
column edge was cut off: two items visible as slivers, mid-word.

Two causes, both fixed in `Menu` rather than at the call site. The panel had a
`min-w` and no `max-w`, so one long `hint` stretched it to whatever the text
wanted; it is capped now and hints wrap. And the vertical flip — measured, not
assumed, since M10 — had no horizontal twin, so it flips sideways too.

The bound for that is the nearest **clipping ancestor**, not the window. The
panel was comfortably inside the viewport the whole time; `main` was doing the
cutting, three levels up, and a viewport check would have found nothing wrong.

### Providers is two lists with the same manners

Models followed the search keys out of their cards, and for the same reason:
the rows relate to each other. One model is the default a new agent is created
with and the rest are alternatives to it, which a border around each one hid.

Making them radio rows fixed something the cards had been quiet about. Clicking
a card highlighted it and never said what that *meant* — the selection is "this
is what a new agent gets", and the row says so now instead of leaving a blue
border to be interpreted.

Capabilities are read from the stored profile rather than from the last probe,
so they survive a reload and are what an agent will actually be run against.
An endpoint nobody has tested shows none, because none was recorded — an
"unknown x3" row would be our own ignorance dressed as data (§1.1).

**And the two "add" buttons became one component.** They had drifted into a
filled button in the Models header and a bare text link at the foot of the
search list: the same job, in the same page, looking like two different kinds
of thing. Both sit at the foot of the list they add to now, which is where the
list ends.

### A panel with nothing in it is a column of window spent on an instruction

The right panel was rendered on Roster, Teams and Settings — where "This run"
means nothing — and on the launch form, where it read *"open a run to see who is
on it"*. Both things it can hold belong to a mission that exists: the terminal
runs in one's workspace, the summary is one's members and budget.

So it is absent on those pages, and absent before the first message creates the
row. The mode is remembered rather than switched off, so it comes back with the
run. On a draft the two header buttons are disabled and say *available once the
run has started*, which is the same sentence the empty panel was spending a
column to say.

### The one screen where a limit is chosen knew nothing about what runs cost

`AppBudget`'s ceiling is typed into a box beside a team that has, on this
machine, spent **23,538 tokens** on one job and **1,262,610** on another. Fifty
times apart, and the form knew neither number.

`GET /teams/{id}/history` is the record, and it is deliberately **not** a
forecast. There is no honest way to estimate a run before it happens (§1.1) and
no provider will say, so what is shown is the last five endings: title, tasks
done out of planned, tokens, and which limit stopped it.

The tokens are counted off `mission_events`, adding the same four fields
`BudgetTracker.record_call` adds — **including cache reads, which are 79% of a
long run**. That rule has now been needed four times in this file, and this is
the first place it was applied without first shipping the wrong version.

`tasksDone/tasksTotal` come back `null` for every run recorded before migration
0018 and are not backfilled. Those runs were not counted at the time, and a
number invented for them would read as a fact for ever (§5.1).

### A model can staff a team. It cannot say whether the team will work.

Two features, and the line between them is the whole design.

`POST /teams/suggest` reads a brief and staffs a team **from the agents that
already exist** — who leads, who sits where, and which tools each person is
missing for this particular job. It saves nothing: the proposal fills in the
seats and the user saves, exactly as §11 requires of a generated profile.
`POST /teams/{id}/review` reads a team against a brief and returns prose.

Neither is allowed to say a team is ready. **The validator is still the gate**,
and the reason is a bug this project shipped: a research team carrying
`web_search` and `web_fetch` ran to completion and answered from memory,
because the tools were on the **leader**, and a leader with workers is never
assigned a task. A model looking at that roster sees every tool present, on a
real member, spelled correctly.

So both endpoints run `validate()` over what they are discussing and return its
findings under their own key, and `TeamAdvisor` renders them under their own
heading — *"What the run gate says about it"* — never merged into the model's
list.

**Then the app demonstrated its own argument, live, twice.** Asked about `Desk
Research`, a real team on this machine:

    the model   "Yes — Wren can research SQLite concurrency via the web tools"
    the gate    "Only Wren carries web_fetch, web_search, and the leader of a
                 team with workers is never assigned a task"

Wren is the leader. Asked the identical question a second time, the same model
on the same team got it right — *"the only research path requires Wren to act
as a worker, which her leader role rules out"*. That inconsistency is the
argument in one line: **a check that is right most of the time is not a check**,
and it is why the model composes and a rule decides.

The suggestion path found the same thing from the other direction. Given a
research-and-write brief it proposed a sensible four-person team and added
`web_fetch` to the QA engineer — who already carries `bash` and `write_file` —
and `web_and_write_in_one_agent` fired on **the model's own addition**, which
the model had not mentioned. The gate is not only catching what a model missed
about an existing team; it is catching what a model just did.

Three smaller decisions that had to be made along the way:

* **A note has a `kind`, never a `severity`.** A `warn` from a model would sit
  in the same list as a `warn` from `validator.py` and be read as the same kind
  of claim. An unrecognised kind arrives as a plain `note` rather than being
  dropped — §8, applied to a model instead of to a wire format.
* **Added tools become a per-team `tool_subset`, not an edit to the agent.**
  That agent is on other teams, and "this work needs grep" is a fact about this
  job, not a permanent change to somebody's toolbox (§5.1).
* **The proposal is validated as it would run** — each member's tools *after*
  the additions — because that is the team the user would launch.

### The default endpoint was a search key, and had been for months

`POST /teams/suggest` failed on its first run in the app with
`no provider registered for 'search'`. Not the new code: `settingsStore.load`
chose the active endpoint as `providers.find((p) => p.hasKey)` — the first
profile with a key of **any kind** — and on this machine Tavily was configured
before DeepSeek.

So `activeId` has been a search endpoint here for as long as both have existed,
and every "generate a profile" in the agent creator defaulted to an endpoint
that cannot complete anything. Nobody noticed because the dropdown is right
there and gets changed by hand.

The store's own `needsOnboarding` draws exactly this distinction, correctly,
**on the line directly above**. Two readers of one idea and the one nobody was
looking at was the wrong one (§2.1). `pickActive` is now the single answer, it
re-checks a stored id rather than trusting it — a machine that ran the old build
has a search profile saved — and six tests cover it.

The same session's second version of that mistake: `TeamAdvisor` held the
chosen provider in `useState(activeId ?? usable[0]?.id ?? "")`, which runs once,
while the store is usually still loading. The selection is derived from the
list now, so the two cannot disagree — the fourth time this file has recorded a
value that went quietly stale.

### One violet, and what it is not allowed to say

Two places ask a model to fill in a form — the agent creator drafts a
character, the team builder staffs a team — and both had the same shape of
problem: press a button, nothing changes for between five and forty seconds,
then a form is suddenly full of text with nothing saying where it came from.

The treatment is a gradient border that runs from the accent that already
exists to **one new hue**, and that hue means exactly one thing: *a model wrote
this and you have not checked it.* It is the visual form of a sentence the app
already prints — "nothing is saved until you press Save" — which is why it has
to *leave* when the thing is saved or edited by hand. Same discipline
`--color-attn` is under, and for the same reason: a colour spent on decoration
stops meaning anything, and then the one time it matters nobody reads it.
`themeTokens.test.ts` fails the build if `--color-ai-*` appears in any file but
`AiPanel.tsx`.

Four states, each of which also changes something with a **shape** — the word
in the header, the button label, a rule down the side of a field — because
colour alone is never a status (§18.3). Only `working` moves, and `working` is
the only one that is temporary: an effect that runs all day is one nobody sees
on the day it means something.

### The step captions were the tempting part, and they would have been invented

*Reading the brief → drafting → choosing an avatar → writing the system prompt*
is what the mockup had, and it is the obvious thing to put in a forty-second
wait. It is also fiction. `POST /agents/generate` returns one JSON object at
the end; nothing streams, and the backend reports no progress at all. A bar
walking through four captions would be the screen narrating work it cannot
see — the same reasoning that keeps a "model calls 18 / 60" row off the budget
panel (§1.1).

What is drawn instead is an indeterminate bar, which claims that something is
running and no proportion, and **the elapsed second**, which is real and is
what actually answers the question a stalled screen provokes: *is this stuck,
or is it thinking?*

And the one piece of progress that **is** real gets reported: `attempts` and
`recovered_from`. On the run this was verified with, a 40-second wait explained
itself — *"The model needed 2 attempts. What was corrected: the reply was cut
off at max_tokens before the JSON closed"*. A caption would have said
"drafting" for those forty seconds and told nobody anything.

### Cancel has to abort, not tidy up

A model that hangs for sixty seconds behind a screen with nothing to press is
worse than not having the feature — and hiding the spinner while the fetch
carries on is worse still, because the reply then lands on a form the person
has moved on from. So there is an `AbortController` per run and the button acts
on it.

Two things had to move for that to be honest. `request()` retries and then
throws *"the backend is not reachable"* on any network-level failure — and an
abort rejects exactly like a dead host, so pressing Cancel reported the machine
as gone. It rethrows an aborted request untouched now. And the `catch` in each
caller returns early when the signal is aborted, so the fetch's wording never
overwrites the sentence the person's own button already wrote.

### `overflow: hidden` is not "clip", it is "clip and make it scrollable"

The gradient border is a 1px padding box with an opaque inner panel on top, and
the rotating conic gradient sits at `inset: -45%` so it still covers the corners
as it turns. That combination has a trap in it, and it took a measurement
rather than a guess.

`overflow: hidden` makes a box a **scroll container**. The `::before` hanging
45% above the top gave that container something to scroll to — and then any
focus change inside it, the Generate button going disabled being quite enough,
made the browser scroll the nearest scrollable ancestor to keep the focused
thing in view. The *panel* scrolled: the opaque inner box slid 151px up and the
gradient showed underneath it as a solid block.

Reading the CSS would not have found it, because nothing in the CSS is wrong.
`scrollTop: 151, scrollHeight: 575, clientHeight: 397` on a box nobody had
scrolled is what found it. `overflow: clip` clips without creating a scroll
container, which is the one thing that was actually wanted.

**And the test for it nearly passed over the bug**, because the rule's own
comment names the thing it warns against — `not.toMatch(/overflow:\s*hidden/)`
matched the explanation. Comments are stripped before the assertion reads the
declarations. Matching prose is not reading the CSS.

### What the mockup asked for and did not get

A **streaming** state, where fields fill in one at a time. Nothing streams, so
staggering them would be a reveal animation dressed as an observation. The
stagger is kept — the eye needs to see what changed — and the comment says
plainly that it claims nothing about the order the model wrote in.

The **reduced-motion** block, which the mockup would have added to. This file's
blanket rule sets `animation-duration: 0.01ms`, and on an *infinite rotation*
that is not "stopped", it is a strobe. Every animation here is declared inside
`@media (prefers-reduced-motion: no-preference)` instead, the same way
`fish-bite-*` already was — while the working state's `opacity: 1` stays at the
top level, so the motion is optional and the state is not.

`--color-ai-ink` measures **7.20:1** on white and **7.45:1** on the dark panel,
so unlike `--color-accent-bright` it is safe on type. Checked, not assumed.

### One question, four answers, and the one on screen was the wrong one

The agent creator's "Generate with" dropdown listed **Tavily** and **Brave
Search**. Neither can complete anything: picking one fails the generation with
`no provider registered for 'search'`. Found by opening the list and reading it.

`providers.filter((p) => p.hasKey)` — wrong in both directions at once. It
offered the search keys, which are providers with keys, and it hid a local
Ollama or LM Studio, which authenticates nothing and therefore has no key to
have. Both of those exact mistakes are already written up in this file, one of
them in the entry immediately about `activeId` and the other about onboarding.

So the count matters more than the bug: **"which endpoints can something be
generated against" had four implementations** — `pickActive`, `needsOnboarding`,
`TeamAdvisor` and `AgentCreator` — and the two nobody was looking at were the
two that were wrong. `chatProviders()` is the one answer now, and the other
three are built on it. §2.1 has been recorded here for `can_run`, `lookFor`,
`activeId` and `search_order`; this is the same shape at four copies rather than
two, which is what happens when a rule is right in the place you keep reading.

### A generated name has to fit the cat, and not be somebody

Two halves, and only one of them is a prompt.

Every character is drawn as a cat, so the name sits on one whether or not
anyone thought about it. The prompt now says so and asks for a name that works
for a cat *and* a colleague — Pepper, Juniper, Moss — while `title` and `role`
stay entirely serious. Explicitly not the joke version: a team of Whiskers and
Miss Paws is not a record of who did what.

The duplicate rule is a **check**, because a prompt is a request. This project
has already paid for the difference: the generator named two different agents
"Mara", `send_message` addresses teammates by name, and one of them would have
received the other's mail with the sender told it worked. The gate for that
landed in `validator.py` and refuses the *team* — which is the right place for
it and arrives late, after both agents are saved and seated. `taken` is checked
where the name is invented, using `_norm` — the same `strip().casefold()` the
validator uses, so the two cannot disagree about what "the same name" means.

A clash is a correction rather than a failure: the model keeps everything else
and moves one field. Archived agents count as taken, because they are still in
the roster list and can be restored.

Verified live: asked for "a research scout who reads pages carefully instead of
trusting snippets" against a roster holding Wren (Research scout), it returned
**Clove**, Research Scout, on the first attempt.

### The composer's `+` had one item and two invisible ones

`/` and `@` work and are findable only by knowing to press them, which nothing
on screen says. That is a discoverability gap, not a missing feature, so the
fix is a menu rather than more code: `+` is a `Menu` again with three rows —
a file, a command, a teammate — and the row's icon is **the character itself**,
so pressing it once teaches the key for next time.

Both typed forms parse only from the **start** of the line (`menuFilter` and
`nameFilter` read the whole raw string), so both rows go dead once there is
anything in the box: taking it over to insert one character would throw away
what was being written. `@` also needs a run in progress, the same condition
`whoFilter` uses, so the row and the menu it opens cannot disagree about
whether there is anyone to address.

**And the reason a dead row gives was being cut off.** `MenuItem.hint` exists
to say *why* something is disabled, the panel has a `max-w` whose comment says
"hints wrap instead" — and the span had `truncate` on it. So the one row with
something to explain was the one row you could not read it on. A label may
truncate; a hint that ends in an ellipsis has failed at its only job.

### Three things on screen that were true and said nothing

Removed rather than fixed, which is the harder half.

**`open_desks` under every team name.** It printed the layout *id*, which is an
internal string nobody chose by that name, and there are two layouts with
everything defaulting to one — so seven cards in a grid carried the identical
word. A field earns a place on a card by *differing between cards*; this one
taught the reader that the second line is never worth looking at.

**`round finished — completed` floating over the scene.** The same sentence was
already in the mission header, beside the run's own title, and on the timeline
in its proper position on the log. The floating copy was the one with no
context — and it is the copy that got the M10 bug, captioning a round that had
ended hours earlier over a team three tasks into the next one. `endReason` is
still derived and still sits everyone down; what is gone is a third surface
repeating it.

**The avatar at the bottom of the agent editor.** You typed a name, scrolled
past the system prompt and thirteen tools, and only then found out what you had
been naming. It sits above the name field now, which makes the two one decision
— and is the same reason the generator was told about the cat.

### Six warnings that are one fact

`tool_uncovered` fires once per tool the team does not carry, so a two-person
team holding four of thirteen tools produced six lines of *"Nobody on this team
carries X"* — and pushed `leader_only_tool`, the finding that mattered, into
seventh place.

They are one line now, naming all six, with everything specific above them and
errors above warnings. Not hidden: the same information, stated once, because a
tool the work does not need is not a problem and six lines saying so is how a
reader learns to skim the list that also contains the real one.

### `100vw` is wider than the window

Reported as "the page scrolls sideways into nothing". Both halves of it came
from one wrong unit. The app shell was `h-screen w-screen`, and **`100vw`
includes the vertical scrollbar** — so the shell was exactly one scrollbar wider
than the space it had (1697 against 1687). That produced a horizontal
scrollbar, which took 10px of height, which made `100vh` taller than the
visible area too. One wrong unit, both axes.

`h-full w-full` instead: the parent is `#root`, whose content box excludes the
scrollbar, which is the measurement that was wanted all along.

The second half is `overflow: hidden` on `html, body, #root`. **The document is
not a scrolling surface in this app** — every scrollable region is a panel
inside a fixed frame — and without saying so, anything that briefly overflows
leaves the *document* scrolled. What you see then is the app sitting above a
tall grey void, because whatever caused it has already gone. The scroll
position outlives its content, which is why hunting the "tall element" found
nothing: `scrollHeight` was `scrollTop + clientHeight` and there was no element
there at all.

### One box, two meanings

`/` in the composer is not a shortcut for typing. It is the app's own menu,
which is why Claude Code has one — a terminal has no menu bar, no sidebar and
no buttons, so `/` has to be all three. This app *has* those, so copying the
list wholesale would have meant rebuilding the existing menus inside a text
box. `/config`, `/model` and `/usage` were rejected on exactly that ground:
they already have screens, and a second way in is a second thing to be wrong
(§2.1).

What was worth taking is the shape, for three things that had no control at
all. Each one already existed as a mechanism with no way in.

**`@Name`** — `runner.note()` posted to `mailbox.recipients()`, meaning
everybody, while `Mailbox.post(recipient=...)` has taken a single recipient
since M8. So noticing that one agent was going wrong meant telling all four.
The name is resolved by the same `Mailbox.resolve` an agent's `send_message`
uses — exact, then prefix, then contains, and `Ambiguous` rather than a guess.
`to` goes on the event, because a note that reached one person and reads as a
broadcast is the timeline being untrue about what happened.

**`/plan`** — `_run_team` has taken `require_approval` since M6 and only
`start_mission` ever passed it. So the plan gate was something you could ask
for once, at launch, and never again in that conversation — while the plan is
the one point where stopping still saves the cost of the work. `/plan` on a
continued round now gates it. It cannot turn the gate *off*: nobody types a
command to get less of a safety check.

**`/fork`** — the roster snapshot has been copyable all along. Continuing
appends to a conversation and cannot be taken back; starting fresh forgets the
team and the workspace. "Run that again but let the designer do it" fell
between the two. The snapshot is **copied, not re-resolved**, because the point
of a fork is to compare two attempts and re-reading the agents table would let
them differ in ways neither record mentions.

**The rule that makes it safe** is in `commands.ts` and is a negative one:
*only a command this build knows is a command.* `/usr/local/bin is missing` is
an ordinary sentence and has to reach the team. There is no unknown-command
error anywhere, by design — a composer that refused that line would be
withholding something the person plainly meant to say, and they would read it
as the app being broken. The same rule covers `@`: a name is only a name when
one was given, and whether it matches anybody is `Mailbox.resolve`'s answer,
never a second copy of that check in the client.

And the intent is stated **before** Enter, not implied by a slash: *"/plan —
the app does this, nothing is sent"*, or *"Only Wren will read this"*. The
whole risk of putting commands in this box is meaning one and getting the
other, and one of the two costs money and reaches four models.

### `/rewind`, and the limit it has to say out loud

Everything for this existed except the operation: `file_versions` keeps what
each file held after each write, the Files tab diffs them, and the log is
addressable by seq. What was missing was **undo**.

The plan is fetched and shown first, always, because of what it cannot do.
`FILE_TOOLS = ("write_file", "edit_file")` is what the runner records, so a
file `bash` created or moved has no stored copy. That is not a footnote — the
case in these notes, an agent that ran `mv components /tmp/components.bak` to
bisect a build and was cut off mid-bisect, is precisely the one this **cannot**
fix. Discovering that from a half-restored workspace would be the worst way to
learn it.

A rewind is itself a change, so the file as it stands is recorded as a version
first. It is therefore undoable by rewinding again, and it appears in the Files
tab as what it is — an entry attributed to nobody, because no agent wrote it.
Proved on the real `Diff check` run: `alpha/BETA CHANGED/gamma/delta` → rewind
to seq 20 → `alpha/beta/gamma` → rewind to seq 47 → back again, with
`rewind-before-20` and `rewind-20` on the history in between. Then again
through the UI, which is where the `label` bug above surfaced.

A file created *after* the chosen point is reported and left alone. Deleting
something we have no copy of is not an undo, it is a second kind of loss.

### Three bugs the real data found that the tests had not

**A naive timestamp is read as local time.** `_epoch` exists because
`DateTime(timezone=True)` is a no-op on SQLite, so both the event and the
version come back naive — and `datetime.timestamp()` on a naive value uses the
machine's zone. On this one that is UTC+7, so the comparison was seven hours
out and the first rewind restored files it should have left alone. Third time
in this project: `_wire` in M1, `as_utc_iso` in M10, this.

**One file offered three times.** `seen` was keyed off the `newest` dictionary,
which only gains a path that *has* a version early enough — so a file whose
every version came after the cutoff was appended once per version. A run that
wrote `NOTE.md` three times offered `NOTE.md` three times. Found by pointing
the endpoint at a real run, not by a test.

**The envelope nests under `draft`.** `pointsFrom` read `ev.type`, got
`undefined`, matched nothing, and reported "this run has no recorded file
changes" over 48 events and three saved versions. No crash, no error — the same
shape as the watcher script in these notes that missed an approval for forty
minutes.

**And then the same function did it again, with `p.title`.** The field is
`label`; `title` does not exist on `mission.progress`. So after the envelope
was fixed the dialog offered exactly one point — the round's message — and
silently dropped every task. Two wrong field names in one function, both
producing an empty list rather than an error.

The part worth keeping is why the test did not catch it. `rewindPoints.test.ts`
was written at the same time as the code, from the same assumption, and its
fixture said `title` too — so it passed over code that dropped every task.
**A test written from the same guess as the code proves nothing.** It is built
from a real run's payloads now, copied off the log rather than typed from
memory, and the schema is the authority for what a field is called.

### Two dev launchers, and the duplicate-module symptom again

`TimelinePanel` threw duplicate-React-key warnings and `RewindDialog` read an
**empty** `eventStore` while the transcript beside it rendered fifty rows —
same selector, same store, two different answers. CLAUDE.md already records
this: Vite serving two copies of a module is two zustand stores, and it looks
exactly like a bug in the code just written.

The cause this time was two `node scripts/dev.mjs` processes running at once —
and four backends under them. Worth knowing that the symptom of that is not
"port in use", which the launcher handles, but **a UI that disagrees with
itself**. The tell was the tab label: `Timeline 0` beside a transcript
rendering fifty rows, and `Timeline 48` the moment one launcher was left.

### `/fork`, and what a fork must not re-read

Verified against `Diff check`: the fork ran, wrote `HAIKU.md`, and ended
`completed` 2/2 — while the original kept its 95 events, its own ending and its
own counts, untouched. `forkedFrom` is on the new run's `mission.started`, and
`roster_snapshot` compares **byte-identical** to the parent's.

That identity is the whole point rather than an implementation detail. A fork
exists to compare two attempts, so the roster is copied rather than resolved
again from the `agents` table — otherwise an agent edited between the two runs
would make them differ in a way neither record mentions (§5.1). The workspace
is *shared*, and that is stated rather than hidden: two runs pointed at one
folder write the same files, and nothing in this app has ever claimed a path.

### Picking a name from a list, and the bug that only picking could find

`@` opens the roster the same way `/` opens the commands, because a teammate's
name is not something anyone should have to remember exactly: this machine's
roster reads `Developer (Dev)` and `Tester (QA Engineer)`, and while
`Mailbox.resolve` accepts a prefix, a name that fits two people is refused, so
guessing has a real cost.

The two menus are **two components**, not one with a flag. Their footers make
opposite claims — *"these are things the app does, they are not sent to the
team"* against *"sent to this teammate only"* — and that sentence is the entire
reason either menu exists. A conditional there is a conditional in the one
place that must never be wrong.

**And the picker immediately broke the parser.** `NAME` was `^@([^\s]+)\s+…`,
which stops at the first space — fine for a hand-typed `@Dev`, and wrong the
moment the list inserts `@Developer (Dev)`: the recipient came out as
`Developer` and **`(Dev)` was left at the front of the message the agent would
read**. Nothing in the bare-word tests could have shown it; it took picking a
name off the list and looking at what came out.

Real names are matched first now, longest first, and a name with *nothing*
after it is treated as an address half-typed rather than as a message — because
otherwise `@Developer (Dev)` on its own reads as "(Dev)", said to Developer,
which is a message nobody wrote.

### A count worth showing is a count that fell short

The sidebar printed `2/2` on every finished run. That is the ordinary outcome,
so a column of it down the whole list makes the one row saying `1/4` **harder**
to find, not easier — the same reasoning that folded six `tool_uncovered` lines
into one. The badge now appears only when a run did not get through what it
planned. A run recorded before the counts existed still shows nothing at all,
because "0 of 0" is a different claim from "nobody counted" (§5.1).

### `@Name`, on a live run

Verified against a running mission rather than argued from the tests. The
composer said *"Only Dev will read this"* before Enter, and the log carries it:

    seq 49  -> everyone               "Write a file called STORY.md ..."
    seq 51  -> Developer (Dev)        "keep every line under 40 characters."
    seq 58  -> Tester (QA Engineer)   "check the line lengths"
    seq 59  -> Tester (QA Engineer)   "and the file name"

Three different match rules on one team: `@Dev` by prefix, `@QA` by contains,
`@Tester` by prefix. `@Nobody` answers 404 with the three real names, because
"no such teammate" is not something a person can act on.

The private note was obeyed — every line Dev wrote came in at 33-38
characters against a 40 limit — though that is corroboration rather than proof,
since a model might write short lines anyway. What is proof is the `to` on the
log and the mailbox tests underneath it.

### The cat office, and the number that decided its shape

`body 5 x hair 8 x outfit 8 x palette 8` is **2,560 characters**. Nobody draws
2,560 cats, so the first question was not what they look like but which slots
cost artwork.

Two of the four already cost none, and had since M5 without anyone noticing it
was load-bearing: `BODIES` was a pair of scale multipliers and `PALETTES` a set
of colours. So `build` is a transform and `palette` is a tint, leaving `coat`
and `outfit` as one overlay layer each over one base cat — seventeen rows of
art instead of 2,560 characters. The sprites are drawn in **white and greys**
because a Pixi tint multiplies: white takes the palette exactly and grey keeps
its shading proportional to it.

M5 promised this: *"Swapping in artwork later replaces `ActorView.redraw`, not
the data path."* It held. `sceneState.ts`, `poses.ts` and the stage were not
touched.

### The catalogue was rewritten, and the record was not

New slots (`build`, `coat`) and new values, so every agent created before this
held a config the validator refuses — which matters because `AgentService`
re-checks on **edit**: without a migration, opening any existing agent and
pressing save would fail on an avatar nobody had touched.

Migration 0019 maps the `agents` table one-to-one, deliberately: a mapping that
collapsed several old looks onto one cat would make agents that were chosen to
look different start looking alike, and the person who chose them would have no
way to tell why.

**`missions.roster_snapshot` is not migrated.** It is the record of what a run
used, and rewriting it would make a finished mission claim a look it never had
(§5.1). Replaying an old run therefore hands `body: "slim"` to a build that has
no such slot, and `lookFor` falls back — this build honestly saying it has no
art for what was recorded (§8). What survives is what the two catalogues happen
to share: `blazer` is still a blazer on a cat, and the test says so.

`validate_avatar` refuses the old shape outright rather than translating.
`migrate_avatar` is the only thing that translates, and it runs once, in a
migration, over rows nobody is editing.

### Props are a fact, and they made a bug visible

What is on a desk comes from the tools that member carried **on that run**, off
the frozen snapshot. That makes the room checkable: the research team that
answered from memory had `web_search` on its leader, and a leader with workers
is never assigned a task — with props you can *see* it, because the satellite
dish is on the desk nobody works at.

**Three slots, fixed priority.** Tester carries eleven tools, which is six prop
groups, and a desk with six things on it says less than one showing the three
that set this cat apart from the one beside it. Fixed rather than computed from
the team, so an agent's desk looks the same on every team they are on.
`send_message` gets no prop at all: everyone has it, so drawing it would spend a
slot to say nothing — the same reason six `tool_uncovered` lines became one.

Iris and Pell get bare desks, which is true of them.

### Seat 0 is the head of the table

Every arrangement is now a table with the leader at the head and the workers
down the two sides. That is not decoration: seat 0 is the leader, and the
leader is the one member the orchestrator never assigns a task to, so "who is
in charge here" is a fact about how the run will behave. A row of identical
desks was the one arrangement that could not show it. The generated fallback
for an unknown layout follows the same shape, because that fact does not depend
on which layout somebody picked.

### Dusk and afternoon

The first warm palette was all brown and read as *hot*. Two themes now, and the
dark one is the better idea: **dusk, not night** — a deep blue outside the
window and warm lamplight inside it. Cool ground, warm accents, which is what
stops the app reading as either cold or overheated. Light is the same room in
the afternoon: warm paper, brown ink, the same orange accenting.

Three choices, not two. "Follow the system" is the default and is a different
statement from "dark" — someone whose laptop switches at sunset has said
something, and pinning dark on first run would override it.

**The scene reads the stylesheet.** Pixi takes numbers and the theme lives in
CSS variables, and there is one honest way to keep them together: ask the
document. `--room-floor-a` and the rest are declared beside the DOM's tokens
and resolved at draw time, because a second table of hex values in TypeScript
would be a second answer to "what colour is the floor" — the mistake this
codebase has already made with `activeId`, `can_run` and `lookFor` (§2.1).

### Three bugs between a correct scene graph and a black rectangle

Everything drew and nothing appeared, and each layer of that took a different
kind of looking.

**The sheet lost a race.** `loadCats().then(refresh every actor)` refreshes
`this.actors`, which is **empty at mount**. When the sheet arrived after the
first render every actor had already given up, and a finished mission produces
no second state to try again with. It re-renders the last state now — the M7
bug ("the scene only drew when something changed") in a new place, and the same
fix: keep what you were asked for and draw it again when the thing you were
missing turns up.

**The camera only moved on the ticker.** `step()` is what turns `cameraWant`
into `world.position`, and the ticker is stopped whenever the scene is not
animating — which includes a background window. So opening a finished run in an
unfocused window drew the room correctly at world (0, 0): desks, cats, captions,
all of it just off the top-left corner.

**And Pixi renders on the ticker too.** A stopped ticker means a scene graph
that is entirely correct and never painted. That is worse than a crash, because
every check downstream reports success — `world.children` was 4, the desk
measured 130x75, the figure held three sprites, and the canvas was blank.

The thing that finally found it was measuring the graph instead of reading the
code: bounds of `(-73, -72, 145, 146)` on a canvas whose camera sat at the
origin says exactly one thing.

### `Assets.load` is not `fetch`

The sheet loader read `data.frames` off what `Assets.load('cats.json')`
returned. Pixi recognises spritesheet-shaped JSON and hands back an
already-parsed `Spritesheet`, so `frames` was undefined, the `try` threw, and
the catch turned a working sheet into "no art" with nothing on the console.

The catch is right — a missing texture must not take the timeline down — which
is exactly why the thing inside it has to be narrow. It uses `fetch` now.

### What Aseprite writes, and what Pixi reads

They are not the same key. Aseprite exports `meta.frameTags`, a list of index
ranges; Pixi looks for `animations`, a map of names to frame names.
`sheet.ts` converts one to the other, and that adapter is the whole reason
`File > Export Sprite Sheet > JSON Data` drops in with nothing to post-process.

`scripts/gen-cats.py` writes the identical shape, so the placeholder art is
replaceable by exporting over it. It draws programmer pixel art and looks it;
the point is that the atlas, the layering, the tinting and the timing are
already right, so the only thing left to judge is the drawing.

`nearest` on the texture and `antialias: false` on the app. Pixel art scaled
with the default filter is the kind of wrong that looks like a bad drawing
rather than a bad setting.

### The furniture floated, and the fix was to stop assuming where its feet are

The bookcase hung a hand's width above the skirting. Not a placement bug: the
piece was *drawn* in the room's own 2:1 projection, base sloping up to the
right like the wall it stands against, and a sprite's default anchor is the
**canvas's** bottom-centre — six to eleven pixels below the drawing's real
base. `roomArt` now reads each picture's pixels once and finds its **foot**,
the lowest ink row, and that point is what gets set on the floor. A redrawn
piece brings its own foot with it. Flat-bottomed pieces (a pot, a stand) are
set half their width into the room, because a flat base centred on a sloping
line has half of itself over the wall.

### The camera frames the floor now, and the room is a grid

Two requests from the artist, one cause. The default view was a fit of the
whole drawing, walls included, in a pane that is always wider than tall — so
the desks were small and half the pane was wall and page. And an eight-seat
room drawn as two long rows put every desk in a narrow band down the middle
of a diamond floor with the front half empty.

`aim()` fits `floorBounds` — walls run off the top, and zooming out brings
them back — and is allowed above 1:1, since the art is sampled nearest and
magnifies clean. The arrangements are grids three tiles apart, sized to the
seats so `floorExtent` draws a floor that is as big as the desks and no
bigger; the eight-seat room is a ring round an open middle. The leader is
still the one desk at the far corner. `WALL_H` went to 4.5 tiles, and the
decor is measured in tiles rather than as a share of the wall so that raising
one did not grow the other.

Found on the way: **a resize never re-fitted.** `aim()` only ran inside
`render()`, so closing the right rail left a room sized for a 270px column in
the middle of a 625px one until the next event. The `ResizeObserver` renders
the last state now. And the dev handle `__PIXI_APP__` was being set by
whichever mount finished last — under React's double-mount, the cancelled one
— and then deleted by its own `destroy()`. It is set by `expose()`, called by
the owner on the instance it kept.

### The desk shows use, not possession

The three props per desk from the frozen roster are gone, at the artist's
request: the desk shows **the tool being used right now**, playing its
drawn frames, and is bare otherwise. That is derived like everything else —
an `agent.tool.start` whose `callId` has no `agent.tool.end`, newest open
call wins, cleared by `mission.ended` and by the next round's first event, so
a cancelled run's dangling start cannot keep a dish turning on a replay.
`Actor.activeTool` carries the raw tool id; `propFor` maps it to a drawing
and an unknown id draws nothing (§8). The check the old props made visible —
web tools on a leader who is never assigned a task — lives in the members
panel and in `leader_only_tool`, which says it in words.

The toolbox is the one drawing that is more than a loop: the open box with
the wrench floating over it, on a timer, because it claims nothing the frames
do not already claim (§1.1). The disc and ring round a drawn cat are gone
too — a frame round a drawing that ends at its own outline — and `waiting`'s
amber moved from the ring to the caption word it was always paired with.

### Things thrown across the room

The artist's `throw/` set is wired to five moments on the log, derived in
`sceneState` like everything else: a task announced as `pending` is thrown
from the leader to its owner, comes back as `done` or `failed`, a
`send_message` flies to the teammate the name resolves to, a note addressed
to one cat comes in from the front of the room, and a question goes out to
it. The derivation lists every throw with its seq and timestamp; `SceneView`
throws only the ones that **just happened**, through the same gate the chime
uses (`justHappened`) — a reconnect or a History replay must not be a room
full of cats hurling a week's work at each other. Which drawing is thrown is
picked by seq, so a replay that does throw throws the same thing.

The message recipient is resolved client-side for the picture only — exact,
prefix, contains, unique or nothing — the same order `Mailbox.resolve` uses.
A name it cannot place throws nothing rather than guessing.

Same session: the timeline's busy fish is the four drawn frames stepped in
CSS, and the busy row never folds into the activity group above it — it had
been landing inside a collapsed "1 step" while the agent was thinking, so
nothing on screen moved.

### One accessory slot became two, because the drawings do not overlap

Twenty-three accessories arrived — nine head bows, two caps, five pairs of ear
bows, seven pairs of glasses — into a single `prop` slot that had been held
open for them. One slot would have shown one of them at a time, so
twenty-two of the twenty-three drawings could never appear together with
anything.

**The art decided the shape, and it was measured rather than eyeballed.**
Pixel masks, not bounding boxes:

    glasses x cap          0 shared pixels
    glasses x ear bows     0
    glasses x head bow    34   (the ribbon meets the top of the rim)
    head bow x ear bows  220
    head bow x cap       216
    cap x ear bows       104

So `headwear` and `glasses`, named for the **place on the cat** rather than
for the thing, because the place is what decides what can be worn at once.
Everything on top of the head collides with everything else up there and
shares a slot; the eyes get their own. Glasses paint last, so the 34 pixels
they share with a bow are the rim covering the ribbon, which is where a bow
is on a real face.

Splitting does not multiply the art — each slot is one overlay layer on the
same 100x100 canvas, so the two cost 17 + 8 files rather than 17 x 8
characters. The same arithmetic that kept four breeds from costing 2,560
cats, applied a second time.

**Only two of the eight old values had anywhere honest to go.** `glasses` and
`cap` were drawn; `scarf`, `headphones`, `bandana` and `eyepatch` never were,
so migration 0024 folds them to nothing rather than to a hat nobody chose
(§5.1). `bow_tie` is the one guess and is labelled as one: the bow that
exists is worn on the head, which is the same object in the wrong place, and
it keeps those agents distinct from the undressed default.

`PROP_SPLIT` lives only in `avatar.py`. `lookFor` deliberately does **not**
read a stale `prop` — it would need its own copy of that table to know
whether `cap` meant a hat or glasses, and two copies of one table is how they
come to disagree (§2.1). A config the migration has not been over draws a
bare cat, which is this build saying it has no art for what was recorded.

`pathsFor` and `artFor` take the keys as an object now. Five slots is five
strings in a row, and a pair swapped at a call site would have been silently
wrong art rather than a type error.

**And the migration ran against a half-updated working tree.** The dev
watcher restarts the backend the moment a file appears, and 0024 was written
a moment before `avatar.py` was — so it ran with the old `migrate_avatar`,
rewrote nothing, and stamped itself done. The rows still said `prop` while
`alembic_version` said `0024`. A packaged build ships one consistent version
and cannot hit this; in dev, **write the code a migration calls before the
migration file**, or expect to re-run the fold by hand.

### Every agent on an endpoint ran the same model, and Save put it back

The agent form had no model field at all. Its only endpoint control lived
**inside the generate panel**, which is not rendered when editing — so an
agent's endpoint could be chosen once, at creation, and never changed, and its
model could not be chosen at any point.

What `save` did instead is the part worth recording: `model: chosen?.model`,
the **endpoint profile's** current default. So every agent pointed at one
endpoint ran one model whatever the roster card implied, and opening an agent
whose model had been set another way and pressing Save moved it back — a field
nobody could see, rewritten by a button that says nothing about it.

`Runs on` is two fields, because they are two choices: which endpoint, and
which of that endpoint's models. It sits on both forms, above the generator on
the create one, since the endpoint is what drafts the character and choosing it
first is the order the page is used in.

**The endpoint select is now one control, not two.** "Generate with" was
already writing `provider_id`, so it had been deciding what the agent *runs on*
under a name that only mentions drafting. One value with two names in one form
is the §2.1 shape at its smallest.

**Changing the endpoint moves the model with it**, to that endpoint's own — and
says so on the line underneath, because a field that changes without being
touched is otherwise indistinguishable from one that was never set. Keeping the
old id would leave a real-looking string the new endpoint has never heard of,
with nothing to say so until a mission failed on it.

### A saved key cannot travel to the page that wants the list

`POST /providers/models` takes the key in its body, which is right for the
add-a-provider form: nothing is stored yet, so the caller is the only one who
has it. It is exactly wrong for an endpoint that already exists — that key is
in the OS keychain and the client can never read it back (§9.2), so reusing
that route would have meant typing a key in to read a list.

`GET /providers/{id}/models` takes an id and reads the key on the backend, the
same way a run does. A `search` profile is refused rather than asked: nothing
runs on one (§16.5), and an empty list would read as *this endpoint has none*
rather than *this is not that kind of endpoint*.

**And the first real use of it found something.** Asked about this machine's
three DeepSeek profiles, the endpoint answered `deepseek-flash` and
`deepseek-v4-pro` — while the profiles are set to `deepseek-v4-flash`,
`deepseek-v4-pro` and `deepseek-v4-flash-vision-exp`. CLAUDE.md recorded the
first list months ago; two of the three ids in use are not in the list it
returns today. Whether the endpoint still *serves* them is a separate question
nobody has asked it, and runs have been working. Which is the argument for
asking rather than shipping a list, demonstrated on the app's own settings.

### A dropdown of one is a field you cannot type in

The first version turned the model into a `Select` whenever there was anything
to show — and an agent that already has a model counts as something. So every
saved agent got a dropdown whose only entry was the model it already had, and
the id could never be typed again.

That is precisely the case the text field exists for. An endpoint with no
`/models` offers nothing, so the list stays empty, so the control would have
locked that agent to the model it was created with for ever. Found by trying to
put one back after testing the save — not by a test, and not by reading it.

The rule is now the one `ModelForm` already had: a list **only once the
endpoint has given one**. The agent's own id is still carried into that list as
an option labelled *"Set here; the endpoint did not list it"*, because dropping
it would show a placeholder over an agent that has a model.

### The app can replace itself, and a signature is what makes that safe

An installed copy asks GitHub once per launch whether there is a newer one,
offers it in the sidebar, and — on a button, never on its own — downloads it,
verifies it and installs it.

**The endpoint is not the security boundary; the key is.** `plugins.updater.
pubkey` is compiled into every build, and a bundle that is not signed by the
matching private half is refused before a byte is written. A compromised
endpoint can serve whatever it likes and every install will decline all of it.
That is the whole reason this is safe to do automatically, and it is the
sentence the Settings panel leads with.

**The private key is outside the repository**, at `~/.agent-studio/updater.key`
— not merely gitignored. `scripts/build-app.mjs` exists so that there is no
line in `package.json` tempting anyone to put a path inside the tree. Lose it
and every installed copy has to be replaced by hand, because they each verify
against the public half they were built with.

**One request to GitHub per launch is a real change in posture** for an app
whose brief says it runs entirely on this machine, so the panel says so in
those words. Finding that out from a packet capture would be the app being
quietly untrue about itself (§1).

**The progress bar here is honest, and that took a rule.** The download reports
a content length and then chunk sizes, so a proportion is a measurement — but
only when the server sent a length. `contentLength ?? 0` would have handed the
panel a denominator and drawn a bar over a number nobody measured, which is the
`costUsd` / `quota` / `ProbeResult.conclusive` rule in a fourth place. Null
means no length, the panel says how much arrived instead, and a test fails on
the `?? 0` version.

**"Last asked", not "up to date".** A panel claiming to be current is making a
statement about the present that it stopped being able to support the moment
the check returned. Same reasoning as the search-allowance meter saying
*measured when this key was last tested*.

The sidebar row renders **nothing** when there is nothing waiting — including
after a failed check, because being unable to reach GitHub is not news to
somebody who did not ask, and Settings carries the endpoint's own words for
anyone who did. A permanent "Up to date" row is how people learn to stop
reading the bottom of that column, which is the argument that took `open_desks`
off the team cards.

### One possible assignee is not a choice

A run died before it started:

    planning_failed: task t5 writes a file ('implement the DESIGN.md') but
    seat 3 (Sorrel) cannot: it has read_file, list_dir, glob, grep,
    send_message. Give it to one of seats [1], who hold write_file or
    edit_file.

**Seats [1].** One seat. The app had computed the only legal answer, put it in
the message, spent every attempt asking a model to guess it, and then threw the
run away — in front of somebody who had done nothing but pick a team and
describe a job.

`_check_tools` was right to exist and wrong about what to do with what it knew.
It is split now: **exactly one candidate is repaired**, two or more is a real
choice and still goes back to the leader, and nobody able to write at all is
still silent, because a correction that cannot be obeyed burns every attempt.

The move is published as `plan_repaired`, in its own words, and deliberately
not as `plan_corrected` — nothing was rejected and no attempt was spent, so
saying "the plan was rejected and retried" would be the log describing
something that did not happen (§1). It is worth saying at all because *Sorrel
was handed a writing task and cannot write* is a fact about the team, and the
person who composed it is the only one who can act on it.

**The general shape, and it has bitten here before:** when a check can name the
fix precisely enough to print it, ask whether it can just apply it. The
`leader_only_tool` warning is the honest opposite case — there the fix is a
judgement about roles and belongs to a person.

**It proved itself on the run that shipped it.** The release check ran the
four-agent `Build it` team — the one with a single writer — inside the packaged
build: `repaired 1, planning_failed 0, ended, completed, 70 events`. The model
mis-assigned again, exactly as before, and the log says
*"t2 writes a file and went to Moss, who cannot; it was given to Juniper"*
instead of a dead run. `DESIGN.md` is on disk with the colour read out of
`NOTES.md`. A fix verified against the failure itself rather than against a
fixture written from the same guess as the code.

**One existing test failed, correctly.** `test_edit_file_alone_counts_as_being_
able_to_write` asserted the correction fires for a lone editor, which is now
the repair path. The property is unchanged and is asserted where the code acts
on it — a test that follows the behaviour rather than one deleted for being
inconvenient.

### No installed build had ever finished a mission

`FileNotFoundError: _MEIPASS/agentd/providers/pricing.json`, on the first reply
from the model, in every packaged release from v0.1.0 to v0.2.3. Tokens spent,
zero tasks done, the row recorded `crashed`.

`pricing.json` is opened with `Path(__file__).with_name(...)` and **nothing
imports it**, so PyInstaller could not see it. This file already lists that as
one of the three things a freeze misses, and names Alembic as the example — the
rule was written down and the next instance of it still shipped, four times.

The rate table is asked for the moment a call finishes, because recording what
a call cost is part of recording that the call happened. So the crash always
landed on the first model reply.

Two fixes, and the second is the one that matters next time. The file is
bundled. And **a missing rate table no longer ends a run**: not knowing a price
is an ordinary state here — DeepSeek has never been in that table and the app
says "Not priced" — so a missing file is the same ignorance at a larger scale
and has no business killing work that is going fine. Our own gap must not be
written down as a fact about the world (§1.1), and it must not take the work
down with it either.

**Why four releases missed it.** Everything verified in the packaged build so
far was a *still frame*: a room drawn, a boot screen caught, a console with no
errors, a command getting past an ACL. Not one of those needs a mission to
finish. The check that exists now runs a whole mission inside the packaged app
through CDP and waits for the row to reach `ended` — and on the first attempt
it returned `completed`, 22 events, a real `read_file`, an artifact written,
zero `internal_error`, and the right answer read out of the workspace.

**A screenshot is not a test of a program that does work.** Everything that can
only be seen while something is *running* was outside every check this project
had.

### `[object Object]` was every structured error, not one screen

Under *This team cannot run* the composer printed one bullet reading
`[object Object]`. `unwrap()` did `detail = body.detail` and handed it to
`Error`, and FastAPI's `detail` is frequently an object — so the message became
the string an object stringifies to, and `missionStore` then tried to
`JSON.parse` that message to recover the list it had just destroyed.

The blast radius is every endpoint that answers with a dict: the teammates you
might have meant when `@Name` matches two, **the three real names when it
matches none** — which this file specifically celebrates as the thing that
makes a 404 actionable — and how many attempts a generation took.

`ApiError.detail` keeps the body as it arrived and `message` is only ever a
sentence. The lesson is narrow and repeatable: **a type that says `string` does
not make the value a string.** `rejected: string[]` had been holding objects.

### Three of four is not the workflow

`Could not update: Command plugin:updater|download_and_install not allowed by
ACL`, reported from the app. **The in-app updater had never installed anything**
— not in v0.2.0, where it was the headline feature, nor in v0.2.1 or v0.2.2.

The capability listed `updater:allow-check`, `updater:allow-download` and
`updater:allow-install`, which reads like the whole workflow. It is not. The JS
`downloadAndInstall()` calls a **fourth** command, `download_and_install`,
which is none of those three, so the page was allowed to ask whether an update
existed and forbidden from applying it. The plugin ships a `default` set
containing exactly those four; `updater:default` is used now, because a
hand-written list of somebody else's commands is a copy that can drift and this
one already had.

Enumerating was chosen to be minimal and was neither minimal nor correct: it
granted three permissions that together do nothing.

**Proved where it broke, not where it was written.** Invoking the command on
the built binary now answers `invalid args onEvent ... missing required key
onEvent` — the plugin's own validation, which is only reachable past the ACL.
"Config looks right" would have said the same thing about the version that
shipped three times.

**Nobody can take this fix through the thing it fixes.** The fault is in the
build a person is running, so v0.2.0 through v0.2.2 cannot install v0.2.3 — one
manual install, then the button works. Each of those three now carries a
warning on its own release page saying so.

### The dot was not the thing I said it was

Reported as an orange dot that came back after closing and reopening the app,
and written up here — twice — as the tool-approval question that cannot survive
a restart (§16.4). It was neither.

`MissionList` draws three dots and they are different shapes: a pulsing accent
dot for *working*, a hollow attn ring for *asking*, a solid attn dot for
*unread*. The one on screen was solid, so it was `unread` — and the database
settled it: one mission, `status=ended`, `end_reason=cancelled`,
**`pending_request=None`**. Nothing was waiting on anything.

Two claims made here before looking were wrong, and both were checkable:

* **The approval case does not leave a stuck dot.** `_mark_pending` only sets
  `pending_request` while `status == "running"`, and a plan interrupt sets
  `status = "waiting"` — so the two kinds are already distinguishable in the
  row, and `reap_orphans()` closing everything `running` already clears the
  tool one through `_finish`. §16.4's open item is that the tool never *ran*,
  not that anything is left dangling.
* **The dot was correct about the facts and wrong about the person.** The run
  had ended and had not been opened since, which is what `unread` means.

The fix is the definition, not the mechanism. `cancelled` is written in exactly
two places and both are the person acting — the Stop button, and rejecting a
plan at the gate — so a dot saying *this finished while you were looking
elsewhere* is being shown to somebody who was looking straight at it and is the
reason it finished. `crashed` keeps its dot, and deserves it more than any other
ending: it is the one nobody chose.

**Read the pixels before naming the bug.** Three dots that differ by shape were
designed precisely so they could be told apart, and the report was diagnosed
twice from memory of what the rail *does* rather than from which dot was drawn.

### The room had never once been drawn in a shipped build

v0.2.0 was published and the scene pane was **empty in it** — chrome buttons
over a blank rectangle, while dev rendered the room perfectly. Three separate
bugs, all one cause: **the app has a Content Security Policy and dev has none**,
so nothing in the scene had ever been exercised under the policy it ships with.

    Error: Current environment does not allow unsafe-eval,
    please use pixi.js/unsafe-eval module to enable support.
        at new Qt (WebGLRenderer) -> _h.init -> xM.mount

Pixi writes its uniform and shader sync routines with `new Function`, so
`Application.init()` threw and **no canvas was ever created**. `import
"pixi.js/unsafe-eval"` is Pixi's own answer: the same routines, interpreted.
Putting `'unsafe-eval'` in the policy would also have worked and is the wrong
trade in the one app that runs model output and reads fetched pages (§2.7).

`loadTextures.config.preferWorkers = false` is the second. Pixi decodes
textures in a worker built from a `blob:` URL, which the policy refuses — so
every texture that goes through `Assets.load` failed. The drawn cats never
noticed, because `artFetch` uses `new Image()` and `Texture.from`; the **decor
did**, and so does `sheet.ts`, which is the sprite-sheet *fallback* — the path
taken exactly when a cat has no drawing, which is the path nobody exercises
until an old `roster_snapshot` names a breed this build cannot draw.

And the updater added hours earlier was already broken: `getVersion()` goes
through Tauri's IPC at `http://ipc.localhost`, which `connect-src` did not
allow. It shipped in v0.2.0 that way.

**How it was found matters more than the fixes.** A release Tauri build has no
devtools, so the scene pane's silence was unreadable from outside. WebView2
still honours `--remote-debugging-port`, so launching the installed binary with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` puts CDP on
a socket and the real console, a real `evaluate` and `Page.captureScreenshot`
all become reachable. Every one of these was invisible until then.

**And the near-miss is the lesson.** The first theory was the blob worker. It
was tested by serving the production bundle with the policy *as written in
`tauri.conf.json`* — which reported **ALLOWED**, so the theory was dropped.
Tauri does not ship that policy. It rewrites it, turning `default-src 'self'`
into an explicit `script-src 'self' 'sha256-...'` list of its own injected
scripts, and a hash-based `script-src` does not admit a blob worker while a
bare `default-src 'self'` does. The reproduction was faithful to the config and
not to the artifact, and it produced a confident wrong answer. **When a bug
only exists in the shipped build, only the shipped build is the witness.**

Verified on the real binary, not on a test harness: canvas 676x280, floor,
walls, the cat at its desk, and the decor back on the walls — a before and
after at the same canvas size, on the same run.

### v0.2.0, and the chain checked from the outside

Published from `3a17b80`, and then verified the way an installed copy would do
it rather than the way the build does: fetch
`releases/latest/download/latest.json` over the real URL, download the file it
names, and check the signature it carries against the public key in
`tauri.conf.json`.

    manifest   byte-identical to what the build wrote
    installer  35,988,742 bytes, sha256 0e47f080...aec1d, matches the notes
    key id     88bb20420e628b18 on both halves
    result     verifies

That is the one link the build cannot test, because it does not exist until
the assets are uploaded — the url in the manifest is a *prediction* of what the
release will be called. Predicting it wrongly gives a 404 that looks exactly
like a signing problem from inside the app, which is why `release-manifest.mjs`
stages the files under the same names it writes into the manifest.

**`latest.json` carries the whole release notes**, 5.5KB of them, because the
panel shows what the release says rather than a summary of it. If that ever
reads badly in a 192px box the answer is a shorter release note, not a second
version of it in the manifest (§2.1).

### A build that fails to sign exits 0

`tauri signer generate` prints three environment variables, `_PATH` among them,
so `TAURI_SIGNING_PRIVATE_KEY_PATH` is the obvious one to set. The bundler does
not read it. What happened was worse than an error: it printed *"A public key
has been found, but no private key"*, produced both installers, and **exited
with status 0**.

So the exit code is not the thing to trust. `build-app.mjs` passes the key's
*content* in `TAURI_SIGNING_PRIVATE_KEY`, and then checks that a `.sig` exists
beside every bundle — because that is what a signed build actually leaves
behind. Without that check the failure is invisible until somebody downloads
the release and their app refuses it.

**What this does not fix: v0.1.0 cannot update itself.** That build has no
updater plugin in it at all, and its published installers were made before any
of this, so they are unsigned and cannot be signed after the fact. The update
path begins at the next release, and getting to it is one manual install.

### Opening the app said nothing about which app it was

The first screen of a packaged build is two lines of grey text, for the second
or two a one-file PyInstaller bundle spends unpacking itself. It is the cat and
the fish now — the app's own artwork, and **the same `.fish-loader` the
transcript uses for a busy agent**, so there is one drawing and one animation
meaning "working" rather than a spinner invented for this screen.

It claims nothing about progress, for the same reason the busy fish does not:
the backend answers `/health` when it answers and this side is polling, so a
bar would be measuring something nobody is measuring (§1.1).

Three things were measured rather than guessed. The **mouth** is at 59% of the
cat's canvas, not the middle, so a row centred the ordinary way puts the fish
level with the eyes. The **gap** is 12px — closer and the fish crosses the
whiskers, further and it reads as a cat and, separately, a fish. And the fish
is eaten **from the right**, so the cat goes on the right of it.

The CSS crop is written once now, in the art's own pixels, with
`--fish-scale` multiplying every number in it. A second size was otherwise four
hand-multiplied offsets that can disagree with each other.

**And then the cat went too**, at the artist's request, leaving the fish alone
at `--fish-scale: 5`. The reason it survives the trim is the reason it was
there: it is the same drawing the transcript uses for a busy agent, so the app
has one picture that means *working*. The cat was the second thing on that
screen and it meant nothing — it sat still while the fish moved.

Caught on the shipped binary rather than read off the source, which is now the
standard here: poll CDP from the moment the debugging port opens and grab the
page while it is still waiting on `/health`. Fish present, zero images, and the
`sr-only` line reading the *packaged* wording — which is `inTauri()` proving
itself in the only place it matters.

**Then the words went too.** The sentence said what was being waited for, which
is a fact about this app's internals shown to somebody who has just
double-clicked an icon, for the second or two before it disappears. The cat and
the fish already say the only useful thing, which is *something is happening*.
It is `sr-only` rather than deleted: a picture of a cat says nothing at all to a
screen reader, and that is the one reader for whom "just the cat" is no
message.

**The hint under it was wrong in every installed copy.** It said *"The dev
launcher starts it. If this persists, check the terminal"* — an instruction
nobody running the packaged app can follow, since it starts its own backend and
has no terminal. `inTauri()` is exported from `popout.ts` rather than copied,
and there are two sentences because there are two things that start it.

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

`GeneratedProfile` omits `provider_id`, `model` and `total_missions`, and a test asserts
it. The model has no idea which endpoints this machine has configured, and
`total_missions` is recorded from what actually happened rather than claimed.

**`tools` used to be on that list and is not any more.** The reason it was excluded —
"the registry is empty, so any tool it named would be fiction" — expired at M8. Now the
model is shown the real ids with their risk and description, picks from them, and an
invented name is refused with a correction listing the real ones: the same rule the
avatar catalogue has always had. Only tools this machine can actually run are offered,
so a model on a machine with no search key is never handed `web_search` to choose.

Verified live: asked for "a codebase archaeologist who digs through a repository", the
model returned `glob, grep, list_dir, read_file, send_message` on the first attempt — the
read-only set plus a way to report back, and nothing that writes.

A decision whose stated reason has expired is not a decision any more. Worth re-reading
the rest of this file with that in mind.

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
- **`open(p, "w").write(open(p).read()...)` destroys the file.** The outer open
  truncates to zero *before* the inner one reads, so the read returns "". It ate
  `tools/search.py` whole. `git checkout` got the committed version back and the
  session's changes were re-applied by hand. Always read into a variable first,
  transform, then write.
- **A long heredoc gets truncated in this harness**, and bash then dies with
  `unexpected EOF while looking for matching '`. Twice, both around 200 lines.
  Write long files with the editor tooling; keep heredocs to a few dozen lines.
- **A `@dataclass` is unhashable by default** (`eq=True` sets `__hash__ = None`), so
  `Subscriber` needs `eq=False` to live in a set.

---

## Open items

- ~~`deepseek-v4-flash` / `deepseek-v4-pro` unverified~~ — **resolved.** The endpoint
  was asked directly and answered `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`,
  `deepseek-v4-pro`. Still no model id hardcoded anywhere: the add-a-model form fetches
  the list from whichever endpoint you are configuring.
- Haiku 4.5 has two ids in circulation (`claude-haiku-4-5` vs
  `claude-haiku-4-5-20251001`). Same resolution: ask the endpoint, don't guess.
- ~~No team has been pointed at a task that needs the web~~ — **done.** A research
  team fetched `sqlite.org/whentouse.html` (15,321 chars) and `faq.html` (20,018) and
  wrote a document quoting them with URLs. Two things that cost a run each to learn:
  the web tools must not sit on the leader, and a fetched page is re-sent every turn,
  so two pages can spend a 200,000-token budget. `web_search` itself is *still*
  unexercised — the model went straight to URLs it already knew both times.
- **DeepSeek's native search has been sent once and never wired into a mission.** The
  probe that established it works was a raw request, not a run: the adapter, the
  `origin` field and the UI switch are all tested, but no team has been pointed at an
  `/anthropic` profile end to end.
- **`recall` is keyword search, not semantic.** `sqlite-vec` is in the stack and nothing
  embeds anything yet. The tool description says so, so a model that finds nothing knows
  to try other words rather than concluding it never knew the thing.
- **A tool approval does not survive a restart**, unlike a plan approval (§16.4). There
  is no checkpoint mid-turn: the mission is reaped as `crashed` and the tool never ran.
  Seen live and documented rather than fixed — fixing it means checkpointing inside a
  turn, which is a larger change than M8 was.
- ~~**Budget limits are not editable anywhere**~~ — **done.** Settings has them,
  they are stored per field, and a new run or a continued round picks them up.
- ~~**A run that hits a limit stops where it stands**~~ — **done.** A reserve
  is held back from each limit: the work phase stops starting new tasks, what
  is running finishes, and the leader writes a handover with what remains.
- **`suggest` and `review` have been run against one endpoint only.** DeepSeek
  produced a usable proposal on the first attempt both times, so the
  validate-and-retry loop's corrections are covered by tests and have never
  fired against a real model. A model that seats somebody who does not exist is
  the case that has not been seen for real.
- **The cat art is a placeholder.** `scripts/gen-cats.py` draws it, and it
  looks like a program drew it. The pipeline around it — atlas, three-layer
  compositing, tinting, integer scaling, the Aseprite `frameTags` adapter — is
  finished and verified, so replacing the art is an export and no code change.
- **Walking still uses one sprite row.** `walk` has four frames and they are
  drawn facing the room; a cat crossing the room is mirrored rather than drawn
  from the side, which reads acceptably at this size and would not with real
  art.
- **`/rewind` cannot undo what `bash` did.** Only `write_file` and `edit_file`
  leave a stored version, so a file a shell command created, moved or deleted
  has no copy to go back to. Said on the dialog before it is agreed to rather
  than discovered afterwards, and it means the bisect case below is still open.
- **Nothing undoes what a stopped turn had temporarily done.** An agent that
  moved two directories aside to bisect a build failure was cut off by
  `tool_rounds_exhausted` mid-bisect, and the next agent reported on the
  debugging state as though it were the deliverable. A half-written file is
  visible; a moved directory is not.
- ~~**`budget_exceeded` does not say which limit**~~ — **done.** The kind is on
  the ending and on the row, so the label names it. Runs recorded before the
  column keep the general phrase, which was true of them.
- ~~**A team or mission budget still has no screen**~~ — **done.** All three
  layers of §10 are editable, per field, with what a blank box inherits shown
  as its placeholder.
- **An image attached with the *first* message reaches the agents only on the next
  round.** The mission has no id until that message creates it, so the upload lands
  after the round has started. Said in the composer's hint rather than hidden, and
  the fix is `POST /missions` taking attachments, or a create-without-starting mode.
- **The installers are unsigned.** Windows SmartScreen will warn on first run, and macOS
  would refuse outright without notarisation. Nothing to fix in the code — it needs a
  certificate — but anyone handing the MSI to someone else should expect the warning and
  not treat it as a build problem.
- **Startup costs a second or two.** A one-file PyInstaller build unpacks itself on every
  launch (~3.5s to a first answer here). Bundling as a directory would remove that, and
  `externalBin` takes a single file, so it would mean shipping the backend as a resource
  and spawning it by path instead.

Every milestone in brief §12 is done: M1 through M8, each verified against a running
build rather than a test alone. An agent can now read and change files in a folder the
user chose, run commands with a question in front of them, and search the web when a key
is configured.
