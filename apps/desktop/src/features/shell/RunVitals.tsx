/**
 * Who is on this run, and what it has cost (§18.2, §6.2).
 *
 * The members come from the mission's frozen roster, so a run from last week
 * lists the people who actually did the work under the names and faces they had
 * at the time (§5.1). Their status and their token count come from the log.
 *
 * Every figure is real. There is no progress percentage, no score, no estimate
 * of what the run "will" cost — §1.1 rules those out, and money is the last
 * place to start guessing. The one bar on screen is drawn against a limit that
 * exists, and it is the token budget, which is the ceiling that actually stops
 * a mission.
 */
import { strings } from "../../lib/constants/strings.en";
import { agentLook } from "../../components/ui/status";
import { Portrait } from "../../components/ui/Portrait";
import type { SnapshotMember } from "../../stores/missionStore";
import { formatDuration, formatTokens, type Vitals } from "./vitals";

export function RunVitals({
  roster,
  vitals,
}: {
  roster: SnapshotMember[];
  vitals: Vitals;
}) {
  return (
    <>
      {roster.length > 0 ? (
        <section aria-label={strings.rail.members(roster.length)}>
          <h3 className="px-1 pb-1.5 text-[11px] font-medium text-faint">
            {strings.rail.members(roster.length)}
          </h3>
          {/* Rows, not cards. A card says "a thing on its own", and these are
              one team spending one budget — the interesting fact about a member
              is their share of it, which a border around each name hides. Same
              argument that took the cards off the models and the search keys.

              The bar is share of what this round has spent. Real arithmetic on
              real numbers, and drawn against the run's own total rather than
              the largest member: "Dev used most" is a rank, and a rank is a
              comparison the panel invents. What is true is 445.1k of 601.4k,
              which is what the bar draws (§1.1). */}
          <ul className="space-y-2">
            {roster.map((member) => {
              const stats = vitals.byAgent.get(member.agent_id);
              const look = stats?.status ? agentLook(stats.status) : null;
              const leader = member.role_in_team === "leader";
              const spent = stats?.tokens ?? 0;
              const share = vitals.tokens > 0 ? spent / vitals.tokens : 0;
              return (
                <li key={member.agent_id} className="flex gap-2.5 px-1">
                  {/* The face stays. It is the same `avatar_config` the scene
                      and the transcript draw through `lookFor`, so the person
                      in the room, the person in the chat and the person on
                      this row cannot become three different people. */}
                  <div className="mt-0.5 shrink-0">
                    <Portrait avatar={member.avatar_config} name={member.name} size={28} />
                  </div>

                  <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-text">
                      {member.name}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-faint">
                      {spent ? formatTokens(spent) : "—"}
                    </span>
                  </div>

                  {look || leader ? (
                    <p className="truncate text-[11px]">
                      {look ? (
                        <span className={TONE[look.tone]}>{look.label}</span>
                      ) : null}
                      {leader ? (
                        <span className="text-faint">
                          {look ? " · " : ""}
                          {strings.rail.leader}
                        </span>
                      ) : null}
                    </p>
                  ) : null}

                  {/* Drawn only once there is something to divide. A row of
                      empty troughs before the first token would be a chart of
                      nothing. */}
                  {vitals.tokens > 0 ? (
                    <div
                      className="mt-1 h-1 overflow-hidden rounded-full bg-solid-2"
                      role="meter"
                      aria-valuenow={spent}
                      aria-valuemin={0}
                      aria-valuemax={vitals.tokens}
                      aria-label={strings.rail.shareOf(member.name)}
                    >
                      <div
                        className="h-full rounded-full bg-accent/70 transition-[width]"
                        // A member who spent something gets a visible sliver:
                        // zero-width would read as "spent nothing", which is a
                        // different fact from "spent a little".
                        style={{ width: `${Math.max(share * 100, spent > 0 ? 2 : 0)}%` }}
                      />
                    </div>
                  ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section aria-label={strings.rail.budget}>
        <h3 className="px-1 pb-1.5 text-[11px] font-medium text-faint">
          {strings.rail.budget}
        </h3>
        {/* The whole conversation, because that is the thing being worked on.
            Continuing a run resets the round's counters — rightly, since the
            limits are per round — so this panel used to forget everything the
            moment a second question was asked.

            No limit beside any of them, and no bar under them. There is no
            mission-wide ceiling: each round gets a fresh budget, and drawing a
            total against a round's limit is the exact mistake that put
            45,856 / 200,000 over a run killed at 200,811. */}
        <dl className="space-y-1.5 rounded-[9px] bg-solid-2 px-3 py-2.5 text-xs">
          <Row
            label={strings.rail.tokensUsed}
            value={vitals.missionTokens.toLocaleString("en")}
            limit={null}
          />
          {/* Replies, not calls — see the note in vitals.ts. A round that only
              asked for tools publishes no message, so counting these as calls
              would undercount. */}
          <Row
            label={strings.rail.replies}
            value={String(vitals.missionReplies)}
            limit={null}
          />
          <Row
            label={strings.rail.timeUsed}
            value={formatDuration(vitals.missionElapsedMs)}
            limit={null}
          />
          <p className="pt-0.5 text-[11px] leading-snug text-faint">
            {strings.rail.wholeMission}
          </p>
          {/* No Cost row. The pricing table only carries rates that were
              verifiable at release, so on any other model this said "Not
              priced" on every run forever — and the alternative, asking the
              user to type their own rate in, is a chore in exchange for a
              number they can already read on their provider's billing page.
              A row that is permanently blank is worse than no row. */}
        </dl>

      </section>
    </>
  );
}

const TONE: Record<string, string> = {
  idle: "text-faint",
  search: "text-search",
  write: "text-write",
  wait: "text-wait",
  stop: "text-stop",
  done: "text-done",
};

function Row({
  label,
  value,
  limit,
  hint,
}: {
  label: string;
  value: string;
  limit: string | null;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2" title={hint}>
      <dt className="text-muted">{label}</dt>
      <dd className="shrink-0 tabular-nums text-text">
        {value}
        {limit ? <span className="text-faint"> / {limit}</span> : null}
      </dd>
    </div>
  );
}

/**
 * The token budget, as a bar.
 *
 * Colour changes at the same 80% the backend warns at, so the bar turning
 * amber and `budget.warning` appearing on the timeline are one event seen
 * twice, not two thresholds that can disagree (§10).
 */
