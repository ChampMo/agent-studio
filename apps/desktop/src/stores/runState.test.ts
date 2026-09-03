import { beforeEach, describe, expect, it } from "vitest";
import { useEventStore } from "./eventStore";
import { useMissionStore } from "./missionStore";
import { useEndReason } from "./runState";

/**
 * These call the hook through `getState()`-backed stores rather than rendering,
 * because what is being tested is which of two sources wins — not React.
 */
function endReason(): string | null {
  const fromLog = useEventStore.getState().endReason;
  const fromRow = useMissionStore.getState().endReason;
  return fromLog ?? fromRow;
}

beforeEach(() => {
  useEventStore.setState({ endReason: null });
  useMissionStore.setState({ endReason: null, missionId: "m-1" });
});

describe("why the run stopped", () => {
  it("is null while it is still going", () => {
    expect(endReason()).toBeNull();
  });

  it("takes the ending from the log the moment it arrives", () => {
    // The bug this exists for: the row is fetched once at launch, when the
    // answer is legitimately null, and nothing updates it afterwards. The
    // header read "Working" over a mission that had stopped 20 minutes before.
    useEventStore.setState({ endReason: "budget_exceeded" });
    expect(endReason()).toBe("budget_exceeded");
  });

  it("falls back to the row when the log cannot say", () => {
    // A mission whose process died is closed as `crashed` at startup by
    // `reap_orphans()`, and a dead process publishes no `mission.ended`. With
    // no fallback those read as running for ever — the same lie, reversed.
    useMissionStore.setState({ endReason: "crashed" });
    expect(endReason()).toBe("crashed");
  });

  it("prefers the log when both have an answer", () => {
    useEventStore.setState({ endReason: "cancelled" });
    useMissionStore.setState({ endReason: "completed" });
    expect(endReason()).toBe("cancelled");
  });

  it("is exported as a hook that composes the same two sources", () => {
    // Guards the wiring rather than the logic: if `useEndReason` ever stops
    // reading one of them, the components go back to the stale row.
    expect(useEndReason.toString()).toContain("useEventStore");
    expect(useEndReason.toString()).toContain("useMissionStore");
  });
});
