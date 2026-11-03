/**
 * Avatar — user portrait with optional status ring + verified flair.
 * Self-heals failed loads: cached file → remote URL → CatRealm default avatar,
 * retrying the real avatar with backoff. The initial is a last resort.
 */

// Same cadence desktop uses for profile reloads.
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, View, StyleSheet } from 'react-native';
import * as Battery from 'expo-battery';
import { Image as ExpoImage } from 'expo-image';
import { ImagePlaceholder } from './ImagePlaceholder';
import { useImageReveal } from './FadeInImage';
import { useTheme } from '@/theme';
import { useAuthStore } from '@/stores/authStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { defaultAvatarUrl, resolveAvatarUrl } from '@/utils/mediaUrl';
import { useCachedUri, centralScope, realmScope, evictCachedFile } from '@/lib/imageCache';
import type { AccountType, UserStatus } from '@/types';
import type { StyleProp, ViewStyle } from 'react-native';
import { Text } from './Text';

export interface AvatarProps {
  username: string;
  uri?: string | null;
  baseUrl?: string | null;
  accountType?: AccountType | null;
  size?: number;
  shape?: 'circle' | 'square';
  status?: UserStatus | null;
  showStatus?: boolean;
  style?: StyleProp<ViewStyle>;
}

const useSafePowerState = () => {
  if (Platform.OS === 'web') {
    return { lowPowerMode: false, batteryLevel: -1, batteryState: Battery.BatteryState.UNKNOWN };
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return Battery.usePowerState();
};

export function Avatar({
  username,
  uri,
  baseUrl,
  accountType,
  size = 40,
  shape = 'circle',
  status,
  showStatus = true,
  style,
}: AvatarProps) {
  const theme = useTheme();
  const { lowPowerMode, batteryLevel, batteryState } = useSafePowerState();
  const showAvatarBackground = useSettingsStore((s) => s.showAvatarBackground);
  const playGifAvatars = useSettingsStore((s) => s.playGifAvatars);
  const authAccountType = useAuthStore((s) => s.user?.accountType);
  const authServerUrl = useAuthStore((s) => s.serverUrl);
  const effectiveAccountType = accountType ?? authAccountType ?? null;
  const initial = (username || '?').charAt(0).toUpperCase();
  const dotSize = Math.max(8, Math.round(size * 0.28));
  const resolvedUri = useMemo(
    () =>
      resolveAvatarUrl(uri, {
        accountType: effectiveAccountType,
        baseUrl: baseUrl ?? (effectiveAccountType === 'local' ? authServerUrl : undefined),
      }),
    [authServerUrl, baseUrl, effectiveAccountType, uri],
  );
  const cacheScope = useMemo(() => {
    if (effectiveAccountType === 'central') return centralScope('Avatars');
    const serverUrl = baseUrl ?? authServerUrl;
    return serverUrl ? realmScope(serverUrl) : centralScope('Avatars');
  }, [effectiveAccountType, baseUrl, authServerUrl]);
  const cachedUri = useCachedUri(resolvedUri, cacheScope);
  const [failedUris, setFailedUris] = useState<ReadonlySet<string>>(() => new Set());
  const retryCountRef = useRef(0);
  const batterySaverEnabled = lowPowerMode || (
    batteryState === Battery.BatteryState.UNPLUGGED &&
    typeof batteryLevel === 'number' &&
    batteryLevel >= 0 &&
    batteryLevel <= 0.15
  );
  const animateGif = playGifAvatars && !batterySaverEnabled;
  const borderRadius = shape === 'circle' ? size / 2 : Math.max(4, Math.round(size * 0.16));

  useEffect(() => {
    retryCountRef.current = 0;
    setFailedUris(new Set());
  }, [resolvedUri]);

  // A transient failure (cache file mid-write, network blip) must not pin the initial.
  useEffect(() => {
    if (failedUris.size === 0 || retryCountRef.current >= RETRY_DELAYS_MS.length) return;
    const timer = setTimeout(() => {
      retryCountRef.current += 1;
      setFailedUris(new Set());
    }, RETRY_DELAYS_MS[retryCountRef.current]);
    return () => clearTimeout(timer);
  }, [failedUris]);

  const imageUri = [cachedUri, resolvedUri, defaultAvatarUrl()]
    .find((candidate): candidate is string => !!candidate && !failedUris.has(candidate)) ?? null;
  const { loaded, transition, markLoaded } = useImageReveal(imageUri);

  const handleError = (uri: string) => {
    evictCachedFile(uri);
    setFailedUris((prev) => new Set(prev).add(uri));
  };

  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius,
          backgroundColor: showAvatarBackground ? theme.colors.bgElev2 : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'visible',
        },
        style,
      ]}
    >
      {imageUri ? (
        <>
          {/* A picture is on its way: show the placeholder, not the initial. */}
          {!loaded && <ImagePlaceholder radius={borderRadius} />}
          <ExpoImage
            source={{ uri: imageUri }}
            style={{ width: size, height: size, borderRadius }}
            onLoad={markLoaded}
            onError={() => handleError(imageUri)}
            transition={transition}
            accessibilityIgnoresInvertColors
            autoplay={animateGif}
            cachePolicy="memory"
          />
        </>
      ) : (
        <Text
          variant="subtitle"
          color={theme.colors.text2}
          style={{ fontSize: size * 0.42, lineHeight: size }}
        >
          {initial}
        </Text>
      )}
      {showStatus && status && (
        <View
          style={[
            styles.statusDot,
            {
              width: dotSize,
              height: dotSize,
              borderRadius: dotSize / 2,
              backgroundColor: theme.colors.statusColor[status],
              borderColor: theme.colors.bgApp,
              borderWidth: Math.max(2, Math.round(size * 0.06)),
            },
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  statusDot: {
    position: 'absolute',
    right: -1,
    bottom: -1,
  },
});
