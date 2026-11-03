import { Platform } from 'react-native';

/** BottomDock's height above the bottom safe-area inset. */
export const DOCK_HEIGHT = 0;

/**
 * Extra space the dock reserves below its icons. Android's edge-to-edge nav
 * bar would cover them; iOS keeps the original dock over the home indicator.
 */
export function dockBottomInset(safeAreaBottom: number): number {
  return Platform.OS === 'android' ? safeAreaBottom : 0;
}
