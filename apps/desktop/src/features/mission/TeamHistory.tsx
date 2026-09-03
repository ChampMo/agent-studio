/**
 * What this team's last few runs cost, beside the box where you set the limit.
 *
 * There is no honest way to *estimate* a run. §1.1 rules out a number the app
 * made up, and no provider will tell you in advance what a conversation will
 * cost. So this is not a forecast and is not offered as one.
 *
 * What there is, is the record — and it turns out to be the thing that was
 * missing. The same team spent 1,262,610 tokens on one job and 23,538 on
 * another, fifty times apart, and the screen where a ceiling gets typed knew
 * neither figure. More runs died of a budget set blind than of anything else.
 *
 * Counted off `mission_events`, adding the four fields the budget guard adds.
 * A number shown beside a limit has to count what the limit counts — a rule
 * this app has now had to learn three separate times.
 */
import { useEffect, useState } from "react";

import { strings } from "../../lib/constants/strings.en";
import { formatDay } from "../../lib/format";
import { missionLook } from "../../components/ui/status";
import { api, type TeamRun } from "../../transport/rest";

export function TeamHistory({ teamId }: { teamId: string | null }) {
  const [runs, setRuns] = useState<TeamRun[] | null>(null);

  useEffect(() => {
    if (!teamId) {
      setRuns(null);
      return;
    }
    let alive = true;
    void api
      .teamHistory(teamId)
      .then((r) => alive && setRuns(r.runs))
      // A history that cannot be fetched shows nothing rather than an error:
      // it is a convenience beside a field that works without it.
      .catch(() => alive && setRuns([]));
    return () => {
      alive = false;
    };
  }, [teamId]);

  if (!runs || runs.length === 0) return null;

  return (
    <div className="space-y-1 pt-1">
      <p className="text-[11px] text-faint">{strings.mission.pastRuns}</p>
      <ul className="space-y-0.5">
        {runs.map((run) => {
          const look = missionLook(null, run.endReason, run.endLimit);
          return (
            <li
              key={run.id}
              className="flex items-baseline gap-2 text-[11px] tabular-nums"
            >
              <span className="min-w-0 flex-1 truncate text-muted">
                {run.title || formatDay(new Date(run.startedAt), new Date())}
              </span>
              {run.tasksTotal ? (
                <span className="shrink-0 text-faint">
                  {run.tasksDone ?? 0}/{run.tasksTotal}
                </span>
              ) : null}
              {/* Zero is a real answer — a run reaped as crashed before it
                  spent anything — so it is printed rather than hidden. */}
              <span className="shrink-0 text-faint">
                {run.tokens.toLocaleString("en")}
              </span>
              <span className="w-[5.5rem] shrink-0 truncate text-faint">
                {look.label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
