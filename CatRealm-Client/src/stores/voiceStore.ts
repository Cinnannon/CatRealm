import { create } from 'zustand';
import { getSocket } from '../lib/socket';
import { useSettingsStore, registerOnAudioSettingsChanged, registerOnNoiseGateThresholdChanged } from './settingsStore';
import { useServerStore } from './serverStore';
import { useAuthStore, setOnLogoutVoiceCallback } from './authStore';
import { useChannelStore } from './channelStore';
import { useUIStore } from './uiStore';
import { PERMISSIONS, hasChannelPermission } from '../utils/permissions';
import { buildAudioPipeline, rebuildAudioPipeline, type AudioPipeline } from '../lib/audioProcessing';
import { clearRealtimeReconnectTarget } from '../lib/realtimeReconnect';
import { playNotificationSound, type SoundType } from '../lib/notificationSounds';
import { logVoiceDebug, logVoiceDebugAwaitable } from '../lib/voiceDebugConsole';
import { isMediaCoreActiveForVoice, useMediaStore } from './mediaStore';
import { captureScreenShare } from '../lib/desktopCapture';
import type { RtcE2eeStatus } from '../lib/rtcE2ee';
import { checkInsecureRealmMedia } from '../lib/insecureRealmMedia';
import {
  CONNECT_TO_VOICE_PERMISSION_MESSAGE,
  isConnectToVoicePermissionError,
} from '../lib/voicePermissionErrors';

// Module-level audio pipeline state (outside the Zustand store to avoid
// serialization and to allow destroy() calls during cleanup).
let activeVoicePipeline: AudioPipeline | null = null;
let activeVoiceRawStream: MediaStream | null = null;

// Resume the AudioContext whenever the page becomes visible or focused again.
// Chrome (and Electron) can suspend AudioContexts when backgrounded/minimized,
// which silences the AudioWorklet pipeline and causes 0 bytes to be sent over RTC.
// visibilitychange covers browser tabs; window focus covers Electron windows.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      activeVoicePipeline?.resume();
    }
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => {
    activeVoicePipeline?.resume();
  });
}

export type VoiceUser = {
  id: string;
  username: string;
  avatar: string | null;
  roleColor: string | null;
  isOwner: boolean;
  status?: 'online' | 'away' | 'sleeping' | 'invisible';
  accountType?: 'local' | 'central';
  muted: boolean;
  deafened: boolean;
};

// Stub type kept for UI backward-compat (VoiceStatusPanel reads peers map).
// Peers are always empty in the LiveKit world; this type is never instantiated.
type VoicePeer = {
  stream: MediaStream | null;
  screenStream: MediaStream | null;
  rtcUiState: 'pending' | 'rtc-connecting' | 'connected' | 'failed';
  e2eeMode: 'encrypted' | 'plaintext';
};

type VoiceShareOptions = {
  kind?: 'desktop' | 'device';
  sourceId?: string;
  deviceId?: string;
  deviceLabel?: string | null;
  devicePath?: string | null;
  audioDeviceId?: string | null;
  audioDeviceLabel?: string | null;
};
type VoiceJoinOptions = { allowNoMicrophone?: boolean; acknowledgedInsecureRealm?: boolean };

// Kept for socket binding compat — useSocket.ts passes this type to handleSignal.
export type VoiceSignal =
  | { type: 'offer'; sdp: RTCSessionDescriptionInit; sessionId?: string; e2ee?: boolean }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit; sessionId?: string; e2ee?: boolean }
  | { type: 'candidate'; candidate: RTCIceCandidateInit; sessionId?: string }
  | { type: 'e2ee-key'; sessionId: string; pub: string; version: 2 };

interface VoiceState {
  activeChannelId: string | null;
  pendingChannelId: string | null;
  selfVoiceUserId: string | null;
  voiceServerUrl: string | null;
  voiceChannelName: string | null;
  voiceServerName: string | null;
  users: Record<string, VoiceUser>;
  voiceCounts: Record<string, number>;
  voiceRoomUsers: Record<string, VoiceUser[]>;
  voiceRoomStartedAt: Record<string, number>;
  liveUserIdsByChannel: Record<string, string[]>;
  peers: Record<string, VoicePeer>;
  e2eeSupported: boolean;
  e2eeByPeer: Record<string, RtcE2eeStatus>;
  localStream: MediaStream | null;
  selfMuted: boolean;
  selfDeafened: boolean;
  mutedBeforeDeafen: boolean;
  pushToTalkPressed: boolean;
  peerVolumeByUser: Record<string, number>;
  connecting: boolean;
  error: string | null;
  notice: string | null;
  lastEvent: string | null;
  lastEventAt: number | null;
  speakingByUser: Record<string, boolean>;
  screenStream: MediaStream | null;
  isSharing: boolean;
  lastShareOpts: VoiceShareOptions | null;
  setLastEvent: (event: string) => void;
  setSpeaking: (userId: string, speaking: boolean) => void;
  setPeerVolume: (userId: string, volumePct: number) => void;
  clearPeerVolumes: () => void;
  loadCentralPeerVolumes: () => Promise<void>;
  startShare: (opts?: VoiceShareOptions) => Promise<void>;
  stopShare: (reason?: 'manual' | 'ended') => void;
  restartShare: () => Promise<void>;

  joinVoice: (channelId: string, options?: VoiceJoinOptions) => Promise<void>;
  leaveVoice: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  pressPushToTalk: () => void;
  releasePushToTalk: () => void;
  handleUsers: (payload: { channelId: string; users: VoiceUser[]; you: string; startedAt?: number | null; liveUserIds?: string[] }) => void;
  handleUserJoined: (payload: { channelId: string; user: VoiceUser }) => void;
  handleUserLeft: (payload: { channelId: string; userId: string }) => void;
  handleUserState: (payload: { channelId: string; userId: string; muted: boolean; deafened: boolean }) => void;
  handleUserSync: (payload: { channelId: string; users: VoiceUser[]; liveUserIds?: string[] }) => void;
  handleRoomCount: (payload: { channelId: string; count: number; startedAt?: number | null }) => void;
  handleRoomSync: (payload: { channelId: string; users: VoiceUser[]; startedAt?: number | null; liveUserIds?: string[] }) => void;
  handleRoomsSnapshot: (payload: { rooms: Array<{ channelId: string; count: number; users?: VoiceUser[]; startedAt?: number | null; liveUserIds?: string[] }> }) => void;
  handleLiveSync: (payload: { channelId: string; userIds: string[] }) => void;
  handleSignal: (payload: { channelId: string; from: string; data: VoiceSignal }) => void;
  cleanup: () => void;
}

async function captureVoiceScreenShareStream(opts?: VoiceShareOptions): Promise<MediaStream | null> {
  const { screenshareFps, screenshareResolution, screenshareAudio } = useSettingsStore.getState();
  await logVoiceDebugAwaitable('livekit', 'screen-share: captureVoiceScreenShareStream enter', {
    kind: opts?.kind ?? 'none',
    hasDeviceId: !!(opts as { deviceId?: string } | undefined)?.deviceId,
    deviceLabel: (opts as { deviceLabel?: string | null } | undefined)?.deviceLabel ?? null,
    devicePath: (opts as { devicePath?: string | null } | undefined)?.devicePath ?? null,
    audioDeviceLabel: (opts as { audioDeviceLabel?: string | null } | undefined)?.audioDeviceLabel ?? null,
    screenshareFps,
    screenshareResolution,
    screenshareAudio,
  });
  const height = screenshareResolution;
  const width = Math.round((screenshareResolution * 16) / 9);
  const isElectron = Boolean(window.electron?.getDesktopSources);
  if (opts?.kind === 'device' && opts.deviceId) {
    const result = await captureScreenShare({
      kind: 'device',
      deviceId: opts.deviceId,
      audioDeviceId: typeof opts.audioDeviceId === 'string' ? opts.audioDeviceId : undefined,
      width,
      height,
      frameRate: screenshareFps,
      includeAudio: opts.audioDeviceId === undefined ? screenshareAudio : opts.audioDeviceId !== null,
    });
    return result.stream;
  }
  if (isElectron) {
    if (!opts?.sourceId) {
      useVoiceStore.setState({ error: 'Select a screen or window to share.' });
      return null;
    }
    const result = await captureScreenShare({
      kind: 'desktop',
      sourceId: opts.sourceId,
      width,
      height,
      frameRate: screenshareFps,
      includeAudio: screenshareAudio,
    });
    return result.stream;
  }
  const isSecureContext = typeof window !== 'undefined' && window.isSecureContext;
  if (!isSecureContext) {
    useVoiceStore.setState({ error: 'Screen share requires HTTPS or a secure context.' });
    return null;
  }
  const result = await captureScreenShare({
    kind: 'browser',
    width,
    height,
    frameRate: screenshareFps,
    includeAudio: screenshareAudio,
  });
  return result.stream;
}

const pendingVoiceJoinRequests = new Set<string>();
const pendingMediaCoreVoiceJoins = new Set<string>();

const DEFAULT_PEER_VOLUME_PCT = 50;
const CENTRAL_PEER_VOLUME_SAVE_DEBOUNCE_MS = 400;
let pendingCentralPeerVolumeSaveTimer: number | null = null;
let loadedCentralPeerVolumesForUserId: string | null = null;
let loadingCentralPeerVolumesPromise: Promise<void> | null = null;
let lastRequestedSelfVoiceState: { muted: boolean; deafened: boolean; at: number } | null = null;
let suppressNextVoiceScreenshareEndedSound = false;
const remoteScreenShareActiveByPeer = new Map<string, boolean>();
const remoteScreenShareStopTimers = new Map<string, number>();
const remoteScreenShareWatcherCleanupByPeer = new Map<string, () => void>();

function stopStream(stream: MediaStream | null) {
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
}

type VoiceSoundSettingKey =
  | 'soundVoiceMute'
  | 'soundVoiceUnmute'
  | 'soundVoiceDeafen'
  | 'soundVoiceUndeafen'
  | 'soundVoicePTTActivate'
  | 'soundVoicePTTDeactivate'
  | 'soundVoiceUserJoined'
  | 'soundVoiceUserLeft'
  | 'soundScreenshareGoLive'
  | 'soundScreenshareUserJoin'
  | 'soundScreenshareUserLeft'
  | 'soundScreenshareEnded'
  | 'soundScreenshareStopped';

function playConfiguredVoiceSound(soundType: SoundType, settingKey: VoiceSoundSettingKey) {
  const settings = useSettingsStore.getState() as Record<string, any>;
  const soundsDisabled = settings.streamerMode && settings.streamerModeDisableSounds;
  if (soundsDisabled || !settings.notificationsEnabled) return;
  if (!settings[settingKey]) return;
  const volume = settings.soundVolumes?.[settingKey] ?? 60;
  playNotificationSound(soundType, volume);
}

function getVoicePeerNotificationKey(channelId: string, userId: string) {
  return `${channelId}:${userId}`;
}

function clearRemoteScreenShareStopTimer(peerKey: string) {
  const timer = remoteScreenShareStopTimers.get(peerKey);
  if (timer === undefined) return;
  window.clearTimeout(timer);
  remoteScreenShareStopTimers.delete(peerKey);
}

function clearRemoteScreenShareWatcher(peerKey: string) {
  const cleanup = remoteScreenShareWatcherCleanupByPeer.get(peerKey);
  if (!cleanup) return;
  remoteScreenShareWatcherCleanupByPeer.delete(peerKey);
  cleanup();
}

function clearRemoteScreenShareState(channelId: string, userId: string, playLeaveSound: boolean) {
  const peerKey = getVoicePeerNotificationKey(channelId, userId);
  clearRemoteScreenShareStopTimer(peerKey);
  clearRemoteScreenShareWatcher(peerKey);
  const wasActive = remoteScreenShareActiveByPeer.get(peerKey) === true;
  remoteScreenShareActiveByPeer.delete(peerKey);
  if (playLeaveSound && wasActive) {
    playConfiguredVoiceSound('screenshare-user-left', 'soundScreenshareUserLeft');
  }
}


function reconcileAuthoritativeLiveUserIds(channelId: string, nextLiveUserIds: string[]) {
  const nextLiveSet = new Set(nextLiveUserIds);
  for (const [peerKey, isActive] of remoteScreenShareActiveByPeer.entries()) {
    if (!isActive || !peerKey.startsWith(`${channelId}:`)) continue;
    const userId = peerKey.slice(channelId.length + 1);
    if (!nextLiveSet.has(userId)) {
      clearRemoteScreenShareState(channelId, userId, true);
    }
  }
}

function isPushToTalkModeEnabled() {
  return useSettingsStore.getState().voiceInputMode === 'push_to_talk';
}

function shouldTransmitLocalAudio(state: Pick<VoiceState, 'activeChannelId' | 'pendingChannelId' | 'selfMuted' | 'selfDeafened' | 'pushToTalkPressed'>) {
  if (state.selfMuted || state.selfDeafened) return false;
  const hasVoiceSession = !!(state.activeChannelId || state.pendingChannelId);
  if (!hasVoiceSession) return true;
  if (!isPushToTalkModeEnabled()) return true;
  return state.pushToTalkPressed;
}

function applyLocalAudioGate(state: Pick<VoiceState, 'activeChannelId' | 'pendingChannelId' | 'selfMuted' | 'selfDeafened' | 'pushToTalkPressed' | 'localStream'>) {
  const enabled = shouldTransmitLocalAudio(state);
  // Gate the processed (sender) stream
  state.localStream?.getAudioTracks().forEach((track) => {
    track.enabled = enabled;
  });
  // Also gate the raw mic track — AudioWorklet continues processing even when
  // the processed track is disabled, so raw-level gating is the reliable mute.
  activeVoiceRawStream?.getAudioTracks().forEach((track) => {
    track.enabled = enabled;
  });
}

function applyCurrentVoicePlaybackState(partial?: Partial<Pick<VoiceState, 'selfMuted' | 'selfDeafened' | 'localStream'>>) {
  const state = useVoiceStore.getState();
  const selfMuted = partial?.selfMuted ?? state.selfMuted;
  const selfDeafened = partial?.selfDeafened ?? state.selfDeafened;
  const localStream = partial?.localStream ?? state.localStream;

  activeVoicePipeline?.resume();
  applyLocalAudioGate({
    ...state,
    selfMuted,
    selfDeafened,
    localStream,
  });
}

function getVoiceAudioConstraint(): MediaTrackConstraints | boolean {
  const deviceId = useSettingsStore.getState().voiceInputDeviceId;
  if (!deviceId) return true;
  return {
    deviceId: { exact: deviceId },
  };
}

async function getVoiceUserMedia(): Promise<MediaStream> {
  const audioConstraint = getVoiceAudioConstraint();
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false });
  } catch (error) {
    const maybeName = (error as { name?: string })?.name ?? '';
    const isInputSelectionError = maybeName === 'NotFoundError'
      || maybeName === 'OverconstrainedError'
      || maybeName === 'ConstraintNotSatisfiedError';
    if (!isInputSelectionError || audioConstraint === true) {
      throw error;
    }
    console.warn('[Voice] Selected input device unavailable, falling back to default microphone');
    return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }
}

async function prepareLocalVoiceCapture(allowNoMicrophone?: boolean): Promise<MediaStream | null> {
  if (allowNoMicrophone) {
    activeVoicePipeline?.destroy();
    activeVoicePipeline = null;
    stopStream(activeVoiceRawStream);
    activeVoiceRawStream = null;
    useVoiceStore.setState({
      localStream: null,
      selfMuted: true,
      notice: 'Joined without a microphone. Configure an input device to talk.',
    });
    return null;
  }

  const rawStream = await getVoiceUserMedia();
  const settings = useSettingsStore.getState();
  const pipeline = await buildAudioPipeline(rawStream, {
    noiseGateEnabled: settings.noiseGateEnabled,
    noiseGateThreshold: settings.noiseGateThreshold,
    rnnoiseEnabled: settings.rnnoiseEnabled,
  });
  activeVoicePipeline = pipeline;
  activeVoiceRawStream = rawStream;
  const stream = pipeline ? pipeline.processedStream : rawStream;
  useVoiceStore.setState({ localStream: stream });
  applyLocalAudioGate({ ...useVoiceStore.getState(), localStream: stream });
  return stream;
}

function normalizePeerVolumesMap(input: unknown): Record<string, number> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, number> = {};
  for (const [userId, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const key = String(userId || '').trim();
    if (!key) continue;
    const num = Number(rawValue);
    if (!Number.isFinite(num)) continue;
    const clamped = Math.max(0, Math.min(300, Math.round(num)));
    if (clamped === DEFAULT_PEER_VOLUME_PCT) continue;
    out[key] = clamped;
  }
  return out;
}

// Always route voice signals to the server the voice session was joined on,
// not wherever the user is currently browsing.
function getVoiceSocket() {
  const voiceUrl = useVoiceStore.getState().voiceServerUrl;
  if (voiceUrl) return getSocket(voiceUrl);
  const user = useAuthStore.getState().user;
  const url = user?.accountType === 'central'
    ? useServerStore.getState().activeServerUrl
    : useAuthStore.getState().serverUrl;
  return url ? getSocket(url) : null;
}

function emitVoiceLiveState(channelId: string | null | undefined, live: boolean) {
  if (!channelId) return;
  getVoiceSocket()?.emit('voice:live-state', { channelId, live });
}

async function pushCentralPeerVolumesIfNeeded() {
  const authState = useAuthStore.getState();
  if (authState.user?.accountType !== 'central' || !authState.token) return;
  try {
    const { createAuthenticatedApi } = await import('../lib/authApi');
    const api = createAuthenticatedApi();
    await api.put('/api/profile/voice-user-volumes', {
      volumes: normalizePeerVolumesMap(useVoiceStore.getState().peerVolumeByUser),
    });
  } catch (error) {
    console.warn('[Voice] Failed to save central voice user volumes:', error);
  }
}

function scheduleCentralPeerVolumesSave() {
  const authState = useAuthStore.getState();
  if (authState.user?.accountType !== 'central' || !authState.token) return;
  if (pendingCentralPeerVolumeSaveTimer) {
    window.clearTimeout(pendingCentralPeerVolumeSaveTimer);
  }
  pendingCentralPeerVolumeSaveTimer = window.setTimeout(() => {
    pendingCentralPeerVolumeSaveTimer = null;
    void pushCentralPeerVolumesIfNeeded();
  }, CENTRAL_PEER_VOLUME_SAVE_DEBOUNCE_MS);
}

export const useVoiceStore = create<VoiceState>((set, get) => ({
  activeChannelId: null,
  pendingChannelId: null,
  selfVoiceUserId: null,
  voiceServerUrl: null,
  voiceChannelName: null,
  voiceServerName: null,
  users: {},
  voiceCounts: {},
  voiceRoomUsers: {},
  voiceRoomStartedAt: {},
  liveUserIdsByChannel: {},
  peers: {},
  e2eeSupported: false,
  e2eeByPeer: {},
  localStream: null,
  selfMuted: useSettingsStore.getState().voiceMuted ?? false,
  selfDeafened: useSettingsStore.getState().voiceDeafened ?? false,
  mutedBeforeDeafen: false,
  pushToTalkPressed: false,
  peerVolumeByUser: useSettingsStore.getState().voiceUserVolumes ?? {},
  connecting: false,
  error: null,
  notice: null,
  lastEvent: null,
  lastEventAt: null,
  speakingByUser: {},
  screenStream: null,
  isSharing: false,
  lastShareOpts: null,

  setLastEvent: (event) => {
    set({ lastEvent: event, lastEventAt: Date.now() });
    const state = get();
    logVoiceDebug('voice', event, {
      channelId: state.activeChannelId,
      pendingChannelId: state.pendingChannelId,
      connecting: state.connecting,
      peerCount: Object.keys(state.peers).length,
      userCount: Object.keys(state.users).length,
      muted: state.selfMuted,
      deafened: state.selfDeafened,
      sharing: state.isSharing,
    });
  },
  setSpeaking: (userId, speaking) => {
    set((s) => ({
      speakingByUser: {
        ...s.speakingByUser,
        [userId]: speaking,
      },
    }));
  },
  setPeerVolume: (userId, volumePct) => {
    const next = Math.max(0, Math.min(300, Math.round(volumePct)));
    useSettingsStore.getState().setVoiceUserVolume(userId, next);
    set((s) => {
      const peerVolumeByUser = { ...s.peerVolumeByUser };
      if (next === DEFAULT_PEER_VOLUME_PCT) delete peerVolumeByUser[userId];
      else peerVolumeByUser[userId] = next;
      return { peerVolumeByUser };
    });
    scheduleCentralPeerVolumesSave();
  },
  clearPeerVolumes: () => {
    useSettingsStore.getState().clearVoiceUserVolumes();
    set({ peerVolumeByUser: {} });
    scheduleCentralPeerVolumesSave();
  },
  loadCentralPeerVolumes: async () => {
    const authState = useAuthStore.getState();
    const userId = authState.user?.id ?? null;
    if (authState.user?.accountType !== 'central' || !authState.token || !userId) {
      loadedCentralPeerVolumesForUserId = null;
      return;
    }
    if (loadedCentralPeerVolumesForUserId === userId) return;
    if (loadingCentralPeerVolumesPromise) return loadingCentralPeerVolumesPromise;
    loadingCentralPeerVolumesPromise = (async () => {
      try {
        const { createAuthenticatedApi } = await import('../lib/authApi');
        const api = createAuthenticatedApi();
        const res = await api.get('/api/profile/voice-user-volumes');
        const volumes = normalizePeerVolumesMap(res.data?.volumes);
        useSettingsStore.getState().setVoiceUserVolumes(volumes);
        useVoiceStore.setState({ peerVolumeByUser: volumes });
        loadedCentralPeerVolumesForUserId = userId;
      } catch (error) {
        console.warn('[Voice] Failed to load central voice user volumes:', error);
      } finally {
        loadingCentralPeerVolumesPromise = null;
      }
    })();
    return loadingCentralPeerVolumesPromise;
  },
  startShare: async (opts) => {
    const state = get();
    if (!state.activeChannelId) {
      set({ error: 'Join voice before starting screen share.' });
      return;
    }
    const userPermissions = useAuthStore.getState().user?.permissions;
    const channel = useChannelStore.getState().channels.find((entry) => entry.id === state.activeChannelId);
    const channelPermissions = channel?.effective_permissions;
    const canShare = hasChannelPermission(userPermissions, channelPermissions, PERMISSIONS.SCREENSHARE)
      || hasChannelPermission(userPermissions, channelPermissions, PERMISSIONS.CAMERA);
    if (!canShare) {
      set({ error: 'You do not have permission to share video in this channel.' });
      return;
    }
    const replacingLiveKitShare = state.isSharing
      && !!state.activeChannelId
      && isMediaCoreActiveForVoice(state.activeChannelId);
    if (state.isSharing && !replacingLiveKitShare) {
      get().stopShare('manual');
    }
    let previousStream: MediaStream | null = null;
    if (replacingLiveKitShare) {
      previousStream = state.screenStream;
    }
    try {
      const channelId = get().activeChannelId!;
      const mediaCoreActive = isMediaCoreActiveForVoice(channelId);
      if (
        opts?.kind === 'desktop'
        && opts.sourceId
        && mediaCoreActive
      ) {
        const nativeStarted = await useMediaStore.getState().startNativeScreenShare({
          sourceId: opts.sourceId,
        });
        if (nativeStarted) {
          if (previousStream) {
            stopStream(previousStream);
          }
          set({ isSharing: true, screenStream: null, lastShareOpts: opts ?? null });
          if (!replacingLiveKitShare) {
            emitVoiceLiveState(channelId, true);
            get().setLastEvent('screenshare:start native-whip');
            playConfiguredVoiceSound('screenshare-go-live', 'soundScreenshareGoLive');
          } else {
            get().setLastEvent('screenshare:switch native-whip');
          }
          return;
        }
        const activeMediaSession = useMediaStore.getState().activeSession;
        if (activeMediaSession?.isNativeVoice) {
          logVoiceDebug('native-voice', 'screen share stopped before browser fallback', {
            channelId,
            sourceId: opts.sourceId,
            reason: 'native-capture-failed',
          }, 'warn');
          set({
            isSharing: false,
            screenStream: null,
            error: 'Native Linux screen capture failed to start.',
          });
          return;
        }
      }
      if (
        opts?.kind === 'device'
        && opts.deviceId
      ) {
        const mediaState = useMediaStore.getState();
        const settingsState = useSettingsStore.getState();
        logVoiceDebug('livekit', 'native WHIP device gate', {
          channelId,
          mediaCoreActive,
          hasActiveSession: !!mediaState.activeSession,
          activeSessionContext: mediaState.activeSession?.context ?? null,
          activeSessionChannelId: mediaState.activeSession?.channelId ?? null,
          nativeWhipEnabled: settingsState.screenShareNativeWhipEnabled,
          chromiumHardwareEncodingSetting: settingsState.screenShareHardwareEncoding,
          hasNativePublisherApi: !!window.electron?.startNativeWhipPublisher,
          hasNativeSupportApi: !!window.electron?.getNativeWhipPublisherSupport,
          deviceLabel: opts.deviceLabel ?? null,
          devicePath: opts.devicePath ?? null,
          audioDeviceLabel: opts.audioDeviceLabel ?? null,
        }, mediaCoreActive ? 'info' : 'warn');
        if (!mediaCoreActive) {
          logVoiceDebug('livekit', 'native WHIP device skipped', {
            channelId,
            deviceId: opts.deviceId,
            deviceLabel: opts.deviceLabel ?? null,
            reason: 'media-core-session-inactive',
          }, 'warn');
        }
      }
      if (
        opts?.kind === 'device'
        && opts.deviceId
        && mediaCoreActive
      ) {
        const nativeStarted = await useMediaStore.getState().startNativeDeviceShare({
          deviceId: opts.deviceId,
          deviceLabel: opts.deviceLabel ?? null,
          devicePath: opts.devicePath ?? null,
          audioDeviceId: opts.audioDeviceId,
          audioDeviceLabel: opts.audioDeviceLabel ?? null,
        });
        if (nativeStarted) {
          if (previousStream) {
            stopStream(previousStream);
          }
          set({ isSharing: true, screenStream: null, lastShareOpts: opts ?? null });
          if (!replacingLiveKitShare) {
            emitVoiceLiveState(channelId, true);
            get().setLastEvent('screenshare:start native-whip-device');
            playConfiguredVoiceSound('screenshare-go-live', 'soundScreenshareGoLive');
          } else {
            get().setLastEvent('screenshare:switch native-whip-device');
          }
          return;
        }
      }
      if (mediaCoreActive && useMediaStore.getState().activeSession?.isNativeVoice) {
        const sourceId = opts?.kind === 'device'
          ? (opts.devicePath || opts.deviceId || '')
          : (opts?.sourceId || 'screen:0');
        await useMediaStore.getState().startScreenShare(undefined, undefined, sourceId);
        if (previousStream) stopStream(previousStream);
        set({ isSharing: true, screenStream: null, lastShareOpts: opts ?? null });
        if (!replacingLiveKitShare) {
          emitVoiceLiveState(channelId, true);
          get().setLastEvent('screenshare:start native-livekit');
          playConfiguredVoiceSound('screenshare-go-live', 'soundScreenshareGoLive');
        }
        return;
      }
      const stream = await captureVoiceScreenShareStream(opts);
      if (!stream) {
        // If capture was cancelled, don't stop the previous stream if we had one.
        return;
      }
      if (previousStream) {
        // Now that the new stream successfully captured, we can safely stop the old one.
        stopStream(previousStream);
      }
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) return;
      if (isMediaCoreActiveForVoice(channelId)) {
        if (replacingLiveKitShare) {
          suppressNextVoiceScreenshareEndedSound = true;
        }
        videoTrack.onended = () => {
          if (suppressNextVoiceScreenshareEndedSound) {
            suppressNextVoiceScreenshareEndedSound = false;
            return;
          }
          get().stopShare('ended');
        };
        await useMediaStore.getState().startScreenShare(stream);
        set({ isSharing: true, screenStream: stream, lastShareOpts: opts ?? null });
        if (!replacingLiveKitShare) {
          emitVoiceLiveState(channelId, true);
          get().setLastEvent('screenshare:start livekit');
          playConfiguredVoiceSound('screenshare-go-live', 'soundScreenshareGoLive');
        } else {
          get().setLastEvent('screenshare:switch livekit');
        }
        return;
      }
      // LiveKit not yet active for this channel — set onended so the track doesn't leak.
      videoTrack.onended = () => {
        if (suppressNextVoiceScreenshareEndedSound) {
          suppressNextVoiceScreenshareEndedSound = false;
          return;
        }
        get().stopShare('ended');
      };
      set({ screenStream: stream, isSharing: true, lastShareOpts: opts ?? null });
      emitVoiceLiveState(channelId, true);
      get().setLastEvent('screenshare:start');
      playConfiguredVoiceSound('screenshare-go-live', 'soundScreenshareGoLive');
    } catch (err) {
      const name = (err as { name?: string }).name ?? '';
      const msg =
        name === 'NotAllowedError'
          ? 'Screen share cancelled or denied.'
          : name === 'NotFoundError'
          ? 'No display sources found.'
          : name === 'NotReadableError'
          ? 'Screen share failed to start.'
          : `Screen share failed. (${name || 'unknown'})`;
      set({ error: msg });
      get().setLastEvent(`screenshare:error ${name || 'unknown'}`);
    }
  },
  stopShare: (reason = 'manual') => {
    const state = get();
    if (!state.isSharing) return;
    if (state.activeChannelId && isMediaCoreActiveForVoice(state.activeChannelId)) {
      if (reason === 'manual') {
        suppressNextVoiceScreenshareEndedSound = true;
      }
      void useMediaStore.getState().stopScreenShare();
      emitVoiceLiveState(state.activeChannelId, false);
      set({ screenStream: null, isSharing: false });
      get().setLastEvent('screenshare:stop livekit');
      playConfiguredVoiceSound(
        reason === 'ended' ? 'screenshare-ended' : 'screenshare-stopped',
        reason === 'ended' ? 'soundScreenshareEnded' : 'soundScreenshareStopped',
      );
      return;
    }
    if (!state.screenStream || !state.activeChannelId) {
      set({ screenStream: null, isSharing: false });
      return;
    }
    if (reason === 'manual') {
      suppressNextVoiceScreenshareEndedSound = true;
    }
    state.screenStream.getTracks().forEach((track) => track.stop());
    const channelId = state.activeChannelId;
    set({ screenStream: null, isSharing: false });
    emitVoiceLiveState(channelId, false);
    get().setLastEvent('screenshare:stop');
    playConfiguredVoiceSound(
      reason === 'ended' ? 'screenshare-ended' : 'screenshare-stopped',
      reason === 'ended' ? 'soundScreenshareEnded' : 'soundScreenshareStopped',
    );
  },

  restartShare: async () => {
    const state = get();
    if (!state.isSharing) return;
    const opts = state.lastShareOpts;
    const channelId = state.activeChannelId;
    // Suppress the "share ended" sound — this is a settings-apply restart, not a real stop.
    suppressNextVoiceScreenshareEndedSound = true;
    // Await the full unpublish so mediaStore's activeScreenShareVideoPublication is cleared
    // before startShare, otherwise it would take the replaceTrack path instead of re-publishing.
    await useMediaStore.getState().stopScreenShare();
    if (channelId && isMediaCoreActiveForVoice(channelId)) {
      emitVoiceLiveState(channelId, false);
    }
    if (state.screenStream) stopStream(state.screenStream);
    set({ screenStream: null, isSharing: false });
    await get().startShare(opts ?? undefined);
  },

  joinVoice: async (channelId, options = {}) => {
    if (!channelId) return;
    const allowNoMicrophone = options.allowNoMicrophone === true;
    const userPermissions = useAuthStore.getState().user?.permissions;
    const channel = useChannelStore.getState().channels.find((entry) => entry.id === channelId);
    const channelPermissions = channel?.effective_permissions;
    if (!hasChannelPermission(userPermissions, channelPermissions, PERMISSIONS.CONNECT_TO_VOICE)) {
      set({ error: 'You do not have permission to join this voice channel.', notice: null });
      return;
    }
    if (get().pendingChannelId === channelId || get().activeChannelId === channelId) return;
    const targetUrl = useAuthStore.getState().user?.accountType === 'central'
      ? useServerStore.getState().activeServerUrl
      : useAuthStore.getState().serverUrl;
    const insecureRealm = await checkInsecureRealmMedia(
      targetUrl, 'voice', useMediaStore.getState().probeSelfHostCapability, options.acknowledgedInsecureRealm === true,
    );
    if (insecureRealm === 'unavailable') {
      set({ error: 'Voice is not available through the HTTP realm gateway without Central Fallback.', notice: null });
      return;
    }
    if (insecureRealm === 'confirm') {
      useUIStore.getState().openModal('insecureRealmMedia', { context: 'voice', channelId, channelName: channel?.name ?? null });
      return;
    }
    const state = get();
    if (state.pendingChannelId === channelId || state.activeChannelId === channelId) return;
    if (state.activeChannelId || state.pendingChannelId) {
      state.leaveVoice();
    }
    if (pendingVoiceJoinRequests.has(channelId)) {
      get().setLastEvent(`voice:join duplicate ignored ${channelId}`);
      return;
    }
    pendingVoiceJoinRequests.add(channelId);
    // Leave any active theater channel before joining regular voice
    const { useTheaterStore } = await import('./theaterStore');
    const theaterState = useTheaterStore.getState();
    if (theaterState.activeChannelId) {
      theaterState.leaveTheater();
    }

    const serverUrl = useAuthStore.getState().user?.accountType === 'central'
      ? useServerStore.getState().activeServerUrl
      : useAuthStore.getState().serverUrl;

    if (!serverUrl) {
      pendingVoiceJoinRequests.delete(channelId);
      set({
        connecting: false,
        pendingChannelId: null,
        notice: null,
        error: 'Not connected to server.',
      });
      return;
    }

    const socket = getSocket(serverUrl);
    if (!socket?.connected) {
      pendingVoiceJoinRequests.delete(channelId);
      set({
        connecting: false,
        pendingChannelId: null,
        notice: null,
        error: 'Not connected to server. Please wait and try again.',
      });
      return;
    }

    pendingMediaCoreVoiceJoins.add(channelId);
    const serverName = useAuthStore.getState().serverInfo?.name ?? null;
    set({ connecting: true, pendingChannelId: channelId, voiceServerUrl: serverUrl, voiceChannelName: channel?.name ?? null, voiceServerName: serverName, error: null, notice: null });
    get().setLastEvent(`voice:join emit ${channelId}`);
    try {
      const nativeVoiceBackend = typeof window !== 'undefined'
        && typeof window.electron?.getNativeVoiceSupport === 'function'
        && typeof RTCPeerConnection === 'undefined';
      // Linux Sushi captures/publishes through the Rust LiveKit backend.
      // Calling WebKit getUserMedia here would fail before joinVoice can hand
      // off to that backend (and re-enabling it triggers the PipeWire crash).
      const localVoiceStream = nativeVoiceBackend
        ? null
        : await prepareLocalVoiceCapture(allowNoMicrophone);
      socket.emit('voice:join', {
        channelId,
        muted: allowNoMicrophone || get().selfMuted,
        deafened: get().selfDeafened,
      }, async (resp: { ok?: boolean; channelId?: string; users?: VoiceUser[]; you?: string; startedAt?: number | null; liveUserIds?: string[]; error?: string }) => {
        if (!resp || resp.ok !== true) {
          const permissionDenied = isConnectToVoicePermissionError(resp?.error);
          pendingVoiceJoinRequests.delete(channelId);
          pendingMediaCoreVoiceJoins.delete(channelId);
          if (resp?.channelId) pendingMediaCoreVoiceJoins.delete(resp.channelId);
          set({
            pendingChannelId: null,
            connecting: false,
            error: permissionDenied
              ? CONNECT_TO_VOICE_PERMISSION_MESSAGE
              : resp?.error || 'Failed to join voice. Please try again.',
          });
          if (permissionDenied) {
            useUIStore.getState().openModal('voicePermissionDenied', {
              channelId: resp?.channelId ?? channelId,
              channelName: channel?.name ?? null,
            });
          }
          get().setLastEvent(`voice:join ack failed ${resp?.channelId ?? 'unknown'}`);
          return;
        }
        const joinedChannelId = resp.channelId ?? channelId;
        let mediaCoreJoined = false;
        try {
          mediaCoreJoined = await useMediaStore.getState().joinVoice({
            serverUrl,
            channelId: joinedChannelId,
            muted: allowNoMicrophone || !shouldTransmitLocalAudio(get()),
            deafened: get().selfDeafened,
            microphoneTrack: localVoiceStream?.getAudioTracks()[0] ?? null,
            microphoneTrackLabel: 'catrealm:voice:processed-mic',
          });
          if (!mediaCoreJoined) {
            logVoiceDebug('media-core', 'voice media unavailable', { channelId: joinedChannelId }, 'warn');
          }
        } finally {
          pendingMediaCoreVoiceJoins.delete(channelId);
          pendingMediaCoreVoiceJoins.delete(joinedChannelId);
        }
        if (!mediaCoreJoined) {
          const mediaError = useMediaStore.getState().error;
          socket.emit('voice:leave', { channelId: joinedChannelId });
          activeVoicePipeline?.destroy();
          activeVoicePipeline = null;
          stopStream(activeVoiceRawStream);
          activeVoiceRawStream = null;
          set({
            pendingChannelId: null,
            connecting: false,
            localStream: null,
            error: mediaError || 'LiveKit media is unavailable for this voice channel.',
          });
          get().setLastEvent(`voice:join media unavailable ${joinedChannelId}`);
          pendingVoiceJoinRequests.delete(channelId);
          return;
        }
        get().handleUsers({
          channelId: joinedChannelId,
          users: resp.users ?? [],
          you: resp.you ?? '',
          startedAt: resp.startedAt,
          liveUserIds: resp.liveUserIds ?? [],
        });
        get().setLastEvent(`voice:join ack ok ${joinedChannelId} livekit`);
        pendingVoiceJoinRequests.delete(channelId);
      });
      // If server does not respond, roll back
      setTimeout(() => {
        const current = get();
        if (current.pendingChannelId === channelId && current.activeChannelId !== channelId) {
          pendingVoiceJoinRequests.delete(channelId);
          pendingMediaCoreVoiceJoins.delete(channelId);
          activeVoicePipeline?.destroy();
          activeVoicePipeline = null;
          stopStream(activeVoiceRawStream);
          activeVoiceRawStream = null;
          set({
            pendingChannelId: null,
            connecting: false,
            localStream: null,
            pushToTalkPressed: false,
            error: 'Failed to join voice. Please try again.',
          });
          get().setLastEvent(`voice:join timeout ${channelId}`);
        }
      }, 12000);
    } catch (error) {
      pendingVoiceJoinRequests.delete(channelId);
      pendingMediaCoreVoiceJoins.delete(channelId);
      const errorName = (error as { name?: string })?.name ?? '';
      const isMicError = errorName === 'NotAllowedError'
        || errorName === 'NotFoundError'
        || errorName === 'NotReadableError'
        || errorName === 'OverconstrainedError'
        || errorName === 'ConstraintNotSatisfiedError'
        || errorName === 'SecurityError'
        || errorName === '';
      set({
        connecting: false,
        pendingChannelId: null,
        error: isMicError ? null : 'Failed to join voice. Please try again.',
        notice: null,
      });
      if (!allowNoMicrophone && isMicError) {
        useUIStore.getState().openModal('voiceNoMicrophone', {
          channelId,
          channelName: channel?.name ?? null,
          errorName: errorName || null,
        });
        get().setLastEvent(`voice:join mic unavailable ${errorName || 'unknown'}`);
      } else {
        get().setLastEvent(`voice:join failed ${errorName || 'unknown'}`);
      }
    }
  },

  leaveVoice: () => {
    const { activeChannelId, pendingChannelId } = get();
    const socket = getVoiceSocket();
    const channelId = activeChannelId ?? pendingChannelId;
    if (channelId) {
      pendingVoiceJoinRequests.delete(channelId);
      pendingMediaCoreVoiceJoins.delete(channelId);
    }
    clearRealtimeReconnectTarget('voice');
    if (socket && channelId) {
      socket.emit('voice:live-state', { channelId, live: false });
      socket.emit('voice:leave', { channelId });
    }
    if (channelId) useMediaStore.getState().leave('voice', channelId);
    activeVoicePipeline?.destroy();
    activeVoicePipeline = null;
    stopStream(activeVoiceRawStream);
    activeVoiceRawStream = null;
    set({
      activeChannelId: null,
      pendingChannelId: null,
      selfVoiceUserId: null,
      voiceServerUrl: null,
      voiceChannelName: null,
      voiceServerName: null,
      users: {},
      peers: {},
      e2eeByPeer: {},
      localStream: null,
      connecting: false,
      mutedBeforeDeafen: false,
      pushToTalkPressed: false,
      error: null,
      notice: null,
      speakingByUser: {},
      screenStream: null,
      isSharing: false,
    });
    pendingVoiceJoinRequests.clear();
    pendingMediaCoreVoiceJoins.clear();
    remoteScreenShareStopTimers.forEach((timer) => window.clearTimeout(timer));
    remoteScreenShareStopTimers.clear();
    remoteScreenShareWatcherCleanupByPeer.forEach((cleanup) => cleanup());
    remoteScreenShareWatcherCleanupByPeer.clear();
    remoteScreenShareActiveByPeer.clear();
    suppressNextVoiceScreenshareEndedSound = false;
    get().setLastEvent('voice:leave');
  },

  toggleMute: () => {
    const { selfMuted, selfDeafened, localStream, activeChannelId } = get();
    const nextMuted = selfDeafened ? true : !selfMuted;
    if (nextMuted === selfMuted) return;
    lastRequestedSelfVoiceState = { muted: nextMuted, deafened: get().selfDeafened, at: Date.now() };
    set({ selfMuted: nextMuted });
    useSettingsStore.getState().setVoiceMuted(nextMuted);
    applyLocalAudioGate({ ...get(), localStream, selfMuted: nextMuted });
    playConfiguredVoiceSound(nextMuted ? 'voice-mute' : 'voice-unmute', nextMuted ? 'soundVoiceMute' : 'soundVoiceUnmute');
    const socket = getVoiceSocket();
    if (socket && activeChannelId) {
      socket.emit('voice:state', { channelId: activeChannelId, muted: nextMuted, deafened: get().selfDeafened });
    }
    if (activeChannelId && isMediaCoreActiveForVoice(activeChannelId)) {
      void useMediaStore.getState().setMicrophoneMuted(nextMuted || get().selfDeafened).catch(() => {});
    }
  },

  toggleDeafen: () => {
    const { selfDeafened, selfMuted, mutedBeforeDeafen, localStream, activeChannelId } = get();
    const nextDeafened = !selfDeafened;
    const restoreMuted = selfDeafened ? mutedBeforeDeafen : selfMuted;
    const nextMuted = nextDeafened ? true : restoreMuted;
    const nextMutedBeforeDeafen = nextDeafened ? selfMuted : mutedBeforeDeafen;
    set({
      selfDeafened: nextDeafened,
      selfMuted: nextMuted,
      mutedBeforeDeafen: nextMutedBeforeDeafen,
    });
    const settings = useSettingsStore.getState();
    settings.setVoiceDeafened(nextDeafened);
    settings.setVoiceMuted(nextMuted);
    lastRequestedSelfVoiceState = { muted: nextMuted, deafened: nextDeafened, at: Date.now() };
    applyLocalAudioGate({ ...get(), localStream, selfMuted: nextMuted, selfDeafened: nextDeafened });
    playConfiguredVoiceSound(nextDeafened ? 'voice-deafen' : 'voice-undeafen', nextDeafened ? 'soundVoiceDeafen' : 'soundVoiceUndeafen');
    const socket = getVoiceSocket();
    if (socket && activeChannelId) {
      socket.emit('voice:state', { channelId: activeChannelId, muted: nextMuted, deafened: nextDeafened });
    }
    if (activeChannelId && isMediaCoreActiveForVoice(activeChannelId)) {
      void useMediaStore.getState().setMicrophoneMuted(nextMuted || nextDeafened).catch(() => {});
      useMediaStore.getState().setDeafened(nextDeafened);
    }
  },

  pressPushToTalk: () => {
    const state = get();
    if (!isPushToTalkModeEnabled() || state.selfMuted || state.selfDeafened || !(state.activeChannelId || state.pendingChannelId)) return;
    if (state.pushToTalkPressed) return;
    set({ pushToTalkPressed: true });
    applyLocalAudioGate({ ...get(), localStream: state.localStream, pushToTalkPressed: true });
    if (state.activeChannelId && isMediaCoreActiveForVoice(state.activeChannelId)) {
      void useMediaStore.getState().setMicrophoneMuted(false).catch(() => {});
    }
    playConfiguredVoiceSound('voice-ptt-activate', 'soundVoicePTTActivate');
  },

  releasePushToTalk: () => {
    const state = get();
    if (!state.pushToTalkPressed) return;
    set({ pushToTalkPressed: false });
    applyLocalAudioGate({ ...get(), localStream: state.localStream, pushToTalkPressed: false });
    if (state.activeChannelId && isMediaCoreActiveForVoice(state.activeChannelId)) {
      void useMediaStore.getState().setMicrophoneMuted(isPushToTalkModeEnabled()).catch(() => {});
    }
    playConfiguredVoiceSound('voice-ptt-deactivate', 'soundVoicePTTDeactivate');
  },

  handleUsers: ({ channelId, users, you, startedAt, liveUserIds = [] }) => {
    const state = get();
    if (state.pendingChannelId && state.pendingChannelId !== channelId) return;
    if (state.activeChannelId && state.activeChannelId !== channelId) return;
    reconcileAuthoritativeLiveUserIds(channelId, liveUserIds);
    const userMap: Record<string, VoiceUser> = {};
    let selfMutedNext = state.selfMuted;
    let selfDeafenedNext = state.selfDeafened;
    users.forEach((u) => {
      userMap[u.id] = u;
      if (u.id === you) {
        selfMutedNext = !!u.muted;
        selfDeafenedNext = !!u.deafened;
      }
    });
    const nextStartedAt = { ...state.voiceRoomStartedAt };
    if (users.length > 0 && typeof startedAt === 'number') nextStartedAt[channelId] = startedAt;
    else if (users.length === 0 || startedAt === null) delete nextStartedAt[channelId];
    set({
      users: userMap,
      peers: {},
      e2eeByPeer: {},
      voiceCounts: {
        ...state.voiceCounts,
        [channelId]: users.length,
      },
      voiceRoomUsers: {
        ...state.voiceRoomUsers,
        [channelId]: users,
      },
      voiceRoomStartedAt: nextStartedAt,
      liveUserIdsByChannel: {
        ...state.liveUserIdsByChannel,
        [channelId]: liveUserIds,
      },
      connecting: false,
      activeChannelId: channelId,
      pendingChannelId: null,
      selfVoiceUserId: you || null,
      error: null,
      speakingByUser: {},
      screenStream: null,
      isSharing: false,
      selfMuted: selfMutedNext,
      selfDeafened: selfDeafenedNext,
      mutedBeforeDeafen: selfDeafenedNext ? state.mutedBeforeDeafen : selfMutedNext,
    });
    applyCurrentVoicePlaybackState({
      selfMuted: selfMutedNext,
      selfDeafened: selfDeafenedNext,
      localStream: get().localStream,
    });
    clearRealtimeReconnectTarget('voice');
    useUIStore.getState().clearRealtimeReconnectPrompt();
    get().setLastEvent(`voice:users ${channelId} livekit`);
  },

  handleUserJoined: ({ channelId, user }) => {
    if (get().activeChannelId !== channelId) return;
    set((s) => ({
      users: { ...s.users, [user.id]: user },
      voiceCounts: {
        ...s.voiceCounts,
        [channelId]: s.users[user.id]
          ? (s.voiceCounts[channelId] ?? Object.keys(s.users).length)
          : Math.max((s.voiceCounts[channelId] ?? 0) + 1, Object.keys(s.users).length + 1),
      },
      voiceRoomUsers: {
        ...s.voiceRoomUsers,
        [channelId]: s.voiceRoomUsers[channelId]?.some((u) => u.id === user.id)
          ? (s.voiceRoomUsers[channelId] ?? [])
          : [...(s.voiceRoomUsers[channelId] ?? []), user],
      },
    }));
    get().setLastEvent(`voice:user-joined ${channelId} livekit`);
  },

  handleUserLeft: ({ channelId, userId }) => {
    if (get().activeChannelId !== channelId) {
      set((s) => ({
        voiceCounts: {
          ...s.voiceCounts,
          [channelId]: Math.max(0, (s.voiceCounts[channelId] ?? 0) - 1),
        },
        voiceRoomUsers: {
          ...s.voiceRoomUsers,
          [channelId]: (s.voiceRoomUsers[channelId] ?? []).filter((u) => u.id !== userId),
        },
        liveUserIdsByChannel: {
          ...s.liveUserIdsByChannel,
          [channelId]: (s.liveUserIdsByChannel[channelId] ?? []).filter((id) => id !== userId),
        },
      }));
      return;
    }
    clearRemoteScreenShareState(channelId, userId, true);
    set((s) => {
      const { [userId]: _, ...restUsers } = s.users;
      const { [userId]: __, ...restPeers } = s.peers;
      return {
        users: restUsers,
        peers: restPeers,
        voiceCounts: {
          ...s.voiceCounts,
          [channelId]: Math.max(0, Object.keys(restUsers).length),
        },
        voiceRoomUsers: {
          ...s.voiceRoomUsers,
          [channelId]: (s.voiceRoomUsers[channelId] ?? []).filter((u) => u.id !== userId),
        },
        liveUserIdsByChannel: {
          ...s.liveUserIdsByChannel,
          [channelId]: (s.liveUserIdsByChannel[channelId] ?? []).filter((id) => id !== userId),
        },
      };
    });
    get().setLastEvent(`voice:user-left ${channelId}`);
  },

  handleUserState: ({ channelId, userId, muted, deafened }) => {
    if (get().activeChannelId !== channelId) return;
    const currentUserId = useAuthStore.getState().user?.id;
    const isCurrentUser = userId === currentUserId;
    const previous = get();
    const prevMuted = previous.selfMuted;
    const prevDeafened = previous.selfDeafened;
    set((s) => ({
      users: {
        ...s.users,
        [userId]: { ...s.users[userId], muted, deafened },
      },
      selfMuted: isCurrentUser ? muted : s.selfMuted,
      selfDeafened: isCurrentUser ? deafened : s.selfDeafened,
      mutedBeforeDeafen: isCurrentUser && !deafened ? muted : s.mutedBeforeDeafen,
    }));
    // Apply audio track changes when the server mutes/deafens the current user
    if (isCurrentUser) {
      const { localStream } = get();
      useSettingsStore.getState().setVoiceMuted(muted);
      useSettingsStore.getState().setVoiceDeafened(deafened);
      applyLocalAudioGate({ ...get(), localStream, selfMuted: muted, selfDeafened: deafened });
      const recentLocalRequest = lastRequestedSelfVoiceState
        && lastRequestedSelfVoiceState.muted === muted
        && lastRequestedSelfVoiceState.deafened === deafened
        && Date.now() - lastRequestedSelfVoiceState.at < 1200;
      if (!recentLocalRequest) {
        if (prevMuted !== muted) {
          playConfiguredVoiceSound(muted ? 'voice-mute' : 'voice-unmute', muted ? 'soundVoiceMute' : 'soundVoiceUnmute');
        }
        if (prevDeafened !== deafened) {
          playConfiguredVoiceSound(deafened ? 'voice-deafen' : 'voice-undeafen', deafened ? 'soundVoiceDeafen' : 'soundVoiceUndeafen');
        }
      }
      if (recentLocalRequest || prevMuted !== muted || prevDeafened !== deafened) {
        lastRequestedSelfVoiceState = null;
      }
    }
    get().setLastEvent(`voice:user-state ${channelId}`);
  },

  handleUserSync: ({ channelId, users, liveUserIds = [] }) => {
    if (get().activeChannelId !== channelId) return;
    reconcileAuthoritativeLiveUserIds(channelId, liveUserIds);
    const currentUserId = useAuthStore.getState().user?.id;
    const previousUsers = get().users;
    const previousRemoteUserIds = new Set(Object.keys(previousUsers).filter((userId) => userId !== currentUserId));
    const nextRemoteUserIds = new Set(users.filter((user) => user.id !== currentUserId).map((user) => user.id));
    const joinedUserIds = Array.from(nextRemoteUserIds).filter((userId) => !previousRemoteUserIds.has(userId));
    const leftUserIds = Array.from(previousRemoteUserIds).filter((userId) => !nextRemoteUserIds.has(userId));
    set((s) => {
      const nextUsers: Record<string, VoiceUser> = {};
      let selfMuted = s.selfMuted;
      let selfDeafened = s.selfDeafened;
      users.forEach((u) => {
        nextUsers[u.id] = { ...(s.users[u.id] || u), ...u };
        if (u.id === currentUserId) {
          selfMuted = !!u.muted;
          selfDeafened = !!u.deafened;
        }
      });
      return {
        users: nextUsers,
        peers: {},
        e2eeByPeer: {},
        selfMuted,
        selfDeafened,
        mutedBeforeDeafen: selfDeafened ? s.mutedBeforeDeafen : selfMuted,
        voiceCounts: {
          ...s.voiceCounts,
          [channelId]: users.length,
        },
        voiceRoomUsers: {
          ...s.voiceRoomUsers,
          [channelId]: users,
        },
        liveUserIdsByChannel: {
          ...s.liveUserIdsByChannel,
          [channelId]: liveUserIds,
        },
      };
    });
    const nextState = get();
    useSettingsStore.getState().setVoiceMuted(nextState.selfMuted);
    useSettingsStore.getState().setVoiceDeafened(nextState.selfDeafened);
    applyCurrentVoicePlaybackState({
      selfMuted: nextState.selfMuted,
      selfDeafened: nextState.selfDeafened,
      localStream: nextState.localStream,
    });
    joinedUserIds.forEach(() => {
      playConfiguredVoiceSound('voice-user-joined', 'soundVoiceUserJoined');
    });
    leftUserIds.forEach((userId) => {
      playConfiguredVoiceSound('voice-user-left', 'soundVoiceUserLeft');
      clearRemoteScreenShareState(channelId, userId, true);
    });
    get().setLastEvent(`voice:sync ${channelId}`);
  },

  handleRoomCount: ({ channelId, count, startedAt }) => {
    set((s) => {
      const nextStartedAt = { ...s.voiceRoomStartedAt };
      if ((count || 0) > 0 && typeof startedAt === 'number') nextStartedAt[channelId] = startedAt;
      else if ((count || 0) <= 0) delete nextStartedAt[channelId];
      return {
        voiceCounts: {
          ...s.voiceCounts,
          [channelId]: Math.max(0, count || 0),
        },
        voiceRoomStartedAt: nextStartedAt,
      };
    });
  },

  handleRoomSync: ({ channelId, users, startedAt, liveUserIds = [] }) => {
    reconcileAuthoritativeLiveUserIds(channelId, liveUserIds);
    set((s) => {
      const nextStartedAt = { ...s.voiceRoomStartedAt };
      if (users.length > 0 && typeof startedAt === 'number') nextStartedAt[channelId] = startedAt;
      else if (users.length === 0) delete nextStartedAt[channelId];
      return {
        voiceCounts: {
          ...s.voiceCounts,
          [channelId]: users.length,
        },
        voiceRoomUsers: {
          ...s.voiceRoomUsers,
          [channelId]: users,
        },
        liveUserIdsByChannel: {
          ...s.liveUserIdsByChannel,
          [channelId]: liveUserIds,
        },
        voiceRoomStartedAt: nextStartedAt,
      };
    });
  },

  handleRoomsSnapshot: ({ rooms }) => {
    set((s) => {
      const nextCounts = { ...s.voiceCounts };
      const nextRooms = { ...s.voiceRoomUsers };
      const nextStartedAt = { ...s.voiceRoomStartedAt };
      const nextLiveUserIds = { ...s.liveUserIdsByChannel };
      rooms.forEach((room) => {
        reconcileAuthoritativeLiveUserIds(room.channelId, room.liveUserIds ?? []);
        nextCounts[room.channelId] = Math.max(0, room.count || 0);
        if (room.users) nextRooms[room.channelId] = room.users;
        if (room.liveUserIds) nextLiveUserIds[room.channelId] = room.liveUserIds;
        if ((room.count || 0) > 0 && typeof room.startedAt === 'number') nextStartedAt[room.channelId] = room.startedAt;
        else if ((room.count || 0) <= 0) delete nextStartedAt[room.channelId];
      });
      return {
        voiceCounts: nextCounts,
        voiceRoomUsers: nextRooms,
        voiceRoomStartedAt: nextStartedAt,
        liveUserIdsByChannel: nextLiveUserIds,
      };
    });
  },

  handleLiveSync: ({ channelId, userIds }) => {
    reconcileAuthoritativeLiveUserIds(channelId, userIds);
    set((s) => ({
      liveUserIdsByChannel: {
        ...s.liveUserIdsByChannel,
        [channelId]: userIds,
      },
    }));
  },

  // No-op: voice signaling is handled by LiveKit SFU. Socket binding kept for compat.
  handleSignal: () => {},

  cleanup: () => {
    const { activeChannelId, pendingChannelId } = get();
    const channelId = activeChannelId ?? pendingChannelId;
    if (channelId) useMediaStore.getState().leave('voice', channelId);
    activeVoicePipeline?.destroy();
    activeVoicePipeline = null;
    stopStream(activeVoiceRawStream);
    activeVoiceRawStream = null;
    set({
      activeChannelId: null,
      pendingChannelId: null,
      selfVoiceUserId: null,
      voiceServerUrl: null,
      voiceChannelName: null,
      voiceServerName: null,
      users: {},
      voiceCounts: {},
      voiceRoomUsers: {},
      voiceRoomStartedAt: {},
      liveUserIdsByChannel: {},
      peers: {},
      e2eeByPeer: {},
      localStream: null,
      pushToTalkPressed: false,
      connecting: false,
      error: null,
      notice: null,
      speakingByUser: {},
      screenStream: null,
      isSharing: false,
    });
    pendingVoiceJoinRequests.clear();
    pendingMediaCoreVoiceJoins.clear();
    remoteScreenShareStopTimers.forEach((timer) => window.clearTimeout(timer));
    remoteScreenShareStopTimers.clear();
    remoteScreenShareWatcherCleanupByPeer.forEach((cleanup) => cleanup());
    remoteScreenShareWatcherCleanupByPeer.clear();
    remoteScreenShareActiveByPeer.clear();
    suppressNextVoiceScreenshareEndedSound = false;
    get().setLastEvent('voice:cleanup');
  },
}));

// Register voice cleanup on logout (avoids circular dep with authStore)
setOnLogoutVoiceCallback(() => useVoiceStore.getState().leaveVoice());

export async function updateVoiceInputDevice(deviceId: string | null) {
  const state = useVoiceStore.getState();
  useSettingsStore.getState().setVoiceInputDeviceId(deviceId);
  if (!state.activeChannelId) return;

  const audioConstraint = deviceId ? { deviceId: { exact: deviceId } } : true;
  let rawStream: MediaStream;
  try {
    rawStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false });
  } catch {
    return;
  }

  const settings = useSettingsStore.getState();
  const { pipeline, processedTrack } = await rebuildAudioPipeline(activeVoicePipeline, rawStream, {
    noiseGateEnabled: settings.noiseGateEnabled,
    noiseGateThreshold: settings.noiseGateThreshold,
    rnnoiseEnabled: settings.rnnoiseEnabled,
  });
  activeVoicePipeline = pipeline;
  stopStream(activeVoiceRawStream);
  activeVoiceRawStream = rawStream;

  const newTrack = processedTrack;
  const processedStream = pipeline ? pipeline.processedStream : rawStream;

  // Replace outgoing microphone track on the LiveKit session
  const mediaSession = useMediaStore.getState().activeSession;
  const publication = mediaSession?.localMicrophonePublication;
  if (publication && newTrack) {
    try {
      await (publication.track as any)?.replaceTrack(newTrack);
    } catch { }
  }

  if (newTrack) {
    newTrack.enabled = shouldTransmitLocalAudio(state);
  }
  useVoiceStore.setState({ localStream: processedStream });
  applyLocalAudioGate({ ...useVoiceStore.getState(), localStream: processedStream });
}

export async function rebuildVoiceAudioProcessing(): Promise<void> {
  const state = useVoiceStore.getState();
  if (!state.activeChannelId || !activeVoiceRawStream) return;

  const settings = useSettingsStore.getState();
  const { pipeline, processedTrack } = await rebuildAudioPipeline(activeVoicePipeline, activeVoiceRawStream, {
    noiseGateEnabled: settings.noiseGateEnabled,
    noiseGateThreshold: settings.noiseGateThreshold,
    rnnoiseEnabled: settings.rnnoiseEnabled,
  });
  activeVoicePipeline = pipeline;

  const processedStream = pipeline ? pipeline.processedStream : activeVoiceRawStream;
  const newTrack = processedTrack;

  // Replace outgoing microphone track on the LiveKit session
  const mediaSession = useMediaStore.getState().activeSession;
  const publication = mediaSession?.localMicrophonePublication;
  if (publication && newTrack) {
    try {
      await (publication.track as any)?.replaceTrack(newTrack);
      if (newTrack) newTrack.enabled = shouldTransmitLocalAudio(state);
    } catch { }
  }

  useVoiceStore.setState({ localStream: processedStream });
  applyLocalAudioGate({ ...useVoiceStore.getState(), localStream: processedStream });
}

// Register to rebuild voice pipeline whenever audio processing settings change
registerOnAudioSettingsChanged(() => { void rebuildVoiceAudioProcessing(); });

// Live threshold update — no rebuild needed
registerOnNoiseGateThresholdChanged((db) => {
  activeVoicePipeline?.updateNoiseGateThreshold(db);
});

useSettingsStore.subscribe((state, prev) => {
  if (state.voiceInputMode === prev.voiceInputMode) return;
  if (state.voiceInputMode !== 'push_to_talk' && useVoiceStore.getState().pushToTalkPressed) {
    useVoiceStore.setState({ pushToTalkPressed: false });
  }
  applyLocalAudioGate(useVoiceStore.getState());
});
