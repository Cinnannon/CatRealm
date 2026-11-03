/**
 * `:shortcode` emoji & custom emote autocomplete and `:shortcode:` replacement
 * for MobileComposer, mirroring Desktop's MessageInput (`updateEmoteSuggestions`).
 */

import {
  getOrigin,
  normalizeExprName,
  type ExpressionEntry,
  type ExpressionLookup,
} from './expressionCache';

type CompactEmoji = {
  unicode: string;
  label: string;
  shortcodes?: string[];
  tags?: string[];
};

export type EmoteSuggestion = {
  key: string;
  label: string;
  insert: string;
  previewImage?: string;
  previewEmoji?: string;
  name?: string;
  isSticker?: boolean;
};

interface IndexedEmoji {
  emoji: string;
  alias: string;
  aliases: string[];
  searchIndex: string;
}

// Common Discord/Slack shortcodes so typing :joy:, :sob:, :heart:, :thumbsup:, etc. always hits first
const COMMON_SHORTCODE_OVERRIDES: Record<string, string> = {
  joy: '😂',
  rofl: '🤣',
  sob: '😭',
  cry: '😢',
  smile: '😄',
  grin: '😁',
  wink: '😉',
  blush: '😊',
  heart: '❤️',
  broken_heart: '💔',
  fire: '🔥',
  sparkles: '✨',
  star: '⭐',
  tada: '🎉',
  party: '🥳',
  thumbsup: '👍',
  '+1': '👍',
  thumbsdown: '👎',
  '-1': '👎',
  ok_hand: '👌',
  clap: '👏',
  pray: '🙏',
  wave: '👋',
  muscle: '💪',
  eyes: '👀',
  skull: '💀',
  poop: '💩',
  clown: '🤡',
  ghost: '👻',
  alien: '👽',
  robot: '🤖',
  cat: '🐱',
  dog: '🐶',
  fox: '🦊',
  rocket: '🚀',
  100: '💯',
  thinking: '🤔',
  sunglasses: '😎',
  cool: '😎',
  pleading_face: '🥺',
  pleading: '🥺',
  angry: '😠',
  rage: '😡',
  sleeping: '😴',
  zzz: '💤',
  sweat_smile: '😅',
  kissing_heart: '😘',
  heart_eyes: '😍',
  smirk: '😏',
  unamused: '😒',
  rolling_eyes: '🙄',
  scream: '😱',
  flushed: '😳',
  exploding_head: '🤯',
  check: '✅',
  white_check_mark: '✅',
  x: '❌',
  warning: '⚠️',
  question: '❓',
  exclamation: '❗',
};

let cachedEmojiIndex: IndexedEmoji[] | null = null;
let cachedExactMap: Map<string, string> | null = null;

function toShortcodeSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9+-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function ensureEmojiIndex(): { list: IndexedEmoji[]; exactMap: Map<string, string> } {
  if (cachedEmojiIndex && cachedExactMap) {
    return { list: cachedEmojiIndex, exactMap: cachedExactMap };
  }

  const data = require('emojibase-data/en/compact.json') as CompactEmoji[];
  const list: IndexedEmoji[] = [];
  const exactMap = new Map<string, string>();

  for (const [alias, emoji] of Object.entries(COMMON_SHORTCODE_OVERRIDES)) {
    exactMap.set(alias, emoji);
  }

  const reverseOverrides = new Map<string, string[]>();
  for (const [alias, emoji] of Object.entries(COMMON_SHORTCODE_OVERRIDES)) {
    const clean = emoji.replace(/\uFE0F/g, '');
    const existing = reverseOverrides.get(clean) ?? [];
    existing.push(alias);
    reverseOverrides.set(clean, existing);
  }

  for (const entry of data) {
    if (!entry.unicode || !entry.label) continue;
    const primaryAlias = toShortcodeSlug(entry.label);
    if (!primaryAlias) continue;
    const cleanGlyph = entry.unicode.replace(/\uFE0F/g, '');
    const extraAliases = reverseOverrides.get(cleanGlyph) ?? [];
    const tagSlugs = (entry.tags ?? []).map(toShortcodeSlug).filter(Boolean);
    const aliases = Array.from(new Set([ ...extraAliases, primaryAlias, ...tagSlugs ]));
    const preferredAlias = extraAliases[0] ?? primaryAlias;

    if (!exactMap.has(primaryAlias)) {
      exactMap.set(primaryAlias, entry.unicode);
    }

    const searchIndex = [
      preferredAlias,
      primaryAlias,
      entry.label.toLowerCase(),
      ...extraAliases,
      ...(entry.tags ?? []).map((t) => t.toLowerCase()),
    ].join(' ');

    list.push({
      emoji: entry.unicode,
      alias: preferredAlias,
      aliases,
      searchIndex,
    });
  }

  cachedEmojiIndex = list;
  cachedExactMap = exactMap;
  return { list, exactMap };
}

/**
 * Returns the `:query` currently being typed right before the caret (minimum 2 characters),
 * or `null` if the caret is not inside an active `:shortcode` token.
 */
export function activeEmoteQuery(textBeforeCaret: string): string | null {
  const match = /(?:^|\s):([a-z0-9_+-]{2,32})$/i.exec(textBeforeCaret);
  return match ? match[1] : null;
}

function buildCustomEmoteToken(
  item: ExpressionEntry,
  currentServerUrl: string | null | undefined,
): string {
  const origin = item.origin ? getOrigin(item.origin) : null;
  const currentOrigin = currentServerUrl ? getOrigin(currentServerUrl) : null;
  const ownerId = item.ownerId?.toLowerCase().replace(/[^a-z0-9_-]/g, '') ?? '';
  const name = normalizeExprName(item.name);

  if (origin && origin !== currentOrigin) {
    return ownerId ? `:${origin}:${name}:${ownerId}:` : `:${origin}:${name}:`;
  }
  return ownerId ? `:${name}:${ownerId}:` : `:${name}:`;
}

/**
 * Builds up to 12 `:shortcode` autocomplete items combining custom server/personal emotes
 * and standard Unicode emojis (matching Desktop's `updateEmoteSuggestions`).
 */
export function buildEmoteSuggestions(
  query: string,
  lookup?: ExpressionLookup | null,
  currentServerUrl?: string | null,
): EmoteSuggestion[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const results: EmoteSuggestion[] = [];
  const seen = new Set<string>();

  if (lookup) {
    const customMatches = [...lookup.values()]
      .filter((entry) => entry.emote && entry.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return aStarts - bStarts || a.name.localeCompare(b.name);
      })
      .slice(0, 6);

    for (const entry of customMatches) {
      if (!entry.emote) continue;
      const name = normalizeExprName(entry.name);
      const label = `:${name}:`;
      if (seen.has(label)) continue;
      seen.add(label);
      results.push({
        key: `custom:${entry.origin ?? 'local'}:${name}:${entry.ownerId ?? ''}`,
        label,
        insert: buildCustomEmoteToken(entry, currentServerUrl),
        previewImage: entry.emote,
        name,
        isSticker: false,
      });
    }
  }

  const { list } = ensureEmojiIndex();
  const unicodeMatches = list
    .filter((entry) => entry.searchIndex.includes(q))
    .sort((a, b) => {
      const aExact = a.aliases.includes(q) ? 0 : 1;
      const bExact = b.aliases.includes(q) ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      const aPrefix = a.alias.startsWith(q) || a.aliases.some((al) => al.startsWith(q)) ? 0 : 1;
      const bPrefix = b.alias.startsWith(q) || b.aliases.some((al) => al.startsWith(q)) ? 0 : 1;
      return aPrefix - bPrefix;
    })
    .slice(0, 10);

  for (const entry of unicodeMatches) {
    const matchedAlias =
      entry.aliases.find((al) => al === q) ??
      entry.aliases.find((al) => al.startsWith(q)) ??
      entry.alias;
    const label = `:${matchedAlias}:`;
    if (seen.has(label)) continue;
    seen.add(label);
    results.push({
      key: `emoji:${entry.emoji}:${matchedAlias}`,
      label,
      insert: entry.emoji,
      previewEmoji: entry.emoji,
    });
  }

  return results.slice(0, 12);
}

/**
 * Replaces completed `:shortcode:` tokens with their Unicode emoji when they
 * match a known Unicode emoji shortcode and aren't a custom server emote.
 */
export function replaceCompletedEmojiShortcodes(
  text: string,
  lookup?: ExpressionLookup | null,
): string {
  if (!text.includes(':')) return text;
  const { exactMap } = ensureEmojiIndex();
  return text.replace(/(^|\s):([a-z0-9_+-]{2,32}):/gi, (fullMatch, prefix: string, rawName: string) => {
    const lower = rawName.toLowerCase();
    // Preserve custom server/personal emotes so serializeComposerText can tokenize them
    if (lookup) {
      const norm = normalizeExprName(lower);
      const hasCustom = [...lookup.values()].some(
        (candidate) => Boolean(candidate.emote) && normalizeExprName(candidate.name) === norm,
      );
      if (hasCustom) return fullMatch;
    }
    const unicode = exactMap.get(lower);
    if (!unicode) return fullMatch;
    return `${prefix}${unicode}`;
  });
}
