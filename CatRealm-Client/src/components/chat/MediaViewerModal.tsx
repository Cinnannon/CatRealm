import { useEffect, useRef, useState } from 'react';
import {
  ZoomIn,
  ZoomOut,
  Download,
  ExternalLink,
  Share2,
  MoreHorizontal,
  X,
  ChevronLeft,
  ChevronRight,
  Copy,
  Check,
} from 'lucide-react';
import { useUIStore } from '../../stores/uiStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { writeClipboardItems, writeClipboardText } from '../../lib/clipboard';
import { formatMessageTime } from '../../utils/formatTime';
import { AvatarImage } from '../ui/AvatarImage';
import { MediaForwardDialog } from './MediaForwardDialog';
import { isKlipyMediaUrl, KlipyFavoriteButton } from './KlipyFavoriteButton';

type MediaViewerItem = {
  id?: string;
  url: string;
  type?: string | null;
  name?: string | null;
  author?: string | null;
  avatarUrl?: string | null;
  createdAt?: string | number | null;
  size?: number | null;
};

type MediaViewerData = {
  url: string;
  type?: string | null;
  name?: string | null;
  author?: string | null;
  avatarUrl?: string | null;
  createdAt?: string | number | null;
  size?: number | null;
  items?: MediaViewerItem[];
  index?: number;
};

const KLIPY_LOGO_URL = `${import.meta.env.BASE_URL}klipy/KLIPY%20Light%20with%20logo.svg`;

function formatFileSize(bytes?: number | null): string {
  if (!bytes || bytes < 0) return 'Unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MediaViewerModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData) as MediaViewerData | null;
  const closeModal = useUIStore((s) => s.closeModal);
  const timeFormat = useSettingsStore((s) => s.timeFormat);

  const [zoom, setZoom] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const offset = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [currentIndex, setCurrentIndex] = useState(0);
  const [forwardOpen, setForwardOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'copied' | 'failed' | null>(null);

  useEffect(() => {
    if (activeModal !== 'mediaViewer') return;
    setZoom(1);
    setPosition({ x: 0, y: 0 });
    offset.current = { x: 0, y: 0 };
    setCurrentIndex(modalData?.index ?? 0);
    setForwardOpen(false);
    setDropdownOpen(false);
    setShowDetails(false);
    setCopyStatus(null);
  }, [activeModal, modalData]);

  const items = modalData?.items && modalData.items.length > 0 ? modalData.items : null;
  const effectiveIndex = items ? Math.min(Math.max(currentIndex, 0), items.length - 1) : 0;
  const current: MediaViewerItem | MediaViewerData | null | undefined = items
    ? items[effectiveIndex]
    : modalData;
  const canNavigate = !!items && items.length > 1;

  const resetZoom = () => {
    setZoom(1);
    setPosition({ x: 0, y: 0 });
    offset.current = { x: 0, y: 0 };
  };

  const goPrev = () => {
    if (!items) return;
    setCurrentIndex((i) => (i - 1 + items.length) % items.length);
    resetZoom();
  };

  const goNext = () => {
    if (!items) return;
    setCurrentIndex((i) => (i + 1) % items.length);
    resetZoom();
  };

  useEffect(() => {
    if (activeModal !== 'mediaViewer') return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (forwardOpen) { setForwardOpen(false); return; }
        if (dropdownOpen) { setDropdownOpen(false); return; }
        closeModal();
        return;
      }
      if (!canNavigate) return;
      if (e.key === 'ArrowLeft') goPrev();
      if (e.key === 'ArrowRight') goNext();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeModal, closeModal, canNavigate, items?.length, forwardOpen, dropdownOpen]);

  if (activeModal !== 'mediaViewer' || !modalData || !current) return null;

  const createdLabel = current.createdAt
    ? formatMessageTime(Number(current.createdAt), timeFormat)
    : '';
  const isVideo =
    current.type?.startsWith('video/') ||
    /\.(mp4|webm)(\?.*)?$/i.test(current.url);
  const isKlipyMedia = isKlipyMediaUrl(current.url);
  const canDrag = !isVideo && zoom > 1;
  const downloadName = current.name ?? 'media';

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!canDrag) return;
    e.stopPropagation();
    setIsDragging(true);
    dragStart.current = { x: e.clientX - offset.current.x, y: e.clientY - offset.current.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !dragStart.current) return;
    const x = e.clientX - dragStart.current.x;
    const y = e.clientY - dragStart.current.y;
    offset.current = { x, y };
    setPosition({ x, y });
  };

  const handleMouseUp = () => {
    if (!isDragging) return;
    setIsDragging(false);
    dragStart.current = null;
  };

  const zoomIn = () => setZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))));
  const zoomOut = () => {
    setZoom((z) => {
      const next = Math.max(1, Number((z - 0.25).toFixed(2)));
      if (next <= 1) {
        setPosition({ x: 0, y: 0 });
        offset.current = { x: 0, y: 0 };
      }
      return next;
    });
  };

  const handleDownload = async () => {
    try {
      const response = await fetch(current.url);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = downloadName;
      a.click();
      URL.revokeObjectURL(objectUrl);
    } catch {
      // Fallback: open in new tab so the user can save manually
      window.open(current.url, '_blank');
    }
  };

  const copyLink = async () => {
    setCopyStatus(await writeClipboardText(current.url) ? 'copied' : 'failed');
    setTimeout(() => setCopyStatus(null), 2000);
  };

  const copyImage = async () => {
    try {
      const response = await fetch(current.url);
      const blob = await response.blob();
      const copied = await writeClipboardItems([new ClipboardItem({ 'image/png': blob })]);
      setCopyStatus(copied ? 'copied' : 'failed');
    } catch {
      setCopyStatus('failed');
    }
    setTimeout(() => setCopyStatus(null), 2000);
  };

  const avatarSrc = (current as MediaViewerItem).avatarUrl ?? null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90 modal-backdrop-in">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 border-b border-white/10 shrink-0 h-[52px]">
        {/* Left: avatar + author + timestamp */}
        <div className="flex items-center gap-3 min-w-0">
          <AvatarImage
            src={avatarSrc}
            alt={current.author ?? 'User'}
            size={32}
            className="w-8 h-8 rounded-full shrink-0"
            fallback={
              <span className="w-8 h-8 rounded-full bg-bg-muted flex items-center justify-center text-sm text-text-secondary font-semibold">
                {(current.author ?? '?').charAt(0).toUpperCase()}
              </span>
            }
          />
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-semibold text-sm text-white truncate">
              {current.author ?? 'Unknown'}
            </span>
            {createdLabel && (
              <span className="text-white/50 text-sm shrink-0">• {createdLabel}</span>
            )}
          </div>
        </div>

        {/* Right: toolbar */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={zoomOut}
            className="w-8 h-8 flex items-center justify-center rounded hover:bg-white/10 text-white/70 hover:text-white transition-colors"
            title="Zoom out"
          >
            <ZoomOut size={16} />
          </button>
          <span className="text-xs text-white/60 px-1 min-w-[38px] text-center">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={zoomIn}
            className="w-8 h-8 flex items-center justify-center rounded hover:bg-white/10 text-white/70 hover:text-white transition-colors"
            title="Zoom in"
          >
            <ZoomIn size={16} />
          </button>

          <div className="w-px h-4 bg-white/20 mx-1" />

          {isKlipyMedia && (
            <KlipyFavoriteButton
              url={current.url}
              size={16}
              className="w-8 h-8 flex items-center justify-center rounded hover:bg-white/10 transition-colors"
            />
          )}

          <button
            onClick={() => setForwardOpen(true)}
            className="w-8 h-8 flex items-center justify-center rounded hover:bg-white/10 text-white/70 hover:text-white transition-colors"
            title="Forward"
          >
            <Share2 size={16} />
          </button>

          <button
            onClick={() => { void handleDownload(); }}
            className="w-8 h-8 flex items-center justify-center rounded hover:bg-white/10 text-white/70 hover:text-white transition-colors"
            title="Download"
          >
            <Download size={16} />
          </button>

          <button
            onClick={() => window.open(current.url, '_blank')}
            className="w-8 h-8 flex items-center justify-center rounded hover:bg-white/10 text-white/70 hover:text-white transition-colors"
            title="Open in browser"
          >
            <ExternalLink size={16} />
          </button>

          {/* ... dropdown */}
          <div className="relative">
            <button
              onClick={() => { setDropdownOpen((o) => !o); setShowDetails(false); }}
              className="w-8 h-8 flex items-center justify-center rounded hover:bg-white/10 text-white/70 hover:text-white transition-colors"
              title="More options"
            >
              <MoreHorizontal size={16} />
            </button>
            {dropdownOpen && (
              <>
                <div
                  className="fixed inset-0 z-[51]"
                  onClick={() => setDropdownOpen(false)}
                />
                <div className="absolute right-0 top-full mt-1 z-[52] bg-bg-elevated border border-border rounded-lg shadow-xl min-w-[168px] py-1 overflow-hidden">
                  {!isVideo && (
                    <button
                      onClick={() => { void copyImage(); }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-text-primary hover:bg-bg-hover transition-colors text-left"
                    >
                      {copyStatus === 'copied' ? (
                        <Check size={14} className="text-accent shrink-0" />
                      ) : (
                        <Copy size={14} className="shrink-0" />
                      )}
                      Copy Image
                    </button>
                  )}
                  <button
                    onClick={copyLink}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-text-primary hover:bg-bg-hover transition-colors text-left"
                  >
                    <Copy size={14} className="shrink-0" />
                    Copy Link
                  </button>
                  <button
                    onClick={() => setShowDetails((v) => !v)}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-text-primary hover:bg-bg-hover transition-colors text-left"
                  >
                    <MoreHorizontal size={14} className="shrink-0" />
                    View Details
                  </button>
                  {showDetails && (
                    <div className="border-t border-border px-3 py-2 text-xs text-text-muted space-y-1">
                      <div>
                        <span className="text-text-secondary">Name: </span>
                        {current.name ?? 'Unknown'}
                      </div>
                      <div>
                        <span className="text-text-secondary">Size: </span>
                        {formatFileSize((current as MediaViewerItem).size)}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="w-px h-4 bg-white/20 mx-1" />

          <button
            onClick={closeModal}
            className="w-8 h-8 flex items-center justify-center rounded hover:bg-white/10 text-white/70 hover:text-white transition-colors"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Middle area */}
      <div
        className="flex-1 relative flex items-center justify-center overflow-hidden"
        onClick={(e) => {
          if (e.target === e.currentTarget) closeModal();
        }}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {isKlipyMedia && (
          <div className="pointer-events-none absolute right-6 top-5 z-10 flex flex-col items-end gap-1" aria-label="Powered by Klipy">
            <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-white/45">Powered by</span>
            <img src={KLIPY_LOGO_URL} alt="Klipy" className="h-auto w-36 opacity-75" />
          </div>
        )}

        {canNavigate && (
          <button
            onClick={goPrev}
            className="absolute left-4 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-black/50 border border-white/20 text-white hover:bg-black/80 flex items-center justify-center transition-colors"
            title="Previous"
          >
            <ChevronLeft size={20} />
          </button>
        )}

        {isVideo ? (
          <video
            src={current.url}
            controls
            autoPlay
            className="max-w-[calc(100vw-96px)] max-h-full rounded-lg border border-white/10 bg-black"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <img
            src={current.url}
            alt={current.name ?? 'media'}
            className={`max-w-[calc(100vw-96px)] max-h-full rounded-lg border border-white/10 object-contain bg-black select-none ${canDrag ? 'cursor-grab' : 'cursor-zoom-in'} ${isDragging ? 'cursor-grabbing' : ''}`}
            style={{
              transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})`,
            }}
            onMouseDown={handleMouseDown}
            draggable={false}
            onClick={(e) => e.stopPropagation()}
          />
        )}

        {canNavigate && (
          <button
            onClick={goNext}
            className="absolute right-4 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-black/50 border border-white/20 text-white hover:bg-black/80 flex items-center justify-center transition-colors"
            title="Next"
          >
            <ChevronRight size={20} />
          </button>
        )}
      </div>

      {/* Gallery strip */}
      {canNavigate && items && (
        <div className="flex items-center justify-center gap-2 py-2 px-4 overflow-x-auto bg-black/60 border-t border-white/10 shrink-0">
          {items.map((item, i) => (
            <button
              key={i}
              onClick={() => { setCurrentIndex(i); resetZoom(); }}
              className={`flex-shrink-0 w-14 h-14 rounded overflow-hidden border-2 transition-all ${
                i === effectiveIndex
                  ? 'border-accent'
                  : 'border-transparent opacity-60 hover:opacity-100'
              }`}
            >
              {item.type?.startsWith('video/') || /\.(mp4|webm)(\?.*)?$/i.test(item.url) ? (
                <video
                  src={item.url}
                  className="w-full h-full object-cover"
                  muted
                />
              ) : (
                <img src={item.url} className="w-full h-full object-cover" alt="" />
              )}
            </button>
          ))}
        </div>
      )}

      {forwardOpen && (
        <MediaForwardDialog url={current.url} createdAt={current.createdAt} onClose={() => setForwardOpen(false)} />
      )}
    </div>
  );
}
