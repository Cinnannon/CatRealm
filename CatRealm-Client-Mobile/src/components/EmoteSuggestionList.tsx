import { Image, ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '@/theme';
import type { EmoteSuggestion } from '@/lib/emoteSuggestions';
import { Pressable } from './Pressable';
import { Text } from './Text';

/** Tappable `:emoji` shortcode suggestions shown above the composer while typing `:name`. */
export function EmoteSuggestionList({
  items,
  onSelect,
}: {
  items: EmoteSuggestion[];
  onSelect: (item: EmoteSuggestion) => void;
}) {
  const theme = useTheme();
  if (items.length === 0) return null;

  return (
    <View
      testID="emote-suggestions"
      style={[
        styles.panel,
        {
          backgroundColor: theme.colors.bgElev1,
          borderColor: theme.colors.lineSoft,
        },
      ]}
    >
      <Text variant="caption" color={theme.colors.text3} style={styles.section}>
        Emojis & Emotes
      </Text>
      <ScrollView keyboardShouldPersistTaps="always" style={styles.scroll}>
        {items.map((item) => (
          <Pressable
            key={item.key}
            haptic
            onPress={() => onSelect(item)}
            style={styles.row}
            accessibilityLabel={item.label}
          >
            <View style={[styles.previewWrap, { backgroundColor: theme.colors.bgElev2 }]}>
              {item.previewImage ? (
                <Image
                  source={{ uri: item.previewImage }}
                  style={styles.emoteImg}
                  resizeMode="contain"
                />
              ) : (
                <Text style={styles.emojiGlyph}>{item.previewEmoji || '🙂'}</Text>
              )}
            </View>
            <Text variant="body" color={theme.colors.text} numberOfLines={1} style={styles.label}>
              {item.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    marginHorizontal: 8,
    marginBottom: 6,
    borderWidth: 1,
    borderRadius: 14,
    overflow: 'hidden',
  },
  scroll: {
    maxHeight: 220,
  },
  section: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 2,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    fontSize: 10,
  },
  row: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
  },
  previewWrap: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoteImg: {
    width: 22,
    height: 22,
  },
  emojiGlyph: {
    fontSize: 18,
    lineHeight: 22,
  },
  label: {
    flex: 1,
  },
});
