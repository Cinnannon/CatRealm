import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Eye, Lock, Maximize2, Minimize2, Pin, PictureInPicture2, Volume2, VolumeX, Volume1,
} from 'lucide-react';
import { useChannelStore } from '../../stores/channelStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { EphemeralBotNotices } from '../bots/EphemeralBotNotices';
import { TypingIndicator } from './TypingIndicator';
import { useMessageStore } from '../../stores/messageStore';
import { PERMISSIONS, hasPermission, hasChannelPermission } from '../../utils/permissions';
import { useThreadStore } from '../../stores/threadStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useVoiceStageStore } from '../../stores/voiceStageStore';
import { useMediaStore, isScreenShareCentralLimited } from '../../stores/mediaStore';
import { AvatarImage } from '../ui/AvatarImage';
import { VoiceParticipantTile } from '../voice/VoiceParticipantTile';
import { getVoiceRingClass } from '../voice/voiceRing';
import { resolveAvatarUrl } from '../../utils/avatar';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAudioTapStore, isUserTappedIn, AUDIO_TAP_GLOW_CLASS } from '../../stores/audioTapStore';
import { AudioTracksButton } from '../voice/AudioTracksButton';
import { VoiceCallBackground } from '../voice/VoiceCallBackground';
import { useServerStore } from '../../stores/serverStore';
import { useContentSocialStore } from '../../stores/contentSocialStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { PERMISSION_CATEGORIES } from '../admin/permissionDefinitions';
import { getSocket } from '../../lib/socket';
import { createApi } from '../../lib/api';
import { writeClipboardText } from '../../lib/clipboard';
import { getScreenShareAudioStatus } from '../../lib/desktopCapture';
import { ChatSearchPanel } from './ChatSearchPanel';
import { ChatLoadingSkeleton } from './ChatLoadingSkeleton';
import {
  buildLiveKitScreenCandidates,
  buildUnplayableScreenShares,
  LiveKitScreenTile,
  LiveKitStreamStripTile,
  ScreenShareAudioMixer,
  type LiveKitScreenCandidate,
} from './LiveKitScreenShare';
import { ForumChannel } from './ForumChannel';
import { ForumPostView } from './ForumPostView';
import { TheaterChannel } from '../theater/TheaterChannel';
import { ServerRulesChannel } from '../onboarding/ServerRulesChannel';
import { useViewedChannels } from '../../hooks/useViewedChannels';
import { useViewedPermissions } from '../../hooks/useViewedPermissions';
import type { ForumPost, Message } from '../../types';
import { useLastAudibleVolume } from '../../hooks/useLastAudibleVolume';
import { CHAT_MESSAGE_JUMP_EVENT, type ChatMessageJumpDetail } from './messageJump';

const permissionDefinitions = Object.values(PERMISSION_CATEGORIES).flatMap((category) => category.permissions);

type ScreenShareViewerInfo = {
  id: string;
  username: string;
  avatarUrl: string | null;
};

function getPermissionLabel(bit: number) {
  return permissionDefinitions.find((permission) => permission.bit === bit)?.label ?? 'Unknown Permission';
}

function isRealmRulesChannel(channel: { type?: string } | null | undefined) {
  return channel?.type === 'rules';
}

function NativeCameraPreviewImage({ identity, local, className }: { identity: string; local: boolean; className: string }) {
  const url = useMediaStore((state) => local
    ? state.nativeCameraPreviewUrl
    : Object.values(state.nativeRemoteVideoFrames).find((frame) => frame.kind === 'camera' && frame.identity === identity)?.dataUrl ?? null);
  if (!url) return null;
  return <img src={url} alt="Camera preview" className={className} />;
}

function NativeScreenPreviewImage({ trackSid, local }: { trackSid?: string; local: boolean }) {
  const url = useMediaStore((state) => local
    ? state.nativeScreenPreviewUrl
    : (trackSid ? state.nativeRemoteVideoFrames[trackSid]?.dataUrl ?? null : null));
  if (!url) return null;
  return <img src={url} alt="Screen preview" className="max-h-[65vh] w-full object-contain" />;
}

export function ChatArea() {
  const activeChannelId = useChannelStore((s) => s.activeChannelId);
  const channels = useViewedChannels();
  const viewed = useViewedPermissions();
  const allMembers = usePresenceStore((s) => s.allMembers);
  const user = useAuthStore((s) => s.user);
  const serverInfo = useAuthStore((s) => s.serverInfo);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const activeServerUrl = useServerStore((s) => s.activeServerUrl);
  const openModal = useUIStore((s) => s.openModal);
  const voiceChatOpen = useUIStore((s) => s.voiceChatOpen);
  const voiceStreamListCollapsed = useUIStore((s) => s.voiceStreamListCollapsed);
  const setVoiceStreamListCollapsed = useUIStore((s) => s.setVoiceStreamListCollapsed);
  const setVoiceStreamListRestorable = useUIStore((s) => s.setVoiceStreamListRestorable);
  const fetchPins = useMessageStore((s) => s.fetchPins);
  const fetchThreads = useThreadStore((s) => s.fetchThreads);
  const setActiveThread = useThreadStore((s) => s.setActiveThread);
  const voiceChannelId = useVoiceStore((s) => s.activeChannelId);
  const pendingVoiceChannelId = useVoiceStore((s) => s.pendingChannelId);
  const selfVoiceUserId = useVoiceStore((s) => s.selfVoiceUserId);
  const voiceUsers = useVoiceStore((s) => s.users);
  const voiceRoomUsersByChannel = useVoiceStore((s) => s.voiceRoomUsers);
  const voiceCounts = useVoiceStore((s) => s.voiceCounts);
  const voicePeers = useVoiceStore((s) => s.peers);
  const mediaVoiceChannelId = useMediaStore((s) => (
    s.activeSession?.context === 'voice' ? s.activeSession.channelId ?? null : null
  ));
  const mediaLocalIdentity = useMediaStore((s) => (
    s.activeSession?.context === 'voice' ? s.activeSession.identity : null
  ));
  const mediaParticipants = useMediaStore((s) => s.participants);
  const mediaRemoteTracks = useMediaStore((s) => s.remoteTracks);
  const mediaLocalCameraStream = useMediaStore((s) => s.localCameraStream);
  const nativeLocalScreenActive = useMediaStore((s) => Boolean(s.activeSession?.isNativeVoice && s.isScreenShareEnabled));
  const nativeRemoteVideoFrames = useMediaStore((s) => s.nativeRemoteVideoFrames);
  const screenShareViewersByUser = useMediaStore((s) => s.screenShareViewersByUser);
  const screenShareCentralLimited = useMediaStore(isScreenShareCentralLimited);
  const liveUserIdsByChannel = useVoiceStore((s) => s.liveUserIdsByChannel);
  const peerVolumeByUser = useVoiceStore((s) => s.peerVolumeByUser);
  const voiceSpeaking = useVoiceStore((s) => s.speakingByUser);
  const joinVoice = useVoiceStore((s) => s.joinVoice);
  const setPeerVolume = useVoiceStore((s) => s.setPeerVolume);
  const loadCentralPeerVolumes = useVoiceStore((s) => s.loadCentralPeerVolumes);
  const selfMuted = useVoiceStore((s) => s.selfMuted);
  const selfDeafened = useVoiceStore((s) => s.selfDeafened);
  const connectingVoice = useVoiceStore((s) => s.connecting);
  const voiceError = useVoiceStore((s) => s.error);
  const voiceNotice = useVoiceStore((s) => s.notice);
  const voiceLastEvent = useVoiceStore((s) => s.lastEvent);
  const voiceLastEventAt = useVoiceStore((s) => s.lastEventAt);
  const setSpeaking = useVoiceStore((s) => s.setSpeaking);
  const localVoiceStream = useVoiceStore((s) => s.localStream);
  const screenStream = useVoiceStore((s) => s.screenStream);
  const joinedRemoteStreamIds = useVoiceStageStore((s) => s.joinedRemoteStreamIds);
  const selectedStageStreamId = useVoiceStageStore((s) => s.selectedStageStreamId);
  const streamAudioVolumeById = useVoiceStageStore((s) => s.streamAudioVolumeById);
  const setJoinedRemoteStreamIds = useVoiceStageStore((s) => s.setJoinedRemoteStreamIds);
  const setSelectedStageStreamId = useVoiceStageStore((s) => s.setSelectedStageStreamId);
  const setStreamAudioVolume = useVoiceStageStore((s) => s.setStreamAudioVolume);
  const [voiceTileMenu, setVoiceTileMenu] = useState<{ userId: string; username: string; x: number; y: number } | null>(null);
  const allowNsfw = useContentSocialStore((s) => s.allowNsfw);
  const loadContentSocialPrefs = useContentSocialStore((s) => s.loadPrefs);
  const [temporaryNsfwChannelId, setTemporaryNsfwChannelId] = useState<string | null>(null);
  const [secureModeLocked, setSecureModeLocked] = useState<boolean>(false);
  const [showSecureServerInfo, setShowSecureServerInfo] = useState(false);

  const channel = channels.find((c) => c.id === activeChannelId);
  const channelPermissions = channel?.effective_permissions;
  const canManageChannels = !viewed.isRoleView && hasPermission(viewed.permissions, PERMISSIONS.MANAGE_CHANNELS);
  const canViewPins = hasChannelPermission(viewed.permissions, channelPermissions, PERMISSIONS.READ_CHAT_HISTORY);
  const canConnectToVoice = hasChannelPermission(viewed.permissions, channelPermissions, PERMISSIONS.CONNECT_TO_VOICE);
  const voiceDisabledReason = !canConnectToVoice
    ? `Missing Permissions: ${getPermissionLabel(PERMISSIONS.CONNECT_TO_VOICE)}`
    : undefined;
  const showEncryptedBadge = secureModeLocked || (!!serverInfo?.secureMode?.enabled && !!serverInfo?.secureMode?.locked);
  const pinnedByChannel = useMessageStore((s) => s.pinnedByChannel);
  const pinnedCount = activeChannelId ? (pinnedByChannel[activeChannelId]?.size ?? 0) : 0;
  const isCentral = user?.accountType === 'central';
  const voiceSocketUrl = isCentral ? activeServerUrl : serverUrl;
  const localVoiceTileId = selfVoiceUserId ?? user?.id ?? null;
  const getUserVoiceVolumePct = (userId: string) => peerVolumeByUser[userId] ?? 50;
  const getStreamAudioVolumePct = (streamId: string) => streamAudioVolumeById[streamId] ?? 100;
  const setStreamAudioVolumePct = (streamId: string, volumePct: number) => {
    setStreamAudioVolume(streamId, volumePct);
  };

  // --- Search ---
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const fetchMessages = useMessageStore((s) => s.fetchMessages);
  const messagesByChannel = useMessageStore((s) => s.messagesByChannel);
  const loadingMoreByChannel = useMessageStore((s) => s.loadingMore);
  const [searchOpen, setSearchOpen] = useState(false);
  const [debugCopied, setDebugCopied] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeForumPost, setActiveForumPost] = useState<ForumPost | null>(null);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const catLabAudioTracks = useSettingsStore((s) => s.catLabAudioTracks);
  const audioTapTracks = useAudioTapStore((s) => s.tracks);
  const isUserTapped = (userId: string) => catLabAudioTracks && isUserTappedIn(audioTapTracks, userId);
  const activeChannelMessages = activeChannelId ? messagesByChannel[activeChannelId] : undefined;
  const activeChannelLoading = activeChannelId ? !!loadingMoreByChannel[activeChannelId] : false;
  const showInitialChannelSkeleton = !!activeChannelId && canViewPins && !activeChannelMessages && activeChannelLoading;
  const screenshareFps = useSettingsStore((s) => s.screenshareFps);
  const screenshareResolution = useSettingsStore((s) => s.screenshareResolution);

  useEffect(() => {
    setSearchOpen(false);
    setHighlightedMessageId(null);
    setActiveForumPost(null);
  }, [activeChannelId]);

  useEffect(() => () => {
    if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
  }, []);

  useEffect(() => {
    const handler = () => {
      if (!chatAreaRef.current?.offsetParent) return;
      setSearchOpen((prev) => !prev);
    };
    window.addEventListener('catrealm:keybind:chat-search', handler);
    return () => window.removeEventListener('catrealm:keybind:chat-search', handler);
  }, []);

  const handleJumpToMessage = useCallback(async (messageId: string, timestamp?: number) => {
    if (!activeChannelId) return;
    let target = document.getElementById(`msg-${messageId}`);
    if (!target) {
      let exactMessage: Message | null = null;
      try {
        if (timestamp === undefined) {
          const response = await createApi().get<Message>(`/api/messages/${activeChannelId}/${messageId}`);
          exactMessage = response.data;
          timestamp = exactMessage.created_at;
        }
        await fetchMessages(activeChannelId, timestamp + 1);
        if (!useMessageStore.getState().messagesByChannel[activeChannelId]?.some((message) => message.id === messageId)) {
          if (!exactMessage) {
            const response = await createApi().get<Message>(`/api/messages/${activeChannelId}/${messageId}`);
            exactMessage = response.data;
          }
          // A timestamp can contain more than one page of messages. Keep the exact
          // target available even when it falls outside that page.
          const messageToInsert = exactMessage;
          if (messageToInsert && !messageToInsert.thread_id) {
            useMessageStore.setState((state) => ({
              messagesByChannel: {
                ...state.messagesByChannel,
                [activeChannelId]: [...(state.messagesByChannel[activeChannelId] ?? []), messageToInsert]
                  .sort((a, b) => a.created_at - b.created_at),
              },
            }));
          }
        }
      } catch {
        return;
      }
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        target = document.getElementById(`msg-${messageId}`);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
        setHighlightedMessageId(null);
        requestAnimationFrame(() => setHighlightedMessageId(messageId));
        highlightTimeoutRef.current = setTimeout(() => setHighlightedMessageId(null), 2600);
      });
    });
  }, [activeChannelId, fetchMessages, setHighlightedMessageId]);

  useEffect(() => {
    const onJump = (event: Event) => {
      const { channelId, messageId, timestamp } = (event as CustomEvent<ChatMessageJumpDetail>).detail;
      if (channelId === activeChannelId) void handleJumpToMessage(messageId, timestamp);
    };
    window.addEventListener(CHAT_MESSAGE_JUMP_EVENT, onJump);
    return () => window.removeEventListener(CHAT_MESSAGE_JUMP_EVENT, onJump);
  }, [activeChannelId, handleJumpToMessage]);

  useEffect(() => {
    if (activeChannelId) {
      if (canViewPins) fetchPins(activeChannelId);
      fetchThreads(activeChannelId);
      setActiveThread(null);
    }
  }, [activeChannelId, canViewPins, fetchPins, fetchThreads, setActiveThread]);

  useEffect(() => {
    // Keep voice connected when switching to non-voice channels.
    // Voice disconnects only via explicit user action.
  }, []);

  useEffect(() => {
    if (channel?.type !== 'voice') {
      setVoiceStreamListCollapsed(false);
      setVoiceStreamListRestorable(false);
      setVoiceTileMenu(null);
    }
  }, [channel?.type, setVoiceStreamListCollapsed, setVoiceStreamListRestorable]);

  useEffect(() => {
    if (channel?.type !== 'voice') {
      setVoiceStreamListRestorable(false);
      return;
    }
    const authoritativeLiveIds = new Set(liveUserIdsByChannel[channel.id] ?? []);
    const activeRemoteStageCount = joinedRemoteStreamIds.filter((id) => {
      if (!authoritativeLiveIds.has(id)) return false;
      const stream = voicePeers[id]?.screenStream ?? null;
      return !!stream?.getVideoTracks().some((track) => track.readyState === 'live');
    }).length;
    const stageStreamCount = (screenStream ? 1 : 0) + activeRemoteStageCount;
    setVoiceStreamListRestorable(stageStreamCount > 1 && voiceStreamListCollapsed);
  }, [
    channel?.type,
    joinedRemoteStreamIds,
    liveUserIdsByChannel,
    screenStream,
    setVoiceStreamListRestorable,
    voicePeers,
    voiceStreamListCollapsed,
  ]);

  useEffect(() => {
    if (channel?.type !== 'voice') return;
    const authoritativeLiveIds = new Set(liveUserIdsByChannel[channel.id] ?? []);
    setJoinedRemoteStreamIds((current) => current.filter((id) => authoritativeLiveIds.has(id)));
    setSelectedStageStreamId((current) => {
      if (!current) return current;
      if (current === 'local-screen') return current;
      return authoritativeLiveIds.has(current) ? current : null;
    });
  }, [channel?.id, channel?.type, liveUserIdsByChannel, setJoinedRemoteStreamIds, setSelectedStageStreamId]);

  useEffect(() => {
    if (!voiceTileMenu) return;
    const closeMenu = () => setVoiceTileMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    window.addEventListener('pointerdown', closeMenu);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', closeMenu);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [voiceTileMenu]);

  useEffect(() => {
    if (!serverUrl && !activeServerUrl) return;
    void loadContentSocialPrefs();
    const onPrefsUpdated = () => {
      void loadContentSocialPrefs();
    };
    window.addEventListener('catrealm:content-social-updated', onPrefsUpdated);
    return () => window.removeEventListener('catrealm:content-social-updated', onPrefsUpdated);
  }, [serverUrl, activeServerUrl, loadContentSocialPrefs]);

  useEffect(() => {
    if (user?.accountType !== 'central') return;
    void loadCentralPeerVolumes();
  }, [user?.accountType, user?.id, loadCentralPeerVolumes]);

  useEffect(() => {
    if (!serverUrl && !activeServerUrl) {
      setSecureModeLocked(false);
      return;
    }
    const api = createApi();
    api.get('/api/server')
      .then((res) => {
        const enabled = !!res.data?.secureMode?.enabled;
        const locked = !!res.data?.secureMode?.locked;
        setSecureModeLocked(enabled && locked);
      })
      .catch(() => {
        setSecureModeLocked(false);
      });
  }, [serverUrl, activeServerUrl, user?.accountType]);

  useEffect(() => {
    if (!temporaryNsfwChannelId) return;
    if (activeChannelId && activeChannelId !== temporaryNsfwChannelId) {
      setTemporaryNsfwChannelId(null);
    }
  }, [activeChannelId, temporaryNsfwChannelId]);

  const renderVoiceAudioBridges = () => (
    <>
      {Object.entries(voicePeers).map(([id, peer]) => {
        const voicePeerUser = voiceUsers[id];
        const disabled = selfDeafened || Boolean(voicePeerUser?.muted || voicePeerUser?.deafened);
        return (
          <VoiceAudio
            key={id}
            userId={id}
            stream={peer.stream}
            setSpeaking={setSpeaking}
            disabled={disabled}
            volumePct={getUserVoiceVolumePct(id)}
          />
        );
      })}
      {localVoiceTileId && (
        <VoiceAnalyzer userId={localVoiceTileId} stream={localVoiceStream} setSpeaking={setSpeaking} disabled={selfMuted || selfDeafened} />
      )}
    </>
  );

  if (!channel) {
    if (channels.length === 0) {
      return <ChatLoadingSkeleton />;
    }
    return (
      <div className="flex-1 flex items-center justify-center bg-bg-chat text-text-muted">
        <p>Select a channel to start chatting</p>
      </div>
    );
  }

  if (channel.type === 'voice') {
    const users = Object.values(voiceUsers);
    const inThisVoice = voiceChannelId === channel.id;
    const previewUsers = inThisVoice ? users : (voiceRoomUsersByChannel[channel.id] ?? []);
    const visibleCount = inThisVoice ? users.length : (voiceCounts[channel.id] ?? 0);
    const socket = getSocket(voiceSocketUrl ?? undefined);
    const socketStatus = socket?.connected ? 'connected' : 'disconnected';
    const lastEventAge = voiceLastEventAt ? `${Math.max(0, Math.floor((Date.now() - voiceLastEventAt) / 1000))}s` : 'n/a';
    const micTrack = localVoiceStream?.getAudioTracks?.()[0] ?? null;
    const liveKitActive = mediaVoiceChannelId === channel.id;
    const entries = liveKitActive ? [] : Object.entries(voicePeers);
    const authoritativeLiveIds = new Set(liveUserIdsByChannel[channel.id] ?? []);
    const selfIdentitySet = new Set(
      [user?.id, selfVoiceUserId, localVoiceTileId, mediaLocalIdentity]
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0),
    );
    const isSelfIdentity = (id: string | null | undefined) => !!id && selfIdentitySet.has(id);
    type LegacyScreenCandidate = { id: string; username: string; stream: MediaStream; title: string };
    type RemoteScreenCandidate = LegacyScreenCandidate | LiveKitScreenCandidate;
    type JoinedRemoteScreenTile = RemoteScreenCandidate | { id: string; username: string; stream: null; title: string };
    const legacyRemoteScreenCandidates = entries
      .map(([id, peer]) => {
        if (isSelfIdentity(id)) return null;
        if (!authoritativeLiveIds.has(id)) return null;
        const stream = peer.screenStream;
        const hasLiveVideoTrack = Boolean(
          stream &&
          stream.getVideoTracks().some((track) => track.readyState === 'live'),
        );
        if (!hasLiveVideoTrack) return null;
        const label = voiceUsers[id]?.username || id.slice(0, 6);
        return {
          id,
          username: label,
          stream,
          title: `${label}'s Screen`,
        };
      })
      .filter((tile): tile is LegacyScreenCandidate => Boolean(tile));
    const liveKitScreenCandidates = buildLiveKitScreenCandidates({
      active: liveKitActive,
      tracks: mediaRemoteTracks,
      participants: mediaParticipants,
      voiceUsers,
      selfUserId: localVoiceTileId ?? mediaLocalIdentity ?? user?.id,
      includeSelf: true,
      audibleParticipantIds: new Set(joinedRemoteStreamIds),
    });
    const liveKitSelfScreenCandidate = liveKitScreenCandidates.find((tile) => isSelfIdentity(tile.id)) ?? null;
    const liveKitRemoteScreenCandidates = liveKitScreenCandidates.filter((tile) => !isSelfIdentity(tile.id));
    const remoteScreenCandidates: RemoteScreenCandidate[] = Array.from(
      new Map<string, RemoteScreenCandidate>([...legacyRemoteScreenCandidates, ...liveKitRemoteScreenCandidates].map((tile) => [tile.id, tile])).values(),
    );
    const remoteScreenTiles = remoteScreenCandidates;
    const unplayableRemoteScreens = buildUnplayableScreenShares({
      active: liveKitActive,
      participants: mediaParticipants,
      voiceUsers,
      playableIds: new Set(remoteScreenCandidates.map((tile) => tile.id)),
      selfUserId: localVoiceTileId ?? mediaLocalIdentity ?? user?.id,
    }).filter((share) => !isSelfIdentity(share.id));
    const nativeRemoteScreenFrames = Object.values(nativeRemoteVideoFrames).filter((frame) => frame.kind === 'screen');
    const nativePrimaryScreen = nativeLocalScreenActive
      ? { id: 'native-local-screen', identity: localVoiceTileId ?? mediaLocalIdentity ?? '', trackSid: undefined, local: true, title: 'Your Screen' }
      : nativeRemoteScreenFrames[0]
        ? {
          id: `native-screen-${nativeRemoteScreenFrames[0].trackSid}`,
          identity: nativeRemoteScreenFrames[0].identity,
          trackSid: nativeRemoteScreenFrames[0].trackSid,
          local: false,
          title: `${voiceUsers[nativeRemoteScreenFrames[0].identity]?.username || nativeRemoteScreenFrames[0].identity.slice(0, 6)}'s Screen`,
        }
        : null;
    const joinedRemoteTiles: JoinedRemoteScreenTile[] = joinedRemoteStreamIds.map((id) => (
      remoteScreenCandidates.find((tile) => tile.id === id) ?? {
        id,
        username: voiceUsers[id]?.username || id.slice(0, 6),
        stream: null,
        title: `${voiceUsers[id]?.username || id.slice(0, 6)}'s Screen`,
      }
    ));
    const activeRemoteScreenTiles = joinedRemoteTiles.filter((tile): tile is RemoteScreenCandidate => Boolean(tile.stream));
    const reconnectingRemoteScreenTiles = joinedRemoteTiles.filter((tile) => !tile.stream);
    const hasAnyScreenShareUi = Boolean(screenStream || liveKitSelfScreenCandidate || remoteScreenCandidates.length > 0 || unplayableRemoteScreens.length > 0 || joinedRemoteTiles.length > 0 || nativePrimaryScreen);
    const liveKitCameraStreamsByUser = Object.values(mediaRemoteTracks).reduce<Record<string, MediaStream>>((acc, track) => {
      if (track.source !== 'camera' || track.kind !== 'video' || !track.mediaStream) return acc;
      acc[track.participantId] = track.mediaStream;
      return acc;
    }, {});
    const nativeCameraFramesByUser = Object.values(nativeRemoteVideoFrames).reduce<Record<string, string>>((acc, frame) => {
      if (frame.kind === 'camera') acc[frame.identity] = frame.dataUrl;
      return acc;
    }, {});
    const getVoiceCameraStream = (userId: string) => (
      userId === localVoiceTileId ? mediaLocalCameraStream : liveKitCameraStreamsByUser[userId] ?? null
    );
    const localScreenShareTarget = { height: screenshareResolution, fps: screenshareFps };
    const localViewerMapKey = [mediaLocalIdentity, localVoiceTileId, selfVoiceUserId, user?.id]
      .find((id) => id && Array.isArray(screenShareViewersByUser[id]));
    const localScreenShareViewerIds = localViewerMapKey
      ? screenShareViewersByUser[localViewerMapKey]
      : [];
    const localStreamViewers: ScreenShareViewerInfo[] = localScreenShareViewerIds
      .map((viewerId) => {
        const viewer = voiceUsers[viewerId];
        if (!viewer) return null;
        return {
          id: viewerId,
          username: viewer.username,
          avatarUrl: resolveAvatarUrl(viewer.avatar, serverUrl, viewer.accountType),
        };
      })
      .filter((viewer): viewer is ScreenShareViewerInfo => Boolean(viewer));
    const localNativeWhipScreenTile = !screenStream && liveKitSelfScreenCandidate
      ? {
        id: 'local-screen',
        stream: liveKitSelfScreenCandidate.stream,
        title: 'Your Screen',
        isRemote: false as const,
        liveKitVideoTrack: liveKitSelfScreenCandidate.liveKitVideoTrack,
        remotePublication: liveKitSelfScreenCandidate.remotePublication,
        audioStatus: liveKitSelfScreenCandidate.audioStatus,
        videoTarget: liveKitSelfScreenCandidate.videoTarget ?? localScreenShareTarget,
        viewers: localStreamViewers,
      }
      : null;
    const stageScreenTiles = [
      ...(screenStream ? [{
        id: 'local-screen',
        stream: screenStream,
        title: 'Your Screen',
        isRemote: false as const,
        audioStatus: undefined,
        videoTarget: localScreenShareTarget,
        viewers: localStreamViewers,
      }] : localNativeWhipScreenTile ? [localNativeWhipScreenTile] : []),
      ...activeRemoteScreenTiles.map((tile) => ({
        id: tile.id,
        stream: tile.stream,
        title: tile.title,
        isRemote: true as const,
        liveKitVideoTrack: 'liveKitVideoTrack' in tile ? tile.liveKitVideoTrack : undefined,
        remotePublication: 'remotePublication' in tile ? tile.remotePublication : undefined,
        audioStatus: 'audioStatus' in tile ? tile.audioStatus : undefined,
        videoTarget: 'videoTarget' in tile ? tile.videoTarget : undefined,
        viewers: [] as ScreenShareViewerInfo[],
      })),
    ];
    const primaryStageTile = stageScreenTiles.find((tile) => tile.id === selectedStageStreamId) ?? stageScreenTiles[0] ?? null;
    const stageStripTiles = stageScreenTiles;
    const secondaryStageAudioSources = stageScreenTiles
      .filter((tile) => (
        tile.isRemote
        && tile.id !== primaryStageTile?.id
        && !!tile.liveKitVideoTrack
        && tile.stream.getAudioTracks().length > 0
      ))
      .map((tile) => ({
        id: tile.id,
        stream: tile.stream,
        volumePct: getStreamAudioVolumePct(tile.id),
      }));
    const hasMultipleStageStreams = stageStripTiles.length > 1;
    const showCurrentStreams = hasMultipleStageStreams && !voiceStreamListCollapsed;
    const joinableRemoteScreenTiles = remoteScreenTiles.filter((tile) => !joinedRemoteStreamIds.includes(tile.id));
    const usersSharingScreen = new Set<string>([
      ...((screenStream || liveKitSelfScreenCandidate) ? Array.from(selfIdentitySet) : []),
      ...remoteScreenCandidates.map((tile) => tile.id),
      ...unplayableRemoteScreens.map((share) => share.id),
      ...nativeRemoteScreenFrames.map((frame) => frame.identity),
    ]);
    const usersWatchingStream = new Set<string>(
      Object.values(screenShareViewersByUser).flat(),
    );
    const renderParticipantStatus = (u: { id: string; muted: boolean; deafened: boolean }) => {
      if (usersSharingScreen.has(u.id)) {
        return (
          <span className="text-[10px] font-semibold tracking-wide text-fuchsia-300 animate-pulse">
            Live
          </span>
        );
      }
      if (usersWatchingStream.has(u.id)) {
        return (
          <span className="text-[10px] font-semibold tracking-wide text-sky-300">
            Watching
          </span>
        );
      }
      if (u.muted || u.deafened) {
        return (
          <span className="text-[10px] text-amber-300">
            {u.deafened ? 'Deafened' : 'Muted'}
          </span>
        );
      }
      if (!inThisVoice || u.id === localVoiceTileId) {
        return <span className="text-[10px] text-emerald-300">Connected</span>;
      }
      const liveKitActive = mediaVoiceChannelId === channel.id;
      if (liveKitActive) {
        const hasParticipant = !!mediaParticipants[u.id];
        const hasTrack = Object.values(mediaRemoteTracks).some((track) => track.participantId === u.id);
        if (hasParticipant || hasTrack) {
          return <span className="text-[10px] text-emerald-300">Connected</span>;
        }
        return <span className="text-[10px] text-sky-300">Connecting</span>;
      }
      const peer = voicePeers[u.id];
      const rtcState = peer?.rtcUiState ?? 'pending';
      if (rtcState === 'failed') return <span className="text-[10px] text-rose-300">Failed</span>;
      if (rtcState === 'rtc-connecting') return <span className="text-[10px] text-sky-300">RTC Connecting</span>;
      if (rtcState === 'pending') return <span className="text-[10px] text-white/70">Pending...</span>;
      return <span className="text-[10px] text-emerald-300">Connected</span>;
    };
    const openVoiceTileMenu = (event: React.MouseEvent, userId: string, username: string) => {
      if (!inThisVoice || userId === localVoiceTileId) return;
      event.preventDefault();
      event.stopPropagation();
      setVoiceTileMenu({ userId, username, x: event.clientX, y: event.clientY });
    };
    const participantGridCols =
      previewUsers.length <= 1
        ? 'grid-cols-1'
        : previewUsers.length <= 2
          ? 'grid-cols-1 sm:grid-cols-2'
          : previewUsers.length <= 4
            ? 'grid-cols-2'
            : 'grid-cols-2 xl:grid-cols-3';
    const peerDebug = liveKitActive
      ? 'livekit active'
      : entries.length === 0
      ? 'none'
      : entries.map(([id, peer]) => {
          const label = voiceUsers[id]?.username || id.slice(0, 6);
          const audioTracks = peer.stream?.getAudioTracks() ?? [];
          const videoTracks = peer.screenStream?.getVideoTracks() ?? [];
          const screenAudioTracks = peer.screenStream?.getAudioTracks() ?? [];
          const audioState = audioTracks.length === 0
            ? 'audio=0'
            : `audio=${audioTracks.length} enabled=${audioTracks.map((t) => (t.enabled ? '1' : '0')).join(',')}`;
          const videoState = videoTracks.length === 0
            ? 'video=0'
            : `video=${videoTracks.length} screenAudio=${screenAudioTracks.length}`;
          return `${label}:${peer.rtcUiState} ${audioState} ${videoState}`;
        }).join(' | ');
    const voiceTileMenuX = voiceTileMenu
      ? Math.max(12, Math.min(voiceTileMenu.x, (typeof window !== 'undefined' ? window.innerWidth : voiceTileMenu.x) - 264))
      : 0;
    const voiceTileMenuY = voiceTileMenu
      ? Math.max(12, Math.min(voiceTileMenu.y, (typeof window !== 'undefined' ? window.innerHeight : voiceTileMenu.y) - 140))
      : 0;
    return (
      <div className="flex-1 flex bg-bg-chat min-w-0 min-h-0 overflow-x-hidden">
        <div className="flex-1 flex flex-col px-4 md:px-6 py-4 md:py-5 relative overflow-hidden">
          <VoiceCallBackground />
          <div className="relative mx-auto w-full max-w-6xl flex flex-col h-full min-h-0">
            {voiceNotice && (
              <div className="mt-3 rounded-xl border border-warning/60 bg-warning/10 px-3 py-2 text-xs text-warning">
                {voiceNotice}
              </div>
            )}
            {screenShareCentralLimited && (
              <div className="mt-3 rounded-xl border border-warning/60 bg-warning/10 px-3 py-2 text-xs text-warning">
                Central has enforced limits on bitrate, ask the realm operators to host their own! If you are one, read the{' '}
                <a
                  href="https://catrealm.app/docs/#livekit-server"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:opacity-80"
                >
                  docs
                </a>{' '}
                and have it set up to enjoy your streaming without limits!
              </div>
            )}
            {voiceError && (
              <div className="mt-3 rounded-xl border border-danger/50 bg-danger/10 px-3 py-2 text-xs text-danger">
                {voiceError}
              </div>
            )}

            <div className="flex-1 min-h-0 mt-4 relative">
              <div className={`h-full min-h-0 transition-all duration-300 ${hasAnyScreenShareUi ? 'flex flex-col gap-4' : 'flex flex-col items-center justify-center'}`}>
                {hasAnyScreenShareUi ? (
                  <>
                    <div className="flex-1 min-h-0 overflow-y-auto pr-1">
                      <div className="space-y-3">
                        <ScreenShareAudioMixer sources={secondaryStageAudioSources} />
                        {primaryStageTile && (
                          'liveKitVideoTrack' in primaryStageTile && primaryStageTile.liveKitVideoTrack ? (
                            <LiveKitScreenTile
                              key={primaryStageTile.id}
                              stream={primaryStageTile.stream}
                              title={primaryStageTile.title}
                              liveKitVideoTrack={primaryStageTile.liveKitVideoTrack}
                              remotePublication={primaryStageTile.remotePublication}
                              audioStatus={primaryStageTile.audioStatus}
                              videoTarget={primaryStageTile.videoTarget}
                              volumePct={primaryStageTile.isRemote ? getStreamAudioVolumePct(primaryStageTile.id) : undefined}
                              onVolumePctChange={primaryStageTile.isRemote
                                ? (volumePct) => setStreamAudioVolumePct(primaryStageTile.id, volumePct)
                                : undefined}
                              onLeave={primaryStageTile.isRemote ? () => {
                                setJoinedRemoteStreamIds((current) => current.filter((id) => id !== primaryStageTile.id));
                                setSelectedStageStreamId((current) => (current === primaryStageTile.id ? null : current));
                              } : undefined}
                              peerId={primaryStageTile.isRemote ? primaryStageTile.id : undefined}
                            />
                          ) : (
                            <ScreenTile
                              key={primaryStageTile.id}
                              stream={primaryStageTile.stream}
                              title={primaryStageTile.title}
                              videoTarget={primaryStageTile.videoTarget}
                              viewers={primaryStageTile.viewers}
                              onLeave={primaryStageTile.isRemote ? () => {
                                setJoinedRemoteStreamIds((current) => current.filter((id) => id !== primaryStageTile.id));
                                setSelectedStageStreamId((current) => (current === primaryStageTile.id ? null : current));
                              } : undefined}
                              peerId={primaryStageTile.isRemote ? primaryStageTile.id : undefined}
                            />
                          )
                        )}
                        {!primaryStageTile && nativePrimaryScreen && (
                          <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/40 text-white shadow-xl">
                            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
                              <span className="truncate text-sm font-semibold">{nativePrimaryScreen.title}</span>
                              <span className="text-xs text-emerald-300">Live</span>
                            </div>
                            <div className="flex min-h-0 items-center justify-center bg-black">
                              <NativeScreenPreviewImage trackSid={nativePrimaryScreen.trackSid} local={nativePrimaryScreen.local} />
                            </div>
                          </div>
                        )}

                        {hasMultipleStageStreams && (
                          <div className={`overflow-hidden transition-all duration-300 ease-out ${
                            showCurrentStreams ? 'max-h-72 opacity-100 translate-y-0' : 'max-h-0 opacity-0 -translate-y-2 pointer-events-none'
                          }`}>
                            <div className="rounded-2xl border border-white/10 bg-black/20 backdrop-blur-sm p-3 text-white">
                              <div className="flex items-center justify-between gap-3">
                                <div className="text-sm font-semibold text-white/90">Current Streams</div>
                                <button
                                  type="button"
                                  onClick={() => setVoiceStreamListCollapsed(true)}
                                  className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/80 hover:bg-white/10 hover:text-white"
                                >
                                  Hide List
                                </button>
                              </div>
                              <div className="mt-3 flex gap-3 overflow-x-auto pb-1">
                                {stageStripTiles.map((tile) => (
                                  'liveKitVideoTrack' in tile && tile.liveKitVideoTrack ? (
                                    <LiveKitStreamStripTile
                                      key={`strip-${tile.id}`}
                                      stream={tile.stream}
                                      title={tile.title}
                                      liveKitVideoTrack={tile.liveKitVideoTrack}
                                      selected={primaryStageTile?.id === tile.id}
                                      onClick={() => setSelectedStageStreamId(tile.id)}
                                    />
                                  ) : (
                                    <StreamStripTile
                                      key={`strip-${tile.id}`}
                                      stream={tile.stream}
                                      title={tile.title}
                                      selected={primaryStageTile?.id === tile.id}
                                      onClick={() => setSelectedStageStreamId(tile.id)}
                                    />
                                  )
                                ))}
                              </div>
                            </div>
                          </div>
                        )}

                        {joinableRemoteScreenTiles.length > 0 && (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            {joinableRemoteScreenTiles.map((tile) => (
                              <JoinableStreamTile
                                key={tile.id}
                                title={tile.title}
                                username={tile.username}
                                onWatch={() => {
                                  setJoinedRemoteStreamIds((current) => (current.includes(tile.id) ? current : [...current, tile.id]));
                                  setSelectedStageStreamId(tile.id);
                                }}
                              />
                            ))}
                          </div>
                        )}

                        {unplayableRemoteScreens.length > 0 && (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            {unplayableRemoteScreens.map((share) => (
                              <UnplayableStreamTile key={`unplayable-${share.id}`} username={share.username} mimeType={share.mimeType} />
                            ))}
                          </div>
                        )}

                        {reconnectingRemoteScreenTiles.map((tile) => (
                          <div key={`reconnecting-${tile.id}`} className="rounded-xl border border-white/15 bg-black/20 p-3 text-white">
                            <div className="text-sm font-semibold">{tile.username}'s screen is reconnecting...</div>
                            <div className="mt-1 text-xs text-white/60">
                              The stream briefly dropped while the share source changed. Keeping your slot active.
                            </div>
                            <button
                              type="button"
                              onClick={() => setJoinedRemoteStreamIds((current) => current.filter((id) => id !== tile.id))}
                              className="mt-2 px-3 py-1.5 rounded-lg bg-white text-black text-sm font-medium hover:bg-white/90"
                            >
                              Stop Watching
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="shrink-0 rounded-2xl border border-white/10 bg-black/20 backdrop-blur-sm p-3 min-h-[156px] flex flex-col overflow-hidden">
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <div className="text-white font-semibold text-sm">In Call</div>
                        <div className="flex items-center gap-2">
                          <AudioTracksButton className="rounded-lg !w-7 !h-7" />
                          <div className="text-xs text-white/60">{visibleCount} online</div>
                        </div>
                      </div>
                      <div className="flex-1 min-h-0">
                        <div className="flex gap-3 overflow-x-auto overflow-y-hidden pb-2 pt-1">
                          {previewUsers.map((u) => {
                            const cameraStream = getVoiceCameraStream(u.id);
                            const nativeCameraUrl = nativeCameraFramesByUser[u.id] ?? null;
                            return (
                            <div
                              key={`call-grid-${u.id}`}
                              onContextMenu={(event) => openVoiceTileMenu(event, u.id, u.username)}
                              className={`relative shrink-0 h-24 w-36 overflow-hidden rounded-2xl border-2 ${isUserTapped(u.id) ? AUDIO_TAP_GLOW_CLASS : 'border-white/10'} bg-black/25 text-white md:h-28 md:w-44`}
                              title={inThisVoice && u.id !== localVoiceTileId ? 'Right-click to adjust volume' : undefined}
                            >
                              <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_20%,rgba(255,255,255,0.12),transparent_45%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(0,0,0,0.22))]" />
                              {cameraStream ? (
                                <CameraVideo stream={cameraStream} muted={u.id === localVoiceTileId} className="relative h-full w-full object-cover" />
                              ) : u.id !== localVoiceTileId && nativeCameraUrl ? (
                                <img src={nativeCameraUrl} alt={`${u.username}'s camera`} className="relative h-full w-full object-cover" />
                              ) : (
                                <div className="relative flex h-full items-center justify-center">
                                  <div className={`relative h-12 w-12 rounded-full ${getVoiceRingClass(u, voiceSpeaking[u.id], u.id === localVoiceTileId ? selfMuted : undefined, u.id === localVoiceTileId ? selfDeafened : undefined)} md:h-14 md:w-14`}>
                                    <div className="h-12 w-12 rounded-full avatar-bg flex items-center justify-center overflow-hidden text-base font-semibold text-white md:h-14 md:w-14">
                                      <AvatarImage
                                        src={resolveAvatarUrl(u.avatar, serverUrl, u.accountType)}
                                        alt={u.username}
                                        size={56}
                                        className="h-full w-full object-cover"
                                        fallback={<span>{u.username.charAt(0).toUpperCase()}</span>}
                                      />
                                    </div>
                                  </div>
                                  <NativeCameraPreviewImage
                                    identity={u.id}
                                    local={u.id === localVoiceTileId}
                                    className="absolute inset-0 h-full w-full object-cover"
                                  />
                                </div>
                              )}
                              <div className="absolute left-1.5 top-1.5">
                                {renderParticipantStatus(u)}
                              </div>
                              <p className="absolute bottom-1.5 left-1.5 right-1.5 truncate rounded bg-black/45 px-2 py-1 text-xs font-medium text-white">
                                {u.username}
                              </p>
                            </div>
                            );
                          })}
                          {previewUsers.length === 0 && (
                            <div className="w-full text-xs text-white/45 rounded-lg border border-white/10 bg-black/15 px-3 py-4 text-center">
                              Waiting for someone to join voice...
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <div
                    className={`w-full max-w-5xl transition-all duration-300 ease-out ${
                      hasAnyScreenShareUi ? 'translate-y-6 opacity-90' : 'translate-y-0 opacity-100'
                    }`}
                  >
                    <div className={`grid ${participantGridCols} gap-3 md:gap-4`}>
                      {previewUsers.map((u) => {
                        const cameraStream = getVoiceCameraStream(u.id);
                        const nativeCameraUrl = nativeCameraFramesByUser[u.id] ?? null;
                        return (
                        <VoiceParticipantTile
                          key={`gallery-${u.id}`}
                          onContextMenu={(event) => openVoiceTileMenu(event, u.id, u.username)}
                          highlightClassName={isUserTapped(u.id) ? AUDIO_TAP_GLOW_CLASS : undefined}
                          title={inThisVoice && u.id !== localVoiceTileId ? 'Right-click to adjust volume' : undefined}
                          name={u.username}
                          avatarUrl={resolveAvatarUrl(u.avatar, serverUrl, u.accountType)}
                          ringClassName={getVoiceRingClass(u, voiceSpeaking[u.id], u.id === localVoiceTileId ? selfMuted : undefined, u.id === localVoiceTileId ? selfDeafened : undefined)}
                          status={renderParticipantStatus(u)}
                          media={cameraStream ? (
                            <CameraVideo stream={cameraStream} muted={u.id === localVoiceTileId} className="h-full w-full object-cover" />
                          ) : u.id !== localVoiceTileId && nativeCameraUrl ? (
                            <img src={nativeCameraUrl} alt={`${u.username}'s camera`} className="h-full w-full object-cover" />
                          ) : undefined}
                          avatarOverlay={(
                            <NativeCameraPreviewImage
                              identity={u.id}
                              local={u.id === localVoiceTileId}
                              className="absolute inset-0 h-full w-full object-cover"
                            />
                          )}
                        />
                        );
                      })}
                      {previewUsers.length === 0 && (
                        <div className="col-span-full rounded-2xl border border-white/10 bg-black/20 backdrop-blur-sm px-4 py-10 text-center text-white/55">
                          <div className="text-sm">Waiting for someone to join voice...</div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className={`shrink-0 mt-4 flex items-center justify-center transition-all duration-300 ${hasAnyScreenShareUi ? 'translate-y-0' : '-translate-y-1'}`}>
              {!inThisVoice && (
                <button
                  onClick={() => joinVoice(channel.id)}
                  disabled={connectingVoice || !canConnectToVoice}
                  title={connectingVoice ? 'Joining voice...' : voiceDisabledReason}
                  aria-label={connectingVoice ? 'Joining voice' : !canConnectToVoice ? voiceDisabledReason : 'Join Voice'}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white text-black text-sm font-semibold shadow-lg disabled:opacity-60"
                >
                  {!canConnectToVoice ? 'Voice Disabled' : connectingVoice ? 'Joining...' : 'Join Voice'}
                </button>
              )}
            </div>
          </div>
        </div>
        <div
          className={`bg-bg-chat flex flex-col min-h-0 transition-all duration-300 ease-out overflow-hidden fixed md:relative inset-0 md:inset-auto z-30 md:z-auto ${
            voiceChatOpen ? 'w-full md:w-80 translate-x-0 opacity-100 border-l border-border' : 'w-0 translate-x-full opacity-0 pointer-events-none'
          }`}
        >
          <div className="px-2 py-1 text-[10px] text-text-muted border-b border-border bg-bg-elevated">
            <div className="flex items-start gap-1">
              <div className="flex-1 min-w-0">
                <div className="break-all">
                  Voice Debug - socket {socketStatus} - server {voiceSocketUrl ?? 'n/a'} - active {voiceChannelId ?? 'none'} - pending {pendingVoiceChannelId ?? 'none'} - users {users.length} - peers {Object.keys(voicePeers).length} - mic {micTrack ? (micTrack.enabled ? 'enabled' : 'disabled') : 'none'} - last {voiceLastEvent ?? 'none'} - {lastEventAge}
                </div>
                <div className="break-all mt-0.5">peer-states: {peerDebug}</div>
              </div>
              <button
                type="button"
                onClick={() => {
                  const text = `Voice Debug - socket ${socketStatus} - server ${voiceSocketUrl ?? 'n/a'} - active ${voiceChannelId ?? 'none'} - pending ${pendingVoiceChannelId ?? 'none'} - users ${users.length} - peers ${Object.keys(voicePeers).length} - mic ${micTrack ? (micTrack.enabled ? 'enabled' : 'disabled') : 'none'} - last ${voiceLastEvent ?? 'none'} - ${lastEventAge}\npeer-states: ${peerDebug}`;
                  void writeClipboardText(text).then((ok) => { if (ok) { setDebugCopied(true); window.setTimeout(() => setDebugCopied(false), 1500); } });
                }}
                className="shrink-0 rounded border border-border bg-bg-tertiary px-1.5 py-0.5 text-[9px] text-text-primary hover:bg-bg-hover transition-colors"
                title="Copy voice debug"
              >
                {debugCopied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
          <div className="h-12 px-4 flex items-center gap-2 border-b border-border shadow-sm shrink-0">
            <span className="text-text-muted">#</span>
            <h3 className="font-semibold text-text-primary">{channel.name}</h3>
            <div className="flex-1" />
            {canViewPins && (
              <button
                onClick={() => openModal('pins')}
                className="inline-flex items-center gap-1 text-text-muted hover:text-text-primary text-xs transition-colors"
                title="Pinned Messages"
              >
                <Pin className="h-3.5 w-3.5" /> {pinnedCount}
              </button>
            )}
            {showEncryptedBadge && (
              <button
                type="button"
                onClick={() => setShowSecureServerInfo(true)}
                className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-green-300 bg-green-900/30 border border-green-700/60"
                title="Secure mode is enabled and locked. Click for details."
              >
                <Lock className="h-3.5 w-3.5" /> Encrypted
              </button>
            )}
          </div>
          <MessageList />
          <TypingIndicator />
          <MessageInput threadId={null} allowText forceMediaButton />
        </div>
        {/* Voice chat mobile overlay */}
        {voiceChatOpen && (
          <div
            className="fixed inset-0 bg-black/50 -z-10 md:hidden"
            onClick={() => useUIStore.setState({ voiceChatOpen: false })}
          />
        )}
        {voiceTileMenu && (
          <div
            className="fixed z-50 w-64 rounded-xl border border-white/15 bg-[#15182e]/95 p-3 text-white shadow-2xl backdrop-blur-md"
            style={{ left: voiceTileMenuX, top: voiceTileMenuY }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="text-sm font-semibold truncate">{voiceTileMenu.username}</div>
            <div className="mt-1 text-[11px] text-white/60">Adjust listen volume for this user.</div>
            <label className="mt-3 flex items-center gap-3 text-xs text-white/80">
              <span className="w-10 shrink-0 text-right">{getUserVoiceVolumePct(voiceTileMenu.userId)}%</span>
              <input
                type="range"
                min={0}
                max={300}
                step={5}
                value={getUserVoiceVolumePct(voiceTileMenu.userId)}
                onChange={(event) => {
                  const next = Math.max(0, Math.min(300, Number(event.target.value) || 0));
                  setPeerVolume(voiceTileMenu.userId, next);
                }}
                className="flex-1 accent-emerald-400"
                aria-label={`Volume for ${voiceTileMenu.username}`}
              />
            </label>
          </div>
        )}
        {renderVoiceAudioBridges()}
      </div>
    );
  }

  if (channel.type === 'theater') {
    return <TheaterChannel channel={channel} />;
  }

  if (channel.type === 'forum') {
    if (activeForumPost) {
      return (
        <ForumPostView
          post={activeForumPost}
          channel={channel}
          onBack={() => setActiveForumPost(null)}
        />
      );
    }
    return (
      <ForumChannel
        channel={channel}
        onOpenPost={(post) => setActiveForumPost(post)}
      />
    );
  }

  if (isRealmRulesChannel(channel)) {
    return <ServerRulesChannel />;
  }

  const showNsfwChannelGate =
    !!channel.nsfw &&
    canManageChannels &&
    !allowNsfw &&
    temporaryNsfwChannelId !== channel.id;

  return (
    <div ref={chatAreaRef} className="flex-1 flex flex-col bg-bg-chat min-w-0 min-h-0 relative">
      {/* Channel header */}
      <div className="h-12 px-4 flex items-center gap-2 border-b border-border shadow-sm shrink-0">
        <span className="text-text-muted font-bold text-lg">#</span>
        <h3 className="font-semibold text-text-primary">{channel.name}</h3>
        {channel.description && (
          <>
            <div className="w-px h-5 bg-border mx-1" />
            <span className="text-sm text-text-muted truncate">{channel.description}</span>
          </>
        )}
        <div className="flex-1" />
        {canViewPins && (
          <button
            onClick={() => openModal('pins')}
            className="mr-2 inline-flex items-center gap-1 text-text-muted hover:text-text-primary text-xs transition-colors"
            title="Pinned Messages"
          >
            <Pin className="h-3.5 w-3.5" /> {pinnedCount}
          </button>
        )}
        {showEncryptedBadge && (
          <button
            type="button"
            onClick={() => setShowSecureServerInfo(true)}
            className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-green-300 bg-green-900/30 border border-green-700/60"
            title="Secure mode is enabled and locked. Click for details."
          >
            <Lock className="h-3.5 w-3.5" /> Encrypted
          </button>
        )}
        {canManageChannels && !showEncryptedBadge && (
          <button
            onClick={() => openModal('deleteChannel', channel)}
            className="text-text-muted hover:text-danger text-xs transition-colors"
            title="Delete Channel"
          >
            &#128465;
          </button>
        )}
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
          title="Search messages (Ctrl+F)"
          aria-label="Search messages"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
        </button>
      </div>

      <ChatSearchPanel
        open={searchOpen}
        onClose={() => { setSearchOpen(false); setHighlightedMessageId(null); }}
        channelId={activeChannelId}
        serverUrl={serverUrl || activeServerUrl || undefined}
        timeFormat={timeFormat}
        members={allMembers}
        channels={channels}
        onJump={(messageId, timestamp) => { void handleJumpToMessage(messageId, timestamp); }}
      />

      {showNsfwChannelGate ? (
        <div className="flex-1 p-6">
          <div className="max-w-2xl rounded-lg border border-border bg-bg-input p-4 text-sm text-text-secondary space-y-2">
            <p className="font-semibold text-text-primary">Seeing NSFW is Disabled on this account.</p>
            <p>However, you are seeing this room regardless because you have permission to edit this channel.</p>
            <p>You are able to View NSFW Channels by entering User Settings -&gt; Content &amp; Social -&gt; Allow NSFW toggle should be set to the right (active)</p>
            <p>You can simply ignore this if you wish to not to see NSFW Content and go all about your day :)</p>
            <button
              type="button"
              onClick={() => setTemporaryNsfwChannelId(channel.id)}
              className="mt-2 inline-flex items-center px-3 py-1.5 rounded bg-bg-elevated border border-border text-text-primary hover:bg-bg-hover"
            >
              [View Room Until Leave Channel]
            </button>
          </div>
        </div>
      ) : (
        showInitialChannelSkeleton ? (
          <ChatLoadingSkeleton showHeader={false} showComposer={false} />
        ) : (
          <>
            {/* Messages */}
            <MessageList highlightedMessageId={highlightedMessageId} />

            {/* Ephemeral bot responses ("only you can see this") */}
            <EphemeralBotNotices channelId={channel.id} />

            {/* Typing indicator */}
            <TypingIndicator />

            {/* Input */}
            <MessageInput threadId={null} allowText={channel.type !== 'media'} forceMediaButton />
          </>
        )
      )}

      {showSecureServerInfo && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setShowSecureServerInfo(false)}>
          <div
            className="bg-bg-elevated rounded-lg shadow-2xl w-full max-w-lg overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 border-b border-border flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-emerald-500/20 flex items-center justify-center">
                <svg className="w-6 h-6 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                </svg>
              </div>
              <div>
                <h2 className="text-xl font-bold text-text-primary">Secure Server</h2>
                <p className="text-sm text-text-muted">Message-at-rest encryption is active</p>
              </div>
            </div>

            <div className="p-6 space-y-4 text-text-secondary">
              <div>
                <h3 className="font-semibold text-text-primary mb-2">How It Works</h3>
                <p className="text-sm leading-relaxed">
                  Messages are encrypted using <strong>AES-256-GCM encryption</strong> before being stored in the
                  server database. This protects chat history at rest.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-text-primary mb-2">Secure Mode Lock</h3>
                <p className="text-sm leading-relaxed">
                  This server is running in locked secure mode. Encryption cannot be disabled, and the original
                  secure key must match for the server to start.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-text-primary mb-2">Message Storage</h3>
                <p className="text-sm leading-relaxed">
                  Stored messages use encrypted payloads in the database format (<code>enc:v1:...</code>) and are
                  decrypted only when viewed in the client.
                </p>
              </div>

              <div className="bg-amber-800/70 rounded-lg p-4 border border-amber-600/80">
                <p className="text-xs text-amber-100 leading-relaxed">
                  <strong className="text-amber-100">Technical Note:</strong> This protects stored data and helps reduce
                  plaintext exposure in backups/dumps. Anyone who controls the server runtime and the secure key can still
                  decrypt message content.
                </p>
              </div>
            </div>

            <div className="p-4 border-t border-border flex justify-end">
              <button
                onClick={() => setShowSecureServerInfo(false)}
                className="px-6 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium transition-colors"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
      {renderVoiceAudioBridges()}
    </div>
  );
}

function VoiceAudio({
  userId,
  stream,
  setSpeaking,
  disabled,
  volumePct,
}: {
  userId: string;
  stream: MediaStream | null;
  setSpeaking: (userId: string, speaking: boolean) => void;
  disabled: boolean;
  volumePct: number;
}) {
  const outputDeviceId = useSettingsStore((s) => s.voiceOutputDeviceId);
  const audioRefs = useRef<Array<HTMLAudioElement | null>>([]);
  const getLayerVolumes = () => {
    const scale = Math.max(0, Math.min(300, volumePct)) / 100;
    return [0, 1, 2].map((layer) => Math.max(0, Math.min(1, scale - layer)));
  };
  const applyLayerVolumes = () => {
    const volumes = getLayerVolumes();
    audioRefs.current.forEach((el, index) => {
      if (!el) return;
      el.volume = volumes[index] ?? 0;
      el.muted = disabled || (volumes[index] ?? 0) <= 0;
    });
  };
  const tryPlay = () => {
    audioRefs.current.forEach((el) => {
      if (!el) return;
      el.play().catch(() => {});
    });
  };

  useEffect(() => {
    if (!stream) return;
    audioRefs.current.forEach((el) => {
      if (!el) return;
      el.srcObject = stream;
    });
    applyLayerVolumes();
    tryPlay();
  }, [stream, disabled, volumePct]);

  useEffect(() => {
    applyLayerVolumes();
  }, [disabled, volumePct]);

  useEffect(() => {
    // Depend on `stream` too: audio elements are guarded by `if (!stream) return null`
    // and only render once a peer stream attaches, so setSinkId must re-apply then.
    audioRefs.current.forEach((rawEl) => {
      const el = rawEl as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> } | null;
      if (!el || !el.setSinkId) return;
      const target = outputDeviceId || 'default';
      el.setSinkId(target).catch(() => {
        el.setSinkId?.('default').catch(() => {});
      });
    });
  }, [outputDeviceId, stream]);

  useEffect(() => {
    const onInteract = () => {
      tryPlay();
    };
    window.addEventListener('pointerdown', onInteract);
    window.addEventListener('keydown', onInteract);
    return () => {
      window.removeEventListener('pointerdown', onInteract);
      window.removeEventListener('keydown', onInteract);
    };
  }, []);

  useVoiceActivity(userId, stream, setSpeaking, disabled, 'remote');

  if (!stream) return null;
  return (
    <>
      {[0, 1, 2].map((layer) => (
        <audio
          key={`${userId}-audio-${layer}`}
          ref={(el) => {
            audioRefs.current[layer] = el;
          }}
          autoPlay
          playsInline
          onLoadedMetadata={tryPlay}
          onCanPlay={tryPlay}
        />
      ))}
    </>
  );
}

function VoiceAnalyzer({ userId, stream, setSpeaking, disabled }: { userId: string; stream: MediaStream | null; setSpeaking: (userId: string, speaking: boolean) => void; disabled: boolean }) {
  useVoiceActivity(userId, stream, setSpeaking, disabled, 'local');
  return null;
}

function StreamStripTile({
  stream,
  title,
  selected,
  onClick,
}: {
  stream: MediaStream;
  title: string;
  selected: boolean;
  onClick: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream;
    el.muted = true;
    void el.play().catch(() => {});
  }, [stream]);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative shrink-0 w-56 overflow-hidden rounded-xl border text-left transition-all ${
        selected
          ? 'border-amber-300 shadow-[0_0_0_1px_rgba(252,211,77,0.65)]'
          : 'border-white/10 hover:border-white/30'
      }`}
    >
      <div className="aspect-video bg-black/40">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-cover"
        />
      </div>
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-2 py-1.5">
        <span className="truncate text-[11px] text-white/90">{title}</span>
        {selected && <span className="text-[10px] font-semibold text-amber-300">Selected</span>}
      </div>
    </button>
  );
}

function describeUnplayableCodec(mimeType: string) {
  const codec = mimeType.replace(/^video\//i, '').toUpperCase();
  if (codec === 'H264') {
    return {
      label: 'H.264',
      help: 'Firefox-based browsers play H.264 through the OpenH264 plugin. Enable "OpenH264 Video Codec provided by Cisco Systems" in about:addons → Plugins, restart the browser and rejoin, or watch in the desktop app.',
    };
  }
  if (codec === 'H265' || codec === 'HEVC') {
    return { label: 'H.265', help: 'Watch it in the desktop app or a browser with H.265 (HEVC) support.' };
  }
  return { label: codec, help: 'Watch it in the desktop app or another browser.' };
}

function UnplayableStreamTile({ username, mimeType }: { username: string; mimeType: string }) {
  const { label, help } = describeUnplayableCodec(mimeType);
  return (
    <div className="overflow-hidden rounded-2xl border border-white/15 bg-black/20 text-white shadow-[0_12px_28px_rgba(0,0,0,0.24)]">
      <div className="relative aspect-video overflow-hidden bg-black/60">
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 p-4 text-center">
          <div className="text-sm font-semibold">Can&apos;t play this stream</div>
          <div className="text-xs text-white/70">It&apos;s encoded in {label}, which this browser can&apos;t decode.</div>
        </div>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-3 py-2">
          <div className="truncate text-sm font-semibold text-white">{username}&apos;s Screen</div>
          <div className="truncate text-[11px] text-white/65">{username} is sharing</div>
        </div>
      </div>
      <div className="px-3 py-3 text-xs text-white/65">{help}</div>
    </div>
  );
}

function JoinableStreamTile({
  title,
  username,
  onWatch,
}: {
  title: string;
  username: string;
  onWatch: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-white/15 bg-black/20 text-white shadow-[0_12px_28px_rgba(0,0,0,0.24)]">
      <div className="relative aspect-video overflow-hidden bg-black/40">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_25%_25%,rgba(255,255,255,0.16),transparent_28%),radial-gradient(circle_at_75%_30%,rgba(255,255,255,0.12),transparent_24%),linear-gradient(135deg,rgba(255,255,255,0.12),rgba(255,255,255,0.03))]" />
        <div className="absolute inset-0 bg-black/35 backdrop-blur-md" />
        <div className="absolute inset-0 flex items-center justify-center p-4">
          <button
            type="button"
            onClick={onWatch}
            className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black shadow-lg hover:bg-white/90"
          >
            Watch Stream
          </button>
        </div>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-3 py-2">
          <div className="truncate text-sm font-semibold text-white">{title}</div>
          <div className="truncate text-[11px] text-white/65">{username} is sharing</div>
        </div>
      </div>
      <div className="px-3 py-3 text-xs text-white/65">
        Click to join this stream on stage.
      </div>
    </div>
  );
}

function StreamViewerSummary({ viewers }: { viewers: ScreenShareViewerInfo[] }) {
  if (viewers.length === 0) return null;
  const visibleViewers = viewers.slice(0, 5);
  const extraCount = Math.max(0, viewers.length - visibleViewers.length);
  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-white/15 bg-black/70 px-2.5 py-1.5 text-white shadow-lg backdrop-blur"
      title={viewers.map((viewer) => viewer.username).join(', ')}
    >
      <div className="flex items-center gap-1 text-[11px] font-semibold text-white/90">
        <Eye size={13} />
        <span>{viewers.length}</span>
      </div>
      <div className="flex -space-x-2">
        {visibleViewers.map((viewer) => (
          <div
            key={viewer.id}
            className="h-6 w-6 overflow-hidden rounded-full border border-black/70 bg-white/10"
            title={viewer.username}
          >
            <AvatarImage
              src={viewer.avatarUrl}
              alt={viewer.username}
              size={24}
              className="h-6 w-6 object-cover"
              fallback={(
                <span className="flex h-6 w-6 items-center justify-center text-[10px] font-semibold">
                  {viewer.username.charAt(0).toUpperCase()}
                </span>
              )}
            />
          </div>
        ))}
        {extraCount > 0 && (
          <div className="flex h-6 min-w-6 items-center justify-center rounded-full border border-black/70 bg-white/15 px-1 text-[10px] font-semibold">
            +{extraCount}
          </div>
        )}
      </div>
    </div>
  );
}

function ScreenTile({
  stream,
  title,
  videoTarget,
  viewers = [],
  onLeave,
  peerId,
}: {
  stream: MediaStream;
  title: string;
  videoTarget?: { height: number; fps: number };
  viewers?: ScreenShareViewerInfo[];
  onLeave?: () => void;
  peerId?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const waitingTimerRef = useRef<number | null>(null);

  const [overlayVisible, setOverlayVisible] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPip, setIsPip] = useState(false);
  const [playFailed, setPlayFailed] = useState(false);
  const [waitingForVideo, setWaitingForVideo] = useState(false);
  const [volumePct, setVolumePct] = useState(100);

  // Stable MediaStream — created once; screen video + screen audio tracks synced into it.
  // Never replace srcObject so the video element never re-initialises mid-stream.
  const stableStreamRef = useRef<MediaStream | null>(null);
  if (!stableStreamRef.current) stableStreamRef.current = new MediaStream();
  const audioStatus = getScreenShareAudioStatus(stream);
  const hasStreamAudio = audioStatus.available && stream.getAudioTracks().length > 0;

  const hasRenderableVideo = () => {
    const el = videoRef.current;
    return !!el && el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && el.videoWidth > 0;
  };

  // Debounce the "waiting" overlay — mute/unmute pairs fire rapidly during ICE
  // restarts, so we wait 400 ms before actually showing the spinner.
  const scheduleWaiting = (isWaiting: boolean) => {
    if (!isWaiting) {
      if (waitingTimerRef.current !== null) { window.clearTimeout(waitingTimerRef.current); waitingTimerRef.current = null; }
      setWaitingForVideo(false);
      return;
    }
    if (waitingTimerRef.current !== null) return;
    waitingTimerRef.current = window.setTimeout(() => {
      waitingTimerRef.current = null;
      const vt = stream.getVideoTracks();
      const missingFrames = vt.length === 0 || vt.every((t) => t.readyState !== 'live');
      setWaitingForVideo(missingFrames && !hasRenderableVideo());
    }, 400);
  };

  // Sync the dedicated screen-share tracks into the stable stream ref.
  const syncTracks = () => {
    const ss = stableStreamRef.current!;
    const incoming = stream.getTracks();
    const existing = ss.getTracks();
    existing.forEach((t) => { if (!incoming.includes(t)) ss.removeTrack(t); });
    incoming.forEach((t) => { if (!existing.includes(t)) ss.addTrack(t); });
    const incomingVideo = incoming.filter((track) => track.kind === 'video');
    scheduleWaiting(incomingVideo.length === 0 || incomingVideo.every((t) => t.readyState !== 'live'));
  };

  const tryPlay = () => {
    const el = videoRef.current;
    if (!el || !el.paused) return;
    el.play().then(() => setPlayFailed(false)).catch(() => setPlayFailed(true));
  };

  // ── PIP ───────────────────────────────────────────────────────────────────────
  const enterPip = () => {
    const el = videoRef.current;
    if (!el || !(document as any).pictureInPictureEnabled) return;
    // Set MediaSession metadata so the PIP window shows the stream title
    // instead of the browser default ("File on your device" / document title).
    try {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: `${title} Stream`,
          artist: 'CatRealm',
        });
      }
    } catch { /* MediaMetadata not supported */ }
    el.requestPictureInPicture().catch(() => {});
  };
  const exitPip = () => {
    if ((document as any).pictureInPictureElement) {
      (document as any).exitPictureInPicture().catch(() => {});
    }
  };

  // Auto PIP when the tab becomes hidden; restore when it comes back.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        enterPip();
      } else if ((document as any).pictureInPictureElement === videoRef.current) {
        exitPip();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Track PIP enter/leave so the button label stays in sync.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const onEnter = () => setIsPip(true);
    const onLeave = () => setIsPip(false);
    el.addEventListener('enterpictureinpicture', onEnter);
    el.addEventListener('leavepictureinpicture', onLeave);
    return () => {
      el.removeEventListener('enterpictureinpicture', onEnter);
      el.removeEventListener('leavepictureinpicture', onLeave);
    };
  }, []);

  // ── Volume ────────────────────────────────────────────────────────────────────
  const isMuted = volumePct === 0;
  const getLastAudibleVolumePct = useLastAudibleVolume(volumePct);
  const handleVolumeChange = (v: number) => setVolumePct(Math.round(Math.max(0, Math.min(100, v))));
  const toggleMute = () => setVolumePct(isMuted ? getLastAudibleVolumePct() : 0);

  // ── Stream / track management ──────────────────────────────────────────────
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stableStreamRef.current;
    el.muted = !peerId || !hasStreamAudio || isMuted;
    el.volume = Math.max(0, Math.min(1, volumePct / 100));
    syncTracks();
    tryPlay();
    return () => {
      if (waitingTimerRef.current !== null) window.clearTimeout(waitingTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = !peerId || !hasStreamAudio || isMuted;
    el.volume = Math.max(0, Math.min(1, volumePct / 100));
  }, [hasStreamAudio, isMuted, peerId, volumePct]);

  useEffect(() => {
    let trackCleanups: Array<() => void> = [];
    const bindTrackListeners = () => {
      trackCleanups.forEach((c) => c());
      trackCleanups = stream.getTracks().map((track) => {
        const handleTrackState = () => syncTracks();
        track.addEventListener('mute', handleTrackState);
        track.addEventListener('unmute', handleTrackState);
        track.addEventListener('ended', handleTrackState);
        return () => {
          track.removeEventListener('mute', handleTrackState);
          track.removeEventListener('unmute', handleTrackState);
          track.removeEventListener('ended', handleTrackState);
        };
      });
    };
    const handleStreamChange = () => { bindTrackListeners(); syncTracks(); tryPlay(); };
    handleStreamChange();
    stream.addEventListener('addtrack', handleStreamChange);
    stream.addEventListener('removetrack', handleStreamChange);
    return () => {
      stream.removeEventListener('addtrack', handleStreamChange);
      stream.removeEventListener('removetrack', handleStreamChange);
      trackCleanups.forEach((c) => c());
    };
  }, [stream]);

  useEffect(() => {
    const onInteract = () => tryPlay();
    window.addEventListener('pointerdown', onInteract);
    window.addEventListener('keydown', onInteract);
    return () => { window.removeEventListener('pointerdown', onInteract); window.removeEventListener('keydown', onInteract); };
  }, [stream]);

  // ── Fullscreen ────────────────────────────────────────────────────────────────
  const enterFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    // requestFullscreen is standard; fall back to webkit-prefixed for older Electron.
    const req = (el as any).requestFullscreen ?? (el as any).webkitRequestFullscreen;
    req?.call(el).catch(() => {});
  };
  const exitFullscreen = () => {
    const exit = (document as any).exitFullscreen ?? (document as any).webkitExitFullscreen;
    if ((document as any).fullscreenElement ?? (document as any).webkitFullscreenElement) {
      exit?.call(document).catch(() => {});
    }
  };

  const scheduleHide = () => {
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setOverlayVisible(false), 2500);
  };

  const cancelHide = () => {
    if (hideTimerRef.current) { window.clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
  };

  useEffect(() => {
    if (isFullscreen) {
      setOverlayVisible(true);
      scheduleHide();
    }
    return () => { if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current); };
  }, [isFullscreen]);

  useEffect(() => {
    const onFs = () => {
      const fsEl = (document as any).fullscreenElement ?? (document as any).webkitFullscreenElement;
      setIsFullscreen(fsEl === containerRef.current);
      setOverlayVisible(true);
    };
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('webkitfullscreenchange', onFs);
    };
  }, []);

  // ── Volume icon helper ────────────────────────────────────────────────────────
  const VolumeIcon = isMuted ? VolumeX : volumePct < 50 ? Volume1 : Volume2;

  const pipSupported = typeof document !== 'undefined' && !!(document as any).pictureInPictureEnabled;

  return (
    <div
      ref={containerRef}
      className={`relative w-full overflow-hidden bg-black/40 border border-white/10 shadow-lg group ${
        isFullscreen ? 'h-full rounded-none' : 'aspect-video rounded-xl'
      }`}
      onMouseEnter={() => { setOverlayVisible(true); cancelHide(); }}
      onMouseMove={() => { setOverlayVisible(true); cancelHide(); }}
      onMouseLeave={scheduleHide}
      onDoubleClick={() => { if (isFullscreen) exitFullscreen(); else enterFullscreen(); }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        controls={false}
        className="w-full h-full object-contain"
        onPause={tryPlay}
        onLoadedMetadata={() => { setWaitingForVideo(false); tryPlay(); }}
        onLoadedData={() => { setWaitingForVideo(false); tryPlay(); }}
        onCanPlay={() => { setWaitingForVideo(false); tryPlay(); }}
        onPlaying={() => { setPlayFailed(false); setWaitingForVideo(false); }}
        onContextMenu={(e) => e.preventDefault()}
        style={{ pointerEvents: 'none' }}
      />

      {(videoTarget || viewers.length > 0) && (
        <div className={`absolute left-3 top-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-wrap items-start gap-2 transition-opacity duration-200 ${overlayVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
          {videoTarget && (
            <div className="rounded-lg border border-emerald-300/40 bg-black/70 px-2.5 py-1.5 text-[11px] font-semibold text-white shadow-lg backdrop-blur">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-emerald-200/75">Target</div>
              <div className="flex items-center justify-between gap-3 text-emerald-100">
                <span className="text-white/55">Resolution</span>
                <span>{videoTarget.height}p</span>
              </div>
              <div className="flex items-center justify-between gap-3 text-emerald-100">
                <span className="text-white/55">FPS</span>
                <span>{videoTarget.fps}</span>
              </div>
            </div>
          )}
          <StreamViewerSummary viewers={viewers} />
        </div>
      )}

      {/* Waiting / play-failed overlay */}
      {(playFailed || waitingForVideo) && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/35 px-4 text-center text-white pointer-events-none">
          <div>
            <div className="text-sm font-semibold">
              {waitingForVideo ? 'Waiting for screen frames...' : 'Click to resume screen playback'}
            </div>
            <div className="mt-1 text-xs text-white/70">
              {waitingForVideo
                ? 'The share source is updating. Your place in the stream stays reserved.'
                : 'Browser autoplay blocked the stream until the next interaction.'}
            </div>
          </div>
        </div>
      )}

      {/* Always-visible bottom gradient + title */}
      <div className="absolute bottom-0 left-0 right-0 flex items-center px-3 py-2 bg-gradient-to-t from-black/80 via-black/40 to-transparent pointer-events-none">
        <span className="text-xs text-white/80 truncate">{title}</span>
      </div>

      {/* Controls — fade on inactivity */}
      <div
        className={`absolute bottom-0 left-0 right-0 flex items-center justify-end gap-2 px-3 py-2
          transition-opacity duration-200
          ${overlayVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {onLeave && (
          <button
            type="button"
            onClick={onLeave}
            className="shrink-0 text-xs px-2 py-0.5 rounded bg-white/20 hover:bg-white/30 text-white"
          >
            Stop Watching
          </button>
        )}
        {peerId && hasStreamAudio && (
          <div className="shrink-0 flex items-center gap-1.5">
            <span className="text-[11px] text-white/55">{audioStatus.label}</span>
            <button
              type="button"
              onClick={toggleMute}
              className="text-white/70 hover:text-white"
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              <VolumeIcon size={16} />
            </button>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={isMuted ? 0 : volumePct}
              onChange={(e) => handleVolumeChange(Number(e.target.value))}
              className="w-20 h-1 accent-white cursor-pointer"
              title={`Volume: ${isMuted ? 0 : volumePct}%`}
            />
          </div>
        )}
        {peerId && !hasStreamAudio && (
          <div className="shrink-0 flex items-center gap-1 text-white/45" title="This stream has no shared audio track">
            <VolumeX size={16} />
            <span className="text-[11px]">No audio</span>
          </div>
        )}
        {pipSupported && (
          <button
            type="button"
            onClick={isPip ? exitPip : enterPip}
            className="shrink-0 text-white/70 hover:text-white"
            title={isPip ? 'Exit Picture-in-Picture' : 'Picture-in-Picture'}
          >
            <PictureInPicture2 size={16} />
          </button>
        )}
        <button
          type="button"
          onClick={isFullscreen ? exitFullscreen : enterFullscreen}
          className="shrink-0 text-white/70 hover:text-white"
          title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
        >
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>
    </div>
  );
}

function useVoiceActivity(
  userId: string,
  stream: MediaStream | null,
  setSpeaking: (userId: string, speaking: boolean) => void,
  disabled: boolean,
  mode: 'local' | 'remote' = 'remote',
) {
  useEffect(() => {
    if (!stream) return;
    if (disabled || stream.getAudioTracks().every((t) => !t.enabled)) {
      setSpeaking(userId, false);
      return;
    }
    const audioCtx = new (window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)();
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = mode === 'local' ? 0.7 : 0.8;
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;
    let lastSpeaking = false;
    let ema = 0;
    let noiseFloor = 0;
    const alpha = mode === 'local' ? 0.5 : 0.35;
    const levelBoost = mode === 'local' ? 2.2 : 1;
    const speakOn = mode === 'local' ? 0.0045 : 0.02;
    const speakOff = mode === 'local' ? 0.0025 : 0.01;
    const minAboveFrames = mode === 'local' ? 2 : 3;
    const minBelowFrames = mode === 'local' ? 4 : 6;
    let aboveCount = 0;
    let belowCount = 0;
    let lastResumeAttempt = 0;
    const tick = () => {
      if (disabled || stream.getAudioTracks().every((t) => !t.enabled)) {
        if (lastSpeaking) {
          lastSpeaking = false;
          setSpeaking(userId, false);
        }
        raf = requestAnimationFrame(tick);
        return;
      }
      if (audioCtx.state !== 'running') {
        const now = Date.now();
        if (now - lastResumeAttempt > 1000) {
          lastResumeAttempt = now;
          audioCtx.resume().catch(() => {});
        }
      }
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rawRms = Math.sqrt(sum / data.length);
      if (mode === 'local') {
        // Learn the baseline mic noise while idle so quiet hiss doesn't pin the ring on.
        const floorAlpha = lastSpeaking ? 0.01 : 0.08;
        noiseFloor = noiseFloor === 0 ? rawRms : floorAlpha * rawRms + (1 - floorAlpha) * noiseFloor;
      }
      const gatedRms = mode === 'local'
        ? Math.max(0, rawRms - noiseFloor * 1.15)
        : rawRms;
      const rms = gatedRms * levelBoost;
      ema = ema === 0 ? rms : alpha * rms + (1 - alpha) * ema;
      if (ema > speakOn) {
        aboveCount += 1;
        belowCount = 0;
      } else if (ema < speakOff) {
        belowCount += 1;
        aboveCount = 0;
      }
      if (!lastSpeaking && aboveCount >= minAboveFrames) {
        lastSpeaking = true;
        setSpeaking(userId, true);
      } else if (lastSpeaking && belowCount >= minBelowFrames) {
        lastSpeaking = false;
        setSpeaking(userId, false);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      source.disconnect();
      analyser.disconnect();
      audioCtx.close().catch(() => {});
      setSpeaking(userId, false);
    };
  }, [userId, stream, setSpeaking, disabled, mode]);
}

function CameraVideo({
  stream,
  muted,
  className,
}: {
  stream: MediaStream;
  muted?: boolean;
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream;
    el.muted = muted ?? true;
    void el.play().catch(() => {});
    return () => {
      el.srcObject = null;
    };
  }, [muted, stream]);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted={muted ?? true}
      className={className}
    />
  );
}
