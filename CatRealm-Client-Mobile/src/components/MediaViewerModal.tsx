import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, FlatList, Image, Linking, Modal, Pressable, Share, StyleSheet, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { ArrowDownToLine, Ellipsis, ExternalLink, Forward, Milestone, Share2, Star, X } from 'lucide-react-native';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/theme';
import { useAuthStore } from '@/stores/authStore';
import { useServerStore } from '@/stores/serverStore';
import { useUIStore } from '@/stores/uiStore';
import { findFavoriteByUrl, isGifMediaUrl, useGifFavoritesStore } from '@/stores/gifFavoritesStore';
import { CatRealmVideoControls } from './CatRealmVideoControls';
import { Text } from './Text';

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
    scale.value       = withSpring(1, { damping: 20 });
    transX.value      = withSpring(0, { damping: 20 });
    transY.value      = withSpring(0, { damping: 20 });
    savedScale.value  = 1;
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
        savedScale.value   = scale.value;
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
        scale.value        = withSpring(2.5, { damping: 20 });
        savedScale.value   = 2.5;
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
      <View style={[styles.imagePage, { width: pageWidth, overflow: 'visible' }]}>
        <Reanimated.View style={[{ width: '100%', height: '100%' }, animStyle]}>
          <Image source={{ uri }} resizeMode="contain" style={styles.image} />
        </Reanimated.View>
      </View>
    </GestureDetector>
  );
}

function FullscreenVideo({ uri, pageWidth }: { uri: string; pageWidth: number }) {
  const authState = useAuthStore();
  const servers = useServerStore((s) => s.servers);
  const source = useMemo(() => {
    const uriLower = uri.toLowerCase();
    const matchingServer = servers.find((server) => uriLower.includes(server.url.toLowerCase()));
    const isServerHosted =
      !!matchingServer ||
      (!!authState.serverUrl && uriLower.includes(authState.serverUrl.toLowerCase()));
    if (!isServerHosted) return uri;

    const token = authState.user?.accountType === 'central'
      ? matchingServer?.token
      : authState.token;

    return {
      uri,
      headers: {
        'X-CatRealm-Client': 'mobile',
        Authorization: `Bearer ${token || ''}`,
      },
    };
  }, [authState.serverUrl, authState.token, authState.user?.accountType, servers, uri]);

  const player = useVideoPlayer(source, (instance) => {
    instance.loop = false;
    instance.muted = false;
  });

  useEffect(() => {
    try {
      player.play();
    } catch {
      // The native player may be unavailable during fast modal transitions.
    }
    return () => {
      try {
        player.pause();
      } catch {
        // Expo may release the native shared object before React cleanup runs.
      }
    };
  }, [player]);

  return (
    <View style={[styles.imagePage, { width: pageWidth }]}>
      <VideoView
        player={player}
        style={styles.video}
        contentFit="contain"
        nativeControls={false}
      />
      <CatRealmVideoControls player={player} />
    </View>
  );
}

function MediaPage({
  item,
  pageWidth,
  onZoomChange,
  zoomedShared,
}: {
  item: { url: string; kind?: 'image' | 'video' };
  pageWidth: number;
  onZoomChange: (zoomed: boolean) => void;
  zoomedShared: SharedValue<number>;
}) {
  const mediaKind = item.kind ?? isImageOrVideoUrl(item.url).media;
  if (mediaKind === 'video') {
    return <FullscreenVideo uri={item.url} pageWidth={pageWidth} />;
  }
  return (
    <ZoomableImage
      uri={item.url}
      pageWidth={pageWidth}
      onZoomChange={onZoomChange}
      zoomedShared={zoomedShared}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function isImageOrVideoUrl(url: string): { media: 'image' | 'video' | null; ext: string } {
  const clean = url.split('?')[0]?.toLowerCase() ?? '';
  const ext = clean.includes('.') ? clean.slice(clean.lastIndexOf('.') + 1) : '';
  const imageExt = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif']);
  const videoExt = new Set(['mp4', 'mov', 'm4v', 'webm']);
  if (imageExt.has(ext)) return { media: 'image', ext };
  if (videoExt.has(ext)) return { media: 'video', ext };
  return { media: null, ext };
}

function filenameFromUrl(url: string): string {
  const withoutQuery = url.split('?')[0] ?? url;
  const part = withoutQuery.split('/').pop() ?? '';
  if (part.trim().length > 0) return part;
  return `attachment-${Date.now()}`;
}

export function MediaViewerModal() {
  const theme = useTheme();
  const { t } = useTranslation();
  const open = useUIStore((s) => s.mediaViewerOpen);
  const items = useUIStore((s) => s.mediaViewerItems);
  const index = useUIStore((s) => s.mediaViewerIndex);
  const active = items[index] ?? null;
  const close = useUIStore((s) => s.closeMediaViewer);
  const setIndex = useUIStore((s) => s.setMediaViewerIndex);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isZoomed, setIsZoomed] = useState(false);
  const [toastText, setToastText] = useState<string | null>(null);
  const toastY = useRef(new Animated.Value(-18)).current;
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const dragY = useSharedValue(0);
  const isZoomedShared = useSharedValue(0);
  const { width: pageWidth, height: pageHeight } = useWindowDimensions();

  const activeUrl = active?.url ?? null;
  const activeName = active?.name ?? t('chat.mediaDefault');
  const activeIsGif = isGifMediaUrl(activeUrl);
  const activeGifStarred = useGifFavoritesStore((s) =>
    activeIsGif && activeUrl ? Boolean(findFavoriteByUrl(s.favorites, activeUrl)) : false,
  );
  const toggleGifFavoriteUrl = useGifFavoritesStore((s) => s.toggleUrl);

  useEffect(() => {
    if (open && activeIsGif) {
      void useGifFavoritesStore.getState().ensureLoaded();
    }
  }, [open, activeIsGif]);
  const pageLabel = useMemo(() => {
    if (items.length <= 1) return null;
    return `${index + 1}/${items.length}`;
  }, [index, items.length]);

  useEffect(() => {
    if (!open) return;
    dragY.value = 0;
    isZoomedShared.value = 0;
    setMenuOpen(false);
    setIsZoomed(false);
  }, [dragY, isZoomedShared, open]);

  const onScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const width = event.nativeEvent.layoutMeasurement.width || 1;
    const next = Math.round(event.nativeEvent.contentOffset.x / width);
    setIndex(next);
    setIsZoomed(false);
    isZoomedShared.value = 0;
  };

  const handleZoomChange = useCallback((zoomed: boolean) => {
    setIsZoomed(zoomed);
    if (zoomed) setMenuOpen(false);
  }, []);

  const onSave = () => {
    setMenuOpen(false);
    void (async () => {
      if (!activeUrl) return;
      try {
        const detected = isImageOrVideoUrl(activeUrl).media;
        const mediaKind = active?.kind ?? detected;
        // Photos needs a real extension; extensionless proxy URLs get one from their kind.
        const baseName = filenameFromUrl(activeUrl);
        const fileName = mediaKind && !detected ? `${baseName}.${mediaKind === 'video' ? 'mp4' : 'jpg'}` : baseName;
        const destination = new FileSystem.File(FileSystem.Paths.cache, `${Date.now()}-${fileName}`);
        const downloaded = await FileSystem.File.downloadFileAsync(activeUrl, destination);

        let savedToPhotos = false;
        if (mediaKind) {
          const perms = await MediaLibrary.requestPermissionsAsync(true);
          if (perms.granted) {
            await MediaLibrary.Asset.create(downloaded.uri);
            savedToPhotos = true;
          }
        }

        if (!savedToPhotos) {
          const available = await Sharing.isAvailableAsync();
          if (available) {
            await Sharing.shareAsync(downloaded.uri, {
              dialogTitle: t('chat.saveAttachmentTitle'),
            });
          } else {
            await Share.share({ message: downloaded.uri, url: downloaded.uri });
          }
        }

        setToastText(savedToPhotos ? t('chat.imageSaved') : t('chat.attachmentSaved'));
        toastY.setValue(-18);
        toastOpacity.setValue(0);
        Animated.sequence([
          Animated.parallel([
            Animated.timing(toastY, { toValue: 0, duration: 180, useNativeDriver: true }),
            Animated.timing(toastOpacity, { toValue: 1, duration: 180, useNativeDriver: true }),
          ]),
          Animated.delay(1400),
          Animated.parallel([
            Animated.timing(toastY, { toValue: -18, duration: 180, useNativeDriver: true }),
            Animated.timing(toastOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
          ]),
        ]).start(() => setToastText(null));
      } catch {
        Alert.alert(t('settings.saveFailedTitle'), t('chat.saveAttachmentFailed'));
      }
    })();
  };

  const onForward = () => {
    setMenuOpen(false);
    Alert.alert(t('chat.forward'), t('chat.forwardWipMsg'));
  };

  const onShare = async () => {
    setMenuOpen(false);
    if (!activeUrl) return;
    await Share.share({ message: activeUrl, url: activeUrl });
  };

  const onOpenInBrowser = async () => {
    setMenuOpen(false);
    if (!activeUrl) return;
    await Linking.openURL(activeUrl);
  };

  const onJumpToMessage = () => {
    setMenuOpen(false);
    Alert.alert(t('chat.jumpToMessage'), t('chat.jumpToMessageWipMsg'));
  };

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
              runOnJS(close)();
            });
            return;
          }
          dragY.value = withSpring(0, { damping: 20, stiffness: 220 });
        }),
    [close, dragY, isZoomed, isZoomedShared, pageHeight],
  );
  const dragStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: dragY.value }],
    opacity: interpolate(Math.abs(dragY.value), [0, pageHeight * 0.55], [1, 0.86]),
  }));
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(Math.abs(dragY.value), [0, pageHeight * 0.55], [1, 0.3]),
  }));

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={close}
      statusBarTranslucent
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
    >
      <GestureDetector gesture={dismissGesture}>
      <View style={styles.root}>
        <Reanimated.View pointerEvents="none" style={[styles.scrim, { backgroundColor: theme.colors.scrim }, scrimStyle]} />
        {/* Chrome — hidden while zoomed */}
        {!isZoomed && (
          <>
            <View style={styles.header}>
              <Pressable style={styles.closeBtn} onPress={close}>
                <X size={22} color={theme.colors.text} />
              </Pressable>
              <Text numberOfLines={1} style={{ color: theme.colors.text, flex: 1 }}>
                {activeName}
              </Text>
              {activeIsGif && activeUrl ? (
                <Pressable
                  style={styles.closeBtn}
                  onPress={() => void toggleGifFavoriteUrl(activeUrl)}
                  accessibilityRole="button"
                  accessibilityLabel={activeGifStarred ? t('gif.removeFavorite') : t('gif.favoriteGif')}
                >
                  <Star
                    size={20}
                    color={activeGifStarred ? '#facc15' : theme.colors.text}
                    fill={activeGifStarred ? '#facc15' : 'transparent'}
                  />
                </Pressable>
              ) : null}
              <Pressable style={styles.closeBtn} onPress={() => setMenuOpen((prev) => !prev)}>
                <Ellipsis size={22} color={theme.colors.text} />
              </Pressable>
            </View>
            {pageLabel ? (
              <View style={[styles.pageTag, { backgroundColor: theme.colors.bgElev1, borderColor: theme.colors.lineSoft }]}>
                <Text variant="caption" color={theme.colors.text3}>{pageLabel}</Text>
              </View>
            ) : null}
            {menuOpen ? (
              <Pressable style={styles.menuDismissLayer} onPress={() => setMenuOpen(false)} />
            ) : null}
            {menuOpen ? (
              <View style={[styles.menu, { backgroundColor: theme.colors.bgElev1, borderColor: theme.colors.lineSoft }]}>
                <Pressable style={styles.menuItem} onPress={onSave}>
                  <ArrowDownToLine size={16} color={theme.colors.text2} />
                  <Text>{t('common.save')}</Text>
                </Pressable>
                <Pressable style={styles.menuItem} onPress={onForward}>
                  <Forward size={16} color={theme.colors.text2} />
                  <Text>{t('chat.forward')}</Text>
                </Pressable>
                <Pressable style={styles.menuItem} onPress={onShare}>
                  <Share2 size={16} color={theme.colors.text2} />
                  <Text>{t('settings.share')}</Text>
                </Pressable>
                <Pressable style={styles.menuItem} onPress={onOpenInBrowser}>
                  <ExternalLink size={16} color={theme.colors.text2} />
                  <Text>{t('chat.openInBrowser')}</Text>
                </Pressable>
                <Pressable style={styles.menuItem} onPress={onJumpToMessage}>
                  <Milestone size={16} color={theme.colors.text2} />
                  <Text>{t('chat.jumpToMessage')}</Text>
                </Pressable>
              </View>
            ) : null}
          </>
        )}
        <Reanimated.View style={[{ flex: 1 }, dragStyle]}>
          <FlatList
            key={`pager-${pageWidth}`}
            horizontal
            pagingEnabled
            directionalLockEnabled
            bounces={false}
            alwaysBounceHorizontal={false}
            showsHorizontalScrollIndicator={false}
            scrollEnabled={!isZoomed}
            data={items}
            keyExtractor={(item, itemIndex) => `${item.url}:${itemIndex}`}
            initialScrollIndex={index}
            getItemLayout={(_data, itemIndex) => ({ length: pageWidth, offset: pageWidth * itemIndex, index: itemIndex })}
            onMomentumScrollEnd={onScrollEnd}
            style={{ flex: 1 }}
            contentContainerStyle={{ flexGrow: 1 }}
            renderItem={({ item }) => (
              <MediaPage
                item={item}
                pageWidth={pageWidth}
                onZoomChange={handleZoomChange}
                zoomedShared={isZoomedShared}
              />
            )}
          />
        </Reanimated.View>
        {toastText ? (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.toast,
              {
                backgroundColor: theme.colors.bgElev1,
                borderColor: theme.colors.lineSoft,
                opacity: toastOpacity,
                transform: [{ translateY: toastY }],
              },
            ]}
          >
            <View style={styles.toastInner}>
              <ArrowDownToLine size={13} color={theme.colors.text2} />
              <Text variant="caption">{toastText}</Text>
            </View>
          </Animated.View>
        ) : null}
      </View>
      </GestureDetector>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  scrim: {
    ...StyleSheet.absoluteFill,
  },
  header: {
    position: 'absolute',
    top: 56,
    left: 14,
    right: 14,
    zIndex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  closeBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  imagePage: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 56,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  video: {
    width: '100%',
    height: '100%',
    backgroundColor: '#000',
  },
  pageTag: {
    position: 'absolute',
    top: 98,
    right: 16,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    zIndex: 2,
  },
  menu: {
    position: 'absolute',
    top: 96,
    right: 14,
    borderWidth: 1,
    borderRadius: 8,
    overflow: 'hidden',
    zIndex: 3,
    minWidth: 190,
  },
  menuDismissLayer: {
    ...StyleSheet.absoluteFill,
    zIndex: 2,
  },
  menuItem: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
  },
  toast: {
    position: 'absolute',
    top: 52,
    alignSelf: 'center',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    zIndex: 4,
  },
  toastInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
});
