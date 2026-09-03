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
import { Checkbox } from "../../components/ui/Checkbox";
import type { ToolRisk } from "../../transport/rest";

const TONE: Record<ToolRisk, "neutral" | "warn" | "bad"> = {
  safe: "neutral",
  guarded: "warn",
  dangerous: "bad",
};

export function ToolPicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (tools: string[]) => void;
}) {
  const tools = useToolStore((s) => s.tools);
  const load = useToolStore((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((t) => t !== id) : [...value, id]);
  };

  return (
    <div className="space-y-3">
      <Field label={strings.tools.title}>
        {tools.length === 0 ? (
          <p className="text-xs text-slate-500">{strings.tools.none}</p>
        ) : (
          <div className="space-y-1">
            {tools.map((tool) => (
              <Checkbox
                key={tool.id}
                checked={value.includes(tool.id)}
                onChange={() => toggle(tool.id)}
                className={cn(
                  "rounded-card border px-3 transition-colors",
                  value.includes(tool.id)
                    ? "border-accent/50 bg-accent/5"
                    : "border-line bg-solid",
                )}
                label={
                  <span className="flex flex-wrap items-center gap-2">
                    <span>{tool.title}</span>
                    <code className="text-[11px] text-faint">{tool.id}</code>
                    <Badge tone={TONE[tool.risk]}>
                      {strings.tools.risk[tool.risk] ?? tool.risk}
                    </Badge>
                    {tool.requires.includes("workspace") ? (
                      <span className="text-[11px] text-faint">
                        {strings.tools.needsWorkspace}
                      </span>
                    ) : null}
                  </span>
                }
                hint={tool.description}
              />
            ))}
          </div>
        )}
      </Field>


      {/* The "trusted removes the only gate" warning moved with the setting,
          to the control that now owns it beside the composer. Warning about a
          choice on a page where the choice no longer lives is noise. */}
    </div>
  );
}
