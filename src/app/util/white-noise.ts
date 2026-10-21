import {
  ensureAudioContextRunning,
  holdAudioContext,
  releaseAudioContext,
  setAudioContextKeepAwake,
} from './audio-context';

// Hold owner: keeps the idle suspend away from the shared context while the loop plays.
const WHITE_NOISE_HOLD = {};

let activeSource: AudioBufferSourceNode | null = null;
let activeGain: GainNode | null = null;
let cachedBuffer: AudioBuffer | null = null;
// Bumped by every start and stop: a start whose await outlives a newer start or a
// stop must not create its source, or it would loop with nothing left to stop it.
let startToken = 0;
let activeVolume = 0;

const getOrCreateWhiteNoiseBuffer = (ctx: AudioContext): AudioBuffer => {
  if (cachedBuffer) {
    return cachedBuffer;
  }
  const sampleRate = ctx.sampleRate;
  const length = sampleRate * 2; // 2-second loop
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    // eslint-disable-next-line no-mixed-operators
    data[i] = Math.random() * 2 - 1;
  }
  cachedBuffer = buffer;
  return buffer;
};

export const startWhiteNoise = async (volume: number): Promise<void> => {
  const myToken = ++startToken;
  activeVolume = volume;
  holdAudioContext(WHITE_NOISE_HOLD);
  let ctx: AudioContext;
  try {
    ctx = await ensureAudioContextRunning();
  } catch (e) {
    if (myToken === startToken) {
      releaseAudioContext(WHITE_NOISE_HOLD);
    }
    throw e;
  }
  if (myToken !== startToken) {
    return;
  }
  const buffer = getOrCreateWhiteNoiseBuffer(ctx);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;

  const gain = ctx.createGain();
  // activeVolume, not volume: setWhiteNoiseVolume() may run while awaiting the context
  gain.gain.value = activeVolume / 100;
  source.connect(gain);
  gain.connect(ctx.destination);

  source.start(0);
  activeSource = source;
  activeGain = gain;
  // Keep the context running while backgrounded so the focus sound keeps playing.
  setAudioContextKeepAwake(true);
};

/** Changes the volume of the running loop without restarting it. */
export const setWhiteNoiseVolume = (volume: number): void => {
  activeVolume = volume;
  if (activeGain) {
    activeGain.gain.value = volume / 100;
  }
};

export const stopWhiteNoise = (): void => {
  startToken++;
  setAudioContextKeepAwake(false);
  releaseAudioContext(WHITE_NOISE_HOLD);
  if (activeSource) {
    try {
      activeSource.stop();
    } catch (_) {
      // source may already be stopped
    }
    activeSource.disconnect();
    activeSource = null;
  }
  if (activeGain) {
    activeGain.disconnect();
    activeGain = null;
  }
  // NOTE: intentionally does NOT suspend the AudioContext here. stopWhiteNoise()
  // runs (via the whiteNoiseSound$ selector effect) right as a session completes,
  // racing the session-done chime (playSound) on the shared context — suspending
  // would cut the chime off. Releasing the hold instead lets the idle suspend in
  // audio-context.ts run once no other sound (e.g. the chime) holds the context.
};
