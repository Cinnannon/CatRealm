import { create } from 'zustand';
import {
  AudioPresets,
  ConnectionQuality,
  ConnectionState,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  VideoPreset,
  type LocalTrackPublication,
  type LocalVideoTrack,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type TrackPublishOptions,
  type VideoCodec,
  type VideoSenderStats,
} from 'livekit-client';
import type { Socket } from 'socket.io-client';
import { createApi } from '../lib/api';
import { getSocket } from '../lib/socket';
import { useSettingsStore } from './settingsStore';
import { useUIStore } from './uiStore';
import { logVoiceDebug } from '../lib/voiceDebugConsole';
import { applyScreenCaptureConstraints, getScreenShareAudioStatus, isTauriDesktop, type ScreenShareAudioStatus } from '../lib/desktopCapture';
import { targetCaptureFps } from '../lib/screenShareCaptureFps';
import { canReceiveVideoMimeType, knownH264HardwareEncode, probeH264HardwareEncode } from '../lib/screenShareCodecSupport';
import { playRemoteParticipantAudio, type ManagedRemoteAudioPlayback } from '../lib/mediaPlayback';
import { playNotificationSound, type SoundType } from '../lib/notificationSounds';
import { useBlockedUsersStore } from './blockedUsersStore';

export type MediaContext = 'dm' | 'group' | 'voice' | 'theater';
export type MediaConnectionLabel = 'Connected' | 'Connecting' | 'Reconnecting' | 'Disconnected' | 'No media server' | 'Legacy mode';

type MediaCapability = {
  version: number;
  provider: 'livekit';
  enabled: boolean;
  configured: boolean;
  ingress?: {
    whip: boolean;
    publicUrl: string | null;
    // Max native screen-share height the host can carry over WHIP. null =
    // unlimited. Set to 720 when the server host's net.core.rmem_max is at the
    // stock default (a 1080p/1440p keyframe burst overflows the small UDP buffer).
    maxHeight?: number | null;
    hostLimited?: boolean;
    simulcastExperiment?: boolean;
  };
  liveKitFallbackContexts?: MediaContext[];
  publicUrl: string | null;
  contexts: MediaContext[];
  privacy?: {
    mediaPath: 'sfu' | 'central-sfu' | 'unavailable';
    e2ee: boolean;
    transportEncrypted: boolean;
    label: string;
  };
};

type MediaTokenResponse = {
  ok: true;
  token: string;
  url: string;
  provider: 'livekit';
  roomName: string;
  identity: string;
  expiresAt: number;
  publishSources: string[];
  context: MediaContext;
  serverId?: string;
  channelId?: string;
  callId?: string;
  privacy?: {
    e2ee: boolean;
    transportEncrypted: boolean;
    mediaPath: 'sfu';
    label: string;
  };
};

type WhipIngressSessionResponse = {
  ok: true;
  provider: 'livekit';
  context: MediaContext;
  serverId?: string;
  channelId: string;
  roomName: string;
  ingress: {
    ingressId: string;
    name: string;
    streamKey: string;
    url: string;
    roomName: string;
    participantIdentity: string;
    participantName: string;
  };
  whip: {
    url: string;
    streamKey: string;
    publicBaseUrl: string;
  };
  simulcast?: {
    requested: boolean;
    enabled: boolean;
    experimental: boolean;
    layers: Array<{
      quality: 'low' | 'medium' | 'high';
      width: number;
      height: number;
      bitrate: number;
      fps: number;
    }>;
  };
};

type WhipIngressReleaseHandle = {
  serverUrl: string;
  context: 'voice' | 'theater';
  channelId: string;
  ingressId: string;
};

type WhipIngressReleaseResponse = {
  ok: boolean;
  deleted?: boolean;
  ingressId?: string;
  roomName?: string;
  error?: string;
};

type MediaErrorLike = {
  response?: {
    status?: number;
    data?: {
      error?: string;
    };
  };
  message?: string;
};

type RemoteMediaTrack = {
  participantId: string;
  publicationSid: string;
  source: string;
  kind: 'audio' | 'video';
  remoteTrack: RemoteTrack;
  subscribedAt: number;
  remotePublication?: Pick<RemoteTrackPublication, 'setVideoDimensions' | 'setVideoFPS' | 'setVideoQuality'>;
  mediaStream?: MediaStream;
  element?: HTMLMediaElement;
  receiverStatsInterval?: ReturnType<typeof setInterval>;
  audioPlayback?: ManagedRemoteAudioPlayback;
  screenShareAudioStatus?: ScreenShareAudioStatus;
  screenShareVideoTarget?: { height: number; fps: number };
};

type MediaSession = {
  key: string;
  context: MediaContext;
  serverUrl: string;
  channelId?: string;
  callId?: string;
  roomName: string;
  identity: string;
  room: Room;
  // Voice runs in the Rust process (Linux Sushi: WebKitGTK has no WebRTC).
  // `room` is then a stub whose disconnect() tears the native session down;
  // every feature beyond join/mute/deafen must bail out early on this flag.
  isNativeVoice?: boolean;
  localMicrophoneTrack?: MediaStreamTrack | null;
  localMicrophonePublication?: LocalTrackPublication | null;
  localMicrophoneMode?: 'processed' | 'device' | 'none';
};

type MediaParticipantState = {
  identity: string;
  name: string | null;
  metadata: Record<string, unknown> | null;
  connectionQuality: ConnectionQuality;
  // Set when this participant shares a screen in a codec this browser can't
  // decode, so the UI can say why the share never arrives.
  unplayableScreenShareMimeType?: string;
};

export type NativeVideoFrame = {
  identity: string;
  trackSid: string;
  kind: 'camera' | 'screen';
  dataUrl: string;
  width: number;
  height: number;
};

type MediaState = {
  capabilityByServer: Record<string, MediaCapability>;
  activeSession: MediaSession | null;
  connectionState: ConnectionState;
  statusLabel: MediaConnectionLabel;
  error: string | null;
  remoteTracks: Record<string, RemoteMediaTrack>;
  participants: Record<string, MediaParticipantState>;
  privacyLabel: string | null;
  isMicrophoneEnabled: boolean;
  isCameraEnabled: boolean;
  localCameraStream: MediaStream | null;
  nativeCameraPreviewUrl: string | null;
  nativeScreenPreviewUrl: string | null;
  nativeRemoteVideoFrames: Record<string, NativeVideoFrame>;
  isScreenShareEnabled: boolean;
  localScreenShareStream: MediaStream | null;
  screenShareViewersByUser: Record<string, string[]>;
  probeSelfHostCapability: (serverUrl: string) => Promise<MediaCapability | null>;
  joinVoice: (args: { serverUrl: string; channelId: string; muted: boolean; deafened: boolean; microphoneTrack?: MediaStreamTrack | null; microphoneTrackLabel?: string }) => Promise<boolean>;
  joinTheater: (args: { serverUrl: string; channelId: string; muted: boolean; deafened: boolean }) => Promise<boolean>;
  joinCall: (args: { socket: Socket; callId: string; callType: 'dm' | 'group'; mediaType: 'audio' | 'video'; muted: boolean; microphoneTrack?: MediaStreamTrack | null; microphoneTrackLabel?: string }) => Promise<boolean>;
  leave: (context?: MediaContext, id?: string) => void;
  setMicrophoneMuted: (muted: boolean) => Promise<void>;
  setDeafened: (deafened: boolean) => void;
  setOutputDevice: (deviceId: string | null) => Promise<void>;
  startCamera: (deviceId?: string) => Promise<void>;
  stopCamera: () => Promise<void>;
  startNativeScreenShare: (opts: {
    sourceId: string;
    captureMode?: ScreenShareDesktopCaptureMode;
    presetOverride?: 'quality' | 'efficiency' | 'compressed' | 'catrealm';
  }) => Promise<boolean>;
  startNativeDeviceShare: (opts: {
    deviceId: string;
    deviceLabel?: string | null;
    devicePath?: string | null;
    audioDeviceId?: string | null;
    audioDeviceLabel?: string | null;
    presetOverride?: 'quality' | 'efficiency' | 'compressed' | 'catrealm';
  }) => Promise<boolean>;
  startScreenShare: (stream?: MediaStream, presetOverride?: 'quality' | 'efficiency' | 'compressed' | 'catrealm', nativeSourceId?: string) => Promise<void>;
  stopScreenShare: () => Promise<void>;
  setWatchingScreenShare: (targetUserId: string, watching: boolean) => void;
  cleanup: () => void;
};

function getSessionKey(context: MediaContext, id: string) {
  return `${context}:${id}`;
}

function parseMetadata(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function toStatusLabel(state: ConnectionState, capability?: MediaCapability | null): MediaConnectionLabel {
  if (capability && !capability.enabled && !(capability.liveKitFallbackContexts?.length)) {
    return 'No media server';
  }
  if (state === ConnectionState.Connected) return 'Connected';
  if (state === ConnectionState.Connecting) return 'Connecting';
  if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting) return 'Reconnecting';
  return 'Disconnected';
}

// A realm without its own LiveKit borrows Central's. Screen shares there are
// held to the same 'catrealm' bitrate ceiling Central enforces for DM shares.
export function isCentralMediaFallback(capability: MediaCapability | null | undefined, context: MediaContext) {
  return !!capability && !capability.enabled && capability.liveKitFallbackContexts?.includes(context) === true;
}

// Whether the local screen share is live and held to the Central ceiling.
export function isScreenShareCentralLimited(state: MediaState) {
  const session = state.activeSession;
  return state.isScreenShareEnabled && !!session
    && isCentralMediaFallback(state.capabilityByServer[session.serverUrl], session.context);
}

function resolveScreenSharePreset(
  session: MediaSession | null | undefined,
  presetOverride?: 'quality' | 'efficiency' | 'compressed' | 'catrealm',
) {
  if (presetOverride) return presetOverride;
  if (session && isCentralMediaFallback(useMediaStore.getState().capabilityByServer[session.serverUrl], session.context)) {
    return 'catrealm';
  }
  return useSettingsStore.getState().screenshareQualityPreset;
}

function hasLiveKitPathForContext(capability: MediaCapability | null | undefined, context: MediaContext) {
  return !!capability && capability.contexts.includes(context) && (
    capability.enabled || capability.liveKitFallbackContexts?.includes(context) === true
  );
}

function detachTrack(track: RemoteMediaTrack) {
  if (track.receiverStatsInterval) {
    clearInterval(track.receiverStatsInterval);
  }
  track.audioPlayback?.destroy();
  if (track.element) {
    try {
      track.element.pause();
      track.element.remove();
    } catch {
      // ignore detach failures
    }
  }
}

function isReplaceableScreenShareTrack(track: Pick<RemoteMediaTrack, 'source' | 'kind'>) {
  return track.source === Track.Source.ScreenShare || track.source === Track.Source.ScreenShareAudio;
}

function upsertRemoteTrack(remoteTracks: Record<string, RemoteMediaTrack>, incoming: RemoteMediaTrack) {
  const next = { ...remoteTracks };
  const incomingKey = `${incoming.participantId}:${incoming.publicationSid}`;
  if (isReplaceableScreenShareTrack(incoming)) {
    Object.entries(next).forEach(([key, existing]) => {
      if (key === incomingKey) return;
      if (existing.participantId !== incoming.participantId) return;
      if (existing.kind !== incoming.kind || existing.source !== incoming.source) return;
      detachTrack(existing);
      delete next[key];
    });
  }
  next[incomingKey] = incoming;
  return next;
}

function removeRemoteTrack(remoteTracks: Record<string, RemoteMediaTrack>, participantId: string, publicationSid: string) {
  const trackKey = `${participantId}:${publicationSid}`;
  const existing = remoteTracks[trackKey];
  if (!existing) return remoteTracks;
  const next = { ...remoteTracks };
  detachTrack(existing);
  delete next[trackKey];
  return next;
}

async function applySinkId(element: HTMLMediaElement, deviceId: string | null) {
  const target = deviceId || 'default';
  const maybeSetSinkId = (element as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
  if (!maybeSetSinkId) return;
  try {
    await maybeSetSinkId.call(element, target);
  } catch {
    if (target !== 'default') {
      await maybeSetSinkId.call(element, 'default').catch(() => {});
    }
  }
}

const LIVEKIT_SCREEN_AUDIO_TRACK_NAME_PREFIX = 'catrealm:screen-share-audio:';
const LIVEKIT_SCREEN_VIDEO_TRACK_NAME_PREFIX = 'catrealm:screen-share-video:';
const LIVEKIT_SCREEN_WATCH_TOPIC = 'catrealm:screen-share-watch';

type ScreenShareWatchPayload = {
  type: 'screen-share-watch';
  targetUserId: string;
  watching: boolean;
};

type ScreenShareWatchersSnapshotPayload = {
  type: 'screen-share-watchers-snapshot';
  targetUserId: string;
  viewers: Array<{
    id: string;
    username: string;
    avatar?: string | null;
    accountType?: 'local' | 'central';
  }>;
};

type ScreenShareViewerSoundSettingKey =
  | 'soundScreenshareUserJoin'
  | 'soundScreenshareUserLeft';

type VoicePlaybackSnapshot = {
  selfDeafened: boolean;
  peerVolumeByUser: Record<string, number>;
  users: Record<string, { muted?: boolean; deafened?: boolean }>;
};

type ScreenShareEncoding = {
  height: number;
  maxBitrate: number;
  maxFramerate: number;
  priority: RTCPriorityType;
  networkPriority?: RTCPriorityType;
};

type ScreenSharePublishTarget = {
  codec: VideoCodec;
  height: number;
  fps: number;
  encoding: ScreenShareEncoding;
  cappedBySoftwareH264: boolean;
};

type BrowserVideoCodecCapability = {
  mimeType: string;
  clockRate?: number;
  channels?: number;
  sdpFmtpLine?: string;
};

type ExtendedOutboundVideoStats = {
  id?: string;
  timestamp?: number;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  framesSent?: number;
  framesEncoded?: number;
  keyFramesEncoded?: number;
  hugeFramesSent?: number;
  qpSum?: number;
  totalEncodeTime?: number;
  totalPacketSendDelay?: number;
  packetsSent?: number;
  bytesSent?: number;
  headerBytesSent?: number;
  retransmittedPacketsSent?: number;
  retransmittedBytesSent?: number;
  qualityLimitationReason?: string;
  qualityLimitationResolutionChanges?: number;
  targetBitrate?: number;
  remoteId?: string;
  codecId?: string;
  encoderImplementation?: string;
  powerEfficientEncoder?: boolean;
};

type ExtendedRemoteInboundVideoStats = {
  jitter?: number;
  packetsLost?: number;
  roundTripTime?: number;
};

type ExtendedInboundVideoStats = {
  id?: string;
  timestamp?: number;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  framesReceived?: number;
  framesDecoded?: number;
  framesDropped?: number;
  framesAssembledFromMultiplePackets?: number;
  keyFramesDecoded?: number;
  qpSum?: number;
  jitter?: number;
  packetsLost?: number;
  packetsReceived?: number;
  bytesReceived?: number;
  headerBytesReceived?: number;
  totalDecodeTime?: number;
  totalInterFrameDelay?: number;
  totalSquaredInterFrameDelay?: number;
  jitterBufferDelay?: number;
  jitterBufferEmittedCount?: number;
  freezeCount?: number;
  totalFreezesDuration?: number;
  pauseCount?: number;
  totalPausesDuration?: number;
  codecId?: string;
};

type ExtendedCandidatePairStats = {
  availableOutgoingBitrate?: number;
  currentRoundTripTime?: number;
};

type ExtendedVideoSourceStats = {
  frames?: number;
  framesPerSecond?: number;
  width?: number;
  height?: number;
};

type ExtendedCodecStats = {
  mimeType?: string;
  payloadType?: number;
  clockRate?: number;
  sdpFmtpLine?: string;
};

type ScreenShareRawStatsSnapshot = {
  outbound: ExtendedOutboundVideoStats | null;
  remoteInbound: ExtendedRemoteInboundVideoStats | null;
  candidatePair: ExtendedCandidatePairStats | null;
  mediaSource: ExtendedVideoSourceStats | null;
  codec: ExtendedCodecStats | null;
};

type CatRealmScreenShareTrack = MediaStreamTrack & {
  catrealmScreenShareSourceKind?: 'device' | 'desktop' | 'browser';
  catrealmScreenShareTargetFps?: number;
  catrealmScreenShareDesktopSourceType?: 'screen' | 'window';
  catrealmScreenShareDesktopSourceId?: string;
  catrealmNativeCapture?: true;
};

let voicePlaybackSnapshot: VoicePlaybackSnapshot = {
  selfDeafened: false,
  peerVolumeByUser: {},
  users: {},
};

function getRemoteTrackVolumePct(participantId: string) {
  if (useBlockedUsersStore.getState().isBlocked(participantId)) return 0;
  return voicePlaybackSnapshot.peerVolumeByUser[participantId] ?? 50;
}

function isRemoteTrackMutedForVoice(participantId: string) {
  if (useBlockedUsersStore.getState().isBlocked(participantId)) return true;
  const user = voicePlaybackSnapshot.users[participantId];
  return voicePlaybackSnapshot.selfDeafened || !!user?.muted || !!user?.deafened;
}

function parseScreenShareAudioStatus(publication: RemoteTrackPublication): ScreenShareAudioStatus | undefined {
  if (publication.source !== Track.Source.ScreenShareAudio) return undefined;
  const trackName = publication.trackName || '';
  if (trackName === `${LIVEKIT_SCREEN_AUDIO_TRACK_NAME_PREFIX}app`) {
    return { mode: 'app', label: 'App audio', requested: true, available: true };
  }
  if (trackName === `${LIVEKIT_SCREEN_AUDIO_TRACK_NAME_PREFIX}system`) {
    return { mode: 'system', label: 'System audio', requested: true, available: true };
  }
  return { mode: 'system', label: 'System audio', requested: true, available: true };
}

function parseScreenShareVideoTarget(publication: RemoteTrackPublication) {
  if (publication.source !== Track.Source.ScreenShare) return undefined;
  const trackName = publication.trackName || '';
  if (!trackName.startsWith(LIVEKIT_SCREEN_VIDEO_TRACK_NAME_PREFIX)) return undefined;
  const match = trackName.slice(LIVEKIT_SCREEN_VIDEO_TRACK_NAME_PREFIX.length).match(/^(\d+)p(\d+)$/);
  if (!match) return undefined;
  return {
    height: Number(match[1]),
    fps: Number(match[2]),
  };
}

function parseScreenShareParticipantVideoTarget(participant: Participant) {
  const metadata = parseMetadata(participant.metadata);
  const target = metadata?.screenShareVideoTarget;
  if (!target || typeof target !== 'object') return undefined;
  const record = target as Record<string, unknown>;
  const height = Number(record.height);
  const fps = Number(record.fps);
  if (!Number.isFinite(height) || !Number.isFinite(fps)) return undefined;
  return { height, fps };
}

function isScreenShareIngressParticipant(participant: Participant) {
  const metadata = parseMetadata(participant.metadata);
  return metadata?.mediaRole === 'screen-share-ingress'
    || /^catrealm-ingress:[^:]+:screen:/.test(participant.identity);
}

function getEffectivePublicationSource(publication: RemoteTrackPublication, participant: Participant) {
  if (!isScreenShareIngressParticipant(participant)) return publication.source;
  if (publication.kind === Track.Kind.Video) return Track.Source.ScreenShare;
  if (publication.kind === Track.Kind.Audio) return Track.Source.ScreenShareAudio;
  return publication.source;
}

function isScreenShareAudioTrack(source: string) {
  return source === Track.Source.ScreenShareAudio;
}

// Per-resolution, per-fps bitrate targets for each quality preset.
// Quality: tuned for maximum visual fidelity (1440p60 ≈ 22 Mbps).
// Efficiency: halved target for bandwidth-constrained hosts (1440p60 ≈ 14 Mbps).
const SCREEN_SHARE_BITRATE = {
  quality: {
    1440: { 24: 12_000_000, 48: 18_000_000, 60: 22_000_000 },
    1080: { 24:  8_000_000, 48: 12_000_000, 60: 16_000_000 },
     720: { 24:  4_000_000, 48:  6_000_000, 60:  8_000_000 },
  },
  efficiency: {
    1440: { 24:  6_000_000, 48: 10_000_000, 60: 14_000_000 },
    1080: { 24:  4_000_000, 48:  7_000_000, 60:  9_000_000 },
     720: { 24:  2_000_000, 48:  3_000_000, 60:  4_000_000 },
  },
  compressed: {
    1440: { 24:  4_000_000, 48:  6_000_000, 60:  8_000_000 },
    1080: { 24:  2_000_000, 48:  4_000_000, 60:  6_000_000 },
     720: { 24:  1_500_000, 48:  2_000_000, 60:  2_500_000 },
  },
  catrealm: {
    1440: { 24:  3_500_000, 48:  4_000_000, 60:  5_000_000 },
    1080: { 24:  1_500_000, 48:  3_000_000, 60:  4_000_000 },
     720: { 24:  1_000_000, 48:  2_000_000, 60:  2_500_000 },
  },
} as const satisfies Record<string, Record<number, Record<number, number>>>;

// Software H.264/OpenH264 is capped at 1080p60 as an upper bound; stability is
// still hardware/session dependent, and larger targets need native WHIP/NVENC.
const H264_SOFTWARE_MAX_SCREEN_SHARE_HEIGHT = 1080;
const H264_SOFTWARE_MAX_SCREEN_SHARE_FPS = 60;

function getScreenShareEncoding(
  height: number,
  fps: number,
  preset: 'quality' | 'efficiency' | 'compressed' | 'catrealm' = 'quality',
): ScreenShareEncoding {
  const resKey = height >= 1440 ? 1440 : height >= 1080 ? 1080 : 720;
  const fpsKey = fps >= 60 ? 60 : fps >= 48 ? 48 : 24;
  const maxBitrate = SCREEN_SHARE_BITRATE[preset][resKey][fpsKey];
  return {
    height,
    maxBitrate,
    maxFramerate: fps,
    // 'high' gives the GCC's startup probing a larger initial allocation,
    // helping it reach the target bitrate faster from a cold start.
    priority: 'high',
    networkPriority: 'high',
  };
}

// Clamp the native screen-share height to whatever the server host can carry
// over WHIP. On a host with a stock net.core.rmem_max the capability reports
// ingress.maxHeight=720; publishing higher overflows the host UDP buffer and
// collapses the stream to ~2-5 fps, so we cap before encoding.
function clampNativeShareHeightToHost(
  requestedHeight: number,
  capability: MediaCapability | null | undefined,
): { height: number; clamped: boolean; maxHeight: number | null } {
  const maxHeight = capability?.ingress?.maxHeight ?? null;
  if (typeof maxHeight === 'number' && maxHeight > 0 && requestedHeight > maxHeight) {
    return { height: maxHeight, clamped: true, maxHeight };
  }
  return { height: requestedHeight, clamped: false, maxHeight };
}

function getScreenShareSimulcastLayers(
  targetHeight: number,
  targetFps: number,
  targetBitrate: number,
) {
  const mediumHeight = targetHeight >= 1080 ? 720 : Math.max(360, Math.round(targetHeight / 2));
  const lowHeight = targetHeight >= 1080 ? 360 : Math.max(180, Math.round(targetHeight / 4));
  const mediumWidth = Math.round((mediumHeight * 16) / 9);
  const lowWidth = Math.round((lowHeight * 16) / 9);
  const mediumFps = Math.min(targetFps, 48);
  const lowFps = Math.min(targetFps, 24);

  const mediumBitrate = Math.min(Math.round(targetBitrate * 0.45), targetFps >= 48 ? 4_000_000 : 2_500_000);
  const lowBitrate = Math.min(Math.round(targetBitrate * 0.18), targetFps >= 48 ? 1_200_000 : 800_000);

  return [
    new VideoPreset(lowWidth, lowHeight, Math.max(350_000, lowBitrate), lowFps, 'medium'),
    new VideoPreset(mediumWidth, mediumHeight, Math.max(900_000, mediumBitrate), mediumFps, 'medium'),
  ];
}

function stopActiveScreenShareStatsPolling() {
  if (activeScreenShareStatsInterval !== null) {
    clearInterval(activeScreenShareStatsInterval);
    activeScreenShareStatsInterval = null;
  }
}

function stopActiveScreenShareCaptureProbe() {
  if (!activeScreenShareCaptureProbe) return;
  const probe = activeScreenShareCaptureProbe;
  activeScreenShareCaptureProbe = null;
  probe.stopped = true;
  clearInterval(probe.interval);
  if (probe.callbackHandle !== null) {
    const cancelFrameCallback = (probe.video as HTMLVideoElement & {
      cancelVideoFrameCallback?: (handle: number) => void;
    }).cancelVideoFrameCallback;
    cancelFrameCallback?.call(probe.video, probe.callbackHandle);
  }
  probe.video.pause();
  probe.video.srcObject = null;
  probe.video.remove();
}

function startActiveScreenShareCaptureProbe(
  session: MediaSession,
  captureTrack: MediaStreamTrack | null,
  targetFps: number,
) {
  stopActiveScreenShareCaptureProbe();
  if (!captureTrack || captureTrack.readyState !== 'live') return;

  const video = document.createElement('video');
  const stream = new MediaStream([captureTrack]);
  const videoWithCallbacks = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
    webkitDecodedFrameCount?: number;
  };

  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.srcObject = stream;
  // Must be in the DOM — Chromium throttles requestVideoFrameCallback for
  // off-DOM video elements, giving falsely low frame counts.
  video.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(video);

  const initialSettings = captureTrack.getSettings();
  logVoiceDebug('livekit', 'screen share local capture probe started', {
    channelId: session.channelId ?? null,
    targetFps,
    captureMetadata: getScreenShareCaptureMetadata(captureTrack),
    trackReadyState: captureTrack.readyState,
    trackMuted: captureTrack.muted,
    trackContentHint: 'contentHint' in captureTrack ? captureTrack.contentHint : null,
    trackSettings: {
      width: initialSettings.width ?? null,
      height: initialSettings.height ?? null,
      frameRate: initialSettings.frameRate ?? null,
      resizeMode: (initialSettings as MediaTrackSettings & { resizeMode?: string }).resizeMode ?? null,
    },
    trackCapabilities: getMediaTrackCapabilitiesSnapshot(captureTrack),
    browserCapabilities: summarizeBrowserVideoCodecCapabilities(getBrowserVideoCodecCapabilities()),
  });

  let callbackFrames = 0;
  let lastPresentedFrames: number | null = null;
  let presentedFrameDeltaSinceLastLog: number | null = null;
  let prevCallbackFrames = 0;
  let prevDecodedFrames = videoWithCallbacks.webkitDecodedFrameCount ?? null;
  let prevLogTime = performance.now();
  let lowProbeFpsStreak = 0;
  let recoveryAttemptIndex = 0;
  let recoveryInFlight = false;
  const recoveryModes = [
    { width: 1920, height: 1080 },
    { width: 1280, height: 720 },
  ];

  const scheduleFrameCallback = () => {
    if (!videoWithCallbacks.requestVideoFrameCallback || !activeScreenShareCaptureProbe || activeScreenShareCaptureProbe.stopped) return;
    activeScreenShareCaptureProbe.callbackHandle = videoWithCallbacks.requestVideoFrameCallback((_now, metadata) => {
      if (!activeScreenShareCaptureProbe || activeScreenShareCaptureProbe.stopped) return;
      callbackFrames += 1;
      if (typeof metadata.presentedFrames === 'number') {
        presentedFrameDeltaSinceLastLog = lastPresentedFrames === null
          ? null
          : Math.max(0, metadata.presentedFrames - lastPresentedFrames);
        lastPresentedFrames = metadata.presentedFrames;
      }
      scheduleFrameCallback();
    });
  };

  const interval = window.setInterval(() => {
    const now = performance.now();
    const elapsedSeconds = Math.max(0.001, (now - prevLogTime) / 1000);
    const callbackFrameDelta = callbackFrames - prevCallbackFrames;
    const decodedFrames = videoWithCallbacks.webkitDecodedFrameCount ?? null;
    const decodedFramesDelta = typeof decodedFrames === 'number' && typeof prevDecodedFrames === 'number'
      ? Math.max(0, decodedFrames - prevDecodedFrames)
      : null;
    const trackSettings = captureTrack.getSettings();
    const callbackFps = Math.round((callbackFrameDelta / elapsedSeconds) * 10) / 10;
    const presentedFps = presentedFrameDeltaSinceLastLog !== null
      ? Math.round((presentedFrameDeltaSinceLastLog / elapsedSeconds) * 10) / 10
      : null;
    const decodedFps = decodedFramesDelta !== null
      ? Math.round((decodedFramesDelta / elapsedSeconds) * 10) / 10
      : null;
    const belowTarget = callbackFps > 0 && callbackFps < targetFps * SCREEN_SHARE_FPS_RECOVERY_RATIO;

    logVoiceDebug('livekit', 'screen share local capture probe', {
      channelId: session.channelId ?? null,
      targetFps,
      trackReadyState: captureTrack.readyState,
      trackMuted: captureTrack.muted,
      trackContentHint: 'contentHint' in captureTrack ? captureTrack.contentHint : null,
      trackSettings: {
        width: trackSettings.width ?? null,
        height: trackSettings.height ?? null,
        frameRate: trackSettings.frameRate ?? null,
        resizeMode: (trackSettings as MediaTrackSettings & { resizeMode?: string }).resizeMode ?? null,
      },
      videoReadyState: video.readyState,
      videoPaused: video.paused,
      videoSize: video.videoWidth && video.videoHeight ? `${video.videoWidth}x${video.videoHeight}` : null,
      callbackFrameDelta,
      callbackFps,
      presentedFrameDelta: presentedFrameDeltaSinceLastLog,
      presentedFps,
      decodedFramesDelta,
      decodedFps,
      belowTarget,
    });

    const captureMetadata = getScreenShareCaptureMetadata(captureTrack);
    if (
      belowTarget
      && targetFps >= SCREEN_SHARE_FPS_RECOVERY_MIN_TARGET
      && captureMetadata.sourceKind === 'device'
      && !captureMetadata.nativeCapture
      && ENABLE_DEVICE_CAPTURE_MODE_RECOVERY
      && !recoveryInFlight
    ) {
      lowProbeFpsStreak++;
      const currentHeight = trackSettings.height ?? 0;
      while (
        recoveryAttemptIndex < recoveryModes.length
        && currentHeight > 0
        && currentHeight <= recoveryModes[recoveryAttemptIndex].height
      ) {
        recoveryAttemptIndex++;
      }
      const nextMode = recoveryModes[recoveryAttemptIndex] ?? null;
      if (lowProbeFpsStreak >= 2 && nextMode) {
        recoveryAttemptIndex++;
        recoveryInFlight = true;
        const previousSettings = {
          width: trackSettings.width ?? null,
          height: trackSettings.height ?? null,
          frameRate: trackSettings.frameRate ?? null,
        };
        const constraints = {
          width: { exact: nextMode.width },
          height: { exact: nextMode.height },
          frameRate: {
            min: Math.max(1, targetFps - 1),
            ideal: targetFps,
            max: targetFps,
          },
          resizeMode: { exact: 'none' },
        } as MediaTrackConstraints & { resizeMode: { exact: string } };
        void captureTrack.applyConstraints(constraints).then(() => {
          logVoiceDebug('livekit', 'screen share capture mode recovery applied', {
            channelId: session.channelId ?? null,
            reason: 'capture-device-rendered-below-target-fps',
            measuredFps: callbackFps,
            targetFps,
            previousSettings,
            attempted: nextMode,
            constraints,
            nextSettings: captureTrack.getSettings(),
          });
        }).catch((error) => {
          logVoiceDebug('livekit', 'screen share capture mode recovery failed', {
            channelId: session.channelId ?? null,
            reason: 'capture-device-rendered-below-target-fps',
            measuredFps: callbackFps,
            targetFps,
            previousSettings,
            attempted: nextMode,
            constraints,
            error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
          }, 'warn');
        }).finally(() => {
          recoveryInFlight = false;
          lowProbeFpsStreak = 0;
        });
      }
    } else {
      lowProbeFpsStreak = 0;
    }

    prevCallbackFrames = callbackFrames;
    prevDecodedFrames = decodedFrames;
    prevLogTime = now;
    presentedFrameDeltaSinceLastLog = null;
  }, 5000);

  activeScreenShareCaptureProbe = {
    video,
    interval,
    callbackHandle: null,
    stopped: false,
  };
  void video.play().catch((error) => {
    logVoiceDebug('livekit', 'screen share local capture probe play failed', {
      channelId: session.channelId ?? null,
      error: error instanceof Error ? error.message : String(error),
    }, 'warn');
  });
  scheduleFrameCallback();
}

// Resolution downscale thresholds. When the GCC estimate is too low to sustain
// the source resolution, we temporarily drop to a lower resolution so keyframes
// are small enough to actually transmit. Without this, a 1440p keyframe at
// 139 Kbps would stall the pipeline for 30+ seconds.
const CAPTURE_SCALE_DOWN_KBPS = 1_000;   // drop to 720p below this
const CAPTURE_SCALE_UP_KBPS   = 2_500;   // restore full resolution above this (lowered from 3k)
const CAPTURE_SCALE_DOWN_HEIGHT = 720;
const CAPTURE_SCALE_DOWN_WIDTH  = 1280;
const SCREEN_SHARE_FPS_RECOVERY_MIN_TARGET = 48;
const SCREEN_SHARE_FPS_RECOVERY_RATIO = 0.8;
const SCREEN_SHARE_BITRATE_RECOVERY_RATIO = 0.9;
const SCREEN_SHARE_BITRATE_RECOVERY_STEP = 1.5; // Increased from 1.25 for faster recovery
// Keep device/capture-card tracks untouched after the initial getUserMedia call.
// Mode recovery applies exact constraints and can move Chromium from a 60 fps
// native mode to a persistent 30 fps resized mode.
const ENABLE_DEVICE_CAPTURE_MODE_RECOVERY = false;


function getScreenShareCaptureMetadata(track: MediaStreamTrack | null) {
  const taggedTrack = track as CatRealmScreenShareTrack | null;
  return {
    sourceKind: taggedTrack?.catrealmScreenShareSourceKind ?? null,
    targetFps: taggedTrack?.catrealmScreenShareTargetFps ?? null,
    desktopSourceType: taggedTrack?.catrealmScreenShareDesktopSourceType ?? null,
    desktopSourceId: taggedTrack?.catrealmScreenShareDesktopSourceId ?? null,
    nativeCapture: taggedTrack?.catrealmNativeCapture === true,
  };
}

function isDeviceScreenShareCapture(track: MediaStreamTrack | null) {
  return getScreenShareCaptureMetadata(track).sourceKind === 'device';
}

function getMediaTrackCapabilitiesSnapshot(track: MediaStreamTrack | null) {
  if (!track || typeof track.getCapabilities !== 'function') return null;
  try {
    const capabilities = track.getCapabilities() as Record<string, any>;
    const range = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const record = value as Record<string, unknown>;
      return {
        min: typeof record.min === 'number' ? record.min : null,
        max: typeof record.max === 'number' ? record.max : null,
      };
    };
    return {
      width: range(capabilities.width),
      height: range(capabilities.height),
      frameRate: range(capabilities.frameRate),
      resizeMode: Array.isArray(capabilities.resizeMode) ? capabilities.resizeMode : null,
      facingMode: Array.isArray(capabilities.facingMode) ? capabilities.facingMode : null,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function canDynamicallyConstrainScreenShareCapture(metadata: ReturnType<typeof getScreenShareCaptureMetadata>) {
  if (metadata.nativeCapture) return false;
  // Capture cards/webcams should keep their negotiated device mode. Applying
  // lower max frameRate constraints can make Chromium renegotiate a 60 fps
  // capture-card mode down to 30 fps and stay there even after bitrate recovers.
  if (metadata.sourceKind === 'device') return false;
  // Allow dynamic FPS scaling for full screens only. Window capture (WGC) can
  // be flaky when churned, and device sources must keep their negotiated mode.
  return metadata.desktopSourceType !== 'window';
}

function getBrowserVideoCodecCapabilities(): BrowserVideoCodecCapability[] {
  if (typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function') {
    return [];
  }
  return RTCRtpSender.getCapabilities('video')?.codecs ?? [];
}

function isVideoCodecAvailable(codec: VideoCodec, capabilities = getBrowserVideoCodecCapabilities()) {
  if (!capabilities.length) return codec === 'vp8';
  const expectedMime = `video/${codec}`.toLowerCase();
  return capabilities.some((candidate) => candidate.mimeType.toLowerCase() === expectedMime);
}

function summarizeBrowserVideoCodecCapabilities(capabilities: BrowserVideoCodecCapability[]) {
  const mediaCodecs = capabilities
    .filter((candidate) => {
      const mimeType = candidate.mimeType.toLowerCase();
      return mimeType.startsWith('video/')
        && !mimeType.endsWith('/rtx')
        && !mimeType.endsWith('/red')
        && !mimeType.endsWith('/ulpfec')
        && !mimeType.endsWith('/flexfec-03');
    })
    .map((candidate) => ({
      mimeType: candidate.mimeType,
      clockRate: candidate.clockRate ?? null,
      channels: candidate.channels ?? null,
      sdpFmtpLine: candidate.sdpFmtpLine ?? null,
    }));

  return {
    getCapabilitiesAvailable: typeof RTCRtpSender !== 'undefined' && typeof RTCRtpSender.getCapabilities === 'function',
    supportedMimeTypes: Array.from(new Set(mediaCodecs.map((codec) => codec.mimeType.toLowerCase()))),
    mediaCodecs,
  };
}

// Wraps the codec preference: a share that would get software H.264 uses VP8
// instead (see lib/screenShareCodecSupport), and an unavailable H.265 choice
// tells the user what they actually got instead of falling back silently.
let screenShareH265FallbackNoticed = false;
function selectScreenShareVideoCodec(captureTrack: MediaStreamTrack | null): VideoCodec {
  const preferred = selectPreferredScreenShareVideoCodec(captureTrack);
  const vp8Available = isVideoCodecAvailable('vp8', getBrowserVideoCodecCapabilities());
  const codec: VideoCodec = preferred === 'h264' && knownH264HardwareEncode() === false && vp8Available ? 'vp8' : preferred;
  if (codec !== preferred) {
    logVoiceDebug('livekit', 'screen share codec switched to VP8 (software H.264)', { preferred, selectedCodec: codec });
  }
  const { screenshareCodecPreference } = useSettingsStore.getState();
  if (screenshareCodecPreference === 'h265' && codec !== 'h265' && !screenShareH265FallbackNoticed) {
    screenShareH265FallbackNoticed = true;
    const label = codec === 'vp8' ? 'VP8' : 'H.264';
    void import('./voiceStore').then(({ useVoiceStore }) => {
      useVoiceStore.setState({ notice: `H.265 screen sharing isn't available in this browser, so this share uses ${label}.` });
    });
  }
  return codec;
}

function selectPreferredScreenShareVideoCodec(captureTrack: MediaStreamTrack | null): VideoCodec {
  const { screenshareCodecPreference, screenShareHardwareEncoding } = useSettingsStore.getState();
  const metadata = getScreenShareCaptureMetadata(captureTrack);
  const capabilities = getBrowserVideoCodecCapabilities();
  const codecAvailability = {
    vp8: isVideoCodecAvailable('vp8', capabilities),
    h264: isVideoCodecAvailable('h264', capabilities),
    h265: isVideoCodecAvailable('h265' as VideoCodec, capabilities),
  };
  let selectedCodec: VideoCodec = 'vp8';
  let selectionReason = 'fallback-vp8';

  if (screenshareCodecPreference === 'h265') {
    if (codecAvailability.h265) {
      selectedCodec = 'h265' as VideoCodec;
      selectionReason = 'manual-h265';
    } else if (codecAvailability.h264) {
      selectedCodec = 'h264';
      selectionReason = 'manual-h265-unavailable-fallback-h264';
    } else {
      selectionReason = 'manual-h265-unavailable-fallback-vp8';
    }
    logVoiceDebug('livekit', 'screen share codec selection', {
      preference: screenshareCodecPreference,
      selectedCodec,
      selectionReason,
      screenShareHardwareEncoding,
      sourceKind: metadata.sourceKind,
      desktopSourceType: metadata.desktopSourceType,
      codecAvailability,
      browserCapabilities: summarizeBrowserVideoCodecCapabilities(capabilities),
    }, selectionReason === 'manual-h265' ? 'info' : 'warn');
    return selectedCodec;
  }
  if (screenshareCodecPreference === 'h264') {
    if (codecAvailability.h264) {
      selectedCodec = 'h264';
      selectionReason = 'manual-h264';
    } else {
      selectionReason = 'manual-h264-unavailable-fallback-vp8';
    }
    logVoiceDebug('livekit', 'screen share codec selection', {
      preference: screenshareCodecPreference,
      selectedCodec,
      selectionReason,
      screenShareHardwareEncoding,
      sourceKind: metadata.sourceKind,
      desktopSourceType: metadata.desktopSourceType,
      codecAvailability,
      browserCapabilities: summarizeBrowserVideoCodecCapabilities(capabilities),
    }, selectionReason === 'manual-h264' ? 'info' : 'warn');
    return selectedCodec;
  }
  if (screenshareCodecPreference === 'vp8') {
    logVoiceDebug('livekit', 'screen share codec selection', {
      preference: screenshareCodecPreference,
      selectedCodec,
      selectionReason: 'manual-vp8',
      screenShareHardwareEncoding,
      sourceKind: metadata.sourceKind,
      desktopSourceType: metadata.desktopSourceType,
      codecAvailability,
      browserCapabilities: summarizeBrowserVideoCodecCapabilities(capabilities),
    });
    return 'vp8';
  }
  // Auto: GPU encoding enabled, native capture card, or non-device source all prefer hardware codecs.
  const preferHardware = screenShareHardwareEncoding
    || metadata.nativeCapture
    || metadata.sourceKind !== 'device';
  if (preferHardware) {
    // H.265 remains manual-only because browser WebRTC support is optional.
    if (codecAvailability.h264) {
      selectedCodec = 'h264';
      selectionReason = 'auto-hardware-h264';
    }
  }
  logVoiceDebug('livekit', 'screen share codec selection', {
    preference: screenshareCodecPreference,
    selectedCodec,
    selectionReason,
    screenShareHardwareEncoding,
    sourceKind: metadata.sourceKind,
    desktopSourceType: metadata.desktopSourceType,
    codecAvailability,
    browserCapabilities: summarizeBrowserVideoCodecCapabilities(capabilities),
  });
  return selectedCodec;
}

function getScreenSharePublishTarget(
  captureTrack: MediaStreamTrack | null,
  requestedHeight: number,
  requestedFps: number,
  preset: 'quality' | 'efficiency' | 'compressed' | 'catrealm' = 'quality',
): ScreenSharePublishTarget {
  const codec = selectScreenShareVideoCodec(captureTrack);
  const cappedBySoftwareH264 = codec === 'h264'
    && (requestedHeight > H264_SOFTWARE_MAX_SCREEN_SHARE_HEIGHT || requestedFps > H264_SOFTWARE_MAX_SCREEN_SHARE_FPS);
  const height = codec === 'h264'
    ? Math.min(requestedHeight, H264_SOFTWARE_MAX_SCREEN_SHARE_HEIGHT)
    : requestedHeight;
  const fps = codec === 'h264'
    ? Math.min(requestedFps, H264_SOFTWARE_MAX_SCREEN_SHARE_FPS)
    : requestedFps;

  return {
    codec,
    height,
    fps,
    encoding: getScreenShareEncoding(height, fps, preset),
    cappedBySoftwareH264,
  };
}

function notifyScreenShareVp8FallbackIfNeeded(
  publishOptions: TrackPublishOptions,
  captureTrack: MediaStreamTrack | null,
) {
  const settings = useSettingsStore.getState();
  const desktopEncodingControlsAvailable = typeof window !== 'undefined'
    && Boolean(window.electron?.setScreenShareVideoEncoding);
  if (!desktopEncodingControlsAvailable || !settings.screenShareHardwareEncoding || publishOptions.videoCodec !== 'vp8') {
    return;
  }
  const { activeModal, openModal } = useUIStore.getState();
  if (activeModal === 'screenShareVp8Fallback') return;
  openModal('screenShareVp8Fallback', {
    encoderBackend: settings.screenShareEncoderBackend,
    sourceKind: getScreenShareCaptureMetadata(captureTrack).sourceKind,
  });
}

function getScreenShareVideoPublishOptions(
  captureTrack: MediaStreamTrack | null,
  screenShareEncoding: ScreenShareEncoding,
  base: Pick<TrackPublishOptions, 'source' | 'stream' | 'name'>,
  selectedCodec?: VideoCodec,
): TrackPublishOptions {
  const settings = useSettingsStore.getState();
  const videoCodec = selectedCodec ?? selectScreenShareVideoCodec(captureTrack);
  // Capture-card/device tracks need a single high-fps sender. With H.264
  // simulcast, Chromium can sample the whole media source at the 30 fps lower
  // layer cadence even when the top encoding advertises 60 fps.
  // On Central-fallback realms the share is held to the low 'catrealm' ceiling;
  // lower simulcast layers would take a third of it from the stream viewers
  // actually watch, so publish a single layer there.
  const { activeSession, capabilityByServer } = useMediaStore.getState();
  const centralFallback = !!activeSession
    && isCentralMediaFallback(capabilityByServer[activeSession.serverUrl], activeSession.context);
  const simulcast = settings.screenShareSimulcastEnabled && !centralFallback && !isDeviceScreenShareCapture(captureTrack);
  return {
    ...base,
    screenShareEncoding,
    // Simulcast is the default because it lets low-bandwidth viewers subscribe
    // to a smaller layer. Users can turn it off to publish only the selected
    // resolution/FPS when their host or uplink cannot afford multiple layers.
    //
    // Keep backupCodec OFF. It sounds right for browser compatibility (browsers
    // can't decode H.265 over WebRTC), but enabling it triggers LiveKit's codec-
    // regression path: when an incompatible viewer subscribes it deactivates the
    // ENTIRE primary H.265 sender (all simulcast layers go active:false) to switch
    // to VP8. On this setup the sender-param reactivation then throws
    // "unimplemented parameter" and the encodings get stuck inactive → 0 fps sent,
    // capture backpressure, and a multi-second renderer/ping stall. Browser-codec
    // compatibility must be solved by codec choice (publish H.264, which all
    // browsers decode), not by backupCodec.
    backupCodec: false,
    simulcast,
    videoCodec,
    // simulcast and SVC scalability modes are mutually exclusive; each
    // simulcast encoding is implicitly L1T1.
    scalabilityMode: undefined,
    ...(simulcast
      ? {
          screenShareSimulcastLayers: getScreenShareSimulcastLayers(
            screenShareEncoding.height ?? 1080,
            screenShareEncoding.maxFramerate,
            screenShareEncoding.maxBitrate,
          ),
        }
      : {}),
    degradationPreference: settings.screenshareDegradationPreference,
  };
}

// applyConstraints() replaces the whole constraint set, so changing one
// property has to carry the others over. Otherwise a frame-rate change drops
// the size limit (capture snaps back to native resolution, e.g. 1440p into a
// 720p bitrate) and a resize drops the frame rate (Chromium falls back to its
// 30 fps screen-capture default while we still believe 60 is applied).
function applyCaptureConstraintPatch(track: MediaStreamTrack, patch: MediaTrackConstraints) {
  return track.applyConstraints({ ...track.getConstraints(), ...patch });
}

// Also holds `fps` as a minimum, so a still screen keeps sending frames.
async function applyCaptureFrameRate(track: MediaStreamTrack, fps: number) {
  await applyScreenCaptureConstraints(track, {
    ...track.getConstraints(),
    frameRate: {
      ideal: fps,
      max: fps,
    },
  }, fps);
}

function startActiveScreenShareStatsPolling(
  session: MediaSession,
  publication: LocalTrackPublication,
  captureTrack: MediaStreamTrack | null,
  screenShareEncoding: ScreenShareEncoding,
  targetHeight: number,
  maxFps: number,
) {
  stopActiveScreenShareStatsPolling();
  const captureSettings = captureTrack?.getSettings();
  const sourceWidth = captureSettings?.width ?? null;
  const sourceHeight = captureSettings?.height ?? null;
  let prevStats: VideoSenderStats | undefined;
  let prevRawStats: ScreenShareRawStatsSnapshot | null = null;
  let lowFpsStreak = 0;
  let appliedCaptureFps: number | null = null;
  let appliedSenderMaxBitrate = screenShareEncoding.maxBitrate;
  let lowEncoderFpsStreak = 0;
  let scaledDown = false;
  activeScreenShareStatsInterval = setInterval(() => {
    const lkTrack = publication.track as LocalVideoTrack | undefined;
    if (!lkTrack) return;
    void lkTrack.getSenderStats().then(async (statsArr) => {
      const s = statsArr[0];
      if (!s) return;
      const rawStats = await getScreenShareRawStats(lkTrack.sender, s.streamId, captureTrack).catch(() => null);
      const actualCaptureFps = captureTrack?.getSettings().frameRate ?? null;
      const statsIntervalSeconds = prevStats
        ? Math.max(0.001, ((s.timestamp ?? 0) - (prevStats.timestamp ?? 0)) / 1000)
        : 5;
      const mediaSourceFps = rawStats?.mediaSource?.framesPerSecond ?? null;
      const bitrateKbps = prevStats
        ? Math.round(((s.bytesSent ?? 0) - (prevStats.bytesSent ?? 0)) * 8 / (statsIntervalSeconds * 1000))
        : null;
      const fps = s.framesPerSecond ?? 0;
      const limitation = s.qualityLimitationReason ?? 'none';
      const targetKbps = s.targetBitrate ? Math.round(s.targetBitrate / 1000) : 0;
      const captureMetadata = getScreenShareCaptureMetadata(captureTrack);
      const framesSentDelta = prevStats
        ? Math.max(0, (s.framesSent ?? 0) - (prevStats.framesSent ?? 0))
        : null;
      const rawOutbound = rawStats?.outbound ?? null;
      const prevRawOutbound = prevRawStats?.outbound ?? null;
      const mediaSourceFramesDelta = numericDelta(rawStats?.mediaSource?.frames, prevRawStats?.mediaSource?.frames);
      const encodedFramesDelta = numericDelta(rawOutbound?.framesEncoded, prevRawOutbound?.framesEncoded);
      const keyFramesEncodedDelta = numericDelta(rawOutbound?.keyFramesEncoded, prevRawOutbound?.keyFramesEncoded);
      const hugeFramesSentDelta = numericDelta(rawOutbound?.hugeFramesSent, prevRawOutbound?.hugeFramesSent);
      const packetsSentDelta = numericDelta(rawOutbound?.packetsSent ?? s.packetsSent, prevRawOutbound?.packetsSent ?? prevStats?.packetsSent);
      const retransmittedPacketsDelta = numericDelta(
        rawOutbound?.retransmittedPacketsSent ?? s.retransmittedPacketsSent,
        prevRawOutbound?.retransmittedPacketsSent ?? prevStats?.retransmittedPacketsSent,
      );
      const retransmittedBytesDelta = numericDelta(rawOutbound?.retransmittedBytesSent, prevRawOutbound?.retransmittedBytesSent);
      const remotePacketsLostDelta = numericDelta(rawStats?.remoteInbound?.packetsLost ?? s.packetsLost, prevRawStats?.remoteInbound?.packetsLost ?? prevStats?.packetsLost);
      const encodeTimeDelta = numericDelta(rawOutbound?.totalEncodeTime, prevRawOutbound?.totalEncodeTime);
      const packetSendDelayDelta = numericDelta(rawOutbound?.totalPacketSendDelay, prevRawOutbound?.totalPacketSendDelay);
      const qpSumDelta = numericDelta(rawOutbound?.qpSum, prevRawOutbound?.qpSum);
      const encodedFps = ratePerSecond(encodedFramesDelta, statsIntervalSeconds);
      const sentFpsFromFrames = ratePerSecond(framesSentDelta, statsIntervalSeconds);
      const effectiveSourceFps = mediaSourceFps ?? actualCaptureFps;
      const captureExpectedFrames = mediaSourceFramesDelta !== null
        ? mediaSourceFramesDelta
        : effectiveSourceFps !== null
        ? Math.round(effectiveSourceFps * statsIntervalSeconds)
        : null;
      const estimatedCaptureToEncodeDrops = captureExpectedFrames !== null && encodedFramesDelta !== null
        ? Math.max(0, captureExpectedFrames - encodedFramesDelta)
        : null;
      const encodeMsPerFrame = msPerUnit(encodeTimeDelta, encodedFramesDelta);
      const sendDelayMsPerPacket = msPerUnit(packetSendDelayDelta, packetsSentDelta);
      const avgQp = qpSumDelta !== null && encodedFramesDelta !== null && encodedFramesDelta > 0
        ? Math.round((qpSumDelta / encodedFramesDelta) * 10) / 10
        : null;
      const retransmittedPacketPct = percent(retransmittedPacketsDelta, packetsSentDelta);
      const remotePacketLossPct = percent(
        remotePacketsLostDelta,
        packetsSentDelta !== null && remotePacketsLostDelta !== null
          ? packetsSentDelta + remotePacketsLostDelta
          : null,
      );
      const availableOutgoingBitrateKbps = rawStats?.candidatePair?.availableOutgoingBitrate
        ? Math.round(rawStats.candidatePair.availableOutgoingBitrate / 1000)
        : null;
      const senderEncodingInactive = hasInactiveScreenShareSenderEncoding(lkTrack.sender);

      if (senderEncodingInactive) {
        void applyScreenShareSenderParams(publication, {
          ...screenShareEncoding,
          maxBitrate: appliedSenderMaxBitrate,
        }, session.channelId ?? null).then((applied) => {
          logVoiceDebug('livekit', applied
            ? 'screen share sender encoding reactivated'
            : 'screen share sender encoding reactivation skipped', {
            channelId: session.channelId ?? null,
            fps,
            framesSent: s.framesSent,
            targetBitrateKbps: targetKbps,
            codec: rawStats?.codec?.mimeType ?? null,
          }, applied ? 'debug' : 'warn');
        }).catch((error) => {
          logVoiceDebug('livekit', 'screen share sender encoding reactivation failed', {
            channelId: session.channelId ?? null,
            error: error instanceof Error ? error.message : String(error),
          }, 'warn');
        });
      }

      if (captureTrack && captureTrack.readyState === 'live') {
        const canConstrainFps = canDynamicallyConstrainScreenShareCapture(captureMetadata);
        const wantedFps = canConstrainFps
          ? targetCaptureFps(targetKbps, maxFps, Math.round(appliedSenderMaxBitrate / 1000))
          : maxFps;

        if (wantedFps !== appliedCaptureFps) {
          appliedCaptureFps = wantedFps;
          if (canConstrainFps) {
            void applyCaptureFrameRate(captureTrack, wantedFps).catch(() => {});
          }
          logVoiceDebug('livekit', canConstrainFps
            ? 'screen share capture fps adjusted'
            : 'screen share capture fps retained', {
            channelId: session.channelId ?? null,
            targetKbps,
            captureFps: wantedFps,
            sourceKind: captureMetadata.sourceKind,
            desktopSourceType: captureMetadata.desktopSourceType,
            actualCaptureFps: captureTrack.getSettings().frameRate ?? null,
          });
        }

        // Scale resolution down when GCC is too low to transmit full-size keyframes.
        // A 1440p keyframe at 139 Kbps stalls for 30+ seconds; 720p is ~4× smaller.
        // Device/capture-card tracks must keep their negotiated mode. For
        // windows, only scale if the encoder is actively stalling.
        const isStalled = fps < 5 && targetKbps < 500;
        const canScaleResolution = captureMetadata.sourceKind !== 'device'
          && (captureMetadata.desktopSourceType !== 'window' || isStalled);
        const needsScaleDown = canScaleResolution
          && sourceHeight !== null && sourceHeight > CAPTURE_SCALE_DOWN_HEIGHT
          && targetKbps > 0 && targetKbps < CAPTURE_SCALE_DOWN_KBPS;
        const canRestoreScale = canScaleResolution
          && scaledDown && targetKbps >= CAPTURE_SCALE_UP_KBPS;

        if (needsScaleDown && !scaledDown) {
          scaledDown = true;
          void applyCaptureConstraintPatch(captureTrack, {
            width: { max: CAPTURE_SCALE_DOWN_WIDTH },
            height: { max: CAPTURE_SCALE_DOWN_HEIGHT },
          }).catch(() => {});
          logVoiceDebug('livekit', 'screen share resolution scaled down for low bitrate', {
            channelId: session.channelId ?? null,
            targetKbps,
            scaledTo: `${CAPTURE_SCALE_DOWN_WIDTH}x${CAPTURE_SCALE_DOWN_HEIGHT}`,
          });
        } else if (canRestoreScale && sourceWidth !== null && sourceHeight !== null) {
          scaledDown = false;
          void applyCaptureConstraintPatch(captureTrack, {
            width: { max: sourceWidth },
            height: { max: sourceHeight },
          }).catch(() => {});
          logVoiceDebug('livekit', 'screen share resolution restored', {
            channelId: session.channelId ?? null,
            targetKbps,
            restoredTo: `${sourceWidth}x${sourceHeight}`,
          });
        }
      }

      const qualityCeiling = getScreenShareEncoding(
        Math.max(sourceHeight ?? 0, targetHeight),
        maxFps,
        'quality',
      ).maxBitrate;
      const senderBelowTargetFps = maxFps >= SCREEN_SHARE_FPS_RECOVERY_MIN_TARGET
        && fps > 0
        && fps < maxFps * SCREEN_SHARE_FPS_RECOVERY_RATIO;
      // Deadlock check: encoder is producing nearly nothing despite the pipe being clear.
      const senderStalled = fps < 5 
        && availableOutgoingBitrateKbps !== null 
        && availableOutgoingBitrateKbps > 2000;

      const captureAtTargetFps = effectiveSourceFps === null
        || effectiveSourceFps >= maxFps * SCREEN_SHARE_FPS_RECOVERY_RATIO;
      const senderUsingBitrateCap = bitrateKbps !== null
        && targetKbps > 0
        && bitrateKbps >= targetKbps * SCREEN_SHARE_BITRATE_RECOVERY_RATIO;
      const canRaiseSenderCeiling = appliedSenderMaxBitrate < qualityCeiling;
      const encodeFrameBudgetMs = maxFps > 0 ? 1000 / maxFps : null;
      const diagnosticReasons: string[] = [];

      if (effectiveSourceFps !== null && effectiveSourceFps < maxFps * SCREEN_SHARE_FPS_RECOVERY_RATIO) {
        diagnosticReasons.push('capture-source-below-target-fps');
      }
      if (mediaSourceFps !== null && mediaSourceFps < maxFps * SCREEN_SHARE_FPS_RECOVERY_RATIO) {
        diagnosticReasons.push('media-source-below-target-fps');
      }
      if (
        mediaSourceFps !== null
        && actualCaptureFps !== null
        && actualCaptureFps >= maxFps * SCREEN_SHARE_FPS_RECOVERY_RATIO
        && mediaSourceFps < maxFps * SCREEN_SHARE_FPS_RECOVERY_RATIO
      ) {
        diagnosticReasons.push('capture-settings-overstate-source-fps');
      }
      if (
        estimatedCaptureToEncodeDrops !== null
        && captureExpectedFrames !== null
        && captureExpectedFrames > 0
        && estimatedCaptureToEncodeDrops >= Math.max(2, captureExpectedFrames * 0.15)
      ) {
        diagnosticReasons.push('capture-to-encoder-frame-deficit');
      }
      if (encodeMsPerFrame !== null && encodeFrameBudgetMs !== null && encodeMsPerFrame > encodeFrameBudgetMs) {
        diagnosticReasons.push('encoder-over-frame-budget');
      }
      if (limitation === 'cpu') {
        diagnosticReasons.push('webrtc-cpu-limited');
      }
      if (limitation === 'bandwidth') {
        diagnosticReasons.push(senderUsingBitrateCap ? 'bitrate-ceiling-or-bandwidth-limited' : 'webrtc-bandwidth-limited');
      }
      if (availableOutgoingBitrateKbps !== null && availableOutgoingBitrateKbps < Math.round(appliedSenderMaxBitrate / 1000 * SCREEN_SHARE_BITRATE_RECOVERY_RATIO)) {
        diagnosticReasons.push('transport-available-bitrate-below-sender-ceiling');
      }
      if ((retransmittedPacketPct ?? 0) >= 5 || (remotePacketLossPct ?? 0) >= 2) {
        diagnosticReasons.push('packet-loss-or-retransmits');
      }
      if ((s.pliCount ?? 0) > (prevStats?.pliCount ?? 0)) {
        diagnosticReasons.push('receiver-requested-keyframe-pli');
      }
      if ((s.nackCount ?? 0) > (prevStats?.nackCount ?? 0)) {
        diagnosticReasons.push('receiver-reported-missing-packets-nack');
      }
      if (senderEncodingInactive) {
        diagnosticReasons.push('sender-encoding-inactive');
      }
      const encoderImplementation = rawStats?.outbound?.encoderImplementation ?? null;
      const powerEfficientEncoder = rawStats?.outbound?.powerEfficientEncoder ?? null;
      const usingSoftwareH264 = typeof encoderImplementation === 'string'
        && encoderImplementation.toLowerCase().includes('openh264');
      if (usingSoftwareH264) {
        diagnosticReasons.push('software-h264-encoder');
      } else if (powerEfficientEncoder === false) {
        diagnosticReasons.push('encoder-not-power-efficient');
      }

      if (
        (senderBelowTargetFps || senderStalled)
        && captureAtTargetFps
        && canRaiseSenderCeiling
        && (limitation === 'bandwidth' || limitation === 'cpu' || limitation === 'none')
        && (senderUsingBitrateCap || limitation === 'cpu' || senderStalled)
      ) {
        lowEncoderFpsStreak++;
        if (lowEncoderFpsStreak >= 1) { // Reduced from 2 for faster recovery
          const previousMaxBitrate = appliedSenderMaxBitrate;
          appliedSenderMaxBitrate = Math.min(
            qualityCeiling,
            Math.ceil(appliedSenderMaxBitrate * SCREEN_SHARE_BITRATE_RECOVERY_STEP),
          );
          void applyScreenShareSenderParams(publication, {
            ...screenShareEncoding,
            maxBitrate: appliedSenderMaxBitrate,
          }, session.channelId ?? null).then((applied) => {
            logVoiceDebug('livekit', applied
              ? 'screen share encoder bitrate ceiling raised to preserve target fps'
              : 'screen share encoder bitrate ceiling raise skipped', {
              channelId: session.channelId ?? null,
              fps,
              targetFps: maxFps,
              actualCaptureFps,
              effectiveSourceFps,
              mediaSourceFps,
              targetBitrateKbps: targetKbps,
              actualBitrateKbps: bitrateKbps,
              previousMaxBitrateKbps: Math.round(previousMaxBitrate / 1000),
              nextMaxBitrateKbps: Math.round(appliedSenderMaxBitrate / 1000),
              qualityCeilingKbps: Math.round(qualityCeiling / 1000),
              qualityLimitationReason: limitation,
            }, applied ? 'debug' : 'warn');
          }).catch((error) => {
            logVoiceDebug('livekit', 'screen share encoder bitrate ceiling raise failed', {
              channelId: session.channelId ?? null,
              error: error instanceof Error ? error.message : String(error),
              previousMaxBitrateKbps: Math.round(previousMaxBitrate / 1000),
              attemptedMaxBitrateKbps: Math.round(appliedSenderMaxBitrate / 1000),
            }, 'warn');
          });
          lowEncoderFpsStreak = 0;
        }
      } else {
        lowEncoderFpsStreak = 0;
      }

      logVoiceDebug('livekit', 'screen share sender stats', {
        channelId: session.channelId ?? null,
        fps,
        framesSent: s.framesSent,
        qualityLimitationReason: limitation,
        qualityLimitationDurations: s.qualityLimitationDurations ?? null,
        targetBitrateKbps: targetKbps,
        actualBitrateKbps: bitrateKbps,
        pliCount: s.pliCount,
        nackCount: s.nackCount,
        captureFpsApplied: appliedCaptureFps,
        senderMaxBitrateKbps: Math.round(appliedSenderMaxBitrate / 1000),
        activeSenderEncodingHeight: screenShareEncoding.height,
        sourceKind: captureMetadata.sourceKind,
        desktopSourceType: captureMetadata.desktopSourceType,
        actualCaptureFps,
        effectiveSourceFps,
        framesSentDelta,
        mediaSourceFramesDelta,
        encodedFramesDelta,
        encodedFps,
        sentFpsFromFrames,
        keyFramesEncodedDelta,
        hugeFramesSentDelta,
        estimatedCaptureToEncodeDrops,
        captureExpectedFrames,
        encodeMsPerFrame,
        encodeFrameBudgetMs: encodeFrameBudgetMs !== null ? Math.round(encodeFrameBudgetMs * 10) / 10 : null,
        avgQp,
        packetsSentDelta,
        retransmittedPacketsDelta,
        retransmittedBytesDelta,
        retransmittedPacketPct,
        remotePacketsLostDelta,
        remotePacketLossPct,
        roundTripTimeMs: typeof (rawStats?.remoteInbound?.roundTripTime ?? s.roundTripTime) === 'number'
          ? Math.round((rawStats?.remoteInbound?.roundTripTime ?? s.roundTripTime ?? 0) * 1000)
          : null,
        jitterMs: typeof (rawStats?.remoteInbound?.jitter ?? s.jitter) === 'number'
          ? Math.round((rawStats?.remoteInbound?.jitter ?? s.jitter ?? 0) * 1000)
          : null,
        transportRoundTripTimeMs: typeof rawStats?.candidatePair?.currentRoundTripTime === 'number'
          ? Math.round(rawStats.candidatePair.currentRoundTripTime * 1000)
          : null,
        availableOutgoingBitrateKbps,
        outboundCodecMimeType: rawStats?.codec?.mimeType ?? null,
        outboundCodecPayloadType: rawStats?.codec?.payloadType ?? null,
        outboundCodecClockRate: rawStats?.codec?.clockRate ?? null,
        outboundCodecFmtp: rawStats?.codec?.sdpFmtpLine ?? null,
        outboundFrameSize: rawStats?.outbound?.frameWidth && rawStats?.outbound?.frameHeight
          ? `${rawStats.outbound.frameWidth}x${rawStats.outbound.frameHeight}`
          : null,
        outboundStatsFps: rawStats?.outbound?.framesPerSecond ?? null,
        encoderImplementation,
        powerEfficientEncoder,
        hardwareEncodingLikely: powerEfficientEncoder === true && !usingSoftwareH264,
        qualityLimitationResolutionChanges: rawStats?.outbound?.qualityLimitationResolutionChanges ?? null,
        senderParameters: getScreenShareSenderParameterSnapshot(lkTrack.sender),
        packetSendDelayMsPerPacket: sendDelayMsPerPacket,
        mediaSourceFps,
        mediaSourceFrames: rawStats?.mediaSource?.frames ?? null,
        mediaSourceSize: rawStats?.mediaSource?.width && rawStats?.mediaSource?.height
          ? `${rawStats.mediaSource.width}x${rawStats.mediaSource.height}`
          : null,
        diagnosticReasons,
        scaledDown,
      });

      // Capture pipeline stall: fps collapses to near-zero while the encoder reports no
      // quality limitation AND has meaningful bandwidth to work with. The encoder has
      // headroom but receives no frames. On Windows this is typically caused by the
      // captured window recreating its DirectX swap chain (e.g. shader reload), which
      // forces Windows.Graphics.Capture to reinitialize for 10-30 seconds.
      // Guard: if targetKbps is very low (<2000), fps will naturally be 0-1 due to
      // GCC cold-start — that is a bitrate issue, not a capture stall.
      if (fps < 5 && limitation === 'none' && targetKbps >= 2_000) {
        lowFpsStreak++;
        if (lowFpsStreak === 2) {
          const isWindowCapture = captureMetadata.desktopSourceType === 'window';
          logVoiceDebug('livekit', isWindowCapture
            ? 'screen share capture stall — window capture pipeline lost'
            : 'screen share capture stall — capture pipeline stopped producing frames', {
            channelId: session.channelId ?? null,
            fps,
            framesSent: s.framesSent,
            framesSentDelta,
            targetBitrateKbps: targetKbps,
            qualityLimitationReason: limitation,
            sourceKind: captureMetadata.sourceKind,
            desktopSourceType: captureMetadata.desktopSourceType,
            desktopSourceId: captureMetadata.desktopSourceId,
            hardwareEncodingLikely: false,
            diagnosis: isWindowCapture
              ? 'The selected application/window source stopped delivering fresh frames. WebRTC still reports no CPU or bandwidth limitation.'
              : 'The capture track stopped delivering fresh frames while WebRTC still reports no CPU or bandwidth limitation.',
            suggestion: isWindowCapture
              ? 'Share a Screen (full display) instead of the application window for heavy games to avoid WGC swap-chain loss.'
              : 'Restart the share or try lowering resolution/FPS if this source keeps stalling.',
          }, 'warn');
        }
      } else {
        lowFpsStreak = 0;
      }
      prevRawStats = rawStats;
      prevStats = s;
    });
  }, 2000);
}

function applyScreenShareTrackHint(track: MediaStreamTrack, fps: number) {
  if (!('contentHint' in track)) return null;
  const contentHint = fps >= 48 ? 'motion' : 'detail';
  track.contentHint = contentHint;
  return contentHint;
}

function numericDelta(current: number | undefined, previous: number | undefined) {
  if (typeof current !== 'number' || typeof previous !== 'number') return null;
  return Math.max(0, current - previous);
}

function ratePerSecond(delta: number | null, seconds: number) {
  if (delta === null) return null;
  return Math.round((delta / seconds) * 10) / 10;
}

function msPerUnit(totalSecondsDelta: number | null, unitDelta: number | null) {
  if (totalSecondsDelta === null || unitDelta === null || unitDelta <= 0) return null;
  return Math.round((totalSecondsDelta * 1000 / unitDelta) * 10) / 10;
}

function percent(numerator: number | null, denominator: number | null) {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

async function getScreenShareRawStats(
  sender: RTCRtpSender | undefined,
  streamId: string | undefined,
  captureTrack: MediaStreamTrack | null,
): Promise<ScreenShareRawStatsSnapshot> {
  if (!sender) {
    return { outbound: null, remoteInbound: null, candidatePair: null, mediaSource: null, codec: null };
  }

  const report = await sender.getStats();
  let outbound: ExtendedOutboundVideoStats | null = null;
  let remoteInbound: ExtendedRemoteInboundVideoStats | null = null;
  let candidatePair: ExtendedCandidatePairStats | null = null;
  let mediaSource: ExtendedVideoSourceStats | null = null;
  let codec: ExtendedCodecStats | null = null;
  let selectedCandidatePairId: string | undefined;

  report.forEach((entry: any) => {
    if (entry.type === 'outbound-rtp' && (entry.kind === 'video' || entry.mediaType === 'video')) {
      if (!outbound || entry.id === streamId || (entry.frameWidth ?? 0) > (outbound.frameWidth ?? 0)) {
        outbound = entry as ExtendedOutboundVideoStats;
      }
    }
    if (entry.type === 'transport' && typeof entry.selectedCandidatePairId === 'string') {
      selectedCandidatePairId = entry.selectedCandidatePairId;
    }
    if (
      entry.type === 'candidate-pair'
      && (entry.selected === true || entry.nominated === true || entry.id === selectedCandidatePairId)
      && entry.state !== 'failed'
    ) {
      candidatePair = entry as ExtendedCandidatePairStats;
    }
    if (entry.type === 'media-source' && (entry.kind === 'video' || entry.trackIdentifier === captureTrack?.id)) {
      mediaSource = entry as ExtendedVideoSourceStats;
    }
  });

  const selectedOutbound = outbound as ExtendedOutboundVideoStats | null;
  if (selectedOutbound?.remoteId) {
    const remote = report.get(selectedOutbound.remoteId);
    if (remote) remoteInbound = remote as ExtendedRemoteInboundVideoStats;
  }
  if (selectedOutbound?.codecId) {
    const codecStats = report.get(selectedOutbound.codecId);
    if (codecStats) codec = codecStats as ExtendedCodecStats;
  }

  return { outbound: selectedOutbound, remoteInbound, candidatePair, mediaSource, codec };
}

async function getScreenShareReceiverRawStats(receiver: RTCRtpReceiver | undefined | null) {
  if (!receiver) return { inbound: null, codec: null };
  const report = await receiver.getStats();
  let inbound: ExtendedInboundVideoStats | null = null;
  let codec: ExtendedCodecStats | null = null;

  report.forEach((entry: any) => {
    if (entry.type === 'inbound-rtp' && (entry.kind === 'video' || entry.mediaType === 'video')) {
      if (!inbound || (entry.frameWidth ?? 0) > (inbound.frameWidth ?? 0)) {
        inbound = entry as ExtendedInboundVideoStats;
      }
    }
  });

  const selectedInbound = inbound as ExtendedInboundVideoStats | null;
  if (selectedInbound?.codecId) {
    const codecStats = report.get(selectedInbound.codecId);
    if (codecStats) codec = codecStats as ExtendedCodecStats;
  }

  return { inbound: selectedInbound, codec };
}

function getRemoteTrackReceiver(track: RemoteTrack): RTCRtpReceiver | null {
  return ((track as RemoteTrack & { receiver?: RTCRtpReceiver }).receiver) ?? null;
}

function startRemoteScreenShareStatsPolling(
  track: RemoteTrack,
  publication: RemoteTrackPublication,
  participant: RemoteParticipant,
  source: string,
  element?: HTMLMediaElement,
) {
  if (track.kind !== Track.Kind.Video || source !== Track.Source.ScreenShare) return undefined;
  const receiver = getRemoteTrackReceiver(track);
  if (!receiver) {
    logVoiceDebug('livekit', 'screen share receiver stats unavailable', {
      channelId: useMediaStore.getState().activeSession?.channelId ?? null,
      identity: participant.identity,
      trackSid: publication.trackSid,
      reason: 'missing-rtp-receiver',
    }, 'warn');
    return undefined;
  }

  let prevInbound: ExtendedInboundVideoStats | null = null;
  const interval = setInterval(() => {
    void getScreenShareReceiverRawStats(receiver).then(({ inbound, codec }) => {
      if (!inbound) return;
      const previous = prevInbound;
      const statsIntervalSeconds = previous
        ? Math.max(0.001, ((inbound.timestamp ?? 0) - (previous.timestamp ?? 0)) / 1000)
        : 5;
      const framesReceivedDelta = numericDelta(inbound.framesReceived, previous?.framesReceived);
      const framesDecodedDelta = numericDelta(inbound.framesDecoded, previous?.framesDecoded);
      const framesDroppedDelta = numericDelta(inbound.framesDropped, previous?.framesDropped);
      const packetsReceivedDelta = numericDelta(inbound.packetsReceived, previous?.packetsReceived);
      const packetsLostDelta = numericDelta(inbound.packetsLost, previous?.packetsLost);
      const bytesReceivedDelta = numericDelta(inbound.bytesReceived, previous?.bytesReceived);
      const decodeTimeDelta = numericDelta(inbound.totalDecodeTime, previous?.totalDecodeTime);
      const jitterBufferDelayDelta = numericDelta(inbound.jitterBufferDelay, previous?.jitterBufferDelay);
      const jitterBufferEmittedDelta = numericDelta(inbound.jitterBufferEmittedCount, previous?.jitterBufferEmittedCount);
      const freezeCountDelta = numericDelta(inbound.freezeCount, previous?.freezeCount);
      const pauseCountDelta = numericDelta(inbound.pauseCount, previous?.pauseCount);
      const actualBitrateKbps = bytesReceivedDelta !== null
        ? Math.round(bytesReceivedDelta * 8 / statsIntervalSeconds / 1000)
        : null;
      const decodedFps = ratePerSecond(framesDecodedDelta, statsIntervalSeconds);
      const receivedFps = ratePerSecond(framesReceivedDelta, statsIntervalSeconds);
      const droppedFramePct = percent(framesDroppedDelta, framesReceivedDelta);
      const packetLossPct = percent(
        packetsLostDelta,
        packetsReceivedDelta !== null && packetsLostDelta !== null
          ? packetsReceivedDelta + packetsLostDelta
          : null,
      );
      const decodeMsPerFrame = msPerUnit(decodeTimeDelta, framesDecodedDelta);
      const jitterBufferMsPerFrame = msPerUnit(jitterBufferDelayDelta, jitterBufferEmittedDelta);
      const target = parseScreenShareVideoTarget(publication);
      const diagnosticReasons: string[] = [];
      if (target?.fps && decodedFps !== null && decodedFps < target.fps * SCREEN_SHARE_FPS_RECOVERY_RATIO) {
        diagnosticReasons.push('receiver-decoded-below-target-fps');
      }
      if (inbound.framesPerSecond !== undefined && target?.fps && inbound.framesPerSecond < target.fps * SCREEN_SHARE_FPS_RECOVERY_RATIO) {
        diagnosticReasons.push('receiver-stats-fps-below-target');
      }
      if ((droppedFramePct ?? 0) >= 5) {
        diagnosticReasons.push('receiver-dropping-frames');
      }
      if ((packetLossPct ?? 0) >= 2) {
        diagnosticReasons.push('receiver-packet-loss');
      }
      if ((freezeCountDelta ?? 0) > 0) {
        diagnosticReasons.push('receiver-freeze-detected');
      }

      logVoiceDebug('livekit', 'screen share receiver stats', {
        channelId: useMediaStore.getState().activeSession?.channelId ?? null,
        identity: participant.identity,
        trackSid: publication.trackSid,
        trackName: publication.trackName || null,
        targetFps: target?.fps ?? null,
        targetHeight: target?.height ?? null,
        inboundFps: inbound.framesPerSecond ?? null,
        decodedFps,
        receivedFps,
        actualBitrateKbps,
        framesReceived: inbound.framesReceived ?? null,
        framesDecoded: inbound.framesDecoded ?? null,
        framesDropped: inbound.framesDropped ?? null,
        framesReceivedDelta,
        framesDecodedDelta,
        framesDroppedDelta,
        droppedFramePct,
        packetsReceivedDelta,
        packetsLostDelta,
        packetLossPct,
        jitterMs: typeof inbound.jitter === 'number' ? Math.round(inbound.jitter * 1000) : null,
        decodeMsPerFrame,
        jitterBufferMsPerFrame,
        freezeCountDelta,
        pauseCountDelta,
        receivedSize: inbound.frameWidth && inbound.frameHeight ? `${inbound.frameWidth}x${inbound.frameHeight}` : null,
        elementSize: element instanceof HTMLVideoElement && element.videoWidth && element.videoHeight
          ? `${element.videoWidth}x${element.videoHeight}`
          : null,
        elementReadyState: element instanceof HTMLVideoElement ? element.readyState : null,
        codecMimeType: codec?.mimeType ?? null,
        codecPayloadType: codec?.payloadType ?? null,
        codecClockRate: codec?.clockRate ?? null,
        codecFmtp: codec?.sdpFmtpLine ?? null,
        diagnosticReasons,
      });

      prevInbound = inbound;
    }).catch((error) => {
      logVoiceDebug('livekit', 'screen share receiver stats failed', {
        channelId: useMediaStore.getState().activeSession?.channelId ?? null,
        identity: participant.identity,
        trackSid: publication.trackSid,
        error: error instanceof Error ? error.message : String(error),
      }, 'warn');
    });
  }, 5000);

  return interval;
}

function updateScreenShareViewerMap(
  current: Record<string, string[]>,
  targetUserId: string,
  viewerUserId: string,
  watching: boolean,
) {
  if (!targetUserId || !viewerUserId || targetUserId === viewerUserId) return current;
  const currentViewers = Array.isArray(current[targetUserId]) ? current[targetUserId] : [];
  if (watching) {
    if (currentViewers.includes(viewerUserId)) return current;
    return { ...current, [targetUserId]: [...currentViewers, viewerUserId] };
  }
  if (!currentViewers.includes(viewerUserId)) return current;
  const nextViewers = currentViewers.filter((id) => id !== viewerUserId);
  const next = { ...current };
  if (nextViewers.length > 0) next[targetUserId] = nextViewers;
  else delete next[targetUserId];
  return next;
}

function removeScreenShareViewer(current: Record<string, string[]>, viewerUserId: string) {
  let changed = false;
  const next: Record<string, string[]> = {};
  Object.entries(current).forEach(([targetUserId, viewers]) => {
    if (!Array.isArray(viewers)) {
      changed = true;
      return;
    }
    const filtered = viewers.filter((id) => id !== viewerUserId);
    if (filtered.length !== viewers.length) changed = true;
    if (targetUserId !== viewerUserId && filtered.length > 0) next[targetUserId] = filtered;
    if (targetUserId === viewerUserId) changed = true;
  });
  return changed ? next : current;
}

function replaceScreenShareViewerMap(
  current: Record<string, string[]>,
  targetUserId: string,
  viewerIds: string[],
) {
  if (!targetUserId) return current;
  const filtered = Array.from(new Set(viewerIds.filter((id) => id && id !== targetUserId)));
  const next = { ...current };
  if (filtered.length > 0) next[targetUserId] = filtered;
  else delete next[targetUserId];
  return next;
}

function parseScreenShareWatchPayload(payload: Uint8Array): ScreenShareWatchPayload | ScreenShareWatchersSnapshotPayload | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payload));
    if (parsed?.type === 'screen-share-watch') {
      if (typeof parsed.targetUserId !== 'string' || typeof parsed.watching !== 'boolean') return null;
      return parsed as ScreenShareWatchPayload;
    }
    if (parsed?.type === 'screen-share-watchers-snapshot') {
      if (typeof parsed.targetUserId !== 'string' || !Array.isArray(parsed.viewers)) return null;
      const viewers = parsed.viewers
        .map((viewer: unknown) => {
          if (!viewer || typeof viewer !== 'object') return null;
          const record = viewer as Record<string, unknown>;
          if (typeof record.id !== 'string' || typeof record.username !== 'string') return null;
          return {
            id: record.id,
            username: record.username,
            avatar: typeof record.avatar === 'string' || record.avatar === null ? record.avatar : null,
            accountType: record.accountType === 'central' || record.accountType === 'local' ? record.accountType : undefined,
          };
        })
        .filter((
          viewer: ScreenShareWatchersSnapshotPayload['viewers'][number] | null,
        ): viewer is ScreenShareWatchersSnapshotPayload['viewers'][number] => Boolean(viewer));
      return { type: 'screen-share-watchers-snapshot', targetUserId: parsed.targetUserId, viewers };
    }
    return null;
  } catch {
    return null;
  }
}

function publishScreenShareWatchersSnapshot(
  session: MediaSession,
  viewersByUser: Record<string, string[]>,
) {
  const targetUserId = session.identity;
  const viewerIds = Array.isArray(viewersByUser[targetUserId]) ? viewersByUser[targetUserId] : [];
  void import('./voiceStore').then(({ useVoiceStore }) => {
    const users = useVoiceStore.getState().users;
    const viewers = viewerIds
      .filter((id) => id && id !== targetUserId)
      .map((id) => {
        const user = users[id];
        return {
          id,
          username: user?.username ?? id,
          avatar: user?.avatar ?? null,
          accountType: user?.accountType,
        };
      });
    const payload = new TextEncoder().encode(JSON.stringify({
      type: 'screen-share-watchers-snapshot',
      targetUserId,
      viewers,
    } satisfies ScreenShareWatchersSnapshotPayload));
    void session.room.localParticipant.publishData(payload, {
      reliable: true,
      topic: LIVEKIT_SCREEN_WATCH_TOPIC,
    }).catch((error) => {
      logVoiceDebug('livekit', 'screen share watcher snapshot failed', {
        channelId: session.channelId ?? null,
        targetUserId,
        error: error instanceof Error ? error.message : String(error),
      }, 'warn');
    });
  }).catch(() => {});
}

function playConfiguredScreenShareViewerSound(soundType: SoundType, settingKey: ScreenShareViewerSoundSettingKey) {
  const settings = useSettingsStore.getState() as Record<string, any>;
  const soundsDisabled = settings.streamerMode && settings.streamerModeDisableSounds;
  if (soundsDisabled || !settings.notificationsEnabled) return;
  if (!settings[settingKey]) return;
  const volume = settings.soundVolumes?.[settingKey] ?? 60;
  playNotificationSound(soundType, volume);
}

async function applyScreenShareSenderParams(
  publication: LocalTrackPublication,
  screenShareEncoding: ScreenShareEncoding,
  channelId?: string | null,
) {
  const lkVideoTrack = publication.track as LocalVideoTrack | undefined;
  const sender = lkVideoTrack?.sender;
  if (!sender) return false;
  const sourceHeight = lkVideoTrack.mediaStreamTrack?.getSettings().height ?? null;
  const targetScale = typeof sourceHeight === 'number' && sourceHeight > screenShareEncoding.height
    ? sourceHeight / screenShareEncoding.height
    : 1;
  const before = getScreenShareSenderParameterSnapshot(sender);
  const params = sender.getParameters();
  if (!params.encodings?.length) return false;
  params.encodings.forEach((encoding) => {
    const mutableEncoding = encoding as RTCRtpEncodingParameters & {
      priority?: unknown;
      networkPriority?: unknown;
    };
    const rid = String(encoding.rid ?? '');
    const layerScale = rid === 'q'
      ? 4
      : rid === 'h'
        ? 2
        : 1;
    const scale = Math.max(1, layerScale * targetScale);
    encoding.active = true;
    encoding.maxBitrate = Math.max(350_000, Math.round(screenShareEncoding.maxBitrate / Math.max(1, layerScale * layerScale * 0.75)));
    encoding.maxFramerate = layerScale > 1 ? Math.min(screenShareEncoding.maxFramerate, 30) : screenShareEncoding.maxFramerate;
    if (scale > 1) {
      encoding.scaleResolutionDownBy = Math.round(scale * 1000) / 1000;
    }
    // Chromium returns these fields in getParameters(), but setting them can
    // throw "unimplemented parameter" and prevent maxFramerate/maxBitrate from
    // being applied.
    delete mutableEncoding.priority;
    delete mutableEncoding.networkPriority;
  });
  // Keep this as the user's/runtime preference even when we provide a sender
  // downscale hint. For software OpenH264, forcing maintain-resolution at 1080p
  // can trap the sender below target FPS instead of letting WebRTC recover.
  params.degradationPreference = useSettingsStore.getState().screenshareDegradationPreference;
  await sender.setParameters(params);
  logVoiceDebug('livekit', 'screen share sender parameters applied', {
    channelId: channelId ?? null,
    requestedEncoding: screenShareEncoding,
    sourceHeight,
    targetScale: Math.round(targetScale * 1000) / 1000,
    before,
    after: getScreenShareSenderParameterSnapshot(sender),
  });
  return true;
}

function seedScreenShareSenderParams(
  publication: LocalTrackPublication,
  screenShareEncoding: ScreenShareEncoding,
  channelId?: string | null,
) {
  void applyScreenShareSenderParams(publication, screenShareEncoding, channelId).catch((error) => {
    logVoiceDebug('livekit', 'screen share sender parameter seed failed', {
      channelId: channelId ?? null,
      error: error instanceof Error ? error.message : String(error),
      encoding: screenShareEncoding,
    }, 'warn');
  });
}

function hasInactiveScreenShareSenderEncoding(sender: RTCRtpSender | undefined | null) {
  try {
    return !!sender?.getParameters().encodings?.some((encoding) => encoding.active === false);
  } catch {
    return false;
  }
}

function getScreenShareSenderParameterSnapshot(sender: RTCRtpSender | undefined | null) {
  if (!sender) return null;
  try {
    const params = sender.getParameters();
    return {
      degradationPreference: params.degradationPreference ?? null,
      encodings: (params.encodings ?? []).map((encoding) => {
        const runtimeEncoding = encoding as RTCRtpEncodingParameters & {
          scalabilityMode?: string;
        };
        return {
          active: encoding.active ?? null,
          maxBitrate: encoding.maxBitrate ?? null,
          maxFramerate: encoding.maxFramerate ?? null,
          scaleResolutionDownBy: encoding.scaleResolutionDownBy ?? null,
          scalabilityMode: runtimeEncoding.scalabilityMode ?? null,
          rid: encoding.rid ?? null,
          priority: encoding.priority ?? null,
          networkPriority: encoding.networkPriority ?? null,
        };
      }),
      codecs: (params.codecs ?? []).map((codec) => ({
        mimeType: codec.mimeType ?? null,
        payloadType: codec.payloadType ?? null,
        clockRate: codec.clockRate ?? null,
        sdpFmtpLine: codec.sdpFmtpLine ?? null,
      })),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function publishScreenShareAudioTracks(
  session: MediaSession,
  tracks: MediaStreamTrack[],
  audioStatus: ScreenShareAudioStatus,
) {
  const publications = await Promise.all(tracks.map((track) => (
    session.room.localParticipant.publishTrack(track, {
      source: Track.Source.ScreenShareAudio,
      stream: 'screen_share',
      name: `${LIVEKIT_SCREEN_AUDIO_TRACK_NAME_PREFIX}${audioStatus.mode === 'app' ? 'app' : 'system'}`,
      audioPreset: AudioPresets.musicHighQualityStereo,
      forceStereo: true,
      dtx: false,
      red: false,
    })
  )));
  publications.forEach((publication) => {
    const publishedTrack = publication.track?.mediaStreamTrack;
    const publishedSettings = publishedTrack?.getSettings();
    logVoiceDebug('livekit', 'screen share audio published', {
      channelId: session.channelId ?? null,
      trackSid: publication.trackSid,
      source: publication.source,
      kind: publication.kind,
      trackName: publication.trackName || null,
      muted: publication.isMuted,
      channelCount: publishedSettings?.channelCount ?? null,
      sampleRate: publishedSettings?.sampleRate ?? null,
    });
  });
  return publications;
}

function getPublishedScreenShareAudioPublications(session: MediaSession) {
  const localPublications = Array.from(session.room.localParticipant.trackPublications.values())
    .filter((publication): publication is LocalTrackPublication => publication.source === Track.Source.ScreenShareAudio);
  const bySid = new Map<string, LocalTrackPublication>();
  [...activeScreenShareAudioPublications, ...localPublications].forEach((publication) => {
    if (publication.trackSid) bySid.set(publication.trackSid, publication);
  });
  return Array.from(bySid.values());
}

async function unpublishScreenShareAudioPublications(session: MediaSession, reason: string) {
  const publications = getPublishedScreenShareAudioPublications(session);
  activeScreenShareAudioPublications = [];
  await Promise.all(publications.map((publication) => {
    if (!publication.track) return Promise.resolve();
    return session.room.localParticipant.unpublishTrack(publication.track, true).catch(() => undefined);
  }));
  if (publications.length > 0) {
    logVoiceDebug('livekit', 'screen share audio unpublished', {
      channelId: session.channelId ?? null,
      reason,
      audioTrackSids: publications.map((publication) => publication.trackSid),
    });
  }
}

function applyManagedRemoteAudioState() {
  const outputDeviceId = useSettingsStore.getState().voiceOutputDeviceId;
  Object.values(useMediaStore.getState().remoteTracks).forEach((track) => {
    track.audioPlayback?.update({
      volumePct: getRemoteTrackVolumePct(track.participantId),
      muted: isScreenShareAudioTrack(track.source)
        ? false
        : isRemoteTrackMutedForVoice(track.participantId),
      outputDeviceId,
    });
  });
}

function attachRemoteTrack(track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant): RemoteMediaTrack {
  const source = getEffectivePublicationSource(publication, participant);
  if (track.kind === Track.Kind.Audio) {
    // Prefer the track's own MediaStream; fall back to constructing one from the
    // raw MediaStreamTrack so screen-share audio isn't silently dropped when
    // track.mediaStream is null at subscription time.
    const mediaStream = track.mediaStream
      ?? (track.mediaStreamTrack ? new MediaStream([track.mediaStreamTrack]) : undefined);
    const screenShareAudio = isScreenShareAudioTrack(source);
    const audioPlayback = mediaStream && !screenShareAudio
      ? playRemoteParticipantAudio({
          participantId: participant.identity,
          stream: mediaStream,
          volumePct: getRemoteTrackVolumePct(participant.identity),
          muted: isRemoteTrackMutedForVoice(participant.identity),
          outputDeviceId: useSettingsStore.getState().voiceOutputDeviceId,
        })
      : undefined;
    audioPlayback?.tryPlay();
    return {
      participantId: participant.identity,
      publicationSid: publication.trackSid,
      source,
      kind: 'audio',
      remoteTrack: track,
      subscribedAt: Date.now(),
      mediaStream,
      audioPlayback,
      screenShareAudioStatus: screenShareAudio
        ? parseScreenShareAudioStatus(publication) ?? { mode: 'system', label: 'System audio', requested: true, available: true }
        : undefined,
    };
  }

  const mediaStream = track.mediaStream
    ?? (track.mediaStreamTrack ? new MediaStream([track.mediaStreamTrack]) : undefined);
  const element = track.attach();
  element.dataset.catrealmMediaCore = 'livekit';
  element.dataset.participantId = participant.identity;
  element.dataset.source = source;
  element.autoplay = true;
  if (element instanceof HTMLAudioElement) {
    element.style.display = 'none';
  } else if (element instanceof HTMLVideoElement) {
    element.playsInline = true;
    element.muted = true; // hidden element must never emit audio; audio is managed by LiveKitScreenTile / playRemoteParticipantAudio
    element.style.display = 'none';
  }
  document.body.appendChild(element);
  void applySinkId(element, useSettingsStore.getState().voiceOutputDeviceId);
  void element.play().catch(() => {});
  const receiverStatsInterval = startRemoteScreenShareStatsPolling(track, publication, participant, source, element);

  return {
    participantId: participant.identity,
    publicationSid: publication.trackSid,
    source,
    kind: track.kind === Track.Kind.Video ? 'video' : 'audio',
    remoteTrack: track,
    subscribedAt: Date.now(),
    remotePublication: track.kind === Track.Kind.Video ? publication : undefined,
    mediaStream,
    element,
    receiverStatsInterval,
    screenShareVideoTarget: parseScreenShareVideoTarget(publication) ?? parseScreenShareParticipantVideoTarget(participant),
  };
}

function participantSnapshot(participant: Participant): MediaParticipantState {
  return {
    identity: participant.identity,
    name: participant.name || null,
    metadata: parseMetadata(participant.metadata),
    connectionQuality: participant.connectionQuality,
    unplayableScreenShareMimeType: participant.isLocal
      ? undefined
      : getUnplayableScreenShareMimeType(participant as RemoteParticipant),
  };
}

function getUnplayableScreenShareMimeType(participant: RemoteParticipant) {
  for (const publication of participant.trackPublications.values()) {
    if (getEffectivePublicationSource(publication, participant) !== Track.Source.ScreenShare) continue;
    if (publication.mimeType && !canReceiveVideoMimeType(publication.mimeType)) return publication.mimeType;
  }
  return undefined;
}

function isMissingMediaRoute(error: unknown) {
  const err = error as MediaErrorLike;
  return err?.response?.status === 404;
}

function getMediaErrorMessage(error: unknown) {
  const err = error as MediaErrorLike;
  return err?.response?.data?.error || err?.message || String(error);
}

function requestSocketCapability(serverUrl: string): Promise<MediaCapability | null> {
  return new Promise((resolve) => {
    const socket = getSocket(serverUrl);
    if (!socket?.connected) {
      resolve(null);
      return;
    }
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, 5000);
    socket.emit('media:v1:capabilities', (resp?: { ok?: boolean; capability?: MediaCapability }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!resp?.ok || !resp.capability) {
        resolve(null);
        return;
      }
      resolve(resp.capability);
    });
  });
}

function requestSocketVoiceToken(serverUrl: string, channelId: string): Promise<MediaTokenResponse | null> {
  return new Promise((resolve) => {
    const socket = getSocket(serverUrl);
    if (!socket?.connected) {
      resolve(null);
      return;
    }
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, 7000);
    socket.emit('media:v1:token', { context: 'voice', channelId }, (resp?: MediaTokenResponse & { ok?: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!resp?.ok || !resp.token || !resp.url) {
        resolve(null);
        return;
      }
      resolve(resp);
    });
  });
}

function requestSocketTheaterToken(serverUrl: string, channelId: string): Promise<MediaTokenResponse | null> {
  return new Promise((resolve) => {
    const socket = getSocket(serverUrl);
    if (!socket?.connected) {
      resolve(null);
      return;
    }
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, 7000);
    socket.emit('media:v1:token', { context: 'theater', channelId }, (resp?: MediaTokenResponse & { ok?: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!resp?.ok || !resp.token || !resp.url) {
        resolve(null);
        return;
      }
      resolve(resp);
    });
  });
}

function requestCallCapability(socket: Socket): Promise<MediaCapability | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, 5000);
    socket.emit('media:v1:capabilities', (resp?: { ok?: boolean; capability?: MediaCapability }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!resp?.ok || !resp.capability) {
        resolve(null);
        return;
      }
      resolve(resp.capability);
    });
  });
}

function requestCallToken(socket: Socket, callId: string): Promise<MediaTokenResponse | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, 7000);
    socket.emit('media:v1:token', { callId }, (resp?: MediaTokenResponse & { ok?: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!resp?.ok || !resp.token || !resp.url) {
        resolve(null);
        return;
      }
      resolve(resp);
    });
  });
}

function hasSession(state: MediaState, context: MediaContext, id?: string) {
  if (!state.activeSession || state.activeSession.context !== context) return false;
  if (!id) return true;
  return state.activeSession.channelId === id || state.activeSession.callId === id || state.activeSession.key === getSessionKey(context, id);
}

function nativeCaptureModeForSource(sourceId: string, requestedMode: ScreenShareDesktopCaptureMode): 'monitor-dxgi' | 'window-wgc' | null {
  if (sourceId.startsWith('screen:')) return 'monitor-dxgi';
  if (sourceId.startsWith('window:') && requestedMode === 'window-wgc') return 'window-wgc';
  // Sushi's WebView2 can't capture a chosen window by id: its Chromium path
  // falls back to getDisplayMedia, which shows WebView2's own picker and
  // ignores the selection. Capture windows natively there instead.
  if (sourceId.startsWith('window:') && requestedMode === 'auto' && isTauriDesktop()) return 'window-wgc';
  return null;
}

function startNativeDirectScreenPublish(
  session: MediaSession,
  sourceId: string,
  captureMode: string,
  presetOverride?: 'quality' | 'efficiency' | 'compressed' | 'catrealm',
  device?: NativeDirectPublishDevice,
): Promise<boolean> {
  if (pendingNativeDirectScreenPublish) {
    logVoiceDebug('livekit', 'native direct screen publish already starting', { channelId: session.channelId, sourceId }, 'debug');
    return pendingNativeDirectScreenPublish;
  }
  pendingNativeDirectScreenPublish = runNativeDirectScreenPublish(session, sourceId, captureMode, presetOverride, device)
    .finally(() => { pendingNativeDirectScreenPublish = null; });
  return pendingNativeDirectScreenPublish;
}

// A capture card shared through the direct publisher (captureMode 'device-dshow').
type NativeDirectPublishDevice = {
  deviceLabel: string;
  devicePath?: string | null;
  audioDeviceLabel?: string | null;
};

async function runNativeDirectScreenPublish(
  session: MediaSession,
  sourceId: string,
  captureMode: string,
  presetOverride?: 'quality' | 'efficiency' | 'compressed' | 'catrealm',
  device?: NativeDirectPublishDevice,
): Promise<boolean> {
  if (!isTauriDesktop() || !window.electron?.startNativeScreenPublish || !session.channelId) return false;
  const support = await window.electron.getNativeScreenPublishSupport?.().catch(() => null);
  if (!support?.ok) {
    logVoiceDebug('livekit', 'native direct screen publish unavailable', { reason: support?.reason ?? 'no-support', message: support?.message ?? null }, 'warn');
    return false;
  }
  let screenToken: { ok?: boolean; token?: string; url?: string } | null = null;
  try {
    const response = await createApi(session.serverUrl).post<{ ok?: boolean; token?: string; url?: string }>(
      '/api/media/screen-token',
      { context: session.context, channelId: session.channelId },
      { timeout: 8000 },
    );
    screenToken = response.data;
  } catch (err) {
    logVoiceDebug('livekit', 'native direct screen publish token failed', { message: (err as Error)?.message ?? String(err) }, 'warn');
    return false;
  }
  if (!screenToken?.ok || !screenToken.token || !screenToken.url) return false;

  const settings = useSettingsStore.getState();
  const height = settings.screenshareResolution;
  const fps = settings.screenshareFps;
  const preset = resolveScreenSharePreset(session, presetOverride);
  const encoding = getScreenShareEncoding(height, fps, preset);
  const started = await window.electron.startNativeScreenPublish({
    url: screenToken.url,
    token: screenToken.token,
    sourceId,
    captureMode,
    width: Math.round((height * 16) / 9 / 2) * 2,
    height,
    fps,
    bitrate: encoding.maxBitrate,
    preset,
    h264Profile: settings.screenShareNativeProfile,
    videoEncoder: settings.screenShareVideoEncoder ?? undefined,
    includeAudio: !device && settings.screenshareAudio,
    deviceLabel: device?.deviceLabel,
    devicePath: device?.devicePath ?? undefined,
    audioDeviceLabel: device?.audioDeviceLabel ?? undefined,
  });
  if (!started?.ok) {
    logVoiceDebug('livekit', 'native direct screen publish failed', { reason: started?.reason ?? null, message: started?.message ?? null }, 'warn');
    return false;
  }
  activeNativeScreenPublish = true;
  nativeScreenPublishStoppedListener ??= window.electron.onNativeScreenPublishStopped?.((payload) => {
    if (!activeNativeScreenPublish) return;
    activeNativeScreenPublish = false;
    logVoiceDebug('livekit', 'native direct screen publish stopped', payload, 'warn');
    useMediaStore.setState({ isScreenShareEnabled: false, localScreenShareStream: null });
  }) ?? null;
  logVoiceDebug('livekit', 'native direct screen publish started', {
    channelId: session.channelId,
    sourceId,
    captureMode,
    trackSid: started.trackSid ?? null,
    target: `${started.height ?? height}p${started.fps ?? fps}`,
    bitrate: encoding.maxBitrate,
    preset,
    audio: started.audio ?? false,
    deviceLabel: device?.deviceLabel ?? null,
  });
  return true;
}

async function requestWhipIngressSession(
  session: MediaSession,
  video?: { height: number; fps: number; bitrate?: number; simulcast?: boolean },
): Promise<WhipIngressSessionResponse | null> {
  if (!session.channelId || !['voice', 'theater'].includes(session.context)) return null;
  const api = createApi(session.serverUrl);
  try {
    const response = await api.post<WhipIngressSessionResponse>('/api/media/ingress/whip', {
      context: session.context,
      channelId: session.channelId,
      video,
    });
    return response.data?.ok ? response.data : null;
  } catch (error) {
    const maybeAxios = error as {
      message?: string;
      code?: string;
      response?: {
        status?: number;
        statusText?: string;
        data?: unknown;
      };
    };
    logVoiceDebug('livekit', 'native WHIP ingress request failed', {
      channelId: session.channelId,
      context: session.context,
      serverUrl: session.serverUrl,
      video: video ?? null,
      message: maybeAxios.message ?? String(error),
      code: maybeAxios.code ?? null,
      status: maybeAxios.response?.status ?? null,
      statusText: maybeAxios.response?.statusText ?? null,
      response: maybeAxios.response?.data ?? null,
    }, 'warn');
    return null;
  }
}

function getWhipIngressReleaseHandle(session: MediaSession, ingress: WhipIngressSessionResponse): WhipIngressReleaseHandle | null {
  if (!session.channelId || (session.context !== 'voice' && session.context !== 'theater')) return null;
  const ingressId = String(ingress.ingress?.ingressId || '').trim();
  if (!ingressId) return null;
  return {
    serverUrl: session.serverUrl,
    context: session.context,
    channelId: session.channelId,
    ingressId,
  };
}

async function releaseWhipIngressSession(handle: WhipIngressReleaseHandle, reason: string): Promise<boolean> {
  const api = createApi(handle.serverUrl);
  try {
    const response = await api.post<WhipIngressReleaseResponse>('/api/media/ingress/whip/release', {
      context: handle.context,
      channelId: handle.channelId,
      ingressId: handle.ingressId,
    }, { timeout: 5000 });
    const ok = response.data?.ok === true;
    logVoiceDebug('livekit', 'native WHIP ingress released', {
      channelId: handle.channelId,
      context: handle.context,
      ingressId: handle.ingressId,
      deleted: response.data?.deleted ?? false,
      reason,
    }, ok ? 'debug' : 'warn');
    return ok;
  } catch (error) {
    const maybeAxios = error as {
      message?: string;
      code?: string;
      response?: {
        status?: number;
        statusText?: string;
        data?: unknown;
      };
    };
    logVoiceDebug('livekit', 'native WHIP ingress release failed', {
      channelId: handle.channelId,
      context: handle.context,
      ingressId: handle.ingressId,
      reason,
      message: maybeAxios.message ?? String(error),
      code: maybeAxios.code ?? null,
      status: maybeAxios.response?.status ?? null,
      statusText: maybeAxios.response?.statusText ?? null,
      response: maybeAxios.response?.data ?? null,
    }, 'warn');
    return false;
  }
}

function nativeWhipStopLevel(payload: NativeWhipPublisherStopped): 'info' | 'warn' {
  return payload.code === 0 || payload.signal === 'SIGTERM' ? 'info' : 'warn';
}

// The call store registers this so a DM call can step aside when the same account
// joins the room from another device (the LiveKit identity is the user id).
type CallMediaReplacedListener = (call: { callId: string; callType: 'dm' | 'group' }) => void;
let callMediaReplacedListener: CallMediaReplacedListener | null = null;
export function registerOnCallMediaReplaced(listener: CallMediaReplacedListener | null) {
  callMediaReplacedListener = listener;
}

let activeScreenShareTracks: MediaStreamTrack[] = [];
let activeScreenShareStatsInterval: ReturnType<typeof setInterval> | null = null;
let activeScreenShareCaptureProbe: {
  video: HTMLVideoElement;
  interval: number;
  callbackHandle: number | null;
  stopped: boolean;
} | null = null;
let activeScreenShareVideoPublication: LocalTrackPublication | null = null;
let activeScreenShareAudioPublications: LocalTrackPublication[] = [];
let activeNativeWhipPublisherId: string | null = null;
let activeNativeWhipIngress: WhipIngressReleaseHandle | null = null;
// Sushi on Windows publishing GPU-encoded screen share straight into the room.
let activeNativeScreenPublish = false;
let nativeScreenPublishStoppedListener: (() => void) | null = null;
// One direct publish start at a time: a second start (e.g. a repeated Go Live
// while the first is still connecting) joins the pending one instead of
// opening another LiveKit connection under the same screen identity.
let pendingNativeDirectScreenPublish: Promise<boolean> | null = null;

function stopNativeScreenPublishIfActive() {
  if (!activeNativeScreenPublish) return false;
  activeNativeScreenPublish = false;
  void window.electron?.stopNativeScreenPublish?.().catch(() => undefined);
  return true;
}
let activeCameraTracks: MediaStreamTrack[] = [];

function takeActiveNativeWhipIngress() {
  const handle = activeNativeWhipIngress;
  activeNativeWhipIngress = null;
  return handle;
}

function clearActiveScreenShareTracks() {
  stopNativeScreenPublishIfActive();
  if (activeNativeWhipPublisherId) {
    const publisherId = activeNativeWhipPublisherId;
    activeNativeWhipPublisherId = null;
    void window.electron?.stopNativeWhipPublisher?.(publisherId).catch(() => undefined);
  }
  const nativeIngress = takeActiveNativeWhipIngress();
  if (nativeIngress) {
    void releaseWhipIngressSession(nativeIngress, 'clear-active-screen-share');
  }
  activeScreenShareTracks.forEach((track) => {
    try {
      track.stop();
    } catch {
      // ignore already-ended tracks
    }
  });
  activeScreenShareTracks = [];
  activeScreenShareVideoPublication = null;
  activeScreenShareAudioPublications = [];
  stopActiveScreenShareCaptureProbe();
}

function clearActiveCameraTracks() {
  activeCameraTracks.forEach((track) => {
    try {
      track.stop();
    } catch {
      // ignore already-ended tracks
    }
  });
  activeCameraTracks = [];
}

function getWebRtcUnavailableMessage(): string | null {
  if (typeof RTCPeerConnection !== 'undefined') return null;

  const isTauriRuntime = typeof window !== 'undefined'
    && Boolean((window as Window & { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown }).__TAURI__
      || (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  return isTauriRuntime
    ? 'Sushi\'s webview does not provide WebRTC, so LiveKit voice cannot connect. Use CatRealm Sparky for voice on this system.'
    : 'This browser does not provide WebRTC, so LiveKit voice cannot connect.';
}

type NativeVoiceBridge = {
  getNativeVoiceSupport: () => Promise<NativeVoiceSupport>;
  nativeVoiceConnect: (opts: { url: string; token: string; muted: boolean }) => Promise<NativeVoiceConnectResult>;
  nativeVoiceLeave: () => Promise<{ ok: boolean }>;
  nativeVoiceSetMuted: (muted: boolean) => Promise<{ ok: boolean; reason?: string }>;
  nativeVoiceSetDeafened: (deafened: boolean) => Promise<{ ok: boolean; reason?: string }>;
  onNativeVoiceEvent: (callback: (payload: NativeVoiceEvent) => void) => () => void;
};

function getNativeVoiceBridge(): NativeVoiceBridge | null {
  const api = typeof window !== 'undefined' ? window.electron : undefined;
  if (!api?.getNativeVoiceSupport || !api.nativeVoiceConnect || !api.nativeVoiceLeave
    || !api.nativeVoiceSetMuted || !api.nativeVoiceSetDeafened || !api.onNativeVoiceEvent) {
    return null;
  }
  return {
    getNativeVoiceSupport: api.getNativeVoiceSupport,
    nativeVoiceConnect: api.nativeVoiceConnect,
    nativeVoiceLeave: api.nativeVoiceLeave,
    nativeVoiceSetMuted: api.nativeVoiceSetMuted,
    nativeVoiceSetDeafened: api.nativeVoiceSetDeafened,
    onNativeVoiceEvent: api.onNativeVoiceEvent,
  };
}

async function fetchVoiceTokenSession(serverUrl: string, channelId: string): Promise<MediaTokenResponse | null> {
  const api = createApi(serverUrl);
  try {
    const response = await api.post<MediaTokenResponse>('/api/media/token', { context: 'voice', channelId });
    return response.data;
  } catch (error) {
    if (isMissingMediaRoute(error)) {
      logVoiceDebug('media-core', 'token http missing route, retrying via socket', {
        channelId,
        error: getMediaErrorMessage(error),
      }, 'warn');
    } else {
      logVoiceDebug('media-core', 'token http failed, retrying via socket', {
        channelId,
        error: getMediaErrorMessage(error),
      }, 'warn');
    }
    return requestSocketVoiceToken(serverUrl, channelId);
  }
}

export const useMediaStore = create<MediaState>((set, get) => ({
  capabilityByServer: {},
  activeSession: null,
  connectionState: ConnectionState.Disconnected,
  statusLabel: 'Disconnected',
  error: null,
  remoteTracks: {},
  participants: {},
  privacyLabel: null,
  isMicrophoneEnabled: false,
  isCameraEnabled: false,
  localCameraStream: null,
  nativeCameraPreviewUrl: null,
  nativeScreenPreviewUrl: null,
  nativeRemoteVideoFrames: {},
  isScreenShareEnabled: false,
  localScreenShareStream: null,
  screenShareViewersByUser: {},

  probeSelfHostCapability: async (serverUrl) => {
    try {
      const api = createApi(serverUrl);
      const response = await api.get<{ ok: boolean; capability: MediaCapability }>('/api/media/capabilities', { timeout: 5000 });
      const capability = response.data?.capability ?? null;
      if (capability) {
        logVoiceDebug('media-core', 'capability ok', {
          serverUrl,
          enabled: capability.enabled,
          configured: capability.configured,
          contexts: capability.contexts,
          publicUrl: capability.publicUrl,
          ingress: capability.ingress ?? null,
        });
        set((state) => ({
          capabilityByServer: { ...state.capabilityByServer, [serverUrl]: capability },
          statusLabel: toStatusLabel(get().connectionState, capability),
        }));
      }
      return capability;
    } catch (error) {
      if (isMissingMediaRoute(error)) {
        logVoiceDebug('media-core', 'capability http missing route, retrying via socket', {
          serverUrl,
          error: getMediaErrorMessage(error),
        }, 'warn');
      } else {
        logVoiceDebug('media-core', 'capability http failed, retrying via socket', {
          serverUrl,
          error: getMediaErrorMessage(error),
        }, 'warn');
      }
      const capability = await requestSocketCapability(serverUrl);
      if (capability) {
        logVoiceDebug('media-core', 'capability socket fallback ok', {
          serverUrl,
          enabled: capability.enabled,
          configured: capability.configured,
          contexts: capability.contexts,
          publicUrl: capability.publicUrl,
          ingress: capability.ingress ?? null,
        });
        set((state) => ({
          capabilityByServer: { ...state.capabilityByServer, [serverUrl]: capability },
          statusLabel: toStatusLabel(get().connectionState, capability),
          error: null,
        }));
        return capability;
      }
      logVoiceDebug('media-core', 'capability socket fallback failed', { serverUrl }, 'warn');
      set({ error: 'Failed to check media server capability.' });
      return null;
    }
  },

  joinVoice: async ({ serverUrl, channelId, muted, deafened, microphoneTrack, microphoneTrackLabel }) => {
    set({ error: null });
    logVoiceDebug('media-core', 'join voice requested', {
      serverUrl,
      channelId,
      muted,
      deafened,
      microphoneMode: microphoneTrack ? 'processed' : 'none',
      microphoneTrackLabel: microphoneTrackLabel ?? microphoneTrack?.label ?? null,
    });
    const webRtcUnavailableMessage = getWebRtcUnavailableMessage();
    if (webRtcUnavailableMessage) {
      // The webview cannot do WebRTC (Linux WebKitGTK compiles it out), but
      // the Rust process may be able to run the LiveKit room natively.
      const nativeVoice = getNativeVoiceBridge();
      const nativeSupport = nativeVoice
        ? await nativeVoice.getNativeVoiceSupport().catch(() => null)
        : null;
      if (!nativeVoice || !nativeSupport?.ok) {
        logVoiceDebug('media-core', 'join voice WebRTC unavailable', {
          channelId,
          nativeVoice: nativeSupport?.reason ?? (nativeVoice ? 'probe-failed' : 'bridge-missing'),
        }, 'warn');
        set({
          error: webRtcUnavailableMessage,
          connectionState: ConnectionState.Disconnected,
          statusLabel: 'Disconnected',
        });
        return false;
      }

      logVoiceDebug('native-voice', 'joining via native backend', { channelId, backend: nativeSupport.backend ?? null });
      const capability = await get().probeSelfHostCapability(serverUrl);
      if (!hasLiveKitPathForContext(capability, 'voice')) {
        logVoiceDebug('media-core', 'join voice unavailable', {
          channelId,
          enabled: capability?.enabled ?? false,
          contexts: capability?.contexts ?? [],
        }, 'warn');
        set({ statusLabel: toStatusLabel(ConnectionState.Disconnected, capability), privacyLabel: capability?.privacy?.label ?? null });
        return false;
      }
      const session = await fetchVoiceTokenSession(serverUrl, channelId);
      if (!session?.ok || !session.token || !session.url) return false;

      get().leave();
      const key = getSessionKey('voice', channelId);
      const unlisten = nativeVoice.onNativeVoiceEvent((event) => {
        const active = get().activeSession;
        if (!active || active.key !== key || !active.isNativeVoice) return;
        if (event.type === 'connection') {
          const state = event.state === 'connected'
            ? ConnectionState.Connected
            : event.state === 'reconnecting'
              ? ConnectionState.Reconnecting
              : ConnectionState.Disconnected;
          logVoiceDebug('native-voice', 'connection state', { channelId, state: event.state });
          set({ connectionState: state, statusLabel: toStatusLabel(state, capability) });
        } else if (event.type === 'participant-connected') {
          logVoiceDebug('native-voice', 'participant connected', { channelId, identity: event.identity, name: event.name || null });
          set((state) => ({
            participants: {
              ...state.participants,
              [event.identity]: {
                identity: event.identity,
                name: event.name || null,
                metadata: null,
                connectionQuality: ConnectionQuality.Unknown,
              },
            },
          }));
        } else if (event.type === 'participant-disconnected') {
          logVoiceDebug('native-voice', 'participant disconnected', { channelId, identity: event.identity });
          set((state) => {
            const participants = { ...state.participants };
            delete participants[event.identity];
            const nativeRemoteVideoFrames = Object.fromEntries(
              Object.entries(state.nativeRemoteVideoFrames).filter(([, frame]) => frame.identity !== event.identity),
            );
            return { participants, nativeRemoteVideoFrames };
          });
        } else if (event.type === 'active-speakers') {
          const speakingIds = new Set(event.identities);
          void import('./voiceStore').then(({ useVoiceStore }) => {
            const currentUsers = useVoiceStore.getState().users;
            Object.keys(currentUsers).forEach((userId) => {
              useVoiceStore.getState().setSpeaking(userId, speakingIds.has(userId));
            });
            });
        } else if (event.type === 'video-preview') {
          if (event.kind === 'camera') set({ nativeCameraPreviewUrl: event.dataUrl });
          else set({ nativeScreenPreviewUrl: event.dataUrl });
        } else if (event.type === 'video-preview-ended') {
          if (event.kind === 'camera') set({ nativeCameraPreviewUrl: null, isCameraEnabled: false });
          else set({ nativeScreenPreviewUrl: null, isScreenShareEnabled: false });
          void window.electron?.nativeVoiceStopVideo?.(event.kind);
        } else if (event.type === 'remote-video-frame') {
          set((state) => ({
            nativeRemoteVideoFrames: {
              ...state.nativeRemoteVideoFrames,
              [event.trackSid]: event,
            },
          }));
        } else if (event.type === 'remote-video-ended') {
          set((state) => {
            const nativeRemoteVideoFrames = { ...state.nativeRemoteVideoFrames };
            delete nativeRemoteVideoFrames[event.trackSid];
            return { nativeRemoteVideoFrames };
          });
        } else if (event.type === 'disconnected') {
          logVoiceDebug('native-voice', 'room disconnected', { channelId, reason: event.reason });
          // Release the latest base64 preview for every remote track even if
          // LiveKit disconnects before individual track-ended events arrive.
          set({
            connectionState: ConnectionState.Disconnected,
            statusLabel: 'Disconnected',
            nativeRemoteVideoFrames: {},
          });
        }
      });

      const nativeRoomStub = {
        disconnect: () => {
          try {
            unlisten();
          } catch {
            // listener already removed
          }
          void nativeVoice.nativeVoiceLeave();
        },
      } as unknown as Room;

      set({
        activeSession: {
          key,
          context: 'voice',
          serverUrl,
          channelId,
          roomName: session.roomName,
          identity: session.identity,
          room: nativeRoomStub,
          isNativeVoice: true,
          localMicrophoneTrack: null,
          localMicrophonePublication: null,
          localMicrophoneMode: 'none',
        },
        connectionState: ConnectionState.Connecting,
        statusLabel: 'Connecting',
        error: null,
        remoteTracks: {},
        nativeRemoteVideoFrames: {},
        participants: {},
        screenShareViewersByUser: {},
        privacyLabel: session.privacy?.label ?? capability?.privacy?.label ?? 'Transport encrypted, SFU routed',
      });

      const result = await nativeVoice.nativeVoiceConnect({ url: session.url, token: session.token, muted });
      if (!result.ok) {
        logVoiceDebug('native-voice', 'connect failed', { channelId, reason: result.reason, message: result.message ?? null }, 'error');
        try {
          unlisten();
        } catch {
          // listener already removed
        }
        set({
          activeSession: null,
          connectionState: ConnectionState.Disconnected,
          statusLabel: 'Disconnected',
          error: result.message ?? webRtcUnavailableMessage,
        });
        return false;
      }

      const participants: Record<string, MediaParticipantState> = {};
      result.participants.forEach((participant) => {
        participants[participant.identity] = {
          identity: participant.identity,
          name: participant.name || null,
          metadata: null,
          connectionQuality: ConnectionQuality.Unknown,
        };
      });
      participants[result.identity] = participants[result.identity] ?? {
        identity: result.identity,
        name: null,
        metadata: null,
        connectionQuality: ConnectionQuality.Unknown,
      };
      set({
        participants,
        connectionState: ConnectionState.Connected,
        statusLabel: 'Connected',
        error: null,
        isMicrophoneEnabled: !muted && result.micPublished,
      });
      if (result.micError) {
        logVoiceDebug('native-voice', 'microphone unavailable', { channelId, micError: result.micError }, 'warn');
      }
      if (deafened) void nativeVoice.nativeVoiceSetDeafened(true);
      logVoiceDebug('native-voice', 'joined via native backend', {
        channelId,
        roomName: result.roomName,
        identity: result.identity,
        micPublished: result.micPublished,
      });
      return true;
    }
    const capability = await get().probeSelfHostCapability(serverUrl);
    if (!hasLiveKitPathForContext(capability, 'voice')) {
      logVoiceDebug('media-core', 'join voice unavailable', {
        channelId,
        enabled: capability?.enabled ?? false,
        contexts: capability?.contexts ?? [],
        liveKitFallbackContexts: capability?.liveKitFallbackContexts ?? [],
      }, 'warn');
      set({ statusLabel: toStatusLabel(ConnectionState.Disconnected, capability), privacyLabel: capability?.privacy?.label ?? null });
      return false;
    }

    try {
      const session = await fetchVoiceTokenSession(serverUrl, channelId);
      if (!session?.ok || !session.token || !session.url) return false;
      logVoiceDebug('media-core', 'token ok', {
        channelId,
        roomName: session.roomName,
        identity: session.identity,
        url: session.url,
        publishSources: session.publishSources,
      });

      get().leave();
      const room = new Room({
        adaptiveStream: { pixelDensity: 1 },
        // Keep screen-share upstream warm even before a viewer opens the tile.
        // Some LiveKit/browser combinations idle screen simulcast too aggressively
        // with dynacast, which can leave the publisher stuck around 1fps.
        dynacast: false,
      });
      const key = getSessionKey('voice', channelId);

      room
        .on(RoomEvent.ConnectionStateChanged, (state) => {
          logVoiceDebug('livekit', 'connection state', { channelId, state });
          set({ connectionState: state, statusLabel: toStatusLabel(state, capability) });
        })
        .on(RoomEvent.Connected, () => {
          logVoiceDebug('livekit', 'connected', { channelId, roomName: session.roomName });
          set({ connectionState: ConnectionState.Connected, statusLabel: 'Connected', error: null });
        })
        .on(RoomEvent.Reconnecting, () => {
          logVoiceDebug('livekit', 'reconnecting', { channelId }, 'warn');
          set({ connectionState: ConnectionState.Reconnecting, statusLabel: 'Reconnecting' });
        })
        .on(RoomEvent.Reconnected, () => {
          logVoiceDebug('livekit', 'reconnected', { channelId });
          set({ connectionState: ConnectionState.Connected, statusLabel: 'Connected' });
        })
        .on(RoomEvent.Disconnected, () => {
          logVoiceDebug('livekit', 'disconnected', { channelId });
          set({ connectionState: ConnectionState.Disconnected, statusLabel: 'Disconnected' });
        })
        .on(RoomEvent.ParticipantConnected, (participant) => {
          logVoiceDebug('livekit', 'participant connected', { channelId, identity: participant.identity, name: participant.name || null });
          set((state) => ({
            participants: { ...state.participants, [participant.identity]: participantSnapshot(participant) },
          }));
          const currentSession = get().activeSession;
          if (get().isScreenShareEnabled && currentSession?.identity === session.identity) {
            publishScreenShareWatchersSnapshot(currentSession, get().screenShareViewersByUser);
          }
        })
        .on(RoomEvent.ParticipantDisconnected, (participant) => {
          logVoiceDebug('livekit', 'participant disconnected', { channelId, identity: participant.identity });
          const wasWatchingLocalShare = !!get().screenShareViewersByUser[session.identity]?.includes(participant.identity);
          if (wasWatchingLocalShare) {
            playConfiguredScreenShareViewerSound('screenshare-user-left', 'soundScreenshareUserLeft');
          }
          set((state) => {
            const participants = { ...state.participants };
            delete participants[participant.identity];
            const remoteTracks = { ...state.remoteTracks };
            for (const [trackKey, track] of Object.entries(remoteTracks)) {
              if (track.participantId !== participant.identity) continue;
              detachTrack(track);
              delete remoteTracks[trackKey];
            }
            return {
              participants,
              remoteTracks,
              screenShareViewersByUser: removeScreenShareViewer(state.screenShareViewersByUser, participant.identity),
            };
          });
        })
        .on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
          if (topic !== LIVEKIT_SCREEN_WATCH_TOPIC || !participant?.identity) return;
          const message = parseScreenShareWatchPayload(payload);
          if (!message) return;
          const currentSession = get().activeSession;
          if (message.type === 'screen-share-watchers-snapshot') {
            if (participant.identity !== message.targetUserId) return;
            set((state) => ({
              screenShareViewersByUser: replaceScreenShareViewerMap(
                state.screenShareViewersByUser,
                message.targetUserId,
                message.viewers.map((viewer) => viewer.id),
              ),
            }));
            return;
          }
          const wasWatching = !!get().screenShareViewersByUser[message.targetUserId]?.includes(participant.identity);
          if (message.targetUserId === currentSession?.identity && wasWatching !== message.watching) {
            playConfiguredScreenShareViewerSound(
              message.watching ? 'screenshare-user-join' : 'screenshare-user-left',
              message.watching ? 'soundScreenshareUserJoin' : 'soundScreenshareUserLeft',
            );
          }
          let nextViewersByUser: Record<string, string[]> | null = null;
          set((state) => {
            nextViewersByUser = updateScreenShareViewerMap(
              state.screenShareViewersByUser,
              message.targetUserId,
              participant.identity,
              message.watching,
            );
            return { screenShareViewersByUser: nextViewersByUser };
          });
          if (message.targetUserId === currentSession?.identity && currentSession && nextViewersByUser) {
            publishScreenShareWatchersSnapshot(currentSession, nextViewersByUser);
          }
        })
        .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
          const source = getEffectivePublicationSource(publication, participant);
          logVoiceDebug('livekit', 'track subscribed', {
            channelId,
            identity: participant.identity,
            trackSid: publication.trackSid,
            source,
            nativeSource: publication.source,
            kind: track.kind,
            trackName: publication.trackName || null,
          });
          const remoteTrack = attachRemoteTrack(track, publication, participant);
          set((state) => ({
            remoteTracks: upsertRemoteTrack(state.remoteTracks, remoteTrack),
          }));
        })
        .on(RoomEvent.TrackPublished, (publication, participant) => {
          const source = getEffectivePublicationSource(publication, participant);
          logVoiceDebug('livekit', 'track published', {
            channelId,
            identity: participant.identity,
            trackSid: publication.trackSid,
            source,
            nativeSource: publication.source,
            kind: publication.kind,
            trackName: publication.trackName || null,
            subscribed: publication.isSubscribed,
          });
          set((state) => ({
            participants: { ...state.participants, [participant.identity]: participantSnapshot(participant) },
          }));
        })
        .on(RoomEvent.TrackUnpublished, (publication, participant) => {
          const source = getEffectivePublicationSource(publication, participant);
          logVoiceDebug('livekit', 'track unpublished', {
            channelId,
            identity: participant.identity,
            trackSid: publication.trackSid,
            source,
            nativeSource: publication.source,
            kind: publication.kind,
            trackName: publication.trackName || null,
          });
          set((state) => ({
            remoteTracks: removeRemoteTrack(state.remoteTracks, participant.identity, publication.trackSid),
            participants: { ...state.participants, [participant.identity]: participantSnapshot(participant) },
          }));
        })
        .on(RoomEvent.TrackSubscriptionFailed, (trackSid, participant, reason) => {
          logVoiceDebug('livekit', 'track subscription failed', {
            channelId,
            identity: participant.identity,
            trackSid,
            reason: String(reason),
          }, 'warn');
        })
        .on(RoomEvent.TrackUnsubscribed, (_track, publication, participant) => {
          const source = getEffectivePublicationSource(publication, participant);
          logVoiceDebug('livekit', 'track unsubscribed', {
            channelId,
            identity: participant.identity,
            trackSid: publication.trackSid,
            source,
            nativeSource: publication.source,
          });
          set((state) => {
            const remoteTracks = removeRemoteTrack(state.remoteTracks, participant.identity, publication.trackSid);
            if (source === Track.Source.ScreenShare) {
              const screenShareViewersByUser = { ...state.screenShareViewersByUser };
              delete screenShareViewersByUser[participant.identity];
              return { remoteTracks, screenShareViewersByUser };
            }
            return { remoteTracks };
          });
        })
        .on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
          logVoiceDebug('livekit', 'connection quality', { channelId, identity: participant.identity, quality }, 'debug');
          set((state) => {
            const identity = participant.identity;
            const existing = state.participants[identity] ?? participantSnapshot(participant);
            return {
              participants: {
                ...state.participants,
                [identity]: { ...existing, connectionQuality: quality },
              },
            };
          });
        })
        .on(RoomEvent.ActiveSpeakersChanged, (participants) => {
          const speakingIds = new Set(participants.map((participant) => participant.identity));
          const voiceStore = import('./voiceStore');
          void voiceStore.then(({ useVoiceStore }) => {
            const currentUsers = useVoiceStore.getState().users;
            Object.keys(currentUsers).forEach((userId) => {
              useVoiceStore.getState().setSpeaking(userId, speakingIds.has(userId));
            });
          });
        });

      set({
        activeSession: {
          key,
          context: 'voice',
          serverUrl,
          channelId,
          roomName: session.roomName,
          identity: session.identity,
          room,
          localMicrophoneTrack: microphoneTrack ?? null,
          localMicrophonePublication: null,
          localMicrophoneMode: microphoneTrack ? 'processed' : 'none',
        },
        connectionState: ConnectionState.Connecting,
        statusLabel: 'Connecting',
        error: null,
        remoteTracks: {},
        participants: {},
        screenShareViewersByUser: {},
        privacyLabel: session.privacy?.label ?? capability?.privacy?.label ?? 'Transport encrypted, SFU routed',
      });

      await room.connect(session.url, session.token, { autoSubscribe: true });
      const participants: Record<string, MediaParticipantState> = {};
      room.remoteParticipants.forEach((participant) => {
        participants[participant.identity] = participantSnapshot(participant);
      });
      participants[room.localParticipant.identity] = participantSnapshot(room.localParticipant);
      set({ participants });

      if (microphoneTrack) {
        const publication = await room.localParticipant.publishTrack(microphoneTrack, {
          source: Track.Source.Microphone,
          stream: 'voice',
          name: microphoneTrackLabel ?? 'catrealm:voice:processed-mic',
        });
        if (muted || deafened || !microphoneTrack.enabled) {
          await publication.mute();
        }
        logVoiceDebug('livekit', 'processed microphone published', {
          channelId,
          trackSid: publication.trackSid,
          trackName: publication.trackName || null,
          muted: publication.isMuted,
          enabled: microphoneTrack.enabled,
        });
        set((state) => ({
          activeSession: state.activeSession && state.activeSession.key === key
            ? {
                ...state.activeSession,
                localMicrophonePublication: publication,
                localMicrophoneMode: 'processed',
              }
            : state.activeSession,
          isMicrophoneEnabled: !(muted || deafened || publication.isMuted),
        }));
      } else if (!muted && !deafened) {
        const deviceId = useSettingsStore.getState().voiceInputDeviceId ?? undefined;
        const publication = await room.localParticipant.setMicrophoneEnabled(true, deviceId ? { deviceId } : undefined);
        logVoiceDebug('livekit', 'microphone enabled', { channelId, deviceId: deviceId ?? 'default' });
        set((state) => ({
          activeSession: state.activeSession && state.activeSession.key === key
            ? {
                ...state.activeSession,
                localMicrophonePublication: publication ?? null,
                localMicrophoneMode: 'device',
              }
            : state.activeSession,
          isMicrophoneEnabled: true,
        }));
      } else {
        logVoiceDebug('livekit', 'microphone left disabled', { channelId, muted, deafened });
        set((state) => ({
          activeSession: state.activeSession && state.activeSession.key === key
            ? {
                ...state.activeSession,
                localMicrophonePublication: null,
                localMicrophoneMode: 'none',
              }
            : state.activeSession,
          isMicrophoneEnabled: false,
        }));
      }
      await get().setOutputDevice(useSettingsStore.getState().voiceOutputDeviceId);
      return true;
    } catch (error) {
      console.warn('[MediaCore] LiveKit voice join failed:', error);
      logVoiceDebug('media-core', 'join voice failed', { channelId, error: error instanceof Error ? error.message : String(error) }, 'error');
      get().leave('voice', channelId);
      set({ error: 'LiveKit media failed to connect.', statusLabel: 'Disconnected' });
      return false;
    }
  },

  joinTheater: async ({ serverUrl, channelId, muted, deafened }) => {
    const capability = await get().probeSelfHostCapability(serverUrl);
    if (!hasLiveKitPathForContext(capability, 'theater')) {
      set({ statusLabel: toStatusLabel(ConnectionState.Disconnected, capability), privacyLabel: capability?.privacy?.label ?? null });
      return false;
    }

    try {
      let session: MediaTokenResponse | null = null;
      const api = createApi(serverUrl);
      try {
        const response = await api.post<MediaTokenResponse>('/api/media/token', { context: 'theater', channelId });
        session = response.data;
      } catch {
        session = await requestSocketTheaterToken(serverUrl, channelId);
      }
      if (!session?.ok || !session.token || !session.url) return false;

      get().leave();
      const room = new Room({ adaptiveStream: { pixelDensity: 1 }, dynacast: false });
      const key = getSessionKey('theater', channelId);

      room
        .on(RoomEvent.ConnectionStateChanged, (state) => {
          set({ connectionState: state, statusLabel: toStatusLabel(state, capability) });
        })
        .on(RoomEvent.Connected, () => {
          set({ connectionState: ConnectionState.Connected, statusLabel: 'Connected', error: null });
        })
        .on(RoomEvent.Reconnecting, () => {
          set({ connectionState: ConnectionState.Reconnecting, statusLabel: 'Reconnecting' });
        })
        .on(RoomEvent.Reconnected, () => {
          set({ connectionState: ConnectionState.Connected, statusLabel: 'Connected' });
        })
        .on(RoomEvent.Disconnected, () => {
          set({ connectionState: ConnectionState.Disconnected, statusLabel: 'Disconnected' });
        })
        .on(RoomEvent.ParticipantConnected, (participant) => {
          set((state) => ({
            participants: { ...state.participants, [participant.identity]: participantSnapshot(participant) },
          }));
        })
        .on(RoomEvent.ParticipantDisconnected, (participant) => {
          set((state) => {
            const participants = { ...state.participants };
            delete participants[participant.identity];
            const remoteTracks = { ...state.remoteTracks };
            for (const [trackKey, track] of Object.entries(remoteTracks)) {
              if (track.participantId !== participant.identity) continue;
              detachTrack(track);
              delete remoteTracks[trackKey];
            }
            return { participants, remoteTracks };
          });
        })
        .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
          const remoteTrack = attachRemoteTrack(track, publication, participant);
          set((state) => ({
            remoteTracks: upsertRemoteTrack(state.remoteTracks, remoteTrack),
          }));
        })
        .on(RoomEvent.TrackUnpublished, (publication, participant) => {
          set((state) => ({
            remoteTracks: removeRemoteTrack(state.remoteTracks, participant.identity, publication.trackSid),
          }));
        })
        .on(RoomEvent.TrackUnsubscribed, (_track, publication, participant) => {
          set((state) => {
            const remoteTracks = removeRemoteTrack(state.remoteTracks, participant.identity, publication.trackSid);
            return { remoteTracks };
          });
        })
        .on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
          set((state) => {
            const identity = participant.identity;
            const existing = state.participants[identity] ?? participantSnapshot(participant);
            return { participants: { ...state.participants, [identity]: { ...existing, connectionQuality: quality } } };
          });
        })
        .on(RoomEvent.ActiveSpeakersChanged, (participants) => {
          const speakingIds = new Set(participants.map((p) => p.identity));
          void import('./theaterStore').then(({ useTheaterStore }) => {
            useTheaterStore.getState().users.forEach((user) => {
              useTheaterStore.getState().setSpeaking(user.id, speakingIds.has(user.id));
            });
          });
        });

      set({
        activeSession: {
          key,
          context: 'theater',
          serverUrl,
          channelId,
          roomName: session.roomName,
          identity: session.identity,
          room,
          localMicrophoneTrack: null,
          localMicrophonePublication: null,
          localMicrophoneMode: 'none',
        },
        connectionState: ConnectionState.Connecting,
        statusLabel: 'Connecting',
        error: null,
        remoteTracks: {},
        participants: {},
        screenShareViewersByUser: {},
        privacyLabel: session.privacy?.label ?? capability?.privacy?.label ?? 'Transport encrypted, SFU routed',
      });

      await room.connect(session.url, session.token, { autoSubscribe: true });
      const participants: Record<string, MediaParticipantState> = {};
      room.remoteParticipants.forEach((participant) => {
        participants[participant.identity] = participantSnapshot(participant);
      });
      participants[room.localParticipant.identity] = participantSnapshot(room.localParticipant);
      set({ participants });

      if (!muted && !deafened) {
        const deviceId = useSettingsStore.getState().voiceInputDeviceId ?? undefined;
        const publication = await room.localParticipant.setMicrophoneEnabled(true, deviceId ? { deviceId } : undefined);
        set((state) => ({
          activeSession: state.activeSession && state.activeSession.key === key
            ? { ...state.activeSession, localMicrophonePublication: publication ?? null, localMicrophoneMode: 'device' }
            : state.activeSession,
          isMicrophoneEnabled: true,
        }));
      } else {
        set((state) => ({
          activeSession: state.activeSession && state.activeSession.key === key
            ? { ...state.activeSession, localMicrophonePublication: null, localMicrophoneMode: 'none' }
            : state.activeSession,
          isMicrophoneEnabled: false,
        }));
      }
      await get().setOutputDevice(useSettingsStore.getState().voiceOutputDeviceId);
      return true;
    } catch (error) {
      console.warn('[MediaCore] LiveKit theater join failed:', error);
      get().leave('theater', channelId);
      set({ error: 'LiveKit media failed.', statusLabel: 'Disconnected' });
      return false;
    }
  },

  joinCall: async ({ socket, callId, callType, mediaType, muted, microphoneTrack, microphoneTrackLabel }) => {
    if (!socket?.connected) return false;

    const capability = await requestCallCapability(socket);
    if (!capability?.enabled || !capability.contexts.includes(callType)) {
      logVoiceDebug('media-core', 'join call unavailable', {
        callId,
        callType,
        enabled: capability?.enabled ?? false,
        contexts: capability?.contexts ?? [],
      }, 'warn');
      return false;
    }

    const session = await requestCallToken(socket, callId);
    if (!session?.ok || !session.token || !session.url) return false;

    logVoiceDebug('media-core', 'call token ok', {
      callId,
      callType,
      roomName: session.roomName,
      identity: session.identity,
      url: session.url,
    });

    try {
      get().leave();
      const room = new Room({ adaptiveStream: { pixelDensity: 1 }, dynacast: false });
      const key = getSessionKey(callType, callId);

      room
        .on(RoomEvent.ConnectionStateChanged, (state) => {
          logVoiceDebug('livekit', 'call connection state', { callId, callType, state });
          set({ connectionState: state, statusLabel: toStatusLabel(state, capability) });
        })
        .on(RoomEvent.Connected, () => {
          logVoiceDebug('livekit', 'call connected', { callId, callType, roomName: session.roomName });
          set({ connectionState: ConnectionState.Connected, statusLabel: 'Connected', error: null });
        })
        .on(RoomEvent.Reconnecting, () => {
          logVoiceDebug('livekit', 'call reconnecting', { callId, callType }, 'warn');
          set({ connectionState: ConnectionState.Reconnecting, statusLabel: 'Reconnecting' });
        })
        .on(RoomEvent.Reconnected, () => {
          logVoiceDebug('livekit', 'call reconnected', { callId, callType });
          set({ connectionState: ConnectionState.Connected, statusLabel: 'Connected' });
        })
        .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
          logVoiceDebug('livekit', 'call disconnected', { callId, callType, reason });
          set({ connectionState: ConnectionState.Disconnected, statusLabel: 'Disconnected' });
          if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
            callMediaReplacedListener?.({ callId, callType });
          }
        })
        .on(RoomEvent.ParticipantConnected, (participant) => {
          logVoiceDebug('livekit', 'call participant connected', { callId, identity: participant.identity });
          set((state) => ({
            participants: { ...state.participants, [participant.identity]: participantSnapshot(participant) },
          }));
        })
        .on(RoomEvent.ParticipantDisconnected, (participant) => {
          logVoiceDebug('livekit', 'call participant disconnected', { callId, identity: participant.identity });
          set((state) => {
            const participants = { ...state.participants };
            delete participants[participant.identity];
            const remoteTracks = { ...state.remoteTracks };
            for (const [trackKey, track] of Object.entries(remoteTracks)) {
              if (track.participantId !== participant.identity) continue;
              detachTrack(track);
              delete remoteTracks[trackKey];
            }
            return { participants, remoteTracks };
          });
        })
        .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
          const kind = track.kind === 'audio' ? 'audio' : 'video';
          const source = publication.source || Track.Source.Unknown;
          const mediaStream = track.mediaStream
            ?? (track.mediaStreamTrack ? new MediaStream([track.mediaStreamTrack]) : undefined);

          const remoteTrack: RemoteMediaTrack = {
            participantId: participant.identity,
            publicationSid: publication.trackSid,
            source,
            kind,
            remoteTrack: track,
            subscribedAt: Date.now(),
            mediaStream,
          };

          if (kind === 'audio' && mediaStream) {
            remoteTrack.audioPlayback = playRemoteParticipantAudio({
              participantId: participant.identity,
              stream: mediaStream,
              volumePct: getRemoteTrackVolumePct(participant.identity),
              muted: isRemoteTrackMutedForVoice(participant.identity),
              outputDeviceId: useSettingsStore.getState().voiceOutputDeviceId,
            });
            remoteTrack.audioPlayback?.tryPlay();
          }
          set((state) => ({ remoteTracks: upsertRemoteTrack(state.remoteTracks, remoteTrack) }));
        })
        .on(RoomEvent.TrackUnpublished, (publication, participant) => {
          set((state) => ({
            remoteTracks: removeRemoteTrack(state.remoteTracks, participant.identity, publication.trackSid),
          }));
        })
        .on(RoomEvent.TrackUnsubscribed, (_track, publication, participant) => {
          set((state) => {
            const remoteTracks = removeRemoteTrack(state.remoteTracks, participant.identity, publication.trackSid);
            return { remoteTracks };
          });
        })
        .on(RoomEvent.ActiveSpeakersChanged, (participants) => {
          const speakingIds = new Set(participants.map((participant) => participant.identity));
          void import('./callStore').then(({ useCallStore }) => {
            const state = useCallStore.getState();
            const participantIds = state.activeDMCall
              ? [state.activeDMCall.otherUserId]
              : state.activeGroupCall?.participants.map((participant) => participant.userId) ?? [];
            participantIds.forEach((userId) => {
              state.setCallSpeaking(userId, speakingIds.has(userId));
            });
          });
        });

      set({
        activeSession: {
          key,
          context: callType,
          serverUrl: '',
          callId,
          roomName: session.roomName,
          identity: session.identity,
          room,
          localMicrophoneTrack: microphoneTrack ?? null,
          localMicrophonePublication: null,
          localMicrophoneMode: microphoneTrack ? 'processed' : 'none',
        },
        connectionState: ConnectionState.Connecting,
        statusLabel: 'Connecting',
        error: null,
        remoteTracks: {},
        participants: {},
        screenShareViewersByUser: {},
        privacyLabel: session.privacy?.label ?? capability.privacy?.label ?? 'Transport encrypted, SFU routed',
      });

      await room.connect(session.url, session.token, { autoSubscribe: true });
      const participants: Record<string, MediaParticipantState> = {};
      room.remoteParticipants.forEach((participant) => {
        participants[participant.identity] = participantSnapshot(participant);
      });
      participants[room.localParticipant.identity] = participantSnapshot(room.localParticipant);
      set({ participants });

      if (microphoneTrack) {
        const publication = await room.localParticipant.publishTrack(microphoneTrack, {
          source: Track.Source.Microphone,
          stream: 'call',
          name: microphoneTrackLabel ?? 'catrealm:call:processed-mic',
        });
        if (muted || !microphoneTrack.enabled) {
          await publication.mute();
        }
        logVoiceDebug('livekit', 'call processed microphone published', {
          callId,
          trackSid: publication.trackSid,
          muted: publication.isMuted,
        });
        set((state) => ({
          activeSession: state.activeSession && state.activeSession.key === key
            ? { ...state.activeSession, localMicrophonePublication: publication, localMicrophoneMode: 'processed' }
            : state.activeSession,
          isMicrophoneEnabled: !(muted || publication.isMuted),
        }));
      } else if (!muted) {
        const deviceId = useSettingsStore.getState().voiceInputDeviceId ?? undefined;
        const publication = await room.localParticipant.setMicrophoneEnabled(true, deviceId ? { deviceId } : undefined);
        set((state) => ({
          activeSession: state.activeSession && state.activeSession.key === key
            ? { ...state.activeSession, localMicrophonePublication: publication ?? null, localMicrophoneMode: 'device' }
            : state.activeSession,
          isMicrophoneEnabled: true,
        }));
      } else {
        set((state) => ({
          activeSession: state.activeSession && state.activeSession.key === key
            ? { ...state.activeSession, localMicrophonePublication: null, localMicrophoneMode: 'none' }
            : state.activeSession,
          isMicrophoneEnabled: false,
        }));
      }

      if (mediaType === 'video') {
        try {
          const deviceId: string | undefined = undefined;
          await room.localParticipant.setCameraEnabled(true, deviceId ? { deviceId } : undefined);
          set({ isCameraEnabled: true });
          logVoiceDebug('livekit', 'call camera enabled', { callId });
        } catch {
          logVoiceDebug('livekit', 'call camera unavailable', { callId }, 'warn');
        }
      }

      await get().setOutputDevice(useSettingsStore.getState().voiceOutputDeviceId);
      return true;
    } catch (error) {
      console.warn('[MediaCore] LiveKit call join failed:', error);
      logVoiceDebug('media-core', 'join call failed', { callId, error: error instanceof Error ? error.message : String(error) }, 'error');
      get().leave(callType, callId);
      set({ error: 'LiveKit media failed to connect.', statusLabel: 'Disconnected' });
      return false;
    }
  },

  leave: (context, id) => {
    const state = get();
    if (context && !hasSession(state, context, id)) return;
    const session = state.activeSession;
    if (session) {
      logVoiceDebug('media-core', 'leave', {
        context: session.context,
        channelId: session.channelId ?? null,
        callId: session.callId ?? null,
        roomName: session.roomName,
      });
      try {
        session.room.disconnect();
      } catch {
        // ignore disconnect failures
      }
    }
    Object.values(state.remoteTracks).forEach(detachTrack);
    clearActiveScreenShareTracks();
    clearActiveCameraTracks();
    set({
      activeSession: null,
      connectionState: ConnectionState.Disconnected,
      statusLabel: 'Disconnected',
      remoteTracks: {},
      nativeRemoteVideoFrames: {},
      participants: {},
      screenShareViewersByUser: {},
      privacyLabel: null,
      isMicrophoneEnabled: false,
      isCameraEnabled: false,
      localCameraStream: null,
      nativeCameraPreviewUrl: null,
      nativeScreenPreviewUrl: null,
      isScreenShareEnabled: false,
      localScreenShareStream: null,
    });
  },

  setMicrophoneMuted: async (muted) => {
    const session = get().activeSession;
    if (!session) return;
    const enabled = !muted;
    if (session.isNativeVoice) {
      const result = await window.electron?.nativeVoiceSetMuted?.(muted);
      logVoiceDebug('native-voice', enabled ? 'microphone unmuted' : 'microphone muted', {
        channelId: session.channelId ?? null,
        ok: result?.ok ?? false,
        reason: result?.reason ?? null,
      });
      set({ isMicrophoneEnabled: enabled && (result?.ok ?? false) });
      return;
    }
    if (session.localMicrophonePublication) {
      if (session.localMicrophoneTrack) {
        session.localMicrophoneTrack.enabled = enabled;
      }
      if (enabled) {
        await session.localMicrophonePublication.unmute();
      } else {
        await session.localMicrophonePublication.mute();
      }
      logVoiceDebug('livekit', enabled ? 'processed microphone unmuted' : 'processed microphone muted', {
        context: session.context,
        channelId: session.channelId ?? null,
        trackSid: session.localMicrophonePublication.trackSid,
        mode: session.localMicrophoneMode ?? 'processed',
      });
    } else if (session.localMicrophoneTrack) {
      const publication = await session.room.localParticipant.publishTrack(session.localMicrophoneTrack, {
        source: Track.Source.Microphone,
        stream: 'voice',
        name: 'catrealm:voice:processed-mic',
      });
      if (!enabled) await publication.mute();
      set((state) => ({
        activeSession: state.activeSession && state.activeSession.key === session.key
          ? { ...state.activeSession, localMicrophonePublication: publication, localMicrophoneMode: 'processed' }
          : state.activeSession,
      }));
      logVoiceDebug('livekit', 'processed microphone published on state change', {
        context: session.context,
        channelId: session.channelId ?? null,
        trackSid: publication.trackSid,
        enabled,
      });
    } else {
      const deviceId = useSettingsStore.getState().voiceInputDeviceId ?? undefined;
      await session.room.localParticipant.setMicrophoneEnabled(enabled, deviceId ? { deviceId } : undefined);
      logVoiceDebug('livekit', enabled ? 'microphone unmuted' : 'microphone muted', {
        context: session.context,
        channelId: session.channelId ?? null,
        deviceId: deviceId ?? 'default',
      });
    }
    set({ isMicrophoneEnabled: enabled });
  },

  setDeafened: (deafened) => {
    const session = get().activeSession;
    if (session?.isNativeVoice) {
      logVoiceDebug('native-voice', deafened ? 'deafened' : 'undeafened', { channelId: session.channelId ?? null });
      void window.electron?.nativeVoiceSetDeafened?.(deafened);
      return;
    }
    logVoiceDebug('livekit', deafened ? 'deafened' : 'undeafened', { remoteTrackCount: Object.keys(get().remoteTracks).length });
    voicePlaybackSnapshot = { ...voicePlaybackSnapshot, selfDeafened: deafened };
    Object.values(get().remoteTracks).forEach((track) => {
      track.audioPlayback?.update({
        muted: isScreenShareAudioTrack(track.source)
          ? false
          : isRemoteTrackMutedForVoice(track.participantId),
      });
      if (track.element && !isScreenShareAudioTrack(track.source)) track.element.muted = deafened;
    });
  },

  setOutputDevice: async (deviceId) => {
    logVoiceDebug('livekit', 'output device', { deviceId: deviceId ?? 'default', remoteTrackCount: Object.keys(get().remoteTracks).length });
    await Promise.all(Object.values(get().remoteTracks).map((track) => {
      track.audioPlayback?.update({ outputDeviceId: deviceId });
      return track.element ? applySinkId(track.element, deviceId) : Promise.resolve();
    }));
  },

  startCamera: async (deviceId) => {
    const session = get().activeSession;
    if (!session) return;
    if (session.isNativeVoice) {
      const result = await window.electron?.nativeVoiceStartVideo?.({
        kind: 'camera', sourceId: deviceId ?? '', width: 1280, height: 720, fps: 30,
      });
      if (!result?.ok) throw new Error(result?.message || result?.reason || 'Native camera failed to start.');
      logVoiceDebug('native-voice', 'camera published', { channelId: session.channelId ?? null, trackSid: result.trackSid ?? null });
      set({ isCameraEnabled: true, localCameraStream: null, nativeCameraPreviewUrl: null });
      return;
    }
    if (activeCameraTracks.length > 0 || get().isCameraEnabled) {
      await get().stopCamera();
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
    });
    const [videoTrack] = stream.getVideoTracks();
    if (!videoTrack) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('Camera stream has no video track.');
    }
    if ('contentHint' in videoTrack) videoTrack.contentHint = 'motion';
    activeCameraTracks = [videoTrack];
    videoTrack.addEventListener('ended', () => {
      void get().stopCamera();
    }, { once: true });
    const publication = await session.room.localParticipant.publishTrack(videoTrack, {
      source: Track.Source.Camera,
      stream: 'camera',
      name: 'catrealm:voice:camera',
      videoEncoding: {
        maxBitrate: 1_500_000,
        maxFramerate: 30,
        priority: 'medium',
      },
    });
    logVoiceDebug('livekit', 'camera published', {
      channelId: session.channelId ?? null,
      trackSid: publication.trackSid,
      settings: videoTrack.getSettings(),
    });
    set({ isCameraEnabled: true, localCameraStream: stream });
  },

  stopCamera: async () => {
    const session = get().activeSession;
    if (session?.isNativeVoice) {
      await window.electron?.nativeVoiceStopVideo?.('camera');
      set({ isCameraEnabled: false, localCameraStream: null, nativeCameraPreviewUrl: null });
      return;
    }
    const tracks = [...activeCameraTracks];
    activeCameraTracks = [];
    if (session) {
      await Promise.all(tracks.map((track) => (
        session.room.localParticipant.unpublishTrack(track, true).catch(() => undefined)
      )));
    }
    tracks.forEach((track) => {
      try {
        track.stop();
      } catch {
        // ignore already-stopped tracks
      }
    });
    get().localCameraStream?.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        // ignore already-stopped tracks
      }
    });
    logVoiceDebug('livekit', 'camera stopped', { channelId: session?.channelId ?? null });
    set({ isCameraEnabled: false, localCameraStream: null, nativeCameraPreviewUrl: null });
  },

  startNativeScreenShare: async ({ sourceId, captureMode, presetOverride }) => {
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const markTiming = (phase: string, details: Record<string, unknown> = {}) => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      logVoiceDebug('livekit', 'native WHIP screen share timing', {
        phase,
        elapsedMs: Math.round(now - startedAt),
        sourceId,
        ...details,
      });
    };
    const session = get().activeSession;
    if (!session?.channelId) return false;
    const settings = useSettingsStore.getState();
    if (session.isNativeVoice) {
      const height = settings.screenshareResolution;
      const width = Math.round((height * 16) / 9 / 2) * 2;
      set({ nativeScreenPreviewUrl: null });
      const result = await window.electron?.nativeVoiceStartVideo?.({
        kind: 'screen',
        sourceId,
        width,
        height,
        fps: settings.screenshareFps,
      });
      if (!result?.ok) {
        logVoiceDebug('native-voice', 'screen share failed', {
          channelId: session.channelId,
          sourceId,
          reason: result?.reason ?? 'native-video-api-unavailable',
          message: result?.message ?? null,
        }, 'warn');
        return false;
      }
      logVoiceDebug('native-voice', 'screen share published', {
        channelId: session.channelId,
        sourceId,
        trackSid: result.trackSid ?? null,
        width: result.width ?? width,
        height: result.height ?? height,
        fps: result.fps ?? settings.screenshareFps,
        codec: result.codec ?? null,
        encoder: result.encoder ?? null,
      });
      set({ isScreenShareEnabled: true, localScreenShareStream: null });
      return true;
    }
    if (!settings.screenShareNativeWhipEnabled || !settings.screenShareHardwareEncoding) return false;
    if (!window.electron?.startNativeWhipPublisher || !window.electron?.getNativeWhipPublisherSupport) return false;

    const requestedMode = captureMode ?? settings.screenShareDesktopCaptureMode;
    const nativeCaptureMode = nativeCaptureModeForSource(sourceId, requestedMode);
    if (!nativeCaptureMode) {
      logVoiceDebug('livekit', 'native WHIP skipped', {
        channelId: session.channelId,
        sourceId,
        requestedMode,
        reason: 'source-mode-mismatch',
      }, 'debug');
      return false;
    }

    const capability = get().capabilityByServer[session.serverUrl]
      ?? await get().probeSelfHostCapability(session.serverUrl);
    markTiming('capability-ready', {
      channelId: session.channelId,
      hasWhip: !!capability?.ingress?.whip,
    });
    if (!capability?.ingress?.whip) {
      logVoiceDebug('livekit', 'native WHIP skipped', {
        channelId: session.channelId,
        sourceId,
        nativeCaptureMode,
        reason: 'server-whip-unavailable',
        capabilityIngress: capability?.ingress ?? null,
      }, 'warn');
      // No ingress (e.g. Central LiveKit fallback): Sushi on Windows can still
      // publish its GPU-encoded share straight into the room.
      const direct = await startNativeDirectScreenPublish(session, sourceId, nativeCaptureMode, presetOverride);
      if (direct) {
        set({ isScreenShareEnabled: true, localScreenShareStream: null });
        publishScreenShareWatchersSnapshot(session, get().screenShareViewersByUser);
      }
      return direct;
    }

    const support = await window.electron.getNativeWhipPublisherSupport({ forceRefresh: false });
    markTiming('support-ready', {
      channelId: session.channelId,
      ok: support.ok,
      backend: support.backend ?? null,
      reason: support.reason ?? null,
    });
    if (!support.ok) {
      logVoiceDebug('livekit', 'native WHIP skipped', {
        channelId: session.channelId,
        sourceId,
        nativeCaptureMode,
        reason: support.reason ?? 'native-publisher-unavailable',
        support,
      }, 'warn');
      return false;
    }

    if (activeScreenShareTracks.length > 0 || activeNativeWhipPublisherId || activeNativeWhipIngress || get().isScreenShareEnabled) {
      await get().stopScreenShare();
      markTiming('previous-share-stopped', { channelId: session.channelId });
    }

    const hostShareLimit = clampNativeShareHeightToHost(settings.screenshareResolution, capability);
    const targetHeight = hostShareLimit.height;
    const targetFps = settings.screenshareFps;
    if (hostShareLimit.clamped) {
      logVoiceDebug('livekit', 'native WHIP capped by host UDP buffer', {
        channelId: session.channelId,
        sourceId,
        requestedHeight: settings.screenshareResolution,
        cappedHeight: targetHeight,
        hostMaxHeight: hostShareLimit.maxHeight,
        reason: 'host-net-core-rmem-max-too-small',
      }, 'warn');
    }
    const effectivePreset = presetOverride ?? settings.screenshareQualityPreset;
    const targetEncoding = getScreenShareEncoding(targetHeight, targetFps, effectivePreset);
    markTiming('requesting-ingress', {
      channelId: session.channelId,
      targetHeight,
      targetFps,
      bitrate: targetEncoding.maxBitrate,
      preset: effectivePreset,
    });
    const ingress = await requestWhipIngressSession(session, {
      height: targetHeight,
      fps: targetFps,
      bitrate: targetEncoding.maxBitrate,
      simulcast: settings.screenShareNativeWhipSimulcastEnabled,
    });
    markTiming('ingress-ready', {
      channelId: session.channelId,
      ok: !!ingress?.whip?.url && !!ingress.whip.streamKey,
      ingressId: ingress?.ingress?.ingressId ?? null,
    });
    if (!ingress?.whip?.url || !ingress.whip.streamKey) {
      logVoiceDebug('livekit', 'native WHIP ingress request failed', {
        channelId: session.channelId,
        sourceId,
        nativeCaptureMode,
        ingress,
      }, 'warn');
      return false;
    }
    const ingressRelease = getWhipIngressReleaseHandle(session, ingress);

    const started = await window.electron.startNativeWhipPublisher({
      sourceId,
      captureMode: nativeCaptureMode,
      fps: targetFps,
      height: targetHeight,
      bitrate: targetEncoding.maxBitrate,
      preset: effectivePreset,
      h264Profile: settings.screenShareNativeProfile,
      videoEncoder: settings.screenShareVideoEncoder ?? undefined,
      includeAudio: settings.screenshareAudio,
      whip: {
        url: ingress.whip.url,
        streamKey: ingress.whip.streamKey,
      },
    });
    markTiming('publisher-start-returned', {
      channelId: session.channelId,
      ok: started.ok,
      publisherId: started.ok ? started.publisherId : null,
      backend: started.ok ? (started.backend ?? null) : null,
      argsBuiltMs: started.ok ? (started.argsBuiltMs ?? null) : null,
      spawnElapsedMs: started.ok ? (started.spawnElapsedMs ?? null) : null,
    });
    if (!started.ok) {
      logVoiceDebug('livekit', 'native WHIP publisher start failed', {
        channelId: session.channelId,
        sourceId,
        nativeCaptureMode,
        reason: started.reason,
        message: started.message ?? null,
        support: started.support ?? null,
      }, 'warn');
      if (ingressRelease) {
        void releaseWhipIngressSession(ingressRelease, 'publisher-start-failed');
      }
      return false;
    }

    activeNativeWhipPublisherId = started.publisherId;
    activeNativeWhipIngress = ingressRelease;
    activeScreenShareVideoPublication = null;
    activeScreenShareAudioPublications = [];
    stopActiveScreenShareCaptureProbe();
    stopActiveScreenShareStatsPolling();
    logVoiceDebug('livekit', 'native WHIP screen share started', {
      channelId: session.channelId,
      sourceId,
      nativeCaptureMode,
      publisherId: started.publisherId,
      ffmpegPath: started.ffmpegPath,
      requestedTarget: `${settings.screenshareResolution}p${settings.screenshareFps}`,
      effectiveTarget: `${targetHeight}p${targetFps}`,
      bitrate: targetEncoding.maxBitrate,
      codec: 'h264_nvenc',
      h264Profile: settings.screenShareNativeProfile,
      preset: effectivePreset,
      ingressId: ingress.ingress.ingressId,
      nativeWhipSimulcastRequested: settings.screenShareNativeWhipSimulcastEnabled,
      simulcast: ingress.simulcast ?? null,
      roomName: ingress.roomName,
    });
    set({ isScreenShareEnabled: true, localScreenShareStream: null });
    markTiming('ui-state-enabled', { channelId: session.channelId });
    publishScreenShareWatchersSnapshot(session, get().screenShareViewersByUser);
    return true;
  },

  startNativeDeviceShare: async ({ deviceId, deviceLabel, devicePath, audioDeviceId, audioDeviceLabel, presetOverride }) => {
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const markTiming = (phase: string, details: Record<string, unknown> = {}) => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      logVoiceDebug('livekit', 'native WHIP device timing', {
        phase,
        elapsedMs: Math.round(now - startedAt),
        deviceId,
        deviceLabel: deviceLabel ?? null,
        devicePath: devicePath ?? null,
        ...details,
      });
    };
    const session = get().activeSession;
    const settings = useSettingsStore.getState();
    logVoiceDebug('livekit', 'native WHIP device requested', {
      channelId: session?.channelId ?? null,
      sessionContext: session?.context ?? null,
      deviceId,
      deviceLabel: deviceLabel ?? null,
      devicePath: devicePath ?? null,
      audioDeviceId: audioDeviceId ?? null,
      audioDeviceLabel: audioDeviceLabel ?? null,
      nativeWhipEnabled: settings.screenShareNativeWhipEnabled,
      chromiumHardwareEncodingSetting: settings.screenShareHardwareEncoding,
      hasNativePublisherApi: !!window.electron?.startNativeWhipPublisher,
      hasNativeSupportApi: !!window.electron?.getNativeWhipPublisherSupport,
    });
    if (!session?.channelId) {
      logVoiceDebug('livekit', 'native WHIP device skipped', {
        deviceId,
        deviceLabel: deviceLabel ?? null,
        devicePath: devicePath ?? null,
        reason: 'no-active-media-session',
      }, 'warn');
      return false;
    }
    if (!settings.screenShareNativeWhipEnabled) {
      logVoiceDebug('livekit', 'native WHIP device skipped', {
        channelId: session.channelId,
        deviceId,
        deviceLabel: deviceLabel ?? null,
        devicePath: devicePath ?? null,
        reason: 'native-whip-disabled',
      }, 'warn');
      return false;
    }
    if (!window.electron?.startNativeWhipPublisher || !window.electron?.getNativeWhipPublisherSupport) {
      logVoiceDebug('livekit', 'native WHIP device skipped', {
        channelId: session.channelId,
        deviceId,
        deviceLabel: deviceLabel ?? null,
        devicePath: devicePath ?? null,
        reason: 'native-publisher-api-unavailable',
        hasNativePublisherApi: !!window.electron?.startNativeWhipPublisher,
        hasNativeSupportApi: !!window.electron?.getNativeWhipPublisherSupport,
      }, 'warn');
      return false;
    }

    const label = String(deviceLabel || '').trim();
    if (!label) {
      logVoiceDebug('livekit', 'native WHIP device skipped', {
        channelId: session.channelId,
        deviceId,
        devicePath: devicePath ?? null,
        reason: 'missing-device-label',
      }, 'debug');
      return false;
    }

    const capability = get().capabilityByServer[session.serverUrl]
      ?? await get().probeSelfHostCapability(session.serverUrl);
    markTiming('capability-ready', {
      channelId: session.channelId,
      hasWhip: !!capability?.ingress?.whip,
    });
    if (!capability?.ingress?.whip) {
      logVoiceDebug('livekit', 'native WHIP device skipped', {
        channelId: session.channelId,
        deviceId,
        deviceLabel: label,
        devicePath: devicePath ?? null,
        reason: 'server-whip-unavailable',
        capabilityIngress: capability?.ingress ?? null,
      }, 'warn');
      // Same as screens: without ingress, Sushi on Windows publishes the
      // capture card (and its audio input) straight into the room.
      const direct = await startNativeDirectScreenPublish(session, deviceId, 'device-dshow', presetOverride, {
        deviceLabel: label,
        devicePath: devicePath ?? null,
        audioDeviceLabel: audioDeviceLabel ?? null,
      });
      if (direct) {
        set({ isScreenShareEnabled: true, localScreenShareStream: null });
        publishScreenShareWatchersSnapshot(session, get().screenShareViewersByUser);
      }
      return direct;
    }

    const support = await window.electron.getNativeWhipPublisherSupport({ forceRefresh: false });
    markTiming('support-ready', {
      channelId: session.channelId,
      ok: support.ok,
      backend: support.backend ?? null,
      reason: support.reason ?? null,
    });
    if (!support.ok) {
      logVoiceDebug('livekit', 'native WHIP device skipped', {
        channelId: session.channelId,
        deviceId,
        deviceLabel: label,
        devicePath: devicePath ?? null,
        reason: support.reason ?? 'native-publisher-unavailable',
        support,
      }, 'warn');
      return false;
    }

    if (activeScreenShareTracks.length > 0 || activeNativeWhipPublisherId || activeNativeWhipIngress || get().isScreenShareEnabled) {
      await get().stopScreenShare();
      markTiming('previous-share-stopped', { channelId: session.channelId });
    }

    const hostShareLimit = clampNativeShareHeightToHost(settings.screenshareResolution, capability);
    const targetHeight = hostShareLimit.height;
    const targetWidth = Math.round((targetHeight * 16) / 9);
    const targetFps = settings.screenshareFps;
    if (hostShareLimit.clamped) {
      logVoiceDebug('livekit', 'native WHIP capped by host UDP buffer', {
        channelId: session.channelId,
        deviceId,
        devicePath: devicePath ?? null,
        requestedHeight: settings.screenshareResolution,
        cappedHeight: targetHeight,
        hostMaxHeight: hostShareLimit.maxHeight,
        reason: 'host-net-core-rmem-max-too-small',
      }, 'warn');
    }
    const effectivePreset = presetOverride ?? settings.screenshareQualityPreset;
    const targetEncoding = getScreenShareEncoding(targetHeight, targetFps, effectivePreset);
    const nativeAudioLabel = audioDeviceLabel ?? null;
    markTiming('requesting-ingress', {
      channelId: session.channelId,
      targetWidth,
      targetHeight,
      targetFps,
      bitrate: targetEncoding.maxBitrate,
      preset: effectivePreset,
    });
    const ingress = await requestWhipIngressSession(session, {
      height: targetHeight,
      fps: targetFps,
      bitrate: targetEncoding.maxBitrate,
      simulcast: false,
    });
    markTiming('ingress-ready', {
      channelId: session.channelId,
      ok: !!ingress?.whip?.url && !!ingress.whip.streamKey,
      ingressId: ingress?.ingress?.ingressId ?? null,
    });
    if (!ingress?.whip?.url || !ingress.whip.streamKey) {
      logVoiceDebug('livekit', 'native WHIP device ingress request failed', {
        channelId: session.channelId,
        deviceId,
        deviceLabel: label,
        ingress,
      }, 'warn');
      return false;
    }
    const ingressRelease = getWhipIngressReleaseHandle(session, ingress);

    const started = await window.electron.startNativeWhipPublisher({
      sourceId: `device:${deviceId}`,
      sourceName: label,
      deviceLabel: label,
      devicePath: devicePath ?? undefined,
      audioDeviceLabel: nativeAudioLabel,
      captureMode: 'device-dshow',
      width: targetWidth,
      height: targetHeight,
      fps: targetFps,
      bitrate: targetEncoding.maxBitrate,
      preset: effectivePreset,
      h264Profile: settings.screenShareNativeProfile,
      videoEncoder: settings.screenShareVideoEncoder ?? undefined,
      includeAudio: settings.screenshareAudio,
      whip: {
        url: ingress.whip.url,
        streamKey: ingress.whip.streamKey,
      },
    });
    markTiming('publisher-start-returned', {
      channelId: session.channelId,
      ok: started.ok,
      publisherId: started.ok ? started.publisherId : null,
      backend: started.ok ? (started.backend ?? null) : null,
      argsBuiltMs: started.ok ? (started.argsBuiltMs ?? null) : null,
      spawnElapsedMs: started.ok ? (started.spawnElapsedMs ?? null) : null,
    });
    if (!started.ok) {
      logVoiceDebug('livekit', 'native WHIP device publisher start failed', {
        channelId: session.channelId,
        deviceId,
        deviceLabel: label,
        devicePath: devicePath ?? null,
        audioDeviceId: audioDeviceId ?? null,
        audioDeviceLabel: audioDeviceLabel ?? null,
        reason: started.reason,
        message: started.message ?? null,
        support: started.support ?? null,
      }, 'warn');
      if (ingressRelease) {
        void releaseWhipIngressSession(ingressRelease, 'publisher-start-failed');
      }
      return false;
    }

    activeNativeWhipPublisherId = started.publisherId;
    activeNativeWhipIngress = ingressRelease;
    activeScreenShareVideoPublication = null;
    activeScreenShareAudioPublications = [];
    stopActiveScreenShareCaptureProbe();
    stopActiveScreenShareStatsPolling();
    logVoiceDebug('livekit', 'native WHIP device share started', {
      channelId: session.channelId,
      deviceId,
      deviceLabel: label,
      devicePath: devicePath ?? null,
      audioDeviceId: audioDeviceId ?? null,
      audioDeviceLabel: nativeAudioLabel,
      requestedAudioDeviceLabel: audioDeviceLabel ?? null,
      publisherId: started.publisherId,
      backend: started.backend ?? (started.ffmpegPath ? 'ffmpeg' : null),
      ffmpegPath: started.ffmpegPath,
      requestedTarget: `${settings.screenshareResolution}p${settings.screenshareFps}`,
      effectiveTarget: `${targetHeight}p${targetFps}`,
      width: targetWidth,
      bitrate: targetEncoding.maxBitrate,
      codec: 'h264_nvenc',
      h264Profile: settings.screenShareNativeProfile,
      preset: effectivePreset,
      ingressId: ingress.ingress.ingressId,
      roomName: ingress.roomName,
    });
    set({ isScreenShareEnabled: true, localScreenShareStream: null });
    markTiming('ui-state-enabled', { channelId: session.channelId });
    publishScreenShareWatchersSnapshot(session, get().screenShareViewersByUser);
    return true;
  },

  startScreenShare: async (stream, presetOverride, nativeSourceId) => {
    const session = get().activeSession;
    if (!session) return;
    if (session.isNativeVoice) {
      const settings = useSettingsStore.getState();
      const height = settings.screenshareResolution;
      const width = Math.round((height * 16) / 9 / 2) * 2;
      const result = await window.electron?.nativeVoiceStartVideo?.({
        kind: 'screen', sourceId: nativeSourceId ?? 'screen:0', width, height, fps: settings.screenshareFps,
      });
      if (!result?.ok) throw new Error(result?.message || result?.reason || 'Native screen share failed to start.');
      logVoiceDebug('native-voice', 'screen share published', { channelId: session.channelId ?? null, trackSid: result.trackSid ?? null });
      set({ isScreenShareEnabled: true, localScreenShareStream: null, nativeScreenPreviewUrl: null });
      return;
    }
    if ((activeScreenShareTracks.length > 0 || get().isScreenShareEnabled) && !stream) {
      await get().stopScreenShare();
    }
    if (stream) {
      const settings = useSettingsStore.getState();
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) throw new Error('Screen share stream has no video track.');
      const tracks: MediaStreamTrack[] = [...stream.getVideoTracks(), ...stream.getAudioTracks()];
      const audioStatus = getScreenShareAudioStatus(stream);
      await probeH264HardwareEncode();
      const screenShareTarget = getScreenSharePublishTarget(
        videoTrack,
        settings.screenshareResolution,
        settings.screenshareFps,
        resolveScreenSharePreset(session, presetOverride),
      );
      const screenShareEncoding = screenShareTarget.encoding;
      const contentHint = applyScreenShareTrackHint(videoTrack, settings.screenshareFps);
      const videoSettings = videoTrack.getSettings();
      const previousTracks = [...activeScreenShareTracks];
      const existingVideoPublication = activeScreenShareVideoPublication;
      const existingVideoTrack = existingVideoPublication?.track as LocalVideoTrack | undefined;

      if (existingVideoPublication && existingVideoTrack) {
        await existingVideoTrack.replaceTrack(videoTrack, { userProvidedTrack: true });
        seedScreenShareSenderParams(existingVideoPublication, screenShareEncoding, session.channelId ?? null);
        activeScreenShareTracks = tracks;
        await unpublishScreenShareAudioPublications(session, 'screen-share-source-switch');
        const audioPublications = await publishScreenShareAudioTracks(session, stream.getAudioTracks(), audioStatus);
        activeScreenShareAudioPublications = audioPublications;
        previousTracks.forEach((track) => {
          if (track === videoTrack || tracks.includes(track)) return;
          try {
            track.stop();
          } catch {
            // ignore already-stopped tracks
          }
        });
        logVoiceDebug('livekit', 'screen share source switched', {
          channelId: session.channelId ?? null,
          audio: stream.getAudioTracks().length > 0,
          audioMode: audioStatus.mode,
          contentHint,
          capture: {
            width: videoSettings.width ?? null,
            height: videoSettings.height ?? null,
            frameRate: videoSettings.frameRate ?? null,
          },
          encoding: screenShareEncoding,
          requestedTarget: `${settings.screenshareResolution}p${settings.screenshareFps}`,
          effectiveTarget: `${screenShareTarget.height}p${screenShareTarget.fps}`,
          cappedBySoftwareH264: screenShareTarget.cappedBySoftwareH264,
          codec: screenShareTarget.codec,
          videoTrackSid: existingVideoPublication.trackSid,
          audioTrackSids: audioPublications.map((publication) => publication.trackSid),
        });
        set({ isScreenShareEnabled: true, localScreenShareStream: stream });
        publishScreenShareWatchersSnapshot(session, get().screenShareViewersByUser);
        startActiveScreenShareCaptureProbe(session, videoTrack, screenShareTarget.fps);
        startActiveScreenShareStatsPolling(
          session,
          existingVideoPublication,
          videoTrack,
          screenShareEncoding,
          screenShareTarget.height,
          screenShareTarget.fps,
        );
        return;
      }

      if (activeScreenShareTracks.length > 0 || get().isScreenShareEnabled) {
        await get().stopScreenShare();
      }
      activeScreenShareTracks = tracks;
      const screenShareVideoPublishOptions = getScreenShareVideoPublishOptions(videoTrack, screenShareEncoding, {
        source: Track.Source.ScreenShare,
        stream: 'screen_share',
        name: `${LIVEKIT_SCREEN_VIDEO_TRACK_NAME_PREFIX}${screenShareTarget.height}p${screenShareTarget.fps}`,
      }, screenShareTarget.codec);
      const videoPublication = await session.room.localParticipant.publishTrack(videoTrack, screenShareVideoPublishOptions);
      notifyScreenShareVp8FallbackIfNeeded(screenShareVideoPublishOptions, videoTrack);
      // Seed the RTP sender's maxBitrate so the GCC probes to the full ceiling
      // immediately rather than spending ~60s ramping from its 2.5 Mbps cold start.
      // This is why Discord can start at 8 Mbps instantly — the sender parameters
      // on the RTP layer tell the congestion controller what headroom to probe for.
      seedScreenShareSenderParams(videoPublication, screenShareEncoding, session.channelId ?? null);
      activeScreenShareVideoPublication = videoPublication;
      const audioPublications = await publishScreenShareAudioTracks(session, stream.getAudioTracks(), audioStatus);
      activeScreenShareAudioPublications = audioPublications;
      logVoiceDebug('livekit', 'screen share started', {
        channelId: session.channelId ?? null,
        audio: stream.getAudioTracks().length > 0,
        audioMode: audioStatus.mode,
        source: 'captured-stream',
        contentHint,
        capture: {
          width: videoSettings.width ?? null,
          height: videoSettings.height ?? null,
          frameRate: videoSettings.frameRate ?? null,
        },
        encoding: screenShareEncoding,
        requestedTarget: `${settings.screenshareResolution}p${settings.screenshareFps}`,
        effectiveTarget: `${screenShareTarget.height}p${screenShareTarget.fps}`,
        cappedBySoftwareH264: screenShareTarget.cappedBySoftwareH264,
        codec: screenShareVideoPublishOptions.videoCodec,
        simulcast: screenShareVideoPublishOptions.simulcast ?? null,
        scalabilityMode: screenShareVideoPublishOptions.scalabilityMode ?? null,
        degradationPreference: screenShareVideoPublishOptions.degradationPreference,
        videoTrackSid: videoPublication.trackSid,
        audioTrackSids: audioPublications.map((publication) => publication.trackSid),
      });
      set({ isScreenShareEnabled: true, localScreenShareStream: stream });
      publishScreenShareWatchersSnapshot(session, get().screenShareViewersByUser);
      startActiveScreenShareCaptureProbe(session, videoTrack, screenShareTarget.fps);
      startActiveScreenShareStatsPolling(
        session,
        videoPublication,
        videoTrack,
        screenShareEncoding,
        screenShareTarget.height,
        screenShareTarget.fps,
      );
      return;
    }
    const settings = useSettingsStore.getState();
    await probeH264HardwareEncode();
    const screenShareTarget = getScreenSharePublishTarget(
      null,
      settings.screenshareResolution,
      settings.screenshareFps,
      resolveScreenSharePreset(session, presetOverride),
    );
    const screenShareEncoding = screenShareTarget.encoding;
    const screenShareVideoPublishOptions = getScreenShareVideoPublishOptions(null, screenShareEncoding, {
      source: Track.Source.ScreenShare,
      stream: 'screen_share',
      name: `${LIVEKIT_SCREEN_VIDEO_TRACK_NAME_PREFIX}${screenShareTarget.height}p${screenShareTarget.fps}`,
    }, screenShareTarget.codec);
    const videoPublication = await session.room.localParticipant.setScreenShareEnabled(true, {
      audio: settings.screenshareAudio,
      resolution: {
        width: Math.round((screenShareTarget.height * 16) / 9),
        height: screenShareTarget.height,
        frameRate: screenShareTarget.fps,
      },
    }, screenShareVideoPublishOptions);
    notifyScreenShareVp8FallbackIfNeeded(screenShareVideoPublishOptions, null);
    logVoiceDebug('livekit', 'screen share started', {
      channelId: session.channelId ?? null,
      audio: settings.screenshareAudio,
      resolution: screenShareTarget.height,
      fps: screenShareTarget.fps,
      requestedTarget: `${settings.screenshareResolution}p${settings.screenshareFps}`,
      effectiveTarget: `${screenShareTarget.height}p${screenShareTarget.fps}`,
      cappedBySoftwareH264: screenShareTarget.cappedBySoftwareH264,
      encoding: screenShareEncoding,
      codec: screenShareVideoPublishOptions.videoCodec,
      simulcast: screenShareVideoPublishOptions.simulcast ?? null,
      scalabilityMode: screenShareVideoPublishOptions.scalabilityMode ?? null,
      degradationPreference: screenShareVideoPublishOptions.degradationPreference,
    });
    set({ isScreenShareEnabled: true, localScreenShareStream: null });
    publishScreenShareWatchersSnapshot(session, get().screenShareViewersByUser);
    if (videoPublication) {
      const lkTrack = videoPublication.track as LocalVideoTrack | undefined;
      const capTrack = lkTrack?.mediaStreamTrack ?? null;
      startActiveScreenShareCaptureProbe(session, capTrack, screenShareTarget.fps);
      startActiveScreenShareStatsPolling(
        session,
        videoPublication,
        capTrack,
        screenShareEncoding,
        screenShareTarget.height,
        screenShareTarget.fps,
      );
    } else {
      stopActiveScreenShareCaptureProbe();
      stopActiveScreenShareStatsPolling();
    }
  },

  stopScreenShare: async () => {
    const session = get().activeSession;
    if (session?.isNativeVoice) {
      await window.electron?.nativeVoiceStopVideo?.('screen');
      set({ isScreenShareEnabled: false, localScreenShareStream: null, nativeScreenPreviewUrl: null, screenShareViewersByUser: {} });
      return;
    }
    const nativeDirectPublish = activeNativeScreenPublish;
    if (nativeDirectPublish) {
      activeNativeScreenPublish = false;
      await window.electron?.stopNativeScreenPublish?.().catch(() => undefined);
    }
    const nativePublisherId = activeNativeWhipPublisherId;
    const nativeIngress = takeActiveNativeWhipIngress();
    if (nativePublisherId) {
      activeNativeWhipPublisherId = null;
      await window.electron?.stopNativeWhipPublisher?.(nativePublisherId).catch(() => ({ ok: true }));
    }
    if (nativeIngress) {
      void releaseWhipIngressSession(nativeIngress, 'screen-share-stop');
    }
    if (!session) {
      clearActiveScreenShareTracks();
      set({ isScreenShareEnabled: false, localScreenShareStream: null, screenShareViewersByUser: {} });
      return;
    }
    if (activeScreenShareTracks.length > 0) {
      const tracks = [...activeScreenShareTracks];
      activeScreenShareTracks = [];
      await unpublishScreenShareAudioPublications(session, 'screen-share-stop');
      await Promise.all(tracks.map((track) => (
        session.room.localParticipant.unpublishTrack(track, true).catch(() => undefined)
      )));
      tracks.forEach((track) => {
        try {
          track.stop();
        } catch {
          // ignore already-ended tracks
        }
      });
    } else if (!nativePublisherId && !nativeDirectPublish) {
      await session.room.localParticipant.setScreenShareEnabled(false);
    }
    activeScreenShareVideoPublication = null;
    activeScreenShareAudioPublications = [];
    stopActiveScreenShareCaptureProbe();
    stopActiveScreenShareStatsPolling();
    logVoiceDebug('livekit', 'screen share stopped', { channelId: session.channelId ?? null });
    set((state) => {
      const screenShareViewersByUser = { ...state.screenShareViewersByUser };
      delete screenShareViewersByUser[session.identity];
      return { isScreenShareEnabled: false, localScreenShareStream: null, screenShareViewersByUser };
    });
  },

  setWatchingScreenShare: (targetUserId, watching) => {
    const session = get().activeSession;
    if (!session || !targetUserId || targetUserId === session.identity) return;
    const payload = new TextEncoder().encode(JSON.stringify({
      type: 'screen-share-watch',
      targetUserId,
      watching,
    } satisfies ScreenShareWatchPayload));
    void session.room.localParticipant.publishData(payload, {
      reliable: true,
      topic: LIVEKIT_SCREEN_WATCH_TOPIC,
    }).catch((error) => {
      logVoiceDebug('livekit', 'screen share watch signal failed', {
        channelId: session.channelId ?? null,
        targetUserId,
        watching,
        error: error instanceof Error ? error.message : String(error),
      }, 'warn');
    });
  },

  cleanup: () => {
    get().leave();
    set({ capabilityByServer: {}, error: null, localCameraStream: null, nativeCameraPreviewUrl: null });
  },
}));

export function isMediaCoreActiveForVoice(channelId: string | null | undefined) {
  if (!channelId) return false;
  return hasSession(useMediaStore.getState(), 'voice', channelId);
}

export function isMediaCoreActiveForTheater(channelId: string | null | undefined) {
  if (!channelId) return false;
  return hasSession(useMediaStore.getState(), 'theater', channelId);
}

if (typeof window !== 'undefined') {
  window.electron?.onNativeWhipPublisherStatus?.((payload) => {
    logVoiceDebug('livekit', 'native WHIP publisher status', {
      publisherId: payload.publisherId,
      message: payload.message,
    }, payload.level === 'warn' || payload.level === 'error' ? 'warn' : 'debug');
  });
  window.electron?.onNativeWhipPublisherStopped?.((payload) => {
    if (payload.publisherId !== activeNativeWhipPublisherId) {
      logVoiceDebug('livekit', 'native WHIP publisher stopped', {
        publisherId: payload.publisherId,
        code: payload.code,
        signal: payload.signal,
        error: payload.error ?? null,
        active: false,
      }, nativeWhipStopLevel(payload));
      return;
    }
    activeNativeWhipPublisherId = null;
    const nativeIngress = takeActiveNativeWhipIngress();
    if (nativeIngress) {
      void releaseWhipIngressSession(nativeIngress, 'publisher-exit');
    }
    stopActiveScreenShareCaptureProbe();
    stopActiveScreenShareStatsPolling();
    logVoiceDebug('livekit', 'native WHIP publisher stopped', {
      publisherId: payload.publisherId,
      code: payload.code,
      signal: payload.signal,
      error: payload.error ?? null,
      active: true,
    }, nativeWhipStopLevel(payload));
    useMediaStore.setState({ isScreenShareEnabled: false, localScreenShareStream: null });
  });
}

let lastVoiceOutputDeviceId = useSettingsStore.getState().voiceOutputDeviceId;
useSettingsStore.subscribe((state) => {
  if (state.voiceOutputDeviceId === lastVoiceOutputDeviceId) return;
  lastVoiceOutputDeviceId = state.voiceOutputDeviceId;
  void useMediaStore.getState().setOutputDevice(state.voiceOutputDeviceId);
});

if (typeof window !== 'undefined') {
  window.setTimeout(() => {
    void import('./voiceStore').then(({ useVoiceStore }) => {
      const snapshot = useVoiceStore.getState();
      voicePlaybackSnapshot = {
        selfDeafened: snapshot.selfDeafened,
        peerVolumeByUser: snapshot.peerVolumeByUser,
        users: snapshot.users,
      };
      applyManagedRemoteAudioState();
      useVoiceStore.subscribe((state) => {
        voicePlaybackSnapshot = {
          selfDeafened: state.selfDeafened,
          peerVolumeByUser: state.peerVolumeByUser,
          users: state.users,
        };
        applyManagedRemoteAudioState();
      });
    });
  }, 0);

  useBlockedUsersStore.subscribe(() => {
    applyManagedRemoteAudioState();
  });

  // Cat Lab — per-person audio taps react to the same media/blocked state.
  window.setTimeout(() => {
    void import('../lib/audioTapManager').then(({ initAudioTapManager }) => {
      initAudioTapManager();
    });
    // Cat Lab — reactive avatar packs are exchanged over the active call's room.
    void import('../lib/reactiveAvatarShare/exchange').then(({ initReactiveAvatarExchange }) => {
      initReactiveAvatarExchange();
    });
  }, 0);
}
