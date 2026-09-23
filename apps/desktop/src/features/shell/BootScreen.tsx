/**
 * What the window shows before the backend has answered.
 *
 * One drawing: the fish, being eaten. Nothing else.
 *
 * It was two lines of grey text, then a cat with the fish beside it. Both the
 * words and the cat have gone, and what is left is the thing that was doing
 * the work the whole time — **the same `.fish-loader` the transcript uses for
 * a busy agent**. One drawing, one animation, one meaning, everywhere in the
 * app. A spinner invented for this screen would be a second thing that means
 * "working", and the cat was a second thing that meant nothing at all: it sat
 * still while the fish moved.
 *
 * **It claims nothing about progress.** There is no bar and no percentage,
 * because there is nothing to measure: the backend answers `/health` when it
 * answers, and this side is polling. The loop is a sign of life (§1.1).
 *
 * **And no words.** The sentence said what was being waited for, which is a
 * fact about this app's own internals shown to somebody who has just
 * double-clicked an icon, for the second or two before it goes away.
 *
 * It is not silent to a screen reader, where a picture says nothing at all.
 * The sentence is still there and still live — `sr-only`, the same way the
 * composer's label and the checkbox input are hidden rather than removed. That
 * is the one reader for whom "just the fish" is no message.
 */
import { strings } from "../../lib/constants/strings.en";
import { inTauri } from "../../lib/popout";

export function BootScreen() {
  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center px-6">
      {/* Its size is `--fish-scale`, set by `.fish-loader--boot` in index.css —
          the crop is written once, in the art's own pixels, and that variable
          multiplies every number in it. */}
      <span aria-hidden="true" className="fish-loader fish-loader--boot" />

      <p aria-live="polite" className="sr-only">
        {strings.app.waitingForBackend}{" "}
        {inTauri() ? strings.app.waitingHintApp : strings.app.waitingHint}
      </p>
    </div>
  );
}
