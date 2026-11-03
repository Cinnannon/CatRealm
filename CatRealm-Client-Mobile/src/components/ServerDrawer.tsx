import { useMemo, useState } from 'react';
import { Alert, Animated, ActivityIndicator, PanResponder, Pressable as RNPressable, ScrollView, StyleSheet, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Link2, ShieldAlert, SquarePlus, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/theme';
import { Text } from './Text';
import { IconBtn } from './IconBtn';
import { Pressable } from './Pressable';
import { ServerListSection } from './ServerListSection';
import { DiscoverButton } from './DiscoverButton';
import { CreateInviteModal } from './CreateInviteModal';
import { useChannelStore } from '@/stores/channelStore';
import { useAuthStore } from '@/stores/authStore';
import { useServerStore } from '@/stores/serverStore';
import { useUIStore } from '@/stores/uiStore';
import { useDrawerTransition } from '@/hooks/useDrawerTransition';
import { useDeviceLayout } from '@/hooks/useDeviceLayout';
import { DOCK_HEIGHT, dockBottomInset } from '@/lib/dockLayout';
import { DrawerLeftRail, DrawerHubFooter } from './BottomDock';

const DRAWER_WIDTH = 356;

export function ServerDrawer() {
  const theme = useTheme();
  const { t } = useTranslation();
  const { isTablet, width: viewportWidth } = useDeviceLayout();
  const router = useRouter();
  const pathname = usePathname();
  const open = useUIStore((s) => s.serverDrawerOpen);
  const closeRequested = useUIStore((s) => s.closingDrawer === 'servers');
  const finishDrawerClose = useUIStore((s) => s.finishDrawerClose);
  const replaced = useUIStore((s) => s.channelsSheetOpen);
  const setOpen = useUIStore((s) => s.setServerDrawerOpen);
  const setChannelsSheetOpen = useUIStore((s) => s.setChannelsSheetOpen);
  const setActiveServer = useServerStore((s) => s.setActiveServer);
  const lastChannelByServer = useChannelStore((s) => s.lastChannelByServer);

  const drawerWidth = isTablet ? Math.min(440, Math.max(360, Math.floor(viewportWidth * 0.38))) : DRAWER_WIDTH;

  const { slideAnim, fadeAnim, mounted } = useDrawerTransition(open, drawerWidth, () => finishDrawerClose('servers'), closeRequested, 'servers');
  const closePanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_evt, g) =>
          open && Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.25,
        onPanResponderMove: (_evt, g) => {
          if (g.dx >= 0) {
            slideAnim.setValue(0);
            fadeAnim.setValue(1);
            return;
          }
          const clamped = Math.max(-drawerWidth, g.dx);
          slideAnim.setValue(clamped);
          fadeAnim.setValue(Math.max(0, 1 + clamped / Math.max(1, drawerWidth)));
        },
        onPanResponderRelease: (_evt, g) => {
          if (g.dx <= -42 || (g.dx < -18 && g.vx < -0.3)) {
            Animated.parallel([
              Animated.timing(slideAnim, { toValue: -drawerWidth, duration: 160, useNativeDriver: true }),
              Animated.timing(fadeAnim, { toValue: 0, duration: 160, useNativeDriver: true }),
            ]).start(() => {
              setOpen(false);
            });
          } else {
            Animated.parallel([
              Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, damping: 22, stiffness: 260 }),
              Animated.timing(fadeAnim, { toValue: 1, duration: 120, useNativeDriver: true }),
            ]).start();
          }
        },
        onPanResponderTerminate: () => {
          Animated.parallel([
            Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, damping: 22, stiffness: 260 }),
            Animated.timing(fadeAnim, { toValue: 1, duration: 120, useNativeDriver: true }),
          ]).start();
        },
      }),
    [open, drawerWidth, slideAnim, fadeAnim, setOpen],
  );

  const inServerChannelOnTablet = isTablet && pathname.startsWith('/server/');
  if (inServerChannelOnTablet || !mounted || replaced) return null;

  const openServer = (id: string) => {
    setActiveServer(id);
    setOpen(false);
    const lastChannelId = lastChannelByServer[id];
    if (lastChannelId) {
      router.replace({
        pathname: '/server/[serverId]/channel/[channelId]',
        params: { serverId: id, channelId: lastChannelId },
      });
      return;
    }
    setChannelsSheetOpen(true);
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={open ? 'box-none' : 'none'}>
      {/* Dimmed backdrop */}
      <Animated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.42)', opacity: fadeAnim }]}
        pointerEvents={open ? 'auto' : 'none'}
      >
        <RNPressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} />
      </Animated.View>

      {/* Sliding drawer */}
      <Animated.View
        {...closePanResponder.panHandlers}
        style={[
          styles.drawer,
          {
            backgroundColor: theme.colors.bgSidebar,
            borderRightColor: theme.colors.line,
            width: drawerWidth,
            transform: [{ translateX: slideAnim }],
          },
        ]}
      >
        <View style={{ flex: 1, flexDirection: 'row', minHeight: 0 }}>
          <DrawerLeftRail onClose={() => setOpen(false)} navigateOnSelect />
          <View style={{ flex: 1, minWidth: 0, paddingTop: theme.spacing.xl }}>
            <View style={styles.header}>
              <View style={{ flex: 1 }}>
                <Text variant="subtitle">{t('tabs.servers')}</Text>
                <Text variant="caption" color={theme.colors.text3}>
                  {t('servers.selectSynced')}
                </Text>
              </View>
              <IconBtn icon={X} onPress={() => setOpen(false)} accessibilityLabel={t('call.closeServers')} />
            </View>

            <ServerListPanel
              onOpenServer={(server) => openServer(server.id)}
              onLeave={() => setOpen(false)}
            />
          </View>
        </View>

        <DrawerHubFooter onClose={() => setOpen(false)} />
      </Animated.View>

    </View>
  );
}

type SyncedServer = ReturnType<typeof useServerStore.getState>['servers'][number];

/**
 * The server list shared by the phone drawer and the tablet servers pane:
 * folders, invite links, realm re-approval, Add Server and Discover.
 */
export function ServerListPanel({ onOpenServer, onLeave }: {
  /** Called once the realm is trusted; the caller navigates. */
  onOpenServer: (server: SyncedServer) => void;
  /** Called before leaving for Add Server / Discover (e.g. close the drawer). */
  onLeave?: () => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const router = useRouter();
  const [inviteServerId, setInviteServerId] = useState<string | null>(null);
  const servers = useServerStore((s) => s.servers);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const setActiveServer = useServerStore((s) => s.setActiveServer);
  const serverSyncStatus = useServerStore((s) => s.serverSyncStatus);
  const serverSyncMessage = useServerStore((s) => s.serverSyncMessage);
  const fetchServersForCentral = useServerStore((s) => s.fetchServersForCentral);
  const verifyRealmTrust = useServerStore((s) => s.verifyRealmTrust);
  const user = useAuthStore((s) => s.user);

  const handleServerPress = (id: string) => {
    const server = servers.find((entry) => entry.id === id);
    if (!server) return;
    // A realm presenting a new identity must be re-approved before use.
    if (server.realmTrust?.state === 'changed') {
      Alert.alert(
        t('server.realmChanged'),
        `${server.name} is presenting a new identity. It may have been reset or replaced. Re-approve before using it again.`,
        [
          { text: t('server.notNow'), style: 'cancel' },
          { text: t('server.reApprovalRequired'), onPress: () => void verifyRealmTrust(id, true) },
        ],
      );
      return;
    }
    onOpenServer(server);
  };

  return (
    <>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.list, { paddingBottom: 16 + DOCK_HEIGHT + dockBottomInset(insets.bottom) }]} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {servers.length > 0 ? (
            <ServerListSection
              variant="drawer"
              activeServerId={activeServerId}
              onServerPress={(server) => handleServerPress(server.id)}
              renderSubtitle={(server) => (
                <View>
                  <Text variant="caption" color={theme.colors.text3}>
                    {t('servers.membersOnline', { count: server.membersOnline })}
                  </Text>
                  {server.realmTrust?.state === 'changed' ? (
                    <View style={styles.trustWarning}>
                      <ShieldAlert size={12} color={theme.colors.danger} />
                      <Text variant="caption" color={theme.colors.danger}>{t('server.reApprovalRequired')}</Text>
                    </View>
                  ) : null}
                </View>
              )}
              renderTrailing={(server) => (
                <IconBtn
                  icon={Link2}
                  accessibilityLabel={t('server.createInvite')}
                  onPress={() => {
                    setActiveServer(server.id);
                    setInviteServerId(server.id);
                  }}
                />
              )}
            />
          ) : (
            <View style={[styles.empty, { backgroundColor: theme.colors.bgElev1 }]}>
              {serverSyncStatus === 'loading' ? (
                <ActivityIndicator color={theme.colors.accent} />
              ) : null}
              <Text variant="bodySmall" color={theme.colors.text2} style={{ textAlign: 'center' }}>
                {serverSyncMessage ?? t('server.noServersLoaded')}
              </Text>
              {user?.accountType === 'central' ? (
                <Pressable
                  haptic
                  onPress={() => void fetchServersForCentral()}
                  style={[
                    styles.refreshBtn,
                    { backgroundColor: theme.colors.accent, borderRadius: theme.radius.md },
                  ]}
                >
                  <Text variant="caption" color={theme.colors.textOnAccent}>
                    {t('common.refresh')}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          )}

          <View style={[styles.actionDivider, { borderTopColor: theme.colors.lineSoft }]}>
            <Pressable
              haptic
              onPress={() => { onLeave?.(); router.push('/(app)/add-server'); }}
              style={[styles.actionRow, { borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.online }]}
            >
              <SquarePlus size={22} color={theme.colors.online} style={styles.actionRowIcon} />
              <Text variant="body" color={theme.colors.online}>{t('server.addServer')}</Text>
            </Pressable>
            <DiscoverButton onPress={() => { onLeave?.(); router.push('/(app)/discover-servers'); }} />
          </View>
        </ScrollView>
      {inviteServerId && (
        <CreateInviteModal
          visible
          onClose={() => setInviteServerId(null)}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  drawer: {
    maxWidth: '92%',
    height: '100%',
    borderRightWidth: 1,
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 18,
    shadowOffset: { width: 8, height: 0 },
    elevation: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  list: {
    paddingHorizontal: 10,
    gap: 6,
  },
  trustWarning: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  empty: {
    marginTop: 8,
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    gap: 12,
  },
  refreshBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  actionDivider: {
    marginTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 4,
    gap: 8,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 14,
    gap: 14,
  },
  actionRowIcon: {
    width: 24,
  },
});
