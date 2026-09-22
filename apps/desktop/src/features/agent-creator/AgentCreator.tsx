/**
 * Create an agent from a short prompt (PROJECT_BRIEF.md §11).
 *
 * Three steps on purpose: describe → review → save. The middle one is not
 * optional. §11 requires the generated profile be shown for editing and never
 * written automatically, so "Generate" fills the form and nothing else — the
 * only thing that writes to the roster is the user pressing Save.
 */
import { useEffect, useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { Select } from "../../components/ui/Select";
import {
  api,
  type Agent,
  type AgentInput,
  type GenerateResult,
} from "../../transport/rest";
import { useAgentStore } from "../../stores/agentStore";
import { chatProviders, useSettingsStore } from "../../stores/settingsStore";
import { Badge, Button, Field, Input } from "../../components/ui/primitives";
import { AvatarPicker } from "./AvatarPicker";
import {
  AI_WRITTEN,
  AiButton,
  AiPanel,
  type AiState,
} from "../../components/ui/AiPanel";
import { useAiRun } from "../../components/ui/AiPanel";
import { ToolPicker } from "./ToolPicker";

const EMPTY: AgentInput = {
  name: "",
  title: "",
  role: "",
  backstory: "",
  personality_traits: [],
  system_prompt: "",
  tools: [],
  //: The cautious default, and the same one the database uses (§16.4).
  autonomy: "ask_dangerous",
};

/**
 * The same form, for making an agent and for changing one.
 *
 * Editing used to be a textarea on the roster card, which meant the fields the
 * card had no room for — tools, autonomy, avatar, backstory — could only ever
 * be set at creation. One form for both is the honest fix: what you can choose
 * when you make an agent is what you can change afterwards.
 *
 * The generate step is only offered when there is nothing to edit yet. Asking
 * a model to rewrite an agent someone has already tuned would throw away the
 * tuning, and "regenerate" is a different feature with a different question.
 */
export function AgentCreator({
  onDone,
  agent,
}: {
  onDone: () => void;
  /** Present when editing. Absent when creating. */
  agent?: Agent;
}) {
  const assets = useAgentStore((s) => s.assets);
  const createAgent = useAgentStore((s) => s.create);
  const updateAgent = useAgentStore((s) => s.update);
  const providers = useSettingsStore((s) => s.providers);
  const active = useSettingsStore((s) => s.active());

  const [role, setRole] = useState("");
  const [brief, setBrief] = useState("");
  const [draft, setDraft] = useState<AgentInput>(() =>
    agent
      ? {
          name: agent.name,
          title: agent.title,
          role: agent.role,
          backstory: agent.backstory,
          personality_traits: agent.personalityTraits,
          system_prompt: agent.systemPrompt,
          tools: agent.tools,
          autonomy: agent.autonomy,
          avatar_config: agent.avatarConfig,
        }
      : EMPTY,
  );
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The provider is the user's choice, not the model's: the model has no idea
  // which endpoints this machine has configured (see schemas.py).
  const [providerId, setProviderId] = useState<string>(
    agent?.providerId ?? active?.id ?? "",
  );

  // And so is the model. It used to be neither: this form had no model field,
  // and `save` sent `chosen?.model` — the *endpoint's* current default. So
  // every agent on an endpoint ran the same model, and opening an agent that
  // had been set to something else and pressing Save silently moved it back.
  //
  // Held as what this agent asks for, which is what the snapshot freezes and
  // what `graph.py` sends. Empty is a real state and not a safe one: the
  // runner sends `member.model or ""` and the endpoint refuses it, so the
  // field says that rather than quietly filling itself in.
  //: Same three sources as `providerId` above, in the same order and for the
  //: same reason: the agent's own, then the endpoint a new agent starts on.
  //: Reading only `agent?.model` left the create form's field empty whenever
  //: the settings store had already loaded — the effect below fills it, and
  //: the effect only runs when `providerId` is still blank, which it is not.
  const [model, setModel] = useState<string>(
    agent?.model ?? active?.model ?? "",
  );
  /** What the endpoint said it offers. Null until asked — not the same as an
   *  empty list, and the two read differently below. */
  const [models, setModels] = useState<string[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  /** Said when this form moved the model itself, so a field that changed
   *  without being touched explains why. */
  const [modelNote, setModelNote] = useState<string | null>(null);

  useEffect(() => {
    if (providerId || !active) return;
    setProviderId(active.id);
    // Only when there is nothing there. An agent being edited brought its own
    // model, and the endpoint's default must not overwrite it.
    setModel((current) => current || active.model);
  }, [active, providerId]);

  // Not `providers.filter((p) => p.hasKey)`, which offered Tavily and Brave —
  // a search key cannot complete anything, and picking one failed the
  // generation with `no provider registered for 'search'`. See `chatProviders`.
  const run = useAiRun();
  const usable = chatProviders(providers);
  const chosen = providers.find((p) => p.id === providerId) ?? null;
  const ignoresSampling = chosen?.capabilities?.sampling_params === false;

  /**
   * A model id belongs to the endpoint that offers it, so it moves with it.
   *
   * Keeping the old id across a change would leave a real-looking string that
   * the new endpoint has never heard of, and nothing would say so until a
   * mission failed on it. The endpoint's own model is the one thing known to
   * work there, so that is what it lands on — and the form says it did,
   * because a field that changes on its own is otherwise indistinguishable
   * from one that was never set.
   */
  function pickEndpoint(id: string) {
    if (id === providerId) return;
    setProviderId(id);
    // Fetched for a different server. Whatever it offered says nothing here.
    setModels(null);
    setModelsError(null);
    const next = providers.find((p) => p.id === id) ?? null;
    const fallback = next?.model ?? "";
    setModel(fallback);
    setModelNote(
      fallback ? strings.creator.modelFollowedEndpoint(fallback) : null,
    );
  }

  /**
   * Ask the endpoint what it runs, rather than shipping a list.
   *
   * A GET by profile id, not the add-a-provider form's POST: a saved key lives
   * in the OS keychain and this app can never read it back (§9.2), so the
   * backend is the only side that can ask. The text field stays underneath for
   * an endpoint with no `/models`, which is a normal thing to meet.
   */
  async function fetchModels() {
    if (!providerId) return;
    setFetching(true);
    setModelsError(null);
    try {
      const answer = await api.profileModels(providerId);
      setModels(answer.models);
      // The endpoint's own words. "Connection refused" and "invalid api key"
      // need different fixes, and one flattened message would hide which.
      setModelsError(answer.error);
    } catch (err) {
      setModels([]);
      setModelsError(err instanceof Error ? err.message : String(err));
    } finally {
      setFetching(false);
    }
  }

  /**
   * A list to pick from only once the endpoint has actually offered one.
   *
   * The first version turned the field into a `Select` whenever there was
   * *anything* to show, and an agent with a model already set counts as
   * something — so every saved agent got a dropdown whose only entry was the
   * model it already had, and the id could never be typed again. That is the
   * one case the text field exists for: an endpoint with no `/models` offers
   * nothing, and then this control would have locked the agent to the model it
   * was created with. Found by trying to change one back.
   *
   * The agent's own id is kept as an option regardless, because dropping it
   * would leave a placeholder over an agent that has a model — the form
   * claiming a field is empty when it is not (§1).
   */
  const offered = models ?? [];
  const pickFromList = offered.length > 0;
  const modelOptions = [
    ...(model && !offered.includes(model)
      ? [
          {
            value: model,
            label: model,
            hint: strings.creator.modelNotOffered,
          },
        ]
      : []),
    ...offered.map((m) => ({ value: m, label: m })),
  ];

  //: Which of the four the panel is in. Derived rather than stored, so it
  //: cannot drift from the thing it describes (§2.1): `busy` is the request,
  //: `error` is the endpoint's answer, and `result` is whether a draft is on
  //: the form. There is no fifth state to forget to leave.
  const aiState: AiState = busy
    ? "working"
    : error
      ? "failed"
      : result
        ? "unreviewed"
        : "idle";

  //: Which fields still hold what the model wrote. A field leaves this set the
  //: moment it is edited, which is the whole claim the mark makes — *this is
  //: the model's and you have not touched it.* Cleared entirely on save,
  //: because a saved agent is the person's.
  const [fromModel, setFromModel] = useState<Set<string>>(new Set());
  const drop = (field: string) =>
    setFromModel((held) => {
      if (!held.has(field)) return held;
      const next = new Set(held);
      next.delete(field);
      return next;
    });
  const mark = (field: string) => (fromModel.has(field) ? AI_WRITTEN : "");

  function cancel() {
    run.cancel();
    setBusy(false);
    setError(strings.ai.cancelled);
  }

  async function generate() {
    if (!providerId || !role.trim()) return;
    const signal = run.begin();
    setBusy(true);
    setError(null);
    try {
      const res = await api.generateAgent(
        {
          provider_id: providerId,
          role: role.trim(),
          brief: brief.trim(),
        },
        signal,
      );
      setResult(res);
      setFromModel(
        new Set([
          "name",
          "title",
          "role",
          "backstory",
          "personality_traits",
          "system_prompt",
          "avatar_config",
          "tools",
        ]),
      );
      setDraft({
        name: res.profile.name,
        title: res.profile.title,
        role: res.profile.role,
        backstory: res.profile.backstory,
        personality_traits: res.profile.personality_traits,
        system_prompt: res.profile.system_prompt,
        avatar_config: res.profile.avatar_config,
        // What the model chose, shown for review rather than dropped. It is
        // picked from the same registry the picker below lists, so it can be
        // changed like anything else on this form.
        tools: res.profile.tools ?? [],
        autonomy: "ask_dangerous",
      });
    } catch (err) {
      // An abort is the person's own decision and `cancel` has already said
      // so; overwriting that with the fetch's wording would be the screen
      // reporting their button press as a fault.
      if (signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal.aborted) {
        run.end();
        setBusy(false);
      }
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // What this form owns, including the model — which is now a field on it
      // rather than whatever the endpoint currently defaults to.
      const runsOn = {
        provider_id: providerId || null,
        model: model.trim() || null,
      };
      if (agent) {
        await updateAgent(agent.id, { ...draft, ...runsOn });
      } else {
        await createAgent({ ...draft, ...runsOn });
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    // One <form> around the whole page, with the actions in a header that stays
    // put. They used to sit at the very bottom, past the tool list and the
    // avatar pickers — so on a long form the only way to save was to scroll to
    // the end and find them, and there was nothing at the top to say the page
    // was even editable. Matches the team editor, which already worked this
    // way.
    <form onSubmit={save} className="flex h-full flex-col">
      <div className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-line bg-glass px-4 py-3 backdrop-blur">
        <h2 className="truncate text-sm font-medium text-text">
          {agent ? strings.creator.editTitle : strings.creator.title}
        </h2>
        <div className="flex shrink-0 gap-2">
          <Button type="submit" disabled={busy || !draft.name.trim()}>
            {agent ? strings.creator.saveEdit : strings.creator.save}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            {strings.creator.cancel}
          </Button>
        </div>
      </div>

      <div className="mx-auto w-full max-w-2xl space-y-6 p-6">
        <div>
          <p className="text-sm text-muted">
            {agent ? strings.creator.editIntro : strings.creator.intro}
          </p>
        </div>

        {/* What this agent thinks with, on both the create and the edit form.

            It was on neither. The only endpoint control lived inside the
            generate panel, which is not rendered when editing — so an agent's
            endpoint could be chosen once and never changed, and its model
            could not be chosen at all. Each agent on a team can run somewhere
            different, and this is where that is said.

            Above the generator on purpose: the endpoint is what drafts the
            character, so choosing it first is the order the page is used in. */}
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-medium text-text">
              {strings.creator.runsOnTitle}
            </h3>
            <p className="mt-1 text-xs text-muted">
              {strings.creator.runsOnHint}
            </p>
          </div>

          <Field label={strings.creator.endpointLabel}>
            <Select
              value={providerId}
              onChange={pickEndpoint}
              placeholder="—"
              options={usable.map((p) => ({
                value: p.id,
                label: p.name,
                // What the endpoint itself is set to run, which is what a new
                // agent starts on. Not necessarily what this agent asks for.
                hint: p.model ?? undefined,
              }))}
            />
          </Field>

          <Field
            label={strings.creator.agentModelLabel}
            hint={strings.creator.agentModelHint}
          >
            <div className="space-y-2">
              {/* A list only once the endpoint has given one. Before that the
                  field is a text box, so an endpoint with no `/models` is no
                  worse off than it was — and neither is an agent whose model
                  someone wants to correct by hand. */}
              {pickFromList ? (
                <Select
                  value={model}
                  onChange={(next) => {
                    setModelNote(null);
                    setModel(next);
                  }}
                  placeholder={strings.creator.modelPick}
                  options={modelOptions}
                />
              ) : (
                <Input
                  value={model}
                  onChange={(e) => {
                    setModelNote(null);
                    setModel(e.target.value);
                  }}
                  placeholder={strings.creator.modelPlaceholder}
                  className="font-mono"
                />
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void fetchModels()}
                  disabled={fetching || !providerId}
                  className={cn(
                    "min-h-[24px] rounded-card border border-line px-2.5 py-1 text-xs",
                    "text-muted transition-colors hover:bg-solid hover:text-text",
                    "disabled:opacity-40",
                  )}
                >
                  {fetching
                    ? strings.creator.fetchingModels
                    : strings.creator.fetchModels}
                </button>
                {models && models.length > 0 ? (
                  <span className="text-[11px] text-faint">
                    {strings.creator.modelsFound(models.length)}
                  </span>
                ) : null}
                {/* Answered, and had nothing to offer. Different from not
                    asked, and different from failing. */}
                {models && models.length === 0 && !modelsError ? (
                  <span className="text-[11px] text-faint">
                    {strings.creator.modelsNone}
                  </span>
                ) : null}
              </div>

              {modelsError ? (
                <p className="text-[11px] text-wait">
                  {strings.creator.modelsFailed} {modelsError}
                </p>
              ) : null}

              {modelNote ? (
                <p className="text-[11px] text-muted">{modelNote}</p>
              ) : null}

              {/* Not a disabled Save: an agent is worth keeping half-built,
                  and the team validator is the run gate, not this form. */}
              {!model.trim() ? (
                <p className="text-[11px] text-attn">
                  {strings.creator.noModelWarning}
                </p>
              ) : null}
            </div>
          </Field>
        </div>

        {/* Only when there is nothing to lose. Regenerating over an agent
          someone has already tuned would throw the tuning away. */}
        {agent ? null : (
          <AiPanel
            state={aiState}
            title={strings.creator.aiTitle}
            model={chosen?.model ?? null}
            startedAt={run.startedAt}
            reviewNote={strings.ai.written}
            // The endpoint's own words, in the panel that produced them, with
            // the role and notes still on screen above. A failure that clears
            // the form is how a feature stops being used.
            error={error}
            actions={
              <>
                <AiButton
                  onClick={generate}
                  disabled={!providerId || !role.trim()}
                  busy={busy}
                >
                  {busy
                    ? strings.creator.generating
                    : result
                      ? strings.creator.regenerate
                      : strings.creator.generate}
                </AiButton>
                {/* Always present while it runs, and it really aborts. */}
                {busy ? (
                  <button
                    type="button"
                    onClick={cancel}
                    className="min-h-[32px] rounded-card border border-line px-3 text-xs text-muted hover:text-text"
                  >
                    {strings.ai.cancel}
                  </button>
                ) : null}
              </>
            }
          >
            <Field
              label={strings.creator.roleLabel}
              hint={strings.creator.roleHint}
            >
              <Input
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder={strings.creator.rolePlaceholder}
              />
            </Field>

            <Field label={strings.creator.briefLabel}>
              <textarea
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                rows={2}
                placeholder={strings.creator.briefPlaceholder}
                className="w-full rounded-md border border-line bg-solid-2 px-3 py-2 text-sm text-text placeholder:text-faint"
              />
            </Field>

            {result && result.recoveredFrom.length > 0 ? (
              // Not hidden: needing three tries is a fact about the chosen
              // model, and §1 says the UI must not present a run as cleaner
              // than it was. This is the only *real* progress this feature
              // has, which is why it is reported and the wait is not.
              <div className="rounded-md border border-attn-edge bg-attn-soft p-2 text-xs text-attn">
                <div className="font-medium">
                  {strings.creator.corrected(result.attempts)}
                </div>
                <ul className="mt-1 list-inside list-disc space-y-0.5 text-attn">
                  {result.recoveredFrom.map((problem, i) => (
                    <li key={i}>{problem}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </AiPanel>
        )}

        {/* A save failure has nothing to do with the model, so it keeps its
            own line. Generation failures live inside the panel. */}
        {error && agent ? (
          <p className="rounded-md bg-stop/10 px-3 py-2 text-sm text-stop">
            {error}
          </p>
        ) : null}

        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-text">
              {strings.creator.reviewTitle}
            </h3>
            {agent ? null : (
              <Badge tone="warn">{strings.creator.reviewBadge}</Badge>
            )}
          </div>

          {/* The face comes first, because the name comes second.

              It used to sit at the very bottom, under the system prompt and
              the thirteen tools — so you typed a name, scrolled past all of
              that, and only then found out what you had been naming. Naming a
              cat you cannot see is guessing, and the generator has the same
              problem from the other side.

              Above the name field, the two are one decision. */}
          <div className={mark("avatar_config")}>
            <AvatarPicker
              assets={assets}
              value={draft.avatar_config ?? {}}
              name={draft.name ?? ""}
              onChange={(avatar_config) => {
                drop("avatar_config");
                setDraft({ ...draft, avatar_config });
              }}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label={strings.creator.nameLabel}>
              <Input
                value={draft.name}
                onChange={(e) => {
                  drop("name");
                  setDraft({ ...draft, name: e.target.value });
                }}
                className={mark("name")}
                required
              />
            </Field>
            <Field label={strings.creator.titleLabel}>
              <Input
                value={draft.title ?? ""}
                onChange={(e) => {
                  drop("title");
                  setDraft({ ...draft, title: e.target.value });
                }}
                className={mark("title")}
              />
            </Field>
          </div>

          <Field label={strings.creator.roleFieldLabel}>
            <Input
              value={draft.role ?? ""}
              onChange={(e) => {
                drop("role");
                setDraft({ ...draft, role: e.target.value });
              }}
              className={mark("role")}
            />
          </Field>

          <Field
            label={strings.creator.traitsLabel}
            hint={strings.creator.traitsHint}
          >
            <Input
              value={(draft.personality_traits ?? []).join(", ")}
              className={mark("personality_traits")}
              onChange={(e) => {
                drop("personality_traits");
                setDraft({
                  ...draft,
                  personality_traits: e.target.value
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean),
                });
              }}
            />
          </Field>

          <Field label={strings.creator.backstoryLabel}>
            <textarea
              value={draft.backstory ?? ""}
              onChange={(e) => {
                drop("backstory");
                setDraft({ ...draft, backstory: e.target.value });
              }}
              rows={3}
              className={cn(
                "w-full rounded-md border border-line bg-solid px-3 py-2 text-sm text-text",
                mark("backstory"),
              )}
            />
          </Field>

          <Field
            label={strings.creator.systemPromptLabel}
            hint={strings.creator.systemPromptHint}
          >
            <textarea
              value={draft.system_prompt ?? ""}
              onChange={(e) => {
                drop("system_prompt");
                setDraft({ ...draft, system_prompt: e.target.value });
              }}
              rows={5}
              className={cn(
                "w-full rounded-md border border-line bg-solid px-3 py-2 font-mono text-xs text-text",
                mark("system_prompt"),
              )}
            />
          </Field>

          <div className={mark("tools")}>
            <ToolPicker
              value={draft.tools ?? []}
              onChange={(tools) => {
                drop("tools");
                setDraft({ ...draft, tools });
              }}
            />
          </div>

          {ignoresSampling ? (
            <p className="text-xs text-attn">
              {strings.creator.samplingIgnored}
            </p>
          ) : null}
        </div>
      </div>
    </form>
  );
}
