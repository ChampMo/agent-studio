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

import { chatProviders, pickActive, useSettingsStore } from "./settingsStore";
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

/**
 * The same question, asked in one place.
 *
 * "Which endpoints can something be generated against" had grown four answers:
 * the default endpoint, the onboarding gate, the team advisor's dropdown and
 * the agent creator's. The creator's was `providers.filter((p) => p.hasKey)`
 * and it was wrong in both directions at once — it offered the two search keys,
 * which fail with `no provider registered for 'search'`, and it hid a local
 * server, which authenticates nothing and therefore has no key to have.
 *
 * Found by opening the dropdown and reading it: Tavily and Brave Search sat at
 * the top of a list headed "Generate with".
 */
describe("the endpoints something can be generated against", () => {
  it("refuses a search key, which cannot complete anything", () => {
    const list = chatProviders([
      profile("tavily", "search"),
      profile("brave", "search"),
      profile("deepseek", "openai_compatible"),
    ]);

    expect(list.map((p) => p.id)).toEqual(["deepseek"]);
  });

  it("keeps a local endpoint that answered without a key", () => {
    // Ollama and LM Studio authenticate nothing, so `hasKey` alone left anyone
    // running one with an empty dropdown and a working endpoint configured.
    const list = chatProviders([
      profile("ollama", "openai_compatible", { hasKey: false, verifiedAt: "2026-09-03T00:00:00Z" }),
    ]);

    expect(list.map((p) => p.id)).toEqual(["ollama"]);
  });

  it("drops a model endpoint that has neither a key nor an answer", () => {
    // Nothing has been established about it in either direction, so offering
    // it would be a guess about which endpoints need a key (§3.1).
    const list = chatProviders([
      profile("half-added", "openai_compatible", { hasKey: false, verifiedAt: null }),
    ]);

    expect(list).toEqual([]);
  });

  it("is the same rule the onboarding gate uses", () => {
    // If these two disagreed, the app would either hold someone on onboarding
    // with a usable endpoint, or let them past with nothing that can run.
    const only = [profile("tavily", "search")];

    expect(chatProviders(only)).toEqual([]);
    expect(useSettingsStore.getState().needsOnboarding()).toBe(true);
  });
});
