/**
 * Servers tab — list of synced servers. Tapping a server sets it active and
 * opens the remembered channel, or the first available non-voice channel.
 **/

import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, View, StyleSheet } from 'react-native';
import { SafeAreaView } from '@/components/SafeAreaView';
import { useRouter } from 'expo-router';
import { RefreshCw, SquarePlus } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/theme';
import { Text, Pressable, IconBtn, DiscoverButton, ServerListSection } from '@/components';
import { useServerStore } from '@/stores/serverStore';
import { useAuthStore } from '@/stores/authStore';
import { useOpenServer } from '@/hooks/useOpenServer';
import { useDeviceLayout } from '@/hooks/useDeviceLayout';

export default function ServersTab() {
  const theme = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const { isTablet } = useDeviceLayout();
  const servers = useServerStore((s) => s.servers);
  const serverSyncStatus = useServerStore((s) => s.serverSyncStatus);
  const serverSyncMessage = useServerStore((s) => s.serverSyncMessage);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const setServers = useServerStore((s) => s.setServers);
  const fetchServersForCentral = useServerStore((s) => s.fetchServersForCentral);
  const user = useAuthStore((s) => s.user);
  const syncKey = useAuthStore((s) => s.syncKey);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const serverInfo = useAuthStore((s) => s.serverInfo);
  const [openingServerId, setOpeningServerId] = useState<string | null>(null);
  const centralStatus =
    user?.accountType === 'central' && servers.length === 0
      ? (serverSyncMessage ??
        (syncKey ? t('servers.centralSyncStatus', { status: serverSyncStatus }) : t('servers.noSyncKey')))
      : null;

  useEffect(() => {
    if (servers.length > 0) return;
    if (user?.accountType === 'central') {
      void fetchServersForCentral();
    } else if (serverUrl) {
      // Decentral: synthesise a single server entry from auth state
      setServers([
        {
          id: 'local',
          name: serverInfo?.name ?? t('servers.defaultServerName'),
          url: serverUrl,
          token: '',
          iconUrl: serverInfo?.serverIcon ?? null,
          bannerUrl: serverInfo?.serverBanner ?? null,
          membersOnline: serverInfo?.userCount ?? 0,
          unread: 0,
          mention: 0,
        },
      ]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.accountType, serverUrl]);

  const openServerHome = useOpenServer();
  const openServer = async (server: typeof servers[number]) => {
    if (openingServerId) return;
    setOpeningServerId(server.id);
    try {
      await openServerHome(server);
    } finally {
      setOpeningServerId(null);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.bgApp }} edges={['top']}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={isTablet ? { maxWidth: 760, width: '100%', alignSelf: 'center' } : undefined}
        contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: theme.spacing.xl }}
      >
        <View style={styles.header}>
          <View style={{ flex: 1, gap: 6 }}>
            <Text variant="display">{t('tabs.servers')}</Text>
            <Text variant="bodySmall" color={theme.colors.text3}>{t('servers.organizeHint')}</Text>
          </View>
          {user?.accountType === 'central' ? (
            <IconBtn icon={RefreshCw} variant="filled" disabled={serverSyncStatus === 'loading'}
              accessibilityLabel={t('common.refresh')} onPress={() => void fetchServersForCentral()} />
          ) : null}
        </View>
        {centralStatus ? (
          <Text variant="bodySmall" color={theme.colors.text2} style={{ marginTop: 6 }}>
            {centralStatus}
          </Text>
        ) : null}
        <View style={styles.panel}>
          {serverSyncStatus === 'loading' ? <ActivityIndicator color={theme.colors.accent} /> : null}
          <View style={styles.sectionHeading}>
            <Text variant="subtitle">{t('servers.yourServers')}</Text>
            <View style={[styles.count, { backgroundColor: theme.colors.bgElev2 }]}>
              <Text variant="caption" color={theme.colors.accentText}>{servers.length}</Text>
            </View>
          </View>
          {servers.length > 0 ? (
            <View style={styles.serverList}>
              <ServerListSection
                variant="panel"
                activeServerId={activeServerId}
                disabled={!!openingServerId}
                dimServerId={openingServerId}
                onServerPress={(server) => void openServer(server)}
                renderTrailing={(server) =>
                  openingServerId === server.id ? (
                    <ActivityIndicator color={theme.colors.accent} />
                  ) : (
                    null
                  )
                }
              />
            </View>
          ) : (
            <Text variant="bodySmall" color={theme.colors.text3} style={{ textAlign: 'center' }}>
              {t('servers.noSyncedServers')}
            </Text>
          )}
          {serverSyncMessage ? (
            <Text variant="caption" color={theme.colors.text3} style={{ textAlign: 'center' }}>
              {serverSyncMessage}
            </Text>
          ) : null}
        </View>

        {/* Add Server / Discover Servers */}
        <View style={styles.actions}>
          <Pressable
            haptic
            onPress={() => router.push('/(app)/add-server')}
            style={[styles.actionBtn, { backgroundColor: theme.colors.bgElev1, borderRadius: 18, borderWidth: 1, borderColor: theme.colors.lineSoft }]}
          >
            <SquarePlus size={20} color={theme.colors.online} style={styles.actionIcon} />
            <Text variant="body" color={theme.colors.online}>{t('server.addServer')}</Text>
          </Pressable>
          <DiscoverButton onPress={() => router.push('/(app)/discover-servers')} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 8 },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  count: { minWidth: 28, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, alignItems: 'center' },
  panel: {
    marginTop: 24,
    width: '100%',
    gap: 14,
  },
  serverList: {
    alignSelf: 'stretch',
    gap: 10,
    width: '100%',
  },
  actions: {
    marginTop: 12,
    gap: 10,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  actionIcon: {
    width: 24,
  },
});
