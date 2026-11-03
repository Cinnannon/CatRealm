/**
 * Default CatRealm theme mapped from the desktop/web CSS tokens in
 * `CatRealm-Client/src/index.css`. Keep this aligned with the product palette
 * first; only add mobile-specific tokens when native UI needs cannot be
 * represented by the desktop theme variables.
 *
 * Stay token-only here — components consume via `useTheme()`. Don't import
 * StyleSheet objects from this file.
 */

const basePalette = {
  // base surfaces
  bgDeepest: '#1E1F22',
  bgApp: '#313338',
  bgSidebar: '#2B2D31',
  bgElev1: '#232428',
  bgElev2: '#383A40',
  bgElev3: '#3F4147',

  // ink
  text: '#F2F3F5',
  text2: '#B5BAC1',
  text3: '#6D6F78',
  textOnAccent: '#FFFFFF',

  // lines
  line: '#3F4147',
  lineSoft: '#383A40',

  // brand
  accent: '#7C5CFF',
  accentRim: '#6A4DE0',
  accentSoft: 'rgba(124, 92, 255, 0.16)',
  accentText: '#C9BCFF',

  // semantic
  online: '#23A559',
  away: '#F0B232',
  sleeping: '#FFD166',
  invisible: '#6D6F78',
  danger: '#F23F42',
  warning: '#F0B232',
  info: '#8FD3FF',

  // overlays
  scrim: 'rgba(0,0,0,0.55)',
  scrimSoft: 'rgba(0,0,0,0.30)',
} as const;

export type Palette = Record<keyof typeof basePalette, string>;
export const palette: Palette = basePalette;

export const builtInPalettes = {
  'retro-discord': palette,
  'dark-cat': {
    ...palette,
    bgDeepest: '#1E1133',
    bgApp: '#3A2864',
    bgSidebar: '#302154',
    bgElev1: '#271748',
    bgElev2: '#44306E',
    bgElev3: '#4A3578',
    text: '#F2F3F5',
    text2: '#C8B5E0',
    text3: '#7A6890',
    line: '#4A3578',
    lineSoft: '#44306E',
    accent: '#9B77FF',
    accentRim: '#8866EE',
    accentSoft: 'rgba(155, 119, 255, 0.16)',
    accentText: '#D7CBFF',
  },
  'angel-cat': {
    ...palette,
    bgDeepest: '#F0E7FF',
    bgApp: '#ECE2F8',
    bgSidebar: '#E0BCF4',
    bgElev1: '#F8F3FF',
    bgElev2: '#F7F0FF',
    bgElev3: '#D5B2EC',
    text: '#1A0A2E',
    text2: '#4A3570',
    text3: '#8B6AAA',
    textOnAccent: '#FFFFFF',
    line: '#C9A5E8',
    lineSoft: '#D5B2EC',
    accent: '#6B44F0',
    accentRim: '#5A35D9',
    accentSoft: 'rgba(107, 68, 240, 0.16)',
    accentText: '#8E69FF',
    invisible: '#8B6AAA',
    scrim: 'rgba(26, 10, 46, 0.22)',
    scrimSoft: 'rgba(26, 10, 46, 0.12)',
  },
  'midnight-cat': {
    ...palette,
    bgDeepest: '#000000',
    bgApp: '#0F0F0F',
    bgSidebar: '#090909',
    bgElev1: '#0D0D0D',
    bgElev2: '#1A1A1A',
    bgElev3: '#1C1C1E',
    text: '#FFFFFF',
    text2: '#A0A3A8',
    text3: '#4A4D54',
    line: '#1C1C1E',
    lineSoft: '#1A1A1A',
  },
} satisfies Record<string, Palette>;
export type BuiltInThemeId = keyof typeof builtInPalettes;
export type PaletteKey = keyof Palette;

/** Status -> dot color (matches User['status'] from /types). */
export const statusColor = {
  online: palette.online,
  away: palette.away,
  sleeping: palette.sleeping,
  invisible: palette.invisible,
} as const;
