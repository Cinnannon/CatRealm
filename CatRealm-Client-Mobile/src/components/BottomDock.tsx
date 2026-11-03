import { ScrollView, StyleSheet, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { Bell, Cat, Folder, Home, Menu, MessageCircle, Palette, Plus, Settings } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme';
import axios from 'axios';
import { Avatar } from '@/components/Avatar';
import { Pressable } from '@/components/Pressable';
import { ServerIcon } from '@/components/ServerIcon';
import { Text } from '@/components/Text';
import { TourAnchor } from '@/components/TourAnchor';
import { useAuthStore } from '@/stores/authStore';
import { useChannelStore } from '@/stores/channelStore';
import { useServerStore, type MobileServer } from '@/stores/serverStore';
import { useUIStore } from '@/stores/uiStore';
import { useDMStore } from '@/stores/dmStore';
import { useGroupChatStore } from '@/stores/groupChatStore';
import { useFriendStore } from '@/stores/friendStore';
import { useNotificationStore } from '@/stores/notificationStore';
import { useRealmUnreadStore } from '@/lib/realmReadState';
import type { Category, Channel } from '@/types';

type HubTabId = 'home' | 'servers' | 'chats' | 'discover' | 'me';

function activeHubTab(pathname: string): HubTabId {
  if (pathname.startsWith('/server') || pathname.includes('/servers')) return 'servers';
  if (pathname.startsWith('/dm/') || pathname.startsWith('/group/') || pathname.includes('/chats')) return 'chats';
  if (pathname.includes('/discover')) return 'discover';
  if (pathname.includes('/me') || pathname.startsWith('/profile') || pathname.startsWith('/settings')) {
    return 'me';
  }
  return 'home';
}

function useNavBadges() {
  const home = useFriendStore((s) => s.incoming.length);
  const servers = useServerStore((s) => s.servers.reduce((sum, server) => sum + (server.mention || 0), 0));
  const chats =
    useDMStore((s) => s.conversations.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0)) +
    useGroupChatStore((s) => s.groups.reduce((sum, g) => sum + (g.unreadCount ?? 0), 0));
  const discover = useNotificationStore((s) => s.summary?.totalUnread ?? 0);
  return { home, servers, chats, discover };
}

/**
 * Legacy BottomDock mount point in `(app)/_layout.tsx`.
 * Eliminated from the bottom of the screen so the chat composer (`MobileComposer`)
 * owns 100% of the bottom edge without accidental tab presses.
 * Navigation now lives in `TopHubBar`, `DrawerLeftRail`, and `DrawerHubFooter`.
 */
export function BottomDock() {
  return null;
}

/**
 * Top navigation header rendered on the main Hub screens (`chats`, `home`, `servers`, `discover`, `me`).
 * Keeps all 5 primary destinations at the top of the screen, far away from the keyboard & chat composer.
 */
export function TopHubBar() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const selfUser = useAuthStore((s) => s.user);
  const servers = useServerStore((s) => s.servers);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const setActiveServer = useServerStore((s) => s.setActiveServer);
  const setChannelsSheetOpen = useUIStore((s) => s.setChannelsSheetOpen);
  const setServerDrawerOpen = useUIStore((s) => s.setServerDrawerOpen);
  const profileEditMode = useUIStore((s) => s.profileEditMode);
  const badges = useNavBadges();

  if (profileEditMode) return null;

  const active = activeHubTab(pathname);

  const openLeftDrawer = () => {
    if (servers.length > 0) {
      if (!activeServerId) {
        void setActiveServer(servers[0].id);
      }
      setChannelsSheetOpen(true);
    } else {
      setServerDrawerOpen(true);
    }
  };

  return (
    <View
      testID="top-hub-bar"
      style={[
        styles.topHubContainer,
        {
          backgroundColor: theme.colors.bgSidebar,
          borderBottomColor: theme.colors.lineSoft,
          paddingTop: Math.max(insets.top, 8),
        },
      ]}
    >
      {/* Top Row: Left Drawer Trigger + App Title | Right: Notifications (Bell) + You (Profile) */}
      <View style={styles.topRow}>
        <View style={styles.brandRow}>
          <Pressable
            haptic
            accessibilityRole="button"
            accessibilityLabel={t('servers.openDrawer')}
            onPress={openLeftDrawer}
            style={[
              styles.iconPillBtn,
              {
                backgroundColor: theme.colors.bgElev1,
                borderColor: theme.colors.line,
              },
            ]}
          >
            <Menu size={18} color={theme.colors.accentText} />
          </Pressable>
          <Text variant="subtitle" style={styles.brandTitle}>
            CatRealm
          </Text>
        </View>

        <View style={styles.topRightActions}>
          <Pressable
            haptic
            accessibilityRole="button"
            accessibilityLabel={t('settings.sectionTheme', { defaultValue: 'Themes' })}
            onPress={() => router.push({ pathname: '/(app)/settings', params: { section: 'appearance' } })}
            style={[
              styles.notifBtn,
              {
                backgroundColor: theme.colors.bgElev1,
                borderColor: theme.colors.lineSoft,
              },
            ]}
          >
            <Palette size={16} color={theme.colors.accentText} />
          </Pressable>

          <TourAnchor name="dock-notifications">
            <Pressable
              haptic
              accessibilityRole="button"
              accessibilityLabel={t('tabs.notifications')}
              onPress={() => router.replace('/(app)/(tabs)/discover')}
              style={[
                styles.notifBtn,
                {
                  backgroundColor: active === 'discover' ? theme.colors.accent : theme.colors.bgElev1,
                  borderColor: active === 'discover' ? theme.colors.accentRim : theme.colors.lineSoft,
                },
              ]}
            >
              <Bell size={16} color={active === 'discover' ? '#FFFFFF' : theme.colors.text2} />
              {badges.discover > 0 ? (
                <View style={[styles.inlineBadge, { backgroundColor: theme.colors.danger }]}>
                  <Text style={styles.badgeText}>{badges.discover > 99 ? '99+' : badges.discover}</Text>
                </View>
              ) : null}
            </Pressable>
          </TourAnchor>

          <TourAnchor name="dock-me">
            <Pressable
              haptic
              accessibilityRole="button"
              accessibilityLabel={t('tabs.you')}
              onPress={() => router.replace('/(app)/(tabs)/me')}
              style={[
                styles.youPill,
                {
                  backgroundColor: active === 'me' ? theme.colors.accent : theme.colors.bgElev1,
                  borderColor: active === 'me' ? theme.colors.accentRim : theme.colors.lineSoft,
                },
              ]}
            >
              <Avatar
                username={selfUser?.username ?? 'You'}
                uri={selfUser?.avatar ?? null}
                size={22}
                shape="circle"
                showStatus={false}
              />
              <Text
                variant="caption"
                color={active === 'me' ? '#FFFFFF' : theme.colors.text}
                style={styles.youLabel}
                numberOfLines={1}
              >
                {t('tabs.you')}
              </Text>
            </Pressable>
          </TourAnchor>
        </View>
      </View>

      {/* Segmented Hub Switcher: Chats | Friends (Home) | Servers */}
      <View
        style={[
          styles.segmentedBar,
          {
            backgroundColor: theme.colors.bgElev1,
            borderColor: theme.colors.lineSoft,
          },
        ]}
      >
        <TourAnchor name="dock-chats" style={styles.segmentFlex}>
          <Pressable
            haptic
            onPress={() => router.replace('/(app)/(tabs)/chats')}
            style={[
              styles.segmentBtn,
              active === 'chats' && { backgroundColor: theme.colors.accent },
            ]}
          >
            <MessageCircle size={15} color={active === 'chats' ? '#FFFFFF' : theme.colors.text2} />
            <Text
              variant="caption"
              color={active === 'chats' ? '#FFFFFF' : theme.colors.text2}
              style={styles.segmentLabel}
              numberOfLines={1}
            >
              {t('tabs.chats')}
            </Text>
            {badges.chats > 0 ? (
              <View style={[styles.inlineBadge, { backgroundColor: theme.colors.danger }]}>
                <Text style={styles.badgeText}>{badges.chats > 99 ? '99+' : badges.chats}</Text>
              </View>
            ) : null}
          </Pressable>
        </TourAnchor>

        <TourAnchor name="dock-home" style={styles.segmentFlex}>
          <Pressable
            haptic
            onPress={() => router.replace('/(app)/(tabs)/home')}
            style={[
              styles.segmentBtn,
              active === 'home' && { backgroundColor: theme.colors.accent },
            ]}
          >
            <Home size={15} color={active === 'home' ? '#FFFFFF' : theme.colors.text2} />
            <Text
              variant="caption"
              color={active === 'home' ? '#FFFFFF' : theme.colors.text2}
              style={styles.segmentLabel}
              numberOfLines={1}
            >
              {t('tabs.home')}
            </Text>
            {badges.home > 0 ? (
              <View style={[styles.inlineBadge, { backgroundColor: theme.colors.danger }]}>
                <Text style={styles.badgeText}>{badges.home > 99 ? '99+' : badges.home}</Text>
              </View>
            ) : null}
          </Pressable>
        </TourAnchor>

        <TourAnchor name="dock-servers" style={styles.segmentFlex}>
          <Pressable
            haptic
            onPress={() => router.replace('/(app)/(tabs)/servers')}
            style={[
              styles.segmentBtn,
              active === 'servers' && { backgroundColor: theme.colors.accent },
            ]}
          >
            <Cat size={15} color={active === 'servers' ? '#FFFFFF' : theme.colors.text2} />
            <Text
              variant="caption"
              color={active === 'servers' ? '#FFFFFF' : theme.colors.text2}
              style={styles.segmentLabel}
              numberOfLines={1}
            >
              {t('tabs.servers')}
            </Text>
            {badges.servers > 0 ? (
              <View style={[styles.inlineBadge, { backgroundColor: theme.colors.danger }]}>
                <Text style={styles.badgeText}>{badges.servers > 99 ? '99+' : badges.servers}</Text>
              </View>
            ) : null}
          </Pressable>
        </TourAnchor>
      </View>
    </View>
  );
}

/**
 * 66px vertical icon rail inside the left sliding drawer (`ChannelsSheet`).
 * Lets the user jump to DMs (`Chats`), Friends/Notes (`Home`), switch servers,
 * or open the full server folder manager without any bottom dock.
 */
export function DrawerLeftRail({
  onClose,
  navigateOnSelect = false,
  embedded = false,
}: {
  onClose: () => void;
  navigateOnSelect?: boolean;
  embedded?: boolean;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const servers = useServerStore((s) => s.servers);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const setActiveServer = useServerStore((s) => s.setActiveServer);
  const setChannels = useServerStore((s) => s.setChannels);
  const setCategories = useServerStore((s) => s.setCategories);
  const unreadByServer = useRealmUnreadStore((s) => s.byServer);
  const setServerDrawerOpen = useUIStore((s) => s.setServerDrawerOpen);
  const badges = useNavBadges();

  const handleSelectServer = async (server: MobileServer) => {
    const wasAlreadyActive = activeServerId === server.id;
    void setActiveServer(server.id);
    let srvChannels = useServerStore.getState().channels[server.id] ?? [];
    if (srvChannels.length === 0) {
      try {
        const base = server.url.replace(/\/$/, '');
        const headers: Record<string, string> = { 'X-CatRealm-Client': 'mobile' };
        if (server.token) headers.Authorization = `Bearer ${server.token}`;
        const [channelsRes, categoriesRes] = await Promise.all([
          axios.get<Channel[]>(`${base}/api/channels`, { headers, timeout: 10000 }),
          axios.get<Category[]>(`${base}/api/categories`, { headers, timeout: 10000 }),
        ]);
        srvChannels = channelsRes.data ?? [];
        setChannels(server.id, srvChannels);
        setCategories(server.id, categoriesRes.data ?? []);
      } catch {
        // Channel fetch error is handled by the main server view
      }
    }

    if (navigateOnSelect || wasAlreadyActive) {
      const rememberedChannelId = useChannelStore.getState().lastChannelByServer[server.id] ?? null;
      const firstChannelId =
        srvChannels
          .slice()
          .sort((a, b) => a.position - b.position)
          .find((c) => c.type !== 'voice')?.id ??
        srvChannels[0]?.id ??
        null;
      const targetChannelId = rememberedChannelId || firstChannelId;
      if (targetChannelId) {
        onClose();
        router.replace({
          pathname: '/server/[serverId]/channel/[channelId]',
          params: { serverId: server.id, channelId: targetChannelId },
        });
      }
    }
  };

  return (
    <View
      style={[
        styles.rail,
        {
          backgroundColor: theme.colors.bgDeepest,
          borderRightColor: theme.colors.lineSoft,
          paddingTop: embedded ? 10 : Math.max(insets.top + 8, 14),
        },
      ]}
    >
      {/* DMs / Chats Shortcut */}
      <Pressable
        haptic
        accessibilityRole="button"
        accessibilityLabel={t('tabs.chats')}
        onPress={() => {
          onClose();
          router.replace('/(app)/(tabs)/chats');
        }}
        style={[
          styles.railHubBtn,
          {
            backgroundColor: pathname.includes('/chats') || pathname.startsWith('/dm/')
              ? theme.colors.accent
              : theme.colors.bgElev2,
            borderColor: theme.colors.line,
          },
        ]}
      >
        <MessageCircle size={18} color="#FFFFFF" />
        <Text style={styles.railBtnLabel} numberOfLines={1}>
          {t('tabs.chats')}
        </Text>
        {badges.chats > 0 ? (
          <View style={[styles.railCornerBadge, { backgroundColor: theme.colors.danger, borderColor: theme.colors.bgDeepest }]}>
            <Text style={styles.badgeText}>{badges.chats > 99 ? '99+' : badges.chats}</Text>
          </View>
        ) : null}
      </Pressable>

      {/* Friends & Notes (Home) Shortcut */}
      <Pressable
        haptic
        accessibilityRole="button"
        accessibilityLabel={t('tabs.home')}
        onPress={() => {
          onClose();
          router.replace('/(app)/(tabs)/home');
        }}
        style={[
          styles.railHubBtn,
          {
            backgroundColor: pathname.includes('/home') ? theme.colors.accent : theme.colors.bgElev1,
            borderColor: theme.colors.lineSoft,
          },
        ]}
      >
        <Home size={18} color={theme.colors.text2} />
        <Text style={[styles.railBtnLabel, { color: theme.colors.text2 }]} numberOfLines={1}>
          {t('tabs.home')}
        </Text>
        {badges.home > 0 ? (
          <View style={[styles.railCornerBadge, { backgroundColor: theme.colors.danger, borderColor: theme.colors.bgDeepest }]}>
            <Text style={styles.badgeText}>{badges.home > 99 ? '99+' : badges.home}</Text>
          </View>
        ) : null}
      </Pressable>

      <View style={[styles.railDivider, { backgroundColor: theme.colors.line }]} />

      {/* Scrollable Server Icons */}
      <ScrollView
        style={{ flex: 1, width: '100%' }}
        contentContainerStyle={styles.railServerList}
        showsVerticalScrollIndicator={false}
      >
        {servers.map((srv) => {
          const isAct = srv.id === activeServerId;
          const hasUnread = !isAct && (unreadByServer[srv.url] ?? 0) > 0;
          return (
            <Pressable
              key={srv.id}
              haptic
              accessibilityRole="button"
              accessibilityLabel={srv.name}
              onPress={() => void handleSelectServer(srv)}
              style={styles.railServerItem}
            >
              {isAct ? <View style={[styles.activeServerPill, { backgroundColor: theme.colors.text }]} /> : null}
              <ServerIcon
                server={srv}
                size={44}
                active={isAct}
                badge={srv.mention}
                unread={hasUnread}
              />
            </Pressable>
          );
        })}

        {/* Open All Servers / Folders Manager */}
        <Pressable
          haptic
          accessibilityRole="button"
          accessibilityLabel={t('tabs.servers')}
          onPress={() => {
            onClose();
            setServerDrawerOpen(true);
          }}
          style={[
            styles.railActionCircle,
            {
              backgroundColor: theme.colors.bgElev1,
              borderColor: theme.colors.lineSoft,
            },
          ]}
        >
          <Folder size={18} color={theme.colors.accentText} />
        </Pressable>

        {/* Add Server */}
        <Pressable
          haptic
          accessibilityRole="button"
          accessibilityLabel={t('server.addServer')}
          onPress={() => {
            onClose();
            router.push('/(app)/add-server');
          }}
          style={[
            styles.railActionCircle,
            {
              backgroundColor: theme.colors.online + '22',
              borderColor: theme.colors.online,
            },
          ]}
        >
          <Plus size={20} color={theme.colors.online} />
        </Pressable>
      </ScrollView>
    </View>
  );
}

/**
 * Persistent user & navigation footer rendered at the bottom of `ChannelsSheet`,
 * `ServerDrawer`, and the tablet sidebar so `You` (Profile/Settings) and
 * `Notifications` are always accessible in 1 tap without a global BottomDock.
 */
export function DrawerHubFooter({
  onClose,
  showHubShortcuts = false,
}: {
  onClose?: () => void;
  showHubShortcuts?: boolean;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const router = useRouter();
  const selfUser = useAuthStore((s) => s.user);
  const badges = useNavBadges();

  const go = (route: '/(app)/(tabs)/me' | '/(app)/(tabs)/discover' | '/(app)/(tabs)/chats' | '/(app)/(tabs)/home') => {
    onClose?.();
    router.replace(route);
  };

  return (
    <View
      style={[
        styles.drawerFooterWrap,
        {
          backgroundColor: theme.colors.bgElev1,
          borderTopColor: theme.colors.line,
          paddingBottom: Math.max(insets.bottom, 10),
        },
      ]}
    >
      {showHubShortcuts ? (
        <View style={[styles.footerQuickStrip, { borderBottomColor: theme.colors.lineSoft }]}>
          <Pressable
            haptic
            onPress={() => go('/(app)/(tabs)/chats')}
            style={[styles.footerQuickBtn, { backgroundColor: theme.colors.bgElev2 }]}
          >
            <MessageCircle size={14} color={theme.colors.accentText} />
            <Text variant="caption" color={theme.colors.text} style={{ fontWeight: '600' }}>
              {t('tabs.chats')}
            </Text>
            {badges.chats > 0 ? (
              <View style={[styles.inlineBadge, { backgroundColor: theme.colors.danger }]}>
                <Text style={styles.badgeText}>{badges.chats > 99 ? '99+' : badges.chats}</Text>
              </View>
            ) : null}
          </Pressable>

          <Pressable
            haptic
            onPress={() => go('/(app)/(tabs)/home')}
            style={[styles.footerQuickBtn, { backgroundColor: theme.colors.bgElev2 }]}
          >
            <Home size={14} color={theme.colors.accentText} />
            <Text variant="caption" color={theme.colors.text} style={{ fontWeight: '600' }}>
              {t('tabs.home')}
            </Text>
            {badges.home > 0 ? (
              <View style={[styles.inlineBadge, { backgroundColor: theme.colors.danger }]}>
                <Text style={styles.badgeText}>{badges.home > 99 ? '99+' : badges.home}</Text>
              </View>
            ) : null}
          </Pressable>
        </View>
      ) : null}

      <View style={styles.drawerFooterRow}>
        <Pressable
          haptic
          accessibilityRole="button"
          accessibilityLabel={t('tabs.you')}
          onPress={() => go('/(app)/(tabs)/me')}
          style={styles.footerProfileBtn}
        >
          <Avatar
            username={selfUser?.username ?? 'You'}
            uri={selfUser?.avatar ?? null}
            size={34}
            shape="circle"
            status={selfUser?.status ?? 'online'}
          />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="bodySmall" style={{ fontWeight: '700' }} numberOfLines={1}>
              {selfUser?.displayName || selfUser?.username || t('tabs.you')}
            </Text>
            <Text variant="caption" color={theme.colors.text3} numberOfLines={1}>
              @{selfUser?.username ?? 'you'} · {t('tabs.you')}
            </Text>
          </View>
        </Pressable>

        <View style={styles.footerActions}>
          <Pressable
            haptic
            accessibilityRole="button"
            accessibilityLabel={t('tabs.notifications')}
            onPress={() => go('/(app)/(tabs)/discover')}
            style={[styles.footerIconBtn, { backgroundColor: theme.colors.bgElev2 }]}
          >
            <Bell size={16} color={theme.colors.text} />
            {badges.discover > 0 ? (
              <View style={[styles.inlineBadge, { backgroundColor: theme.colors.danger }]}>
                <Text style={styles.badgeText}>{badges.discover > 99 ? '99+' : badges.discover}</Text>
              </View>
            ) : null}
          </Pressable>

          <Pressable
            haptic
            accessibilityRole="button"
            accessibilityLabel={t('settings.sectionTheme', { defaultValue: 'Themes' })}
            onPress={() => {
              onClose?.();
              router.push({ pathname: '/(app)/settings', params: { section: 'appearance' } });
            }}
            style={[styles.footerIconBtn, { backgroundColor: theme.colors.bgElev2 }]}
          >
            <Palette size={16} color={theme.colors.accentText} />
          </Pressable>

          <Pressable
            haptic
            accessibilityRole="button"
            accessibilityLabel={t('settings.title', { defaultValue: 'Settings' })}
            onPress={() => {
              onClose?.();
              router.push('/(app)/settings');
            }}
            style={[styles.footerIconBtn, { backgroundColor: theme.colors.bgElev2 }]}
          >
            <Settings size={16} color={theme.colors.text2} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  topHubContainer: {
    borderBottomWidth: 1,
    paddingHorizontal: 14,
    paddingBottom: 10,
    gap: 8,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  brandTitle: {
    fontWeight: '700',
    fontSize: 18,
  },
  iconPillBtn: {
    width: 36,
    height: 36,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topRightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  notifBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 36,
    paddingHorizontal: 11,
    borderRadius: 11,
    borderWidth: 1,
  },
  youPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 36,
    paddingLeft: 6,
    paddingRight: 11,
    borderRadius: 11,
    borderWidth: 1,
    maxWidth: 120,
  },
  youLabel: {
    fontWeight: '700',
  },
  segmentedBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    padding: 3,
    gap: 4,
  },
  segmentFlex: {
    flex: 1,
  },
  segmentBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 8,
    borderRadius: 9,
  },
  segmentLabel: {
    fontWeight: '700',
  },
  inlineBadge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 12,
  },
  rail: {
    width: 66,
    borderRightWidth: 1,
    alignItems: 'center',
    paddingBottom: 10,
    gap: 8,
  },
  railHubBtn: {
    width: 46,
    height: 46,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  railBtnLabel: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '700',
  },
  railCornerBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  railDivider: {
    width: 32,
    height: 1,
    marginVertical: 2,
  },
  railServerList: {
    alignItems: 'center',
    gap: 10,
    paddingBottom: 16,
  },
  railServerItem: {
    width: 66,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeServerPill: {
    position: 'absolute',
    left: 0,
    width: 4,
    height: 28,
    borderTopRightRadius: 4,
    borderBottomRightRadius: 4,
  },
  railActionCircle: {
    width: 44,
    height: 44,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  drawerFooterWrap: {
    borderTopWidth: 1,
    paddingTop: 8,
    paddingHorizontal: 10,
    gap: 8,
  },
  footerQuickStrip: {
    flexDirection: 'row',
    gap: 6,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  footerQuickBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 9,
  },
  drawerFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  footerProfileBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  footerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  footerIconBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 34,
    paddingHorizontal: 10,
    borderRadius: 10,
    justifyContent: 'center',
  },
});
