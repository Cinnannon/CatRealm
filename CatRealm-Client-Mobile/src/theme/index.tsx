import { createContext, useContext, type ReactNode, useEffect, useMemo } from 'react';
import { builtInPalettes, palette, statusColor, type BuiltInThemeId } from './palette';
import { spacing, radius, shadow, z, hit } from './spacing';
import { fontFamily, fontSize, fontWeight, lineHeight } from './typography';
import { useSettingsStore } from '@/stores/settingsStore';
import { customThemeToPalette, useCustomThemeStore } from '@/stores/customThemeStore';

export type Theme = {
  colors: typeof palette & { statusColor: typeof statusColor };
  spacing: typeof spacing;
  radius: typeof radius;
  shadow: typeof shadow;
  z: typeof z;
  hit: typeof hit;
  font: {
    family: typeof fontFamily;
    size: typeof fontSize;
    weight: typeof fontWeight;
    lineHeight: typeof lineHeight;
  };
  /** Reserved for server-issued custom themes (see CatRealm-Client/src/stores/customThemeStore). */
  serverThemeId: string | null;
};

const defaultTheme: Theme = {
  colors: { ...palette, statusColor },
  spacing,
  radius,
  shadow,
  z,
  hit,
  font: {
    family: fontFamily,
    size: fontSize,
    weight: fontWeight,
    lineHeight,
  },
  serverThemeId: null,
};

const ThemeContext = createContext<Theme>(defaultTheme);

export function ThemeProvider({ children, override }: { children: ReactNode; override?: Partial<Theme> }) {
  const selectedThemeId = useSettingsStore((s) => s.theme);
  const customThemes = useCustomThemeStore((s) => s.themes);
  const hydrateCustomThemes = useCustomThemeStore((s) => s.hydrate);

  useEffect(() => {
    void hydrateCustomThemes();
  }, [hydrateCustomThemes]);

  const paletteForTheme = useMemo(() => {
    const builtIn = (builtInPalettes as Record<string, typeof palette | undefined>)[selectedThemeId as BuiltInThemeId];
    if (builtIn) return builtIn;
    const custom = customThemes.find((t) => t.id === selectedThemeId);
    if (custom) return customThemeToPalette(custom.colors);
    return builtInPalettes['dark-cat'] ?? palette;
  }, [customThemes, selectedThemeId]);

  const value = useMemo(
    () => ({
      ...defaultTheme,
      ...override,
      colors: { ...paletteForTheme, statusColor },
    }),
    [override, paletteForTheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

export { palette, statusColor, spacing, radius, shadow, z, hit, fontFamily, fontSize, fontWeight, lineHeight };
