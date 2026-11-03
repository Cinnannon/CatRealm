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
import {
  beginDrawerOpenDrag,
  endDrawerOpenDrag,
  updateDrawerOpenDrag,
} from '@/hooks/useDrawerTransition';

const REPLY_TRIGGER_DX = -52;
const MIN_TRANSLATE_X = -84;
const OPEN_SIDEBAR_TRIGGER_DX = 48;

function triggerLightHaptic() {
  if (Platform.OS === 'web') return;
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

interface SwipeableMessageRowProps {
  children: ReactNode;
  /** Called when the user swipes the message to the left past threshold. */
  onReply?: () => void;
  /** Called when the user swipes to the right past threshold (defaults to opening ChannelsSheet). */
  onSwipeLeft?: () => void;
  disabled?: boolean;
}

/**
 * Wraps a chat message row with horizontal gestures:
 * - Swipe left (`dx <= -52`) -> Reply to message (with animated CornerUpLeft indicator on the right)
 * - Swipe right (`dx > 0`) -> Live-drags and immediately opens the left sidebar (Servers & Channels drawer)
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
  const drawerDragStartedRef = useRef(false);
  const drawerOpenedDuringMoveRef = useRef(false);

  const onReplyRef = useRef(onReply);
  onReplyRef.current = onReply;
  const onOpenSidebarRef = useRef(onSwipeLeft);
  onOpenSidebarRef.current = onSwipeLeft;

  const triggerOpenSidebar = () => {
    if (onOpenSidebarRef.current) {
      onOpenSidebarRef.current();
    } else {
      useUIStore.getState().setChannelsSheetOpen(true);
    }
  };

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
          if (absDx < 10 || absDx < absDy * 1.3) return false;
          if (dx < 0 && !onReplyRef.current) return false;
          return true;
        },
        onMoveShouldSetPanResponderCapture: (_evt, gestureState) => {
          if (disabled) return false;
          const { dx, dy } = gestureState;
          const absDx = Math.abs(dx);
          const absDy = Math.abs(dy);
          if (absDx < 14 || absDx < absDy * 1.5) return false;
          if (dx < 0 && !onReplyRef.current) return false;
          return true;
        },
        onPanResponderGrant: () => {
          thresholdCrossedRef.current = false;
          drawerDragStartedRef.current = false;
          drawerOpenedDuringMoveRef.current = false;
        },
        onPanResponderMove: (_evt, gestureState) => {
          const { dx } = gestureState;
          if (dx < 0 && onReplyRef.current) {
            // Swipe message left to reply
            const damped = Math.max(MIN_TRANSLATE_X, dx * 0.68);
            translateX.setValue(damped);
            if (dx <= REPLY_TRIGGER_DX && !thresholdCrossedRef.current) {
              thresholdCrossedRef.current = true;
              triggerLightHaptic();
            } else if (dx > REPLY_TRIGGER_DX && thresholdCrossedRef.current) {
              thresholdCrossedRef.current = false;
            }
          } else if (dx > 0) {
            // Live-drag and immediately open the left sidebar without waiting for thumb release
            if (!drawerDragStartedRef.current) {
              drawerDragStartedRef.current = true;
              beginDrawerOpenDrag();
            }
            if (!drawerOpenedDuringMoveRef.current) {
              updateDrawerOpenDrag(dx * 1.5);
              if (dx >= OPEN_SIDEBAR_TRIGGER_DX) {
                drawerOpenedDuringMoveRef.current = true;
                triggerLightHaptic();
                endDrawerOpenDrag(true, triggerOpenSidebar);
              }
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

          if (dx <= REPLY_TRIGGER_DX || (dx < -28 && vx < -0.55)) {
            onReplyRef.current?.();
          } else if (drawerDragStartedRef.current && !drawerOpenedDuringMoveRef.current) {
            const shouldOpen = dx >= OPEN_SIDEBAR_TRIGGER_DX || (dx > 24 && vx > 0.35);
            if (shouldOpen) triggerLightHaptic();
            endDrawerOpenDrag(shouldOpen, triggerOpenSidebar);
          }
          thresholdCrossedRef.current = false;
          drawerDragStartedRef.current = false;
          drawerOpenedDuringMoveRef.current = false;
        },
        onPanResponderTerminate: () => {
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: true,
            damping: 20,
            stiffness: 240,
          }).start();
          if (drawerDragStartedRef.current && !drawerOpenedDuringMoveRef.current) {
            endDrawerOpenDrag(false, triggerOpenSidebar);
          }
          thresholdCrossedRef.current = false;
          drawerDragStartedRef.current = false;
          drawerOpenedDuringMoveRef.current = false;
        },
      }),
    [disabled, translateX],
  );

  const badgeOpacity = translateX.interpolate({
    inputRange: [REPLY_TRIGGER_DX * 0.68, -14, 0],
    outputRange: [1, 0.45, 0],
    extrapolate: 'clamp',
  });

  const badgeScale = translateX.interpolate({
    inputRange: [REPLY_TRIGGER_DX * 0.68, -18, 0],
    outputRange: [1.06, 0.85, 0.55],
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
 * Container wrapper for chat / hub screens so swiping right anywhere on the screen
 * live-drags and immediately opens the Servers & Channels left sidebar while the thumb is still moving.
 */
export function SwipeSidebarContainer({
  children,
  style,
  onOpenSidebar,
  disabled = false,
}: SwipeSidebarContainerProps) {
  const onOpenRef = useRef(onOpenSidebar);
  onOpenRef.current = onOpenSidebar;
  const drawerDragStartedRef = useRef(false);
  const drawerOpenedDuringMoveRef = useRef(false);

  const triggerOpen = () => {
    if (onOpenRef.current) {
      onOpenRef.current();
    } else {
      useUIStore.getState().setChannelsSheetOpen(true);
    }
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_evt, gestureState) => {
          if (disabled) return false;
          const { dx, dy } = gestureState;
          const absDx = Math.abs(dx);
          const absDy = Math.abs(dy);
          if (absDx < 10 || absDx < absDy * 1.3) return false;
          // Swipe right anywhere opens the left sidebar
          return dx > 10;
        },
        onPanResponderGrant: () => {
          drawerDragStartedRef.current = false;
          drawerOpenedDuringMoveRef.current = false;
        },
        onPanResponderMove: (_evt, gestureState) => {
          const { dx } = gestureState;
          if (dx <= 0) return;
          if (!drawerDragStartedRef.current) {
            drawerDragStartedRef.current = true;
            beginDrawerOpenDrag();
          }
          if (!drawerOpenedDuringMoveRef.current) {
            updateDrawerOpenDrag(dx * 1.5);
            if (dx >= OPEN_SIDEBAR_TRIGGER_DX) {
              drawerOpenedDuringMoveRef.current = true;
              triggerLightHaptic();
              endDrawerOpenDrag(true, triggerOpen);
            }
          }
        },
        onPanResponderRelease: (_evt, gestureState) => {
          const { dx, vx } = gestureState;
          if (drawerDragStartedRef.current && !drawerOpenedDuringMoveRef.current) {
            const shouldOpen = dx >= OPEN_SIDEBAR_TRIGGER_DX || (dx > 24 && vx > 0.35);
            if (shouldOpen) triggerLightHaptic();
            endDrawerOpenDrag(shouldOpen, triggerOpen);
          }
          drawerDragStartedRef.current = false;
          drawerOpenedDuringMoveRef.current = false;
        },
        onPanResponderTerminate: () => {
          if (drawerDragStartedRef.current && !drawerOpenedDuringMoveRef.current) {
            endDrawerOpenDrag(false, triggerOpen);
          }
          drawerDragStartedRef.current = false;
          drawerOpenedDuringMoveRef.current = false;
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
    right: 14,
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 0,
  },
});
