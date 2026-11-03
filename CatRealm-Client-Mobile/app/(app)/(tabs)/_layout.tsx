/**
 * Tab bar — five-up mobile navigation. Server/channel navigation should
 * preserve desktop hierarchy while using mobile-appropriate presentation.
 * TLDR, This is Homebar Layout.
 */

import { useRef } from 'react';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Tabs, useRouter } from 'expo-router';
import { Home, Cat, MessageCircle, Bell } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Avatar, TopHubBar, SwipeSidebarContainer } from '@/components';
import { useTheme } from '@/theme';
import { useChannelStore } from '@/stores/channelStore';
import { useAuthStore } from '@/stores/authStore';
import { useServerStore } from '@/stores/serverStore';
import { useUIStore } from '@/stores/uiStore';
import { useDMStore } from '@/stores/dmStore';
import { useFriendStore } from '@/stores/friendStore';
import { useNotificationStore } from '@/stores/notificationStore';

export default function TabsLayout() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t } = useTranslation();
  const lastTap = useRef<Record<string, number>>({});
  const selfUser = useAuthStore((s) => s.user);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const lastChannelByServer = useChannelStore((s) => s.lastChannelByServer);
  const setServerDrawerOpen = useUIStore((s) => s.setServerDrawerOpen);
  const conversations = useDMStore((s) => s.conversations);
  const incomingRequests = useFriendStore((s) => s.incoming);
  const notificationSummary = useNotificationStore((s) => s.summary);
  const totalUnreadDMs = conversations.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0);
  const chatsBadge = totalUnreadDMs || undefined;
  const homeBadge = incomingRequests.length || undefined;
  const notifBadge = notificationSummary?.totalUnread || undefined;

  const handleServersTabPress = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const now = Date.now();
    const prev = lastTap.current.servers ?? 0;
    lastTap.current.servers = now;
    if (now - prev < 350) {
      setServerDrawerOpen(true);
      lastTap.current.servers = 0;
      return;
    }

    const lastChannelId = activeServerId ? lastChannelByServer[activeServerId] : null;
    if (activeServerId && lastChannelId) {
      router.replace({
        pathname: '/server/[serverId]/channel/[channelId]',
        params: { serverId: activeServerId, channelId: lastChannelId },
      });
      return;
    }

    setServerDrawerOpen(true);
  };

  return (
    <SwipeSidebarContainer style={{ backgroundColor: theme.colors.bgApp }}>
      <TopHubBar />
      <SafeAreaInsetsContext.Provider value={{ ...insets, top: 0 }}>
        <Tabs
          tabBar={() => null}
          screenOptions={{
            headerShown: false,
          }}
        >
          <Tabs.Screen
            name="home"
            options={{
              title: t('tabs.home'),
              tabBarIcon: ({ color, size }) => <Home color={color} size={size} />,
              tabBarBadge: homeBadge,
            }}
          />
          <Tabs.Screen
            name="servers"
            options={{
              title: t('tabs.servers'),
              tabBarIcon: ({ color, size }) => <Cat color={color} size={size} />,
            }}
            listeners={{
              tabPress: handleServersTabPress,
            }}
          />
          <Tabs.Screen
            name="chats"
            options={{
              title: t('tabs.directChats'),
              tabBarIcon: ({ color, size }) => <MessageCircle color={color} size={size} />,
              tabBarBadge: chatsBadge,
            }}
          />
          <Tabs.Screen
            name="discover"
            options={{
              title: t('tabs.notifications'),
              tabBarIcon: ({ color, size }) => <Bell color={color} size={size} />,
              tabBarBadge: notifBadge,
            }}
          />
          <Tabs.Screen
            name="me"
            options={{
              title: t('tabs.you'),
              tabBarIcon: () => (
                <Avatar
                  username={selfUser?.username ?? t('tabs.you')}
                  uri={selfUser?.avatar ?? null}
                  size={24}
                  shape="square"
                  showStatus={false}
                />
              ),
            }}
          />
        </Tabs>
      </SafeAreaInsetsContext.Provider>
    </SwipeSidebarContainer>
  );
}
