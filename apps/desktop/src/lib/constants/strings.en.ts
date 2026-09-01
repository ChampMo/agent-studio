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
    roster: "Roster",
    teams: "Teams",
    mission: "Mission",
    history: "History",
    timeline: "Timeline",
    settings: "Settings",
  },

  scene: {
    empty: "Send a team out and they will appear here.",
    soundOn: "Sound on — click to mute",
    soundOff: "Muted — click for sound",
    ended: (reason: string) => `mission ended — ${reason}`,
  },

  mission: {
    title: "Mission",
    teamLabel: "Team",
    noRunnableTeam: "No team is ready to run — check the Teams tab.",
    goalLabel: "Goal",
    goalHint: "One instruction for the whole team. The leader breaks it into tasks.",
    goalPlaceholder: "Research X and summarise the tradeoffs",
    launch: "Send the team",
    launching: "Starting…",
    rejected: "This team cannot run:",
    stop: "Stop",
    newRun: "New run",
    endedPrefix: "Mission ended",
    approvalLabel: "Show me the plan before the team starts",
    approvalHint:
      "The mission pauses after planning and waits for you. The only point where stopping still saves the cost of the work.",
  },

  workview: {
    splitter: "Resize the scene",
    splitterHint:
      "Drag, or focus it and use the arrows, PageUp/PageDown, Home, End. Enter collapses and restores.",
    recordTabs: "What happened",
    timeline: "Timeline",
    artifacts: "Files",
  },

  workspace: {
    title: "Workspace folder",
    required: "required by this team's tools",
    hint: "The only folder this team's file tools may touch. Everything outside it is refused.",
    browse: "Choose a folder…",
    use: "Use this folder",
    checking: "Checking…",
    change: "Change",
    recent: "Recent",
    missing: "This folder is no longer there.",
    placeholder: "C:\\path\\to\\project",
    broadHint: "That is wider than most tasks need.",
    working: "Working in",
    blocked:
      "This team has tools that read and write files, so it needs a folder before it can run.",
  },

  tools: {
    title: "Tools",
    none: "No tools. This agent can only answer from what the model already knows.",
    risk: {
      safe: "safe",
      guarded: "changes files",
      dangerous: "asks first",
    } as Record<string, string>,
    autonomy: "When to ask before acting",
    autonomyOptions: {
      ask_always: "Ask before every tool",
      ask_dangerous: "Ask before running commands and fetching pages",
      trusted: "Never ask",
    } as Record<string, string>,
    trustedWarning:
      "There is no sandbox. Shell commands run as you, with your files and your network — the question is the only thing in the way, and this turns it off.",
    needsWorkspace: "needs a workspace folder",
  },

  approval: {
    // Not "approve this plan": the same modal now carries tool approvals, and
    // the question itself already says which (§16.4).
    approvalTitle: "Approval needed",
    questionTitle: "The team needs an answer",
    option: {
      approve: "Start the work",
      reject: "Do not run this",
    } as Record<string, string>,
    replyPlaceholder: "Your answer…",
    send: "Send",
    sending: "Sending…",
    later: "Later",
    more: (n: number) => `${n} more waiting`,
    footnote: "The mission is paused until this is answered — closing the app is safe.",
    waiting: (n: number) => (n === 1 ? "1 question waiting" : `${n} questions waiting`),
    reopen: "Answer",
  },

  history: {
    title: "History",
    refresh: "Refresh",
    loading: "Loading…",
    empty: "No missions yet.",
    noGoal: "(no goal recorded)",
    members: "members",
    live: "live",
    replaying: "Replayed from the log",
    delete: "Delete",
    deleteConfirm: "Delete this run",
    deleteWarning:
      "This removes the run, everything on its timeline, and the files it produced. There is no undo, and nothing else keeps a copy.",
    deleteRunning: "Stop the run before deleting it.",
  },

  artifacts: {
    title: "Files produced",
    none: "This mission produced no files.",
    close: "Close",
  },

  teams: {
    title: "Teams",
    create: "New team",
    import: "Import",
    export: "Export",
    empty: "No teams yet. Build one from your roster.",
    showArchived: "Show archived",
    archived: "Archived",
    ready: "Ready to run",
    blocked: "Cannot run",
    members: "members",
    edit: "Edit",
    duplicate: "Duplicate",
    archive: "Archive",
    restore: "Restore",
    delete: "Delete",
    deleteConfirm: "Delete permanently",
    deleteWarning:
      "This cannot be undone. The agents stay in your roster and the missions this team ran keep their record — what goes is the team itself and its seats.",
    importedBefore:
      "You have imported this team before. A separate copy was made — importing never overwrites what you have edited.",

    newTitle: "New team",
    editTitle: "Edit team",
    save: "Save",
    close: "Close",
    roster: "Roster",
    noAgents: "No agents yet. Create one first.",
    seats: "Seats",
    seat: "Seat",
    emptySeat: "Drag an agent here, or click one on the left.",
    leader: "Leader",
    makeLeader: "Make leader",
    clearSeat: "Remove",
    nameLabel: "Team name",
    layoutLabel: "Scene layout",
    descriptionLabel: "Description",
    displaced: (n: number) =>
      `${n} member${n === 1 ? "" : "s"} sat beyond this layout's seats and are not shown. Saving now would drop them.`,
  },

  roster: {
    title: "Roster",
    create: "New agent",
    empty: "No agents yet. Create one from a short prompt.",
    showArchived: "Show archived",
    archived: "Archived",
    missions: "missions",
    edit: "Edit",
    saveEdit: "Save",
    duplicate: "Duplicate",
    archive: "Archive",
    restore: "Restore",
    delete: "Delete",
    deleteConfirm: "Delete permanently",
    deleteWarning:
      "This cannot be undone. Missions this agent ran keep their own record of it, so the history stays true — but its seat on any team goes, and so do its notes. Archive instead if you only want it out of the way.",
  },

  creator: {
    title: "Create an agent",
    editTitle: "Edit agent",
    editIntro:
      "Everything about this agent, on one page — including what it can do and when it stops to ask.",
    saveEdit: "Save changes",
    intro:
      "Describe the role and the model drafts a character. Nothing is saved until you review it and press Save.",
    providerLabel: "Generate with",
    roleLabel: "Role",
    roleHint: "One line. What is this agent for?",
    rolePlaceholder: "research analyst who checks sources",
    briefLabel: "Notes (optional)",
    briefPlaceholder: "Anything else that should shape the character.",
    generate: "Generate profile",
    generating: "Generating…",
    corrected: (attempts: number) =>
      `The model needed ${attempts} attempts. What was corrected:`,
    reviewTitle: "Review",
    reviewBadge: "nothing is saved until you press Save",
    nameLabel: "Name",
    titleLabel: "Title",
    roleFieldLabel: "Role",
    traitsLabel: "Personality traits",
    traitsHint: "Comma separated.",
    backstoryLabel: "Backstory",
    systemPromptLabel: "System prompt",
    systemPromptHint: "This is what the agent will actually run under.",
    avatarLabel: "Avatar",
    avatarHint:
      "Assembled from assets that exist — the scene draws from this same list.",
    samplingIgnored:
      "This model rejects sampling parameters, so any temperature set here would be dropped.",
    save: "Save to roster",
    cancel: "Cancel",
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
    allPassed: "All checks passed",
    unusable: "Endpoint not usable",
    inconclusive: "inconclusive",
    inconclusiveHint:
      "An inconclusive check proves nothing either way, so nothing was recorded for it. Re-run to try again.",
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
    nativeSearchLabel: "Let this endpoint search the web itself",
    nativeSearchHint:
      "Supported here. The model searches during its reply instead of calling a tool this app runs.",
    nativeSearchWarning:
      "This search does not go through the approval gate, its query is not redacted before it is recorded, and the results come back encrypted — the timeline can say a search happened and what was asked, but not what came back. web_search through a Brave or Tavily key does all three.",
    searchFirst: "Tried first",
    searchFallback: (n: number) =>
      `Used ${n === 2 ? "if the one above" : "if the ones above"} run out or fail`,
    addSearch: "Add a web search endpoint",
    addAnotherSearch: "Add another search endpoint",
    searchHint:
      "Lets agents use web_search. Without one the tool is not offered at all, rather than offered and failing.",
    saveSearch: "Save and test",
    savingSearch: "Testing…",
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
