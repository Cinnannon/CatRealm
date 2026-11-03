import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Modal, Pressable as RNPressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { CachedImage } from './CachedImage';
import { realmScope } from '@/lib/imageCache';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/theme';
import { useDeviceLayout } from '@/hooks/useDeviceLayout';
import { Pressable } from './Pressable';
import { Text } from './Text';
import { Sheet } from './Sheet';
import { ExpressionPicker } from './ExpressionPicker';
import { normalizeExprName, getOrigin, type ExpressionEntry, type ExpressionLookup } from '@/lib/expressionCache';
import { filterExpressionLookup } from '@/lib/expressionPermissions';
import type { Reaction } from '@/types';
import { useMessageTranslationAction } from '@/lib/translation/useAutoTranslation';

const USAGE_STORAGE_KEY = 'catrealm.expression-usage.v1';
const DEFAULT_RECENT_EMOJI = ['😀', '🥳', '🔥', '✨', '💜', '👍'];

type UsageMap = Record<string, number>;

interface MessageActionSheetProps {
  open: boolean;
  onClose: () => void;
  expressionLookup?: ExpressionLookup | null;
  serverUrl?: string | null;
  canEdit?: boolean;
  canPin?: boolean;
  isPinned?: boolean;
  canDelete?: boolean;
  isDm?: boolean;
  initialEditText?: string;
  onReact?: (token: string) => void;
  onEdit?: (nextText: string) => void | Promise<void>;
  onReply?: () => void;
  onForward?: () => void;
  onMarkUnread?: () => void;
  onPin?: () => void;
  onDelete?: () => void;
  onCopy?: () => void;
  onCreateThread?: () => void;
  canReact?: boolean;
  canUseExternalEmotes?: boolean;
  canUseExternalStickers?: boolean;
  /** Cat Lab auto-translate: the message whose translation the sheet can show or request. */
  translationMessageId?: string | null;
  translationText?: string | null;
  reactions?: ReadonlyArray<Reaction> | null;
  onViewReactions?: () => void;
}

function buildExpressionToken(item: ExpressionEntry, currentOrigin: string | null): string {
  const name = normalizeExprName(item.name);
  const origin = item.origin ? getOrigin(item.origin) : null;
  const ownerId = item.ownerId?.toLowerCase().replace(/[^a-z0-9_-]/g, '') ?? '';
  const includeOrigin = origin && origin !== currentOrigin;
  if (includeOrigin) {
    return ownerId ? `:${origin}:${name}:${ownerId}:` : `:${origin}:${name}:`;
  }
  return ownerId ? `:${name}:${ownerId}:` : `:${name}:`;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${clampByte(r).toString(16).padStart(2, '0')}${clampByte(g).toString(16).padStart(2, '0')}${clampByte(b).toString(16).padStart(2, '0')}`;
}

function mixHex(base: string, target: string, amount: number): string {
  const baseRgb = hexToRgb(base);
  const targetRgb = hexToRgb(target);
  if (!baseRgb || !targetRgb) return base;
  const t = Math.max(0, Math.min(1, amount));
  return rgbToHex(
    baseRgb.r + (targetRgb.r - baseRgb.r) * t,
    baseRgb.g + (targetRgb.g - baseRgb.g) * t,
    baseRgb.b + (targetRgb.b - baseRgb.b) * t,
  );
}

export function MessageActionSheet({
  open,
  onClose,
  expressionLookup,
  serverUrl,
  canEdit = false,
  canPin = false,
  isPinned = false,
  canDelete = false,
  isDm = false,
  initialEditText = '',
  onReact,
  onEdit,
  onReply,
  onForward,
  onMarkUnread,
  onPin,
  onDelete,
  onCopy,
  onCreateThread,
  canReact = true,
  canUseExternalEmotes = true,
  canUseExternalStickers = true,
  translationMessageId,
  translationText,
  reactions,
  onViewReactions,
}: MessageActionSheetProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const translationAction = useMessageTranslationAction(translationMessageId, translationText);
  const { isDesktopLike } = useDeviceLayout();
  const [usage, setUsage] = useState<UsageMap | null>(null);
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editDraft, setEditDraft] = useState('');
  const [rotatingIndex, setRotatingIndex] = useState(0);
  const [displayedRotatingIndex, setDisplayedRotatingIndex] = useState(0);
  const fadeOpacity = useState(() => new Animated.Value(1))[0];
  const sparklePulse = useState(() => new Animated.Value(0))[0];
  const borderSpin = useState(() => new Animated.Value(0))[0];
  const isAnimatingRef = useRef(false);
  const presentationModeRef = useRef<'desktop' | 'sheet' | null>(null);
  // Captured before onClose() fires so the picker still has the correct message context.
  const savedOnReactRef = useRef<((token: string) => void) | undefined>(undefined);
  const allowedExpressionLookup = useMemo(
    () => filterExpressionLookup(expressionLookup, serverUrl, canUseExternalEmotes, canUseExternalStickers),
    [expressionLookup, serverUrl, canUseExternalEmotes, canUseExternalStickers],
  );

  if (open && presentationModeRef.current === null) {
    presentationModeRef.current = isDesktopLike ? 'desktop' : 'sheet';
  } else if (!open && presentationModeRef.current !== null) {
    presentationModeRef.current = null;
  }

  const useDesktopPresentation = (presentationModeRef.current ?? (isDesktopLike ? 'desktop' : 'sheet')) === 'desktop';

  useEffect(() => {
    let cancelled = false;
    if (!open) return;
    void AsyncStorage.getItem(USAGE_STORAGE_KEY).then((raw) => {
      if (cancelled) return;
      if (!raw) {
        setUsage({});
        return;
      }
      try {
        setUsage(JSON.parse(raw) as UsageMap);
      } catch {
        setUsage({});
      }
    });
    return () => { cancelled = true; };
  }, [open]);

  const recentEntries = useMemo(() => {
    if (!usage || !allowedExpressionLookup) return [];
    const all = [...allowedExpressionLookup.values()].filter((entry) => entry.emote);
    const scored = all
      .map((entry) => {
        const key = ['emote', entry.source ?? 'server', entry.origin ?? '', entry.ownerId ?? '', normalizeExprName(entry.name)].join(':');
        return { entry, score: usage[key] ?? 0 };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((item) => item.entry);
    return scored;
  }, [allowedExpressionLookup, usage]);

  const topRecentEntries = useMemo(() => recentEntries.slice(0, 5), [recentEntries]);

  const rotatingOptions = useMemo(() => {
    if (recentEntries.length > 0) return recentEntries;
    if (!allowedExpressionLookup) return [];
    return [...allowedExpressionLookup.values()].filter((entry) => entry.emote).slice(0, 12);
  }, [allowedExpressionLookup, recentEntries]);

  useEffect(() => {
    if (!open || rotatingOptions.length <= 1) return;
    const timer = setInterval(() => {
      setRotatingIndex((prev) => (prev + 1) % rotatingOptions.length);
    }, 1500);
    return () => clearInterval(timer);
  }, [open, rotatingOptions.length]);

  useEffect(() => {
    if (!open) return;
    const sparkleLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(sparklePulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(sparklePulse, { toValue: 0, duration: 900, useNativeDriver: true }),
      ]),
    );
    sparklePulse.setValue(0);
    sparkleLoop.start();
    return () => {
      sparkleLoop.stop();
    };
  }, [open, sparklePulse]);

  useEffect(() => {
    if (!open) return;
    borderSpin.setValue(0);
    const spinLoop = Animated.loop(
      Animated.timing(borderSpin, {
        toValue: 1,
        duration: 3200,
        useNativeDriver: true,
      }),
    );
    spinLoop.start();
    return () => spinLoop.stop();
  }, [borderSpin, open]);

  useEffect(() => {
    if (!open || rotatingOptions.length === 0 || rotatingIndex === displayedRotatingIndex) return;
    if (isAnimatingRef.current) return;
    isAnimatingRef.current = true;

    Animated.timing(fadeOpacity, {
      toValue: 0.2,
      duration: 220,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) {
        isAnimatingRef.current = false;
        return;
      }
      setDisplayedRotatingIndex(rotatingIndex);
      Animated.timing(fadeOpacity, {
        toValue: 1,
        duration: 260,
        useNativeDriver: true,
      }).start(() => {
        isAnimatingRef.current = false;
      });
    });
  }, [displayedRotatingIndex, fadeOpacity, open, rotatingIndex, rotatingOptions.length]);

  const rotatingEntry = rotatingOptions[displayedRotatingIndex % Math.max(1, rotatingOptions.length)] ?? null;
  const sparkleOpacity = sparklePulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 0.7],
  });
  const borderGlowOpacity = sparklePulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.25, 0.55],
  });
  const borderRotate = borderSpin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });
  const borderGradientColors = useMemo(() => {
    const accent = theme.colors.accent;
    const rim = theme.colors.accentRim;
    const text = theme.colors.text;
    return [
      mixHex(accent, '#ffffff', 0.12),
      rim,
      mixHex(accent, text, 0.32),
      mixHex(accent, '#ffffff', 0.06),
      mixHex(accent, '#000000', 0.14),
      mixHex(accent, '#ffffff', 0.12),
    ] as const;
  }, [theme.colors.accent, theme.colors.accentRim, theme.colors.text]);

  const actionRows: Array<{ key: string; label: string; onPress?: () => void }> = [];
  if (canEdit) actionRows.push({
    key: 'edit',
    label: t('chat.editMessage'),
    onPress: () => {
      setEditDraft(initialEditText);
      setEditOpen(true);
    },
  });
  if (onReply) actionRows.push({ key: 'reply', label: t('chat.reply'), onPress: onReply });
  if (onCopy) actionRows.push({ key: 'copy', label: t('chat.copyText'), onPress: onCopy });
  if (onCreateThread) actionRows.push({ key: 'thread', label: t('chat.createThread'), onPress: onCreateThread });
  if (onForward) actionRows.push({ key: 'forward', label: t('chat.forward'), onPress: onForward });
  if (onMarkUnread) actionRows.push({ key: 'unread', label: t('chat.markUnread'), onPress: onMarkUnread });
  if (onPin && (isDm || canPin)) actionRows.push({ key: 'pin', label: isPinned ? t('chat.unpinMessage') : t('chat.pinMessage'), onPress: onPin });
  if (onViewReactions && (reactions?.length ?? 0) > 0) {
    actionRows.push({
      key: 'view_reactions',
      label: t('chat.viewCatReactions'),
      onPress: onViewReactions,
    });
  }
  if (translationAction) actionRows.push({
    key: 'translate',
    label: translationAction.kind === 'toggle'
      ? (translationAction.showingOriginal ? t('chat.showTranslation') : t('chat.showOriginal'))
      : t('chat.translateTo', { language: t(`chat.languageName_${translationAction.target}`) }),
    onPress: translationAction.run,
  });

  const innerContent = (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 10 }}>
      {canReact && (
        <>
        <Text variant="caption" color={theme.colors.text3} style={styles.sectionTitle}>{t('chat.recentEmotes')}</Text>
        <View style={styles.recentRow}>
          {usage === null ? (
            <ActivityIndicator color={theme.colors.accent} />
          ) : topRecentEntries.length > 0 ? (
            topRecentEntries.map((entry) => (
              <Pressable
                key={`${normalizeExprName(entry.name)}:${entry.ownerId ?? ''}`}
                style={[styles.recentBtn, { backgroundColor: theme.colors.bgElev2, borderColor: theme.colors.lineSoft }]}
                onPress={() => {
                  onReact?.(buildExpressionToken(entry, serverUrl ? getOrigin(serverUrl) : null));
                  onClose();
                }}
              >
                <CachedImage uri={entry.emote} scope={realmScope(serverUrl ?? entry.emote ?? '')} contentFit="contain" style={styles.recentImage} />
              </Pressable>
            ))
          ) : (
            DEFAULT_RECENT_EMOJI.slice(0, 5).map((emoji) => (
              <Pressable
                key={emoji}
                style={[styles.recentBtn, { backgroundColor: theme.colors.bgElev2, borderColor: theme.colors.lineSoft }]}
                onPress={() => {
                  onReact?.(emoji);
                  onClose();
                }}
              >
                <Text style={{ fontSize: 20 }}>{emoji}</Text>
              </Pressable>
            ))
          )}
          <Pressable
            style={[styles.recentBtn, { marginLeft: 'auto', backgroundColor: theme.colors.bgElev2, borderColor: theme.colors.accent }]}
            onPress={() => {
              savedOnReactRef.current = onReact;
              setReactionPickerOpen(true);
              onClose();
            }}
          >
            <Animated.View
              pointerEvents="none"
              style={[
                styles.glowBorder,
                {
                  opacity: borderGlowOpacity,
                  shadowColor: theme.colors.accent,
                },
              ]}
            />
            <Animated.View
              pointerEvents="none"
              style={styles.gradientRingWrap}
            >
              <Animated.View
                style={[
                  styles.gradientSpinner,
                  {
                    transform: [{ rotate: borderRotate }],
                  },
                ]}
              >
                <LinearGradient
                  colors={borderGradientColors}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.gradientRing}
                />
              </Animated.View>
            </Animated.View>
            <View style={[styles.ringInnerMask, { backgroundColor: theme.colors.bgElev2 }]}>
              <Animated.View pointerEvents="none" style={[styles.sparkleDot, styles.sparkleTopRight, { backgroundColor: theme.colors.accent, opacity: sparkleOpacity }]} />
              <Animated.View pointerEvents="none" style={[styles.sparkleDot, styles.sparkleBottomLeft, { backgroundColor: theme.colors.accent, opacity: sparkleOpacity }]} />
              <Animated.View style={{ opacity: fadeOpacity }}>
                {rotatingEntry?.emote ? (
                  <CachedImage uri={rotatingEntry.emote} scope={realmScope(serverUrl ?? rotatingEntry.emote ?? '')} contentFit="contain" style={styles.recentImage} />
                ) : (
                  <Text style={{ fontSize: 20 }}>{DEFAULT_RECENT_EMOJI[displayedRotatingIndex % DEFAULT_RECENT_EMOJI.length]}</Text>
                )}
              </Animated.View>
            </View>
          </Pressable>
        </View>
        </>
      )}

        <View style={[styles.actionList, { borderColor: theme.colors.lineSoft, backgroundColor: theme.colors.bgElev2 }]}>
          {actionRows.map((action, index) => (
            <Pressable
              key={action.key}
              onPress={() => {
                if (action.key === 'edit') {
                  action.onPress?.();
                  return;
                }
                action.onPress?.();
                onClose();
              }}
              style={[
                styles.actionBtn,
                index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.lineSoft } : null,
              ]}
            >
              <Text variant="body">{action.label}</Text>
            </Pressable>
          ))}
        </View>

        {canDelete ? (
          <Pressable
            onPress={() => {
              onDelete?.();
              onClose();
            }}
            style={[styles.deleteBtn, { borderColor: theme.colors.danger, backgroundColor: theme.colors.bgElev2 }]}
          >
            <Text variant="body" color={theme.colors.danger}>{t('chat.deleteMessage')}</Text>
          </Pressable>
        ) : null}
    </ScrollView>
  );

  return (
    <>
    {useDesktopPresentation ? (
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={onClose}
        statusBarTranslucent
        supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
      >
        <View style={styles.desktopScrim}>
          <RNPressable style={StyleSheet.absoluteFill} onPress={onClose} />
          <View style={[styles.desktopPanel, { backgroundColor: theme.colors.bgElev1, borderColor: theme.colors.line }]}>
            {innerContent}
          </View>
        </View>
      </Modal>
    ) : (
      <Sheet open={open} onClose={onClose} maxHeightFraction={0.72}>
        {innerContent}
      </Sheet>
    )}
    <ExpressionPicker
      open={canReact && reactionPickerOpen}
      onClose={() => { setReactionPickerOpen(false); savedOnReactRef.current = undefined; }}
      expressionLookup={allowedExpressionLookup}
      serverUrl={serverUrl}
      onSelect={(displayToken, serializedToken) => {
        const react = savedOnReactRef.current ?? onReact;
        savedOnReactRef.current = undefined;
        react?.(serializedToken ?? displayToken);
      }}
    />
    <Sheet open={editOpen} onClose={() => setEditOpen(false)} maxHeightFraction={0.42}>
      <View style={styles.editWrap}>
        <Text variant="subtitle" style={styles.editTitle}>{t('chat.editMessage')}</Text>
        <TextInput
          value={editDraft}
          onChangeText={setEditDraft}
          multiline
          placeholder={t('chat.editMessagePlaceholder')}
          placeholderTextColor={theme.colors.text3}
          style={[
            styles.editInput,
            {
              color: theme.colors.text,
              backgroundColor: theme.colors.bgElev2,
              borderColor: theme.colors.lineSoft,
            },
          ]}
        />
        <View style={styles.editActions}>
          <Pressable
            style={[styles.editBtn, { backgroundColor: theme.colors.bgElev2, borderColor: theme.colors.lineSoft }]}
            onPress={() => setEditOpen(false)}
          >
            <Text variant="body">{t('common.cancel')}</Text>
          </Pressable>
          <Pressable
            style={[styles.editBtn, { backgroundColor: theme.colors.accent }]}
            onPress={async () => {
              const next = editDraft.trim();
              if (!next) return;
              await onEdit?.(next);
              setEditOpen(false);
              onClose();
            }}
          >
            <Text variant="body" color={theme.colors.textOnAccent}>{t('common.save')}</Text>
          </Pressable>
        </View>
      </View>
    </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    marginBottom: 8,
  },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'nowrap',
  },
  recentBtn: {
    width: 46,
    height: 46,
    borderRadius: 8,
    borderWidth: 1,
  },
  recentImage: {
    width: 30,
    height: 30,
  },
  glowBorder: {
    position: 'absolute',
    inset: -1,
    borderRadius: 10,
    shadowOpacity: 0.85,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  gradientRingWrap: {
    position: 'absolute',
    width: 48,
    height: 48,
    borderRadius: 10,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  gradientSpinner: {
    width: 68,
    height: 68,
  },
  gradientRing: {
    flex: 1,
    borderRadius: 10,
  },
  ringInnerMask: {
    width: 44,
    height: 44,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  sparkleDot: {
    position: 'absolute',
    width: 4,
    height: 4,
    borderRadius: 2,
  },
  sparkleTopRight: {
    top: 4,
    right: 4,
  },
  sparkleBottomLeft: {
    bottom: 4,
    left: 4,
  },
  actionList: {
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 14,
    overflow: 'hidden',
  },
  actionBtn: {
    minHeight: 46,
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  deleteBtn: {
    marginTop: 14,
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 48,
  },
  desktopScrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.52)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  desktopPanel: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '82%',
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    elevation: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
  },
  editWrap: {
    paddingHorizontal: 12,
    paddingTop: 8,
    gap: 10,
  },
  editTitle: {
    marginBottom: 2,
  },
  editInput: {
    minHeight: 100,
    maxHeight: 180,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    textAlignVertical: 'top',
  },
  editActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  editBtn: {
    minHeight: 40,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 14,
  },
});
