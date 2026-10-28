import { setWhiteNoiseVolume, startWhiteNoise, stopWhiteNoise } from './white-noise';
import { closeAudioContext, IDLE_SUSPEND_DELAY_MS } from './audio-context';

describe('white-noise', () => {
  let originalAudioContext: typeof AudioContext;
  let mockContext: any;
  let mockGainNode: any;

  beforeEach(() => {
    originalAudioContext = (window as any).AudioContext;

    mockGainNode = {
      connect: jasmine.createSpy('connect'),
      disconnect: jasmine.createSpy('disconnect'),
      gain: { value: 1 },
    };
    mockContext = {
      state: 'running',
      sampleRate: 8,
      resume: jasmine.createSpy('resume').and.returnValue(Promise.resolve()),
      close: jasmine.createSpy('close'),
      createBuffer: jasmine.createSpy('createBuffer').and.callFake(() => ({
        getChannelData: () => new Float32Array(16),
      })),
      createBufferSource: jasmine.createSpy('createBufferSource').and.callFake(() => ({
        connect: jasmine.createSpy('connect'),
        disconnect: jasmine.createSpy('disconnect'),
        start: jasmine.createSpy('start'),
        stop: jasmine.createSpy('stop'),
        buffer: null,
        loop: false,
      })),
      createGain: jasmine.createSpy('createGain').and.returnValue(mockGainNode),
      destination: {} as AudioDestinationNode,
    };
    (window as any).AudioContext = jasmine
      .createSpy('AudioContext')
      .and.returnValue(mockContext);

    // Reset module-level audio-context state.
    closeAudioContext();
  });

  afterEach(() => {
    stopWhiteNoise();
    // Also cancels the idle-suspend timer the stop scheduled.
    closeAudioContext();
    (window as any).AudioContext = originalAudioContext;
  });

  it('updates the gain of the running loop', async () => {
    await startWhiteNoise(40);
    expect(mockGainNode.gain.value).toBeCloseTo(0.4);

    setWhiteNoiseVolume(10);

    expect(mockGainNode.gain.value).toBeCloseTo(0.1);
  });

  it('keeps the shared context running while playing and lets it idle-suspend after stop', async () => {
    mockContext.suspend = jasmine.createSpy('suspend').and.returnValue(Promise.resolve());
    jasmine.clock().install();
    try {
      await startWhiteNoise(40);
      jasmine.clock().tick(IDLE_SUSPEND_DELAY_MS * 10);
      expect(mockContext.suspend).not.toHaveBeenCalled();

      stopWhiteNoise();
      jasmine.clock().tick(IDLE_SUSPEND_DELAY_MS);

      expect(mockContext.suspend).toHaveBeenCalled();
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('starts a single loop when stopped and restarted while the context resumes', async () => {
    let resolveResume!: () => void;
    mockContext.state = 'suspended';
    mockContext.resume.and.returnValue(
      new Promise<void>((resolve) => (resolveResume = resolve)),
    );

    const first = startWhiteNoise(40);
    stopWhiteNoise();
    const second = startWhiteNoise(40);
    resolveResume();
    await Promise.all([first, second]);

    expect(mockContext.createBufferSource).toHaveBeenCalledTimes(1);
  });

  it('releases the shared context when the start fails', async () => {
    mockContext.state = 'suspended';
    mockContext.resume.and.returnValue(Promise.reject(new Error('NotAllowedError')));
    mockContext.suspend = jasmine.createSpy('suspend').and.returnValue(Promise.resolve());
    jasmine.clock().install();
    try {
      await expectAsync(startWhiteNoise(40)).toBeRejectedWithError('NotAllowedError');
      // a later sound resumes the context; the failed start must not keep it awake
      mockContext.state = 'running';
      jasmine.clock().tick(IDLE_SUSPEND_DELAY_MS);

      expect(mockContext.suspend).toHaveBeenCalled();
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('keeps a volume set while the context is still resuming', async () => {
    let resolveResume!: () => void;
    mockContext.state = 'suspended';
    mockContext.resume.and.returnValue(
      new Promise<void>((resolve) => (resolveResume = resolve)),
    );

    const started = startWhiteNoise(40);
    setWhiteNoiseVolume(10);
    resolveResume();
    await started;

    expect(mockContext.createGain).toHaveBeenCalled();
    expect(mockGainNode.gain.value).toBeCloseTo(0.1);
  });
});
