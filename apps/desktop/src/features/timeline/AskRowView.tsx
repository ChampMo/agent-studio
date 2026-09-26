/**
 * A question, answered where it was asked (§7.3, §12 M6).
 *
 * It used to be a card in the right rail. The rail was already better than the
 * modal before it, but it still put the question somewhere other than the place
 * that explains it: deciding whether an agent may run `bash` means reading what
 * it just did, and that is three inches to the left and half a screen up.
 *
 * So the question sits in the transcript, at the moment it happened, with its
 * own way to answer — buttons for an approval, a box for anything else.
 *
 * **Whether it is still waiting is not derived here.** The row records that a
 * question was asked; `approvalStore` knows which are still outstanding, and it
 * knows because the backend told it (over REST on mount, over the stream while
 * open). Deciding "pending" by scanning the log for a matching `resolved` would
 * be a second implementation of a fact the backend already owns — and it would
 * be wrong for the case that matters: a question asked by a process that no
 * longer exists (§12 M6).
 *
 * Answered questions keep their place and lose their controls. The transcript
 * is a record; a question that was asked stays asked.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { parseAsk } from "./choices";
import { cn } from "../../lib/cn";
import { Portrait } from "../../components/ui/Portrait";
import { useApprovalStore } from "../../stores/approvalStore";
import type { AskRow } from "./transcript";

/**
 * The command, out of the envelope it arrived in.
 *
 * A tool approval's question is built as `Run bash?` followed by the tool's
 * whole JSON input, so what the person is shown is
 * `{ "command": "ls -la", "timeout": 180 }`. **They are approving a command,
 * not a payload** — and the quoting that JSON adds is exactly the part that
 * makes a shell line hard to read at the moment it matters most.
 *
 * Returns null when there is nothing of that shape, and then the question is
 * shown as it was: a shape this build does not recognise is not something to
 * guess at (§8).
 */
function shellCommand(question: string): string | null {
  const brace = question.indexOf("{");
  if (brace === -1) return null;
  try {
    const input = JSON.parse(question.slice(brace)) as Record<string, unknown>;
    const command = input.command;
    if (typeof command !== "string" || !command.trim()) return null;
    const head = question.slice(0, brace).trim();
    // The timeout is a real part of what is being allowed — a command with ten
    // minutes to run is a different proposition from one with two.
    const seconds = typeof input.timeout === "number" ? input.timeout : null;
    const tail = seconds ? "(up to " + seconds + "s)" : "";
    return [head, "", command, tail].filter(Boolean).join("\n");
  } catch {
    return null;
  }
}

export function AskRowView({
  row,
  avatar,
}: {
  row: AskRow;
  avatar: Record<string, string> | null;
}) {
  const pending = useApprovalStore((s) => s.pending);
  const answering = useApprovalStore((s) => s.answering);
  const answer = useApprovalStore((s) => s.answer);
  const error = useApprovalStore((s) => s.error);

  const [reply, setReply] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);

  const waiting = pending.some((r) => r.requestId === row.requestId);
  const busy = answering === row.requestId;

  useEffect(() => {
    // The run is stopped on this. Putting the caret in it saves the one click
    // that stands between a paused mission and carrying on.
    if (waiting) box.current?.focus();
  }, [waiting]);

  const options = row.options?.length ? row.options : ["approve", "reject"];
  const isApproval = row.ask === "approval";
  //: Parsed from the question the agent wrote. Memoised on the text, because
  //: the text is the only thing it depends on.
  const parsed = useMemo(
    () =>
      isApproval
        ? { text: row.question ?? "", choices: [] }
        : parseAsk(row.question ?? ""),
    [isApproval, row.question],
  );
  // **Structured first, prose second.** An agent that filled in `options` said
  // exactly what it meant; `parseAsk` is a *reading* of prose and refuses
  // anything it is not sure of, which is why a question written as a
  // paragraph — the case this was reported for — offered nothing at all. The
  // reading is kept for runs recorded before the field existed (§8).
  const offered = useMemo(
    () =>
      !isApproval && row.options?.length
        ? row.options.map((text) => ({ text, marker: null as string | null }))
        : parsed.choices.map((c) => ({ text: c.text, marker: c.marker })),
    [isApproval, row.options, parsed.choices],
  );

  /** Finished cards start shut. */
  const [open, setOpen] = useState(false);
  // The question as shown: an approval keeps its exact command, and an
  // `ask_user` has its option list lifted out into the buttons below. Nothing
  // is hidden — every word taken out is on a button, and the untouched text is
  // on the log either way.
  const asked = shellCommand(row.question) ?? parsed.text;

  return (
    // Marked so the bar above the scroll can find it: a question held at the
    // top has to be able to take you to where it was asked.
    <div className="flex gap-2.5 py-1" data-ask={row.requestId}>
      {/* The same 36px column every other row uses for a face. It was 28 here
          and 36 everywhere else, so the card started at a different left edge
          from the messages around it. */}
      <div className="w-9 shrink-0">
        <Portrait avatar={avatar} name={row.name ?? "?"} />
      </div>

      <div
        className={cn(
          // One radius on all four corners. The tail — a 4px bottom-left
          // against a 12px everywhere else — belongs on a speech bubble, where
          // it points at the speaker. On a card with a coloured left edge it
          // read as a corner that had been sliced off, because a 3px straight
          // border cannot follow two different curves.
          "min-w-0 flex-1 rounded-[10px] border border-l-2 p-3",
          // The waiting colour while it is waiting, and only then. A question
          // answered ten minutes ago is not still asking.
          waiting
            ? "border-wait/30 border-l-wait bg-wait/5"
            : "border-line border-l-line bg-solid-2",
        )}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-text">
            {row.name ?? strings.approval.questionTitle}
          </span>
          <span
            className={cn("text-[11px]", waiting ? "text-wait" : "text-faint")}
          >
            {waiting
              ? isApproval
                ? strings.approval.approvalTitle
                : strings.approval.questionTitle
              : strings.approval.answered}
          </span>
        </div>

        {/* Pre-wrapped so a numbered plan stays a list, and scrollable so a
            long one cannot push the controls off the bottom.

            Answered ones collapse to their first line. Three finished cards in
            a row filled most of a screen with decisions already taken, and the
            record only has to *hold* them — it does not have to shout them. */}
        {waiting || open ? (
          <pre className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted">
            {asked}
          </pre>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-1 flex w-full min-h-[24px] items-center gap-1.5 rounded-card text-left"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">
              {asked.split("\n")[0]}
            </span>
            <span className="shrink-0 text-faint" aria-hidden>
              ›
            </span>
          </button>
        )}

        {waiting ? (
          <div className="mt-2.5">
            {isApproval ? (
              <div className="flex flex-wrap gap-2">
                {options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    disabled={busy}
                    onClick={() => void answer(row.requestId, option)}
                    className={cn(
                      "min-h-[36px] rounded-card px-3 text-xs font-medium",
                      "transition-[filter] disabled:opacity-40",
                      option === "approve"
                        ? "bg-wait text-[#2a1c00] hover:brightness-110"
                        : "border border-line text-muted hover:bg-solid hover:text-text",
                    )}
                  >
                    {strings.approval.option[option] ?? option}
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                {/* Options the agent itself offered, as buttons.
                    `choicesIn` reads them out of the question and refuses
                    anything it is not sure of, so this is either the agent's
                    own list or nothing at all — never a guess (see
                    `choices.ts`). The reply box is always here underneath:
                    a list of options is not the same as a closed set, and the
                    agent asked in prose for a reason. */}
                {offered.length > 0 ? (
                  <ul className="space-y-1">
                    {offered.map((choice, i) => {
                      const suggested = row.recommended === choice.text;
                      return (
                        <li key={choice.marker ?? `${i}-${choice.text}`}>
                          <button
                            type="button"
                            disabled={busy}
                            // What is sent is the label, not the letter: "a" on
                            // the log is unreadable a week later, and this is
                            // the record (§9.3).
                            onClick={() =>
                              void answer(row.requestId, choice.text)
                            }
                            className={cn(
                              "flex w-full min-h-[36px] items-start gap-2 rounded-card px-3 py-2 text-left",
                              "border bg-attn-soft text-xs leading-snug text-text",
                              "hover:border-attn disabled:opacity-40",
                              // The suggested one is a heavier edge, not a
                              // different colour: amber already means "this
                              // is waiting on you" all over this card, and
                              // spending a second colour here would make both
                              // mean less.
                              suggested
                                ? "border-attn border-2"
                                : "border-attn-edge",
                            )}
                          >
                            {choice.marker ? (
                              <span className="shrink-0 font-mono text-[11px] text-attn">
                                {choice.marker})
                              </span>
                            ) : null}
                            <span className="min-w-0 flex-1">{choice.text}</span>
                            {/* Named, because it is the agent's view and not
                                the app's. A bare "Recommended" reads as the
                                app having an opinion it is in no position to
                                have (§1.1). */}
                            {suggested ? (
                              <span className="shrink-0 text-[10px] text-attn">
                                {strings.approval.suggests(row.name)}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}

                <label htmlFor={`ask-${row.requestId}`} className="sr-only">
                  {strings.approval.replyPlaceholder}
                </label>
                <textarea
                  id={`ask-${row.requestId}`}
                  ref={box}
                  rows={2}
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      const value = event.currentTarget.value;
                      if (!value.trim() || busy) return;
                      event.preventDefault();
                      void answer(row.requestId, value.trim());
                    }
                  }}
                  placeholder={strings.approval.replyPlaceholder}
                  className={cn(
                    "block w-full resize-none rounded-card border border-line bg-solid",
                    "px-3 py-2 text-sm text-text placeholder:text-faint",
                  )}
                />
                <button
                  type="button"
                  disabled={busy || !reply.trim()}
                  onClick={() => void answer(row.requestId, reply.trim())}
                  className={cn(
                    "min-h-[36px] rounded-card bg-wait px-3 text-xs font-medium",
                    "text-[#2a1c00] transition-[filter] hover:brightness-110",
                    "disabled:opacity-40",
                  )}
                >
                  {busy ? strings.approval.sending : strings.approval.send}
                </button>
              </div>
            )}

            {error ? (
              <p className="mt-2 text-[11px] text-stop">{error}</p>
            ) : null}
            <p className="mt-2 text-[10px] leading-snug text-faint">
              {strings.approval.footnote}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
