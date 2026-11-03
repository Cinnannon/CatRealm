import { useEffect, useState } from 'react';
import { Image as ExpoImage } from 'expo-image';
import * as FileSystem from 'expo-file-system/legacy';

export const CACHE_DIR = FileSystem.documentDirectory! + 'CatRealmCache/';

const SKIP_RE = /^(file:|data:|blob:|assets-library:|asset:)/i;
const inFlight = new Map<string, Promise<string>>();
// Remote URL -> cached file already confirmed on disk this session, keyed like
// inFlight. A remount starts on the file directly instead of the remote URL, so
// the image does not swap sources (and flash its placeholder) on every mount.
const resolvedPaths = new Map<string, string>();

function forgetResolved(match: (localPath: string) => boolean): void {
  for (const [key, localPath] of resolvedPaths) {
    if (match(localPath)) resolvedPaths.delete(key);
  }
}

// ─── File type detection & cap enforcement ───────────────────────────────────

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'ts', 'flv', '3gp']);

type MediaType = 'image' | 'video' | 'other';

function detectFileType(path: string): MediaType {
  const ext = path.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'other';
}

let _imageCap = 150 * 1024 * 1024;
let _videoCap  = 250 * 1024 * 1024;

export function setCacheCaps(imageMb: number, videoMb: number): void {
  _imageCap = imageMb * 1024 * 1024;
  _videoCap  = videoMb * 1024 * 1024;
}

async function enforceCacheCap(type: MediaType): Promise<void> {
  if (type === 'other') return;
  const cap = type === 'image' ? _imageCap : _videoCap;
  if (cap <= 0) return;

  const found: { path: string; size: number; mtime: number }[] = [];

  async function scanDir(dir: string): Promise<void> {
    try {
      const info = await FileSystem.getInfoAsync(dir);
      if (!info.exists || !info.isDirectory) return;
      const names = await FileSystem.readDirectoryAsync(dir);
      await Promise.all(names.map(async (n) => {
        const p = dir + n;
        const fi = await FileSystem.getInfoAsync(p);
        if (!fi.exists) return;
        if (fi.isDirectory) {
          await scanDir(p + '/');
        } else if (detectFileType(p) === type) {
          const size  = 'size'             in fi ? (fi.size             as number) : 0;
          const mtime = 'modificationTime' in fi ? (fi.modificationTime as number) : 0;
          found.push({ path: p, size, mtime });
        }
      }));
    } catch { /* ignore */ }
  }

  await scanDir(CACHE_DIR);
  found.sort((a, b) => a.mtime - b.mtime);

  let total = found.reduce((s, f) => s + f.size, 0);
  for (const file of found) {
    if (total <= cap) break;
    try {
      await FileSystem.deleteAsync(file.path, { idempotent: true });
      forgetResolved((localPath) => localPath === file.path);
      total -= file.size;
    } catch { /* ignore */ }
  }
}

// A page of media can finish dozens of downloads at once. Scan the cache once
// per burst instead of starting a full directory walk for every image.
const pendingCapTypes = new Set<MediaType>();
let capTimer: ReturnType<typeof setTimeout> | null = null;
let capScanRunning = false;

function scheduleCacheCap(type: MediaType): void {
  if (type === 'other') return;
  pendingCapTypes.add(type);
  if (capTimer || capScanRunning) return;
  capTimer = setTimeout(() => {
    capTimer = null;
    capScanRunning = true;
    void (async () => {
      try {
        while (pendingCapTypes.size > 0) {
          const types = [...pendingCapTypes];
          pendingCapTypes.clear();
          for (const pendingType of types) await enforceCacheCap(pendingType);
        }
      } finally {
        capScanRunning = false;
        if (pendingCapTypes.size > 0) scheduleCacheCap([...pendingCapTypes][0]);
      }
    })().catch(() => { /* Cache cleanup is best effort. */ });
  }, 250);
}

// ─── Scope helpers ──────────────────────────────────────────────────────────────
// Scope is a relative path within CACHE_DIR, e.g. 'Central/Avatars' or 'Realms/ab12cd34'

export type CentralCategory = 'Avatars' | 'DMs' | 'Emotes' | 'Icons';

export function centralScope(category: CentralCategory = 'Avatars'): string {
  return `Central/${category}`;
}

/**
 * Scope for a self-hosted realm server. Pass the server's URL or a pre-known
 * UUID/ID — URLs are hashed to their origin for a stable, short folder name.
 */
export function realmScope(serverUrlOrId: string): string {
  const id = /^https?:\/\//i.test(serverUrlOrId)
    ? originHash(serverUrlOrId)
    : serverUrlOrId;
  return `Realms/${id}`;
}

/** Returns the origin hash used as the Realms/ folder name for a given URL. */
export function originHashForUrl(url: string): string {
  return originHash(url);
}

// ─── Internal helpers ───────────────────────────────────────────────────────────

function djb2(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0;
  return h;
}

function originHash(url: string): string {
  try {
    return djb2(new globalThis.URL(url).origin).toString(16);
  } catch {
    return djb2(url).toString(16);
  }
}

function urlToFilename(url: string): string {
  const base = url.split('?')[0].split('#')[0];
  const lastSlash = base.lastIndexOf('/');
  const segment = lastSlash !== -1 ? base.slice(lastSlash + 1) : base;
  const lastDot = segment.lastIndexOf('.');
  const rawExt = lastDot !== -1
    ? segment.slice(lastDot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6)
    : '';
  const ext = IMAGE_EXTS.has(rawExt) || VIDEO_EXTS.has(rawExt) ? rawExt : 'jpg';
  return `${djb2(url).toString(16)}.${ext}`;
}

async function ensureDir(dir: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return 0;
    if (info.isDirectory) {
      const base = path.endsWith('/') ? path : path + '/';
      const entries = await FileSystem.readDirectoryAsync(path);
      const sizes = await Promise.all(entries.map((e) => sizeOf(base + e)));
      return sizes.reduce((a, b) => a + b, 0);
    }
    return 'size' in info ? (info.size as number) : 0;
  } catch {
    return 0;
  }
}

// ─── Core API ───────────────────────────────────────────────────────────────────

/**
 * Download and cache a remote image into the given scope folder.
 * Returns the local file path on success, or the original URL on failure.
 *
 * Use centralScope() or realmScope() helpers to build the scope string.
 */
export async function getCachedUri(remoteUrl: string, scope: string): Promise<string> {
  if (SKIP_RE.test(remoteUrl)) return remoteUrl;

  const cacheKey = `${scope}::${remoteUrl}`;
  const known = resolvedPaths.get(cacheKey);
  if (known) return known;
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey)!;

  const run = async (): Promise<string> => {
    try {
      const dir = CACHE_DIR + scope + '/';
      await ensureDir(dir);
      const localPath = dir + urlToFilename(remoteUrl);
      const info = await FileSystem.getInfoAsync(localPath);
      if (info.exists) {
        const size = 'size' in info ? (info.size as number) : 1;
        if (size > 0) return localPath;
        await FileSystem.deleteAsync(localPath, { idempotent: true });
      }

      const result = await FileSystem.downloadAsync(remoteUrl, localPath);
      if (result.status < 200 || result.status >= 300) {
        await FileSystem.deleteAsync(localPath, { idempotent: true });
        return remoteUrl;
      }
      scheduleCacheCap(detectFileType(localPath));
      return localPath;
    } catch {
      return remoteUrl;
    }
  };

  const promise = run()
    .then((uri) => {
      if (uri !== remoteUrl) resolvedPaths.set(cacheKey, uri);
      return uri;
    })
    .finally(() => inFlight.delete(cacheKey));
  inFlight.set(cacheKey, promise);
  return promise;
}

/** Drop a cached copy that failed to decode so the next request re-downloads it. */
export function evictCachedFile(localPath: string): void {
  if (!localPath.startsWith(CACHE_DIR)) return;
  forgetResolved((path) => path === localPath);
  void FileSystem.deleteAsync(localPath, { idempotent: true }).catch(() => {});
}

// ─── React hook ─────────────────────────────────────────────────────────────────

export function useCachedUri(remoteUrl: string | null, scope: string): string | null {
  const [resolved, setResolved] = useState<string | null>(
    () => (remoteUrl ? resolvedPaths.get(`${scope}::${remoteUrl}`) ?? remoteUrl : null),
  );

  useEffect(() => {
    if (!remoteUrl) {
      setResolved(null);
      return;
    }
    const known = resolvedPaths.get(`${scope}::${remoteUrl}`);
    if (known) {
      setResolved(known);
      return;
    }
    setResolved(remoteUrl);
    if (SKIP_RE.test(remoteUrl)) return;

    let cancelled = false;
    void getCachedUri(remoteUrl, scope).then((uri) => {
      if (!cancelled) setResolved(uri);
    });
    return () => { cancelled = true; };
  }, [remoteUrl, scope]);

  return resolved;
}

export function clearImageMemoryCache(): void {
  void ExpoImage.clearMemoryCache().catch(() => {
    // Best effort: native caches can reject while images are still being decoded.
  });
}

// ─── Size & management ──────────────────────────────────────────────────────────

export async function getCacheSize(): Promise<number> {
  return sizeOf(CACHE_DIR);
}

export type ScopeEntry = {
  scope: string;   // e.g. 'Central/Avatars', 'Realms/ab12cd34'
  size: number;
  count: number;
};

/**
 * Returns per-scope cache sizes.
 * Central sub-folders (Avatars, DMs, …) are returned individually.
 * Each Realms/{hash} folder is returned as a single entry.
 */
/** Returns local file paths for every cached file within a scope folder. */
export async function getCacheScopeFiles(scope: string): Promise<string[]> {
  try {
    const dir = CACHE_DIR + scope + '/';
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) return [];
    const names = await FileSystem.readDirectoryAsync(dir);
    return names.map((n) => dir + n);
  } catch {
    return [];
  }
}

export async function getCacheScopeBreakdown(): Promise<ScopeEntry[]> {
  const entries: ScopeEntry[] = [];
  try {
    const info = await FileSystem.getInfoAsync(CACHE_DIR);
    if (!info.exists) return [];

    const topDirs = await FileSystem.readDirectoryAsync(CACHE_DIR);
    for (const top of topDirs) {
      const topPath = CACHE_DIR + top + '/';
      const topInfo = await FileSystem.getInfoAsync(topPath);
      if (!topInfo.exists || !topInfo.isDirectory) continue;

      if (top === 'Central') {
        const cats = await FileSystem.readDirectoryAsync(topPath);
        for (const cat of cats) {
          const catPath = topPath + cat + '/';
          const catInfo = await FileSystem.getInfoAsync(catPath);
          if (catInfo.exists && catInfo.isDirectory) {
            const files = await FileSystem.readDirectoryAsync(catPath);
            const count = files.length;
            const size = await sizeOf(catPath);
            if (size > 0) entries.push({ scope: `Central/${cat}`, size, count });
          }
        }
      } else if (top === 'Realms') {
        const realms = await FileSystem.readDirectoryAsync(topPath);
        for (const realm of realms) {
          const realmPath = topPath + realm + '/';
          const realmInfo = await FileSystem.getInfoAsync(realmPath);
          if (realmInfo.exists && realmInfo.isDirectory) {
            const files = await FileSystem.readDirectoryAsync(realmPath);
            const count = files.length;
            const size = await sizeOf(realmPath);
            if (size > 0) entries.push({ scope: `Realms/${realm}`, size, count });
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return entries;
}

export async function clearCacheScope(scope: string): Promise<void> {
  const dir = CACHE_DIR + scope + '/';
  // Remove in-flight entries for this scope
  for (const key of inFlight.keys()) {
    if (key.startsWith(`${scope}::`)) inFlight.delete(key);
  }
  forgetResolved((localPath) => localPath.startsWith(dir));
  await FileSystem.deleteAsync(dir, { idempotent: true });
}

export async function clearImageCache(): Promise<void> {
  inFlight.clear();
  resolvedPaths.clear();
  await FileSystem.deleteAsync(CACHE_DIR, { idempotent: true });
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
