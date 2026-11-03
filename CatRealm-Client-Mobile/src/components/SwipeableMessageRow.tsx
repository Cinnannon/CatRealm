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
import { useDeviceLayout } from '@/hooks/useDeviceLayout';
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

function isAnySidebarOpen(): boolean {
  const state = useUIStore.getState();
  return Boolean(state.channelsSheetOpen || state.serverDrawerOpen || state.closingDrawer);
}

interface SwipeableMessageRowProps {
  children: ReactNode;
  /** Called when the user swipes the message to the left past threshold. */
  onReply?: () => void;
  /** Called when the user swipes to the right past threshold (defaults to opening ChannelsSheet). */
  onSwipeLeft?: () => void;
  /** Explicitly disable opening the sidebar via swipe (defaults to true when `isTablet` is true). */
  disableSidebarSwipe?: boolean;
  disabled?: boolean;
}

/**
 * Wraps a chat message row with horizontal gestures:
 * - Swipe left (`dx <= -52`) -> Reply to message (with animated CornerUpLeft indicator on the right)
 * - Swipe right (`dx > 0`) -> Live-drags and immediately opens the left sidebar (only when sidebar is not already visible on large screens)
 */
export function SwipeableMessageRow({
  children,
  onReply,
  onSwipeLeft,
  disableSidebarSwipe,
  disabled = false,
}: SwipeableMessageRowProps) {
  const theme = useTheme();
  const { isTablet } = useDeviceLayout();
  const sidebarSwipeDisabled = disableSidebarSwipe ?? isTablet;

  const translateX = useRef(new Animated.Value(0)).current;
  const gestureModeRef = useRef<'reply' | 'sidebar' | null>(null);
  const peakDxRef = useRef(0);
  const thresholdCrossedRef = useRef(false);
  const drawerDragStartedRef = useRef(false);
  const drawerOpenedDuringMoveRef = useRef(false);

  const onReplyRef = useRef(onReply);
  onReplyRef.current = onReply;
  const onOpenSidebarRef = useRef(onSwipeLeft);
  onOpenSidebarRef.current = onSwipeLeft;
  const sidebarSwipeDisabledRef = useRef(sidebarSwipeDisabled);
  sidebarSwipeDisabledRef.current = sidebarSwipeDisabled;

  const triggerOpenSidebar = () => {
    if (onOpenSidebarRef.current) {
      onOpenSidebarRef.current();
    } else {
      useUIStore.getState().setChannelsSheetOpen(true);
    }
  };

  const triggerCloseSidebar = () => {
    const ui = useUIStore.getState();
    if (ui.channelsSheetOpen) ui.setChannelsSheetOpen(false);
    if (ui.serverDrawerOpen) ui.setServerDrawerOpen(false);
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_evt, gestureState) => {
          if (disabled || isAnySidebarOpen()) return false;
          const { dx, dy } = gestureState;
          const absDx = Math.abs(dx);
          const absDy = Math.abs(dy);
          // Claim only clear horizontal drags so vertical FlatList scrolling is never blocked
          if (absDx < 10 || absDx < absDy * 1.3) return false;
          if (dx < 0 && !onReplyRef.current) return false;
          if (dx > 0 && sidebarSwipeDisabledRef.current) return false;
          return true;
        },
        onMoveShouldSetPanResponderCapture: (_evt, gestureState) => {
          if (disabled || isAnySidebarOpen()) return false;
          const { dx, dy } = gestureState;
          const absDx = Math.abs(dx);
          const absDy = Math.abs(dy);
          if (absDx < 14 || absDx < absDy * 1.5) return false;
          if (dx < 0 && !onReplyRef.current) return false;
          if (dx > 0 && sidebarSwipeDisabledRef.current) return false;
          return true;
        },
        onPanResponderGrant: () => {
          gestureModeRef.current = null;
          peakDxRef.current = 0;
          thresholdCrossedRef.current = false;
          drawerDragStartedRef.current = false;
          drawerOpenedDuringMoveRef.current = false;
        },
        onPanResponderMove: (_evt, gestureState) => {
          if (isAnySidebarOpen() && drawerOpenedDuringMoveRef.current) return;
          const { dx } = gestureState;

          if (gestureModeRef.current === null) {
            if (dx < 0 && onReplyRef.current && !isAnySidebarOpen()) {
              gestureModeRef.current = 'reply';
            } else if (dx > 0 && !sidebarSwipeDisabledRef.current && !isAnySidebarOpen()) {
              gestureModeRef.current = 'sidebar';
            } else {
              return;
            }
          }

          if (isAnySidebarOpen()) {
            if (gestureModeRef.current === 'reply') {
              translateX.setValue(0);
            }
            gestureModeRef.current = null;
            drawerDragStartedRef.current = false;
            drawerOpenedDuringMoveRef.current = false;
            return;
          }

          if (gestureModeRef.current === 'reply') {
            // Swipe message left to reply — never affects sidebar
            const clampedNegDx = Math.min(0, dx);
            const damped = Math.max(MIN_TRANSLATE_X, clampedNegDx * 0.68);
            translateX.setValue(damped);
            if (clampedNegDx <= REPLY_TRIGGER_DX && !thresholdCrossedRef.current) {
              thresholdCrossedRef.current = true;
              triggerLightHaptic();
            } else if (clampedNegDx > REPLY_TRIGGER_DX && thresholdCrossedRef.current) {
              thresholdCrossedRef.current = false;
            }
          } else if (gestureModeRef.current === 'sidebar') {
            peakDxRef.current = Math.max(peakDxRef.current, dx);
            if (!drawerDragStartedRef.current && dx > 0) {
              drawerDragStartedRef.current = true;
              beginDrawerOpenDrag();
            }
            if (!drawerOpenedDuringMoveRef.current) {
              updateDrawerOpenDrag(Math.max(0, dx) * 1.5);
              if (dx >= OPEN_SIDEBAR_TRIGGER_DX) {
                drawerOpenedDuringMoveRef.current = true;
                triggerLightHaptic();
                endDrawerOpenDrag(true, triggerOpenSidebar);
              }
            } else if (dx < peakDxRef.current - 38 || dx <= 10) {
              // User reversed swipe direction to the left during the same drag -> close sidebar
              drawerOpenedDuringMoveRef.current = false;
              drawerDragStartedRef.current = false;
              peakDxRef.current = Math.max(0, dx);
              triggerLightHaptic();
              triggerCloseSidebar();
              endDrawerOpenDrag(false, triggerOpenSidebar);
            }
          }
        },
        onPanResponderRelease: (_evt, gestureState) => {
          const { dx, vx } = gestureState;
          const mode = gestureModeRef.current;

          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: true,
            damping: 20,
            stiffness: 240,
          }).start();

          if (mode === 'reply') {
            if (dx <= REPLY_TRIGGER_DX || (dx < -28 && vx < -0.55)) {
              onReplyRef.current?.();
            }
          } else if (mode === 'sidebar' && drawerDragStartedRef.current && !drawerOpenedDuringMoveRef.current) {
            const shouldOpen = dx >= OPEN_SIDEBAR_TRIGGER_DX || (dx > 24 && vx > 0.35);
            if (shouldOpen) triggerLightHaptic();
            endDrawerOpenDrag(shouldOpen, triggerOpenSidebar);
          }

          gestureModeRef.current = null;
          peakDxRef.current = 0;
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
          if (gestureModeRef.current === 'sidebar' && drawerDragStartedRef.current && !drawerOpenedDuringMoveRef.current) {
            endDrawerOpenDrag(false, triggerOpenSidebar);
          }
          gestureModeRef.current = null;
          peakDxRef.current = 0;
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
 * Automatically disabled on large/tablet screens where the sidebar is already visible.
 */
export function SwipeSidebarContainer({
  children,
  style,
  onOpenSidebar,
  disabled = false,
}: SwipeSidebarContainerProps) {
  const { isTablet } = useDeviceLayout();
  const effectiveDisabled = disabled || isTablet;
  const effectiveDisabledRef = useRef(effectiveDisabled);
  effectiveDisabledRef.current = effectiveDisabled;

  const onOpenRef = useRef(onOpenSidebar);
  onOpenRef.current = onOpenSidebar;
  const drawerDragStartedRef = useRef(false);
  const drawerOpenedDuringMoveRef = useRef(false);
  const peakDxRef = useRef(0);

  const triggerOpen = () => {
    if (onOpenRef.current) {
      onOpenRef.current();
    } else {
      useUIStore.getState().setChannelsSheetOpen(true);
    }
  };

  const triggerClose = () => {
    const ui = useUIStore.getState();
    if (ui.channelsSheetOpen) ui.setChannelsSheetOpen(false);
    if (ui.serverDrawerOpen) ui.setServerDrawerOpen(false);
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_evt, gestureState) => {
          if (effectiveDisabledRef.current || isAnySidebarOpen()) return false;
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
          peakDxRef.current = 0;
        },
        onPanResponderMove: (_evt, gestureState) => {
          if (isAnySidebarOpen() && drawerOpenedDuringMoveRef.current) return;
          const { dx } = gestureState;
          peakDxRef.current = Math.max(peakDxRef.current, dx);
          if (!drawerDragStartedRef.current && dx > 0) {
            drawerDragStartedRef.current = true;
            beginDrawerOpenDrag();
          }
          if (!drawerOpenedDuringMoveRef.current) {
            if (dx <= 0) return;
            updateDrawerOpenDrag(dx * 1.5);
            if (dx >= OPEN_SIDEBAR_TRIGGER_DX) {
              drawerOpenedDuringMoveRef.current = true;
              triggerLightHaptic();
              endDrawerOpenDrag(true, triggerOpen);
            }
          } else if (dx < peakDxRef.current - 38 || dx <= 10) {
            drawerOpenedDuringMoveRef.current = false;
            drawerDragStartedRef.current = false;
            peakDxRef.current = Math.max(0, dx);
            triggerLightHaptic();
            triggerClose();
            endDrawerOpenDrag(false, triggerOpen);
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
          peakDxRef.current = 0;
        },
        onPanResponderTerminate: () => {
          if (drawerDragStartedRef.current && !drawerOpenedDuringMoveRef.current) {
            endDrawerOpenDrag(false, triggerOpen);
          }
          drawerDragStartedRef.current = false;
          drawerOpenedDuringMoveRef.current = false;
          peakDxRef.current = 0;
        },
      }),
    [],
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
