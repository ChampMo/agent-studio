/**
 * The gate in front of a plan (PROJECT_BRIEF.md §7.3, §12 M6).
 *
 * Rendered at the top of the app rather than inside the mission panel: the
 * question can belong to a mission the user is not currently looking at — or to
 * one started in a previous session — and burying it in a tab nobody has open
 * is the same as never asking.
 */
import { useEffect, useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { useApprovalStore } from "../../stores/approvalStore";
import { Button } from "../../components/ui/primitives";

export function ApprovalModal() {
  const pending = useApprovalStore((s) => s.pending);
  const answering = useApprovalStore((s) => s.answering);
  const deferred = useApprovalStore((s) => s.deferred);
  const defer = useApprovalStore((s) => s.defer);
  const error = useApprovalStore((s) => s.error);
  const answer = useApprovalStore((s) => s.answer);
  const refresh = useApprovalStore((s) => s.refresh);
  const [reply, setReply] = useState("");

  // On mount, because the question may predate this window (§12 M6).
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // One at a time: two stacked modals asking different things is a way to
  // answer the wrong one.
  const request = pending.find((r) => !deferred.includes(r.requestId));
  useEffect(() => setReply(""), [request?.requestId]);
  if (!request) return null;

  const busy = answering === request.requestId;
  const isApproval = request.kind === "approval";
  const options = request.options ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-6">
      <div className="w-full max-w-lg space-y-4 rounded-lg border border-amber-800/60 bg-slate-900 p-5 shadow-xl">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400">
            {isApproval ? strings.approval.approvalTitle : strings.approval.questionTitle}
          </h2>
          {pending.length > 1 ? (
            <span className="text-[11px] text-slate-500">
              {strings.approval.more(pending.length - 1)}
            </span>
          ) : null}
        </div>

        {request.goal ? (
          <p className="text-xs text-slate-500">{request.goal}</p>
        ) : null}

        {/* The plan, as written. Pre-wrapped so a numbered list stays a list. */}
        <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-200">
          {request.question}
        </pre>

        {error ? (
          <p className="text-xs text-red-400">{error}</p>
        ) : null}

        {isApproval || options.length > 0 ? (
          <div className="flex gap-2">
            {(options.length > 0 ? options : ["approve", "reject"]).map((option) => (
              <Button
                key={option}
                disabled={busy}
                variant={option === "approve" ? "primary" : "secondary"}
                onClick={() => void answer(request.requestId, option)}
              >
                {strings.approval.option[option as "approve" | "reject"] ?? option}
              </Button>
            ))}
          </div>
        ) : (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (reply.trim()) void answer(request.requestId, reply.trim());
            }}
          >
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              rows={3}
              placeholder={strings.approval.replyPlaceholder}
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
            />
            <Button type="submit" disabled={busy || !reply.trim()}>
              {busy ? strings.approval.sending : strings.approval.send}
            </Button>
          </form>
        )}

        {/* Deciding often needs a look at the roster or the timeline first.
            "Later" hides the modal without answering: the mission stays paused,
            the request stays in the list, and the header keeps saying so. What
            there is no button for is dismissing the question itself. */}
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-slate-500">{strings.approval.footnote}</p>
          <Button variant="ghost" disabled={busy} onClick={() => defer(request.requestId)}>
            {strings.approval.later}
          </Button>
        </div>
      </div>
    </div>
  );
}
