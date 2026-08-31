/**
 * All user-facing copy in one place.
 *
 * i18n is out of scope for now (PROJECT_BRIEF.md §13), but the strings are kept
 * here so extracting them later is a move rather than a hunt.
 */
export const strings = {
  app: {
    name: "Agent Studio",
    waitingForBackend: "Waiting for the backend to start…",
    waitingHint: "The dev launcher starts it. If this persists, check the terminal.",
  },
  nav: {
    chat: "Chat",
    timeline: "Timeline",
    settings: "Settings",
  },
  onboarding: {
    title: "Connect a model provider",
    intro:
      "Agent Studio runs entirely on this machine. Your API key goes into the OS keychain and never touches this app's storage, a config file, or a log.",
    nameLabel: "Profile name",
    namePlaceholder: "DeepSeek",
    kindLabel: "Provider type",
    kindOpenAI: "OpenAI-compatible (DeepSeek, Ollama, LM Studio, OpenRouter…)",
    kindAnthropic: "Anthropic",
    baseUrlLabel: "Base URL",
    baseUrlPlaceholder: "https://api.deepseek.com/v1",
    baseUrlHint: "The endpoint's OpenAI-compatible base URL.",
    modelLabel: "Model",
    modelPlaceholder: "deepseek-v4-flash",
    modelHint:
      "Test connection asks the endpoint which models it actually offers, so a typo is caught here rather than mid-mission.",
    keyLabel: "API key",
    keyPlaceholder: "sk-…",
    keyHint: "Stored in the OS keychain. There is no way to read it back out.",
    save: "Save and test connection",
    saving: "Testing…",
    skip: "I'll do this later",
  },
  probe: {
    title: "Connection test",
    rerun: "Test connection",
    running: "Running four checks…",
    passed: "All checks passed",
    failed: "Some checks did not pass",
    capabilities: "Observed capabilities",
    checkNames: {
      models: "Model exists at this endpoint",
      chat: "Chat and streaming",
      tools: "Tool calling",
      structured: "Structured output",
    } as Record<string, string>,
    informational:
      "Tool calling and structured output are informational: chat works without them, but an agent given tools would not.",
  },
  chat: {
    placeholder: "Send a message…",
    send: "Send",
    stop: "Stop",
    empty: "Nothing yet. Send a message to start.",
    noProvider: "Add a provider in Settings first.",
    thinking: "thinking…",
    endedPrefix: "Mission ended",
  },
  timeline: {
    title: "Event stream",
    empty: "No events yet.",
    unknownType: "unknown event type",
    futureVersion: "written by a newer version",
    malformed: "unreadable frame",
    hint: "Every event the backend published, in sequence. This is the same stream the scene will consume.",
  },
  settings: {
    title: "Providers",
    add: "Add provider",
    remove: "Remove",
    setKey: "Replace key",
    keyPresent: "Key stored in keychain",
    keyMissing: "No key stored",
    neverVerified: "Never tested",
    verifiedAt: "Last tested",
  },
  connection: {
    idle: "Not connected",
    connecting: "Connecting…",
    open: "Live",
    reconnecting: "Reconnecting…",
    closed: "Disconnected",
  } as Record<string, string>,
} as const;
