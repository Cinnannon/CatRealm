/**
 * Settings modal — account, appearance, and sign-out.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import {
  View,
  FlatList,
  ScrollView,
  TextInput,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Image,
  Linking,
  Modal,
  Platform,
  Switch,
  useWindowDimensions,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { SafeAreaView } from '@/components/SafeAreaView';
import { useLocalSearchParams, useRouter } from 'expo-router';
import axios from 'axios';
import * as DocumentPicker from 'expo-document-picker';
import { ChevronDown, ChevronRight, ChevronUp, Ellipsis, Globe, KeyRound, Laptop, Pencil, Plus, RefreshCw, Smartphone, Trash2, X } from 'lucide-react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';
import { useTheme } from '@/theme';
import { Text, IconBtn, Pressable, Avatar, StatusDot } from '@/components';
import { TranslationPacksList } from '@/components/settings/TranslationPacksList';
import { ServerIcon } from '@/components/ServerIcon';
import { DeleteAccountConfirmModal } from '@/components/settings/DeleteAccountConfirmModal';
import { useAuthStore } from '@/stores/authStore';
import { CUSTOM_THEME_TEMPLATE, useCustomThemeStore, validateAndParseCustomTheme } from '@/stores/customThemeStore';
import {
  EMOTE_SIZE_OPTIONS,
  SOUND_SETTING_DEFAULTS,
  useSettingsStore,
  type AppLanguage,
  type BuiltInThemeId,
  type EmoteSizePx,
  type SoundSettingKey,
} from '@/stores/settingsStore';
import { useServerStore } from '@/stores/serverStore';
import { useNowPlayingStore } from '@/stores/nowPlayingStore';
import { useContentSocialStore } from '@/stores/contentSocialStore';
import { AUTH_BASE, createApi, createAuthenticatedApi } from '@/lib/api';
import { appendFormDataFile } from '@/lib/formData';
import { playNotificationSound, type SoundType } from '@/lib/notificationSounds';
import {
  requestPushPermissionAndGetToken,
  registerPushToken,
  unregisterPushToken,
} from '@/lib/pushNotifications';
import { usePushSettingsStore } from '@/stores/pushSettingsStore';
import { getCacheSize, getCacheScopeBreakdown, getCacheScopeFiles, clearCacheScope, clearImageCache, formatBytes, originHashForUrl, setCacheCaps } from '@/lib/imageCache';
import { secureStorage, StorageKeys } from '@/lib/storage';
import { getLocalDeviceId, registerCurrentDevice } from '@/lib/deviceIdentity';
import { approveSurvivingDevice } from '@/lib/approveSurvivingDevice';
import {
  clearLatestNotificationPreviewDiagnostic,
  getLatestNotificationPreviewDiagnostic,
  getNotificationPreviewLocalReadiness,
  type NotificationPreviewDiagnostic,
  type NotificationPreviewLocalReadiness,
} from '@/lib/notificationDiagnostics';
import {
  clearPersonalExpressionLookup,
  loadPersonalExpressionLookup,
  useExpressionLookup,
} from '@/lib/expressionCache';
import type { UserStatus } from '@/types';

type SettingsSection =
  | 'profile'
  | 'server-profiles'
  | 'account-security'
  | 'voice'
  | 'notifications'
  | 'appearance'
  | 'emotes-settings'
  | 'content-social'
  | 'storage'
  | 'language'
  | 'cat-lab';

const STATUSES: { value: UserStatus; label: string; selectable?: boolean }[] = [
  { value: 'online', label: 'Online' },
  { value: 'away', label: 'Away' },
  { value: 'sleeping', label: 'Sleeping (auto)', selectable: false },
  { value: 'invisible', label: 'Offline' },
];

const DEFAULT_PREVIEW_GLYPHS = ['CR', ':)', 'OK', '!!', '<3'];
type PersonalExpressionType = 'emotes' | 'anim-emotes' | 'stickers' | 'anim-stickers';

type PersonalExpressionItem = {
  id: string;
  owner_id?: string;
  name: string;
  type: PersonalExpressionType;
  file_url?: string;
  absolute_url?: string;
  token_alias?: string;
  variants?: Record<string, string>;
  absolute_variants?: Record<string, string>;
};

type PersonalExpressionGroups = Record<PersonalExpressionType, PersonalExpressionItem[]>;

type PersonalSummary = {
  animatedEmotes: number;
  animatedStickers: number;
  emoteLimit: number;
  stickerLimit: number;
};

type PreviewItem = {
  id: string;
  label: string;
  src?: string;
  emoji?: string;
};

const EMPTY_PERSONAL_EXPRESSIONS: PersonalExpressionGroups = {
  emotes: [],
  'anim-emotes': [],
  stickers: [],
  'anim-stickers': [],
};

const DEFAULT_PERSONAL_SUMMARY: PersonalSummary = {
  animatedEmotes: 0,
  animatedStickers: 0,
  emoteLimit: 10,
  stickerLimit: 10,
};

const THEME_OPTIONS: Array<{
  id: BuiltInThemeId;
  name: string;
  description: string;
  swatches: [string, string, string];
}> = [
  {
    id: 'dark-cat',
    name: 'DarkCat',
    description: 'Deeper violet surfaces with stronger contrast. Default.',
    swatches: ['#302154', '#3A2864', '#9B77FF'],
  },
  {
    id: 'angel-cat',
    name: 'AngelCat',
    description: 'Light theme for bright environments.',
    swatches: ['#F0E7FF', '#ECE2F8', '#6B44F0'],
  },
  {
    id: 'midnight-cat',
    name: 'MidnightCat',
    description: 'AMOLED black theme with restrained accents.',
    swatches: ['#000000', '#0F0F0F', '#7C5CFF'],
  },
  {
    id: 'retro-discord',
    name: 'RetroDiscord',
    description: 'Classic dark CatRealm base theme.',
    swatches: ['#2B2D31', '#313338', '#7C5CFF'],
  },
];

const LANGUAGE_DISPLAY_OPTIONS: Array<{ id: AppLanguage; nativeLabel: string }> = [
  { id: 'en', nativeLabel: 'English' },
  { id: 'es', nativeLabel: 'Español' },
  { id: 'ru', nativeLabel: 'Русский' },
  { id: 'ja', nativeLabel: '日本語' },
];

function normalizeSection(section: string | undefined): SettingsSection {
  if (
    section === 'server-profiles' ||
    section === 'account-security' ||
    section === 'voice' ||
    section === 'notifications' ||
    section === 'appearance' ||
    section === 'emotes-settings' ||
    section === 'content-social' ||
    section === 'storage' ||
    section === 'language' ||
    section === 'cat-lab'
  ) {
    return section;
  }
  return 'profile';
}

function SectionHeader({ title }: { title: string }) {
  const theme = useTheme();
  return (
    <Text
      variant="caption"
      color={theme.colors.text3}
      style={{
        paddingHorizontal: theme.spacing.lg,
        paddingTop: theme.spacing.lg,
        paddingBottom: theme.spacing.xs,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
      }}
    >
      {title}
    </Text>
  );
}

function profileText(profile: Record<string, unknown>, camel: string, snake?: string) {
  const value = profile[camel] ?? (snake ? profile[snake] : undefined);
  return typeof value === 'string' ? value : '';
}

function sanitizeExpressionName(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 64);
}

function absoluteExpressionUrl(item: PersonalExpressionItem): string | null {
  if (item.absolute_url) return item.absolute_url;
  if (!item.file_url) return null;
  return /^https?:\/\//i.test(item.file_url) ? item.file_url : `${AUTH_BASE}${item.file_url}`;
}

function normalizePersonalGroups(payload: Record<string, unknown>): PersonalExpressionGroups {
  return {
    emotes: Array.isArray(payload.emotes) ? payload.emotes as PersonalExpressionItem[] : [],
    'anim-emotes': Array.isArray(payload['anim-emotes']) ? payload['anim-emotes'] as PersonalExpressionItem[] : [],
    stickers: Array.isArray(payload.stickers) ? payload.stickers as PersonalExpressionItem[] : [],
    'anim-stickers': Array.isArray(payload['anim-stickers']) ? payload['anim-stickers'] as PersonalExpressionItem[] : [],
  };
}

function extractApiError(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const message = error.response?.data?.error ?? error.response?.data?.message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return fallback;
}

function EmotesSettingsSection() {
  const theme = useTheme();
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const authServerUrl = useAuthStore((s) => s.serverUrl);
  const activeServerUrl = useServerStore((s) =>
    s.activeServerId ? s.byId(s.activeServerId)?.url : undefined,
  );
  const firstServerUrl = useServerStore((s) => s.servers[0]?.url);
  const emoteSizePx = useSettingsStore((s) => s.emoteSizePx);
  const setEmoteSizePx = useSettingsStore((s) => s.setEmoteSizePx);
  const expressionLookup = useExpressionLookup(activeServerUrl ?? firstServerUrl ?? authServerUrl);

  const [personalExpressions, setPersonalExpressions] = useState<PersonalExpressionGroups>(EMPTY_PERSONAL_EXPRESSIONS);
  const [personalSummary, setPersonalSummary] = useState<PersonalSummary>(DEFAULT_PERSONAL_SUMMARY);
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({});
  const [personalLoading, setPersonalLoading] = useState(false);
  const [personalError, setPersonalError] = useState<string | null>(null);
  const [uploadingKind, setUploadingKind] = useState<'emotes' | 'stickers' | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const isCentral = user?.accountType === 'central';
  const personalTokenSuffix = user?.id || 'user-id';
  const personalEmoteItems = useMemo(
    () => [...personalExpressions['anim-emotes'], ...personalExpressions.emotes],
    [personalExpressions],
  );
  const personalStickerItems = useMemo(
    () => [...personalExpressions['anim-stickers'], ...personalExpressions.stickers],
    [personalExpressions],
  );

  const previewItems = useMemo<PreviewItem[]>(() => {
    const expressions = [...(expressionLookup?.values() ?? [])]
      .filter((entry) => entry.emote)
      .slice(0, 5)
      .map((entry, index) => ({
        id: `${entry.origin ?? 'local'}:${entry.name}:${index}`,
        label: entry.name,
        src: entry.emote,
      }));
    if (expressions.length > 0) return expressions;
    return DEFAULT_PREVIEW_GLYPHS.map((glyph, index) => ({
      id: `glyph-${index}`,
      label: glyph,
      emoji: glyph,
    }));
  }, [expressionLookup]);

  const refreshPersonalExpressionCache = useCallback(() => {
    clearPersonalExpressionLookup(AUTH_BASE);
    if (token) void loadPersonalExpressionLookup(AUTH_BASE, token);
  }, [token]);

  const loadPersonalSummary = useCallback(async () => {
    if (!isCentral) {
      setPersonalSummary(DEFAULT_PERSONAL_SUMMARY);
      setPersonalExpressions(EMPTY_PERSONAL_EXPRESSIONS);
      setRenameDrafts({});
      setPersonalError(t('settings.emotesRequireCentral'));
      return;
    }

    setPersonalLoading(true);
    setPersonalError(null);
    try {
      const res = await createAuthenticatedApi().get<Record<string, unknown>>('/api/profile/personal-expressions');
      const groups = normalizePersonalGroups(res.data ?? {});
      setPersonalExpressions(groups);
      setRenameDrafts((prev) => {
        const next: Record<string, string> = {};
        for (const item of [
          ...groups.emotes,
          ...groups['anim-emotes'],
          ...groups.stickers,
          ...groups['anim-stickers'],
        ]) {
          if (!item.id) continue;
          next[item.id] = prev[item.id] ?? sanitizeExpressionName(item.name);
        }
        return next;
      });

      const counts = (res.data.counts ?? {}) as Record<string, unknown>;
      const limits = (res.data.limits ?? {}) as Record<string, unknown>;
      const emotes = Number(counts.emotes ?? groups.emotes.length + groups['anim-emotes'].length);
      const stickers = Number(counts.stickers ?? groups.stickers.length + groups['anim-stickers'].length);
      const emoteLimit = Number(limits.emotes ?? 10);
      const stickerLimit = Number(limits.stickers ?? 10);
      setPersonalSummary({
        animatedEmotes: Number.isFinite(emotes) ? emotes : 0,
        animatedStickers: Number.isFinite(stickers) ? stickers : 0,
        emoteLimit: Number.isFinite(emoteLimit) ? emoteLimit : 10,
        stickerLimit: Number.isFinite(stickerLimit) ? stickerLimit : 10,
      });
    } catch (error) {
      setPersonalError(extractApiError(error, t('settings.emoteAPIUnavailable')));
      setPersonalSummary(DEFAULT_PERSONAL_SUMMARY);
      setPersonalExpressions(EMPTY_PERSONAL_EXPRESSIONS);
      setRenameDrafts({});
    } finally {
      setPersonalLoading(false);
    }
  }, [isCentral, t]);

  useEffect(() => {
    void loadPersonalSummary();
  }, [loadPersonalSummary]);

  const uploadPersonalExpression = async (kind: 'emotes' | 'stickers') => {
    if (!isCentral) {
      setPersonalError(t('settings.emoteUploadRequiresCentral'));
      return;
    }
    const picked = await DocumentPicker.getDocumentAsync({
      type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/apng'],
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (picked.canceled || !picked.assets[0]) return;

    const asset = picked.assets[0];
    const name = sanitizeExpressionName((asset.name ?? kind).replace(/\.[^.]+$/, '')) || `${kind}-${Date.now()}`;
    const form = new FormData();
    form.append('name', name);
    await appendFormDataFile(form, 'file', {
      uri: asset.uri,
      name: asset.name ?? `${name}.png`,
      type: asset.mimeType ?? 'application/octet-stream',
    });

    setUploadingKind(kind);
    setPersonalError(null);
    try {
      await createAuthenticatedApi().post(`/api/profile/personal-expressions/${kind}`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      refreshPersonalExpressionCache();
      await loadPersonalSummary();
    } catch (error) {
      setPersonalError(extractApiError(error, t('settings.emoteAPIUnavailable')));
    } finally {
      setUploadingKind(null);
    }
  };

  const renamePersonalExpression = async (item: PersonalExpressionItem) => {
    const itemId = String(item.id || '');
    const nextName = sanitizeExpressionName(renameDrafts[itemId] ?? item.name);
    if (!itemId || !nextName || nextName === sanitizeExpressionName(item.name)) return;

    setSavingId(itemId);
    setPersonalError(null);
    try {
      await createAuthenticatedApi().patch(`/api/profile/personal-expressions/${itemId}`, { name: nextName });
      refreshPersonalExpressionCache();
      await loadPersonalSummary();
    } catch (error) {
      setPersonalError(extractApiError(error, t('settings.emoteRenameFailed')));
    } finally {
      setSavingId(null);
    }
  };

  const deletePersonalExpression = async (item: PersonalExpressionItem) => {
    const itemId = String(item.id || '');
    if (!itemId) return;

    Alert.alert(t('settings.emoteDeleteTitle'), t('settings.emoteDeleteBody', { name: sanitizeExpressionName(item.name) }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          setDeletingId(itemId);
          setPersonalError(null);
          try {
            await createAuthenticatedApi().delete(`/api/profile/personal-expressions/${itemId}`);
            refreshPersonalExpressionCache();
            await loadPersonalSummary();
          } catch (error) {
            setPersonalError(extractApiError(error, t('settings.emoteDeleteFailed')));
          } finally {
            setDeletingId(null);
          }
        },
      },
    ]);
  };

  const renderExpressionItem = (item: PersonalExpressionItem, isSticker: boolean) => {
    const itemId = String(item.id || '');
    const draft = renameDrafts[itemId] ?? sanitizeExpressionName(item.name);
    const normalizedDraft = sanitizeExpressionName(draft);
    const canSave = normalizedDraft.length > 0 && normalizedDraft !== sanitizeExpressionName(item.name);
    const tokenAlias = item.token_alias || `:${sanitizeExpressionName(item.name)}:${item.owner_id || personalTokenSuffix}:`;
    const previewUrl = absoluteExpressionUrl(item);

    return (
      <View
        key={itemId}
        style={[
          styles.expressionItem,
          {
            backgroundColor: theme.colors.bgElev2,
            borderColor: theme.colors.lineSoft,
            borderRadius: theme.radius.md,
          },
        ]}
      >
        <View style={styles.expressionPreview}>
          {previewUrl ? (
            <Image source={{ uri: previewUrl }} style={styles.expressionImage} resizeMode="contain" />
          ) : (
            <Text variant="caption" color={theme.colors.text3}>{t('common.notAvailable')}</Text>
          )}
        </View>
        <View style={{ flex: 1, gap: 8 }}>
          <Text variant="caption" color={theme.colors.text3} numberOfLines={1}>
            {isSticker ? `:sticker:${tokenAlias.replace(/^:/, '')}` : tokenAlias}
          </Text>
          <View style={styles.expressionEditRow}>
            <TextInput
              value={draft}
              onChangeText={(next) =>
                setRenameDrafts((prev) => ({ ...prev, [itemId]: sanitizeExpressionName(next) }))
              }
              placeholder={isSticker ? 'sticker-name' : 'emote-name'}
              placeholderTextColor={theme.colors.text3}
              style={[
                styles.expressionInput,
                {
                  color: theme.colors.text,
                  backgroundColor: theme.colors.bgElev1,
                  borderColor: theme.colors.lineSoft,
                  borderRadius: theme.radius.sm,
                },
              ]}
            />
            <Pressable
              haptic
              disabled={!canSave || savingId === itemId}
              onPress={() => void renamePersonalExpression(item)}
              style={[
                styles.iconAction,
                {
                  backgroundColor: theme.colors.bgElev1,
                  borderColor: theme.colors.lineSoft,
                  opacity: !canSave || savingId === itemId ? 0.45 : 1,
                },
              ]}
            >
              <Text variant="caption" color={theme.colors.text2}>{t('common.save')}</Text>
            </Pressable>
            <Pressable
              haptic
              disabled={deletingId === itemId}
              onPress={() => void deletePersonalExpression(item)}
              style={[
                styles.iconAction,
                {
                  backgroundColor: theme.colors.bgElev1,
                  borderColor: theme.colors.danger,
                  opacity: deletingId === itemId ? 0.45 : 1,
                },
              ]}
            >
              <Trash2 size={16} color={theme.colors.danger} />
            </Pressable>
          </View>
        </View>
      </View>
    );
  };

  return (
    <>
      <SectionHeader title={t('settings.sectionEmoteSettings')} />
      <View style={[styles.card, { backgroundColor: theme.colors.bgElev1, borderRadius: theme.radius.lg, marginHorizontal: theme.spacing.lg }]}>
        <View style={styles.infoBlock}>
          <Text variant="body" color={theme.colors.text2}>
            {t('settings.emoteAdjustDesc')}
          </Text>
          <View style={styles.sizeGrid}>
            {EMOTE_SIZE_OPTIONS.map((size) => (
              <Pressable
                key={size}
                haptic
                onPress={() => setEmoteSizePx(size as EmoteSizePx)}
                style={[
                  styles.sizeChip,
                  {
                    backgroundColor: emoteSizePx === size ? theme.colors.accent : theme.colors.bgElev2,
                    borderColor: emoteSizePx === size ? theme.colors.accent : theme.colors.lineSoft,
                    borderRadius: theme.radius.md,
                  },
                ]}
              >
                <Text
                  variant="caption"
                  color={emoteSizePx === size ? theme.colors.textOnAccent : theme.colors.text2}
                >
                  {size}x
                </Text>
              </Pressable>
            ))}
          </View>
          <Text variant="caption" color={theme.colors.text3}>
            {t('settings.emotePreviewAt', { size: emoteSizePx })}
          </Text>
          <View style={[styles.previewRow, { backgroundColor: theme.colors.bgElev2, borderRadius: theme.radius.md }]}>
            {previewItems.map((item) => (
              <View key={item.id} style={{ width: emoteSizePx, height: emoteSizePx }}>
                {item.src ? (
                  <Image source={{ uri: item.src }} style={{ width: emoteSizePx, height: emoteSizePx }} resizeMode="contain" />
                ) : (
                  <Text style={{ fontSize: Math.max(16, Math.min(48, Math.round(emoteSizePx * 0.7))) }}>
                    {item.emoji}
                  </Text>
                )}
              </View>
            ))}
          </View>
        </View>
      </View>

      <SectionHeader title={t('settings.sectionPersonalEmotes')} />
      <View style={[styles.card, { backgroundColor: theme.colors.bgElev1, borderRadius: theme.radius.lg, marginHorizontal: theme.spacing.lg }]}>
        {personalError ? (
          <View style={[styles.notice, { backgroundColor: theme.colors.accentSoft }]}>
            <Text variant="bodySmall" color={isCentral ? theme.colors.warning : theme.colors.text3}>
              {personalError}
            </Text>
          </View>
        ) : null}

        <View style={[styles.row, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.lineSoft }]}>
          <View style={{ flex: 1 }}>
            <Text variant="body">Animated / Emotes {personalSummary.animatedEmotes}/{personalSummary.emoteLimit}</Text>
            <Text variant="caption" color={theme.colors.text3}>{t('settings.emoteFormats')}</Text>
          </View>
          <Pressable
            haptic
            disabled={!isCentral || uploadingKind === 'emotes'}
            onPress={() => void uploadPersonalExpression('emotes')}
            style={[styles.uploadBtn, { backgroundColor: theme.colors.bgElev2, borderRadius: theme.radius.md, opacity: !isCentral || uploadingKind === 'emotes' ? 0.45 : 1 }]}
          >
            {uploadingKind === 'emotes' ? <ActivityIndicator color={theme.colors.accent} /> : <Plus size={18} color={theme.colors.text2} />}
          </Pressable>
        </View>

        <View style={[styles.row, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.lineSoft }]}>
          <View style={{ flex: 1 }}>
            <Text variant="body">Animated / Stickers {personalSummary.animatedStickers}/{personalSummary.stickerLimit}</Text>
            <Text variant="caption" color={theme.colors.text3}>{t('settings.emoteStickersPoolDesc')}</Text>
          </View>
          <Pressable
            haptic
            disabled={!isCentral || uploadingKind === 'stickers'}
            onPress={() => void uploadPersonalExpression('stickers')}
            style={[styles.uploadBtn, { backgroundColor: theme.colors.bgElev2, borderRadius: theme.radius.md, opacity: !isCentral || uploadingKind === 'stickers' ? 0.45 : 1 }]}
          >
            {uploadingKind === 'stickers' ? <ActivityIndicator color={theme.colors.accent} /> : <Plus size={18} color={theme.colors.text2} />}
          </Pressable>
        </View>

        <View style={styles.personalHeader}>
          <Text variant="caption" color={theme.colors.text3}>{t('settings.yourEmotes')}</Text>
          <Pressable haptic onPress={() => void loadPersonalSummary()} style={styles.refreshButton}>
            {personalLoading ? <ActivityIndicator color={theme.colors.accent} /> : <RefreshCw size={16} color={theme.colors.text3} />}
          </Pressable>
        </View>
        {personalEmoteItems.length === 0 ? (
          <Text variant="bodySmall" color={theme.colors.text3} style={styles.emptyText}>
            {t('settings.noEmotes')}
          </Text>
        ) : personalEmoteItems.map((item) => renderExpressionItem(item, false))}

        <View style={styles.personalHeader}>
          <Text variant="caption" color={theme.colors.text3}>{t('settings.yourStickers')}</Text>
        </View>
        {personalStickerItems.length === 0 ? (
          <Text variant="bodySmall" color={theme.colors.text3} style={styles.emptyText}>
            {t('settings.noStickers')}
          </Text>
        ) : personalStickerItems.map((item) => renderExpressionItem(item, true))}
      </View>
    </>
  );
}

function LanguageSection() {
  const theme = useTheme();
  const { t } = useTranslation();
  const selectedLanguage = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);

  return (
    <>
      <SectionHeader title={t('settings.sectionLanguage')} />
      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.bgElev1,
            borderRadius: theme.radius.lg,
            marginHorizontal: theme.spacing.lg,
          },
        ]}
      >
        <View style={[styles.infoBlock, { paddingBottom: 8 }]}>
          <Text variant="bodySmall" color={theme.colors.text3}>
            {t('settings.langSelect')}
          </Text>
        </View>
        {LANGUAGE_DISPLAY_OPTIONS.map((option, index) => {
          const active = selectedLanguage === option.id;
          return (
            <Pressable
              key={option.id}
              haptic
              onPress={() => setLanguage(option.id)}
              style={[
                styles.themeRow,
                index < LANGUAGE_DISPLAY_OPTIONS.length - 1
                  ? {
                      borderBottomWidth: StyleSheet.hairlineWidth,
                      borderBottomColor: theme.colors.lineSoft,
                    }
                  : null,
              ]}
            >
              <View style={{ flex: 1 }}>
                <Text variant="subtitle">{option.nativeLabel}</Text>
              </View>
              <View
                style={[
                  styles.radioOuter,
                  {
                    borderColor: active ? theme.colors.accent : theme.colors.text3,
                  },
                ]}
              >
                {active ? (
                  <View
                    style={[
                      styles.radioInner,
                      { backgroundColor: theme.colors.accent },
                    ]}
                  />
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </>
  );
}

// Cat Lab — experimental features. Central-account only (mirrors the menu gate).
// Empty for now: the GIF picker graduated to a full feature once Klipy issued a
// production key. Kept in place as the home for the next experiment.
// Mirrors Central's check: Last.fm usernames are 2-15 letters, digits, _ or -.
const LASTFM_USERNAME_RE = /^[A-Za-z0-9_-]{2,15}$/;

function LastfmSection() {
  const theme = useTheme();
  const { t } = useTranslation();
  const userId = useAuthStore((s) => s.user?.id);
  const [linked, setLinked] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    createAuthenticatedApi().get<{ lastfmUsername: string | null }>('/api/profile/me/lastfm')
      .then((res) => { if (!cancelled) setLinked(res.data.lastfmUsername ?? null); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const apply = (data: { lastfmUsername: string | null; nowPlaying?: unknown }) => {
    setLinked(data.lastfmUsername ?? null);
    if (userId) useNowPlayingStore.getState().setNowPlaying(userId, data.nowPlaying);
  };

  const link = async () => {
    const username = draft.trim();
    if (!LASTFM_USERNAME_RE.test(username)) {
      setError(t('lastfm.invalidUsername'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await createAuthenticatedApi().put('/api/profile/me/lastfm', { username });
      apply(res.data);
      setDraft('');
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      setError(status === 404 ? t('lastfm.userNotFound') : status === 400 ? t('lastfm.invalidUsername') : t('lastfm.linkFailed'));
    } finally {
      setSaving(false);
    }
  };

  const unlink = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await createAuthenticatedApi().delete('/api/profile/me/lastfm');
      apply(res.data);
    } catch {
      setError(t('lastfm.unlinkFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SectionHeader title={t('lastfm.title')} />
      <View
        style={[
          styles.card,
          { backgroundColor: theme.colors.bgElev1, borderRadius: theme.radius.lg, marginHorizontal: theme.spacing.lg },
        ]}
      >
        {loading ? (
          <View style={styles.row}><ActivityIndicator color={theme.colors.accent} /></View>
        ) : linked ? (
          <View style={styles.row}>
            <Pressable haptic style={{ flex: 1 }} onPress={() => void Linking.openURL(`https://www.last.fm/user/${encodeURIComponent(linked)}`)}>
              <Text variant="bodySmall" color={theme.colors.text2} numberOfLines={1}>
                {t('lastfm.linkedAs')} <Text variant="bodySmall" color={theme.colors.accent}>{linked}</Text>
              </Text>
            </Pressable>
            <Pressable
              haptic
              onPress={() => void unlink()}
              disabled={saving}
              style={[styles.saveBtn, { backgroundColor: theme.colors.bgElev2, borderRadius: theme.radius.md, opacity: saving ? 0.5 : 1 }]}
            >
              <Text variant="caption">{t('lastfm.unlink')}</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.row}>
            <TextInput
              value={draft}
              onChangeText={(value) => { setDraft(value); setError(null); }}
              placeholder={t('lastfm.usernamePlaceholder')}
              placeholderTextColor={theme.colors.text3}
              style={[styles.nameInput, { color: theme.colors.text, flex: 1 }]}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={15}
              returnKeyType="done"
              onSubmitEditing={() => void link()}
            />
            <Pressable
              haptic
              onPress={() => void link()}
              disabled={saving || !draft.trim()}
              style={[styles.saveBtn, { backgroundColor: theme.colors.accent, borderRadius: theme.radius.md, opacity: saving || !draft.trim() ? 0.5 : 1 }]}
            >
              <Text variant="caption" color={theme.colors.textOnAccent}>
                {saving ? t('lastfm.saving') : t('lastfm.link')}
              </Text>
            </Pressable>
          </View>
        )}
      </View>
      <View style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.xs }}>
        {error ? (
          <Text variant="caption" color={theme.colors.danger}>{error}</Text>
        ) : (
          <Text variant="caption" color={theme.colors.text3}>{t('lastfm.description')}</Text>
        )}
      </View>
    </>
  );
}

function CatLabSettingsSection() {
  const theme = useTheme();
  const { t } = useTranslation();
  const autoTranslate = useSettingsStore((s) => s.catLabAutoTranslate);
  const setAutoTranslate = useSettingsStore((s) => s.setCatLabAutoTranslate);

  return (
    <>
      <SectionHeader title={t('settings.sectionCatLab')} />
      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.bgElev1,
            borderRadius: theme.radius.lg,
            marginHorizontal: theme.spacing.lg,
          },
        ]}
      >
        <View style={styles.infoBlock}>
          <Text variant="subtitle">{t('settings.catLabAutoTranslateTitle')}</Text>
          <Text variant="bodySmall" color={theme.colors.text3}>
            {t('settings.catLabAutoTranslateSectionDesc')}
          </Text>
        </View>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text variant="body">{t('settings.catLabAutoTranslateToggle')}</Text>
            <Text variant="bodySmall" color={theme.colors.text3}>
              {t('settings.catLabAutoTranslateToggleDesc')}
            </Text>
          </View>
          <Switch
            value={autoTranslate}
            onValueChange={setAutoTranslate}
            trackColor={{
              false: theme.colors.bgElev3,
              true: theme.colors.accentSoft,
            }}
            thumbColor={autoTranslate ? theme.colors.accent : theme.colors.text3}
            ios_backgroundColor={theme.colors.bgElev3}
          />
        </View>
        {autoTranslate ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
            <TranslationPacksList />
          </View>
        ) : null}
        <Text variant="caption" color={theme.colors.text3} style={{ paddingHorizontal: 16, paddingBottom: 14 }}>
          {t('settings.catLabAutoTranslateCredit')}
        </Text>
      </View>
    </>
  );
}

function AppearanceSettingsSection() {
  const theme = useTheme();
  const { t } = useTranslation();
  const selectedTheme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const customThemes = useCustomThemeStore((s) => s.themes);
  const addCustomTheme = useCustomThemeStore((s) => s.addTheme);
  const removeCustomTheme = useCustomThemeStore((s) => s.removeTheme);
  const [importError, setImportError] = useState<string | null>(null);
  const playGifAvatars = useSettingsStore((s) => s.playGifAvatars);
  const setPlayGifAvatars = useSettingsStore((s) => s.setPlayGifAvatars);
  const disableEmbedAutoplay = useSettingsStore((s) => s.disableEmbedAutoplay);
  const setDisableEmbedAutoplay = useSettingsStore((s) => s.setDisableEmbedAutoplay);
  const showAvatarBackground = useSettingsStore((s) => s.showAvatarBackground);
  const setShowAvatarBackground = useSettingsStore((s) => s.setShowAvatarBackground);

  const handleDownloadThemeTemplate = useCallback(() => {
    const json = JSON.stringify(CUSTOM_THEME_TEMPLATE, null, 2);
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'catrealm-theme-template.json';
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    Alert.alert('catrealm-theme-template.json', json);
  }, []);

  const handleImportCustomTheme = useCallback(async () => {
    setImportError(null);
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['application/json', 'text/json', '*/*'],
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets?.[0]) return;
      const asset = res.assets[0];
      let rawText = '';
      if (Platform.OS === 'web' && (asset as { file?: File }).file) {
        rawText = await (asset as { file: File }).file.text();
      } else {
        const resp = await fetch(asset.uri);
        rawText = await resp.text();
      }
      const parsed = validateAndParseCustomTheme(rawText);
      if (!parsed.ok) {
        setImportError(parsed.error);
        return;
      }
      const id = addCustomTheme(parsed.theme);
      setTheme(id);
      setImportError(null);
    } catch {
      setImportError('Failed to import custom theme JSON.');
    }
  }, [addCustomTheme, setTheme]);

  return (
    <>
      <SectionHeader title={t('settings.sectionTheme')} />
      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.bgElev1,
            borderRadius: theme.radius.lg,
            marginHorizontal: theme.spacing.lg,
          },
        ]}
      >
        {THEME_OPTIONS.map((option, index) => {
          const active = selectedTheme === option.id;
          return (
            <Pressable
              key={option.id}
              haptic
              onPress={() => setTheme(option.id)}
              style={[
                styles.themeRow,
                index < THEME_OPTIONS.length - 1 || customThemes.length > 0
                  ? {
                      borderBottomWidth: StyleSheet.hairlineWidth,
                      borderBottomColor: theme.colors.lineSoft,
                    }
                  : null,
              ]}
            >
              <View style={styles.themeSwatches}>
                {option.swatches.map((swatch) => (
                  <View
                    key={swatch}
                    style={[
                      styles.themeSwatch,
                      {
                        backgroundColor: swatch,
                        borderColor: active ? theme.colors.accent : theme.colors.lineSoft,
                      },
                    ]}
                  />
                ))}
              </View>
              <View style={{ flex: 1 }}>
                <Text variant="subtitle">{option.name}</Text>
                <Text variant="bodySmall" color={theme.colors.text3}>
                  {t(({
                    'dark-cat': 'theme.darkCatDesc',
                    'angel-cat': 'theme.angelCatDesc',
                    'midnight-cat': 'theme.midnightCatDesc',
                    'retro-discord': 'theme.retroDiscordDesc',
                  } as Record<BuiltInThemeId, string>)[option.id])}
                </Text>
              </View>
              <View
                style={[
                  styles.radioOuter,
                  {
                    borderColor: active ? theme.colors.accent : theme.colors.text3,
                  },
                ]}
              >
                {active ? (
                  <View
                    style={[
                      styles.radioInner,
                      {
                        backgroundColor: theme.colors.accent,
                      },
                    ]}
                  />
                ) : null}
              </View>
            </Pressable>
          );
        })}

        {customThemes.map((ct, idx) => {
          const active = selectedTheme === ct.id;
          const swatches = [
            ct.colors['bg-sidebar'] || '#302154',
            ct.colors['bg-chat'] || '#3A2864',
            ct.colors['accent'] || '#9B77FF',
          ];
          return (
            <Pressable
              key={ct.id}
              haptic
              onPress={() => setTheme(ct.id)}
              style={[
                styles.themeRow,
                idx < customThemes.length - 1
                  ? {
                      borderBottomWidth: StyleSheet.hairlineWidth,
                      borderBottomColor: theme.colors.lineSoft,
                    }
                  : null,
              ]}
            >
              <View style={styles.themeSwatches}>
                {swatches.map((swatch, sIdx) => (
                  <View
                    key={`${ct.id}-${sIdx}-${swatch}`}
                    style={[
                      styles.themeSwatch,
                      {
                        backgroundColor: swatch,
                        borderColor: active ? theme.colors.accent : theme.colors.lineSoft,
                      },
                    ]}
                  />
                ))}
              </View>
              <View style={{ flex: 1 }}>
                <Text variant="subtitle">{ct.themeName}</Text>
                <Text variant="bodySmall" color={theme.colors.text3}>
                  {ct.author ? `By ${ct.author} · v${ct.version || '1.0'}` : `Custom theme · v${ct.version || '1.0'}`}
                </Text>
              </View>
              <Pressable
                haptic
                onPress={() => {
                  removeCustomTheme(ct.id);
                  if (selectedTheme === ct.id) setTheme('dark-cat');
                }}
                style={{ padding: 6, marginRight: 4 }}
              >
                <Trash2 size={16} color={theme.colors.danger} />
              </Pressable>
              <View
                style={[
                  styles.radioOuter,
                  {
                    borderColor: active ? theme.colors.accent : theme.colors.text3,
                  },
                ]}
              >
                {active ? (
                  <View
                    style={[
                      styles.radioInner,
                      {
                        backgroundColor: theme.colors.accent,
                      },
                    ]}
                  />
                ) : null}
              </View>
            </Pressable>
          );
        })}

        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 10,
            padding: 14,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: theme.colors.lineSoft,
          }}
        >
          <Pressable
            haptic
            onPress={handleDownloadThemeTemplate}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 9,
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: theme.colors.line,
              backgroundColor: theme.colors.bgElev2,
            }}
          >
            <Text variant="caption" color={theme.colors.text2} style={{ fontWeight: '600' }}>
              {t('settingsContent.downloadThemeTemplate', { defaultValue: 'Download Theme Template' })}
            </Text>
          </Pressable>

          <Pressable
            haptic
            onPress={() => void handleImportCustomTheme()}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 9,
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: theme.colors.accent,
              backgroundColor: theme.colors.accentSoft,
            }}
          >
            <Text variant="caption" color={theme.colors.accentText} style={{ fontWeight: '700' }}>
              {t('settingsContent.importCustomTheme', { defaultValue: 'Import Custom Theme (.json)' })}
            </Text>
          </Pressable>
        </View>
        {importError ? (
          <Text variant="caption" color={theme.colors.danger} style={{ paddingHorizontal: 14, paddingBottom: 12 }}>
            {importError}
          </Text>
        ) : null}
      </View>

      <SectionHeader title={t('settings.sectionAvatarMedia')} />
      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.bgElev1,
            borderRadius: theme.radius.lg,
            marginHorizontal: theme.spacing.lg,
          },
        ]}
      >
        <View
          style={[
            styles.row,
            {
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: theme.colors.lineSoft,
            },
          ]}
        >
          <View style={{ flex: 1 }}>
            <Text variant="body">{t('settings.autoplayGif')}</Text>
            <Text variant="bodySmall" color={theme.colors.text3}>
              {t('settings.autoplayGifDesc')}
            </Text>
          </View>
          <Switch
            value={playGifAvatars}
            onValueChange={setPlayGifAvatars}
            trackColor={{
              false: theme.colors.bgElev3,
              true: theme.colors.accentSoft,
            }}
            thumbColor={playGifAvatars ? theme.colors.accent : theme.colors.text3}
            ios_backgroundColor={theme.colors.bgElev3}
          />
        </View>

        <View
          style={[
            styles.row,
            {
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: theme.colors.lineSoft,
            },
          ]}
        >
          <View style={{ flex: 1 }}>
            <Text variant="body">{t('settings.disableEmbedAutoplay')}</Text>
            <Text variant="bodySmall" color={theme.colors.text3}>
              {t('settings.disableEmbedAutoplayDesc')}
            </Text>
          </View>
          <Switch
            value={disableEmbedAutoplay}
            onValueChange={setDisableEmbedAutoplay}
            trackColor={{
              false: theme.colors.bgElev3,
              true: theme.colors.accentSoft,
            }}
            thumbColor={disableEmbedAutoplay ? theme.colors.accent : theme.colors.text3}
            ios_backgroundColor={theme.colors.bgElev3}
          />
        </View>

        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text variant="body">{t('settings.accentBackground')}</Text>
            <Text variant="bodySmall" color={theme.colors.text3}>
              {t('settings.accentBackgroundDesc')}
            </Text>
          </View>
          <Switch
            value={showAvatarBackground}
            onValueChange={setShowAvatarBackground}
            trackColor={{
              false: theme.colors.bgElev3,
              true: theme.colors.accentSoft,
            }}
            thumbColor={showAvatarBackground ? theme.colors.accent : theme.colors.text3}
            ios_backgroundColor={theme.colors.bgElev3}
          />
        </View>
      </View>
    </>
  );
}

function NsfwToggleRow({
  label,
  description,
  value,
  onValueChange,
  isLast,
}: {
  label: string;
  description: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  isLast?: boolean;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.row,
        !isLast && {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.lineSoft,
        },
      ]}
    >
      <View style={{ flex: 1 }}>
        <Text variant="body">{label}</Text>
        <Text variant="bodySmall" color={theme.colors.text3}>
          {description}
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: theme.colors.bgElev3, true: theme.colors.accentSoft }}
        thumbColor={value ? theme.colors.accent : theme.colors.text3}
        ios_backgroundColor={theme.colors.bgElev3}
      />
    </View>
  );
}

function ContentSocialSection() {
  const theme = useTheme();
  const { t } = useTranslation();
  const { allowNsfw, nsfwLewds, nsfwBlood, nsfwGore, loaded, loadPrefs, savePrefs } =
    useContentSocialStore();

  useEffect(() => {
    if (!loaded) void loadPrefs();
  }, [loaded, loadPrefs]);

  return (
    <>
      <SectionHeader title={t('settings.sectionContentSocial')} />

      {/* NSFW Filters */}
      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.bgElev1,
            borderRadius: theme.radius.lg,
            marginHorizontal: theme.spacing.lg,
          },
        ]}
      >
        <View style={styles.infoBlock}>
          <Text variant="subtitle">{t('settings.nsfwFilters')}</Text>
          <Text variant="bodySmall" color={theme.colors.text3}>
            {t('settings.nsfwFiltersDesc')}
          </Text>
        </View>
        <NsfwToggleRow
          label={t('settings.allowNsfw')}
          description={t('settings.allowNsfwDesc')}
          value={allowNsfw}
          onValueChange={(v) => void savePrefs({ allowNsfw: v })}
        />
      </View>

      {/* NSFW Subtags Comfort */}
      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.bgElev1,
            borderRadius: theme.radius.lg,
            marginHorizontal: theme.spacing.lg,
            marginTop: theme.spacing.lg,
          },
        ]}
      >
        <View style={styles.infoBlock}>
          <Text variant="subtitle">{t('settings.nsfwSubtags')}</Text>
          <Text variant="bodySmall" color={theme.colors.text3}>
            {t('settings.nsfwSubtagsDesc')}
          </Text>
        </View>
        <NsfwToggleRow
          label={t('settings.nsfwLewds')}
          description={t('settings.nsfwLewdsDesc')}
          value={nsfwLewds}
          onValueChange={(v) => void savePrefs({ nsfwLewds: v })}
        />
        <NsfwToggleRow
          label={t('settings.nsfwBlood')}
          description={t('settings.nsfwBloodDesc')}
          value={nsfwBlood}
          onValueChange={(v) => void savePrefs({ nsfwBlood: v })}
        />
        <NsfwToggleRow
          label={t('settings.nsfwGore')}
          description={t('settings.nsfwGoreDesc')}
          value={nsfwGore}
          onValueChange={(v) => void savePrefs({ nsfwGore: v })}
          isLast
        />
      </View>
    </>
  );
}

function NotificationSoundRow({
  label,
  description,
  enabled,
  volume,
  onToggle,
  onVolumeChange,
  onPreview,
  isLast,
}: {
  label: string;
  description: string;
  enabled: boolean;
  volume: number;
  onToggle: (value: boolean) => void;
  onVolumeChange: (value: number) => void;
  onPreview: () => void;
  isLast?: boolean;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <View
      style={[
        styles.soundRow,
        !isLast && {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.lineSoft,
        },
      ]}
    >
      <View style={styles.soundHeaderRow}>
        <View style={{ flex: 1 }}>
          <Text variant="body">{label}</Text>
          <Text variant="bodySmall" color={theme.colors.text3}>
            {description}
          </Text>
        </View>
        <Switch
          value={enabled}
          onValueChange={onToggle}
          trackColor={{ false: theme.colors.bgElev3, true: theme.colors.accentSoft }}
          thumbColor={enabled ? theme.colors.accent : theme.colors.text3}
          ios_backgroundColor={theme.colors.bgElev3}
        />
      </View>
      <View style={styles.soundControlsRow}>
        <Pressable
          haptic
          disabled={false}
          onPress={onPreview}
          style={[
            styles.previewBtn,
            {
              backgroundColor: theme.colors.bgElev2,
              borderColor: theme.colors.lineSoft,
              opacity: 1,
            },
          ]}
        >
          <Text variant="caption" color={theme.colors.text2}>{t('common.preview')}</Text>
        </Pressable>
        <View style={{ flex: 1, marginLeft: 10 }}>
          <Slider
            value={volume}
            minimumValue={0}
            maximumValue={100}
            step={1}
            onValueChange={onVolumeChange}
            minimumTrackTintColor={theme.colors.accent}
            maximumTrackTintColor={theme.colors.bgElev3}
            thumbTintColor={theme.colors.accent}
            disabled={!enabled}
          />
        </View>
        <Text variant="caption" color={theme.colors.text3} style={{ width: 40, textAlign: 'right' }}>
          {Math.round(volume)}%
        </Text>
      </View>
    </View>
  );
}

// ─── Zoomable image (pinch + pan + double-tap) ────────────────────────────────

function ZoomableImage({ uri, pageWidth, onZoomChange, zoomedShared }: {
  uri: string;
  pageWidth: number;
  onZoomChange: (zoomed: boolean) => void;
  zoomedShared: SharedValue<number>;
}) {
  const scale        = useSharedValue(1);
  const savedScale   = useSharedValue(1);
  const transX       = useSharedValue(0);
  const transY       = useSharedValue(0);
  const savedTransX  = useSharedValue(0);
  const savedTransY  = useSharedValue(0);

  const resetZoom = () => {
    'worklet';
    scale.value      = withSpring(1, { damping: 20 });
    transX.value     = withSpring(0, { damping: 20 });
    transY.value     = withSpring(0, { damping: 20 });
    savedScale.value = 1;
    savedTransX.value = 0;
    savedTransY.value = 0;
    zoomedShared.value = 0;
    runOnJS(onZoomChange)(false);
  };

  const pinch = Gesture.Pinch()
    .onStart(() => { savedScale.value = scale.value; })
    .onUpdate((e) => {
      scale.value = Math.min(Math.max(savedScale.value * e.scale, 1), 6);
    })
    .onEnd(() => {
      if (scale.value < 1.1) {
        resetZoom();
      } else {
        savedScale.value = scale.value;
        zoomedShared.value = 1;
        runOnJS(onZoomChange)(true);
      }
    });

  const pan = Gesture.Pan()
    .averageTouches(true)
    .minPointers(1)
    .manualActivation(true)
    .onTouchesMove((event, stateManager) => {
      if (event.numberOfTouches > 1 || scale.value > 1.01) {
        stateManager.activate();
        return;
      }
      stateManager.fail();
    })
    .onStart(() => {
      savedTransX.value = transX.value;
      savedTransY.value = transY.value;
    })
    .onUpdate((e) => {
      if (scale.value > 1) {
        const panFactor = 1 / Math.sqrt(scale.value);
        transX.value = savedTransX.value + e.translationX * panFactor;
        transY.value = savedTransY.value + e.translationY * panFactor;
      }
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (scale.value > 1) {
        resetZoom();
      } else {
        scale.value      = withSpring(2.5, { damping: 20 });
        savedScale.value = 2.5;
        zoomedShared.value = 1;
        runOnJS(onZoomChange)(true);
      }
    });

  const composed = Gesture.Race(
    doubleTap,
    Gesture.Simultaneous(pinch, pan),
  );

  const animStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: scale.value },
      { translateX: transX.value },
      { translateY: transY.value },
    ],
  }));

  return (
    <GestureDetector gesture={composed}>
      <View style={[styles.galleryPage, { width: pageWidth, overflow: 'visible' }]}>
        <Reanimated.View style={[{ width: '100%', height: '100%' }, animStyle]}>
          <Image source={{ uri }} style={styles.galleryImage} resizeMode="contain" />
        </Reanimated.View>
      </View>
    </GestureDetector>
  );
}

// ─── Cat Cache gallery lightbox ───────────────────────────────────────────────

function CacheGallery({ files, initialIndex, scopeLabel, onClose }: {
  files: string[];
  initialIndex: number;
  scopeLabel: string;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const { width: pageWidth, height: pageHeight } = useWindowDimensions();
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isZoomed, setIsZoomed] = useState(false);
  const dragY = useSharedValue(0);
  const isZoomedShared = useSharedValue(0);

  const currentFile = files[currentIndex] ?? files[0];
  const pageLabel = files.length > 1 ? `${currentIndex + 1}/${files.length}` : null;

  const handleZoomChange = useCallback((zoomed: boolean) => {
    setIsZoomed(zoomed);
    if (zoomed) setMenuOpen(false);
  }, []);

  const onScrollEnd = useCallback((e: { nativeEvent: { contentOffset: { x: number }; layoutMeasurement: { width: number } } }) => {
    const w = e.nativeEvent.layoutMeasurement.width || 1;
    setCurrentIndex(Math.round(e.nativeEvent.contentOffset.x / w));
    setIsZoomed(false);
    isZoomedShared.value = 0;
  }, [isZoomedShared]);

  const dismissGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!isZoomed)
        .maxPointers(1)
        .activeOffsetY([-8, 8])
        .failOffsetX([-16, 16])
        .onUpdate((event) => {
          if (isZoomedShared.value > 0) return;
          dragY.value = event.translationY;
        })
        .onEnd((event) => {
          if (isZoomedShared.value > 0) return;
          const shouldClose = Math.abs(event.translationY) > 72 || Math.abs(event.velocityY) > 850;
          if (shouldClose) {
            const target = event.translationY > 0 ? pageHeight : -pageHeight;
            dragY.value = withTiming(target, { duration: 160 }, (finished) => {
              if (!finished) return;
              runOnJS(onClose)();
            });
            return;
          }
          dragY.value = withSpring(0, { damping: 20, stiffness: 220 });
        }),
    [dragY, isZoomed, isZoomedShared, onClose, pageHeight],
  );

  const dragStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: dragY.value }],
    opacity: interpolate(Math.abs(dragY.value), [0, pageHeight * 0.55], [1, 0.86]),
  }));
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(Math.abs(dragY.value), [0, pageHeight * 0.55], [1, 0.3]),
  }));

  const onSave = useCallback(() => {
    setMenuOpen(false);
    void (async () => {
      try {
        const perms = await MediaLibrary.requestPermissionsAsync(true);
        if (perms.granted) {
          await MediaLibrary.Asset.create(currentFile);
          Alert.alert(t('settings.savedTitle'), t('settings.savedMsg'));
        } else {
          const available = await Sharing.isAvailableAsync();
          if (available) await Sharing.shareAsync(currentFile, { dialogTitle: t('settings.saveImageDialogTitle') });
        }
      } catch {
        Alert.alert(t('settings.saveFailedTitle'), t('settings.saveFailedMsg'));
      }
    })();
  }, [currentFile, t]);

  const onShare = useCallback(() => {
    setMenuOpen(false);
    void (async () => {
      try {
        const available = await Sharing.isAvailableAsync();
        if (available) await Sharing.shareAsync(currentFile, { dialogTitle: t('settings.shareImageDialogTitle') });
      } catch {
        Alert.alert(t('settings.shareFailedTitle'), t('settings.shareFailedMsg'));
      }
    })();
  }, [currentFile, t]);

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}>
      <GestureDetector gesture={dismissGesture}>
      <View style={styles.galleryRoot}>
        <Reanimated.View style={[styles.galleryScrim, { backgroundColor: theme.colors.scrim }, scrimStyle]} pointerEvents="none" />

        {/* Image pager — scroll locked while zoomed in */}
        <Reanimated.View style={[{ flex: 1 }, dragStyle]}>
        <FlatList
          data={files}
          horizontal
          pagingEnabled
          directionalLockEnabled
          bounces={false}
          showsHorizontalScrollIndicator={false}
          scrollEnabled={!isZoomed}
          initialScrollIndex={initialIndex}
          getItemLayout={(_, index) => ({ length: pageWidth, offset: pageWidth * index, index })}
          keyExtractor={(item) => item}
          onMomentumScrollEnd={onScrollEnd}
          style={{ flex: 1 }}
          renderItem={({ item }) => (
            <ZoomableImage
              uri={item}
              pageWidth={pageWidth}
              onZoomChange={handleZoomChange}
              zoomedShared={isZoomedShared}
            />
          )}
        />
        </Reanimated.View>

        {/* Header and chrome — hidden while zoomed */}
        {!isZoomed && (
          <>
            {/* Header: X | scopeLabel | ... */}
            <View style={styles.galleryHeader}>
              <Pressable style={styles.galleryHeaderBtn} onPress={onClose}>
                <X size={22} color={theme.colors.text} />
              </Pressable>
              <Text numberOfLines={1} style={[styles.galleryTitle, { color: theme.colors.text }]}>
                {scopeLabel}
              </Text>
              <Pressable style={styles.galleryHeaderBtn} onPress={() => setMenuOpen((p) => !p)}>
                <Ellipsis size={22} color={theme.colors.text} />
              </Pressable>
            </View>

            {/* Page counter pill */}
            {pageLabel ? (
              <View style={[styles.galleryPageTag, { backgroundColor: theme.colors.bgElev1, borderColor: theme.colors.lineSoft }]}>
                <Text variant="caption" color={theme.colors.text3}>{pageLabel}</Text>
              </View>
            ) : null}

            {/* Three-dot menu */}
            {menuOpen ? <Pressable style={styles.galleryMenuDismiss} onPress={() => setMenuOpen(false)}><View /></Pressable> : null}
            {menuOpen ? (
              <View style={[styles.galleryMenu, { backgroundColor: theme.colors.bgElev1, borderColor: theme.colors.lineSoft }]}>
                <Pressable style={styles.galleryMenuItem} onPress={onSave}>
                  <Text>{t('settings.saveToPhotos')}</Text>
                </Pressable>
                <Pressable style={styles.galleryMenuItem} onPress={onShare}>
                  <Text>{t('settings.share')}</Text>
                </Pressable>
              </View>
            ) : null}
          </>
        )}
      </View>
      </GestureDetector>
    </Modal>
  );
}

// ─── Cat Cache tree node ───────────────────────────────────────────────────────

function CacheTreeNode({
  scope, label, size, count, clearing, onClear,
}: {
  scope: string;
  label: string;
  size: number;
  count: number;
  clearing: boolean;
  onClear: () => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const { width: screenWidth } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<string[] | null>(null);
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null);

  useEffect(() => {
    if (open && files === null) {
      void getCacheScopeFiles(scope).then(setFiles);
    }
  }, [open, scope, files]);

  const isAvatar = scope === 'Central/Avatars';

  // 3-column grid thumb size: account for treeCard margin (lg*2=32), content padding (12*2=24), gaps (2*4=8)
  const COLS = 3;
  const GRID_GAP = 4;
  const thumbSize = Math.floor((screenWidth - 32 - 24 - GRID_GAP * (COLS - 1)) / COLS);

  return (
    <>
      {/* Header row */}
      <View style={[styles.treeRow, { borderColor: theme.colors.lineSoft }]}>
        <Pressable
          onPress={() => setOpen((o) => !o)}
          style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}
        >
          {open
            ? <ChevronDown size={16} color={theme.colors.text3} />
            : <ChevronRight size={16} color={theme.colors.text3} />
          }
          <Text variant="bodySmall" color={theme.colors.text2} style={{ flex: 1 }}>
            {label}
          </Text>
          <View style={[styles.countBadge, { backgroundColor: theme.colors.bgElev2 }]}>
            <Text variant="caption" color={theme.colors.text3}>{files !== null ? files.length : count}</Text>
          </View>
          <Text variant="bodySmall" color={theme.colors.text3} style={{ marginRight: 8 }}>
            {formatBytes(size)}
          </Text>
        </Pressable>
        <Pressable haptic onPress={onClear} disabled={clearing}>
          <Text variant="caption" color={clearing ? theme.colors.text3 : theme.colors.danger}>
            {clearing ? '…' : t('common.clear')}
          </Text>
        </Pressable>
      </View>

      {/* Expanded gallery grid */}
      {open && (
        <View style={[styles.treeContent, { backgroundColor: theme.colors.bgApp, borderColor: theme.colors.lineSoft }]}>
          {files === null ? (
            <ActivityIndicator size="small" color={theme.colors.accent} />
          ) : files.length === 0 ? (
            <Text variant="caption" color={theme.colors.text3} style={{ fontStyle: 'italic' }}>
              {t('settings.cacheEmpty')}
            </Text>
          ) : (
            <View style={styles.galleryGrid}>
              {files.map((f, i) => (
                <Pressable
                  key={f}
                  onPress={() => setGalleryIndex(i)}
                  style={[
                    styles.gridThumbWrap,
                    { width: thumbSize, height: thumbSize },
                  ]}
                >
                  <Image
                    source={{ uri: f }}
                    style={[
                      styles.gridThumb,
                      {
                        width: thumbSize,
                        height: thumbSize,
                        borderRadius: isAvatar ? thumbSize / 2 : 6,
                        borderColor: theme.colors.lineSoft,
                      },
                    ]}
                    resizeMode="cover"
                  />
                </Pressable>
              ))}
            </View>
          )}
        </View>
      )}

      {galleryIndex !== null && files !== null && (
        <CacheGallery
          files={files}
          initialIndex={galleryIndex}
          scopeLabel={label}
          onClose={() => setGalleryIndex(null)}
        />
      )}
    </>
  );
}

// ─── Storage section ───────────────────────────────────────────────────────────

function StorageSection() {
  const theme = useTheme();
  const { t } = useTranslation();
  const servers = useServerStore((s) => s.servers);
  const [totalSize, setTotalSize] = useState<number | null>(null);
  const [entries, setEntries] = useState<{ scope: string; label: string; size: number; count: number }[]>([]);
  const [clearing, setClearing] = useState<string | null>(null);
  const [limitsOpen, setLimitsOpen] = useState(false);

  const ugcImageCapMb = useSettingsStore((s) => s.ugcImageCapMb);
  const ugcVideoCapMb = useSettingsStore((s) => s.ugcVideoCapMb);
  const setUgcImageCapMb = useSettingsStore((s) => s.setUgcImageCapMb);
  const setUgcVideoCapMb = useSettingsStore((s) => s.setUgcVideoCapMb);

  // Sync caps to imageCache module whenever settings change
  useEffect(() => { setCacheCaps(ugcImageCapMb, ugcVideoCapMb); }, [ugcImageCapMb, ugcVideoCapMb]);

  const load = useCallback(async () => {
    const [size, breakdown] = await Promise.all([getCacheSize(), getCacheScopeBreakdown()]);
    setTotalSize(size);
    setEntries(
      breakdown.map((e) => {
        let label = e.scope;
        if (e.scope.startsWith('Realms/')) {
          const hash = e.scope.slice('Realms/'.length);
          const match = servers.find((s) => s.url && originHashForUrl(s.url) === hash);
          label = match ? `Realm: ${match.name}` : `Realm: ${hash.slice(0, 8)}`;
        } else if (e.scope === 'Central/Avatars') label = 'Central · Avatars';
        else if (e.scope === 'Central/DMs') label = 'Central · DMs';
        else if (e.scope === 'Central/Emotes') label = 'Central · Emotes';
        else if (e.scope === 'Central/Icons') label = 'Central · Icons';
        return { ...e, label };
      }),
    );
  }, [servers]);

  useEffect(() => { void load(); }, [load]);

  const handleClearScope = (scope: string, label: string) => {
    Alert.alert(
      t('settings.clearScopeTitle', { label }),
      t('settings.clearScopeMsg'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.clear'),
          style: 'destructive',
          onPress: async () => {
            setClearing(scope);
            await clearCacheScope(scope);
            await load();
            setClearing(null);
          },
        },
      ],
    );
  };

  const handleClearAll = () => {
    Alert.alert(
      t('settings.clearAllCacheTitle'),
      t('settings.clearAllCacheMsg'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('settings.clearAll'),
          style: 'destructive',
          onPress: async () => {
            setClearing('all');
            await clearImageCache();
            setTotalSize(0);
            setEntries([]);
            setClearing(null);
          },
        },
      ],
    );
  };

  return (
    <>
      <SectionHeader title={t('settings.sectionCacheSettings')} />

      {/* Cache Limits collapsible panel */}
      <View style={[styles.card, { backgroundColor: theme.colors.bgElev1, borderRadius: theme.radius.lg, marginHorizontal: theme.spacing.lg }]}>
        <Pressable
          haptic
          onPress={() => setLimitsOpen((o) => !o)}
          style={[styles.row, { paddingVertical: 12 }]}
        >
          <View style={{ flex: 1 }}>
            <Text variant="body">{t('settings.cacheLimits')}</Text>
            <Text variant="bodySmall" color={theme.colors.text3}>
              {t('settings.cacheLimitsDesc')}
            </Text>
          </View>
          {limitsOpen
            ? <ChevronUp size={18} color={theme.colors.text3} />
            : <ChevronDown size={18} color={theme.colors.text3} />
          }
        </Pressable>

        {limitsOpen && (
          <View style={{ paddingBottom: 12, paddingHorizontal: 4 }}>
            <View style={{ marginTop: 4 }}>
              <View style={[styles.row, { paddingHorizontal: 8 }]}>
                <Text variant="bodySmall" color={theme.colors.text2} style={{ flex: 1 }}>{t('settings.cacheImages')}</Text>
                <Text variant="bodySmall" color={theme.colors.text3}>{ugcImageCapMb} MB</Text>
              </View>
              <Slider
                minimumValue={50}
                maximumValue={500}
                step={10}
                value={ugcImageCapMb}
                onSlidingComplete={(v) => setUgcImageCapMb(Math.round(v))}
                minimumTrackTintColor={theme.colors.accent}
                maximumTrackTintColor={theme.colors.lineSoft}
                thumbTintColor={theme.colors.accent}
                style={{ marginHorizontal: 8, marginTop: 4 }}
              />
            </View>

            <View style={{ marginTop: 12 }}>
              <View style={[styles.row, { paddingHorizontal: 8 }]}>
                <Text variant="bodySmall" color={theme.colors.text2} style={{ flex: 1 }}>{t('settings.cacheVideos')}</Text>
                <Text variant="bodySmall" color={theme.colors.text3}>{ugcVideoCapMb} MB</Text>
              </View>
              <Slider
                minimumValue={50}
                maximumValue={2000}
                step={50}
                value={ugcVideoCapMb}
                onSlidingComplete={(v) => setUgcVideoCapMb(Math.round(v))}
                minimumTrackTintColor={theme.colors.accent}
                maximumTrackTintColor={theme.colors.lineSoft}
                thumbTintColor={theme.colors.accent}
                style={{ marginHorizontal: 8, marginTop: 4 }}
              />
            </View>
          </View>
        )}
      </View>

      <SectionHeader title={t('settings.sectionCatBox')} />

      {/* Summary card */}
      <View style={[styles.card, { backgroundColor: theme.colors.bgElev1, borderRadius: theme.radius.lg, marginHorizontal: theme.spacing.lg }]}>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text variant="body">{t('settings.totalCached')}</Text>
            <Text variant="bodySmall" color={theme.colors.text3}>
              {t('settings.totalCachedDesc')}
            </Text>
          </View>
          <Text variant="body" color={theme.colors.text2}>
            {totalSize === null ? '…' : formatBytes(totalSize)}
          </Text>
        </View>
      </View>

      {/* Tree nodes */}
      {entries.length > 0 && (
        <View style={[styles.treeCard, { backgroundColor: theme.colors.bgElev1, borderColor: theme.colors.lineSoft, marginHorizontal: theme.spacing.lg }]}>
          {entries.map((entry, i) => (
            <View key={entry.scope} style={i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.lineSoft } : undefined}>
              <CacheTreeNode
                scope={entry.scope}
                label={entry.label}
                size={entry.size}
                count={entry.count}
                clearing={clearing === entry.scope}
                onClear={() => handleClearScope(entry.scope, entry.label)}
              />
            </View>
          ))}
        </View>
      )}

      {/* Clear all */}
      <View style={[styles.card, { backgroundColor: theme.colors.bgElev1, borderRadius: theme.radius.lg, marginHorizontal: theme.spacing.lg }]}>
        <View style={styles.row}>
          <Pressable haptic onPress={handleClearAll} disabled={clearing !== null} style={{ flex: 1 }}>
            <Text variant="body" color={clearing === 'all' ? theme.colors.text3 : theme.colors.danger}>
              {clearing === 'all' ? t('common.clearing') : t('settings.clearAllCache')}
            </Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}


type MobileUserDevice = {
  id: string;
  deviceName: string;
  platform: 'desktop' | 'web' | 'ios' | 'android';
  browserName: string | null;
  dmTrustState: 'untrusted' | 'trusted' | 'revoked';
  deviceSecurity?: 'software_protected' | 'platform_protected' | 'passkey_protected' | 'security_key_protected';
  boundWebAuthnCredentialId?: string | null;
  lastProofAt?: number | null;
  proofRequiredOnLaunch?: boolean;
  pushCapable: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
};

type MobilePasskeyCredential = {
  id: string;
  name: string;
  createdAt: number;
  transports: string[];
  rpId?: string;
};

function passkeyErrorMessage(err: unknown, fallback: string) {
  return axios.isAxiosError(err)
    ? (err.response?.data?.error ?? fallback)
    : (err instanceof Error ? err.message : fallback);
}

async function openHostedPasskeyUrl(url: string) {
  const supported = await Linking.canOpenURL(url);
  if (!supported) throw new Error('This device cannot open the CatRealm passkey page.');
  await Linking.openURL(url);
}

async function pollHostedFlow<T>(
  api: ReturnType<typeof createAuthenticatedApi>,
  statusUrl: string,
  onComplete: (data: any) => T | Promise<T>,
  timeoutMs = 10 * 60 * 1000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const statusRes = await api.get(statusUrl);
    if (statusRes.data.status === 'complete') {
      return onComplete(statusRes.data);
    }
    if (statusRes.data.status === 'failed') {
      throw new Error(statusRes.data.error || 'Passkey flow failed.');
    }
  }
  throw new Error('Passkey flow timed out. Return here and try again if the browser is still open.');
}

function deviceSecurityLabel(device: MobileUserDevice) {
  if (device.revokedAt || device.dmTrustState === 'revoked') return 'revoked';
  if (device.dmTrustState !== 'trusted') return 'untrusted for encrypted DMs';
  switch (device.deviceSecurity) {
    case 'platform_protected':
      return 'trusted · device passkey protected';
    case 'passkey_protected':
      return 'trusted · passkey protected';
    case 'security_key_protected':
      return 'trusted · security-key protected';
    default:
      return 'trusted · software protected';
  }
}

function AccountPasskeysSection() {
  const theme = useTheme();
  const { t } = useTranslation();
  const user = useAuthStore((state) => state.user);
  const [credentials, setCredentials] = useState<MobilePasskeyCredential[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (user?.accountType !== 'central') return;
    setError(null);
    try {
      const [deviceId, response] = await Promise.all([
        getLocalDeviceId(),
        createAuthenticatedApi().get<{ credentials: MobilePasskeyCredential[] }>('/api/security/webauthn/credentials'),
      ]);
      setCurrentDeviceId(deviceId);
      setCredentials(response.data.credentials);
    } catch (err) {
      setError(passkeyErrorMessage(err, t('settings.passkeyLoadFailed')));
    } finally {
      setLoaded(true);
    }
  }, [t, user?.accountType]);

  useEffect(() => { void load(); }, [load]);

  const registerPasskey = useCallback(async () => {
    setRegistering(true);
    setError(null);
    try {
      const deviceId = currentDeviceId ?? await getLocalDeviceId();
      setCurrentDeviceId(deviceId);
      const api = createAuthenticatedApi();
      const startRes = await api.post('/api/security/webauthn/desktop/register/start', {
        name: Platform.OS === 'ios' ? 'iPhone Passkey' : 'Android Passkey',
        deviceId,
      });
      const flowId = String(startRes.data.flowId || '');
      const hostedUrl = new URL(startRes.data.url, AUTH_BASE).toString();
      await openHostedPasskeyUrl(hostedUrl);
      await pollHostedFlow(api, `/api/security/webauthn/desktop/register/${encodeURIComponent(flowId)}/status`, async () => {
        const listRes = await api.get<{ credentials: MobilePasskeyCredential[] }>('/api/security/webauthn/credentials');
        setCredentials(listRes.data.credentials);
      });
    } catch (err) {
      setError(passkeyErrorMessage(err, t('settings.passkeyRegisterFailed')));
    } finally {
      setRegistering(false);
    }
  }, [currentDeviceId, t]);

  const removePasskey = useCallback(async (id: string) => {
    setRemovingId(id);
    setError(null);
    try {
      const deviceId = currentDeviceId ?? await getLocalDeviceId();
      setCurrentDeviceId(deviceId);
      const api = createAuthenticatedApi();
      try {
        await api.delete(`/api/security/webauthn/credentials/${id}`, { data: { deviceId } });
      } catch (err) {
        const status = axios.isAxiosError(err) ? err.response?.status : null;
        const data = axios.isAxiosError(err) ? err.response?.data : null;
        if (status !== 409 || !data?.downgradeAvailable) throw err;
        const names = Array.isArray(data.boundDevices)
          ? data.boundDevices.map((device: { deviceName?: string }) => device.deviceName).filter(Boolean).join(', ')
          : '';
        const confirm = await new Promise<boolean>((resolve) => {
          Alert.alert(
            t('settings.removePasskeyTitle'),
            t('settings.removePasskeyMsg', { names: names || t('settings.oneOrMoreDevices') }),
            [
              { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
              { text: t('common.remove'), style: 'destructive', onPress: () => resolve(true) },
            ],
          );
        });
        if (!confirm) return;
        await api.delete(`/api/security/webauthn/credentials/${id}?downgrade=1`, { data: { deviceId } });
      }
      setCredentials((prev) => prev.filter((entry) => entry.id !== id));
    } catch (err) {
      setError(passkeyErrorMessage(err, t('settings.passkeyRemoveFailed')));
    } finally {
      setRemovingId(null);
    }
  }, [currentDeviceId, t]);

  if (user?.accountType !== 'central') return null;

  return (
    <>
      <SectionHeader title={t('settings.sectionPasskeys')} />
      <View style={[styles.card, { backgroundColor: theme.colors.bgElev1, borderRadius: theme.radius.lg, marginHorizontal: theme.spacing.lg }]}>
        <View style={[styles.infoBlock, { gap: 8 }]}>
          <Text variant="bodySmall" color={theme.colors.text3}>
            {t('settings.passkeysDesc')}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable haptic onPress={() => void registerPasskey()} disabled={registering} style={[styles.smallActionBtn, { borderColor: theme.colors.lineSoft }]}>
              <Text variant="bodySmall" color={theme.colors.text2}>{registering ? t('settings.waitingPasskey') : t('settings.registerPasskey')}</Text>
            </Pressable>
            <Pressable haptic onPress={() => void load()} style={[styles.smallActionBtn, { borderColor: theme.colors.lineSoft }]}>
              <Text variant="bodySmall" color={theme.colors.text2}>{t('common.refresh')}</Text>
            </Pressable>
          </View>
          {error ? <Text variant="bodySmall" color={theme.colors.danger}>{error}</Text> : null}
        </View>
        {loaded && credentials.length === 0 ? (
          <View style={[styles.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.lineSoft }]}>
            <Text variant="bodySmall" color={theme.colors.text3}>{t('settings.noPasskeys')}</Text>
          </View>
        ) : null}
        {credentials.map((credential, index) => (
          <View key={credential.id} style={[styles.row, { alignItems: 'center' }, (index > 0 || loaded) ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.lineSoft } : null]}>
            <KeyRound size={18} color={theme.colors.text3} />
            <View style={{ flex: 1, marginLeft: theme.spacing.md }}>
              <Text variant="body" numberOfLines={1}>{credential.name || 'Passkey'}</Text>
              <Text variant="bodySmall" color={theme.colors.text3}>
                {credential.rpId || 'auth.catrealm.app'} · {t('settings.passkeyAdded')} {new Date(credential.createdAt * 1000).toLocaleDateString()}
              </Text>
            </View>
            <Pressable haptic onPress={() => void removePasskey(credential.id)} disabled={removingId === credential.id} style={{ padding: 8 }}>
              {removingId === credential.id
                ? <ActivityIndicator size="small" color={theme.colors.text3} />
                : <Trash2 size={18} color={theme.colors.danger} />}
            </Pressable>
          </View>
        ))}
      </View>
    </>
  );
}

function AccountDevicesSection() {
  const theme = useTheme();
  const { t } = useTranslation();
  const user = useAuthStore((state) => state.user);
  const [devices, setDevices] = useState<MobileUserDevice[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [selfApprovingId, setSelfApprovingId] = useState<string | null>(null);
  const [selfApprovalCode, setSelfApprovalCode] = useState('');
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pushDiagnostic, setPushDiagnostic] = useState<NotificationPreviewDiagnostic | null>(null);
  const [pushReadiness, setPushReadiness] = useState<NotificationPreviewLocalReadiness | null>(null);

  const load = useCallback(async () => {
    if (user?.accountType !== 'central') return;
    setLoading(true);
    setError(null);
    try {
      const [id, response] = await Promise.all([
        getLocalDeviceId(),
        createAuthenticatedApi().get<{ devices: MobileUserDevice[] }>('/api/devices'),
      ]);
      setCurrentDeviceId(id);
      setDevices(response.data.devices);
      const [diagnostic, readiness] = await Promise.all([
        getLatestNotificationPreviewDiagnostic(),
        getNotificationPreviewLocalReadiness(),
      ]);
      setPushDiagnostic(diagnostic);
      setPushReadiness(readiness);
    } catch (err) {
      setError(axios.isAxiosError(err) ? (err.response?.data?.error ?? t('settings.devicesLoadFailed')) : t('settings.devicesLoadFailed'));
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [t, user?.accountType]);

  useEffect(() => { void load(); }, [load]);

  const retryRegistration = useCallback(async () => {
    setRegistering(true);
    setError(null);
    try {
      await registerCurrentDevice();
      await load();
    } catch (err) {
      setError(axios.isAxiosError(err) ? (err.response?.data?.error ?? t('settings.deviceRegFailed')) : (err instanceof Error ? err.message : t('settings.deviceRegFailed')));
    } finally {
      setRegistering(false);
    }
  }, [load, t]);

  const renameInFlight = useRef(false);
  const saveRename = useCallback(async () => {
    // onSubmitEditing also blurs the input — ref guard so one save can't fire
    // twice (state updates land too late to stop the immediate blur call).
    if (renameInFlight.current) return;
    const targetId = renameId;
    const name = renameDraft.trim();
    if (!targetId) return;
    if (!name) { setRenameId(null); return; }
    renameInFlight.current = true;
    setRenaming(true);
    setError(null);
    try {
      const r = await createAuthenticatedApi().patch<{ device: MobileUserDevice }>(`/api/devices/${targetId}`, { deviceName: name });
      setDevices((prev) => prev.map((entry) => entry.id === r.data.device.id ? r.data.device : entry));
      setRenameId(null);
    } catch (err) {
      setError(axios.isAxiosError(err) ? (err.response?.data?.error ?? t('settings.deviceRenameFailed')) : t('settings.deviceRenameFailed'));
    } finally {
      renameInFlight.current = false;
      setRenaming(false);
    }
  }, [renameId, renameDraft, t]);

  const approveThisDeviceWithPasskey = useCallback(async (deviceId: string) => {
    setSelfApprovingId(deviceId);
    setError(null);
    try {
      const api = createAuthenticatedApi();
      const startRes = await api.post('/api/security/webauthn/desktop/device-approval/start', { deviceId });
      if (startRes.data?.alreadyTrusted) {
        await load();
        return;
      }
      const flowId = String(startRes.data.flowId || '');
      const hostedUrl = new URL(startRes.data.url, AUTH_BASE).toString();
      await openHostedPasskeyUrl(hostedUrl);
      await pollHostedFlow(api, `/api/security/webauthn/desktop/device-approval/${encodeURIComponent(flowId)}/status`, (data) => {
        if (data.device) {
          setDevices((prev) => prev.map((entry) => entry.id === data.device.id ? data.device : entry));
        }
      });
    } catch (err) {
      setError(passkeyErrorMessage(err, t('settings.deviceApproveFailed')));
    } finally {
      setSelfApprovingId(null);
    }
  }, [load, t]);

  const approveThisDeviceWith2FA = useCallback(async (deviceId: string) => {
    if (deviceId !== currentDeviceId) return;
    setSelfApprovingId(deviceId);
    setError(null);
    try {
      await approveSurvivingDevice(selfApprovalCode);
      setSelfApprovalCode('');
      await load();
    } catch (err) {
      setError(axios.isAxiosError(err) ? (err.response?.data?.error ?? t('settings.deviceApproveFailed')) : (err instanceof Error ? err.message : t('settings.deviceApproveFailed')));
    } finally {
      setSelfApprovingId(null);
    }
  }, [currentDeviceId, selfApprovalCode, load, t]);

  const clearPushDiagnostic = useCallback(async () => {
    await clearLatestNotificationPreviewDiagnostic();
    setPushDiagnostic(null);
  }, []);

  if (user?.accountType !== 'central') return null;

  function DeviceIcon({ platform }: { platform: MobileUserDevice['platform'] }) {
    if (platform === 'ios' || platform === 'android') return <Smartphone size={18} color={theme.colors.text3} />;
    if (platform === 'web') return <Globe size={18} color={theme.colors.text3} />;
    return <Laptop size={18} color={theme.colors.text3} />;
  }

  function getPushDiagnosticHint(diagnostic: NotificationPreviewDiagnostic | null) {
    switch (diagnostic?.status) {
      case 'started':
        return 'The extension started but did not finish before this snapshot was read.';
      case 'missing_envelope':
        return 'The extension ran, but the push did not include an encrypted preview envelope.';
      case 'decrypt_failed':
        return 'The extension saw the envelope but could not decrypt it with this device key.';
      case 'invalid_payload':
        return 'The extension decrypted data, but the payload shape was not a usable DM preview.';
      case 'decrypt_success':
        return 'The preview decrypted; delivery may still be in progress or have timed out.';
      case 'delivered':
        return 'The extension finished. Compare the delivered title/body here with what iOS showed.';
      default:
        return 'Send a DM while the app is backgrounded, then refresh this page.';
    }
  }

  return (
    <>
      <SectionHeader title={t('settings.sectionDevices')} />
      <View style={[styles.card, { backgroundColor: theme.colors.bgElev1, borderRadius: theme.radius.lg, marginHorizontal: theme.spacing.lg }]}>
        <View style={[styles.infoBlock, { gap: 8 }]}>
          <Text variant="bodySmall" color={theme.colors.text3}>
            {t('settings.devicesDesc')}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable haptic onPress={() => void load()} disabled={loading} style={[styles.smallActionBtn, { borderColor: theme.colors.lineSoft }]}>
              <Text variant="bodySmall" color={theme.colors.text2}>{loading ? t('common.refreshing') : t('common.refresh')}</Text>
            </Pressable>
            <Pressable haptic onPress={() => void retryRegistration()} disabled={registering} style={[styles.smallActionBtn, { borderColor: theme.colors.lineSoft }]}>
              <Text variant="bodySmall" color={theme.colors.text2}>{registering ? t('common.registering') : t('settings.retryDevice')}</Text>
            </Pressable>
          </View>
          {error ? <Text variant="bodySmall" color={theme.colors.danger}>{error}</Text> : null}
          {Platform.OS === 'ios' ? (
            <View style={{ gap: 4, paddingTop: 4 }}>
              <Text variant="bodySmall" color={theme.colors.text2}>{t('settings.iosDiagnostic')}</Text>
              {pushReadiness ? (
                <Text variant="bodySmall" color={theme.colors.text3}>
                  app shared keys: device ID {pushReadiness.hasSharedDeviceId ? 'yes' : 'no'} · preview key {pushReadiness.hasSharedNotificationPrivateKey ? 'yes' : 'no'}
                </Text>
              ) : null}
              {pushDiagnostic ? (
                <>
                  <Text variant="bodySmall" color={pushDiagnostic.status === 'delivered' ? theme.colors.accent : theme.colors.text3}>
                    Last NSE status: {pushDiagnostic.status ?? 'unknown'}
                  </Text>
                  <Text variant="bodySmall" color={theme.colors.text3}>
                    {typeof pushDiagnostic.updatedAtMs === 'number'
                      ? `Updated ${new Date(pushDiagnostic.updatedAtMs).toLocaleString()}`
                      : 'No timestamp recorded'}
                  </Text>
                  <Text variant="bodySmall" color={theme.colors.text3}>
                    envelope {pushDiagnostic.hasEnvelope ? 'yes' : 'no / unknown'} · avatar URL {pushDiagnostic.hasAvatarUrl ? 'yes' : 'no / unknown'} · attachments {pushDiagnostic.attachmentCount ?? '—'}
                  </Text>
                  <Text variant="bodySmall" color={theme.colors.text3}>
                    {getPushDiagnosticHint(pushDiagnostic)}
                  </Text>
                  {pushDiagnostic.status === 'delivered' ? (
                    <Text variant="bodySmall" color={theme.colors.text3}>
                      delivered title “{pushDiagnostic.title || '—'}” · body “{pushDiagnostic.body || '—'}”
                    </Text>
                  ) : null}
                  <Pressable haptic onPress={() => void clearPushDiagnostic()} style={[styles.smallActionBtn, { alignSelf: 'flex-start', borderColor: theme.colors.lineSoft }]}>
                    <Text variant="bodySmall" color={theme.colors.text2}>{t('settings.clearDiagnostic')}</Text>
                  </Pressable>
                </>
              ) : (
                <Text variant="bodySmall" color={theme.colors.text3}>
                  No Notification Service Extension run has been recorded yet on this install. {getPushDiagnosticHint(null)}
                </Text>
              )}
            </View>
          ) : null}
        </View>
        {loaded && devices.length === 0 ? (
          <View style={[styles.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.lineSoft }]}>
            <Text variant="bodySmall" color={theme.colors.text3}>{t('settings.noDevices')}</Text>
          </View>
        ) : null}
        {devices.map((device, index) => {
          const current = device.id === currentDeviceId;
          const revoked = Boolean(device.revokedAt);
          const canSelfApproveWithPasskey = current && device.dmTrustState === 'untrusted';
          return (
            <View key={device.id} style={[styles.row, { alignItems: 'flex-start' }, (index > 0 || loaded) ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.lineSoft } : null]}>
              <DeviceIcon platform={device.platform} />
              <View style={{ flex: 1, marginLeft: theme.spacing.md }}>
                {renameId === device.id ? (
                  <TextInput
                    value={renameDraft}
                    onChangeText={setRenameDraft}
                    maxLength={80}
                    autoFocus
                    editable={!renaming}
                    onSubmitEditing={() => void saveRename()}
                    onBlur={() => void saveRename()}
                    returnKeyType="done"
                    style={{
                      borderWidth: 1,
                      borderColor: theme.colors.lineSoft,
                      borderRadius: 8,
                      paddingHorizontal: 8,
                      paddingVertical: 4,
                      color: theme.colors.text,
                      fontSize: 15,
                    }}
                  />
                ) : (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text variant="body" numberOfLines={1} style={{ flexShrink: 1 }}>
                      {device.deviceName}{current ? t('settings.thisDevice') : ''}
                    </Text>
                    {!revoked && (
                      <Pressable
                        haptic
                        onPress={() => { setError(null); setRenameDraft(device.deviceName); setRenameId(device.id); }}
                        accessibilityLabel={t('settings.renameDevice')}
                        hitSlop={8}
                      >
                        <Pencil size={14} color={theme.colors.text3} />
                      </Pressable>
                    )}
                  </View>
                )}
                <Text variant="bodySmall" color={revoked ? theme.colors.danger : device.dmTrustState === 'trusted' ? theme.colors.accent : theme.colors.text3}>
                  {deviceSecurityLabel(device)}{device.pushCapable ? t('settings.pushEnabled') : ''}
                </Text>
                <Text variant="bodySmall" color={theme.colors.text3}>
                  {t('settings.lastActive')} {new Date(device.lastSeenAt * 1000).toLocaleString()}
                </Text>
                {canSelfApproveWithPasskey ? (
                  <>
                  <Text variant="bodySmall" color={theme.colors.text2} style={{ marginTop: 8 }}>
                    If this device held a DM key before it lost trust, verify with your authenticator code and its existing encryption key. Keep this app’s data intact.
                  </Text>
                  <TextInput
                    accessibilityLabel="2FA code to verify this device"
                    keyboardType="number-pad"
                    textContentType="oneTimeCode"
                    value={selfApprovalCode}
                    onChangeText={setSelfApprovalCode}
                    maxLength={6}
                    placeholder="6-digit 2FA code"
                    placeholderTextColor={theme.colors.text3}
                    style={{ color: theme.colors.text, borderColor: theme.colors.lineSoft, borderWidth: 1, borderRadius: 8, padding: 8, marginTop: 8 }}
                  />
                  <Pressable
                    haptic
                    accessibilityLabel="Verify this device with 2FA"
                    onPress={() => void approveThisDeviceWith2FA(device.id)}
                    disabled={selfApprovingId === device.id || !/^\d{6}$/.test(selfApprovalCode)}
                    style={[styles.smallActionBtn, { alignSelf: 'flex-start', marginTop: 8, borderColor: theme.colors.lineSoft }]}
                  >
                    <Text variant="bodySmall" color={theme.colors.text2}>Verify this device with 2FA</Text>
                  </Pressable>
                  <Pressable
                    haptic
                    onPress={() => void approveThisDeviceWithPasskey(device.id)}
                    disabled={selfApprovingId === device.id}
                    style={[styles.smallActionBtn, { alignSelf: 'flex-start', marginTop: 8, borderColor: theme.colors.lineSoft }]}
                  >
                    <Text variant="bodySmall" color={theme.colors.text2}>
                      {selfApprovingId === device.id ? t('settings.waitingPasskey') : t('settings.approveWithPasskey')}
                    </Text>
                  </Pressable>
                  </>
                ) : null}
              </View>
            </View>
          );
        })}
      </View>
    </>
  );
}

function NotificationsSection() {
  const theme = useTheme();
  const { t } = useTranslation();
  const settings = useSettingsStore();
  const pushPrefsStore = usePushSettingsStore();
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void pushPrefsStore.loadGlobalPrefs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleNotifications = useCallback(async (value: boolean) => {
    settings.setNotificationsEnabled(value);
    if (!value) {
      const token = await secureStorage.get(StorageKeys.pushToken);
      if (token) await unregisterPushToken(token);
    } else {
      const result = await requestPushPermissionAndGetToken();
      if (result.success) {
        const deviceId = await getLocalDeviceId().catch(() => null);
        await registerPushToken(result.token, deviceId);
        await secureStorage.set(StorageKeys.pushToken, result.token);
      }
    }
  }, [settings]);

  const SOUND_SECTIONS: Array<{
    title: string;
    subtitle?: string;
    items: Array<{ key: SoundSettingKey; type: SoundType; label: string }>;
  }> = [
    {
      title: t('settings.soundChatSounds'),
      items: [
        { key: 'soundMessageInChannel', type: 'message-in-channel', label: t('settings.soundMsgChannel') },
        { key: 'soundMessageInServer', type: 'message-in-server', label: t('settings.soundMsgServer') },
        { key: 'soundMessageMention', type: 'message-mention', label: t('settings.soundMsgMentioned') },
        { key: 'soundMessageEveryone', type: 'message-everyone', label: t('settings.soundMsgEveryone') },
      ],
    },
    {
      title: t('settings.soundDMSounds'),
      items: [
        { key: 'soundDMIncomingCall', type: 'dm-incoming-call', label: t('settings.soundIncomingCall') },
        { key: 'soundDMOutgoingCall', type: 'dm-outgoing-call', label: t('settings.soundOutgoingCall') },
        { key: 'soundDMMessageInCurrent', type: 'dm-message-current', label: t('settings.soundDMCurrent') },
        { key: 'soundDMMessageFromOther', type: 'dm-message-other', label: t('settings.soundDMOther') },
      ],
    },
    {
      title: t('settings.soundVoiceSounds'),
      items: [
        { key: 'soundVoiceDeafen', type: 'voice-deafen', label: t('settings.soundDeafen') },
        { key: 'soundVoiceUndeafen', type: 'voice-undeafen', label: t('settings.soundUndeafen') },
        { key: 'soundVoiceMute', type: 'voice-mute', label: t('settings.soundMute') },
        { key: 'soundVoiceUnmute', type: 'voice-unmute', label: t('settings.soundUnmute') },
        { key: 'soundVoicePTTActivate', type: 'voice-ptt-activate', label: t('settings.soundPTTActivate') },
        { key: 'soundVoicePTTDeactivate', type: 'voice-ptt-deactivate', label: t('settings.soundPTTDeactivate') },
      ],
    },
    {
      title: t('settings.soundVoiceUsers'),
      items: [
        { key: 'soundVoiceUserJoined', type: 'voice-user-joined', label: t('settings.soundUserJoined') },
        { key: 'soundVoiceUserLeft', type: 'voice-user-left', label: t('settings.soundUserLeft') },
        { key: 'soundVoiceUserMoved', type: 'voice-user-moved', label: t('settings.soundUserMoved') },
      ],
    },
    {
      title: t('settings.soundExtraVoice'),
      items: [
        { key: 'soundScreenshareGoLive', type: 'screenshare-go-live', label: t('settings.soundScreenshareGoLive') },
        { key: 'soundScreenshareUserJoin', type: 'screenshare-user-join', label: t('settings.soundScreenshareUserJoin') },
        { key: 'soundScreenshareUserLeft', type: 'screenshare-user-left', label: t('settings.soundScreenshareUserLeft') },
        { key: 'soundScreenshareEnded', type: 'screenshare-ended', label: t('settings.soundScreenshareEnded') },
        { key: 'soundScreenshareStopped', type: 'screenshare-stopped', label: t('settings.soundScreenshareStopped') },
        { key: 'soundRTCFailed', type: 'rtc-failed', label: t('settings.soundRTCFailed') },
        { key: 'soundRTCReconnecting', type: 'rtc-reconnecting', label: t('settings.soundRTCReconnecting') },
      ],
    },
    {
      title: t('settings.soundVeryExtra'),
      subtitle: t('settings.soundDisabledByDefault'),
      items: [
        { key: 'soundUIButtonClick', type: 'ui-button-click', label: t('settings.soundUIButtonClick') },
        { key: 'soundHourlyBeep', type: 'hourly-beep', label: t('settings.soundHourlyBeep') },
        { key: 'soundAmbience', type: 'ambience', label: t('settings.soundAmbience') },
        { key: 'soundChannelCreated', type: 'channel-created', label: t('settings.soundChannelCreated') },
        { key: 'soundCategoryCreated', type: 'category-created', label: t('settings.soundCategoryCreated') },
        { key: 'soundUploadingAttachment', type: 'uploading-attachment', label: t('settings.soundUploadAttachment') },
        { key: 'soundTyping', type: 'typing', label: t('settings.soundTyping') },
        { key: 'soundSendMessage', type: 'send-message', label: t('settings.soundSendMessage') },
        { key: 'soundChannelDeleted', type: 'channel-deleted', label: t('settings.soundChannelDeleted') },
        { key: 'soundCategoryDeleted', type: 'category-deleted', label: t('settings.soundCategoryDeleted') },
        { key: 'soundDeletingMessage', type: 'deleting-message', label: t('settings.soundDeletingMessage') },
        { key: 'soundEditingMessage', type: 'editing-message', label: t('settings.soundEditingMessage') },
      ],
    },
  ];

  const { globalPrefs, saveGlobalPref } = pushPrefsStore;

  const PUSH_TOGGLE_ROWS: Array<{
    key: keyof typeof globalPrefs;
    label: string;
    description: string;
  }> = [
    {
      key: 'notifServers',
      label: t('settings.pushServers'),
      description: t('settings.pushServersDesc'),
    },
    {
      key: 'notifDMs',
      label: t('settings.pushDMs'),
      description: t('settings.pushDMsDesc'),
    },
    {
      key: 'notifFriendRequests',
      label: t('settings.pushFriends'),
      description: t('settings.pushFriendsDesc'),
    },
    {
      key: 'pushWhenOnline',
      label: t('settings.pushWhenOnline'),
      description: t('settings.pushWhenOnlineDesc'),
    },
  ];

  return (
    <>
      <SectionHeader title={t('settings.sectionMobilePush')} />
      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.bgElev1,
            borderRadius: theme.radius.lg,
            marginHorizontal: theme.spacing.lg,
          },
        ]}
      >
        <View style={styles.infoBlock}>
          <Text variant="bodySmall" color={theme.colors.text3}>
            {t('settings.pushDesc')}
          </Text>
        </View>
        {PUSH_TOGGLE_ROWS.map((row, idx) => (
          <View
            key={row.key}
            style={[
              styles.row,
              idx < PUSH_TOGGLE_ROWS.length - 1
                ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.lineSoft }
                : null,
            ]}
          >
            <View style={{ flex: 1 }}>
              <Text variant="body">{row.label}</Text>
              <Text variant="bodySmall" color={theme.colors.text3}>
                {row.description}
              </Text>
            </View>
            <Switch
              value={globalPrefs[row.key]}
              onValueChange={(v) => void saveGlobalPref(row.key, v)}
              trackColor={{ false: theme.colors.bgElev3, true: theme.colors.accentSoft }}
              thumbColor={globalPrefs[row.key] ? theme.colors.accent : theme.colors.text3}
              ios_backgroundColor={theme.colors.bgElev3}
            />
          </View>
        ))}
      </View>

      <SectionHeader title={t('settings.sectionNotifications')} />
      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.bgElev1,
            borderRadius: theme.radius.lg,
            marginHorizontal: theme.spacing.lg,
          },
        ]}
      >
        <View
          style={[
            styles.row,
            {
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: theme.colors.lineSoft,
            },
          ]}
        >
          <View style={{ flex: 1 }}>
            <Text variant="body">{t('settings.enableSounds')}</Text>
            <Text variant="bodySmall" color={theme.colors.text3}>
              {t('settings.enableSoundsDesc')}
            </Text>
          </View>
          <Switch
            value={settings.notificationsEnabled}
            onValueChange={(v) => void handleToggleNotifications(v)}
            trackColor={{ false: theme.colors.bgElev3, true: theme.colors.accentSoft }}
            thumbColor={settings.notificationsEnabled ? theme.colors.accent : theme.colors.text3}
            ios_backgroundColor={theme.colors.bgElev3}
          />
        </View>

        <View style={[styles.row, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.lineSoft }]}>
          <View style={{ flex: 1 }}>
            <Text variant="body">{t('theater.chatPreviews')}</Text>
            <Text variant="bodySmall" color={theme.colors.text3}>{t('theater.chatPreviewsDesc')}</Text>
          </View>
          <Switch
            accessibilityLabel={t('theater.chatPreviews')}
            value={settings.theaterChatPreviews}
            onValueChange={settings.setTheaterChatPreviews}
            trackColor={{ false: theme.colors.bgElev3, true: theme.colors.accentSoft }}
            thumbColor={settings.theaterChatPreviews ? theme.colors.accent : theme.colors.text3}
            ios_backgroundColor={theme.colors.bgElev3}
          />
        </View>

        {SOUND_SECTIONS.map((section) => {
          const sectionItems = section.items.filter((item) => item.key in SOUND_SETTING_DEFAULTS);
          if (sectionItems.length === 0) return null;
          const isCollapsed = collapsedSections[section.title] ?? false;
          return (
            <View
              key={section.title}
              style={[
                styles.card,
                {
                  backgroundColor: theme.colors.bgElev1,
                  borderRadius: theme.radius.lg,
                  marginHorizontal: theme.spacing.lg,
                  marginTop: theme.spacing.md,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: theme.colors.lineSoft,
                },
              ]}
            >
              <Pressable
                onPress={() =>
                  setCollapsedSections((prev) => ({ ...prev, [section.title]: !isCollapsed }))
                }
                style={{
                  backgroundColor: theme.colors.accentSoft,
                  borderTopLeftRadius: theme.radius.lg,
                  borderTopRightRadius: theme.radius.lg,
                  paddingHorizontal: theme.spacing.md,
                  paddingTop: theme.spacing.md,
                  paddingBottom: theme.spacing.sm,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <View style={{ flex: 1, paddingRight: theme.spacing.md }}>
                  <Text variant="subtitle" color={theme.colors.text}>
                    {section.title}
                  </Text>
                  {section.subtitle ? (
                    <Text variant="bodySmall" color={theme.colors.text2}>
                      {section.subtitle}
                    </Text>
                  ) : null}
                </View>
                {isCollapsed ? (
                  <ChevronDown size={16} color={theme.colors.text2} />
                ) : (
                  <ChevronUp size={16} color={theme.colors.text2} />
                )}
              </Pressable>

              {!isCollapsed
                ? sectionItems.map((item, idx) => {
                    const enabled = settings.notificationsEnabled && Boolean(settings[item.key]);
                    const volume = settings.soundVolumes[item.key] ?? 100;
                    return (
                      <NotificationSoundRow
                        key={item.key}
                        label={item.label}
                        description={t('settings.soundPreviewDesc', { label: item.label.toLowerCase() })}
                        enabled={enabled}
                        volume={volume}
                        onToggle={(value) => settings.setSoundSetting(item.key, value)}
                        onVolumeChange={(value) => settings.setSoundVolume(item.key, value)}
                        onPreview={() => void playNotificationSound(item.type, volume)}
                        isLast={idx === sectionItems.length - 1}
                      />
                    );
                  })
                : null}
            </View>
          );
        })}
      </View>
    </>
  );
}

export default function SettingsScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ section?: string | string[] }>();
  const activeSection = normalizeSection(
    Array.isArray(params.section) ? params.section[0] : params.section,
  );
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const applyProfile = useAuthStore((s) => s.applyProfile);
  const servers = useServerStore((s) => s.servers);
  const serverSyncStatus = useServerStore((s) => s.serverSyncStatus);
  const serverSyncMessage = useServerStore((s) => s.serverSyncMessage);
  const fetchServersForCentral = useServerStore((s) => s.fetchServersForCentral);

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [customStatusText, setCustomStatusText] = useState(user?.customStatusText ?? '');
  const [profileLoading, setProfileLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);

  const profileApi = () =>
    user?.accountType === 'central' ? createAuthenticatedApi() : createApi();

  const hydrateDrafts = (profile: Record<string, unknown>) => {
    setDisplayName(profileText(profile, 'displayName', 'display_name'));
    setBio(profileText(profile, 'bio'));
    setCustomStatusText(profileText(profile, 'customStatusText', 'custom_status_text'));
  };

  const applyProfileResponse = async (profile: Record<string, unknown>) => {
    hydrateDrafts(profile);
    await applyProfile(profile);
  };

  useEffect(() => {
    if (!user) return;
    setProfileLoading(true);
    setMessage(null);
    profileApi()
      .get<Record<string, unknown>>('/api/profile/me')
      .then((res) => applyProfileResponse(res.data))
      .catch(() => setMessage(t('settings.profileLoadError')))
      .finally(() => setProfileLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, user?.accountType]);

  useEffect(() => {
    if (
      user?.accountType === 'central' &&
      activeSection === 'server-profiles' &&
      servers.length === 0
    ) {
      void fetchServersForCentral();
    }
  }, [activeSection, fetchServersForCentral, servers.length, user?.accountType]);

  const saveProfileField = async (
    action: () => Promise<{ data: Record<string, unknown> }>,
    success: string,
  ) => {
    if (saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await action();
      await applyProfileResponse(res.data);
      setMessage(success);
    } catch {
      setMessage(t('settings.profileSaveError'));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveDisplayName = async () => {
    const trimmed = displayName.trim();
    await saveProfileField(
      () =>
        trimmed
          ? profileApi().put('/api/profile/me/display-name', { displayName: trimmed })
          : profileApi().delete('/api/profile/me/display-name'),
      t('settings.displayNameUpdated'),
    );
  };

  const handleSaveBio = async () => {
    await saveProfileField(
      () => profileApi().put('/api/profile/me', { bio: bio.trim() }),
      t('settings.bioUpdated'),
    );
  };

  const handleSaveCustomStatus = async () => {
    const trimmed = customStatusText.trim();
    await saveProfileField(
      () =>
        trimmed
          ? profileApi().put('/api/profile/me/custom-status', { customStatusText: trimmed })
          : profileApi().delete('/api/profile/me/custom-status'),
      t('settings.customStatusUpdated'),
    );
  };

  const handleStatusChange = async (status: UserStatus) => {
    await saveProfileField(
      () => profileApi().put('/api/profile/me/status', { status }),
      t('settings.statusUpdated'),
    );
  };

  const handleUploadMedia = async (kind: 'avatar' | 'banner') => {
    const picked = await DocumentPicker.getDocumentAsync({
      type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      copyToCacheDirectory: true,
    });
    if (picked.canceled || !picked.assets?.[0]) return;
    const asset = picked.assets[0];
    const mime = asset.mimeType ?? 'image/jpeg';
    const fieldName = kind;
    const endpoint = `/api/profile/me/${kind}`;
    if (kind === 'avatar') setUploadingAvatar(true);
    else setUploadingBanner(true);
    setMessage(null);
    try {
      const formData = new FormData();
      await appendFormDataFile(formData, fieldName, {
        uri: asset.uri,
        type: mime,
        name: asset.name ?? `${kind}.jpg`,
      });
      const api = profileApi();
      const res = await api.post<Record<string, unknown>>(endpoint, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      await applyProfileResponse(res.data);
      setMessage(kind === 'avatar' ? t('settings.avatarUpdated') : t('settings.bannerUpdated'));
    } catch {
      setMessage(kind === 'avatar' ? t('settings.avatarUploadError') : t('settings.bannerUploadError'));
    } finally {
      if (kind === 'avatar') setUploadingAvatar(false);
      else setUploadingBanner(false);
    }
  };

  const handleSignOut = () => {
    Alert.alert(t('settings.signOut'), t('settings.signOutConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('settings.signOut'),
        style: 'destructive',
        onPress: async () => {
          await signOut();
          router.replace('/(auth)/welcome');
        },
      },
    ]);
  };

  const [deleteAccountModalVisible, setDeleteAccountModalVisible] = useState(false);
  const handleDeleteAccount = () => {
    Alert.alert(t('settings.deleteAccount'), t('settings.deleteAccountConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('settings.deleteAccount'),
        style: 'destructive',
        onPress: () => setDeleteAccountModalVisible(true),
      },
    ]);
  };
  const handleAccountDeleted = async () => {
    setDeleteAccountModalVisible(false);
    await signOut();
    router.replace('/(auth)/welcome');
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.colors.bgApp }]}>
      <View style={styles.topBar}>
        <Text variant="subtitle" style={{ flex: 1, paddingLeft: theme.spacing.sm }}>
          {({
            profile: t('settings.navProfile'),
            'server-profiles': t('settings.navServerProfiles'),
            'account-security': t('settings.navAccountSecurity'),
            voice: t('settings.navVoice'),
            notifications: t('settings.navNotifications'),
            appearance: t('settings.navAppearance'),
            'emotes-settings': t('settings.navEmotesSettings'),
            'content-social': t('settings.navContentSocial'),
            storage: t('settings.navStorage'),
            language: t('settings.navLanguage'),
          } as Record<SettingsSection, string>)[activeSection]}
        </Text>
        <IconBtn icon={X} onPress={() => router.back()} accessibilityLabel={t('common.close')} />
      </View>

      <ScrollView>
        {activeSection === 'profile' ? (
          <>
            {/* Account */}
            <SectionHeader title={t('settings.sectionAccount')} />
            <View
              style={[
                styles.card,
                {
                  backgroundColor: theme.colors.bgElev1,
                  borderRadius: theme.radius.lg,
                  marginHorizontal: theme.spacing.lg,
                },
              ]}
            >
              <View style={styles.row}>
                <Pressable haptic onPress={() => void handleUploadMedia('avatar')} disabled={uploadingAvatar}>
                  <View>
                    <Avatar username={user?.username ?? '?'} uri={user?.avatar ?? null} size={52} />
                    <View style={{
                      position: 'absolute', bottom: 0, right: 0,
                      width: 18, height: 18, borderRadius: 9,
                      backgroundColor: theme.colors.accent,
                      alignItems: 'center', justifyContent: 'center',
                    }}>
                      {uploadingAvatar
                        ? <ActivityIndicator size="small" color="#fff" style={{ transform: [{ scale: 0.5 }] }} />
                        : <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>+</Text>}
                    </View>
                  </View>
                </Pressable>
                <View style={{ flex: 1, marginLeft: theme.spacing.md }}>
                  <Text variant="subtitle">{user?.displayName ?? user?.username}</Text>
                  <Text variant="bodySmall" color={theme.colors.text3}>@{user?.username}</Text>
                  <Pressable
                    haptic
                    onPress={() => void handleUploadMedia('banner')}
                    disabled={uploadingBanner}
                    style={{ marginTop: 6 }}
                  >
                    <Text variant="caption" color={theme.colors.accent}>
                      {uploadingBanner ? t('settings.uploadingBanner') : t('settings.changeBanner')}
                    </Text>
                  </Pressable>
                </View>
              </View>
            </View>

            {profileLoading ? (
              <View style={{ paddingTop: theme.spacing.md }}>
                <ActivityIndicator color={theme.colors.accent} />
              </View>
            ) : null}
            {message ? (
              <View style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.md }}>
                <Text
                  variant="bodySmall"
                  color={message.startsWith('Could') ? theme.colors.danger : theme.colors.text3}
                >
                  {message}
                </Text>
              </View>
            ) : null}

            {/* Display name */}
            <SectionHeader title={t('settings.sectionDisplayName')} />
            <View
              style={[
                styles.card,
                {
                  backgroundColor: theme.colors.bgElev1,
                  borderRadius: theme.radius.lg,
                  marginHorizontal: theme.spacing.lg,
                },
              ]}
            >
              <View style={styles.row}>
                <TextInput
                  value={displayName}
                  onChangeText={setDisplayName}
                  placeholder={t('settings.displayNamePlaceholder')}
                  placeholderTextColor={theme.colors.text3}
                  style={[styles.nameInput, { color: theme.colors.text, flex: 1 }]}
                  returnKeyType="done"
                  onSubmitEditing={() => void handleSaveDisplayName()}
                />
                <Pressable
                  haptic
                  onPress={() => void handleSaveDisplayName()}
                  disabled={saving}
                  style={[
                    styles.saveBtn,
                    {
                      backgroundColor: theme.colors.accent,
                      borderRadius: theme.radius.md,
                      opacity: saving ? 0.5 : 1,
                    },
                  ]}
                >
                  <Text variant="caption" color={theme.colors.textOnAccent}>
                    {t('common.save')}
                  </Text>
                </Pressable>
              </View>
            </View>

            <SectionHeader title={t('settings.sectionBio')} />
            <View
              style={[
                styles.card,
                {
                  backgroundColor: theme.colors.bgElev1,
                  borderRadius: theme.radius.lg,
                  marginHorizontal: theme.spacing.lg,
                },
              ]}
            >
              <View style={[styles.row, { alignItems: 'flex-start' }]}>
                <TextInput
                  value={bio}
                  onChangeText={setBio}
                  placeholder={t('settings.bioPlaceholder')}
                  placeholderTextColor={theme.colors.text3}
                  maxLength={500}
                  multiline
                  style={[styles.textArea, { color: theme.colors.text, flex: 1 }]}
                />
              </View>
              <View style={[styles.row, { paddingTop: 0 }]}>
                <Text variant="caption" color={theme.colors.text3} style={{ flex: 1 }}>
                  {bio.length}/500
                </Text>
                <Pressable
                  haptic
                  onPress={() => void handleSaveBio()}
                  disabled={saving}
                  style={[
                    styles.saveBtn,
                    {
                      backgroundColor: theme.colors.accent,
                      borderRadius: theme.radius.md,
                      opacity: saving ? 0.5 : 1,
                    },
                  ]}
                >
                  <Text variant="caption" color={theme.colors.textOnAccent}>
                    {t('common.save')}
                  </Text>
                </Pressable>
              </View>
            </View>

            {user?.accountType === 'central' ? <LastfmSection /> : null}

            {/* Status */}
            <SectionHeader title={t('settings.sectionStatus')} />
            <View
              style={[
                styles.card,
                {
                  backgroundColor: theme.colors.bgElev1,
                  borderRadius: theme.radius.lg,
                  marginHorizontal: theme.spacing.lg,
                },
              ]}
            >
              {STATUSES.map(({ value, selectable = true }, index) => (
                <Pressable
                  key={value}
                  haptic={selectable}
                  disabled={!selectable}
                  onPress={() => {
                    if (selectable) void handleStatusChange(value);
                  }}
                  style={[
                    styles.row,
                    !selectable ? { opacity: 0.72 } : null,
                    index < STATUSES.length - 1
                      ? {
                          borderBottomWidth: StyleSheet.hairlineWidth,
                          borderBottomColor: theme.colors.lineSoft,
                        }
                      : null,
                  ]}
                >
                  <StatusDot status={value} size={10} />
                  <Text variant="body" style={{ marginLeft: theme.spacing.sm }}>
                    {t(`status.${value}` as Parameters<typeof t>[0])}
                  </Text>
                  {user?.status === value && (
                    <Text
                      variant="caption"
                      color={theme.colors.accent}
                      style={{ marginLeft: 'auto' }}
                    >
                      {t('common.active')}
                    </Text>
                  )}
                </Pressable>
              ))}
            </View>

            <SectionHeader title={t('settings.sectionCustomStatus')} />
            <View
              style={[
                styles.card,
                {
                  backgroundColor: theme.colors.bgElev1,
                  borderRadius: theme.radius.lg,
                  marginHorizontal: theme.spacing.lg,
                },
              ]}
            >
              <View style={styles.row}>
                <TextInput
                  value={customStatusText}
                  onChangeText={setCustomStatusText}
                  placeholder={t('settings.customStatusPlaceholder')}
                  placeholderTextColor={theme.colors.text3}
                  maxLength={128}
                  style={[styles.nameInput, { color: theme.colors.text, flex: 1 }]}
                  returnKeyType="done"
                  onSubmitEditing={() => void handleSaveCustomStatus()}
                />
                <Pressable
                  haptic
                  onPress={() => void handleSaveCustomStatus()}
                  disabled={saving}
                  style={[
                    styles.saveBtn,
                    {
                      backgroundColor: theme.colors.accent,
                      borderRadius: theme.radius.md,
                      opacity: saving ? 0.5 : 1,
                    },
                  ]}
                >
                  <Text variant="caption" color={theme.colors.textOnAccent}>
                    {t('common.save')}
                  </Text>
                </Pressable>
              </View>
            </View>
          </>
        ) : null}

        {activeSection === 'server-profiles' ? (
          <>
            <SectionHeader title={t('settings.sectionServers')} />
            <View
              style={[
                styles.card,
                {
                  backgroundColor: theme.colors.bgElev1,
                  borderRadius: theme.radius.lg,
                  marginHorizontal: theme.spacing.lg,
                },
              ]}
            >
              <View
                style={[
                  styles.row,
                  servers.length > 0
                    ? {
                        borderBottomWidth: StyleSheet.hairlineWidth,
                        borderBottomColor: theme.colors.lineSoft,
                      }
                    : null,
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text variant="body" color={theme.colors.text2}>
                    {t('settings.centralSync')}
                  </Text>
                  {serverSyncMessage ? (
                    <Text variant="bodySmall" color={theme.colors.text3} style={{ marginTop: 3 }}>
                      {serverSyncMessage}
                    </Text>
                  ) : null}
                </View>
                {serverSyncStatus === 'loading' ? (
                  <ActivityIndicator color={theme.colors.accent} />
                ) : (
                  <Pressable
                    haptic
                    onPress={() => void fetchServersForCentral()}
                    style={[
                      styles.saveBtn,
                      {
                        backgroundColor: theme.colors.bgElev2,
                        borderRadius: theme.radius.md,
                        marginLeft: theme.spacing.md,
                      },
                    ]}
                  >
                    <Text variant="caption" color={theme.colors.text2}>
                      {t('common.refresh')}
                    </Text>
                  </Pressable>
                )}
              </View>
              {servers.length > 0 ? (
                servers.map((server, index) => (
                  <View
                    key={server.id}
                    style={[
                      styles.row,
                      index < servers.length - 1
                        ? {
                            borderBottomWidth: StyleSheet.hairlineWidth,
                            borderBottomColor: theme.colors.lineSoft,
                          }
                        : null,
                    ]}
                  >
                    <ServerIcon server={server} size={40} />
                    <View style={{ flex: 1, marginLeft: theme.spacing.md }}>
                      <Text variant="subtitle" numberOfLines={1}>
                        {server.name}
                      </Text>
                      <Text variant="bodySmall" color={theme.colors.text3} numberOfLines={1}>
                        {t('settings.usesMainProfile')}
                      </Text>
                    </View>
                  </View>
                ))
              ) : (
                <View style={styles.row}>
                  <Text variant="body" color={theme.colors.text3}>
                    {t('settings.noLinkedServers')}
                  </Text>
                </View>
              )}
            </View>

            <SectionHeader title={t('settings.sectionOverrides')} />
            <View
              style={[
                styles.card,
                {
                  backgroundColor: theme.colors.bgElev1,
                  borderRadius: theme.radius.lg,
                  marginHorizontal: theme.spacing.lg,
                },
              ]}
            >
              <View style={styles.infoBlock}>
                <Text variant="body" color={theme.colors.text2}>
                  {t('settings.serverOverridesDesc')}
                </Text>
              </View>
            </View>
          </>
        ) : null}

        {activeSection === 'account-security' ? (
          <>
            <SectionHeader title={t('settings.sectionAccount')} />
            <View
              style={[
                styles.card,
                {
                  backgroundColor: theme.colors.bgElev1,
                  borderRadius: theme.radius.lg,
                  marginHorizontal: theme.spacing.lg,
                },
              ]}
            >
              <View style={styles.row}>
                <Text variant="body" style={{ flex: 1 }}>
                  {t('settings.username')}
                </Text>
                <Text variant="bodySmall" color={theme.colors.text3}>
                  @{user?.username ?? 'unknown'}
                </Text>
              </View>
              <View
                style={[
                  styles.row,
                  {
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: theme.colors.lineSoft,
                  },
                ]}
              >
                <Text variant="body" style={{ flex: 1 }}>
                  {t('settings.accountType')}
                </Text>
                <Text variant="bodySmall" color={theme.colors.text3}>
                  {user?.accountType === 'central' ? t('settings.typeCentral') : t('settings.typeLocal')}
                </Text>
              </View>
              {user?.accountType === 'central' ? (
                <View
                  style={[
                    styles.row,
                    {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: theme.colors.lineSoft,
                    },
                  ]}
                >
                  <Text variant="body" style={{ flex: 1 }}>
                    {t('settings.twoFactor')}
                  </Text>
                  <Text variant="bodySmall" color={theme.colors.accent}>
                    {t('common.enabled')}
                  </Text>
                </View>
              ) : null}
            </View>
            <AccountPasskeysSection />
            <AccountDevicesSection />
            {user?.accountType === 'central' ? (
              <View style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.lg }}>
                <Text variant="caption" color={theme.colors.danger} style={{ marginBottom: 6 }}>
                  {t('settings.dangerZone')}
                </Text>
                <Pressable
                  haptic
                  onPress={handleDeleteAccount}
                  style={[
                    styles.signOutBtn,
                    {
                      backgroundColor: theme.colors.bgElev1,
                      borderRadius: theme.radius.lg,
                      borderWidth: 1,
                      borderColor: theme.colors.danger,
                    },
                  ]}
                >
                  <Text variant="subtitle" color={theme.colors.danger}>
                    {t('settings.deleteAccount')}
                  </Text>
                </Pressable>
                <DeleteAccountConfirmModal
                  visible={deleteAccountModalVisible}
                  onClose={() => setDeleteAccountModalVisible(false)}
                  onDeleted={handleAccountDeleted}
                />
              </View>
            ) : null}
          </>
        ) : null}

        {activeSection === 'voice' ? (
          <>
            <SectionHeader title={t('settings.sectionVoice')} />
            <View
              style={[
                styles.card,
                {
                  backgroundColor: theme.colors.bgElev1,
                  borderRadius: theme.radius.lg,
                  marginHorizontal: theme.spacing.lg,
                },
              ]}
            >
              <View style={styles.infoBlock}>
                <Text variant="body" color={theme.colors.text2}>
                  {t('settings.voiceDesc')}
                </Text>
              </View>
            </View>
          </>
        ) : null}

        {activeSection === 'notifications' ? (
          <NotificationsSection />
        ) : null}

        {activeSection === 'appearance' ? (
          <AppearanceSettingsSection />
        ) : null}

        {activeSection === 'emotes-settings' ? (
          <EmotesSettingsSection />
        ) : null}

        {activeSection === 'content-social' ? (
          <ContentSocialSection />
        ) : null}

        {activeSection === 'storage' ? (
          <StorageSection />
        ) : null}

        {activeSection === 'language' ? (
          <LanguageSection />
        ) : null}

        {activeSection === 'cat-lab' ? (
          <CatLabSettingsSection />
        ) : null}

        {/* Sign out */}
        {activeSection === 'account-security' ? (
          <View style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.xl }}>
            <Pressable
              haptic
              onPress={handleSignOut}
              style={[
                styles.signOutBtn,
                {
                  backgroundColor: theme.colors.bgElev1,
                  borderRadius: theme.radius.lg,
                  borderWidth: 1,
                  borderColor: theme.colors.danger,
                },
              ]}
            >
              <Text variant="subtitle" color={theme.colors.danger}>
                {t('settings.signOut')}
              </Text>
            </Pressable>
          </View>
        ) : null}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 8,
  },
  card: {
    overflow: 'hidden',
  },
  infoBlock: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  treeCard: {
    overflow: 'hidden',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  treeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  treeContent: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  countBadge: {
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 1,
    marginRight: 4,
  },
  galleryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  gridThumbWrap: {
    overflow: 'hidden',
  },
  gridThumb: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  galleryRoot: {
    flex: 1,
  },
  galleryScrim: {
    ...StyleSheet.absoluteFill,
  },
  galleryHeader: {
    position: 'absolute',
    top: 56,
    left: 14,
    right: 14,
    zIndex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  galleryHeaderBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  galleryTitle: {
    flex: 1,
    fontSize: 15,
  },
  galleryPage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 56,
  },
  galleryImage: {
    width: '100%',
    height: '100%',
  },
  galleryPageTag: {
    position: 'absolute',
    top: 98,
    right: 16,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    zIndex: 2,
  },
  galleryMenuDismiss: {
    ...StyleSheet.absoluteFill,
    zIndex: 2,
  },
  galleryMenu: {
    position: 'absolute',
    top: 96,
    right: 14,
    borderWidth: 1,
    borderRadius: 8,
    overflow: 'hidden',
    zIndex: 3,
    minWidth: 160,
  },
  galleryMenuItem: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
  },
  nameInput: {
    fontSize: 15,
    paddingVertical: 0,
  },
  textArea: {
    minHeight: 96,
    maxHeight: 160,
    fontSize: 15,
    paddingVertical: 0,
    textAlignVertical: 'top',
  },
  saveBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginLeft: 8,
  },
  smallActionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderWidth: 1,
    borderRadius: 10,
  },
  signOutBtn: {
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sizeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingVertical: 12,
  },
  sizeChip: {
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  previewRow: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 8,
    padding: 12,
  },
  notice: {
    margin: 12,
    marginBottom: 0,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
  },
  uploadBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
    minHeight: 38,
    minWidth: 44,
  },
  personalHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
  },
  refreshButton: {
    minHeight: 34,
    minWidth: 34,
  },
  emptyText: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  expressionItem: {
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    marginHorizontal: 12,
    marginBottom: 10,
    padding: 10,
  },
  expressionPreview: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    width: 52,
  },
  expressionImage: {
    height: 52,
    width: 52,
  },
  expressionEditRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  expressionInput: {
    borderWidth: 1,
    flex: 1,
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  iconAction: {
    alignItems: 'center',
    borderRadius: 6,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 38,
    minWidth: 44,
    paddingHorizontal: 8,
  },
  themeRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  themeSwatches: {
    flexDirection: 'row',
    gap: 6,
  },
  themeSwatch: {
    borderRadius: 999,
    borderWidth: 1,
    height: 18,
    width: 18,
  },
  radioOuter: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 2,
    height: 20,
    justifyContent: 'center',
    width: 20,
  },
  radioInner: {
    borderRadius: 999,
    height: 10,
    width: 10,
  },
  soundRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  soundHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  soundControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
  },
  previewBtn: {
    minHeight: 32,
    minWidth: 64,
    borderWidth: 1,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
});
