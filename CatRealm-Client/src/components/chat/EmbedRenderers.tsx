import React from 'react';
import {
  toYouTubeEmbed,
  toVimeoEmbed,
  toTwitchChannelEmbed,
  toInstagramEmbed,
  toIwaraEmbed,
  toIwaraDirectMediaUrl,
  type LinkPreview,
  type InviteLinkData,
} from '../../messaging/chatlib/messageTokenParser';
import { AudioPlayer } from './AudioPlayer';
import { isKlipyMediaUrl, KlipyFavoriteButton } from './KlipyFavoriteButton';
import { EmbedImage, PreviewVideo } from './EmbedMedia';

export type OpenPreviewMediaFn = (preview: LinkPreview, images: string[], index: number) => void;
export type OpenExternalLinkFn = (url: string, event: React.MouseEvent<HTMLAnchorElement>) => void;
export type OpenImmediateMediaFn = (url: string) => void;

function IwaraEmbed({ url, onOpenExternalLink }: { url: string; onOpenExternalLink?: OpenExternalLinkFn }) {
  const iwara = React.useMemo(() => toIwaraEmbed(url), [url]);
  const [resolvedSources, setResolvedSources] = React.useState<string[] | null>(null);
  const [resolveFinished, setResolveFinished] = React.useState(false);
  const [sourceIndex, setSourceIndex] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;

    async function resolveDesktopSources() {
      if (!iwara) {
        setResolvedSources(null);
        setResolveFinished(true);
        return;
      }
      if (typeof window === 'undefined' || window.location.protocol !== 'file:') {
        setResolvedSources(null);
        setResolveFinished(true);
        return;
      }

      if (!cancelled) {
        setResolveFinished(false);
        setResolvedSources(null);
        setSourceIndex(0);
      }

      try {
        const videoMatch = url.match(/\/video\/([A-Za-z0-9-]+)/);
        const videoId = videoMatch?.[1];
        if (!videoId) {
          setResolvedSources(null);
          setResolveFinished(true);
          return;
        }

        const metaResp = await fetch(`https://api.iwara.tv/video/${encodeURIComponent(videoId)}`, {
          headers: { Accept: 'application/json' },
        });
        if (!metaResp.ok) throw new Error(`Iwara meta fetch failed: ${metaResp.status}`);
        const meta = await metaResp.json() as { fileUrl?: string | null };
        if (!meta?.fileUrl) {
          setResolvedSources(null);
          setResolveFinished(true);
          return;
        }

        const fileResp = await fetch(meta.fileUrl, {
          headers: { Accept: 'application/json, text/plain, */*' },
        });
        if (!fileResp.ok) throw new Error(`Iwara file fetch failed: ${fileResp.status}`);
        const entries = await fileResp.json() as Array<{ name?: string; src?: { view?: string } }>;
        if (!Array.isArray(entries)) {
          setResolvedSources(null);
          setResolveFinished(true);
          return;
        }

        const qualityRank = new Map([
          ['source', 0],
          ['1080', 1],
          ['720', 2],
          ['540', 3],
          ['480', 4],
          ['360', 5],
          ['240', 6],
          ['preview', 7],
        ]);

        const normalized = entries
          .map((entry) => {
            const name = String(entry?.name || '').toLowerCase();
            const rawView = entry?.src?.view || null;
            if (!rawView) return null;
            const absoluteView = rawView.startsWith('//') ? `https:${rawView}` : rawView;
            return {
              name,
              rank: qualityRank.get(name) ?? 100,
              url: absoluteView,
            };
          })
          .filter((entry): entry is { name: string; rank: number; url: string } => Boolean(entry?.url))
          .sort((a, b) => a.rank - b.rank);

        const uniqueSources = Array.from(new Set(normalized.map((entry) => entry.url)));
        if (!cancelled) {
          setResolvedSources(uniqueSources.length > 0 ? uniqueSources : null);
          setSourceIndex(0);
          setResolveFinished(true);
        }
      } catch {
        if (!cancelled) {
          setResolvedSources(null);
          setSourceIndex(0);
          setResolveFinished(true);
        }
      }
    }

    void resolveDesktopSources();
    return () => {
      cancelled = true;
    };
  }, [iwara, url]);

  if (!iwara) return null;

  if (typeof window !== 'undefined' && window.location.protocol === 'file:' && !resolveFinished) {
    return (
      <div className="mt-2 max-w-md rounded border border-border bg-bg-elevated p-3">
        <div className="text-[11px] uppercase tracking-wide text-text-muted mb-1">Iwara</div>
        <div className="text-sm text-text-secondary">Resolving media...</div>
      </div>
    );
  }

  const sourcePool = resolvedSources && resolvedSources.length > 0 ? resolvedSources : [];
  const activeSource = sourcePool[sourceIndex] ?? null;
  if (!activeSource) {
    const label = (() => {
      try {
        const parsed = new URL(iwara.originalUrl);
        const parts = parsed.pathname.split('/').filter(Boolean);
        return parts[2] || parts[1] || parsed.hostname;
      } catch {
        return 'Iwara video';
      }
    })();
    return (
      <div className="mt-2 max-w-md rounded border border-border bg-bg-elevated p-3">
        <div className="text-[11px] uppercase tracking-wide text-text-muted mb-1">Iwara</div>
        <div className="text-sm text-text-secondary mb-3">
          Embed failed due to CORS/browser restrictions, but this URL points to `{label}`. Use the desktop app to view it here, or open it on Iwara.
        </div>
        <a
          href={iwara.originalUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-semibold text-accent hover:underline"
          onClick={(e) => onOpenExternalLink?.(iwara.originalUrl, e)}
        >
          Open on Iwara
        </a>
      </div>
    );
  }

  return (
    <div className="mt-2 max-w-md rounded border border-border overflow-hidden bg-black">
      <video
        key={activeSource}
        src={activeSource}
        controls
        preload="metadata"
        playsInline
        className="block w-full max-h-[70vh] bg-black"
        onError={() => setSourceIndex((current) => current + 1)}
      />
    </div>
  );
}

export function buildImmediateEmbed(
  url: string,
  onOpenExternalLink?: OpenExternalLinkFn,
  onOpenMedia?: OpenImmediateMediaFn
): React.ReactElement | null {
  const lower = url.toLowerCase();

  if (/\.(png|jpe?g|gif|webp|apng)(\?.*)?$/.test(lower)) {
    const klipyMedia = isKlipyMediaUrl(url);
    const image = (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className={klipyMedia ? 'block max-w-full cursor-zoom-in' : 'inline-block mt-2 align-top max-w-lg cursor-zoom-in'}
        onClick={(e) => {
          if (onOpenMedia) {
            e.preventDefault();
            e.stopPropagation();
            onOpenMedia(url);
            return;
          }
          onOpenExternalLink?.(url, e);
        }}
      >
        <EmbedImage src={url} alt="Embed preview" className={`block rounded border border-border h-auto max-w-full ${klipyMedia ? 'max-h-[300px]' : 'max-h-[42vh]'}`} />
      </a>
    );
    if (!klipyMedia) return image;
    // Hover star sits beside the link, not inside it, so starring never opens the viewer.
    return (
      <span className="group relative inline-block mt-2 align-top max-w-[360px]">
        {image}
        <KlipyFavoriteButton
          url={url}
          className="absolute right-1.5 top-1.5 rounded bg-black/75 p-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 aria-pressed:opacity-100"
        />
      </span>
    );
  }

  if (/\.(mp4|webm|ogg)(\?.*)?$/.test(lower)) {
    return (
      <video src={url} controls className="mt-2 max-w-md rounded border border-border bg-black" />
    );
  }

  const iwaraDirectMedia = toIwaraDirectMediaUrl(url);
  if (iwaraDirectMedia) {
    return (
      <video src={iwaraDirectMedia} controls preload="metadata" playsInline className="mt-2 max-w-md rounded border border-border bg-black" />
    );
  }

  if (/\.(mp3|wav|ogg|m4a|aac|flac)(\?.*)?$/.test(lower)) {
    return <AudioPlayer src={url} className="mt-2" />;
  }

  if (/\.(pdf)(\?.*)?$/.test(lower)) {
    return (
      <div className="mt-2 max-w-md rounded border border-border overflow-hidden bg-bg-elevated">
        <iframe src={url} title="PDF preview" sandbox="" referrerPolicy="no-referrer" className="w-full h-64" />
        <a href={url} target="_blank" rel="noreferrer" className="block p-2 text-sm text-accent hover:underline" onClick={(event) => onOpenExternalLink?.(url, event)}>
          Open PDF
        </a>
      </div>
    );
  }

  const youtube = toYouTubeEmbed(url);
  if (youtube) {
    const isShorts = /\/shorts\//i.test(url);
    return isShorts ? (
      // Shorts: 9:16 portrait — narrow container with aspect-ratio box
      <div className="mt-2 inline-block rounded border border-border overflow-hidden bg-black" style={{ width: 220 }}>
        <div style={{ position: 'relative', paddingBottom: '177.78%' }}>
          <iframe
            src={youtube}
            title="YouTube Shorts embed"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
      </div>
    ) : (
      <div className="mt-2 max-w-md rounded border border-border overflow-hidden bg-black">
        <iframe
          src={youtube}
          title="YouTube embed"
          className="w-full h-56"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>
    );
  }

  const vimeo = toVimeoEmbed(url);
  if (vimeo) {
    return (
      <div className="mt-2 max-w-md rounded border border-border overflow-hidden bg-black">
        <iframe
          src={vimeo}
          title="Vimeo embed"
          className="w-full h-56"
          allow="autoplay; picture-in-picture"
          allowFullScreen
        />
      </div>
    );
  }

  const twitch = toTwitchChannelEmbed(url);
  if (twitch) {
    return (
      <div className="mt-2 max-w-md rounded border border-border overflow-hidden bg-black">
        <iframe
          src={twitch}
          title="Twitch embed"
          className="w-full h-56"
          allow="autoplay"
          allowFullScreen
        />
      </div>
    );
  }

  const instagram = toInstagramEmbed(url);
  if (instagram) {
    return (
      <div className="mt-2 max-w-md rounded border border-border overflow-hidden bg-bg-elevated">
        <iframe
          src={instagram}
          title="Instagram embed"
          className="w-full h-[740px]"
          loading="lazy"
          allow="encrypted-media; clipboard-write"
        />
      </div>
    );
  }

  const iwara = toIwaraEmbed(url);
  if (iwara) {
    return <IwaraEmbed key={url} url={url} onOpenExternalLink={onOpenExternalLink} />;
  }

  return null;
}

export function buildPreviewCard(
  url: string,
  preview: LinkPreview | null,
  onOpenPreviewMedia?: OpenPreviewMediaFn,
  onOpenExternalLink?: OpenExternalLinkFn
): React.ReactElement | null {
  if (!preview) {
    return null;
  }

  if (preview.type === 'kick') {
    return (
      <div className="mt-2 max-w-lg rounded border border-border bg-bg-elevated p-3">
        <div className="text-[11px] uppercase tracking-wide text-text-muted mb-2">{preview.siteName || 'Kick.com - VOD'}</div>
        <a
          href={preview.url || url}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-semibold text-accent hover:underline block"
          onClick={(e) => onOpenExternalLink?.(preview.url || url, e)}
        >
          {preview.title || `${preview.authorName || 'Streamer'} - Watch on Kick`}
        </a>
        <div className="mt-3 flex items-start gap-3">
          {preview.authorAvatar && (
            <img
              src={preview.authorAvatar}
              alt={preview.authorName || 'Kick avatar'}
              className="w-16 h-16 rounded-full object-cover border border-border shrink-0"
            />
          )}
          {preview.description && (
            <div className="text-xs text-text-secondary leading-relaxed">
              {preview.description}
            </div>
          )}
        </div>
      </div>
    );
  }

  const metaBlock = (preview.siteName || preview.title || preview.description) ? (
    <div className="p-3">
      <div className="text-[11px] uppercase tracking-wide text-text-muted mb-1">{preview.siteName || 'Website'}</div>
      {preview.title && <div className="text-sm font-semibold text-text-primary line-clamp-2">{preview.title}</div>}
      {preview.description && <div className="text-xs text-text-secondary mt-1 line-clamp-3">{preview.description}</div>}
    </div>
  ) : null;
  const previewImages = Array.isArray(preview.images) && preview.images.length > 0
    ? preview.images
    : (preview.image ? [preview.image] : []);

  if (preview.type === 'media') {
    if (preview.mime?.startsWith('image/')) {
      return (
        <div className="mt-2 inline-block max-w-lg align-top rounded border border-border bg-bg-elevated hover:bg-bg-hover/60 transition-colors overflow-hidden">
          <button
            type="button"
            onClick={() => onOpenPreviewMedia?.(preview, [preview.url], 0)}
            className="block w-full text-left"
          >
            <EmbedImage src={preview.url} alt={preview.title || 'Embed preview'} className="block rounded-t h-auto max-w-full max-h-[42vh] cursor-zoom-in" />
          </button>
          {metaBlock && (
            <a href={preview.url} target="_blank" rel="noreferrer" className="block" onClick={(e) => onOpenExternalLink?.(preview.url, e)}>
              {metaBlock}
            </a>
          )}
        </div>
      );
    }
    if (preview.mime?.startsWith('video/')) {
      return (
        <div className="mt-2 inline-block max-w-lg align-top rounded border border-border bg-bg-elevated">
          <PreviewVideo src={preview.url} animated={!!preview.animated} />
          {metaBlock}
        </div>
      );
    }
    if (preview.mime?.startsWith('audio/')) {
      return (
        <div className="mt-2 inline-block max-w-lg align-top rounded border border-border bg-bg-elevated">
          <AudioPlayer src={preview.url} className="w-full p-2" />
          {metaBlock}
        </div>
      );
    }
  }

  if (previewImages.length > 1) {
    return (
      <div className="mt-2 inline-block max-w-lg align-top rounded border border-border bg-bg-elevated overflow-hidden">
        <div className="grid grid-cols-2 gap-px bg-border">
          {previewImages.slice(0, 4).map((img, index) => (
            <button
              key={`${img}-${index}`}
              type="button"
              onClick={() => onOpenPreviewMedia?.(preview, previewImages.slice(0, 4), index)}
              className="block bg-bg-elevated"
            >
              <EmbedImage src={img} alt={preview.title || `Link preview ${index + 1}`} className="block w-full h-36 object-cover" />
            </button>
          ))}
        </div>
        <a
          href={preview.url || url}
          target="_blank"
          rel="noreferrer"
          className="block hover:bg-bg-hover/60 transition-colors"
          onClick={(e) => onOpenExternalLink?.(preview.url || url, e)}
        >
          {metaBlock}
        </a>
      </div>
    );
  }

  return (
    <div className="mt-2 inline-block max-w-lg align-top rounded border border-border bg-bg-elevated hover:bg-bg-hover/60 transition-colors overflow-hidden">
      {previewImages[0] && (
        <button
          type="button"
          onClick={() => onOpenPreviewMedia?.(preview, [previewImages[0]], 0)}
          className="block w-full text-left"
        >
          <EmbedImage src={previewImages[0]} alt={preview.title || 'Link preview'} className="block h-auto max-w-full max-h-[42vh] rounded-t cursor-zoom-in" />
        </button>
      )}
      {metaBlock && (
        <a
          href={preview.url || url}
          target="_blank"
          rel="noreferrer"
          className="block"
          onClick={(e) => onOpenExternalLink?.(preview.url || url, e)}
        >
          {metaBlock}
        </a>
      )}
    </div>
  );
}

export function buildInviteCard(invite: InviteLinkData, onOpen: (invite: InviteLinkData) => void): React.ReactElement {
  return (
    <button
      type="button"
      onClick={() => onOpen(invite)}
      className="mt-2 w-full max-w-lg text-left rounded border border-border bg-bg-elevated p-3 hover:bg-bg-hover/60 transition-colors"
    >
      <div className="text-[11px] uppercase tracking-wide text-text-muted mb-1">CatRealm Invite</div>
      <div className="text-sm font-semibold text-text-primary line-clamp-1">Join server invite</div>
      <div className="text-xs text-text-secondary mt-1 break-all">{invite.canonicalUrl}</div>
      <div className="text-xs text-accent mt-2">Open invite</div>
    </button>
  );
}

export function buildTwitchDesktopFallbackCard(
  url: string,
  channel: string,
  preview: LinkPreview | null,
  onOpenExternalLink?: OpenExternalLinkFn
): React.ReactElement {
  const profileName = (preview?.authorName || channel).trim();
  const avatarUrl = (preview?.authorAvatar || preview?.image || '').trim() || null;
  const title = (preview?.title || `twitch.tv/${channel}`).trim();
  const description = (preview?.description || 'Live Twitch embeds are blocked in the desktop app by Twitch CSP. Open in browser.').trim();
  const initial = profileName.slice(0, 1).toUpperCase() || 'T';

  return (
    <div className="mt-2 max-w-lg rounded border border-border bg-bg-elevated p-3">
      <div className="text-[11px] uppercase tracking-wide text-text-muted mb-2">Twitch</div>
      <div className="flex items-center gap-3">
        {avatarUrl ? (
          <img src={avatarUrl} alt={profileName} className="w-11 h-11 rounded-full object-cover border border-border shrink-0" />
        ) : (
          <div className="w-11 h-11 rounded-full border border-border bg-bg-input text-text-primary font-semibold flex items-center justify-center shrink-0">
            {initial}
          </div>
        )}
        <div className="min-w-0">
          <div className="text-sm font-semibold text-text-primary truncate">{profileName}</div>
          <div className="text-xs text-text-muted truncate">{title}</div>
        </div>
      </div>
      <div className="mt-2 text-sm text-text-secondary">
        {description}
      </div>
      <a href={url} target="_blank" rel="noreferrer" className="inline-block mt-2 text-sm text-accent hover:underline" onClick={(e) => onOpenExternalLink?.(url, e)}>
        Open Twitch stream
      </a>
    </div>
  );
}
