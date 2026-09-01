/**
 * Which tools an agent carries, and how much it is trusted (§16.1, §16.4).
 *
 * The list comes from the backend, so what is offered here is exactly what can
 * actually run on this machine — a tool with no key behind it is absent rather
 * than present and broken (§15 row 32).
 *
 * The `trusted` warning is the one piece of copy in this app that has to be
 * blunt. There is no sandbox behind the question it removes (§2.7), and an
 * interface that implied otherwise would be the app lying about what it is.
 */
import { useEffect } from "react";
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { useToolStore } from "../../stores/toolStore";
import { Badge, Field } from "../../components/ui/primitives";
import type { Autonomy, ToolRisk } from "../../transport/rest";

const TONE: Record<ToolRisk, "neutral" | "warn" | "bad"> = {
  safe: "neutral",
  guarded: "warn",
  dangerous: "bad",
};

export function ToolPicker({
  value,
  autonomy,
  onChange,
  onAutonomyChange,
}: {
  value: string[];
  autonomy: Autonomy;
  onChange: (tools: string[]) => void;
  onAutonomyChange: (autonomy: Autonomy) => void;
}) {
  const tools = useToolStore((s) => s.tools);
  const load = useToolStore((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((t) => t !== id) : [...value, id]);
  };

  const holdsDangerous = tools.some(
    (t) => value.includes(t.id) && t.risk === "dangerous",
  );

  return (
    <div className="space-y-3">
      <Field label={strings.tools.title}>
        {tools.length === 0 ? (
          <p className="text-xs text-slate-500">{strings.tools.none}</p>
        ) : (
          <div className="space-y-1">
            {tools.map((tool) => (
              <label
                key={tool.id}
                className={cn(
                  "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2",
                  value.includes(tool.id)
                    ? "border-sky-800 bg-sky-950/30"
                    : "border-slate-800 bg-slate-900/40",
                )}
              >
                <input
                  type="checkbox"
                  checked={value.includes(tool.id)}
                  onChange={() => toggle(tool.id)}
                  className="mt-1 accent-sky-500"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-sm text-slate-200">{tool.title}</span>
                    <code className="text-[11px] text-slate-500">{tool.id}</code>
                    <Badge tone={TONE[tool.risk]}>
                      {strings.tools.risk[tool.risk] ?? tool.risk}
                    </Badge>
                    {tool.requires.includes("workspace") ? (
                      <span className="text-[11px] text-slate-500">
                        {strings.tools.needsWorkspace}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-400">
                    {tool.description}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
      </Field>

      <Field label={strings.tools.autonomy}>
        <select
          value={autonomy}
          onChange={(e) => onAutonomyChange(e.target.value as Autonomy)}
          className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
        >
          {(["ask_always", "ask_dangerous", "trusted"] as const).map((option) => (
            <option key={option} value={option}>
              {strings.tools.autonomyOptions[option]}
            </option>
          ))}
        </select>
      </Field>

      {autonomy === "trusted" && holdsDangerous ? (
        // Said plainly, because it is true and because the alternative is an
        // app that implies a container it does not have (§2.7).
        <p className="rounded-md border border-red-900/60 bg-red-950/30 p-3 text-xs text-red-300">
          {strings.tools.trustedWarning}
        </p>
      ) : null}
    </div>
  );
}
