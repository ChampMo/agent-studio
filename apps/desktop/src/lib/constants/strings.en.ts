/**
 * All user-facing copy in one place.
 *
 * i18n is out of scope for now (PROJECT_BRIEF.md §13), but the strings are kept
 * here so extracting them later is a move rather than a hunt.
 */
/** " this month", " per second", or nothing at all.
 *
 *  An endpoint can state a total without a period — Tavily returns a credit
 *  limit and never says over what — and the sentence then simply ends. Writing
 *  "this month" there because its dashboard says so would be putting a claim in
 *  the app's mouth that no API made (§3.1). */
function period(per: string): string {
  if (!per) return "";
  if (per === "a month") return " this month";
  return ` per ${per.replace(/^an? /, "")}`;
}

export const strings = {
  app: {
    name: "Agent Studio",
    waitingForBackend: "Waiting for the backend to start…",
    waitingHint:
      "The dev launcher starts it. If this persists, check the terminal.",
  },
  sidebar: {
    newRun: "New run",
    //: What the button shows. The accessible name stays the full "New run",
    //: which contains this word, so a voice command for either one works.
    newShort: "New",
    searchLabel: "Search past runs",
    searchPlaceholder: "Search past runs",
    roster: "Roster",
    teams: "Teams",
    settings: "Settings and connections",
    today: "Today",
    yesterday: "Yesterday",
    // What the dot means, said once, for anyone who cannot see it.
    // Counted, not a percentage: a plan of twelve tasks is twelve things.
    tasks: (done: number, total: number) => `${done}/${total}`,
    unread: "Finished since you last opened it",
    working: "Still working",
    asking: "Waiting for your answer",
    soloChat: "Solo chat",
    spentThisMonth: "Spent this month",
    empty: "Nothing yet. Start a run to see it here.",
    noMatches: "No past run matches that.",
    notStarted: "Not started",
    cancel: "Keep it",
    //: The row's own name, so a screen reader hears which run it deletes.
    deleteRun: (goal: string) => `Delete the run: ${goal}`,
  },

  rail: {
    title: "This run",
    collapse: "Collapse the side panel",
    expand: "Expand the side panel",
    waitingCount: (n: number) =>
      n === 1 ? "1 thing is waiting on you" : `${n} things are waiting on you`,
    needsYou: "Needs you",
    members: (n: number) => (n === 1 ? "1 member" : `${n} members`),
    budget: "Budget for this run",
    tokensUsed: "Tokens used",
    //: "Replies", not "model calls". A round that only asked for tools
    //: publishes no message, so this count sits below the backend's own — and
    //: is never drawn against `max_llm_calls`. See vitals.ts.
    replies: "Replies",
    // Which measurement the three numbers above are, said once. Without it a
    // reader has no way to tell a conversation's total from one round's.
    plan: "Plan",
    // Counted, not a percentage: a plan of five tasks is five things, and
    // "40%" would be a number invented from them.
    planDone: (done: number, total: number) => `${done} of ${total}`,
    wholeMission: "Everything this run has spent, across every round.",
    // The nearest of the round's ceilings, which is the one that will stop it.
    roundUsed: (percent: number) => `This round: ${percent}% of its limit`,
    unfinished: "Not finished this round",
    // Says the one thing the ending line above does not: that these can be
    // picked up without paying for the whole round again.
    unfinishedLead: (n: number) =>
      n === 1
        ? "One task did not finish. It can be picked up on its own."
        : `${n} tasks did not finish. They can be picked up without redoing the rest.`,
    retryAll: "Run these",
    timeUsed: "Time used",
    leader: "Team leader",
    // Share of what the round spent, not a rank against the biggest spender.
    shareOf: (who: string) => `${who}: share of this round's tokens`,
    noStatus: "Nothing yet",
    empty: "Open a run to see who is on it.",
    resize: "Panel width",
    resizeHint:
      "Drag, or focus it and use the arrows. Home and End go to the limits.",
    showRun: "This run",
    beforeStart: "Available once the run has started",
    showTerminal: "Terminal",
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
    nobody: "No one is seated on this run.",
    leader: "Team leader",
    empty: "Send a team out and they will appear here.",
    soundOn: "Sound on — click to mute",
    soundOff: "Muted — click for sound",
  },

  mission: {
    title: "Mission",
    startTitle: "Start a run",
    startHint:
      "Name it, pick a team, and choose the folder they may touch. Nothing runs until you send the first message.",
    // Said as what it is. A list of what happened, next to a field where a
    // limit is typed — not a prediction of what this run will do.
    pastRuns:
      "What this team's last runs spent — tasks, tokens, how they ended",
    titleLabel: "Title",
    titleHint: "What to call this run in the list. It is not the instruction.",
    titlePlaceholder: "Landing page for the gaming brand",
    create: "Create run",
    breadcrumb: "Where you are",
    currentRun: "This run",
    rename: "Rename this run",
    renameLabel: "Run name",
    untitled: "Untitled run",
    notStarted: "Not started",
    soloChat: "Solo chat",
    workspaceChip: "Workspace",
    workspaceOpen: (path: string) => `Open ${path} in the file manager`,
    workspaceOpened: "Opened",
    // A page cannot open a folder on the machine — the same wall the folder
    // picker hits — so the browser gets the path instead, and is told so.
    workspaceCopied: "Path copied — the file manager needs the desktop app",
    workspaceNoClipboard: "Could not copy the path",
    //: Counted out in words. "1/2" reads like a score; this reads like a fact.
    progress: (done: number, total: number) =>
      `${done} of ${total} ${total === 1 ? "task" : "tasks"} done`,
    views: "How to look at this run",
    viewScene: "Scene",
    viewTimeline: "Timeline",
    viewArtifacts: "Files",
    teamLabel: "Team",
    noRunnableTeam: "No team is ready to run — check the Teams tab.",
    goalLabel: "Goal",
    goalHint:
      "One instruction for the whole team. The leader breaks it into tasks.",
    goalPlaceholder: "Research X and summarise the tradeoffs",
    launch: "Send the team",
    launching: "Starting…",
    rejected: "This team cannot run:",
    stop: "Stop",
    newRun: "New run",
    endedPrefix: "Round finished",
    approvalLabel: "Show me the plan before the team starts",
    approvalHint:
      "The mission pauses after planning and waits for you. The only point where stopping still saves the cost of the work.",
  },

  composer: {
    label: "Say something to this team",
    placeholder: "Ask for a change, or say what is next…",
    firstPlaceholder: "Tell the team what to do — this starts the run…",
    send: "Send",
    start: "Start",
    //: What the button does, said before it is pressed. There is no way to
    //: talk to a team mid-run yet, so this must not look like there is.
    //: After a round has finished. It continues the same conversation — same
    //: team, same workspace, same timeline — rather than starting over.
    hint: "Enter sends · Shift+Enter adds a line · continues this run",
    firstHint:
      "Enter sends · Shift+Enter adds a line · this message starts the run",
    //: While the team works. Precise on purpose: nothing can reach a model
    //: mid-reply, so this says *when* it lands rather than implying it
    //: interrupts. "Sent" would be the UI overstating what happened.
    running:
      "Enter queues it · the team reads this when the current step ends · Esc stops the run",
    queued: "Waiting for the next step",
    queueFailed: "The run ended before that could be delivered.",
    runningPlaceholder: "Add a note for the team…",
    stopHint: "Esc stops the run",
    attachImage: "Attach an image",
    modelCannotSeeImages: (models: string) =>
      `${models} refused an image before, so this one will not be read. It is still attached to the record.`,
    removeImage: (name: string) => `Remove ${name}`,
    attachFile: "Attach an image or a text file",
    //: Says which of the two routes a file could not take, because "rejected"
    //: on its own leaves the person guessing which rule they hit.
    notReadable: (name: string) =>
      `${name} is not an image and is not text. Images go to the model as pictures and text files go in as text; put anything else in the workspace folder, where the file tools can read it.`,
    tooBig: (name: string, limit: number) =>
      `${name} is too large. The limit is ${Math.round(limit / 1024)} KB.`,
    stopRun: "Stop the run",
    //: The `+` menu. Three rows, because there are three things you can put in
    //: this box that are not simply words: a file, a command to the app, and a
    //: note addressed to one teammate. The two typed forms are discoverable
    //: only by knowing to press `/` or `@`, which is a thing nobody is told.
    addMenu: "Add to this message",
    addFiles: "Add a photo or a file",
    addCommand: "Run a command",
    addName: "Message one teammate",
    //: Why those two rows go dead, said on the row rather than left to be
    //: guessed. `/plan …` and `@Wren …` only parse from the **start** of the
    //: line, so neither can be dropped into a sentence already being written —
    //: and taking the box over to insert one would throw that sentence away.
    needsEmptyBox: "Only from an empty box — this is the whole line",
    //: A note is collected from the mailbox when a teammate's next task
    //: starts, so there has to be a next task.
    needsRunning: "Only while the team is working",
    dropHere: "Drop to attach",
    dropHint: "or drop files here",
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
    browse: "Browse",
    browserOnly:
      "The folder picker needs the desktop app — a browser hands back a handle, not a path, and the boundary is a path. Paste one below meanwhile.",
    use: "Use this folder",
    checking: "Checking…",
    change: "Change",
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
    autonomy: "Ask before acting:",
    // It used to say "on the next run", which was true and was also the
    // complaint: you turn the questions off because the one on screen is
    // interrupting you, and being told to start a new run to get that is not
    // an answer. It is read per tool call now.
    autonomyNextRun: "Takes effect on the next tool call",
    trustedShort: "No approval gate, and no sandbox behind it.",
    confirmTrusted: "Turn off every approval?",
    confirmTrustedYes: "Turn it off",
    confirmTrustedNo: "Keep asking",
    autonomyOptions: {
      ask_always: "Ask before every tool",
      ask_dangerous: "Ask before running commands and fetching pages",
      trusted: "Never ask",
    } as Record<string, string>,
    //: What the chip says. The full sentence above is the menu row; a chip has
    //: room for the mode, not for the explanation of it.
    autonomyShort: {
      ask_always: "Ask always",
      ask_dangerous: "Ask on risky",
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
    footnote:
      "The mission is paused until this is answered — closing the app is safe.",
    waiting: (n: number) =>
      n === 1 ? "1 question waiting" : `${n} questions waiting`,
    reopen: "Answer",
    //: On a question that has already been dealt with. The row keeps its place
    //: — the transcript is a record, and a question that was asked stays asked.
    answered: "Answered",
    fromAnotherRun: "Asked by a different run — open it to see the context",
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
    // The run's file history, which is what the app knows and a file manager
    // does not: who changed what, when, in what order.
    changed: (n: number) => (n === 1 ? "1 file changed" : `${n} files changed`),
    changes: (n: number) => (n === 1 ? "1 change" : `${n} changes`),
    open: "Open",
    loading: "Reading the file…",
    // A write that changed nothing is a real outcome — an agent rewriting a
    // file with the same bytes — and worth saying rather than showing blank.
    noChange: "This write changed nothing.",
    // Counted, never merely dropped: a reader has to be able to see that
    // something was left out or they cannot trust what was kept.
    skipped: (n: number) =>
      n === 1 ? "1 unchanged line" : `${n} unchanged lines`,
    showDiff: "What changed",
    noVersions:
      "No copy of this file was kept — it was written before the app started keeping them.",
    none: "This mission produced no files.",
    close: "Close",
    // Two different things, and the difference matters: one is still in the
    // user's folder and can be opened in their editor; the other the app owns.
    inWorkspace: "in your workspace folder",
  },

  /**
   * The AI team builder. Every string here has to keep one distinction alive:
   * what a model suggested is an opinion, and what `validate()` found is a
   * rule. The words do the work the layout cannot.
   */
  theme: {
    // Says what each one *is*, not what it looks like — "dusk" is the design
    // and "dark" is only the setting. There is no settings page for this: the
    // button in the corner of the window is the whole control.
    system: "Follow the system",
    light: "Afternoon",
    dark: "Dusk",
    current: (name: string) => `Theme: ${name}`,
    switchTo: (name: string) => `Switch to ${name}`,
  },

  advisor: {
    title: "Ask AI to staff this team",
    briefPlaceholder:
      "What is the work? e.g. research how SQLite handles concurrent writes, quote the docs, and write it to a file",
    suggest: "Suggest a team",
    review: "Check this team",
    thinking: "Thinking…",
    leader: "leads",
    adds: (tools: string) => `add ${tools}`,
    gapsTitle: "Nobody on your roster fills this",
    // Said plainly, because "apply" on a screen full of other controls is not
    // obviously harmless. It changes the seats and saves nothing (§11).
    apply: "Use this team",
    applyHint: "Fills in the seats below — nothing is saved until you save",
    // The heading that keeps the two claims apart. It is the load-bearing
    // string in this component.
    gateTitle: "What the run gate says about it",
    // One line for what was six. A tool the work does not need is not a
    // problem, so this reads as a list rather than as a warning per tool.
    uncovered: (tools: string) => `Nobody carries: ${tools}`,
    modelSays: "The model's reading of this team, not a check",
    attempts: (n: number) => `took ${n} attempts`,
    noProvider: "Add a model endpoint in Settings to use this.",
  },

  /**
   * The command layer. One box now means two things, and these strings are
   * what keeps them apart — so each one names the *act*, never the feature.
   */
  commands: {
    menuFooter: "These are things the app does — they are not sent to the team",
    // The opposite claim from the one above it, which is why the two menus are
    // two components rather than one with a conditional.
    nameFooter: "Sent to this teammate only, at their next step",
    // Shown above the box once a real command is typed, so it is never a
    // surprise which of the two is about to happen.
    willRun: (name: string) => `/${name} — the app does this, nothing is sent`,
    addressed: (who: string) => `Only ${who} will read this`,
    // /plan
    planOn: "The plan comes back for your approval before any work starts",
    // /fork
    forkHint: "Starts a separate run — this one is left exactly as it is",
    // /rewind
    rewindTitle: "Put the files back",
    rewindPick: "Choose the point to go back to",
    rewindNothing: "This run has no recorded file changes to put back.",
    rewindWillChange: (n: number) =>
      n === 1 ? "1 file would change" : `${n} files would change`,
    rewindNoChange: "Nothing would change at that point",
    rewindApply: "Put these files back",
    rewindCancel: "Cancel",
    rewindBusy: "Putting files back…",
    // Said before it is agreed to, not discovered afterwards. This is the one
    // limit that decides whether the command is any use in a given run.
    rewindLimit:
      "Only files written with write_file or edit_file can be put back — anything bash created or moved has no stored copy.",
    rewindDone: (n: number) =>
      n === 0
        ? "Nothing needed changing."
        : n === 1
          ? "Put 1 file back."
          : `Put ${n} files back.`,
    rewindKept:
      "What was there before this is kept, so you can undo it the same way.",
    rewindOnlyStopped: "Stop the run first — the team is using these files.",
    action: {
      restore: "will be put back",
      created_after: "was created after this point — left alone",
      missing_blob: "no stored copy — left alone",
      unchanged: "already matches",
      failed: "could not be written",
    } as Record<string, string>,
  },

  teams: {
    title: "Teams",
    memberCount: (n: number) => (n === 1 ? "1 member" : `${n} members`),
    seatCount: (n: number) => (n === 1 ? "1 seat" : `${n} seats`),
    //: The same control seats and unseats, so it says which one a click does.
    clickToSeat: (name: string) => `Seat ${name}`,
    clickToRemove: (name: string) => `Take ${name} out of the team`,
    //: Named per seat: six seats meant six identical "Remove" links, and a
    //: screen reader announced every one of them the same.
    makeLeaderFor: (name: string) => `Make ${name} the leader`,
    //: The solid star's accessible name. It is an image, not a control — there
    //: is nothing to do to the leader from this seat.
    isLeader: (name: string) => `${name} is the team leader`,
    clearSeatFor: (name: string) => `Take ${name} out of this seat`,
    moreFor: (name: string) => `More options for ${name}`,
    archiveHint: "Out of the way, and reversible",
    //: Two findings on the card, the rest in the builder — which is where they
    //: get fixed. A team with six used to print all six and tower over its
    //: neighbours.
    moreFindings: (n: number) => `+${n} more to fix in the builder`,
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
    //: Counted, so it has to agree with the number in front of it. "1 missions"
    //: on every card that had run once was the first thing anyone noticed.
    missions: (n: number) => (n === 1 ? "1 mission" : `${n} missions`),
    edit: "Edit",
    saveEdit: "Save",
    duplicate: "Duplicate",
    archive: "Archive",
    restore: "Restore",
    //: Named for the card it belongs to. Seven cards mean seven of these, and
    //: "More options" seven times tells a screen-reader user nothing.
    moreFor: (name: string) => `More options for ${name}`,
    duplicateHint: "A copy you can change without touching this one",
    archiveHint: "Out of the way, and reversible",
    //: Delete is gone from the card. An agent is named in the roster snapshot
    //: of every mission it ran, so removing the row would leave those replays
    //: describing someone who is not there (§5.2).
  },

  terminal: {
    tab: "Terminal",
    label: "Run a command in this run's folder",
    placeholder: "ls, git status, npm test…",
    //: All three facts on screen, because each would otherwise be found out
    //: the hard way (§2.7).
    preamble:
      "Your own shell, opened on this run's folder. It is not gated by “Ask before acting” — that governs agents, not you — and nothing typed here goes on the timeline. Files you change are the files the team reads next.",
    noRun: "Open a run to get a terminal on its folder.",
    noWorkspace:
      "This run has no folder, so there is nowhere to open a terminal.",
    running: "running…",
    timedOut: "stopped — it was still running",
    truncated: "output was cut",
    exit: (code: number | null, ms: number) =>
      `exit ${code ?? "?"} · ${ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}`,
  },

  //: The panel a model writes inside. Shared by the agent creator and the
  //: team builder, because both are the same act — a model fills in a form and
  //: a person checks it — and two wordings would be two claims.
  ai: {
    working: "The model is writing",
    //: The one measure of this wait that is real. Nothing streams and the
    //: backend reports no progress, so a step-by-step caption would be the
    //: screen narrating work it cannot see (§1.1).
    elapsed: (seconds: number) => `${seconds}s`,
    cancel: "Cancel",
    //: What the treatment on the fields means, said once in words.
    written: "The violet marks are what the model wrote. Editing a field clears its mark.",
    //: Not "it failed". The endpoint's own words go underneath this.
    failed: "The model could not produce a usable answer.",
    //: Said where the person can act on it: a cancelled run costs nothing and
    //: leaves what was typed exactly where it was.
    cancelled: "Cancelled. Nothing was saved and nothing was changed.",
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
    regenerate: "Draft it again",
    generating: "Generating…",
    aiTitle: "Let the model draft a character",
    //: Present tense about a state, not a congratulation. It is on screen
    //: for as long as the draft is unchecked and leaves when it is saved.
    aiReview: "Drafted by the model — yours to check before it is saved",
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
    //: The row repeats per endpoint, so the button's own name has to say which
    //: one it belongs to — "Test connection" three times over is three
    //: identical controls to anyone not looking at the layout (§18.3).
    rerunFor: (name: string) => `Test the connection to ${name}`,
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
    endedPrefix: "Round finished",
  },
  timeline: {
    // Counted, not named. "6 steps" needs no vocabulary and makes no claim
    // about which of the six was the interesting one.
    // An arrow, because a preposition would read as part of the sentence the
    // agent wrote rather than as a label about it.
    mineOnly: "Only what involves me",
    mineOnlyHint: "Hides the agents talking to each other",
    // Counted, because a filter whose effect you cannot see is one you cannot
    // trust to have kept the rest.
    hiddenCount: (n: number) => (n === 1 ? "1 row hidden" : `${n} rows hidden`),
    waitingOn: (who: string) =>
      who
        ? `${who} is waiting for an answer`
        : "The run is waiting for an answer",
    goToQuestion: "Go to it",
    showEarlier: (n: number) =>
      n === 1
        ? "Show 1 earlier row"
        : `Show ${n.toLocaleString("en")} earlier rows`,
    newBelow: (n: number) => (n === 1 ? "1 new" : `${n} new`),
    addressedTo: (who: string) => `→ ${who}`,
    // Named, then counted. Two names is what fits; the rest is a number,
    // because a truncated third name is worse than an honest "+2".
    foldedWrote: (n: number, files: string[]) => {
      const shown = files.slice(0, 2).join(", ");
      const rest = files.length - 2;
      const what = n === 1 ? "wrote 1 file" : `wrote ${n} files`;
      if (!shown) return what;
      return rest > 0 ? `${what} · ${shown} +${rest}` : `${what} · ${shown}`;
    },
    foldedFailed: "· something failed",
    folded: (n: number) => (n === 1 ? "1 step" : `${n} steps`),
    title: "Event stream",
    empty: "No events yet.",
    emptyDraft:
      "Nothing has happened yet. Send the first message to start the run.",
    //: The status word comes from the event, not from a table here: a status
    //: this build has never seen is shown as published rather than guessed at.
    busy: (name: string, status: string) => `${name} is ${status}`,
    unknownType: "unknown event type",
    futureVersion: "written by a newer version",
    malformed: "unreadable frame",
    imageGone: "the attached image is no longer on disk",
    hint: "Every event the backend published, in sequence. This is the same stream the scene will consume.",
    usage: (input: number, output: number) =>
      `${input.toLocaleString("en")} in · ${output.toLocaleString("en")} out`,
  },

  settings: {
    nativeSearchLabel: "Let this endpoint search the web itself",
    nativeSearchHint:
      "Supported here. The model searches during its reply instead of calling a tool this app runs.",
    nativeSearchWarning:
      "This search does not go through the approval gate, its query is not redacted before it is recorded, and the results come back encrypted — the timeline can say a search happened and what was asked, but not what came back. web_search through a Brave or Tavily key does all three.",
    addSearch: "Add a web search key",
    // "Endpoint" was wrong: the two engines are fixed — they are the two APIs
    // this build has adapters for — and what you add is another key for one of
    // them. A second free account is exactly what the fallback order is for.
    addAnotherSearch: "Add another key",
    searchHint:
      "Brave and Tavily are the two APIs this build can talk to. Adding a second key for either — another free account, say — gives the tool somewhere to go when the first runs out.",
    saveSearch: "Save and test",
    savingSearch: "Testing…",
    // The allowance an endpoint reported about itself.
    quotaLeft: (remaining: string, limit: string, unit: string, per: string) =>
      `${remaining} of ${limit} ${unit} left${period(per)}`,
    // What the bar draws, as opposed to what the line above it says. The bar
    // fills as the allowance is spent, so full means gone.
    quotaUsed: (used: string, limit: string, unit: string, per: string) =>
      `${used} of ${limit} ${unit} used${period(per)}`,
    quotaMeasured: "Measured when this key was last tested, not since.",
    // Whose statement this is matters: it is the key reporting no allowance,
    // not this app failing to find one. Read the other way it looks like a
    // missing feature.
    quotaRate: (limit: string, unit: string, per: string) =>
      `This key reports no allowance to spend down — only a rate limit of up to ${limit} ${unit} ${per}.`,
    quotaSilent: "This endpoint reports no allowance, so none is shown.",
    quotaUntested: "Test the key to read its allowance.",
    title: "Providers",
    sections: "Settings sections",
    modelsTitle: "Models",
    modelsHint:
      "The endpoints your agents think with. Each agent picks one of these.",
    noModels: "No model configured. Agents cannot run without one.",
    addModel: "Add a model",
    searchTitle: "Web search",
    searchSectionHint:
      "Keys for the web_search tool, tried in the order they were added — so a key that runs out falls through to the next. Without one, the tool is not offered at all rather than offered and failing.",
    noSearch: "No search key. Agents will not be offered web_search.",
    kindLabel: "API style",
    kindOpenAI: "OpenAI-compatible (DeepSeek, local servers, most others)",
    kindAnthropic: "Anthropic",
    nameLabel: "Name",
    nameHint: "Whatever you want to call it in this list.",
    baseUrlLabel: "Base URL",
    modelLabel: "Model",
    modelHint: "The exact model id this endpoint expects.",
    presetLabel: "Where the model runs",
    localHint:
      "A server on this machine. This is that project's default port — change it if yours is elsewhere.",
    keyOptionalLabel: "API key (optional here)",
    keyLocalHint:
      "A server on your own machine usually authenticates nothing. Leave it empty and the endpoint will say if it wanted one.",
    modelPick: "Pick a model",
    modelPlaceholder: "Fetch the list, or type the id",
    fetchModels: "Fetch models from this endpoint",
    fetchingModels: "Asking…",
    modelsFound: (n: number) => `${n} model${n === 1 ? "" : "s"} offered`,
    modelsNone: "This endpoint offered no models.",
    // The endpoint's own words follow. "Connection refused" and "invalid api
    // key" need different fixes, and one flattened message would hide which.
    modelsFailed: "Could not ask this endpoint:",
    keyLabel: "API key",
    keyHint:
      "Goes straight to your OS keychain. Nothing here keeps a copy, and no endpoint can read it back.",
    saveModel: "Save and test",
    savingModel: "Testing…",
    add: "Add provider",
    remove: "Remove",
    setKey: "Replace key",
    setKeyFor: (name: string) => `Replace the API key for ${name}`,
    removeFor: (name: string) => `Remove ${name}`,
    keyPresent: "Key stored in keychain",
    keyMissing: "No key stored",
    neverVerified: "Never tested",
    verifiedAt: "Last tested",
    moreFor: (name: string) => `More options for ${name}`,
    save: "Save",
    cancel: "Cancel",
    //: What choosing a model row actually does. A highlighted row on its own
    //: says only that something is selected, not what selecting it means.
    defaultGroup: "The model a new agent is created with",
    defaultForAgents: "Default for new agents",
    tryEarlier: "Try this one earlier",
    tryLater: "Try this one later",
    alreadyFirst: "Already the first one tried",
    alreadyLast: "Already the last one tried",
    noBaseUrl: "No base URL",
    removeWarning: (name: string) =>
      `Removing ${name} deletes its key from the keychain. This app never had a copy to give back.`,
  },
  budget: {
    title: "Limits for every run",
    // Whose limits these are. Nothing here is imposed by the endpoint, and a
    // panel that did not say so would read as though it were.
    intro:
      "This app stops a run when it reaches one of these. They are not limits your provider sets — they are the point at which Agent Studio stops paying for a run, so raise them if your work is bigger than they are.",
    loading: "Reading the current limits…",
    tokensLabel: "Tokens per run",
    tokensHint:
      "Input, output and cached context, added up. A long conversation is re-sent on every step, so this is spent faster than the work alone suggests.",
    timeLabel: "Time per run",
    timeHint:
      "Time the team spends working. Time a run waits for you to answer a question does not count.",
    callsLabel: "Model calls per run",
    callsHint: "Every request to a model, including planning retries.",
    stepsLabel: "Steps per run",
    stepsHint:
      "One per task and one per stage. A run that hits this had a plan longer than it could carry out.",
    seconds: "seconds",
    save: "Save limits",
    saving: "Saving…",
    saved: "Saved — the next run uses these",
    reset: "Back to the shipped values",
    // Blank means inherit, and the placeholder shows what inheriting gets you.
    inheritHint: (from: string) =>
      `Leave a box empty to use ${from}. The greyed number is what that is.`,
    clearOverrides: (from: string) => `Use ${from} for all four`,
    teamTitle: "Limits for this team",
    teamFrom: "the app default",
    runTitle: "Limits for this run",
    runFrom: "the team's limits",
    appliesTo:
      "Applies to the next run, and to the next round of a run you continue. A run already going keeps the limits it started with.",
  },

  storage: {
    title: "Where your work is kept",
    intro:
      "Runs, the files agents produced, and anything you attached. All of it is on this machine and none of it is sent anywhere.",
    loading: "Measuring…",
    open: (path: string) => `Open ${path} in the file manager`,
    files: (n: number) =>
      `${n.toLocaleString("en-GB")} file${n === 1 ? "" : "s"}`,
    notYet: "nothing yet",
    total: (size: string) => `${size} in total.`,
  },

  connection: {
    idle: "Not connected",
    connecting: "Connecting…",
    open: "Live",
    reconnecting: "Reconnecting…",
    closed: "Disconnected",
  } as Record<string, string>,
} as const;
