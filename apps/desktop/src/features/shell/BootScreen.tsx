/**
 * What the window shows before the backend has answered.
 *
 * It was two lines of grey text. That is honest and says nothing about which
 * app you just opened — and on a packaged build it is the *first* thing anyone
 * sees, for the second or two a one-file PyInstaller bundle spends unpacking
 * itself.
 *
 * So: the cat, and the fish it is eating. Both are the app's own artwork, and
 * the fish is the same `.fish-loader` the transcript uses for a busy agent —
 * one drawing, one animation, one meaning. A spinner invented for this screen
 * would be a second thing that means "working".
 *
 * **It claims nothing about progress.** There is no bar and no percentage,
 * because there is nothing to measure: the backend answers `/health` when it
 * answers, and this side is polling. The loop is a sign of life (§1.1). The
 * only fact on screen is the sentence, and it says what is being waited for.
 *
 * **This cat is not an agent.** Every other cat in the app is drawn from an
 * `avatar_config` that belongs to somebody; this one is the app's own face,
 * the same marmalade that is on the window icon and the installer. It is
 * named through `pathsFor` rather than by writing the four paths out here, so
 * the folder layout still has exactly one definition (§2.1) — and its mouth is
 * the open frame because it is eating, which is the one place in this app
 * where an open mouth is not a claim that an agent is speaking.
 */
import { useState } from "react";

import { strings } from "../../lib/constants/strings.en";
import { inTauri } from "../../lib/popout";
import { pathsFor } from "../../scene/entities/catArt";

/** How big the cat is drawn. The fish's own size is `--fish-scale` in CSS. */
const CAT = 128;

/**
 * Where the fish has to sit to be at the mouth rather than merely beside it.
 *
 * The mouth's ink spans y 49-69 of the cat's 100px canvas, so its centre is at
 * 59% — nine percent below the middle of the drawing. A row centred the
 * ordinary way puts the fish level with the eyes.
 */
const TO_MOUTH = Math.round(CAT * (0.59 - 0.5));

/** Clear of the whiskers, close enough to belong to the cat. Measured. */
const GAP = 12;

const MASCOT = pathsFor({
  breed: "marmalade",
  size: "normal",
  headwear: "none",
  glasses: "none",
  collar: "none",
});

//: Face, then the resting eyes, then the *open* mouth — index 1, because the
//: pair is resting-first and resting is shut.
const LAYERS = [MASCOT.faceCandidates[0]!, MASCOT.eyes[0]!, MASCOT.mouth[1]!];

export function BootScreen() {
  //: A drawing that is not there must not leave a broken-image glyph on the
  //: first screen of the app. Dropped individually, the way `catArt` drops a
  //: single layer: a cat with no collar is still a cat.
  const [missing, setMissing] = useState<string[]>([]);

  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center gap-6 px-6 text-center">
      <div
        aria-hidden="true"
        className="flex items-center"
        style={{ gap: GAP }}
      >
        <span
          className="fish-loader fish-loader--boot"
          style={{ transform: `translateY(${TO_MOUTH}px)` }}
        />
        <span
          className="relative block shrink-0"
          style={{ width: CAT, height: CAT }}
        >
          {LAYERS.filter((src) => !missing.includes(src)).map((src) => (
            <img
              key={src}
              src={src}
              alt=""
              // Every layer shares one 100x100 canvas and one origin, so
              // stacking them is the whole of the compositing.
              className="absolute inset-0 h-full w-full"
              style={{ imageRendering: "pixelated" }}
              onError={() => setMissing((gone) => [...gone, src])}
            />
          ))}
        </span>
      </div>

      <div aria-live="polite" className="space-y-1">
        <p className="text-sm text-muted">{strings.app.waitingForBackend}</p>
        <p className="text-xs text-faint">
          {inTauri() ? strings.app.waitingHintApp : strings.app.waitingHint}
        </p>
      </div>
    </div>
  );
}
