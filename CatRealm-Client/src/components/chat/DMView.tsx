import { getCentralDeviceHeaders } from '../../lib/centralDeviceCredentials';
import { MentionProvider } from './mentions';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import axios from 'axios';
import { isHttpGatewayRealm } from '../../lib/httpRealmGateway';
import { useDMStore } from '../../stores/dmStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { isAppInBackground } from '../../lib/desktopNotifications';
import { useServerStore } from '../../stores/serverStore';
import { useCallStore } from '../../stores/callStore';
import { useBlockedUsersStore } from '../../stores/blockedUsersStore';
import { DMRequestActions } from './DMRequestActions';
import { defaultAvatarUrl, resolveAvatarUrl } from '../../utils/avatar';
import { getSocket } from '../../lib/socket';
import { AUTH_BASE, createAuthenticatedApi } from '../../lib/authApi';
import { createApi } from '../../lib/api';
import { buildDmContextText, dmContextPreviewText, parseDmContextText } from '../../lib/dmContext';
import { getInitialDmConversation } from '../../lib/dmSelection';
import { Clock3, Lock, X, Zap } from 'lucide-react';
import {
  buildExpressionToken,
  buildCompactExpressionToken,
  normalizeExpressionName,
  type EmoteSuggestion,
  EMPTY_EXPRESSION_MANIFEST as EMPTY_MANIFEST,
  type ExpressionItem,
  type ExpressionManifest,
  presenceDotClass as dmPresenceDotClass,
  type PickerExpressionItem,
  type PickerServer,
  formatPresenceStatusLabel as formatDMPresenceStatusLabel,
  hasBigIntPermission,
  normalizeServerOrigin,
  resolveServerIcon as resolveDMServerIcon,
  sanitizeCompactEmoteTokens,
  PERSONAL_PICKER_SERVER_URL,
  DEFAULT_PICKER_SERVER_URL,
} from '../../lib/expressions';
import {
  DEFAULT_EMOJI_CATEGORIES,
  DEFAULT_CATEGORY_SEARCH_KEYWORDS,
  loadEmojiMetadataLookup,
  getEmojiMetadataLookupCache,
  normalizeEmojiGlyph,
  normalizeEmojiSearchText,
  toEmojiSearchTerms,
  type DefaultEmojiCategory,
  type EmojiMetadataLookup,
} from '../../lib/emojiMetadata';
import { hasPermission, PERMISSIONS } from '../../utils/permissions';
import type { DMMessage } from '../../types';
import { dispatchMessageForward, dispatchMessageReply, executeMessageShortcutAction, getShortcutActionFromEvent } from '../../messaging/chatlib/messageActions';
import { COMPACT_EMOTE_TOKEN_REGEX } from '../../messaging/chatlib/messageTokenParser';
import {
  useDefaultEmojiSearchAdapter,
  useComposerExpressionPickerActions,
  useComposerTransportAdapter,
  useExpressionPickerAdapter,
  useExpressionPickerDataAdapter,
  useReplyForwardComposerBridge,
} from '../../messaging/chatlib/composerBridge';
import type { DMComposerCoreHandle } from './DMComposerCore';
import { ChatSearchPanel } from './ChatSearchPanel';
import { ScheduleMessageModal } from './ScheduleMessageModal';
import { DMComposer } from './DMComposer';
import { isInsideExpressionPicker } from './SharedExpressionPickerPanel';
import { ComposerSelfPreview } from './ComposerSelfPreview';
import { VoiceMessageRecorder } from './VoiceMessageRecorder';
import { VoiceAutoDeleteModal } from './VoiceAutoDeleteModal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Modal } from '../ui/Modal';
import { DMAttachmentPreview } from './DMAttachmentPreview';
import { DMConversationHeader } from './DMConversationHeader';
import { DMKeyRecoveryPanel } from './DMKeyRecoveryPanel';
import { fetchDMKeyManifest, deriveDMEncryptionState, areAllKeyHoldersBlocked, needsProofToShareDMKey, loadConversationSecretForCurrentDevice, useDMKeyHealthStore, type DMEncryptionState } from '../../messaging/crypto/dmKeyStore';
import { useTranslation } from 'react-i18next';

// Shown on a locked conversation when every key-holding device has a lapsed
// passkey proof — waiting can't fix that; only Re-trust / re-proving can.
function DMKeyRetrustBanner() {
  const { t } = useTranslation();
  return (
    <div className="mx-4 mt-2 px-3 py-2 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 text-sm">
      {t('security.retrustBanner')}
    </div>
  );
}
import { getLocalDeviceId } from '../../lib/deviceIdentity';
import { DMEncryptionInfoModal, DMRetentionSettingsModal } from './DMInfoModals';
import { DMMessageList } from './DMMessageList';
import { DMRetentionBanners } from './DMRetentionBanners';
import { DMEmptyConversationState } from './DMViewStates';
import { ChatLoadingSkeleton } from './ChatLoadingSkeleton';
import { DMCallHeader } from '../calls/DMCallHeader';
import { DMIncomingCallBanner } from '../calls/DMIncomingCallBanner';
import { logDMKeyDebug } from '../../messaging/crypto/dmKeyDebug';

const EXTERNAL_EMOJI_DISCORD_BIT = 0x40000n;
const EXTERNAL_STICKER_DISCORD_BIT = 0x2000000000n;
const EMPTY_DM_PINS: import('../../messaging/pins/dmPinSlice').DMPinnedEntry[] = [];
export function DMView() {
  const emptyNsfwTags = { gore: false, blood: false, lewd: false, spoiler: false } as const;
  const [messageText, setMessageText] = useState('');
  const [selectedAttachments, setSelectedAttachments] = useState<File[]>([]);
  const [selectedAttachmentNsfwTags, setSelectedAttachmentNsfwTags] = useState<{ gore: boolean; blood: boolean; lewd: boolean; spoiler: boolean }>({ ...emptyNsfwTags });
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentOverflowQueue, setAttachmentOverflowQueue] = useState<File[]>([]);
  const [overflowModalOpen, setOverflowModalOpen] = useState(false);
  const [reactionPickerMessageId, setReactionPickerMessageId] = useState<string | null>(null);
  const [reactionPickerAnchor, setReactionPickerAnchor] = useState<{ x: number; y: number } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState<'emojis' | 'stickers'>('emojis');
  const [emojiSearchQuery, setEmojiSearchQuery] = useState('');
  const [defaultEmojiCategory, setDefaultEmojiCategory] = useState<DefaultEmojiCategory>('People');
  const [selectedExpressionServerUrl, setSelectedExpressionServerUrl] = useState<string | null>(null);
  const [expressionStateByServer, setExpressionStateByServer] = useState<Record<string, { loading: boolean; data: ExpressionManifest | null; error: string | null }>>({});
  const [personalManifest, setPersonalManifest] = useState<ExpressionManifest | null>(null);
  const [emojiMetadataLookup, setEmojiMetadataLookup] = useState<EmojiMetadataLookup | null>(() => getEmojiMetadataLookupCache());
  const [isTyping, setIsTyping] = useState(false);
  const typingSentAtRef = useRef(0);
  const [typingTimeout, setTypingTimeout] = useState<number | null>(null);
  const [showE2EInfo, setShowE2EInfo] = useState(false);
  const [dmEncryptionState, setDmEncryptionState] = useState<DMEncryptionState | undefined>(undefined);
  const [localDeviceTrustState, setLocalDeviceTrustState] = useState<string | null>(null);
  const [keyHoldersBlocked, setKeyHoldersBlocked] = useState(false);
  const [needsKeyShareProof, setNeedsKeyShareProof] = useState(false);
  const [peerKeyRecoveryPending, setPeerKeyRecoveryPending] = useState(false);
  const [showRetentionSettings, setShowRetentionSettings] = useState(false);
  const [otherUserTyping, setOtherUserTyping] = useState(false);
  const [retentionDays, setRetentionDays] = useState<number>(365); // Default 1 year
  const [savingRetention, setSavingRetention] = useState(false);
  const [pendingRetentionRequest, setPendingRetentionRequest] = useState<{
    requesterId: string;
    requesterUsername: string;
    retentionDays: number;
    requestId: string;
  } | null>(null);
  const [requestSent, setRequestSent] = useState(false);
  const [requestedDays, setRequestedDays] = useState<number | null>(null);
  const [emoteSuggestOpen, setEmoteSuggestOpen] = useState(false);
  const [emoteSuggestItems, setEmoteSuggestItems] = useState<EmoteSuggestion[]>([]);
  const [emoteSuggestIndex, setEmoteSuggestIndex] = useState(0);
  const [emoteSuggestAnchor, setEmoteSuggestAnchor] = useState<number>(-1);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionItems, setMentionItems] = useState<Array<{ label: string; insert: string; type: string; description?: string; avatar?: string | null; accountType?: 'local' | 'central' }>>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionAnchor, setMentionAnchor] = useState<number>(-1);
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);
  const [replyingToMessage, setReplyingToMessage] = useState<DMMessage | null>(null);
  const [forwardingMessage, setForwardingMessage] = useState<DMMessage | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [showPrivacyModeModal, setShowPrivacyModeModal] = useState(false);
  const [pendingCallMediaType, setPendingCallMediaType] = useState<'audio' | 'video' | null>(null);
  const [, setCallMessageChatOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [pendingScheduledSend, setPendingScheduledSend] = useState<{ text: string; scheduledAt: number } | null>(null);
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceCancelConfirmOpen, setVoiceCancelConfirmOpen] = useState(false);
  const [deleteConfirmMessageId, setDeleteConfirmMessageId] = useState<string | null>(null);
  const [pendingDMVoiceAttachment, setPendingDMVoiceAttachment] = useState<any>(null);
  const [dmVoiceAutoDeleteOpen, setDMVoiceAutoDeleteOpen] = useState(false);

  const user = useAuthStore((s) => s.user);
  const serverInfo = useAuthStore((s) => s.serverInfo);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const servers = useServerStore((s) => s.servers);
  const activeServerUrl = useServerStore((s) => s.activeServerUrl);
  const authOrigin = useMemo(() => normalizeServerOrigin(AUTH_BASE), []);
  const openModal = useUIStore((s) => s.openModal);
  const {
    activeConversationId,
    conversations,
    messagesByConversation,
    unavailableMessagesByConversation,
    hasOlderByConversation,
    loadingOlderByConversation,
    loadingMessagesByConversation,
    openConversation,
    sendMessage,
    loadOlderMessages,
    toggleReaction,
    editMessage,
    deleteMessage,
    markAsRead,
    markConversationUnread,
    loading,
    setDMViewOpen,
    scheduledDMs,
    publishScheduledDM,
    dmPinsByConversation,
    fetchDmPins,
    pinDmMessage,
    unpinDmMessage,
  } = useDMStore();

  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<DMComposerCoreHandle>(null);
  const editInputRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const lastMessagesScrollTopRef = useRef(0);

  const activeConversation = conversations.find((c) => c.id === activeConversationId);
  const dmMentionUsers = useMemo(() => [
    ...(user ? [{ id: user.id, username: user.username, displayName: user.displayName }] : []),
    ...(activeConversation ? [{ id: activeConversation.otherUserId, username: activeConversation.otherUsername, displayName: activeConversation.otherDisplayName }] : []),
  ], [user, activeConversation?.otherUserId, activeConversation?.otherUsername, activeConversation?.otherDisplayName]);
  const keyUpdateRevision = useDMKeyHealthStore((state) => activeConversationId
    ? (state.updatedConversations[activeConversationId] ?? 0)
    : 0);
  const messages = activeConversationId ? messagesByConversation[activeConversationId] || [] : [];
  const unavailableMessages = activeConversationId ? (unavailableMessagesByConversation[activeConversationId] ?? 0) : 0;
  const hasOlderMessages = activeConversationId ? (hasOlderByConversation[activeConversationId] ?? true) : false;
  const loadingOlderMessages = activeConversationId ? !!loadingOlderByConversation[activeConversationId] : false;
  const loadingInitialMessages = activeConversationId ? !!loadingMessagesByConversation[activeConversationId] : false;
  const currentServerUrl = activeServerUrl || serverUrl || null;
  const autoOpeningConversationIdRef = useRef<string | null>(null);

  // --- Search ---
  const dmViewRef = useRef<HTMLDivElement>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
  }, []);

  // --- Pinned messages ---
  const dmPins = activeConversationId ? (dmPinsByConversation[activeConversationId] ?? EMPTY_DM_PINS) : EMPTY_DM_PINS;
  const pinnedDmMessageIds = useMemo(() => new Set(dmPins.map((p) => p.messageId)), [dmPins]);
  useEffect(() => {
    if (activeConversationId) void fetchDmPins(activeConversationId);
  }, [activeConversationId, fetchDmPins]);
  const handleDmPinToggle = useCallback((msg: DMMessage) => {
    if (pinnedDmMessageIds.has(msg.id)) void unpinDmMessage(msg.id);
    else void pinDmMessage(msg.id);
  }, [pinnedDmMessageIds, pinDmMessage, unpinDmMessage]);

  // Call functionality
  const initiateCall = useCallStore((s) => s.initiateCall);
  const activeDMCall = useCallStore((s) => s.activeDMCall);
  const incomingDMCalls = useCallStore((s) => s.incomingDMCalls);
  const lastEndedDMCall = useCallStore((s) => s.lastEndedDMCall);
  const rejoinCall = useCallStore((s) => s.rejoinCall);
  const isOtherUserOnline = activeConversation?.otherStatus && activeConversation.otherStatus !== 'invisible';

  const blockedUsers = useBlockedUsersStore((s) => s.blockedUsers);
  const dmError = useDMStore((s) => s.error);
  const youBlockedThem = activeConversation ? blockedUsers.has(activeConversation.otherUserId) : false;
  const theyBlockedYou = activeConversation?.isBlockedByThem ?? false;
  const requestNeedsResponse = activeConversation?.requestState === 'pending' || activeConversation?.requestState === 'declined';
  const requestWaiting = activeConversation?.outgoingRequestState === 'pending' || activeConversation?.outgoingRequestState === 'declined';
  const isMessagingBlocked = youBlockedThem || theyBlockedYou || requestNeedsResponse || requestWaiting || activeConversation?.canSend === false;

  // Check if there's an active or ringing call for this conversation
  const hasActiveCall = activeDMCall?.status === 'active' && activeConversation?.otherUserId === activeDMCall.otherUserId;
  const hasRingingCall = activeDMCall?.status === 'ringing' && activeConversation?.otherUserId === activeDMCall.otherUserId;
  const activeCallForConversation = activeConversation && activeDMCall?.otherUserId === activeConversation.otherUserId
    ? activeDMCall
    : null;
  const selfCallDisplayName = user?.displayName || user?.username || 'You';
  const selfCallAvatarUrl = resolveAvatarUrl(user?.avatar ?? undefined, AUTH_BASE, 'central')
    ?? defaultAvatarUrl();
  const remoteCallDisplayName = activeConversation?.otherDisplayName || activeConversation?.otherUsername || 'User';
  const remoteCallAvatarUrl = activeConversation
    ? (resolveAvatarUrl(activeConversation.otherAvatar ?? undefined, AUTH_BASE, 'central')
      ?? defaultAvatarUrl())
    : null;

  useEffect(() => {
    if (!hasActiveCall) {
      setCallMessageChatOpen(false);
    }
  }, [hasActiveCall]);

  // Check if there's an incoming call for this conversation
  const incomingCallForThisConversation = activeConversation
    ? Object.values(incomingDMCalls).find((call) => call.callerId === activeConversation.otherUserId)
    : null;

  const canRejoin = !hasActiveCall && !hasRingingCall && lastEndedDMCall?.otherUserId === activeConversation?.otherUserId;

  const handleAudioCall = useCallback(() => {
    if (!activeConversation || isMessagingBlocked) return;
    if (canRejoin) {
      void rejoinCall();
      return;
    }
    setPendingCallMediaType('audio');
    setShowPrivacyModeModal(true);
  }, [activeConversation, isMessagingBlocked, canRejoin, rejoinCall]);

const handlePrivacyModeSelection = useCallback((privacyMode: boolean) => {
    if (!activeConversation || !pendingCallMediaType || isMessagingBlocked) return;

    initiateCall(
      activeConversation.id,
      activeConversation.otherUserId,
      activeConversation.otherDisplayName || activeConversation.otherUsername,
      activeConversation.otherAvatar,
      pendingCallMediaType,
      privacyMode
    );

    setShowPrivacyModeModal(false);
    setPendingCallMediaType(null);
  }, [activeConversation, pendingCallMediaType, initiateCall]);
  const hoveredMessage = useMemo(
    () => messages.find((m) => m.id === hoveredMessageId) ?? null,
    [messages, hoveredMessageId]
  );
  const isPrivileged = user?.role === 'owner' || user?.isOwner || hasPermission(user?.permissions, PERMISSIONS.ADMINISTRATOR);
  const canUseExternalEmojis = isPrivileged || user?.accountType === 'central' || hasBigIntPermission(user?.permissions, EXTERNAL_EMOJI_DISCORD_BIT);
  const canUseExternalStickers = isPrivileged || user?.accountType === 'central' || hasBigIntPermission(user?.permissions, EXTERNAL_STICKER_DISCORD_BIT);
  const canUsePersonalEmotes = true;

  const expressionServers = useMemo<PickerServer[]>(() => {
    const deduped = new Map<string, PickerServer>();

    if (user?.accountType === 'central') {
      servers.forEach((entry) => {
        deduped.set(entry.url, {
          url: entry.url,
          name: entry.name || entry.info?.name || entry.url,
          icon: resolveDMServerIcon(entry.url, entry.icon || entry.info?.serverIcon || null),
          token: entry.token,
          isCurrent: !!currentServerUrl && entry.url === currentServerUrl,
        });
      });
    }

    const serverOrigin = normalizeServerOrigin(serverUrl);
    if (serverUrl && serverOrigin && serverOrigin !== authOrigin && !deduped.has(serverUrl)) {
      deduped.set(serverUrl, {
        url: serverUrl,
        name: serverInfo?.name || 'Current Server',
        icon: resolveDMServerIcon(serverUrl, serverInfo?.serverIcon || null),
        token: token || undefined,
        isCurrent: !!currentServerUrl && serverUrl === currentServerUrl,
      });
    }

    const sorted = Array.from(deduped.values()).sort((a, b) => {
      if (a.isCurrent && !b.isCurrent) return -1;
      if (!a.isCurrent && b.isCurrent) return 1;
      return a.name.localeCompare(b.name);
    });

    const personalIcon = resolveAvatarUrl(
      user?.avatar ?? undefined,
      currentServerUrl || serverUrl || AUTH_BASE,
      user?.accountType
    ) || undefined;

    const withSpecial: PickerServer[] = [];
    if (user?.accountType === 'central') {
      withSpecial.push({
        url: PERSONAL_PICKER_SERVER_URL,
        name: 'Personal',
        icon: personalIcon,
        isCurrent: false,
        isPersonal: true,
      });
    }

    withSpecial.push(...sorted);
    withSpecial.push({
      url: DEFAULT_PICKER_SERVER_URL,
      name: 'Default',
      isCurrent: false,
      isDefault: true,
    });

    return withSpecial;
  }, [user?.accountType, user?.avatar, servers, serverUrl, serverInfo?.name, serverInfo?.serverIcon, token, currentServerUrl, authOrigin]);

  const visibleExpressionServers = useMemo(() => {
    const available = expressionServers.filter((entry) => !isHttpGatewayRealm(entry.url));
    if (canUseExternalEmojis || canUseExternalStickers) return available;
    return available.filter((entry) => entry.isPersonal || entry.isCurrent || entry.isDefault);
  }, [expressionServers, canUseExternalEmojis, canUseExternalStickers]);


  const loadManifest = useCallback(async (entry: PickerServer) => {
    if (entry.isDefault || entry.isPersonal || isHttpGatewayRealm(entry.url)) return;
    const origin = normalizeServerOrigin(entry.url);
    if (!origin || origin === authOrigin) return;
    setExpressionStateByServer((prev) => {
      const existing = prev[entry.url];
      if (existing?.loading || existing?.data) return prev;
      return {
        ...prev,
        [entry.url]: {
          loading: true,
          data: existing?.data ?? null,
          error: null,
        },
      };
    });

    try {
      const api = createApi(entry.url, entry.token);
      const res = await api.get('/api/expressions/manifest');
      const manifest: ExpressionManifest = {
        emotes: Array.isArray(res.data?.emotes) ? res.data.emotes : [],
        'anim-emotes': Array.isArray(res.data?.['anim-emotes']) ? res.data['anim-emotes'] : [],
        stickers: Array.isArray(res.data?.stickers) ? res.data.stickers : [],
        'anim-stickers': Array.isArray(res.data?.['anim-stickers']) ? res.data['anim-stickers'] : [],
      };
      setExpressionStateByServer((prev) => ({
        ...prev,
        [entry.url]: { loading: false, data: manifest, error: null },
      }));
    } catch (err) {
      const msg = axios.isAxiosError(err) ? err.response?.data?.error : null;
      setExpressionStateByServer((prev) => ({
        ...prev,
        [entry.url]: { loading: false, data: null, error: msg || 'Failed to load expressions' },
      }));
    }
  }, [authOrigin]);

  const loadPersonalManifest = useCallback(async () => {
    if (user?.accountType !== 'central' || !token) {
      setPersonalManifest(null);
      return;
    }
    try {
      const api = createAuthenticatedApi();
      const res = await api.get('/api/profile/personal-expressions/manifest');
      const manifest: ExpressionManifest = {
        emotes: Array.isArray(res.data?.emotes) ? res.data.emotes : [],
        'anim-emotes': Array.isArray(res.data?.['anim-emotes']) ? res.data['anim-emotes'] : [],
        stickers: Array.isArray(res.data?.stickers) ? res.data.stickers : [],
        'anim-stickers': Array.isArray(res.data?.['anim-stickers']) ? res.data['anim-stickers'] : [],
      };
      setPersonalManifest(manifest);
    } catch {
      setPersonalManifest(null);
    }
  }, [user?.accountType, token]);

  const clearExpressionServerState = useCallback((url: string) => {
    setExpressionStateByServer((prev) => {
      const next = { ...prev };
      delete next[url];
      return next;
    });
  }, []);
  const {
    effectiveSelectedServerUrl,
    selectedServer,
    selectedServerState,
    selectServer: selectExpressionPickerServer,
    primePickerSelection: primeExpressionPickerSelection,
    retrySelectedServer: retrySelectedExpressionServer,
  } = useExpressionPickerAdapter<PickerServer, ExpressionManifest>({
    visibleServers: visibleExpressionServers,
    selectedServerUrl: selectedExpressionServerUrl,
    setSelectedServerUrl: setSelectedExpressionServerUrl,
    stateByServer: expressionStateByServer,
    loadManifest,
    ensurePersonalManifest: loadPersonalManifest,
    clearServerState: clearExpressionServerState,
  });
  const composerPickerActions = useComposerExpressionPickerActions({
    pickerTab,
    setPickerTab,
    setPickerOpen,
    primePickerSelection: primeExpressionPickerSelection,
    beforeToggle: () => setReactionPickerMessageId(null),
  });
  const {
    selectedManifest,
    selectedIsExternal,
    canUseSelectedEmojiServer,
    canUseSelectedStickerServer,
    filteredSelectedEmoteItems,
    filteredSelectedStickerItems,
  } = useExpressionPickerDataAdapter<PickerServer, ExpressionItem, ExpressionManifest, PickerExpressionItem>({
    selectedServer,
    selectedServerState,
    personalManifest,
    emptyManifest: EMPTY_MANIFEST,
    currentServerUrl,
    serverUrl,
    authBase: AUTH_BASE,
    canUseExternalEmojis,
    canUseExternalStickers,
    searchQuery: emojiSearchQuery,
    buildPickerItem: ({ expression, sourceUrl, kind, isPersonal }) => ({
      expression,
      sourceUrl,
      key: `${isPersonal ? 'personal' : 'server'}-${kind}-${expression.id}`,
      isPersonal,
    }),
  });
  const personalEmoteItems = personalManifest
    ? [...personalManifest['anim-emotes'], ...personalManifest.emotes]
    : [];

  const searchableDefaultEmojiEntries = useMemo(
    () =>
      DEFAULT_EMOJI_CATEGORIES.flatMap((category) =>
        category.emojis.map((emoji, index) => {
          const emojiMetadata = emojiMetadataLookup?.get(emoji) ?? emojiMetadataLookup?.get(normalizeEmojiGlyph(emoji));
          const label = (emojiMetadata?.label ?? '').toLowerCase();
          const alias = label
            .replace(/[^a-z0-9\s]/g, ' ')
            .trim()
            .replace(/\s+/g, '_')
            .replace(/^_+|_+$/g, '') || `emoji_${index}`;
          const keywords = [
            category.name.toLowerCase(),
            ...DEFAULT_CATEGORY_SEARCH_KEYWORDS[category.name],
            emojiMetadata?.label ?? '',
            ...(emojiMetadata?.tags ?? []),
          ];
          return {
            key: `${category.name}-${index}-${emoji}`,
            emoji,
            alias,
            category: category.name,
            searchIndex: normalizeEmojiSearchText(keywords.join(' ')),
          };
        })
      ),
    [emojiMetadataLookup]
  );

  const {
    hasEmojiSearchQuery,
    filteredEntries: defaultEmojiEntries,
  } = useDefaultEmojiSearchAdapter({
    searchQuery: emojiSearchQuery,
    selectedCategory: defaultEmojiCategory,
    entries: searchableDefaultEmojiEntries,
    toSearchTerms: toEmojiSearchTerms,
  });
  const defaultEmojiTypeaheadEntries = useMemo(
    () => searchableDefaultEmojiEntries.filter((entry) => entry.alias.length > 0),
    [searchableDefaultEmojiEntries]
  );

  const resolveExpressionAssetUrl = useCallback((
    expression: ExpressionItem,
    fromServerUrl: string,
    preferredSize?: number,
    options?: { preferRelative?: boolean }
  ) => {
    const absoluteVariants = expression.absolute_variants ?? {};
    const relativeVariants = expression.variants ?? {};
    const useRelative = !!options?.preferRelative && !!currentServerUrl && fromServerUrl === currentServerUrl;
    if (typeof preferredSize === 'number' && Number.isFinite(preferredSize)) {
      const availableSizes = Array.from(
        new Set([
          ...Object.keys(absoluteVariants),
          ...Object.keys(relativeVariants),
        ].map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0))
      ).sort((a, b) => a - b);

      if (availableSizes.length > 0) {
        const exact = availableSizes.find((size) => size === preferredSize);
        const lowerOrEqual = availableSizes.filter((size) => size <= preferredSize);
        const chosen = exact ?? (lowerOrEqual.length > 0 ? lowerOrEqual[lowerOrEqual.length - 1] : availableSizes[0]);
        const chosenKey = String(chosen);
        if (useRelative && relativeVariants[chosenKey]) {
          return relativeVariants[chosenKey];
        }
        if (absoluteVariants[chosenKey]) return absoluteVariants[chosenKey];
        if (relativeVariants[chosenKey]) {
          return /^https?:\/\//i.test(relativeVariants[chosenKey])
            ? relativeVariants[chosenKey]
            : `${fromServerUrl}${relativeVariants[chosenKey]}`;
        }
      }
    }

    if (useRelative && expression.file_url) return expression.file_url;
    if (expression.absolute_url) return expression.absolute_url;
    if (/^https?:\/\//i.test(expression.file_url)) return expression.file_url;
    return `${fromServerUrl}${expression.file_url}`;
  }, [currentServerUrl]);

  const insertIntoComposer = useCallback((insertValue: string, surroundWithSpacing = true) => {
    composerRef.current?.insertTextAtCaret(insertValue, surroundWithSpacing);
  }, []);

  const insertUnicodeEmoji = useCallback((emoji: string) => {
    if (reactionPickerMessageId) {
      void handleAddReaction(reactionPickerMessageId, emoji);
      setReactionPickerMessageId(null);
      setPickerOpen(false);
      return;
    }
    insertIntoComposer(emoji, false);
  }, [insertIntoComposer, reactionPickerMessageId]);

  const insertExpression = useCallback((
    kind: 'emote' | 'sticker',
    expression: ExpressionItem,
    fromServerUrl: string,
    isPersonal = false
  ) => {
    const preferredSize = kind === 'sticker' ? 320 : 64;
    const assetUrl = resolveExpressionAssetUrl(expression, fromServerUrl, preferredSize);
    const ownerTokenId = isPersonal ? (expression.owner_id || user?.id || null) : null;
    const tokenized = buildExpressionToken(
      kind,
      expression.name,
      assetUrl,
      fromServerUrl,
      currentServerUrl,
      ownerTokenId
    );
    if (!tokenized) return;
    if (reactionPickerMessageId) {
      void handleAddReaction(reactionPickerMessageId, tokenized);
      setReactionPickerMessageId(null);
      setPickerOpen(false);
      return;
    }
    if (kind === 'emote') {
      composerRef.current?.insertEmoteAtCaret(tokenized, assetUrl, normalizeExpressionName(expression.name));
    } else {
      composerRef.current?.insertTextAtCaret(tokenized, true);
    }
    setPickerOpen(false);
  }, [resolveExpressionAssetUrl, currentServerUrl, user?.id, reactionPickerMessageId]);

  useEffect(() => {
    setDMViewOpen(true);
    return () => setDMViewOpen(false);
  }, [setDMViewOpen]);


  useEffect(() => {
    setSearchOpen(false);
    setHighlightedMessageId(null);
  }, [activeConversationId]);

  useEffect(() => {
    if (activeConversationId) {
      autoOpeningConversationIdRef.current = null;
      return;
    }
    const firstConversation = getInitialDmConversation(conversations, activeConversationId);
    if (!firstConversation) return;
    if (autoOpeningConversationIdRef.current === firstConversation.id) return;
    autoOpeningConversationIdRef.current = firstConversation.id;
    void openConversation(
      firstConversation.otherUserId,
      firstConversation.otherUsername,
      firstConversation.otherAvatar
    );
  }, [activeConversationId, conversations, openConversation]);

  useEffect(() => {
    const handler = () => {
      if (!dmViewRef.current?.offsetParent) return;
      setSearchOpen((prev) => !prev);
    };
    window.addEventListener('catrealm:keybind:chat-search', handler);
    return () => window.removeEventListener('catrealm:keybind:chat-search', handler);
  }, []);

  useEffect(() => {
    void loadPersonalManifest();
  }, [loadPersonalManifest]);

  useEffect(() => {
    for (const entry of visibleExpressionServers) {
      if (entry.isDefault || entry.isPersonal) continue;
      const state = expressionStateByServer[entry.url];
      if (state?.loading || state?.data || state?.error) continue;
      void loadManifest(entry);
    }
  }, [visibleExpressionServers, expressionStateByServer, loadManifest]);

  useEffect(() => {
    if (!activeConversationId) return;
    const markVisibleConversationRead = () => {
      if (!isAppInBackground()) void markAsRead(activeConversationId);
    };
    markVisibleConversationRead();
    window.addEventListener('focus', markVisibleConversationRead);
    document.addEventListener('visibilitychange', markVisibleConversationRead);
    return () => {
      window.removeEventListener('focus', markVisibleConversationRead);
      document.removeEventListener('visibilitychange', markVisibleConversationRead);
    };
  }, [activeConversationId, markAsRead]);

  useEffect(() => {
    setReactionPickerMessageId(null);
    setPickerOpen(false);
    setEmojiSearchQuery('');
    setEmoteSuggestOpen(false);
    setEmoteSuggestAnchor(-1);
    setOtherUserTyping(false);
    setHoveredMessageId(null);
    setReplyingToMessage(null);
    setForwardingMessage(null);
    setEditingMessageId(null);
    setEditDraft('');
    setCallMessageChatOpen(false);
  }, [activeConversationId]);

  useReplyForwardComposerBridge<DMMessage>({
    setReplying: setReplyingToMessage,
    setForwarding: setForwardingMessage,
    focusInput: () => composerRef.current?.focus(),
  });

  useEffect(() => {
    if (!pickerOpen) {
      if (reactionPickerMessageId) setReactionPickerMessageId(null);
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!pickerRef.current) return;
      if (pickerRef.current.contains(event.target as Node) || isInsideExpressionPicker(event.target)) return;
      setPickerOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
    };
  }, [pickerOpen, reactionPickerMessageId]);

  // Eagerly load emoji metadata on mount so typeahead has real names immediately.
  useEffect(() => {
    if (emojiMetadataLookup) return;
    let cancelled = false;
    void loadEmojiMetadataLookup()
      .then((lookup) => {
        if (!cancelled) setEmojiMetadataLookup(lookup);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load metadata when picker opens (belt-and-suspenders for the mount effect).
  useEffect(() => {
    if (!pickerOpen || emojiMetadataLookup) return;
    let cancelled = false;
    void loadEmojiMetadataLookup()
      .then((lookup) => {
        if (!cancelled) setEmojiMetadataLookup(lookup);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [pickerOpen, emojiMetadataLookup]);

  // Re-run typeahead filter when metadata arrives while suggestions are visible.
  useEffect(() => {
    if (!emoteSuggestOpen || !emojiMetadataLookup) return;
    const caret = composerRef.current?.getCaretPlainOffset() ?? messageText.length;
    updateEmoteSuggestions(messageText, caret);
  // Only re-run when the lookup changes (i.e. metadata just loaded).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emojiMetadataLookup]);

  useEffect(() => {
    if (!editingMessageId) return;
    const el = editInputRef.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    try {
      el.setSelectionRange(len, len);
    } catch {
      // ignore
    }
  }, [editingMessageId]);


  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const container = messagesScrollRef.current;
    if (!container) return;

    if (behavior === 'smooth') {
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      return;
    }

    container.scrollTop = container.scrollHeight;
  }, []);

  const handleMessageMediaLayout = useCallback(() => {
    if (!shouldStickToBottomRef.current) return;
    requestAnimationFrame(() => {
      if (shouldStickToBottomRef.current) scrollToBottom('auto');
    });
  }, [scrollToBottom]);

  // Auto-scroll to bottom when new messages arrive only if user is already near bottom
  useEffect(() => {
    if (shouldStickToBottomRef.current) {
      scrollToBottom('auto');
      const raf = requestAnimationFrame(() => scrollToBottom('auto'));
      return () => cancelAnimationFrame(raf);
    }
  }, [messages, scrollToBottom]);

  // Keep typing indicator visible if user is already reading at the bottom
  useEffect(() => {
    if (otherUserTyping && shouldStickToBottomRef.current) {
      scrollToBottom('auto');
      const raf = requestAnimationFrame(() => scrollToBottom('auto'));
      return () => cancelAnimationFrame(raf);
    }
  }, [otherUserTyping, scrollToBottom]);

  useEffect(() => {
    shouldStickToBottomRef.current = true;
    scrollToBottom('auto');

    const raf = requestAnimationFrame(() => scrollToBottom('auto'));
    const timeoutId = window.setTimeout(() => scrollToBottom('auto'), 90);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timeoutId);
    };
  }, [activeConversationId, scrollToBottom]);

  // Load conversation's retention setting and check for pending requests
  const activeConversationRetentionDays = activeConversation?.retentionDays;
  useEffect(() => {
    if (!activeConversationId) return;

    // Load conversation retention from the conversation object
    setRetentionDays(activeConversationRetentionDays || 365);

    // Check for pending retention requests
    let cancelled = false;
    const checkRetentionRequest = async () => {
      try {
        const res = await fetch(`${AUTH_BASE}/api/dms/conversations/${activeConversationId}/retention-request`, {
          headers: {
            'Authorization': `Bearer ${useAuthStore.getState().token}`,
            ...getCentralDeviceHeaders(),
          },
        });

        if (res.ok && !cancelled) {
          const data = await res.json();
          const currentUserId = useAuthStore.getState().user?.id;
          if (data.request && data.request.requester_id !== currentUserId) {
            setPendingRetentionRequest({
              requesterId: data.request.requester_id,
              requesterUsername: data.request.requesterUsername,
              retentionDays: data.request.requested_days,
              requestId: data.request.id,
            });
          }
        }
      } catch (err) {
        if (!cancelled) console.error('[DM] Failed to check retention request:', err);
      }
    };

    checkRetentionRequest();
    return () => { cancelled = true; };
  }, [activeConversationId, activeConversationRetentionDays]);

  // Reflect the conversation's E2EE state in the header badge. Reset to the
  // calm default on conversation switch so we never flash a stale warning from
  // the previous chat, then resolve the real state from the key manifest.
  useEffect(() => {
    setDmEncryptionState(undefined);
    setLocalDeviceTrustState(null);
    setKeyHoldersBlocked(false);
    setNeedsKeyShareProof(false);
  }, [activeConversationId]);
  useEffect(() => {
    if (!activeConversationId) return;
    let cancelled = false;
    (async () => {
      try {
        const manifest = await fetchDMKeyManifest(activeConversationId);
        const deviceId = getLocalDeviceId();
        const localDevice = manifest.devices.find((device) => device.id === deviceId);
        let encryptionState = deriveDMEncryptionState(manifest, deviceId);
        if (encryptionState === 'synced' && manifest.activeKeyVersion != null) {
          // A server envelope alone does not prove that this device can unwrap it.
          const secret = await loadConversationSecretForCurrentDevice(activeConversationId, manifest.activeKeyVersion)
            .catch(() => null);
          if (!secret) encryptionState = 'locked';
        }
        if (!cancelled) {
          setDmEncryptionState(encryptionState);
          setLocalDeviceTrustState(localDevice?.dmTrustState ?? null);
          setKeyHoldersBlocked(encryptionState === 'locked' && areAllKeyHoldersBlocked(manifest));
          setNeedsKeyShareProof(encryptionState === 'synced' && needsProofToShareDMKey(manifest, deviceId));
        }
      } catch {
        // Keep the badge neutral when the manifest cannot be checked.
      }
    })();
    return () => { cancelled = true; };
  }, [activeConversationId, keyUpdateRevision]);

  // A key-holder may be offline when this DM first opens. Keep requesting the
  // wrapped key while locked so a later reconnect can satisfy it without the
  // user having to close and reopen the conversation.
  useEffect(() => {
    if (!activeConversationId || dmEncryptionState !== 'locked') return;
    const requestKeys = () => {
      logDMKeyDebug('Locked conversation requesting key from peers', {
        conversationId: activeConversationId,
        deviceId: getLocalDeviceId(),
        socketConnected: Boolean(getSocket(AUTH_BASE)?.connected),
      });
      getSocket(AUTH_BASE)?.emit('dm:keys:request', {
        conversationId: activeConversationId,
        deviceId: getLocalDeviceId(),
      });
    };
    requestKeys();
    // 60s: every accepted request costs each connected peer 2-3 rate-limited
    // REST calls to fulfill; with several locked DMs open this stacks fast.
    const interval = window.setInterval(requestKeys, 60_000);
    return () => window.clearInterval(interval);
  }, [activeConversationId, dmEncryptionState]);

  // Listen for typing and retention events from socket
  const activeOtherUserId = activeConversation?.otherUserId;
  useEffect(() => {
    if (!activeConversationId || !activeOtherUserId) return;

    const socket = getSocket(AUTH_BASE);
    if (!socket) return;

    // Typers re-send start every ~2.5s; clear after 6s of silence in case the stop was lost.
    let typingExpiry: ReturnType<typeof setTimeout> | undefined;
    const handleTypingStart = ({ userId }: { userId: string }) => {
      if (userId === activeOtherUserId) {
        setOtherUserTyping(true);
        clearTimeout(typingExpiry);
        typingExpiry = setTimeout(() => setOtherUserTyping(false), 6000);
      }
    };

    const handleTypingStop = ({ userId }: { userId: string }) => {
      if (userId === activeOtherUserId) {
        clearTimeout(typingExpiry);
        setOtherUserTyping(false);
      }
    };

    const handleRetentionRequest = ({ conversationId, requesterId, requesterUsername, retentionDays: reqDays, requestId }: any) => {
      if (conversationId === activeConversationId) {
        setPendingRetentionRequest({ requesterId, requesterUsername, retentionDays: reqDays, requestId });
      }
    };

    const handleRetentionResponse = ({ conversationId, accepted, retentionDays: newDays }: any) => {
      if (conversationId === activeConversationId) {
        // Hide the "request sent" banner
        setRequestSent(false);
        setRequestedDays(null);

        if (accepted) {
          setRetentionDays(newDays);
          setPendingRetentionRequest(null);
          // Reload conversations to get updated retention
          useDMStore.getState().loadConversations();
        } else {
          // Request was rejected
          setPendingRetentionRequest(null);
        }
      }
    };

    socket.on('dm:typing:start', handleTypingStart);
    socket.on('dm:typing:stop', handleTypingStop);
    socket.on('dm:retention:request', handleRetentionRequest);
    socket.on('dm:retention:response', handleRetentionResponse);

    return () => {
      clearTimeout(typingExpiry);
      socket.off('dm:typing:start', handleTypingStart);
      socket.off('dm:typing:stop', handleTypingStop);
      socket.off('dm:retention:request', handleRetentionRequest);
      socket.off('dm:retention:response', handleRetentionResponse);
    };
  }, [activeConversationId, activeOtherUserId]);

  const handleMessagesScroll = useCallback(async () => {
    const container = messagesScrollRef.current;
    if (!container || !activeConversationId) return;

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const movedUp = container.scrollTop < lastMessagesScrollTopRef.current - 1;
    lastMessagesScrollTopRef.current = container.scrollTop;
    // Only a scroll upward un-sticks. Content growing under a pinned view (an
    // image resizing as it decrypts and loads) also fires scroll with a large
    // gap; treating that as "user scrolled away" stopped later media re-pins.
    if (distanceFromBottom < 80) shouldStickToBottomRef.current = true;
    else if (movedUp) shouldStickToBottomRef.current = false;

    if (shouldStickToBottomRef.current) return;
    if (container.scrollTop > 80 || loadingOlderMessages || !hasOlderMessages) return;

    const prevHeight = container.scrollHeight;
    await loadOlderMessages(activeConversationId);

    requestAnimationFrame(() => {
      const target = messagesScrollRef.current;
      if (!target) return;
      const nextHeight = target.scrollHeight;
      target.scrollTop += Math.max(0, nextHeight - prevHeight);
    });
  }, [activeConversationId, hasOlderMessages, loadingOlderMessages, loadOlderMessages]);

  const applyEmoteSuggestion = useCallback((item: EmoteSuggestion) => {
    const caret = composerRef.current?.getCaretPlainOffset() ?? messageText.length;
    const anchor = emoteSuggestAnchor;
    if (anchor < 0 || anchor > caret) return;

    setEmoteSuggestOpen(false);

    if (item.previewImage) {
      composerRef.current?.replaceRangeWithEmote(
        anchor, caret,
        item.insert,
        item.previewImage,
        item.label.replace(/:/g, '')
      );
    } else {
      composerRef.current?.replaceRangeWithText(anchor, caret, item.insert + ' ');
    }

    requestAnimationFrame(() => composerRef.current?.focus());
  }, [messageText, emoteSuggestAnchor]);

  const updateEmoteSuggestions = useCallback((value: string, caret: number): boolean => {
    const upto = value.slice(0, caret);
    const colon = upto.lastIndexOf(':');
    if (colon === -1) {
      setEmoteSuggestOpen(false);
      return false;
    }
    const before = colon === 0 ? ' ' : upto[colon - 1];
    if (before && !/\s/.test(before)) {
      setEmoteSuggestOpen(false);
      return false;
    }
    const query = upto.slice(colon + 1);
    if (!query || query.includes(' ') || query.includes('\n') || query.includes(':') || query.length < 2) {
      setEmoteSuggestOpen(false);
      return false;
    }

    const q = query.toLowerCase();
    const next: EmoteSuggestion[] = [];
    const seen = new Set<string>();

    if (canUsePersonalEmotes && personalEmoteItems.length > 0) {
      personalEmoteItems
        .filter((entry) => entry.name.toLowerCase().includes(q))
        .slice(0, 8)
        .forEach((entry) => {
          const label = `:${entry.name}:`;
          if (seen.has(label)) return;
          seen.add(label);
          // Personal emotes: renderer resolves via ownerId + authOrigin — no server URL needed.
          const ownerId = entry.owner_id || user?.id || null;
          next.push({
            label,
            insert: buildCompactExpressionToken('emote', normalizeExpressionName(entry.name), undefined, ownerId),
            previewImage: entry.absolute_url || (/^https?:\/\//i.test(entry.file_url) ? entry.file_url : `${AUTH_BASE}${entry.file_url}`),
          });
        });
    }

    // Include emotes from all loaded server manifests, not just the active server.
    // Known servers (in visibleExpressionServers) use compact :name: form; truly external
    // servers keep the full :serverUrl:name: form so the renderer can fetch them.
    const knownOrigins = new Set(
      visibleExpressionServers
        .filter((e) => !e.isDefault && !e.isPersonal)
        .map((e) => normalizeServerOrigin(e.url))
        .filter(Boolean) as string[]
    );
    for (const [serverEntryUrl, state] of Object.entries(expressionStateByServer)) {
      if (!state.data) continue;
      const serverOrigin = normalizeServerOrigin(serverEntryUrl);
      const isKnown = !!(serverOrigin && knownOrigins.has(serverOrigin));
      const serverEmotes = [...state.data.emotes, ...state.data['anim-emotes']];
      serverEmotes
        .filter((entry) => entry.name.toLowerCase().includes(q))
        .slice(0, 8)
        .forEach((entry) => {
          const label = `:${entry.name}:`;
          if (seen.has(label)) return;
          seen.add(label);
          next.push({
            label,
            insert: isKnown
              ? buildCompactExpressionToken('emote', normalizeExpressionName(entry.name))
              : buildExpressionToken('emote', entry.name, '', serverEntryUrl, null),
            previewImage: entry.absolute_url || (/^https?:\/\//i.test(entry.file_url) ? entry.file_url : `${serverEntryUrl}${entry.file_url}`),
          });
        });
    }

    defaultEmojiTypeaheadEntries
      .filter((entry) => entry.searchIndex.includes(q) || entry.alias.includes(q))
      .slice(0, 10)
      .forEach((entry) => {
        const label = `:${entry.alias}:`;
        if (seen.has(label)) return;
        seen.add(label);
        next.push({
          label,
          insert: entry.emoji,
          previewEmoji: entry.emoji,
        });
      });

    const items = next.slice(0, 12);
    setEmoteSuggestItems(items);
    setEmoteSuggestIndex(0);
    setEmoteSuggestAnchor(colon);
    setEmoteSuggestOpen(items.length > 0);
    return items.length > 0;
  }, [
    canUsePersonalEmotes,
    personalEmoteItems,
    expressionStateByServer,
    visibleExpressionServers,
    currentServerUrl,
    defaultEmojiTypeaheadEntries,
    user?.id,
  ]);

  const updateMentionSuggestions = useCallback((value: string, caret: number) => {
    const upto = value.slice(0, caret);
    const at = upto.lastIndexOf('@');
    if (at === -1) { setMentionOpen(false); return; }
    const before = at === 0 ? ' ' : upto[at - 1];
    if (before && !/\s/.test(before)) { setMentionOpen(false); return; }
    const query = upto.slice(at + 1);
    if (query.includes(' ') || query.includes('\n')) { setMentionOpen(false); return; }
    const q = query.toLowerCase();
    const items: Array<{ label: string; insert: string; type: string; description?: string; avatar?: string | null; accountType?: 'local' | 'central' }> = [];
    if ('schedule'.includes(q)) {
      items.push({ label: '@schedule', insert: '@schedule', type: 'system', description: 'Send at a future time' });
    }
    const otherUsername = activeConversation?.otherUsername;
    if (otherUsername && otherUsername.toLowerCase().includes(q)) {
      items.push({
        label: `@${otherUsername}`,
        insert: `@${otherUsername}`,
        type: 'user',
        avatar: activeConversation?.otherAvatar ?? null,
        accountType: 'central',
      });
    }
    setMentionItems(items);
    setMentionIndex(0);
    setMentionAnchor(at);
    setMentionOpen(items.length > 0);
  }, [activeConversation]);

  const applyMentionSuggestion = useCallback((item: { insert: string }) => {
    const caret = composerRef.current?.getCaretPlainOffset() ?? messageText.length;
    const anchor = mentionAnchor;
    if (anchor < 0 || anchor > caret) return;
    setMentionOpen(false);
    composerRef.current?.replaceRangeWithText(anchor, caret, item.insert + ' ');
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [messageText, mentionAnchor]);

  const expandDmEmoteTokens = useCallback((text: string): string => {
    if (!text.includes(':')) return text;

    // Build name→origin lookups from all loaded server manifests
    const emoteToOrigin = new Map<string, string>();
    const stickerToOrigin = new Map<string, string>();
    for (const [serverEntryUrl, state] of Object.entries(expressionStateByServer)) {
      if (!state.data) continue;
      const origin = normalizeServerOrigin(serverEntryUrl);
      if (!origin) continue;
      for (const entry of [...state.data.emotes, ...state.data['anim-emotes']]) {
        const n = normalizeExpressionName(entry.name);
        if (n && !emoteToOrigin.has(n)) emoteToOrigin.set(n, origin);
      }
      for (const entry of [...state.data.stickers, ...state.data['anim-stickers']]) {
        const n = normalizeExpressionName(entry.name);
        if (n && !stickerToOrigin.has(n)) stickerToOrigin.set(n, origin);
      }
    }
    if (emoteToOrigin.size === 0 && stickerToOrigin.size === 0) return text;

    const regex = new RegExp(COMPACT_EMOTE_TOKEN_REGEX.source, 'gi');
    return text.replace(
      regex,
      (match, externalServer, _kindExt, _nameExt, _ownerExt, kindLocal, nameLocal, ownerLocal) => {
        // Only expand bare local tokens: no external server URL, no owner ID
        if (externalServer || ownerLocal || !nameLocal) return match;

        const isSticker = kindLocal === 'sticker';
        const n = normalizeExpressionName(nameLocal);
        const origin = isSticker ? stickerToOrigin.get(n) : emoteToOrigin.get(n);
        if (!origin) return match;

        return isSticker ? `:${origin}:sticker:${n}:` : `:${origin}:${n}:`;
      }
    );
  }, [expressionStateByServer]);


  const handleSend = async (e?: React.FormEvent | React.MouseEvent) => {
    e?.preventDefault();
    if ((!messageText.trim() && selectedAttachments.length === 0) || !activeConversation || loading || isMessagingBlocked) return;

    // Stop typing indicator when sending
    const socket = getSocket(AUTH_BASE);
    if (socket) {
      socket.emit('dm:typing:stop', { recipientId: activeConversation.otherUserId });
    }
    setIsTyping(false);
    if (typingTimeout) {
      clearTimeout(typingTimeout);
      setTypingTimeout(null);
    }

    let outgoingText = messageText.trim();
    if (replyingToMessage) {
      const sourcePreview = dmContextPreviewText(replyingToMessage.text);
      const authorLabel = replyingToMessage.senderId === activeConversation.otherUserId
        ? (activeConversation.otherDisplayName || activeConversation.otherUsername)
        : (user?.displayName || user?.username || 'You');
      outgoingText = buildDmContextText({
        v: 1,
        kind: 'reply',
        authorLabel,
        previewText: sourcePreview,
        messageId: replyingToMessage.id,
      }, outgoingText);
    } else if (forwardingMessage) {
      const sourcePreview = dmContextPreviewText(forwardingMessage.text);
      const authorLabel = forwardingMessage.senderId === activeConversation.otherUserId
        ? (activeConversation.otherDisplayName || activeConversation.otherUsername)
        : (user?.displayName || user?.username || 'You');
      outgoingText = buildDmContextText({
        v: 1,
        kind: 'forward',
        authorLabel,
        previewText: sourcePreview,
      }, outgoingText);
    }

    // Sanitize first (on compact tokens), then expand bare :name: tokens to
    // :serverOrigin:name: so MessageFormatter can resolve them even when
    // expressionOrigin is null (DM context, no active game server).
    // Expansion must come AFTER sanitize so sanitize doesn't strip the server
    // URL we just added (it would strip external tokens when canUseExternal is
    // false, or collapse same-server tokens back to the bare compact form).
    const sanitizedText = sanitizeCompactEmoteTokens(
      outgoingText,
      currentServerUrl,
      canUseExternalEmojis,
      canUseExternalStickers
    );
    const normalizedMessageText = expandDmEmoteTokens(sanitizedText);
    const hasScheduleTrigger = /\B@schedule\b/i.test(outgoingText);
    const cleanedText = hasScheduleTrigger
      ? normalizedMessageText.replace(/\B@schedule\b/gi, '').trim()
      : normalizedMessageText;

    if (hasScheduleTrigger) {
      if (!cleanedText && selectedAttachments.length === 0) return;
      setPendingScheduledSend({ text: cleanedText, scheduledAt: 0 });
      setScheduleModalOpen(true);
      return;
    }

    const nsfwTags = selectedAttachments.length > 0
      ? (Object.entries(selectedAttachmentNsfwTags)
        .filter(([, enabled]) => enabled)
        .map(([tag]) => tag))
      : [];
    try {
      await sendMessage(activeConversation.otherUserId, normalizedMessageText, selectedAttachments.length > 0 ? selectedAttachments : null, nsfwTags);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to send message';
      setAttachmentError(msg);
      return;
    }
    setMessageText('');
    composerRef.current?.clear();
    requestAnimationFrame(() => composerRef.current?.focus());
    setEmoteSuggestOpen(false);
    setEmoteSuggestAnchor(-1);
    setPickerOpen(false);
    setAttachmentError(null);
    setReplyingToMessage(null);
    setForwardingMessage(null);
    if (attachmentInputRef.current) {
      attachmentInputRef.current.value = '';
    }
    // If there are queued overflow files, load the next batch automatically
    if (attachmentOverflowQueue.length > 0) {
      const nextBatch = attachmentOverflowQueue.slice(0, DM_MAX_FILES);
      const remaining = attachmentOverflowQueue.slice(DM_MAX_FILES);
      setSelectedAttachments(nextBatch);
      setSelectedAttachmentNsfwTags({ ...emptyNsfwTags });
      setAttachmentOverflowQueue(remaining);
    } else {
      setSelectedAttachments([]);
      setSelectedAttachmentNsfwTags({ ...emptyNsfwTags });
      setAttachmentOverflowQueue([]);
    }
  };

  const handleDMScheduleConfirm = async (date: Date) => {
    setScheduleModalOpen(false);
    if (!activeConversation || !pendingScheduledSend || isMessagingBlocked) return;

    const scheduledAt = Math.floor(date.getTime() / 1000);
    const nsfwTags = selectedAttachments.length > 0
      ? Object.entries(selectedAttachmentNsfwTags).filter(([, v]) => v).map(([k]) => k)
      : [];

    try {
      await sendMessage(activeConversation.otherUserId, pendingScheduledSend.text, null, nsfwTags, null, scheduledAt);
    } catch {
      // error handled by dmStore
    }

    setPendingScheduledSend(null);
    setMessageText('');
    composerRef.current?.clear();
    requestAnimationFrame(() => composerRef.current?.focus());
    setEmoteSuggestOpen(false);
    setEmoteSuggestAnchor(-1);
    setPickerOpen(false);
    setAttachmentError(null);
    setReplyingToMessage(null);
    setForwardingMessage(null);
    if (attachmentInputRef.current) attachmentInputRef.current.value = '';
  };

  const handleVoiceToggle = () => {
    if (voiceMode) {
      setVoiceCancelConfirmOpen(true);
    } else {
      setVoiceMode(true);
    }
  };

  const handleDMVoiceSend = async (blob: Blob, waveformData: number[]) => {
    if (!activeConversation || isMessagingBlocked) return;
    setPendingDMVoiceAttachment({ blob, waveformData });
    setDMVoiceAutoDeleteOpen(true);
  };

  const handleDMVoiceAutoDeleteConfirm = async (expiresAt: number | null) => {
    if (!activeConversation || !pendingDMVoiceAttachment || isMessagingBlocked) return;
    const { blob } = pendingDMVoiceAttachment;
    const voiceFile = new File([blob], 'voice-message.webm', { type: 'audio/webm' });
    setDMVoiceAutoDeleteOpen(false);
    setPendingDMVoiceAttachment(null);
    setVoiceMode(false);
    await sendMessage(activeConversation.otherUserId, '', voiceFile, [], expiresAt);
  };

  const handleMessageTextChange = (text: string, caret = text.length) => {
    setMessageText(text);
    updateEmoteSuggestions(text, caret);
    updateMentionSuggestions(text, caret);

    if (!activeConversation) return;

    const socket = getSocket(AUTH_BASE);
    if (!socket) return;

    // Send typing start event
    // Re-announce every 2.5s while typing continues; the recipient expires silent typers.
    if (text.length > 0 && (!isTyping || Date.now() - typingSentAtRef.current > 2500)) {
      setIsTyping(true);
      typingSentAtRef.current = Date.now();
      socket.emit('dm:typing:start', { recipientId: activeConversation.otherUserId });
    }

    // Clear existing timeout
    if (typingTimeout) {
      clearTimeout(typingTimeout);
    }

    // Set timeout to stop typing after 3 seconds of inactivity
    if (text.length > 0) {
      const timeout = window.setTimeout(() => {
        setIsTyping(false);
        socket.emit('dm:typing:stop', { recipientId: activeConversation.otherUserId });
      }, 3000);
      setTypingTimeout(timeout);
    } else {
      setIsTyping(false);
      socket.emit('dm:typing:stop', { recipientId: activeConversation.otherUserId });
    }
  };

  const handleComposerInput = useCallback((text: string, caret: number) => {
    handleMessageTextChange(text, caret);
  }, [handleMessageTextChange]);

  const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (emoteSuggestOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setEmoteSuggestIndex((i) => (i + 1) % emoteSuggestItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setEmoteSuggestIndex((i) => (i - 1 + emoteSuggestItems.length) % emoteSuggestItems.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const item = emoteSuggestItems[emoteSuggestIndex];
        if (item) applyEmoteSuggestion(item);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setEmoteSuggestOpen(false);
        return;
      }
    }

    if (mentionOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const item = mentionItems[mentionIndex];
        if (item) applyMentionSuggestion(item);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionOpen(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleDelete = (messageId: string) => {
    setDeleteConfirmMessageId(messageId);
  };

  const DM_MAX_FILES = 8;
  const DM_MAX_PER_FILE = (serverInfo?.mediaMaxMb ?? 50) * 1024 * 1024;
  const DM_MAX_TOTAL = DM_MAX_FILES * DM_MAX_PER_FILE;
  const dmMaxMbLabel = serverInfo?.mediaMaxMb ?? 50;

  const setAttachmentsFromFiles = (files: File[]) => {
    if (files.length === 0) {
      setSelectedAttachments([]);
      setSelectedAttachmentNsfwTags({ ...emptyNsfwTags });
      setAttachmentError(null);
      setAttachmentOverflowQueue([]);
      return;
    }

    const oversized = files.find((f) => f.size > DM_MAX_PER_FILE);
    if (oversized) {
      setAttachmentError(`Each attachment must be ${dmMaxMbLabel} MB or smaller.`);
      setSelectedAttachments([]);
      setSelectedAttachmentNsfwTags({ ...emptyNsfwTags });
      if (attachmentInputRef.current) attachmentInputRef.current.value = '';
      return;
    }

    // If more than 8 files, queue the overflow and warn the user
    if (files.length > DM_MAX_FILES) {
      const batch = files.slice(0, DM_MAX_FILES);
      const overflow = files.slice(DM_MAX_FILES);
      setAttachmentOverflowQueue(overflow);
      setOverflowModalOpen(true);
      setAttachmentError(null);
      setSelectedAttachments(batch);
      setSelectedAttachmentNsfwTags({ ...emptyNsfwTags });
      return;
    }

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    if (totalSize > DM_MAX_TOTAL) {
      setAttachmentError(`Total upload size too large. Max is ${DM_MAX_FILES * dmMaxMbLabel} MB across all files in a single message.`);
      setSelectedAttachments([]);
      setSelectedAttachmentNsfwTags({ ...emptyNsfwTags });
      if (attachmentInputRef.current) attachmentInputRef.current.value = '';
      return;
    }

    setAttachmentError(null);
    setAttachmentOverflowQueue([]);
    setSelectedAttachments(files);
    setSelectedAttachmentNsfwTags({ ...emptyNsfwTags });
  };


  const clampFloatingPickerX = useCallback((x: number) => {
    if (typeof window === 'undefined') return x;
    const viewportWidth = window.innerWidth || 0;
    const sideMargin = 16; // Keep a small gutter from viewport edges.
    const panelWidth = Math.min(480, Math.max(240, viewportWidth - (sideMargin * 2)));
    return Math.max(sideMargin, Math.min(x, viewportWidth - sideMargin - panelWidth));
  }, []);

  const clampFloatingPickerY = useCallback((y: number) => {
    if (typeof window === 'undefined') return y;
    const viewportHeight = window.innerHeight || 0;
    const sideMargin = 16;
    const panelHeight = 360;
    return Math.max(sideMargin, Math.min(y, viewportHeight - sideMargin - panelHeight));
  }, []);

  const openReactionPickerForMessage = useCallback((messageId: string) => {
    const nextMessageId = reactionPickerMessageId === messageId ? null : messageId;
    setReactionPickerMessageId(nextMessageId);
    setReactionPickerAnchor(null);
    if (!nextMessageId) {
      setPickerOpen(false);
      return;
    }
    setPickerTab('emojis');
    setPickerOpen(true);
  }, [reactionPickerMessageId]);
  const openReactionPickerForMessageAt = useCallback((messageId: string, event?: ReactMouseEvent<HTMLButtonElement>) => {
    const nextMessageId = reactionPickerMessageId === messageId ? null : messageId;
    setReactionPickerMessageId(nextMessageId);
    if (!nextMessageId) {
      setReactionPickerAnchor(null);
      setPickerOpen(false);
      return;
    }
    setPickerTab('emojis');
    setPickerOpen(true);
    if (event) {
      const rect = event.currentTarget.getBoundingClientRect();
      setReactionPickerAnchor({
        x: Math.round(clampFloatingPickerX(rect.left)),
        y: Math.round(clampFloatingPickerY(rect.bottom + 8)),
      });
    }
  }, [
    clampFloatingPickerX,
    clampFloatingPickerY,
    reactionPickerMessageId,
  ]);

  const handleAddReaction = useCallback(async (messageId: string, emoji: string) => {
    const trimmed = emoji.trim();
    if (!trimmed) return;
    await toggleReaction(messageId, trimmed);
  }, [toggleReaction]);

  const handleEdit = useCallback(async (message: DMMessage) => {
    const current = message.text ?? '';
    const parsed = parseDmContextText(current);
    const visibleBody = parsed ? parsed.bodyText : current;
    if (!visibleBody.trim()) return;
    setEditingMessageId(message.id);
    setEditDraft(visibleBody);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null);
    setEditDraft('');
  }, []);
  const {
    uploadAction: uploadButtonAction,
    pickerAction: pickerButtonAction,
    sendAction: sendButtonAction,
    onFileInputChange: handleAttachmentSelect,
  } = useComposerTransportAdapter({
    keybind: {
      focusText: () => {
        if (!activeConversationId) return;
        composerRef.current?.focus();
      },
      uploadFile: () => {
        if (!activeConversationId || loading) return;
        attachmentInputRef.current?.click();
      },
      togglePicker: (targetTab) => {
        if (!activeConversationId || loading) return;
        composerPickerActions.togglePickerTab(targetTab);
      },
    },
    uiActions: {
      upload: {
        disabled: loading,
        title: 'Attach file',
      },
      picker: {
        disabled: loading,
        title: 'Open emoji/sticker picker',
        ariaLabel: 'Open emoji and sticker picker',
        onClick: () => {
          composerPickerActions.togglePickerButton();
        },
      },
      send: {
        disabled: (!messageText.trim() && selectedAttachments.length === 0) || loading,
        title: 'Send message',
      },
    },
    pasteFiles: {
      enabled: true,
      mode: 'single',
      onFiles: (files) => {
        if (!files[0]) return;
        setAttachmentsFromFiles([files[0]]);
      },
    },
    fileInputChange: {
      enabled: !loading,
      mode: 'multiple',
      onFiles: (files) => {
        setAttachmentsFromFiles(files);
      },
    },
  });

  const handleSaveEdit = useCallback(async () => {
    if (!editingMessageId) return;
    const currentMessage = messages.find((m) => m.id === editingMessageId);
    if (!currentMessage) {
      handleCancelEdit();
      return;
    }

    const current = currentMessage.text ?? '';
    const parsed = parseDmContextText(current);
    const currentVisibleBody = parsed ? parsed.bodyText : current;
    const trimmed = editDraft.trim();
    if (!trimmed) {
      alert('Message cannot be empty.');
      return;
    }
    if (trimmed === currentVisibleBody.trim()) {
      handleCancelEdit();
      return;
    }
    try {
      const nextText = parsed
        ? buildDmContextText({
            v: 1,
            kind: parsed.kind,
            authorLabel: parsed.authorLabel,
            previewText: parsed.previewText,
            messageId: parsed.messageId,
          }, trimmed)
        : trimmed;
      await editMessage(editingMessageId, nextText);
      handleCancelEdit();
    } catch {
      alert('Failed to edit message.');
    }
  }, [editingMessageId, messages, editDraft, editMessage, handleCancelEdit]);

  useEffect(() => {
    const onMessageShortcut = (event: Event) => {
      if (!activeConversation || !hoveredMessage) return;
      const action = getShortcutActionFromEvent(event);
      if (!action) return;

      const selfIds = new Set<string>(
        [user?.id, user?.serverUserId].filter((value): value is string => typeof value === 'string' && value.length > 0)
      );
      const isOwn = selfIds.has(hoveredMessage.senderId);
      executeMessageShortcutAction({
        action,
        message: hoveredMessage,
        getText: (m) => m.text,
        canEdit: isOwn,
        canDelete: isOwn,
        onEdit: (m) => handleEdit(m),
        onDelete: (m) => handleDelete(m.id),
        onMarkUnread: (m) => markConversationUnread(activeConversation.id, m.id),
        onAddReaction: (m) => openReactionPickerForMessage(m.id),
        onReply: (m) => dispatchMessageReply(m),
        onForward: (m) => dispatchMessageForward(m),
      });
    };

    window.addEventListener('catrealm:keybind:message', onMessageShortcut as EventListener);
    return () => window.removeEventListener('catrealm:keybind:message', onMessageShortcut as EventListener);
  }, [activeConversation, hoveredMessage, handleDelete, handleEdit, markConversationUnread, openReactionPickerForMessage, user?.id, user?.serverUserId]);

  const handleSaveRetention = async (days: number) => {
    if (!activeConversation) return;

    setSavingRetention(true);
    try {
      const res = await fetch(`${AUTH_BASE}/api/dms/conversations/${activeConversation.id}/request-retention`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${useAuthStore.getState().token}`,
            ...getCentralDeviceHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ retentionDays: days }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.immediate) {
          // Already at this retention
          setShowRetentionSettings(false);
        } else {
          // Request sent, notify via socket
          const socket = getSocket(AUTH_BASE);
          if (socket) {
            socket.emit('dm:retention:request', {
              conversationId: activeConversation.id,
              retentionDays: days,
              requestId: data.requestId,
            });
          }
          setShowRetentionSettings(false);
          setRequestSent(true);
          setRequestedDays(days);
          // Banner stays visible until other user responds
        }
      }
    } catch (err) {
      console.error('[DM] Failed to request retention:', err);
      alert('Failed to request retention change');
    } finally {
      setSavingRetention(false);
    }
  };

  const handleRetentionResponse = async (accept: boolean) => {
    if (!activeConversation || !pendingRetentionRequest) return;

    try {
      const res = await fetch(`${AUTH_BASE}/api/dms/conversations/${activeConversation.id}/respond-retention`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${useAuthStore.getState().token}`,
            ...getCentralDeviceHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ accept }),
      });

      if (res.ok) {
        const data = await res.json();

        // Notify via socket
        const socket = getSocket(AUTH_BASE);
        if (socket) {
          socket.emit('dm:retention:response', {
            conversationId: activeConversation.id,
            accepted: accept,
            retentionDays: data.retentionDays,
          });
        }

        if (accept) {
          setRetentionDays(data.retentionDays);
          // Reload conversations
          useDMStore.getState().loadConversations();
        }

        setPendingRetentionRequest(null);
      }
    } catch (err) {
      console.error('[DM] Failed to respond to retention request:', err);
    }
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const hour12 = timeFormat !== '24';
    const hourCycle = hour12 ? 'h12' as const : 'h23' as const;

    if (isToday) {
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12, hourCycle });
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
        date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12, hourCycle });
    }
  };

  const renderAttachment = (msg: DMMessage) => {
    const isOwn = msg.senderId === user?.id;
    const senderUsername = isOwn
      ? (user?.displayName || user?.username || null)
      : (activeConversation?.otherDisplayName || activeConversation?.otherUsername || null);
    const senderAvatarUrl = isOwn
      ? resolveAvatarUrl(user?.avatar ?? undefined, AUTH_BASE, 'central')
      : resolveAvatarUrl(activeConversation?.otherAvatar ?? undefined, AUTH_BASE, 'central');
    return (
      <DMAttachmentPreview
        message={msg}
        authBase={AUTH_BASE}
        senderUsername={senderUsername}
        senderAvatarUrl={senderAvatarUrl}
      />
    );
  };

  if (!activeConversation) {
    if (dmError) return <div role="alert" className="flex-1 p-6 text-danger">{dmError}</div>;
    if (conversations.length === 0) {
      return <DMEmptyConversationState text="No conversations yet." />;
    }
    return <ChatLoadingSkeleton showHeader={false} />;
  }

  const handleJumpToDMMessage = (messageId: string) => {
    requestAnimationFrame(() => {
      const el = document.getElementById(`msg-${messageId}`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
      setHighlightedMessageId(null);
      requestAnimationFrame(() => setHighlightedMessageId(messageId));
      highlightTimeoutRef.current = setTimeout(() => setHighlightedMessageId(null), 2600);
    });
  };

  const dmChatContent = (
    <>
      {loadingInitialMessages && messages.length === 0 ? (
        <ChatLoadingSkeleton showHeader={false} showComposer={false} />
      ) : (
        <MentionProvider users={dmMentionUsers}>
        <DMMessageList
          authBase={AUTH_BASE}
          messages={messages}
          loadingOlderMessages={loadingOlderMessages}
          hasOlderMessages={hasOlderMessages}
          otherUserTyping={otherUserTyping}
          messagesScrollRef={messagesScrollRef}
          messagesEndRef={messagesEndRef}
          editInputRef={editInputRef}
          onScroll={() => { void handleMessagesScroll(); }}
          onMediaLayout={handleMessageMediaLayout}
          activeConversation={{
            otherUserId: activeConversation.otherUserId,
            otherUsername: activeConversation.otherUsername,
            otherDisplayName: activeConversation.otherDisplayName,
            otherAvatar: activeConversation.otherAvatar,
          }}
          user={user ? {
            id: user.id,
            serverUserId: user.serverUserId ?? null,
            avatar: user.avatar,
            username: user.username,
            displayName: user.displayName,
          } : null}
          hoveredMessageId={hoveredMessageId}
          setHoveredMessageId={setHoveredMessageId}
          editingMessageId={editingMessageId}
          editDraft={editDraft}
          setEditDraft={setEditDraft}
          formatTime={formatTime}
          renderAttachment={renderAttachment}
          onOpenProfile={(userId) => openModal('profileView', { userId })}
          onSaveEdit={handleSaveEdit}
          onCancelEdit={handleCancelEdit}
          onToggleReaction={(messageId, emoji) => { void toggleReaction(messageId, emoji); }}
          onOpenReactionPicker={openReactionPickerForMessageAt}
          onReply={(m) => dispatchMessageReply(m)}
          onJumpToMessage={handleJumpToDMMessage}
          onForward={(m) => dispatchMessageForward(m)}
          onEdit={(m) => { void handleEdit(m); }}
          onDelete={(messageId) => { void handleDelete(messageId); }}
          pinnedMessageIds={pinnedDmMessageIds}
          onPinToggle={handleDmPinToggle}
          highlightedMessageId={highlightedMessageId}
          activeCallId={activeCallForConversation?.callId ?? lastEndedDMCall?.callId ?? null}
        />
        </MentionProvider>
      )}

      {overflowModalOpen && (
        <Modal open={overflowModalOpen} onClose={() => setOverflowModalOpen(false)} title="Too many files selected">
          <div className="space-y-3 text-sm text-text-primary">
            <p>
              You selected <strong>{(selectedAttachments.length) + attachmentOverflowQueue.length + (selectedAttachments.length > 0 ? 0 : 0)}</strong> files, but only <strong>8</strong> can be sent per message.
            </p>
            <p>
              The first <strong>8</strong> files have been staged for this message.{' '}
              {attachmentOverflowQueue.length > 0 && (
                <>The remaining <strong>{attachmentOverflowQueue.length}</strong> file{attachmentOverflowQueue.length !== 1 ? 's' : ''} will be automatically loaded after you send this batch.</>
              )}
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setAttachmentOverflowQueue([]);
                  setOverflowModalOpen(false);
                }}
                className="px-3 py-1.5 rounded border border-border text-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover"
              >
                Drop remaining
              </button>
              <button
                type="button"
                onClick={() => setOverflowModalOpen(false)}
                className="px-3 py-1.5 rounded border border-accent bg-accent text-white text-sm hover:opacity-90"
              >
                OK, send in batches
              </button>
            </div>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        open={!!deleteConfirmMessageId}
        onClose={() => setDeleteConfirmMessageId(null)}
        onConfirm={() => {
          if (deleteConfirmMessageId) void deleteMessage(deleteConfirmMessageId);
          setDeleteConfirmMessageId(null);
        }}
        title="Delete Message"
        message="Delete this message? It will be removed from the server but the recipient may still have a local copy."
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
      />
      <ConfirmDialog
        open={voiceCancelConfirmOpen}
        onClose={() => setVoiceCancelConfirmOpen(false)}
        onConfirm={() => {
          setVoiceMode(false);
          setVoiceCancelConfirmOpen(false);
        }}
        title="Cancel Recording?"
        message="Cancel recording? Your progress will be lost."
        confirmText="Cancel Recording"
        cancelText="Keep Recording"
        variant="danger"
      />
      <VoiceAutoDeleteModal
        open={dmVoiceAutoDeleteOpen}
        onConfirm={(expiresAt) => { void handleDMVoiceAutoDeleteConfirm(expiresAt); }}
        onCancel={() => {
          setDMVoiceAutoDeleteOpen(false);
          setPendingDMVoiceAttachment(null);
        }}
      />
      {(scheduledDMs[activeConversation.id]?.length ?? 0) > 0 && (
        <div className="px-4 py-2 border-t border-border bg-bg-elevated/60 flex flex-col gap-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-0.5">Scheduled</p>
          {(scheduledDMs[activeConversation.id] ?? []).map((msg) => {
            const sendTime = msg.scheduledAt ? new Date(msg.scheduledAt * 1000) : null;
            const timeLabel = sendTime
              ? sendTime.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
              : '';
            return (
              <div key={msg.id} className="flex items-center gap-2 text-xs text-text-secondary">
                <Clock3 className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                <span className="flex-1 truncate">{msg.text || '(attachment)'}</span>
                <span className="shrink-0 text-text-muted">{timeLabel}</span>
                <button
                  type="button"
                  title="Cancel scheduled message"
                  onClick={() => {
                    publishScheduledDM(msg.id, activeConversation.id);
                    void deleteMessage(msg.id);
                  }}
                  className="shrink-0 text-text-muted hover:text-danger transition-colors text-xs"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {requestNeedsResponse ? <DMRequestActions otherUserId={activeConversation.otherUserId} declined={activeConversation.requestState === 'declined'} /> : isMessagingBlocked ? (
        <div className="px-4 py-3 bg-surface-1 border-t border-border text-center text-text-muted text-sm select-none">
          {youBlockedThem
            ? 'This User is Blocked — You Cannot Send a Message'
            : theyBlockedYou ? 'This User has Blocked You — You Cannot Send a Message' : 'Messaging is unavailable while your request is awaiting acceptance or has been declined.'}
        </div>
      ) : (
      <DMComposer
        otherUsername={activeConversation.otherUsername}
        onSubmit={(e) => void handleSend(e)}
        previewSlot={!voiceMode ? <ComposerSelfPreview content={messageText} /> : null}
        voiceMode={voiceMode}
        onVoiceToggle={handleVoiceToggle}
        voiceRecorderSlot={(
          <VoiceMessageRecorder
            onCancel={() => setVoiceMode(false)}
            onSend={(blob, waveformData) => { void handleDMVoiceSend(blob, waveformData); }}
          />
        )}
        selectedAttachments={selectedAttachments}
        attachmentError={attachmentError}
        attachmentInputRef={attachmentInputRef}
        onAttachmentChange={handleAttachmentSelect}
        onRemoveAttachment={(index?: number) => {
          if (typeof index === 'number') {
            setSelectedAttachments((prev) => prev.filter((_, i) => i !== index));
          } else {
            setSelectedAttachments([]);
            setSelectedAttachmentNsfwTags({ ...emptyNsfwTags });
            setAttachmentError(null);
            if (attachmentInputRef.current) {
              attachmentInputRef.current.value = '';
            }
          }
        }}
        selectedAttachmentNsfwTags={selectedAttachmentNsfwTags}
        onToggleAttachmentNsfwTag={(tag, value) => {
          setSelectedAttachmentNsfwTags((prev) => ({ ...prev, [tag]: value }));
        }}
        replyBanner={replyingToMessage ? {
          label: (
            <>
              Replying to{' '}
              <span className="text-accent">
                {replyingToMessage.senderId === activeConversation.otherUserId
                  ? (activeConversation.otherDisplayName || activeConversation.otherUsername)
                  : (user?.displayName || user?.username || 'You')}
              </span>
              : {((replyingToMessage.text || '(attachment)').replace(/\s+/g, ' ').slice(0, 80))}
              {(replyingToMessage.text || '').length > 80 ? '...' : ''}
            </>
          ),
          onClear: () => setReplyingToMessage(null),
        } : null}
        forwardBanner={forwardingMessage ? {
          label: (
            <>
              Forwarding from{' '}
              <span className="text-blue-400">
                {forwardingMessage.senderId === activeConversation.otherUserId
                  ? (activeConversation.otherDisplayName || activeConversation.otherUsername)
                  : (user?.displayName || user?.username || 'You')}
              </span>
            </>
          ),
          onClear: () => setForwardingMessage(null),
        } : null}
        uploadButtonAction={uploadButtonAction ?? null}
        pickerRef={pickerRef}
        pickerButtonAction={pickerButtonAction ?? null}
        pickerOpen={pickerOpen}
        pickerFloatingPosition={reactionPickerMessageId ? reactionPickerAnchor : null}
        pickerTab={pickerTab}
        onPickerTabChange={setPickerTab}
        gifPickerEnabled={user?.accountType === 'central'}
        onSelectGif={(gifUrl) => {
          void sendMessage(activeConversation.otherUserId, gifUrl, null, []);
          setPickerOpen(false);
          setReactionPickerMessageId(null);
          setReactionPickerAnchor(null);
        }}
        emojiSearchQuery={emojiSearchQuery}
        onEmojiSearchQueryChange={setEmojiSearchQuery}
        onClosePicker={() => {
          setPickerOpen(false);
          setReactionPickerMessageId(null);
          setReactionPickerAnchor(null);
        }}
        reactionPickerMode={!!reactionPickerMessageId}
        visibleExpressionServers={visibleExpressionServers}
        effectiveSelectedServerUrl={effectiveSelectedServerUrl}
        currentServerUrl={currentServerUrl}
        canUseExternalEmojis={canUseExternalEmojis}
        canUseExternalStickers={canUseExternalStickers}
        onSelectExpressionPickerServer={selectExpressionPickerServer}
        selectedServer={selectedServer}
        selectedServerState={selectedServerState}
        onRetrySelectedExpressionServer={selectedServer ? retrySelectedExpressionServer : undefined}
        selectedManifest={selectedManifest}
        selectedIsExternal={selectedIsExternal}
        canUseSelectedEmojiServer={canUseSelectedEmojiServer}
        canUseSelectedStickerServer={canUseSelectedStickerServer}
        hasEmojiSearchQuery={hasEmojiSearchQuery}
        defaultEmojiCategory={defaultEmojiCategory}
        onSelectDefaultEmojiCategory={(category) => setDefaultEmojiCategory(category)}
        emojiMetadataLoaded={!!emojiMetadataLookup}
        defaultEmojiEntries={defaultEmojiEntries}
        onInsertUnicodeEmoji={insertUnicodeEmoji}
        filteredSelectedEmoteItems={filteredSelectedEmoteItems}
        filteredSelectedStickerItems={filteredSelectedStickerItems}
        resolveExpressionAssetUrl={resolveExpressionAssetUrl}
        onInsertExpression={(kind, expression, sourceUrl, isPersonal) => insertExpression(kind, expression, sourceUrl, isPersonal)}
        composerRef={composerRef}
        onInput={handleComposerInput}
        onFilePaste={(files) => { if (files[0]) setAttachmentsFromFiles([files[0]]); }}
        onKeyDown={handleComposerKeyDown}
        loading={loading}
        sendButtonAction={sendButtonAction ?? null}
        emoteSuggestOpen={emoteSuggestOpen}
        emoteSuggestItems={emoteSuggestItems}
        emoteSuggestIndex={emoteSuggestIndex}
        onApplyEmoteSuggestion={applyEmoteSuggestion}
        mentionOpen={mentionOpen}
        mentionItems={mentionItems}
        mentionIndex={mentionIndex}
        onApplyMentionSuggestion={applyMentionSuggestion}
      />
      )}
    </>
  );

  const handleCloseSearch = () => {
    setSearchOpen(false);
    setHighlightedMessageId(null);
  };

  return (
    <div ref={dmViewRef} className="flex-1 flex flex-col h-full relative">
      <DMConversationHeader
        avatarUrl={resolveAvatarUrl(activeConversation.otherAvatar ?? undefined, AUTH_BASE, 'central') ?? defaultAvatarUrl()}
        avatarAlt={activeConversation.otherUsername}
        displayName={activeConversation.otherDisplayName || activeConversation.otherUsername}
        username={activeConversation.otherUsername}
        showUsernameSubline={!!activeConversation.otherDisplayName}
        statusLabel={formatDMPresenceStatusLabel(activeConversation.otherStatus)}
        statusDotClassName={dmPresenceDotClass(activeConversation.otherStatus)}
        clients={activeConversation.otherClients}
        isOnline={isOtherUserOnline}
        peerKeyRecoveryPending={peerKeyRecoveryPending}
        onBackMobile={() => {
          useDMStore.setState({ activeConversationId: null });
          useUIStore.getState().setMobileNavOpen(true);
        }}
        onOpenProfile={() => openModal('profileView', { userId: activeConversation.otherUserId })}
        onShowEncryptionInfo={() => setShowE2EInfo(true)}
        onShowRetentionSettings={() => setShowRetentionSettings(true)}
        encryptionState={dmEncryptionState}
        onAudioCall={handleAudioCall}
        onSearch={() => setSearchOpen(true)}
        hideCallButtons={hasActiveCall || hasRingingCall}
        isInCall={hasActiveCall || hasRingingCall}
        isRinging={hasRingingCall}
        remoteCallState={activeCallForConversation ? {
          muted: activeCallForConversation.otherMuted,
          deafened: activeCallForConversation.otherDeafened,
          videoEnabled: activeCallForConversation.otherVideoEnabled,
          sharingScreen: activeCallForConversation.otherSharingScreen,
        } : null}
      />

      {/* Incoming Call Banner (if there's an incoming call for this conversation) */}
      {incomingCallForThisConversation && (
        <DMIncomingCallBanner
          callId={incomingCallForThisConversation.callId}
          callerName={incomingCallForThisConversation.callerName}
          callerAvatar={incomingCallForThisConversation.callerAvatar}
          mediaType={incomingCallForThisConversation.mediaType}
          privacyMode={incomingCallForThisConversation.privacyMode}
        />
      )}

      {(dmEncryptionState === 'locked' || unavailableMessages > 0) && (
        <div role="status" className="mx-4 mt-2 px-3 py-2 rounded border border-red-500/40 bg-red-500/10 text-red-200 text-sm">
          <strong>
            {unavailableMessages > 0
              ? `${unavailableMessages} encrypted ${unavailableMessages === 1 ? 'message is' : 'messages are'} unavailable on this device.`
              : 'Encrypted messages are unavailable on this device.'}
          </strong>{' '}
          {localDeviceTrustState !== 'trusted'
            ? 'Approve this device with your passkey or from a trusted session in Account & Security. A key-holding device must then share the DM key.'
            : 'Waiting for a key-holding device to share the conversation key. If that device shows a passkey warning, verify it again in Account & Security.'}
          <button
            type="button"
            className="ml-2 underline font-medium hover:text-white"
            onClick={() => openModal('profileSettings', { initialTab: 'account-security' })}
          >
            Account &amp; Security
          </button>
          <button
            type="button"
            className="ml-3 underline font-medium hover:text-white"
            onClick={() => {
              if (!activeConversationId) return;
              void useDMStore.getState().loadMessages(activeConversationId).finally(() => {
                useDMKeyHealthStore.getState().markConversationKeysUpdated(activeConversationId);
              });
            }}
          >
            Retry sync
          </button>
        </div>
      )}
      {dmEncryptionState === 'locked' && keyHoldersBlocked && <DMKeyRetrustBanner />}
      {activeConversationId && activeConversation && (
        <DMKeyRecoveryPanel
          conversationId={activeConversationId}
          otherUsername={activeConversation.otherDisplayName || activeConversation.otherUsername}
          onIncomingChange={setPeerKeyRecoveryPending}
        />
      )}
      {needsKeyShareProof && (
        <div role="status" className="mx-4 mt-2 px-3 py-2 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 text-sm">
          This device has the DM key, but its passkey proof has expired. Verify this device to share the key with your other trusted devices.
          <button
            type="button"
            className="ml-2 underline font-medium hover:text-white"
            onClick={() => openModal('profileSettings', { initialTab: 'account-security' })}
          >
            Verify device
          </button>
        </div>
      )}

      <DMRetentionBanners
        requestSent={requestSent}
        requestedDays={requestedDays}
        otherUsername={activeConversation.otherUsername}
        pendingRetentionRequest={pendingRetentionRequest}
        onRespond={handleRetentionResponse}
      />

      <ScheduleMessageModal
        open={scheduleModalOpen}
        onClose={() => { setScheduleModalOpen(false); setPendingScheduledSend(null); }}
        onConfirm={handleDMScheduleConfirm}
        context="dm"
      />

      <ChatSearchPanel
        open={searchOpen}
        onClose={handleCloseSearch}
        dmMessages={messages}
        selfId={user?.id}
        selfName={user?.displayName || user?.username || 'You'}
        selfAvatarUrl={resolveAvatarUrl(user?.avatar ?? undefined, AUTH_BASE, 'central') ?? undefined}
        otherName={activeConversation.otherDisplayName || activeConversation.otherUsername}
        otherAvatarUrl={resolveAvatarUrl(activeConversation.otherAvatar ?? undefined, AUTH_BASE, 'central') ?? undefined}
        dmHasOlder={hasOlderMessages}
        onLoadOlderDM={async () => {
          if (!activeConversationId) return false;
          await loadOlderMessages(activeConversationId);
          return useDMStore.getState().hasOlderByConversation[activeConversationId] ?? false;
        }}
        timeFormat={timeFormat}
        onJump={(messageId) => handleJumpToDMMessage(messageId)}
      />

      {/* canRejoin keeps the call pane up (with Rejoin) after you leave. */}
      {(hasActiveCall || hasRingingCall || canRejoin) ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <DMCallHeader
            selfAvatarUrl={selfCallAvatarUrl}
            otherAvatarUrl={remoteCallAvatarUrl}
            selfName={selfCallDisplayName}
            otherName={remoteCallDisplayName}
          />
          {dmChatContent}
        </div>
      ) : (
        dmChatContent
      )}

      <DMEncryptionInfoModal
        open={showE2EInfo}
        onClose={() => setShowE2EInfo(false)}
        retentionDays={retentionDays}
      />

      <DMRetentionSettingsModal
        open={showRetentionSettings}
        onClose={() => setShowRetentionSettings(false)}
        saving={savingRetention}
        retentionDays={retentionDays}
        otherUsername={activeConversation.otherUsername}
        onSelectRetentionDays={(days) => { void handleSaveRetention(days); }}
      />

      {/* Privacy Mode Selection Modal */}
      {showPrivacyModeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => {
          setShowPrivacyModeModal(false);
          setPendingCallMediaType(null);
        }}>
          <div className="bg-bg-elevated rounded-lg shadow-xl max-w-md w-full mx-4 p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-xl font-bold text-text-primary mb-4">Choose Call Privacy Mode</h2>

            <div className="space-y-3 mb-6">
              {/* Privacy Mode Option */}
              <button
                onClick={() => handlePrivacyModeSelection(true)}
                className="w-full text-left p-4 rounded-lg border-2 border-green-500/30 bg-green-500/10 hover:bg-green-500/20 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <Lock className="mt-0.5 h-6 w-6" />
                  <div className="flex-1">
                    <h3 className="font-semibold text-text-primary mb-1">Privacy Mode <span className="text-green-400 text-sm">(Recommended)</span></h3>
                    <p className="text-sm text-text-muted">
                      Uses central relay to hide your IP address. Slightly higher latency but more private.
                    </p>
                  </div>
                </div>
              </button>

              {/* P2P Mode Option */}
              <button
                onClick={() => handlePrivacyModeSelection(false)}
                className="w-full text-left p-4 rounded-lg border-2 border-yellow-500/30 bg-yellow-500/10 hover:bg-yellow-500/20 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <Zap className="mt-0.5 h-6 w-6" />
                  <div className="flex-1">
                    <h3 className="font-semibold text-text-primary mb-1">P2P Mode</h3>
                    <p className="text-sm text-text-muted">
                      Direct peer-to-peer connection. Lower latency but may expose your IP address to the other user.
                    </p>
                  </div>
                </div>
              </button>
            </div>

            <button
              onClick={() => {
                setShowPrivacyModeModal(false);
                setPendingCallMediaType(null);
              }}
              className="w-full px-4 py-2 rounded-lg bg-bg-hover hover:bg-bg-active transition-colors text-text-primary font-medium"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
