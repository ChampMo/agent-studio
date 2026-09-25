import { describe, expect, it } from "vitest";

import { TIERS, runsUnder, tierFor } from "./tiers";

const SHIPPED = {
  max_tokens: 200_000,
  timeout_sec: 900,
  max_llm_calls: 40,
  max_supersteps: 60,
};

describe("which step a machine is on", () => {
  it("recognises the shipped set", () => {
    expect(tierFor(SHIPPED)?.max_tokens).toBe(200_000);
  });

  it("is not on a step it only mostly matches", () => {
    // Raising the tokens box alone is the most likely thing anybody does after
    // being told "Out of tokens" — and it is exactly the state a step does not
    // describe. Claiming it does would make the panel disagree with itself.
    expect(tierFor({ ...SHIPPED, max_tokens: 400_000 })).toBeNull();
  });

  it("offers steps that rise on every field at once", () => {
    // The whole reason for a step: raising one number moves which wall you
    // hit rather than moving the wall.
    for (let i = 1; i < TIERS.length; i += 1) {
      const lower = TIERS[i - 1]!;
      const higher = TIERS[i]!;
      expect(higher.max_tokens).toBeGreaterThan(lower.max_tokens);
      expect(higher.timeout_sec).toBeGreaterThan(lower.timeout_sec);
      expect(higher.max_llm_calls).toBeGreaterThan(lower.max_llm_calls);
      expect(higher.max_supersteps).toBeGreaterThan(lower.max_supersteps);
    }
  });
});

describe("what the record says about a ceiling", () => {
  // The real figures off this machine, and the ones in the repo's notes.
  const spent = [12_856, 198_857, 605_853, 1_262_610];

  it("counts the runs that spent less", () => {
    expect(runsUnder(100_000, spent)).toBe(1);
    expect(runsUnder(200_000, spent)).toBe(2);
    expect(runsUnder(600_000, spent)).toBe(2);
    expect(runsUnder(1_500_000, spent)).toBe(4);
  });

  it("counts a run that spent exactly the ceiling as under it", () => {
    expect(runsUnder(200_000, [200_000])).toBe(1);
  });

  it("says nothing rather than zero when there is no history", () => {
    // The caller renders nothing at all for an empty record; this is only
    // here to pin that the function does not invent a denominator.
    expect(runsUnder(200_000, [])).toBe(0);
  });
});
