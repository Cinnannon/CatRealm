import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createApi } from '../../lib/api';
import { AUTH_BASE, createAuthenticatedApi } from '../../lib/authApi';
import { writeClipboardText } from '../../lib/clipboard';
import { useAuthStore } from '../../stores/authStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useServerStore } from '../../stores/serverStore';
import { useUIStore } from '../../stores/uiStore';
import { useContentSocialStore } from '../../stores/contentSocialStore';
import { AutoSizingChatImage } from './AutoSizingChatImage';
import { normalizeExpressionName, normalizeServerOrigin, normalizeTokenOwnerId } from '../../lib/expressions';
import { formatMessageTime } from '../../utils/formatTime';
import {
  MESSAGE_TOKEN_REGEX,
  COMPACT_EMOTE_TOKEN_REGEX,
  URL_REGEX,
  type LinkPreview,
  type CompactExpressionLookup,
  type InviteLinkData,
  stripExpressionTokensForLinkScan,
  getSingleUrlFromText,
  parseInviteLink,
  isTrustedEmbedHostUrl,
  decodeExpressionUrl,
  normalizeEmbedUrls,
  loadServerEmoteLookup,
  loadPersonalExpressionLookup,
  loadDefaultEmojiAliases,
  getDefaultEmojiAliasesCache,
  makePersonalLookupKey,
  emoteLookupCache,
  personalLookupCache,
  lookupRefetchDelayMs,
  markExpressionLookupStale,
  isTwitterLikeUrl,
  isInstagramUrl,
  getTwitchChannelFromUrl,
  canEmbedTwitchInCurrentContext,
} from '../../messaging/chatlib/messageTokenParser';
import {
  type OpenPreviewMediaFn,
  buildImmediateEmbed,
  buildPreviewCard,
  buildInviteCard,
  buildTwitchDesktopFallbackCard,
} from './EmbedRenderers';
import { MentionText } from './mentions';
import { isKlipyMediaUrl } from './KlipyFavoriteButton';
import { isAllowedExternalUrl, openProtectedExternalUrl } from '../../utils/externalLinks';

/**
 * Format message text with Discord-style markdown.
 * Supports: #/##/### headings, **bold**, *italic*, __underline__, ||spoiler||, `code`, ```code blocks```
 */

function CodeBlock({ content }: { content: string }) {
  const [copied, setCopied] = React.useState(false);
  const handleCopy = async () => {
    if (!await writeClipboardText(content)) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <pre className="relative group bg-zinc-900/80 text-[var(--color-accent)] p-3 rounded mt-1 mb-1 overflow-x-auto">
      <button
        type="button"
        onClick={handleCopy}
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-zinc-700 hover:bg-zinc-600 text-zinc-300 text-xs px-2 py-1 rounded"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
      <code className="font-mono text-sm">{content}</code>
    </pre>
  );
}

function SpoilerText({ children }: { children: React.ReactNode }) {
  const [revealed, setRevealed] = React.useState(false);
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={() => setRevealed(true)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setRevealed(true); }}
      className={
        revealed
          ? 'bg-zinc-700/40 px-0.5 rounded'
          : 'bg-zinc-700 text-zinc-700 px-0.5 rounded cursor-pointer select-none'
      }
    >
      {children}
    </span>
  );
}

interface InlineAttachment {
  url: string;
  mime?: string | null;
  type?: string | null;
  size?: number | null;
  name?: string | null;
  thumbnailUrl?: string | null;
  thumbnail_url?: string | null;
}

interface MessageFormatterProps {
  text: string;
  className?: string;
  allowLinks?: boolean;
  allowEmbeds?: boolean;
  inlineEmoteSizePxOverride?: number;
  attachments?: InlineAttachment[] | null;
  serverUrl?: string | null;
  senderAuthor?: string | null;
  senderAvatarUrl?: string | null;
  senderCreatedAt?: string | number | null;
}

const previewCache = new Map<string, LinkPreview | null>();
const previewInflight = new Map<string, Promise<LinkPreview | null>>();
// Previews routed through /api/embed-media carry signed links that expire server-side,
// so drop them well before then and refetch a fresh link.
const PROXY_PREVIEW_TTL_MS = 60 * 60 * 1000;
const previewExpiresAt = new Map<string, number>();

function setCachedPreview(url: string, preview: LinkPreview | null) {
  previewCache.set(url, preview);
  if (preview && JSON.stringify(preview).includes('/api/embed-media')) {
    previewExpiresAt.set(url, Date.now() + PROXY_PREVIEW_TTL_MS);
  } else {
    previewExpiresAt.delete(url);
  }
}

function getCachedPreview(url: string): LinkPreview | null | undefined {
  const expiresAt = previewExpiresAt.get(url);
  if (expiresAt !== undefined && Date.now() >= expiresAt) {
    previewCache.delete(url);
    previewExpiresAt.delete(url);
    return undefined;
  }
  return previewCache.get(url);
}

function personalTokenOwnerId(
  explicitOwnerId: string | undefined,
  tokenServer: string | undefined,
  authOrigin: string | null,
  currentUserId: string | null
): string {
  const explicit = normalizeTokenOwnerId(explicitOwnerId || '');
  if (explicit) return explicit;
  if (tokenServer && normalizeServerOrigin(tokenServer) !== authOrigin) return '';
  return normalizeTokenOwnerId(currentUserId || '');
}

function resolveAttachmentDisplayUrl(att: InlineAttachment, serverUrl: string | null | undefined, useThumbnail: boolean): string {
  const sourceUrl = useThumbnail ? (att.thumbnailUrl ?? att.thumbnail_url ?? att.url) : att.url;
  return sourceUrl.startsWith('http') ? sourceUrl : `${serverUrl ?? ''}${sourceUrl}`;
}

async function fetchPreview(url: string): Promise<LinkPreview | null> {
  const cached = getCachedPreview(url);
  if (cached !== undefined) {
    if (cached) {
      if (isInstagramUrl(url) && cached.type === 'link' && !cached.image) {
        previewCache.delete(url);
      } else {
        return cached;
      }
    }
    previewCache.delete(url);
  }
  if (previewInflight.has(url)) return previewInflight.get(url) as Promise<LinkPreview | null>;

  const task = (async () => {
    if (!isTwitterLikeUrl(url) && !isInstagramUrl(url)) {
      try {
        // First try noembed for broad provider support (YouTube, Reddit, etc.)
        const noembedResp = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`);
        if (noembedResp.ok) {
          const data = await noembedResp.json();
          if (data && (data.title || data.thumbnail_url || data.provider_name)) {
            let isTwitch = false;
            try {
              isTwitch = new URL(url).hostname.toLowerCase().includes('twitch.tv');
            } catch {
              isTwitch = false;
            }
            const result: LinkPreview = {
              type: 'link',
              url,
              siteName: data.provider_name || null,
              title: data.title || null,
              description: data.description || (data.author_name ? `By ${data.author_name}` : null),
              image: isTwitch ? null : (data.thumbnail_url || null),
              authorName: data.author_name || null,
              authorAvatar: isTwitch ? (data.thumbnail_url || null) : null,
            };
            setCachedPreview(url, result);
            return result;
          }
        }
      } catch {
        // ignore and fallback to server route below
      }
    }

    try {
      const authState = useAuthStore.getState();
      const activeServerUrl = useServerStore.getState().activeServerUrl;
      const api = authState.user?.accountType === 'central' && !activeServerUrl
        ? createAuthenticatedApi()
        : createApi();
      const rawBase = api.defaults.baseURL ?? '';
      const resolvedBase = (() => {
        if (typeof rawBase !== 'string' || !rawBase.trim()) {
          return typeof window !== 'undefined' ? window.location.origin : undefined;
        }
        if (rawBase.startsWith('http://') || rawBase.startsWith('https://')) {
          return rawBase;
        }
        if (typeof window !== 'undefined') {
          try {
            return new URL(rawBase, window.location.origin).toString();
          } catch {
            return window.location.origin;
          }
        }
        return undefined;
      })();

      const resp = await api.get('/api/embeds', { params: { url } });
      const embed = resp.data?.embed;
      if (embed) {
        const normalized = normalizeEmbedUrls(embed, resolvedBase);
        setCachedPreview(url, normalized);
        return normalized;
      }
    } catch {
      // ignore
    }

    return null;
  })();

  previewInflight.set(url, task);
  try {
    return await task;
  } finally {
    previewInflight.delete(url);
  }
}

export function MessageFormatter({
  text,
  className = '',
  allowLinks = false,
  allowEmbeds = false,
  inlineEmoteSizePxOverride,
  attachments,
  serverUrl,
  senderAuthor = null,
  senderAvatarUrl = null,
  senderCreatedAt = null,
}: MessageFormatterProps) {
  const openModal = useUIStore((s) => s.openModal);
  const emoteSizePx = useSettingsStore((s) => s.emoteSizePx);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const enableImageThumbnailing = useSettingsStore((s) => s.enableImageThumbnailing);
  const customAllowedDomains = useContentSocialStore((s) => s.customAllowedDomains);

  // Detect E2E-encrypted forwarded DM messages (can't be typed by users)
  const fwdMeta = useMemo(() => {
    if (!text.startsWith('{"__catrealm_fwd__":')) return null;
    try {
      const parsed = JSON.parse(text);
      const m = parsed.__catrealm_fwd__;
      if (m && typeof m.u === 'string' && /^https?:\/\//i.test(m.u)) return m as { s: string; t: number; u: string };
    } catch { /* not valid JSON */ }
    return null;
  }, [text]);
  const authServerUrl = useAuthStore((s) => s.serverUrl);
  const ownPersonalOwnerId = useAuthStore((s) => s.user?.accountType === 'central' ? s.user.id : null);
  const activeServerUrl = useServerStore((s) => s.activeServerUrl);
  const expressionBaseUrl = activeServerUrl || authServerUrl || null;
  const authOrigin = useMemo(() => normalizeServerOrigin(AUTH_BASE), []);
  const expressionOrigin = useMemo(() => {
    const origin = normalizeServerOrigin(expressionBaseUrl);
    if (!origin || origin === authOrigin) return null;
    return origin;
  }, [expressionBaseUrl, authOrigin]);
  const [emoteLookupByOrigin, setEmoteLookupByOrigin] = useState<Record<string, CompactExpressionLookup | null>>({});
  const [personalLookupByKey, setPersonalLookupByKey] = useState<Record<string, CompactExpressionLookup | null>>({});
  // Bumped to re-check lookups after a refetch cooldown or a broken expression image.
  const [lookupRetryTick, setLookupRetryTick] = useState(0);
  const [defaultEmojiAliases, setDefaultEmojiAliases] = useState<Map<string, string> | null>(() => getDefaultEmojiAliasesCache());
  const textForLinkScan = useMemo(() => stripExpressionTokensForLinkScan(text), [text]);
  // Each lookup key with the expression names this message needs from it.
  const compactTokenOrigins = useMemo(() => {
    const origins = new Map<string, Set<string>>();
    const add = (origin: string, name: string) => {
      const names = origins.get(origin) ?? new Set<string>();
      names.add(name);
      origins.set(origin, names);
    };
    const regex = new RegExp(COMPACT_EMOTE_TOKEN_REGEX.source, 'gi');
    for (const match of text.matchAll(regex)) {
      const externalOrigin = normalizeServerOrigin(match[1] || null);
      const ownerId = normalizeTokenOwnerId(match[4] || match[7] || '');
      if (externalOrigin && externalOrigin !== authOrigin) {
        add(externalOrigin, match[3]);
        continue;
      }
      if (ownerId) continue;
      if (match[6] && expressionOrigin) {
        add(expressionOrigin, match[6]);
      }
    }
    return Array.from(origins.entries(), ([origin, names]) => [origin, Array.from(names)] as const)
      .sort(([a], [b]) => a.localeCompare(b));
  }, [text, expressionOrigin, authOrigin]);
  const compactPersonalKeys = useMemo(() => {
    const keys = new Map<string, Set<string>>();
    const regex = new RegExp(COMPACT_EMOTE_TOKEN_REGEX.source, 'gi');
    for (const match of text.matchAll(regex)) {
      const ownerId = personalTokenOwnerId(match[4] || match[7], match[1], authOrigin, ownPersonalOwnerId);
      if (!ownerId) continue;
      const origin = authOrigin;
      if (!origin) continue;
      const key = makePersonalLookupKey(origin, ownerId);
      const names = keys.get(key) ?? new Set<string>();
      names.add(match[3] || match[6]);
      keys.set(key, names);
    }
    return Array.from(keys.entries(), ([key, names]) => [key, Array.from(names)] as const)
      .sort(([a], [b]) => a.localeCompare(b));
  }, [text, authOrigin, ownPersonalOwnerId]);

  useEffect(() => {
    if (!text.includes(':')) return;
    let cancelled = false;
    void loadDefaultEmojiAliases()
      .then((aliases) => {
        if (!cancelled) setDefaultEmojiAliases(aliases);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [text]);

  useEffect(() => {
    if (compactTokenOrigins.length === 0) return;
    let cancelled = false;

    const retryTimers: number[] = [];

    compactTokenOrigins.forEach(([origin, names]) => {
      const delay = lookupRefetchDelayMs(emoteLookupCache, origin, names);
      if (delay !== 0) {
        if (emoteLookupCache.has(origin)) {
          const cached = emoteLookupCache.get(origin) ?? null;
          setEmoteLookupByOrigin((prev) => (
            prev[origin] === cached
              ? prev
              : { ...prev, [origin]: cached }
          ));
        }
        if (delay !== null) retryTimers.push(window.setTimeout(() => setLookupRetryTick((tick) => tick + 1), delay + 50));
        return;
      }
      void loadServerEmoteLookup(origin, names).then((lookup) => {
        if (cancelled) return;
        setEmoteLookupByOrigin((prev) => (
          prev[origin] === lookup
            ? prev
            : { ...prev, [origin]: lookup }
        ));
      });
    });

    return () => {
      cancelled = true;
      retryTimers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [compactTokenOrigins, emoteLookupByOrigin, lookupRetryTick]);

  useEffect(() => {
    if (compactPersonalKeys.length === 0) return;
    let cancelled = false;

    const retryTimers: number[] = [];

    compactPersonalKeys.forEach(([key, names]) => {
      const delay = lookupRefetchDelayMs(personalLookupCache, key, names);
      if (delay !== 0) {
        if (personalLookupCache.has(key)) {
          const cached = personalLookupCache.get(key) ?? null;
          setPersonalLookupByKey((prev) => (
            prev[key] === cached
              ? prev
              : { ...prev, [key]: cached }
          ));
        }
        if (delay !== null) retryTimers.push(window.setTimeout(() => setLookupRetryTick((tick) => tick + 1), delay + 50));
        return;
      }

      const separator = key.indexOf('::');
      if (separator <= 0) return;
      const origin = key.slice(0, separator);
      const ownerId = key.slice(separator + 2);
      if (!origin || !ownerId) return;

      void loadPersonalExpressionLookup(origin, ownerId, names).then((lookup) => {
        if (cancelled) return;
        setPersonalLookupByKey((prev) => (
          prev[key] === lookup
            ? prev
            : { ...prev, [key]: lookup }
        ));
      });
    });

    return () => {
      cancelled = true;
      retryTimers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [compactPersonalKeys, personalLookupByKey, lookupRetryTick]);

  const resolveCompactEmoteAsset = useCallback((serverOrigin: string, name: string, kindHint: 'emote' | 'sticker' | null): { url: string; kind: 'emote' | 'sticker' } | null => {
    const normalizedName = normalizeExpressionName(name);
    if (!normalizedName) return null;
    const inState = emoteLookupByOrigin[serverOrigin];
    const lookup = (inState === undefined ? emoteLookupCache.get(serverOrigin) : inState) ?? null;
    if (!lookup) return null;
    const entry = lookup.get(normalizedName);
    if (!entry) return null;
    if (kindHint === 'sticker') {
      if (entry.sticker) return { url: entry.sticker, kind: 'sticker' };
      return null;
    }
    if (kindHint === 'emote') {
      if (entry.emote) return { url: entry.emote, kind: 'emote' };
      return null;
    }
    if (entry.emote) return { url: entry.emote, kind: 'emote' };
    if (entry.sticker) return { url: entry.sticker, kind: 'sticker' };
    return null;
  }, [emoteLookupByOrigin]);
  const resolvePersonalExpressionAsset = useCallback((
    origin: string,
    ownerId: string,
    name: string,
    kindHint: 'emote' | 'sticker' | null
  ): { url: string; kind: 'emote' | 'sticker' } | null => {
    const normalizedName = normalizeExpressionName(name);
    const normalizedOwnerId = normalizeTokenOwnerId(ownerId);
    if (!normalizedName || !normalizedOwnerId) return null;
    const key = makePersonalLookupKey(origin, normalizedOwnerId);
    const inState = personalLookupByKey[key];
    const lookup = (inState === undefined ? personalLookupCache.get(key) : inState) ?? null;
    if (!lookup) return null;
    const entry = lookup.get(normalizedName);
    if (!entry) return null;
    if (kindHint === 'sticker') {
      if (entry.sticker) return { url: entry.sticker, kind: 'sticker' };
      return null;
    }
    if (kindHint === 'emote') {
      if (entry.emote) return { url: entry.emote, kind: 'emote' };
      return null;
    }
    if (entry.emote) return { url: entry.emote, kind: 'emote' };
    if (entry.sticker) return { url: entry.sticker, kind: 'sticker' };
    return null;
  }, [personalLookupByKey]);

  // A cached asset that no longer loads (e.g. a re-uploaded sticker) refetches its manifest.
  const handleExpressionAssetError = useCallback((lookupKey: string) => {
    markExpressionLookupStale(lookupKey);
    setLookupRetryTick((tick) => tick + 1);
  }, []);

  const openInviteModal = useCallback((invite: InviteLinkData) => {
    openModal('inviteEmbed', { code: invite.code, url: invite.canonicalUrl });
  }, [openModal]);

  const handleExternalLinkClick = useCallback((url: string, event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    event.stopPropagation();
    openProtectedExternalUrl(url, openModal);
  }, [openModal]);

  const handleImmediateMediaOpen = useCallback((url: string) => {
    const klipyMedia = isKlipyMediaUrl(url);
    openModal('mediaViewer', {
      url,
      type: klipyMedia ? 'image/gif' : 'image/*',
      name: klipyMedia ? 'Klipy GIF' : null,
      author: senderAuthor,
      avatarUrl: senderAvatarUrl,
      createdAt: senderCreatedAt,
      size: null,
    });
  }, [openModal, senderAuthor, senderAvatarUrl, senderCreatedAt]);

  const isLinkAllowed = useCallback((url: string) => isAllowedExternalUrl(url), [customAllowedDomains]);

  const renderExternalLink = (
    key: React.Key,
    url: string,
    label: React.ReactNode,
    className = ''
  ) => {
    const allowed = isLinkAllowed(url);
    const linkClass = allowed
      ? `text-accent hover:underline break-all ${className}`
      : `text-red-400 hover:text-red-300 hover:underline decoration-red-400/70 break-all ${className}`;

    return (
      <a
        key={key}
        href={url}
        target="_blank"
        rel="noreferrer"
        className={linkClass}
        onClick={(e) => handleExternalLinkClick(url, e)}
      >
        {allowed ? label : <><span aria-hidden="true">⚠ </span>{label}</>}
      </a>
    );
  };

  const renderTextWithLinks = (input: string, startKey: number): { elements: React.ReactElement[]; nextKey: number } => {
    if (!allowLinks) {
      return { elements: input ? [<MentionText key={startKey} text={input} />] : [], nextKey: startKey + 1 };
    }

    // Pre-process markdown links [text](url) before bare URL scanning
    const mdLinkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
    const mdLinkMatches = [...input.matchAll(mdLinkRegex)];
    if (mdLinkMatches.length > 0) {
      const elements: React.ReactElement[] = [];
      let key = startKey;
      let lastIndex = 0;
      for (const match of mdLinkMatches) {
        const idx = match.index ?? -1;
        if (idx < 0) continue;
        if (idx > lastIndex) {
          const { elements: pre, nextKey } = renderTextWithLinks(input.slice(lastIndex, idx), key);
          elements.push(...pre);
          key = nextKey;
        }
        const linkText = match[1];
        const linkUrl = match[2];
        const invite = parseInviteLink(linkUrl);
        if (invite) {
          elements.push(
            <button key={key++} type="button" onClick={() => openInviteModal(invite)} className="text-accent hover:underline break-all text-left">
              {linkText}
            </button>
          );
        } else {
          elements.push(renderExternalLink(key++, linkUrl, linkText));
        }
        lastIndex = idx + match[0].length;
      }
      if (lastIndex < input.length) {
        const { elements: tail, nextKey } = renderTextWithLinks(input.slice(lastIndex), key);
        elements.push(...tail);
        key = nextKey;
      }
      return { elements, nextKey: key };
    }

    const elements: React.ReactElement[] = [];
    let key = startKey;
    let lastIndex = 0;
    const matches = [...input.matchAll(URL_REGEX)];

    for (const match of matches) {
      const url = match[0];
      const idx = match.index ?? -1;
      if (idx < 0) continue;
      if (idx > lastIndex) {
        elements.push(<MentionText key={key++} text={input.slice(lastIndex, idx)} />);
      }
      if (!(hiddenLinkUrl && url === hiddenLinkUrl)) {
        const invite = parseInviteLink(url);
        if (invite) {
          elements.push(
            <button
              key={key++}
              type="button"
              onClick={() => openInviteModal(invite)}
              className="text-accent hover:underline break-all text-left"
            >
              {url}
            </button>
          );
        } else {
          elements.push(renderExternalLink(key++, url, url));
        }
      }
      lastIndex = idx + url.length;
    }

    if (lastIndex < input.length) {
      elements.push(<MentionText key={key++} text={input.slice(lastIndex)} />);
    }

    return { elements, nextKey: key };
  };

  const renderPlainWithLinks = (input: string, startKey: number): { elements: React.ReactElement[]; nextKey: number } => {
    const parts: React.ReactElement[] = [];
    let key = startKey;
    let lastIndex = 0;
    const hasPlainTextContent = input
      .replace(new RegExp(MESSAGE_TOKEN_REGEX.source, 'gi'), ' ')
      .replace(new RegExp(URL_REGEX.source, 'gi'), ' ')
      .trim()
      .length > 0;
    const inlineEmoteSizePx = inlineEmoteSizePxOverride ?? (hasPlainTextContent ? 48 : emoteSizePx);
    const matches = [...input.matchAll(new RegExp(MESSAGE_TOKEN_REGEX.source, 'gi'))];

    for (const match of matches) {
      const idx = match.index;
      if (idx === undefined) continue;
      if (idx > lastIndex) {
        const segment = renderTextWithLinks(input.slice(lastIndex, idx), key);
        parts.push(...segment.elements);
        key = segment.nextKey;
      }

      const legacyKind = match[1];
      const legacyName = match[2];
      const legacyRawUrl = match[3];
      const compactExternalServer = match[4];
      const compactExternalKindRaw = match[5];
      const compactExternalName = match[6];
      const compactExternalOwnerIdRaw = match[7];
      const compactLocalKindRaw = match[8];
      const compactLocalName = match[9];
      const compactLocalOwnerIdRaw = match[10];

      if (legacyKind && legacyName && legacyRawUrl) {
        const assetUrl = decodeExpressionUrl(legacyRawUrl, expressionBaseUrl);
        if (!assetUrl) {
          const segment = renderTextWithLinks(match[0], key);
          parts.push(...segment.elements);
          key = segment.nextKey;
        } else if (legacyKind === 'sticker') {
          // Compact contexts (reaction chips) render stickers emote-sized;
          // stickers are transparent art, so no border/background box.
          parts.push(inlineEmoteSizePxOverride ? (
            <img
              key={key++}
              src={assetUrl}
              alt={legacyName}
              loading="lazy"
              decoding="async"
              className="inline-block object-contain align-text-bottom mx-0.5"
              style={{ width: `${inlineEmoteSizePxOverride}px`, height: `${inlineEmoteSizePxOverride}px` }}
              title={legacyName}
            />
          ) : (
            <AutoSizingChatImage
              key={key++}
              src={assetUrl}
              alt={legacyName}
              loading="lazy"
              decoding="async"
              maxWidth={150}
              maxHeight={150}
              placeholderWidth={96}
              placeholderHeight={96}
              className="my-1 rounded object-contain"
              title={legacyName}
            />
          ));
        } else {
          parts.push(
            <img
              key={key++}
              src={assetUrl}
              alt={legacyName}
              loading="lazy"
              decoding="async"
              className="inline-block object-contain align-text-bottom mx-0.5"
              style={{ width: `${inlineEmoteSizePx}px`, height: `${inlineEmoteSizePx}px` }}
              title={legacyName}
            />
          );
        }
      } else {
        const hasStickerMarker = compactExternalKindRaw === 'sticker' || compactLocalKindRaw === 'sticker';
        const compactName = compactExternalName || compactLocalName || '';
        const compactOwnerId = normalizeTokenOwnerId(compactExternalOwnerIdRaw || compactLocalOwnerIdRaw || '');
        const compactOrigin = compactExternalServer
          ? (() => {
            const externalOrigin = normalizeServerOrigin(compactExternalServer);
            if (!externalOrigin || externalOrigin === authOrigin) return null;
            return externalOrigin;
          })()
          : expressionOrigin;
        const kindHint: 'emote' | 'sticker' | null = hasStickerMarker ? 'sticker' : null;
        const personalOrigin = authOrigin;
        const personalOwnerId = personalTokenOwnerId(
          compactOwnerId, compactExternalServer, authOrigin, ownPersonalOwnerId
        );
        let customAsset = personalOwnerId
          ? ((personalOrigin && compactName)
            ? resolvePersonalExpressionAsset(personalOrigin, personalOwnerId, compactName, kindHint)
            : null)
          : null;
        let customAssetLookupKey = customAsset && personalOrigin && personalOwnerId
          ? makePersonalLookupKey(personalOrigin, normalizeTokenOwnerId(personalOwnerId))
          : null;
        // Backstop for older tokens that incorrectly included owner ids for server expressions.
        if (!customAsset && compactOrigin) {
          customAsset = resolveCompactEmoteAsset(compactOrigin, compactName, kindHint);
          customAssetLookupKey = compactOrigin;
        }
        const onCustomAssetError = customAssetLookupKey
          ? () => handleExpressionAssetError(customAssetLookupKey)
          : undefined;
        if (customAsset?.kind === 'sticker') {
          parts.push(inlineEmoteSizePxOverride ? (
            <img
              key={key++}
              src={customAsset.url}
              alt={compactName}
              loading="lazy"
              decoding="async"
              className="inline-block object-contain align-text-bottom mx-0.5"
              style={{ width: `${inlineEmoteSizePxOverride}px`, height: `${inlineEmoteSizePxOverride}px` }}
              title={compactName}
              onError={onCustomAssetError}
            />
          ) : (
            <AutoSizingChatImage
              key={key++}
              src={customAsset.url}
              alt={compactName}
              loading="lazy"
              decoding="async"
              maxWidth={150}
              maxHeight={150}
              placeholderWidth={96}
              placeholderHeight={96}
              className="my-1 rounded object-contain"
              title={compactName}
              onError={onCustomAssetError}
            />
          ));
        } else if (customAsset?.kind === 'emote') {
          parts.push(
            <img
              key={key++}
              src={customAsset.url}
              alt={compactName}
              loading="lazy"
              decoding="async"
              className="inline-block object-contain align-text-bottom mx-0.5"
              style={{ width: `${inlineEmoteSizePx}px`, height: `${inlineEmoteSizePx}px` }}
              title={compactName}
              onError={onCustomAssetError}
            />
          );
        } else if (!compactOwnerId && !compactExternalServer && !hasStickerMarker && defaultEmojiAliases) {
          const alias = defaultEmojiAliases.get(normalizeExpressionName(compactName));
          if (alias) {
            parts.push(
              <span key={key++} className="inline-block align-text-bottom mx-0.5">
                {alias}
              </span>
            );
          } else {
            const segment = renderTextWithLinks(match[0], key);
            parts.push(...segment.elements);
            key = segment.nextKey;
          }
        } else {
          parts.push(<span key={key++}>{match[0]}</span>);
        }
      }

      lastIndex = idx + match[0].length;
    }

    if (lastIndex < input.length) {
      const segment = renderTextWithLinks(input.slice(lastIndex), key);
      parts.push(...segment.elements);
      key = segment.nextKey;
    }

    return { elements: parts, nextKey: key };
  };

  const formatText = (input: string): React.ReactElement[] => {
    const parts: React.ReactElement[] = [];
    let remaining = input;
    let key = 0;

    const renderInline = (segment: string): React.ReactElement[] => {
      // Marker specs ordered longest-first to avoid prefix ambiguity (*** before **)
      type Spec = {
        open: string;
        close: string;
        raw?: boolean;
        wrap: (inner: React.ReactNode, k: number) => React.ReactElement;
      };
      const SPECS: Spec[] = [
        {
          open: '`', close: '`', raw: true,
          wrap: (inner, k) => (
            <code key={k} className="bg-zinc-900/50 text-[var(--color-accent)] px-1.5 py-0.5 rounded text-sm font-mono">
              {inner}
            </code>
          ),
        },
        {
          open: '***', close: '***',
          wrap: (inner, k) => <strong key={k} className="font-bold"><em className="italic">{inner}</em></strong>,
        },
        {
          open: '**', close: '**',
          wrap: (inner, k) => <strong key={k} className="font-bold">{inner}</strong>,
        },
        {
          open: '__', close: '__',
          wrap: (inner, k) => <u key={k}>{inner}</u>,
        },
        {
          open: '~~', close: '~~',
          wrap: (inner, k) => <s key={k} className="line-through">{inner}</s>,
        },
        {
          open: '||', close: '||',
          wrap: (inner, k) => <SpoilerText key={k}>{inner}</SpoilerText>,
        },
        {
          open: '*', close: '*',
          wrap: (inner, k) => <em key={k} className="italic">{inner}</em>,
        },
      ];

      const scan = (text: string): React.ReactElement[] => {
        const result: React.ReactElement[] = [];
        let i = 0;
        let plainStart = 0;

        while (i < text.length) {
          // Handle sentinel inline image \x00imgN\x00
          if (text[i] === '\x00') {
            const sentinelMatch = /^\x00img(\d+)\x00/.exec(text.slice(i));
            if (sentinelMatch) {
              if (i > plainStart) {
                const { elements, nextKey } = renderPlainWithLinks(text.slice(plainStart, i), key);
                result.push(...elements);
                key = nextKey;
              }
              const attIdx = parseInt(sentinelMatch[1], 10);
              const att = attachments?.[attIdx];
              if (att) {
                const resolvedUrl = att.url.startsWith('http') ? att.url : `${serverUrl ?? ''}${att.url}`;
                const displayUrl = resolveAttachmentDisplayUrl(att, serverUrl, enableImageThumbnailing);
                const allItems = (attachments ?? []).map((a, aIdx) => ({
                  id: `${aIdx}`,
                  url: a.url.startsWith('http') ? a.url : `${serverUrl ?? ''}${a.url}`,
                  type: a.mime ?? a.type ?? 'image/*',
                  name: a.name ?? `attachment-${aIdx + 1}`,
                  author: null,
                  avatarUrl: null,
                  createdAt: null,
                  size: a.size ?? null,
                }));
                result.push(
                  <AutoSizingChatImage
                    key={key++}
                    src={displayUrl}
                    alt={att.name ?? 'image'}
                    maxWidth={320}
                    maxHeight={384}
                    placeholderWidth={208}
                    placeholderHeight={144}
                    className="rounded border border-border bg-bg-input my-1 block object-contain cursor-zoom-in"
                    loading="lazy"
                    decoding="async"
                    onClick={() => openModal('mediaViewer', {
                      url: resolvedUrl,
                      type: att.mime ?? att.type ?? 'image/*',
                      name: att.name ?? null,
                      author: null,
                      avatarUrl: null,
                      createdAt: null,
                      size: att.size ?? null,
                      items: allItems,
                      index: attIdx,
                    })}
                  />
                );
              }
              i += sentinelMatch[0].length;
              plainStart = i;
              continue;
            }
          }

          let matched = false;
          for (const spec of SPECS) {
            if (!text.startsWith(spec.open, i)) continue;
            const searchFrom = i + spec.open.length;
            const closeIdx = text.indexOf(spec.close, searchFrom);
            // Skip if no closing marker or empty content
            if (closeIdx < 0 || closeIdx === searchFrom) continue;

            // Flush plain text before this marker
            if (i > plainStart) {
              const { elements, nextKey } = renderPlainWithLinks(text.slice(plainStart, i), key);
              result.push(...elements);
              key = nextKey;
            }

            const innerText = text.slice(searchFrom, closeIdx);
            const inner: React.ReactNode = spec.raw ? innerText : scan(innerText);
            result.push(spec.wrap(inner, key++));

            i = closeIdx + spec.close.length;
            plainStart = i;
            matched = true;
            break;
          }
          if (!matched) i++;
        }

        // Flush remaining plain text
        if (plainStart < text.length) {
          const { elements, nextKey } = renderPlainWithLinks(text.slice(plainStart), key);
          result.push(...elements);
          key = nextKey;
        }

        return result;
      };

      return scan(segment);
    };

    // Resolve <?imgN> placeholders — render inline if attachments available, strip otherwise
    if (attachments && attachments.length > 0) {
      remaining = remaining.replace(/<\?img(\d+)>/gi, (_match, numStr) => {
        const att = attachments[parseInt(numStr, 10) - 1];
        if (!att) return '';
        // Use a sentinel that we'll convert to JSX after line splitting
        return `\x00img${parseInt(numStr, 10) - 1}\x00`;
      });
    } else {
      remaining = remaining.replace(/<\?img\d+>/gi, '');
    }

    // Process code blocks first (```)
    const codeBlockRegex = /```([\s\S]*?)```/g;
    const codeBlockParts = remaining.split(codeBlockRegex);

    for (let i = 0; i < codeBlockParts.length; i++) {
      if (i % 2 === 0) {
        // Not a code block - process line-level formatting + inline formatting.
        remaining = codeBlockParts[i];
        const lines = remaining.split('\n');

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const line = lines[lineIdx];
          const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);

          if (headingMatch) {
            const level = headingMatch[1].length;
            const content = headingMatch[2];
            const headingClass =
              level === 1
                ? 'text-xl font-bold'
                : level === 2
                ? 'text-lg font-bold'
                : 'text-base font-bold';
            const headingContent = renderInline(content);
            parts.push(
              <div key={key++} className={`${headingClass} leading-tight`}>
                {headingContent.length > 0 ? headingContent : content}
              </div>
            );
          } else if (/^>>>\s*/.test(line)) {
            // Multi-line blockquote: consumes this line and all remaining lines
            const blockLines = [line.replace(/^>>>\s*/, ''), ...lines.slice(lineIdx + 1)];
            const blockParts: React.ReactElement[] = [];
            blockLines.forEach((bl, blIdx) => {
              if (bl) blockParts.push(...renderInline(bl));
              if (blIdx < blockLines.length - 1) blockParts.push(<br key={key++} />);
            });
            parts.push(
              <div key={key++} className="border-l-[3px] border-zinc-500 pl-3 my-0.5 text-text-secondary">
                {blockParts}
              </div>
            );
            break; // skip all remaining lines
          } else if (/^>\s/.test(line) || line === '>') {
            const content = line.slice(line.startsWith('> ') ? 2 : 1);
            parts.push(
              <div key={key++} className="border-l-[3px] border-zinc-500 pl-3 my-0.5 text-text-secondary">
                {content ? renderInline(content) : null}
              </div>
            );
          } else if (line) {
            parts.push(...renderInline(line));
          }

          if (lineIdx < lines.length - 1) {
            parts.push(<br key={key++} />);
          }
        }
      } else {
        // Code block
        parts.push(<CodeBlock key={key++} content={codeBlockParts[i]} />);
      }
    }

    return parts;
  };

  const firstUrlCandidate = useMemo(() => (
    allowEmbeds ? (textForLinkScan.match(URL_REGEX)?.[0] ?? null) : null
  ), [allowEmbeds, textForLinkScan]);
  const firstUrl = useMemo(() => (
    firstUrlCandidate && isLinkAllowed(firstUrlCandidate) ? firstUrlCandidate : null
  ), [firstUrlCandidate, isLinkAllowed]);
  const twitchChannel = useMemo(() => (firstUrl ? getTwitchChannelFromUrl(firstUrl) : null), [firstUrl]);
  const useTwitchDesktopFallback = useMemo(
    () => Boolean(twitchChannel && !canEmbedTwitchInCurrentContext()),
    [twitchChannel]
  );
  const inviteLink = useMemo(() => (firstUrl ? parseInviteLink(firstUrl) : null), [firstUrl]);
  const immediateEmbed = useMemo(() => (
    firstUrl ? buildImmediateEmbed(firstUrl, handleExternalLinkClick, handleImmediateMediaOpen) : null
  ), [firstUrl, handleExternalLinkClick, handleImmediateMediaOpen]);
  const [previewState, setPreviewState] = useState<{ url: string; data: LinkPreview | null } | null>(null);
  const preview = useMemo(() => {
    if (!firstUrl) return null;
    const cached = getCachedPreview(firstUrl);
    if (cached !== undefined) return cached;
    if (previewState?.url === firstUrl) return previewState.data;
    return null;
  }, [firstUrl, previewState]);

  const hiddenLinkUrl = useMemo(() => {
    if (!allowEmbeds || !allowLinks) return null;
    const singleUrl = getSingleUrlFromText(textForLinkScan);
    if (!singleUrl) return null;
    if (inviteLink) return singleUrl;
    if (immediateEmbed) return singleUrl;
    if (isTrustedEmbedHostUrl(singleUrl) && preview) return singleUrl;
    return null;
  }, [allowEmbeds, allowLinks, textForLinkScan, inviteLink, immediateEmbed, preview]);

  useEffect(() => {
    if (!allowEmbeds || !firstUrl || immediateEmbed || inviteLink) return;

    let cancelled = false;
    void fetchPreview(firstUrl).then((result) => {
      if (!cancelled) setPreviewState({ url: firstUrl, data: result });
    });

    return () => {
      cancelled = true;
    };
  }, [allowEmbeds, firstUrl, immediateEmbed, inviteLink]);

  const openPreviewMedia = useCallback<OpenPreviewMediaFn>((previewData, images, index) => {
    if (!images || images.length === 0) return;
    const boundedIndex = Math.min(Math.max(index, 0), images.length - 1);
    const items = images.map((imageUrl, imageIndex) => ({
      id: `${imageIndex}`,
      url: imageUrl,
      type: previewData.mime ?? 'image/*',
      name: previewData.title ?? `media-${imageIndex + 1}`,
      author: previewData.authorName ?? previewData.siteName ?? null,
      avatarUrl: null,
      createdAt: null,
      size: null,
    }));
    openModal('mediaViewer', {
      url: images[boundedIndex],
      type: previewData.mime ?? 'image/*',
      name: previewData.title ?? `media-${boundedIndex + 1}`,
      author: previewData.authorName ?? previewData.siteName ?? null,
      avatarUrl: null,
      createdAt: null,
      size: null,
      items,
      index: boundedIndex,
    });
  }, [openModal]);

  if (fwdMeta) {
    const fwdTimeLabel = fwdMeta.t ? formatMessageTime(fwdMeta.t, timeFormat) : null;
    const isImage = /\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i.test(fwdMeta.u) || /image\//i.test(fwdMeta.u);
    return (
      <div className={className}>
        <div className="mb-2 pl-3 border-l-2 border-blue-500/50 bg-bg-elevated/30 rounded p-2 text-xs text-text-muted select-none">
          ↗ Forwarded from <span className="text-blue-400 font-medium">{fwdMeta.s || 'Unknown'}</span>
          {fwdTimeLabel && <span> • {fwdTimeLabel}</span>}
        </div>
        {isImage && isLinkAllowed(fwdMeta.u) ? (
          <AutoSizingChatImage
            src={fwdMeta.u}
            alt="Forwarded media"
            maxWidth={512}
            maxHeight={384}
            placeholderWidth={320}
            placeholderHeight={180}
            className="mt-1 rounded-lg border border-border bg-bg-input object-contain cursor-zoom-in"
            onClick={() => openModal('mediaViewer', { url: fwdMeta.u, type: null, name: null, author: senderAuthor, avatarUrl: senderAvatarUrl, createdAt: fwdMeta.t ?? null, size: null })}
          />
        ) : (
          renderExternalLink('forwarded-link', fwdMeta.u, fwdMeta.u, 'underline text-sm')
        )}
      </div>
    );
  }

  return (
    <div className={className}>
      <div>{formatText(text)}</div>
      {firstUrl && (
        inviteLink
          ? buildInviteCard(inviteLink, openInviteModal)
          : (immediateEmbed || (
            useTwitchDesktopFallback && twitchChannel
              ? buildTwitchDesktopFallbackCard(firstUrl, twitchChannel, preview, handleExternalLinkClick)
              : buildPreviewCard(firstUrl, preview, openPreviewMedia, handleExternalLinkClick)
          ))
      )}
    </div>
  );
}
