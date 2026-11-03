import { useEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';
import { useUIStore } from '@/stores/uiStore';

interface DrawerLiveHandle {
  kind: 'channels' | 'servers';
  width: number;
  open: boolean;
  slideAnim: Animated.Value;
  fadeAnim: Animated.Value;
  setDragging: (v: boolean) => void;
}

const liveHandles = new Set<DrawerLiveHandle>();

/**
 * Starts a live interactive open-drag for the channels drawer so it mounts immediately
 * and follows the user's thumb before they lift their finger.
 */
export function beginDrawerOpenDrag() {
  const ui = useUIStore.getState();
  if (ui.channelsSheetOpen || ui.serverDrawerOpen || ui.closingDrawer) return;
  for (const h of liveHandles) {
    if (h.kind === 'channels' && !h.open) {
      h.setDragging(true);
      h.slideAnim.setValue(-h.width);
      h.fadeAnim.setValue(0);
    }
  }
}

/**
 * Updates the channels drawer's horizontal translation in real time as the thumb moves right (`dx > 0`).
 */
export function updateDrawerOpenDrag(dx: number) {
  const ui = useUIStore.getState();
  if (ui.channelsSheetOpen || ui.serverDrawerOpen || ui.closingDrawer) return;
  const clampedDx = Math.max(0, dx);
  for (const h of liveHandles) {
    if (h.kind === 'channels' && !h.open) {
      const nextX = Math.min(0, -h.width + clampedDx);
      const progress = Math.min(1, clampedDx / Math.max(1, h.width));
      h.slideAnim.setValue(nextX);
      h.fadeAnim.setValue(progress);
    }
  }
}

/**
 * Finishes a live interactive open-drag, animating to open (`0`) or back to closed (`-width`).
 */
export function endDrawerOpenDrag(shouldOpen: boolean, onConfirmOpen: () => void) {
  const ui = useUIStore.getState();
  if (shouldOpen) {
    onConfirmOpen();
    for (const h of liveHandles) {
      if (h.kind === 'channels') {
        Animated.parallel([
          Animated.spring(h.slideAnim, {
            toValue: 0,
            useNativeDriver: true,
            damping: 22,
            stiffness: 260,
          }),
          Animated.timing(h.fadeAnim, {
            toValue: 1,
            duration: 140,
            useNativeDriver: true,
          }),
        ]).start(() => {
          h.setDragging(false);
        });
      }
    }
    return;
  }

  // If already open, do not animate to -width! Keep open at 0.
  if (ui.channelsSheetOpen || ui.serverDrawerOpen) {
    for (const h of liveHandles) {
      if (h.kind === 'channels') {
        Animated.parallel([
          Animated.spring(h.slideAnim, {
            toValue: 0,
            useNativeDriver: true,
            damping: 22,
            stiffness: 260,
          }),
          Animated.timing(h.fadeAnim, {
            toValue: 1,
            duration: 120,
            useNativeDriver: true,
          }),
        ]).start(() => {
          h.setDragging(false);
        });
      }
    }
    return;
  }

  for (const h of liveHandles) {
    if (h.kind === 'channels' && !h.open) {
      Animated.parallel([
        Animated.timing(h.slideAnim, {
          toValue: -h.width,
          duration: 160,
          useNativeDriver: true,
        }),
        Animated.timing(h.fadeAnim, {
          toValue: 0,
          duration: 160,
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) h.setDragging(false);
      });
    }
  }
}

/** Keep an exiting drawer mounted, without letting an obsolete close hide a reopened one. */
export function useDrawerTransition(
  open: boolean,
  width: number,
  onClosed?: () => void,
  closeRequested = false,
  kind: 'channels' | 'servers' = 'channels',
) {
  const slideAnim = useRef(new Animated.Value(-width)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const closedCallback = useRef(onClosed);
  closedCallback.current = onClosed;
  const [mounted, setMounted] = useState(open);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const handle: DrawerLiveHandle = {
      kind,
      width,
      open,
      slideAnim,
      fadeAnim,
      setDragging,
    };
    liveHandles.add(handle);
    return () => {
      liveHandles.delete(handle);
    };
  }, [kind, width, open, slideAnim, fadeAnim]);

  useEffect(() => {
    let cancelled = false;
    if (open) setMounted(true);
    const animation = Animated.parallel([
      Animated.timing(slideAnim, { toValue: open ? 0 : -width, duration: 210, useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: open ? 1 : 0, duration: 210, useNativeDriver: true }),
    ]);
    animation.start(({ finished }) => {
      if (!cancelled && finished && !open) {
        setMounted(false);
        setDragging(false);
        closedCallback.current?.();
      }
    });
    return () => {
      cancelled = true;
      animation.stop();
    };
  }, [open, width, slideAnim, fadeAnim, closeRequested]);

  return { slideAnim, fadeAnim, mounted: mounted || dragging };
}
