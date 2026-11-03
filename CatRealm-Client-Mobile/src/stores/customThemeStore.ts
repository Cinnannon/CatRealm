import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { palette, type Palette } from '@/theme/palette';

export type CustomTheme = {
  id: string;
  themeName: string;
  author: string;
  version: string;
  source: string;
  colors: Record<string, string>;
};

export const REQUIRED_THEME_COLORS = [
  'bg-deepest',
  'bg-sidebar',
  'bg-chat',
  'bg-hover',
  'bg-input',
  'bg-elevated',
  'text-primary',
  'text-secondary',
  'text-muted',
  'accent',
  'accent-hover',
  'border',
] as const;

export const CUSTOM_THEME_TEMPLATE = {
  themeName: 'DarkCat',
  author: 'CatRealm',
  version: '1.0',
  source: 'https://github.com/CatRealm/themes',
  colors: {
    'bg-deepest': '#1e1133',
    'bg-sidebar': '#302154',
    'bg-chat': '#3a2864',
    'bg-hover': '#44306e',
    'bg-input': '#1e1133',
    'bg-elevated': '#271748',
    'text-primary': '#f2f3f5',
    'text-secondary': '#c8b5e0',
    'text-muted': '#7a6890',
    'accent': '#9b77ff',
    'accent-hover': '#8866ee',
    'border': '#4a3578',
  },
};

const STORAGE_KEY = 'catrealm.custom-themes';

function toThemeId(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '').trim();
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (/^[0-9a-fA-F]{6,8}$/.test(clean)) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return 'rgba(124, 92, 255, 0.16)';
}

export function customThemeToPalette(colors: Record<string, string>): Palette {
  const accent = colors['accent'] || palette.accent;
  return {
    ...palette,
    bgDeepest: colors['bg-deepest'] || palette.bgDeepest,
    bgSidebar: colors['bg-sidebar'] || palette.bgSidebar,
    bgApp: colors['bg-chat'] || palette.bgApp,
    bgElev1: colors['bg-elevated'] || palette.bgElev1,
    bgElev2: colors['bg-hover'] || palette.bgElev2,
    bgElev3: colors['border'] || palette.bgElev3,
    text: colors['text-primary'] || palette.text,
    text2: colors['text-secondary'] || palette.text2,
    text3: colors['text-muted'] || palette.text3,
    accent,
    accentRim: colors['accent-hover'] || accent,
    accentSoft: hexToRgba(accent, 0.16),
    accentText: colors['text-secondary'] || palette.accentText,
    line: colors['border'] || palette.line,
    lineSoft: colors['bg-hover'] || palette.lineSoft,
  };
}

export function validateAndParseCustomTheme(
  rawJson: string,
): { ok: true; theme: Omit<CustomTheme, 'id'> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    if (!parsed.themeName || typeof parsed.themeName !== 'string' || !parsed.themeName.trim()) {
      return { ok: false, error: 'Invalid theme: "themeName" must be a non-empty string.' };
    }
    if (!parsed.colors || typeof parsed.colors !== 'object') {
      return { ok: false, error: 'Invalid theme: missing "colors" object.' };
    }
    const colorsObj = parsed.colors as Record<string, unknown>;
    const hexRe = /^#[0-9a-fA-F]{3,8}$/;
    const validatedColors: Record<string, string> = {};
    for (const key of REQUIRED_THEME_COLORS) {
      const val = colorsObj[key];
      if (typeof val !== 'string') {
        return { ok: false, error: `Invalid theme: missing required color key "${key}".` };
      }
      if (!hexRe.test(val)) {
        return { ok: false, error: `Invalid theme: color "${key}" must be a hex value (e.g. #ff0000).` };
      }
      validatedColors[key] = val;
    }
    return {
      ok: true,
      theme: {
        themeName: parsed.themeName.trim(),
        author: typeof parsed.author === 'string' ? parsed.author : '',
        version: typeof parsed.version === 'string' ? parsed.version : '1.0',
        source: typeof parsed.source === 'string' ? parsed.source : '',
        colors: validatedColors,
      },
    };
  } catch {
    return { ok: false, error: 'Failed to parse JSON. Please check the file format.' };
  }
}

function loadInitialThemesSync(): CustomTheme[] {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed as CustomTheme[];
      }
    }
  } catch {
    // ignore
  }
  return [];
}

async function persistThemes(themes: CustomTheme[]) {
  const serialized = JSON.stringify(themes);
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, serialized);
    }
  } catch {
    // ignore
  }
  try {
    await AsyncStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    // ignore
  }
}

interface CustomThemeState {
  themes: CustomTheme[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addTheme: (theme: Omit<CustomTheme, 'id'> & { id?: string }) => string;
  removeTheme: (id: string) => void;
}

export const useCustomThemeStore = create<CustomThemeState>((set, get) => ({
  themes: loadInitialThemesSync(),
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          set({ themes: parsed as CustomTheme[], hydrated: true });
          return;
        }
      }
    } catch {
      // ignore
    }
    set({ hydrated: true });
  },

  addTheme: (theme) => {
    const { themes } = get();
    const baseId = toThemeId(theme.themeName) || 'custom-theme';
    let id = theme.id || baseId;
    let counter = 2;
    while (themes.some((t) => t.id === id)) {
      id = `${baseId}-${counter}`;
      counter++;
    }
    const newTheme: CustomTheme = { ...theme, id };
    const next = [...themes, newTheme];
    set({ themes: next });
    void persistThemes(next);
    return id;
  },

  removeTheme: (id) => {
    const next = get().themes.filter((t) => t.id !== id);
    set({ themes: next });
    void persistThemes(next);
  },
}));
