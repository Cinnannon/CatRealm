/**
 * ForumChannelView — Desktop-parity forum channel experience for Mobile & Tablet.
 * Mirrors CatRealm-Client/src/components/chat/ForumChannel.tsx, ForumPostCard.tsx,
 * ForumPostComposer.tsx, and ForumPostView.tsx.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Keyboard,
  Platform,
  Pressable as RNPressable,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  CornerUpLeft,
  ImagePlus,
  LayoutGrid,
  List,
  MessageCircle,
  Paperclip,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/theme';
import { Text } from './Text';
import { Avatar } from './Avatar';
import { BotBadge } from './BotBadge';
import { Pressable } from './Pressable';
import { MobileComposer, type ComposerSendOptions } from './MobileComposer';
import { TranslatableMarkdownText } from './TranslatableMarkdownText';
import { SwipeableMessageRow } from './SwipeableMessageRow';
import { ServerMentionProvider } from './MentionText';
import { createApi } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { uploadChatFile } from '@/lib/uploadApi';
import { useAuthStore } from '@/stores/authStore';
import { useComposerKeyboardInset } from '@/hooks/useComposerKeyboardInset';
import { formatMessageTimestamp } from '@/utils/formatTime';
import { hasChannelPermission, PERMISSIONS } from '@/utils/permissions';
import type { Channel, ForumPost, Message, MessageAttachment } from '@/types';
import type { ExpressionLookup } from '@/lib/expressionCache';

type SortMode = 'activity' | 'newest' | 'oldest';
type ViewMode = 'list' | 'gallery';

const EMPTY_POSTS: ForumPost[] = [];
const GROUP_THRESHOLD_MS = 5 * 60 * 1000;

function toMs(v: number): number {
  return v < 10_000_000_000 ? v * 1000 : v;
}

function formatRelativeForumTime(epochMaybeSec: number | null | undefined): string {
  if (!epochMaybeSec || !Number.isFinite(epochMaybeSec)) return '';
  const ms = toMs(epochMaybeSec);
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} ${diffHr === 1 ? 'hour' : 'hours'} ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 30) return `${diffDays} days ago`;
  return formatMessageTimestamp(ms);
}

function resolveMediaUrl(rawUrl: string | null | undefined, serverUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  if (/^https?:\/\//i.test(rawUrl) || rawUrl.startsWith('blob:') || rawUrl.startsWith('data:')) {
    return rawUrl;
  }
  const base = (serverUrl ?? '').replace(/\/+$/, '');
  return base ? `${base}${rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`}` : rawUrl;
}

function getPostCoverUrl(post: ForumPost, serverUrl: string | null | undefined): string | null {
  if (post.cover_image) {
    return resolveMediaUrl(post.cover_image, serverUrl);
  }
  const firstImg = post.body_attachments?.find((att) => {
    const mime = att.mime ?? att.type ?? '';
    return mime.startsWith('image/') || /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(att.url ?? '');
  });
  if (firstImg?.url) {
    return resolveMediaUrl(firstImg.thumbnailUrl ?? firstImg.thumbnail_url ?? firstImg.url, serverUrl);
  }
  return null;
}

// ─── Forum Post Card ──────────────────────────────────────────────────────────

function ForumPostCardItem({
  post,
  viewMode,
  cardWidth,
  serverUrl,
  canManage,
  onOpen,
  onArchive,
  onDelete,
}: {
  post: ForumPost;
  viewMode: ViewMode;
  cardWidth?: number;
  serverUrl?: string | null;
  canManage: boolean;
  onOpen: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
}) {
  const theme = useTheme();
  const displayName = post.author_display_name || post.author_username;
  const coverUrl = getPostCoverUrl(post, serverUrl);
  const avatarBaseUrl = post.author_account_type === 'central' ? undefined : (serverUrl ?? undefined);

  if (viewMode === 'gallery') {
    return (
      <Pressable
        haptic
        onPress={onOpen}
        style={[
          styles.galleryCard,
          {
            width: cardWidth,
            backgroundColor: theme.colors.bgElev1,
            borderColor: theme.colors.lineSoft,
          },
        ]}
      >
        <View style={[styles.galleryCoverWrap, { backgroundColor: theme.colors.bgElev2 }]}>
          {coverUrl ? (
            <ExpoImage
              source={{ uri: coverUrl }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              cachePolicy="memory-disk"
            />
          ) : (
            <MessageCircle size={28} color={theme.colors.text3} />
          )}
          {Boolean(post.archived) && (
            <View style={styles.archivedOverlayBadge}>
              <Text variant="caption" style={styles.archivedOverlayText}>Archived</Text>
            </View>
          )}
        </View>

        <View style={styles.galleryCardBody}>
          <Text variant="subtitle" numberOfLines={2} style={styles.galleryTitle}>
            {post.name}
          </Text>
          {Boolean(post.preview_content) && (
            <Text variant="caption" color={theme.colors.text2} numberOfLines={2} style={styles.galleryPreview}>
              {post.preview_content}
            </Text>
          )}
          <View style={[styles.galleryFooter, { borderTopColor: theme.colors.lineSoft }]}>
            <View style={styles.authorRow}>
              <Avatar
                username={displayName}
                uri={post.author_avatar}
                baseUrl={avatarBaseUrl}
                size={16}
                showStatus={false}
              />
              <Text variant="caption" color={theme.colors.text3} numberOfLines={1} style={{ flex: 1 }}>
                {displayName}
              </Text>
            </View>
            <View style={styles.replyCountInline}>
              <MessageCircle size={12} color={theme.colors.text3} />
              <Text variant="caption" color={theme.colors.text3}>{post.reply_count}</Text>
            </View>
          </View>
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable
      haptic
      onPress={onOpen}
      style={[
        styles.listCard,
        {
          backgroundColor: theme.colors.bgElev1,
          borderColor: theme.colors.lineSoft,
        },
      ]}
    >
      <View style={styles.listCardRow}>
        {coverUrl ? (
          <View style={[styles.listThumbWrap, { backgroundColor: theme.colors.bgElev2 }]}>
            <ExpoImage
              source={{ uri: coverUrl }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              cachePolicy="memory-disk"
            />
          </View>
        ) : null}

        <View style={styles.listCardMain}>
          <View style={styles.listTitleRow}>
            <Text variant="subtitle" numberOfLines={2} style={[styles.listTitle, { color: theme.colors.text }]}>
              {post.name}
            </Text>
            {canManage && (onArchive || onDelete) ? (
              <View style={styles.manageRow}>
                {onArchive ? (
                  <RNPressable
                    onPress={(e) => {
                      e.stopPropagation?.();
                      onArchive();
                    }}
                    hitSlop={6}
                    style={styles.manageBtn}
                  >
                    {post.archived ? (
                      <ArchiveRestore size={15} color={theme.colors.text3} />
                    ) : (
                      <Archive size={15} color={theme.colors.text3} />
                    )}
                  </RNPressable>
                ) : null}
                {onDelete ? (
                  <RNPressable
                    onPress={(e) => {
                      e.stopPropagation?.();
                      onDelete();
                    }}
                    hitSlop={6}
                    style={styles.manageBtn}
                  >
                    <Trash2 size={15} color={theme.colors.danger} />
                  </RNPressable>
                ) : null}
              </View>
            ) : null}
          </View>

          {Boolean(post.preview_content) && (
            <Text
              variant="bodySmall"
              color={theme.colors.text2}
              numberOfLines={2}
              style={styles.listPreview}
            >
              {post.preview_content}
            </Text>
          )}

          <View style={styles.listFooterRow}>
            <View style={styles.authorMetaRow}>
              <Avatar
                username={displayName}
                uri={post.author_avatar}
                baseUrl={avatarBaseUrl}
                size={18}
                showStatus={false}
              />
              <Text variant="caption" color={theme.colors.text3} numberOfLines={1} style={styles.authorName}>
                {displayName}
              </Text>
              <Text variant="caption" color={theme.colors.text3}>·</Text>
              <Text variant="caption" color={theme.colors.text3}>
                {formatRelativeForumTime(post.created_at)}
              </Text>
              {Boolean(post.archived) && (
                <View style={[styles.archivedPill, { backgroundColor: theme.colors.warning + '22' }]}>
                  <Text variant="caption" style={{ color: theme.colors.warning, fontSize: 10, fontWeight: '700' }}>
                    Archived
                  </Text>
                </View>
              )}
            </View>

            <View style={styles.statsMetaRow}>
              <Text variant="caption" color={theme.colors.text3}>
                {formatRelativeForumTime(post.last_message_at ?? post.created_at)}
              </Text>
              <View
                style={[
                  styles.replyCountBadge,
                  {
                    backgroundColor: theme.colors.bgApp,
                    borderColor: theme.colors.lineSoft,
                  },
                ]}
              >
                <MessageCircle size={12} color={theme.colors.text3} />
                <Text variant="caption" color={theme.colors.text2} style={{ fontWeight: '600' }}>
                  {post.reply_count}
                </Text>
              </View>
            </View>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

// ─── Inline Forum Post Composer ───────────────────────────────────────────────

function InlineForumComposer({
  channelId,
  serverUrl,
  serverToken,
  onCreated,
  onCancel,
}: {
  channelId: string;
  serverUrl?: string | null;
  serverToken?: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [coverAsset, setCoverAsset] = useState<{ uri: string; mime: string; name: string } | null>(null);
  const [attachments, setAttachments] = useState<Array<{ uri: string; mime: string; name: string }>>([]);
  const [submitting, setSubmitting] = useState(false);

  const pickCover = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.9,
      allowsMultipleSelection: false,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const asset = res.assets[0];
    setCoverAsset({
      uri: asset.uri,
      mime: asset.mimeType ?? 'image/jpeg',
      name: asset.fileName ?? `cover-${Date.now()}.jpg`,
    });
  };

  const pickAttachments = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.9,
      allowsMultipleSelection: true,
    });
    if (res.canceled || !res.assets?.length) return;
    const picked = res.assets.map((asset, idx) => ({
      uri: asset.uri,
      mime: asset.mimeType ?? (asset.type === 'video' ? 'video/mp4' : 'image/jpeg'),
      name: asset.fileName ?? `attachment-${Date.now()}-${idx}.jpg`,
    }));
    setAttachments((prev) => [...prev, ...picked]);
  };

  const handleSubmit = async () => {
    if (!title.trim() || !body.trim() || submitting) return;
    setSubmitting(true);
    try {
      const api = createApi(serverUrl ?? undefined, serverToken);

      let coverImageUrl: string | null = null;
      if (coverAsset) {
        const uploadedCover = await uploadChatFile(
          coverAsset.uri,
          coverAsset.mime,
          coverAsset.name,
          channelId,
          serverUrl,
        );
        coverImageUrl = uploadedCover.url;
      }

      const uploadedAttachments: Array<{ url: string; mime: string | null; size: number | null }> = [];
      if (attachments.length > 0) {
        const results = await Promise.all(
          attachments.map((att) =>
            uploadChatFile(att.uri, att.mime, att.name, channelId, serverUrl),
          ),
        );
        for (const r of results) {
          uploadedAttachments.push({
            url: r.url,
            mime: r.mime ?? null,
            size: r.size ?? null,
          });
        }
      }

      const msgRes = await api.post<{ id: string }>('/api/messages/forum', {
        channelId,
        content: body.trim(),
        attachments: uploadedAttachments,
      });
      await api.post('/api/threads', {
        channelId,
        messageId: msgRes.data.id,
        name: title.trim(),
        coverImage: coverImageUrl,
      });

      Keyboard.dismiss();
      onCreated();
    } catch (err) {
      Alert.alert('Post failed', err instanceof Error ? err.message : 'Failed to create forum post.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View
      style={[
        styles.composerCard,
        {
          backgroundColor: theme.colors.bgElev1,
          borderColor: theme.colors.lineSoft,
        },
      ]}
    >
      <View style={[styles.composerTitleRow, { borderBottomColor: theme.colors.lineSoft }]}>
        <RNPressable onPress={onCancel} hitSlop={8} style={styles.composerCancelBtn}>
          <X size={18} color={theme.colors.text3} />
        </RNPressable>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder="Title"
          placeholderTextColor={theme.colors.text3}
          maxLength={100}
          style={[styles.composerTitleInput, { color: theme.colors.text }]}
        />
      </View>

      <View style={styles.composerBodyRow}>
        <TextInput
          value={body}
          onChangeText={setBody}
          placeholder="Enter a message..."
          placeholderTextColor={theme.colors.text3}
          multiline
          maxLength={2000}
          style={[styles.composerBodyInput, { color: theme.colors.text }]}
        />
        <RNPressable
          onPress={() => void pickCover()}
          style={[
            styles.coverUploadBox,
            {
              backgroundColor: theme.colors.bgElev2,
              borderColor: theme.colors.lineSoft,
            },
          ]}
        >
          {coverAsset ? (
            <>
              <Image source={{ uri: coverAsset.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
              <RNPressable
                onPress={() => setCoverAsset(null)}
                style={styles.removeCoverBtn}
              >
                <X size={12} color="#fff" />
              </RNPressable>
            </>
          ) : (
            <ImagePlus size={24} color={theme.colors.text3} />
          )}
        </RNPressable>
      </View>

      {attachments.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.attachStrip}
        >
          {attachments.map((att, idx) => (
            <View
              key={`${att.uri}-${idx}`}
              style={[styles.attachThumbBox, { borderColor: theme.colors.lineSoft }]}
            >
              <Image source={{ uri: att.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
              <RNPressable
                onPress={() => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                style={styles.removeCoverBtn}
              >
                <X size={11} color="#fff" />
              </RNPressable>
            </View>
          ))}
        </ScrollView>
      )}

      <View style={[styles.composerBottomBar, { borderTopColor: theme.colors.lineSoft }]}>
        <View style={styles.composerLeftActions}>
          <RNPressable onPress={() => void pickAttachments()} hitSlop={8} style={styles.attachIconBtn}>
            <Paperclip size={18} color={theme.colors.text3} />
          </RNPressable>
          <Text variant="caption" color={theme.colors.text3}>{body.length}/2000</Text>
        </View>

        <Pressable
          haptic
          disabled={submitting || !title.trim() || !body.trim()}
          onPress={() => void handleSubmit()}
          style={[
            styles.submitPostBtn,
            {
              backgroundColor: theme.colors.accent,
              opacity: submitting || !title.trim() || !body.trim() ? 0.5 : 1,
            },
          ]}
        >
          <MessageCircle size={14} color="#fff" />
          <Text variant="bodySmall" style={styles.submitPostText}>
            {submitting ? 'Posting...' : 'Post'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

// ─── Inline Forum Post Detail View (Starter Post + Replies) ───────────────────

function ForumPostDetailView({
  post,
  channel,
  serverId,
  serverUrl,
  serverToken,
  expressionLookup,
  canUseExternalEmotes,
  canUseExternalStickers,
  onBack,
}: {
  post: ForumPost;
  channel: Channel;
  serverId: string;
  serverUrl?: string | null;
  serverToken?: string;
  expressionLookup?: ExpressionLookup | null;
  canUseExternalEmotes?: boolean;
  canUseExternalStickers?: boolean;
  onBack: () => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const selfUser = useAuthStore((s) => s.user);
  const composerBottom = useComposerKeyboardInset();

  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<Message | null>(null);

  const canReply = hasChannelPermission(
    selfUser?.permissions,
    channel.effective_permissions,
    PERMISSIONS.SEND_MESSAGES_IN_POSTS,
  );

  useEffect(() => {
    setLoading(true);
    const api = createApi(serverUrl ?? undefined, serverToken);
    api
      .get<Message[]>(`/api/threads/${post.id}/messages`, { params: { limit: 100 } })
      .then((res) => {
        setMessages(Array.isArray(res.data) ? res.data : []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    const socket = getSocket();
    const join = () => socket?.emit('thread:join', post.id);
    join();
    const onNewMessage = (msg: Message) => {
      if (msg.thread_id === post.id) {
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      }
    };
    socket?.on('connect', join);
    socket?.on('message:new', onNewMessage);
    return () => {
      socket?.off('connect', join);
      socket?.off('message:new', onNewMessage);
    };
  }, [post.id, serverToken, serverUrl]);

  const handleSendReply = (
    serializedText?: string,
    attachments?: { url: string; mime: string; size: number; thumbnailUrl?: string | null; isNsfw: boolean }[],
    _localAttachments?: unknown,
    options?: ComposerSendOptions,
  ) => {
    const text = (serializedText ?? draft).trim();
    if (!text && !attachments?.length) return;
    getSocket()?.emit('message:send', {
      channelId: channel.id,
      threadId: post.id,
      content: text,
      replyToId: replyTo?.id ?? undefined,
      attachments:
        attachments?.map((att) => ({
          url: att.url,
          mime: att.mime,
          size: att.size,
          ...(att.thumbnailUrl ? { thumbnailUrl: att.thumbnailUrl } : {}),
        })) ?? [],
      nsfwTags: attachments?.some((att) => att.isNsfw) ? ['nsfw'] : [],
      voice_expires_at: options?.voiceExpiresAt ?? null,
    });
    setDraft('');
    setReplyTo(null);
  };

  const starterAttachments = useMemo<MessageAttachment[] | null>(() => {
    const list: MessageAttachment[] = [];
    if (Array.isArray(post.body_attachments) && post.body_attachments.length > 0) {
      list.push(...post.body_attachments);
    } else if (post.cover_image) {
      list.push({ url: post.cover_image, mime: 'image/jpeg' });
    }
    return list.length > 0 ? list : null;
  }, [post.body_attachments, post.cover_image]);

  const authorDisplay = post.author_display_name || post.author_username;
  const avatarBaseUrl = post.author_account_type === 'central' ? undefined : (serverUrl ?? undefined);

  return (
    <View style={{ flex: 1 }}>
      {/* Post Sub-header */}
      <View style={[styles.postViewHeader, { borderBottomColor: theme.colors.lineSoft }]}>
        <Pressable haptic onPress={onBack} style={styles.postBackBtn}>
          <ArrowLeft size={18} color={theme.colors.text2} />
        </Pressable>
        <MessageCircle size={16} color={theme.colors.text3} />
        <Text variant="subtitle" numberOfLines={1} style={{ flex: 1 }}>
          {post.name}
        </Text>
      </View>

      <ServerMentionProvider serverId={serverId} serverUrl={serverUrl ?? null} token={serverToken}>
        <FlatList
          data={messages}
          keyExtractor={(item) => item.id}
          style={{ flex: 1 }}
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 16 }}
          ListHeaderComponent={
            <View>
              {/* Original Starter Post */}
              <View style={[styles.starterPostBox, { borderBottomColor: theme.colors.lineSoft }]}>
                <View style={styles.starterAuthorRow}>
                  <Avatar
                    username={authorDisplay}
                    uri={post.author_avatar}
                    baseUrl={avatarBaseUrl}
                    size={34}
                  />
                  <View style={{ flex: 1 }}>
                    <Text variant="subtitle" numberOfLines={1}>{authorDisplay}</Text>
                    <Text variant="caption" color={theme.colors.text3}>
                      {formatMessageTimestamp(toMs(post.created_at))}
                    </Text>
                  </View>
                </View>

                <Text variant="title" style={styles.starterTitle}>
                  {post.name}
                </Text>

                <TranslatableMarkdownText
                  messageId={post.parent_message_id ?? post.id}
                  text={post.preview_content}
                  color={theme.colors.text2}
                  attachments={starterAttachments}
                  serverUrl={serverUrl}
                  expressionLookup={expressionLookup}
                  linkPreviews
                />
              </View>

              {/* Replies count divider */}
              <View style={[styles.repliesCountBar, { borderBottomColor: theme.colors.lineSoft }]}>
                <Text variant="caption" color={theme.colors.text3}>
                  {loading
                    ? 'Loading replies...'
                    : `${messages.length} ${messages.length === 1 ? 'reply' : 'replies'}`}
                </Text>
              </View>
            </View>
          }
          ListEmptyComponent={
            loading ? (
              <View style={{ padding: 24, alignItems: 'center' }}>
                <ActivityIndicator color={theme.colors.accent} />
              </View>
            ) : (
              <View style={{ padding: 24, alignItems: 'center' }}>
                <Text variant="bodySmall" color={theme.colors.text3}>No replies yet.</Text>
              </View>
            )
          }
          renderItem={({ item, index }) => {
            const prev = index > 0 ? messages[index - 1] : null;
            const grouped =
              prev !== null &&
              prev.user_id === item.user_id &&
              toMs(item.created_at) - toMs(prev.created_at) < GROUP_THRESHOLD_MS;

            return (
              <SwipeableMessageRow onReply={() => setReplyTo(item)}>
                <View style={[styles.replyRow, { paddingTop: grouped ? 2 : 12 }]}>
                  {grouped ? (
                    <View style={{ width: 34 }} />
                  ) : (
                    <Avatar
                      username={item.username}
                      uri={item.avatar}
                      baseUrl={serverUrl ?? undefined}
                      size={34}
                    />
                  )}
                  <View style={{ flex: 1 }}>
                    {!grouped && (
                      <View style={styles.replyMeta}>
                        <Text
                          variant="subtitle"
                          style={{ color: item.role_color ?? theme.colors.text }}
                          numberOfLines={1}
                        >
                          {item.display_name ?? item.username}
                        </Text>
                        {item.is_bot ? <BotBadge /> : null}
                        <Text variant="caption" color={theme.colors.text3} style={{ marginLeft: 6 }}>
                          {formatMessageTimestamp(toMs(item.created_at))}
                        </Text>
                      </View>
                    )}
                    <TranslatableMarkdownText
                      messageId={item.id}
                      text={item.content}
                      color={theme.colors.text}
                      attachments={item.attachments}
                      serverUrl={serverUrl}
                      expressionLookup={expressionLookup}
                      nsfwTags={item.nsfw_tags}
                      allowEmbeds={item.embeds_enabled !== 0}
                      linkPreviews
                      voiceExpiresAt={item.voice_expires_at}
                    />
                  </View>
                </View>
              </SwipeableMessageRow>
            );
          }}
        />
      </ServerMentionProvider>

      {replyTo ? (
        <View
          style={[
            styles.replyBanner,
            { backgroundColor: theme.colors.bgElev1, borderTopColor: theme.colors.lineSoft },
          ]}
        >
          <CornerUpLeft size={14} color={theme.colors.accent} />
          <Text variant="caption" color={theme.colors.text3} style={{ flex: 1 }} numberOfLines={1}>
            <Text variant="caption" color={theme.colors.accent}>
              {replyTo.display_name ?? replyTo.username}
            </Text>
            {'  '}
            {replyTo.content || t('chat.attachment')}
          </Text>
          <TouchableOpacity onPress={() => setReplyTo(null)} style={{ padding: 4 }}>
            <X size={14} color={theme.colors.text3} />
          </TouchableOpacity>
        </View>
      ) : null}

      {canReply ? (
        <MobileComposer
          value={draft}
          onChangeText={setDraft}
          placeholder={`Reply to ${post.name}...`}
          onSend={handleSendReply}
          bottomInset={composerBottom}
          expressionLookup={expressionLookup}
          serverUrl={serverUrl}
          channelId={channel.id}
          mentionsEnabled
          canUseExternalEmotes={canUseExternalEmotes}
          canUseExternalStickers={canUseExternalStickers}
          voiceMessages
        />
      ) : null}
    </View>
  );
}

// ─── Main ForumChannelView ────────────────────────────────────────────────────

export function ForumChannelView({
  channel,
  serverId,
  serverUrl,
  serverToken,
  expressionLookup,
  canUseExternalEmotes,
  canUseExternalStickers,
}: {
  channel: Channel;
  serverId: string;
  serverUrl?: string | null;
  serverToken?: string;
  expressionLookup?: ExpressionLookup | null;
  canUseExternalEmotes?: boolean;
  canUseExternalStickers?: boolean;
}) {
  const theme = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const selfUser = useAuthStore((s) => s.user);

  const [posts, setPosts] = useState<ForumPost[]>(EMPTY_POSTS);
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState(false);
  const [search, setSearch] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('activity');
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [activePost, setActivePost] = useState<ForumPost | null>(null);
  const [containerWidth, setContainerWidth] = useState(windowWidth);

  const channelLayout = channel.forum_layout ?? 'user_choice';
  const [userViewMode, setUserViewMode] = useState<ViewMode>('list');
  const effectiveView: ViewMode =
    channelLayout === 'list'
      ? 'list'
      : channelLayout === 'gallery'
        ? 'gallery'
        : userViewMode;

  const canCreatePost = hasChannelPermission(
    selfUser?.permissions,
    channel.effective_permissions,
    PERMISSIONS.CREATE_POST_IN_FORUMS,
  );
  const canManage = hasChannelPermission(
    selfUser?.permissions,
    channel.effective_permissions,
    PERMISSIONS.MANAGE_POSTS,
  );

  const fetchForumPosts = useCallback(async () => {
    try {
      const api = createApi(serverUrl ?? undefined, serverToken);
      const res = await api.get<ForumPost[]>('/api/threads/forum', {
        params: { channelId: channel.id, archived: 1 },
      });
      setPosts(Array.isArray(res.data) ? res.data : EMPTY_POSTS);
    } catch {
      setPosts(EMPTY_POSTS);
    } finally {
      setLoading(false);
    }
  }, [channel.id, serverToken, serverUrl]);

  useEffect(() => {
    setLoading(true);
    setActivePost(null);
    setComposing(false);
    setSearch('');
    setShowArchived(false);
    void fetchForumPosts();
  }, [channel.id, fetchForumPosts]);

  // Listen for live forum post updates over socket
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const refresh = () => {
      void fetchForumPosts();
    };
    socket.on('thread:created', refresh);
    socket.on('thread:updated', refresh);
    socket.on('thread:deleted', refresh);
    return () => {
      socket.off('thread:created', refresh);
      socket.off('thread:updated', refresh);
      socket.off('thread:deleted', refresh);
    };
  }, [fetchForumPosts]);

  const handleArchiveToggle = async (post: ForumPost) => {
    try {
      const api = createApi(serverUrl ?? undefined, serverToken);
      await api.post(`/api/threads/${post.id}/${post.archived ? 'unarchive' : 'archive'}`);
      void fetchForumPosts();
    } catch {
      // Ignore error
    }
  };

  const handleDeletePost = (post: ForumPost) => {
    Alert.alert('Delete Post', `Delete "${post.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void createApi(serverUrl ?? undefined, serverToken)
            .delete(`/api/threads/${post.id}`)
            .then(() => fetchForumPosts())
            .catch(() => {});
        },
      },
    ]);
  };

  const sortAndFilter = useCallback(
    (list: ForumPost[]) => {
      const q = search.trim().toLowerCase();
      const filtered = q
        ? list.filter(
            (p) =>
              p.name.toLowerCase().includes(q) ||
              (p.preview_content ?? '').toLowerCase().includes(q) ||
              p.author_username.toLowerCase().includes(q) ||
              (p.author_display_name ?? '').toLowerCase().includes(q),
          )
        : list;

      if (sortMode === 'newest') {
        return [...filtered].sort((a, b) => b.created_at - a.created_at);
      }
      if (sortMode === 'oldest') {
        return [...filtered].sort((a, b) => a.created_at - b.created_at);
      }
      return [...filtered].sort(
        (a, b) => (b.last_message_at ?? b.created_at) - (a.last_message_at ?? a.created_at),
      );
    },
    [search, sortMode],
  );

  const activePosts = useMemo(
    () => sortAndFilter(posts.filter((p) => !p.archived)),
    [posts, sortAndFilter],
  );
  const archivedPosts = useMemo(
    () => sortAndFilter(posts.filter((p) => Boolean(p.archived))),
    [posts, sortAndFilter],
  );

  if (activePost) {
    return (
      <ForumPostDetailView
        post={activePost}
        channel={channel}
        serverId={serverId}
        serverUrl={serverUrl}
        serverToken={serverToken}
        expressionLookup={expressionLookup}
        canUseExternalEmotes={canUseExternalEmotes}
        canUseExternalStickers={canUseExternalStickers}
        onBack={() => {
          setActivePost(null);
          void fetchForumPosts();
        }}
      />
    );
  }

  const galleryCols = containerWidth >= 680 ? 3 : 2;
  const galleryCardWidth = Math.floor((containerWidth - 28 - (galleryCols - 1) * 10) / galleryCols);

  return (
    <View
      style={{ flex: 1, backgroundColor: theme.colors.bgApp }}
      onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
    >
      {/* Top Search Bar or Inline Post Composer */}
      {composing ? (
        <InlineForumComposer
          channelId={channel.id}
          serverUrl={serverUrl}
          serverToken={serverToken}
          onCreated={() => {
            setComposing(false);
            void fetchForumPosts();
          }}
          onCancel={() => setComposing(false)}
        />
      ) : (
        <View style={styles.searchBarRow}>
          <View
            style={[
              styles.searchBox,
              {
                backgroundColor: theme.colors.bgElev2,
                borderColor: theme.colors.lineSoft,
              },
            ]}
          >
            <Search size={15} color={theme.colors.text3} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search or create a post..."
              placeholderTextColor={theme.colors.text3}
              style={[styles.searchInput, { color: theme.colors.text }]}
              returnKeyType="search"
            />
            {search.length > 0 && (
              <RNPressable onPress={() => setSearch('')} hitSlop={8}>
                <X size={15} color={theme.colors.text3} />
              </RNPressable>
            )}
          </View>

          {canCreatePost && (
            <Pressable
              haptic
              onPress={() => setComposing(true)}
              style={[styles.newPostBtn, { backgroundColor: theme.colors.accent }]}
            >
              <MessageCircle size={15} color="#fff" />
              <Text variant="bodySmall" style={styles.newPostBtnText}>
                New Post
              </Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Sort & View Bar */}
      <View style={styles.controlsRow}>
        <Pressable
          haptic
          onPress={() => setShowSortMenu((v) => !v)}
          style={[
            styles.sortPill,
            {
              backgroundColor: theme.colors.bgElev1,
              borderColor: theme.colors.lineSoft,
            },
          ]}
        >
          <SlidersHorizontal size={13} color={theme.colors.text2} />
          <Text variant="caption" color={theme.colors.text2} style={{ fontWeight: '600' }}>
            Sort & View
          </Text>
          <ChevronDown size={13} color={theme.colors.text3} />
        </Pressable>

        {channelLayout === 'user_choice' && (
          <View
            style={[
              styles.viewToggleGroup,
              {
                backgroundColor: theme.colors.bgElev1,
                borderColor: theme.colors.lineSoft,
              },
            ]}
          >
            <RNPressable
              onPress={() => setUserViewMode('list')}
              style={[
                styles.viewToggleBtn,
                userViewMode === 'list' && { backgroundColor: theme.colors.accent + '28' },
              ]}
            >
              <List
                size={14}
                color={userViewMode === 'list' ? theme.colors.accent : theme.colors.text3}
              />
            </RNPressable>
            <RNPressable
              onPress={() => setUserViewMode('gallery')}
              style={[
                styles.viewToggleBtn,
                { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.colors.lineSoft },
                userViewMode === 'gallery' && { backgroundColor: theme.colors.accent + '28' },
              ]}
            >
              <LayoutGrid
                size={14}
                color={userViewMode === 'gallery' ? theme.colors.accent : theme.colors.text3}
              />
            </RNPressable>
          </View>
        )}
      </View>

      {/* Sort Menu Dropdown */}
      {showSortMenu && (
        <View
          style={[
            styles.sortDropdown,
            {
              backgroundColor: theme.colors.bgElev1,
              borderColor: theme.colors.lineSoft,
            },
          ]}
        >
          <Text variant="caption" color={theme.colors.text3} style={styles.sortDropdownHeader}>
            SORT BY
          </Text>
          {(['activity', 'newest', 'oldest'] as SortMode[]).map((mode) => {
            const selected = sortMode === mode;
            const label =
              mode === 'activity' ? 'Latest Activity' : mode === 'newest' ? 'Newest' : 'Oldest';
            return (
              <Pressable
                key={mode}
                haptic
                onPress={() => {
                  setSortMode(mode);
                  setShowSortMenu(false);
                }}
                style={[
                  styles.sortMenuItem,
                  selected && { backgroundColor: theme.colors.accent + '18' },
                ]}
              >
                <Text
                  variant="bodySmall"
                  color={selected ? theme.colors.accent : theme.colors.text}
                  style={{ flex: 1, fontWeight: selected ? '700' : '500' }}
                >
                  {label}
                </Text>
                {selected && <Check size={15} color={theme.colors.accent} />}
              </Pressable>
            );
          })}
        </View>
      )}

      {/* Posts ScrollView */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.postsContainer}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {loading && posts.length === 0 ? (
          <View style={styles.emptyState}>
            <ActivityIndicator color={theme.colors.accent} />
          </View>
        ) : activePosts.length === 0 ? (
          <View style={styles.emptyState}>
            <Text variant="subtitle" style={{ textAlign: 'center' }}>
              {search.trim()
                ? 'No posts match your search.'
                : 'Be the first to start the conversation!'}
            </Text>
            {!search.trim() && (
              <Text variant="bodySmall" color={theme.colors.text3} style={{ textAlign: 'center' }}>
                What do you want to post about in #{channel.name}?
              </Text>
            )}
          </View>
        ) : effectiveView === 'gallery' ? (
          <View style={styles.galleryGrid}>
            {activePosts.map((post) => (
              <ForumPostCardItem
                key={post.id}
                post={post}
                viewMode="gallery"
                cardWidth={galleryCardWidth}
                serverUrl={serverUrl}
                canManage={canManage}
                onOpen={() => setActivePost(post)}
                onArchive={canManage ? () => void handleArchiveToggle(post) : undefined}
                onDelete={canManage ? () => handleDeletePost(post) : undefined}
              />
            ))}
          </View>
        ) : (
          <View style={styles.listStack}>
            {activePosts.map((post) => (
              <ForumPostCardItem
                key={post.id}
                post={post}
                viewMode="list"
                serverUrl={serverUrl}
                canManage={canManage}
                onOpen={() => setActivePost(post)}
                onArchive={canManage ? () => void handleArchiveToggle(post) : undefined}
                onDelete={canManage ? () => handleDeletePost(post) : undefined}
              />
            ))}
          </View>
        )}

        {/* Archived Posts Section */}
        {archivedPosts.length > 0 && (
          <View style={styles.archivedSection}>
            <Pressable
              haptic
              onPress={() => setShowArchived((v) => !v)}
              style={styles.archivedToggleRow}
            >
              {showArchived ? (
                <ChevronDown size={14} color={theme.colors.text3} />
              ) : (
                <ChevronRight size={14} color={theme.colors.text3} />
              )}
              <Text variant="caption" color={theme.colors.text3} style={styles.archivedHeaderText}>
                ARCHIVED POSTS ({archivedPosts.length})
              </Text>
            </Pressable>

            {showArchived && (
              <View style={[styles.listStack, { opacity: 0.72, marginTop: 8 }]}>
                {archivedPosts.map((post) => (
                  <ForumPostCardItem
                    key={post.id}
                    post={post}
                    viewMode={effectiveView}
                    cardWidth={galleryCardWidth}
                    serverUrl={serverUrl}
                    canManage={canManage}
                    onOpen={() => setActivePost(post)}
                    onArchive={canManage ? () => void handleArchiveToggle(post) : undefined}
                    onDelete={canManage ? () => handleDeletePost(post) : undefined}
                  />
                ))}
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  searchBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 8,
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 38,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 0,
  },
  newPostBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 38,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  newPostBtnText: {
    color: '#fff',
    fontWeight: '700',
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  sortPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  viewToggleGroup: {
    flexDirection: 'row',
    borderRadius: 999,
    borderWidth: 1,
    overflow: 'hidden',
  },
  viewToggleBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sortDropdown: {
    marginHorizontal: 14,
    marginBottom: 10,
    borderRadius: 10,
    borderWidth: 1,
    overflow: 'hidden',
  },
  sortDropdownHeader: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
    fontWeight: '700',
    fontSize: 10,
    letterSpacing: 0.6,
  },
  sortMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  postsContainer: {
    paddingHorizontal: 14,
    paddingBottom: 28,
  },
  listStack: {
    gap: 10,
  },
  listCard: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 14,
  },
  listCardRow: {
    flexDirection: 'row',
    gap: 12,
  },
  listThumbWrap: {
    width: 64,
    height: 64,
    borderRadius: 8,
    overflow: 'hidden',
  },
  listCardMain: {
    flex: 1,
    minWidth: 0,
  },
  listTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 4,
  },
  listTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 21,
  },
  manageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  manageBtn: {
    padding: 4,
  },
  listPreview: {
    marginBottom: 10,
    lineHeight: 19,
  },
  listFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    flexWrap: 'wrap',
  },
  authorMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  authorName: {
    maxWidth: 140,
  },
  archivedPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
  },
  statsMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  replyCountBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  galleryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  galleryCard: {
    borderRadius: 10,
    borderWidth: 1,
    overflow: 'hidden',
  },
  galleryCoverWrap: {
    width: '100%',
    aspectRatio: 16 / 9,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  archivedOverlayBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    backgroundColor: 'rgba(0,0,0,0.68)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
  },
  archivedOverlayText: {
    color: '#fbbf24',
    fontSize: 10,
    fontWeight: '700',
  },
  galleryCardBody: {
    padding: 10,
    gap: 4,
  },
  galleryTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  galleryPreview: {
    lineHeight: 16,
  },
  galleryFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flex: 1,
    minWidth: 0,
  },
  replyCountInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  archivedSection: {
    marginTop: 16,
  },
  archivedToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
  },
  archivedHeaderText: {
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  emptyState: {
    paddingVertical: 56,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  composerCard: {
    marginHorizontal: 14,
    marginTop: 12,
    marginBottom: 8,
    borderRadius: 10,
    borderWidth: 1,
    overflow: 'hidden',
  },
  composerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  composerCancelBtn: {
    padding: 2,
  },
  composerTitleInput: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    paddingVertical: 2,
  },
  composerBodyRow: {
    flexDirection: 'row',
    minHeight: 96,
    padding: 10,
    gap: 10,
  },
  composerBodyInput: {
    flex: 1,
    fontSize: 14,
    textAlignVertical: 'top',
  },
  coverUploadBox: {
    width: 84,
    height: 84,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
  },
  removeCoverBtn: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachStrip: {
    paddingHorizontal: 10,
    paddingBottom: 8,
    gap: 8,
  },
  attachThumbBox: {
    width: 56,
    height: 56,
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
    position: 'relative',
  },
  composerBottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  composerLeftActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  attachIconBtn: {
    padding: 4,
  },
  submitPostBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
  },
  submitPostText: {
    color: '#fff',
    fontWeight: '700',
  },
  postViewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  postBackBtn: {
    padding: 4,
  },
  starterPostBox: {
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  starterAuthorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  starterTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  repliesCountBar: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  replyRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingHorizontal: 14,
    paddingBottom: 4,
  },
  replyMeta: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: 2,
  },
  replyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
