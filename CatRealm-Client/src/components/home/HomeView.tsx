import { lazy, Suspense, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { MentionProvider } from '../chat/mentions';
import { useTranslation } from 'react-i18next';
import { useFriendStore } from '../../stores/friendStore';
import { useAuthStore } from '../../stores/authStore';
import { useDMStore } from '../../stores/dmStore';
import { useUIStore } from '../../stores/uiStore';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { useCallStore } from '../../stores/callStore';
import { useContentSocialStore } from '../../stores/contentSocialStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useNotificationStore, type CentralNotification } from '../../messaging/notifications/notificationStore';
import { createApi } from '../../lib/api';
import { isHttpGatewayRealm } from '../../lib/httpRealmGateway';
import { AUTH_BASE, createAuthenticatedApi } from '../../lib/authApi';
import { writeClipboardText } from '../../lib/clipboard';
import { getSocket } from '../../lib/socket';
import { formatActivitySummary } from '../../lib/presenceActivity';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { AvatarImage } from '../ui/AvatarImage';
import { VoiceParticipantTile } from '../voice/VoiceParticipantTile';
import { getVoiceRingClass } from '../voice/voiceRing';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Modal } from '../ui/Modal';
import { defaultAvatarUrl, resolveAvatarUrl } from '../../utils/avatar';
import { groupChatFallbackBackground } from '../../utils/groupChatAvatar';
import { HOME_PENDING_REQUESTS_REFRESH_MS, HOME_PRESENCE_REFRESH_MS, OPEN_GROUP_CHAT_CREATOR_EVENT } from './constants';
import type { Tab } from './HomeNav';
import { PersonalNotesView } from '../notes/PersonalNotesView';
import { usePersonalNotesStore } from '../../stores/personalNotesStore';
import { DMView } from '../chat/DMView';
import { MessageRequests } from './MessageRequests';
import { ChatLoadingSkeleton } from '../chat/ChatLoadingSkeleton';
import { GroupChatMessageRow } from '../chat/GroupChatMessageRow';
import { MessageContextMenu } from '../chat/MessageContextMenu';
import { SystemMessageRow } from '../chat/SystemMessageRow';
const GroupCallPanel = lazy(() => import('../calls/GroupCallPanel').then(m => ({ default: m.GroupCallPanel })));
import { SharedComposerShell } from '../chat/SharedComposerShell';
import { ComposerFileButton, ComposerIconButton, ComposerSendButton } from '../chat/ComposerActionButtons';
import { ComposerSelfPreview } from '../chat/ComposerSelfPreview';
import { ComposerSingleAttachmentChip } from '../chat/ComposerAttachments';
import { ComposerMentionSuggestionList } from '../chat/ComposerMentionSuggestionList';
import { ScheduleMessageModal } from '../chat/ScheduleMessageModal';
import { SharedExpressionPickerPanel, isInsideExpressionPicker } from '../chat/SharedExpressionPickerPanel';
import {
  SharedDefaultEmojiPicker,
  SharedEmotePickerGrid,
  SharedExpressionPickerBodyState,
  SharedExpressionPickerSidebar,
  SharedExpressionTabContent,
  SharedStickerPickerGrid,
} from '../chat/SharedExpressionPickerSections';
import type { GroupChatMessage } from '../../types';
import type { ContextMenuItem } from '../../messaging/chatlib/messageActionDefinitions';
import {
  buildExpressionToken,
  DEFAULT_PICKER_SERVER_URL,
  EMPTY_EXPRESSION_MANIFEST as EMPTY_MANIFEST,
  formatPresenceStatusLabel,
  hasBigIntPermission,
  PERSONAL_PICKER_SERVER_URL,
  sanitizeCompactEmoteTokens,
  type ExpressionItem,
  type ExpressionManifest,
  type PickerExpressionItem,
  type PickerServer,
} from '../../lib/expressions';
import {
  DEFAULT_EMOJI_CATEGORIES,
  DEFAULT_CATEGORY_SEARCH_KEYWORDS,
  loadEmojiMetadataLookup,
  normalizeEmojiGlyph,
  normalizeEmojiSearchText,
  toEmojiSearchTerms,
  type DefaultEmojiCategory,
  type EmojiMetadataLookup,
} from '../../lib/emojiMetadata';
import {
  useComposerExpressionPickerActions,
  useDefaultEmojiSearchAdapter,
  useExpressionPickerAdapter,
  useExpressionPickerDataAdapter,
} from '../../messaging/chatlib/composerBridge';
import { hasPermission, PERMISSIONS } from '../../utils/permissions';
import { getNsfwSubtagLabels, shouldBlurAttachmentForNsfwTags } from '../../utils/nsfw';
import {
  ArrowsPointingOutIcon,
  MagnifyingGlassIcon,
  PhoneIcon,
  UsersIcon,
  VideoCameraIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { AudioDeafenedIcon, MicrophoneMutedIcon } from '../voice/VoiceStateIcons';
import { Check, Clock3, Crown, Lock, Users, X } from 'lucide-react';
import { dmContextPreviewText } from '../../lib/dmContext';

interface HomeViewProps {
  tab: Tab;
  setTab?: (tab: Tab) => void;
  /** Small-screen layout: back from an open group chat to the chats list. */
  onMobileBack?: () => void;
}

interface DiscoveryEntry {
  serverUrl: string;
  inviteCode: string;
  inviteUrl: string;
  serverName: string;
  serverDescription: string;
  serverIcon: string | null;
  serverBanner: string | null;
  memberCount: number;
}

interface DiscoveryServerStatus {
  url: string;
  name: string;
  icon: string | null;
  published: boolean;
  inviteCode: string | null;
  inviteUrl: string | null;
  manageBlockedReason?: string | null;
}

const EXTERNAL_EMOJI_DISCORD_BIT = 0x40000n;
const EXTERNAL_STICKER_DISCORD_BIT = 0x2000000000n;
const formatStatus = (status?: 'online' | 'away' | 'sleeping' | 'invisible') => {
  if (!status) return 'Offline';
  if (status === 'away') return 'Away';
  if (status === 'sleeping') return 'Sleeping';
  if (status === 'invisible') return 'Offline';
  return 'Online';
};

function notificationTimeAgo(timestampSeconds: number) {
  const diffMs = Date.now() - timestampSeconds * 1000;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function notificationLabel(notification: CentralNotification) {
  const payload = notification.payload ?? {};
  if (notification.type === 'dm_message') {
    return notification.localPreviewText
      ? `${String(payload.otherDisplayName ?? payload.otherUsername ?? notification.actorName ?? 'Someone')}: ${dmContextPreviewText(notification.localPreviewText)}`
      : `${String(payload.otherDisplayName ?? payload.otherUsername ?? notification.actorName ?? 'Someone')} sent you a message`;
  }
  if (notification.type === 'server_mention') {
    const channel = typeof payload.channelName === 'string' && payload.channelName ? ` in #${payload.channelName}` : '';
    return `${String(payload.senderUsername ?? notification.actorName ?? 'Someone')} mentioned you${channel}`;
  }
  if (notification.type === 'friend_request') {
    return `${String(payload.fromUsername ?? notification.actorName ?? 'Someone')} sent you a friend request`;
  }
  return notification.type.replace(/_/g, ' ');
}

type NotificationFilter = 'all' | 'unread' | 'dms' | 'mentions' | 'friends';

function fallbackRealmName(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}


const NO_MENTION_USERS: { id: string; username: string }[] = [];
export function HomeView({ tab, setTab, onMobileBack }: HomeViewProps) {
  const { t } = useTranslation();
  const [activityNowMs, setActivityNowMs] = useState(() => Date.now());
  const notesActiveId = usePersonalNotesStore((s) => s.activeNoteId);
  const notesActiveTitle = usePersonalNotesStore((s) => s.notes.find((n) => n.id === s.activeNoteId)?.title ?? null);
  const notesStorageUsed = usePersonalNotesStore((s) => s.storageUsed);
  const user = useAuthStore((s) => s.user);
  const serverInfo = useAuthStore((s) => s.serverInfo);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const servers = useServerStore((s) => s.servers);
  const activeServerUrl = useServerStore((s) => s.activeServerUrl);
  const switchServer = useServerStore((s) => s.switchServer);
  const friends = useFriendStore((s) => s.friends);
  const openConversation = useDMStore((s) => s.openConversation);
  const dmConversations = useDMStore((s) => s.conversations);
  const openModal = useUIStore((s) => s.openModal);
  const incoming = useFriendStore((s) => s.incoming);
  const outgoing = useFriendStore((s) => s.outgoing);
  const fetchFriends = useFriendStore((s) => s.fetchFriends);
  const notificationItems = useNotificationStore((s) => s.items);
  const notificationSummary = useNotificationStore((s) => s.summary);
  const refreshNotifications = useNotificationStore((s) => s.refresh);
  const markNotificationRead = useNotificationStore((s) => s.markRead);
  const markAllNotificationsRead = useNotificationStore((s) => s.markAllRead);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setActivityNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const getActivitySummary = (
    customStatusText?: string | null,
    activityType?: string | null,
    activityText?: string | null,
    activityStartedAt?: number | null
  ) => formatActivitySummary({
    customStatusText,
    activityType,
    activityText,
    activityStartedAt,
    nowMs: activityNowMs,
  });

  const fetchRequests = useFriendStore((s) => s.fetchRequests);
  const loading = useFriendStore((s) => s.loading);
  const error = useFriendStore((s) => s.error);
  const sendRequest = useFriendStore((s) => s.sendRequest);
  const acceptRequest = useFriendStore((s) => s.acceptRequest);
  const rejectRequest = useFriendStore((s) => s.rejectRequest);
  const removeFriend = useFriendStore((s) => s.removeFriend);
  const personalRoles = useFriendStore((s) => s.personalRoles);
  const roleAssignments = useFriendStore((s) => s.roleAssignments);
  const loadPersonalRoles = useFriendStore((s) => s.loadPersonalRoles);
  const createPersonalRole = useFriendStore((s) => s.createPersonalRole);
  const updatePersonalRole = useFriendStore((s) => s.updatePersonalRole);
  const deletePersonalRole = useFriendStore((s) => s.deletePersonalRole);
  const setFriendRoleAssigned = useFriendStore((s) => s.setFriendRoleAssigned);
  const clearError = useFriendStore((s) => s.clearError);
  const groupChats = useGroupChatStore((s) => s.groups);
  const activeGroupChatId = useGroupChatStore((s) => s.activeGroupId);
  const groupDetailsById = useGroupChatStore((s) => s.groupDetailsById);
  const groupMessagesById = useGroupChatStore((s) => s.messagesByGroupId);
  const groupLoadingMessagesById = useGroupChatStore((s) => s.loadingMessagesByGroupId);
  const groupHasOlderById = useGroupChatStore((s) => s.hasOlderByGroupId);
  const groupSendingById = useGroupChatStore((s) => s.sendingByGroupId);
  const loadGroupChats = useGroupChatStore((s) => s.loadGroups);
  const loadGroupChatDetail = useGroupChatStore((s) => s.loadGroupDetail);
  const loadGroupChatMessages = useGroupChatStore((s) => s.loadMessages);
  const loadOlderGroupChatMessages = useGroupChatStore((s) => s.loadOlderMessages);
  const markGroupChatRead = useGroupChatStore((s) => s.markAsRead);
  const sendGroupChatMessage = useGroupChatStore((s) => s.sendMessage);
  const toggleGroupChatReaction = useGroupChatStore((s) => s.toggleReaction);
  const editGroupChatMessage = useGroupChatStore((s) => s.editMessage);
  const deleteGroupChatMessage = useGroupChatStore((s) => s.deleteMessage);
  const createGroupChat = useGroupChatStore((s) => s.createGroup);
  const addGroupChatMembers = useGroupChatStore((s) => s.addMembers);
  const removeGroupChatMember = useGroupChatStore((s) => s.removeMember);
  const updateGroupChatAvatar = useGroupChatStore((s) => s.updateAvatar);
  const updateGroupChatRetention = useGroupChatStore((s) => s.updateRetention);
  const groupChatError = useGroupChatStore((s) => s.error);
  const clearGroupChatError = useGroupChatStore((s) => s.clearError);
  const scheduledGCMessages = useGroupChatStore((s) => s.scheduledGCMessages);
  const publishScheduledGC = useGroupChatStore((s) => s.publishScheduledGC);
  const activeGroupCall = useCallStore((s) => s.activeGroupCall);
  const incomingGroupCalls = useCallStore((s) => s.incomingGroupCalls);
  const groupCallRosters = useCallStore((s) => s.groupCallRosters);
  const fetchGroupCallRoster = useCallStore((s) => s.fetchGroupCallRoster);
  const initiateGroupCall = useCallStore((s) => s.initiateGroupCall);
  const joinGroupCall = useCallStore((s) => s.joinGroupCall);

  const openNotification = async (notification: CentralNotification) => {
    if (!notification.readAt) {
      await markNotificationRead(notification.id).catch(() => {});
    }
    if (notification.type === 'friend_request') {
      setTab?.('pending');
      return;
    }
    if (notification.type === 'dm_message') {
      setTab?.('dms');
      const conversation = dmConversations.find((item) => item.id === notification.sourceId);
      const payload = notification.payload ?? {};
      const otherUserId = conversation?.otherUserId ?? (typeof payload.otherUserId === 'string' ? payload.otherUserId : null);
      if (otherUserId) {
        void openConversation(
          otherUserId,
          conversation?.otherUsername ?? String(payload.otherUsername ?? notification.actorName ?? 'Unknown'),
          conversation?.otherAvatar ?? (typeof payload.otherAvatar === 'string' ? payload.otherAvatar : null),
        );
      }
      return;
    }
    if (notification.type === 'server_mention') {
      switchServer(notification.sourceId);
      if (notification.subsourceId && useServerStore.getState().activeServerUrl === notification.sourceId) {
        useChannelStore.getState().setActiveChannel(notification.subsourceId);
      }
    }
  };

  const [addUsername, setAddUsername] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [notificationFilter, setNotificationFilter] = useState<NotificationFilter>('all');
  const [notificationRealmFilter, setNotificationRealmFilter] = useState('all');
  const [friendToRemove, setFriendToRemove] = useState<{ id: string; username: string } | null>(null);
  const [newRoleName, setNewRoleName] = useState('');
  const [newRoleColor, setNewRoleColor] = useState('#6366F1');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [editingRolesForFriend, setEditingRolesForFriend] = useState<string | null>(null);
  const [personalRoleModalOpen, setPersonalRoleModalOpen] = useState(false);
  const [roleManagerOpen, setRoleManagerOpen] = useState(false);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [editRoleName, setEditRoleName] = useState('');
  const [editRoleColor, setEditRoleColor] = useState('#6366F1');
  const [confirmDeleteRoleId, setConfirmDeleteRoleId] = useState<string | null>(null);
  const [discoverEntries, setDiscoverEntries] = useState<DiscoveryEntry[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [discoverQuery, setDiscoverQuery] = useState('');
  const [discoveryManageOpen, setDiscoveryManageOpen] = useState(false);
  const [discoveryManageLoading, setDiscoveryManageLoading] = useState(false);
  const [discoveryManageError, setDiscoveryManageError] = useState<string | null>(null);
  const [discoveryManageNotice, setDiscoveryManageNotice] = useState<string | null>(null);
  const [discoveryActionUrl, setDiscoveryActionUrl] = useState<string | null>(null);
  const [discoveryServers, setDiscoveryServers] = useState<DiscoveryServerStatus[]>([]);
  const [groupChatCreatorOpen, setGroupChatCreatorOpen] = useState(false);
  // Search box for the group friend pickers (long friends lists); cleared
  // whenever either picker opens.
  const [groupFriendSearch, setGroupFriendSearch] = useState('');
  // The Home nav's "Group Chat" button replaces this view's old top row.
  useEffect(() => {
    const openCreator = () => {
      clearGroupChatError();
      setGroupFriendSearch('');
      setGroupChatCreatorOpen(true);
    };
    window.addEventListener(OPEN_GROUP_CHAT_CREATOR_EVENT, openCreator);
    return () => window.removeEventListener(OPEN_GROUP_CHAT_CREATOR_EVENT, openCreator);
  }, [clearGroupChatError]);
  const [groupChatName, setGroupChatName] = useState('');
  const [groupChatRetentionDays, setGroupChatRetentionDays] = useState<number>(365);
  const [groupChatSelectedFriendIds, setGroupChatSelectedFriendIds] = useState<string[]>([]);
  const [creatingGroupChat, setCreatingGroupChat] = useState(false);
  const [groupMemberAdderOpen, setGroupMemberAdderOpen] = useState(false);
  const [groupMemberAdderSelectedIds, setGroupMemberAdderSelectedIds] = useState<string[]>([]);
  const [groupMemberToRemove, setGroupMemberToRemove] = useState<{ id: string; username: string } | null>(null);
  const [groupEncryptionInfoOpen, setGroupEncryptionInfoOpen] = useState(false);
  const [groupReactionPickerMessageId, setGroupReactionPickerMessageId] = useState<string | null>(null);
  const [groupReactionPickerAnchor, setGroupReactionPickerAnchor] = useState<{ x: number; y: number } | null>(null);
  const [groupPickerOpen, setGroupPickerOpen] = useState(false);
  const [groupPickerTab, setGroupPickerTab] = useState<'emojis' | 'stickers'>('emojis');
  const [groupEmojiSearchQuery, setGroupEmojiSearchQuery] = useState('');
  const [groupDefaultEmojiCategory, setGroupDefaultEmojiCategory] = useState<DefaultEmojiCategory>('People');
  const [groupSelectedExpressionServerUrl, setGroupSelectedExpressionServerUrl] = useState<string | null>(null);
  const [groupExpressionStateByServer, setGroupExpressionStateByServer] = useState<Record<string, { loading: boolean; data: ExpressionManifest | null; error: string | null }>>({});
  const [groupPersonalManifest, setGroupPersonalManifest] = useState<ExpressionManifest | null>(null);
  const [groupEmojiMetadataLookup, setGroupEmojiMetadataLookup] = useState<EmojiMetadataLookup | null>(null);
  const [groupRetentionSettingsOpen, setGroupRetentionSettingsOpen] = useState(false);
  const [updatingGroupAvatar, setUpdatingGroupAvatar] = useState(false);
  const [groupMemberListOpen, setGroupMemberListOpen] = useState(false);
  const [updatingGroupRetention, setUpdatingGroupRetention] = useState(false);
  const [groupMessageText, setGroupMessageText] = useState('');
  const [selectedGroupAttachment, setSelectedGroupAttachment] = useState<File | null>(null);
  const [selectedGroupAttachmentNsfwTags, setSelectedGroupAttachmentNsfwTags] = useState<{ gore: boolean; blood: boolean; lewd: boolean; spoiler: boolean }>({
    gore: false,
    blood: false,
    lewd: false,
    spoiler: false,
  });
  const [revealedGroupMediaByMessageId, setRevealedGroupMediaByMessageId] = useState<Record<string, boolean>>({});
  const [groupTypingUserIds, setGroupTypingUserIds] = useState<string[]>([]);
  const [isGroupTyping, setIsGroupTyping] = useState(false);
  const [groupMemberContextMenu, setGroupMemberContextMenu] = useState<{
    position: { x: number; y: number };
    member: { id: string; username: string; isOwner: boolean };
  } | null>(null);
  const [groupCallMessageChatOpen, setGroupCallMessageChatOpen] = useState(false);
  const [groupScheduleModalOpen, setGroupScheduleModalOpen] = useState(false);
  const [pendingGroupScheduledSend, setPendingGroupScheduledSend] = useState<{ text: string } | null>(null);
  const [groupMentionOpen, setGroupMentionOpen] = useState(false);
  const [groupMentionItems, setGroupMentionItems] = useState<Array<{ label: string; insert: string; type: string; description?: string; avatar?: string | null; accountType?: 'local' | 'central' }>>([]);
  const [groupMentionIndex, setGroupMentionIndex] = useState(0);
  const [groupMentionAnchor, setGroupMentionAnchor] = useState<number>(-1);
  const groupAttachmentInputRef = useRef<HTMLInputElement>(null);
  const groupAvatarInputRef = useRef<HTMLInputElement>(null);
  const groupMessagesScrollRef = useRef<HTMLDivElement>(null);
  const groupComposerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const groupPickerRef = useRef<HTMLDivElement>(null);
  const groupTypingTimeoutRef = useRef<number | null>(null);

  const friendStatusOverrideById = useMemo(() => {
    const map = new Map<string, 'online' | 'away' | 'sleeping' | 'invisible'>();
    for (const conv of dmConversations) {
      if (conv.otherStatus) {
        map.set(conv.otherUserId, conv.otherStatus);
      }
    }
    return map;
  }, [dmConversations]);
  const currentServerUrl = activeServerUrl || serverUrl || null;
  const isPrivileged = user?.role === 'owner' || user?.isOwner || hasPermission(user?.permissions, PERMISSIONS.ADMINISTRATOR);
  const canUseExternalEmojis = isPrivileged || user?.accountType === 'central' || hasBigIntPermission(user?.permissions, EXTERNAL_EMOJI_DISCORD_BIT);
  const canUseExternalStickers = isPrivileged || user?.accountType === 'central' || hasBigIntPermission(user?.permissions, EXTERNAL_STICKER_DISCORD_BIT);
  const allowNsfw = useContentSocialStore((s) => s.allowNsfw);
  const nsfwLewds = useContentSocialStore((s) => s.nsfwLewds);
  const nsfwBlood = useContentSocialStore((s) => s.nsfwBlood);
  const nsfwGore = useContentSocialStore((s) => s.nsfwGore);
  const enableImageThumbnailing = useSettingsStore((s) => s.enableImageThumbnailing);

  const notificationRealmOptions = useMemo(() => {
    const namesByUrl = new Map(servers.map((entry) => [
      entry.url,
      entry.name || entry.info?.name || fallbackRealmName(entry.url),
    ]));
    const options = new Map<string, string>();
    for (const notification of notificationItems) {
      if (notification.type !== 'server_mention' || !notification.sourceId) continue;
      options.set(
        notification.sourceId,
        namesByUrl.get(notification.sourceId) || fallbackRealmName(notification.sourceId)
      );
    }
    return Array.from(options, ([url, name]) => ({ url, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [notificationItems, servers]);

  const filteredNotificationItems = useMemo(() => {
    return notificationItems.filter((notification) => {
      if (notificationFilter === 'unread' && notification.readAt) return false;
      if (notificationFilter === 'dms' && notification.type !== 'dm_message') return false;
      if (notificationFilter === 'mentions' && notification.type !== 'server_mention') return false;
      if (notificationFilter === 'friends' && notification.type !== 'friend_request') return false;
      if (notificationRealmFilter !== 'all') {
        return notification.type === 'server_mention' && notification.sourceId === notificationRealmFilter;
      }
      return true;
    });
  }, [notificationFilter, notificationItems, notificationRealmFilter]);

  const notificationFilterCounts = useMemo<Record<NotificationFilter, number>>(() => ({
    all: notificationItems.length,
    unread: notificationItems.filter((notification) => !notification.readAt).length,
    dms: notificationItems.filter((notification) => notification.type === 'dm_message').length,
    mentions: notificationItems.filter((notification) => notification.type === 'server_mention').length,
    friends: notificationItems.filter((notification) => notification.type === 'friend_request').length,
  }), [notificationItems]);

  useEffect(() => {
    if (
      notificationRealmFilter !== 'all'
      && !notificationRealmOptions.some((option) => option.url === notificationRealmFilter)
    ) {
      setNotificationRealmFilter('all');
    }
  }, [notificationRealmFilter, notificationRealmOptions]);

  const groupExpressionServers = useMemo<PickerServer[]>(() => {
    const deduped = new Map<string, PickerServer>();

    if (user?.accountType === 'central') {
      servers.forEach((entry) => {
        deduped.set(entry.url, {
          url: entry.url,
          name: entry.name || entry.info?.name || entry.url,
          icon: entry.icon || entry.info?.serverIcon || undefined,
          token: entry.token,
          isCurrent: currentServerUrl === entry.url,
        });
      });
    }

    if (serverUrl && !deduped.has(serverUrl)) {
      deduped.set(serverUrl, {
        url: serverUrl,
        name: serverInfo?.name || serverUrl,
        icon: serverInfo?.serverIcon || undefined,
        token: token || undefined,
        isCurrent: currentServerUrl === serverUrl,
      });
    }

    return [
      {
        url: DEFAULT_PICKER_SERVER_URL,
        name: 'Default Emojis',
        isCurrent: false,
        isDefault: true,
      },
      ...(user?.accountType === 'central'
        ? [{
            url: PERSONAL_PICKER_SERVER_URL,
            name: 'Personal Emojis',
            icon: user.avatar || undefined,
            isCurrent: false,
            isPersonal: true,
          } satisfies PickerServer]
        : []),
      ...Array.from(deduped.values()).filter((entry) => !isHttpGatewayRealm(entry.url)),
    ];
  }, [user?.accountType, user?.avatar, servers, serverUrl, serverInfo?.name, serverInfo?.serverIcon, token, currentServerUrl]);

  const groupVisibleExpressionServers = useMemo(() => groupExpressionServers, [groupExpressionServers]);

  const loadGroupExpressionManifest = useCallback(async (entry: PickerServer) => {
    if (entry.isDefault || entry.isPersonal || isHttpGatewayRealm(entry.url)) return;
    setGroupExpressionStateByServer((prev) => ({
      ...prev,
      [entry.url]: { loading: true, data: null, error: null },
    }));
    try {
      const api = createApi(entry.url, entry.token);
      const res = await api.get('/api/expressions/manifest');
      const manifest: ExpressionManifest = {
        emotes: Array.isArray(res.data?.emotes) ? res.data.emotes : [],
        'anim-emotes': Array.isArray(res.data?.['anim-emotes']) ? res.data['anim-emotes'] : [],
        stickers: Array.isArray(res.data?.stickers) ? res.data.stickers : [],
        'anim-stickers': Array.isArray(res.data?.['anim-stickers']) ? res.data['anim-stickers'] : [],
      };
      setGroupExpressionStateByServer((prev) => ({
        ...prev,
        [entry.url]: { loading: false, data: manifest, error: null },
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load expressions';
      setGroupExpressionStateByServer((prev) => ({
        ...prev,
        [entry.url]: { loading: false, data: null, error: msg },
      }));
    }
  }, []);

  const loadGroupPersonalManifest = useCallback(async () => {
    if (user?.accountType !== 'central' || !token) {
      setGroupPersonalManifest(null);
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
      setGroupPersonalManifest(manifest);
    } catch {
      setGroupPersonalManifest(null);
    }
  }, [user?.accountType, token]);

  const clearGroupExpressionServerState = useCallback((url: string) => {
    setGroupExpressionStateByServer((prev) => {
      const next = { ...prev };
      delete next[url];
      return next;
    });
  }, []);

  const {
    effectiveSelectedServerUrl: effectiveGroupSelectedServerUrl,
    selectedServer: groupSelectedServer,
    selectedServerState: groupSelectedServerState,
    selectServer: selectGroupExpressionPickerServer,
    primePickerSelection: primeGroupExpressionPickerSelection,
    retrySelectedServer: retrySelectedGroupExpressionServer,
  } = useExpressionPickerAdapter<PickerServer, ExpressionManifest>({
    visibleServers: groupVisibleExpressionServers,
    selectedServerUrl: groupSelectedExpressionServerUrl,
    setSelectedServerUrl: setGroupSelectedExpressionServerUrl,
    stateByServer: groupExpressionStateByServer,
    loadManifest: loadGroupExpressionManifest,
    ensurePersonalManifest: loadGroupPersonalManifest,
    clearServerState: clearGroupExpressionServerState,
  });

  const groupComposerPickerActions = useComposerExpressionPickerActions({
    pickerTab: groupPickerTab,
    setPickerTab: setGroupPickerTab,
    setPickerOpen: setGroupPickerOpen,
    primePickerSelection: primeGroupExpressionPickerSelection,
    beforeToggle: () => setGroupReactionPickerMessageId(null),
  });

  const {
    selectedManifest: groupSelectedManifest,
    selectedIsExternal: groupSelectedIsExternal,
    canUseSelectedEmojiServer: canUseGroupSelectedEmojiServer,
    canUseSelectedStickerServer: canUseGroupSelectedStickerServer,
    filteredSelectedEmoteItems: filteredGroupSelectedEmoteItems,
    filteredSelectedStickerItems: filteredGroupSelectedStickerItems,
  } = useExpressionPickerDataAdapter<PickerServer, ExpressionItem, ExpressionManifest, PickerExpressionItem>({
    selectedServer: groupSelectedServer,
    selectedServerState: groupSelectedServerState,
    personalManifest: groupPersonalManifest,
    emptyManifest: EMPTY_MANIFEST,
    currentServerUrl,
    serverUrl,
    authBase: AUTH_BASE,
    canUseExternalEmojis,
    canUseExternalStickers,
    searchQuery: groupEmojiSearchQuery,
    buildPickerItem: ({ expression, sourceUrl, kind, isPersonal }) => ({
      expression,
      sourceUrl,
      key: `${isPersonal ? 'personal' : 'server'}-${kind}-${expression.id}`,
      isPersonal,
    }),
  });

  const groupSearchableDefaultEmojiEntries = useMemo(
    () =>
      DEFAULT_EMOJI_CATEGORIES.flatMap((category) =>
        category.emojis.map((emoji, index) => {
          const emojiMetadata = groupEmojiMetadataLookup?.get(emoji) ?? groupEmojiMetadataLookup?.get(normalizeEmojiGlyph(emoji));
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
    [groupEmojiMetadataLookup]
  );

  const {
    hasEmojiSearchQuery: hasGroupEmojiSearchQuery,
    filteredEntries: filteredGroupDefaultEmojiEntries,
  } = useDefaultEmojiSearchAdapter({
    searchQuery: groupEmojiSearchQuery,
    selectedCategory: groupDefaultEmojiCategory,
    entries: groupSearchableDefaultEmojiEntries,
    toSearchTerms: toEmojiSearchTerms,
  });

  const resolveGroupExpressionAssetUrl = useCallback((
    expression: ExpressionItem,
    fromServerUrl: string,
    preferredSize?: number
  ) => {
    const absoluteVariants = expression.absolute_variants ?? {};
    const relativeVariants = expression.variants ?? {};
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
        if (absoluteVariants[chosenKey]) return absoluteVariants[chosenKey];
        if (relativeVariants[chosenKey]) {
          return /^https?:\/\//i.test(relativeVariants[chosenKey])
            ? relativeVariants[chosenKey]
            : `${fromServerUrl}${relativeVariants[chosenKey]}`;
        }
      }
    }

    if (expression.absolute_url) return expression.absolute_url;
    if (/^https?:\/\//i.test(expression.file_url)) return expression.file_url;
    return `${fromServerUrl}${expression.file_url}`;
  }, []);

  useEffect(() => {
    if (user?.accountType === 'central') {
      loadPersonalRoles();
    }
  }, [user?.accountType, loadPersonalRoles]);

  const fetchDiscovery = async (queryText?: string) => {
    setDiscoverLoading(true);
    setDiscoverError(null);
    try {
      const api = createAuthenticatedApi();
      const response = await api.get('/api/discovery', {
        params: {
          limit: 60,
          ...(queryText && queryText.trim() ? { query: queryText.trim() } : {}),
        },
      });
      setDiscoverEntries(Array.isArray(response.data) ? response.data as DiscoveryEntry[] : []);
    } catch (err: any) {
      setDiscoverError(err?.response?.data?.error || 'Failed to load discoverable servers');
    } finally {
      setDiscoverLoading(false);
    }
  };

  useEffect(() => {
    if (tab !== 'discover') return;
    void fetchDiscovery(discoverQuery);
  }, [tab]);

  useEffect(() => {
    if (tab !== 'groupChats') return;
    void loadGroupChats();
  }, [tab, loadGroupChats]);

  useEffect(() => {
    if (tab !== 'groupChats') return;
    if (!activeGroupChatId) return;
    void loadGroupChatDetail(activeGroupChatId);
  }, [tab, activeGroupChatId, loadGroupChatDetail]);

  useEffect(() => {
    if (!user?.id) return;
    const isHomeTab = tab === 'notifications' || tab === 'friends' || tab === 'pending' || tab === 'dms' || tab === 'groupChats';
    if (!isHomeTab) return;

    const refreshHomePresence = () => {
      void fetchFriends({ force: true });
      if (tab === 'groupChats' && activeGroupChatId) {
        void loadGroupChatDetail(activeGroupChatId);
      }
    };

    refreshHomePresence();
    const intervalId = window.setInterval(refreshHomePresence, HOME_PRESENCE_REFRESH_MS);
    const onFocus = () => refreshHomePresence();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshHomePresence();
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [tab, user?.id, activeGroupChatId, fetchFriends, loadGroupChatDetail]);

  useEffect(() => {
    if (tab !== 'notifications') return;
    void refreshNotifications();
  }, [tab, refreshNotifications]);

  useEffect(() => {
    if (!user?.id) return;
    if (tab !== 'pending') return;

    const refreshPendingRequests = () => {
      void fetchRequests({ force: true });
    };

    refreshPendingRequests();
    const intervalId = window.setInterval(refreshPendingRequests, HOME_PENDING_REQUESTS_REFRESH_MS);
    const onFocus = () => refreshPendingRequests();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshPendingRequests();
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [tab, user?.id, fetchRequests]);

  useEffect(() => {
    if (tab !== 'groupChats') return;
    if (!activeGroupChatId) return;
    void loadGroupChatMessages(activeGroupChatId);
  }, [tab, activeGroupChatId, loadGroupChatMessages]);

  useEffect(() => {
    if (tab !== 'groupChats') return;
    if (!activeGroupChatId) return;
    void markGroupChatRead(activeGroupChatId);
  }, [tab, activeGroupChatId, (groupMessagesById[activeGroupChatId || ''] || []).length, markGroupChatRead]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab !== 'groupChats') return;
    const el = groupMessagesScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [tab, activeGroupChatId, (activeGroupChatId ? (groupMessagesById[activeGroupChatId] || []).length : 0)]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab !== 'groupChats' || !activeGroupChatId) return;
    const socket = getSocket(AUTH_BASE);
    if (!socket) return;

    const onTypingStart = ({ groupChatId, userId }: { groupChatId: string; userId: string }) => {
      if (groupChatId !== activeGroupChatId || !userId || userId === user?.id) return;
      setGroupTypingUserIds((prev) => (prev.includes(userId) ? prev : [...prev, userId]));
    };
    const onTypingStop = ({ groupChatId, userId }: { groupChatId: string; userId: string }) => {
      if (groupChatId !== activeGroupChatId || !userId || userId === user?.id) return;
      setGroupTypingUserIds((prev) => prev.filter((id) => id !== userId));
    };

    socket.on('gc:typing:start', onTypingStart);
    socket.on('gc:typing:stop', onTypingStop);
    return () => {
      socket.off('gc:typing:start', onTypingStart);
      socket.off('gc:typing:stop', onTypingStop);
      setGroupTypingUserIds([]);
    };
  }, [tab, activeGroupChatId, user?.id]);

  useEffect(() => {
    const el = groupComposerTextareaRef.current;
    if (!el) return;
    // Roughly 18 visible lines before textarea starts scrolling (Discord-like behavior)
    const maxHeight = 376;
    el.style.height = '0px';
    const nextHeight = Math.max(24, Math.min(el.scrollHeight, maxHeight));
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [groupMessageText, activeGroupChatId]);

  useEffect(() => {
    setGroupReactionPickerMessageId(null);
    setGroupPickerOpen(false);
    setGroupEmojiSearchQuery('');
    setSelectedGroupAttachmentNsfwTags({ gore: false, blood: false, lewd: false, spoiler: false });
    setRevealedGroupMediaByMessageId({});
  }, [activeGroupChatId]);

  useEffect(() => {
    if (!groupPickerOpen) {
      if (groupReactionPickerMessageId) setGroupReactionPickerMessageId(null);
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!groupPickerRef.current) return;
      if (groupPickerRef.current.contains(event.target as Node) || isInsideExpressionPicker(event.target)) return;
      setGroupPickerOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
    };
  }, [groupPickerOpen, groupReactionPickerMessageId]);

  useEffect(() => {
    if (!groupPickerOpen || groupEmojiMetadataLookup) return;
    let cancelled = false;
    void loadEmojiMetadataLookup()
      .then((lookup) => {
        if (!cancelled) setGroupEmojiMetadataLookup(lookup);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [groupPickerOpen, groupEmojiMetadataLookup]);


  useEffect(() => {
    if (!groupMemberContextMenu) return;
    const onClose = () => setGroupMemberContextMenu(null);
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setGroupMemberContextMenu(null);
    };
    window.addEventListener('click', onClose);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('click', onClose);
      window.removeEventListener('keydown', onEsc);
    };
  }, [groupMemberContextMenu]);

  const loadDiscoveryManageStatus = async () => {
    setDiscoveryManageError(null);
    setDiscoveryManageNotice(null);
    setDiscoveryManageLoading(true);
    try {
      const isSecureWebContext = typeof window !== 'undefined' && window.location.protocol === 'https:';
      const statuses = await Promise.all(servers.map(async (server) => {
        if (isSecureWebContext && server.url.startsWith('http://')) {
          return {
            url: server.url,
            name: server.name,
            icon: server.icon || null,
            published: false,
            inviteCode: null,
            inviteUrl: null,
            manageBlockedReason: 'HTTP-only server. Use desktop app to publish discovery.',
          } as DiscoveryServerStatus;
        }

        try {
          const api = createApi(server.url, server.token);
          const response = await api.get('/api/invites/discovery/status');
          if (!response?.data?.owner) return null;
          return {
            url: server.url,
            name: server.name,
            icon: server.icon || null,
            published: Boolean(response.data.published),
            inviteCode: response.data.inviteCode || null,
            inviteUrl: response.data.inviteUrl || null,
          } as DiscoveryServerStatus;
        } catch {
          return null;
        }
      }));

      const filtered = statuses.filter((entry): entry is DiscoveryServerStatus => Boolean(entry));
      setDiscoveryServers(filtered);
      if (filtered.some((entry) => entry.manageBlockedReason)) {
        setDiscoveryManageNotice('Some connected servers are HTTP-only and cannot be managed from the HTTPS web app.');
      }
    } catch (err: any) {
      setDiscoveryManageError(err?.response?.data?.error || 'Failed to load server publish status');
      setDiscoveryServers([]);
    } finally {
      setDiscoveryManageLoading(false);
    }
  };

  const openDiscoveryManageModal = async () => {
    setDiscoveryManageOpen(true);
    await loadDiscoveryManageStatus();
  };

  const publishServerToDiscovery = async (serverUrl: string) => {
    const server = servers.find((entry) => entry.url === serverUrl);
    if (!server) return;
    setDiscoveryActionUrl(serverUrl);
    setDiscoveryManageError(null);
    try {
      const api = createApi(server.url, server.token);
      await api.post('/api/invites/discovery/publish', {});
      await Promise.all([
        loadDiscoveryManageStatus(),
        fetchDiscovery(discoverQuery),
      ]);
    } catch (err: any) {
      setDiscoveryManageError(err?.response?.data?.error || 'Failed to publish server to discovery');
    } finally {
      setDiscoveryActionUrl(null);
    }
  };

  const unpublishServerFromDiscovery = async (serverUrl: string) => {
    const server = servers.find((entry) => entry.url === serverUrl);
    if (!server) return;
    setDiscoveryActionUrl(serverUrl);
    setDiscoveryManageError(null);
    try {
      const api = createApi(server.url, server.token);
      await api.delete('/api/invites/discovery/unpublish');
      await Promise.all([
        loadDiscoveryManageStatus(),
        fetchDiscovery(discoverQuery),
      ]);
    } catch (err: any) {
      setDiscoveryManageError(err?.response?.data?.error || 'Failed to unpublish server from discovery');
    } finally {
      setDiscoveryActionUrl(null);
    }
  };

  const handleSendRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addUsername.trim()) return;
    setSuccessMsg('');
    await sendRequest(addUsername.trim());
    if (!useFriendStore.getState().error) {
      setSuccessMsg(`Friend request sent to ${addUsername.trim()}`);
      setAddUsername('');
    }
  };

  const filteredFriends = roleFilter === 'all'
    ? friends
    : friends.filter((f) => (roleAssignments[f.id] || []).includes(roleFilter));

  const handleCreatePersonalRole = async () => {
    if (!newRoleName.trim()) return;
    await createPersonalRole(newRoleName.trim(), newRoleColor || null);
    if (!useFriendStore.getState().error) {
      setNewRoleName('');
      setPersonalRoleModalOpen(false);
    }
  };

  const startEditRole = (role: { id: string; name: string; color?: string | null }) => {
    setEditingRoleId(role.id);
    setEditRoleName(role.name);
    setEditRoleColor(role.color || '#6366F1');
  };

  const handleSaveRole = async () => {
    if (!editingRoleId || !editRoleName.trim()) return;
    await updatePersonalRole(editingRoleId, editRoleName.trim(), editRoleColor || null);
    if (!useFriendStore.getState().error) {
      setEditingRoleId(null);
    }
  };

  const handleDeleteRole = async (roleId: string) => {
    await deletePersonalRole(roleId);
    if (confirmDeleteRoleId === roleId) setConfirmDeleteRoleId(null);
    if (editingRoleId === roleId) setEditingRoleId(null);
    if (roleFilter === roleId) setRoleFilter('all');
  };

  const activeGroupChat = activeGroupChatId ? (groupDetailsById[activeGroupChatId] || null) : null;
  const activeGroupMessages = activeGroupChatId ? (groupMessagesById[activeGroupChatId] || []) : [];
  const groupMessagesLoading = activeGroupChatId ? !!groupLoadingMessagesById[activeGroupChatId] : false;
  const groupHasOlderMessages = activeGroupChatId ? (groupHasOlderById[activeGroupChatId] ?? false) : false;
  const groupSending = activeGroupChatId ? !!groupSendingById[activeGroupChatId] : false;
  const activeGroupCallForChat = activeGroupChatId && activeGroupCall?.groupChatId === activeGroupChatId
    ? activeGroupCall
    : null;
  const incomingGroupCallForChat = activeGroupChatId ? incomingGroupCalls[activeGroupChatId] : null;
  const hasOngoingGroupCallForChat = !!(activeGroupCallForChat || incomingGroupCallForChat);
  const callParticipantByUserId = useMemo(() => {
    const map = new Map<string, NonNullable<typeof activeGroupCallForChat>['participants'][number]>();
    for (const participant of activeGroupCallForChat?.participants || []) {
      map.set(participant.userId, participant);
    }
    return map;
  }, [activeGroupCallForChat?.participants]);
  // Who is in this group's call while you're not in it (the roster reaches
  // every member). Falls back to the starter until the roster arrives.
  const groupCallPaneParticipants = useMemo(() => {
    if (!incomingGroupCallForChat) return [];
    const roster = activeGroupChatId ? groupCallRosters[activeGroupChatId] : undefined;
    const entries = roster && roster.callId === incomingGroupCallForChat.callId
      ? roster.participants
      : [{
          userId: incomingGroupCallForChat.initiatorId,
          username: incomingGroupCallForChat.initiatorName,
          displayName: null,
          avatar: activeGroupChat?.members.find((member) => member.id === incomingGroupCallForChat.initiatorId)?.avatar ?? null,
        }];
    return entries
      .filter((entry) => entry.userId !== user?.id)
      .map((entry) => {
        const member = activeGroupChat?.members.find((m) => m.id === entry.userId);
        return {
          userId: entry.userId,
          name: entry.displayName || member?.displayName || entry.username || member?.username || 'User',
          avatarUrl: resolveAvatarUrl((entry.avatar ?? member?.avatar) ?? undefined, AUTH_BASE, 'central') ?? defaultAvatarUrl(),
        };
      });
  }, [incomingGroupCallForChat, groupCallRosters, activeGroupChatId, activeGroupChat?.members, user?.id]);

  // Load the running call's roster when opening a group (covers reloads and
  // calls that started before this client connected).
  useEffect(() => {
    if (activeGroupChatId) void fetchGroupCallRoster(activeGroupChatId);
  }, [activeGroupChatId, incomingGroupCallForChat?.callId, fetchGroupCallRoster]);
  useEffect(() => {
    if (!activeGroupCallForChat) {
      setGroupCallMessageChatOpen(false);
    }
  }, [activeGroupCallForChat?.callId]);
  useEffect(() => {
    setGroupCallMessageChatOpen(false);
  }, [activeGroupChatId]);
  useEffect(() => {
    setGroupMemberListOpen(false);
  }, [activeGroupChatId]);
  const activeGroupAvatarUrl = activeGroupChat
    ? resolveAvatarUrl(activeGroupChat.avatar ?? undefined, AUTH_BASE, 'central')
    : null;
  const activeGroupAvatarBg = activeGroupChat
    ? groupChatFallbackBackground(activeGroupChat.id || activeGroupChat.name || 'group-chat')
    : '#4f46e5';
  const activeGroupMemberIds = new Set((activeGroupChat?.members || []).map((m) => m.id));
  const eligibleFriendsForActiveGroup = friends.filter((f) => !activeGroupMemberIds.has(f.id));
  const groupFriendQuery = groupFriendSearch.trim().toLowerCase();
  const matchesGroupFriendSearch = (friend: { username: string }) =>
    !groupFriendQuery || friend.username.toLowerCase().includes(groupFriendQuery);
  const creatorFriendMatches = friends.filter(matchesGroupFriendSearch);
  const adderFriendMatches = eligibleFriendsForActiveGroup.filter(matchesGroupFriendSearch);
  const allowedGroupRetentionOptions = [7, 30, 90, 180, 365, 1825];
  // Group member status is a snapshot from loadGroupDetail; overlay live status
  // from friends (refreshed on friends:sync), DM conversations and our own status.
  const liveGroupStatusById = useMemo(() => {
    const map = new Map(friendStatusOverrideById);
    for (const friend of friends) {
      if (friend.status) map.set(friend.id, friend.status);
    }
    if (user?.id && user.status) map.set(user.id, user.status);
    return map;
  }, [friendStatusOverrideById, friends, user?.id, user?.status]);
  const { groupOnlineMembers, groupOfflineMembers } = useMemo(() => {
    const members = (activeGroupChat?.members || []).map((m) => {
      const live = liveGroupStatusById.get(m.id);
      return live && live !== m.status ? { ...m, status: live } : m;
    });
    const sorted = [...members].sort((a, b) => {
      if (a.isOwner && !b.isOwner) return -1;
      if (!a.isOwner && b.isOwner) return 1;
      const aOffline = !a.status || a.status === 'invisible';
      const bOffline = !b.status || b.status === 'invisible';
      if (aOffline !== bOffline) return aOffline ? 1 : -1;
      return (a.displayName || a.username).localeCompare(b.displayName || b.username);
    });
    return {
      groupOnlineMembers: sorted.filter((m) => m.status && m.status !== 'invisible'),
      groupOfflineMembers: sorted.filter((m) => !m.status || m.status === 'invisible'),
    };
  }, [activeGroupChat?.members, liveGroupStatusById]);
  const groupMemberContextMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!groupMemberContextMenu) return [];
    const member = groupMemberContextMenu.member;
    const items: ContextMenuItem[] = [
      {
        key: 'copy_username',
        label: 'Copy Username',
        onClick: () => { void writeClipboardText(member.username); },
      },
      {
        key: 'copy_id',
        label: 'Copy User ID',
        onClick: () => { void writeClipboardText(member.id); },
      },
    ];
    if (activeGroupChat?.isOwner && !member.isOwner) {
      items.push({
        key: 'remove_member',
        label: 'Remove Member',
        isDanger: true,
        onClick: () => { void handleRemoveGroupMember(member.id, member.username); },
      });
    }
    return items;
  }, [groupMemberContextMenu, activeGroupChat?.isOwner]);

  const handleStartGroupAudioCall = async () => {
    if (!activeGroupChat) return;
    await initiateGroupCall(activeGroupChat.id, activeGroupChat.name, activeGroupChat.avatar ?? null, 'audio');
  };

  const handleJoinActiveGroupCall = async () => {
    if (!activeGroupChat || !incomingGroupCallForChat) return;
    await joinGroupCall({
      callId: incomingGroupCallForChat.callId,
      groupChatId: incomingGroupCallForChat.groupChatId,
      groupName: activeGroupChat.name,
      groupAvatar: activeGroupChat.avatar ?? null,
      mediaType: incomingGroupCallForChat.mediaType,
    });
  };

  const groupMemberListPane = activeGroupChat ? (
    <>
      <div className="px-4 py-3 border-b border-border shrink-0 flex items-center gap-2">
        <h5 className="text-xs font-semibold uppercase text-text-muted flex-1">
          Members -- {activeGroupChat.members.length}
        </h5>
        <button
          type="button"
          onClick={() => setGroupMemberListOpen(false)}
          className="md:hidden w-8 h-8 inline-flex items-center justify-center rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
          aria-label="Close member list"
        >
          <XMarkIcon className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
        {/* One "Members" list: online first, offline faded below (no
            Online/Offline subheadings). */}
        {groupOnlineMembers.length > 0 && (
          <div className="mb-0.5">
            <div className="space-y-0.5">
              {groupOnlineMembers.map((member) => (
                <div
                  key={member.id}
                  onContextMenu={(e) => openGroupMemberContextMenu(e, member)}
                  onClick={() => openModal('profileView', { userId: member.id })}
                  className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-bg-hover/50 transition-colors cursor-pointer"
                >
                  <div className="relative w-8 h-8 rounded-full avatar-bg-muted flex items-center justify-center text-white text-sm font-semibold shrink-0 overflow-hidden">
                    <AvatarImage
                      src={resolveAvatarUrl(member.avatar, AUTH_BASE, 'central')}
                      alt={member.username}
                      size={32}
                      className="w-8 h-8 object-cover"
                      fallback={<span>{member.username.charAt(0).toUpperCase()}</span>}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      <span
                        className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${
                          member.status === 'away'
                            ? 'bg-warning'
                            : member.status === 'sleeping'
                            ? 'status-sleeping'
                            : 'bg-success'
                        }`}
                        title={formatPresenceStatusLabel(member.status)}
                      />
                      <span className="text-sm text-text-primary truncate">
                        {member.isOwner && <Crown className="mr-1 inline h-3.5 w-3.5" />}
                        {member.displayName || member.username}
                      </span>
                    </div>
                    <div className="text-xs text-text-muted truncate">
                      @{member.username}
                      {(() => {
                        const activity = getActivitySummary(
                          member.customStatusText,
                          member.activityType,
                          member.activityText,
                          member.activityStartedAt
                        );
                        return activity ? ` • ${activity}` : null;
                      })()}
                    </div>
                  </div>
                  {renderGroupCallIndicators(member.id)}
                </div>
              ))}
            </div>
          </div>
        )}

        {groupOfflineMembers.length > 0 && (
          <>
            <div>
              <div className="space-y-0.5">
                {groupOfflineMembers.map((member) => (
                  <div
                    key={member.id}
                    onContextMenu={(e) => openGroupMemberContextMenu(e, member)}
                    onClick={() => openModal('profileView', { userId: member.id })}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-bg-hover/50 transition-colors cursor-pointer opacity-60"
                  >
                    <div className="relative w-8 h-8 rounded-full avatar-bg-muted flex items-center justify-center text-white text-sm font-semibold shrink-0 overflow-hidden">
                      <AvatarImage
                        src={resolveAvatarUrl(member.avatar, AUTH_BASE, 'central')}
                        alt={member.username}
                        size={32}
                        className="w-8 h-8 object-cover grayscale"
                        fallback={<span>{member.username.charAt(0).toUpperCase()}</span>}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1">
                        <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0 bg-text-muted/40" />
                        <span className="text-sm text-text-primary truncate">
                          {member.isOwner && <Crown className="mr-1 inline h-3.5 w-3.5" />}
                          {member.displayName || member.username}
                        </span>
                      </div>
                      <div className="text-xs text-text-muted truncate">
                        @{member.username}
                      </div>
                    </div>
                    {renderGroupCallIndicators(member.id)}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  ) : null;

  const toggleSelectedId = (
    current: string[],
    id: string,
    setValue: (next: string[]) => void,
  ) => {
    setValue(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  };

  const handleCreateGroupChat = async () => {
    if (!groupChatName.trim() || creatingGroupChat) return;
    setCreatingGroupChat(true);
    clearGroupChatError();
    try {
      const createdId = await createGroupChat(groupChatName.trim(), groupChatSelectedFriendIds, groupChatRetentionDays);
      if (createdId) {
        setGroupChatCreatorOpen(false);
        setGroupChatName('');
        setGroupChatSelectedFriendIds([]);
        setGroupChatRetentionDays(365);
      }
    } finally {
      setCreatingGroupChat(false);
    }
  };

  const handleAddMembersToActiveGroup = async () => {
    if (!activeGroupChat || groupMemberAdderSelectedIds.length === 0) return;
    clearGroupChatError();
    await addGroupChatMembers(activeGroupChat.id, groupMemberAdderSelectedIds);
    setGroupMemberAdderSelectedIds([]);
    setGroupMemberAdderOpen(false);
  };

  const handleRemoveGroupMember = (memberId: string, memberUsername: string) => {
    if (!activeGroupChat || !activeGroupChat.isOwner) return;
    setGroupMemberToRemove({ id: memberId, username: memberUsername });
  };

  const confirmRemoveGroupMember = async () => {
    if (!activeGroupChat || !activeGroupChat.isOwner || !groupMemberToRemove) return;
    clearGroupChatError();
    await removeGroupChatMember(activeGroupChat.id, groupMemberToRemove.id);
  };

  const handleGroupAvatarFileChange = async (file: File | null) => {
    if (!activeGroupChatId || !file) return;
    setUpdatingGroupAvatar(true);
    clearGroupChatError();
    try {
      await updateGroupChatAvatar(activeGroupChatId, file);
    } finally {
      setUpdatingGroupAvatar(false);
      if (groupAvatarInputRef.current) groupAvatarInputRef.current.value = '';
    }
  };

  const handleUpdateGroupRetention = async (days: number) => {
    if (!activeGroupChat || !activeGroupChat.isOwner || updatingGroupRetention) return;
    if (days === activeGroupChat.retentionDays) return;
    setUpdatingGroupRetention(true);
    clearGroupChatError();
    try {
      await updateGroupChatRetention(activeGroupChat.id, days);
    } finally {
      setUpdatingGroupRetention(false);
    }
  };

  const handleSendGroupMessage = async () => {
    if (!activeGroupChatId) return;
    const normalizedMessageText = sanitizeCompactEmoteTokens(
      groupMessageText,
      currentServerUrl,
      canUseExternalEmojis,
      canUseExternalStickers
    );

    const hasScheduleTrigger = /\B@schedule\b/i.test(groupMessageText);
    const cleanedText = hasScheduleTrigger
      ? normalizedMessageText.replace(/\B@schedule\b/gi, '').trim()
      : normalizedMessageText;

    if (hasScheduleTrigger) {
      if (!cleanedText && !selectedGroupAttachment) return;
      setPendingGroupScheduledSend({ text: cleanedText });
      setGroupScheduleModalOpen(true);
      return;
    }

    const socket = getSocket(AUTH_BASE);
    if (socket && isGroupTyping) {
      socket.emit('gc:typing:stop', { groupChatId: activeGroupChatId });
    }
    setIsGroupTyping(false);
    if (groupTypingTimeoutRef.current) {
      clearTimeout(groupTypingTimeoutRef.current);
      groupTypingTimeoutRef.current = null;
    }
    const nsfwTags = selectedGroupAttachment
      ? (Object.entries(selectedGroupAttachmentNsfwTags)
        .filter(([, enabled]) => enabled)
        .map(([tag]) => tag))
      : [];
    await sendGroupChatMessage(activeGroupChatId, cleanedText, selectedGroupAttachment, nsfwTags);
    if (!useGroupChatStore.getState().error) {
      setGroupMessageText('');
      setSelectedGroupAttachment(null);
      setSelectedGroupAttachmentNsfwTags({ gore: false, blood: false, lewd: false, spoiler: false });
      if (groupAttachmentInputRef.current) groupAttachmentInputRef.current.value = '';
      requestAnimationFrame(() => {
        const el = groupMessagesScrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  };

  const handleGroupScheduleConfirm = async (date: Date) => {
    setGroupScheduleModalOpen(false);
    if (!pendingGroupScheduledSend || !activeGroupChatId) return;

    const scheduledAt = Math.floor(date.getTime() / 1000);
    const nsfwTags = selectedGroupAttachment
      ? Object.entries(selectedGroupAttachmentNsfwTags).filter(([, v]) => v).map(([k]) => k)
      : [];

    try {
      await sendGroupChatMessage(activeGroupChatId, pendingGroupScheduledSend.text, null, nsfwTags, scheduledAt);
    } catch {
      // error handled by groupChatStore
    }

    setPendingGroupScheduledSend(null);
    setGroupMessageText('');
    setSelectedGroupAttachment(null);
    setSelectedGroupAttachmentNsfwTags({ gore: false, blood: false, lewd: false, spoiler: false });
    if (groupAttachmentInputRef.current) groupAttachmentInputRef.current.value = '';
  };

  const updateGroupMentionSuggestions = (value: string, caret: number) => {
    const upto = value.slice(0, caret);
    const at = upto.lastIndexOf('@');
    if (at === -1) { setGroupMentionOpen(false); return; }
    const before = at === 0 ? ' ' : upto[at - 1];
    if (before && !/\s/.test(before)) { setGroupMentionOpen(false); return; }
    const query = upto.slice(at + 1);
    if (query.includes(' ') || query.includes('\n')) { setGroupMentionOpen(false); return; }
    const q = query.toLowerCase();
    const items: Array<{ label: string; insert: string; type: string; description?: string; avatar?: string | null; accountType?: 'local' | 'central' }> = [];
    if ('schedule'.includes(q)) {
      items.push({ label: '@schedule', insert: '@schedule', type: 'system', description: 'Send at a future time' });
    }
    const members = activeGroupChat?.members ?? [];
    members
      .filter((m) => m.username.toLowerCase().includes(q))
      .slice(0, 8)
      .forEach((m) => items.push({
        label: `@${m.username}`,
        insert: `@${m.username}`,
        type: 'user',
        avatar: m.avatar ?? null,
        accountType: 'central',
      }));
    setGroupMentionItems(items);
    setGroupMentionIndex(0);
    setGroupMentionAnchor(at);
    setGroupMentionOpen(items.length > 0);
  };

  const applyGroupMentionSuggestion = (item: { insert: string }) => {
    const el = groupComposerTextareaRef.current;
    const caret = el?.selectionStart ?? groupMessageText.length;
    const anchor = groupMentionAnchor;
    if (anchor < 0 || anchor > caret) return;
    const before = groupMessageText.slice(0, anchor);
    const after = groupMessageText.slice(caret);
    const next = `${before}${item.insert} ${after}`;
    setGroupMentionOpen(false);
    handleGroupMessageTextChange(next);
    requestAnimationFrame(() => {
      if (!el) return;
      const pos = before.length + item.insert.length + 1;
      el.selectionStart = pos;
      el.selectionEnd = pos;
      el.focus();
    });
  };

  const handleGroupMessageComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (groupMentionOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setGroupMentionIndex((i) => (i + 1) % groupMentionItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setGroupMentionIndex((i) => (i - 1 + groupMentionItems.length) % groupMentionItems.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const item = groupMentionItems[groupMentionIndex];
        if (item) applyGroupMentionSuggestion(item);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setGroupMentionOpen(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSendGroupMessage();
    }
  };

  const handleGroupMessageTextChange = (value: string, caret?: number) => {
    setGroupMessageText(value);
    updateGroupMentionSuggestions(value, caret ?? value.length);
    if (!activeGroupChatId) return;
    const socket = getSocket(AUTH_BASE);
    if (!socket) return;

    if (!isGroupTyping && value.length > 0) {
      setIsGroupTyping(true);
      socket.emit('gc:typing:start', { groupChatId: activeGroupChatId });
    }

    if (groupTypingTimeoutRef.current) {
      clearTimeout(groupTypingTimeoutRef.current);
      groupTypingTimeoutRef.current = null;
    }

    if (value.length > 0) {
      groupTypingTimeoutRef.current = window.setTimeout(() => {
        setIsGroupTyping(false);
        socket.emit('gc:typing:stop', { groupChatId: activeGroupChatId });
        groupTypingTimeoutRef.current = null;
      }, 3000);
    } else {
      setIsGroupTyping(false);
      socket.emit('gc:typing:stop', { groupChatId: activeGroupChatId });
    }
  };

  const insertIntoGroupComposer = (insertValue: string) => {
    const token = insertValue.trim();
    if (!token) return;
    const el = groupComposerTextareaRef.current;
    const caretStart = el?.selectionStart ?? groupMessageText.length;
    const caretEnd = el?.selectionEnd ?? groupMessageText.length;
    const before = groupMessageText.slice(0, caretStart);
    const after = groupMessageText.slice(caretEnd);
    const padLeft = before.length > 0 && !/\s$/.test(before);
    const padRight = after.length > 0 && !/^\s/.test(after);
    const insertChunk = `${padLeft ? ' ' : ''}${token}${padRight ? ' ' : ''}`;
    const next = `${before}${insertChunk}${after}`;
    const nextCaret = before.length + insertChunk.length;
    handleGroupMessageTextChange(next);
    requestAnimationFrame(() => {
      const target = groupComposerTextareaRef.current;
      if (!target) return;
      target.focus();
      target.selectionStart = nextCaret;
      target.selectionEnd = nextCaret;
    });
  };

  const insertGroupUnicodeEmoji = useCallback((emoji: string) => {
    if (groupReactionPickerMessageId) {
      if (!activeGroupChatId) return;
      void toggleGroupChatReaction(activeGroupChatId, groupReactionPickerMessageId, emoji);
      setGroupReactionPickerMessageId(null);
      setGroupPickerOpen(false);
      return;
    }
    insertIntoGroupComposer(emoji);
  }, [activeGroupChatId, groupReactionPickerMessageId, toggleGroupChatReaction, insertIntoGroupComposer]);

  const insertGroupExpression = useCallback((
    kind: 'emote' | 'sticker',
    expression: ExpressionItem,
    fromServerUrl: string,
    isPersonal = false
  ) => {
    const preferredSize = kind === 'sticker' ? 320 : 64;
    const assetUrl = resolveGroupExpressionAssetUrl(expression, fromServerUrl, preferredSize);
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
    if (groupReactionPickerMessageId) {
      if (!activeGroupChatId) return;
      void toggleGroupChatReaction(activeGroupChatId, groupReactionPickerMessageId, tokenized);
      setGroupReactionPickerMessageId(null);
      setGroupPickerOpen(false);
      return;
    }
    insertIntoGroupComposer(tokenized);
    setGroupPickerOpen(false);
  }, [
    resolveGroupExpressionAssetUrl,
    user?.id,
    currentServerUrl,
    groupReactionPickerMessageId,
    activeGroupChatId,
    toggleGroupChatReaction,
    insertIntoGroupComposer,
  ]);

  const openGroupEmojiPickerForComposer = () => {
    groupComposerPickerActions.togglePickerButton();
  };

  const openGroupEmojiPickerForReactionAt = (messageId: string, event?: React.MouseEvent<HTMLButtonElement>) => {
    const nextMessageId = groupReactionPickerMessageId === messageId ? null : messageId;
    setGroupReactionPickerMessageId(nextMessageId);
    if (!nextMessageId) {
      setGroupReactionPickerAnchor(null);
      setGroupPickerOpen(false);
      return;
    }
    if (event) {
      const rect = event.currentTarget.getBoundingClientRect();
      const viewportWidth = typeof window !== 'undefined' ? (window.innerWidth || 0) : 0;
      const viewportHeight = typeof window !== 'undefined' ? (window.innerHeight || 0) : 0;
      const sideMargin = 16;
      const panelWidth = Math.min(480, Math.max(240, viewportWidth - (sideMargin * 2)));
      const panelHeight = 360;
      const clampedX = viewportWidth > 0
        ? Math.max(sideMargin, Math.min(rect.left, viewportWidth - sideMargin - panelWidth))
        : rect.left;
      const clampedY = viewportHeight > 0
        ? Math.max(sideMargin, Math.min(rect.bottom + 8, viewportHeight - sideMargin - panelHeight))
        : (rect.bottom + 8);
      setGroupReactionPickerAnchor({
        x: Math.round(clampedX),
        y: Math.round(clampedY),
      });
    }
    setGroupPickerTab('emojis');
    setGroupPickerOpen(true);
    primeGroupExpressionPickerSelection();
  };

  const closeGroupEmojiPicker = () => {
    setGroupPickerOpen(false);
    setGroupReactionPickerMessageId(null);
    setGroupReactionPickerAnchor(null);
  };

  const openGroupMemberContextMenu = (
    e: React.MouseEvent<HTMLDivElement>,
    member: { id: string; username: string; isOwner: boolean }
  ) => {
    e.preventDefault();
    setGroupMemberContextMenu({
      position: { x: e.clientX, y: e.clientY },
      member,
    });
  };

  function renderGroupCallIndicators(memberUserId: string) {
    if (!activeGroupCallForChat) return null;
    const participant = callParticipantByUserId.get(memberUserId);
    if (!participant) return null;
    return (
      <div className="flex items-center gap-1">
        {participant.muted && (
          <span className="inline-flex items-center justify-center w-4 h-4 rounded bg-red-500/20 text-red-300" title="Muted">
            <MicrophoneMutedIcon className="w-3 h-3" />
          </span>
        )}
        {participant.deafened && (
          <span className="inline-flex items-center justify-center w-4 h-4 rounded bg-amber-500/20 text-amber-300" title="Deafened">
            <AudioDeafenedIcon className="w-3 h-3" />
          </span>
        )}
        {participant.videoEnabled && (
          <span className="inline-flex items-center justify-center w-4 h-4 rounded bg-sky-500/20 text-sky-300" title="Camera enabled">
            <VideoCameraIcon className="w-3 h-3" />
          </span>
        )}
        {participant.sharingScreen && (
          <span className="inline-flex items-center justify-center w-4 h-4 rounded bg-fuchsia-500/20 text-fuchsia-300" title="Sharing screen">
            <ArrowsPointingOutIcon className="w-3 h-3" />
          </span>
        )}
      </div>
    );
  }

  const formatMessageTimestamp = (timestamp: number) => new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });

  const renderGroupChatAttachment = (message: GroupChatMessage) => {
    if (!message.attachmentUrl) return null;
    const mime = message.attachmentType || '';
    const resolvedUrl = /^https?:\/\//i.test(message.attachmentUrl)
      ? message.attachmentUrl
      : `${AUTH_BASE}${message.attachmentUrl}`;
    const primaryThumbnailUrl = message.attachments?.[0]?.thumbnailUrl ?? message.attachments?.[0]?.thumbnail_url ?? null;
    const resolvedDisplayUrl = enableImageThumbnailing && primaryThumbnailUrl
      ? (/^https?:\/\//i.test(primaryThumbnailUrl) ? primaryThumbnailUrl : `${AUTH_BASE}${primaryThumbnailUrl}`)
      : resolvedUrl;
    const isRevealed = !!revealedGroupMediaByMessageId[message.id];
    const shouldBlurAttachment = !isRevealed && shouldBlurAttachmentForNsfwTags(
      message.nsfwTags,
      { allowNsfw, nsfwLewds, nsfwBlood, nsfwGore }
    );
    const isSpoilerOnly = !isRevealed && !!(message.nsfwTags?.includes('spoiler')) && (message.nsfwTags?.length ?? 0) === 1;
    const nsfwSubtagLabels = getNsfwSubtagLabels(message.nsfwTags);
    const openGroupMedia = () => {
      openModal('mediaViewer', {
        url: resolvedUrl,
        type: mime || null,
        name: message.attachmentName ?? null,
        author: message.senderDisplayName || message.senderUsername || null,
        avatarUrl: resolveAvatarUrl(message.senderAvatar, AUTH_BASE, 'central'),
        createdAt: message.createdAt ? Math.floor(message.createdAt / 1000) : null,
        size: message.attachmentSize ?? null,
      });
    };

    if (mime.startsWith('image/')) {
      return (
        <div className="relative inline-block max-w-xl">
          <img
            src={resolvedDisplayUrl}
            alt={message.attachmentName || 'Attachment'}
            className={`mt-2 max-h-96 rounded-lg border border-border object-cover cursor-zoom-in transition-all ${
              shouldBlurAttachment ? 'blur-md brightness-50' : ''
            }`}
            loading="lazy"
            onClick={() => {
              if (shouldBlurAttachment) {
                setRevealedGroupMediaByMessageId((prev) => ({ ...prev, [message.id]: true }));
                return;
              }
              openGroupMedia();
            }}
          />
          {shouldBlurAttachment && (
            <button
              type="button"
              onClick={() => setRevealedGroupMediaByMessageId((prev) => ({ ...prev, [message.id]: true }))}
              className="absolute inset-0 mt-2 flex flex-col items-center justify-center rounded-lg bg-black/45 text-white text-xs font-medium px-2 text-center"
            >
              <span>{isSpoilerOnly ? 'Spoiler - Click to reveal' : 'NSFW Media - Click to reveal'}</span>
              {!isSpoilerOnly && (
                <span className="mt-1 text-[11px] font-normal text-white/90">
                  Subtags: [{nsfwSubtagLabels.length > 0 ? nsfwSubtagLabels.join(', ') : 'Tagged'}]
                </span>
              )}
            </button>
          )}
        </div>
      );
    }

    if (mime.startsWith('video/')) {
      return (
        <div className="relative inline-block max-w-xl">
          <video
            src={resolvedUrl}
            controls
            preload="metadata"
            className={`mt-2 max-w-xl max-h-96 rounded-lg border border-border bg-black cursor-zoom-in transition-all ${
              shouldBlurAttachment ? 'blur-md brightness-50' : ''
            }`}
            onClick={() => {
              if (shouldBlurAttachment) {
                setRevealedGroupMediaByMessageId((prev) => ({ ...prev, [message.id]: true }));
                return;
              }
              openGroupMedia();
            }}
          />
          {shouldBlurAttachment && (
            <button
              type="button"
              onClick={() => setRevealedGroupMediaByMessageId((prev) => ({ ...prev, [message.id]: true }))}
              className="absolute inset-0 mt-2 flex flex-col items-center justify-center rounded-lg bg-black/45 text-white text-xs font-medium px-2 text-center"
            >
              <span>{isSpoilerOnly ? 'Spoiler - Click to reveal' : 'NSFW Media - Click to reveal'}</span>
              {!isSpoilerOnly && (
                <span className="mt-1 text-[11px] font-normal text-white/90">
                  Subtags: [{nsfwSubtagLabels.length > 0 ? nsfwSubtagLabels.join(', ') : 'Tagged'}]
                </span>
              )}
            </button>
          )}
        </div>
      );
    }

    if (mime.startsWith('audio/')) {
      return <audio src={resolvedUrl} controls className="mt-2 w-full max-w-xl" />;
    }

    return (
      <div className="rounded-lg border border-border/70 bg-bg-elevated/40 px-3 py-2">
        <a
          href={resolvedUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-accent hover:underline break-all"
        >
          {message.attachmentName || 'Attachment'}
        </a>
        <div className="text-[11px] text-text-muted mt-0.5">
          {message.attachmentType || 'file'}
          {typeof message.attachmentSize === 'number' ? ` • ${Math.round(message.attachmentSize / 1024)} KB` : ''}
        </div>
      </div>
    );
  };

  const handleEditGroupMessage = async (messageId: string, currentText: string) => {
    if (!activeGroupChatId) return;
    const next = window.prompt('Edit message', currentText);
    if (next === null) return;
    if (!next.trim()) return;
    await editGroupChatMessage(activeGroupChatId, messageId, next);
  };

  const handleDeleteGroupMessage = async (messageId: string) => {
    if (!activeGroupChatId) return;
    if (!window.confirm('Delete this message?')) return;
    await deleteGroupChatMessage(activeGroupChatId, messageId);
  };

  const groupChatMessagePane = activeGroupChat ? (
    <>
      <div ref={groupMessagesScrollRef} className="flex-1 min-h-0 overflow-y-auto py-3 bg-bg-chat">
        {groupMessagesLoading && activeGroupMessages.length === 0 && (
          <ChatLoadingSkeleton showHeader={false} showComposer={false} />
        )}
        {!groupMessagesLoading && activeGroupMessages.length === 0 && (
          <div className="px-4 md:px-6 text-sm text-text-muted">No messages yet. Start the group chat.</div>
        )}

        <MentionProvider users={activeGroupChat?.members ?? NO_MENTION_USERS}>
        {!groupMessagesLoading && activeGroupMessages.map((message, index) => {
          if (message.messageType === 'system') {
            return (
              <SystemMessageRow
                key={message.id}
                messageType={message.messageType}
                systemType={message.systemType ?? null}
                systemData={message.systemData ?? null}
                text={message.text}
                timestampLabel={formatMessageTimestamp(message.createdAt)}
                icon="🛠"
                className="px-4 md:px-6 py-2"
              />
            );
          }

          const selfIds = new Set<string>(
            [user?.id, user?.serverUserId].filter((value): value is string => typeof value === 'string' && value.length > 0)
          );
          const isOwn = selfIds.has(message.senderId);
          const prevMessage = index > 0 ? activeGroupMessages[index - 1] : null;
          const isGrouped = !!prevMessage &&
            prevMessage.messageType !== 'system' &&
            prevMessage.senderId === message.senderId &&
            message.createdAt >= prevMessage.createdAt &&
            (message.createdAt - prevMessage.createdAt) < 300000;
          const showAvatar = !isGrouped;
          const authorName = isOwn
            ? (user?.displayName || user?.username || 'You')
            : (message.senderDisplayName || message.senderUsername);
          const authorAvatarUrl = resolveAvatarUrl(
            isOwn ? user?.avatar : message.senderAvatar,
            AUTH_BASE,
            'central'
          ) || defaultAvatarUrl();
          const authorAvatarAlt = isOwn ? (user?.username || 'You') : message.senderUsername;
          const profileUserId = message.senderId || null;
          return (
            <GroupChatMessageRow
              key={message.id}
              msg={message}
              isOwn={isOwn}
              isGrouped={isGrouped}
              showAvatar={showAvatar}
              authorName={authorName}
              authorAvatarUrl={authorAvatarUrl}
              authorAvatarAlt={authorAvatarAlt}
              profileUserId={profileUserId}
              timestampLabel={formatMessageTimestamp(message.createdAt)}
              renderAttachment={renderGroupChatAttachment}
              onOpenProfile={(userId) => openModal('profileView', { userId })}
              onToggleReaction={(messageId, emoji) => {
                if (!activeGroupChatId) return;
                void toggleGroupChatReaction(activeGroupChatId, messageId, emoji);
              }}
              onOpenReactionPicker={(messageId, event) => { openGroupEmojiPickerForReactionAt(messageId, event); }}
              onEdit={(msg) => { void handleEditGroupMessage(msg.id, msg.text); }}
              onDelete={(messageId) => { void handleDeleteGroupMessage(messageId); }}
              resolveReactorName={(userId) => {
                const member = activeGroupChat?.members.find((m) => m.id === userId);
                return member ? member.displayName || member.username : null;
              }}
            />
          );
        })}
        </MentionProvider>
      </div>

      <div className="px-4 md:px-6 py-3 border-t border-border bg-bg-sidebar/40 shrink-0">
        {groupTypingUserIds.length > 0 && (
          <div className="text-xs text-text-muted px-1 mb-2">
            {groupTypingUserIds
              .map((id) => activeGroupChat.members.find((m) => m.id === id))
              .filter((m): m is NonNullable<typeof activeGroupChat.members[number]> => Boolean(m))
              .map((m) => m.displayName || m.username)
              .join(', ')} typing...
          </div>
        )}
        {selectedGroupAttachment && (
          <ComposerSingleAttachmentChip
            file={selectedGroupAttachment}
            sizeLabel={`${Math.max(1, Math.round(selectedGroupAttachment.size / 1024))} KB`}
            nsfwTagState={selectedGroupAttachmentNsfwTags}
            onToggleNsfwTag={(tag, value) => setSelectedGroupAttachmentNsfwTags((prev) => ({ ...prev, [tag]: value }))}
            onRemove={() => {
              setSelectedGroupAttachment(null);
              setSelectedGroupAttachmentNsfwTags({ gore: false, blood: false, lewd: false, spoiler: false });
              if (groupAttachmentInputRef.current) groupAttachmentInputRef.current.value = '';
            }}
          />
        )}

        <ComposerSelfPreview content={groupMessageText} />
        <SharedComposerShell rowClassName="px-2 py-1">
          <ComposerFileButton
            inputRef={groupAttachmentInputRef}
            action={{
              disabled: groupSending,
              title: 'Attach file',
              ariaLabel: 'Attach file',
            }}
            onChange={(e) => {
              const nextFile = e.target.files?.[0] || null;
              setSelectedGroupAttachment(nextFile);
              setSelectedGroupAttachmentNsfwTags({ gore: false, blood: false, lewd: false, spoiler: false });
            }}
            multiple={false}
            className="px-2 py-2.5 text-text-muted hover:text-accent disabled:opacity-40 transition-colors"
          />
          <div ref={groupPickerRef} className="relative">
            <ComposerIconButton
              action={{
                disabled: groupSending,
                title: 'Open emoji/sticker picker',
                ariaLabel: 'Open emoji and sticker picker',
                onClick: openGroupEmojiPickerForComposer,
              }}
              className="px-2 py-2.5 text-text-muted hover:text-accent disabled:opacity-40 transition-colors"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2a10 10 0 100 20 10 10 0 000-20Zm0 18a8 8 0 110-16 8 8 0 010 16Zm-4-7a1 1 0 011.4.2A3.2 3.2 0 0012 14.5c1 0 1.93-.47 2.6-1.3a1 1 0 111.56 1.24A5.2 5.2 0 0112 16.5a5.2 5.2 0 01-4.16-2.06 1 1 0 01.16-1.44ZM9 10a1.25 1.25 0 100-2.5A1.25 1.25 0 009 10Zm6 0a1.25 1.25 0 100-2.5A1.25 1.25 0 0015 10Z" />
              </svg>
            </ComposerIconButton>
            {groupPickerOpen && (
              <SharedExpressionPickerPanel
                className="w-[30rem] max-w-[calc(100vw-2rem)]"
                floatingPosition={groupReactionPickerMessageId ? groupReactionPickerAnchor : null}
                pickerTab={groupPickerTab}
                onPickerTabChange={setGroupPickerTab}
                gifPickerEnabled={user?.accountType === 'central' && !groupReactionPickerMessageId}
                onSelectGif={(gifUrl) => {
                  if (!activeGroupChatId) return;
                  void sendGroupChatMessage(activeGroupChatId, gifUrl, null, []);
                  closeGroupEmojiPicker();
                }}
                searchValue={groupEmojiSearchQuery}
                onSearchChange={setGroupEmojiSearchQuery}
                onClose={closeGroupEmojiPicker}
                headerPrefix={groupReactionPickerMessageId ? (
                  <span className="text-[11px] uppercase tracking-wide text-accent">Add Reaction</span>
                ) : null}
                sidebar={(
                  <SharedExpressionPickerSidebar
                    entries={groupVisibleExpressionServers}
                    selectedUrl={effectiveGroupSelectedServerUrl}
                    pickerTab={groupPickerTab}
                    isExternalBlocked={(entry, tab) => {
                      const isExternal = !entry.isDefault && !entry.isPersonal && !!(currentServerUrl && entry.url !== currentServerUrl);
                      return isExternal && ((tab === 'emojis' && !canUseExternalEmojis) || (tab === 'stickers' && !canUseExternalStickers));
                    }}
                    onSelect={selectGroupExpressionPickerServer}
                  />
                )}
              >
                <SharedExpressionPickerBodyState
                  hasSelectedServer={!!groupSelectedServer}
                  loading={!!groupSelectedServer && !!groupSelectedServerState?.loading}
                  error={groupSelectedServer ? (groupSelectedServerState?.error ?? null) : null}
                  onRetry={groupSelectedServer ? retrySelectedGroupExpressionServer : undefined}
                >
                  {groupSelectedServer && groupSelectedManifest && groupPickerTab === 'emojis' && (
                    <SharedExpressionTabContent
                      warningText={!groupSelectedServer.isDefault && groupSelectedIsExternal && !canUseGroupSelectedEmojiServer
                        ? 'External emojis are not allowed for your current permissions.'
                        : null}
                      isDefault={!!groupSelectedServer.isDefault}
                      defaultContent={(
                        <SharedDefaultEmojiPicker
                          hasSearchQuery={hasGroupEmojiSearchQuery}
                          selectedCategoryName={groupDefaultEmojiCategory}
                          categories={DEFAULT_EMOJI_CATEGORIES}
                          onSelectCategory={(categoryName) => setGroupDefaultEmojiCategory(categoryName as DefaultEmojiCategory)}
                          emojiMetadataLoaded={!!groupEmojiMetadataLookup}
                          entries={filteredGroupDefaultEmojiEntries}
                          onSelectEmoji={insertGroupUnicodeEmoji}
                        />
                      )}
                      nonDefaultContent={(
                        <SharedEmotePickerGrid
                          isPersonal={!!groupSelectedServer.isPersonal}
                          hasSearchQuery={hasGroupEmojiSearchQuery}
                          items={filteredGroupSelectedEmoteItems}
                          disabled={!groupSelectedServer.isPersonal && groupSelectedIsExternal && !canUseGroupSelectedEmojiServer}
                          resolveAssetUrl={(item) => resolveGroupExpressionAssetUrl(item.expression, item.sourceUrl, 32)}
                          onSelect={(item) => insertGroupExpression('emote', item.expression, item.sourceUrl, !!groupSelectedServer.isPersonal)}
                        />
                      )}
                    />
                  )}
                  {groupSelectedServer && groupSelectedManifest && groupPickerTab === 'stickers' && (
                    <SharedExpressionTabContent
                      warningText={!groupSelectedServer.isDefault && groupSelectedIsExternal && !canUseGroupSelectedStickerServer
                        ? 'External stickers are not allowed for your current permissions.'
                        : null}
                      isDefault={!!groupSelectedServer.isDefault}
                      defaultFallbackText="Default stickers are not available."
                      nonDefaultContent={(
                        <SharedStickerPickerGrid
                          isPersonal={!!groupSelectedServer.isPersonal}
                          hasSearchQuery={hasGroupEmojiSearchQuery}
                          items={filteredGroupSelectedStickerItems}
                          disabled={!groupSelectedServer.isPersonal && groupSelectedIsExternal && !canUseGroupSelectedStickerServer}
                          resolveAssetUrl={(item) => resolveGroupExpressionAssetUrl(item.expression, item.sourceUrl, 320)}
                          onSelect={(item) => insertGroupExpression('sticker', item.expression, item.sourceUrl, !!groupSelectedServer.isPersonal)}
                        />
                      )}
                    />
                  )}
                </SharedExpressionPickerBodyState>
              </SharedExpressionPickerPanel>
            )}
          </div>
          <textarea
            ref={groupComposerTextareaRef}
            value={groupMessageText}
            onChange={(e) => handleGroupMessageTextChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onKeyDown={handleGroupMessageComposerKeyDown}
            rows={1}
            placeholder={`Message ${activeGroupChat.name}`}
            className="flex-1 resize-none bg-transparent px-1 py-2 text-sm leading-5 text-text-primary placeholder:text-text-muted outline-none"
          />
          <ComposerSendButton
            action={{
              disabled: groupSending || (!groupMessageText.trim() && !selectedGroupAttachment),
              title: groupSending ? 'Sending...' : 'Send',
              ariaLabel: groupSending ? 'Sending...' : 'Send',
              onClick: () => { void handleSendGroupMessage(); },
            }}
            ready={!!groupMessageText.trim() || !!selectedGroupAttachment}
          />
        </SharedComposerShell>
      </div>
      <ComposerMentionSuggestionList
        open={groupMentionOpen}
        items={groupMentionItems}
        activeIndex={groupMentionIndex}
        authBase={AUTH_BASE}
        onSelect={applyGroupMentionSuggestion}
      />
      {(scheduledGCMessages[activeGroupChatId ?? '']?.length ?? 0) > 0 && (
        <div className="px-4 py-2 border-t border-border bg-bg-elevated/60 flex flex-col gap-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-0.5">Scheduled</p>
          {(scheduledGCMessages[activeGroupChatId ?? ''] ?? []).map((msg) => {
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
                    publishScheduledGC(msg.id, activeGroupChatId ?? '');
                    void deleteGroupChatMessage(activeGroupChatId ?? '', msg.id);
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
      <ScheduleMessageModal
        open={groupScheduleModalOpen}
        context="server"
        onConfirm={handleGroupScheduleConfirm}
        onClose={() => setGroupScheduleModalOpen(false)}
      />
    </>
  ) : null;

  // DMs tab uses a different layout (split pane)
  if (tab === 'messageRequests') return <MessageRequests onOpen={() => setTab?.('dms')} />;
  if (tab === 'dms') {
    return (
      <div className="flex-1 bg-bg-primary flex min-w-0">
        <DMView />
      </div>
    );
  }

  if (tab === 'groupChats') {
    return (
      <div className="flex-1 bg-bg-primary flex flex-col min-w-0">
        <div className="flex-1 min-h-0 flex flex-col">
          {groupChatError && (
            <div className="mx-4 mt-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-red-200 shrink-0">
              {groupChatError}
            </div>
          )}

          {groupChats.length === 0 ? (
            <div className="flex-1 min-h-0 overflow-y-auto p-6">
              <div className="h-full min-h-[240px] rounded-xl border border-border bg-bg-elevated/40 flex items-center justify-center">
                <div className="px-6 text-center">
                  <p className="text-sm font-medium text-text-primary">No group chats yet.</p>
                  <p className="mt-1 text-sm text-text-muted">
                    Create a group chat to add friends directly (no invite flow) and manage retention as the owner.
                  </p>
                </div>
              </div>
            </div>
          ) : !activeGroupChat ? (
            <div className="flex-1 min-h-0 overflow-y-auto p-6">
              <div className="h-full min-h-[240px] rounded-xl border border-border bg-bg-elevated/40 flex items-center justify-center">
                <p className="text-sm text-text-muted">Select a group chat from the left to view messages and members.</p>
              </div>
            </div>
          ) : (
            <div className="relative flex-1 min-h-0 flex flex-col md:flex-row">
              <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                <div className="h-12 px-4 md:px-6 border-b border-border shadow-sm bg-bg-chat flex items-center gap-2 shrink-0">
                  {onMobileBack && (
                    <button
                      type="button"
                      onClick={onMobileBack}
                      className="text-text-secondary hover:text-text-primary p-1 -ml-2 shrink-0"
                      aria-label="Back to chats"
                    >
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M19 12H5M12 19l-7-7 7-7" />
                      </svg>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => groupAvatarInputRef.current?.click()}
                    className="relative shrink-0 rounded-full focus:outline-none focus:ring-2 focus:ring-accent/50"
                    title="Change group photo"
                    disabled={updatingGroupAvatar}
                  >
                    <AvatarImage
                      src={activeGroupAvatarUrl || undefined}
                      alt={activeGroupChat.name}
                      size={28}
                      className={`w-7 h-7 rounded-full object-cover ${updatingGroupAvatar ? 'opacity-70' : ''}`}
                      fallback={(
                        <span
                          className="w-full h-full rounded-full overflow-hidden flex items-center justify-center text-[24px] leading-none"
                          style={{ backgroundColor: activeGroupAvatarBg }}
                        >
                          <Users className="h-5 w-5" />
                        </span>
                      )}
                    />
                    <span className="absolute -bottom-1 -right-1 w-3.5 h-3.5 rounded-full bg-bg-elevated border border-border text-[9px] text-text-muted flex items-center justify-center">
                      {updatingGroupAvatar ? '…' : '+'}
                    </span>
                  </button>
                  <input
                    ref={groupAvatarInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => { void handleGroupAvatarFileChange(e.target.files?.[0] || null); }}
                  />
                  {!onMobileBack && <span className="text-text-muted font-bold text-base">#</span>}
                  <h4 className={`font-semibold text-text-primary truncate min-w-0 ${onMobileBack ? 'flex-1' : ''}`}>
                    {activeGroupChat.isOwner && <Crown className="mr-1 inline h-4 w-4" />}
                    {activeGroupChat.name}
                  </h4>
                  <div className="hidden md:block w-px h-5 bg-border mx-1 shrink-0" />
                  <span className="hidden md:block text-sm text-text-muted truncate min-w-0">
                    Group chat
                  </span>
                  {!onMobileBack && <div className="flex-1" />}
                  <div className="flex items-center gap-2 shrink-0">
                    {/* One call button, like DMs: camera is turned on from inside the call. */}
                    {!hasOngoingGroupCallForChat && (
                      <button
                        type="button"
                        onClick={() => { void handleStartGroupAudioCall(); }}
                        className="w-9 h-9 flex items-center justify-center rounded-lg bg-bg-elevated hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
                        title="Start call"
                        aria-label="Start call"
                      >
                        <PhoneIcon className="w-5 h-5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setGroupMemberListOpen(true)}
                      className="md:hidden w-9 h-9 flex items-center justify-center rounded-lg bg-bg-elevated hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
                      title="Show members"
                      aria-label="Show members"
                    >
                      <UsersIcon className="w-5 h-5" />
                    </button>
                    {/* Small screens change the photo by tapping the group avatar. */}
                    {!onMobileBack && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => groupAvatarInputRef.current?.click()}
                        disabled={updatingGroupAvatar}
                      >
                        {updatingGroupAvatar ? 'Updating...' : 'Change Photo'}
                      </Button>
                    )}
                    {groupHasOlderMessages && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => { if (activeGroupChatId) void loadOlderGroupChatMessages(activeGroupChatId); }}
                        disabled={groupMessagesLoading || !activeGroupChatId}
                      >
                        {groupMessagesLoading ? 'Loading...' : 'Load Older'}
                      </Button>
                    )}
                    {activeGroupChat.isOwner && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          clearGroupChatError();
                          setGroupMemberAdderSelectedIds([]);
                          setGroupFriendSearch('');
                          setGroupMemberAdderOpen(true);
                        }}
                      >
                        {onMobileBack ? 'Add' : 'Add Members'}
                        </Button>
                      )}
                    {!onMobileBack && (
                    <button
                      type="button"
                      onClick={() => setGroupEncryptionInfoOpen(true)}
                      className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-emerald-300 bg-emerald-900/30 border border-emerald-700/60"
                      title="Encrypted group chat"
                    >
                      <Lock className="h-3.5 w-3.5" />
                      Encrypted
                    </button>
                    )}
                    {activeGroupChat.isOwner && (
                      <button
                        type="button"
                        onClick={() => {
                          clearGroupChatError();
                          setGroupRetentionSettingsOpen(true);
                        }}
                        className="w-9 h-9 flex items-center justify-center rounded-lg bg-bg-elevated hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
                        title="Group retention settings"
                        aria-label="Group retention settings"
                      >
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
                {/* A call you're not in: the same call pane DMs keep open after you
                    leave, with everyone in it and a Join button (in the call,
                    GroupCallPanel below is the call UI). */}
                {!activeGroupCallForChat && incomingGroupCallForChat && (
                  <div className="flex flex-col items-center gap-4 pt-6 pb-5 bg-gradient-to-b from-bg-secondary to-bg-primary border-b border-border">
                    <div className={`grid w-full gap-3 px-4 md:gap-4 ${
                      groupCallPaneParticipants.length + 1 <= 2
                        ? 'max-w-xl grid-cols-2'
                        : groupCallPaneParticipants.length + 1 === 3
                          ? 'max-w-2xl grid-cols-3'
                          : 'max-w-4xl grid-cols-2 md:grid-cols-4'
                    }`}>
                      {groupCallPaneParticipants.map((participant) => (
                        <VoiceParticipantTile
                          key={participant.userId}
                          name={participant.name}
                          avatarUrl={participant.avatarUrl}
                          ringClassName={getVoiceRingClass({ muted: false, deafened: false })}
                          status={<span className="text-[10px] text-emerald-300">In call</span>}
                          square
                        />
                      ))}
                      <VoiceParticipantTile
                        name={user?.displayName || user?.username || 'You'}
                        avatarUrl={resolveAvatarUrl(user?.avatar ?? undefined, AUTH_BASE, 'central') ?? defaultAvatarUrl()}
                        ringClassName={getVoiceRingClass({ muted: false, deafened: false })}
                        status={<span className="text-[10px] text-white/55">Not in call</span>}
                        dimmed
                        square
                      />
                    </div>
                    <div className="text-xs text-text-muted">
                      {incomingGroupCallForChat.initiatorName || 'Someone'} started {incomingGroupCallForChat.mediaType === 'video' ? 'a video' : 'an audio'} call
                      {' · '}{groupCallPaneParticipants.length} in call
                    </div>
                    <button
                      type="button"
                      onClick={() => { void handleJoinActiveGroupCall(); }}
                      title="Join call"
                      aria-label="Join call"
                      className="w-14 h-14 rounded-2xl flex items-center justify-center bg-success hover:bg-success/90 text-white transition-colors"
                    >
                      <PhoneIcon className="w-6 h-6" />
                    </button>
                  </div>
                )}

                {activeGroupCallForChat ? (
                  <div className="relative flex-1 min-h-0 flex bg-bg-chat">
                    <div className="flex-1 min-w-0 min-h-0">
                      <Suspense fallback={null}>
                        <GroupCallPanel
                          messageChatOpen={groupCallMessageChatOpen}
                          onToggleMessageChat={() => setGroupCallMessageChatOpen((prev) => !prev)}
                        />
                      </Suspense>
                    </div>
                    <div
                      className={`bg-bg-chat flex flex-col min-h-0 transition-all duration-300 ease-out overflow-hidden fixed md:relative inset-0 md:inset-auto z-20 md:z-auto ${
                        groupCallMessageChatOpen ? 'w-full md:w-[420px] translate-x-0 opacity-100 border-l border-border' : 'w-0 translate-x-full opacity-0 pointer-events-none'
                      }`}
                    >
                      <div className="h-12 px-4 flex items-center gap-2 border-b border-border shadow-sm shrink-0">
                        <span className="text-text-muted">#</span>
                        <h3 className="font-semibold text-text-primary">Message Chat</h3>
                        <span className="text-xs text-text-muted truncate">
                          {activeGroupChat.name}
                        </span>
                        <div className="flex-1" />
                        <button
                          type="button"
                          onClick={() => setGroupCallMessageChatOpen(false)}
                          className="text-xs text-text-muted hover:text-text-primary transition-colors"
                        >
                          Close
                        </button>
                      </div>
                      {groupChatMessagePane}
                    </div>
                    {groupCallMessageChatOpen && (
                      <div
                        className="fixed inset-0 bg-black/50 z-10 md:hidden"
                        onClick={() => setGroupCallMessageChatOpen(false)}
                      />
                    )}
                  </div>
                ) : (
                  groupChatMessagePane
                )}
              </div>

              <div className="hidden md:flex md:w-60 shrink-0 border-l border-border bg-bg-sidebar flex-col min-h-0">
                {groupMemberListPane}
              </div>

              <div className="md:hidden">
                {groupMemberListOpen && (
                  <div
                    className="absolute inset-0 bg-black/50 z-20"
                    onClick={() => setGroupMemberListOpen(false)}
                  />
                )}
                <div className="absolute inset-y-0 right-0 z-30 pointer-events-none">
                  <div
                    className={`h-full transition-all duration-300 ease-out overflow-hidden ${
                      groupMemberListOpen
                        ? 'w-[85vw] max-w-xs opacity-100 translate-x-0 pointer-events-auto'
                        : 'w-0 opacity-0 translate-x-full'
                    }`}
                  >
                    <div className="h-full border-l border-border bg-bg-sidebar flex flex-col min-h-0 shadow-xl">
                      {groupMemberListPane}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        {groupMemberContextMenu && (
          <MessageContextMenu
            items={groupMemberContextMenuItems}
            position={groupMemberContextMenu.position}
            onClose={() => setGroupMemberContextMenu(null)}
          />
        )}
        <ConfirmDialog
          open={!!groupMemberToRemove}
          onClose={() => setGroupMemberToRemove(null)}
          onConfirm={() => { void confirmRemoveGroupMember(); }}
          title="Remove Member"
          message={
            <>
              Remove <strong>{groupMemberToRemove?.username}</strong> from <strong>{activeGroupChat?.name}</strong>?
            </>
          }
          confirmText="Remove Member"
          cancelText="Cancel"
          variant="danger"
        />
        <Modal
          open={groupChatCreatorOpen}
          onClose={() => setGroupChatCreatorOpen(false)}
          title="Create A Group Chat"
        >
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
                Group Chat Name
              </label>
              <Input
                value={groupChatName}
                onChange={(e) => setGroupChatName(e.target.value)}
                placeholder="Weekend squad"
                maxLength={80}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
                Retention
              </label>
              <select
                value={groupChatRetentionDays}
                onChange={(e) => setGroupChatRetentionDays(Number(e.target.value))}
                className="w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary"
              >
                {allowedGroupRetentionOptions.map((days) => (
                  <option key={days} value={days} className="bg-bg-elevated">
                    {days === 365 ? '1 year' : days === 1825 ? '5 years' : `${days} days`}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
                Add Friends (Directly, No Invite)
                {groupChatSelectedFriendIds.length > 0 && (
                  <span className="ml-1 normal-case tracking-normal font-normal">· {groupChatSelectedFriendIds.length} selected</span>
                )}
              </label>
              {friends.length > 0 && (
                <div className="relative mb-2">
                  <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
                  <Input
                    value={groupFriendSearch}
                    onChange={(e) => setGroupFriendSearch(e.target.value)}
                    placeholder="Search friends"
                    aria-label="Search friends"
                    className="pl-9"
                  />
                </div>
              )}
              <div className="max-h-56 overflow-y-auto rounded-lg border border-border bg-bg-input/40 divide-y divide-border/50">
                {friends.length === 0 ? (
                  <div className="px-3 py-3 text-sm text-text-muted">You need friends before creating a group chat.</div>
                ) : creatorFriendMatches.length === 0 ? (
                  <div className="px-3 py-3 text-sm text-text-muted">No friends match "{groupFriendSearch.trim()}".</div>
                ) : (
                  creatorFriendMatches.map((friend) => {
                    const checked = groupChatSelectedFriendIds.includes(friend.id);
                    return (
                      <label key={friend.id} className="px-3 py-2 flex items-center gap-3 cursor-pointer hover:bg-bg-hover/40">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSelectedId(groupChatSelectedFriendIds, friend.id, setGroupChatSelectedFriendIds)}
                          className="accent-current"
                        />
                        <div className="w-8 h-8 rounded-full avatar-bg overflow-hidden flex items-center justify-center shrink-0">
                          <AvatarImage
                            src={resolveAvatarUrl(friend.avatar, AUTH_BASE, 'central')}
                            alt={friend.username}
                            size={32}
                            className="w-8 h-8 object-cover"
                            fallback={<span>{friend.username.charAt(0).toUpperCase()}</span>}
                          />
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm text-text-primary truncate">{friend.username}</div>
                          <div className="text-xs text-text-muted truncate">
                            {getActivitySummary(
                              friend.customStatusText,
                              friend.activityType,
                              friend.activityText,
                              friend.activityStartedAt
                            ) || formatStatus(friend.status)}
                          </div>
                        </div>
                      </label>
                    );
                  })
                )}
              </div>
            </div>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => setGroupChatCreatorOpen(false)}>
                Close
              </Button>
              <Button
                className="ml-2"
                onClick={() => { void handleCreateGroupChat(); }}
                disabled={creatingGroupChat || !groupChatName.trim()}
              >
                {creatingGroupChat ? 'Creating...' : 'Create A Group Chat'}
              </Button>
            </div>
          </div>
        </Modal>
        <Modal
          open={groupMemberAdderOpen}
          onClose={() => setGroupMemberAdderOpen(false)}
          title="Add Members"
        >
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              Only the owner can add members, and they must already be your friends.
              {groupMemberAdderSelectedIds.length > 0 && ` · ${groupMemberAdderSelectedIds.length} selected`}
            </p>
            {eligibleFriendsForActiveGroup.length > 0 && (
              <div className="relative">
                <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
                <Input
                  value={groupFriendSearch}
                  onChange={(e) => setGroupFriendSearch(e.target.value)}
                  placeholder="Search friends"
                  aria-label="Search friends"
                  className="pl-9"
                />
              </div>
              )}
            <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-bg-input/40 divide-y divide-border/50">
              {eligibleFriendsForActiveGroup.length === 0 ? (
                <div className="px-3 py-3 text-sm text-text-muted">No eligible friends to add.</div>
              ) : adderFriendMatches.length === 0 ? (
                <div className="px-3 py-3 text-sm text-text-muted">No friends match "{groupFriendSearch.trim()}".</div>
              ) : (
                adderFriendMatches.map((friend) => (
                  <label key={friend.id} className="px-3 py-2 flex items-center gap-3 cursor-pointer hover:bg-bg-hover/40">
                    <input
                      type="checkbox"
                      checked={groupMemberAdderSelectedIds.includes(friend.id)}
                      onChange={() => toggleSelectedId(groupMemberAdderSelectedIds, friend.id, setGroupMemberAdderSelectedIds)}
                      className="accent-current"
                    />
                    <div className="w-8 h-8 rounded-full avatar-bg overflow-hidden flex items-center justify-center shrink-0">
                      <AvatarImage
                        src={resolveAvatarUrl(friend.avatar, AUTH_BASE, 'central')}
                        alt={friend.username}
                        size={32}
                        className="w-8 h-8 object-cover"
                        fallback={<span>{friend.username.charAt(0).toUpperCase()}</span>}
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm text-text-primary truncate">{friend.username}</div>
                      <div className="text-xs text-text-muted truncate">
                        {getActivitySummary(
                          friend.customStatusText,
                          friend.activityType,
                          friend.activityText,
                          friend.activityStartedAt
                        ) || formatStatus(friend.status)}
                      </div>
                    </div>
                  </label>
                ))
              )}
            </div>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => setGroupMemberAdderOpen(false)}>
                Close
              </Button>
              <Button
                className="ml-2"
                onClick={() => { void handleAddMembersToActiveGroup(); }}
                disabled={groupMemberAdderSelectedIds.length === 0}
              >
                Add Members
              </Button>
            </div>
          </div>
        </Modal>
        <Modal
          open={groupRetentionSettingsOpen}
          onClose={() => setGroupRetentionSettingsOpen(false)}
          title="Group Retention Settings"
        >
          {activeGroupChat && activeGroupChat.isOwner ? (
            <div className="space-y-4">
              <p className="text-sm text-text-secondary">
                As the owner, you control message retention for this group chat.
              </p>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
                  Message Retention
                </label>
                <select
                  value={activeGroupChat.retentionDays}
                  onChange={(e) => { void handleUpdateGroupRetention(Number(e.target.value)); }}
                  disabled={updatingGroupRetention}
                  className="w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary"
                >
                  {allowedGroupRetentionOptions.map((days) => (
                    <option key={days} value={days} className="bg-bg-elevated">
                      {days === 365 ? '1 year' : days === 1825 ? '5 years' : `${days} days`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="rounded-lg border border-border bg-bg-input/40 p-3 text-xs text-text-muted space-y-1">
                <p>Messages use the selected retention period.</p>
                <p>Attachments follow your retention setting (7-180 days exact).</p>
                <p>At 1 year+, files over 25MB expire in 90 days and files at/under 25MB expire in 180 days.</p>
              </div>
              <div className="flex justify-end">
                <Button variant="secondary" onClick={() => setGroupRetentionSettingsOpen(false)}>
                  Close
                </Button>
              </div>
            </div>
          ) : (
            <div className="text-sm text-text-muted">Only the owner can change retention settings.</div>
          )}
        </Modal>
        <Modal
          open={groupEncryptionInfoOpen}
          onClose={() => setGroupEncryptionInfoOpen(false)}
          title="Group Chat Encryption"
        >
          {activeGroupChat ? (
            <div className="space-y-3 text-sm text-text-secondary">
              <p>
                Group chats use encrypted messages with versioned group keys.
              </p>
              <p>
                When the owner removes a member, the group key rotates for future messages so removed members cannot decrypt new messages.
              </p>
              <p>
                Removed members also lose access to the group chat and its message history in the official client.
              </p>
              <p className="text-xs text-text-muted">
                Already-downloaded plaintext on a removed member&apos;s device cannot be remotely revoked.
              </p>
              <div className="rounded-lg border border-border bg-bg-input/40 p-3 text-xs text-text-muted">
                Current key version: KV{activeGroupChat.activeKeyVersion}
              </div>
              <div className="flex justify-end">
                <Button variant="secondary" onClick={() => setGroupEncryptionInfoOpen(false)}>
                  Close
                </Button>
              </div>
            </div>
          ) : (
            <div className="text-sm text-text-muted">No active group chat selected.</div>
          )}
        </Modal>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-bg-primary flex flex-col min-w-0">
      <div className="px-6 h-12 flex items-center justify-between border-b border-border shrink-0">
        <h3 className="text-sm font-semibold text-text-primary">
          {tab === 'notifications' && t('nav.notifications')}
          {tab === 'friends' && t('nav.friendsList')}
          {tab === 'pending' && t('nav.pendingRequests')}
          {tab === 'add' && t('nav.addFriend')}
          {tab === 'discover' && t('discover.title')}
          {tab === 'notes' && (
            <span className="flex items-center gap-1">
              {t('nav.myNotes')}
              <span className="text-text-muted font-normal"> / </span>
              <span className="text-text-muted font-normal">
                {notesActiveId && notesActiveTitle ? notesActiveTitle || t('notes.untitled') : t('notes.home')}
              </span>
            </span>
          )}
        </h3>
        {tab === 'friends' && (
          <div className="flex items-center gap-2">
            {personalRoles.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditingRoleId(null);
                  setConfirmDeleteRoleId(null);
                  setRoleManagerOpen(true);
                }}
              >
                {t('friends.manageRoles')}
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => {
                clearError();
                setPersonalRoleModalOpen(true);
              }}
              disabled={personalRoles.length >= 69}
            >
              {t('friends.createPersonalRole')}
            </Button>
          </div>
        )}
        {tab === 'notifications' && (notificationItems.length > 0 || (notificationSummary?.totalUnread ?? 0) > 0) && (
          <Button size="sm" variant="ghost" onClick={() => { void markAllNotificationsRead(); }}>
            Mark all read
          </Button>
        )}
        {tab === 'discover' && (
          <Button
            size="sm"
            className="discover-add-server-button"
            onClick={() => {
              void openDiscoveryManageModal();
            }}
          >
            {t('discover.addYourServer')}
          </Button>
        )}
        {tab === 'notes' && (
          <div className="flex flex-col items-end gap-0.5 min-w-32">
            <div className="flex items-center justify-between w-full">
              <span className="text-xs font-medium text-text-muted">{t('notes.storage')}</span>
              <span className="text-xs text-text-muted">
                {notesStorageUsed < 1024
                  ? `${notesStorageUsed} B`
                  : notesStorageUsed < 1024 * 1024
                    ? `${(notesStorageUsed / 1024).toFixed(1)} KB`
                    : `${(notesStorageUsed / (1024 * 1024)).toFixed(2)} MB`} / 10MB
              </span>
            </div>
            <div className="h-1 w-full rounded-full bg-bg-input overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  notesStorageUsed / (10 * 1024 * 1024) >= 0.9
                    ? 'bg-danger'
                    : notesStorageUsed / (10 * 1024 * 1024) >= 0.7
                      ? 'bg-amber-400'
                      : 'bg-accent'
                }`}
                style={{ width: `${Math.min((notesStorageUsed / (10 * 1024 * 1024)) * 100, 100)}%` }}
              />
            </div>
          </div>
        )}
      </div>

      <div className={`flex-1 min-h-0 ${tab !== 'notes' ? 'overflow-y-auto p-6' : 'overflow-hidden'}`}>
        {/* Personal Notes */}
        {tab === 'notes' && <PersonalNotesView />}

        {/* Notifications */}
        {tab === 'notifications' && (
          <div className="max-w-3xl space-y-3">
            <div className="rounded-xl border border-border bg-bg-elevated/50 p-3 space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {([
                  ['all', 'All'],
                  ['unread', 'Unread'],
                  ['dms', 'DMs'],
                  ['mentions', 'Mentions'],
                  ['friends', 'Friends'],
                ] as Array<[NotificationFilter, string]>).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setNotificationFilter(value)}
                    className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                      notificationFilter === value
                        ? 'bg-accent text-white'
                        : 'bg-bg-input text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                    }`}
                  >
                    {label}
                    {notificationFilterCounts[value] > 0 && (
                      <span className="ml-1.5 opacity-80">{notificationFilterCounts[value]}</span>
                    )}
                  </button>
                ))}
              </div>

              {notificationRealmOptions.length > 0 && (
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Realm filter</p>
                    <p className="text-xs text-text-muted">Target server mentions from one connected realm.</p>
                  </div>
                  <select
                    value={notificationRealmFilter}
                    onChange={(event) => {
                      const nextRealm = event.target.value;
                      setNotificationRealmFilter(nextRealm);
                      if (nextRealm !== 'all') setNotificationFilter('mentions');
                    }}
                    className="min-w-0 rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary sm:min-w-56"
                  >
                    <option value="all">All realms</option>
                    {notificationRealmOptions.map((option) => (
                      <option key={option.url} value={option.url}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {notificationItems.length === 0 ? (
              <div className="rounded-xl border border-border bg-bg-elevated/60 px-5 py-10 text-center">
                <p className="text-sm text-text-muted">You're all caught up.</p>
              </div>
            ) : filteredNotificationItems.length === 0 ? (
              <div className="rounded-xl border border-border bg-bg-elevated/60 px-5 py-10 text-center">
                <p className="text-sm text-text-muted">No notifications match these filters.</p>
              </div>
            ) : (
              filteredNotificationItems.map((notification) => {
                const payload = notification.payload ?? {};
                const preview = typeof payload.contentPreview === 'string' ? payload.contentPreview : null;
                return (
                  <button
                    key={notification.id}
                    type="button"
                    onClick={() => { void openNotification(notification); }}
                    className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${
                      notification.readAt
                        ? 'border-border bg-bg-elevated/40 hover:bg-bg-hover/40'
                        : 'border-accent/45 bg-accent/10 hover:bg-accent/15'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        {(() => {
                          const payloadAvatar = typeof payload.otherAvatar === 'string'
                            ? payload.otherAvatar
                            : typeof payload.fromAvatar === 'string'
                              ? payload.fromAvatar
                              : null;
                          const payloadName = String(payload.otherDisplayName ?? payload.otherUsername ?? payload.fromUsername ?? notification.actorName ?? 'Someone');
                          const avatarUrl = resolveAvatarUrl(payloadAvatar ?? undefined, AUTH_BASE, 'central');
                          return (
                            <AvatarImage
                              src={avatarUrl}
                              alt={payloadName}
                              size={36}
                              fallback={<span className="flex h-9 w-9 items-center justify-center rounded-full bg-bg-hover text-xs text-text-secondary">{payloadName.slice(0, 1).toUpperCase()}</span>}
                              className="h-9 w-9 shrink-0 rounded-full object-cover"
                            />
                          );
                        })()}
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-text-primary">{notificationLabel(notification)}</p>
                          {preview && (
                            <p className="mt-1 truncate text-xs text-text-secondary">{preview}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {!notification.readAt && <span className="h-2 w-2 rounded-full bg-accent" />}
                        <span className="text-xs text-text-muted">{notificationTimeAgo(notification.createdAt)}</span>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        )}

        {/* Friends List */}
        {tab === 'friends' && (
          <div className="space-y-1 max-w-2xl">
            <div className="rounded-xl border border-border bg-bg-elevated/60 p-3 mb-3 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase text-text-muted">{t('friends.personalRolesPrivate')}</p>
                <span className="text-xs text-text-muted">{personalRoles.length}/69</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className={`px-2 py-1 rounded-full text-xs border ${roleFilter === 'all' ? 'border-accent text-text-primary bg-bg-hover/60' : 'border-border text-text-muted hover:text-text-primary'}`}
                  onClick={() => setRoleFilter('all')}
                >
                  {t('friends.allFriends')}
                </button>
                {personalRoles.map((role) => (
                  <button
                    key={role.id}
                    className={`px-2 py-1 rounded-full text-xs border ${
                      roleFilter === role.id
                        ? 'bg-bg-hover/60'
                        : 'border-border text-text-muted hover:text-text-primary'
                    }`}
                    style={roleFilter === role.id
                      ? { borderColor: role.color || undefined, color: role.color || undefined }
                      : undefined}
                    onClick={() => setRoleFilter(role.id)}
                    title={t('friends.assigned', { count: role.friendCount })}
                  >
                    {role.name}
                  </button>
                ))}
              </div>
            </div>

            {friends.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-text-muted text-sm">{t('friends.noFriends')}</p>
              </div>
            ) : (
              filteredFriends.map((friend) => (
                (() => {
                  const effectiveFriendStatus = friend.status ?? friendStatusOverrideById.get(friend.id);
                  return (
                <div
                  key={friend.id}
                  className="group relative h-44 rounded-2xl border border-indigo-400/50 bg-bg-elevated/80 overflow-hidden transition-all hover:border-indigo-300/70 hover:shadow-[0_0_0_1px_rgba(129,140,248,0.45),0_12px_32px_rgba(79,70,229,0.2)]"
                >
                  <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute top-0 right-0 w-56 h-56 bg-indigo-400/15 blur-3xl rounded-full translate-x-24 -translate-y-24" />
                  </div>

                  <div className="absolute inset-0 overflow-hidden border border-indigo-300/30 bg-bg-input origin-top-right transform-gpu will-change-transform transition-transform duration-500 ease-out group-hover:scale-x-[0.72] group-hover:scale-y-[0.56] group-hover:-translate-x-3 group-hover:translate-y-3 group-hover:rounded-xl">
                    {friend.banner ? (
                      <img
                        src={resolveAvatarUrl(friend.banner, AUTH_BASE, 'central') ?? undefined}
                        alt={`${friend.username} banner`}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full bg-[linear-gradient(110deg,rgba(67,56,202,0.45),rgba(99,102,241,0.2)_45%,rgba(30,41,59,0.5))]" />
                    )}
                    <div className="absolute inset-0 bg-gradient-to-r from-black/45 via-black/25 to-black/35 transition-colors duration-500 group-hover:from-black/10 group-hover:via-transparent group-hover:to-black/20" />
                  </div>

                  <div className="absolute left-4 right-4 bottom-3 z-10 flex items-end justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-20 h-20 rounded-full avatar-bg overflow-hidden flex items-center justify-center text-white text-xl font-semibold shrink-0 border-4 border-indigo-400/70 shadow-lg shadow-indigo-500/30 transition-transform duration-500 group-hover:scale-90">
                        <div className="w-20 h-20 rounded-full overflow-hidden">
                          <AvatarImage
                            src={resolveAvatarUrl(friend.avatar, AUTH_BASE, 'central')}
                            alt={friend.username}
                            size={80}
                            className="w-20 h-20 object-cover"
                            fallback={<span>{friend.username.charAt(0).toUpperCase()}</span>}
                          />
                        </div>
                      </div>
                      <div className="flex flex-col min-w-0">
                        <button
                          type="button"
                          className="text-left text-base font-semibold text-white drop-shadow truncate group-hover:text-text-primary transition-colors hover:underline"
                          onClick={() => openModal('profileView', { userId: friend.id })}
                        >
                          {friend.username}
                        </button>
                        <span className="text-xs text-text-muted">{t('friends.catRealmFriend')}</span>
                        <span className="text-xs text-text-muted truncate">
                          {getActivitySummary(
                            friend.customStatusText,
                            friend.activityType,
                            friend.activityText,
                            friend.activityStartedAt
                          ) || formatStatus(effectiveFriendStatus)}
                        </span>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {(roleAssignments[friend.id] || []).map((roleId) => {
                            const role = personalRoles.find((r) => r.id === roleId);
                            if (!role) return null;
                            return (
                              <span
                                key={`${friend.id}-${role.id}`}
                                className="px-1.5 py-0.5 rounded-full text-[10px] border"
                                style={{ borderColor: role.color || undefined, color: role.color || undefined }}
                              >
                                {role.name}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 opacity-100 translate-y-0 pointer-events-auto transition-all duration-300 delay-75 md:opacity-0 md:translate-y-2 md:pointer-events-none md:group-hover:opacity-100 md:group-hover:translate-y-0 md:group-hover:pointer-events-auto">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="border border-border/70 bg-bg-elevated/70"
                        onClick={() => setEditingRolesForFriend((prev) => prev === friend.id ? null : friend.id)}
                      >
                        {t('friends.roles')}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          openConversation(friend.id, friend.username, friend.avatar);
                          setTab?.('dms');
                        }}
                      >
                        {t('friends.message')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger border border-danger/50 bg-bg-elevated/70 hover:bg-danger/10"
                        onClick={() => setFriendToRemove({ id: friend.id, username: friend.username })}
                        disabled={loading}
                      >
                        {t('friends.removeFriend')}
                      </Button>
                    </div>
                  </div>

                  {editingRolesForFriend === friend.id && (
                    <div className="absolute left-3 right-3 bottom-2 z-20 rounded-lg border border-border bg-bg-elevated/95 p-2">
                      <p className="text-[11px] text-text-muted mb-1.5">{t('friends.assignPersonalRoles')}</p>
                      {personalRoles.length === 0 ? (
                        <p className="text-[11px] text-text-muted">{t('friends.noPersonalRoles')}</p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {personalRoles.map((role) => {
                            const assigned = (roleAssignments[friend.id] || []).includes(role.id);
                            return (
                              <button
                                key={`${friend.id}-${role.id}-toggle`}
                                className={`px-2 py-1 rounded-full text-[11px] border ${assigned ? 'bg-bg-hover/70' : ''}`}
                                style={{ borderColor: role.color || undefined, color: role.color || undefined }}
                                onClick={() => setFriendRoleAssigned(friend.id, role.id, !assigned)}
                                disabled={loading}
                              >
                                {assigned && <Check className="mr-1 inline h-3 w-3" />}{role.name}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <div className="flex justify-end mt-1.5">
                        <button
                          className="text-[11px] text-text-muted hover:text-text-primary"
                          onClick={() => setEditingRolesForFriend(null)}
                        >
                          {t('common.close')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                  );
                })()
              ))
            )}
          </div>
        )}

        {/* Discover Servers */}
        {tab === 'discover' && (
          <div className="max-w-4xl space-y-4">
            <div className="flex flex-col md:flex-row gap-2 md:items-end">
              <div className="flex-1">
                <Input
                  label={t('discover.searchServers')}
                  value={discoverQuery}
                  onChange={(e) => setDiscoverQuery(e.target.value)}
                  placeholder={t('discover.searchPlaceholder')}
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={() => {
                    void fetchDiscovery(discoverQuery);
                  }}
                  disabled={discoverLoading}
                >
                  {discoverLoading ? t('common.refreshing') : t('common.refresh')}
                </Button>
              </div>
            </div>

            {discoverError && <p className="text-sm text-danger">{discoverError}</p>}

            {discoverLoading ? (
              <div className="text-text-muted text-sm py-8">{t('discover.loading')}</div>
            ) : discoverEntries.length === 0 ? (
              <div className="text-text-muted text-sm py-8">
                {t('discover.empty')}
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {discoverEntries.map((entry) => (
                  <div
                    key={`${entry.serverUrl}-${entry.inviteCode}`}
                    className="rounded-xl border border-border bg-bg-elevated overflow-hidden"
                  >
                    <div className="relative h-28 bg-bg-input">
                      {entry.serverBanner ? (
                        <img src={entry.serverBanner} alt={`${entry.serverName} banner`} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full bg-[linear-gradient(135deg,rgba(124,92,255,0.4),rgba(99,102,241,0.18),rgba(30,31,34,0.65))]" />
                      )}
                      <div className="absolute -bottom-6 left-4 w-12 h-12 rounded-full border-2 border-bg-elevated bg-bg-input overflow-hidden flex items-center justify-center text-sm font-semibold text-text-primary">
                        {entry.serverIcon ? (
                          <img src={entry.serverIcon} alt={entry.serverName} className="w-full h-full object-cover" />
                        ) : (
                          entry.serverName.slice(0, 1).toUpperCase()
                        )}
                      </div>
                    </div>

                    <div className="p-4 pt-8 space-y-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h4 className="text-sm font-semibold text-text-primary truncate">{entry.serverName}</h4>
                          <p className="text-xs text-text-muted">{t('discover.members', { count: entry.memberCount || 0 })}</p>
                        </div>
                        <Button
                          size="sm"
                          onClick={() => openModal('inviteEmbed', { code: entry.inviteCode, url: entry.inviteUrl })}
                        >
                          {t('common.join')}
                        </Button>
                      </div>
                      <p className="text-xs text-text-secondary line-clamp-3">
                        {entry.serverDescription || t('discover.noDescription')}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Pending Requests */}
        {tab === 'pending' && (
          <div className="space-y-6 max-w-2xl">
            {incoming.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase text-text-muted mb-3">Incoming</h4>
                <div className="space-y-1">
                  {incoming.map((req) => (
                    <div
                      key={req.id}
                      className="flex items-center justify-between px-4 py-3 rounded-lg hover:bg-bg-hover/50 transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-full avatar-bg overflow-hidden flex items-center justify-center text-white text-sm font-semibold shrink-0">
                          <AvatarImage
                            src={resolveAvatarUrl(req.from_avatar, AUTH_BASE, 'central')}
                            alt={req.from_username}
                            size={40}
                            className="w-10 h-10 object-cover"
                            fallback={<span>{req.from_username.charAt(0).toUpperCase()}</span>}
                          />
                        </div>
                        <span className="text-sm text-text-primary font-medium truncate">{req.from_username}</span>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <Button variant="primary" size="sm" onClick={() => acceptRequest(req.id)} disabled={loading}>
                          Accept
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => rejectRequest(req.id)} disabled={loading}>
                          Reject
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {outgoing.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase text-text-muted mb-3">Outgoing</h4>
                <div className="space-y-1">
                  {outgoing.map((req) => (
                    <div
                      key={req.id}
                      className="flex items-center justify-between px-4 py-3 rounded-lg hover:bg-bg-hover/50 transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-full avatar-bg overflow-hidden flex items-center justify-center text-white text-sm font-semibold shrink-0">
                          <AvatarImage
                            src={resolveAvatarUrl(req.to_avatar, AUTH_BASE, 'central')}
                            alt={req.to_username}
                            size={40}
                            className="w-10 h-10 object-cover"
                            fallback={<span>{req.to_username.charAt(0).toUpperCase()}</span>}
                          />
                        </div>
                        <span className="text-sm text-text-primary font-medium truncate">{req.to_username}</span>
                      </div>
                      <Button variant="secondary" size="sm" onClick={() => rejectRequest(req.id)} disabled={loading}>
                        Cancel
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {incoming.length === 0 && outgoing.length === 0 && (
              <div className="text-center py-12">
                <p className="text-text-muted text-sm">No pending requests.</p>
              </div>
            )}
          </div>
        )}

        {/* Add Friend */}
        {tab === 'add' && (
          <form onSubmit={handleSendRequest} className="space-y-4 max-w-md">
            <p className="text-text-muted text-sm">
              {t('friends.addExact')}
            </p>
            <Input
              label={t('friends.username')}
              value={addUsername}
              onChange={(e) => { setAddUsername(e.target.value); clearError(); setSuccessMsg(''); }}
              placeholder={t('friends.usernamePlaceholder')}
              autoFocus
            />
            {error && <p className="text-danger text-sm">{error}</p>}
            {successMsg && <p className="text-success text-sm">{successMsg}</p>}
            <Button type="submit" disabled={loading || !addUsername.trim()}>
              {loading ? t('friends.sending') : t('friends.sendRequest')}
            </Button>
          </form>
        )}
      </div>

      {/* Remove Friend Confirmation Dialog */}
      <ConfirmDialog
        open={!!friendToRemove}
        onClose={() => setFriendToRemove(null)}
        onConfirm={() => {
          if (friendToRemove) {
            removeFriend(friendToRemove.id);
          }
        }}
        title={t('friends.removeFriend')}
        message={
          <>
            {t('friends.removeConfirm', { username: friendToRemove?.username ?? '' })}
          </>
        }
        confirmText={t('friends.removeFriend')}
        cancelText={t('common.cancel')}
        variant="danger"
      />

      <Modal
        open={personalRoleModalOpen}
        onClose={() => setPersonalRoleModalOpen(false)}
        title={t('friends.createPersonalRole')}
      >
        <div className="space-y-3">
          <p className="text-xs text-text-muted">
            Personal roles are private to you and only used in Home - Friends List.
          </p>
          <div className="flex items-center justify-between">
            <label className="text-xs text-text-muted">Role Name</label>
            <span className="text-xs text-text-muted">{personalRoles.length}/69</span>
          </div>
          <Input
            value={newRoleName}
            onChange={(e) => {
              setNewRoleName(e.target.value);
              clearError();
            }}
            maxLength={32}
            placeholder="e.g. IRL, Guild Leads, Traders"
            disabled={personalRoles.length >= 69}
          />
          <div className="flex items-center gap-2">
            <label className="text-xs text-text-muted">Color</label>
            <input
              type="color"
              value={newRoleColor}
              onChange={(e) => setNewRoleColor(e.target.value)}
              className="w-8 h-8 rounded border border-border bg-transparent p-0"
              title="Role color"
              disabled={personalRoles.length >= 69}
            />
          </div>
          {error && <p className="text-danger text-xs">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPersonalRoleModalOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleCreatePersonalRole}
              disabled={loading || !newRoleName.trim() || personalRoles.length >= 69}
            >
              {loading ? 'Creating...' : 'Create Role'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Personal Roles Manager */}
      <Modal
        open={roleManagerOpen}
        onClose={() => {
          setRoleManagerOpen(false);
          setEditingRoleId(null);
          setConfirmDeleteRoleId(null);
        }}
        title="Manage Personal Roles"
      >
        <div className="space-y-2">
          <p className="text-xs text-text-muted">
            Edit or delete your personal roles. Roles are private to you.
          </p>
          {personalRoles.length === 0 ? (
            <p className="text-xs text-text-muted italic">No personal roles yet.</p>
          ) : (
            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {personalRoles.map((role) => (
                <div key={role.id} className="rounded-lg border border-border bg-bg-input p-2.5 space-y-2">
                  {editingRoleId === role.id ? (
                    /* ── Edit mode ── */
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={editRoleColor}
                          onChange={(e) => setEditRoleColor(e.target.value)}
                          className="w-7 h-7 rounded border border-border bg-transparent p-0 shrink-0 cursor-pointer"
                          title="Role color"
                        />
                        <Input
                          value={editRoleName}
                          onChange={(e) => setEditRoleName(e.target.value)}
                          maxLength={32}
                          placeholder="Role name"
                          className="flex-1 h-7 text-sm py-0"
                        />
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditingRoleId(null)}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => { void handleSaveRole(); }}
                          disabled={loading || !editRoleName.trim()}
                        >
                          {loading ? 'Saving…' : 'Save'}
                        </Button>
                      </div>
                    </div>
                  ) : confirmDeleteRoleId === role.id ? (
                    /* ── Delete confirmation ── */
                    <div className="space-y-2">
                      <p className="text-xs text-text-primary">
                        Delete <strong style={{ color: role.color || undefined }}>{role.name}</strong>?
                        {role.friendCount > 0 && (
                          <span className="text-text-muted"> ({role.friendCount} friend{role.friendCount !== 1 ? 's' : ''} assigned)</span>
                        )}
                      </p>
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setConfirmDeleteRoleId(null)}>
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => { void handleDeleteRole(role.id); }}
                          disabled={loading}
                        >
                          {loading ? 'Deleting…' : 'Delete'}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    /* ── View mode ── */
                    <div className="flex items-center gap-2">
                      <span
                        className="w-3 h-3 rounded-full shrink-0 border border-border/50"
                        style={{ backgroundColor: role.color || '#6366F1' }}
                      />
                      <span
                        className="flex-1 text-sm font-medium truncate"
                        style={{ color: role.color || undefined }}
                      >
                        {role.name}
                      </span>
                      <span className="text-xs text-text-muted shrink-0">{role.friendCount} friend{role.friendCount !== 1 ? 's' : ''}</span>
                      <Button size="sm" variant="ghost" onClick={() => startEditRole(role)} className="shrink-0 h-6 px-2 text-xs">
                        Edit
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => setConfirmDeleteRoleId(role.id)} className="shrink-0 h-6 px-2 text-xs">
                        Delete
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {error && <p className="text-danger text-xs">{error}</p>}
        </div>
      </Modal>

      <Modal
        open={discoveryManageOpen}
        onClose={() => {
          setDiscoveryManageOpen(false);
          setDiscoveryManageError(null);
          setDiscoveryManageNotice(null);
        }}
        title={t('discover.addYourServer')}
      >
        <div className="space-y-3">
          <p className="text-xs text-text-muted">
            Only users with the server owner flag can publish a server to discovery.
            Publishing creates a permanent invite until revoked.
          </p>

          {discoveryManageError && (
            <p className="text-xs text-danger">{discoveryManageError}</p>
          )}
          {discoveryManageNotice && (
            <p className="text-xs text-warning">{discoveryManageNotice}</p>
          )}

          {discoveryManageLoading ? (
            <div className="text-sm text-text-muted py-4">Loading connected servers...</div>
          ) : discoveryServers.length === 0 ? (
            <div className="text-sm text-text-muted py-4">
              No owner-managed servers found in your connected server list.
            </div>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {discoveryServers.map((server) => (
                <div key={server.url} className="rounded-lg border border-border bg-bg-input p-3 flex items-center justify-between gap-3">
                  <div className="min-w-0 flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full overflow-hidden bg-bg-elevated border border-border flex items-center justify-center text-xs font-semibold">
                      {server.icon ? (
                        <img src={server.icon} alt={server.name} className="w-full h-full object-cover" />
                      ) : (
                        server.name.slice(0, 1).toUpperCase()
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm text-text-primary font-medium truncate">{server.name}</p>
                      <p className="text-xs text-text-muted truncate">{server.url}</p>
                    </div>
                  </div>
                  {server.manageBlockedReason ? (
                    <Button size="sm" variant="secondary" disabled title={server.manageBlockedReason}>
                      Desktop Required
                    </Button>
                  ) : server.published ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        void unpublishServerFromDiscovery(server.url);
                      }}
                      disabled={discoveryActionUrl === server.url}
                    >
                      {discoveryActionUrl === server.url ? 'Removing...' : 'Unpublish'}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => {
                        void publishServerToDiscovery(server.url);
                      }}
                      disabled={discoveryActionUrl === server.url}
                    >
                      {discoveryActionUrl === server.url ? 'Publishing...' : 'Publish'}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
