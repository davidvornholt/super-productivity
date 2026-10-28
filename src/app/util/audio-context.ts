/**
 * Singleton AudioContext manager to avoid creating multiple AudioContext instances.
 * This prevents memory leaks and browser resource exhaustion when playing sounds frequently.
 */

let audioContext: AudioContext | null = null;
const audioBufferCache = new Map<string, AudioBuffer>();
let unlocked = false;
// Whether something still needs the context running while the app is backgrounded
// (e.g. focus-mode white noise). While set, suspendAudioContext() is a no-op so
// the ongoing sound is not cut off. See setAudioContextKeepAwake().
let keepAwake = false;

/**
 * How long the context stays running after the last sound ends. A running
 * AudioContext keeps rendering silence (~70-90 wakeups/s on Chromium, measured
 * 2026-10 on Linux/Electron) until it is suspended, so it is released shortly
 * after the last sound instead of at first use for the rest of the session.
 * Long enough that a quick burst of sounds (e.g. several tasks marked done)
 * reuses the running context.
 */
export const IDLE_SUSPEND_DELAY_MS = 5000;
// Owners of sounds that are currently playing (see holdAudioContext()).
const activeSounds = new Set<object>();
let idleSuspendTimer: ReturnType<typeof setTimeout> | null = null;
// suspend() flips `state` only once its promise settles; ensureAudioContextRunning()
// awaits this so a resume is not lost to a suspend that is still in flight.
let pendingSuspend: Promise<void> | null = null;

const suspendNow = (): void => {
  if (!audioContext || audioContext.state !== 'running') {
    return;
  }
  // Swallow errors — the context may already be closing.
  const suspending = audioContext.suspend().catch(() => {});
  pendingSuspend = suspending;
  void suspending.then(() => {
    if (pendingSuspend === suspending) {
      pendingSuspend = null;
    }
  });
};

const cancelIdleSuspend = (): void => {
  if (idleSuspendTimer !== null) {
    clearTimeout(idleSuspendTimer);
    idleSuspendTimer = null;
  }
};

// (Re)starts the idle countdown; holdAudioContext() cancels it.
const scheduleIdleSuspend = (): void => {
  cancelIdleSuspend();
  if (activeSounds.size > 0) {
    return;
  }
  idleSuspendTimer = setTimeout(() => {
    idleSuspendTimer = null;
    suspendNow();
  }, IDLE_SUSPEND_DELAY_MS);
};

/**
 * Returns the singleton AudioContext instance, creating it if necessary.
 */
export const getAudioContext = (): AudioContext => {
  if (!audioContext) {
    audioContext = new (
      (window as any).AudioContext || (window as any).webkitAudioContext
    )();
    // Where autoplay is allowed (Electron) a new context starts running.
    scheduleIdleSuspend();
  }

  return audioContext!;
};

/**
 * Returns the singleton AudioContext after ensuring it is in the "running" state.
 * Awaits resume() if the context is suspended (e.g., iOS after backgrounding).
 */
export const ensureAudioContextRunning = async (): Promise<AudioContext> => {
  const ctx = getAudioContext();
  if (pendingSuspend) {
    await pendingSuspend;
  }
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }
  return ctx;
};

/**
 * Retrieves a cached audio buffer or fetches and decodes it if not cached.
 * @param filePath - Path to the audio file
 * @returns Promise resolving to the decoded AudioBuffer
 */
export const getAudioBuffer = async (filePath: string): Promise<AudioBuffer> => {
  const cached = audioBufferCache.get(filePath);
  if (cached) {
    return cached;
  }

  const ctx = getAudioContext();
  const response = await fetch(filePath);
  // Capacitor's iOS asset scheme can return a readable response with status 0.
  // Network failures still reject fetch(), and decodeAudioData validates the body.
  if (!response.ok && response.status !== 0) {
    throw new Error(`Failed to fetch audio file ${filePath}: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

  audioBufferCache.set(filePath, audioBuffer);
  return audioBuffer;
};

/**
 * Marks a sound as playing so the idle suspend leaves the context running until
 * releaseAudioContext() is called with the same owner. Call it before awaiting
 * ensureAudioContextRunning() so the context cannot be suspended in between.
 */
export const holdAudioContext = (owner: object): void => {
  activeSounds.add(owner);
  cancelIdleSuspend();
};

/**
 * Ends a holdAudioContext() hold. Once no sound holds the context it is
 * suspended after IDLE_SUSPEND_DELAY_MS. Releasing an owner that holds nothing
 * is a no-op, so teardown paths can call it unconditionally.
 */
export const releaseAudioContext = (owner: object): void => {
  if (activeSounds.delete(owner)) {
    scheduleIdleSuspend();
  }
};

/**
 * Plays a decoded audio buffer at the given volume with optional source configuration.
 * Handles gain routing and node cleanup after playback.
 *
 * @param buffer - Decoded AudioBuffer to play
 * @param volume - Volume level from 0 to 100 (default: 100)
 * @param configureSource - Optional callback to configure the source node (e.g., detune, playbackRate)
 */
export const playBuffer = async (
  buffer: AudioBuffer,
  volume: number = 100,
  configureSource?: (source: AudioBufferSourceNode) => void,
): Promise<void> => {
  const hold = {};
  holdAudioContext(hold);
  try {
    const audioCtx = await ensureAudioContextRunning();
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    configureSource?.(source);

    let gainNode: GainNode | null = null;
    if (volume !== 100) {
      gainNode = audioCtx.createGain();
      gainNode.gain.value = volume / 100;
      source.connect(gainNode);
      gainNode.connect(audioCtx.destination);
    } else {
      source.connect(audioCtx.destination);
    }

    source.onended = (): void => {
      source.disconnect();
      if (gainNode) {
        gainNode.disconnect();
      }
      releaseAudioContext(hold);
    };

    source.start(0);
  } catch (e) {
    releaseAudioContext(hold);
    throw e;
  }
};

/**
 * Marks (or clears) a need to keep the AudioContext running even while the app is
 * backgrounded. Used by long-lived background audio such as the focus-mode white
 * noise so that suspendAudioContext() does not cut it off mid-playback.
 *
 * Single-owner: white noise is currently the only caller. If a second long-lived
 * background sound is ever added, replace this boolean with a reference count so
 * one source clearing the flag cannot release another's.
 */
export const setAudioContextKeepAwake = (keep: boolean): void => {
  keepAwake = keep;
};

/**
 * Suspends the singleton AudioContext to release the underlying audio output
 * stream. On Android a `running` AudioContext keeps an AudioTrack open in the
 * audio HAL even while completely silent — which drains the battery around the
 * clock and keeps the process alive in the background (issue #8243). Suspending
 * releases that stream; the next playback resumes it via ensureAudioContextRunning().
 *
 * No-op when the context was never created, is already suspended, or something
 * still needs it running (see setAudioContextKeepAwake).
 */
export const suspendAudioContext = (): void => {
  if (!keepAwake) {
    // suspend() returns a promise; the release begins immediately so we don't
    // await it.
    suspendNow();
  }
};

/**
 * Registers one-time touchend/click listeners that create and resume the AudioContext
 * on the first user gesture. This is required on iOS where AudioContext can only be
 * unlocked from within a user gesture event handler.
 */
export const unlockAudioContext = (): void => {
  if (unlocked) {
    return;
  }
  unlocked = true;

  const ac = new AbortController();
  const onGesture = (): void => {
    ac.abort();
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') {
      // Fire-and-forget — ensureAudioContextRunning() retries before actual playback.
      // Resuming inside the gesture is what unlocks the context (iOS); once
      // unlocked it may be suspended and resumed again without one.
      ctx
        .resume()
        .then(scheduleIdleSuspend)
        .catch(() => {});
    }
  };

  const opts = { once: true, signal: ac.signal };
  document.addEventListener('touchend', onGesture, opts);
  document.addEventListener('click', onGesture, opts);
};

/**
 * Clears the audio buffer cache. Useful for testing or memory management.
 */
export const clearAudioBufferCache = (): void => {
  audioBufferCache.clear();
};

/**
 * Closes the AudioContext and clears all caches.
 * Should only be called when audio is no longer needed (e.g., app shutdown).
 */
export const closeAudioContext = (): void => {
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  audioBufferCache.clear();
  unlocked = false;
  keepAwake = false;
  activeSounds.clear();
  cancelIdleSuspend();
  pendingSuspend = null;
};
