/**
 * Whether the scene should be animating at all (§17.1, §12 M9 criterion 2).
 *
 * The scene used to live in a tab, so it stopped existing when you looked away.
 * With the splitter it is always mounted, which means PixiJS would otherwise
 * run a sixty-times-a-second loop behind a collapsed pane or a window nobody is
 * looking at — work whose entire output is invisible, on a laptop battery.
 *
 * Hiding it with CSS does not help: `display: none` stops the painting, not the
 * ticker, and the ticker is what costs. So the answer is computed here and the
 * stage starts and stops its ticker on it.
 */
import { COLLAPSED_BELOW } from "../../components/ui/splitter";

export interface Visibility {
  /** The height the splitter has given the scene, in pixels. */
  heightPx: number;
  /** `document.hasFocus()` — another window is in front. */
  windowFocused: boolean;
  /** `document.visibilityState` — minimised, or another tab. */
  documentVisible: boolean;
}

export function shouldAnimate({
  heightPx,
  windowFocused,
  documentVisible,
}: Visibility): boolean {
  if (heightPx < COLLAPSED_BELOW) return false;
  if (!documentVisible) return false;
  return windowFocused;
}
