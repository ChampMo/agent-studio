/**
 * The icons, drawn rather than downloaded (§18.1).
 *
 * A handful of 16px strokes on a shared grid: no icon font, no sprite sheet, no
 * dependency to keep current. Each one is `aria-hidden` and always sits beside
 * a real label or an `aria-label`, because an icon on its own is a guess the
 * reader has to make — and the ones people guess wrong are exactly the ones
 * that do something irreversible.
 *
 * `currentColor` throughout, so an icon belongs to the text it sits in and
 * follows its state without a second colour to keep in sync.
 */
type IconProps = { size?: number; className?: string };

function Svg({
  size = 16,
  className,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {children}
    </svg>
  );
}

export function SendIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 8h11M9 4l4 4-4 4" />
    </Svg>
  );
}

/** The return key's arrow. Says "this is what Enter does" without a word. */
export function EnterIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 3v4.5a1.5 1.5 0 0 1-1.5 1.5H3" />
      <path d="M6 6 3 9l3 3" />
    </Svg>
  );
}

export function ImageIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <circle cx="6" cy="6.5" r="1" />
      <path d="M2.5 11.5 6 8.5l2.5 2 2-1.5 3 2.5" />
    </Svg>
  );
}

export function FileIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6z" />
      <path d="M9 2v3.5A.5.5 0 0 0 9.5 6H13" />
    </Svg>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2a1 1 0 0 1 .8.4l.7.9a1 1 0 0 0 .8.4h4.5A1.5 1.5 0 0 1 14 6.2v5.3A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />
    </Svg>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
    </Svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8" />
    </Svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="7" cy="7" r="4" />
      <path d="m10 10 3 3" />
    </Svg>
  );
}

/** One person: the roster is a list of individual agents. */
export function PersonIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3.5 13.5a4.5 4.5 0 0 1 9 0" />
    </Svg>
  );
}

/** Two people, overlapping: a team is a group, and the difference from the
 *  roster icon has to be visible at 15px. */
export function TeamIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="6" cy="5.5" r="2.2" />
      <path d="M1.8 13a4.2 4.2 0 0 1 8.4 0" />
      <path d="M10.6 3.6a2.2 2.2 0 0 1 0 4.3" />
      <path d="M11.5 9.4a4.2 4.2 0 0 1 2.7 3.6" />
    </Svg>
  );
}

/** Sliders rather than a gear: these are settings you adjust, and a gear reads
 *  as machinery. */
export function SettingsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 4.5h11M2.5 11.5h11" />
      <circle cx="6" cy="4.5" r="1.6" />
      <circle cx="10.5" cy="11.5" r="1.6" />
    </Svg>
  );
}

/** Three dots: "there is more here". Never on its own — the button carrying it
 *  always names what it acts on. */
export function MoreIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** The tick inside a checkbox. Drawn at a heavier weight than the rest — at
 *  10px a 1.5px stroke reads as grey rather than as a mark. */
export function CheckIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}

/** The disclosure chevron on a dropdown trigger. A drawn shape rather than the
 *  "⌄" character, which renders at whatever weight and baseline the font
 *  happens to give it and sat visibly off-centre. */
export function ChevronDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m4 6.5 4 4 4-4" />
    </Svg>
  );
}

/**
 * The leader's star: hollow to hand it over, solid to say who holds it.
 *
 * One shape in two states rather than a star plus a "Leader" badge — the badge
 * was a second thing saying what the star could say by itself.
 */
export function StarIcon({
  filled,
  ...props
}: IconProps & { filled?: boolean }) {
  return (
    <Svg {...props}>
      <path
        d="M8 2.5 9.7 6l3.8.5-2.8 2.6.7 3.8L8 11.1 4.6 12.9l.7-3.8L2.5 6.5 6.3 6z"
        fill={filled ? "currentColor" : "none"}
      />
    </Svg>
  );
}

/** A prompt and a caret: the terminal panel's button. */
export function TerminalIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="m5 6.5 2 1.8-2 1.8M8.5 10.3H11" />
    </Svg>
  );
}

/** The run panel's button: a small column of rows, which is what it is. */
export function PanelIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M9.5 3v10M11 6.5h1.5M11 9.5h1.5" />
    </Svg>
  );
}

/** The scene pane's three drawings, for the button that cycles them. */
export function AutoModeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5v11" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function RoomIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2.5 13.5 5.5v5L8 13.5 2.5 10.5v-5z" />
      <path d="M2.5 5.5 8 8.5l5.5-3M8 8.5v5" />
    </Svg>
  );
}

export function RosterIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="4" cy="7" r="1.8" />
      <circle cx="8" cy="7" r="1.8" />
      <circle cx="12" cy="7" r="1.8" />
      <path d="M3 11.5h10" />
    </Svg>
  );
}

/** Two overlapping frames: "in its own window". */
export function PopOutIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5.5" y="2.5" width="8" height="8" rx="1" />
      <path d="M2.5 6v6.5a1 1 0 0 0 1 1H10" />
    </Svg>
  );
}

/** The reverse: an arrow back into the frame. */
export function PopInIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M13.5 2.5 8.5 7.5M9 3h4.5v4.5" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Svg>
  );
}

/** A pencil, for renaming things in place. */
export function PencilIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11.2 2.3a1.4 1.4 0 0 1 2 2L5.6 11.9l-2.7.8.8-2.7z" />
      <path d="M10.1 3.4 12.6 5.9" />
    </svg>
  );
}

/**
 * The twelve-bar throbber, for a character who is thinking or working.
 *
 * Drawn rather than animated with a transform on a single arc, because the
 * bars are what carry the state when nothing is allowed to move: the ramp of
 * opacity around the ring reads as "part way round" even frozen, so someone
 * who has asked for less motion still sees an indicator rather than a circle
 * of identical dashes (§18.3).
 *
 * It ticks in twelve steps rather than sweeping. A smooth rotation of twelve
 * discrete bars beats against its own geometry and reads as a wobble; landing
 * each bar exactly where the last one was is what makes it look like the thing
 * everyone recognises.
 *
 * `aria-hidden`, like every other icon here: the status word sits beside it
 * and is what gets announced. An icon that also spoke would say it twice.
 */
export function ThrobberIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className="throbber"
    >
      {Array.from({ length: 12 }, (_, i) => (
        <rect
          key={i}
          x="10.9"
          y="1.6"
          width="2.2"
          height="6.4"
          rx="1.1"
          transform={`rotate(${i * 30} 12 12)`}
          // Brightest at the head, fading backwards round the ring. Floored
          // rather than run to zero: a bar that disappears entirely leaves a
          // gap, and the gap is what makes a throbber look broken.
          opacity={(0.14 + (i / 11) * 0.86).toFixed(3)}
        />
      ))}
    </svg>
  );
}
