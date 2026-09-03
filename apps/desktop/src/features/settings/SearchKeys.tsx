/**
 * The web-search keys, as the fallback chain they actually are (§16.5).
 *
 * They used to be cards, one per key, the same shape as a model provider. Two
 * things were wrong with that.
 *
 * **A card says "a thing on its own".** These are not: they are an *ordered*
 * list, tried top to bottom, and the whole reason to have more than one is that
 * the first runs out. A border around each one hid the only property that
 * matters between them. So: a numbered list, hairlines rather than boxes, and
 * the position is a number you can read instead of a sentence describing it.
 *
 * **Two of the three buttons were never pressed.** Replacing a key and removing
 * one happen once; testing happens whenever you wonder how much is left. So
 * testing stays on the surface and the other two are behind `⋯`, which is the
 * rule the roster and team cards already follow.
 *
 * The engines themselves are fixed — Brave and Tavily are the two APIs this
 * build has adapters for, and a third would mean writing one. What can be added
 * is another *key* for either, which is what a second free account is for.
 */
import { useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { formatDateTime } from "../../lib/format";
import { cn } from "../../lib/cn";
import { Menu } from "../../components/ui/Menu";
import { MoreIcon, TrashIcon } from "../../components/ui/icons";
import { ProbeReport } from "./ProbeReport";
import { QuotaBar } from "./QuotaBar";
import type { ProbeResult, ProviderProfile } from "../../transport/rest";

export function SearchKeys({
  keys,
  probe,
  probing,
  onTest,
  onSetKey,
  onRemove,
  onMove,
}: {
  /** In the order the backend will try them. The number drawn beside each row
   *  is that order, and `onMove` is how it changes. */
  keys: ProviderProfile[];
  probe: Record<string, ProbeResult | undefined>;
  probing: string | null;
  onTest: (id: string) => void;
  onSetKey: (id: string, key: string) => Promise<void> | void;
  onRemove: (id: string) => void;
  /** Up or down the chain. The order is what decides which allowance is spent
   *  first, so it has to be something you set rather than something the app
   *  infers from when you happened to add a key. */
  onMove: (id: string, by: -1 | 1) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <ol className="divide-y divide-line border-y border-line">
      {keys.map((p, i) => (
        <li key={p.id} className="py-3">
          <div className="flex items-start gap-3">
            {/* The position in the chain, as a number. It replaces "Tried
                first" and "Used if the ones above run out": the same fact,
                without a sentence per row restating it. */}
            <span
              aria-hidden="true"
              className="mt-px w-4 shrink-0 text-right text-xs tabular-nums text-faint"
            >
              {i + 1}
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate text-sm font-medium text-text">{p.name}</span>
                {!p.hasKey ? (
                  <span className="shrink-0 text-[11px] text-stop">
                    {strings.settings.keyMissing}
                  </span>
                ) : null}
              </div>
              <div className="truncate text-[11px] text-faint">
                {p.baseUrl}
                {" · "}
                {p.verifiedAt
                  ? `${strings.settings.verifiedAt} ${formatDateTime(new Date(p.verifiedAt))}`
                  : strings.settings.neverVerified}
              </div>

              <div className="mt-2 max-w-sm">
                <QuotaBar quota={p.quota} />
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
                  <label htmlFor={`key-${p.id}`} className="sr-only">
                    {strings.settings.setKeyFor(p.name)}
                  </label>
                  <input
                    id={`key-${p.id}`}
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
                // Removing a key deletes it from the keychain, and this app
                // never held a copy it could give back. So it asks first.
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

              {probe[p.id] ? (
                <div className="mt-2 max-w-xl">
                  <ProbeReport result={probe[p.id]!} />
                </div>
              ) : null}
            </div>

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
                    label: strings.settings.tryEarlier,
                    disabled: i === 0,
                    hint: i === 0 ? strings.settings.alreadyFirst : undefined,
                    onSelect: () => onMove(p.id, -1),
                  },
                  {
                    label: strings.settings.tryLater,
                    disabled: i === keys.length - 1,
                    hint:
                      i === keys.length - 1 ? strings.settings.alreadyLast : undefined,
                    onSelect: () => onMove(p.id, 1),
                  },
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
        </li>
      ))}
    </ol>
  );
}
