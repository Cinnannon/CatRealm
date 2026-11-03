import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createAuthenticatedApi } from '@/lib/api';
import i18n from '@/i18n';
import { useAuthStore } from './authStore';
import { detectAppLanguage, LANGUAGE_OPTIONS, type AppLanguage } from '@/i18n/languages';

export const EMOTE_SIZE_OPTIONS = [24, 32, 48, 64, 96, 128, 256, 512] as const;
export type EmoteSizePx = (typeof EMOTE_SIZE_OPTIONS)[number];
export const BUILT_IN_THEME_IDS = ['retro-discord', 'dark-cat', 'angel-cat', 'midnight-cat'] as const;
export type BuiltInThemeId = (typeof BUILT_IN_THEME_IDS)[number];
export type ThemeId = BuiltInThemeId | (string & {});
export { LANGUAGE_OPTIONS };
export type { AppLanguage };
export type ScreenShareViewerQuality = 'auto' | 'high' | 'medium' | 'low';
const DEFAULT_LANGUAGE: AppLanguage = detectAppLanguage();
const SCREEN_SHARE_VIEWER_QUALITIES = ['auto', 'high', 'medium', 'low'] as const;

const SETTINGS_STORAGE_KEY = 'catrealm.mobile.settings.v1';
const DEFAULT_EMOTE_SIZE: EmoteSizePx = 48;
const DEFAULT_THEME: BuiltInThemeId = 'dark-cat';

export const SOUND_SETTING_DEFAULTS = {
  soundMessageInChannel: true,
  soundMessageInServer: true,
  soundMessageMention: true,
  soundMessageEveryone: true,
  soundDMIncomingCall: true,
  soundDMOutgoingCall: true,
  soundDMMessageInCurrent: true,
  soundDMMessageFromOther: true,
  soundVoiceDeafen: true,
  soundVoiceUndeafen: true,
  soundVoiceMute: true,
  soundVoiceUnmute: true,
  soundVoicePTTActivate: true,
  soundVoicePTTDeactivate: true,
  soundVoiceUserJoined: true,
  soundVoiceUserLeft: true,
  soundVoiceUserMoved: true,
  soundScreenshareGoLive: true,
  soundScreenshareUserJoin: true,
  soundScreenshareUserLeft: true,
  soundScreenshareEnded: true,
  soundScreenshareStopped: true,
  soundRTCFailed: true,
  soundRTCReconnecting: true,
  soundUIButtonClick: false,
  soundHourlyBeep: false,
  soundAmbience: false,
  soundChannelCreated: false,
  soundCategoryCreated: false,
  soundUploadingAttachment: false,
  soundTyping: false,
  soundSendMessage: false,
  soundChannelDeleted: false,
  soundCategoryDeleted: false,
  soundDeletingMessage: false,
  soundEditingMessage: false,
} as const;

export type SoundSettingKey = keyof typeof SOUND_SETTING_DEFAULTS;

const DEFAULT_SOUND_VOLUMES: Record<SoundSettingKey, number> = Object.keys(SOUND_SETTING_DEFAULTS).reduce(
  (acc, key) => {
    acc[key as SoundSettingKey] = 100;
    return acc;
  },
  {} as Record<SoundSettingKey, number>,
);

type PersistedSettings = {
  emoteSizePx?: number;
  theme?: string;
  language?: string;
  playGifAvatars?: boolean;
  disableEmbedAutoplay?: boolean;
  showAvatarBackground?: boolean;
  notificationsEnabled?: boolean;
  theaterChatPreviews?: boolean;
  soundVolumes?: Record<string, number>;
  ugcImageCapMb?: number;
  ugcVideoCapMb?: number;
  screenShareViewerQuality?: string;
  catLabAutoTranslate?: boolean;
} & Partial<Record<SoundSettingKey, boolean>>;

interface SettingsState extends Record<SoundSettingKey, boolean> {
  emoteSizePx: EmoteSizePx;
  theme: ThemeId;
  language: AppLanguage;
  playGifAvatars: boolean;
  disableEmbedAutoplay: boolean;
  showAvatarBackground: boolean;
  notificationsEnabled: boolean;
  theaterChatPreviews: boolean;
  soundVolumes: Record<string, number>;
  ugcImageCapMb: number;
  ugcVideoCapMb: number;
  screenShareViewerQuality: ScreenShareViewerQuality;
  /** Cat Lab: translate messages on-device (see lib/translation). */
  catLabAutoTranslate: boolean;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setEmoteSizePx: (value: EmoteSizePx) => void;
  setTheme: (value: ThemeId) => void;
  setLanguage: (value: AppLanguage) => void;
  setPlayGifAvatars: (value: boolean) => void;
  setDisableEmbedAutoplay: (value: boolean) => void;
  setShowAvatarBackground: (value: boolean) => void;
  setNotificationsEnabled: (value: boolean) => void;
  setTheaterChatPreviews: (value: boolean) => void;
  setSoundSetting: (key: SoundSettingKey, value: boolean) => void;
  setSoundVolume: (key: SoundSettingKey, volume: number) => void;
  setUgcImageCapMb: (value: number) => void;
  setUgcVideoCapMb: (value: number) => void;
  setScreenShareViewerQuality: (value: ScreenShareViewerQuality) => void;
  setCatLabAutoTranslate: (value: boolean) => void;
}

function coerceEmoteSize(value: unknown): EmoteSizePx {
  return EMOTE_SIZE_OPTIONS.includes(value as EmoteSizePx)
    ? (value as EmoteSizePx)
    : DEFAULT_EMOTE_SIZE;
}

function coerceTheme(value: unknown): ThemeId {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return DEFAULT_THEME;
}

async function persistSettings(value: PersistedSettings) {
  await AsyncStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(value));
}

function isCentralAccount(): boolean {
  return useAuthStore.getState().user?.accountType === 'central';
}

// Subset of PersistedSettings that lives on the server (notification/sound prefs only).
type SoundPrefsPayload = {
  notificationsEnabled?: boolean;
  soundVolumes?: Record<string, number>;
} & Partial<Record<SoundSettingKey, boolean>>;

function extractSoundPrefs(snapshot: PersistedSettings): SoundPrefsPayload {
  const { emoteSizePx: _e, theme: _t, language: _l, playGifAvatars: _p, disableEmbedAutoplay: _d, showAvatarBackground: _s, theaterChatPreviews: _c, catLabAutoTranslate: _a, ...rest } = snapshot;
  return rest;
}

function syncSoundPrefsToServer(snapshot: PersistedSettings): void {
  if (!isCentralAccount()) return;
  const payload = extractSoundPrefs(snapshot);
  const api = createAuthenticatedApi();
  void api.put('/api/user-settings/sounds', payload).catch(() => { /* non-fatal */ });
}

function getPersistedSnapshot(state: SettingsState): PersistedSettings {
  const soundFlags = Object.keys(SOUND_SETTING_DEFAULTS).reduce((acc, key) => {
    const typedKey = key as SoundSettingKey;
    acc[typedKey] = state[typedKey] as boolean;
    return acc;
  }, {} as Partial<Record<SoundSettingKey, boolean>>);

  return {
    emoteSizePx: state.emoteSizePx,
    theme: state.theme,
    language: state.language,
    playGifAvatars: state.playGifAvatars,
    disableEmbedAutoplay: state.disableEmbedAutoplay,
    showAvatarBackground: state.showAvatarBackground,
    notificationsEnabled: state.notificationsEnabled,
    theaterChatPreviews: state.theaterChatPreviews,
    soundVolumes: state.soundVolumes,
    ugcImageCapMb: state.ugcImageCapMb,
    ugcVideoCapMb: state.ugcVideoCapMb,
    screenShareViewerQuality: state.screenShareViewerQuality,
    catLabAutoTranslate: state.catLabAutoTranslate,
    ...soundFlags,
  };
}

const baseState = {
  emoteSizePx: DEFAULT_EMOTE_SIZE,
  theme: DEFAULT_THEME,
  language: DEFAULT_LANGUAGE,
  playGifAvatars: true,
  disableEmbedAutoplay: false,
  showAvatarBackground: true,
  notificationsEnabled: true,
  theaterChatPreviews: true,
  soundVolumes: { ...DEFAULT_SOUND_VOLUMES },
  ugcImageCapMb: 150,
  ugcVideoCapMb: 250,
  screenShareViewerQuality: 'auto' as ScreenShareViewerQuality,
  catLabAutoTranslate: false,
};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...baseState,
  ...SOUND_SETTING_DEFAULTS,
  hydrated: false,
  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(SETTINGS_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as PersistedSettings) : {};

      // For central accounts, try to pull server-side sound prefs and merge
      // them on top of local storage (server wins so settings roam across devices).
      let serverSoundPrefs: SoundPrefsPayload = {};
      if (isCentralAccount()) {
        try {
          const api = createAuthenticatedApi();
          const res = await api.get<SoundPrefsPayload>('/api/user-settings/sounds');
          serverSoundPrefs = res.data ?? {};
        } catch { /* offline — fall back to local */ }
      }

      const merged: PersistedSettings = { ...parsed, ...serverSoundPrefs };

      const soundFlags = Object.keys(SOUND_SETTING_DEFAULTS).reduce((acc, key) => {
        const typedKey = key as SoundSettingKey;
        acc[typedKey] = merged[typedKey] ?? SOUND_SETTING_DEFAULTS[typedKey];
        return acc;
      }, {} as Record<SoundSettingKey, boolean>);

      const persistedVolumes = (merged.soundVolumes ?? {}) as Record<string, number>;
      const mergedVolumes = Object.keys(DEFAULT_SOUND_VOLUMES).reduce((acc, key) => {
        const typedKey = key as SoundSettingKey;
        const rawValue = persistedVolumes[typedKey];
        const numeric = Number(rawValue);
        acc[typedKey] = Number.isFinite(numeric)
          ? Math.max(0, Math.min(100, Math.round(numeric)))
          : DEFAULT_SOUND_VOLUMES[typedKey];
        return acc;
      }, {} as Record<SoundSettingKey, number>);

      const lang = LANGUAGE_OPTIONS.includes(merged.language as AppLanguage)
        ? (merged.language as AppLanguage)
        : DEFAULT_LANGUAGE;
      const screenShareViewerQuality = SCREEN_SHARE_VIEWER_QUALITIES.includes(merged.screenShareViewerQuality as ScreenShareViewerQuality)
        ? (merged.screenShareViewerQuality as ScreenShareViewerQuality)
        : 'auto';
      void i18n.changeLanguage(lang);

      set({
        emoteSizePx: coerceEmoteSize(merged.emoteSizePx),
        theme: coerceTheme(merged.theme),
        language: lang,
        playGifAvatars: merged.playGifAvatars ?? true,
        disableEmbedAutoplay: merged.disableEmbedAutoplay ?? false,
        showAvatarBackground: merged.showAvatarBackground ?? true,
        notificationsEnabled: merged.notificationsEnabled ?? true,
        theaterChatPreviews: typeof parsed.theaterChatPreviews === 'boolean' ? parsed.theaterChatPreviews : true,
        soundVolumes: mergedVolumes,
        ugcImageCapMb: typeof merged.ugcImageCapMb === 'number' && merged.ugcImageCapMb > 0 ? merged.ugcImageCapMb : 150,
        ugcVideoCapMb: typeof merged.ugcVideoCapMb === 'number' && merged.ugcVideoCapMb > 0 ? merged.ugcVideoCapMb : 250,
        screenShareViewerQuality,
        catLabAutoTranslate: parsed.catLabAutoTranslate === true,
        ...soundFlags,
        hydrated: true,
      });
    } catch {
      set({ hydrated: true });
    }
  },
  setEmoteSizePx: (value) => {
    set({ emoteSizePx: value });
    void persistSettings(getPersistedSnapshot(get()));
  },
  setTheme: (value) => {
    set({ theme: value });
    void persistSettings(getPersistedSnapshot(get()));
  },
  setLanguage: (value) => {
    set({ language: value });
    void persistSettings(getPersistedSnapshot(get()));
    void i18n.changeLanguage(value);
  },
  setPlayGifAvatars: (value) => {
    set({ playGifAvatars: value });
    void persistSettings(getPersistedSnapshot(get()));
  },
  setDisableEmbedAutoplay: (value) => {
    set({ disableEmbedAutoplay: value });
    void persistSettings(getPersistedSnapshot(get()));
  },
  setShowAvatarBackground: (value) => {
    set({ showAvatarBackground: value });
    void persistSettings(getPersistedSnapshot(get()));
  },
  setNotificationsEnabled: (value) => {
    set({ notificationsEnabled: value });
    const snapshot = getPersistedSnapshot(get());
    void persistSettings(snapshot);
    syncSoundPrefsToServer(snapshot);
  },
  setTheaterChatPreviews: (value) => {
    set({ theaterChatPreviews: value });
    void persistSettings(getPersistedSnapshot(get()));
  },
  setSoundSetting: (key, value) => {
    set({ [key]: value } as Partial<SettingsState>);
    const snapshot = getPersistedSnapshot(get());
    void persistSettings(snapshot);
    syncSoundPrefsToServer(snapshot);
  },
  setSoundVolume: (key, volume) => {
    const clamped = Math.max(0, Math.min(100, Math.round(volume)));
    const soundVolumes = { ...get().soundVolumes, [key]: clamped };
    set({ soundVolumes });
    const snapshot = getPersistedSnapshot(get());
    void persistSettings(snapshot);
    syncSoundPrefsToServer(snapshot);
  },
  setUgcImageCapMb: (value) => {
    set({ ugcImageCapMb: value });
    void persistSettings(getPersistedSnapshot(get()));
  },
  setUgcVideoCapMb: (value) => {
    set({ ugcVideoCapMb: value });
    void persistSettings(getPersistedSnapshot(get()));
  },
  setCatLabAutoTranslate: (value) => {
    set({ catLabAutoTranslate: value });
    void persistSettings(getPersistedSnapshot(get()));
  },
  setScreenShareViewerQuality: (value) => {
    const screenShareViewerQuality = SCREEN_SHARE_VIEWER_QUALITIES.includes(value) ? value : 'auto';
    set({ screenShareViewerQuality });
    void persistSettings(getPersistedSnapshot(get()));
  },
}));
