/**
 * Server channel chat — message list + composer wired to messageStore + socket.
 * Behavior and visual hierarchy should stay aligned with the desktop chat
 * surface in CatRealm-Client/src/components/chat.
 */

import { memo, useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { View, FlatList, StyleSheet, ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, TouchableOpacity, Pressable as RNPressable, TextInput, Alert, Share, Image } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useComposerKeyboardInset } from '@/hooks/useComposerKeyboardInset';
import { useFocusEffect } from "expo-router/react-navigation";
import { useLocalSearchParams, useRouter } from 'expo-router';
import { HeadphoneOff, Hash, Menu, MessageSquareText, MicOff, Monitor, Search, Smartphone, Users, X, CornerUpLeft, CornerUpRight, Pin, ChevronDown } from 'lucide-react-native';
import axios from 'axios';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/theme';
import { Text, IconBtn, Avatar, BotBadge, MobileComposer, Pressable, ConnectedChannelPulse, useConnectedChannelIds, TranslatableMarkdownText, MessageActionSheet, MessageReactionsSheet, Sheet, ChannelIcon, ServerRulesView, ForumChannelView, ServerListPanel, DrawerLeftRail, DrawerHubFooter, SwipeableMessageRow, SwipeSidebarContainer } from '@/components';
import { VoiceChannelContent } from '@/components/VoiceChannelContent';
import { useServerStore } from '@/stores/serverStore';
import { useMessageStore } from '@/stores/messageStore';
import { useChannelStore } from '@/stores/channelStore';
import { useAuthStore } from '@/stores/authStore';
import { useUIStore } from '@/stores/uiStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useVoiceStore, type VoiceParticipant } from '@/stores/voiceStore';
import { useTheaterStore, type TheaterParticipant } from '@/stores/theaterStore';
import { useOpenTheater } from '@/components/theater/TheaterJoinModal';
import { createApi, createAuthenticatedApi } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { getOrigin, resolveEmoteFromCache, useExpressionLookup, type ExpressionLookup } from '@/lib/expressionCache';
import { RoleNameText, setRgbFlowScrolling } from '@/lib/roleStyles';
import { fetchIconByTitle } from '@/lib/gameLibraryIcons';
import { useListeningArt } from '@/lib/lastfmAlbumArt';
import type { Category, Channel, Message, OnlineUser, Reaction } from '@/types';
import type { ComposerSendOptions } from '@/components/MobileComposer';
import { hasChannelPermission, PERMISSIONS } from '@/utils/permissions';
import { formatMessageTimestamp } from '@/utils/formatTime';
import { useDeviceLayout } from '@/hooks/useDeviceLayout';
import { DOCK_HEIGHT, dockBottomInset } from '@/lib/dockLayout';
import { markRealmChannelRead } from '@/lib/realmReadState';
import { ServerMentionProvider } from '@/components/MentionText';
import { useVisibleChannelMemberIds, filterMembersByVisibleIds } from '@/hooks/useVisibleChannelMemberIds';
import { debugLog, debugTap } from '@/lib/debugLog';
import { clearImageMemoryCache } from '@/lib/imageCache';

const EMPTY_CHANNELS: Channel[] = [];
const EMPTY_CATEGORIES: { id: string; name: string; position: number }[] = [];
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_TYPING_USERS: string[] = [];
const EMPTY_MEMBERS: OnlineUser[] = [];
const EMPTY_VOICE_PARTICIPANTS: VoiceParticipant[] = [];
const EMPTY_THEATER_PARTICIPANTS: TheaterParticipant[] = [];

type MemberEntry = OnlineUser & {
  offline?: boolean;
};

type RoleGroup = {
  key: string;
  label: string;
  roleIcon: string | null;
  offline: boolean;
  users: MemberEntry[];
};

function isOfflineLikeStatus(status: unknown): boolean {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  return normalized === 'invisible' || normalized === 'offline';
}

function mergeMemberPresence(base: OnlineUser | undefined, live: OnlineUser): MemberEntry {
  const hasCustomStatusText = Object.prototype.hasOwnProperty.call(live, 'customStatusText');
  const hasActivityType = Object.prototype.hasOwnProperty.call(live, 'activityType');
  const hasActivityText = Object.prototype.hasOwnProperty.call(live, 'activityText');
  const hasActivityStartedAt = Object.prototype.hasOwnProperty.call(live, 'activityStartedAt');
  const hasStatus = Object.prototype.hasOwnProperty.call(live, 'status');
  const merged = {
    ...(base ?? {}),
    ...live,
    status: hasStatus ? (live.status ?? undefined) : undefined,
    customStatusText: hasCustomStatusText ? (live.customStatusText ?? null) : (base?.customStatusText ?? null),
    activityType: hasActivityType ? (live.activityType ?? null) : (base?.activityType ?? null),
    activityText: hasActivityText ? (live.activityText ?? null) : (base?.activityText ?? null),
    activityStartedAt: hasActivityStartedAt ? (live.activityStartedAt ?? null) : (base?.activityStartedAt ?? null),
  } as MemberEntry;

  const offline = isOfflineLikeStatus(merged.status);
  return {
    ...merged,
    offline,
    status: offline ? 'invisible' : merged.status,
  };
}

function buildMemberList(allMembers: OnlineUser[], onlineUsers: OnlineUser[]): MemberEntry[] {
  const seen = new Set<string>();
  const result: MemberEntry[] = [];
  const allMembersById = new Map(allMembers.map((member) => [member.id, member]));

  for (const user of onlineUsers) {
    seen.add(user.id);
    result.push(mergeMemberPresence(allMembersById.get(user.id), user));
  }

  for (const user of allMembers) {
    if (!seen.has(user.id)) {
      result.push({ ...user, status: undefined, offline: true });
    }
  }

  return result;
}

function resolveRoleIconUrl(roleIcon: string | null | undefined, serverUrl: string | null) {
  if (!roleIcon) return null;
  if (roleIcon.startsWith('http://') || roleIcon.startsWith('https://')) return roleIcon;
  if (!serverUrl) return null;
  return `${serverUrl}${roleIcon.startsWith('/') ? roleIcon : '/' + roleIcon}`;
}

function formatRoomElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatMemberSubtitle(member: MemberEntry, listeningLabel: string): string {
  const withSnake = member as MemberEntry & {
    custom_status_text?: string | null;
    activity_type?: string | null;
    activity_text?: string | null;
  };
  const activityType = member.activityType ?? withSnake.activity_type ?? null;
  const activityText = member.activityText ?? withSnake.activity_text ?? null;
  const customStatusText = member.customStatusText ?? withSnake.custom_status_text ?? null;
  const label = activityType === 'Listening' ? listeningLabel : activityType;
  if (activityText) return `${label ? `${label} ` : ''}${activityText}`;
  if (customStatusText) return customStatusText;
  return '';
}

function TabletMemberRow({
  member,
  theme,
  channelServerUrl,
  onPress,
}: {
  member: MemberEntry;
  theme: ReturnType<typeof useTheme>;
  channelServerUrl: string | null;
  onPress: () => void;
}) {
  const withSnake = member as MemberEntry & {
    activity_type?: string | null;
    activity_text?: string | null;
  };
  const activityType = member.activityType ?? withSnake.activity_type ?? null;
  const activityText = member.activityText ?? withSnake.activity_text ?? null;
  const { t } = useTranslation();
  const subtitle = formatMemberSubtitle(member, t('lastfm.listeningTo'));
  const isPlaying = (activityType ?? '').toLowerCase() === 'playing' && !!activityText;
  const isListening = activityType === 'Listening' && !!activityText;
  const listeningArtUrl = useListeningArt(activityType, activityText);
  const [gameIconUrl, setGameIconUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isPlaying || !activityText) {
      setGameIconUrl(null);
      return;
    }
    let cancelled = false;
    fetchIconByTitle(activityText).then((url) => {
      if (!cancelled) setGameIconUrl(url);
    }).catch(() => {
      if (!cancelled) setGameIconUrl(null);
    });
    return () => {
      cancelled = true;
    };
  }, [isPlaying, activityText]);

  const offline = !!member.offline;
  const hasDesktop = !!member.clients?.includes('desktop');
  const hasMobile = !!member.clients?.includes('mobile');
  const memberStatus = member.status ?? null;

  return (
    <Pressable key={member.id} haptic onPress={onPress} style={[styles.tabletMemberRow, offline && styles.tabletMemberRowOffline]}>
      <Avatar
        username={member.displayName ?? member.username}
        uri={member.avatar ?? null}
        baseUrl={channelServerUrl ?? undefined}
        status={offline ? null : memberStatus}
        size={36}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, minWidth: 0 }}>
          <RoleNameText
            color={offline ? theme.colors.text3 : (member.roleColor ?? null)}
            styleType={offline ? null : (member.roleStyleType ?? null)}
            styleColors={offline ? null : (member.roleStyleColors ?? null)}
            numberOfLines={1}
            style={[styles.tabletMemberName, { flex: 1 }]}
          >
            {(member.isOwner || member.role === 'owner') ? `♛ ${member.displayName ?? member.username}` : (member.displayName ?? member.username)}
          </RoleNameText>
          {(member.isBot || member.accountType === 'bot') ? <BotBadge /> : null}
          {!offline && hasDesktop && (
            <Monitor
              size={10}
              color={
                memberStatus === 'away' ? theme.colors.warning
                : memberStatus === 'sleeping' ? '#eab308'
                : theme.colors.online
              }
            />
          )}
          {!offline && hasMobile && (
            <Smartphone
              size={10}
              color={
                memberStatus === 'away' ? theme.colors.warning
                : memberStatus === 'sleeping' ? '#eab308'
                : theme.colors.online
              }
            />
          )}
        </View>
        {!offline && subtitle ? (
          <View style={styles.tabletMemberSubtitleRow}>
            {isPlaying ? (
              gameIconUrl ? (
                <Image source={{ uri: gameIconUrl }} style={styles.tabletActivityIcon} resizeMode="cover" />
              ) : (
                <Text variant="caption">🎮</Text>
              )
            ) : isListening ? (
              listeningArtUrl ? (
                <Image source={{ uri: listeningArtUrl }} style={styles.tabletActivityIcon} resizeMode="cover" />
              ) : (
                <Text variant="caption">🎵</Text>
              )
            ) : null}
            <Text variant="caption" color={theme.colors.text3} numberOfLines={1} style={{ flex: 1 }}>
              {subtitle}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

function groupMembersByRole(members: MemberEntry[]): RoleGroup[] {
  const online = members.filter((user) => !user.offline);
  const offline = members.filter((user) => user.offline);
  const roleMap = new Map<string, RoleGroup>();
  for (const user of online) {
    if (user.roleHoist && user.roleName) {
      const key = user.roleName;
      if (!roleMap.has(key)) {
        roleMap.set(key, {
          key,
          label: user.roleName,
          roleIcon: user.roleIcon ?? null,
          offline: false,
          users: [],
        });
      }
      roleMap.get(key)!.users.push(user);
    } else {
      const key = '__members__';
      if (!roleMap.has(key)) {
        roleMap.set(key, { key, label: 'Members', roleIcon: null, offline: false, users: [] });
      }
      roleMap.get(key)!.users.push(user);
    }
  }
  const groups = Array.from(roleMap.values()).sort((a, b) => {
    const posA = a.users[0]?.rolePosition ?? 0;
    const posB = b.users[0]?.rolePosition ?? 0;
    return posB - posA;
  });
  if (offline.length > 0) {
    groups.push({ key: '__offline__', label: 'Offline', roleIcon: null, offline: true, users: offline });
  }
  return groups;
}

// ─── MessageRow ───────────────────────────────────────────────────────────────

interface MessageRowProps {
  message: Message;
  prevMessage: Message | null;
  selfUserId: string | undefined;
  avatarBaseUrl?: string | null;
  serverUrl?: string | null;
  expressionLookup?: ExpressionLookup | null;
  isPinned?: boolean;
  onAvatarPress: (userId: string) => void;
  onMessageLongPress: (message: Message, isSelf: boolean) => void;
  onToggleReaction?: (messageId: string, emoji: string) => void;
  onOpenReactions?: (message: Message, emoji?: string) => void;
}

// Matches compact emote tokens: :server:name:, :name:, :name:ownerId:, etc.
// (same renderer as the DM screen's reaction chips)
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

const GROUP_THRESHOLD_MS = 5 * 60 * 1000;
const PERF_ROW_WARN_MS = 8;

function toTimestampMs(value: number): number {
  return value < 10_000_000_000 ? value * 1000 : value;
}

const MessageRow = memo(function MessageRow({
  message,
  prevMessage,
  selfUserId,
  avatarBaseUrl,
  serverUrl,
  expressionLookup,
  isPinned,
  onAvatarPress,
  onMessageLongPress,
  onToggleReaction,
  onOpenReactions,
}: MessageRowProps) {
  const theme = useTheme();
  const { t } = useTranslation();

  // System messages render as a centered notice row (no avatar, no long-press)
  if (message.message_type === 'system') {
    return (
      <View style={styles.systemRow}>
        <Text style={styles.systemIcon}>🛠</Text>
        <Text variant="caption" color={theme.colors.text3} style={{ flex: 1 }}>
          {message.content}
        </Text>
      </View>
    );
  }

  const isGrouped =
    prevMessage !== null &&
    prevMessage.message_type !== 'system' &&
    prevMessage.user_id === message.user_id &&
    toTimestampMs(message.created_at) - toTimestampMs(prevMessage.created_at) < GROUP_THRESHOLD_MS;

  const isSelf = message.user_id === selfUserId;
  const timestamp = formatMessageTimestamp(toTimestampMs(message.created_at));

  const renderStartMs = globalThis.performance?.now?.() ?? Date.now();

  const rowNode = (
    <Pressable minHit={0} onLongPress={() => onMessageLongPress(message, isSelf)} style={[styles.msgRow, { paddingTop: isGrouped ? 2 : 12 }]}>
      {isGrouped ? (
        <View style={styles.avatarPlaceholder} />
      ) : (
        <Pressable haptic onPress={() => onAvatarPress(message.user_id)}>
          <Avatar
            username={message.username}
            uri={message.avatar}
            baseUrl={avatarBaseUrl}
            size={36}
          />
        </Pressable>
      )}
      <View style={{ flex: 1 }}>
        {message.interaction ? (
          <View style={styles.botInteraction}>
            <CornerUpRight size={12} color={theme.colors.text3} />
            <Text variant="caption" color={theme.colors.text3} numberOfLines={1} style={{ flex: 1 }}>
              <Text variant="caption" color={theme.colors.text2}>{message.interaction.invokerName}</Text>
              {' used '}
              <Text variant="caption" color="#818CF8" style={{ fontWeight: '600' }}>
                /{message.interaction.command}
              </Text>
            </Text>
          </View>
        ) : null}
        {message.reply_to && (
          <View style={[styles.replyQuote, { borderLeftColor: theme.colors.text3 }]}>
            <Text variant="caption" color={theme.colors.accent} style={{ fontWeight: '600' }}>
              {message.reply_to.username}
            </Text>
            <Text variant="caption" color={theme.colors.text3} numberOfLines={1} style={{ flex: 1 }}>
              {'  '}{message.reply_to.content}
            </Text>
          </View>
        )}
        {!isGrouped && (
          <View style={styles.msgMeta}>
            <Pressable haptic onPress={() => onAvatarPress(message.user_id)}>
              <RoleNameText
                color={message.role_color}
                styleType={message.role_style_type}
                styleColors={message.role_style_colors}
                numberOfLines={1}
              >
                {message.display_name ?? message.username}
              </RoleNameText>
            </Pressable>
            {message.is_bot ? <BotBadge /> : null}
            {message.ephemeral ? (
              <Text variant="caption" color="#FACC15" style={{ marginLeft: 4, fontWeight: '600' }}>Only you can see this</Text>
            ) : null}
            {isPinned ? null : null}
            <Text variant="caption" color={theme.colors.text3} style={{ marginLeft: 6 }}>
              {timestamp}
            </Text>
          </View>
        )}
        <TranslatableMarkdownText
          messageId={message.id}
          text={message.content}
          color={theme.colors.text}
          attachments={message.attachments}
          serverUrl={serverUrl}
          expressionLookup={expressionLookup}
          nsfwTags={message.nsfw_tags}
          voiceExpiresAt={message.voice_expires_at}
          allowEmbeds={message.embeds_enabled !== 0}
          linkPreviews
        />
        {message.edited ? (
          <Text variant="caption" color={theme.colors.text3}>{t('common.edited')}</Text>
        ) : null}
        {(message.reactions?.length ?? 0) > 0 && (
          <View style={styles.reactionsRow}>
            {message.reactions!.map((reaction) => {
              const reacted = reaction.reacted || Boolean(selfUserId && reaction.users?.includes(selfUserId));
              return (
                <Pressable
                  key={reaction.emoji}
                  disabled={!onToggleReaction}
                  onPress={() => onToggleReaction?.(message.id, reaction.emoji)}
                  onLongPress={() => onOpenReactions?.(message, reaction.emoji)}
                  style={[
                    styles.reactionChip,
                    reacted
                      ? { backgroundColor: theme.colors.accent + '33', borderColor: theme.colors.accent }
                      : { backgroundColor: theme.colors.bgElev2, borderColor: theme.colors.lineSoft },
                  ]}
                >
                  <ReactionEmoji emoji={reaction.emoji} serverUrl={serverUrl} />
                  <Text variant="caption" style={{ marginLeft: 4, color: reacted ? theme.colors.accent : theme.colors.text2 }}>
                    {reaction.count}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}
      </View>
    </Pressable>
  );

  const renderEndMs = globalThis.performance?.now?.() ?? Date.now();
  const renderCostMs = renderEndMs - renderStartMs;
  if (renderCostMs >= PERF_ROW_WARN_MS) {
    debugLog('ChannelScreen', 'perf:message-row-expensive', {
      messageId: message.id,
      channelId: message.channel_id,
      costMs: Math.round(renderCostMs * 100) / 100,
      contentLength: message.content?.length ?? 0,
      attachmentCount: message.attachments?.length ?? 0,
      hasReply: Boolean(message.reply_to),
      messageType: message.message_type ?? 'basic',
      hasRoleStyle: Boolean(message.role_style_type),
      edited: Boolean(message.edited),
      grouped: isGrouped,
    });
  }

  return rowNode;
}, (prev, next) =>
  prev.message === next.message &&
  prev.prevMessage === next.prevMessage &&
  prev.isPinned === next.isPinned &&
  prev.expressionLookup === next.expressionLookup &&
  prev.selfUserId === next.selfUserId &&
  prev.avatarBaseUrl === next.avatarBaseUrl &&
  prev.serverUrl === next.serverUrl &&
  prev.onAvatarPress === next.onAvatarPress &&
  prev.onMessageLongPress === next.onMessageLongPress &&
  prev.onToggleReaction === next.onToggleReaction &&
  prev.onOpenReactions === next.onOpenReactions,
);

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function ChannelScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const { isTablet } = useDeviceLayout();
  const insets = useSafeAreaInsets();
  // Tablet side panes run under the bottom dock; keep their last rows scrollable above it.
  const paneListStyle = { paddingBottom: 16 + DOCK_HEIGHT + dockBottomInset(insets.bottom) };
  const router = useRouter();
  const { serverId: rawServerId, channelId: rawChannelId } = useLocalSearchParams<{
    serverId: string;
    channelId: string;
  }>();
  const serverId = Array.isArray(rawServerId) ? rawServerId[0] : rawServerId;
  const channelId = Array.isArray(rawChannelId) ? rawChannelId[0] : rawChannelId;

  const servers = useServerStore((s) => s.servers);
  const connectedChannels = useConnectedChannelIds(serverId);
  const openTheater = useOpenTheater();
  const channelsByServer = useServerStore((s) => s.channels);
  const categoriesByServer = useServerStore((s) => s.categories);
  const presenceOnlineUsers = usePresenceStore((s) => s.onlineUsers);
  const presenceAllMembers = usePresenceStore((s) => s.allMembers);
  const voiceRoomUsers = useVoiceStore((s) => s.voiceRoomUsers);
  const voiceRoomStartedAt = useVoiceStore((s) => s.voiceRoomStartedAt);
  const theaterRoomUsers = useTheaterStore((s) => s.roomUsersByChannel);
  const theaterRoomStartedAt = useTheaterStore((s) => s.roomStartedAtByChannel);
  const theaterChannelId = useTheaterStore((s) => s.channelId);
  const theaterHostUserId = useTheaterStore((s) => s.hostUserId);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const setActiveServer = useServerStore((s) => s.setActiveServer);
  const server = useMemo(
    () => (serverId ? servers.find((entry) => entry.id === serverId) : undefined),
    [servers, serverId],
  );
  const channels = useMemo(
    () => (serverId ? (channelsByServer[serverId] ?? EMPTY_CHANNELS) : EMPTY_CHANNELS),
    [channelsByServer, serverId],
  );
  const categories = useMemo(
    () => (serverId ? (categoriesByServer[serverId] ?? EMPTY_CATEGORIES) : EMPTY_CATEGORIES),
    [categoriesByServer, serverId],
  );
  const channel = channels.find((c) => c.id === channelId);
  const onlineMembers = serverId ? presenceOnlineUsers : EMPTY_MEMBERS;

  const messages = useMessageStore((s) => s.byChannel[channelId] ?? EMPTY_MESSAGES);
  const earliestId = useMessageStore((s) => s.earliestId[channelId] ?? null);
  const hasMore = useMessageStore((s) => s.hasMore[channelId] ?? true);
  const loading = useMessageStore((s) => s.loading[channelId] ?? false);
  const loadingOlder = useMessageStore((s) => s.loadingOlder[channelId] ?? false);
  const typingUsers = useMessageStore((s) => s.typingByChannel[channelId] ?? EMPTY_TYPING_USERS);
  const fetchMessages = useMessageStore((s) => s.fetchMessages);
  const sendMessage = useMessageStore((s) => s.sendMessage);
  const requestEdit = useMessageStore((s) => s.requestEdit);
  const requestDelete = useMessageStore((s) => s.requestDelete);

  const draft = useChannelStore((s) => s.drafts[channelId]?.text ?? '');
  const setDraft = useChannelStore((s) => s.setDraft);
  const clearDraft = useChannelStore((s) => s.clearDraft);
  const setLastChannelForServer = useChannelStore((s) => s.setLastChannelForServer);
  const setActiveChannelInStore = useChannelStore((s) => s.setActiveChannel);
  const resetChannelCounts = useChannelStore((s) => s.resetCounts);
  const pinnedMessages = useChannelStore((s) => s.pinnedByChannel[channelId] ?? EMPTY_MESSAGES);
  const fetchPins = useChannelStore((s) => s.fetchPins);
  const pinMessage = useChannelStore((s) => s.pinMessage);
  const unpinMessage = useChannelStore((s) => s.unpinMessage);

  const selfUser = useAuthStore((s) => s.user);
  const isRealmOwner = selfUser?.isOwner || selfUser?.role === 'owner';
  const canReact = Boolean(isRealmOwner || hasChannelPermission(selfUser?.permissions, channel?.effective_permissions, PERMISSIONS.ADD_REACTIONS));
  const canUseExternalEmotes = Boolean(isRealmOwner || hasChannelPermission(selfUser?.permissions, channel?.effective_permissions, PERMISSIONS.USE_EXTERNAL_EMOTES));
  const canUseExternalStickers = Boolean(isRealmOwner || hasChannelPermission(selfUser?.permissions, channel?.effective_permissions, PERMISSIONS.USE_EXTERNAL_STICKERS));
  const serverInfo = useAuthStore((s) => s.serverInfo);
  const authServerUrl = useAuthStore((s) => s.serverUrl);
  const channelServerUrl =
    server?.url ??
    (serverId && getOrigin(serverId)
      ? serverId
      : selfUser?.accountType === 'local'
        ? authServerUrl
        : null);
  const expressionLookup = useExpressionLookup(channelServerUrl);
  const setChannelsSheetOpen = useUIStore((s) => s.setChannelsSheetOpen);
  const setMembersSheetOpen = useUIStore((s) => s.setMembersSheetOpen);
  const setSearchOpen = useUIStore((s) => s.setSearchOpen);
  const setActiveChannelId = useUIStore((s) => s.setActiveChannelId);
  const serverDrawerOpen = useUIStore((s) => s.serverDrawerOpen);
  const setServerDrawerOpen = useUIStore((s) => s.setServerDrawerOpen);

  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const typingActiveRef = useRef(false);
  const typingSentAtRef = useRef(0);
  const [activeMessage, setActiveMessage] = useState<Message | null>(null);
  const [replyToMessage, setReplyToMessage] = useState<Message | null>(null);
  const [reactionsSheetState, setReactionsSheetState] = useState<{ open: boolean; reactions: ReadonlyArray<Reaction> | null; initialEmoji: string | null }>({ open: false, reactions: null, initialEmoji: null });
  const [pinsOpen, setPinsOpen] = useState(false);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [threads, setThreads] = useState<Array<{ id: string; name: string; created_at: number }>>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [isScrollingOld, setIsScrollingOld] = useState(false);
  const [createThreadOpen, setCreateThreadOpen] = useState(false);
  const [createThreadName, setCreateThreadName] = useState('');
  const [createThreadLoading, setCreateThreadLoading] = useState(false);
  const [tabletMembersVisible, setTabletMembersVisible] = useState(true);
  const [tabletRightPaneMode, setTabletRightPaneMode] = useState<'members' | 'threads' | 'pins'>('members');
  const [secureModeLockedFallback, setSecureModeLockedFallback] = useState(false);
  const [roomNowMs, setRoomNowMs] = useState(() => Date.now());
  const createThreadMessageRef = useRef<Message | null>(null);
  const flatListRef = useRef<FlatList<Message>>(null);
  const lastSnapshotLogAtRef = useRef(0);
  const lastScrollOldRef = useRef(false);
  const translateY = useSharedValue(0);
  const kbStyle = useAnimatedStyle(() => ({
    // iOS phones only. Android lifts just the composer (edge-to-edge keeps the
    // window full height); translating there moved the header off-screen.
    transform: [{ translateY: Platform.OS === 'ios' && !isTablet ? translateY.value : 0 }],
  }));
  const leftPaneProgress = useSharedValue(serverDrawerOpen ? 1 : 0);
  const channelsPaneStyle = useAnimatedStyle(() => ({
    opacity: 1 - leftPaneProgress.value,
    transform: [{ translateX: -16 * leftPaneProgress.value }],
  }));
  const serversPaneStyle = useAnimatedStyle(() => ({
    opacity: leftPaneProgress.value,
    transform: [{ translateX: 16 * (1 - leftPaneProgress.value) }],
  }));

  const fetchChannelMessages = useCallback((before?: string) => {
    if (selfUser?.accountType === 'central') {
      if (!server?.url || !server.token) return;
      void fetchMessages(channelId, before, { serverUrl: server.url, token: server.token });
      return;
    }
    void fetchMessages(channelId, before);
  }, [channelId, fetchMessages, selfUser?.accountType, server?.token, server?.url]);

  // A non-empty cache may contain only live socket messages, not history.
  // Fetch the latest page on entry and again when realm credentials arrive.
  useEffect(() => {
    fetchChannelMessages();
  }, [fetchChannelMessages]);

  // iOS: phones translate the whole screen, tablets use KeyboardAvoidingView,
  // so the composer only needs its gap. Android lifts the composer itself.
  const composerBottom = useComposerKeyboardInset({
    keyboardGap: 8,
    enabled: Platform.OS === 'android' || !isTablet,
  });
  useEffect(() => {
    if (Platform.OS !== 'ios' || isTablet) {
      translateY.value = 0;
      return;
    }
    const show = Keyboard.addListener('keyboardWillShow', (e) => {
      translateY.value = withTiming(-e.endCoordinates.height, { duration: e.duration || 250 });
    });
    const hide = Keyboard.addListener('keyboardWillHide', (e) => {
      translateY.value = withTiming(0, { duration: e.duration || 250 });
    });
    return () => { show.remove(); hide.remove(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTablet]);

  useEffect(() => {
    if (!isTablet) return;
    setTabletMembersVisible(true);
    setTabletRightPaneMode('members');
  }, [isTablet, channelId, serverId]);

  useEffect(() => {
    leftPaneProgress.value = withTiming(serverDrawerOpen ? 1 : 0, { duration: 240 });
  }, [leftPaneProgress, serverDrawerOpen]);

  useEffect(() => {
    const hasVoiceRooms = Object.keys(voiceRoomStartedAt).length > 0;
    const hasTheaterRooms = Object.values(theaterRoomStartedAt).some((startedAt) => startedAt != null);
    if (!hasVoiceRooms && !hasTheaterRooms) return;
    const timer = globalThis.setInterval(() => setRoomNowMs(Date.now()), 1000);
    return () => globalThis.clearInterval(timer);
  }, [voiceRoomStartedAt, theaterRoomStartedAt]);

  // Join channel + load initial messages on mount
  useEffect(() => {
    debugLog('ChannelScreen', 'mount-join', {
      serverId,
      channelId,
      messagesCount: messages.length,
    });
    if (serverId) void setActiveServer(serverId);
    if (serverId && channelId) setLastChannelForServer(serverId, channelId);
    setActiveChannelId(channelId);
    setActiveChannelInStore(channelId);
    resetChannelCounts(channelId);
    if (selfUser?.accountType === 'central' && channelServerUrl) {
      void createAuthenticatedApi().post('/api/notifications/read-stream', {
        streamKind: 'server',
        streamId: channelServerUrl,
        subsourceId: channelId,
      }).catch(() => {});
    }
    getSocket()?.emit('channel:join', channelId);
    // Read position lives on the realm so highlights survive restarts and match other devices.
    const readAuth = channelServerUrl ? { serverUrl: channelServerUrl, token: server?.token } : null;
    if (readAuth) markRealmChannelRead(readAuth, channelId);
    return () => {
      debugLog('ChannelScreen', 'unmount-leave', { channelId });
      if (readAuth) markRealmChannelRead(readAuth, channelId);
      clearTimeout(typingTimerRef.current);
      typingActiveRef.current = false;
      setActiveChannelInStore(null);
      clearImageMemoryCache();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, channelId, setActiveServer, setLastChannelForServer, setActiveChannelId, setActiveChannelInStore, resetChannelCounts, fetchChannelMessages]);

  useFocusEffect(
    useCallback(() => {
      return () => {
        clearImageMemoryCache();
      };
    }, []),
  );

  const handleLoadMore = useCallback(() => {
    debugLog('ChannelScreen', 'load-more:attempt', {
      channelId,
      loading,
      hasMore,
      earliestId,
    });
    if (!loading && hasMore && earliestId) {
      debugLog('ChannelScreen', 'load-more:fetch', { channelId, earliestId });
      fetchChannelMessages(earliestId);
    }
  }, [loading, hasMore, earliestId, channelId, fetchChannelMessages]);

  const handleChangeText = (text: string) => {
    debugLog('ChannelScreen', 'composer:change', { channelId, length: text.length });
    setDraft(channelId, text);
    const socket = getSocket();
    if (socket) {
      clearTimeout(typingTimerRef.current);
      if (!text.trim()) {
        if (typingActiveRef.current) socket.emit('typing:stop', { channelId });
        typingActiveRef.current = false;
        return;
      }
      // Re-announce every 2.5s while typing continues; desktop expires silent typers.
      if (!typingActiveRef.current || Date.now() - typingSentAtRef.current > 2500) {
        socket.emit('typing:start', { channelId });
        typingActiveRef.current = true;
        typingSentAtRef.current = Date.now();
      }
      typingTimerRef.current = setTimeout(() => {
        socket.emit('typing:stop', { channelId });
        typingActiveRef.current = false;
      }, 3000);
    }
  };

  const handleSend = (
    serializedText?: string,
    attachments?: { url: string; mime: string; size: number; thumbnailUrl?: string | null; isNsfw: boolean }[],
    _localAttachments?: unknown,
    options?: ComposerSendOptions,
  ) => {
    const text = (serializedText ?? draft).trim();
    debugTap('ChannelScreen', 'send-message', {
      channelId,
      textLength: text.length,
      hasAttachment: Boolean(attachments?.length),
      hasReply: Boolean(replyToMessage),
    });
    if (!text && !attachments?.length) return;
    const socket = getSocket();
    if (replyToMessage) {
      socket?.emit('message:send', {
        channelId,
        content: text,
        attachments: attachments?.map((attachment) => ({
          url: attachment.url,
          mime: attachment.mime,
          size: attachment.size,
          ...(attachment.thumbnailUrl ? { thumbnailUrl: attachment.thumbnailUrl } : {}),
        })) ?? [],
        nsfwTags: attachments?.some((attachment) => attachment.isNsfw) ? ['nsfw'] : [],
        replyToId: replyToMessage.id,
        voice_expires_at: options?.voiceExpiresAt ?? null,
      });
    } else {
      sendMessage(channelId, text, attachments, options?.voiceExpiresAt);
    }
    setReplyToMessage(null);
    clearDraft(channelId);
    socket?.emit('typing:stop', { channelId });
    clearTimeout(typingTimerRef.current);
    typingActiveRef.current = false;
  };

  const handleAvatarPress = useCallback((userId: string) => {
    debugTap('ChannelScreen', 'avatar-press', { userId });
    router.push({ pathname: '/profile/[userId]', params: { userId, context: 'server' } });
  }, [router]);

  const handleMessageLongPress = useCallback((msg: Message) => {
    setActiveMessage((current) => current?.id === msg.id ? current : msg);
  }, []);

  const handleToggleReaction = useCallback((messageId: string, emoji: string) => {
    if (!canReact) return;
    const socket = getSocket();
    if (!socket?.connected) {
      Alert.alert(t('common.error'), t('chat.reactionFailed'));
      return;
    }
    socket.emit('message:react', { messageId, channelId, emoji }, (reply: { status?: string; error?: string }) => {
      if (reply?.status !== 'ok') Alert.alert(t('common.error'), reply?.error || t('chat.reactionFailed'));
    });
  }, [canReact, channelId, t]);

  const handleScroll = useCallback((event: { nativeEvent: { contentOffset: { y: number } } }) => {
    const offsetY = event.nativeEvent.contentOffset.y;
    const nextIsOld = offsetY > 9000;
    if (nextIsOld !== lastScrollOldRef.current) {
      lastScrollOldRef.current = nextIsOld;
      debugLog('ChannelScreen', 'scroll:old-state-changed', { offsetY, isOld: nextIsOld });
    }
    setIsScrollingOld(nextIsOld);
  }, []);

  const handleWarpToCurrent = useCallback(() => {
    debugTap('ChannelScreen', 'warp-to-current', { channelId });
    flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    setIsScrollingOld(false);
  }, [channelId]);

  // FlatList is inverted; reverse array so newest renders at bottom
  const displayMessages = useMemo(() => [...messages].reverse(), [messages]);

  const typingText =
    typingUsers.length === 0
      ? null
      : typingUsers.length === 1
        ? `${typingUsers[0]} is typing…`
        : typingUsers.length >= 4
          ? 'Multiple users are typing...'
          : `${typingUsers.slice(0, 2).join(', ')} are typing…`;
  const singleTypingUser = useMemo(() => {
    if (typingUsers.length !== 1) return null;
    const typingName = typingUsers[0];
    return onlineMembers.find((m) =>
      m.username === typingName || m.displayName === typingName,
    ) ?? null;
  }, [typingUsers, onlineMembers]);

  const pinnedMessageIds = useMemo(() => new Set(pinnedMessages.map((p) => p.id)), [pinnedMessages]);
  const selfUserId = selfUser?.id;

  const renderItem = useCallback(
    ({ item, index }: { item: Message; index: number }) => {
      const prev = displayMessages[index + 1] ?? null;
      return (
        <SwipeableMessageRow
          onReply={() => setReplyToMessage(item)}
          onSwipeLeft={() => setChannelsSheetOpen(true)}
        >
          <MessageRow
            message={item}
            prevMessage={prev}
            selfUserId={selfUserId}
            avatarBaseUrl={channelServerUrl}
            serverUrl={channelServerUrl}
            expressionLookup={expressionLookup}
            isPinned={pinnedMessageIds.has(item.id)}
            onAvatarPress={handleAvatarPress}
            onMessageLongPress={handleMessageLongPress}
            onToggleReaction={canReact ? handleToggleReaction : undefined}
            onOpenReactions={(msg, emoji) => setReactionsSheetState({ open: true, reactions: msg.reactions ?? null, initialEmoji: emoji ?? null })}
          />
        </SwipeableMessageRow>
      );
    },
    [displayMessages, selfUserId, channelServerUrl, expressionLookup, pinnedMessageIds, handleAvatarPress, handleMessageLongPress, handleToggleReaction, canReact, setChannelsSheetOpen],
  );

  const orderedChannels = useMemo(() => [...channels].sort((a, b) => a.position - b.position), [channels]);
  const groupedChannels = useMemo(() => {
    const groups: Array<{ key: string; label: string; channels: Channel[] }> = [];
    const uncategorized = orderedChannels.filter((c) => !c.category_id);
    if (uncategorized.length > 0) {
      groups.push({ key: '__uncat__', label: 'Channels', channels: uncategorized });
    }
    const orderedCategories = categories.slice().sort((a, b) => a.position - b.position);
    for (const cat of orderedCategories) {
      const catChannels = orderedChannels.filter((c) => c.category_id === cat.id);
      if (catChannels.length > 0) groups.push({ key: cat.id, label: cat.name, channels: catChannels });
    }
    debugLog('ChannelScreen', 'compute:groupedChannels', {
      serverId,
      groups: groups.length,
      channels: orderedChannels.length,
      categories: categories.length,
    });
    return groups;
  }, [orderedChannels, categories, serverId]);

  const showEncryptedBadge =
    Boolean(serverInfo?.secureMode?.enabled && serverInfo?.secureMode?.locked) ||
    secureModeLockedFallback;
  const serverBannerUrl = useMemo(() => {
    if (!server?.bannerUrl) return null;
    if (/^https?:\/\//i.test(server.bannerUrl)) return server.bannerUrl;
    const base = server.url?.replace(/\/$/, '');
    return base ? `${base}${server.bannerUrl}` : null;
  }, [server?.bannerUrl, server?.url]);
  const serverUrlForRoleIcons = useMemo(() => {
    const base = (server?.url ?? channelServerUrl ?? null);
    return base ? base.replace(/\/$/, '') : null;
  }, [server?.url, channelServerUrl]);
  const visibleMemberIds = useVisibleChannelMemberIds(channelId, presenceAllMembers.length);
  const roleGroups = useMemo(
    () => groupMembersByRole(
      serverId
        ? filterMembersByVisibleIds(buildMemberList(presenceAllMembers, presenceOnlineUsers), visibleMemberIds)
        : [],
    ),
    [presenceAllMembers, presenceOnlineUsers, serverId, visibleMemberIds],
  );

  useEffect(() => {
    const now = Date.now();
    if (now - lastSnapshotLogAtRef.current < 1000) return;
    lastSnapshotLogAtRef.current = now;
    debugLog('ChannelScreen', 'selector-snapshot', {
      serverId,
      channelId,
      activeServerId,
      channelFound: Boolean(channel),
      channelsCount: channels.length,
      categoriesCount: categories.length,
      messagesCount: messages.length,
      loading,
      loadingOlder,
      hasMore,
      earliestId,
    });
  }, [
    serverId,
    channelId,
    activeServerId,
    channel,
    channels.length,
    categories.length,
    messages.length,
    loading,
    loadingOlder,
    hasMore,
    earliestId,
  ]);

  const openThreadsPanel = useCallback(() => {
    debugTap('ChannelScreen', 'open-threads', { channelId, isTablet });
    setThreadsLoading(true);
    if (isTablet) {
      setTabletRightPaneMode('threads');
      setTabletMembersVisible(true);
    } else {
      setThreadsOpen(true);
    }
    void import('@/lib/api').then(({ createApi }) =>
      createApi()
        .get<Array<{ id: string; name: string; created_at: number }>>('/api/threads', { params: { channelId } })
        .then((res) => setThreads(res.data ?? []))
        .catch(() => {})
        .finally(() => setThreadsLoading(false)),
    );
  }, [channelId, isTablet]);

  const openPinsPanel = useCallback(() => {
    debugTap('ChannelScreen', 'open-pins', { channelId, isTablet });
    void fetchPins(channelId);
    if (isTablet) {
      setTabletRightPaneMode('pins');
      setTabletMembersVisible(true);
    } else {
      setPinsOpen(true);
    }
  }, [channelId, fetchPins, isTablet]);

  const handleTabletServerPress = useCallback((srv: typeof servers[number]) => {
    debugTap('ChannelScreen', 'tablet-server-press', {
      fromServerId: activeServerId,
      nextServerId: srv.id,
    });
    void (async () => {
      let srvChannels = useServerStore.getState().channels[srv.id] ?? [];
      if (srvChannels.length === 0) {
        try {
          const api = createApi(srv.url, srv.token || undefined);
          const [channelsRes, categoriesRes] = await Promise.all([
            api.get<Channel[]>('/api/channels'),
            api.get<Category[]>('/api/categories'),
          ]);
          srvChannels = channelsRes.data ?? [];
          useServerStore.getState().setChannels(srv.id, srvChannels);
          useServerStore.getState().setCategories(srv.id, categoriesRes.data ?? []);
        } catch {
          srvChannels = [];
        }
      }

      await setActiveServer(srv.id);
      const rememberedChannelId = useChannelStore.getState().lastChannelByServer[srv.id] ?? null;
      const firstChannelId =
        srvChannels
          .slice()
          .sort((a, b) => a.position - b.position)
          .find((c) => c.type !== 'voice')?.id ??
        srvChannels[0]?.id ??
        null;
      const targetChannelId = rememberedChannelId || firstChannelId;
      if (targetChannelId) {
        router.replace({
          pathname: '/server/[serverId]/channel/[channelId]',
          params: { serverId: srv.id, channelId: targetChannelId },
        });
      }
      setServerDrawerOpen(false);
    })();
  }, [activeServerId, router, setActiveServer, setServerDrawerOpen]);

  useEffect(() => {
    let cancelled = false;
    const base = channelServerUrl?.replace(/\/+$/, '');
    if (!base) {
      setSecureModeLockedFallback(false);
      return () => {
        cancelled = true;
      };
    }
    void axios
      .get<{ secureMode?: { enabled?: boolean; locked?: boolean } }>(`${base}/api/server`, {
        headers: { 'X-CatRealm-Client': 'mobile' },
        timeout: 10000,
      })
      .then((res) => {
        if (cancelled) return;
        const mode = res.data?.secureMode;
        setSecureModeLockedFallback(Boolean(mode?.enabled && mode?.locked));
      })
      .catch(() => {
        if (!cancelled) setSecureModeLockedFallback(false);
      });
    return () => {
      cancelled = true;
    };
  }, [channelServerUrl]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bgApp, paddingTop: insets.top }}>
      {!isTablet && (
        <View
          style={[
            styles.header,
            {
              borderBottomColor: theme.colors.lineSoft,
              paddingHorizontal: theme.spacing.sm,
              paddingVertical: theme.spacing.sm,
              gap: theme.spacing.xs,
            },
          ]}
        >
          <Pressable
            haptic
            onPress={() => setChannelsSheetOpen(true)}
            style={styles.channelTitle}
          >
            <View
              style={{
                width: 32,
                height: 32,
                borderRadius: 9,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: theme.colors.bgElev2,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.colors.lineSoft,
                marginRight: 2,
              }}
            >
              <Menu size={17} color={theme.colors.accentText} />
            </View>
            <Hash size={18} color={theme.colors.text3} />
            <Text variant="subtitle" style={{ flex: 1 }} numberOfLines={1}>
              {channel?.name ?? channelId}
            </Text>
            {showEncryptedBadge && (
              <View style={[styles.encryptedBadge, { backgroundColor: theme.colors.accent + '22', borderColor: theme.colors.accent + '66' }]}>
                <Text variant="caption" style={{ color: theme.colors.accent, fontWeight: '700' }}>
                  🔒 {t('common.encrypted')}
                </Text>
              </View>
            )}
          </Pressable>
          <View style={styles.headerActions}>
            <IconBtn
              icon={Search}
              accessibilityLabel={t('server.searchAccessibility')}
              onPress={() => setSearchOpen(true)}
            />
            <IconBtn
              icon={MessageSquareText}
              accessibilityLabel={t('server.threadsAccessibility')}
              onPress={openThreadsPanel}
            />
            <IconBtn
              icon={Pin}
              accessibilityLabel={t('server.pinnedAccessibility')}
              onPress={openPinsPanel}
            />
            <IconBtn
              icon={Users}
              accessibilityLabel={t('server.membersAccessibility')}
              onPress={() => setMembersSheetOpen(true)}
            />
          </View>
        </View>
      )}

      <View style={{ flex: 1, overflow: 'hidden', flexDirection: isTablet ? 'row' : 'column' }}>
      {isTablet && (
        <View
          style={[
            styles.tabletLeftPane,
            {
              backgroundColor: theme.colors.bgSidebar,
              borderRightColor: theme.colors.lineSoft,
            },
          ]}
        >
          <View style={{ flex: 1, flexDirection: 'row', minHeight: 0 }}>
            <DrawerLeftRail onClose={() => setServerDrawerOpen(false)} navigateOnSelect embedded />
            <View style={styles.tabletPaneStack}>
            <Animated.View style={[styles.tabletPaneLayer, channelsPaneStyle]} pointerEvents={serverDrawerOpen ? 'none' : 'auto'}>
              <Pressable
                haptic
                onPress={() => setServerDrawerOpen(true)}
                style={[
                  styles.tabletServerHeader,
                  { borderBottomColor: theme.colors.lineSoft, backgroundColor: theme.colors.bgElev1 },
                ]}
              >
                {serverBannerUrl ? (
                  <Image source={{ uri: serverBannerUrl }} style={styles.tabletServerBanner} resizeMode="cover" />
                ) : null}
                <View style={styles.tabletServerBannerScrim} />
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', zIndex: 1 }}>
                  <Text variant="subtitle" style={[styles.tabletServerTitle, { flex: 1 }]} numberOfLines={1}>
                    {server?.name ?? t('servers.defaultServerName')}
                  </Text>
                  <ChevronDown size={16} color="#ffffff" />
                </View>
              </Pressable>
              <Text variant="subtitle" style={styles.tabletPaneTitle}>{t('chat.channelsTab')}</Text>
              <FlatList
                data={groupedChannels}
                keyExtractor={(g) => g.key}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={paneListStyle}
                renderItem={({ item: group }) => (
                  <View style={{ marginBottom: 10 }}>
                    <Text
                      variant="caption"
                      color={theme.colors.text3}
                      style={{ textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 4 }}
                    >
                      {group.label}
                    </Text>
                    {group.channels.map((ch) => {
                      const active = ch.id === channelId;
                      // Still in this call/theater while viewing another channel.
                      const connectedElsewhere = !active
                        && (ch.id === connectedChannels.voiceChannelId || ch.id === connectedChannels.theaterChannelId);
                      const voiceMembers = ch.type === 'voice'
                        ? (voiceRoomUsers[ch.id] ?? EMPTY_VOICE_PARTICIPANTS)
                        : EMPTY_VOICE_PARTICIPANTS;
                      const theaterMembers = ch.type === 'theater'
                        ? (theaterRoomUsers[ch.id] ?? EMPTY_THEATER_PARTICIPANTS)
                        : EMPTY_THEATER_PARTICIPANTS;
                      const voiceStartedAt = ch.type === 'voice' ? voiceRoomStartedAt[ch.id] : null;
                      const theaterStartedAt = ch.type === 'theater' ? theaterRoomStartedAt[ch.id] : null;
                      const elapsedStartedAt = typeof voiceStartedAt === 'number'
                        ? voiceStartedAt
                        : (typeof theaterStartedAt === 'number' ? theaterStartedAt : null);
                      return (
                        <View key={ch.id}>
                          <Pressable
                            haptic
                            onPress={() => {
                              debugTap('ChannelScreen', 'tablet-channel-press', {
                                fromChannelId: channelId,
                                nextChannelId: ch.id,
                                type: ch.type,
                                serverId,
                              });
                              if (ch.type === 'voice') {
                                router.replace({
                                  pathname: '/server/[serverId]/channel/[channelId]',
                                  params: { serverId, channelId: ch.id },
                                });
                              } else if (ch.type === 'theater') {
                                openTheater(serverId, ch.id, ch.name);
                              } else {
                                router.replace({
                                  pathname: '/server/[serverId]/channel/[channelId]',
                                  params: { serverId, channelId: ch.id },
                                });
                              }
                              setServerDrawerOpen(false);
                            }}
                            style={[
                              styles.tabletChannelRow,
                              {
                                backgroundColor: active ? theme.colors.accent + '22' : 'transparent',
                                borderRadius: theme.radius.md,
                              },
                            ]}
                          >
                            {connectedElsewhere && <ConnectedChannelPulse radius={theme.radius.md} />}
                            <ChannelIcon type={ch.type} size={14} color={active ? theme.colors.accent : connectedElsewhere ? theme.colors.statusColor.online : theme.colors.text3} />
                            <Text
                              variant="bodySmall"
                              numberOfLines={1}
                              style={{ flex: 1, color: active ? theme.colors.accent : connectedElsewhere ? theme.colors.statusColor.online : theme.colors.text2 }}
                            >
                              {ch.name}
                            </Text>
                            {elapsedStartedAt != null ? (
                              <Text variant="caption" style={[styles.tabletRoomElapsed, { color: theme.colors.accent }]}>
                                {formatRoomElapsed(Math.max(0, roomNowMs - elapsedStartedAt))}
                              </Text>
                            ) : null}
                          </Pressable>
                          {voiceMembers.map((member) => (
                            <View key={`${ch.id}:${member.userId}`} style={styles.tabletVoiceMemberRow}>
                              <Avatar
                                username={member.username}
                                uri={member.avatar ?? null}
                                baseUrl={channelServerUrl ?? undefined}
                                size={20}
                                showStatus={false}
                              />
                              <Text
                                variant="caption"
                                numberOfLines={1}
                                style={[styles.tabletVoiceMemberName, { color: theme.colors.text3 }]}
                              >
                                {member.username}
                              </Text>
                              {member.muted ? <MicOff size={13} color={theme.colors.danger} /> : null}
                              {member.deafened ? <HeadphoneOff size={13} color={theme.colors.warning} /> : null}
                            </View>
                          ))}
                          {theaterMembers.map((member) => (
                            <View key={`theater:${ch.id}:${member.userId}`} style={styles.tabletVoiceMemberRow}>
                              <Avatar
                                username={member.username}
                                uri={member.avatar ?? null}
                                baseUrl={member.accountType === 'local' ? (channelServerUrl ?? undefined) : undefined}
                                size={20}
                                showStatus={false}
                              />
                              <Text
                                variant="caption"
                                numberOfLines={1}
                                style={[styles.tabletVoiceMemberName, { color: theme.colors.text3 }]}
                              >
                                {theaterChannelId === ch.id && theaterHostUserId === member.userId ? '🎤 ' : ''}{member.username}
                              </Text>
                              {!member.micEnabled ? <MicOff size={13} color={theme.colors.danger} /> : null}
                              {member.deafened ? <HeadphoneOff size={13} color={theme.colors.warning} /> : null}
                            </View>
                          ))}
                        </View>
                      );
                    })}
                  </View>
                )}
              />
            </Animated.View>
            <Animated.View style={[styles.tabletPaneLayer, serversPaneStyle]} pointerEvents={serverDrawerOpen ? 'auto' : 'none'}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingRight: 8 }}>
                <Text variant="subtitle" style={styles.tabletPaneTitle}>{t('chat.serversTab')}</Text>
                <IconBtn icon={X} onPress={() => setServerDrawerOpen(false)} accessibilityLabel={t('call.closeServers')} />
              </View>
              {/* Same list as the phone drawer: folders, invites, realm re-approval, Add/Discover. */}
              <ServerListPanel onOpenServer={handleTabletServerPress} onLeave={() => setServerDrawerOpen(false)} />
            </Animated.View>
            </View>
          </View>
          <DrawerHubFooter onClose={() => setServerDrawerOpen(false)} />
        </View>
      )}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
        enabled={isTablet}
      >
      <Animated.View style={[{ flex: 1 }, kbStyle]}>
        {isTablet && channel?.type === 'voice' ? (
          <VoiceChannelContent
            channelId={channelId}
            serverId={serverId}
            bottomInset={insets.bottom}
            showHeader={false}
          />
        ) : (
          <>
            {isTablet && (
              <View
                style={[
                  styles.header,
                  {
                    borderBottomColor: theme.colors.lineSoft,
                    paddingHorizontal: theme.spacing.sm,
                    paddingVertical: theme.spacing.sm,
                    gap: theme.spacing.xs,
                    minHeight: 64,
                  },
                ]}
              >
                <View style={styles.headerSideSpacer} />
                <View style={styles.headerCenterTitle} pointerEvents="none">
                  <Hash size={18} color={theme.colors.text3} />
                  <Text variant="subtitle" numberOfLines={1} style={{ textAlign: 'center' }}>
                    {channel?.name ?? channelId}
                  </Text>
                  {showEncryptedBadge && (
                    <View style={[styles.encryptedBadge, { backgroundColor: theme.colors.accent + '22', borderColor: theme.colors.accent + '66' }]}>
                      <Text variant="caption" style={{ color: theme.colors.accent, fontWeight: '700' }}>
                        🔒 {t('common.encrypted')}
                      </Text>
                    </View>
                  )}
                </View>
                <View style={styles.headerActions}>
                  <IconBtn
                    icon={Search}
                    accessibilityLabel={t('server.searchAccessibility')}
                    onPress={() => setSearchOpen(true)}
                  />
                  <IconBtn
                    icon={MessageSquareText}
                    accessibilityLabel={t('server.threadsAccessibility')}
                    onPress={openThreadsPanel}
                  />
                  <IconBtn
                    icon={Pin}
                    accessibilityLabel={t('server.pinnedAccessibility')}
                    onPress={openPinsPanel}
                  />
                  <IconBtn
                    icon={Users}
                    accessibilityLabel={tabletMembersVisible && tabletRightPaneMode === 'members' ? t('server.hideRightPanel') : t('server.showMembers')}
                    onPress={() => {
                      if (tabletMembersVisible && tabletRightPaneMode === 'members') {
                        setTabletMembersVisible(false);
                        return;
                      }
                      setTabletRightPaneMode('members');
                      setTabletMembersVisible(true);
                    }}
                  />
                </View>
              </View>
            )}
            {channel?.type === 'rules' ? (
              <ServerRulesView
                serverUrl={channelServerUrl}
                serverToken={server?.token}
                serverName={server?.name ?? ''}
                serverIcon={server?.iconUrl}
              />
            ) : channel?.type === 'forum' ? (
              <SwipeSidebarContainer onOpenSidebar={() => setChannelsSheetOpen(true)} disabled={isTablet}>
                <ForumChannelView
                  channel={channel}
                  serverId={serverId ?? ''}
                  serverUrl={channelServerUrl}
                  serverToken={server?.token}
                  expressionLookup={expressionLookup}
                  canUseExternalEmotes={canUseExternalEmotes}
                  canUseExternalStickers={canUseExternalStickers}
                />
              </SwipeSidebarContainer>
            ) : (
              <>
            {/* Message list (inverted so newest is at bottom) */}
            <SwipeSidebarContainer onOpenSidebar={() => setChannelsSheetOpen(true)} disabled={isTablet}>
            <ServerMentionProvider serverId={serverId ?? ''} serverUrl={channelServerUrl} token={server?.token}>
            <FlatList
              ref={flatListRef}
              data={displayMessages}
              keyExtractor={(item) => item.id}
              renderItem={renderItem}
              inverted
              onScroll={handleScroll}
              scrollEventThrottle={16}
              onEndReached={handleLoadMore}
              onEndReachedThreshold={0.35}
              removeClippedSubviews={Platform.OS === 'android'}
              windowSize={3}
              initialNumToRender={8}
              maxToRenderPerBatch={6}
              updateCellsBatchingPeriod={50}
              ListFooterComponent={loadingOlder ? <ActivityIndicator color={theme.colors.accent} style={{ marginVertical: 10 }} /> : null}
              ListEmptyComponent={
                loading ? (
                  <View style={{ paddingVertical: 24 }}>
                    <ActivityIndicator color={theme.colors.accent} />
                  </View>
                ) : (
                  <Text variant="bodySmall" color={theme.colors.text3} style={{ textAlign: 'center', paddingVertical: 24 }}>
                    No messages yet.
                  </Text>
                )
              }
              contentContainerStyle={{ paddingHorizontal: theme.spacing.md, paddingTop: 6, paddingBottom: 10 }}
              keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
              keyboardShouldPersistTaps="handled"
              onScrollBeginDrag={() => { Keyboard.dismiss(); setRgbFlowScrolling(true); }}
              onMomentumScrollBegin={() => setRgbFlowScrolling(true)}
              onMomentumScrollEnd={() => setRgbFlowScrolling(false)}
              onScrollEndDrag={() => setRgbFlowScrolling(false)}
            />
            </ServerMentionProvider>
            </SwipeSidebarContainer>
            {/* Old messages banner */}
            {isScrollingOld && (
              <View style={[styles.oldMessagesBanner, { backgroundColor: theme.colors.bgElev1, borderTopColor: theme.colors.lineSoft }]}>
                <Text variant="caption" color={theme.colors.text3} style={{ flex: 1 }}>
                  You're viewing old messages
                </Text>
                <TouchableOpacity onPress={handleWarpToCurrent} style={[styles.warpBtn, { backgroundColor: theme.colors.accent }]}>
                  <Text variant="caption" style={{ color: '#fff', fontWeight: '600' }}>
                    Warp To Current
                  </Text>
                </TouchableOpacity>
              </View>
            )}

        {/* Typing indicator */}
        {typingText ? (
          <View style={[styles.typingBar, { borderTopColor: theme.colors.lineSoft }]}>
            {singleTypingUser ? (
              <Avatar
                username={singleTypingUser.displayName ?? singleTypingUser.username}
                uri={singleTypingUser.avatar ?? null}
                baseUrl={channelServerUrl ?? undefined}
                size={20}
                showStatus={false}
              />
            ) : null}
            <Text variant="caption" color={theme.colors.text3}>
              {typingText}
            </Text>
          </View>
        ) : null}

        {replyToMessage && (
          <View style={[styles.replyBar, { backgroundColor: theme.colors.bgElev1, borderTopColor: theme.colors.lineSoft }]}>
            <CornerUpLeft color={theme.colors.accent} size={14} />
            <Text variant="caption" color={theme.colors.text3} style={{ flex: 1 }} numberOfLines={1}>
              <Text variant="caption" color={theme.colors.accent}>{replyToMessage.display_name ?? replyToMessage.username}</Text>
              {'  '}{replyToMessage.content}
            </Text>
            <RNPressable onPress={() => setReplyToMessage(null)} style={{ padding: 4 }}>
              <X color={theme.colors.text3} size={14} />
            </RNPressable>
          </View>
        )}
            <MobileComposer
              value={draft}
              onChangeText={handleChangeText}
              placeholder={channel?.type === 'media' ? 'Media-only channel' : `Message #${channel?.name ?? channelId}`}
              onSend={handleSend}
              disabled={false}
              allowText={channel?.type !== 'media'}
              bottomInset={composerBottom}
              expressionLookup={expressionLookup}
              serverUrl={channelServerUrl}
              channelId={channelId}
              botCommandsEnabled={channel?.type !== 'media'}
              mentionsEnabled
              canUseExternalEmotes={canUseExternalEmotes}
              canUseExternalStickers={canUseExternalStickers}
              voiceMessages
            />
              </>
            )}
          </>
        )}
      </Animated.View>
      </KeyboardAvoidingView>
      {isTablet && tabletMembersVisible && (
        <View
          style={[
            styles.tabletRightPane,
            {
              backgroundColor: theme.colors.bgSidebar,
              borderLeftColor: theme.colors.lineSoft,
            },
          ]}
        >
          <View style={styles.tabletRightPaneHeader}>
            <Text variant="subtitle" style={styles.tabletPaneTitle}>
              {tabletRightPaneMode === 'members' ? t('chat.members') : tabletRightPaneMode === 'threads' ? t('chat.threads') : t('chat.pinnedMessages')}
            </Text>
            <IconBtn
              icon={X}
              accessibilityLabel={t('server.hideRightPanel')}
              onPress={() => setTabletMembersVisible(false)}
            />
          </View>
          {tabletRightPaneMode === 'members' && (
            <>
              <FlatList
                data={roleGroups}
                keyExtractor={(g) => g.key}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={paneListStyle}
                renderItem={({ item: group }) => {
                  const iconUrl = resolveRoleIconUrl(group.roleIcon, serverUrlForRoleIcons);
                  return (
                    <View style={{ marginBottom: 10 }}>
                      <View style={styles.tabletRoleHeader}>
                        {iconUrl ? (
                          <Image source={{ uri: iconUrl }} style={styles.tabletRoleIcon} resizeMode="contain" />
                        ) : null}
                        <Text
                          variant="caption"
                          color={theme.colors.text3}
                          style={{ textTransform: 'uppercase', letterSpacing: 0.7 }}
                        >
                          {group.label} — {group.users.length}
                        </Text>
                      </View>
                      {group.users.map((member) => (
                        <TabletMemberRow
                          key={member.id}
                          member={member}
                          theme={theme}
                          channelServerUrl={channelServerUrl}
                          onPress={() => router.push({ pathname: '/profile/[userId]', params: { userId: member.id, context: 'server' } })}
                        />
                      ))}
                    </View>
                  );
                }}
              />
            </>
          )}
          {tabletRightPaneMode === 'threads' && (
            threadsLoading ? (
              <View style={{ padding: 24, alignItems: 'center' }}>
                <ActivityIndicator color={theme.colors.accent} />
              </View>
            ) : threads.length === 0 ? (
              <View style={{ padding: 8 }}>
                <Text variant="bodySmall" color={theme.colors.text3}>{t('chat.noThreads')}</Text>
              </View>
            ) : (
              <FlatList
                data={threads}
                keyExtractor={(t) => t.id}
                contentContainerStyle={paneListStyle}
                renderItem={({ item }) => (
                  <Pressable
                    haptic
                    onPress={() => {
                      router.push({
                        pathname: '/server/[serverId]/threads/[channelId]',
                        params: { serverId, channelId: item.id },
                      });
                    }}
                    style={{ paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.lineSoft }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <MessageSquareText size={14} color={theme.colors.text3} />
                      <Text variant="body" color={theme.colors.text} style={{ flex: 1 }} numberOfLines={1}>{item.name}</Text>
                    </View>
                  </Pressable>
                )}
              />
            )
          )}
          {tabletRightPaneMode === 'pins' && (
            pinnedMessages.length === 0 ? (
              <View style={{ padding: 8 }}>
                <Text variant="bodySmall" color={theme.colors.text3}>{t('chat.noPinnedMessages')}</Text>
              </View>
            ) : (
              <FlatList
                data={pinnedMessages}
                keyExtractor={(m) => m.id}
                contentContainerStyle={paneListStyle}
                renderItem={({ item }) => (
                  <View style={{ paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.lineSoft }}>
                    <Text variant="caption" color={theme.colors.accent} style={{ marginBottom: 2 }}>{item.username}</Text>
                    <Text variant="body" color={theme.colors.text} numberOfLines={3}>{item.content}</Text>
                  </View>
                )}
              />
            )
          )}
        </View>
      )}
      </View>

      <MessageActionSheet
        open={Boolean(activeMessage)}
        onClose={() => setActiveMessage(null)}
        expressionLookup={expressionLookup}
        serverUrl={channelServerUrl}
        canReact={canReact}
        canUseExternalEmotes={canUseExternalEmotes}
        canUseExternalStickers={canUseExternalStickers}
        initialEditText={activeMessage?.content ?? ''}
        translationMessageId={activeMessage?.id}
        translationText={activeMessage?.content}
        reactions={activeMessage?.reactions}
        onViewReactions={() => {
          if (!activeMessage) return;
          const current = activeMessage;
          setActiveMessage(null);
          setReactionsSheetState({ open: true, reactions: current.reactions ?? null, initialEmoji: null });
        }}
        canEdit={Boolean(
          activeMessage && (
            activeMessage.user_id === selfUser?.id ||
            hasChannelPermission(selfUser?.permissions, channel?.effective_permissions, PERMISSIONS.MANAGE_MESSAGES)
          )
        )}
        canPin={hasChannelPermission(selfUser?.permissions, channel?.effective_permissions, PERMISSIONS.PIN_MESSAGES)}
        canDelete={Boolean(
          activeMessage && (
            activeMessage.user_id === selfUser?.id ||
            hasChannelPermission(selfUser?.permissions, channel?.effective_permissions, PERMISSIONS.MANAGE_MESSAGES)
          )
        )}
        onReact={(emoji) => {
          if (!activeMessage || !canReact) return;
          handleToggleReaction(activeMessage.id, emoji);
          setActiveMessage(null);
        }}
        onEdit={(nextText) => {
          if (!activeMessage) return;
          requestEdit(activeMessage.id, nextText);
        }}
        onReply={() => {
          if (!activeMessage) return;
          setReplyToMessage(activeMessage);
          setActiveMessage(null);
        }}
        onCopy={() => {
          if (!activeMessage) return;
          void Share.share({ message: activeMessage.content });
          setActiveMessage(null);
        }}
        onCreateThread={channel?.type !== 'forum' ? () => {
          if (!activeMessage) return;
          createThreadMessageRef.current = activeMessage;
          setCreateThreadName('');
          setCreateThreadOpen(true);
          setActiveMessage(null);
        } : undefined}
        isPinned={Boolean(activeMessage && pinnedMessages.some((m) => m.id === activeMessage.id))}
        onPin={() => {
          if (!activeMessage) return;
          const isPinned = pinnedMessages.some((m) => m.id === activeMessage.id);
          if (isPinned) {
            void unpinMessage(channelId, activeMessage.id);
          } else {
            void pinMessage(channelId, activeMessage.id);
          }
          setActiveMessage(null);
        }}
        onDelete={() => {
          if (!activeMessage) return;
          requestDelete(activeMessage.id, activeMessage.channel_id);
        }}
      />

      <MessageReactionsSheet
        open={reactionsSheetState.open}
        onClose={() => setReactionsSheetState({ open: false, reactions: null, initialEmoji: null })}
        reactions={reactionsSheetState.reactions}
        serverUrl={channelServerUrl}
        initialEmoji={reactionsSheetState.initialEmoji}
      />

      {/* Threads sheet */}
      <Sheet open={!isTablet && threadsOpen} onClose={() => setThreadsOpen(false)} maxHeightFraction={0.7}>
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <Text variant="subtitle">{t('chat.threads')}</Text>
        </View>
        {threadsLoading ? (
          <View style={{ padding: 24, alignItems: 'center' }}>
            <ActivityIndicator color={theme.colors.accent} />
          </View>
        ) : threads.length === 0 ? (
          <View style={{ padding: 16 }}>
            <Text variant="bodySmall" color={theme.colors.text3}>{t('chat.noThreads')}</Text>
          </View>
        ) : (
          <FlatList
            data={threads}
            keyExtractor={(t) => t.id}
            contentContainerStyle={{ paddingBottom: 24, paddingHorizontal: 16 }}
            renderItem={({ item }) => (
              <Pressable
                haptic
                onPress={() => {
                  setThreadsOpen(false);
                  router.push({
                    pathname: '/server/[serverId]/threads/[channelId]',
                    params: { serverId, channelId: item.id },
                  });
                }}
                style={{ paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.lineSoft }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <MessageSquareText size={14} color={theme.colors.text3} />
                  <Text variant="body" color={theme.colors.text} style={{ flex: 1 }} numberOfLines={1}>{item.name}</Text>
                </View>
              </Pressable>
            )}
          />
        )}
      </Sheet>

      {/* Pinned messages sheet */}
      <Sheet open={!isTablet && pinsOpen} onClose={() => setPinsOpen(false)} maxHeightFraction={0.7}>
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <Text variant="subtitle">{t('chat.pinnedMessages')}</Text>
        </View>
        {pinnedMessages.length === 0 ? (
          <View style={{ padding: 16 }}>
            <Text variant="bodySmall" color={theme.colors.text3}>{t('chat.noPinnedMessages')}</Text>
          </View>
        ) : (
          <FlatList
            data={pinnedMessages}
            keyExtractor={(m) => m.id}
            contentContainerStyle={{ paddingBottom: 24, paddingHorizontal: 16 }}
            renderItem={({ item }) => (
              <View style={{ paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.lineSoft }}>
                <Text variant="caption" color={theme.colors.accent} style={{ marginBottom: 2 }}>{item.username}</Text>
                <Text variant="body" color={theme.colors.text} numberOfLines={3}>{item.content}</Text>
              </View>
            )}
          />
        )}
      </Sheet>

      {/* Create thread sheet */}
      <Sheet open={createThreadOpen} onClose={() => setCreateThreadOpen(false)} maxHeightFraction={0.42}>
        <View style={{ paddingHorizontal: 16, paddingBottom: 8, gap: 12 }}>
          <Text variant="subtitle">{t('chat.createThreadTitle')}</Text>
          <TextInput
            value={createThreadName}
            onChangeText={setCreateThreadName}
            placeholder={t('chat.threadNamePlaceholder')}
            placeholderTextColor={theme.colors.text3}
            maxLength={80}
            style={{
              backgroundColor: theme.colors.bgElev2,
              color: theme.colors.text,
              borderRadius: theme.radius.md,
              paddingHorizontal: 12,
              paddingVertical: 10,
              fontSize: 15,
            }}
          />
          <Pressable
            haptic
            disabled={!createThreadName.trim() || createThreadLoading}
            onPress={() => {
              const msg = createThreadMessageRef.current;
              if (!msg || !createThreadName.trim()) return;
              setCreateThreadLoading(true);
              void import('@/lib/api').then(({ createApi }) =>
                createApi()
                  .post<{ id: string }>('/api/threads', {
                    channelId,
                    messageId: msg.id,
                    name: createThreadName.trim(),
                  })
                  .then((res) => {
                    setCreateThreadOpen(false);
                    router.push({
                      pathname: '/server/[serverId]/threads/[channelId]',
                      params: { serverId, channelId: res.data.id },
                    });
                  })
                  .catch(() => Alert.alert(t('common.error'), t('chat.threadCreateFailed')))
                  .finally(() => setCreateThreadLoading(false)),
              );
            }}
            style={[{ backgroundColor: theme.colors.accent, borderRadius: theme.radius.md, paddingVertical: 12, alignItems: 'center' }]}
          >
            {createThreadLoading
              ? <ActivityIndicator color={theme.colors.textOnAccent} />
              : <Text variant="body" color={theme.colors.textOnAccent}>{t('chat.createThreadBtn')}</Text>}
          </Pressable>
        </View>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
  },
  channelTitle: {
    flex: 1,
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
  },
  headerSideSpacer: {
    width: 44,
    height: 40,
  },
  headerCenterTitle: {
    position: 'absolute',
    left: 12,
    right: 260,
    top: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 6,
  },
  headerActions: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  encryptedBadge: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginLeft: 4,
  },
  msgRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 12,
    paddingBottom: 2,
    gap: 10,
  },
  avatarPlaceholder: {
    width: 36,
  },
  systemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
    gap: 8,
    opacity: 0.7,
  },
  systemIcon: {
    fontSize: 13,
  },
  msgMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
    flexWrap: 'wrap',
  },
  botInteraction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 2,
    overflow: 'hidden',
  },
  roleIconWrap: {
    marginRight: 4,
  },
  replyQuote: {
    flexDirection: 'row',
    alignItems: 'center',
    borderLeftWidth: 2,
    paddingLeft: 6,
    marginBottom: 2,
    opacity: 0.75,
    overflow: 'hidden',
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
  oldMessagesBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  typingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  warpBtn: {
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tabletLeftPane: {
    width: 346,
    borderRightWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 0,
    paddingTop: 0,
    overflow: 'hidden',
  },
  tabletPaneStack: {
    flex: 1,
    position: 'relative',
    minWidth: 0,
  },
  tabletPaneLayer: {
    ...StyleSheet.absoluteFill,
    paddingHorizontal: 12,
  },
  tabletRightPane: {
    width: 280,
    borderLeftWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  tabletPaneTitle: {
    marginBottom: 8,
    marginTop: 10,
  },
  tabletServerHeader: {
    height: 120,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginHorizontal: -12,
    marginBottom: 2,
    overflow: 'hidden',
    justifyContent: 'flex-end',
    padding: 10,
  },
  tabletServerBanner: {
    ...StyleSheet.absoluteFill,
  },
  tabletServerBannerScrim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.38)',
  },
  tabletServerTitle: {
    color: '#fff',
    fontWeight: '700',
  },
  tabletChannelRow: {
    minHeight: 34,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  tabletVoiceMemberRow: {
    minHeight: 28,
    paddingLeft: 30,
    paddingRight: 8,
    paddingVertical: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  tabletVoiceMemberName: {
    flex: 1,
    fontSize: 13,
  },
  tabletRoomElapsed: {
    fontSize: 10,
    fontVariant: ['tabular-nums'],
  },
  tabletMemberRow: {
    minHeight: 40,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  tabletMemberRowOffline: {
    opacity: 0.5,
  },
  tabletMemberName: {
    fontSize: 14,
    fontWeight: '600',
  },
  tabletRightPaneHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  tabletRoleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  tabletRoleIcon: {
    width: 14,
    height: 14,
  },
  tabletMemberSubtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 2,
  },
  tabletActivityIcon: {
    width: 12,
    height: 12,
    borderRadius: 2,
  },
});
