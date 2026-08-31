/**
 * Sound (PROJECT_BRIEF.md §12 M7).
 *
 * Synthesised rather than sampled: no audio assets exist, the same way no art
 * does, and a WebAudio oscillator is a tone this build owns outright instead of
 * a file that has to ship and be licensed.
 *
 * Three rules, and the second is the one that matters:
 *
 * * **Off by default.** An app that makes noise before being asked to is one
 *   people mute permanently, and the setting is remembered per machine.
 * * **Only for things that just happened.** A reconnect replays the log from
 *   seq 0 and opening an old mission replays all of it, so a naive hook would
 *   fire thirty chimes at once for a run that finished last week. `shouldChime`
 *   is pure and tested for exactly that.
 * * Nothing is announced that is not on the log. A chime marks an event, never
 *   a mood.
 */
import type { EventEnvelope } from "../transport/events.generated";

export type SoundKind = "message" | "request" | "ended";

/** How recent an event has to be to be worth a sound. */
export const FRESH_MS = 5000;

const STORAGE_KEY = "agent-studio.sound";

/**
 * Whether this event deserves a chime, given when it is being read.
 *
 * Pure on purpose: the interesting cases are all "no" — a replay, a
 * reconnect's history, an event with an unreadable timestamp — and each is a
 * test rather than something noticed by an unexpected noise.
 */
export function shouldChime(
  event: EventEnvelope,
  now: number,
  replaying: boolean,
): SoundKind | null {
  if (replaying) return null;

  const at = Date.parse(event.ts);
  // A timestamp this build cannot read is not evidence that anything just
  // happened (§8).
  if (Number.isNaN(at) || now - at > FRESH_MS || at - now > FRESH_MS) return null;

  switch (event.draft.type) {
    case "agent.message":
      return "message";
    case "agent.request":
      return "request";
    case "mission.ended":
      return "ended";
    default:
      return null;
  }
}

export function isSoundOn(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    // Private browsing, or storage denied. Silence is the safe default.
    return false;
  }
}

export function setSoundOn(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Not being able to remember the preference is not a reason to fail.
  }
}

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  // Created on first play, which is always downstream of the click that turned
  // sound on — browsers refuse to start one without a gesture.
  context ??= new AudioContext();
  void context.resume();
  return context;
}

/** Frequencies in Hz and length in seconds, per event. Two notes, no melody. */
const VOICES: Record<SoundKind, { notes: number[]; length: number; gain: number }> = {
  message: { notes: [587.33, 880], length: 0.09, gain: 0.05 },
  request: { notes: [523.25, 659.25, 987.77], length: 0.12, gain: 0.08 },
  ended: { notes: [392, 261.63], length: 0.18, gain: 0.06 },
};

export function playChime(kind: SoundKind): void {
  if (!isSoundOn()) return;
  const ctx = audio();
  if (!ctx) return;

  const voice = VOICES[kind];
  voice.notes.forEach((frequency, index) => {
    const start = ctx.currentTime + index * voice.length;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = frequency;
    // A short envelope: a square-edged tone clicks on both ends.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(voice.gain, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + voice.length);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + voice.length + 0.02);
  });
}
