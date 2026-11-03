import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Image, Platform, StyleSheet, Switch, TextInput, TouchableOpacity, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { File, Mic, Paperclip, Send, Smile, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/theme';
import { Text } from './Text';
import type { UploadedAttachment } from '@/lib/uploadApi';
import {
  getOrigin,
  normalizeExprName,
  prefetchExpressions,
  useExpressionLookup,
  type ExpressionEntry,
  type ExpressionLookup,
} from '@/lib/expressionCache';
import { useAuthStore } from '@/stores/authStore';
import { useServerStore } from '@/stores/serverStore';
import { useUIStore } from '@/stores/uiStore';
import { IconBtn } from './IconBtn';
import { ExpressionPicker } from './ExpressionPicker';
import { BotCommandPicker } from './BotCommandPicker';
import { BotBadge } from './BotBadge';
import { MentionSuggestionList } from './MentionSuggestionList';
import { EmoteSuggestionList } from './EmoteSuggestionList';
import {
  activeEmoteQuery,
  buildEmoteSuggestions,
  replaceCompletedEmojiShortcodes,
  type EmoteSuggestion,
} from '@/lib/emoteSuggestions';
import { usePresenceStore } from '@/stores/presenceStore';
import { activeMentionQuery, buildMentionSuggestions, type MentionSuggestion } from '@/lib/mentionSuggestions';
import { VoiceExpirySheet, VoiceRecorderBar } from './VoiceRecorderBar';
import { VOICE_RECORDING_MIME, VOICE_RECORDING_NAME } from '@/lib/voiceMessages';
import { createApi } from '@/lib/api';
import { filterExpressionLookup } from '@/lib/expressionPermissions';
import { getSocket } from '@/lib/socket';
import type { BotCommand, BotScope, Role } from '@/types';

type PendingAttachment = {
  localUri: string;
  name: string;
  mime: string;
  isImage: boolean;
  isNsfw: boolean;
  uploaded: UploadedAttachment | null;
  uploading: boolean;
  error: string | null;
};

// Attachment kept on-device until send (DM/group flows post multipart to central
// instead of pre-uploading to the game server).
export type LocalComposerAttachment = {
  uri: string;
  name: string;
  mime: string;
  isNsfw: boolean;
};

export type UploadedComposerAttachment = UploadedAttachment & { isNsfw: boolean };

/** Voice notes carry an absolute auto-delete time (ms) or null for "keep". */
export type ComposerSendOptions = { voiceExpiresAt: number | null };

type MobileComposerProps = {
  value: string;
  onChangeText: (text: string) => void;
  onSend: (
    serializedText?: string,
    attachments?: UploadedComposerAttachment[],
    localAttachments?: LocalComposerAttachment[],
    options?: ComposerSendOptions,
  ) => void;
  placeholder: string;
  disabled?: boolean;
  allowText?: boolean;
  bottomInset: SharedValue<number>;
  expressionLookup?: ExpressionLookup | null;
  serverUrl?: string | null;
  channelId?: string;
  /** Skip the game-server pre-upload; hand the picked file to onSend as localAttachment. */
  deferUpload?: boolean;
  /** Enable realm bot slash commands for this composer. */
  botCommandsEnabled?: boolean;
  canUseExternalEmotes?: boolean;
  canUseExternalStickers?: boolean;
  /** Show the mic button; the screen's onSend must forward options.voiceExpiresAt. */
  voiceMessages?: boolean;
  /** Offer @mention suggestions from the active realm's members and roles. */
  mentionsEnabled?: boolean;
};

const DISPLAY_EXPR_RE = /:(sticker:)?([a-z0-9_-]{1,64}):/gi;
const COMPACT_EXPR_WITH_ORIGIN_OR_OWNER_RE = /:https?:\/\/[^\s:]+(?::\d{1,5})?:(?:sticker:)?[a-z0-9_-]{1,64}(?::[a-z0-9_-]{3,128})?:|:(?:sticker:)?[a-z0-9_-]{1,64}:[a-z0-9_-]{3,128}:/gi;

type ComposerWebMessage =
  | { type: 'input'; value: string; height: number; beforeCaret?: string | null }
  | { type: 'height'; height: number };

function buildSerializedToken(
  item: ExpressionEntry,
  isSticker: boolean,
  currentServerUrl: string | null | undefined,
): string {
  const prefix = isSticker ? 'sticker:' : '';
  const origin = item.origin ? getOrigin(item.origin) : null;
  const currentOrigin = currentServerUrl ? getOrigin(currentServerUrl) : null;
  const ownerId = item.ownerId?.toLowerCase().replace(/[^a-z0-9_-]/g, '') ?? '';
  const name = normalizeExprName(item.name);

  if (origin && origin !== currentOrigin) {
    return ownerId
      ? `:${origin}:${prefix}${name}:${ownerId}:`
      : `:${origin}:${prefix}${name}:`;
  }
  return ownerId ? `:${prefix}${name}:${ownerId}:` : `:${prefix}${name}:`;
}

function serializeComposerText(
  text: string,
  lookup: ExpressionLookup | null | undefined,
  currentServerUrl: string | null | undefined,
): string {
  const withShortcodes = replaceCompletedEmojiShortcodes(text, lookup);
  if (!lookup) return withShortcodes;
  const protectedTokens: string[] = [];
  const protectedText = withShortcodes.replace(COMPACT_EXPR_WITH_ORIGIN_OR_OWNER_RE, (match) => {
    protectedTokens.push(match);
    return `\uF901${protectedTokens.length - 1}\uF901`;
  });

  const converted = protectedText.replace(DISPLAY_EXPR_RE, (match, stickerPrefix: string | undefined, rawName: string) => {
    const normalized = normalizeExprName(rawName);
    const entry = [...lookup.values()].find((candidate) => {
      if (normalizeExprName(candidate.name) !== normalized) return false;
      return stickerPrefix ? Boolean(candidate.sticker) : Boolean(candidate.emote);
    });
    if (!entry) return match;
    return buildSerializedToken(entry, Boolean(stickerPrefix), currentServerUrl);
  });
  return converted.replace(/\uF901(\d+)\uF901/g, (_match, index: string) => protectedTokens[Number(index)] ?? '');
}

function composerHtml(placeholder: string, textColor: string, placeholderColor: string, accentColor: string, allowText = true) {
  return `<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      background: transparent;
      color: ${textColor};
      font: 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      overflow: hidden;
    }
    #editor {
      display: block;
      width: 100%;
      min-height: 40px;
      box-sizing: border-box;
      padding: 9px 0;
      line-height: 21px;
      outline: none;
      overflow-y: hidden;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
      caret-color: ${accentColor};
      -webkit-user-select: text;
      user-select: text;
    }
    #editor:empty::before {
      content: attr(data-placeholder);
      color: ${placeholderColor};
      pointer-events: none;
    }
    #editor[contenteditable="false"] {
      pointer-events: none;
      cursor: default;
      opacity: 0.5;
    }
    img[data-token] {
      display: inline-block;
      width: 22px;
      height: 22px;
      object-fit: contain;
      vertical-align: -5px;
      user-select: all;
      -webkit-user-select: all;
    }
    img[data-sticker="1"] {
      width: 28px;
      height: 28px;
      vertical-align: -8px;
    }
  </style>
</head>
<body>
  <div id="editor" contenteditable="${allowText}" role="textbox" data-placeholder="${placeholder.replace(/"/g, '&quot;')}"></div>
  <script>
    const editor = document.getElementById('editor');
    const MIN_HEIGHT = 40;
    const MAX_HEIGHT = 120;

    function clampHeight(value) {
      return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, value || MIN_HEIGHT));
    }

    function measureHeight() {
      editor.style.height = 'auto';
      const nextHeight = clampHeight(Math.ceil(editor.scrollHeight || MIN_HEIGHT));
      editor.style.height = nextHeight + 'px';
      editor.style.overflowY = nextHeight >= MAX_HEIGHT ? 'auto' : 'hidden';
      // Keep the active typing line visible when content exceeds max height.
      if (nextHeight >= MAX_HEIGHT) {
        editor.scrollTop = editor.scrollHeight;
      } else {
        editor.scrollTop = 0;
      }
      return nextHeight;
    }

    function serialize() {
      const clone = editor.cloneNode(true);
      clone.querySelectorAll('img[data-token]').forEach((img) => {
        const token = img.dataset.token || '';
        img.replaceWith(document.createTextNode(token));
      });
      return (clone.innerText || '')
        .replace(/\\r/g, '')
        .replace(/\\u00a0/g, ' ')
        .replace(/\\n+$/g, '');
    }

    // Plain text up to the caret (nbsp as a space) so React can spot an @mention being typed.
    function textBeforeCaret() {
      const selection = window.getSelection();
      if (!selection.rangeCount || !editor.contains(selection.anchorNode)) return null;
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.setEnd(selection.anchorNode, selection.anchorOffset);
      const div = document.createElement('div');
      div.appendChild(range.cloneContents());
      return (div.innerText || '').replace(/\\r/g, '').replace(/\\u00a0/g, ' ');
    }

    function post(type) {
      const height = measureHeight();
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type,
        value: serialize(),
        height,
        beforeCaret: type === 'input' ? textBeforeCaret() : undefined
      }));
    }

    function focusEnd() {
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }

    function insertNodes(nodes) {
      editor.focus();
      const selection = window.getSelection();
      let range;
      if (selection.rangeCount && editor.contains(selection.getRangeAt(0).startContainer)) {
        range = selection.getRangeAt(0);
        range.deleteContents();
      } else {
        range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
      }
      for (const node of nodes) {
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
      }
      selection.removeAllRanges();
      selection.addRange(range);
      post('input');
    }

    function currentValueBeforeCaret() {
      const selection = window.getSelection();
      if (!selection.rangeCount) return serialize();
      const range = selection.getRangeAt(0).cloneRange();
      range.selectNodeContents(editor);
      range.setEnd(selection.anchorNode, selection.anchorOffset);
      const div = document.createElement('div');
      div.appendChild(range.cloneContents());
      return (div.innerText || '').replace(/\\r/g, '').replace(/\\u00a0/g, '');
    }

    window.CatRealmComposer = {
      setText(value) {
        // Rewriting identical text would only reset the caret mid-typing.
        if (serialize() === (value || '')) return;
        editor.textContent = value || '';
        post('input');
      },
      insertText(value) {
        const before = currentValueBeforeCaret();
        const nodes = [];
        if (before.length > 0 && !/\\s$/.test(before)) nodes.push(document.createTextNode(' '));
        nodes.push(document.createTextNode(value));
        insertNodes(nodes);
      },
      insertExpression(token, url, name, isSticker) {
        const before = currentValueBeforeCaret();
        const nodes = [];
        if (before.length > 0 && !/\\s$/.test(before)) nodes.push(document.createTextNode(' '));
        const img = document.createElement('img');
        img.src = url;
        img.alt = ':' + name + ':';
        img.title = ':' + name + ':';
        img.dataset.token = token;
        if (isSticker) img.dataset.sticker = '1';
        img.contentEditable = 'false';
        nodes.push(img);
        insertNodes(nodes);
      },
      // Swap the ":query" right before the caret for a picked emoji or custom emote.
      replaceEmote(insert, url, name, isSticker) {
        const selection = window.getSelection();
        if (!selection.rangeCount) return;
        let node = selection.anchorNode;
        let offset = selection.anchorOffset;
        if (node === editor && offset > 0 && editor.childNodes[offset - 1] && editor.childNodes[offset - 1].nodeType === 3) {
          node = editor.childNodes[offset - 1];
          offset = node.textContent.length;
        }
        if (!node || node.nodeType !== 3 || !editor.contains(node)) return;
        const text = (node.textContent || '').replace(/\u00a0/g, ' ');
        const colon = text.slice(0, offset).lastIndexOf(':');
        if (colon === -1) return;
        if (url) {
          const beforeText = text.slice(0, colon);
          const afterText = text.slice(offset).replace(/^ /, '');
          node.textContent = beforeText;
          const img = document.createElement('img');
          img.src = url;
          img.alt = ':' + name + ':';
          img.title = ':' + name + ':';
          img.dataset.token = insert;
          if (isSticker) img.dataset.sticker = '1';
          img.contentEditable = 'false';
          const spaceNode = document.createTextNode(' ' + afterText);
          const parent = node.parentNode || editor;
          const nextSibling = node.nextSibling;
          parent.insertBefore(img, nextSibling);
          parent.insertBefore(spaceNode, nextSibling);
          const range = document.createRange();
          range.setStart(spaceNode, 1);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
          editor.focus();
          post('input');
          return;
        }
        const inserted = insert + ' ';
        node.textContent = text.slice(0, colon) + inserted + text.slice(offset).replace(/^ /, '');
        const range = document.createRange();
        range.setStart(node, colon + inserted.length);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        editor.focus();
        post('input');
      },
      // Swap the "@query" right before the caret for a picked mention.
      replaceMention(insert) {
        const selection = window.getSelection();
        if (!selection.rangeCount) return;
        let node = selection.anchorNode;
        let offset = selection.anchorOffset;
        if (node === editor && offset > 0 && editor.childNodes[offset - 1] && editor.childNodes[offset - 1].nodeType === 3) {
          node = editor.childNodes[offset - 1];
          offset = node.textContent.length;
        }
        if (!node || node.nodeType !== 3 || !editor.contains(node)) return;
        const text = (node.textContent || '').replace(/\\u00a0/g, ' ');
        const at = text.slice(0, offset).lastIndexOf('@');
        if (at === -1) return;
        const inserted = insert + ' ';
        node.textContent = text.slice(0, at) + inserted + text.slice(offset).replace(/^ /, '');
        const range = document.createRange();
        range.setStart(node, at + inserted.length);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        editor.focus();
        post('input');
      },
      clear() {
        editor.textContent = '';
        post('input');
      },
      blur() {
        editor.blur();
      },
      focusEnd,
    };

    // Android WebView can deliver input, key and mutation events for the same
    // keystroke. Coalesce them so fast typing cannot build a queue of layout
    // reads and React Native bridge messages. Never let a height-only event
    // downgrade a pending input update or the latest text could be missed.
    let postFrame = 0;
    let pendingPostType = null;
    function schedulePost(type) {
      if (type === 'input' || !pendingPostType) pendingPostType = type;
      if (postFrame) return;
      postFrame = requestAnimationFrame(() => {
        const nextType = pendingPostType || 'height';
        postFrame = 0;
        pendingPostType = null;
        post(nextType);
      });
    }

    editor.addEventListener('input', () => schedulePost('input'));
    editor.addEventListener('focus', () => schedulePost('height'));
    new MutationObserver(() => schedulePost('height')).observe(editor, { childList: true, subtree: true, characterData: true });
    // iOS can run the first measure before the WebView has its final width;
    // at a near-zero width the placeholder wraps per character and the box
    // locks at max height. Measure again whenever the width settles.
    let lastWidth = 0;
    function remeasureOnWidthChange() {
      const width = document.documentElement.clientWidth;
      if (!width || width === lastWidth) return;
      lastWidth = width;
      schedulePost('height');
    }
    window.addEventListener('resize', remeasureOnWidthChange);
    if (window.ResizeObserver) new ResizeObserver(remeasureOnWidthChange).observe(document.documentElement);
    setTimeout(() => post('height'), 50);
  </script>
</body>
</html>`;
}

export function MobileComposer({
  value,
  onChangeText,
  onSend,
  placeholder,
  disabled = false,
  allowText = true,
  bottomInset,
  expressionLookup,
  serverUrl,
  channelId,
  deferUpload,
  botCommandsEnabled = false,
  canUseExternalEmotes = true,
  canUseExternalStickers = true,
  voiceMessages = false,
  mentionsEnabled = false,
}: MobileComposerProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [commandPickerOpen, setCommandPickerOpen] = useState(false);
  const [commandPickerInitial, setCommandPickerInitial] = useState<BotCommand | null>(null);
  const [botCommands, setBotCommands] = useState<BotCommand[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [voiceUri, setVoiceUri] = useState<string | null>(null);
  const [voiceSending, setVoiceSending] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [emoteQuery, setEmoteQuery] = useState<string | null>(null);
  const [mentionRoles, setMentionRoles] = useState<Role[]>([]);
  const mentionMembers = usePresenceStore((s) => s.allMembers);
  const mentionAlias = useAuthStore((s) => s.serverInfo?.mentionAlias);
  const token = useAuthStore((s) => s.token);
  const authServerUrl = useAuthStore((s) => s.serverUrl);
  const isCentralAccount = useAuthStore((s) => s.user?.accountType === 'central');
  const activeServer = useServerStore((s) => s.activeServerId ? s.byId(s.activeServerId) : undefined);
  const activeServerUrl = activeServer?.url;
  const activeServerToken = activeServer?.token || undefined;
  const firstServerUrl = useServerStore((s) => s.servers[0]?.url);
  const channelsSheetOpen = useUIStore((s) => s.channelsSheetOpen);
  const effectiveServerUrl = serverUrl ?? activeServerUrl ?? firstServerUrl ?? authServerUrl;
  const composerExpressionLookup = useExpressionLookup(effectiveServerUrl);
  const pickerExpressionLookup = composerExpressionLookup ?? expressionLookup;
  const webRef = useRef<WebView<object>>(null);
  const [editorHeight, setEditorHeight] = useState(40);
  const webValueRef = useRef('');
  // Every value the editor itself reported since React last pushed text into it.
  // While typing fast, an effect from an older render can run after a newer
  // keystroke arrived; its stale `value` must not be written back over the editor.
  const webReportedRef = useRef(new Set<string>());
  const animStyle = useAnimatedStyle(() => ({ paddingBottom: Math.max(14, bottomInset.value + 10) }));
  const effectiveExpressionLookup = useMemo(
    () => filterExpressionLookup(pickerExpressionLookup ?? expressionLookup, effectiveServerUrl, canUseExternalEmotes, canUseExternalStickers),
    [pickerExpressionLookup, expressionLookup, effectiveServerUrl, canUseExternalEmotes, canUseExternalStickers],
  );
  const typedCommandName = /^\/([a-z0-9_-]+)(?:\s|$)/i.exec(value.trimStart())?.[1]?.toLowerCase() ?? null;
  const typedCommand = typedCommandName
    ? botCommands.find((command) => command.name.toLowerCase() === typedCommandName) ?? null
    : null;

  const fetchBotCommands = useCallback(async () => {
    if (!botCommandsEnabled || !effectiveServerUrl) return;
    try {
      const res = await createApi(effectiveServerUrl, activeServerToken).get<{ commands?: BotCommand[] }>('/api/bots/commands');
      setBotCommands(Array.isArray(res.data?.commands) ? res.data.commands : []);
    } catch {
      setBotCommands([]);
    }
  }, [activeServerToken, botCommandsEnabled, effectiveServerUrl]);

  useEffect(() => {
    void fetchBotCommands();
    if (!botCommandsEnabled) return;
    const socket = getSocket();
    const refresh = () => { void fetchBotCommands(); };
    socket?.on('bots:commands_updated', refresh);
    return () => { socket?.off('bots:commands_updated', refresh); };
  }, [botCommandsEnabled, fetchBotCommands]);

  // Realms only return mentionable roles from /api/roles, same as desktop.
  useEffect(() => {
    if (!mentionsEnabled || !effectiveServerUrl) {
      setMentionRoles([]);
      return;
    }
    let cancelled = false;
    createApi(effectiveServerUrl, activeServerToken)
      .get<Role[]>('/api/roles')
      .then((res) => { if (!cancelled) setMentionRoles(Array.isArray(res.data) ? res.data : []); })
      .catch(() => { if (!cancelled) setMentionRoles([]); });
    return () => { cancelled = true; };
  }, [activeServerToken, effectiveServerUrl, mentionsEnabled]);

  const mentionSuggestions = useMemo(
    () => (mentionQuery === null ? [] : buildMentionSuggestions(mentionQuery, mentionMembers, mentionRoles, mentionAlias)),
    [mentionAlias, mentionMembers, mentionQuery, mentionRoles],
  );
  const emoteSuggestions = useMemo(
    () => (emoteQuery === null ? [] : buildEmoteSuggestions(emoteQuery, effectiveExpressionLookup, effectiveServerUrl)),
    [emoteQuery, effectiveExpressionLookup, effectiveServerUrl],
  );

  const inputHtml = useMemo(
    () => composerHtml(placeholder, theme.colors.text, theme.colors.text3, theme.colors.accent, allowText),
    [allowText, placeholder, theme.colors.accent, theme.colors.text, theme.colors.text3],
  );

  const injectComposerCommand = useCallback((name: string, args: unknown[]) => {
    const serializedArgs = args.map((arg) => JSON.stringify(arg)).join(',');
    webRef.current?.injectJavaScript(
      `window.CatRealmComposer && window.CatRealmComposer.${name}(${serializedArgs}); true;`,
    );
  }, []);

  useEffect(() => {
    if (channelsSheetOpen) injectComposerCommand('blur', []);
  }, [channelsSheetOpen, injectComposerCommand]);

  useEffect(() => {
    if (value === webValueRef.current || webReportedRef.current.has(value)) return;
    webValueRef.current = value;
    webReportedRef.current.clear();
    injectComposerCommand('setText', [value]);
  }, [injectComposerCommand, value]);

  useEffect(() => {
    const ce = allowText ? 'true' : 'false';
    webRef.current?.injectJavaScript(
      `var e=document.getElementById('editor');if(e){e.contentEditable='${ce}';}true;`,
    );
  }, [allowText]);

  const handleExpressionSelect = (
    displayToken: string,
    serializedToken?: string,
    preview?: { name: string; url: string; isSticker: boolean },
  ) => {
    if (serializedToken && preview) {
      injectComposerCommand('insertExpression', [
        serializedToken,
        preview.url,
        normalizeExprName(preview.name),
        preview.isSticker,
      ]);
      return;
    }
    injectComposerCommand('insertText', [displayToken]);
  };

  const handlePickFile = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        quality: 1,
        allowsEditing: false,
        allowsMultipleSelection: true,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const pending = result.assets.map((asset, index): PendingAttachment => {
        const mime = asset.mimeType ?? (asset.type === 'video' ? 'video/mp4' : 'image/jpeg');
        const isImage = mime.startsWith('image/');
        const extension = ({ 'image/jpeg': 'jpg', 'video/quicktime': 'mov' } as Record<string, string>)[mime]
          ?? mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '')
          ?? (isImage ? 'jpg' : 'mp4');
        const name = asset.fileName ?? `${isImage ? 'photo' : 'video'}-${index + 1}.${extension}`;
        return {
          localUri: asset.uri,
          name,
          mime,
          isImage,
          isNsfw: false,
          uploaded: null,
          uploading: !deferUpload,
          error: null,
        };
      });
      await stageAttachments(pending);
    } catch (error) {
      Alert.alert(t('chat.uploadFailed'), error instanceof Error ? error.message : t('chat.uploadFailed'));
    }
  };

  // Realms take zip/rar/7z as downloads; the realm checks the file really is an archive.
  const handlePickArchive = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/zip', 'application/x-zip-compressed', 'application/vnd.rar', 'application/x-rar-compressed', 'application/x-7z-compressed', 'application/octet-stream'],
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.length) return;
      const pending = result.assets.map((asset): PendingAttachment => ({
        localUri: asset.uri,
        name: asset.name,
        mime: asset.mimeType || 'application/octet-stream',
        isImage: false,
        isNsfw: false,
        uploaded: null,
        uploading: true,
        error: null,
      }));
      await stageAttachments(pending);
    } catch (error) {
      Alert.alert(t('chat.uploadFailed'), error instanceof Error ? error.message : t('chat.uploadFailed'));
    }
  };

  const handleAttachPress = () => {
    // DMs send files through Central, which doesn't take archives; realms do.
    if (deferUpload) {
      void handlePickFile();
      return;
    }
    Alert.alert(t('chat.attachFile'), undefined, [
      { text: t('chat.attachMedia'), onPress: () => { void handlePickFile(); } },
      { text: t('chat.attachArchive'), onPress: () => { void handlePickArchive(); } },
      { text: t('common.cancel'), style: 'cancel' },
    ]);
  };

  const stageAttachments = async (pending: PendingAttachment[]) => {
    setPendingAttachments(pending);

    if (deferUpload) return; // file goes up with the send request instead

    const { uploadChatFile } = await import('@/lib/uploadApi');
    await Promise.all(pending.map(async (item) => {
      try {
        const uploaded = await uploadChatFile(item.localUri, item.mime, item.name, channelId, effectiveServerUrl);
        setPendingAttachments((prev) => prev.map((entry) =>
          entry.localUri === item.localUri ? { ...entry, uploaded, uploading: false } : entry
        ));
      } catch (err) {
        const msg = err instanceof Error ? err.message : t('chat.uploadFailed');
        setPendingAttachments((prev) => prev.map((entry) =>
          entry.localUri === item.localUri ? { ...entry, uploading: false, error: msg } : entry
        ));
        Alert.alert(t('chat.uploadFailed'), msg);
      }
    }));
  };

  const clearComposer = () => {
    onChangeText('');
    webValueRef.current = '';
    webReportedRef.current.clear();
    setMentionQuery(null);
    setEmoteQuery(null);
    injectComposerCommand('clear', []);
  };

  const selectMention = (item: MentionSuggestion) => {
    setMentionQuery(null);
    if (Platform.OS === 'web') {
      const next = value.replace(/(?:^|\s)@[^\s@]*$/, (m) => (m.startsWith(' ') ? ' ' : '') + item.insert + ' ');
      webValueRef.current = next;
      onChangeText(next);
      return;
    }
    injectComposerCommand('replaceMention', [item.insert]);
  };

  const selectEmoteSuggestion = (item: EmoteSuggestion) => {
    setEmoteQuery(null);
    if (Platform.OS === 'web') {
      const next = value.replace(/(?:^|\s):[a-z0-9_+-]{2,32}$/i, (m) => {
        const leading = /^\s/.test(m) ? m[0] : '';
        return leading + item.insert + ' ';
      });
      webValueRef.current = next;
      onChangeText(next);
      return;
    }
    injectComposerCommand('replaceEmote', [
      item.insert,
      item.previewImage ?? null,
      item.name ?? '',
      Boolean(item.isSticker),
    ]);
  };

  const invokeBotCommand = async (command: BotCommand, options: Record<string, string | number | boolean>): Promise<boolean> => {
    if (!channelId || !effectiveServerUrl) return false;
    const emitInvoke = () => new Promise<{ status?: string; error?: string; requestedScopes?: BotScope[] }>((resolve) => {
      const socket = getSocket();
      if (!socket) return resolve({ status: 'error', error: 'Not connected' });
      socket.emit('interaction:invoke', { botId: command.botId, command: command.name, channelId, threadId: null, options }, resolve);
    });
    let ack = await emitInvoke();
    if (ack.status === 'consent_required') {
      const allowed = await new Promise<boolean>((resolve) => {
        Alert.alert(
          `Allow ${command.botDisplayName ?? command.botUsername}?`,
          'This bot needs your permission before you can use its commands.',
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Allow', onPress: () => resolve(true) },
          ],
          { cancelable: true, onDismiss: () => resolve(false) },
        );
      });
      if (!allowed) return false;
      const requested = ack.requestedScopes?.length ? ack.requestedScopes : ['interactions'] as BotScope[];
      const scopes = Object.fromEntries(requested.map((scope) => [scope, true]));
      try {
        await createApi(effectiveServerUrl, activeServerToken).put(`/api/bots/${command.botId}/consent`, { decision: 'allowed', scopes });
      } catch {
        Alert.alert('Bot command failed', 'Could not save bot consent.');
        return false;
      }
      ack = await emitInvoke();
    }
    if (ack.status === 'ok') {
      clearComposer();
      return true;
    }
    const messages: Record<string, string> = {
      denied: 'You have denied this bot. Change its permissions from the bot profile.',
      bot_offline: 'That bot is currently offline.',
      unknown_command: 'That command is no longer available.',
      unknown_bot: 'That bot no longer exists.',
    };
    Alert.alert('Bot command failed', messages[ack.status ?? ''] ?? ack.error ?? 'The command could not be sent.');
    return false;
  };

  const handleSend = () => {
    if (botCommandsEnabled && typedCommand) {
      if (typedCommand.options.length > 0) {
        setCommandPickerInitial(typedCommand);
        setCommandPickerOpen(true);
      } else {
        void invokeBotCommand(typedCommand, {});
      }
      return;
    }
    const serializedText = allowText
      ? serializeComposerText(value, effectiveExpressionLookup, effectiveServerUrl)
      : undefined;
    const attachments = pendingAttachments
      .filter((item) => item.uploaded && !item.error)
      .map((item) => ({ ...item.uploaded!, isNsfw: item.isNsfw }));
    const localAttachments = deferUpload
      ? pendingAttachments
          .filter((item) => !item.error)
          .map((item) => ({
            uri: item.localUri,
            name: item.name,
            mime: item.mime,
            isNsfw: item.isNsfw,
          }))
      : [];
    if (!serializedText && attachments.length === 0 && localAttachments.length === 0) return;
    onSend(
      serializedText,
      attachments.length > 0 ? attachments : undefined,
      localAttachments.length > 0 ? localAttachments : undefined,
    );
    setPendingAttachments([]);
    clearComposer();
  };

  const closeVoice = () => {
    setVoiceUri(null);
    setVoiceRecording(false);
  };

  // Same flow as desktop: realm channels pre-upload to /api/uploads/chat, DMs hand the
  // file to onSend for Central's multipart send.
  const sendVoice = async (voiceExpiresAt: number | null) => {
    const uri = voiceUri;
    if (!uri || voiceSending) return;
    setVoiceUri(null);
    if (deferUpload) {
      onSend(undefined, undefined, [{ uri, name: VOICE_RECORDING_NAME, mime: VOICE_RECORDING_MIME, isNsfw: false }], { voiceExpiresAt });
      closeVoice();
      return;
    }
    setVoiceSending(true);
    try {
      const { uploadChatFile } = await import('@/lib/uploadApi');
      const uploaded = await uploadChatFile(uri, VOICE_RECORDING_MIME, VOICE_RECORDING_NAME, channelId, effectiveServerUrl);
      onSend(undefined, [{ ...uploaded, isNsfw: false }], undefined, { voiceExpiresAt });
      closeVoice();
    } catch (err) {
      // Keep the recording on screen so the user can retry the send.
      Alert.alert(t('chat.uploadFailed'), err instanceof Error ? err.message : t('chat.uploadFailed'));
    } finally {
      setVoiceSending(false);
    }
  };

  const handleEditorMessage = (event: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(event.nativeEvent.data) as ComposerWebMessage;
      if (typeof message.height === 'number') {
        setEditorHeight(Math.max(40, Math.min(120, message.height)));
      }
      if (message.type === 'input') {
        const nextEmoteQ = typeof message.beforeCaret === 'string'
          ? activeEmoteQuery(message.beforeCaret)
          : null;
        setEmoteQuery(nextEmoteQ);
        setMentionQuery(!nextEmoteQ && mentionsEnabled && typeof message.beforeCaret === 'string'
          ? activeMentionQuery(message.beforeCaret)
          : null);
        webValueRef.current = message.value;
        const reported = webReportedRef.current;
        reported.add(message.value);
        if (reported.size > 256) reported.delete(reported.values().next().value as string);
        onChangeText(message.value);
      }
    } catch {
      // Ignore malformed WebView messages.
    }
  };

  const openExpressionPicker = () => {
    if (effectiveServerUrl) prefetchExpressions(effectiveServerUrl);
    setPickerOpen(true);
  };

  return (
    <>
      {pendingAttachments.map((pendingAttachment) => (
        <View key={pendingAttachment.localUri} style={[styles.attachPreview, { backgroundColor: theme.colors.bgElev1, borderColor: theme.colors.lineSoft }]}>
            {pendingAttachment.isImage ? (
              <Image source={{ uri: pendingAttachment.localUri }} style={styles.attachThumb} resizeMode="cover" />
            ) : (
              <View style={[styles.attachThumb, { backgroundColor: theme.colors.bgElev2, alignItems: 'center', justifyContent: 'center' }]}>
                <File color={theme.colors.text3} size={20} />
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Text variant="bodySmall" numberOfLines={1}>{pendingAttachment.name}</Text>
              {pendingAttachment.uploading && (
                <Text variant="caption" color={theme.colors.text3}>{t('chat.uploading')}</Text>
              )}
              {pendingAttachment.error && (
                <Text variant="caption" color={theme.colors.danger}>{pendingAttachment.error}</Text>
              )}
              {(pendingAttachment.uploaded || deferUpload) && !pendingAttachment.uploading && !pendingAttachment.error && (
                <View style={styles.nsfwRow}>
                  <Text variant="caption" color={theme.colors.text3}>{t('chat.markAsNSFW')}</Text>
                  <Switch
                    value={pendingAttachment.isNsfw}
                    onValueChange={(v) => setPendingAttachments((prev) => prev.map((entry) =>
                      entry.localUri === pendingAttachment.localUri ? { ...entry, isNsfw: v } : entry
                    ))}
                    trackColor={{ true: theme.colors.danger, false: theme.colors.bgElev2 }}
                    thumbColor={pendingAttachment.isNsfw ? '#fff' : theme.colors.text3}
                    style={{ transform: [{ scaleX: 0.75 }, { scaleY: 0.75 }] }}
                  />
                </View>
              )}
            </View>
            <TouchableOpacity
              onPress={() => setPendingAttachments((prev) => prev.filter((entry) => entry.localUri !== pendingAttachment.localUri))}
              style={{ padding: 4 }}
            >
              <X color={theme.colors.text3} size={16} />
            </TouchableOpacity>
          </View>
      ))}
      {botCommandsEnabled && typedCommand ? (
        <TouchableOpacity
          onPress={() => { setCommandPickerInitial(typedCommand); setCommandPickerOpen(true); }}
          style={[styles.commandBanner, { backgroundColor: theme.colors.bgElev1, borderColor: theme.colors.lineSoft }]}
        >
          <BotBadge />
          <Text variant="caption" color={theme.colors.text2} numberOfLines={1} style={{ flex: 1 }}>
            Using {typedCommand.botDisplayName ?? typedCommand.botUsername} · /{typedCommand.name}
          </Text>
          <Text variant="caption" color={theme.colors.accent}>{typedCommand.options.length ? 'Fill options' : 'Ready'}</Text>
        </TouchableOpacity>
      ) : null}
      {!voiceRecording && emoteSuggestions.length > 0 ? (
        <EmoteSuggestionList items={emoteSuggestions} onSelect={selectEmoteSuggestion} />
      ) : mentionsEnabled && !voiceRecording ? (
        <MentionSuggestionList items={mentionSuggestions} serverUrl={effectiveServerUrl} onSelect={selectMention} />
      ) : null}
      <Animated.View
        style={[
          styles.wrap,
          {
            backgroundColor: theme.colors.bgApp,
            borderTopColor: theme.colors.lineSoft,
          },
          animStyle,
        ]}
      >
        {voiceRecording ? (
          <VoiceRecorderBar
            busy={voiceSending}
            onCancel={closeVoice}
            onSubmit={setVoiceUri}
          />
        ) : (
        <>
        <IconBtn icon={Paperclip} accessibilityLabel={t('chat.attachFile')} onPress={handleAttachPress} />
        <View
          style={[
            styles.inputShell,
            {
              backgroundColor: theme.colors.bgElev2,
              borderColor: theme.colors.lineSoft,
              borderRadius: theme.radius.lg,
            },
          ]}
        >
          <View style={styles.inputArea}>
            {Platform.OS === 'web' ? (
              <TextInput
                value={value}
                onChangeText={(rawNext) => {
                  const next = replaceCompletedEmojiShortcodes(rawNext, effectiveExpressionLookup);
                  webValueRef.current = next;
                  const nextEmoteQ = activeEmoteQuery(next);
                  setEmoteQuery(nextEmoteQ);
                  setMentionQuery(!nextEmoteQ && mentionsEnabled ? activeMentionQuery(next) : null);
                  onChangeText(next);
                }}
                placeholder={allowText ? placeholder : t('chat.attachmentsOnly')}
                placeholderTextColor={theme.colors.text3}
                editable={!disabled && allowText}
                multiline
                onKeyPress={(e) => {
                  const ne = e.nativeEvent as { key?: string; shiftKey?: boolean };
                  if ((ne.key === 'Tab' || (ne.key === 'Enter' && !ne.shiftKey)) && emoteSuggestions.length > 0) {
                    e.preventDefault?.();
                    selectEmoteSuggestion(emoteSuggestions[0]);
                    return;
                  }
                  if (ne.key === 'Enter' && !ne.shiftKey) {
                    e.preventDefault?.();
                    handleSend();
                  }
                }}
                style={[
                  styles.editorWebView,
                  {
                    minHeight: 40,
                    maxHeight: 120,
                    color: theme.colors.text,
                    fontSize: 15,
                    paddingHorizontal: 10,
                    paddingVertical: 9,
                    outlineStyle: 'none',
                  } as object,
                ]}
              />
            ) : (
              <WebView<object>
                ref={webRef}
                originWhitelist={['*']}
                source={{ html: inputHtml }}
                onMessage={handleEditorMessage}
                onLoadEnd={() => injectComposerCommand('setText', [value])}
                javaScriptEnabled
                scrollEnabled={false}
                hideKeyboardAccessoryView
                keyboardDisplayRequiresUserAction={false}
                style={[styles.editorWebView, { height: editorHeight }]}
                containerStyle={[styles.editorContainer, { height: editorHeight }]}
                automaticallyAdjustContentInsets={false}
                showsHorizontalScrollIndicator={false}
                showsVerticalScrollIndicator={false}
              />
            )}
          </View>
          <IconBtn
            icon={Smile}
            accessibilityLabel={t('chat.expressions')}
            onPress={openExpressionPicker}
          />
          {/* Only realms with slash commands get the picker button. */}
          {botCommandsEnabled && botCommands.length > 0 ? (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Bot commands"
              onPress={() => { setCommandPickerInitial(null); setCommandPickerOpen(true); void fetchBotCommands(); }}
              style={styles.slashButton}
            >
              <Text variant="bodySmall" color={theme.colors.text2} style={{ fontWeight: '800' }}>[ / ]</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        {voiceMessages && !value.trim() && pendingAttachments.length === 0 ? (
          <IconBtn icon={Mic} accessibilityLabel={t('chat.voiceRecord')} onPress={() => setVoiceRecording(true)} disabled={disabled} />
        ) : (
          <IconBtn icon={Send} accessibilityLabel={t('chat.send')} onPress={handleSend} disabled={disabled} />
        )}
        </>
        )}
      </Animated.View>

      <VoiceExpirySheet
        open={voiceUri !== null && !voiceSending}
        onCancel={() => setVoiceUri(null)}
        onConfirm={(expiresAt) => { void sendVoice(expiresAt); }}
      />

      <ExpressionPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={handleExpressionSelect}
        expressionLookup={effectiveExpressionLookup}
        serverUrl={effectiveServerUrl}
        canLoadExpressions={Boolean(effectiveServerUrl || token)}
        gifPickerEnabled={Boolean(isCentralAccount || true)}
        onSelectGif={(gifUrl) => { onSend(gifUrl); setPickerOpen(false); }}
      />
      <BotCommandPicker
        open={commandPickerOpen}
        onClose={() => setCommandPickerOpen(false)}
        commands={botCommands}
        serverUrl={effectiveServerUrl}
        initialCommand={commandPickerInitial}
        initialText={value}
        onInvoke={invokeBotCommand}
      />
    </>
  );
}

const styles = StyleSheet.create({
  attachPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
  },
  commandBanner: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    borderTopWidth: 1,
  },
  slashButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachThumb: {
    width: 44,
    height: 44,
    borderRadius: 6,
    overflow: 'hidden',
  },
  nsfwRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderTopWidth: 1,
    paddingHorizontal: 10,
    paddingTop: 10,
  },
  inputShell: {
    flex: 1,
    minHeight: 44,
    maxHeight: 132,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    paddingLeft: 12,
    paddingRight: 4,
  },
  inputArea: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    justifyContent: 'center',
  },
  editorContainer: {
    flex: 0,
    backgroundColor: 'transparent',
  },
  editorWebView: {
    flex: 0,
    minHeight: 40,
    maxHeight: 120,
    backgroundColor: 'transparent',
  },
});
