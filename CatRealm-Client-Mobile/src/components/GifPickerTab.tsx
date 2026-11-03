/**
 * GIF search tab for the mobile ExpressionPicker.
 *
 * Self-contained: owns its search box, trending default, result grid, and
 * infinite scroll. Talks only to Central's Klipy proxy via @/lib/gifApi and
 * hands the chosen GIF's direct media URL back through `onSelect` (the composer
 * sends it as a message; the URL ends in .gif/.webp so it renders inline).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Image,
  TextInput,
  FlatList,
  ScrollView,
  Linking,
  Pressable,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useTranslation } from 'react-i18next';
import { Star } from 'lucide-react-native';
import { useTheme } from '@/theme';
import {
  searchGifs,
  trendingGifs,
  type GifAd,
  type GifFavorite,
  type GifItem,
  type GifProduct,
  type GifResult,
  type GifError,
} from '@/lib/gifApi';
import { decideGifAdNavigation, isHttpAdUrl } from '@/lib/gifAdNavigation';
import {
  favoriteKey,
  findFavoriteByUrl,
  useGifFavoritesStore,
} from '@/stores/gifFavoritesStore';

interface GifPickerTabProps {
  onSelect: (gifUrl: string) => void;
  /** Width of the picker panel (narrower than the window on tablets). */
  width: number;
}

const GIF_COLS = 2;
const DEBOUNCE_MS = 300;
type GifSection = GifProduct | 'favorites';

/**
 * The grid is two columns but an ad is a full-width banner, and FlatList can't
 * mix column spans — so results become rows: GIFs pair up, an ad takes its own
 * row. Klipy chooses the ad's index deliberately, so rows keep that ordering.
 */
type GifRow =
  | { key: string; kind: 'gifs'; items: GifItem[] }
  | { key: string; kind: 'ad'; ad: GifAd };

function buildRows(results: GifResult[]): GifRow[] {
  const rows: GifRow[] = [];
  let pending: GifItem[] = [];
  const flush = () => {
    if (!pending.length) return;
    rows.push({ key: `g:${pending[0].id}:${rows.length}`, kind: 'gifs', items: pending });
    pending = [];
  };
  results.forEach((r, i) => {
    if (r.kind === 'ad') {
      flush();
      rows.push({ key: `ad:${i}:${r.content}`, kind: 'ad', ad: r });
      return;
    }
    pending.push(r);
    if (pending.length === GIF_COLS) flush();
  });
  flush();
  return rows;
}

/**
 * Klipy returns the ad as a URL to render in a WebView (we request
 * `ad-iframe=1`). An ad can redirect while loading; only a user-initiated
 * navigation may open the advertiser in the system browser.
 */
function AdRow({ ad, containerWidth }: { ad: GifAd; containerWidth: number }) {
  const initialLoadFinished = useRef(false);
  const width = Math.min(ad.width ?? containerWidth, containerWidth);
  const height = ad.height ?? 50;
  if (!isHttpAdUrl(ad.content)) return null;
  return (
    <View style={styles.adRow} pointerEvents="box-none">
      <WebView
        source={{ uri: ad.content }}
        style={{ width, height, backgroundColor: 'transparent' }}
        containerStyle={{ width, height, flex: 0 }}
        scrollEnabled={false}
        bounces={false}
        javaScriptEnabled
        setSupportMultipleWindows={false}
        originWhitelist={['*']}
        onLoadEnd={() => { initialLoadFinished.current = true; }}
        onShouldStartLoadWithRequest={(req) => {
          const decision = decideGifAdNavigation(req, ad.content, initialLoadFinished.current);
          if (decision === 'open') void Linking.openURL(req.url).catch(() => {});
          return decision === 'allow';
        }}
      />
    </View>
  );
}

export function GifPickerTab({ onSelect, width: pickerWidth }: GifPickerTabProps) {
  const theme = useTheme();
  const { t: tr } = useTranslation();
  const gifCell = (pickerWidth - 24) / GIF_COLS;
  /**
   * Width we tell Klipy an ad may occupy. Must be the container, not a cell —
   * Klipy serves no creative narrower than 250px, and a cell is ~183.
   */
  const adContainerWidth = pickerWidth - 16;

  const [query, setQuery] = useState('');
  const [section, setSection] = useState<GifSection>('gifs');
  const [results, setResults] = useState<GifResult[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorCode, setErrorCode] = useState<GifError['code'] | null>(null);

  const favorites = useGifFavoritesStore((s) => s.favorites);
  const favoritesLoading = useGifFavoritesStore((s) => s.loading);
  const favoritesError = useGifFavoritesStore((s) => s.error);
  const favoriteBusy = useGifFavoritesStore((s) => s.busy);
  const loadFavorites = useGifFavoritesStore((s) => s.load);
  const toggleFavorite = useGifFavoritesStore((s) => s.toggle);

  // Guards against a stale in-flight request applying after the query changed.
  const requestSeq = useRef(0);

  useEffect(() => {
    void loadFavorites();
  }, [loadFavorites]);

  const runQuery = useCallback(async (q: string, source: GifProduct) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setErrorCode(null);
    try {
      const opts = { containerWidth: adContainerWidth, product: source };
      const page = q.trim() ? await searchGifs(q, opts) : await trendingGifs(opts);
      if (seq !== requestSeq.current) return;
      setResults(page.results);
      setNext(page.next);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setResults([]);
      setNext(null);
      setErrorCode((err as GifError)?.code ?? 'unavailable');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [adContainerWidth]);

  // Switching library clears the query: a search is scoped to one library, and
  // carrying terms across makes the empty state look like a failure.
  const selectSection = useCallback((nextSection: GifSection) => {
    requestSeq.current++;
    setSection(nextSection);
    setQuery('');
    setLoading(false);
    setLoadingMore(false);
  }, []);

  useEffect(() => {
    if (section === 'favorites') {
      return;
    }
    const handle = setTimeout(() => { void runQuery(query, section); }, query ? DEBOUNCE_MS : 0);
    return () => clearTimeout(handle);
  }, [query, section, runQuery]);

  const loadMore = useCallback(async () => {
    if (section === 'favorites' || next == null || loadingMore || loading) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    try {
      const opts = { pos: next, containerWidth: adContainerWidth, product: section };
      const page = query.trim() ? await searchGifs(query, opts) : await trendingGifs(opts);
      if (seq !== requestSeq.current) return;
      setResults((prev) => [...prev, ...page.results]);
      setNext(page.next);
    } catch {
      if (seq === requestSeq.current) setNext(null);
    } finally {
      if (seq === requestSeq.current) setLoadingMore(false);
    }
  }, [adContainerWidth, next, loadingMore, loading, query, section]);

  const displayedResults: GifResult[] = section === 'favorites'
    ? favorites.filter((favorite) => favorite.title.toLowerCase().includes(query.trim().toLowerCase()))
    : results;
  const rows = useMemo(() => buildRows(displayedResults), [displayedResults]);

  const errorText = errorCode === 'not_configured'
    ? tr('chat.gifUnavailable')
    : errorCode === 'rate_limited'
      ? tr('chat.gifRateLimited')
      : errorCode
        ? tr('chat.gifLoadFailed')
        : null;

  return (
    <View style={{ flex: 1 }}>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={tr(section === 'favorites' ? 'chat.gifSearchFavorites' : 'chat.gifSearchPlaceholder')}
        placeholderTextColor={theme.colors.text3}
        style={[styles.search, { backgroundColor: theme.colors.bgElev2, color: theme.colors.text, borderColor: theme.colors.lineSoft }]}
        autoCorrect={false}
      />

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={styles.presets}>
        {([
          ['gifs', tr('chat.gifTrending')],
          ['memes', tr('chat.gifTrendingMemes')],
          ['favorites', tr('chat.gifFavorites')],
        ] as const).map(([id, label]) => {
          const active = section === id;
          return (
            <Pressable
              key={id}
              onPress={() => selectSection(id)}
              style={[styles.preset, {
                backgroundColor: active ? theme.colors.accentSoft : theme.colors.bgElev2,
                borderColor: active ? theme.colors.accent : theme.colors.lineSoft,
              }]}
            >
              <Text style={{ color: active ? theme.colors.accent : theme.colors.text2, fontWeight: '600' }}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {section === 'favorites' && favoritesLoading ? (
        <View style={styles.center}><ActivityIndicator color={theme.colors.accent} /></View>
      ) : section === 'favorites' && favoritesError === 'load' && favorites.length === 0 ? (
        <View style={styles.center}>
          <Text style={{ color: theme.colors.text3, textAlign: 'center' }}>{tr('chat.gifFavoritesLoadFailed')}</Text>
          <Pressable onPress={() => void loadFavorites()} style={{ marginTop: 10 }}>
            <Text style={{ color: theme.colors.accent, fontWeight: '600' }}>{tr('chat.gifRetry')}</Text>
          </Pressable>
        </View>
      ) : section !== 'favorites' && loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.colors.accent} /></View>
      ) : section !== 'favorites' && errorText ? (
        <View style={styles.center}>
          <Text style={{ color: theme.colors.text3, textAlign: 'center' }}>{errorText}</Text>
          {errorCode !== 'not_configured' && (
            <Pressable onPress={() => void runQuery(query, section)} style={{ marginTop: 10 }}>
              <Text style={{ color: theme.colors.accent, fontWeight: '600' }}>{tr('chat.gifRetry')}</Text>
            </Pressable>
          )}
        </View>
      ) : displayedResults.length === 0 ? (
        <View style={styles.center}>
          <Text style={{ color: theme.colors.text3, textAlign: 'center' }}>
            {section === 'favorites'
              ? tr(query ? 'chat.gifFavoritesNoMatch' : 'chat.gifFavoritesEmpty')
              : tr('chat.gifNoResults')}
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) => row.key}
          contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 8 }}
          onEndReached={() => void loadMore()}
          onEndReachedThreshold={0.5}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item: row }) => (
            row.kind === 'ad' ? (
              <AdRow ad={row.ad} containerWidth={adContainerWidth} />
            ) : (
              <View style={styles.gifRow}>
                {row.items.map((gif) => {
                  const itemProduct = section === 'favorites' ? (gif as GifFavorite).product : section;
                  const key = favoriteKey(itemProduct, gif.id);
                  const saved =
                    favorites.some((favorite) => favoriteKey(favorite.product, favorite.id) === key) ||
                    Boolean(findFavoriteByUrl(favorites, gif.url));
                  const busy = favoritesLoading || Boolean(favoriteBusy[key]);
                  return (
                    <View key={key} style={[styles.cell, { width: gifCell, backgroundColor: theme.colors.bgElev2, borderColor: theme.colors.lineSoft }]}>
                      <Pressable onPress={() => { onSelect(gif.url); }}>
                        <Image source={{ uri: gif.previewUrl }} style={{ width: '100%', height: gifCell - 8 }} resizeMode="cover" />
                      </Pressable>
                      <Pressable
                        onPress={() => void toggleFavorite(gif, itemProduct)}
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityLabel={tr(saved ? 'chat.gifRemoveFavorite' : 'chat.gifAddFavorite')}
                        accessibilityState={{ selected: saved, disabled: busy }}
                        style={styles.favoriteButton}
                      >
                        <Star size={18} color={saved ? '#fbbf24' : '#fff'} fill={saved ? '#fbbf24' : 'none'} />
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            )
          )}
          ListFooterComponent={section !== 'favorites' && loadingMore ? <ActivityIndicator color={theme.colors.accent} style={{ marginVertical: 10 }} /> : null}
        />
      )}

      {favoritesError === 'update' && (
        <Text accessibilityRole="alert" style={{ color: theme.colors.text3, fontSize: 12, textAlign: 'center', paddingVertical: 4 }}>
          {tr('chat.gifFavoritesUpdateFailed')}
        </Text>
      )}

      <Text style={{ color: theme.colors.text3, fontSize: 10, textAlign: 'right', paddingHorizontal: 12, paddingVertical: 4 }}>
        {tr('chat.gifPoweredBy')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  search: {
    marginHorizontal: 12,
    marginVertical: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 14,
  },
  presets: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingBottom: 4 },
  preset: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  gifRow: { flexDirection: 'row' },
  adRow: { alignItems: 'center', marginVertical: 4, overflow: 'hidden' },
  favoriteButton: { position: 'absolute', top: 4, right: 4, padding: 6, borderRadius: 8, backgroundColor: 'rgba(0, 0, 0, 0.7)' },
  cell: {
    margin: 4,
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
  },
});
