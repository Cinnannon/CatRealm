import { Image, StyleSheet, View } from 'react-native';
import { useTheme } from '@/theme';
import { Text } from './Text';
import { Pressable } from './Pressable';
import { resolveEmoteFromCache } from '@/lib/expressionCache';

// Matches compact emote tokens: :server:name:, :name:, :name:ownerId:, etc.
const REACTION_TOKEN_RE = /^:(https?:\/\/[^\s:]+(?::\d{1,5})?):(?:sticker:)?([a-z0-9_-]{1,64})(?::([a-z0-9_-]{3,128}))?:|^:(?:sticker:)?([a-z0-9_-]{1,64})(?::([a-z0-9_-]{3,128}))?:/i;

export function ReactionEmoji({ emoji, serverUrl }: { emoji: string; serverUrl?: string | null }) {
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

/** Reaction pills under a message; tapping one toggles the viewer's reaction. */
export function ReactionChips({
  reactions,
  serverUrl,
  onToggle,
  onLongPress,
}: {
  reactions: ReadonlyArray<{ emoji: string; count: number; reacted?: boolean }>;
  serverUrl?: string | null;
  onToggle?: (emoji: string) => void;
  onLongPress?: (emoji: string) => void;
}) {
  const theme = useTheme();
  if (reactions.length === 0) return null;
  return (
    <View style={styles.row}>
      {reactions.map((reaction) => (
        <Pressable
          key={reaction.emoji}
          onPress={() => onToggle?.(reaction.emoji)}
          onLongPress={() => onLongPress?.(reaction.emoji)}
          style={[
            styles.chip,
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
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 4,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
});
