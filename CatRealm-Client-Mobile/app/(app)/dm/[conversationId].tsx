/**
 * DM screen — 1:1 direct message chat. Layout matches the server channel screen:
 * avatar left, username + timestamp header, flat message body, grouped consecutive messages.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, FlatList, Image, StyleSheet, ActivityIndicator, Alert, Keyboard, KeyboardAvoidingView, Platform, TouchableOpacity, Share, Animated as RNAnimated, Dimensions, Modal, ScrollView } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useComposerKeyboardInset } from '@/hooks/useComposerKeyboardInset';
import { SafeAreaView } from '@/components/SafeAreaView';
import { useFocusEffect, useIsFocused } from "expo-router/react-navigation";
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, Bell, BellOff, Check, CornerUpLeft, EllipsisVertical, Lock, LockOpen, Pin, Search, ShieldAlert, Phone, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/theme';
import { Text, IconBtn, Avatar, MobileComposer, Pressable, MarkdownText, TranslatableMarkdownText, MessageActionSheet, MessageReactionsSheet, Sheet, DMSearchSheet, SwipeableMessageRow, SwipeSidebarContainer } from '@/components';
import { AUTH_BASE } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useDMStore, type DMPinnedEntry } from '@/stores/dmStore';
import { useAuthStore } from '@/stores/authStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useExpressionLookup, resolveEmoteFromCache, type ExpressionLookup } from '@/lib/expressionCache';
import { buildDmContextText, dmContextPreviewText, parseDmContextText } from '@/lib/dmContext';
import type { ComposerSendOptions, LocalComposerAttachment } from '@/components/MobileComposer';
import { usePushSettingsStore } from '@/stores/pushSettingsStore';
import { useCallStore } from '@/stores/callStore';
import { fetchDMKeyManifest, deriveDMEncryptionState, areAllKeyHoldersBlocked, retryCurrentDeviceDMKey, type DMEncryptionState } from '@/lib/dmKeyStore';
import { useDeviceLayout } from '@/hooks/useDeviceLayout';
import { getLocalDeviceId } from '@/lib/deviceIdentity';
import type { DMConversation, DMMessage, Reaction } from '@/types';
import { formatMessageTimestamp } from '@/utils/formatTime';
import { centralScope, realmScope } from '@/lib/imageCache';
import { DMRequestBanner } from '@/components/DMRequestBanner';
import { canSendDM } from '@/lib/dmRequests';
import { useBlockedUsersStore } from '@/stores/blockedUsersStore';
import { DMKeyRecoveryPanel } from '@/components/DMKeyRecoveryPanel';

const EMPTY_DM_MESSAGES: DMMessage[] = [];
const EMPTY_DM_PINS: DMPinnedEntry[] = [];
const EMPTY_TYPING_USERS: string[] = [];
const GROUP_THRESHOLD_MS = 5 * 60 * 1000;

// ─── HighlightChaser ──────────────────────────────────────────────────────────
// A shimmer bar that sweeps left → right across the message row, giving the
// same "chasing light" feel as the emote-picker ring without the GPU cost of
// rotating a large gradient inside overflow:hidden (rotation forces an
// expensive off-screen compositing buffer on every frame; translateX does not).

const SCREEN_W = Dimensions.get('window').width;

const CHASER_COLORS: readonly [string, string, string, string] = [
  'transparent',
  'rgba(253,224,71,0.45)',
  'rgba(253,224,71,0.45)',
  'transparent',
];

function HighlightChaser({ active, bgColor: _bgColor }: { active: boolean; bgColor?: string }) {
  const progress = useRef(new RNAnimated.Value(0)).current;
  const opacity  = useRef(new RNAnimated.Value(0)).current;

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    progress.setValue(0);
    opacity.setValue(1);

    // 3 sweeps at 750 ms each = 2 250 ms, matches the 2 200 ms highlight reset
    const sweep = RNAnimated.loop(
      RNAnimated.timing(progress, { toValue: 1, duration: 750, useNativeDriver: true }),
      { iterations: 3 },
    );
    sweep.start();

    // Fade out after last sweep finishes
    const timer = setTimeout(() => {
      if (stopped) return;
      RNAnimated.timing(opacity, { toValue: 0, duration: 400, useNativeDriver: true }).start(() => {
        sweep.stop();
        progress.setValue(0);
      });
    }, 1850);

    return () => {
      stopped = true;
      clearTimeout(timer);
      sweep.stop();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const translateX = progress.interpolate({
    inputRange:  [0, 1],
    outputRange: [-SCREEN_W * 0.5, SCREEN_W * 1.5],
  });

  return (
    <RNAnimated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { opacity, overflow: 'hidden' }]}
    >
      <RNAnimated.View
        style={[StyleSheet.absoluteFill, { transform: [{ translateX }] }]}
      >
        <LinearGradient
          colors={CHASER_COLORS}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={{ flex: 1 }}
        />
      </RNAnimated.View>
    </RNAnimated.View>
  );
}

// ─── Reaction emoji renderer ─────────────────────────────────────────────────
// Matches compact emote tokens: :server:name:, :name:, :name:ownerId:, etc.
const REACTION_TOKEN_RE = /^:(https?:\/\/[^\s:]+(?::\d{1,5})?):(?:sticker:)?([a-z0-9_-]{1,64})(?::([a-z0-9_-]{3,128}))?:|^:(?:sticker:)?([a-z0-9_-]{1,64})(?::([a-z0-9_-]{3,128}))?:/i;

function ReactionEmoji({ emoji, serverUrl }: { emoji: string; serverUrl?: string | null }) {
  const m = REACTION_TOKEN_RE.exec(emoji);
  if (m) {
    const tokenServerUrl = m[1] ?? null;
    const name = m[2] || m[4] || '';
    const ownerId = m[3] || m[5] || null;
    const url = resolveEmoteFromCache(name, false, serverUrl, tokenServerUrl, ownerId);
    if (url) {
      return <Image source={{ uri: url }} style={{ width: 18, height: 18 }} resizeMode="contain" />;
    }
    return <Text style={{ fontSize: 11 }}>:{name}:</Text>;
  }
  return <Text style={{ fontSize: 14 }}>{emoji}</Text>;
}

// ─── DMMessageRow ─────────────────────────────────────────────────────────────

interface DMMessageRowProps {
  message: DMMessage;
  prevMessage: DMMessage | null;
  selfUserId: string | undefined;
  selfUsername: string | undefined;
  selfAvatar: string | null | undefined;
  conversation: DMConversation | undefined;
  expressionLookup?: ExpressionLookup | null;
  serverUrl?: string | null;
  imageScope?: string;
  isHighlighted: boolean;
  onMessageLongPress: (message: DMMessage, isSelf: boolean) => void;
  onOpenProfile: (userId: string) => void;
  onJumpToReply?: (previewText: string, authorLabel: string) => void;
  onToggleReaction?: (messageId: string, emoji: string) => void;
  onOpenReactions?: (message: DMMessage, emoji?: string) => void;
}

const DMMessageRow = memo(function DMMessageRow({
  message,
  prevMessage,
  selfUserId,
  selfUsername,
  selfAvatar,
  conversation,
  expressionLookup,
  serverUrl,
  imageScope,
  isHighlighted,
  onMessageLongPress,
  onOpenProfile,
  onJumpToReply,
  onToggleReaction,
  onOpenReactions,
}: DMMessageRowProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const isSelf = message.senderId === selfUserId;
  const ctx = useMemo(() => parseDmContextText(message.text), [message.text]);

  if (message.messageType === 'system') {
    const isE2EEUpgrade = message.systemType === 'dm_e2ee_upgraded';
    return (
      <View style={[styles.systemRow]}>
        <Text style={{ fontSize: 13 }}>{isE2EEUpgrade ? '🔒' : '🛠'}</Text>
        <Text variant="caption" style={{ flex: 1, color: isE2EEUpgrade ? '#34d399' : '#EAB308' }}>
          {message.text}
        </Text>
      </View>
    );
  }

  const isGrouped =
    prevMessage !== null &&
    prevMessage.messageType !== 'system' &&
    prevMessage.senderId === message.senderId &&
    message.createdAt - prevMessage.createdAt < GROUP_THRESHOLD_MS;

  const username = isSelf
    ? (selfUsername ?? t('call.you'))
    : (conversation?.otherDisplayName ?? conversation?.otherUsername ?? '?');

  const avatarUri = isSelf ? (selfAvatar ?? null) : (conversation?.otherAvatar ?? null);
  const profileUserId = isSelf ? selfUserId : (conversation?.otherUserId ?? message.senderId);

  const timestamp = formatMessageTimestamp(message.createdAt);

  const bodyText = ctx ? ctx.bodyText : message.text;

  return (
    <View style={styles.msgRowWrap}>
      <HighlightChaser active={isHighlighted} bgColor={theme.colors.bgApp} />
      <Pressable minHit={0} onLongPress={() => onMessageLongPress(message, isSelf)} style={[styles.msgRow, { paddingTop: isGrouped ? 2 : 12 }]}>
        {isGrouped ? (
          <View style={styles.avatarPlaceholder} />
        ) : (
          <Pressable
            haptic
            minHit={36}
            disabled={!profileUserId}
            onPress={() => { if (profileUserId) onOpenProfile(profileUserId); }}
            accessibilityRole="button"
            accessibilityLabel={t('chat.openProfile', { username })}
            style={styles.messageIdentityButton}
          >
            <Avatar username={username} uri={avatarUri} size={36} shape="square" />
          </Pressable>
        )}
        <View style={{ flex: 1 }}>
          {!isGrouped && (
            <View style={styles.msgMeta}>
              <Pressable
                haptic
                minHit={24}
                disabled={!profileUserId}
                onPress={() => { if (profileUserId) onOpenProfile(profileUserId); }}
                accessibilityRole="button"
                accessibilityLabel={t('chat.openProfile', { username })}
                style={styles.messageNameButton}
              >
                <Text variant="subtitle" numberOfLines={1}>
                  {username}
                </Text>
              </Pressable>
              <Text variant="caption" color={theme.colors.text3} style={{ marginLeft: 6 }}>
                {timestamp}
              </Text>
            </View>
          )}
          {ctx ? (
            <Pressable
              onPress={() => onJumpToReply?.(ctx.previewText, ctx.authorLabel)}
              style={[styles.contextCard, { backgroundColor: theme.colors.bgElev2, borderColor: theme.colors.lineSoft }]}
            >
              <Text variant="caption" color={theme.colors.text3}>
                {ctx.kind === 'forward' ? t('chat.forwardedFrom') : t('chat.replyingTo')}
                <Text variant="caption" style={{ color: theme.colors.text, fontWeight: '600' }}>
                  {ctx.authorLabel}
                </Text>
              </Text>
              <View style={styles.contextPreview}>
                <MarkdownText
                  text={ctx.previewText}
                  color={theme.colors.text2}
                  style={{ fontSize: 12 }}
                  serverUrl={serverUrl}
                  expressionLookup={expressionLookup}
                />
              </View>
            </Pressable>
          ) : null}
          <TranslatableMarkdownText
            messageId={message.id}
            text={bodyText}
            color={theme.colors.text}
            attachments={message.attachments}
            serverUrl={serverUrl}
            imageScope={imageScope}
            expressionLookup={expressionLookup}
            nsfwTags={message.nsfwTags}
            voiceExpiresAt={message.voiceExpiresAt}
            linkPreviews
          />
          {message.editedAt != null ? (
            <Text variant="caption" color={theme.colors.text3}>{t('common.edited')}</Text>
          ) : null}
          {(message.reactions?.length ?? 0) > 0 && (
            <View style={styles.reactionsRow}>
              {message.reactions!.map((reaction) => (
                <Pressable
                  key={reaction.emoji}
                  onPress={() => onToggleReaction?.(message.id, reaction.emoji)}
                  onLongPress={() => onOpenReactions?.(message, reaction.emoji)}
                  style={[
                    styles.reactionChip,
                    reaction.reacted
                      ? { backgroundColor: theme.colors.accent + '33', borderColor: theme.colors.accent }
                      : { backgroundColor: theme.colors.bgElev2, borderColor: theme.colors.lineSoft },
                  ]}
                >
                  <ReactionEmoji emoji={reaction.emoji} serverUrl={serverUrl} />
                  <Text variant="caption" style={{ marginLeft: 4, color: reaction.reacted ? theme.colors.accent : theme.colors.text2 }}>
                    {reaction.count}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      </Pressable>
    </View>
  );
}, (prev, next) =>
  prev.message === next.message &&
  prev.prevMessage === next.prevMessage &&
  prev.isHighlighted === next.isHighlighted &&
  prev.expressionLookup === next.expressionLookup &&
  prev.conversation === next.conversation &&
  prev.selfUserId === next.selfUserId &&
  prev.selfUsername === next.selfUsername &&
  prev.selfAvatar === next.selfAvatar &&
  prev.serverUrl === next.serverUrl &&
  prev.imageScope === next.imageScope &&
  prev.onMessageLongPress === next.onMessageLongPress &&
  prev.onOpenProfile === next.onOpenProfile &&
  prev.onJumpToReply === next.onJumpToReply &&
  prev.onToggleReaction === next.onToggleReaction &&
  prev.onOpenReactions === next.onOpenReactions,
);

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function DMScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const isFocused = useIsFocused();
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const isMuted = usePushSettingsStore((s) => s.isMuted);
  const setMute = usePushSettingsStore((s) => s.setMute);
  const initiateDMCall = useCallStore((s) => s.initiateDMCall);
  const dmMuted = conversationId ? isMuted('dm', conversationId) : false;
  const { isTablet } = useDeviceLayout();

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [activeMessage, setActiveMessage] = useState<DMMessage | null>(null);
  const [reactionsSheetState, setReactionsSheetState] = useState<{ open: boolean; reactions: ReadonlyArray<Reaction> | null; initialEmoji: string | null }>({ open: false, reactions: null, initialEmoji: null });
  const [replyToMessage, setReplyToMessage] = useState<DMMessage | null>(null);
  const [isScrollingOld, setIsScrollingOld] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [showE2EInfo, setShowE2EInfo] = useState(false);
  const [showNotificationControls, setShowNotificationControls] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [dmEncryptionState, setDmEncryptionState] = useState<DMEncryptionState | undefined>(undefined);
  const [keyHoldersBlocked, setKeyHoldersBlocked] = useState(false);
  const [localKeyNeedsTrust, setLocalKeyNeedsTrust] = useState(false);
  const [peerKeyRecoveryPending, setPeerKeyRecoveryPending] = useState(false);
  const [keyRefreshRevision, setKeyRefreshRevision] = useState(0);
  const flatListRef = useRef<FlatList<DMMessage>>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const typingActiveRef = useRef(false);
  const typingSentAtRef = useRef(0);
  const actionHandoffRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(actionHandoffRef.current), []);
  const composerBottom = useComposerKeyboardInset();


  const conversation = useDMStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const otherPresenceStatus = usePresenceStore((s) =>
    conversation?.otherUserId ? (s.centralByUserId[conversation.otherUserId]?.status ?? null) : null,
  );
  const otherStatus = otherPresenceStatus ?? conversation?.otherStatus ?? null;
  const blocked = useBlockedUsersStore((s) => !!conversation && s.blockedUsers.has(conversation.otherUserId));
  const canSend = canSendDM(conversation, blocked);
  const messages = useDMStore((s) => s.messages[conversationId] ?? EMPTY_DM_MESSAGES);
  const decryptFailure = useMemo((): 1 | 2 | 'unknown' | 'rate_limited' | null => {
    const failed = messages.filter((message) => message.systemType === 'decrypt_failed');
    if (!failed.length) return null;
    if (failed.some((message) => message.systemData?.keySyncRateLimited === true)) return 'rate_limited';
    if (failed.some((message) => message.systemData?.encryptedVersion === 2)) return 2;
    if (failed.some((message) => message.systemData?.encryptedVersion === 1)) return 1;
    return 'unknown';
  }, [messages]);
  const keySyncRetryAt = useMemo(() => Math.max(0, ...messages
    .filter((message) => message.systemType === 'decrypt_failed' && message.systemData?.keySyncRateLimited === true)
    .map((message) => Number(message.systemData?.retryAt) || 0)), [messages]);
  const loading = useDMStore((s) => s.loading[conversationId] ?? false);
  const hasMore = useDMStore((s) => s.hasMore[conversationId] ?? true);
  const oldestCursor = useDMStore((s) => s.oldestCursor[conversationId] ?? null);
  const fetchMessages = useDMStore((s) => s.fetchMessages);
  const releaseMessages = useDMStore((s) => s.releaseMessages);
  const fetchConversations = useDMStore((s) => s.fetchConversations);
  const markAsRead = useDMStore((s) => s.markAsRead);
  const setActiveConversationId = useDMStore((s) => s.setActiveConversationId);
  const typingUsers = useDMStore((s) => s.typingByConversation[conversationId] ?? EMPTY_TYPING_USERS);
  const sendMessage = useDMStore((s) => s.sendMessage);
  const editMessage = useDMStore((s) => s.editMessage);
  const deleteMessage = useDMStore((s) => s.deleteMessage);
  const toggleReaction = useDMStore((s) => s.toggleReaction);
  const pinnedEntries = useDMStore((s) => s.pinsByConversation[conversationId] ?? EMPTY_DM_PINS);
  const fetchPins = useDMStore((s) => s.fetchPins);
  const pinMessage = useDMStore((s) => s.pinMessage);
  const unpinMessage = useDMStore((s) => s.unpinMessage);
  const selfUser = useAuthStore((s) => s.user);
  const accountType = useAuthStore((s) => s.user?.accountType);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const dmMediaUrl = accountType === 'central' ? AUTH_BASE : (serverUrl ?? null);
  const dmImageScope = accountType === 'central' ? centralScope('DMs') : realmScope(serverUrl ?? '');
  const expressionLookup = useExpressionLookup(serverUrl);
  const dmSocketUrl = accountType === 'central' ? AUTH_BASE : (serverUrl ?? undefined);

  // Reflect the conversation's E2EE state in the header badge. Reset to the calm
  // default on conversation switch so we never flash a stale warning from the
  // previous chat, then resolve the real per-device state from the key manifest.
  useEffect(() => { setDmEncryptionState(undefined); setKeyHoldersBlocked(false); setLocalKeyNeedsTrust(false); }, [conversationId]);
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    (async () => {
      try {
        const [manifest, deviceId] = await Promise.all([
          fetchDMKeyManifest(conversationId),
          getLocalDeviceId(),
        ]);
        if (!cancelled) {
          const encryptionState = deriveDMEncryptionState(manifest, deviceId);
          setDmEncryptionState(encryptionState);
          setKeyHoldersBlocked(encryptionState === 'locked' && areAllKeyHoldersBlocked(manifest));
        }
      } catch {
        // Leave the badge in its default look if we can't determine the state.
      }
    })();
    return () => { cancelled = true; };
  }, [conversationId, messages.length, keyRefreshRevision]);

  useEffect(() => {
    const socket = getSocket(AUTH_BASE);
    if (!socket) return;
    const onKeysUpdated = (payload: { conversationId?: string }) => {
      if (payload.conversationId === conversationId) setKeyRefreshRevision((value) => value + 1);
    };
    socket.on('dm:keys:updated', onKeysUpdated);
    return () => { socket.off('dm:keys:updated', onKeysUpdated); };
  }, [conversationId]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setActiveConversationId(conversationId);

      void (async () => {
        if (!useDMStore.getState().conversations.find((c) => c.id === conversationId)) {
          await fetchConversations();
        }
        if (cancelled) return;
        await Promise.all([
          fetchMessages(conversationId),
          markAsRead(conversationId),
          fetchPins(conversationId),
        ]);
      })();

      return () => {
        cancelled = true;
        releaseMessages(conversationId);
        if (useDMStore.getState().activeConversationId === conversationId) {
          setActiveConversationId(null);
        }
      };
    }, [conversationId, fetchConversations, fetchMessages, markAsRead, fetchPins, releaseMessages, setActiveConversationId]),
  );

  // FlatList is inverted; reverse so newest renders at bottom
  const displayMessages = useMemo(() => [...messages].reverse(), [messages]);

  const handleSend = async (serializedText?: string, localAttachments?: LocalComposerAttachment[], options?: ComposerSendOptions) => {
    const body = (serializedText ?? draft).trim();
    if ((!body && !localAttachments?.length) || sending || !canSend) return;
    if (conversation?.otherUserId) {
      getSocket(dmSocketUrl)?.emit('dm:typing:stop', { recipientId: conversation.otherUserId });
    }
    clearTimeout(typingTimerRef.current);

    // Replies are a client convention: prepend the structured context envelope
    // (same serialization as desktop) before encrypting.
    let text = body;
    if (replyToMessage) {
      const sourcePreview = dmContextPreviewText(replyToMessage.text);
      const authorLabel = replyToMessage.senderId === conversation?.otherUserId
        ? (conversation?.otherDisplayName || conversation?.otherUsername || '')
        : (selfUser?.displayName || selfUser?.username || 'You');
      text = buildDmContextText({ v: 1, kind: 'reply', authorLabel, previewText: sourcePreview }, body);
    }

    setDraft('');
    setSending(true);
    try {
      const ok = await sendMessage(
        conversationId,
        text,
        localAttachments?.length ? localAttachments : undefined,
        options,
      );
      if (ok) {
        setReplyToMessage(null);
      } else {
        setDraft(body);
        Alert.alert(t('chat.sendFailed'), t('chat.sendFailedMsg'));
      }
    } finally {
      setSending(false);
    }
  };

  const handleLoadOlder = useCallback(() => {
    if (!loading && hasMore && oldestCursor) {
      void fetchMessages(conversationId, oldestCursor);
    }
  }, [loading, hasMore, oldestCursor, conversationId, fetchMessages]);

  const handleScroll = useCallback((event: { nativeEvent: { contentOffset: { y: number } } }) => {
    const offsetY = event.nativeEvent.contentOffset.y;
    setIsScrollingOld(offsetY > 9000);
  }, []);

  const handleWarpToCurrent = useCallback(() => {
    flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    setIsScrollingOld(false);
  }, []);

  const handleMessageLongPress = useCallback((msg: DMMessage) => {
    setActiveMessage((current) => current?.id === msg.id ? current : msg);
  }, []);

  const handleToggleReaction = useCallback((messageId: string, emoji: string) => {
    void toggleReaction(messageId, emoji);
  }, [toggleReaction]);

  const openProfile = useCallback((userId: string) => {
    router.push({
      pathname: '/profile/[userId]',
      params: { userId, context: 'central' },
    });
  }, [router]);

  const openOtherUserProfile = useCallback(() => {
    if (!conversation?.otherUserId) return;
    openProfile(conversation.otherUserId);
  }, [conversation?.otherUserId, openProfile]);

  const handleJumpToReply = useCallback((previewText: string, authorLabel: string) => {
    const normalizedPreview = previewText.replace(/\s+/g, ' ').trim();
    const match = messages.find((msg) => {
      if (msg.messageType === 'system') return false;
      const parsed = parseDmContextText(msg.text);
      const body = parsed ? parsed.bodyText : msg.text;
      const normalizedBody = body.replace(/\s+/g, ' ').trim();
      if (!normalizedBody.startsWith(normalizedPreview.slice(0, 60))) return false;
      const isSenderSelf = msg.senderId === selfUser?.id;
      const senderLabel = isSenderSelf
        ? (selfUser?.displayName ?? selfUser?.username ?? '')
        : (conversation?.otherDisplayName ?? conversation?.otherUsername ?? '');
      return senderLabel === authorLabel ||
        senderLabel.startsWith(authorLabel) ||
        authorLabel.startsWith(senderLabel);
    });
    if (!match) return;
    const idx = displayMessages.findIndex((m) => m.id === match.id);
    if (idx < 0) return;
    flatListRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.4 });
    setHighlightedMessageId(match.id);
    setTimeout(() => setHighlightedMessageId(null), 2200);
  }, [messages, displayMessages, selfUser, conversation]);

  const handleJumpToMessage = useCallback((messageId: string) => {
    const idx = displayMessages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    flatListRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.4 });
    setHighlightedMessageId(messageId);
    setTimeout(() => setHighlightedMessageId(null), 2200);
  }, [displayMessages]);

  // Jumping while a sheet's Modal is still dismissing silently no-ops the
  // scroll; wait out the exit animation first.
  const jumpAfterSheetClose = useCallback((messageId: string) => {
    clearTimeout(actionHandoffRef.current);
    actionHandoffRef.current = setTimeout(() => handleJumpToMessage(messageId), 350);
  }, [handleJumpToMessage]);

  // One older page for the search sheet; resolves to whether more history remains.
  const loadOlderForSearch = useCallback(async () => {
    // fetchMessages silently no-ops while another load is in flight (e.g. the
    // list's own scroll pagination) — drain it first so our page really runs.
    while (useDMStore.getState().loading[conversationId]) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const store = useDMStore.getState();
    if (store.hasMore[conversationId] === false) return false;
    const before = store.oldestCursor[conversationId];
    if (!before) return false;
    await store.fetchMessages(conversationId, before);
    return useDMStore.getState().hasMore[conversationId] !== false;
  }, [conversationId]);

  // Stable extraData — FlatList uses this to decide when to re-call renderItem.
  // Including highlightedMessageId here ensures the highlight row gets updated
  // even when renderItem is memoized via useCallback.
  const flatListExtraData = useMemo(
    () => ({ expressionLookup, highlightedMessageId }),
    [expressionLookup, highlightedMessageId],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: DMMessage; index: number }) => {
      const prev = displayMessages[index + 1] ?? null;
      return (
        <SwipeableMessageRow
          disabled={item.messageType === 'system'}
          onReply={() => setReplyToMessage(item)}
        >
          <DMMessageRow
            message={item}
            prevMessage={prev}
            selfUserId={selfUser?.id}
            selfUsername={selfUser?.displayName ?? selfUser?.username}
            selfAvatar={selfUser?.avatar}
            conversation={conversation}
            expressionLookup={expressionLookup}
            serverUrl={dmMediaUrl}
            imageScope={dmImageScope}
            isHighlighted={highlightedMessageId === item.id}
            onMessageLongPress={handleMessageLongPress}
            onOpenProfile={openProfile}
            onJumpToReply={handleJumpToReply}
            onToggleReaction={handleToggleReaction}
            onOpenReactions={(msg, emoji) => setReactionsSheetState({ open: true, reactions: msg.reactions ?? null, initialEmoji: emoji ?? null })}
          />
        </SwipeableMessageRow>
      );
    },
    // displayMessages changes when messages arrive (expected). All other deps are stable.
    [displayMessages, selfUser, conversation, expressionLookup, dmMediaUrl, dmImageScope, highlightedMessageId, handleMessageLongPress, openProfile, handleJumpToReply, handleToggleReaction],
  );

  const handleDraftChange = (value: string) => {
    setDraft(value);
    if (!conversation?.otherUserId) return;

    const socket = getSocket(dmSocketUrl);
    if (!socket) return;

    if (value.trim().length > 0) {
      // Re-announce every 2.5s while typing continues, so a recipient who missed the first
      // start (app suspended, reconnecting) still sees it; receivers expire silent typers.
      if (!typingActiveRef.current || Date.now() - typingSentAtRef.current > 2500) {
        socket.emit('dm:typing:start', { recipientId: conversation.otherUserId });
        typingActiveRef.current = true;
        typingSentAtRef.current = Date.now();
      }
      clearTimeout(typingTimerRef.current);
      typingTimerRef.current = setTimeout(() => {
        socket.emit('dm:typing:stop', { recipientId: conversation.otherUserId });
        typingActiveRef.current = false;
      }, 2500);
      return;
    }

    if (typingActiveRef.current) socket.emit('dm:typing:stop', { recipientId: conversation.otherUserId });
    typingActiveRef.current = false;
    clearTimeout(typingTimerRef.current);
  };

  useEffect(() => {
    return () => {
      clearTimeout(typingTimerRef.current);
      if (conversation?.otherUserId) {
        getSocket(dmSocketUrl)?.emit('dm:typing:stop', { recipientId: conversation.otherUserId });
      }
      typingActiveRef.current = false;
    };
  }, [conversation?.otherUserId, dmSocketUrl]);

  // Header E2EE badge appearance, driven by this device's encryption state.
  // Defaults to the calm "synced" look until the manifest resolves so we don't
  // flash a warning on every conversation open.
  const encryptionBadge = localKeyNeedsTrust
    ? { Icon: ShieldAlert, color: '#f87171', border: 'rgba(248,113,113,0.4)', bg: 'rgba(248,113,113,0.08)', label: 'Verify device' }
    : dmEncryptionState === 'pending'
    ? { Icon: LockOpen, color: '#fbbf24', border: 'rgba(251,191,36,0.4)', bg: 'rgba(251,191,36,0.08)', label: 'Pending' }
    : dmEncryptionState === 'locked'
      ? { Icon: ShieldAlert, color: '#f87171', border: 'rgba(248,113,113,0.4)', bg: 'rgba(248,113,113,0.08)', label: 'Locked' }
      : { Icon: Lock, color: '#34d399', border: 'rgba(52,211,153,0.4)', bg: 'rgba(52,211,153,0.08)', label: 'E2EE' };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.colors.bgApp }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
    <SafeAreaView style={{ flex: 1 }} edges={['top']}>
      {/* Header */}
      <View
        style={[
          styles.header,
          {
            borderBottomColor: theme.colors.lineSoft,
            paddingHorizontal: theme.spacing.sm,
            paddingVertical: theme.spacing.sm,
            gap: theme.spacing.sm,
          },
        ]}
      >
        <IconBtn icon={ArrowLeft} onPress={() => router.back()} accessibilityLabel={t('chat.backLabel')} />
        {conversation && (
          <Pressable
            haptic
            onPress={openOtherUserProfile}
            accessibilityRole="button"
            accessibilityLabel={t('chat.openProfile', { username: conversation.otherDisplayName ?? conversation.otherUsername })}
            style={styles.headerIdentity}
          >
            {peerKeyRecoveryPending ? <Lock size={16} color={theme.colors.danger} accessibilityLabel="DM key recovery requested" /> : null}
            <Avatar
              username={conversation.otherUsername}
              uri={conversation.otherAvatar}
              size={32}
              shape="square"
              status={otherStatus}
            />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text variant="subtitle" numberOfLines={1}>
                {conversation.otherDisplayName ?? conversation.otherUsername}
              </Text>
              <Text variant="caption" color={theme.colors.text3} numberOfLines={1}>
                {t(`status.${otherStatus && otherStatus !== 'invisible' ? otherStatus : 'invisible'}`)}
              </Text>
            </View>
          </Pressable>
        )}
        {!conversation && (
          <Text variant="subtitle" style={{ flex: 1 }} numberOfLines={1}>
            {conversationId}
          </Text>
        )}
        <TouchableOpacity
          onPress={() => setShowE2EInfo(true)}
          accessibilityLabel={t('chat.e2eeInfo')}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: encryptionBadge.border, backgroundColor: encryptionBadge.bg }}
        >
          <encryptionBadge.Icon size={16} color={encryptionBadge.color} />
          <Text variant="caption" style={{ color: encryptionBadge.color, fontWeight: '600' }}>{encryptionBadge.label}</Text>
        </TouchableOpacity>
        {/* Video call button intentionally absent (parity with desktop): camera is
            volunteered from inside a call, never forced by the call action. */}
        {conversationId && (
          <IconBtn icon={Phone} onPress={() => initiateDMCall(conversationId, 'audio')} accessibilityLabel={t('chat.startAudioCall')} />
        )}
        {conversationId && isTablet ? (
          <>
            <IconBtn icon={Search} onPress={() => setSearchOpen(true)} accessibilityLabel={t('chat.searchTitle')} />
            <IconBtn icon={Pin} onPress={() => setPinsOpen(true)} accessibilityLabel={t('server.pinnedAccessibility')} />
            <IconBtn icon={dmMuted ? BellOff : Bell} onPress={() => setShowNotificationControls(true)} accessibilityLabel={t('chat.dmNotifSettings')} />
          </>
        ) : conversationId ? (
          <IconBtn
            icon={EllipsisVertical}
            onPress={() => setActionsOpen(true)}
            accessibilityLabel={t('chat.conversationActions')}
          />
        ) : null}
      </View>

      {dmEncryptionState === 'locked' && keyHoldersBlocked && (
        <View style={{ marginHorizontal: 12, marginTop: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(251,191,36,0.4)', backgroundColor: 'rgba(251,191,36,0.08)' }}>
          <Text variant="caption" style={{ color: '#fbbf24' }}>{t('chat.retrustBanner')}</Text>
        </View>
      )}

      {isFocused && conversationId && conversation ? (
        <DMKeyRecoveryPanel
          conversationId={conversationId}
          otherUsername={conversation.otherDisplayName ?? conversation.otherUsername}
          onIncomingChange={setPeerKeyRecoveryPending}
          onLocalKeyNeedsTrustChange={setLocalKeyNeedsTrust}
          decryptFailure={decryptFailure}
          keySyncRetryAt={keySyncRetryAt}
          onRetryMessages={async () => {
            if (decryptFailure !== 1 && decryptFailure !== 'rate_limited') await retryCurrentDeviceDMKey(conversationId);
            await fetchMessages(conversationId);
          }}
          onOpenDeviceSettings={() => router.push({ pathname: '/settings', params: { section: 'account-security' } })}
        />
      ) : null}

      {/* Conversation actions sheet (search / pins / notifications) */}
      <Sheet open={actionsOpen} onClose={() => setActionsOpen(false)} maxHeightFraction={0.4}>
        <View style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 4 }}>
          {([
            { key: 'search', Icon: Search, label: t('chat.searchTitle'), onPress: () => setSearchOpen(true) },
            { key: 'pins', Icon: Pin, label: t('chat.pinnedMessages'), onPress: () => setPinsOpen(true) },
            { key: 'notifications', Icon: dmMuted ? BellOff : Bell, label: t('chat.dmNotifications'), onPress: () => setShowNotificationControls(true) },
          ] as const).map(({ key, Icon, label, onPress }) => (
            <Pressable
              key={key}
              haptic
              onPress={() => {
                setActionsOpen(false);
                // iOS won't present a Modal while another is dismissing; wait out the exit animation.
                clearTimeout(actionHandoffRef.current);
                actionHandoffRef.current = setTimeout(onPress, 300);
              }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingVertical: 14,
                paddingHorizontal: 12,
                borderRadius: theme.radius.md,
                backgroundColor: theme.colors.bgElev2,
              }}
            >
              <Icon size={18} color={theme.colors.text2} />
              <Text variant="body" color={theme.colors.text}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </Sheet>

      {/* DM notification controls modal */}
      <Modal
        visible={showNotificationControls}
        supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
        transparent
        animationType="fade"
        onRequestClose={() => setShowNotificationControls(false)}
        statusBarTranslucent
      >
        <TouchableOpacity
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: 24 }}
          activeOpacity={1}
          onPress={() => setShowNotificationControls(false)}
        >
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={{ width: '100%', maxWidth: 420 }}>
            <View style={{ backgroundColor: theme.colors.bgElev1, borderRadius: theme.radius.xl, overflow: 'hidden' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 20, borderBottomWidth: 1, borderBottomColor: theme.colors.lineSoft }}>
                <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: theme.colors.bgElev2, alignItems: 'center', justifyContent: 'center' }}>
                  {dmMuted ? <BellOff size={22} color={theme.colors.text2} /> : <Bell size={22} color={theme.colors.accent} />}
                </View>
                <View style={{ flex: 1 }}>
                  <Text variant="subtitle" style={{ fontWeight: '700' }}>{t('chat.dmNotifications')}</Text>
                  <Text variant="caption" color={theme.colors.text3}>
                    {dmMuted ? t('chat.dmMutedForConversation') : t('chat.dmEnabledForConversation')}
                  </Text>
                </View>
              </View>

              <View style={{ padding: 20, gap: 12 }}>
                <Text variant="bodySmall" color={theme.colors.text2}>
                  {dmMuted ? t('chat.dmMutedStatusDesc') : t('chat.dmEnabledStatusDesc')}
                </Text>

                {([
                  { muted: false as boolean, label: t('chat.dmUnmuted'), description: t('chat.dmUnmutedOptionDesc') },
                  { muted: true as boolean, label: t('chat.dmMutedOption'), description: t('chat.dmMutedOptionDesc') },
                ]).map((option) => {
                  const selected = dmMuted === option.muted;
                  return (
                    <Pressable
                      key={option.label}
                      haptic
                      onPress={() => {
                        if (!conversationId || selected) return;
                        void setMute('dm', conversationId, option.muted);
                      }}
                      style={{
                        minHeight: 58,
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        backgroundColor: selected ? theme.colors.accent + '18' : theme.colors.bgElev2,
                        borderRadius: theme.radius.md,
                        borderWidth: 1,
                        borderColor: selected ? theme.colors.accentRim : theme.colors.lineSoft,
                        paddingHorizontal: 16,
                        paddingVertical: 10,
                      }}
                    >
                      <View style={{ flex: 1 }}>
                        <Text variant="subtitle" color={theme.colors.text}>{option.label}</Text>
                        <Text variant="caption" color={theme.colors.text3}>{option.description}</Text>
                      </View>
                      <View
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 11,
                          alignItems: 'center',
                          justifyContent: 'center',
                          backgroundColor: selected ? theme.colors.accent : theme.colors.bgElev1,
                          borderWidth: selected ? 0 : 1,
                          borderColor: theme.colors.lineSoft,
                        }}
                      >
                        {selected ? <Check size={14} color={theme.colors.textOnAccent} /> : null}
                      </View>
                    </Pressable>
                  );
                })}

                <Pressable
                  haptic
                  onPress={() => setShowNotificationControls(false)}
                  style={{
                    backgroundColor: theme.colors.bgElev2,
                    borderRadius: theme.radius.md,
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                  }}
                >
                  <Text variant="subtitle" color={theme.colors.text2}>{t('chat.done')}</Text>
                </Pressable>
              </View>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* E2EE info modal */}
      <Modal visible={showE2EInfo} transparent animationType="fade" onRequestClose={() => setShowE2EInfo(false)} statusBarTranslucent
        supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}>
        <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: 24 }} activeOpacity={1} onPress={() => setShowE2EInfo(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={{ width: '100%', maxWidth: 420 }}>
            <View style={{ backgroundColor: theme.colors.bgElev1, borderRadius: theme.radius.xl, overflow: 'hidden' }}>
              {/* Header */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 20, borderBottomWidth: 1, borderBottomColor: theme.colors.lineSoft }}>
                <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(52,211,153,0.15)', alignItems: 'center', justifyContent: 'center' }}>
                  <Lock size={22} color="#34d399" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text variant="subtitle" style={{ fontWeight: '700' }}>{t('chat.messageEncryption')}</Text>
                  <Text variant="caption" color={theme.colors.text3}>{t('chat.messagesProtected')}</Text>
                </View>
              </View>

              {/* Body */}
              <ScrollView style={{ maxHeight: 340 }} contentContainerStyle={{ padding: 20, gap: 16 }}>
                <View style={{ gap: 4 }}>
                  <Text variant="body" style={{ fontWeight: '600' }}>{t('chat.trueE2EE')}</Text>
                  <Text variant="caption" color={theme.colors.text2} style={{ lineHeight: 18 }}>
                    {t('chat.e2eeAesDesc')}
                  </Text>
                </View>

                <View style={{ gap: 4 }}>
                  <Text variant="body" style={{ fontWeight: '600' }}>{t('chat.deviceKeyExchange')}</Text>
                  <Text variant="caption" color={theme.colors.text2} style={{ lineHeight: 18 }}>
                    {t('chat.e2eeKeyDesc')}
                  </Text>
                </View>

                <View style={{ gap: 4 }}>
                  <Text variant="body" style={{ fontWeight: '600' }}>{t('chat.messageStorage')}</Text>
                  <Text variant="caption" color={theme.colors.text2} style={{ lineHeight: 18 }}>
                    {t('chat.e2eeStorageDesc')}
                  </Text>
                </View>

                <View style={{ backgroundColor: 'rgba(52,211,153,0.1)', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(52,211,153,0.25)', padding: 12 }}>
                  <Text variant="caption" style={{ color: '#6ee7b7', lineHeight: 17 }}>
                    <Text variant="caption" style={{ fontWeight: '700', color: '#6ee7b7' }}>{t('chat.securityNote')}</Text>
                    {t('chat.e2eeSecurityNote')}
                  </Text>
                </View>
              </ScrollView>

              {/* Footer */}
              <View style={{ padding: 16, borderTopWidth: 1, borderTopColor: theme.colors.lineSoft }}>
                <TouchableOpacity onPress={() => setShowE2EInfo(false)} style={{ backgroundColor: theme.colors.accent, borderRadius: theme.radius.md, paddingVertical: 10, alignItems: 'center' }}>
                  <Text variant="body" style={{ color: '#fff', fontWeight: '600' }}>{t('chat.gotIt')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <SwipeSidebarContainer style={{ overflow: 'hidden' }}>
        <View style={{ flex: 1 }}>
          <FlatList
            ref={flatListRef}
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            keyboardShouldPersistTaps="handled"
            onScrollBeginDrag={Keyboard.dismiss}
            onScroll={handleScroll}
            scrollEventThrottle={100}
            inverted
            data={displayMessages}
            keyExtractor={(item) => item.id}
            extraData={flatListExtraData}
            renderItem={renderItem}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingVertical: 8 }}
            onEndReached={handleLoadOlder}
            onEndReachedThreshold={0.3}
            maxToRenderPerBatch={8}
            updateCellsBatchingPeriod={50}
            windowSize={5}
            initialNumToRender={20}
            removeClippedSubviews={Platform.OS === 'android'}
            onScrollToIndexFailed={({ averageItemLength, index }) => {
              flatListRef.current?.scrollToOffset({
                offset: index * averageItemLength,
                animated: true,
              });
            }}
            ListFooterComponent={
              loading ? (
                <View style={{ padding: 12 }}>
                  <ActivityIndicator color={theme.colors.accent} />
                </View>
              ) : null
            }
          />

          {typingUsers.length > 0 ? (
            <View style={[styles.typingBar, { borderTopColor: theme.colors.lineSoft }]}>
              <Avatar
                username={conversation?.otherUsername ?? t('notifications.someone')}
                uri={conversation?.otherAvatar ?? null}
                size={20}
                shape="square"
                showStatus={false}
              />
              <Text variant="caption" color={theme.colors.text3}>
                {t('chat.isTyping', { name: conversation?.otherDisplayName ?? conversation?.otherUsername ?? t('notifications.someone') })}
              </Text>
            </View>
          ) : null}

          {isScrollingOld && (
            <View style={[styles.oldMessagesBanner, { backgroundColor: theme.colors.bgElev1, borderTopColor: theme.colors.lineSoft }]}>
              <Text variant="caption" color={theme.colors.text3} style={{ flex: 1 }}>
                {t('chat.viewingOldMessages')}
              </Text>
              <TouchableOpacity onPress={handleWarpToCurrent} style={[styles.warpBtn, { backgroundColor: theme.colors.accent }]}>
                <Text variant="caption" style={{ color: '#fff', fontWeight: '600' }}>
                  {t('chat.warpToCurrent')}
                </Text>
              </TouchableOpacity>
            </View>
          )}
          {replyToMessage && (
            <View style={[styles.replyBar, { backgroundColor: theme.colors.bgElev1, borderTopColor: theme.colors.lineSoft }]}>
              <CornerUpLeft color={theme.colors.accent} size={14} />
              <Text variant="caption" color={theme.colors.text3} style={{ flex: 1 }} numberOfLines={1}>
                <Text variant="caption" color={theme.colors.accent}>
                  {replyToMessage.senderId === conversation?.otherUserId
                    ? (conversation?.otherDisplayName ?? conversation?.otherUsername ?? '')
                    : (selfUser?.displayName ?? selfUser?.username ?? '')}
                </Text>
                {'  '}{(parseDmContextText(replyToMessage.text)?.bodyText ?? replyToMessage.text) || t('chat.attachment')}
              </Text>
              <TouchableOpacity onPress={() => setReplyToMessage(null)} style={{ padding: 4 }}>
                <X color={theme.colors.text3} size={14} />
              </TouchableOpacity>
            </View>
          )}
          <DMRequestBanner conversation={conversation} />
          <MobileComposer
            value={draft}
            onChangeText={handleDraftChange}
            placeholder={t('chat.messagePlaceholder', { name: conversation?.otherDisplayName ?? conversation?.otherUsername ?? '' })}
            onSend={(serializedText, _attachments, localAttachments, options) => void handleSend(serializedText, localAttachments, options)}
            disabled={sending || !canSend}
            bottomInset={composerBottom}
            expressionLookup={expressionLookup}
            serverUrl={dmMediaUrl}
            deferUpload
            voiceMessages
          />
        </View>
      </SwipeSidebarContainer>

      <MessageActionSheet
        open={Boolean(activeMessage)}
        onClose={() => setActiveMessage(null)}
        expressionLookup={expressionLookup}
        serverUrl={serverUrl}
        isDm
        initialEditText={activeMessage?.text ?? ''}
        translationMessageId={activeMessage?.id}
        translationText={activeMessage ? (parseDmContextText(activeMessage.text)?.bodyText ?? activeMessage.text) : null}
        reactions={activeMessage?.reactions}
        onViewReactions={() => {
          if (!activeMessage) return;
          const current = activeMessage;
          setActiveMessage(null);
          setReactionsSheetState({ open: true, reactions: current.reactions ?? null, initialEmoji: null });
        }}
        canEdit={Boolean(activeMessage && activeMessage.senderId === selfUser?.id)}
        canDelete={Boolean(activeMessage && activeMessage.senderId === selfUser?.id)}
        onReply={() => {
          if (!activeMessage) return;
          setReplyToMessage(activeMessage);
          setActiveMessage(null);
        }}
        onReact={(token) => {
          if (!activeMessage) return;
          void toggleReaction(activeMessage.id, token);
        }}
        isPinned={Boolean(activeMessage && pinnedEntries.some((entry) => entry.messageId === activeMessage.id))}
        onPin={activeMessage?.messageType === 'system' ? undefined : () => {
          if (!activeMessage) return;
          const isPinned = pinnedEntries.some((entry) => entry.messageId === activeMessage.id);
          if (isPinned) {
            void unpinMessage(activeMessage.id);
          } else {
            void pinMessage(activeMessage.id);
          }
          setActiveMessage(null);
        }}
        onEdit={(nextText) => {
          if (!activeMessage) return;
          return editMessage(activeMessage.id, nextText);
        }}
        onCopy={() => {
          if (!activeMessage) return;
          void Share.share({ message: activeMessage.text });
          setActiveMessage(null);
        }}
        onDelete={() => {
          if (!activeMessage) return;
          void deleteMessage(activeMessage.id);
        }}
      />

      <MessageReactionsSheet
        open={reactionsSheetState.open}
        onClose={() => setReactionsSheetState({ open: false, reactions: null, initialEmoji: null })}
        reactions={reactionsSheetState.reactions}
        serverUrl={serverUrl}
        initialEmoji={reactionsSheetState.initialEmoji}
      />

      {/* Search sheet */}
      <DMSearchSheet
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        messages={messages}
        selfUserId={selfUser?.id}
        selfName={selfUser?.displayName ?? selfUser?.username}
        selfAvatar={selfUser?.avatar}
        otherName={conversation?.otherDisplayName ?? conversation?.otherUsername}
        otherAvatar={conversation?.otherAvatar}
        serverUrl={serverUrl}
        expressionLookup={expressionLookup}
        hasOlder={hasMore}
        onLoadOlder={loadOlderForSearch}
        onSelectResult={jumpAfterSheetClose}
      />

      {/* Pinned messages sheet */}
      <Sheet open={pinsOpen} onClose={() => setPinsOpen(false)} maxHeightFraction={0.7}>
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <Text variant="subtitle">{t('chat.pinnedMessages')}</Text>
        </View>
        {pinnedEntries.length === 0 ? (
          <View style={{ padding: 16 }}>
            <Text variant="bodySmall" color={theme.colors.text3}>{t('chat.noPinnedMessages')}</Text>
          </View>
        ) : (
          <FlatList
            data={pinnedEntries}
            keyExtractor={(entry) => entry.messageId}
            contentContainerStyle={{ paddingBottom: 24, paddingHorizontal: 16 }}
            renderItem={({ item }) => {
              const isOther = item.message.senderId === conversation?.otherUserId;
              const senderName = isOther
                ? (conversation?.otherDisplayName ?? conversation?.otherUsername ?? '')
                : (selfUser?.displayName ?? selfUser?.username ?? '');
              const avatarUri = isOther ? (conversation?.otherAvatar ?? null) : (selfUser?.avatar ?? null);
              const body = parseDmContextText(item.message.text)?.bodyText ?? item.message.text;
              return (
                <Pressable
                  haptic
                  onPress={() => {
                    setPinsOpen(false);
                    jumpAfterSheetClose(item.messageId);
                  }}
                  style={{ flexDirection: 'row', gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.lineSoft }}
                >
                  <Avatar username={senderName} uri={avatarUri} size={32} shape="square" showStatus={false} />
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                      <Text variant="subtitle" numberOfLines={1}>{senderName}</Text>
                      <Text variant="caption" color={theme.colors.text3}>{formatMessageTimestamp(item.message.createdAt)}</Text>
                    </View>
                    {body ? (
                      <MarkdownText
                        text={body}
                        color={theme.colors.text2}
                        style={{ fontSize: 13 }}
                        serverUrl={serverUrl}
                        expressionLookup={expressionLookup}
                      />
                    ) : (
                      <Text variant="bodySmall" color={theme.colors.text3}>{t('chat.attachment')}</Text>
                    )}
                  </View>
                </Pressable>
              );
            }}
          />
        )}
      </Sheet>
    </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
  },
  headerIdentity: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  systemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
    gap: 8,
    opacity: 0.7,
  },
  msgRowWrap: {
    position: 'relative',
  },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  msgRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 12,
    paddingBottom: 2,
    gap: 10,
  },
  messageIdentityButton: {
    minHeight: 36,
    minWidth: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  messageNameButton: {
    minHeight: 24,
    minWidth: 0,
    alignItems: 'flex-start',
    justifyContent: 'center',
    maxWidth: '72%',
  },
  avatarPlaceholder: {
    width: 36,
  },
  msgMeta: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: 2,
  },
  contextCard: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginBottom: 4,
  },
  contextPreview: {
    marginTop: 3,
    maxHeight: 60,
    overflow: 'hidden',
    opacity: 0.85,
  },
  reactionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 4,
  },
  reactionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  typingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  oldMessagesBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  warpBtn: {
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
});
