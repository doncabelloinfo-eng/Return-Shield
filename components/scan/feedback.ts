'use client';

/**
 * The beep and the buzz.
 *
 * In a warehouse this is the whole interface. Nobody is looking at the screen —
 * the phone is in one hand and a parcel in the other — so a scan is a short
 * high beep and a short buzz, and a parcel already in the batch is TWO of each.
 * Two beeps rather than a different note on purpose: a warehouse is loud, and
 * counting beeps survives noise that pitch does not.
 *
 * ONE AUDIO CONTEXT, UNLOCKED ON THE FIRST TOUCH. iPhone Safari creates every
 * context suspended and only a real gesture may resume it, so a context made
 * per beep — which is what the operator's component does, and which works fine
 * on Android — is silent on an iPhone for ever. The scanning screen calls
 * `unlockAudio` on its first pointer event, and after that the beeps work.
 *
 * Every call is wrapped. Sound is a nicety; the scan is already saved by the
 * time any of this runs.
 */

type Ctor = typeof AudioContext;

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const Ctx: Ctor | undefined = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
    return ctx;
  } catch {
    return null;
  }
}

/** Call inside a real gesture — a tap — or an iPhone stays silent. */
export function unlockAudio(): void {
  const c = context();
  if (c && c.state === 'suspended') void c.resume().catch(() => {});
}

function tone(at: number, ms = 120, hz = 1200): void {
  const c = context();
  if (!c) return;
  try {
    if (c.state === 'suspended') void c.resume().catch(() => {});
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.frequency.value = hz;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(c.destination);
    const start = c.currentTime + at / 1000;
    osc.start(start);
    osc.stop(start + ms / 1000);
  } catch {
    /* sound is optional */
  }
}

function buzz(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* so is vibration */
  }
}

/** Saved. One beep, one buzz. */
export function beepSaved(): void {
  tone(0);
  buzz(120);
}

/** Already in this batch. Two of each, which is audible across a warehouse. */
export function beepDuplicate(): void {
  tone(0, 90, 980);
  tone(150, 90, 980);
  buzz([90, 70, 90]);
}
