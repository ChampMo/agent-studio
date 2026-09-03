/**
 * The model endpoints, as a list rather than a stack of cards (§3.1).
 *
 * The same move the search keys made, for the same reason: a card draws a box
 * around one thing to say it stands alone, and these do not — one of them is
 * the default a new agent gets, and the others are alternatives to it. That
 * relationship is the whole content of this section, and a border around each
 * row was hiding it.
 *
 * So they are radio rows. Which is also the fix for something the cards were
 * quietly wrong about: clicking a card highlighted it and said nothing about
 * what that meant. It means *this is the endpoint a new agent is created with*,
 * and now the row says so instead of leaving a blue border to be interpreted.
 *
 * Capabilities are shown from the profile, not from the last probe, because
 * they are what was **recorded** about the endpoint — they survive a reload and
 * they are what an agent will actually be run against (§3.1). Anything a probe
 * could not establish was never written there, so nothing here is a guess.
 *
 * Testing stays on the surface; replacing a key and removing an endpoint go
 * behind `⋯`, the same rule as everywhere else.
 */
import { useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { formatDateTime } from "../../lib/format";
import { cn } from "../../lib/cn";
import { Menu } from "../../components/ui/Menu";
import { MoreIcon, TrashIcon } from "../../components/ui/icons";
import { Checkbox } from "../../components/ui/Checkbox";
import { ProbeReport } from "./ProbeReport";
import type { Capabilities, ProbeResult, ProviderProfile } from "../../transport/rest";

/** What was established about an endpoint, in words, or nothing at all.
 *
 *  Never a placeholder: an endpoint that has not been tested has no
 *  capabilities recorded, and inventing "unknown ×3" would fill the row with
 *  our own ignorance dressed as data (§1.1). */
function capabilityWords(caps: Capabilities | null): string[] {
  if (!caps) return [];
  const words = [caps.tool_calling ? "tools" : "no tools"];
  if (caps.structured_output !== "none") words.push(caps.structured_output);
  if (caps.vision) words.push("vision");
  if (caps.max_input_tokens) {
    words.push(`${caps.max_input_tokens.toLocaleString("en-GB")} context`);
  }
  return words;
}

export function ModelList({
  models,
  activeId,
  probe,
  probing,
  onSelect,
  onTest,
  onSetKey,
  onRemove,
  onNativeSearch,
}: {
  models: ProviderProfile[];
  /** The one a new agent is created with. */
  activeId: string | null;
  probe: Record<string, ProbeResult | undefined>;
  probing: string | null;
  onSelect: (id: string) => void;
  onTest: (id: string) => void;
  onSetKey: (id: string, key: string) => Promise<void> | void;
  onRemove: (id: string) => void;
  onNativeSearch: (id: string, on: boolean) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <div
      role="radiogroup"
      aria-label={strings.settings.defaultGroup}
      className="divide-y divide-line border-y border-line"
    >
      {models.map((p) => {
        const chosen = p.id === activeId;
        const words = capabilityWords(p.capabilities);
        return (
          <div key={p.id} className="py-3">
            <div className="flex items-start gap-3">
              <button
                type="button"
                role="radio"
                aria-checked={chosen}
                onClick={() => onSelect(p.id)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="truncate text-sm font-medium text-text">{p.name}</span>
                  <span className="truncate font-mono text-[11px] text-muted">
                    {p.model}
                  </span>
                  {/* The selection, in words. A highlighted row on its own does
                      not say what being selected does. */}
                  {chosen ? (
                    <span className="shrink-0 text-[11px] text-accent">
                      {strings.settings.defaultForAgents}
                    </span>
                  ) : null}
                  {!p.hasKey ? (
                    <span className="shrink-0 text-[11px] text-stop">
                      {strings.settings.keyMissing}
                    </span>
                  ) : null}
                </div>
                <div className="truncate text-[11px] text-faint">
                  {p.baseUrl ?? strings.settings.noBaseUrl}
                  {" · "}
                  {p.verifiedAt
                    ? `${strings.settings.verifiedAt} ${formatDateTime(new Date(p.verifiedAt))}`
                    : strings.settings.neverVerified}
                </div>
                {words.length > 0 ? (
                  <div className="mt-1 truncate text-[11px] text-muted">
                    {words.join(" · ")}
                  </div>
                ) : null}
              </button>

              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  aria-label={strings.probe.rerunFor(p.name)}
                  onClick={() => onTest(p.id)}
                  disabled={probing === p.id || !p.hasKey}
                  className={cn(
                    "min-h-[24px] rounded-card border border-line px-2.5 py-1 text-xs",
                    "text-muted transition-colors hover:bg-solid hover:text-text",
                    "disabled:opacity-40",
                  )}
                >
                  {probing === p.id ? strings.probe.running : strings.probe.rerun}
                </button>
                <Menu
                  label={strings.settings.moreFor(p.name)}
                  trigger={<MoreIcon />}
                  items={[
                    {
                      label: strings.settings.setKey,
                      onSelect: () => {
                        setEditing(editing === p.id ? null : p.id);
                        setConfirming(null);
                        setDraft("");
                      },
                    },
                    {
                      label: strings.settings.remove,
                      icon: <TrashIcon />,
                      tone: "danger",
                      onSelect: () => {
                        setConfirming(p.id);
                        setEditing(null);
                      },
                    },
                  ]}
                />
              </div>
            </div>

            {editing === p.id ? (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await onSetKey(p.id, draft);
                  setDraft("");
                  setEditing(null);
                }}
                className="mt-2 flex max-w-sm gap-2"
              >
                <label htmlFor={`model-key-${p.id}`} className="sr-only">
                  {strings.settings.setKeyFor(p.name)}
                </label>
                <input
                  id={`model-key-${p.id}`}
                  type="password"
                  autoComplete="off"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={strings.onboarding.keyPlaceholder}
                  className={cn(
                    "w-full rounded-[9px] border border-line bg-solid px-3 py-2",
                    "text-sm text-text placeholder:text-faint",
                  )}
                />
                <button
                  type="submit"
                  disabled={!draft.trim()}
                  className={cn(
                    "shrink-0 rounded-[9px] border border-line px-3 text-xs",
                    "text-muted hover:bg-solid hover:text-text disabled:opacity-40",
                  )}
                >
                  {strings.settings.save}
                </button>
              </form>
            ) : null}

            {confirming === p.id ? (
              <div className="mt-2 max-w-sm rounded-[9px] border border-stop/40 bg-stop/10 p-2 text-[11px] text-muted">
                <p>{strings.settings.removeWarning(p.name)}</p>
                <div className="mt-1.5 flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      onRemove(p.id);
                      setConfirming(null);
                    }}
                    className="rounded px-2 py-1 font-medium text-stop hover:bg-stop/15"
                  >
                    {strings.settings.remove}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="rounded px-2 py-1 hover:bg-solid-2"
                  >
                    {strings.settings.cancel}
                  </button>
                </div>
              </div>
            ) : null}

            {p.nativeSearchAvailable ? (
              <div className="mt-2 max-w-xl space-y-1.5">
                <Checkbox
                  checked={p.nativeSearch}
                  onChange={(next) => onNativeSearch(p.id, next)}
                  label={strings.settings.nativeSearchLabel}
                  hint={strings.settings.nativeSearchHint}
                />
                {p.nativeSearch ? (
                  // Blunt on purpose. This is the one tool the approval gate
                  // cannot stop and redaction never sees, and the timeline can
                  // only say that it happened (§16.8).
                  <p className="rounded-[9px] border border-wait/40 bg-wait/10 p-2 text-[11px] text-wait">
                    {strings.settings.nativeSearchWarning}
                  </p>
                ) : null}
              </div>
            ) : null}

            {probe[p.id] ? (
              <div className="mt-2 max-w-xl">
                <ProbeReport result={probe[p.id]!} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
