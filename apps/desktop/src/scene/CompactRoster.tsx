/**
 * The same room, too short to be a room.
 *
 * Below `COMPACT_BELOW` the isometric view is a sliver of floor with the tops
 * of three heads in it, costing a WebGL context and a ticker to show less than
 * a list would. So the pane changes *what* it draws rather than drawing the
 * same thing badly: who is here, what they are, and who is talking to whom.
 *
 * Everything on screen comes from the same `SceneState` the room draws from, so
 * the two cannot disagree about anything (§2.1) — the portrait is the same
 * `avatar_config` through the same sheet, the status word is the same pose, and
 * the star is `role_in_team`.
 *
 * The lines are `agent.message.to`, which is the field the transcript prints as
 * "→ Developer (Dev)" beside a bubble. `recentTalk` refuses to produce any
 * while replaying and drops anything older than a few seconds, because a line
 * is a claim about *now* — see `talk.ts`.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { strings } from "../lib/constants/strings.en";
import { cn } from "../lib/cn";
import { Portrait } from "../components/ui/Portrait";
import { isActive, shapeFor } from "./animation/poses";
import { ThrobberIcon } from "../components/ui/icons";
import type { SceneState, Throw } from "./bindings/sceneState";
import { THINGS } from "./entities/throwArt";
import { justHappened, playChime } from "./audio";
import { WINDOW_MS, ageOf, recentTalk, type TalkLine } from "./bindings/talk";
import { bySeat } from "./bindings/order";
import { useEventStore } from "../stores/eventStore";

interface Spot {
  x: number;
  y: number;
}

/** How long a thrown thing is in the air, and how high it hops. Matches the
 *  room's `THROW_SEC` so the two views throw at the same speed. */
const FLIGHT_MS = 1500;
const HOP_PX = 36;
/** After landing: held in the recipient's hands, then faded out. */
const LINGER_MS = 600;
const FADE_MS = 400;

/** The drawing for a throw, chosen by seq like the room does. */
function thingFor(item: Throw): string {
  const things = THINGS[item.kind];
  return `/art/throw/${item.kind}/${things[Math.abs(item.seq) % things.length]}.png`;
}

/**
 * One thing flying from one portrait to another.
 *
 * Two animations on two elements: the outer moves in a straight line, the
 * inner hops up and back down, which together is an arc without computing
 * one. Both are started once, when the element mounts, with the Web
 * Animations API — a CSS transition would need a second render to have
 * something to transition *from*.
 */
function Flying({ item, from, to }: { item: Throw; from: Spot; to: Spot }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    const line = outer.current?.animate(
      [
        { transform: `translate(${from.x}px, ${from.y}px)` },
        { transform: `translate(${to.x}px, ${to.y}px)` },
      ],
      { duration: FLIGHT_MS, easing: "linear", fill: "forwards" },
    );
    const hop = inner.current?.animate(
      [
        { transform: "translateY(0) rotate(0deg)" },
        { transform: `translateY(-${HOP_PX}px) rotate(20deg)`, offset: 0.5 },
        { transform: "translateY(0) rotate(0deg)" },
      ],
      { duration: FLIGHT_MS, easing: "ease-in-out", fill: "forwards" },
    );
    // Then it sits where it landed and fades: opaque through the flight and
    // the linger, gone by the end of the fade.
    const total = FLIGHT_MS + LINGER_MS + FADE_MS;
    const fade = outer.current?.animate(
      [
        { opacity: 1 },
        { opacity: 1, offset: (FLIGHT_MS + LINGER_MS) / total },
        { opacity: 0 },
      ],
      { duration: total, easing: "linear", fill: "forwards" },
    );
    return () => {
      line?.cancel();
      hop?.cancel();
      fade?.cancel();
    };
  }, [from.x, from.y, to.x, to.y]);
  return (
    <div
      ref={outer}
      // Above the faces: the list is painted after this overlay, and a thing
      // thrown behind the cat it was thrown at was never seen to arrive.
      className="pointer-events-none absolute left-0 top-0 z-10"
      style={{ transform: `translate(${from.x}px, ${from.y}px)` }}
    >
      <img
        ref={inner}
        src={thingFor(item)}
        alt=""
        aria-hidden="true"
        className="-ml-8 -mt-8 block h-16 w-16"
        style={{ imageRendering: "pixelated" }}
      />
    </div>
  );
}

export function CompactRoster({ state }: { state: SceneState }) {
  const events = useEventStore((s) => s.events);
  const replaying = useEventStore((s) => s.replaying);

  const box = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const [spots, setSpots] = useState<Record<string, Spot>>({});

  //: Things in the air: the same throws the room throws, gated the same way
  //: (`justHappened`), drawn as images flying portrait to portrait. Each is
  //: removed when its flight ends.
  const [flights, setFlights] = useState<Throw[]>([]);
  const thrownUpTo = useRef(0);
  useEffect(() => {
    const at = Date.now();
    const fresh: Throw[] = [];
    for (const item of state.throws) {
      if (item.seq <= thrownUpTo.current) continue;
      thrownUpTo.current = item.seq;
      if (justHappened(item.ts, at, replaying)) fresh.push(item);
    }
    if (fresh.length === 0) return;
    setFlights((was) => [...was, ...fresh]);
    playChime("throw");
    // Not returned as the effect's cleanup: a second throw inside the 800ms
    // re-runs the effect, and a cleanup would cancel the first one's landing
    // and leave it hanging in the DOM for ever. Landings are owned by the
    // timer list below and cleared only when the roster unmounts.
    const landed = window.setTimeout(() => {
      timers.current.delete(landed);
      playChime("land");
    }, FLIGHT_MS);
    timers.current.add(landed);
    const id = window.setTimeout(() => {
      timers.current.delete(id);
      setFlights((was) => was.filter((f) => !fresh.includes(f)));
    }, FLIGHT_MS + LINGER_MS + FADE_MS);
    timers.current.add(id);
  }, [state.throws, replaying]);
  const timers = useRef(new Set<number>());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const id of pending) window.clearTimeout(id);
      pending.clear();
    };
  }, []);

  //: The clock the lines are measured against.
  //:
  //: It has to move on **every new event**, not only while lines already
  //: exist. The first version started its timer on `lines.length > 0` — and
  //: `lines` is computed from `now`, so the clock froze at mount, every later
  //: message looked like it came from the future, and `recentTalk`'s own
  //: future-guard dropped it. Nothing ever drew.
  //:
  //: `talk.test.ts` could not have caught it: the pure function takes `now` as
  //: an argument and was right the whole time. The bug was entirely in who
  //: decides what time it is.
  const [now, setNow] = useState(() => Date.now());
  //: The roster is needed because  addresses people by name.
  const lines = recentTalk({
    events,
    roster: state.actors.map((a) => ({ agentId: a.agentId, name: a.name })),
    now,
    replaying,
  });

  // A new event is the only thing that can *start* a line, so it is what wakes
  // the clock.
  useEffect(() => {
    setNow(Date.now());
  }, [events]);

  // And once one is up, a timer to fade it. Only then: a permanent interval
  // behind a pane nobody is looking at is the work `shouldAnimate` exists to
  // avoid.
  useEffect(() => {
    if (lines.length === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 120);
    return () => window.clearInterval(id);
  }, [lines.length]);

  // Where each card ended up. Measured rather than computed: the row wraps, and
  // a line drawn to where a card *would* be if it had not wrapped is a line
  // pointing at nothing.
  useLayoutEffect(() => {
    const measure = () => {
      const origin = box.current?.getBoundingClientRect();
      if (!origin) return;
      const next: Record<string, Spot> = {};
      for (const [id, el] of cards.current) {
        const r = el.getBoundingClientRect();
        next[id] = {
          x: r.left - origin.left + r.width / 2,
          y: r.top - origin.top + r.height / 2,
        };
      }
      setSpots(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, [state.actors.length]);

  // The same order the rail and the room use — `order.ts` owns the rule now.
  // It lived here as its own sort, and the rail had a different one, so the
  // two lists of the same five people disagreed.
  const ordered = bySeat(
    state.actors.map((a) => ({
      ...a,
      seat_index: a.seatIndex,
      role_in_team: a.isLeader ? "leader" : "member",
    })),
  );

  if (state.actors.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <p className="text-xs text-faint">{strings.scene.nobody}</p>
      </div>
    );
  }

  return (
    <div
      ref={box}
      className="relative flex h-full flex-col overflow-auto px-3 py-2.5"
    >
      <Lines lines={lines} spots={spots} now={now} />
      {flights.map((item) => {
        // The person is at the bottom of the box, where the composer is.
        const front: Spot | null = box.current
          ? { x: box.current.clientWidth / 2, y: box.current.clientHeight - 12 }
          : null;
        const from = item.from === "front" ? front : spots[item.from];
        const to = item.to === "front" ? front : spots[item.to];
        if (!from || !to) return null;
        return <Flying key={`${item.seq}-${item.kind}`} item={item} from={from} to={to} />;
      })}

      {/* `my-auto` rather than `justify-center`: it centres the row in the pane
          when there is room, and lets it scroll from the top when there is not
          — a centred flex child with overflow clips its own first row instead
          of scrolling to it. */}
      <ul className="relative my-auto flex flex-wrap items-start justify-center gap-x-6 gap-y-3">
        {ordered.map((actor) => {
          const shape = shapeFor(actor.pose);
          //: Thinking or working — the same `isActive` the room uses to decide
          //: whether a character bobs, so the badge and the posture cannot
          //: disagree about who is busy (§2.1).
          //:
          //: `waiting` and `blocked` deliberately do not spin. They are
          //: stopped, and the thing `waiting` is stopped on is the reader —
          //: a spinner over it would say the app is working on something when
          //: it is the person who has been asked.
          const busy = isActive(actor.pose);
          //: The one the mission currently turns on — the same agent the
          //: room's camera turns to. A ring rather than a filled card: it
          //: marks a face without turning it into a button.
          const onFloor = actor.agentId === state.focusAgentId;
          return (
            <li
              key={actor.agentId}
              className="flex w-[8.5rem] min-w-0 flex-col items-center gap-1 text-center"
            >
              <span
                // Measured here rather than on the whole column, so the arcs
                // run face to face instead of card to card.
                ref={(el) => {
                  if (el) cards.current.set(actor.agentId, el);
                  else cards.current.delete(actor.agentId);
                }}
                className={cn(
                  "relative rounded-full",
                  onFloor &&
                    "ring-2 ring-accent ring-offset-2 ring-offset-room-sky",
                )}
              >
                <Portrait avatar={actor.avatar} name={actor.name} size={80} />

                {/* Top right, half off the portrait's edge, on its own disc so
                    the bars stay readable over whatever fur is behind them.
                    The status word is directly underneath, which is what a
                    reader is actually told — this is the glance version. */}
                {busy ? (
                  <span
                    className={cn(
                      "absolute -right-1 -top-1 flex size-[18px] items-center",
                      "justify-center rounded-full bg-solid-2 text-accent",
                      "ring-2 ring-room-sky",
                    )}
                  >
                    <ThrobberIcon size={13} />
                  </span>
                ) : null}
              </span>

              <span className="flex min-w-0 max-w-full items-baseline gap-1">
                {actor.isLeader ? (
                  <span
                    className="shrink-0 text-[11px] text-attn"
                    title={strings.scene.leader}
                    aria-label={strings.scene.leader}
                    role="img"
                  >
                    ★
                  </span>
                ) : null}
                <span className="truncate text-xs font-medium text-text">
                  {actor.name}
                </span>
              </span>

              {/* The job, then what they are doing. Both are on the log; the
                  room shows the second as a posture and this shows it as the
                  word it already was.

                  Two spans, not one string, because `truncate` eats from the
                  end — and the status is at the end and is the only half that
                  changes. `Senior Full-Stack Developer · idle` measured 159px
                  in a 136px column, so the Developer and the PM showed a job
                  title and no status at all, on the one view whose whole
                  purpose is who is doing what. The title gives way; the status
                  never does. */}
              <span className="flex max-w-full items-baseline gap-1 text-[11px] leading-tight text-faint">
                {actor.title ? (
                  <>
                    <span className="min-w-0 truncate">{actor.title}</span>
                    <span aria-hidden="true" className="shrink-0">
                      ·
                    </span>
                  </>
                ) : null}
                <span className="shrink-0">{shape.caption}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The arcs.
 *
 * Drawn behind the cards and `pointer-events: none`, so this is decoration over
 * a list rather than something you can catch with the mouse and wonder about.
 *
 * A message to one teammate is a curve between two cards. One to the user or to
 * the whole team leaves its sender and goes nowhere in particular, because that
 * is what it does — drawing it as an arrow to somebody would be inventing a
 * recipient the log does not have.
 */
function Lines({
  lines,
  spots,
  now,
}: {
  lines: TalkLine[];
  spots: Record<string, Spot>;
  now: number;
}) {
  if (lines.length === 0) return null;
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      aria-hidden="true"
    >
      {lines.map((line) => {
        const from = spots[line.from];
        if (!from) return null;
        const fade = 1 - ageOf(line, now);

        if (line.to) {
          const to = spots[line.to];
          if (!to) return null;
          // A curve, bowed away from the straight line, so two people talking
          // both ways are two arcs rather than one line drawn twice.
          const mx = (from.x + to.x) / 2;
          const my = (from.y + to.y) / 2 - Math.abs(to.x - from.x) * 0.18 - 12;
          return (
            <path
              key={line.id}
              d={`M ${from.x} ${from.y} Q ${mx} ${my} ${to.x} ${to.y}`}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth="1.5"
              strokeLinecap="round"
              opacity={fade * 0.85}
              // A travelling dash: the direction is the message's direction,
              // and it is the only thing here that says which way it went.
              className="motion-safe:[animation:talk-dash_.9s_linear_infinite]"
              strokeDasharray="5 7"
            />
          );
        }

        // To the user, or to everyone: a short stroke leaving the speaker.
        const up = line.kind === "user";
        return (
          <line
            key={line.id}
            x1={from.x}
            y1={from.y}
            x2={from.x + (up ? 0 : 18)}
            y2={from.y - (up ? 22 : 0)}
            stroke={up ? "var(--color-attn)" : "var(--color-accent)"}
            strokeWidth="1.5"
            strokeLinecap="round"
            opacity={fade * 0.7}
            strokeDasharray="4 6"
            className="motion-safe:[animation:talk-dash_.9s_linear_infinite]"
          />
        );
      })}
    </svg>
  );
}

export { WINDOW_MS };
