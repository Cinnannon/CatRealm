import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { isHttpGatewayRealm } from '../../lib/httpRealmGateway';
import { useMessageStore } from '../../stores/messageStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { useChannelStore } from '../../stores/channelStore';
import { useAuthStore } from '../../stores/authStore';
import { createApi } from '../../lib/api';
import { AUTH_BASE, createAuthenticatedApi } from '../../lib/authApi';
import { PERMISSIONS, hasPermission, hasChannelPermission } from '../../utils/permissions';
import { useThreadStore } from '../../stores/threadStore';
import { useServerStore } from '../../stores/serverStore';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import type { OnlineUser, Role, Message } from '../../types';
import { resolveAvatarUrl } from '../../utils/avatar';
import { useViewedChannels } from '../../hooks/useViewedChannels';
import { useViewedPermissions } from '../../hooks/useViewedPermissions';
import { Modal } from '../ui/Modal';
import {
  type ExpressionItem,
  type ExpressionManifest,
  type PickerServer,
  type PickerExpressionItem,
  type EmoteSuggestion,
  PERSONAL_PICKER_SERVER_URL,
  DEFAULT_PICKER_SERVER_URL,
  EMPTY_EXPRESSION_MANIFEST as EMPTY_MANIFEST,
  normalizeServerOrigin,
  buildExpressionToken,
  sanitizeCompactEmoteTokens,
  sanitizeExpressionTokens,
  resolveServerIcon,
} from '../../lib/expressions';
import {
  type DefaultEmojiCategory,
  type EmojiMetadataLookup,
  DEFAULT_EMOJI_CATEGORIES,
  DEFAULT_CATEGORY_SEARCH_KEYWORDS,
  normalizeEmojiSearchText,
  toEmojiSearchTerms,
  normalizeEmojiGlyph,
  loadEmojiMetadataLookup,
  getEmojiMetadataLookupCache,
} from '../../lib/emojiMetadata';
import {
  useDefaultEmojiSearchAdapter,
  useComposerExpressionPickerActions,
  useComposerTransportAdapter,
  useExpressionPickerAdapter,
  useExpressionPickerDataAdapter,
  useReplyForwardComposerBridge,
} from '../../messaging/chatlib/composerBridge';
import { SharedComposerShell } from './SharedComposerShell';
import { DMComposerCore, type DMComposerCoreHandle } from './DMComposerCore';
import { ComposerUploadPreviewStrip } from './ComposerAttachments';
import { ComposerFileButton, ComposerSendButton, ComposerIconButton } from './ComposerActionButtons';
import { ComposerActionStripLeft } from './ComposerActionStrip';
import { VoiceMessageRecorder } from './VoiceMessageRecorder';
import { VoiceAutoDeleteModal } from './VoiceAutoDeleteModal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ComposerSelfPreview } from './ComposerSelfPreview';
import { ComposerEmoteSuggestionList } from './ComposerEmoteSuggestionList';
import { ComposerMentionSuggestionList } from './ComposerMentionSuggestionList';
import { ComposerCommandSuggestionList } from './ComposerCommandSuggestionList';
import { ComposerOptionSuggestionList, type OptionSuggestion } from './ComposerOptionSuggestionList';
import { useBotStore } from '../../stores/botStore';
import type { BotCommand } from '../../types';
import { SharedExpressionPickerPanel, isInsideExpressionPicker } from './SharedExpressionPickerPanel';
import { ScheduleMessageModal } from './ScheduleMessageModal';
import { ARCHIVE_ACCEPT, isArchiveFile } from '../../lib/archiveFiles';
import {
  SharedDefaultEmojiPicker,
  SharedEmotePickerGrid,
  SharedExpressionTabContent,
  SharedExpressionPickerBodyState,
  SharedExpressionPickerSidebar,
  SharedStickerPickerGrid,
} from './SharedExpressionPickerSections';

type AttachmentItem = {
  id: string;
  file: File;
  previewUrl: string;
  status: 'uploading' | 'ready' | 'error';
  progress: number;
  remote?: { url: string; mime: string; size: number; thumbnailUrl?: string | null };
  error?: string | null;
};

type AttachmentDraft = {
  attachments: AttachmentItem[];
  uploading: boolean;
  uploadError: string | null;
};

const attachmentDrafts = new Map<string, AttachmentDraft>();

function getAttachmentDraft(key: string | null): AttachmentDraft {
  if (!key) return { attachments: [], uploading: false, uploadError: null };
  return attachmentDrafts.get(key) ?? { attachments: [], uploading: false, uploadError: null };
}

function revokeRemovedAttachmentUrls(prev: AttachmentItem[], next: AttachmentItem[]) {
  const nextIds = new Set(next.map((item) => item.id));
  for (const item of prev) {
    if (!nextIds.has(item.id)) {
      URL.revokeObjectURL(item.previewUrl);
    }
  }
}

function updateAttachmentDraft(
  key: string,
  updater: AttachmentItem[] | ((prev: AttachmentItem[]) => AttachmentItem[])
) {
  const previousDraft = getAttachmentDraft(key);
  const previousAttachments = previousDraft.attachments;
  const nextAttachments = typeof updater === 'function'
    ? updater(previousAttachments)
    : updater;
  revokeRemovedAttachmentUrls(previousAttachments, nextAttachments);
  attachmentDrafts.set(key, {
    ...previousDraft,
    attachments: nextAttachments,
  });
  return nextAttachments;
}

function patchAttachmentDraft(key: string, patch: Partial<Omit<AttachmentDraft, 'attachments'>>) {
  const previousDraft = getAttachmentDraft(key);
  attachmentDrafts.set(key, {
    ...previousDraft,
    ...patch,
  });
}

function clearAttachmentDraft(key: string) {
  const draft = attachmentDrafts.get(key);
  if (draft) {
    for (const item of draft.attachments) {
      URL.revokeObjectURL(item.previewUrl);
    }
  }
  attachmentDrafts.delete(key);
}

type NsfwTagKey = 'gore' | 'blood' | 'lewd' | 'spoiler';

type PendingSendPayload = {
  channelId: string;
  messageText: string;
  readyAttachments: Array<AttachmentItem & { remote: { url: string; mime: string; size: number; thumbnailUrl?: string | null } }>;
  effectiveThreadId: string | null;
  replyToId?: string;
  forwardFromId?: string;
  scheduledAt?: number | null;
  draftKey?: string | null;
};

type MentionSuggestion = {
  label: string;
  insert: string;
  type: 'system' | 'user' | 'role' | 'alias' | 'channel';
  description?: string;
  avatar?: string | null;
  accountType?: 'local' | 'central' | 'bot';
};

const NSFW_TAG_KEYS: NsfwTagKey[] = ['gore', 'blood', 'lewd', 'spoiler'];
const TYPING_HEARTBEAT_MS = 2500;

// Re-export for backwards compatibility with files that import from MessageInput
export { DEFAULT_EMOJI_CATEGORIES, DEFAULT_CATEGORY_SEARCH_KEYWORDS, normalizeEmojiSearchText, toEmojiSearchTerms, normalizeEmojiGlyph, loadEmojiMetadataLookup } from '../../lib/emojiMetadata';
export type { DefaultEmojiCategory, EmojiMetadataLookup } from '../../lib/emojiMetadata';

export function MessageInput({ threadId = null, allowText = true, forceMediaButton = false }: { threadId?: string | null; allowText?: boolean; forceMediaButton?: boolean } = {}) {
  const { t } = useTranslation();
  const [content, setContent] = useState('');
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionItems, setMentionItems] = useState<MentionSuggestion[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdItems, setCmdItems] = useState<BotCommand[]>([]);
  const [cmdIndex, setCmdIndex] = useState(0);
  const [optItems, setOptItems] = useState<OptionSuggestion[]>([]);
  const [optIndex, setOptIndex] = useState(0);
  const [optTitle, setOptTitle] = useState('');
  const optOpen = optItems.length > 0;
  const [commandError, setCommandError] = useState<string | null>(null);
  const [emoteSuggestOpen, setEmoteSuggestOpen] = useState(false);
  const [emoteSuggestItems, setEmoteSuggestItems] = useState<EmoteSuggestion[]>([]);
  const [emoteSuggestIndex, setEmoteSuggestIndex] = useState(0);
  const [emoteSuggestAnchor, setEmoteSuggestAnchor] = useState<number>(-1);
  const [allUsers, setAllUsers] = useState<OnlineUser[]>([]);
  const [allRoles, setAllRoles] = useState<Role[]>([]);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [forwardingFrom, setForwardingFrom] = useState<Message | null>(null);
  const [nsfwModalOpen, setNsfwModalOpen] = useState(false);
  const [nsfwAttachmentIndex, setNsfwAttachmentIndex] = useState(0);
  const [pendingSendPayload, setPendingSendPayload] = useState<PendingSendPayload | null>(null);
  const [nsfwTagsByAttachment, setNsfwTagsByAttachment] = useState<Record<string, Record<NsfwTagKey, boolean>>>({});
  const [globalNsfwTags, setGlobalNsfwTags] = useState<Record<NsfwTagKey, boolean>>({
    gore: false,
    blood: false,
    lewd: false,
    spoiler: false,
  });
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceCancelConfirmOpen, setVoiceCancelConfirmOpen] = useState(false);
  const [pendingVoiceAttachment, setPendingVoiceAttachment] = useState<{ blob: Blob; waveformData: number[]; uploadResult?: { url: string; mime: string; size: number } } | null>(null);
  const [voiceAutoDeleteOpen, setVoiceAutoDeleteOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // When set, the next picker selection toggles a reaction on this message
  // instead of inserting into the composer (see dispatchMessageReact).
  const [reactionTargetMessageId, setReactionTargetMessageId] = useState<string | null>(null);
  const [pickerTab, setPickerTab] = useState<'emojis' | 'stickers'>('emojis');
  const [emojiSearchQuery, setEmojiSearchQuery] = useState('');
  const [defaultEmojiCategory, setDefaultEmojiCategory] = useState<DefaultEmojiCategory>('People');
  const [selectedExpressionServerUrl, setSelectedExpressionServerUrl] = useState<string | null>(null);
  const [expressionStateByServer, setExpressionStateByServer] = useState<Record<string, { loading: boolean; data: ExpressionManifest | null; error: string | null }>>({});
  const [personalManifest, setPersonalManifest] = useState<ExpressionManifest | null>(null);
  const [emojiMetadataLookup, setEmojiMetadataLookup] = useState<EmojiMetadataLookup | null>(() => getEmojiMetadataLookupCache());
  const [channelSlowmodesById, setChannelSlowmodesById] = useState<Record<string, number>>({});
  const [lastSentAtByChannel, setLastSentAtByChannel] = useState<Record<string, number>>({});
  const [slowmodeNow, setSlowmodeNow] = useState<number>(() => Math.floor(Date.now() / 1000));
  const activeChannelId = useChannelStore((s) => s.activeChannelId);
  const serverChannels = useChannelStore((s) => s.channels);
  const channels = useViewedChannels();
  const viewed = useViewedPermissions();
  const sendMessage = useMessageStore((s) => s.sendMessage);
  const allBotCommands = useBotStore((s) => s.commands);
  // Message actions live in the right-click menu, not the slash typeahead.
  const botCommands = useMemo(() => allBotCommands.filter((c) => c.type !== 'message'), [allBotCommands]);
  const fetchBotCommands = useBotStore((s) => s.fetchCommands);
  const invokeCommand = useBotStore((s) => s.invokeCommand);
  const { startTyping, stopTyping } = usePresenceStore();
  const user = useAuthStore((s) => s.user);
  const serverInfo = useAuthStore((s) => s.serverInfo);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const servers = useServerStore((s) => s.servers);
  const activeServerUrl = useServerStore((s) => s.activeServerUrl);
  const authOrigin = useMemo(() => normalizeServerOrigin(AUTH_BASE), []);
  const activeChannel = channels.find((entry) => entry.id === activeChannelId);
  const channelPermissions = activeChannel?.effective_permissions;
  const activeThread = useThreadStore((s) => s.activeThread);
  const canSendChannelMessages = hasChannelPermission(viewed.permissions, channelPermissions, PERMISSIONS.SEND_MESSAGES);
  const canSendThreadMessages = hasChannelPermission(viewed.permissions, channelPermissions, PERMISSIONS.SEND_MESSAGES_IN_THREADS);
  const canSendForumPosts = hasChannelPermission(viewed.permissions, channelPermissions, PERMISSIONS.SEND_MESSAGES_IN_POSTS);
  const canBypassSlowmode = hasChannelPermission(viewed.permissions, channelPermissions, PERMISSIONS.BYPASS_SLOWMODE);
  const canSendInCurrentContext = (threadId !== null ? true : !!activeThread?.id)
    ? canSendThreadMessages
    : activeChannel?.type === 'forum'
      ? canSendForumPosts
      : canSendChannelMessages;
  const canAttachFiles = hasChannelPermission(viewed.permissions, channelPermissions, PERMISSIONS.ATTACH_FILES);
  const canSendMedia = canSendInCurrentContext && canAttachFiles;
  const hasUploading = attachments.some((a) => a.status === 'uploading');
  const readyCount = attachments.filter((a) => a.status === 'ready').length;
  const activeChannelSlowmode = useMemo(() => {
    if (!activeChannelId) return 0;
    const cachedSlowmode = channelSlowmodesById[activeChannelId];
    if (typeof cachedSlowmode === 'number' && Number.isFinite(cachedSlowmode)) {
      return Math.max(0, Math.trunc(cachedSlowmode));
    }
    const rawSlowmode = (activeChannel as { slowmode?: number } | undefined)?.slowmode;
    if (typeof rawSlowmode === 'number' && Number.isFinite(rawSlowmode)) {
      return Math.max(0, Math.trunc(rawSlowmode));
    }
    return 0;
  }, [activeChannelId, channelSlowmodesById, activeChannel?.slowmode]);
  const slowmodeRemaining = useMemo(() => {
    if (!activeChannelId || activeChannelSlowmode <= 0 || canBypassSlowmode) return 0;
    const lastSentAt = lastSentAtByChannel[activeChannelId];
    if (typeof lastSentAt !== 'number' || !Number.isFinite(lastSentAt) || lastSentAt <= 0) return 0;
    return Math.max(0, lastSentAt + activeChannelSlowmode - slowmodeNow);
  }, [activeChannelId, activeChannelSlowmode, canBypassSlowmode, lastSentAtByChannel, slowmodeNow]);
  const slowmodeSendBlocked = activeChannelSlowmode > 0 && !canBypassSlowmode && slowmodeRemaining > 0;
  const activeTypedCommand = useMemo(() => {
    const match = content.trimStart().match(/^\/([a-z0-9_-]+)(?:\s|$)/i);
    if (!match) return null;
    return botCommands.find((command) => command.name === match[1].toLowerCase()) ?? null;
  }, [botCommands, content]);

  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTyping = useRef(false);
  const typingSentAt = useRef(0);
  const composerCoreRef = useRef<DMComposerCoreHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const currentServerUrl = activeServerUrl || serverUrl || null;
  const activeDraftKey = activeChannelId
    ? `${activeChannelId}:${threadId !== null ? threadId : (activeThread?.id ?? 'main')}`
    : null;
  const activeDraftKeyRef = useRef<string | null>(activeDraftKey);
  const applyAttachmentDraftUpdate = useCallback((
    draftKey: string,
    updater: AttachmentItem[] | ((prev: AttachmentItem[]) => AttachmentItem[])
  ) => {
    const nextAttachments = updateAttachmentDraft(draftKey, updater);
    if (activeDraftKeyRef.current === draftKey) {
      setAttachments(nextAttachments);
    }
    return nextAttachments;
  }, []);
  const applyAttachmentDraftPatch = useCallback((draftKey: string, patch: Partial<Omit<AttachmentDraft, 'attachments'>>) => {
    patchAttachmentDraft(draftKey, patch);
    if (activeDraftKeyRef.current !== draftKey) return;
    if (patch.uploading !== undefined) setUploading(patch.uploading);
    if (patch.uploadError !== undefined) setUploadError(patch.uploadError);
  }, []);
  const isPrivileged = !viewed.isRoleView && (user?.role === 'owner' || user?.isOwner || hasPermission(viewed.permissions, PERMISSIONS.ADMINISTRATOR));
  const canUseExternalEmojis = isPrivileged || hasChannelPermission(viewed.permissions, channelPermissions, PERMISSIONS.USE_EXTERNAL_EMOTES);
  const canUseExternalStickers = isPrivileged || hasChannelPermission(viewed.permissions, channelPermissions, PERMISSIONS.USE_EXTERNAL_STICKERS);
  const canUsePersonalEmotes = canUseExternalEmojis;
  const canScheduleMessages = isPrivileged || hasChannelPermission(viewed.permissions, channelPermissions, PERMISSIONS.SCHEDULE_MESSAGES);

  const expressionServers = useMemo<PickerServer[]>(() => {
    const deduped = new Map<string, PickerServer>();

    if (user?.accountType === 'central') {
      servers.forEach((entry) => {
        deduped.set(entry.url, {
          url: entry.url,
          name: entry.name || entry.info?.name || entry.url,
          icon: resolveServerIcon(entry.url, entry.icon || entry.info?.serverIcon || null),
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
        icon: resolveServerIcon(serverUrl, serverInfo?.serverIcon || null),
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

  const currentExpressionServer = useMemo(
    () => visibleExpressionServers.find((entry) => {
      if (entry.isDefault || entry.isPersonal || !currentServerUrl || entry.url !== currentServerUrl) return false;
      const origin = normalizeServerOrigin(entry.url);
      return !!origin && origin !== authOrigin;
    })
      ?? visibleExpressionServers.find((entry) => {
        if (!entry.isCurrent || entry.isDefault || entry.isPersonal) return false;
        const origin = normalizeServerOrigin(entry.url);
        return !!origin && origin !== authOrigin;
      })
      ?? null,
    [visibleExpressionServers, currentServerUrl, authOrigin]
  );
  const currentServerManifest = currentExpressionServer
    ? expressionStateByServer[currentExpressionServer.url]?.data ?? null
    : null;
  const currentServerEmoteItems = currentServerManifest
    ? [...currentServerManifest.emotes, ...currentServerManifest['anim-emotes']]
    : [];
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
  const defaultEmojiTypeaheadEntries = useMemo(
    () => searchableDefaultEmojiEntries.filter((entry) => entry.alias.length > 0),
    [searchableDefaultEmojiEntries]
  );

  // Slash-command typeahead: active only while typing the first token of a
  // message that starts with '/'.
  // After '/command ', suggest values for its first option when it declares
  // choices or is a role (the composer fills only the first option).
  const updateOptionSuggestions = useCallback((value: string, tokenEnd: number, caret: number): boolean => {
    const command = botCommands.find((c) => c.name === value.slice(1, tokenEnd).toLowerCase());
    const option = command?.options[0];
    const candidates: OptionSuggestion[] = option?.choices?.length
      ? option.choices.map((c) => ({ key: String(c.value), label: c.name }))
      : option?.type === 'role'
        ? [...allRoles].filter((r) => !r.is_default).sort((a, b) => b.position - a.position)
          .map((r) => ({ key: r.id, label: r.name, color: r.color }))
        : [];
    const query = value.slice(tokenEnd, caret).trim().replace(/^@/, '').toLowerCase();
    // An exact match means the value is complete — close so Enter sends.
    const items = candidates.some((c) => c.label.toLowerCase() === query)
      ? []
      : candidates.filter((c) => c.label.toLowerCase().includes(query)).slice(0, 25);
    setOptTitle(option ? `${option.name}${option.description ? ` — ${option.description}` : ''}` : '');
    setOptItems(items);
    setOptIndex(0);
    return items.length > 0;
  }, [botCommands, allRoles]);

  const updateCommandSuggestions = useCallback((value: string, caret: number): boolean => {
    if (!value.startsWith('/') || botCommands.length === 0) {
      setCmdOpen(false);
      setOptItems([]);
      return false;
    }
    const firstSpace = value.search(/\s/);
    const tokenEnd = firstSpace === -1 ? value.length : firstSpace;
    if (caret > tokenEnd) {
      setCmdOpen(false);
      return updateOptionSuggestions(value, tokenEnd, caret);
    }
    setOptItems([]);
    const query = value.slice(1, caret).toLowerCase();
    if (/[^a-z0-9_-]/.test(query)) {
      setCmdOpen(false);
      return false;
    }
    const items = botCommands
      .filter((c) => c.name.startsWith(query))
      .slice(0, 10);
    setCmdItems(items);
    setCmdIndex(0);
    setCmdOpen(items.length > 0);
    return items.length > 0;
  }, [botCommands, updateOptionSuggestions]);

  const applyOptionSuggestion = useCallback((item: OptionSuggestion) => {
    const firstSpace = content.search(/\s/);
    if (firstSpace === -1) return;
    composerCoreRef.current?.replaceRangeWithText(firstSpace, content.length, ` ${item.label}`);
    setOptItems([]);
    composerCoreRef.current?.focus();
  }, [content]);

  const applyCommandSuggestion = useCallback((item: BotCommand) => {
    const caret = composerCoreRef.current?.getCaretPlainOffset() ?? content.length;
    composerCoreRef.current?.replaceRangeWithText(0, caret, `/${item.name} `);
    setCmdOpen(false);
    composerCoreRef.current?.focus();
  }, [content]);

  const openCommandPicker = useCallback(async () => {
    await fetchBotCommands(true);
    const commands = useBotStore.getState().commands.filter((c) => c.type !== 'message');
    setCmdItems(commands.slice(0, 50));
    setCmdIndex(0);
    setCmdOpen(commands.length > 0);
    setMentionOpen(false);
    setEmoteSuggestOpen(false);
    composerCoreRef.current?.focus();
  }, [content, fetchBotCommands]);

  useEffect(() => {
    if (!activeChannelId) return;
    void fetchBotCommands();
  }, [activeChannelId, activeServerUrl, fetchBotCommands]);

  const updateMentions = useCallback((value: string, caret: number): boolean => {
    const upto = value.slice(0, caret);
    // `#query` lists channels; picking one inserts a chip that sends `<#channelId>`.
    const channelQuery = /(?:^|\s)#([^\s#@]*)$/.exec(upto);
    if (channelQuery) {
      const q = channelQuery[1].toLowerCase();
      const items: MentionSuggestion[] = serverChannels
        .filter((channel) => channel.name.toLowerCase().includes(q))
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
        .slice(0, 10)
        .map((channel) => ({
          label: `#${channel.name}`,
          insert: `<#${channel.id}>`,
          type: 'channel',
          description: channel.type === 'voice' ? 'Voice channel' : undefined,
        }));
      setMentionItems(items);
      setMentionIndex(0);
      setMentionOpen(items.length > 0);
      return items.length > 0;
    }
    const at = upto.lastIndexOf('@');
    if (at === -1) {
      setMentionOpen(false);
      return false;
    }
    const before = at === 0 ? ' ' : upto[at - 1];
    if (before && !/\s/.test(before)) {
      setMentionOpen(false);
      return false;
    }
    const query = upto.slice(at + 1);
    if (query.includes(' ') || query.includes('\n')) {
      setMentionOpen(false);
      return false;
    }
    const q = query.toLowerCase();
    const items: MentionSuggestion[] = [];

    // System special mentions
    if ('schedule'.includes(q)) {
      items.push({ label: '@schedule', insert: '@schedule', type: 'system', description: 'Send at a future time' });
    }
    const alias = serverInfo?.mentionAlias ?? '@everyone';
    if (alias) {
      const label = alias.startsWith('@') ? alias : `@${alias}`;
      if (label.toLowerCase().slice(1).includes(q) || q === '') {
        items.push({ label, insert: label, type: 'alias', description: 'Notify all members' });
      }
    }

    // Roles (sorted highest position first = most significant)
    [...allRoles]
      .sort((a, b) => b.position - a.position)
      .filter((r) => r.name.toLowerCase().includes(q))
      .slice(0, 6)
      .forEach((r) => items.push({ label: `@${r.name}`, insert: `@${r.name}`, type: 'role' }));

    // Members
    allUsers
      .filter((u) => u.username.toLowerCase().includes(q))
      .slice(0, 6)
      .forEach((u) => items.push({
        label: `@${u.username}`,
        insert: `@${u.username}`,
        type: 'user',
        avatar: u.avatar ?? null,
        accountType: u.accountType,
      }));

    setMentionItems(items.slice(0, 12));
    setMentionIndex(0);
    setMentionOpen(items.length > 0);
    return items.length > 0;
  }, [allUsers, allRoles, serverChannels, serverInfo?.mentionAlias]);

  const applyMentionSuggestion = useCallback((item: MentionSuggestion) => {
    const caret = composerCoreRef.current?.getCaretPlainOffset() ?? content.length;
    const upto = content.slice(0, caret);
    const start = upto.lastIndexOf(item.type === 'channel' ? '#' : '@');
    if (start === -1) return;
    if (item.type === 'channel') {
      composerCoreRef.current?.replaceRangeWithChip(start, caret, item.insert, item.label);
    } else {
      composerCoreRef.current?.replaceRangeWithText(start, caret, item.insert + ' ');
    }
    setMentionOpen(false);
    composerCoreRef.current?.focus();
  }, [content]);

  const applyEmoteSuggestion = useCallback((item: EmoteSuggestion) => {
    const caret = composerCoreRef.current?.getCaretPlainOffset() ?? content.length;
    const anchor = emoteSuggestAnchor;
    if (anchor < 0 || anchor > caret) return;
    if (item.previewImage) {
      const name = item.label.slice(1, -1);
      composerCoreRef.current?.replaceRangeWithEmote(anchor, caret, item.insert, item.previewImage, name);
      composerCoreRef.current?.insertTextAtCaret(' ', false);
    } else {
      composerCoreRef.current?.replaceRangeWithText(anchor, caret, item.insert + ' ');
    }
    setEmoteSuggestOpen(false);
    composerCoreRef.current?.focus();
  }, [content, emoteSuggestAnchor]);

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
          next.push({
            label,
            insert: buildExpressionToken('emote', entry.name, '', AUTH_BASE, currentServerUrl, entry.owner_id || user?.id || null),
            previewImage: entry.absolute_url || (/^https?:\/\//i.test(entry.file_url) ? entry.file_url : `${AUTH_BASE}${entry.file_url}`),
          });
        });
    }

    if (currentExpressionServer && currentServerEmoteItems.length > 0) {
      currentServerEmoteItems
        .filter((entry) => entry.name.toLowerCase().includes(q))
        .slice(0, 8)
        .forEach((entry) => {
          const label = `:${entry.name}:`;
          if (seen.has(label)) return;
          seen.add(label);
          next.push({
            label,
            insert: buildExpressionToken('emote', entry.name, '', currentExpressionServer.url, currentServerUrl),
            previewImage: entry.absolute_url || (/^https?:\/\//i.test(entry.file_url) ? entry.file_url : `${currentExpressionServer.url}${entry.file_url}`),
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
    currentExpressionServer,
    currentServerEmoteItems,
    currentServerUrl,
    defaultEmojiTypeaheadEntries,
    user?.id,
  ]);

  const handleChange = useCallback(
    (value: string, caret: number) => {
      setContent(value);
      const commandOpen = updateCommandSuggestions(value, caret);
      const emoteOpen = !commandOpen && updateEmoteSuggestions(value, caret);
      if (commandOpen || emoteOpen) {
        setMentionOpen(false);
        if (commandOpen) setEmoteSuggestOpen(false);
      } else {
        updateMentions(value, caret);
      }
      if (!activeChannelId) return;

      // Re-announce while typing continues; receivers expire a typer who goes quiet.
      if (value.length > 0 && (!isTyping.current || Date.now() - typingSentAt.current > TYPING_HEARTBEAT_MS)) {
        isTyping.current = true;
        typingSentAt.current = Date.now();
        startTyping(activeChannelId);
      }

      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      typingTimeout.current = setTimeout(() => {
        if (isTyping.current && activeChannelId) {
          isTyping.current = false;
          stopTyping(activeChannelId);
        }
      }, 2000);
    },
    [activeChannelId, startTyping, stopTyping, updateMentions, updateEmoteSuggestions, updateCommandSuggestions]
  );

  const insertIntoComposer = useCallback((insertValue: string, surroundWithSpacing = true) => {
    if (!allowText) return;
    const caret = composerCoreRef.current?.getCaretPlainOffset() ?? 0;
    const before = content.slice(0, caret);
    const after = content.slice(caret);
    const padLeft = surroundWithSpacing && before.length > 0 && !/\s$/.test(before);
    const padRight = surroundWithSpacing && after.length > 0 && !/^\s/.test(after);
    const text = `${padLeft ? ' ' : ''}${insertValue}${padRight ? ' ' : ''}`;
    composerCoreRef.current?.insertTextAtCaret(text, false);
    composerCoreRef.current?.focus();
  }, [allowText, content]);

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

  const insertUnicodeEmoji = useCallback((emoji: string) => {
    if (reactionTargetMessageId) {
      useMessageStore.getState().toggleReaction(reactionTargetMessageId, emoji);
      setReactionTargetMessageId(null);
      setPickerOpen(false);
      return;
    }
    insertIntoComposer(emoji, false);
  }, [insertIntoComposer, reactionTargetMessageId]);

  const insertExpression = useCallback((
    kind: 'emote' | 'sticker',
    expression: ExpressionItem,
    fromServerUrl: string,
    isPersonal = false
  ) => {
    if (isPersonal) {
      if (kind === 'emote' && !canUseExternalEmojis) return;
      if (kind === 'sticker' && !canUseExternalStickers) return;
    }
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
    if (reactionTargetMessageId) {
      useMessageStore.getState().toggleReaction(reactionTargetMessageId, tokenized);
      setReactionTargetMessageId(null);
      setPickerOpen(false);
      return;
    }
    composerCoreRef.current?.insertEmoteAtCaret(tokenized, assetUrl, expression.name);
    composerCoreRef.current?.focus();
    setPickerOpen(false);
  }, [insertIntoComposer, resolveExpressionAssetUrl, currentServerUrl, user?.id, canUseExternalEmojis, canUseExternalStickers, reactionTargetMessageId]);

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

  useEffect(() => {
    if (!currentExpressionServer || currentExpressionServer.isDefault) return;
    const state = expressionStateByServer[currentExpressionServer.url];
    if (state?.loading || state?.data || state?.error) return;
    void loadManifest(currentExpressionServer);
  }, [currentExpressionServer, expressionStateByServer, loadManifest]);

  useEffect(() => {
    void loadPersonalManifest();
  }, [loadPersonalManifest]);

  const finalizeSend = useCallback((
    payload: PendingSendPayload,
    tagMap: Record<string, Record<NsfwTagKey, boolean>> = {}
  ) => {
    const sentAt = Math.floor(Date.now() / 1000);
    const payloadSlowmode = (payload.channelId === activeChannelId ? activeChannelSlowmode : channelSlowmodesById[payload.channelId]) ?? 0;
    const mapAttachmentTags = (attachmentId: string): string[] =>
      NSFW_TAG_KEYS.filter((tag) => !!tagMap[attachmentId]?.[tag]);

    if (payload.readyAttachments.length > 0) {
      // Always send as a single message with all attachments as an array.
      // <?imgN> placeholders stay in the content for inline rendering by the formatter.
      const allTags = payload.readyAttachments.flatMap((a) => mapAttachmentTags(a.id));
      sendMessage(
        payload.channelId,
        payload.messageText,
        payload.readyAttachments.map((a) => a.remote),
        payload.effectiveThreadId,
        payload.replyToId,
        payload.forwardFromId,
        allTags,
        undefined,
        payload.scheduledAt ?? null
      );
    } else {
      sendMessage(
        payload.channelId,
        payload.messageText,
        undefined,
        payload.effectiveThreadId,
        payload.replyToId,
        payload.forwardFromId,
        undefined,
        undefined,
        payload.scheduledAt ?? null
      );
    }

    if (allowText) composerCoreRef.current?.clear();
    if (payload.draftKey) {
      clearAttachmentDraft(payload.draftKey);
      if (activeDraftKeyRef.current === payload.draftKey) {
        setAttachments([]);
        setUploading(false);
        setUploadError(null);
      }
    } else {
      setAttachments([]);
      setUploading(false);
      setUploadError(null);
    }
    setReplyingTo(null);
    setForwardingFrom(null);
    setPickerOpen(false);
    setEmoteSuggestOpen(false);
    setMentionOpen(false);
    setPendingSendPayload(null);
    setNsfwModalOpen(false);
    if (payloadSlowmode > 0) {
      setSlowmodeNow(sentAt);
      setLastSentAtByChannel((prev) => ({ ...prev, [payload.channelId]: sentAt }));
    }
  }, [sendMessage, allowText, activeChannelId, activeChannelSlowmode, channelSlowmodesById]);

  // Send a picked GIF as its own message (its URL auto-embeds via the formatter).
  // Sends directly rather than through finalizeSend so an in-progress text draft
  // isn't cleared.
  const sendGif = useCallback((gifUrl: string) => {
    if (!activeChannelId || !canSendInCurrentContext || slowmodeSendBlocked) return;
    const effectiveThreadId = threadId !== null ? threadId : (activeThread?.id ?? null);
    sendMessage(activeChannelId, gifUrl, undefined, effectiveThreadId, replyingTo?.id, forwardingFrom?.id, undefined, undefined, null);
    setReplyingTo(null);
    setForwardingFrom(null);
    setPickerOpen(false);
  }, [activeChannelId, canSendInCurrentContext, slowmodeSendBlocked, threadId, activeThread, replyingTo, forwardingFrom, sendMessage]);

  const handleSend = useCallback(() => {
    if (!activeChannelId) return;
    if (!canSendInCurrentContext) return;
    if (slowmodeSendBlocked) return;
    const messageText = allowText
      ? sanitizeExpressionTokens(
        sanitizeCompactEmoteTokens(content.trim(), currentServerUrl, canUseExternalEmojis, canUseExternalStickers),
        currentServerUrl,
        canUseExternalEmojis,
        canUseExternalStickers
      )
      : '';
    const hasText = allowText && messageText.length > 0;

    // Slash-command invocation: '/name ...' matching a registered bot command
    // becomes an interaction instead of a plain message.
    const slashMatch = hasText && attachments.length === 0
      ? messageText.match(/^\/([a-z0-9_-]{1,32})(?:\s+([\s\S]*))?$/i)
      : null;
    if (slashMatch) {
      const matched = botCommands.find((c) => c.name === slashMatch[1].toLowerCase());
      if (matched) {
        const rest = (slashMatch[2] || '').trim();
        const options: Record<string, string> = {};
        if (rest && matched.options.length > 0) options[matched.options[0].name] = rest;
        setCommandError(null);
        void invokeCommand({
          botId: matched.botId,
          command: matched.name,
          channelId: activeChannelId,
          threadId: threadId !== null ? threadId : (activeThread?.id ?? null),
          replyToId: replyingTo?.id ?? null,
          options,
        }).then((result) => {
          if (result.status === 'ok' || result.status === 'consent_required') return;
          const friendly: Record<string, string> = {
            denied: 'You have denied this bot — allow it from its profile to use commands.',
            bot_offline: `${matched.botDisplayName || matched.botUsername} is offline right now.`,
            unknown_command: 'That command no longer exists.',
            unknown_bot: 'That bot no longer exists.',
            missing_permission: 'You do not have permission to use that command.',
          };
          setCommandError(friendly[result.status] || result.error || 'Command failed');
        });
        composerCoreRef.current?.clear();
        setReplyingTo(null);
        setCmdOpen(false);
        setOptItems([]);
        setMentionOpen(false);
        setEmoteSuggestOpen(false);
        return;
      }
    }

    const hasScheduleTrigger = /\B@schedule\b/i.test(messageText);
    const cleanedText = hasScheduleTrigger
      ? messageText.replace(/\B@schedule\b/gi, '').trim()
      : messageText;

    if (hasScheduleTrigger && !cleanedText && attachments.filter((a) => a.status === 'ready' && !!a.remote).length === 0) return;

    const effectiveMessageText = hasScheduleTrigger ? cleanedText : messageText;

    const readyAttachments = attachments.filter(
      (a): a is AttachmentItem & { remote: { url: string; mime: string; size: number; thumbnailUrl?: string | null } } =>
        a.status === 'ready' && !!a.remote
    );
    if (!hasText && !hasScheduleTrigger && readyAttachments.length === 0) return;
    if (!effectiveMessageText && readyAttachments.length === 0) return;
    if (hasUploading) return;

    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    if (isTyping.current) {
      isTyping.current = false;
      stopTyping(activeChannelId);
    }

    const payload: PendingSendPayload = {
      channelId: activeChannelId,
      messageText: effectiveMessageText,
      readyAttachments,
      effectiveThreadId: threadId !== null ? threadId : (activeThread?.id ?? null),
      replyToId: replyingTo?.id,
      forwardFromId: forwardingFrom?.id,
      draftKey: activeDraftKey,
    };

    if (hasScheduleTrigger) {
      if (!canScheduleMessages) {
        return;
      }
      setPendingSendPayload(payload);
      setScheduleModalOpen(true);
      return;
    }

    if (readyAttachments.length > 0) {
      setPendingSendPayload(payload);
      setNsfwAttachmentIndex(0);
      setGlobalNsfwTags({ gore: false, blood: false, lewd: false, spoiler: false });
      setNsfwTagsByAttachment(
        Object.fromEntries(
          readyAttachments.map((item) => [item.id, { gore: false, blood: false, lewd: false, spoiler: false }])
        )
      );
      setNsfwModalOpen(true);
      return;
    }

    finalizeSend(payload);
  }, [
    content,
    activeChannelId,
    stopTyping,
    allowText,
    attachments,
    threadId,
    activeThread,
    activeDraftKey,
    hasUploading,
    replyingTo,
    forwardingFrom,
    currentServerUrl,
    canUseExternalEmojis,
    canUseExternalStickers,
    canSendInCurrentContext,
    slowmodeSendBlocked,
    finalizeSend,
    botCommands,
    invokeCommand,
  ]);

  const handleScheduleConfirm = (date: Date) => {
    setScheduleModalOpen(false);
    const withSchedule: PendingSendPayload = { ...pendingSendPayload!, scheduledAt: Math.floor(date.getTime() / 1000) };
    setPendingSendPayload(withSchedule);
    if (withSchedule.readyAttachments.length > 0) {
      setNsfwAttachmentIndex(0);
      setGlobalNsfwTags({ gore: false, blood: false, lewd: false, spoiler: false });
      setNsfwTagsByAttachment(
        Object.fromEntries(
          withSchedule.readyAttachments.map((item) => [item.id, { gore: false, blood: false, lewd: false, spoiler: false }])
        )
      );
      setNsfwModalOpen(true);
    } else {
      finalizeSend(withSchedule);
    }
  };

  const currentNsfwAttachment = pendingSendPayload?.readyAttachments[nsfwAttachmentIndex] ?? null;
  const currentNsfwAttachmentTags = currentNsfwAttachment
    ? (nsfwTagsByAttachment[currentNsfwAttachment.id] ?? { gore: false, blood: false, lewd: false, spoiler: false })
    : { gore: false, blood: false, lewd: false, spoiler: false };

  const setCurrentAttachmentTag = (tag: NsfwTagKey, value: boolean) => {
    if (!currentNsfwAttachment) return;
    setNsfwTagsByAttachment((prev) => ({
      ...prev,
      [currentNsfwAttachment.id]: {
        ...(prev[currentNsfwAttachment.id] ?? { gore: false, blood: false, lewd: false, spoiler: false }),
        [tag]: value,
      },
    }));
  };

  const handleSendWithoutNsfw = () => {
    if (!pendingSendPayload) return;
    finalizeSend(pendingSendPayload, {});
  };

  const handleSendWithNsfwSelections = () => {
    if (!pendingSendPayload) return;
    finalizeSend(pendingSendPayload, nsfwTagsByAttachment);
  };

  const handleApplyAllAndSend = () => {
    if (!pendingSendPayload) return;
    const applied = Object.fromEntries(
      pendingSendPayload.readyAttachments.map((item) => [item.id, { ...globalNsfwTags }])
    );
    setNsfwTagsByAttachment(applied);
    finalizeSend(pendingSendPayload, applied);
  };

  const handleVoiceToggle = useCallback(() => {
    if (voiceMode) {
      setVoiceCancelConfirmOpen(true);
    } else {
      setVoiceMode(true);
    }
  }, [voiceMode]);

  const handleVoiceSend = useCallback(async (blob: Blob, _waveformData: number[]) => {
    if (!activeChannelId) return;
    try {
      const api = createApi();
      const form = new FormData();
      form.append('file', blob, 'voice-message.webm');
      form.append('channelId', activeChannelId);
      const res = await api.post<{ url: string; mime: string; size: number }>('/api/uploads/chat', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setPendingVoiceAttachment({ blob, waveformData: _waveformData, uploadResult: res.data });
      setVoiceAutoDeleteOpen(true);
    } catch (err) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.status === 413 ? 'File too large. Max upload size exceeded.' : (err.response?.data?.error || 'Upload failed'))
        : 'Upload failed';
      setUploadError(msg);
    }
  }, [activeChannelId]);

  const handleVoiceAutoDeleteConfirm = useCallback((expiresAt: number | null) => {
    if (!activeChannelId || !pendingVoiceAttachment) return;
    const { uploadResult } = pendingVoiceAttachment as any;
    if (!uploadResult) return;
    sendMessage(
      activeChannelId,
      '',
      { url: uploadResult.url, mime: uploadResult.mime || 'audio/webm', size: uploadResult.size },
      threadId !== null ? threadId : (activeThread?.id ?? null),
      undefined,
      undefined,
      [],
      expiresAt
    );
    setVoiceAutoDeleteOpen(false);
    setPendingVoiceAttachment(null);
    setVoiceMode(false);
  }, [activeChannelId, pendingVoiceAttachment, sendMessage, threadId, activeThread]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
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
        if (!item) return;
        applyEmoteSuggestion(item);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setEmoteSuggestOpen(false);
        return;
      }
    }
    if (optOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setOptIndex((i) => (i + 1) % optItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setOptIndex((i) => (i - 1 + optItems.length) % optItems.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const item = optItems[optIndex];
        if (item) applyOptionSuggestion(item);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setOptItems([]);
        return;
      }
    }
    if (cmdOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCmdIndex((i) => (i + 1) % cmdItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCmdIndex((i) => (i - 1 + cmdItems.length) % cmdItems.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const item = cmdItems[cmdIndex];
        if (!item) return;
        applyCommandSuggestion(item);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setCmdOpen(false);
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
        if (!item) return;
        applyMentionSuggestion(item);
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
      handleSend();
    }
  };

  useEffect(() => {
    activeDraftKeyRef.current = activeDraftKey;
    const draft = getAttachmentDraft(activeDraftKey);
    setAttachments(draft.attachments);
    setUploading(draft.uploading);
    setUploadError(draft.uploadError);
  }, [activeDraftKey]);

  useEffect(() => {
    if (!activeChannelId) return;
    const api = createApi();
    api.get('/api/users').then((res) => setAllUsers(res.data ?? [])).catch(() => {});
    api.get('/api/roles').then((res) => setAllRoles(res.data ?? [])).catch(() => {});
  }, [activeChannelId]);

  useEffect(() => {
    if (!activeChannelId) return;
    let cancelled = false;
    const api = createApi();
    api.get(`/api/channels/${activeChannelId}/settings`)
      .then((res) => {
        if (cancelled) return;
        const rawSlowmode = res.data?.slowmode;
        const nextSlowmode = typeof rawSlowmode === 'number' && Number.isFinite(rawSlowmode)
          ? Math.max(0, Math.trunc(rawSlowmode))
          : 0;
        setChannelSlowmodesById((prev) => (
          prev[activeChannelId] === nextSlowmode ? prev : { ...prev, [activeChannelId]: nextSlowmode }
        ));
      })
      .catch(() => {
        if (cancelled) return;
        const fallbackSlowmode = typeof (activeChannel as { slowmode?: number } | undefined)?.slowmode === 'number'
          ? Math.max(0, Math.trunc((activeChannel as { slowmode?: number }).slowmode ?? 0))
          : 0;
        setChannelSlowmodesById((prev) => (
          prev[activeChannelId] === fallbackSlowmode ? prev : { ...prev, [activeChannelId]: fallbackSlowmode }
        ));
      });
    return () => {
      cancelled = true;
    };
  }, [activeChannelId, activeChannel?.slowmode]);

  useEffect(() => {
    if (slowmodeRemaining <= 0) return;
    const tick = window.setInterval(() => {
      setSlowmodeNow(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => {
      window.clearInterval(tick);
    };
  }, [slowmodeRemaining]);

  useReplyForwardComposerBridge<Message>({
    setReplying: setReplyingTo,
    setForwarding: setForwardingFrom,
  });

  // Open the picker in reaction mode when a message row's "react" action fires.
  useEffect(() => {
    const handler = (e: Event) => {
      const { messageId } = (e as CustomEvent<{ messageId: string }>).detail ?? {};
      if (!messageId) return;
      setReactionTargetMessageId(messageId);
      setPickerTab('emojis');
      setPickerOpen(true);
    };
    window.addEventListener('message:react-picker', handler);
    return () => window.removeEventListener('message:react-picker', handler);
  }, []);

  // Leaving reaction mode whenever the picker closes prevents a stale target
  // from hijacking a later composer insertion.
  useEffect(() => {
    if (!pickerOpen && reactionTargetMessageId) setReactionTargetMessageId(null);
  }, [pickerOpen, reactionTargetMessageId]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!pickerRef.current) return;
      if (pickerRef.current.contains(event.target as Node) || isInsideExpressionPicker(event.target)) return;
      setPickerOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
    };
  }, [pickerOpen]);

  useEffect(() => {
    if (!pickerOpen || emojiMetadataLookup) return;
    let cancelled = false;
    void loadEmojiMetadataLookup()
      .then((lookup) => {
        if (!cancelled) setEmojiMetadataLookup(lookup);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pickerOpen, emojiMetadataLookup]);

  const uploadFile = useCallback(async (item: AttachmentItem, draftKey: string | null, uploadChannelId: string | null) => {
    if (draftKey) applyAttachmentDraftPatch(draftKey, { uploadError: null });
    else setUploadError(null);
    try {
      const api = createApi();
      const form = new FormData();
      form.append('file', item.file);
      if (uploadChannelId) form.append('channelId', uploadChannelId);
      const res = await api.post('/api/uploads/chat', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (evt) => {
          const total = evt.total ?? item.file.size;
          const progress = total ? Math.round((evt.loaded / total) * 100) : 0;
          const updater = (prev: AttachmentItem[]) => prev.map((a) =>
            a.id === item.id ? { ...a, progress, status: 'uploading' as const } : a
          );
          if (draftKey) applyAttachmentDraftUpdate(draftKey, updater);
          else setAttachments(updater);
        },
      });
      const updater = (prev: AttachmentItem[]) => prev.map((a) =>
        a.id === item.id
          ? { ...a, status: 'ready' as const, progress: 100, remote: res.data, error: null }
          : a
      );
      if (draftKey) applyAttachmentDraftUpdate(draftKey, updater);
      else setAttachments(updater);
    } catch (err) {
      let msg = 'Upload failed';
      if (axios.isAxiosError(err)) {
        msg = err.response?.status === 413
          ? `File too large. Max upload size exceeded.`
          : (err.response?.data?.error || 'Upload failed');
      }
      const updater = (prev: AttachmentItem[]) => prev.map((a) =>
        a.id === item.id
          ? { ...a, status: 'error' as const, progress: 0, error: msg }
          : a
      );
      if (draftKey) {
        applyAttachmentDraftUpdate(draftKey, updater);
        applyAttachmentDraftPatch(draftKey, { uploadError: msg });
      } else {
        setAttachments(updater);
        setUploadError(msg);
      }
    }
  }, [applyAttachmentDraftPatch, applyAttachmentDraftUpdate]);

  const allowedTypes = useMemo(() => new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'video/mp4',
    'video/webm',
  ]), []);

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (!canSendMedia) return;
      const draftKey = activeDraftKey;
      const uploadChannelId = activeChannelId;
      const filtered = files.filter((f) => allowedTypes.has(f.type) || isArchiveFile(f));
      if (filtered.length === 0) {
        if (draftKey) applyAttachmentDraftPatch(draftKey, { uploadError: 'Unsupported file type' });
        else setUploadError('Unsupported file type');
        return;
      }
      const maxBytes = (serverInfo?.mediaMaxMb ?? 50) * 1024 * 1024;
      const oversized = filtered.find((f) => f.size > maxBytes);
      if (oversized) {
        const msg = `File too large. Max upload size is ${serverInfo?.mediaMaxMb ?? 50} MB per file.`;
        if (draftKey) applyAttachmentDraftPatch(draftKey, { uploadError: msg });
        else setUploadError(msg);
        return;
      }
      const items = filtered.map((file) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        previewUrl: URL.createObjectURL(file),
        status: 'uploading' as const,
        progress: 0,
        remote: undefined,
        error: null,
      }));
      if (draftKey) {
        applyAttachmentDraftUpdate(draftKey, (prev) => [...prev, ...items]);
        applyAttachmentDraftPatch(draftKey, { uploading: true, uploadError: null });
      } else {
        setAttachments((prev) => [...prev, ...items]);
        setUploading(true);
        setUploadError(null);
      }
      for (const item of items) {
        // Upload sequentially to keep load predictable
        await uploadFile(item, draftKey, uploadChannelId);
      }
      if (draftKey) applyAttachmentDraftPatch(draftKey, { uploading: false });
      else setUploading(false);
    },
    [
      canSendMedia,
      activeDraftKey,
      activeChannelId,
      applyAttachmentDraftPatch,
      applyAttachmentDraftUpdate,
      uploadFile,
      allowedTypes,
      serverInfo?.mediaMaxMb,
    ]
  );

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
  const {
    hasEmojiSearchQuery,
    filteredEntries: defaultEmojiEntries,
  } = useDefaultEmojiSearchAdapter({
    searchQuery: emojiSearchQuery,
    selectedCategory: defaultEmojiCategory,
    entries: searchableDefaultEmojiEntries,
    toSearchTerms: toEmojiSearchTerms,
  });
  const {
    uploadAction: uploadButtonAction,
    pickerAction: pickerButtonAction,
    sendAction: sendButtonAction,
    onFileInputChange: handleUploadInputChange,
  } = useComposerTransportAdapter({
    keybind: {
      focusText: () => {
        if (!activeChannelId || threadId !== null) return;
        if (!allowText || !canSendInCurrentContext) return;
        composerCoreRef.current?.focus();
      },
      uploadFile: () => {
        if (!activeChannelId || threadId !== null) return;
        if (!(canSendMedia || forceMediaButton) || !canSendMedia) return;
        fileInputRef.current?.click();
      },
      togglePicker: (targetTab) => {
        if (!activeChannelId || threadId !== null) return;
        if (!allowText || !canSendInCurrentContext) return;
        composerPickerActions.togglePickerTab(targetTab);
      },
    },
    uiActions: {
      upload: {
        disabled: uploading || hasUploading || !canSendMedia,
        title: canSendMedia ? t('chat.uploadMedia') : t('chat.noUploadPermission'),
      },
      picker: {
        disabled: !allowText || !canSendInCurrentContext,
        title: !canSendInCurrentContext
          ? t('chat.noSendPermissionChannel')
          : (allowText ? t('emotePicker.openPicker') : t('chat.textInputDisabled')),
        ariaLabel: t('emotePicker.openPickerAria'),
        onClick: () => {
          if (!allowText || !canSendInCurrentContext) return;
          composerPickerActions.togglePickerButton();
        },
      },
      send: {
        disabled:
          slowmodeSendBlocked ||
          !canSendInCurrentContext ||
          hasUploading ||
          ((!allowText || !content.trim()) && readyCount === 0),
        title: slowmodeSendBlocked ? `Slowmode enabled (${slowmodeRemaining}s left)` : 'Send message',
        onClick: handleSend,
      },
    },
    pasteFiles: {
      enabled: canSendMedia,
      mode: 'multiple',
      onFiles: async (files) => {
        if (files.length === 0) return;
        await handleFiles(files);
      },
    },
    fileInputChange: {
      enabled: canSendMedia,
      mode: 'multiple',
      resetInput: true,
      onFiles: async (files) => {
        if (files.length === 0) return;
        await handleFiles(files);
      },
    },
  });
  const voiceBarRetracted = useUIStore((s) => s.voiceBarRetracted);
  const activeVoiceChannelId = useVoiceStore((s) => s.activeChannelId);
  const composerBottomSpacingClass = activeVoiceChannelId && !voiceBarRetracted ? 'pb-24' : 'pb-4';

  if (!activeChannelId) return null;

  return (
    <div className={`px-4 ${composerBottomSpacingClass}`}>
      {activeChannelSlowmode > 0 && (
        <div className="mb-2 px-4 py-2 rounded-lg border border-border bg-bg-elevated/80 text-xs">
          {canBypassSlowmode ? (
            <span className="text-accent">Cat Powers~ Slowmode Bypassed~!</span>
          ) : slowmodeRemaining > 0 ? (
            <span className="text-warning">
              Slowmode Enabled. {slowmodeRemaining} {slowmodeRemaining === 1 ? 'Second' : 'Seconds'} left before a new one can be sent!
            </span>
          ) : (
            <span className="text-text-muted">Slowmode Enabled.</span>
          )}
        </div>
      )}
      {allowText && canSendInCurrentContext && !voiceMode && (
        <ComposerSelfPreview content={content} />
      )}
      <div className="relative">
      {activeTypedCommand && (
        <div className="mb-1 flex items-center gap-2 rounded-lg border border-border bg-bg-elevated px-3 py-1.5 text-xs text-text-muted">
          <span className="rounded bg-indigo-600 px-1 py-0.5 text-[10px] font-bold text-white">BOT</span>
          <span className="min-w-0 flex-1 truncate">
            Using <span className="text-text-primary">{activeTypedCommand.botDisplayName || activeTypedCommand.botUsername}</span>
            {' · '}
            <span className="font-medium text-indigo-400">/{activeTypedCommand.name}</span>
          </span>
        </div>
      )}
      <SharedComposerShell
        replyBanner={replyingTo ? {
          kind: 'reply',
          label: (
            <>
              Replying to <span className="text-accent">{replyingTo.username}</span>: {replyingTo.content.substring(0, 50)}{replyingTo.content.length > 50 ? '...' : ''}
            </>
          ),
          onClear: () => setReplyingTo(null),
        } : null}
        forwardBanner={forwardingFrom ? {
          kind: 'forward',
          label: (
            <>
              Forwarding from <span className="text-blue-400">{forwardingFrom.username}</span>
            </>
          ),
          onClear: () => setForwardingFrom(null),
        } : null}
        rowProps={{
          onDragOver: (e) => {
          if (!canSendMedia) return;
          e.preventDefault();
          setDragActive(true);
          },
          onDragLeave: () => setDragActive(false),
          onDrop: (e) => {
          if (!canSendMedia) return;
          e.preventDefault();
          setDragActive(false);
          const files = Array.from(e.dataTransfer.files ?? []);
          if (files.length === 0) return;
          handleFiles(files);
          },
        }}
      >
        {dragActive && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-accent bg-bg-hover/70 text-sm text-text-primary pointer-events-none">
            Drop files to upload
          </div>
        )}
        <ComposerActionStripLeft
          uploadControl={(canSendMedia || forceMediaButton) ? (
            <ComposerFileButton
              inputRef={fileInputRef}
              action={uploadButtonAction ?? {}}
              accept={`image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,${ARCHIVE_ACCEPT}`}
              multiple
              onChange={handleUploadInputChange}
              className={`px-3 py-2.5 text-text-muted transition-colors ${
                canSendMedia ? 'hover:text-accent' : 'opacity-50'
              }`}
            />
          ) : null}
          pickerRef={pickerRef}
          pickerAction={pickerButtonAction ?? {}}
          pickerButtonClassName="px-3 py-2.5 text-text-muted hover:text-accent disabled:opacity-50 transition-colors"
          pickerPanel={pickerOpen ? (
            <SharedExpressionPickerPanel
              className="w-full md:w-[30rem] max-w-[calc(100vw-1rem)]"
              pickerTab={pickerTab}
              onPickerTabChange={setPickerTab}
              searchValue={emojiSearchQuery}
              onSearchChange={setEmojiSearchQuery}
              onClose={composerPickerActions.closePicker}
              gifPickerEnabled={user?.accountType === 'central' && !reactionTargetMessageId}
              onSelectGif={sendGif}
                  sidebar={(
                    <SharedExpressionPickerSidebar
                      entries={visibleExpressionServers}
                      selectedUrl={effectiveSelectedServerUrl}
                      pickerTab={pickerTab}
                      isExternalBlocked={(entry, tab) => {
                    const requiresExternalPermission = !entry.isDefault && (
                      entry.isPersonal || !!(currentServerUrl && entry.url !== currentServerUrl)
                    );
                    return requiresExternalPermission && ((tab === 'emojis' && !canUseExternalEmojis) || (tab === 'stickers' && !canUseExternalStickers));
                      }}
                      onSelect={selectExpressionPickerServer}
                    />
                  )}
            >
                  <SharedExpressionPickerBodyState
                    hasSelectedServer={!!selectedServer}
                    loading={!!selectedServer && !!selectedServerState?.loading}
                    error={selectedServer ? (selectedServerState?.error ?? null) : null}
                    onRetry={selectedServer ? retrySelectedExpressionServer : undefined}
                  >
                  {selectedServer && selectedManifest && pickerTab === 'emojis' && (
                    <SharedExpressionTabContent
                      warningText={!selectedServer.isDefault && selectedIsExternal && !canUseSelectedEmojiServer
                        ? 'External emojis are not allowed for your current permissions.'
                        : null}
                      isDefault={!!selectedServer.isDefault}
                      defaultContent={(
                        <SharedDefaultEmojiPicker
                          hasSearchQuery={hasEmojiSearchQuery}
                          selectedCategoryName={defaultEmojiCategory}
                          categories={DEFAULT_EMOJI_CATEGORIES}
                          onSelectCategory={(categoryName) => setDefaultEmojiCategory(categoryName as DefaultEmojiCategory)}
                          emojiMetadataLoaded={!!emojiMetadataLookup}
                          entries={defaultEmojiEntries}
                          onSelectEmoji={insertUnicodeEmoji}
                        />
                      )}
                      nonDefaultContent={(
                        <SharedEmotePickerGrid
                          isPersonal={!!selectedServer.isPersonal}
                          hasSearchQuery={hasEmojiSearchQuery}
                          items={filteredSelectedEmoteItems}
                          disabled={selectedIsExternal && !canUseSelectedEmojiServer}
                          resolveAssetUrl={(item) => resolveExpressionAssetUrl(item.expression, item.sourceUrl, 32)}
                          onSelect={(item) => insertExpression('emote', item.expression, item.sourceUrl, !!selectedServer.isPersonal)}
                        />
                      )}
                    />
                  )}
                  {selectedServer && selectedManifest && pickerTab === 'stickers' && (
                    <SharedExpressionTabContent
                      warningText={!selectedServer.isDefault && selectedIsExternal && !canUseSelectedStickerServer
                        ? 'External stickers are not allowed for your current permissions.'
                        : null}
                      isDefault={!!selectedServer.isDefault}
                      defaultFallbackText="Default stickers are not available."
                      nonDefaultContent={(
                        <SharedStickerPickerGrid
                          isPersonal={!!selectedServer.isPersonal}
                          hasSearchQuery={hasEmojiSearchQuery}
                          items={filteredSelectedStickerItems}
                          disabled={selectedIsExternal && !canUseSelectedStickerServer}
                          resolveAssetUrl={(item) => resolveExpressionAssetUrl(item.expression, item.sourceUrl, 320)}
                          onSelect={(item) => insertExpression('sticker', item.expression, item.sourceUrl, !!selectedServer.isPersonal)}
                        />
                      )}
                    />
                  )}
                  </SharedExpressionPickerBodyState>
            </SharedExpressionPickerPanel>
          ) : null}
        />
        {voiceMode ? (
          <div className="flex-1 px-2 py-1">
            <VoiceMessageRecorder
              onCancel={() => setVoiceMode(false)}
              onSend={handleVoiceSend}
              disabled={!canSendInCurrentContext}
            />
          </div>
        ) : (
          <DMComposerCore
            ref={composerCoreRef}
            onInput={(value, caret) => { if (allowText && canSendInCurrentContext) handleChange(value, caret); }}
            onFilePaste={canSendMedia ? (files) => { void handleFiles(Array.from(files)); } : undefined}
            onKeyDown={allowText && canSendInCurrentContext ? handleKeyDown : undefined}
            placeholder={!canSendInCurrentContext ? t('chat.noSendPermission') : (allowText ? t('chat.sendMessagePlaceholder') : t('chat.mediaOnlyChannel'))}
            disabled={!allowText || !canSendInCurrentContext}
            rightSlot={(
              <div className="flex items-center">
                {/* Only realms with slash commands get the picker button. */}
                {botCommands.length > 0 && (
                  <ComposerIconButton
                    action={{
                      onClick: () => { void openCommandPicker(); },
                      title: 'Bot commands',
                      disabled: !canSendInCurrentContext || !allowText,
                    }}
                    className="px-2 py-2.5 text-text-muted hover:text-indigo-400 transition-colors disabled:opacity-40"
                  >
                    <span className="text-xs font-bold tracking-tight">[ / ]</span>
                  </ComposerIconButton>
                )}
                <ComposerIconButton
                  action={{
                    onClick: handleVoiceToggle,
                    title: voiceMode ? 'Cancel voice recording' : 'Record voice message',
                    disabled: !canSendInCurrentContext,
                  }}
                  className={`px-2 py-2.5 transition-colors disabled:opacity-40 ${voiceMode ? 'text-red-400' : 'text-text-muted hover:text-accent'}`}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z" />
                  </svg>
                </ComposerIconButton>
                <ComposerSendButton
                  action={sendButtonAction ?? {}}
                  ready={readyCount > 0 && !hasUploading}
                />
              </div>
            )}
          />
        )}
      </SharedComposerShell>
      {/* Suggestion popups — absolutely positioned above the composer */}
      {(emoteSuggestOpen || mentionOpen || cmdOpen || optOpen) && (
        <div className="absolute bottom-full left-0 right-0 z-50 mb-1">
          <ComposerOptionSuggestionList
            open={optOpen}
            title={optTitle}
            items={optItems}
            activeIndex={optIndex}
            onSelect={applyOptionSuggestion}
          />
          <ComposerCommandSuggestionList
            open={cmdOpen}
            items={cmdItems}
            activeIndex={cmdIndex}
            serverUrl={serverUrl}
            onSelect={applyCommandSuggestion}
          />
          <ComposerEmoteSuggestionList
            open={emoteSuggestOpen}
            items={emoteSuggestItems}
            activeIndex={emoteSuggestIndex}
            onSelect={applyEmoteSuggestion}
          />
          <ComposerMentionSuggestionList
            open={mentionOpen}
            items={mentionItems}
            activeIndex={mentionIndex}
            serverUrl={serverUrl}
            authBase={AUTH_BASE}
            onSelect={applyMentionSuggestion}
          />
        </div>
      )}
      </div>
      <ComposerUploadPreviewStrip
        items={attachments}
        onRemove={(item) => {
          if (activeDraftKey) {
            applyAttachmentDraftUpdate(activeDraftKey, (prev) => prev.filter((a) => a.id !== item.id));
          } else {
            URL.revokeObjectURL(item.previewUrl);
            setAttachments((prev) => prev.filter((a) => a.id !== item.id));
          }
        }}
        onRetry={async (item) => {
          const draftKey = activeDraftKey;
          const uploadChannelId = activeChannelId;
          const updater = (prev: AttachmentItem[]) => prev.map((a) =>
            a.id === item.id ? { ...a, status: 'uploading' as const, progress: 0, error: null } : a
          );
          if (draftKey) {
            applyAttachmentDraftUpdate(draftKey, updater);
            applyAttachmentDraftPatch(draftKey, { uploading: true, uploadError: null });
          } else {
            setAttachments(updater);
            setUploading(true);
            setUploadError(null);
          }
          await uploadFile(item, draftKey, uploadChannelId);
          if (draftKey) applyAttachmentDraftPatch(draftKey, { uploading: false });
          else setUploading(false);
        }}
        onInsertTag={(tag) => {
          composerCoreRef.current?.insertTextAtCaret(tag, false);
          composerCoreRef.current?.focus();
        }}
      />
      {uploadError && (
        <div className="mt-1 text-xs text-danger">{uploadError}</div>
      )}
      {commandError && (
        <div className="mt-1 flex items-center gap-2 text-xs text-danger">
          <span>{commandError}</span>
          <button type="button" className="underline text-text-muted" onClick={() => setCommandError(null)}>dismiss</button>
        </div>
      )}
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
        open={voiceAutoDeleteOpen}
        onConfirm={handleVoiceAutoDeleteConfirm}
        onCancel={() => {
          setVoiceAutoDeleteOpen(false);
          setPendingVoiceAttachment(null);
        }}
      />
      <ScheduleMessageModal
        open={scheduleModalOpen}
        onClose={() => { setScheduleModalOpen(false); setPendingSendPayload(null); }}
        onConfirm={handleScheduleConfirm}
        context="server"
      />
      <Modal
        open={nsfwModalOpen}
        onClose={() => {
          setNsfwModalOpen(false);
          setPendingSendPayload(null);
        }}
        title="NSFW Media Check"
        className="max-w-2xl"
      >
        {!pendingSendPayload || pendingSendPayload.readyAttachments.length === 0 ? (
          <div className="text-sm text-text-muted">No media attachments to tag.</div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-text-secondary">
              Do any media attachments contain NSFW content? Select subtags per attachment, or apply tags to all and send.
            </p>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setNsfwAttachmentIndex((i) => Math.max(0, i - 1))}
                disabled={nsfwAttachmentIndex <= 0}
                className="px-2 py-1 rounded border border-border text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-50"
              >
                &lt;
              </button>
              <div className="flex-1 overflow-x-auto whitespace-nowrap space-x-1">
                {pendingSendPayload.readyAttachments.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setNsfwAttachmentIndex(index)}
                    className={`px-2 py-1 rounded text-xs border ${
                      index === nsfwAttachmentIndex
                        ? 'bg-accent text-white border-accent'
                        : 'bg-bg-input border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                    }`}
                  >
                    Attachment {index + 1}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() =>
                  setNsfwAttachmentIndex((i) => Math.min(pendingSendPayload.readyAttachments.length - 1, i + 1))
                }
                disabled={nsfwAttachmentIndex >= pendingSendPayload.readyAttachments.length - 1}
                className="px-2 py-1 rounded border border-border text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-50"
              >
                &gt;
              </button>
            </div>

            {currentNsfwAttachment && (
              <div className="rounded border border-border bg-bg-input p-3 space-y-3">
                <div className="text-xs text-text-muted truncate">{currentNsfwAttachment.file.name}</div>
                <div className="rounded overflow-hidden border border-border bg-black/20">
                  {currentNsfwAttachment.file.type.startsWith('video/') ? (
                    <video
                      src={currentNsfwAttachment.previewUrl}
                      className="w-full max-h-52 object-contain"
                      muted
                      controls
                    />
                  ) : (
                    <img
                      src={currentNsfwAttachment.previewUrl}
                      alt={currentNsfwAttachment.file.name}
                      className="w-full max-h-52 object-contain"
                    />
                  )}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {NSFW_TAG_KEYS.map((tag) => (
                    <label key={tag} className="flex items-center gap-2 text-sm text-text-primary">
                      <input
                        type="checkbox"
                        checked={!!currentNsfwAttachmentTags[tag]}
                        onChange={(e) => setCurrentAttachmentTag(tag, e.target.checked)}
                        className="h-4 w-4 rounded border-border bg-bg-chat"
                      />
                      {tag.charAt(0).toUpperCase() + tag.slice(1)}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="rounded border border-border bg-bg-input p-3 space-y-2">
              <div className="text-xs uppercase tracking-wide text-text-muted">Apply to All Attachments</div>
              <div className="grid grid-cols-4 gap-2">
                {NSFW_TAG_KEYS.map((tag) => (
                  <label key={`global-${tag}`} className="flex items-center gap-2 text-sm text-text-primary">
                    <input
                      type="checkbox"
                      checked={!!globalNsfwTags[tag]}
                      onChange={(e) =>
                        setGlobalNsfwTags((prev) => ({
                          ...prev,
                          [tag]: e.target.checked,
                        }))
                      }
                      className="h-4 w-4 rounded border-border bg-bg-chat"
                    />
                    {tag.charAt(0).toUpperCase() + tag.slice(1)}
                  </label>
                ))}
                <button
                  type="button"
                  onClick={handleApplyAllAndSend}
                  className="col-span-1 px-3 py-1.5 rounded border border-accent bg-accent text-white text-xs hover:opacity-90"
                >
                  Apply All &amp; Send
                </button>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setNsfwModalOpen(false);
                  setPendingSendPayload(null);
                }}
                className="px-3 py-1.5 rounded border border-border text-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSendWithoutNsfw}
                className="px-3 py-1.5 rounded border border-border text-sm text-text-primary hover:bg-bg-hover"
              >
                No NSFW, Send
              </button>
              <button
                type="button"
                onClick={handleSendWithNsfwSelections}
                className="px-3 py-1.5 rounded border border-accent bg-accent text-white text-sm hover:opacity-90"
              >
                Send with Tags
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
