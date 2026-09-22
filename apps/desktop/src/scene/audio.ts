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

export type SoundKind =
  | "message"
  | "request"
  | "ended"
  //: Something left a cat's hands, and something landed in another's.
  | "throw"
  | "land"
  //: A tool went on a desk. Pitched per drawing by `playTool`.
  | "tool";

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
/**
 * Whether something stamped `ts` just happened, as far as this window can
 * tell. Shared by the chime and the thrown things in the scene, which have
 * the identical problem: a reconnect replays the log from seq 0, History
 * replays whole finished missions, and neither is a room full of cats
 * throwing a week's work at each other.
 */
export function justHappened(ts: string, now: number, replaying: boolean): boolean {
  if (replaying) return false;
  const at = Date.parse(ts);
  // A timestamp this build cannot read is not evidence that anything just
  // happened (§8).
  return !(Number.isNaN(at) || now - at > FRESH_MS || at - now > FRESH_MS);
}

export function shouldChime(
  event: EventEnvelope,
  now: number,
  replaying: boolean,
): SoundKind | null {
  if (!justHappened(event.ts, now, replaying)) return null;

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

/**
 * A voice: a few notes in a row, each with a short envelope, on one waveform.
 *
 * Still synthesised, still owned outright — "find some sounds" became
 * "write some", for the same reason the first three were: a sample is a
 * file to ship and license, and a tone is thirty lines. The waveforms are
 * the chiptune ones because the art is pixel art: a sine chime over a
 * pixel cat sounds like a different app.
 */
interface Voice {
  notes: number[];
  length: number;
  gain: number;
  wave: OscillatorType;
  /** Slide each note down (or up) by this many Hz over its length. */
  slide?: number;
}

const VOICES: Record<Exclude<SoundKind, "throw" | "land">, Voice> = {
  message: { notes: [587.33, 880], length: 0.09, gain: 0.05, wave: "sine" },
  request: { notes: [523.25, 659.25, 987.77], length: 0.12, gain: 0.08, wave: "sine" },
  ended: { notes: [392, 261.63], length: 0.18, gain: 0.06, wave: "sine" },
  tool: { notes: [660], length: 0.06, gain: 0.04, wave: "square" },
};

/** The desk tools, each with its own little noise: a ring for the phone,
 *  a clink for the toolbox, a tap for the keys, a scratch for the pencil. */
const TOOL_VOICES: Record<string, Voice> = {
  phone: { notes: [1318.5, 1046.5, 1318.5, 1046.5], length: 0.05, gain: 0.04, wave: "square" },
  toolbox: { notes: [1760, 2637], length: 0.05, gain: 0.03, wave: "triangle", slide: -300 },
  computer: { notes: [880, 1174.7], length: 0.04, gain: 0.03, wave: "square" },
  papers: { notes: [220, 196, 233], length: 0.05, gain: 0.02, wave: "sawtooth" },
  dish: { notes: [1567.98, 2093], length: 0.08, gain: 0.03, wave: "sine", slide: 400 },
  files: { notes: [110, 146.83], length: 0.08, gain: 0.03, wave: "square" },
};

function play(ctx: AudioContext, voice: Voice, at = 0): void {
  voice.notes.forEach((frequency, index) => {
    const start = ctx.currentTime + at + index * voice.length;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = voice.wave;
    osc.frequency.setValueAtTime(frequency, start);
    if (voice.slide) {
      osc.frequency.linearRampToValueAtTime(
        Math.max(40, frequency + voice.slide),
        start + voice.length,
      );
    }
    // A short envelope: a square-edged tone clicks on both ends.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(voice.gain, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + voice.length);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + voice.length + 0.02);
  });
}

/**
 * A puff of noise through a filter that sweeps: up for a throw leaving a
 * hand, down for one landing. No oscillator can whoosh; noise can.
 */
function whoosh(ctx: AudioContext, kind: "throw" | "land"): void {
  const length = kind === "throw" ? 0.18 : 0.09;
  const frames = Math.ceil(ctx.sampleRate * length);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = 1.2;
  const start = ctx.currentTime;
  if (kind === "throw") {
    filter.frequency.setValueAtTime(600, start);
    filter.frequency.exponentialRampToValueAtTime(3200, start + length);
  } else {
    filter.frequency.setValueAtTime(1800, start);
    filter.frequency.exponentialRampToValueAtTime(300, start + length);
  }
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(kind === "throw" ? 0.05 : 0.08, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start(start);
  source.stop(start + length + 0.02);
}

export function playChime(kind: SoundKind): void {
  if (!isSoundOn()) return;
  const ctx = audio();
  if (!ctx) return;
  if (kind === "throw" || kind === "land") whoosh(ctx, kind);
  else play(ctx, VOICES[kind]);
}

/** The noise a tool makes going on the desk — its own, or the plain blip
 *  for a drawing this table has no voice for. */
export function playTool(prop: string): void {
  if (!isSoundOn()) return;
  const ctx = audio();
  if (!ctx) return;
  play(ctx, TOOL_VOICES[prop] ?? VOICES.tool);
}
