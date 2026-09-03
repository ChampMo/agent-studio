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
import { Select } from "../../components/ui/Select";
import {
  api,
  type Agent,
  type AgentInput,
  type GenerateResult,
} from "../../transport/rest";
import { useAgentStore } from "../../stores/agentStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { Badge, Button, Field, Input } from "../../components/ui/primitives";
import { AvatarPicker } from "./AvatarPicker";
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
  useEffect(() => {
    if (!providerId && active) setProviderId(active.id);
  }, [active, providerId]);

  const usable = providers.filter((p) => p.hasKey);
  const chosen = providers.find((p) => p.id === providerId) ?? null;
  const ignoresSampling = chosen?.capabilities?.sampling_params === false;

  async function generate() {
    if (!providerId || !role.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.generateAgent({
        provider_id: providerId,
        role: role.trim(),
        brief: brief.trim(),
      });
      setResult(res);
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (agent) {
        // Only what this form owns. The provider and model are sent because
        // they are on this form too; nothing else about the row is touched.
        await updateAgent(agent.id, {
          ...draft,
          provider_id: providerId || null,
          model: chosen?.model ?? agent.model,
        });
      } else {
        await createAgent({
          ...draft,
          provider_id: providerId || null,
          model: chosen?.model ?? null,
        });
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

      {/* Only when there is nothing to lose. Regenerating over an agent
          someone has already tuned would throw the tuning away. */}
      <section
        hidden={Boolean(agent)}
        className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/40 p-4"
      >
        <Field label={strings.creator.providerLabel}>
          <Select
            value={providerId}
            onChange={setProviderId}
            placeholder="—"
            options={usable.map((p) => ({
              value: p.id,
              label: p.name,
              hint: p.model ?? undefined,
            }))}
          />
        </Field>

        <Field label={strings.creator.roleLabel} hint={strings.creator.roleHint}>
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
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500"
          />
        </Field>

        <Button
          type="button"
          onClick={generate}
          disabled={busy || !providerId || !role.trim()}
        >
          {busy ? strings.creator.generating : strings.creator.generate}
        </Button>

        {result && result.recoveredFrom.length > 0 ? (
          // Not hidden: needing three tries is a fact about the chosen model,
          // and §1 says the UI must not present a run as cleaner than it was.
          <div className="rounded-md border border-amber-900/60 bg-amber-950/30 p-2 text-xs text-amber-300">
            <div className="font-medium">
              {strings.creator.corrected(result.attempts)}
            </div>
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-amber-400/80">
              {result.recoveredFrom.map((problem, i) => (
                <li key={i}>{problem}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {error ? (
        <p className="rounded-md bg-red-950/60 px-3 py-2 text-sm text-red-300">{error}</p>
      ) : null}

      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-text">
            {strings.creator.reviewTitle}
          </h3>
          {agent ? null : <Badge tone="warn">{strings.creator.reviewBadge}</Badge>}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label={strings.creator.nameLabel}>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              required
            />
          </Field>
          <Field label={strings.creator.titleLabel}>
            <Input
              value={draft.title ?? ""}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </Field>
        </div>

        <Field label={strings.creator.roleFieldLabel}>
          <Input
            value={draft.role ?? ""}
            onChange={(e) => setDraft({ ...draft, role: e.target.value })}
          />
        </Field>

        <Field label={strings.creator.traitsLabel} hint={strings.creator.traitsHint}>
          <Input
            value={(draft.personality_traits ?? []).join(", ")}
            onChange={(e) =>
              setDraft({
                ...draft,
                personality_traits: e.target.value
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>

        <Field label={strings.creator.backstoryLabel}>
          <textarea
            value={draft.backstory ?? ""}
            onChange={(e) => setDraft({ ...draft, backstory: e.target.value })}
            rows={3}
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
          />
        </Field>

        <Field
          label={strings.creator.systemPromptLabel}
          hint={strings.creator.systemPromptHint}
        >
          <textarea
            value={draft.system_prompt ?? ""}
            onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })}
            rows={5}
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100"
          />
        </Field>

        <ToolPicker
          value={draft.tools ?? []}
          onChange={(tools) => setDraft({ ...draft, tools })}
        />

        <AvatarPicker
          assets={assets}
          value={draft.avatar_config ?? {}}
          name={draft.name ?? ""}
          onChange={(avatar_config) => setDraft({ ...draft, avatar_config })}
        />

        {ignoresSampling ? (
          <p className="text-xs text-amber-400">{strings.creator.samplingIgnored}</p>
        ) : null}

      </div>
      </div>
    </form>
  );
}
