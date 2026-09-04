/**
 * The theme, beside the app's name.
 *
 * It cycles rather than opening a menu: three states is few enough that
 * pressing again to keep going is faster than a popup, and the button always
 * says which one it is on. Settings still has the full control with all three
 * laid out — this is the shortcut, not the only way in.
 *
 * The icon is the *current* theme rather than the next one. A button that
 * shows what it will do is fine for two states and unreadable for three, and
 * "which theme am I in" is the question someone glancing at it actually has.
 * The title says what pressing it does, so nothing is left to be inferred.
 */
import { strings } from "../../lib/constants/strings.en";
import { useThemeStore, type ThemeChoice } from "../../stores/themeStore";

const NEXT: Record<ThemeChoice, ThemeChoice> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const LABEL: Record<ThemeChoice, string> = {
  system: strings.theme.system,
  light: strings.theme.light,
  dark: strings.theme.dark,
};

function Icon({ choice }: { choice: ThemeChoice }) {
  if (choice === "light") {
    // Afternoon: the sun, high.
    return (
      <svg
        width="15"
        height="15"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="3.2" fill="currentColor" />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
          <rect
            key={deg}
            x="7.4"
            y="0.8"
            width="1.2"
            height="2.4"
            rx="0.6"
            fill="currentColor"
            transform={`rotate(${deg} 8 8)`}
          />
        ))}
      </svg>
    );
  }
  if (choice === "dark") {
    // Dusk: the sun gone down behind the horizon, which is the theme's whole
    // idea — not a moon, because this is not night.
    return (
      <svg
        width="15"
        height="15"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="8" cy="9" r="3.4" fill="currentColor" />
        <rect
          x="1"
          y="10.6"
          width="14"
          height="1.4"
          rx="0.7"
          fill="currentColor"
        />
        <rect
          x="3"
          y="13.2"
          width="10"
          height="1.2"
          rx="0.6"
          fill="currentColor"
          opacity="0.55"
        />
      </svg>
    );
  }
  // Following the system: half of each.
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="5.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 2.4a5.6 5.6 0 0 0 0 11.2z" fill="currentColor" />
    </svg>
  );
}

export function ThemeToggle() {
  const choice = useThemeStore((s) => s.choice);
  const set = useThemeStore((s) => s.set);

  return (
    <button
      type="button"
      onClick={() => set(NEXT[choice])}
      // Both, because they answer different questions: the label is where it
      // is now, the title is what the press does.
      aria-label={strings.theme.current(LABEL[choice])}
      title={strings.theme.switchTo(LABEL[NEXT[choice]])}
      className="flex size-[26px] shrink-0 items-center justify-center rounded-card text-muted hover:bg-solid-2 hover:text-text"
    >
      <Icon choice={choice} />
    </button>
  );
}
