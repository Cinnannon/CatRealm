import { useMemo, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import {
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';
import { Image as ExpoImage, type ImageLoadEventData } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { WebView } from 'react-native-webview';
import { FileText, Play, Film, Mic, Star, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/theme';
import { ImagePlaceholder } from './ImagePlaceholder';
import { useImageReveal } from './FadeInImage';
import type { MessageAttachment } from '@/types';
import { type ExpressionLookup, resolveExpressionAsset } from '@/lib/expressionCache';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAuthStore } from '@/stores/authStore';
import { useServerStore } from '@/stores/serverStore';
import { useUIStore } from '@/stores/uiStore';
import { formatMessageTimestamp } from '@/utils/formatTime';
import { useContentSocialStore } from '@/stores/contentSocialStore';
import { shouldBlurForNsfwTags, getNsfwSubtagLabels } from '@/utils/nsfw';
import { useCachedUri, realmScope, evictCachedFile } from '@/lib/imageCache';
import { CatRealmVideoControls } from './CatRealmVideoControls';
import { LinkPreviewCard } from './LinkPreviewCard';
import { useLinkPreview } from '@/lib/linkPreview';
import { isAudioAttachment } from '@/lib/voiceMessages';
import { MentionText } from './MentionText';
import { VoiceMessagePlayer } from './VoiceMessagePlayer';
import { findFavoriteByUrl, isGifMediaUrl, useGifFavoritesStore } from '@/stores/gifFavoritesStore';

// ─── Inline span types ─────────────────────────────────────────────────────
// Formatting spans carry children (recursive) so nesting works correctly.
// Raw spans (code, url, link) carry a plain string.

type Span =
  | { k: 'text'; v: string }
  | { k: 'bold' | 'italic' | 'bolditalic' | 'underline' | 'strike' | 'spoiler'; children: Span[] }
  | { k: 'code'; v: string }
  | { k: 'url'; v: string }
  | { k: 'link'; label: string; url: string }
  | { k: 'emote'; name: string; url: string; isSticker: boolean };

// ─── Block token types ─────────────────────────────────────────────────────

type Block =
  | { b: 'para'; spans: Span[] }
  | { b: 'forwardmeta'; text: string }
  | { b: 'h1' | 'h2' | 'h3'; spans: Span[] }
  | { b: 'codeblock'; lang: string; content: string }
  | { b: 'blockquote'; lines: Span[][] }
  | { b: 'list'; items: Span[][] }
  | { b: 'image'; url: string; thumbnailUrl: string | null; mime: string | null; name: string | null }
  | { b: 'video'; url: string; mime: string | null; name: string | null }
  | { b: 'audio'; url: string; mime: string | null }
  | { b: 'file'; url: string; mime: string | null; name: string | null; size: number | null }
  | { b: 'voiceexpired' }
  | { b: 'embed'; kind: 'youtube'; url: string; videoId: string }
  | { b: 'embed'; kind: 'image'; url: string };

// ─── Inline parser (recursive scanner) ────────────────────────────────────

const SPECS = [
  { open: '`',   close: '`',   kind: 'code'       as const, raw: true  },
  { open: '***', close: '***', kind: 'bolditalic' as const, raw: false },
  { open: '**',  close: '**',  kind: 'bold'       as const, raw: false },
  { open: '__',  close: '__',  kind: 'underline'  as const, raw: false },
  { open: '~~',  close: '~~',  kind: 'strike'     as const, raw: false },
  { open: '||',  close: '||',  kind: 'spoiler'    as const, raw: false },
  { open: '*',   close: '*',   kind: 'italic'     as const, raw: false },
] as const;

const MD_LINK_RE = /^\[([^\]\n]+)\]\((https?:\/\/[^\s<>")\n]+)\)/;
const BARE_URL_RE = /^(https?:\/\/[^\s<>"]+)/;
// Legacy [[emote:name|url]] and [[sticker:name|url]]
const LEGACY_EXPR_RE = /^\[\[(emote|sticker):([^|\]]+)\|([^\]]+)\]\]/i;
// Compact emote tokens: :server:name:  or  :name:  (with optional sticker: prefix and ownerid suffix)
// Owner id is captured, not skipped: personal expressions belonging to another
// user can only be resolved through their manifest. Kept in sync with desktop's
// COMPACT_EMOTE_TOKEN_REGEX in messaging/chatlib/messageTokenParser.ts.
const COMPACT_EXPR_RE = /^:(https?:\/\/[^\s:]+(?::\d{1,5})?):(?:(sticker):)?([a-z0-9_-]{1,64})(?::([a-z0-9_-]{3,128}))?:|^:(?:(sticker):)?([a-z0-9_-]{1,64})(?::([a-z0-9_-]{3,128}))?:/i;

function scan(text: string, lookup?: ExpressionLookup | null, primaryServerUrl?: string | null): Span[] {
  const result: Span[] = [];
  let i = 0;
  let plainStart = 0;

  const flush = (to: number) => {
    if (to > plainStart) result.push({ k: 'text', v: text.slice(plainStart, to) });
  };

  while (i < text.length) {
    // Legacy [[emote:name|encodedUrl]] or [[sticker:name|encodedUrl]]
    if (text[i] === '[' && text[i + 1] === '[') {
      const lm = LEGACY_EXPR_RE.exec(text.slice(i));
      if (lm) {
        flush(i);
        const isSticker = lm[1].toLowerCase() === 'sticker';
        const name = lm[2] ?? '';
        let url: string | null = null;
        try { url = decodeURIComponent(lm[3] ?? ''); } catch { url = lm[3] ?? null; }
        if (url && /^https?:\/\//i.test(url)) {
          result.push({ k: 'emote', name, url, isSticker });
        } else {
          result.push({ k: 'text', v: `:${name}:` });
        }
        i += lm[0].length;
        plainStart = i;
        continue;
      }
    }

    // [label](url) markdown link
    if (text[i] === '[') {
      const m = MD_LINK_RE.exec(text.slice(i));
      if (m) {
        flush(i);
        result.push({ k: 'link', label: m[1], url: m[2] });
        i += m[0].length;
        plainStart = i;
        continue;
      }
    }

    // Compact emote token :name: or :sticker:name: or :server:name:
    if (text[i] === ':') {
      const em = COMPACT_EXPR_RE.exec(text.slice(i));
      if (em) {
        flush(i);
        // Groups: [full, externalServer, stickerPrefixExt, nameExt, ownerExt,
        //          stickerPrefixLocal, nameLocal, ownerLocal]
        const tokenServerUrl = em[1] ?? null;  // e.g. https://cat.mcneko.net:25600
        const hasStickerMarker = !!(em[2] || em[5]);
        const name = em[3] || em[6] || '';
        const ownerId = em[4] || em[7] || null;
        // Checks the owner's personal manifest, then the token's server, then the
        // primary server. The resolved kind wins over the token's marker: the
        // canonical alias `:name:ownerId:` carries no marker but may be a sticker.
        const asset = resolveExpressionAsset(
          name,
          hasStickerMarker ? 'sticker' : null,
          primaryServerUrl,
          tokenServerUrl,
          ownerId,
        );
        if (asset) {
          result.push({ k: 'emote', name, url: asset.url, isSticker: asset.kind === 'sticker' });
        } else {
          result.push({ k: 'text', v: em[0] });
        }
        i += em[0].length;
        plainStart = i;
        continue;
      }
    }

    // bare https?:// URL (not inside a markdown link)
    if (text[i] === 'h' || text[i] === 'H') {
      const m = BARE_URL_RE.exec(text.slice(i));
      if (m) {
        flush(i);
        result.push({ k: 'url', v: m[1] });
        i += m[1].length;
        plainStart = i;
        continue;
      }
    }

    // Formatting markers — longest-first to avoid *** matching **
    let matched = false;
    for (const spec of SPECS) {
      if (!text.startsWith(spec.open, i)) continue;
      const searchFrom = i + spec.open.length;
      const closeIdx = text.indexOf(spec.close, searchFrom);
      if (closeIdx === -1) continue;
      flush(i);
      const inner = text.slice(searchFrom, closeIdx);
      if (spec.raw) {
        result.push({ k: 'code', v: inner });
      } else {
        result.push({ k: spec.kind, children: scan(inner, lookup, primaryServerUrl) } as Span);
      }
      i = closeIdx + spec.close.length;
      plainStart = i;
      matched = true;
      break;
    }
    if (!matched) i++;
  }

  flush(text.length);
  return result;
}

// ─── Block parser ──────────────────────────────────────────────────────────

const CODE_BLOCK_RE = /```(\w*)\n?([\s\S]*?)```/g;
const HEADING_RE = /^(#{1,3})\s+(.+)$/;
const LIST_RE = /^[-*]\s+(.+)$/;
const BQ_LINE_RE = /^>\s?/;

const IMG_PLACEHOLDER_RE = /<\?img(\d+)>/gi;

function resolveAttachmentUrl(att: MessageAttachment, serverUrl?: string | null): string {
  const url = att.url;
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (serverUrl) return serverUrl.replace(/\/$/, '') + (url.startsWith('/') ? url : '/' + url);
  return url;
}

function resolveAttachmentThumbnailUrl(att: MessageAttachment, serverUrl?: string | null): string | null {
  const thumbnailUrl = att.thumbnailUrl ?? att.thumbnail_url ?? null;
  if (!thumbnailUrl) return null;
  if (thumbnailUrl.startsWith('http://') || thumbnailUrl.startsWith('https://')) return thumbnailUrl;
  if (serverUrl) return serverUrl.replace(/\/$/, '') + (thumbnailUrl.startsWith('/') ? thumbnailUrl : '/' + thumbnailUrl);
  return thumbnailUrl;
}

function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseForwardEnvelope(rawText: string): { serverName: string | null; at: number | null; url: string } | null {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const envelope = (
      (parsed['__catrealm_fwd__'] && typeof parsed['__catrealm_fwd__'] === 'object'
        ? parsed['__catrealm_fwd__']
        : null) ??
      (parsed['catrealm_fwd'] && typeof parsed['catrealm_fwd'] === 'object'
        ? parsed['catrealm_fwd']
        : null)
    ) as Record<string, unknown> | null;
    if (!envelope) return null;
    const url = typeof envelope.u === 'string' ? envelope.u.trim() : '';
    if (!/^https?:\/\//i.test(url)) return null;
    return {
      serverName: typeof envelope.s === 'string' ? envelope.s : null,
      at: Number.isFinite(Number(envelope.t)) ? Number(envelope.t) : null,
      url,
    };
  } catch {
    return null;
  }
}

function formatForwardTimestamp(epochMaybeSeconds: number | null): string | null {
  if (!epochMaybeSeconds || !Number.isFinite(epochMaybeSeconds)) return null;
  const ms = epochMaybeSeconds < 10_000_000_000 ? epochMaybeSeconds * 1000 : epochMaybeSeconds;
  if (Number.isNaN(new Date(ms).getTime())) return null;
  return formatMessageTimestamp(ms);
}

const IS_IMAGE_RE = /\.(jpe?g|png|gif|webp|heic|avif|bmp|svg)(\?|$)/i;
const IS_VIDEO_RE = /\.(mp4|webm|mov|m4v|ogv|ogg)(\?|$)/i;

function classifyAttachment(att: MessageAttachment, url: string, thumbnailUrl: string | null): Block {
  const mime = att.mime ?? att.type ?? '';
  // Before the video check: voice notes are `voice-message.webm`, which IS_VIDEO_RE matches.
  if (isAudioAttachment(att)) {
    return { b: 'audio', url, mime: mime || null };
  }
  if (
    mime.startsWith('image/') ||
    att.type === 'image' ||
    IS_IMAGE_RE.test(att.url ?? '')
  ) {
    return { b: 'image', url, thumbnailUrl, mime: mime || null, name: att.name ?? null };
  }
  if (
    mime.startsWith('video/') ||
    IS_VIDEO_RE.test(att.url ?? '')
  ) {
    return { b: 'video', url, mime: mime || null, name: att.name ?? null };
  }
  return { b: 'file', url, mime: mime || null, name: att.name ?? null, size: att.size ?? null };
}

function parseBlocks(
  rawText: string,
  attachments?: MessageAttachment[] | null,
  serverUrl?: string | null,
  lookup?: ExpressionLookup | null,
  primaryServerUrl?: string | null,
): Block[] {
  const forwarded = parseForwardEnvelope(rawText);
  if (forwarded) {
    const looksImage = /\.(jpe?g|png|gif|webp|heic|avif|bmp|svg)(\?|$)/i.test(forwarded.url);
    const blocks: Block[] = [];
    const timestamp = formatForwardTimestamp(forwarded.at);
    const prefix = forwarded.serverName ? `Forwarded from ${forwarded.serverName}` : 'Forwarded media';
    blocks.push({ b: 'forwardmeta', text: timestamp ? `${prefix} - ${timestamp}` : prefix });
    if (looksImage) {
      blocks.push({ b: 'image', url: forwarded.url, thumbnailUrl: null, mime: null, name: null });
    } else {
      blocks.push({ b: 'file', url: forwarded.url, mime: null, name: null, size: null });
    }
    return blocks;
  }

  const blocks: Block[] = [];
  const referencedAttachmentIndices = new Set<number>();

  // Split on ```...``` first, then handle <?imgN> within each text segment
  const segments: Array<{ kind: 'text'; content: string } | { kind: 'code'; lang: string; content: string }> = [];
  let last = 0;
  CODE_BLOCK_RE.lastIndex = 0;
  let cm: RegExpExecArray | null;
  while ((cm = CODE_BLOCK_RE.exec(rawText)) !== null) {
    if (cm.index > last) segments.push({ kind: 'text', content: rawText.slice(last, cm.index) });
    segments.push({ kind: 'code', lang: cm[1] ?? '', content: (cm[2] ?? '').trimEnd() });
    last = CODE_BLOCK_RE.lastIndex;
  }
  if (last < rawText.length) segments.push({ kind: 'text', content: rawText.slice(last) });

  for (const seg of segments) {
    if (seg.kind === 'code') {
      blocks.push({ b: 'codeblock', lang: seg.lang, content: seg.content });
      continue;
    }

    // Within text segments, split on <?imgN> placeholders
    const parts = seg.content.split(IMG_PLACEHOLDER_RE);
    // split with a capturing group gives [text, index, text, index, ...]
    for (let pi = 0; pi < parts.length; pi++) {
      if (pi % 2 === 0) {
        // Plain text chunk — run through addTextBlocks
        const chunk = parts[pi];
        if (chunk && chunk.trim()) addTextBlocks(blocks, chunk, lookup, primaryServerUrl ?? serverUrl);
      } else {
        // Attachment index (1-based)
        const idx = parseInt(parts[pi] ?? '0', 10) - 1;
        referencedAttachmentIndices.add(idx);
        const att = attachments?.[idx];
        if (!att) continue;
        const url = resolveAttachmentUrl(att, serverUrl);
        const thumbnailUrl = resolveAttachmentThumbnailUrl(att, serverUrl);
        blocks.push(classifyAttachment(att, url, thumbnailUrl));
      }
    }
  }

  // Render any attachments not referenced by a <?imgN> placeholder (old messages, or
  // messages where the text didn't include the placeholder).
  if (attachments) {
    for (let i = 0; i < attachments.length; i++) {
      if (referencedAttachmentIndices.has(i)) continue;
      const att = attachments[i];
      if (!att) continue;
      const url = resolveAttachmentUrl(att, serverUrl);
      const thumbnailUrl = resolveAttachmentThumbnailUrl(att, serverUrl);
      blocks.push(classifyAttachment(att, url, thumbnailUrl));
    }
  }

  return blocks;
}

const YT_RE = /(?:youtube\.com\/(?:watch\?.*v=|shorts\/|live\/|v\/|embed\/|watch\/|vi?\/)|youtu\.be\/|img\.youtube\.com\/vi\/)([a-zA-Z0-9_-]{11})/i;
const IMG_URL_RE = /\.(jpe?g|png|gif|webp|bmp|avif)(\?.*)?$/i;

function extractLoneUrl(spans: Span[]): string | null {
  const nonEmpty = spans.filter((s) => !(s.k === 'text' && s.v.trim() === ''));
  if (nonEmpty.length !== 1) return null;
  const s = nonEmpty[0];
  if (s.k === 'url') return s.v;
  if (s.k === 'link') return s.url;
  return null;
}

function makeEmbedBlocks(url: string): Block[] {
  const ytMatch = YT_RE.exec(url);
  if (ytMatch?.[1]) return [{ b: 'embed', kind: 'youtube', url, videoId: ytMatch[1] }];
  if (IMG_URL_RE.test(url)) return [{ b: 'embed', kind: 'image', url }];
  return [];
}

function firstSpanUrl(spans: Span[]): string | null {
  for (const span of spans) {
    if (span.k === 'url') return span.v;
    if (span.k === 'link') return span.url;
    if ('children' in span) {
      const nested = firstSpanUrl(span.children);
      if (nested) return nested;
    }
  }
  return null;
}

/** First linked URL in the message text, ignoring code blocks and emote tokens. */
function findFirstUrl(blocks: Block[]): string | null {
  for (const block of blocks) {
    const lines =
      block.b === 'para' || block.b === 'h1' || block.b === 'h2' || block.b === 'h3' ? [block.spans]
        : block.b === 'blockquote' ? block.lines
          : block.b === 'list' ? block.items
            : [];
    for (const spans of lines) {
      const url = firstSpanUrl(spans);
      if (url) return url;
    }
  }
  return null;
}

function addTextBlocks(out: Block[], text: string, lookup?: ExpressionLookup | null, primaryServerUrl?: string | null) {
  const lines = text.split('\n');
  let paraLines: string[] = [];
  let listItems: Span[][] = [];

  const flushPara = () => {
    if (!paraLines.length) return;
    const joined = paraLines.join('\n').trim();
    if (joined) {
      const spans = scan(joined, lookup, primaryServerUrl);
      const loneUrl = extractLoneUrl(spans);
      const embeds = loneUrl ? makeEmbedBlocks(loneUrl) : [];
      // A message that is nothing but an embeddable URL renders as the embed
      // alone — printing the raw link above its own image is noise, and a sent
      // GIF is exactly this shape. Mirrors desktop's `hiddenLinkUrl`
      // (chat/MessageFormatter.tsx), which drops the text on the same condition.
      // A URL that embeds nothing still needs its link text.
      if (embeds.length) out.push(...embeds);
      else out.push({ b: 'para', spans });
    }
    paraLines = [];
  };
  const flushList = () => {
    if (!listItems.length) return;
    out.push({ b: 'list', items: listItems });
    listItems = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // >>> multi-line blockquote — consumes all remaining lines (matches desktop)
    if (/^>>>\s*/.test(line)) {
      flushPara(); flushList();
      const bqLines = [line.replace(/^>>>\s*/, ''), ...lines.slice(i + 1)];
      out.push({ b: 'blockquote', lines: bqLines.map((l) => scan(l, lookup, primaryServerUrl)) });
      return;
    }

    // > single-line blockquote — collect consecutive > lines
    if (BQ_LINE_RE.test(line) || line === '>') {
      flushPara(); flushList();
      const bqLines: Span[][] = [];
      while (i < lines.length && (BQ_LINE_RE.test(lines[i]) || lines[i] === '>')) {
        const l = lines[i];
        const content = l.startsWith('> ') ? l.slice(2) : l.startsWith('>') ? l.slice(1) : '';
        bqLines.push(scan(content, lookup, primaryServerUrl));
        i++;
      }
      out.push({ b: 'blockquote', lines: bqLines });
      continue;
    }

    // # / ## / ### heading
    const hm = HEADING_RE.exec(line);
    if (hm) {
      flushPara(); flushList();
      const level = (['h1', 'h2', 'h3'] as const)[hm[1].length - 1];
      out.push({ b: level, spans: scan(hm[2], lookup, primaryServerUrl) });
      i++; continue;
    }

    // - / * list item
    const lm = LIST_RE.exec(line);
    if (lm) {
      flushPara();
      listItems.push(scan(lm[1], lookup, primaryServerUrl));
      i++; continue;
    }

    // Regular line
    if (listItems.length) flushList();
    paraLines.push(line);
    i++;
  }
  flushPara(); flushList();
}

// ─── Render helpers ────────────────────────────────────────────────────────

type CC = { bg: string; fg: string; link: string; spoilerBg: string };

function spansToPlain(spans: Span[]): string {
  return spans
    .map((s) => {
      if (s.k === 'text' || s.k === 'code' || s.k === 'url') return s.v;
      if (s.k === 'link') return s.label;
      if (s.k === 'emote') return `:${s.name}:`;
      return spansToPlain(s.children);
    })
    .join('');
}

function SpoilerInline({
  children,
  color,
  cc,
  emoteSizePx,
  disableInlineEmotes,
}: {
  children: Span[];
  color: string;
  cc: CC;
  emoteSizePx: number;
  disableInlineEmotes?: boolean;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const bg = theme.colors.bgElev2;
  return open ? (
    <Text style={{ backgroundColor: bg, borderRadius: 2 }}>
      {renderSpans(children, color, cc, emoteSizePx, disableInlineEmotes)}
    </Text>
  ) : (
    <Text
      onPress={() => setOpen(true)}
      style={{ color: bg, backgroundColor: bg, borderRadius: 2 }}
    >
      {spansToPlain(children)}
    </Text>
  );
}

function renderSpans(
  spans: Span[],
  color: string,
  cc: CC,
  emoteSizePx: number,
  disableInlineEmotes?: boolean,
): ReactNode[] {
  return spans.map((s, i) => {
    switch (s.k) {
      case 'text':
        return <MentionText key={i} text={s.v} color={color} />;

      case 'bold':
        return (
          <Text key={i} style={{ color, fontWeight: 'bold' }}>
            {renderSpans(s.children, color, cc, emoteSizePx, disableInlineEmotes)}
          </Text>
        );
      case 'italic':
        return (
          <Text key={i} style={{ color, fontStyle: 'italic' }}>
            {renderSpans(s.children, color, cc, emoteSizePx, disableInlineEmotes)}
          </Text>
        );
      case 'bolditalic':
        return (
          <Text key={i} style={{ color, fontWeight: 'bold', fontStyle: 'italic' }}>
            {renderSpans(s.children, color, cc, emoteSizePx, disableInlineEmotes)}
          </Text>
        );
      case 'underline':
        return (
          <Text key={i} style={{ color, textDecorationLine: 'underline' }}>
            {renderSpans(s.children, color, cc, emoteSizePx, disableInlineEmotes)}
          </Text>
        );
      case 'strike':
        return (
          <Text key={i} style={{ color, textDecorationLine: 'line-through' }}>
            {renderSpans(s.children, color, cc, emoteSizePx, disableInlineEmotes)}
          </Text>
        );
      case 'spoiler':
        return (
          <SpoilerInline
            key={i}
            children={s.children}
            color={color}
            cc={cc}
            emoteSizePx={emoteSizePx}
            disableInlineEmotes={disableInlineEmotes}
          />
        );

      case 'code':
        return (
          <Text
            key={i}
            style={{
              fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
              fontSize: 13,
              color: cc.fg,
              backgroundColor: cc.bg,
              borderRadius: 3,
            }}
          >
            {s.v}
          </Text>
        );

      case 'url':
        return (
          <Text
            key={i}
            style={{ color: cc.link, textDecorationLine: 'underline' }}
            onPress={() => void Linking.openURL(s.v)}
          >
            {s.v}
          </Text>
        );

      case 'link':
        return (
          <Text
            key={i}
            style={{ color: cc.link, textDecorationLine: 'underline' }}
            onPress={() => void Linking.openURL(s.url)}
          >
            {s.label}
          </Text>
        );

      case 'emote':
        if (disableInlineEmotes) {
          return (
            <Text key={i} style={{ color }}>
              :{s.name}:
            </Text>
          );
        }
        return (
          <Image
            key={i}
            source={{ uri: s.url }}
            style={
              s.isSticker
                ? {
                    height: Math.max(80, Math.min(180, emoteSizePx * 1.75)),
                    width: Math.max(80, Math.min(180, emoteSizePx * 1.75)),
                  }
                : { height: emoteSizePx, width: emoteSizePx }
            }
            resizeMode="contain"
            accessibilityLabel={s.name}
          />
        );
    }
  });
}

// ─── Image sub-components ──────────────────────────────────────────────────

type ImageBlock = Extract<Block, { b: 'image' }>;

interface ImageSharedProps {
  shouldBlur: boolean;
  nsfwLabels: string[];
  onReveal: () => void;
  onPress: (img: ImageBlock) => void;
  serverUrl?: string | null;
  imageScope?: string;
}

// Widest a single inline image renders, so thumbnails aren't stretched across
// wide tablet panes far beyond their encoded resolution.
const SINGLE_IMAGE_MAX_WIDTH = 520;
const KLIPY_IMAGE_MAX_WIDTH = 360;
const KLIPY_IMAGE_MAX_HEIGHT = 300;


function GifFavoriteStarOverlay({ url, mime }: { url: string; mime?: string | null }) {
  const { t } = useTranslation();
  const isGif = isGifMediaUrl(url, mime);
  const starred = useGifFavoritesStore((s) => (isGif ? Boolean(findFavoriteByUrl(s.favorites, url)) : false));
  const toggleUrl = useGifFavoritesStore((s) => s.toggleUrl);

  useEffect(() => {
    if (isGif) {
      void useGifFavoritesStore.getState().ensureLoaded();
    }
  }, [isGif]);

  if (!isGif) return null;

  return (
    <Pressable
      onPress={(e) => {
        e?.stopPropagation?.();
        void toggleUrl(url);
      }}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={starred ? t('gif.removeFavorite') : t('gif.favoriteGif')}
      style={[
        styles.gifStarBtn,
        {
          backgroundColor: starred ? 'rgba(20, 16, 10, 0.82)' : 'rgba(10, 12, 18, 0.64)',
          borderColor: starred ? 'rgba(250, 204, 21, 0.58)' : 'rgba(255, 255, 255, 0.18)',
        },
      ]}
    >
      <Star
        size={14}
        color={starred ? '#facc15' : '#ffffff'}
        fill={starred ? '#facc15' : 'transparent'}
      />
    </Pressable>
  );
}

function isKlipyMediaUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'static.klipy.com' || host === 'static1.klipy.com' || host === 'static2.klipy.com';
  } catch {
    return false;
  }
}

/** Single image that sizes itself to the image's natural aspect ratio (capped, never upscaled). */
function SingleChatImage({ block, shouldBlur, nsfwLabels, onReveal, onPress, serverUrl, imageScope, autoplay = true }: ImageSharedProps & { block: ImageBlock; autoplay?: boolean }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [containerW, setContainerW] = useState(0);
  const [naturalDim, setNaturalDim] = useState<{ w: number; h: number } | null>(null);
  const displayUrl = block.thumbnailUrl ?? block.url;
  const cachedUri = useCachedUri(displayUrl, imageScope ?? realmScope(serverUrl ?? displayUrl));
  const [failedUris, setFailedUris] = useState<ReadonlySet<string>>(() => new Set());
  const [lockedLoadedUri, setLockedLoadedUri] = useState<string | null>(null);

  useEffect(() => {
    setFailedUris(new Set());
    setLockedLoadedUri(null);
  }, [displayUrl]);

  const candidateUri = [cachedUri, displayUrl, block.url].find(
    (u): u is string => typeof u === 'string' && u.length > 0 && !failedUris.has(u),
  ) ?? displayUrl;
  // Once an image has decoded and displayed in this mount, never swap its source
  // mid-render when background disk caching completes (prevents Android Glide
  // from clearing the already-visible bitmap mid-transition).
  const imageUri = lockedLoadedUri && !failedUris.has(lockedLoadedUri) ? lockedLoadedUri : candidateUri;
  const allFailed = Boolean(displayUrl) && failedUris.has(displayUrl) && (!block.url || failedUris.has(block.url));

  const klipyMedia = isKlipyMediaUrl(block.url);
  const maxWidth = klipyMedia ? KLIPY_IMAGE_MAX_WIDTH : SINGLE_IMAGE_MAX_WIDTH;
  const maxHeight = klipyMedia ? KLIPY_IMAGE_MAX_HEIGHT : 360;

  let displayWidth = containerW > 0 ? Math.min(containerW, maxWidth) : Math.min(280, maxWidth);
  if (displayWidth > 0 && naturalDim) displayWidth = Math.min(displayWidth, naturalDim.w);
  const displayHeight =
    naturalDim && displayWidth > 0
      ? Math.min((naturalDim.h / naturalDim.w) * displayWidth, maxHeight)
      : 200;

  const handleLayout = useCallback((e: { nativeEvent: { layout: { width: number } } }) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0) setContainerW(w);
  }, []);

  const { loaded, transition, markLoaded } = useImageReveal(displayUrl);
  const handleLoad = useCallback((e: ImageLoadEventData) => {
    const { width: w, height: h } = e.source;
    if (w > 0 && h > 0) setNaturalDim({ w, h });
    setLockedLoadedUri((prev) => prev ?? imageUri);
    markLoaded();
  }, [imageUri, markLoaded]);

  const handleError = useCallback(() => {
    evictCachedFile(imageUri);
    setLockedLoadedUri(null);
    setFailedUris((prev) => new Set(prev).add(imageUri));
  }, [imageUri]);

  const imageStyle = { width: displayWidth, height: displayHeight, borderRadius: 8 };

  if (shouldBlur) {
    return (
      <View style={styles.imageWrap} onLayout={handleLayout}>
        <Pressable onPress={onReveal}>
          <ExpoImage source={{ uri: imageUri }} style={[imageStyle, { opacity: 0.15 }]} contentFit="cover" cachePolicy="disk" recyclingKey={displayUrl} blurRadius={20} onLoad={handleLoad} onError={handleError} accessibilityLabel={block.name ?? t('chat.imageAlt')} />
          <View style={styles.nsfwOverlay}>
            <Text style={[styles.nsfwLabel, { color: theme.colors.text }]}>{nsfwLabels.length > 0 ? nsfwLabels.join(' · ') : 'NSFW'}</Text>
            <Text style={[styles.nsfwReveal, { color: theme.colors.text3 }]}>{t('chat.tapToReveal')}</Text>
          </View>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.imageWrap} onLayout={handleLayout}>
      <View style={{ position: 'relative', alignSelf: 'flex-start', width: imageStyle.width, height: imageStyle.height }}>
        <Pressable onPress={() => onPress(block)} style={{ width: imageStyle.width, height: imageStyle.height }}>
          {!loaded && !allFailed && <ImagePlaceholder radius={8} mark style={{ width: imageStyle.width, height: imageStyle.height }} />}
          {allFailed && <ImageFailed width={imageStyle.width} height={imageStyle.height} />}
          <ExpoImage source={{ uri: imageUri }} style={imageStyle} contentFit="cover" cachePolicy="disk" recyclingKey={displayUrl} autoplay={autoplay} transition={transition} onLoad={handleLoad} onError={handleError} accessibilityLabel={block.name ?? t('chat.imageAlt')} />
        </Pressable>
        <GifFavoriteStarOverlay url={block.url} mime={block.mime} />
      </View>
    </View>
  );
}

const GALLERY_THUMB = 160;

/** Shown when an attachment fails, so it does not look like it is still loading. */
function ImageFailed({ width, height }: { width: number | `${number}%`; height: number }) {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <View accessibilityRole="alert" style={[styles.imageFailed, { width, height, backgroundColor: theme.colors.bgElev1, borderColor: theme.colors.lineSoft }]}>
      <Text style={{ color: theme.colors.text3, fontSize: 12 }}>{t('chat.imageLoadFailed')}</Text>
    </View>
  );
}

function GalleryImage({ img, index, shouldBlur, nsfwLabels, onReveal, onPress, serverUrl, imageScope }: {
  img: ImageBlock;
  index: number;
  shouldBlur: boolean;
  nsfwLabels: string[];
  onReveal: () => void;
  onPress: (img: ImageBlock) => void;
  serverUrl?: string | null;
  imageScope?: string;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const displayUrl = img.thumbnailUrl ?? img.url;
  const cachedUri = useCachedUri(displayUrl, imageScope ?? realmScope(serverUrl ?? displayUrl));
  const [failedUris, setFailedUris] = useState<ReadonlySet<string>>(() => new Set());
  const [lockedLoadedUri, setLockedLoadedUri] = useState<string | null>(null);

  useEffect(() => {
    setFailedUris(new Set());
    setLockedLoadedUri(null);
  }, [displayUrl]);

  const candidateUri = [cachedUri, displayUrl, img.url].find(
    (u): u is string => typeof u === 'string' && u.length > 0 && !failedUris.has(u),
  ) ?? displayUrl;
  const uri = lockedLoadedUri && !failedUris.has(lockedLoadedUri) ? lockedLoadedUri : candidateUri;
  const allFailed = Boolean(displayUrl) && failedUris.has(displayUrl) && (!img.url || failedUris.has(img.url));
  const { loaded, transition, markLoaded } = useImageReveal(displayUrl);

  const handleLoad = useCallback(() => {
    setLockedLoadedUri((prev) => prev ?? uri);
    markLoaded();
  }, [uri, markLoaded]);

  const handleError = useCallback(() => {
    evictCachedFile(uri);
    setLockedLoadedUri(null);
    setFailedUris((prev) => new Set(prev).add(uri));
  }, [uri]);

  return (
    <View style={{ width: GALLERY_THUMB, height: GALLERY_THUMB, borderRadius: 8, overflow: 'hidden' }}>
      {shouldBlur ? (
        <Pressable onPress={onReveal} style={{ flex: 1 }}>
          <ExpoImage source={{ uri }} style={{ width: GALLERY_THUMB, height: GALLERY_THUMB, opacity: 0.15 }} contentFit="cover" cachePolicy="disk" recyclingKey={displayUrl} blurRadius={20} onLoad={handleLoad} onError={handleError} accessibilityLabel={img.name ?? t('chat.imageAlt')} />
          {index === 0 && (
            <View style={styles.nsfwOverlay}>
              <Text style={[styles.nsfwLabel, { color: theme.colors.text }]}>{nsfwLabels.length > 0 ? nsfwLabels.join(' · ') : 'NSFW'}</Text>
              <Text style={[styles.nsfwReveal, { color: theme.colors.text3 }]}>{t('chat.tapToReveal')}</Text>
            </View>
          )}
        </Pressable>
      ) : (
        <View style={{ flex: 1, position: 'relative' }}>
          <Pressable onPress={() => onPress(img)} style={{ flex: 1 }}>
            {!loaded && !allFailed && <ImagePlaceholder mark />}
            {allFailed && <ImageFailed width={GALLERY_THUMB} height={GALLERY_THUMB} />}
            <ExpoImage source={{ uri }} style={{ width: GALLERY_THUMB, height: GALLERY_THUMB }} contentFit="cover" cachePolicy="disk" recyclingKey={displayUrl} transition={transition} onLoad={handleLoad} onError={handleError} accessibilityLabel={img.name ?? t('chat.imageAlt')} />
          </Pressable>
          <GifFavoriteStarOverlay url={img.url} mime={img.mime} />
        </View>
      )}
    </View>
  );
}

/** Horizontal scrolling row for 2+ images in one message. */
function ImageGalleryRow({ images, shouldBlur, nsfwLabels, onReveal, onPress, serverUrl, imageScope }: ImageSharedProps & { images: ImageBlock[] }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 2 }} contentContainerStyle={{ gap: 4 }}>
      {images.map((img, i) => (
        <GalleryImage
          key={i}
          img={img}
          index={i}
          shouldBlur={shouldBlur}
          nsfwLabels={nsfwLabels}
          onReveal={onReveal}
          onPress={onPress}
          serverUrl={serverUrl}
          imageScope={imageScope}
        />
      ))}
    </ScrollView>
  );
}

// ─── Inline video player ───────────────────────────────────────────────────

function ChatVideo({ url, name, serverUrl, imageScope, autoLoop = false }: { url: string; name: string | null; serverUrl?: string | null; imageScope?: string; autoLoop?: boolean }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const authState = useAuthStore();
  const servers = useServerStore((s) => s.servers);
  const openMediaViewer = useUIStore((s) => s.openMediaViewer);

  // The cache names files by URL extension; AVPlayer (iOS) refuses a local file without a
  // video extension, so extensionless URLs (e.g. /api/embed-media?token=) stay streamed.
  const cachedUri = useCachedUri(IS_VIDEO_RE.test(url) ? url : null, imageScope ?? realmScope(serverUrl ?? url));

  const source = useMemo(() => {
    if (!url) return '';

    // Normalize url for comparison
    const urlLower = url.toLowerCase();
    const isServerHosted =
      (serverUrl && urlLower.includes(serverUrl.toLowerCase())) ||
      (authState.serverUrl && urlLower.includes(authState.serverUrl.toLowerCase()));

    if (isServerHosted) {
      let token = authState.token;

      // For central accounts, find the matching server's token
      if (authState.user?.accountType === 'central') {
        const matchingServer = servers.find(s => urlLower.includes(s.url.toLowerCase()));
        if (matchingServer) {
          token = matchingServer.token;
        }
      }

      return {
        uri: url,
        headers: {
          'X-CatRealm-Client': 'mobile',
          'Authorization': `Bearer ${token || ''}`,
        },
      };
    }
    return url;
  }, [url, serverUrl, authState.serverUrl, authState.token, authState.user?.accountType, servers]);

  // autoLoop: GIF-style embeds (desktop parity) play muted on repeat.
  const player = useVideoPlayer(source, (player) => {
    player.loop = autoLoop;
    player.muted = true;
    if (autoLoop) player.play();
  });

  // Switch to local cached file once download completes
  const appliedCacheRef = useRef<string | null>(null);
  useEffect(() => {
    if (cachedUri && cachedUri !== url && cachedUri !== appliedCacheRef.current) {
      appliedCacheRef.current = cachedUri;
      player.replace({ uri: cachedUri });
      if (autoLoop) player.play();
    }
  }, [cachedUri, url, player, autoLoop]);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  useEffect(() => {
    setErrorMsg(null);
    const sub = player.addListener('statusChange', (payload) => {
      if (payload.status === 'error') {
        setErrorMsg(payload.error?.message ?? t('chat.playbackFailed'));
      }
    });
    return () => sub.remove();
  }, [player, t]);

  if (errorMsg) {
    return (
      <Pressable
        onPress={() => void Linking.openURL(url)}
        style={[styles.videoWrap, { backgroundColor: theme.colors.bgElev2, borderColor: theme.colors.lineSoft, padding: 12, flexDirection: 'row', alignItems: 'center' }]}
      >
        <Film size={24} color={theme.colors.text3} style={{ marginRight: 12 }} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: theme.colors.text, fontSize: 14 }} numberOfLines={1}>{name || t('chat.videoAttachment')}</Text>
          <Text style={{ color: theme.colors.text3, fontSize: 12 }}>{errorMsg || t('chat.playbackFailed')}. {t('chat.tapOpenBrowser')}</Text>
        </View>
      </Pressable>
    );
  }

  return (
    <View style={[styles.videoWrap, { backgroundColor: '#000', borderColor: theme.colors.lineSoft }]}>
      <View style={{ position: 'relative', width: '100%', height: 240, overflow: 'hidden' }}>
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          nativeControls={false}
        />
        {autoLoop ? (
          // GIF-style loop: no controls (desktop parity). iOS fires playingChange on every
          // loop restart, which would keep popping CatRealmVideoControls back up.
          <Pressable style={StyleSheet.absoluteFill} onPress={() => openMediaViewer(url, name, [{ url, name, kind: 'video' }], 0)} />
        ) : (
          <CatRealmVideoControls
            player={player}
            compact
            onFullscreen={() => {
              try {
                player.pause();
              } catch {
                // Ignore pause races while opening the fullscreen viewer.
              }
              openMediaViewer(url, name, [{ url, name, kind: 'video' }], 0);
            }}
          />
        )}
      </View>
      {name ? (
        <View style={[styles.videoMeta, { backgroundColor: theme.colors.bgElev1 }]}>
          <Text style={{ color: theme.colors.text3, fontSize: 12 }} numberOfLines={1}>{name}</Text>
        </View>
      ) : null}
    </View>
  );
}

// ─── YouTube embed card ────────────────────────────────────────────────────

function YouTubeEmbedCard({ videoId, url }: { videoId: string; url: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [playing, setPlaying] = useState(false);
  const thumbUri = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

  if (playing) {
    const embedUrl = `https://www.youtube.com/embed/${videoId}?autoplay=1&modestbranding=1&playsinline=1`;
    return (
      <View style={[styles.ytCard, { height: 200, backgroundColor: '#000', overflow: 'hidden' }]}>
        <WebView
          source={{ uri: embedUrl }}
          style={{ flex: 1, backgroundColor: '#000' }}
          allowsFullscreenVideo
          mediaPlaybackRequiresUserAction={false}
        />
        <Pressable 
          onPress={() => setPlaying(false)}
          style={{ position: 'absolute', top: 8, right: 8, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 12, padding: 4 }}
        >
          <X size={16} color="#fff" />
        </Pressable>
      </View>
    );
  }

  return (
    <Pressable
      onPress={() => setPlaying(true)}
      style={[styles.ytCard, { backgroundColor: theme.colors.bgElev2, borderColor: theme.colors.lineSoft }]}
    >
      <View style={styles.ytThumbWrap}>
        <Image source={{ uri: thumbUri }} style={styles.ytThumb} resizeMode="cover" />
        <View style={styles.ytPlayOverlay}>
          <View style={[styles.ytPlayBtn, { backgroundColor: '#FF0000' }]}>
            <Play size={16} color="#fff" fill="#fff" />
          </View>
        </View>
      </View>
      <View style={styles.ytMeta}>
        <Text style={[styles.ytBadge, { color: theme.colors.text3 }]}>YouTube</Text>
        <Pressable onPress={() => void Linking.openURL(url)} style={{ marginLeft: 'auto' }}>
          <Text style={{ color: theme.colors.accent, fontSize: 12 }}>{t('chat.openInBrowser')}</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

// ─── Public component ──────────────────────────────────────────────────────

interface MarkdownTextProps {
  text: string;
  color: string;
  style?: TextStyle;
  attachments?: MessageAttachment[] | null;
  serverUrl?: string | null;
  /** Override the cache scope for inline images/attachments. Defaults to realmScope(serverUrl). */
  imageScope?: string;
  expressionLookup?: ExpressionLookup | null;
  nsfwTags?: string[] | null;
  disableInlineEmotes?: boolean;
  /** False hides YouTube/image embeds and link previews (server `embeds_enabled = 0`). */
  allowEmbeds?: boolean;
  /** Unfurl the first URL into a preview card. Off by default (reply snippets, search, notes). */
  linkPreviews?: boolean;
  /** Voice messages only: past this time (ms) the audio is gone, so show a placeholder instead of a player. */
  voiceExpiresAt?: number | null;
}

export function MarkdownText({
  text,
  color,
  style,
  attachments,
  serverUrl,
  imageScope,
  expressionLookup,
  nsfwTags,
  disableInlineEmotes,
  voiceExpiresAt,
  allowEmbeds = true,
  linkPreviews = false,
}: MarkdownTextProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const openMediaViewer = useUIStore((s) => s.openMediaViewer);
  const emoteSizePx = useSettingsStore((s) => s.emoteSizePx);
  const embedAutoplay = !useSettingsStore((s) => s.disableEmbedAutoplay);
  const allowNsfw = useContentSocialStore((s) => s.allowNsfw);
  const nsfwLewds = useContentSocialStore((s) => s.nsfwLewds);
  const nsfwBlood = useContentSocialStore((s) => s.nsfwBlood);
  const nsfwGore = useContentSocialStore((s) => s.nsfwGore);
  const [revealedImages, setRevealedImages] = useState(false);

  const shouldBlur = !revealedImages && shouldBlurForNsfwTags(nsfwTags, { allowNsfw, nsfwLewds, nsfwBlood, nsfwGore });
  const nsfwLabels = shouldBlur ? getNsfwSubtagLabels(nsfwTags) : [];
  const voiceExpired = typeof voiceExpiresAt === 'number' && voiceExpiresAt > 0 && Date.now() > voiceExpiresAt;
  const blocks = useMemo(() => {
    const parsed = parseBlocks(text, attachments, serverUrl, expressionLookup, serverUrl);
    // Expired voice files 404, so swap the player for a placeholder (matches desktop).
    const withVoice = voiceExpired
      ? parsed.map((block): Block => (block.b === 'video' || block.b === 'file' ? { b: 'voiceexpired' } : block))
      : parsed;
    return allowEmbeds ? withVoice : withVoice.filter((block) => block.b !== 'embed');
  }, [text, attachments, serverUrl, expressionLookup, voiceExpired, allowEmbeds]);
  // Desktop parity: unfurl the first URL unless it already has a YouTube/image embed.
  const previewUrl = useMemo(() => {
    if (!linkPreviews || !allowEmbeds) return null;
    const url = findFirstUrl(blocks);
    if (!url || blocks.some((block) => block.b === 'embed' && block.url === url)) return null;
    if (YT_RE.test(url) || IMG_URL_RE.test(url)) return null;
    return url;
  }, [blocks, linkPreviews, allowEmbeds]);
  const linkPreview = useLinkPreview(previewUrl);
  const previewNode = previewUrl && linkPreview
    ? linkPreview.type === 'media' && linkPreview.mime?.startsWith('video/')
      ? <ChatVideo url={linkPreview.url} name={linkPreview.title ?? null} serverUrl={serverUrl} imageScope={imageScope} autoLoop={!!linkPreview.animated && embedAutoplay} />
      : <LinkPreviewCard url={previewUrl} preview={linkPreview} />
    : null;
  const imageGallery = useMemo(
    () =>
      blocks
        .filter((block): block is ImageBlock => block.b === 'image')
        .map((block) => ({ url: block.url, name: block.name ?? null })),
    [blocks],
  );

  // Group consecutive image blocks so they render as a horizontal gallery row.
  const renderItems = useMemo(() => {
    type RenderItem =
      | { kind: 'non-image'; block: Block; idx: number }
      | { kind: 'images'; images: ImageBlock[]; startIdx: number };
    const result: RenderItem[] = [];
    let i = 0;
    while (i < blocks.length) {
      if (blocks[i].b === 'image') {
        const images: ImageBlock[] = [];
        const startIdx = i;
        while (i < blocks.length && blocks[i].b === 'image') {
          images.push(blocks[i] as ImageBlock);
          i++;
        }
        result.push({ kind: 'images', images, startIdx });
      } else {
        result.push({ kind: 'non-image', block: blocks[i], idx: i });
        i++;
      }
    }
    return result;
  }, [blocks]);

  const handlePressImage = useCallback((img: ImageBlock) => {
    if (!img.url) return;
    const imageIndex = imageGallery.findIndex((x) => x.url === img.url);
    openMediaViewer(img.url, img.name ?? null, imageGallery, imageIndex >= 0 ? imageIndex : 0);
  }, [imageGallery, openMediaViewer]);

  const handleReveal = useCallback(() => setRevealedImages(true), []);

  const cc: CC = {
    bg: theme.colors.bgElev2,
    fg: theme.colors.accent,
    link: theme.colors.accent,
    spoilerBg: theme.colors.bgElev2,
  };

  const bodyStyle: TextStyle = { color, fontSize: 15 };

  const headingSize = (b: 'h1' | 'h2' | 'h3'): TextStyle =>
    b === 'h1'
      ? { fontSize: 22, fontWeight: 'bold', marginBottom: 2 }
      : b === 'h2'
        ? { fontSize: 18, fontWeight: 'bold', marginBottom: 2 }
        : { fontSize: 15, fontWeight: 'bold', marginBottom: 1 };

  // Fast path: single plain paragraph with no embeds — no View wrapper keeps sizing natural
  if (blocks.length === 1 && blocks[0].b === 'para' && !attachments?.length && !previewNode) {
    return (
      <Text style={[bodyStyle, style]}>
        {renderSpans(blocks[0].spans, color, cc, emoteSizePx, disableInlineEmotes)}
      </Text>
    );
  }

  return (
    <View style={styles.container}>
      {renderItems.map((item) => {
        if (item.kind === 'images') {
          const { images, startIdx } = item;
          if (images.length === 1) {
            return (
              <SingleChatImage
                key={`img-${startIdx}`}
                block={images[0]}
                shouldBlur={shouldBlur}
                nsfwLabels={nsfwLabels}
                onReveal={handleReveal}
                onPress={handlePressImage}
                serverUrl={serverUrl}
                imageScope={imageScope}
              />
            );
          }
          return (
            <ImageGalleryRow
              key={`gallery-${startIdx}`}
              images={images}
              shouldBlur={shouldBlur}
              nsfwLabels={nsfwLabels}
              onReveal={handleReveal}
              onPress={handlePressImage}
              serverUrl={serverUrl}
              imageScope={imageScope}
            />
          );
        }

        const { block, idx: i } = item;
        switch (block.b) {
          case 'codeblock':
            return (
              <ScrollView
                key={i}
                horizontal
                showsHorizontalScrollIndicator={false}
                style={[styles.codeBlock, { backgroundColor: theme.colors.bgElev2 }]}
              >
                <Text
                  style={[
                    styles.codeBlockText,
                    {
                      color: theme.colors.text,
                      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                    },
                  ]}
                >
                  {block.content}
                </Text>
              </ScrollView>
            );

          case 'blockquote': {
            const quoteColor = theme.colors.text3;
            return (
              <View
                key={i}
                style={[
                  styles.blockquote,
                  {
                    borderLeftColor: theme.colors.text3,
                    backgroundColor: theme.colors.bgElev2,
                  },
                ]}
              >
                {block.lines.map((spans, li) => (
                  <Text key={li} style={[bodyStyle, style, { color: quoteColor }]}>
                    {renderSpans(spans, quoteColor, cc, emoteSizePx, disableInlineEmotes)}
                  </Text>
                ))}
              </View>
            );
          }

          case 'list':
            return (
              <View key={i} style={styles.list}>
                {block.items.map((spans, li) => (
                  <View key={li} style={styles.listRow}>
                    <Text style={[bodyStyle, styles.bullet, { color }]}>{'•'}</Text>
                    <Text style={[bodyStyle, style, { flex: 1 }]}>
                      {renderSpans(spans, color, cc, emoteSizePx, disableInlineEmotes)}
                    </Text>
                  </View>
                ))}
              </View>
            );

          case 'h1':
          case 'h2':
          case 'h3':
            return (
              <Text key={i} style={[bodyStyle, style, headingSize(block.b)]}>
                {renderSpans(block.spans, color, cc, emoteSizePx, disableInlineEmotes)}
              </Text>
            );

          case 'forwardmeta':
            return (
              <Text key={i} style={[styles.forwardMeta, { color: theme.colors.text3 }]}>
                {block.text}
              </Text>
            );

          case 'video':
            return <ChatVideo key={i} url={block.url} name={block.name} serverUrl={serverUrl} imageScope={imageScope} />;

          case 'audio':
          case 'voiceexpired':
            // Expired voice files 404, so audio past its expiry shares the placeholder.
            if (block.b === 'audio' && !voiceExpired) {
              return <VoiceMessagePlayer key={i} url={block.url} mime={block.mime} serverUrl={serverUrl} />;
            }
            return (
              <View key={i} style={styles.voiceExpired}>
                <Mic size={14} color={theme.colors.text3} style={{ opacity: 0.6 }} />
                <Text style={{ color: theme.colors.text3, fontSize: 13, fontStyle: 'italic' }}>
                  {t('chat.voiceMessageExpired')}
                </Text>
              </View>
            );

          case 'file':
            return (
              <Pressable
                key={i}
                onPress={() => block.url ? void Linking.openURL(block.url) : undefined}
                style={[styles.fileCard, { backgroundColor: theme.colors.bgElev2, borderColor: theme.colors.lineSoft }]}
              >
                <FileText size={20} color={theme.colors.text3} />
                <View style={{ flex: 1 }}>
                  <Text
                    style={{ color: theme.colors.text, fontSize: 14, fontWeight: '500' }}
                    numberOfLines={1}
                  >
                    {block.name ?? 'File'}
                  </Text>
                  {block.size ? (
                    <Text style={{ color: theme.colors.text3, fontSize: 12 }}>
                      {formatFileSize(block.size)}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );

          case 'embed':
            if (block.kind === 'youtube') {
              return <YouTubeEmbedCard key={i} videoId={block.videoId} url={block.url} />;
            }
            // image embed from a bare URL in text
            return (
              <SingleChatImage
                key={i}
                block={{ b: 'image', url: block.url, thumbnailUrl: null, mime: null, name: null }}
                autoplay={embedAutoplay}
                shouldBlur={false}
                nsfwLabels={[]}
                onReveal={() => {}}
                onPress={(img) => openMediaViewer(img.url, null, [{ url: img.url, name: null }], 0)}
              />
            );

          case 'para':
            return (
              <Text key={i} style={[bodyStyle, style]}>
                {renderSpans(block.spans, color, cc, emoteSizePx, disableInlineEmotes)}
              </Text>
            );

          default:
            return null;
        }
      })}
      {previewNode}
    </View>
  );
}

const styles = StyleSheet.create({
  imageFailed: { position: 'absolute', borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  container: { gap: 4 },
  codeBlock: {
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginVertical: 2,
  },
  codeBlockText: {
    fontSize: 13,
    lineHeight: 18,
  },
  blockquote: {
    borderLeftWidth: 4,
    borderRadius: 2,
    paddingLeft: 10,
    paddingVertical: 4,
    paddingRight: 6,
    gap: 2,
  },
  list: { gap: 2 },
  listRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  bullet: {
    lineHeight: 22,
    width: 12,
  },
  imageWrap: {
    width: '100%',
    borderRadius: 8,
    overflow: 'hidden',
    marginVertical: 2,
  },
  gifStarBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
  },
  nsfwOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  nsfwLabel: {
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  nsfwReveal: {
    fontSize: 12,
    textAlign: 'center',
  },
  forwardMeta: {
    fontSize: 12,
    lineHeight: 16,
    marginBottom: 2,
  },
  image: {
    width: '100%',
    height: 200,
    borderRadius: 8,
  },
  videoWrap: {
    borderRadius: 8,
    overflow: 'hidden',
    marginVertical: 2,
    borderWidth: 1,
    maxWidth: 480,
  },
  video: {
    width: '100%',
    height: 240,
  },
  videoMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  voiceExpired: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  fileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginVertical: 2,
  },
  emote: {
    width: 22,
    height: 22,
  },
  sticker: {
    width: 80,
    height: 80,
  },
  ytCard: {
    borderRadius: 10,
    borderWidth: 1,
    overflow: 'hidden',
    marginVertical: 2,
    maxWidth: 360,
  },
  ytThumbWrap: {
    width: '100%',
    height: 160,
    position: 'relative',
  },
  ytThumb: {
    width: '100%',
    height: 160,
  },
  ytPlayOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ytPlayBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 4,
    elevation: 4,
  },
  ytMeta: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  ytBadge: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
