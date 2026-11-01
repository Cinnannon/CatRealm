import { createWindowsAppAudioStream } from './appAudioCapture';
import { logVoiceDebug, logVoiceDebugAwaitable } from './voiceDebugConsole';

export type DesktopSource = {
  id: string;
  name: string;
  thumbnail: string | null;
  appIcon: string | null;
};

export type ScreenShareAudioMode = 'app' | 'system' | 'none';

export type ScreenShareAudioStatus = {
  mode: ScreenShareAudioMode;
  label: 'App audio' | 'System audio' | 'No audio';
  requested: boolean;
  available: boolean;
  reason?: string;
};

export type DesktopAudioCaptureSupport = {
  platform: NodeJS.Platform | 'browser' | 'unknown';
  appAudio: {
    available: boolean;
    reason?: string;
  };
  systemAudio: {
    available: boolean;
    reason?: string;
  };
};

export type VideoCaptureDeviceInfo = {
  deviceId: string;
  kind: 'videoinput';
  label: string;
  groupId: string;
  devicePath?: string | null;
  nativeOnly?: boolean;
};

export type CaptureScreenShareOptions =
  | {
      kind: 'device';
      deviceId: string;
      audioDeviceId?: string;
      width: number;
      height: number;
      frameRate: number;
      includeAudio: boolean;
    }
  | {
      kind: 'desktop';
      sourceId?: string;
      width: number;
      height: number;
      frameRate: number;
      includeAudio: boolean;
    }
  | {
      kind: 'browser';
      width: number;
      height: number;
      frameRate: number;
      includeAudio: boolean;
    };

let nativeVideoDevicesCache: { checkedAt: number; devices: NativeVideoCaptureDevice[] } | null = null;
let nativeVideoDevicesPromise: Promise<NativeVideoCaptureDevice[]> | null = null;
const NATIVE_VIDEO_DEVICES_CACHE_MS = 30_000;
const NATIVE_VIDEO_DEVICES_TIMEOUT_MS = 2_500;

export type CaptureScreenShareResult = {
  stream: MediaStream;
  audioStatus: ScreenShareAudioStatus;
};

const screenShareAudioStatusByStream = new WeakMap<MediaStream, ScreenShareAudioStatus>();

type CatRealmScreenShareTrack = MediaStreamTrack & {
  catrealmScreenShareSourceKind?: CaptureScreenShareOptions['kind'];
  catrealmScreenShareTargetFps?: number;
  catrealmScreenShareDesktopSourceType?: 'screen' | 'window';
  catrealmScreenShareDesktopSourceId?: string;
  catrealmNativeCapture?: true;
};

export const NO_SCREEN_SHARE_AUDIO_STATUS: ScreenShareAudioStatus = {
  mode: 'none',
  label: 'No audio',
  requested: false,
  available: false,
};

function buildAudioStatus(mode: ScreenShareAudioMode, requested: boolean, reason?: string): ScreenShareAudioStatus {
  if (mode === 'app') return { mode, label: 'App audio', requested, available: true, reason };
  if (mode === 'system') return { mode, label: 'System audio', requested, available: true, reason };
  return { mode, label: 'No audio', requested, available: false, reason };
}

function rememberScreenShareAudioStatus(stream: MediaStream, status: ScreenShareAudioStatus) {
  screenShareAudioStatusByStream.set(stream, status);
  stream.getTracks().forEach((track) => {
    try {
      (track as MediaStreamTrack & { catrealmScreenShareAudioStatus?: ScreenShareAudioStatus }).catrealmScreenShareAudioStatus = status;
    } catch {
      // Some browser track wrappers can be non-extensible.
    }
  });
}

function rememberScreenShareCaptureMetadata(
  stream: MediaStream,
  sourceKind: CaptureScreenShareOptions['kind'],
  targetFps: number,
  desktopMetadata?: { sourceType: 'screen' | 'window'; sourceId: string },
  nativeCapture?: boolean,
) {
  stream.getVideoTracks().forEach((track) => {
    try {
      const taggedTrack = track as CatRealmScreenShareTrack & { catrealmStopMonkeyPatched?: boolean };
      taggedTrack.catrealmScreenShareSourceKind = sourceKind;
      taggedTrack.catrealmScreenShareTargetFps = targetFps;
      taggedTrack.catrealmScreenShareDesktopSourceType = desktopMetadata?.sourceType;
      taggedTrack.catrealmScreenShareDesktopSourceId = desktopMetadata?.sourceId;
      if (nativeCapture) taggedTrack.catrealmNativeCapture = true;

      if (!taggedTrack.catrealmStopMonkeyPatched) {
        taggedTrack.catrealmStopMonkeyPatched = true;
        const originalStop = track.stop.bind(track);
        track.stop = () => {
          if ((track as any).catrealmStopping) return;
          (track as any).catrealmStopping = true;
          try {
            originalStop();
          } finally {
            track.dispatchEvent(new Event('ended'));
          }
        };
      }
    } catch {
      // Some browser track wrappers can be non-extensible.
    }
  });
}

export function getScreenShareAudioStatus(stream: MediaStream | null | undefined): ScreenShareAudioStatus {
  if (!stream) return NO_SCREEN_SHARE_AUDIO_STATUS;
  const cached = screenShareAudioStatusByStream.get(stream);
  if (cached) return cached;
  const fromTrack = stream.getTracks()
    .map((track) => (track as MediaStreamTrack & { catrealmScreenShareAudioStatus?: ScreenShareAudioStatus }).catrealmScreenShareAudioStatus)
    .find(Boolean);
  if (fromTrack) return fromTrack;
  return stream.getAudioTracks().length > 0
    ? buildAudioStatus('system', true)
    : buildAudioStatus('none', false);
}

function isConstraintFallbackError(error: unknown) {
  const name = (error as { name?: string } | null)?.name;
  return name === 'OverconstrainedError'
    || name === 'ConstraintNotSatisfiedError'
    || name === 'NotFoundError';
}

type BrowserDisplayOptions = { width?: number; height?: number; frameRate: number; includeAudio: boolean };

// Some browsers (notably Firefox and Safari) reject size/frame-rate limits
// they cannot meet for the picked surface. Retry unconstrained, then apply
// the limits as a best effort so the share still starts.
export async function getBrowserDisplayMedia(options: BrowserDisplayOptions): Promise<MediaStream> {
  const audio = options.includeAudio ? screenShareAudioConstraints() : false;
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: options.frameRate },
        width: { ideal: options.width, max: options.width },
        height: { ideal: options.height, max: options.height },
      },
      audio,
    } as MediaStreamConstraints);
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name !== 'OverconstrainedError' && name !== 'ConstraintNotSatisfiedError' && name !== 'TypeError') throw error;
    logVoiceDebug('livekit', 'screen share constraints rejected; retrying unconstrained', {
      name: (error as { name?: string }).name ?? null,
      constraint: (error as { constraint?: string }).constraint ?? null,
    }, 'warn');
  }
  stream ??= await navigator.mediaDevices.getDisplayMedia({ video: true, audio: options.includeAudio } as MediaStreamConstraints);
  const [track] = stream.getVideoTracks();
  if (track) {
    void applyScreenCaptureConstraints(track, {
      frameRate: { ideal: options.frameRate, max: options.frameRate },
      width: { ideal: options.width, max: options.width },
      height: { ideal: options.height, max: options.height },
    }, options.frameRate);
  }
  return stream;
}

// Chromium's screen capture only emits a frame when the screen changes, so a
// mostly still screen sent ~20 fps (moving the mouse brought it back to 60).
// A minimum frame rate makes it repeat the last frame to hold the rate, as the
// desktop apps' minFrameRate does; getDisplayMedia() itself rejects `min`, so it
// is applied afterwards. If a browser refuses `min`, keep the rest without it.
export async function applyScreenCaptureConstraints(
  track: MediaStreamTrack,
  constraints: MediaTrackConstraints,
  minFrameRate: number,
): Promise<void> {
  const frameRate = typeof constraints.frameRate === 'object' ? constraints.frameRate : {};
  try {
    await track.applyConstraints({ ...constraints, frameRate: { ...frameRate, min: minFrameRate } });
  } catch {
    await track.applyConstraints(constraints).catch(() => {});
  }
}

function deviceVideoConstraints(
  options: Extract<CaptureScreenShareOptions, { kind: 'device' }>,
  strictFrameRate: boolean,
  exactDimensions = false,
): MediaTrackConstraints {
  const frameRate = strictFrameRate && options.frameRate >= 48
    ? {
        min: Math.max(1, options.frameRate - 1),
        ideal: options.frameRate,
        max: options.frameRate,
      }
    : {
        ideal: options.frameRate,
        max: options.frameRate,
      };

  const constraints: MediaTrackConstraints & { resizeMode?: { exact: string } } = {
    deviceId: { exact: options.deviceId },
    // Keep device dimensions ideal-only. Capture cards often expose 60fps only
    // on native modes; max caps can force Chromium onto a lower-fps 1440p mode.
    width: exactDimensions ? { exact: options.width } : { ideal: options.width },
    height: exactDimensions ? { exact: options.height } : { ideal: options.height },
    frameRate,
  };

  if (exactDimensions) constraints.resizeMode = { exact: 'none' };
  return constraints;
}

function compactTrackCapabilities(track: MediaStreamTrack) {
  if (typeof track.getCapabilities !== 'function') return null;
  const capabilities = track.getCapabilities() as MediaTrackCapabilities & { resizeMode?: string[] };
  return {
    width: capabilities.width ?? null,
    height: capabilities.height ?? null,
    frameRate: capabilities.frameRate ?? null,
    resizeMode: capabilities.resizeMode ?? null,
  };
}

function logDeviceCaptureNegotiated(
  options: Extract<CaptureScreenShareOptions, { kind: 'device' }>,
  stream: MediaStream,
  strictFrameRate: boolean,
  targetFrameRate = options.frameRate,
) {
  const track = stream.getVideoTracks()[0] ?? null;
  const trackSettings = track?.getSettings() ?? null;
  logVoiceDebug('livekit', 'screen share capture device negotiated', {
    requested: {
      width: options.width,
      height: options.height,
      captureConstraintFrameRate: options.frameRate,
      targetFrameRate,
      strictFrameRate,
    },
    constraintsSent: deviceVideoConstraints(options, strictFrameRate),
    trackSettings,
    trackConstraints: track?.getConstraints() ?? null,
    trackCapabilities: track ? compactTrackCapabilities(track) : null,
    diagnosis: trackSettings?.frameRate && trackSettings.frameRate < targetFrameRate
      ? 'Browser selected a lower-FPS device mode before LiveKit publishing.'
      : undefined,
  });
}

type DeviceCaptureAttempt = {
  label: string;
  options: Extract<CaptureScreenShareOptions, { kind: 'device' }>;
  strictFrameRate: boolean;
  exactDimensions: boolean;
  expectedHalfRateBug?: boolean;
};

type DeviceCaptureProbe = {
  callbackFrames: number;
  callbackFps: number | null;
  decodedFramesDelta: number | null;
  decodedFps: number | null;
  videoReadyState: number | null;
  videoSize: string | null;
};

const DEVICE_CAPTURE_FPS_VALIDATION_MS = 1200;
const DEVICE_CAPTURE_FPS_PASS_RATIO = 0.8;

function stopMediaStream(stream: MediaStream) {
  stream.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      // ignore already-stopped tracks
    }
  });
}

async function measureDeviceCaptureFps(stream: MediaStream, durationMs = DEVICE_CAPTURE_FPS_VALIDATION_MS): Promise<DeviceCaptureProbe | null> {
  if (typeof document === 'undefined' || !document.body) return null;
  const track = stream.getVideoTracks()[0];
  if (!track || track.readyState !== 'live') return null;

  const video = document.createElement('video');
  const videoWithCallbacks = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
    webkitDecodedFrameCount?: number;
  };

  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  video.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(video);

  let callbackFrames = 0;
  let callbackHandle: number | null = null;
  let stopped = false;
  const startDecodedFrames = videoWithCallbacks.webkitDecodedFrameCount ?? null;
  const startedAt = performance.now();

  const scheduleFrameCallback = () => {
    if (stopped || !videoWithCallbacks.requestVideoFrameCallback || track.readyState !== 'live') return;
    callbackHandle = videoWithCallbacks.requestVideoFrameCallback(() => {
      callbackFrames += 1;
      scheduleFrameCallback();
    });
  };

  try {
    await video.play();
    scheduleFrameCallback();
    await new Promise((resolve) => window.setTimeout(resolve, durationMs));
    const elapsedSeconds = Math.max(0.001, (performance.now() - startedAt) / 1000);
    const endDecodedFrames = videoWithCallbacks.webkitDecodedFrameCount ?? null;
    const decodedFramesDelta = typeof endDecodedFrames === 'number' && typeof startDecodedFrames === 'number'
      ? Math.max(0, endDecodedFrames - startDecodedFrames)
      : null;
    return {
      callbackFrames,
      callbackFps: Math.round((callbackFrames / elapsedSeconds) * 10) / 10,
      decodedFramesDelta,
      decodedFps: decodedFramesDelta !== null
        ? Math.round((decodedFramesDelta / elapsedSeconds) * 10) / 10
        : null,
      videoReadyState: video.readyState,
      videoSize: video.videoWidth && video.videoHeight ? `${video.videoWidth}x${video.videoHeight}` : null,
    };
  } catch (error) {
    logVoiceDebug('livekit', 'screen share device fps validation probe failed', {
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    }, 'warn');
    return null;
  } finally {
    stopped = true;
    if (callbackHandle !== null) {
      videoWithCallbacks.cancelVideoFrameCallback?.(callbackHandle);
    }
    video.pause();
    video.srcObject = null;
    video.remove();
  }
}

async function getUserMediaForDeviceAttempt(
  attempt: DeviceCaptureAttempt,
  audioConstraint: MediaTrackConstraints | false,
) {
  return navigator.mediaDevices.getUserMedia({
    video: deviceVideoConstraints(attempt.options, attempt.strictFrameRate, attempt.exactDimensions),
    audio: audioConstraint,
  });
}

function compactDeviceCaptureAttempt(attempt: DeviceCaptureAttempt) {
  return {
    label: attempt.label,
    width: attempt.options.width,
    height: attempt.options.height,
    captureConstraintFrameRate: attempt.options.frameRate,
    strictFrameRate: attempt.strictFrameRate,
    exactDimensions: attempt.exactDimensions,
    expectedHalfRateBug: attempt.expectedHalfRateBug === true,
  };
}

function buildDeviceFpsValidationAttempts(
  options: Extract<CaptureScreenShareOptions, { kind: 'device' }>,
  strictFrameRate: boolean,
  maxDeviceFrameRate: number | null,
): DeviceCaptureAttempt[] {
  const attempts: DeviceCaptureAttempt[] = [
    { label: 'initial', options, strictFrameRate, exactDimensions: false },
  ];

  if (options.frameRate < 48) return attempts;

  const targetFrameRate = options.frameRate;
  const supportsDoubleRate = typeof maxDeviceFrameRate === 'number'
    && maxDeviceFrameRate >= (targetFrameRate * 2) - 1;
  const doubleFrameRate = supportsDoubleRate
    ? Math.max(targetFrameRate + 1, Math.round(Math.min(maxDeviceFrameRate, targetFrameRate * 2)))
    : null;
  const candidateModes = [
    { label: 'exact-requested', width: options.width, height: options.height },
    { label: 'fallback-1080p', width: 1920, height: 1080 },
    { label: 'fallback-720p', width: 1280, height: 720 },
  ];
  const seen = new Set<string>();
  attempts.forEach((attempt) => {
    seen.add(`${attempt.options.width}x${attempt.options.height}:${attempt.options.frameRate}:${attempt.exactDimensions}`);
  });

  candidateModes.forEach((mode) => {
    if (mode.width > options.width || mode.height > options.height) return;
    const modeAttempts: DeviceCaptureAttempt[] = [
      {
        label: mode.label,
        options: { ...options, width: mode.width, height: mode.height },
        strictFrameRate: true,
        exactDimensions: true,
      },
    ];
    if (doubleFrameRate !== null) {
      modeAttempts.push({
        label: mode.label === 'exact-requested'
          ? 'chromium-half-rate-requested'
          : `chromium-half-rate-${mode.label.replace(/^fallback-/, '')}`,
        options: { ...options, width: mode.width, height: mode.height, frameRate: doubleFrameRate },
        strictFrameRate: true,
        exactDimensions: true,
        expectedHalfRateBug: true,
      });
    }
    modeAttempts.forEach((attempt) => {
      const key = `${attempt.options.width}x${attempt.options.height}:${attempt.options.frameRate}:${attempt.exactDimensions}`;
      if (seen.has(key)) return;
      seen.add(key);
      attempts.push(attempt);
    });
  });

  return attempts;
}

function isDeviceCaptureProbePassing(probe: DeviceCaptureProbe | null, targetFps: number) {
  const fps = probe?.callbackFps ?? probe?.decodedFps ?? null;
  return fps !== null && fps >= targetFps * DEVICE_CAPTURE_FPS_PASS_RATIO;
}

function deviceCaptureProbeScore(probe: DeviceCaptureProbe | null, attempt: DeviceCaptureAttempt) {
  const fps = probe?.callbackFps ?? probe?.decodedFps ?? 0;
  return (fps * 10_000) + attempt.options.height;
}

function getTrackFrameRateCapabilityMax(track: MediaStreamTrack | null) {
  if (!track || typeof track.getCapabilities !== 'function') return null;
  try {
    const capabilities = track.getCapabilities() as MediaTrackCapabilities;
    const frameRate = capabilities.frameRate as { max?: number } | undefined;
    return typeof frameRate?.max === 'number' ? frameRate.max : null;
  } catch {
    return null;
  }
}

async function validateDeviceCaptureFps(
  initialStream: MediaStream,
  initialStrictFrameRate: boolean,
  options: Extract<CaptureScreenShareOptions, { kind: 'device' }>,
  audioConstraint: MediaTrackConstraints | false,
) {
  if (options.frameRate < 48) {
    return { stream: initialStream, options, strictFrameRate: initialStrictFrameRate };
  }

  const initialTrack = initialStream.getVideoTracks()[0] ?? null;
  const maxDeviceFrameRate = getTrackFrameRateCapabilityMax(initialTrack);
  const attempts = buildDeviceFpsValidationAttempts(options, initialStrictFrameRate, maxDeviceFrameRate);
  let bestAttempt: DeviceCaptureAttempt = attempts[0];
  let bestProbe: DeviceCaptureProbe | null = null;
  let bestScore = -1;

  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index];
    let stream: MediaStream | null = null;
    try {
      stream = index === 0 ? initialStream : await getUserMediaForDeviceAttempt(attempt, audioConstraint);
      const track = stream.getVideoTracks()[0] ?? null;
      const probe = await measureDeviceCaptureFps(stream);
      const score = deviceCaptureProbeScore(probe, attempt);
      if (score > bestScore) {
        bestScore = score;
        bestAttempt = attempt;
        bestProbe = probe;
      }

      logVoiceDebug('livekit', 'screen share device fps validation', {
        attempt: compactDeviceCaptureAttempt(attempt),
        constraints: deviceVideoConstraints(attempt.options, attempt.strictFrameRate, attempt.exactDimensions),
        trackSettings: track?.getSettings() ?? null,
        trackCapabilities: track ? compactTrackCapabilities(track) : null,
        probe,
        targetFps: options.frameRate,
        maxDeviceFrameRate,
        passed: isDeviceCaptureProbePassing(probe, options.frameRate),
      });

      if (options.frameRate < 48 || isDeviceCaptureProbePassing(probe, options.frameRate)) {
        if (index > 0) stopMediaStream(initialStream);
        return { stream, options: attempt.options, strictFrameRate: attempt.strictFrameRate };
      }
    } catch (error) {
      logVoiceDebug('livekit', 'screen share device fps validation attempt failed', {
        attempt: compactDeviceCaptureAttempt(attempt),
        constraints: deviceVideoConstraints(attempt.options, attempt.strictFrameRate, attempt.exactDimensions),
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      }, 'warn');
    }

    if (stream) stopMediaStream(stream);
  }

  logVoiceDebug('livekit', 'screen share device fps validation kept best available mode', {
    requested: {
      width: options.width,
      height: options.height,
      frameRate: options.frameRate,
    },
    selected: compactDeviceCaptureAttempt(bestAttempt),
    bestProbe,
    maxDeviceFrameRate,
    diagnosis: 'Chromium accepted the requested constraints but did not deliver target FPS from this device.',
  }, 'warn');

  const stream = await getUserMediaForDeviceAttempt(bestAttempt, audioConstraint);
  return { stream, options: bestAttempt.options, strictFrameRate: bestAttempt.strictFrameRate };
}

function screenShareAudioConstraints(deviceId?: string): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    channelCount: { ideal: 2 },
    sampleRate: { ideal: 48000 },
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
}

export async function getDesktopSources(opts?: { includeWindowThumbnails?: boolean }): Promise<DesktopSource[]> {
  if (!window.electron?.getDesktopSources) return [];
  await logVoiceDebugAwaitable('electron', 'desktop-sources: renderer requesting getSources');
  return window.electron.getDesktopSources({
    types: ['screen', 'window'],
    includeWindowThumbnails: opts?.includeWindowThumbnails === true,
  });
}

export function isElectronDesktop() {
  return Boolean(window.electron?.getDesktopSources);
}

export function isTauriDesktop() {
  return typeof window !== 'undefined' && Boolean((window as Window & { __TAURI__?: unknown }).__TAURI__);
}

function supportsElectronDesktopCapture() {
  return isElectronDesktop() && !isTauriDesktop();
}

export async function getDesktopAudioCaptureSupport(): Promise<DesktopAudioCaptureSupport> {
  if (!window.electron?.getDesktopAudioCaptureSupport) {
    return {
      platform: 'browser',
      appAudio: { available: false, reason: 'Native app audio capture is only available in the desktop app.' },
      systemAudio: { available: true },
    };
  }
  return window.electron.getDesktopAudioCaptureSupport();
}

type ElectronDesktopCaptureOptions = {
  sourceId: string;
  width: number;
  height: number;
  frameRate: number;
  includeAudio: boolean;
};

function electronDesktopVideoConstraints({
  sourceId,
  width,
  height,
  frameRate,
}: Omit<ElectronDesktopCaptureOptions, 'includeAudio'>, relaxed = false) {
  return {
    mandatory: relaxed
      ? { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: frameRate }
      : {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxWidth: width,
          maxHeight: height,
          minFrameRate: frameRate,
          maxFrameRate: frameRate,
        },
  };
}

// The frame-rate floor is what makes Chromium capture at the chosen rate, but
// some sources (and Sushi's WebView2) cannot meet it and reject the request
// with OverconstrainedError. Retry once with only the frame-rate ceiling.
async function getDesktopUserMedia(
  audio: MediaTrackConstraints | false,
  capture: Omit<ElectronDesktopCaptureOptions, 'includeAudio'>,
): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio,
      video: electronDesktopVideoConstraints(capture),
    } as MediaStreamConstraints);
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name !== 'OverconstrainedError' && name !== 'ConstraintNotSatisfiedError') throw error;
    logVoiceDebug('livekit', 'desktop capture constraints rejected; retrying without frame-rate floor', {
      name,
      constraint: (error as { constraint?: string }).constraint ?? null,
      sourceId: capture.sourceId,
      frameRate: capture.frameRate,
    }, 'warn');
    return navigator.mediaDevices.getUserMedia({
      audio,
      video: electronDesktopVideoConstraints(capture, true),
    } as MediaStreamConstraints);
  }
}

function electronDesktopAudioConstraints(sourceId?: string) {
  return {
    mandatory: {
      chromeMediaSource: 'desktop',
      ...(sourceId ? { chromeMediaSourceId: sourceId } : {}),
    },
  };
}

async function tryCaptureDesktopAudio(sourceId: string): Promise<MediaStream | null> {
  const attempts = [sourceId, undefined];

  for (const audioSourceId of attempts) {
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({
        audio: electronDesktopAudioConstraints(audioSourceId),
        video: false,
      } as MediaStreamConstraints);
      if (audioStream.getAudioTracks().length > 0) return audioStream;
      audioStream.getTracks().forEach((track) => track.stop());
    } catch {
      // Try the next loopback mode. Some Electron/Chromium builds only support
      // full-desktop audio, while others require a desktop source id.
    }
  }

  return null;
}

export async function getElectronDesktopMediaStream({
  sourceId,
  width,
  height,
  frameRate,
  includeAudio,
}: ElectronDesktopCaptureOptions): Promise<MediaStream> {
  const result = await getElectronDesktopMediaStreamWithStatus({ sourceId, width, height, frameRate, includeAudio });
  return result.stream;
}

export async function getElectronDesktopMediaStreamWithStatus({
  sourceId,
  width,
  height,
  frameRate,
  includeAudio,
}: ElectronDesktopCaptureOptions): Promise<CaptureScreenShareResult> {
  const capture = { sourceId, width, height, frameRate };
  const isApplicationShare = sourceId.startsWith('window:');
  const desktopMetadata = {
    sourceType: isApplicationShare ? 'window' as const : 'screen' as const,
    sourceId,
  };
  await logVoiceDebugAwaitable('livekit', 'screen-share: chromium desktop capture', {
    sourceId,
    sourceType: desktopMetadata.sourceType,
    backend: isApplicationShare ? 'chromium-window-wgc' : 'chromium-monitor-dxgi',
    width,
    height,
    frameRate,
    includeAudio,
  });
  const support = includeAudio && isApplicationShare
    ? await getDesktopAudioCaptureSupport().catch(() => null)
    : null;
  const canCaptureRequestedAudio = includeAudio && (!isApplicationShare || support?.appAudio.available === true);

  if (includeAudio && isApplicationShare && support?.appAudio.available !== true) {
    const videoStream = await getDesktopUserMedia(false, capture);
    const audioStatus = buildAudioStatus('none', true, support?.appAudio.reason ?? 'App audio capture is unavailable for this window.');
    rememberScreenShareAudioStatus(videoStream, audioStatus);
    rememberScreenShareCaptureMetadata(videoStream, 'desktop', frameRate, desktopMetadata, true);
    return { stream: videoStream, audioStatus };
  }

  if (includeAudio && isApplicationShare && support?.appAudio.available === true) {
    const videoStream = await getDesktopUserMedia(false, capture);
    const appAudio = await createWindowsAppAudioStream(sourceId);
    if (!appAudio.ok) {
      const audioStatus = buildAudioStatus('none', true, appAudio.message ?? 'App audio capture failed for this window.');
      rememberScreenShareAudioStatus(videoStream, audioStatus);
      rememberScreenShareCaptureMetadata(videoStream, 'desktop', frameRate, desktopMetadata, true);
      return { stream: videoStream, audioStatus };
    }
    const stream = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...appAudio.stream.getAudioTracks(),
    ]);
    videoStream.getVideoTracks().forEach((track) => {
      track.addEventListener('ended', appAudio.stop, { once: true });
    });
    const audioStatus = buildAudioStatus('app', true);
    rememberScreenShareAudioStatus(stream, audioStatus);
    rememberScreenShareCaptureMetadata(stream, 'desktop', frameRate, desktopMetadata, true);
    return { stream, audioStatus };
  }

  try {
    const combinedStream = await getDesktopUserMedia(canCaptureRequestedAudio ? electronDesktopAudioConstraints(sourceId) as MediaTrackConstraints : false, capture);
    if (!canCaptureRequestedAudio || combinedStream.getAudioTracks().length > 0) {
      const audioStatus = combinedStream.getAudioTracks().length > 0
        ? buildAudioStatus(isApplicationShare ? 'app' : 'system', includeAudio)
        : buildAudioStatus('none', includeAudio, includeAudio ? 'This source did not expose an audio track.' : undefined);
      rememberScreenShareAudioStatus(combinedStream, audioStatus);
      rememberScreenShareCaptureMetadata(combinedStream, 'desktop', frameRate, desktopMetadata, true);
      return { stream: combinedStream, audioStatus };
    }
    combinedStream.getTracks().forEach((track) => track.stop());
  } catch (error) {
    if (!canCaptureRequestedAudio) throw error;
  }

  const videoStream = await getDesktopUserMedia(false, capture);
  const audioStream = await tryCaptureDesktopAudio(sourceId);
  if (!audioStream) {
    const audioStatus = buildAudioStatus('none', includeAudio, includeAudio ? 'Desktop audio capture is unavailable for this source.' : undefined);
    rememberScreenShareAudioStatus(videoStream, audioStatus);
    rememberScreenShareCaptureMetadata(videoStream, 'desktop', frameRate, desktopMetadata, true);
    return { stream: videoStream, audioStatus };
  }

  const stream = new MediaStream([
    ...videoStream.getVideoTracks(),
    ...audioStream.getAudioTracks(),
  ]);
  const audioStatus = buildAudioStatus(isApplicationShare ? 'app' : 'system', includeAudio);
  rememberScreenShareAudioStatus(stream, audioStatus);
  rememberScreenShareCaptureMetadata(stream, 'desktop', frameRate, desktopMetadata, true);
  return { stream, audioStatus };
}

export async function findDeviceAudioInput(videoDeviceId: string): Promise<MediaDeviceInfo | null> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return null;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoDevice = devices.find((d) => d.kind === 'videoinput' && d.deviceId === videoDeviceId);
  if (!videoDevice?.groupId) return null;
  return devices.find((d) => d.kind === 'audioinput' && d.groupId === videoDevice.groupId) ?? null;
}

export async function getAudioInputDevices(): Promise<MediaDeviceInfo[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}

function normalizeDeviceMatchLabel(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(audio|video|device|capture|microphone|mic|digital|interface|input|line|array|default|communications)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parentheticalLabels(value: string) {
  return [...value.matchAll(/\(([^)]+)\)/g)]
    .map((match) => normalizeDeviceMatchLabel(match[1] ?? ''))
    .filter(Boolean);
}

function deviceMatchTokens(value: string) {
  return new Set(
    normalizeDeviceMatchLabel(value)
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length > 2 || /\d/.test(token)),
  );
}

function audioInputMatchScore(videoLabel: string, audioLabel: string) {
  const video = normalizeDeviceMatchLabel(videoLabel);
  const audio = normalizeDeviceMatchLabel(audioLabel);
  if (!video || !audio) return 0;
  if (video === audio) return 100;
  if (parentheticalLabels(audioLabel).some((label) => label === video || label.includes(video) || video.includes(label))) return 95;
  if (audio.includes(video) || video.includes(audio)) return 90;

  const videoTokens = deviceMatchTokens(videoLabel);
  const audioTokens = deviceMatchTokens(audioLabel);
  if (videoTokens.size === 0 || audioTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of videoTokens) {
    if (audioTokens.has(token)) overlap += 1;
  }
  return Math.round((overlap / videoTokens.size) * 80);
}

export async function findBestDeviceAudioInput(
  videoDevice: Pick<VideoCaptureDeviceInfo, 'deviceId' | 'label' | 'groupId'>,
  audioInputs?: MediaDeviceInfo[],
): Promise<MediaDeviceInfo | null> {
  const inputs = audioInputs ?? await getAudioInputDevices();
  if (videoDevice.groupId) {
    const exactGroupMatch = inputs.find((input) => input.groupId && input.groupId === videoDevice.groupId);
    if (exactGroupMatch) return exactGroupMatch;
  }

  const videoLabel = videoDevice.label?.trim();
  if (!videoLabel) return null;
  let best: { input: MediaDeviceInfo; score: number } | null = null;
  for (const input of inputs) {
    const score = audioInputMatchScore(videoLabel, input.label || '');
    if (!best || score > best.score) best = { input, score };
  }
  return best && best.score >= 50 ? best.input : null;
}

export async function captureScreenShare(options: CaptureScreenShareOptions): Promise<CaptureScreenShareResult> {
  if (options.kind === 'device') {
    let audioConstraint: MediaTrackConstraints | false = false;
    if (options.includeAudio) {
      if (options.audioDeviceId) {
        audioConstraint = screenShareAudioConstraints(options.audioDeviceId);
      } else {
        const auto = await findDeviceAudioInput(options.deviceId);
        if (auto) audioConstraint = screenShareAudioConstraints(auto.deviceId);
      }
    }
    let stream: MediaStream;
    let strictFrameRate = true;
    await logVoiceDebugAwaitable('livekit', 'screen-share: getUserMedia device (strict)', {
      deviceId: options.deviceId,
      width: options.width,
      height: options.height,
      frameRate: options.frameRate,
      hasAudio: audioConstraint !== false,
      constraints: deviceVideoConstraints(options, true),
    });
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: deviceVideoConstraints(options, true),
        audio: audioConstraint,
      });
    } catch (error) {
      if (!isConstraintFallbackError(error)) throw error;
      logVoiceDebug('livekit', 'screen share strict device fps constraints rejected', {
        requested: {
          width: options.width,
          height: options.height,
          frameRate: options.frameRate,
        },
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      }, 'warn');
      strictFrameRate = false;
      await logVoiceDebugAwaitable('livekit', 'screen-share: getUserMedia device (relaxed fallback)', {
        deviceId: options.deviceId,
        width: options.width,
        height: options.height,
        frameRate: options.frameRate,
        hasAudio: audioConstraint !== false,
        constraints: deviceVideoConstraints(options, false),
      });
      stream = await navigator.mediaDevices.getUserMedia({
        video: deviceVideoConstraints(options, false),
        audio: audioConstraint,
      });
    }
    const validated = await validateDeviceCaptureFps(stream, strictFrameRate, options, audioConstraint);
    stream = validated.stream;
    strictFrameRate = validated.strictFrameRate;

    const audioStatus = audioConstraint !== false
      ? buildAudioStatus('system', true)
      : buildAudioStatus('none', options.includeAudio, options.includeAudio ? 'No audio input found for this device.' : undefined);
    rememberScreenShareAudioStatus(stream, audioStatus);
    rememberScreenShareCaptureMetadata(stream, 'device', options.frameRate);
    logDeviceCaptureNegotiated(validated.options, stream, strictFrameRate, options.frameRate);
    return { stream, audioStatus };
  }

  if (options.kind === 'desktop' && supportsElectronDesktopCapture()) {
    if (!options.sourceId) {
      throw new Error('Select a screen or window to share.');
    }
    return getElectronDesktopMediaStreamWithStatus({
      sourceId: options.sourceId,
      width: options.width,
      height: options.height,
      frameRate: options.frameRate,
      includeAudio: options.includeAudio,
    });
  }

  const stream = await getBrowserDisplayMedia(options);
  const audioStatus = stream.getAudioTracks().length > 0
    ? buildAudioStatus('system', options.includeAudio)
    : buildAudioStatus('none', options.includeAudio, options.includeAudio ? 'The selected source did not include audio.' : undefined);
  rememberScreenShareAudioStatus(stream, audioStatus);
  rememberScreenShareCaptureMetadata(stream, 'browser', options.frameRate);
  return { stream, audioStatus };
}

function nativeVideoCaptureDeviceLoad(): Promise<NativeVideoCaptureDevice[]> {
  if (typeof window === 'undefined' || !window.electron?.listVideoCaptureDevices) return Promise.resolve([]);
  const now = Date.now();
  if (nativeVideoDevicesCache && now - nativeVideoDevicesCache.checkedAt < NATIVE_VIDEO_DEVICES_CACHE_MS) {
    return Promise.resolve(nativeVideoDevicesCache.devices);
  }
  if (!nativeVideoDevicesPromise) {
    nativeVideoDevicesPromise = window.electron.listVideoCaptureDevices()
      .then((devices) => {
        const normalized = Array.isArray(devices)
          ? devices
            .filter((device) => device?.kind === 'videoinput' && typeof device.label === 'string' && device.label.trim())
            .map((device, index) => ({
              deviceId: device.deviceId || `native-video:${index}`,
              kind: 'videoinput' as const,
              label: device.label.trim(),
              groupId: device.groupId ?? '',
              devicePath: device.devicePath ?? null,
            }))
          : [];
        nativeVideoDevicesCache = { checkedAt: Date.now(), devices: normalized };
        return normalized;
      })
      .catch(() => [])
      .finally(() => {
        nativeVideoDevicesPromise = null;
      });
  }
  return nativeVideoDevicesPromise;
}

async function getNativeVideoCaptureDevices(timeoutMs: number): Promise<NativeVideoCaptureDevice[]> {
  const load = nativeVideoCaptureDeviceLoad();
  if (timeoutMs <= 0) return load;
  return Promise.race([
    load,
    new Promise<NativeVideoCaptureDevice[]>((resolve) => {
      window.setTimeout(() => resolve(nativeVideoDevicesCache?.devices ?? []), timeoutMs);
    }),
  ]);
}

export async function getVideoDevices(options?: { native?: 'include' | 'cached' | 'skip'; timeoutMs?: number }): Promise<VideoCaptureDeviceInfo[]> {
  const browserDevices = typeof navigator !== 'undefined' && navigator.mediaDevices
    ? await navigator.mediaDevices.enumerateDevices().catch(() => [])
    : [];
  const browserVideoDevices = browserDevices.filter((d) => d.kind === 'videoinput');
  const nativeMode = options?.native ?? 'include';
  const nativeVideoDevices = nativeMode === 'skip'
    ? []
    : nativeMode === 'cached'
      ? nativeVideoDevicesCache?.devices ?? []
      : await getNativeVideoCaptureDevices(options?.timeoutMs ?? NATIVE_VIDEO_DEVICES_TIMEOUT_MS);

  if (browserVideoDevices.length > 0) {
    const usedNativeDeviceIds = new Set<string>();
    const merged: VideoCaptureDeviceInfo[] = browserVideoDevices.map((device, index) => {
      const nativeDevice = device.label
        ? nativeVideoDevices.find((candidate) => candidate.label.localeCompare(device.label, undefined, { sensitivity: 'accent' }) === 0) ?? nativeVideoDevices[index] ?? null
        : nativeVideoDevices[index] ?? null;
      if (nativeDevice) usedNativeDeviceIds.add(nativeDevice.deviceId);
      return {
        deviceId: device.deviceId,
        kind: 'videoinput',
        label: device.label || nativeDevice?.label || '',
        groupId: device.groupId || nativeDevice?.groupId || '',
        devicePath: nativeDevice?.devicePath ?? null,
      };
    });
    for (const nativeDevice of nativeVideoDevices) {
      if (usedNativeDeviceIds.has(nativeDevice.deviceId)) continue;
      merged.push({
        deviceId: nativeDevice.deviceId,
        kind: 'videoinput',
        label: nativeDevice.label,
        groupId: nativeDevice.groupId ?? '',
        devicePath: nativeDevice.devicePath ?? null,
        nativeOnly: true,
      });
    }
    return merged;
  }

  return nativeVideoDevices.map((device) => ({
    deviceId: device.deviceId,
    kind: 'videoinput',
    label: device.label,
    groupId: device.groupId ?? '',
    devicePath: device.devicePath ?? null,
    nativeOnly: true,
  }));
}
