import { create } from 'zustand';
import { getSocket } from '../lib/socket';
import { useServerStore } from './serverStore';
import { useAuthStore } from './authStore';
import { useSettingsStore } from './settingsStore';
import { useUIStore } from './uiStore';
import { clearRealtimeReconnectTarget, getRealtimeReconnectTarget } from '../lib/realtimeReconnect';
import { playNotificationSound } from '../lib/notificationSounds';
import { useMediaStore } from './mediaStore';
import type { TheaterQueueItem, TheaterPlaybackState, TheaterUser } from '../types';
import { checkInsecureRealmMedia } from '../lib/insecureRealmMedia';

type TheaterReaction = {
  id: string;
  userId: string;
  username: string;
  emoji: string;
  at: number;
};

type TheaterDebugEvent = {
  id: string;
  at: number;
  message: string;
};

interface TheaterState {
  activeChannelId: string | null;
  theaterServerUrl: string | null;
  theaterChannelName: string | null;
  theaterJoinedAt: number | null;
  users: TheaterUser[];
  roomUsersByChannel: Record<string, TheaterUser[]>;
  roomStartedAtByChannel: Record<string, number | null>;
  hostUserIdByChannel: Record<string, string | null>;
  queue: TheaterQueueItem[];
  state: TheaterPlaybackState | null;
  mySkipVote: boolean;
  localCameraStream: MediaStream | null;
  cameraEnabled: boolean;
  micEnabled: boolean;
  selfDeafened: boolean;
  hostUserId: string | null;
  selfUserId: string | null;
  reactions: TheaterReaction[];
  debugEvents: TheaterDebugEvent[];
  error: string | null;
  speakingByUser: Record<string, boolean>;

  // Actions
  joinTheater: (channelId: string, channelName?: string, options?: { acknowledgedInsecureRealm?: boolean }) => Promise<void>;
  leaveTheater: () => void;
  fetchQueue: (channelId: string) => Promise<void>;
  addToQueue: (channelId: string, url: string) => Promise<void>;
  removeFromQueue: (channelId: string, itemId: string) => Promise<void>;
  control: (channelId: string, patch: { playing?: boolean; positionMs?: number; currentItemId?: string | null; durationMs?: number }) => void;
  skipCurrent: (channelId: string) => Promise<void>;
  castSkipVote: (channelId: string) => Promise<void>;
  voteQueue: (channelId: string, itemId: string, upvote: boolean) => Promise<void>;
  grantHost: (channelId: string, userId: string) => void;
  toggleCamera: () => Promise<void>;
  toggleMic: () => Promise<void>;
  toggleDeafen: () => void;
  sendReaction: (channelId: string, emoji: string) => void;
  addReaction: (reaction: TheaterReaction) => void;
  setSpeaking: (userId: string, speaking: boolean) => void;
  computeExpectedPositionMs: () => number;
  addDebugEvent: (message: string) => void;
  clearDebugEvents: () => void;

  kickUser: (channelId: string, userId: string) => void;

  // Socket handlers
  handleUsers: (payload: { channelId: string; users: TheaterUser[]; you: string; startedAt?: number | null }) => void;
  handleUserJoined: (payload: { channelId: string; user: TheaterUser }) => void;
  handleUserLeft: (payload: { channelId: string; userId: string }) => void;
  handleSync: (payload: Partial<TheaterPlaybackState> & { channelId: string; updatedAt: number; videoUrl?: string | null }) => void;
  handleQueueUpdated: (payload: { channelId: string }) => void;
  handleHostChanged: (payload: { channelId: string; hostUserId: string }) => void;
  handleUserState: (payload: { channelId: string; userId: string; cameraEnabled?: boolean; micEnabled?: boolean; deafened?: boolean; muted?: boolean; voiceConnected?: boolean }) => void;
  handleRoomUsers: (payload: { channelId: string; users: TheaterUser[]; startedAt?: number | null }) => void;
  handleRoomsSnapshot: (payload: { rooms: Array<{ channelId: string; users: TheaterUser[]; startedAt: number | null }> }) => void;
  cleanup: () => void;
}

function getCurrentServerUrl() {
  const user = useAuthStore.getState().user;
  return user?.accountType === 'central'
    ? useServerStore.getState().activeServerUrl
    : useAuthStore.getState().serverUrl;
}

function getTheaterServerUrl() {
  return useTheaterStore.getState().theaterServerUrl ?? getCurrentServerUrl();
}

function getServerToken(serverUrl: string | null) {
  if (!serverUrl) return null;
  const auth = useAuthStore.getState();
  if (auth.user?.accountType === 'central') {
    return useServerStore.getState().servers.find((entry) => entry.url === serverUrl)?.token ?? auth.token;
  }
  return auth.token;
}

function getTheaterSocket() {
  const url = getTheaterServerUrl();
  return url ? getSocket(url) : null;
}

function getServerUrl() {
  return getTheaterServerUrl();
}

async function getApi() {
  const { createApi } = await import('../lib/api');
  const url = getServerUrl();
  if (!url) throw new Error('No server URL');
  return createApi(url, getServerToken(url) ?? undefined);
}

const EMPTY_USERS: TheaterUser[] = [];
const EMPTY_QUEUE: TheaterQueueItem[] = [];
const EMPTY_REACTIONS: TheaterReaction[] = [];
const EMPTY_DEBUG_EVENTS: TheaterDebugEvent[] = [];
const pendingMediaCoreTheaterJoins = new Set<string>();

function getTheaterSelfId() {
  return useAuthStore.getState().user?.id ?? null;
}

function resetTheaterSession(
  set: (fn: (state: TheaterState) => Partial<TheaterState>) => void,
  get: () => TheaterState,
  options: { emitLeave: boolean; clearReconnectTarget: boolean; debugLabel: string },
) {
  const { activeChannelId, localCameraStream } = get();
  get().addDebugEvent(`${options.debugLabel} channel=${activeChannelId ?? '-'}`);
  if (activeChannelId) {
    useMediaStore.getState().leave('theater', activeChannelId);
    pendingMediaCoreTheaterJoins.delete(activeChannelId);
  }
  const socket = getTheaterSocket();
  if (options.clearReconnectTarget) {
    clearRealtimeReconnectTarget('theater');
  }
  if (options.emitLeave && socket && activeChannelId) {
    socket.emit('theater:leave', { channelId: activeChannelId });
  }
  if (localCameraStream) {
    for (const track of localCameraStream.getTracks()) track.stop();
  }
  set((s) => ({
    activeChannelId: null,
    theaterServerUrl: null,
    theaterChannelName: null,
    theaterJoinedAt: null,
    users: EMPTY_USERS,
    queue: EMPTY_QUEUE,
    state: null,
    localCameraStream: null,
    cameraEnabled: false,
    micEnabled: false,
    selfDeafened: false,
    hostUserId: null,
    selfUserId: null,
    reactions: EMPTY_REACTIONS,
    debugEvents: s.debugEvents,
    speakingByUser: {},
    mySkipVote: false,
    error: null,
    roomUsersByChannel: activeChannelId
      ? {
          ...s.roomUsersByChannel,
          [activeChannelId]: EMPTY_USERS,
        }
      : s.roomUsersByChannel,
    roomStartedAtByChannel: activeChannelId
      ? {
          ...s.roomStartedAtByChannel,
          [activeChannelId]: null,
        }
      : s.roomStartedAtByChannel,
    hostUserIdByChannel: activeChannelId
      ? {
          ...s.hostUserIdByChannel,
          [activeChannelId]: null,
        }
      : s.hostUserIdByChannel,
  }));
}

export const useTheaterStore = create<TheaterState>((set, get) => ({
  activeChannelId: null,
  theaterServerUrl: null,
  theaterChannelName: null,
  theaterJoinedAt: null,
  users: EMPTY_USERS,
  roomUsersByChannel: {},
  roomStartedAtByChannel: {},
  hostUserIdByChannel: {},
  queue: EMPTY_QUEUE,
  state: null,
  mySkipVote: false,
  localCameraStream: null,
  cameraEnabled: false,
  micEnabled: false,
  selfDeafened: false,
  hostUserId: null,
  selfUserId: null,
  reactions: EMPTY_REACTIONS,
  debugEvents: EMPTY_DEBUG_EVENTS,
  error: null,
  speakingByUser: {},

  computeExpectedPositionMs: () => {
    const { state } = get();
    if (!state) return 0;
    const durationMs = state.duration_ms && state.duration_ms > 0 ? state.duration_ms : null;
    if (!state.playing) {
      return durationMs !== null ? Math.min(state.position_ms, durationMs) : state.position_ms;
    }
    const elapsed = Math.max(0, Date.now() - state.updated_at);
    const expectedMs = Math.max(0, state.position_ms + elapsed);
    return durationMs !== null ? Math.min(expectedMs, durationMs) : expectedMs;
  },

  joinTheater: async (channelId, channelName, options = {}) => {
    get().addDebugEvent(`join request channel=${channelId}`);
    const serverUrl = getCurrentServerUrl();
    const insecureRealm = await checkInsecureRealmMedia(
      serverUrl, 'theater', useMediaStore.getState().probeSelfHostCapability, options.acknowledgedInsecureRealm === true,
    );
    if (insecureRealm === 'unavailable') {
      set({ error: 'Theater is not available through the HTTP realm gateway without Central Fallback.' });
      return;
    }
    if (insecureRealm === 'confirm') {
      useUIStore.getState().openModal('insecureRealmMedia', { context: 'theater', channelId, channelName: channelName ?? null });
      return;
    }
    const socket = serverUrl ? getSocket(serverUrl) : null;
    if (!socket) return;
    // Leave any active regular voice channel before joining theater
    const { useVoiceStore } = await import('./voiceStore');
    const voiceState = useVoiceStore.getState();
    if (voiceState.activeChannelId || voiceState.pendingChannelId) {
      voiceState.leaveVoice();
    }
    const currentTheater = get();
    if (
      currentTheater.activeChannelId
      && (currentTheater.activeChannelId !== channelId || currentTheater.theaterServerUrl !== serverUrl)
    ) {
      get().leaveTheater();
    }

    pendingMediaCoreTheaterJoins.add(channelId);

    socket.emit('theater:join', { channelId }, async (ack: {
      ok: boolean;
      users?: TheaterUser[];
      queue?: TheaterQueueItem[];
      state?: TheaterPlaybackState | null;
      you?: string;
      startedAt?: number | null;
      error?: string;
    }) => {
      if (!ack?.ok) {
        pendingMediaCoreTheaterJoins.delete(channelId);
        get().addDebugEvent(`join failed channel=${channelId} error=${ack?.error || 'unknown'}`);
        set({ error: ack?.error || 'Failed to join theater' });
        const currentUserId = useAuthStore.getState().user?.id ?? null;
        const queued = serverUrl
          ? getRealtimeReconnectTarget({ serverUrl, userId: currentUserId })
          : null;
        if (queued?.kind === 'theater' && queued.channelId === channelId) {
          useUIStore.getState().setRealtimeReconnectPrompt({
            kind: 'theater',
            serverUrl: queued.serverUrl,
            channelId: queued.channelId,
            channelName: queued.channelName ?? channelName ?? null,
          });
          clearRealtimeReconnectTarget('theater');
        }
        return;
      }
      const selfUser = (ack.users ?? EMPTY_USERS).find((entry) => entry.id === (ack.you ?? getTheaterSelfId()));
      set({
        activeChannelId: channelId,
        theaterServerUrl: serverUrl,
        theaterChannelName: channelName ?? null,
        theaterJoinedAt: Date.now(),
        users: ack.users?.length ? ack.users : EMPTY_USERS,
        roomUsersByChannel: {
          ...get().roomUsersByChannel,
          [channelId]: ack.users?.length ? ack.users : EMPTY_USERS,
        },
        roomStartedAtByChannel: {
          ...get().roomStartedAtByChannel,
          [channelId]: ack.startedAt ?? get().roomStartedAtByChannel[channelId] ?? null,
        },
        hostUserIdByChannel: {
          ...get().hostUserIdByChannel,
          [channelId]: ack.state?.host_user_id ?? null,
        },
        queue: ack.queue?.length ? ack.queue : EMPTY_QUEUE,
        state: ack.state ?? null,
        selfUserId: ack.you ?? null,
        selfDeafened: !!selfUser?.deafened,
        hostUserId: ack.state?.host_user_id ?? null,
        error: null,
        mySkipVote: false,
      });

      let mediaCoreJoined = false;
      if (serverUrl) {
        try {
          mediaCoreJoined = await useMediaStore.getState().joinTheater({
            serverUrl,
            channelId,
            muted: !!selfUser?.muted,
            deafened: !!selfUser?.deafened,
          });
        } finally {
          pendingMediaCoreTheaterJoins.delete(channelId);
        }
      }
      if (!mediaCoreJoined) {
        socket.emit('theater:leave', { channelId });
        set({
          activeChannelId: null,
          theaterServerUrl: null,
          theaterChannelName: null,
          theaterJoinedAt: null,
          users: EMPTY_USERS,
          queue: EMPTY_QUEUE,
          state: null,
          error: 'LiveKit media is unavailable for this theater.',
        });
        get().addDebugEvent(`join media unavailable channel=${channelId}`);
        return;
      }

      clearRealtimeReconnectTarget('theater');
      useUIStore.getState().clearRealtimeReconnectPrompt();
      get().addDebugEvent(`join ack channel=${channelId} livekit users=${ack.users?.length ?? 0} host=${ack.state?.host_user_id ?? '-'} playing=${ack.state?.playing ? '1' : '0'}`);
      const settings = useSettingsStore.getState();
      if (settings.notificationsEnabled && settings.soundVoiceUserJoined) {
        const volume = settings.soundVolumes?.['soundVoiceUserJoined'] ?? 60;
        playNotificationSound('voice-user-joined', volume);
      }
    });
  },

  leaveTheater: () => {
    resetTheaterSession(set, get, {
      emitLeave: true,
      clearReconnectTarget: true,
      debugLabel: 'leave',
    });
  },

  fetchQueue: async (channelId) => {
    try {
      const api = await getApi();
      const resp = await api.get<{ items: TheaterQueueItem[]; state: TheaterPlaybackState | null; mySkipVote: boolean }>(`/api/theater/${channelId}/queue`);
      set({
        queue: resp.data.items?.length ? resp.data.items : EMPTY_QUEUE,
        state: resp.data.state ?? null,
        mySkipVote: resp.data.mySkipVote ?? false,
        hostUserId: resp.data.state?.host_user_id ?? get().hostUserId,
        hostUserIdByChannel: {
          ...get().hostUserIdByChannel,
          [channelId]: resp.data.state?.host_user_id ?? get().hostUserIdByChannel[channelId] ?? null,
        },
      });
    } catch { /* ignore */ }
  },

  addToQueue: async (channelId, url) => {
    const api = await getApi();
    try {
      await api.post(`/api/theater/${channelId}/queue`, { url });
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      throw new Error(msg || 'Failed to add to queue');
    }
    // Queue will update via socket event
  },

  removeFromQueue: async (channelId, itemId) => {
    const api = await getApi();
    await api.delete(`/api/theater/${channelId}/queue/${itemId}`);
  },

  control: (channelId, patch) => {
    const socket = getTheaterSocket();
    if (!socket) return;
    get().addDebugEvent(`control channel=${channelId} playing=${patch.playing === undefined ? '-' : (patch.playing ? '1' : '0')} positionMs=${patch.positionMs ?? '-'} durationMs=${patch.durationMs ?? '-'} item=${patch.currentItemId ?? '-'}`);
    socket.emit('theater:state', { channelId, ...patch });
  },

  skipCurrent: async (channelId) => {
    const api = await getApi();
    await api.post(`/api/theater/${channelId}/skip`);
  },

  castSkipVote: async (channelId) => {
    const api = await getApi();
    await api.post(`/api/theater/${channelId}/skip-vote`);
    set({ mySkipVote: true });
  },

  voteQueue: async (channelId, itemId, upvote) => {
    const api = await getApi();
    if (upvote) {
      await api.post(`/api/theater/${channelId}/queue/${itemId}/vote`);
    } else {
      await api.delete(`/api/theater/${channelId}/queue/${itemId}/vote`);
    }
  },

  grantHost: (channelId, userId) => {
    const socket = getTheaterSocket();
    if (!socket) return;
    socket.emit('theater:host:grant', { channelId, userId });
  },

  toggleCamera: async () => {
    const { cameraEnabled, activeChannelId } = get();
    const socket = getTheaterSocket();

    if (cameraEnabled) {
      await useMediaStore.getState().stopCamera();
      set({ cameraEnabled: false, localCameraStream: null });
      if (socket && activeChannelId) {
        socket.emit('theater:camera-state', { channelId: activeChannelId, cameraEnabled: false });
      }
    } else {
      try {
        await useMediaStore.getState().startCamera();
        const stream = useMediaStore.getState().localCameraStream;
        set({ cameraEnabled: true, localCameraStream: stream });
        if (socket && activeChannelId) {
          socket.emit('theater:camera-state', { channelId: activeChannelId, cameraEnabled: true });
        }
      } catch (err) {
        console.error('[TheaterStore] Camera error:', err);
      }
    }
  },

  toggleMic: async () => {
    const { micEnabled, activeChannelId } = get();
    const socket = getTheaterSocket();
    if (!activeChannelId) return;
    playNotificationSound(micEnabled ? 'voice-mute' : 'voice-unmute', 60);

    const nextMicEnabled = !micEnabled;
    await useMediaStore.getState().setMicrophoneMuted(!nextMicEnabled).catch(() => {});
    const selfId = get().selfUserId;
    set((s) => ({
      micEnabled: nextMicEnabled,
      users: selfId ? s.users.map((u) => u.id === selfId ? { ...u, micEnabled: nextMicEnabled, muted: !nextMicEnabled } : u) : s.users,
      roomUsersByChannel: selfId ? {
        ...s.roomUsersByChannel,
        [activeChannelId]: (s.roomUsersByChannel[activeChannelId] ?? []).map((u) => u.id === selfId ? { ...u, micEnabled: nextMicEnabled, muted: !nextMicEnabled } : u),
      } : s.roomUsersByChannel,
    }));
    socket?.emit('theater:mic-state', { channelId: activeChannelId, micEnabled: nextMicEnabled });
  },

  toggleDeafen: () => {
    const { selfDeafened, activeChannelId, micEnabled } = get();
    if (!activeChannelId) return;
    const nextDeafened = !selfDeafened;

    useMediaStore.getState().setDeafened(nextDeafened);
    void useMediaStore.getState().setMicrophoneMuted(nextDeafened || !micEnabled).catch(() => {});
    const selfId = get().selfUserId;
    set((s) => ({
      selfDeafened: nextDeafened,
      users: selfId ? s.users.map((u) => u.id === selfId ? { ...u, deafened: nextDeafened, muted: nextDeafened || !s.micEnabled } : u) : s.users,
      roomUsersByChannel: selfId ? {
        ...s.roomUsersByChannel,
        [activeChannelId]: (s.roomUsersByChannel[activeChannelId] ?? []).map((u) => u.id === selfId ? { ...u, deafened: nextDeafened, muted: nextDeafened || !s.micEnabled } : u),
      } : s.roomUsersByChannel,
    }));
    playNotificationSound(nextDeafened ? 'voice-deafen' : 'voice-undeafen', 60);
    // Broadcast deafen state so other users can see it
    const socket = getTheaterSocket();
    socket?.emit('theater:deafen-state', { channelId: activeChannelId, deafened: nextDeafened });
  },

  sendReaction: (channelId, emoji) => {
    const socket = getTheaterSocket();
    if (!socket) return;
    socket.emit('theater:reaction', { channelId, emoji });
  },

  addReaction: (reaction) => {
    set((s) => ({
      reactions: [...s.reactions.slice(-49), reaction],
    }));
    // Auto-remove after 4 seconds
    setTimeout(() => {
      set((s) => ({
        reactions: s.reactions.filter((r) => r.id !== reaction.id),
      }));
    }, 4000);
  },

  setSpeaking: (userId, speaking) => {
    set((s) => ({
      speakingByUser: {
        ...s.speakingByUser,
        [userId]: speaking,
      },
    }));
  },

  addDebugEvent: (message) => {
    const event: TheaterDebugEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
      message,
    };
    set((s) => ({
      debugEvents: [...s.debugEvents.slice(-199), event],
    }));
  },

  clearDebugEvents: () => {
    set({ debugEvents: EMPTY_DEBUG_EVENTS });
  },

  // ── Socket handlers ───────────────────────────────────────────────────────

  handleUsers: ({ channelId, users, you, startedAt }) => {
    if (get().activeChannelId !== channelId) return;
    const currentUser = users.find((entry) => entry.id === you);
    set((s) => ({
      users,
      selfUserId: you,
      selfDeafened: !!currentUser?.deafened,
      roomUsersByChannel: {
        ...s.roomUsersByChannel,
        [channelId]: users,
      },
      roomStartedAtByChannel: {
        ...s.roomStartedAtByChannel,
        [channelId]: startedAt ?? s.roomStartedAtByChannel[channelId] ?? null,
      },
    }));
    clearRealtimeReconnectTarget('theater');
    useUIStore.getState().clearRealtimeReconnectPrompt();
  },

  handleUserJoined: ({ channelId, user }) => {
    if (get().activeChannelId !== channelId) return;
    set((s) => ({
      users: [...s.users.filter((u) => u.id !== user.id), user],
      roomUsersByChannel: {
        ...s.roomUsersByChannel,
        [channelId]: [...(s.roomUsersByChannel[channelId] ?? []).filter((u) => u.id !== user.id), user],
      },
    }));
  },

  handleUserLeft: ({ channelId, userId }) => {
    if (get().activeChannelId !== channelId) return;
    set((s) => ({
        users: s.users.filter((u) => u.id !== userId),
        roomUsersByChannel: {
          ...s.roomUsersByChannel,
          [channelId]: (s.roomUsersByChannel[channelId] ?? []).filter((u) => u.id !== userId),
        },
        hostUserIdByChannel: {
          ...s.hostUserIdByChannel,
          [channelId]: s.hostUserIdByChannel[channelId] ?? null,
        },
      }));
  },

  handleSync: (payload) => {
    if (get().activeChannelId !== payload.channelId) return;
    const currentItemId = (payload as TheaterPlaybackState & { currentItemId?: string | null }).currentItemId;
    const positionMs = (payload as TheaterPlaybackState & { positionMs?: number }).positionMs;
    const hostUserId = (payload as TheaterPlaybackState & { hostUserId?: string | null }).hostUserId;
    const durationMs = (payload as TheaterPlaybackState & { durationMs?: number }).durationMs;
    set((s) => {
      const nextCurrentItemId = currentItemId ?? payload.current_item_id ?? s.state?.current_item_id ?? null;
      const nextPositionMs = positionMs ?? payload.position_ms ?? s.state?.position_ms ?? 0;
      const nextDurationMs = durationMs ?? payload.duration_ms ?? s.state?.duration_ms ?? 0;
      const nextPlaying = payload.playing ?? s.state?.playing ?? false;
      const rawUpdatedAt = payload.updatedAt ?? Date.now();
      const prevState = s.state;
      let nextUpdatedAt = rawUpdatedAt;

      if (nextPlaying) {
        nextUpdatedAt = Math.min(rawUpdatedAt, Date.now());
        const sameAnchor = !!prevState
          && prevState.playing
          && prevState.current_item_id === nextCurrentItemId
          && prevState.videoUrl === (payload.videoUrl !== undefined ? payload.videoUrl : (prevState.videoUrl ?? null))
          && Math.abs((prevState.position_ms ?? 0) - nextPositionMs) < 250;
        if (sameAnchor) {
          const previousExpectedMs = Math.max(0, prevState.position_ms + Math.max(0, Date.now() - prevState.updated_at));
          nextUpdatedAt = Date.now() - Math.max(0, previousExpectedMs - nextPositionMs);
        }
      }

      return {
        state: {
          channel_id: payload.channelId,
          current_item_id: nextCurrentItemId,
          position_ms: nextPositionMs,
          duration_ms: nextDurationMs,
          playing: nextPlaying,
          updated_at: nextUpdatedAt,
          host_user_id: hostUserId ?? payload.host_user_id ?? s.state?.host_user_id ?? null,
          videoUrl: payload.videoUrl !== undefined ? payload.videoUrl : (s.state?.videoUrl ?? null),
          pendingAutoAdvance: payload.pendingAutoAdvance ?? null,
        },
        hostUserId: hostUserId ?? payload.host_user_id ?? s.hostUserId,
        hostUserIdByChannel: {
          ...s.hostUserIdByChannel,
          [payload.channelId]: hostUserId ?? payload.host_user_id ?? s.hostUserIdByChannel[payload.channelId] ?? null,
        },
      };
    });
    get().addDebugEvent(`sync channel=${payload.channelId} playing=${payload.playing ? '1' : '0'} positionMs=${positionMs ?? payload.position_ms ?? 0} durationMs=${durationMs ?? payload.duration_ms ?? 0} item=${currentItemId ?? payload.current_item_id ?? '-'} updatedAt=${payload.updatedAt ?? Date.now()}`);
  },

  handleQueueUpdated: ({ channelId }) => {
    if (get().activeChannelId !== channelId) return;
    get().fetchQueue(channelId);
  },

  handleHostChanged: ({ channelId, hostUserId }) => {
    if (get().activeChannelId !== channelId) return;
    get().addDebugEvent(`host changed channel=${channelId} host=${hostUserId}`);
    set((s) => ({
      hostUserId,
      hostUserIdByChannel: {
        ...s.hostUserIdByChannel,
        [channelId]: hostUserId,
      },
    }));
  },

  handleUserState: ({ channelId, userId, cameraEnabled, micEnabled, deafened, muted, voiceConnected }) => {
    if (get().activeChannelId !== channelId) return;
    const selfId = get().selfUserId ?? getTheaterSelfId();
    set((s) => ({
      users: s.users.map((u) => u.id === userId ? {
        ...u,
        ...(cameraEnabled !== undefined ? { cameraEnabled } : {}),
        ...(micEnabled !== undefined ? { micEnabled } : {}),
        ...(deafened !== undefined ? { deafened } : {}),
        ...(muted !== undefined ? { muted } : {}),
        ...(voiceConnected !== undefined ? { voiceConnected } : {}),
      } : u),
      roomUsersByChannel: {
        ...s.roomUsersByChannel,
        [channelId]: (s.roomUsersByChannel[channelId] ?? []).map((u) => u.id === userId ? {
          ...u,
          ...(cameraEnabled !== undefined ? { cameraEnabled } : {}),
          ...(micEnabled !== undefined ? { micEnabled } : {}),
          ...(deafened !== undefined ? { deafened } : {}),
          ...(muted !== undefined ? { muted } : {}),
          ...(voiceConnected !== undefined ? { voiceConnected } : {}),
        } : u),
      },
      selfDeafened: userId === selfId && deafened !== undefined ? !!deafened : s.selfDeafened,
    }));
  },

  handleRoomUsers: ({ channelId, users, startedAt }) => {
    set((s) => {
      const selfId = s.selfUserId ?? getTheaterSelfId();
      const selfUser = users.find((entry) => entry.id === selfId);
      const next: Partial<TheaterState> = {
      roomUsersByChannel: { ...s.roomUsersByChannel, [channelId]: users },
      roomStartedAtByChannel: { ...s.roomStartedAtByChannel, [channelId]: startedAt ?? s.roomStartedAtByChannel[channelId] ?? null },
      };
      if (s.activeChannelId === channelId) {
        next.users = users;
        next.selfDeafened = !!selfUser?.deafened;
      }
      return next;
    });
  },

  handleRoomsSnapshot: ({ rooms }) => {
    set((s) => {
      const activeChannels = new Set(rooms.map((room) => room.channelId));
      const byChannel = Object.fromEntries(
        Object.entries(s.roomUsersByChannel).filter(([channelId]) => activeChannels.has(channelId)),
      );
      const startedAt = Object.fromEntries(
        Object.entries(s.roomStartedAtByChannel).filter(([channelId]) => activeChannels.has(channelId)),
      );
      const hostByChannel = Object.fromEntries(
        Object.entries(s.hostUserIdByChannel).filter(([channelId]) => activeChannels.has(channelId)),
      );
      for (const r of rooms) {
        byChannel[r.channelId] = r.users;
        startedAt[r.channelId] = r.startedAt;
        hostByChannel[r.channelId] = s.hostUserIdByChannel[r.channelId] ?? null;
      }
      return {
        roomUsersByChannel: byChannel,
        roomStartedAtByChannel: startedAt,
        hostUserIdByChannel: hostByChannel,
      };
    });
  },

  kickUser: (channelId, userId) => {
    const socket = getTheaterSocket();
    socket?.emit('theater:kick', { channelId, userId });
  },

  cleanup: () => {
    resetTheaterSession(set, get, {
      emitLeave: false,
      clearReconnectTarget: false,
      debugLabel: 'cleanup',
    });
  },

} as TheaterState));
