/**
 * The default model endpoint is a model endpoint.
 *
 * `activeId` decides which endpoint a generated profile — and now a suggested
 * team — is asked for. It was chosen as "the first provider with a key", and a
 * search key is a provider with a key. On the machine this was found on, Tavily
 * was configured before DeepSeek, so every generate defaulted to an endpoint
 * that cannot complete anything and failed with
 * `no provider registered for 'search'`.
 *
 * The store's own `needsOnboarding` had drawn this distinction correctly on the
 * line directly above. Two readers of the same idea, and the one nobody was
 * looking at was the wrong one — which is the shape §2.1 exists to prevent.
 */
import { describe, expect, it } from "vitest";

import { pickActive } from "./settingsStore";
import type { ProviderProfile } from "../transport/rest";

function profile(
  id: string,
  kind: ProviderProfile["kind"],
  extra: Partial<ProviderProfile> = {},
): ProviderProfile {
  return {
    id,
    name: id,
    kind,
    baseUrl: null,
    model: "m",
    capabilities: null,
    verifiedAt: null,
    hasKey: true,
    nativeSearch: false,
    nativeSearchAvailable: false,
    ...extra,
  } as ProviderProfile;
}

describe("the default model endpoint", () => {
  it("never picks a search key, however early it was added", () => {
    const providers = [
      profile("tavily", "search"),
      profile("deepseek", "openai_compatible"),
    ];
    expect(pickActive(providers, null)).toBe("deepseek");
  });

  it("replaces a stored search id rather than keeping it", () => {
    // A machine that ran the older build has one saved. Trusting the stored
    // value would leave it broken for ever.
    const providers = [
      profile("tavily", "search"),
      profile("deepseek", "openai_compatible"),
    ];
    expect(pickActive(providers, "tavily")).toBe("deepseek");
  });

  it("keeps a deliberate choice", () => {
    const providers = [
      profile("flash", "openai_compatible"),
      profile("pro", "openai_compatible"),
    ];
    expect(pickActive(providers, "pro")).toBe("pro");
  });

  it("drops a stored id whose profile is gone", () => {
    expect(pickActive([profile("flash", "openai_compatible")], "deleted")).toBe(
      "flash",
    );
  });

  it("prefers an endpoint that can actually be used", () => {
    // A local endpoint authenticates nothing, so `verifiedAt` counts too —
    // both are established facts rather than a guess about which endpoints
    // need a key.
    const providers = [
      profile("unconfigured", "openai_compatible", { hasKey: false }),
      profile("ollama", "openai_compatible", {
        hasKey: false,
        verifiedAt: "2026-01-01",
      }),
    ];
    expect(pickActive(providers, null)).toBe("ollama");
  });

  it("is null when there is no model endpoint at all", () => {
    expect(pickActive([profile("tavily", "search")], null)).toBeNull();
  });
});
