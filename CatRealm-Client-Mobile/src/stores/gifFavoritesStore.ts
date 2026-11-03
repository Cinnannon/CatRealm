import { create } from 'zustand';
import {
  getGifFavorites,
  removeGifFavorite,
  saveGifFavorite,
  type GifFavorite,
  type GifItem,
  type GifProduct,
} from '@/lib/gifApi';

export function favoriteKey(product: GifProduct, id: string): string {
  return `${product}:${id}`;
}

/**
 * A GIF sent in chat only carries its URL, while a picker item has a Klipy id.
 * Derive a deterministic id from the URL so chat-starred GIFs can be saved and
 * later matched by URL even when they were originally starred from the picker.
 */
function idFromUrl(rawUrl: string): string {
  const clean = rawUrl.trim().split('#')[0]?.split('?')[0] ?? rawUrl.trim();
  return `url:${clean.slice(-200)}`;
}

function normalizeMediaUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  try {
    const u = new URL(trimmed);
    u.hash = '';
    return u.toString();
  } catch {
    return trimmed;
  }
}

export function findFavoriteByUrl(favorites: GifFavorite[], rawUrl: string): GifFavorite | undefined {
  const target = normalizeMediaUrl(rawUrl);
  return favorites.find(
    (fav) => normalizeMediaUrl(fav.url) === target || normalizeMediaUrl(fav.previewUrl) === target,
  );
}

export function isGifMediaUrl(rawUrl: string | null | undefined, mime?: string | null): boolean {
  if (mime && /image\/gif/i.test(mime)) return true;
  const clean = String(rawUrl ?? '').trim();
  if (!clean) return false;
  if (/\.gif(\?|$|#)/i.test(clean)) return true;
  try {
    const host = new URL(clean).hostname.toLowerCase();
    return (
      host === 'static.klipy.com' ||
      host === 'static1.klipy.com' ||
      host === 'static2.klipy.com' ||
      host.endsWith('.tenor.com') ||
      host.endsWith('.giphy.com')
    );
  } catch {
    return false;
  }
}

interface GifFavoritesState {
  favorites: GifFavorite[];
  loading: boolean;
  loaded: boolean;
  error: 'load' | 'update' | null;
  busy: Record<string, true>;
  load: () => Promise<void>;
  ensureLoaded: () => Promise<void>;
  toggle: (item: GifItem, product: GifProduct) => Promise<void>;
  toggleUrl: (rawUrl: string) => Promise<void>;
  reset: () => void;
}

let inflightLoad: Promise<void> | null = null;

export const useGifFavoritesStore = create<GifFavoritesState>((set, get) => ({
  favorites: [],
  loading: false,
  loaded: false,
  error: null,
  busy: {},

  load: async () => {
    if (inflightLoad) return inflightLoad;
    set({ loading: true, error: null });
    inflightLoad = (async () => {
      try {
        const favorites = await getGifFavorites();
        set({ favorites, loading: false, loaded: true, error: null });
      } catch {
        set({ loading: false, error: 'load' });
      } finally {
        inflightLoad = null;
      }
    })();
    return inflightLoad;
  },

  ensureLoaded: async () => {
    const { loaded, loading, load } = get();
    if (loaded || loading) {
      if (inflightLoad) await inflightLoad;
      return;
    }
    await load();
  },

  toggle: async (item, product) => {
    const existingByUrl = findFavoriteByUrl(get().favorites, item.url);
    const effectiveProduct = existingByUrl ? existingByUrl.product : product;
    const effectiveId = existingByUrl ? existingByUrl.id : item.id;
    const key = favoriteKey(effectiveProduct, effectiveId);
    const state = get();
    if (state.busy[key] || state.loading) return;

    const alreadySaved =
      Boolean(existingByUrl) ||
      state.favorites.some((fav) => favoriteKey(fav.product, fav.id) === key);
    set((s) => ({ busy: { ...s.busy, [key]: true }, error: null }));
    try {
      if (alreadySaved) {
        await removeGifFavorite(effectiveId, effectiveProduct);
        set((s) => ({
          favorites: s.favorites.filter((fav) => favoriteKey(fav.product, fav.id) !== key),
        }));
      } else {
        const saved = await saveGifFavorite(item, product);
        set((s) => ({
          favorites: [
            saved,
            ...s.favorites.filter((fav) => favoriteKey(fav.product, fav.id) !== favoriteKey(saved.product, saved.id)),
          ],
        }));
      }
    } catch {
      set({ error: 'update' });
    } finally {
      set((s) => {
        const next = { ...s.busy };
        delete next[key];
        return { busy: next };
      });
    }
  },

  toggleUrl: async (rawUrl) => {
    await get().ensureLoaded();
    const url = normalizeMediaUrl(rawUrl);
    const existing = findFavoriteByUrl(get().favorites, url);
    if (existing) {
      await get().toggle(existing, existing.product);
      return;
    }
    const filename = url.split('/').pop()?.split('?')[0] ?? 'GIF';
    const item: GifItem = {
      kind: 'gif',
      id: idFromUrl(url),
      url,
      previewUrl: url,
      title: filename || 'GIF',
      width: null,
      height: null,
    };
    await get().toggle(item, 'gifs');
  },

  reset: () => {
    inflightLoad = null;
    set({ favorites: [], loading: false, loaded: false, error: null, busy: {} });
  },
}));
