import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { GifPickerPanel } from './GifPickerPanel';

type PickerTab = 'emojis' | 'stickers';

const MOBILE_MAX_WIDTH = 767; // below Tailwind's `md`
const MOBILE_GUTTER_PX = 8;

const PANEL_GAP_PX = 8;

// The panel renders into document.body so no chat column, sliding sidebar
// transform or overflow-hidden wrapper can clip it. Composers' outside-click
// handlers use this to treat clicks inside the panel as inside the picker.
export function isInsideExpressionPicker(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('[data-expression-picker-panel]');
}

// Keeps a full-width panel on screen: anchored at the picker button's left
// edge, moved left only as far as needed.
export function clampPanelLeft(anchorLeft: number, panelWidth: number, viewportWidth: number): number {
  return Math.max(MOBILE_GUTTER_PX, Math.min(anchorLeft, viewportWidth - MOBILE_GUTTER_PX - panelWidth));
}

interface SharedExpressionPickerPanelProps {
  className?: string;
  floatingPosition?: { x: number; y: number } | null;
  pickerTab: PickerTab;
  onPickerTabChange: (tab: PickerTab) => void;
  searchValue: string;
  onSearchChange: (value: string) => void;
  onClose: () => void;
  headerPrefix?: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
  /**
   * GIF tab (Cat Lab). When enabled, a "GIFs" tab is shown; its state is kept
   * internal to this panel so consumers don't need to widen their PickerTab
   * type. Picking a GIF calls `onSelectGif` with its direct media URL.
   */
  gifPickerEnabled?: boolean;
  onSelectGif?: (gifUrl: string) => void;
}

export function SharedExpressionPickerPanel({
  className = '',
  floatingPosition = null,
  pickerTab,
  onPickerTabChange,
  searchValue,
  onSearchChange,
  onClose,
  headerPrefix,
  sidebar,
  children,
  gifPickerEnabled = false,
  onSelectGif,
}: SharedExpressionPickerPanelProps) {
  const { t } = useTranslation();
  const isFloating = !!floatingPosition;
  const gifTabAvailable = gifPickerEnabled && !!onSelectGif;
  // GIF tab is tracked here (not in the consumer's pickerTab) to keep the
  // integration surface tiny for each composer.
  const [gifActive, setGifActive] = useState(false);
  const gifOpen = gifTabAvailable && gifActive;

  const selectExpressionTab = (tab: PickerTab) => {
    setGifActive(false);
    onPickerTabChange(tab);
  };

  const containerClassName = `fixed z-50 rounded-lg border border-border bg-bg-elevated shadow-xl ${className}`.trim();
  // Anchored panels sit just above the picker button's wrapper (where the
  // zero-size anchor below is rendered), at their full width; on phones they
  // stretch across the viewport instead.
  const anchorRef = useRef<HTMLSpanElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [anchoredStyle, setAnchoredStyle] = useState<CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    if (isFloating) return;
    const place = () => {
      const wrapper = anchorRef.current?.offsetParent;
      const panel = containerRef.current;
      if (!wrapper || !panel) return;
      const rect = wrapper.getBoundingClientRect();
      const bottom = window.innerHeight - rect.top + PANEL_GAP_PX;
      if (window.innerWidth <= MOBILE_MAX_WIDTH) {
        setAnchoredStyle({ left: MOBILE_GUTTER_PX, bottom, width: window.innerWidth - MOBILE_GUTTER_PX * 2, maxWidth: 'none' });
        return;
      }
      setAnchoredStyle({ left: clampPanelLeft(rect.left, panel.offsetWidth, window.innerWidth), bottom });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [isFloating]);

  const containerStyle = isFloating
    ? { left: floatingPosition!.x, top: floatingPosition!.y }
    : anchoredStyle;

  const panel = (
    <div ref={containerRef} data-expression-picker-panel="" className={containerClassName} style={containerStyle}>
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 text-xs">
          {headerPrefix}
          <button
            type="button"
            onClick={() => selectExpressionTab('emojis')}
            className={`px-2 py-1 rounded ${!gifOpen && pickerTab === 'emojis' ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'}`}
          >
            {t('emotePicker.emojis')}
          </button>
          <button
            type="button"
            onClick={() => selectExpressionTab('stickers')}
            className={`px-2 py-1 rounded ${!gifOpen && pickerTab === 'stickers' ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'}`}
          >
            {t('emotePicker.stickers')}
          </button>
          {gifTabAvailable && (
            <button
              type="button"
              onClick={() => setGifActive(true)}
              className={`px-2 py-1 rounded ${gifOpen ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'}`}
            >
              {t('emotePicker.gifs')}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* The GIF tab has its own search box, so hide the shared one there. */}
          {!gifOpen && (
            <input
              type="text"
              value={searchValue}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={t('emotePicker.searchPlaceholder')}
              className="w-36 md:w-44 px-2 py-1 rounded bg-bg-input border border-border text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
            />
          )}
          <button
            type="button"
            onClick={onClose}
            className="text-text-muted hover:text-text-primary text-xs"
          >
            {t('common.close')}
          </button>
        </div>
      </div>

      <div className="flex h-72">
        {gifOpen ? (
          <div className="flex-1 p-3 overflow-hidden">
            <GifPickerPanel onSelect={onSelectGif!} />
          </div>
        ) : (
          <>
            <div className="w-32 border-r border-border p-2 overflow-y-auto space-y-1">
              {sidebar}
            </div>
            <div className="flex-1 p-3 overflow-y-auto">
              {children}
            </div>
          </>
        )}
      </div>
    </div>
  );

  return (
    <>
      {!isFloating && <span ref={anchorRef} aria-hidden="true" className="absolute left-0 top-0 h-0 w-0" />}
      {createPortal(panel, document.body)}
    </>
  );
}
