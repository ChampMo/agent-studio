/**
 * The M1 deliverable: send a message, watch tokens arrive, stop it mid-flight.
 *
 * The panel never calls a provider. It POSTs to start a mission and reads
 * everything else off the event store, which reads the socket — the same stream
 * the timeline renders (PROJECT_BRIEF.md §2.1).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { api } from "../../transport/rest";
import { buildTurns, useEventStore } from "../../stores/eventStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { Badge, Button, Input } from "../../components/ui/primitives";

export function ChatPanel() {
  const active = useSettingsStore((s) => s.active());
  const attach = useEventStore((s) => s.attach);
  const missionId = useEventStore((s) => s.missionId);
  const connection = useEventStore((s) => s.connection);
  const endReason = useEventStore((s) => s.endReason);
  // Subscribe to the raw slices and derive here: a selector that builds an
  // array returns a new reference every call, which zustand reads as a changed
  // snapshot and loops forever.
  const events = useEventStore((s) => s.events);
  const streaming = useEventStore((s) => s.streaming);
  const turns = useMemo(
    () => buildTurns(events, streaming),
    [events, streaming],
  );

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const running = missionId !== null && endReason === null;

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns.length, turns[turns.length - 1]?.text]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!active || !draft.trim()) return;
    setSending(true);
    setError(null);
    try {
      const { missionId: id } = await api.startChat({
        provider_id: active.id,
        content: draft.trim(),
      });
      setDraft("");
      // Subscribe from seq 0: mission.started and user.message were already
      // published before this response arrived, and the replay covers them.
      attach(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    if (missionId) await api.cancelMission(missionId);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            {strings.nav.chat}
          </h2>
          {active ? (
            <p className="truncate text-xs text-faint">
              {active.name} · <span className="font-mono">{active.model}</span>
            </p>
          ) : null}
        </div>
        <Badge tone={connection === "open" ? "good" : "neutral"}>
          {strings.connection[connection] ?? connection}
        </Badge>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {turns.length === 0 ? (
          <p className="text-sm text-faint">
            {active ? strings.chat.empty : strings.chat.noProvider}
          </p>
        ) : null}

        {turns.map((turn) => (
          <div
            key={turn.id}
            className={
              turn.role === "user" ? "flex justify-end" : "flex justify-start"
            }
          >
            <div
              className={`max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                turn.role === "user"
                  ? "bg-accent/20 text-text"
                  : "bg-solid-2 text-text"
              }`}
            >
              {turn.text || (turn.streaming ? strings.chat.thinking : "")}
              {turn.usage ? (
                <div className="mt-1.5 border-t border-line pt-1 text-[11px] text-muted">
                  {turn.usage.inputTokens} in · {turn.usage.outputTokens} out
                  {/* Absent for a model with no published rate: a guessed price
                      in an append-only table would read as fact (§6.2). */}
                  {turn.usage.costUsd !== undefined
                    ? ` · $${turn.usage.costUsd.toFixed(6)}`
                    : ""}
                </div>
              ) : null}
            </div>
          </div>
        ))}

        {endReason && endReason !== "completed" ? (
          <p className="text-xs text-attn">
            {strings.chat.endedPrefix}: {endReason}
          </p>
        ) : null}

        {error ? (
          <p className="rounded-md bg-stop/10 px-3 py-2 text-sm text-stop">
            {error}
          </p>
        ) : null}

        <div ref={bottom} />
      </div>

      <form onSubmit={send} className="flex gap-2 border-t border-line p-3">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={strings.chat.placeholder}
          disabled={!active || sending}
        />
        {running ? (
          <Button type="button" variant="danger" onClick={stop}>
            {strings.chat.stop}
          </Button>
        ) : (
          <Button type="submit" disabled={!active || sending || !draft.trim()}>
            {strings.chat.send}
          </Button>
        )}
      </form>
    </div>
  );
}
