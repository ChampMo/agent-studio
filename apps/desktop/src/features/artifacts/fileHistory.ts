/**
 * What happened to each file, off the log.
 *
 * The Files tab used to be a list of one thing: `final-answer.md`, because
 * that was the only place in the whole codebase that published
 * `artifact.created`. Even now that an agent's writes are recorded, a flat
 * list of paths answers the least interesting question — *which files exist* is
 * something a file manager already tells you, and the workspace chip opens one.
 *
 * What the app knows and a file manager does not is **who changed what, when,
 * and in which order**. Three agents touched `app/globals.css` across two
 * rounds; a directory listing shows one file and one timestamp.
 *
 * Derived, not stored (§2.1). Every write is already on the log as an
 * `agent.tool.start` naming the path and an `agent.tool.end` carrying the
 * backend's own summary — *wrote 2,898 bytes to app/globals.css* — and that
 * sentence is used verbatim rather than re-phrased, because it is the record
 * and a paraphrase is a second version of it.
 *
 * A failed write is kept and marked. It is the most useful line here: a file
 * that is missing because writing it did not work looks exactly like a file
 * nobody tried to write, and only this distinguishes them.
 */
import type { SequencedEntry } from "../../stores/eventStore";

/** The tools whose success means a file changed. */
const FILE_TOOLS: Record<string, "wrote" | "edited"> = {
  write_file: "wrote",
  edit_file: "edited",
};

export interface FileChange {
  id: string;
  ts: string | null;
  agentId: string | null;
  name: string;
  verb: "wrote" | "edited";
  /** The backend's own sentence, kept as written. */
  summary: string;
  ok: boolean;
}

export interface FileTrail {
  path: string;
  changes: FileChange[];
  /** Last change first is what a reader wants; the trail itself stays in the
   *  order it happened. */
  lastTs: string | null;
  /** False when every attempt on this path failed — the file is not there, and
   *  saying "3 changes" about it would be describing work that produced
   *  nothing. */
  exists: boolean;
}

export function fileTrails(
  events: SequencedEntry[],
  nameOf: (agentId: string) => string,
): FileTrail[] {
  //: callId -> what the start said, waiting for its end.
  const pending = new Map<
    string,
    { verb: "wrote" | "edited"; path: string; agentId: string | null }
  >();
  const byPath = new Map<string, FileTrail>();

  for (const { event } of events) {
    const type = event.draft.type;
    const p = event.draft.payload as unknown as Record<string, unknown>;
    const callId = String(p.callId ?? "");
    if (!callId) continue;

    if (type === "agent.tool.start") {
      const verb = FILE_TOOLS[String(p.tool ?? "")];
      const path = String((p.input as Record<string, unknown>)?.path ?? "");
      if (verb && path) {
        pending.set(callId, {
          verb,
          path,
          agentId: typeof p.agentId === "string" ? p.agentId : null,
        });
      }
      continue;
    }

    if (type !== "agent.tool.end") continue;
    const started = pending.get(callId);
    if (!started) continue;
    pending.delete(callId);

    const trail = byPath.get(started.path) ?? {
      path: started.path,
      changes: [],
      lastTs: null,
      exists: false,
    };
    const ok = p.ok === true;
    trail.changes.push({
      id: event.id,
      ts: event.ts ?? null,
      agentId: started.agentId,
      name: started.agentId ? nameOf(started.agentId) : "",
      verb: started.verb,
      summary: String(p.summary ?? ""),
      ok,
    });
    trail.lastTs = event.ts ?? trail.lastTs;
    // One success is enough for the file to be there. A later failed edit does
    // not un-write it.
    trail.exists = trail.exists || ok;
    byPath.set(started.path, trail);
  }

  // Most recently touched first: that is where anyone looking at a run that
  // just stopped wants to start.
  return [...byPath.values()].sort((a, b) => {
    if (!a.lastTs || !b.lastTs) return 0;
    return Date.parse(b.lastTs) - Date.parse(a.lastTs);
  });
}

/** How many times each file changed, and how many files there are — the two
 *  numbers worth putting on a tab. */
export function countChanges(trails: FileTrail[]): number {
  return trails.reduce((n, trail) => n + trail.changes.length, 0);
}
