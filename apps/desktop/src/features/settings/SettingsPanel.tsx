/**
 * Providers: the models agents think with, and the keys one of their tools uses
 * (§3.1, §16.5).
 *
 * Two lists with the same manners. Neither is cards any more — a card says "a
 * thing on its own", and in both sections the rows relate to each other: one
 * model is the default a new agent gets, and the search keys are an ordered
 * chain where the second exists because the first runs out. The relationship is
 * the content, and a box around each row was hiding it.
 *
 * The two "add" affordances are one component for the same reason. They had
 * drifted into a filled button in one section header and a bare text link at
 * the foot of the other, which made two identical jobs look like two different
 * kinds of thing.
 */
import { useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { useSettingsStore } from "../../stores/settingsStore";
import { Button, Input } from "../../components/ui/primitives";
import { Select } from "../../components/ui/Select";
import { ModelForm } from "./ModelForm";
import { ModelList } from "./ModelList";
import { PlusIcon } from "../../components/ui/icons";
import { cn } from "../../lib/cn";
import { SearchKeys } from "./SearchKeys";
import { BudgetPanel } from "./BudgetPanel";
import { StoragePanel } from "./StoragePanel";

type Where = "models" | "search" | "limits" | "storage";

const SECTIONS: { id: Where; label: string; blurb: string }[] = [
  {
    id: "models",
    label: strings.settings.modelsTitle,
    blurb: strings.settings.modelsHint,
  },
  {
    id: "search",
    label: strings.settings.searchTitle,
    blurb: strings.settings.searchSectionHint,
  },
  { id: "limits", label: strings.budget.title, blurb: strings.budget.intro },
  { id: "storage", label: strings.storage.title, blurb: strings.storage.intro },
  // No theme section. It is one setting with three values and a button for it
  // in the corner of the window, which is where it belongs — and a page that
  // held nothing else printed its own one-line description under the section
  // blurb that already said the same sentence.
];

export function SettingsPanel() {
  const [where, setWhere] = useState<Where>("models");
  const { providers, activeId, probe, probing } = useSettingsStore();
  const { setActive, test, removeProvider, setKey, setNativeSearch } =
    useSettingsStore();
  const moveSearchKey = useSettingsStore((s) => s.moveSearchKey);
  const [addingModel, setAddingModel] = useState(false);

  const models = providers.filter((p) => p.kind !== "search");
  const searches = providers.filter((p) => p.kind === "search");

  const section = SECTIONS.find((s) => s.id === where) ?? SECTIONS[0]!;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Across the top, not down the side. As a left rail it sat immediately
          beside the app's own left sidebar — two columns of vertical links
          against each other, and a whole column spent on four words.

          Tabs rather than a list because there are four of them and they are
          not going to become twelve: models, keys, limits, storage is the whole
          surface of what this page configures. */}
      {/* A plain nav, not role="tablist". These are four places rather than
          four views of one thing, and a real tablist owes the reader arrow-key
          roving focus — which would be extra code to make Tab behave worse than
          it already does here. `aria-current="page"` says which one you are on
          and every button stays in the tab order (WCAG 2.1.1). */}
      <nav
        aria-label={strings.settings.sections}
        className="flex shrink-0 gap-1 border-b border-line px-5 pt-3"
      >
        {SECTIONS.map((item) => {
          const current = item.id === section.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={current ? "page" : undefined}
              onClick={() => setWhere(item.id)}
              className={cn(
                "min-h-[24px] rounded-t-md px-3 py-2 text-sm transition-colors",
                // The underline lands on the container's own bottom border, so
                // the chosen tab joins the pane below rather than floating over
                // a second rule.
                "-mb-px border-b-2",
                current
                  ? "border-accent text-text"
                  : "border-transparent text-muted hover:text-text",
              )}
            >
              {item.label}
            </button>
          );
        })}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="max-w-3xl space-y-3 p-5">
          <p className="max-w-2xl text-xs text-muted">{section.blurb}</p>

          {section.id === "models" ? (
            <div className="space-y-3 pt-1">
              {models.length === 0 ? (
                <p className="text-xs text-faint">
                  {strings.settings.noModels}
                </p>
              ) : (
                <ModelList
                  models={models}
                  activeId={activeId}
                  probe={probe}
                  probing={probing}
                  onSelect={setActive}
                  onTest={test}
                  onSetKey={setKey}
                  onRemove={removeProvider}
                  onNativeSearch={setNativeSearch}
                />
              )}
              {addingModel ? (
                <ModelForm onDone={() => setAddingModel(false)} />
              ) : (
                <AddRow
                  label={strings.settings.addModel}
                  onClick={() => setAddingModel(true)}
                />
              )}
            </div>
          ) : null}

          {section.id === "search" ? (
            <div className="space-y-3 pt-1">
              {searches.length === 0 ? (
                <p className="text-xs text-faint">
                  {strings.settings.noSearch}
                </p>
              ) : (
                <SearchKeys
                  keys={searches}
                  probe={probe}
                  probing={probing}
                  onTest={test}
                  onSetKey={setKey}
                  onRemove={removeProvider}
                  onMove={moveSearchKey}
                />
              )}
              <SearchEndpointForm />
            </div>
          ) : null}

          {section.id === "limits" ? (
            <div className="pt-1">
              <BudgetPanel />
            </div>
          ) : null}

          {section.id === "storage" ? (
            <div className="pt-1">
              <StoragePanel />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * "Add one more", in both sections.
 *
 * One component so the two cannot drift again: it was a filled button in the
 * Models header and a bare text link under the search list, which made the same
 * job in the same page look like two different kinds of thing. It sits at the
 * foot of the list it adds to, because that is where the list ends.
 */
function AddRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-[24px] items-center gap-2 rounded-card px-2 py-1.5 text-sm",
        "text-muted transition-colors hover:bg-solid hover:text-text",
      )}
    >
      <PlusIcon />
      {label}
    </button>
  );
}

/**
 * Adding a search endpoint (§16.5).
 *
 * Separate from onboarding because it is not a model: nothing runs on it, and
 * an app that has only this still cannot start a mission. Its whole effect is
 * that `web_search` appears in the tool registry — with no key it is absent
 * rather than present and failing (§15 row 32).
 */
function SearchEndpointForm() {
  const engines = useSettingsStore((s) => s.searchEngines);
  const providers = useSettingsStore((s) => s.providers);
  const createProvider = useSettingsStore((s) => s.createProvider);
  const test = useSettingsStore((s) => s.test);
  const [open, setOpen] = useState(false);
  const [engineId, setEngineId] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (engines.length === 0) return null;
  const engine = engines.find((e) => e.id === engineId) ?? engines[0]!;
  const configured = providers.filter((p) => p.kind === "search");

  if (!open) {
    return (
      <AddRow
        label={
          configured.length > 0
            ? strings.settings.addAnotherSearch
            : strings.settings.addSearch
        }
        onClick={() => setOpen(true)}
      />
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-line bg-solid p-3">
      <p className="text-xs text-muted">{strings.settings.searchHint}</p>

      <Select
        value={engine.id}
        onChange={setEngineId}
        options={engines.map((e) => ({ value: e.id, label: e.name }))}
      />
      {/* The base URL is shown rather than typed: it is what tells the backend
          which API this is, so it is not something to get wrong by hand. */}
      <code className="block truncate text-[11px] text-faint">
        {engine.baseUrl}
      </code>

      <Input
        type="password"
        autoComplete="off"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={strings.onboarding.keyPlaceholder}
      />
      {error ? <p className="text-xs text-stop">{error}</p> : null}

      <div className="flex gap-2">
        <Button
          disabled={busy || !key.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const created = await createProvider({
                name: engine.name,
                kind: "search",
                // No model to choose here; the engine id is what the card shows
                // and what makes two search profiles tellable apart.
                model: engine.id,
                base_url: engine.baseUrl,
                key: key.trim(),
              });
              // Tested straight away: a wrong key found now beats one found
              // three minutes into a mission (§3.1).
              await test(created.id);
              setKey("");
              setOpen(false);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? strings.settings.savingSearch : strings.settings.saveSearch}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          {strings.teams.close}
        </Button>
      </div>
    </div>
  );
}
