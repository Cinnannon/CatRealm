import { useMemo, useRef, type ReactNode } from 'react';
import {
  Animated,
  PanResponder,
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { CornerUpLeft } from 'lucide-react-native';
import { useTheme } from '@/theme';
import { useUIStore } from '@/stores/uiStore';

const REPLY_TRIGGER_DX = 52;
const MAX_TRANSLATE_X = 84;
const OPEN_SIDEBAR_TRIGGER_DX = -56;
const EDGE_SWIPE_WIDTH = 36;
const EDGE_OPEN_TRIGGER_DX = 48;

function triggerLightHaptic() {
  if (Platform.OS === 'web') return;
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

interface SwipeableMessageRowProps {
  children: ReactNode;
  /** Called when the user swipes the message to the right past threshold. */
  onReply?: () => void;
  /** Called when the user swipes to the left past threshold (defaults to opening ChannelsSheet). */
  onSwipeLeft?: () => void;
  disabled?: boolean;
}

/**
 * Wraps a chat message row with horizontal gestures:
 * - Swipe right (`dx > 52`) -> Reply to message (with animated CornerUpLeft indicator)
 * - Swipe left (`dx < -56`) -> Open the left sidebar (Servers & Channels drawer)
 */
export function SwipeableMessageRow({
  children,
  onReply,
  onSwipeLeft,
  disabled = false,
}: SwipeableMessageRowProps) {
  const theme = useTheme();
  const translateX = useRef(new Animated.Value(0)).current;
  const thresholdCrossedRef = useRef(false);

  const onReplyRef = useRef(onReply);
  onReplyRef.current = onReply;
  const onSwipeLeftRef = useRef(onSwipeLeft);
  onSwipeLeftRef.current = onSwipeLeft;

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_evt, gestureState) => {
          if (disabled) return false;
          const { dx, dy } = gestureState;
          const absDx = Math.abs(dx);
          const absDy = Math.abs(dy);
          // Claim only clear horizontal drags so vertical FlatList scrolling is never blocked
          if (absDx < 12 || absDx < absDy * 1.35) return false;
          if (dx > 0 && !onReplyRef.current) return false;
          return true;
        },
        onMoveShouldSetPanResponderCapture: (_evt, gestureState) => {
          if (disabled) return false;
          const { dx, dy } = gestureState;
          const absDx = Math.abs(dx);
          const absDy = Math.abs(dy);
          if (absDx < 16 || absDx < absDy * 1.6) return false;
          if (dx > 0 && !onReplyRef.current) return false;
          return true;
        },
        onPanResponderGrant: () => {
          thresholdCrossedRef.current = false;
        },
        onPanResponderMove: (_evt, gestureState) => {
          const { dx } = gestureState;
          if (dx > 0 && onReplyRef.current) {
            const damped = Math.min(MAX_TRANSLATE_X, dx * 0.68);
            translateX.setValue(damped);
            if (dx >= REPLY_TRIGGER_DX && !thresholdCrossedRef.current) {
              thresholdCrossedRef.current = true;
              triggerLightHaptic();
            } else if (dx < REPLY_TRIGGER_DX && thresholdCrossedRef.current) {
              thresholdCrossedRef.current = false;
            }
          } else if (dx < 0) {
            // Subtle left nudge while swiping left to open sidebar
            const dampedLeft = Math.max(-28, dx * 0.25);
            translateX.setValue(dampedLeft);
            if (dx <= OPEN_SIDEBAR_TRIGGER_DX && !thresholdCrossedRef.current) {
              thresholdCrossedRef.current = true;
              triggerLightHaptic();
            }
          }
        },
        onPanResponderRelease: (_evt, gestureState) => {
          const { dx, vx } = gestureState;
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: true,
            damping: 20,
            stiffness: 240,
          }).start();

          if (dx >= REPLY_TRIGGER_DX || (dx > 28 && vx > 0.55)) {
            onReplyRef.current?.();
          } else if (dx <= OPEN_SIDEBAR_TRIGGER_DX || (dx < -32 && vx < -0.55)) {
            if (onSwipeLeftRef.current) {
              onSwipeLeftRef.current();
            } else {
              useUIStore.getState().setChannelsSheetOpen(true);
            }
          }
          thresholdCrossedRef.current = false;
        },
        onPanResponderTerminate: () => {
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: true,
            damping: 20,
            stiffness: 240,
          }).start();
          thresholdCrossedRef.current = false;
        },
      }),
    [disabled, translateX],
  );

  const badgeOpacity = translateX.interpolate({
    inputRange: [0, 14, REPLY_TRIGGER_DX * 0.68],
    outputRange: [0, 0.45, 1],
    extrapolate: 'clamp',
  });

  const badgeScale = translateX.interpolate({
    inputRange: [0, 18, REPLY_TRIGGER_DX * 0.68],
    outputRange: [0.55, 0.85, 1.06],
    extrapolate: 'clamp',
  });

  return (
    <View style={styles.container} {...panResponder.panHandlers}>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.replyBadge,
          {
            backgroundColor: theme.colors.accent + '24',
            borderColor: theme.colors.accent + '66',
            opacity: badgeOpacity,
            transform: [{ scale: badgeScale }],
          },
        ]}
      >
        <CornerUpLeft size={16} color={theme.colors.accent} />
      </Animated.View>
      <Animated.View style={{ transform: [{ translateX }] }}>
        {children}
      </Animated.View>
    </View>
  );
}

interface SwipeSidebarContainerProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  onOpenSidebar?: () => void;
  disabled?: boolean;
}

/**
 * Container wrapper for chat / hub screens so swiping left anywhere on the screen
 * (or swiping right from the left screen edge) opens the Servers & Channels sidebar.
 */
export function SwipeSidebarContainer({
  children,
  style,
  onOpenSidebar,
  disabled = false,
}: SwipeSidebarContainerProps) {
  const onOpenRef = useRef(onOpenSidebar);
  onOpenRef.current = onOpenSidebar;

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_evt, gestureState) => {
          if (disabled) return false;
          const { dx, dy, x0 } = gestureState;
          const absDx = Math.abs(dx);
          const absDy = Math.abs(dy);
          if (absDx < 14 || absDx < absDy * 1.4) return false;
          // Swipe left anywhere OR swipe right from left edge
          const isSwipeLeft = dx < -14;
          const isLeftEdgeSwipeRight = x0 <= EDGE_SWIPE_WIDTH && dx > 14;
          return isSwipeLeft || isLeftEdgeSwipeRight;
        },
        onPanResponderRelease: (_evt, gestureState) => {
          const { dx, vx, x0 } = gestureState;
          const triggeredByLeftSwipe = dx <= OPEN_SIDEBAR_TRIGGER_DX || (dx < -32 && vx < -0.5);
          const triggeredByEdgeSwipe = x0 <= EDGE_SWIPE_WIDTH && (dx >= EDGE_OPEN_TRIGGER_DX || (dx > 24 && vx > 0.45));
          if (triggeredByLeftSwipe || triggeredByEdgeSwipe) {
            triggerLightHaptic();
            if (onOpenRef.current) {
              onOpenRef.current();
            } else {
              useUIStore.getState().setChannelsSheetOpen(true);
            }
          }
        },
      }),
    [disabled],
  );

  return (
    <View style={[{ flex: 1 }, style]} {...panResponder.panHandlers}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    justifyContent: 'center',
  },
  replyBadge: {
    position: 'absolute',
    left: 14,
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 0,
  },
});
