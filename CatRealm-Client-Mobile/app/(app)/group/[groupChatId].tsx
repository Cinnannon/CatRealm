import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useComposerKeyboardInset } from '@/hooks/useComposerKeyboardInset';
import { SafeAreaView } from '@/components/SafeAreaView';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Bell, BellOff, ChevronLeft, CornerUpLeft, Phone, Users, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/theme';
import { Text, Avatar, Pressable, MobileComposer, TranslatableMarkdownText, MessageActionSheet, SwipeableMessageRow, SwipeSidebarContainer } from '@/components';
import { ReactionChips } from '@/components/ReactionChips';
import { GroupMembersSheet } from '@/components/GroupMembersSheet';
import { AUTH_BASE } from '@/lib/api';
import { centralScope, realmScope } from '@/lib/imageCache';
import { useExpressionLookup, type ExpressionLookup } from '@/lib/expressionCache';
import { useAuthStore } from '@/stores/authStore';
import { usePushSettingsStore } from '@/stores/pushSettingsStore';
import { useGroupChatStore } from '@/stores/groupChatStore';
import { useCallStore } from '@/stores/callStore';
import { formatMessageTimestamp } from '@/utils/formatTime';
import type { GroupChatMessage, MessageAttachment } from '@/types';
import type { LocalComposerAttachment } from '@/components/MobileComposer';

const EMPTY_MSGS: GroupChatMessage[] = [];
const GROUP_THRESHOLD_MS = 5 * 60 * 1000;

const senderLabel = (m: GroupChatMessage) => m.senderDisplayName || m.senderUsername;

// ─── Message row ─────────────────────────────────────────────────────────────

/** Multi-attachment list, falling back to the legacy single-attachment columns. */
function messageAttachments(message: GroupChatMessage): MessageAttachment[] | null {
  if (message.attachments?.length) return message.attachments;
  if (!message.attachmentUrl) return null;
  return [{
    url: message.attachmentUrl,
    type: message.attachmentType ?? null,
    mime: message.attachmentType ?? null,
    size: message.attachmentSize ?? null,
    name: message.attachmentName ?? null,
  }];
}

const GroupMessageRow = memo(function GroupMessageRow({
  message,
  prev,
  mediaUrl,
  imageScope,
  expressionLookup,
  onLongPress,
  onToggleReaction,
}: {
  message: GroupChatMessage;
  prev: GroupChatMessage | null;
  mediaUrl?: string | null;
  imageScope?: string;
  expressionLookup?: ExpressionLookup | null;
  onLongPress: (message: GroupChatMessage) => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
}) {
  const theme = useTheme();
  const grouped =
    prev !== null &&
    prev.senderId === message.senderId &&
    message.createdAt - prev.createdAt < GROUP_THRESHOLD_MS;

  const resolveAvatar = (uri?: string | null): string | undefined => {
    if (!uri) return undefined;
    if (uri.startsWith('http')) return uri;
    const base = mediaUrl?.replace(/\/$/, '') ?? '';
    return base + (uri.startsWith('/') ? uri : '/' + uri);
  };

  if (message.messageType === 'system') {
    return (
      <View style={styles.systemRow}>
        <Text variant="caption" color={theme.colors.text3} style={{ textAlign: 'center' }}>
          {message.text}
        </Text>
      </View>
    );
  }

  return (
    <Pressable minHit={0} onLongPress={() => onLongPress(message)} style={[styles.row, { paddingTop: grouped ? 2 : 12 }]}>
      {grouped ? (
        <View style={styles.avatarPlaceholder} />
      ) : (
        <Avatar
          username={message.senderUsername}
          uri={resolveAvatar(message.senderAvatar)}
          size={36}
          shape="square"
        />
      )}
      <View style={{ flex: 1 }}>
        {!grouped && (
          <View style={styles.meta}>
            <Text variant="subtitle" numberOfLines={1}>
              {senderLabel(message)}
            </Text>
            <Text variant="caption" color={theme.colors.text3} style={{ marginLeft: 6 }}>
              {formatMessageTimestamp(message.createdAt)}
            </Text>
          </View>
        )}
        <TranslatableMarkdownText
          messageId={message.id}
          text={message.text}
          color={theme.colors.text}
          attachments={messageAttachments(message)}
          serverUrl={mediaUrl}
          imageScope={imageScope}
          expressionLookup={expressionLookup}
          nsfwTags={message.nsfwTags}
          linkPreviews
        />
        <ReactionChips
          reactions={message.reactions ?? []}
          serverUrl={mediaUrl}
          onToggle={(emoji) => onToggleReaction(message.id, emoji)}
        />
      </View>
    </Pressable>
  );
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function GroupChatScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const { groupChatId } = useLocalSearchParams<{ groupChatId: string }>();

  const selfUser = useAuthStore((s) => s.user);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  // Group chats live on Central, same media/cache routing as DMs.
  const mediaUrl = selfUser?.accountType === 'central' ? AUTH_BASE : (serverUrl ?? null);
  const imageScope = selfUser?.accountType === 'central' ? centralScope('DMs') : realmScope(serverUrl ?? '');
  const expressionLookup = useExpressionLookup(serverUrl);

  const groups = useGroupChatStore((s) => s.groups);
  const messages = useGroupChatStore((s) =>
    groupChatId ? (s.messagesByGroup[groupChatId] ?? EMPTY_MSGS) : EMPTY_MSGS,
  );
  const fetchMessages = useGroupChatStore((s) => s.fetchMessages);
  const fetchOlderMessages = useGroupChatStore((s) => s.fetchOlderMessages);
  const sendMessage = useGroupChatStore((s) => s.sendMessage);
  const markRead = useGroupChatStore((s) => s.markRead);
  const toggleReaction = useGroupChatStore((s) => s.toggleReaction);
  const editMessage = useGroupChatStore((s) => s.editMessage);
  const deleteMessage = useGroupChatStore((s) => s.deleteMessage);
  const initiateGroupCall = useCallStore((s) => s.initiateGroupCall);
  const activeCall = useCallStore((s) => s.activeCall);
  const joinGroupCall = useCallStore((s) => s.joinGroupCall);

  const group = groups.find((g) => g.id === groupChatId) ?? null;
  const activeCallForThisGroup = activeCall?.callType === 'group' && activeCall.groupChatId === groupChatId
    ? activeCall
    : null;

  const isMuted = usePushSettingsStore((s) => s.isMuted);
  const setMute = usePushSettingsStore((s) => s.setMute);
  const groupMuted = groupChatId ? isMuted('group', groupChatId) : false;

  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [activeMessage, setActiveMessage] = useState<GroupChatMessage | null>(null);
  const [replyToMessage, setReplyToMessage] = useState<GroupChatMessage | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);

  const flatListRef = useRef<FlatList<GroupChatMessage>>(null);
  const composerBottom = useComposerKeyboardInset();


  useEffect(() => {
    if (!groupChatId) return;
    setLoading(true);
    void fetchMessages(groupChatId).finally(() => setLoading(false));
    void markRead(groupChatId);
  }, [groupChatId, fetchMessages, markRead]);

  const handleLoadMore = useCallback(() => {
    if (loadingOlder || !hasMore || !groupChatId || messages.length === 0) return;
    const oldestMs = messages[0]?.createdAt;
    if (!oldestMs) return;
    setLoadingOlder(true);
    void fetchOlderMessages(groupChatId, oldestMs).then((more) => {
      setHasMore(more);
    }).finally(() => setLoadingOlder(false));
  }, [loadingOlder, hasMore, groupChatId, messages, fetchOlderMessages]);

  const handleSend = useCallback((serializedText?: string, _attachments?: unknown, localAttachments?: LocalComposerAttachment[]) => {
    const body = (serializedText ?? draft).trim();
    if ((!body && !localAttachments?.length) || !groupChatId) return;
    // Replies are a plain markdown quote: desktop group chats don't parse the DM context envelope.
    let text = body;
    if (replyToMessage) {
      const preview = replyToMessage.text.replace(/\s+/g, ' ').trim().slice(0, 160) || t('chat.attachment');
      text = `> Replying to ${senderLabel(replyToMessage)}: ${preview}${body ? `\n${body}` : ''}`;
    }
    setDraft('');
    void sendMessage(groupChatId, text, localAttachments?.length ? localAttachments : undefined).then((ok) => {
      if (ok) {
        setReplyToMessage(null);
      } else {
        setDraft(body);
        Alert.alert(t('chat.sendFailed'), t('chat.sendFailedMsg'));
      }
    });
  }, [draft, groupChatId, replyToMessage, sendMessage, t]);

  const handleMessageLongPress = useCallback((msg: GroupChatMessage) => {
    if (msg.messageType === 'system') return;
    setActiveMessage(msg);
  }, []);

  const handleToggleReaction = useCallback((messageId: string, emoji: string) => {
    if (groupChatId) void toggleReaction(groupChatId, messageId, emoji);
  }, [groupChatId, toggleReaction]);

  const displayMessages = useMemo(() => [...messages].reverse(), [messages]);
  const isOwnActive = Boolean(activeMessage && activeMessage.senderId === selfUser?.id);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.colors.bgApp }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={[styles.header, { borderBottomColor: theme.colors.lineSoft }]}>
          <Pressable haptic onPress={() => router.back()} style={styles.backBtn}>
            <ChevronLeft color={theme.colors.accent} size={20} />
          </Pressable>
          <Avatar username={group?.name ?? t('groups.defaultName')} uri={undefined} size={28} />
          <View style={{ flex: 1 }}>
            <Text variant="subtitle" numberOfLines={1}>{group?.name ?? t('groups.defaultChatName')}</Text>
            {group && (
              <Text variant="caption" color={theme.colors.text3}>
                {activeCallForThisGroup
                  ? t('groups.callStatus', { count: group.memberCount, status: activeCallForThisGroup.status })
                  : t('chats.memberCount', { count: group.memberCount })}
              </Text>
            )}
          </View>
          {groupChatId && (
            <>
            {activeCallForThisGroup && activeCallForThisGroup.status !== 'active' ? (
              <Pressable haptic onPress={() => joinGroupCall(activeCallForThisGroup.callId, groupChatId, activeCallForThisGroup.mediaType)} style={{ padding: 4 }} accessibilityLabel={t('groups.joinActiveCall')}>
                <Phone size={18} color={theme.colors.accent} />
              </Pressable>
            ) : null}
            {/* One call button, like DMs: camera is turned on from inside the call. */}
            {!activeCallForThisGroup ? (
              <Pressable haptic onPress={() => initiateGroupCall(groupChatId, 'audio')} style={{ padding: 4 }} accessibilityLabel={t('groups.startAudioCall')}>
                <Phone size={18} color={theme.colors.text3} />
              </Pressable>
            ) : null}
            <Pressable
              haptic
              onPress={() => void setMute('group', groupChatId, !groupMuted)}
              style={{ padding: 4 }}
              accessibilityLabel={groupMuted ? t('groups.unmuteNotifications') : t('groups.muteNotifications')}
            >
              {groupMuted
                ? <BellOff size={18} color={theme.colors.text3} />
                : <Bell size={18} color={theme.colors.text3} />}
            </Pressable>
            </>
          )}
          <Pressable haptic onPress={() => setMembersOpen(true)} style={{ padding: 4 }} accessibilityLabel={t('chat.members')}>
            <Users size={18} color={theme.colors.text3} />
          </Pressable>
        </View>

        <SwipeSidebarContainer style={{ overflow: 'hidden' }}>
          <View style={{ flex: 1 }}>
            {loading ? (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator color={theme.colors.accent} />
              </View>
            ) : (
              <FlatList
                ref={flatListRef}
                style={{ flex: 1 }}
                inverted
                data={displayMessages}
                keyExtractor={(m) => m.id}
                keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
                keyboardShouldPersistTaps="handled"
                onScrollBeginDrag={Keyboard.dismiss}
                onEndReached={handleLoadMore}
                onEndReachedThreshold={0.3}
                ListFooterComponent={
                  loadingOlder
                    ? <ActivityIndicator color={theme.colors.accent} style={{ margin: 12 }} />
                    : null
                }
                ListEmptyComponent={
                  <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
                    <Text variant="bodySmall" color={theme.colors.text3}>
                      {t('chats.noMessagesSayHello')}
                    </Text>
                  </View>
                }
                renderItem={({ item, index }) => {
                  const prev = displayMessages[index + 1] ?? null;
                  return (
                    <SwipeableMessageRow
                      disabled={item.messageType === 'system'}
                      onReply={() => setReplyToMessage(item)}
                    >
                      <GroupMessageRow
                        message={item}
                        prev={prev}
                        mediaUrl={mediaUrl}
                        imageScope={imageScope}
                        expressionLookup={expressionLookup}
                        onLongPress={handleMessageLongPress}
                        onToggleReaction={handleToggleReaction}
                      />
                    </SwipeableMessageRow>
                  );
                }}
              />
            )}

            {replyToMessage && (
              <View style={[styles.replyBar, { backgroundColor: theme.colors.bgElev1, borderTopColor: theme.colors.lineSoft }]}>
                <CornerUpLeft color={theme.colors.accent} size={14} />
                <Text variant="caption" color={theme.colors.text3} style={{ flex: 1 }} numberOfLines={1}>
                  <Text variant="caption" color={theme.colors.accent}>{senderLabel(replyToMessage)}</Text>
                  {'  '}{replyToMessage.text || t('chat.attachment')}
                </Text>
                <TouchableOpacity onPress={() => setReplyToMessage(null)} style={{ padding: 4 }}>
                  <X color={theme.colors.text3} size={14} />
                </TouchableOpacity>
              </View>
            )}
            <MobileComposer
              value={draft}
              onChangeText={setDraft}
              placeholder={t('chat.messageGroupPlaceholder', { name: group?.name ?? t('groups.defaultName').toLowerCase() })}
              onSend={handleSend}
              disabled={false}
              bottomInset={composerBottom}
              deferUpload
              expressionLookup={expressionLookup}
              serverUrl={mediaUrl}
            />
          </View>
        </SwipeSidebarContainer>
      </SafeAreaView>

      {groupChatId ? (
        <GroupMembersSheet
          open={membersOpen}
          onClose={() => setMembersOpen(false)}
          groupChatId={groupChatId}
          mediaUrl={mediaUrl}
          onOpenProfile={(userId) => router.push({ pathname: '/profile/[userId]', params: { userId, context: 'central' } })}
        />
      ) : null}

      <MessageActionSheet
        open={Boolean(activeMessage)}
        onClose={() => setActiveMessage(null)}
        expressionLookup={expressionLookup}
        serverUrl={serverUrl}
        isDm
        initialEditText={activeMessage?.text ?? ''}
        translationMessageId={activeMessage?.id}
        translationText={activeMessage?.text}
        canEdit={isOwnActive && Boolean(activeMessage?.text.trim())}
        canDelete={isOwnActive}
        onReply={() => {
          if (!activeMessage) return;
          setReplyToMessage(activeMessage);
          setActiveMessage(null);
        }}
        onReact={(token) => {
          if (activeMessage) handleToggleReaction(activeMessage.id, token);
        }}
        onEdit={async (nextText) => {
          if (!activeMessage || !groupChatId) return;
          if (!(await editMessage(groupChatId, activeMessage.id, nextText))) Alert.alert(t('common.error'));
        }}
        onCopy={() => {
          if (!activeMessage) return;
          void Clipboard.setStringAsync(activeMessage.text);
          setActiveMessage(null);
        }}
        onDelete={() => {
          if (!activeMessage || !groupChatId) return;
          void deleteMessage(groupChatId, activeMessage.id).then((ok) => {
            if (!ok) Alert.alert(t('common.error'));
          });
        }}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    padding: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 12,
    paddingBottom: 2,
    gap: 10,
  },
  systemRow: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  avatarPlaceholder: {
    width: 36,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: 2,
  },
});
