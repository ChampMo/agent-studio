/**
 * The box at the bottom of the run (§18.2).
 *
 * This is what starts a run. The setup form names it and picks the team; the
 * first message here is the instruction, and sending it is what creates the
 * mission. Nothing is spent before that — a draft costs nothing and leaves no
 * row behind, which is the whole reason the two steps are separate.
 *
 * While the team is working it stays usable, and what it does then is queue.
 * Nothing can reach a model mid-reply, so a note goes into the same mailbox
 * teammates use and is collected when the next task starts. The hint says that
 * in those words — *"the team reads this when the current step ends"* — because
 * a button labelled "Send" over a system that cannot interrupt is the UI
 * overstating what it did (§1). Once the run has ended, sending starts a new
 * one with the same team, and the hint says that instead.
 *
 * It is also where the mode control and attachments will live (M9.2, M9.3).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { CommandMenu, NameMenu } from "./CommandMenu";
import { RewindDialog } from "./RewindDialog";
import {
  available,
  matches,
  menuFilter,
  nameFilter,
  parse,
  whoMatches,
  type CommandSpec,
} from "./commands";
import { cn } from "../../lib/cn";
import { api } from "../../transport/rest";
import { useMissionStore } from "../../stores/missionStore";
import { useEndReason } from "../../stores/runState";
import { useTeamStore } from "../../stores/teamStore";
import {
  CloseIcon,
  EnterIcon,
  FileIcon,
  PlusIcon,
  StopIcon,
} from "../../components/ui/icons";
import { RoundMeter } from "../shell/RoundMeter";
import { IMAGE_TYPES, mimeFor, vet, type Staged } from "./attachments";
import { AutonomyControl } from "./AutonomyControl";
import { useEventStore } from "../../stores/eventStore";
import { useSettingsStore } from "../../stores/settingsStore";

/** About eight lines. Past that the box would start eating the conversation
 *  it is a reply to, and the textarea scrolls instead. */
const MAX_COMPOSER_PX = 168;

/** A vetted file, plus the object URL a picture needs for its thumbnail. */
type Attached = Staged & { preview?: string };

/**
 * Whether this drag is carrying files at all.
 *
 * Dragging selected text inside the app is still a drag, and highlighting the
 * composer for it — then swallowing the drop — would break ordinary text
 * dragging to no purpose. `types` is readable during the drag; the files
 * themselves are not, by design.
 */
function hasFiles(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

export function Composer() {
  const missionId = useMissionStore((s) => s.missionId);
  const endReason = useEndReason();
  const teamId = useMissionStore((s) => s.teamId);
  const launching = useMissionStore((s) => s.launching);
  const sendFirst = useMissionStore((s) => s.sendFirst);
  const continueRun = useMissionStore((s) => s.continueRun);
  const rejected = useMissionStore((s) => s.rejected);
  const teams = useTeamStore((s) => s.teams);
  const [text, setText] = useState("");
  /** Set once a note has been accepted for delivery, cleared when the next
   *  step picks it up — i.e. when the next event arrives. */
  const [queued, setQueued] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  //: Which row of the `/` menu the arrows are on. Reset whenever the filter
  //: changes, so the highlight never points at a row that has moved.
  const [pick, setPick] = useState(0);
  const [rewinding, setRewinding] = useState(false);
  const events = useEventStore((s) => s.events);
  const roster = useMissionStore((s) => s.roster);
  const providers = useSettingsStore((s) => s.providers);

  // Whether any model on this run is *known* not to read images. Known, not
  // guessed: the flag is only written after an endpoint has actually refused
  // one (§3.1), so an unprobed model says nothing rather than warning wrongly.
  const blindModels = useMemo(() => {
    const models = new Set(roster.map((m) => m.model).filter(Boolean));
    return providers
      .filter(
        (p) =>
          p.model &&
          models.has(p.model) &&
          (p.capabilities as { vision?: boolean } | null)?.vision === false,
      )
      .map((p) => p.model as string);
  }, [roster, providers]);
  const box = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  /** Images chosen but not yet sent, so they can be shown and removed before
   *  they go anywhere. */
  const [staged, setStaged] = useState<Attached[]>([]);
  /** Whether a drag is currently over the composer. Counted rather than a
   *  boolean: dragleave fires when the pointer crosses onto a *child*, so a
   *  plain flag flickers off over the textarea and the buttons. */
  const [dragDepth, setDragDepth] = useState(0);
  const [imageError, setImageError] = useState<string | null>(null);

  // Grows with the text, up to a ceiling. A single-line box turns a paragraph
  // into a keyhole; an uncapped one eats the transcript it is a reply to.
  // Height is set from `scrollHeight`, which needs the reset first — without it
  // the box can only ever get taller.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    // Measured before the height is assigned: afterwards `scrollHeight` is
    // clamped to the box and can no longer say whether anything overflowed.
    const full = el.scrollHeight;
    el.style.height = `${Math.min(full, MAX_COMPOSER_PX)}px`;
    // The scrollbar only exists once the box has stopped growing. `auto` left
    // on permanently still paints the track and its arrows in this WebView, so
    // an empty one-line composer carried a scrollbar for content that was not
    // there.
    el.style.overflowY = full > MAX_COMPOSER_PX ? "auto" : "hidden";
  }, [text]);

  // "Waiting for the next step" has to stop being true at some point, and the
  // moment it stops is a real one on the log: the next task starting is
  // exactly when a mailbox is collected. Counted rather than timed — a guess
  // at how long a step takes would be the label lying by a different route.
  const stepsStarted = useMemo(
    () =>
      events.filter(
        (e) =>
          e.event.draft.type === "mission.progress" &&
          (e.event.draft.payload as unknown as { state?: string }).state ===
            "running",
      ).length,
    [events],
  );

  useEffect(() => {
    setQueued(false);
  }, [stepsStarted]);

  const running = missionId !== null && endReason === null;
  const first = missionId === null;
  const team = teams.find((t) => t.id === teamId) ?? null;
  const canSend =
    !launching &&
    text.trim().length > 0 &&
    (running ? missionId !== null : team !== null);

  /**
   * Send whatever is in the box.
   *
   * Takes the text as an argument rather than reading `text` from the closure,
   * because the keyboard path cannot trust the closure: `onKeyDown` fires on
   * the DOM node as it was last *rendered*, and a paste followed immediately by
   * Enter arrives before React has committed the change. The old version read a
   * stale `text` — usually "" — decided there was nothing to send, and returned
   * having already called `preventDefault()`. The keystroke vanished: no
   * newline, no message, and a hint underneath still promising "Enter sends".
   */
  const stage = async (files: FileList | null | File[]) => {
    const list = files ? Array.from(files as ArrayLike<File>) : [];
    if (list.length === 0) return;
    setImageError(null);

    const next: Attached[] = [];
    for (const file of list) {
      const mime = mimeFor(file);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = vet(file.name, mime, bytes);

      if (!result.ok) {
        // Said the moment it is dropped, naming the file and the actual
        // reason, rather than after an upload round trip.
        setImageError(
          result.reason === "not-readable"
            ? strings.composer.notReadable(file.name)
            : strings.composer.tooBig(file.name, result.limit ?? 0),
        );
        continue;
      }

      next.push({
        ...result.staged,
        // Only a picture gets a preview URL, and only a picture needs one.
        ...(result.staged.kind === "image"
          ? { preview: URL.createObjectURL(file) }
          : {}),
      });
    }
    setStaged((current) => [...current, ...next]);
  };

  const drop = (index: number) =>
    setStaged((current) => {
      const preview = current[index]?.preview;
      if (preview) URL.revokeObjectURL(preview);
      return current.filter((_, i) => i !== index);
    });

  const send = (raw: string) => {
    // What was typed decides which of two very different things happens: the
    // app acts, or four models are paid to read something. `parse` is the only
    // place that decision is made, and an unrecognised slash word is a
    // message — see `commands.ts`.
    const parsed = parse(raw, usable, teammates);
    if (parsed.kind === "command") {
      setQueueError(null);
      if (parsed.id === "rewind") {
        setText("");
        setRewinding(true);
        return;
      }
      if (!parsed.rest) {
        // `/plan` or `/fork` with nothing after it is a person part-way
        // through typing. Leave it alone rather than sending an empty round.
        return;
      }
      setText("");
      if (parsed.id === "fork") {
        void forkRun(parsed.rest);
        return;
      }
      // /plan — the same round, gated. Continuing a conversation could never
      // ask for this before: the flag existed only on the launch form.
      if (missionId) void continueRun(parsed.rest, { requireApproval: true });
      else if (team)
        void sendFirst(team, parsed.rest, { requireApproval: true });
      return;
    }

    const message = parsed.text;
    const addressed = parsed.to;
    // An image on its own is a real message — "what is wrong with this?" is
    // often the whole question — so text is only required when nothing else is.
    if ((!message && staged.length === 0) || launching) return;

    // Images first, so they are attached before the message that refers to
    // them starts a round. Each publishes `attachment.added`, which is what
    // puts it on the timeline.
    const pending = staged;
    const upload = async (target: string) => {
      for (const image of pending) {
        await api.addAttachment(target, {
          name: image.name,
          mime: image.mime,
          data_b64: image.data,
        });
        if (image.preview) URL.revokeObjectURL(image.preview);
      }
    };
    if (pending.length > 0) setStaged([]);

    // Working: queue it for the next step rather than refusing to take it.
    if (running && missionId) {
      setText("");
      setQueueError(null);
      void upload(missionId)
        .then(() => api.noteMission(missionId, message, addressed))
        .then(() => setQueued(true))
        .catch(() => setQueueError(strings.composer.queueFailed));
      return;
    }

    setText("");

    // A round ended, and this is the next thing to say about the same work.
    // Continuing keeps the roster, the workspace and the whole timeline —
    // starting a new run would throw all three away to ask for one change.
    if (missionId) {
      void upload(missionId).then(() => continueRun(message));
      return;
    }

    if (!team) return;
    // The mission does not exist until `sendFirst` returns, so the images are
    // attached to it afterwards — and the round is already under way, which is
    // why they land on the *next* one. Said in the hint rather than hidden.
    void sendFirst(team, message).then(() => {
      const created = useMissionStore.getState().missionId;
      if (created) void upload(created);
    });
  };

  // What the app would do with what is currently typed. Derived every render
  // rather than tracked in state: two answers to "is this a command" is one
  // too many, and the stale one would be the one on screen (§2.1).
  const usable = available({ hasMission: missionId !== null, running });
  const filter = menuFilter(text);
  const options = filter === null ? [] : matches(filter, usable);
  const menuOpen = options.length > 0;

  // The roster of the run on screen — the only people a note can reach, so the
  // only people worth offering. Empty before a run exists, which is also when
  // there is nobody to address.
  const teammates = roster.map((m) => m.name);
  const whoFilter = running ? nameFilter(text) : null;
  const whoOptions = whoFilter === null ? [] : whoMatches(whoFilter, teammates);
  const whoOpen = whoOptions.length > 0;

  const takeName = (name: string) => {
    // A space after it, because the message comes next — and because a space
    // is what closes this menu.
    setText(`@${name} `);
    box.current?.focus();
  };
  const intent = parse(text, usable, teammates);
  const forkRun = useMissionStore.getState().forkRun;

  const take = (spec: CommandSpec) => {
    // A command that takes an argument leaves the caret after a space, ready
    // for it; one that does not runs on the spot.
    if (spec.takesText) {
      setText(`/${spec.name} `);
      box.current?.focus();
      return;
    }
    setText("");
    send(`/${spec.name}`);
  };

  const dragging = dragDepth > 0;
  // Nothing to send and a team still working: the only useful thing this button
  // can do is stop the run.
  const stopping = running && missionId !== null && text.trim().length === 0;

  return (
    <div
      className={cn(
        "relative shrink-0 border-t border-line p-3 transition-colors",
        dragging && "bg-accent/5",
      )}
      // Counted, not toggled: `dragleave` fires every time the pointer crosses
      // onto a child, so a boolean flickers off over the textarea and the
      // buttons and the highlight strobes.
      onDragEnter={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDragDepth((depth) => depth + 1);
      }}
      onDragOver={(event) => {
        // Required: without preventDefault on dragover the browser refuses the
        // drop entirely and opens the file in a new tab instead.
        if (hasFiles(event)) event.preventDefault();
      }}
      onDragLeave={() => setDragDepth((depth) => Math.max(0, depth - 1))}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDragDepth(0);
        void stage(event.dataTransfer.files);
      }}
    >
      {/* Shown over the composer while a drag is in flight. `pointer-events-none`
          matters: an overlay that swallows the pointer would take the drop
          itself and the handlers above would never fire. */}
      {dragging ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-card border-2 border-dashed border-accent bg-bg/80 text-sm font-medium text-accent"
        >
          {strings.composer.dropHere}
        </div>
      ) : null}

      {rejected ? (
        // Every blocking finding, because fixing a team one rejection at a
        // time is a guessing game (§5.2).
        <div className="mb-2 rounded-[9px] border border-stop/40 bg-stop/10 p-3 text-xs text-stop">
          <div className="font-medium">{strings.mission.rejected}</div>
          <ul className="mt-1 list-inside list-disc">
            {rejected.map((problem, i) => (
              <li key={i}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {staged.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {staged.map((item, index) => (
            <div key={`${item.name}-${index}`} className="relative">
              {/* A picture shows itself; a text file cannot, so it gets a chip
                  with its name and size. Showing a generic thumbnail for one
                  would be a picture of nothing. */}
              {item.preview ? (
                <img
                  src={item.preview}
                  alt={item.name}
                  className="h-16 w-16 rounded-card border border-line object-cover"
                />
              ) : (
                <span className="flex h-16 min-w-[7rem] max-w-[12rem] flex-col justify-center gap-1 rounded-card border border-line bg-solid px-3">
                  <span className="flex items-center gap-1.5 text-xs text-text">
                    <FileIcon size={13} />
                    <span className="truncate">{item.name}</span>
                  </span>
                  <span className="text-[11px] text-faint">
                    {Math.max(1, Math.round(item.bytes / 1024))} KB
                  </span>
                </span>
              )}
              <button
                type="button"
                onClick={() => drop(index)}
                aria-label={strings.composer.removeImage(item.name)}
                className="absolute -right-1.5 -top-1.5 rounded-full bg-solid-2 p-0.5 text-faint hover:text-stop"
              >
                <CloseIcon size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {imageError ? (
        <p className="mb-2 text-[11px] text-stop">{imageError}</p>
      ) : null}

      {/* Only for pictures. A text file goes in as text and a model with no
          vision reads it perfectly well — warning about it would be the UI
          inventing a limitation that is not there. */}
      {staged.some((item) => item.kind === "image") &&
      blindModels.length > 0 ? (
        <p className="mb-2 text-[11px] text-wait">
          {strings.composer.modelCannotSeeImages(blindModels.join(", "))}
        </p>
      ) : null}

      <div className="flex items-end gap-2">
        <input
          ref={filePicker}
          type="file"
          // Images by type, plus the text families. Deliberately permissive —
          // a `.env` or a `.log` has no registered type at all, and the real
          // gate is `vet`, which decodes the bytes.
          accept={[
            ...IMAGE_TYPES,
            "text/*",
            ".md",
            ".csv",
            ".json",
            ".log",
            ".yml",
            ".yaml",
          ].join(",")}
          multiple
          className="sr-only"
          onChange={(event) => {
            void stage(event.target.files);
            // Cleared so choosing the same file twice fires `change` again.
            event.target.value = "";
          }}
        />

        <div className="relative min-w-0 flex-1">
          {menuOpen ? (
            <CommandMenu
              specs={options}
              active={Math.min(pick, options.length - 1)}
              onPick={take}
              onHover={setPick}
            />
          ) : whoOpen ? (
            <NameMenu
              names={whoOptions}
              active={Math.min(pick, whoOptions.length - 1)}
              onPick={takeName}
              onHover={setPick}
            />
          ) : null}
          <label htmlFor="composer" className="sr-only">
            {strings.composer.label}
          </label>
          <textarea
            id="composer"
            ref={box}
            rows={1}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              // The list has just been re-filtered; an old index would be
              // pointing at a row that moved.
              setPick(0);
            }}
            onKeyDown={(event) => {
              // The menu owns the keys while it is open, and hands them back
              // the moment it closes. Escape closes it and leaves the text
              // alone — it does not also stop the run, because one key doing
              // two irreversible things is how a run gets killed by accident.
              if (menuOpen || whoOpen) {
                const count = menuOpen ? options.length : whoOptions.length;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  setPick((at) => (at + step + count) % count);
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  const at = Math.min(pick, count - 1);
                  if (menuOpen) take(options[at]!);
                  else takeName(whoOptions[at]!);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setText("");
                  return;
                }
              }
              if (event.key === "Escape" && running && missionId) {
                event.preventDefault();
                void api.cancelMission(missionId);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                // The element's own value, which is always current — and
                // `preventDefault` only once there is something to send, so a
                // key we decline to act on still does what the user expects.
                const value = event.currentTarget.value;
                if (!value.trim() || launching) return;
                // A command needs neither a team nor a running mission — it is
                // the app being asked to do something, not a round being sent.
                if (
                  !running &&
                  !team &&
                  parse(value, usable, teammates).kind !== "command"
                )
                  return;
                event.preventDefault();
                send(value);
              }
            }}
            placeholder={
              running
                ? strings.composer.runningPlaceholder
                : first
                  ? strings.composer.firstPlaceholder
                  : strings.composer.placeholder
            }
            className={cn(
              // `block` is load-bearing: a textarea is inline-block by
              // default, so it sits on its container's text baseline and
              // leaves descender space underneath. The row is `items-end`, so
              // that gap pushed the button 6px below the box it was meant to
              // line up with — a misalignment with no visible cause.
              // `overflow-hidden` is the resting state; the effect above turns
              // scrolling on only when the text passes the ceiling.
              "block w-full resize-none overflow-hidden rounded-card border border-line",
              "bg-solid px-3 py-2.5 text-sm leading-relaxed text-text placeholder:text-faint",
            )}
          />
        </div>
        {/* One square, flush with the first line of the box.
            `h-[42px] w-[42px]` rather than padding plus a line-box: the old
            button's height came out of its text, so it never lined up with the
            textarea beside it — and once the textarea grows, `items-end` keeps
            the button on the last line where the caret is.

            It stops the run when the team is working and there is nothing to
            send, because that is the only thing the button could usefully do
            in that state, and the run's Stop no longer lives in the header. */}
        <button
          type="button"
          onClick={() =>
            stopping ? void api.cancelMission(missionId!) : send(text)
          }
          disabled={!stopping && !canSend}
          aria-label={
            stopping
              ? strings.composer.stopRun
              : first
                ? strings.composer.start
                : strings.composer.send
          }
          title={
            stopping
              ? strings.composer.stopRun
              : first
                ? strings.composer.start
                : strings.composer.send
          }
          className={cn(
            "flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-card",
            "transition-[filter,background-color] disabled:opacity-40",
            stopping
              ? "border border-stop/50 text-stop hover:bg-stop/10"
              : "bg-accent text-[#08222c] hover:brightness-110",
          )}
        >
          {stopping ? <StopIcon /> : <EnterIcon />}
        </button>
      </div>
      {/* One compact row of controls, the way a composer footer reads: what
          mode you are in, and a `+` for everything you might add. The three
          separate lines this replaces — an attach button beside the box, a
          full-width labelled select, and a sentence of keyboard help — took
          three times the height to say the same thing, and the keyboard help
          was permanent instructions for a shortcut you learn once. */}
      <div className="mt-1 flex flex-wrap items-center gap-2 px-1">
        <AutonomyControl running={running} />

        {/* A button, not a menu. "Change folder" was the only other item and it
            never worked: the workspace is frozen into the mission at launch
            (§5.1), so it was disabled for the whole life of every run — and on
            a draft, where it was enabled, it cleared a store value that nothing
            on this screen reads, so pressing it did nothing at all.

            Disabled-with-a-reason was the wrong shape for it. The way to point
            a team at another folder is to start a run, which "New" already
            does, and a permanently greyed row is not a route to that. So the
            menu is gone and its one live item is the control. */}
        <button
          type="button"
          onClick={() => filePicker.current?.click()}
          aria-label={strings.composer.addFiles}
          title={strings.composer.addFiles}
          className={cn(
            "flex size-[24px] items-center justify-center rounded-card",
            "text-muted hover:bg-solid hover:text-text",
          )}
        >
          <PlusIcon />
        </button>

        {rewinding ? (
          <RewindDialog onClose={() => setRewinding(false)} />
        ) : null}

        {/* Which of the two things Enter is about to do. The whole risk of
            putting commands in this box is that a person means one and gets
            the other, so it is stated before the key is pressed rather than
            implied by a slash. */}
        {intent.kind === "command" ? (
          <span className="text-[11px] text-accent">
            {strings.commands.willRun(intent.id)}
          </span>
        ) : intent.to ? (
          <span className="text-[11px] text-accent">
            {strings.commands.addressed(intent.to)}
          </span>
        ) : null}

        {queued && running ? (
          <span className="text-[11px] text-wait">
            {strings.composer.queued}
          </span>
        ) : null}
        {queueError ? (
          <span className="text-[11px] text-stop">{queueError}</span>
        ) : null}

        {/* Pushed to the far end of the row. It is the only thing here that is
            a reading rather than a control, and "have I got room for another
            go at this?" is a question that comes up beside the box, not in a
            panel that may not even be open. */}
        <RoundMeter />
      </div>
    </div>
  );
}
