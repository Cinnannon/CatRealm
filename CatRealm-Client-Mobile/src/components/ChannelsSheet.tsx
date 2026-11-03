/**
 * ChannelsDrawer — left-side sliding drawer that mirrors the desktop sidebar.
 * Includes the Unified Left Rail (Chats, Home, Server icons, All Servers, Add Server),
 * Server banner + categories + channels, and the bottom You/Notifications footer.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Image,
  Keyboard,
  Modal,
  PanResponder,
  Pressable as RNPressable,
  StyleSheet,
  View,
} from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HeadphoneOff, MicOff, TriangleAlert } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/theme';
import { Text } from './Text';
import { Pressable } from './Pressable';
import { ChannelIcon } from './ChannelIcon';
import { ConnectedChannelPulse, useConnectedChannelIds } from './ConnectedChannelPulse';
import { useOpenTheater } from './theater/TheaterJoinModal';
import { Avatar } from './Avatar';
import { useUIStore } from '@/stores/uiStore';
import { useDrawerTransition } from '@/hooks/useDrawerTransition';
import { useServerStore } from '@/stores/serverStore';
import { useChannelStore } from '@/stores/channelStore';
import { useAuthStore } from '@/stores/authStore';
import { useVoiceStore, type VoiceParticipant } from '@/stores/voiceStore';
import { useTheaterStore, type TheaterParticipant } from '@/stores/theaterStore';
import type { Channel, Category } from '@/types';
import { useDeviceLayout } from '@/hooks/useDeviceLayout';
import { DOCK_HEIGHT, dockBottomInset } from '@/lib/dockLayout';
import { debugLog, debugTap } from '@/lib/debugLog';
import { VoiceChannelContent } from './VoiceChannelContent';
import { useCachedUri, realmScope } from '@/lib/imageCache';
import { DrawerLeftRail, DrawerHubFooter } from './BottomDock';

const DRAWER_WIDTH = 356;
const HEADER_HEIGHT = 126;

// ── Types ─────────────────────────────────────────────────────────────────────

type ListItem =
  | { kind: 'category'; id: string; name: string }
  | { kind: 'channel'; channel: Channel }
  | { kind: 'voice-member'; channelId: string; member: VoiceParticipant }
  | { kind: 'theater-member'; channelId: string; member: TheaterParticipant; isHost: boolean };

const EMPTY_CHANNELS: Channel[] = [];
// The drawer unmounts when it closes; remember each realm's scroll position
// so reopening it (e.g. after switching channels) doesn't jump to the top.
const scrollOffsetByServer = new Map<string, number>();
const EMPTY_CATEGORIES: Category[] = [];

function formatRoomElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// ── List builder ──────────────────────────────────────────────────────────────

function buildItems(
  categories: Category[],
  channels: Channel[],
  voiceRoomUsers: Record<string, VoiceParticipant[]>,
  theaterRoomUsers: Record<string, TheaterParticipant[]>,
  theaterHostByChannel: Record<string, string | null>,
): ListItem[] {
  const items: ListItem[] = [];

  const addChannelGroup = (chans: Channel[]) => {
    for (const ch of chans.sort((a, b) => a.position - b.position)) {
      items.push({ kind: 'channel', channel: ch });
      if (ch.type === 'voice') {
        for (const m of (voiceRoomUsers[ch.id] ?? [])) {
          items.push({ kind: 'voice-member', channelId: ch.id, member: m });
        }
      }
      if (ch.type === 'theater') {
        for (const m of (theaterRoomUsers[ch.id] ?? [])) {
          items.push({ kind: 'theater-member', channelId: ch.id, member: m, isHost: theaterHostByChannel[ch.id] === m.userId });
        }
      }
    }
  };

  // Uncategorized channels first
  addChannelGroup(channels.filter((c) => !c.category_id));

  // Then each category
  const sorted = [...categories].sort((a, b) => a.position - b.position);
  for (const cat of sorted) {
    const catChannels = channels.filter((c) => c.category_id === cat.id);
    if (catChannels.length === 0) continue;
    items.push({ kind: 'category', id: cat.id, name: cat.name });
    addChannelGroup(catChannels);
  }

  return items;
}

// ── Main component ────────────────────────────────────────────────────────────

export function ChannelsSheet() {
  const theme = useTheme();
  const { t } = useTranslation();
  const { isTablet, isDesktopLike, width: viewportWidth } = useDeviceLayout();
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const [voiceModal, setVoiceModal] = useState<{ channelId: string; serverId: string } | null>(null);

  const open = useUIStore((s) => s.channelsSheetOpen);
  const closeRequested = useUIStore((s) => s.closingDrawer === 'channels');
  const finishDrawerClose = useUIStore((s) => s.finishDrawerClose);
  const replaced = useUIStore((s) => s.serverDrawerOpen);
  const setOpen = useUIStore((s) => s.setChannelsSheetOpen);

  const activeServerId = useServerStore((s) => s.activeServerId);
  const activeServer = useServerStore((s) =>
    s.activeServerId ? s.byId(s.activeServerId) : undefined,
  );
  const channels = useServerStore((s) =>
    activeServerId ? (s.channels[activeServerId] ?? EMPTY_CHANNELS) : EMPTY_CHANNELS,
  );
  const categories = useServerStore((s) =>
    activeServerId ? (s.categories[activeServerId] ?? EMPTY_CATEGORIES) : EMPTY_CATEGORIES,
  );

  const lastChannelByServer = useChannelStore((s) => s.lastChannelByServer);
  const activeChannelId = activeServerId ? (lastChannelByServer[activeServerId] ?? null) : null;
  const unreadByChannel = useChannelStore((s) => s.unreadByChannel);
  const mentionByChannel = useChannelStore((s) => s.mentionByChannel);

  const voiceRoomUsers = useVoiceStore((s) => s.voiceRoomUsers);
  const voiceRoomStartedAt = useVoiceStore((s) => s.voiceRoomStartedAt);
  const theaterRoomUsers = useTheaterStore((s) => s.roomUsersByChannel);
  const theaterRoomStartedAt = useTheaterStore((s) => s.roomStartedAtByChannel);
  // Read primitives separately — never build objects inside selectors (new ref every call → infinite loop)
  const theaterChannelId = useTheaterStore((s) => s.channelId);
  const theaterHostUserId = useTheaterStore((s) => s.hostUserId);
  const connectedChannels = useConnectedChannelIds(activeServerId);
  const openTheater = useOpenTheater();

  const serverUrl = useAuthStore((s) => s.serverUrl);

  const theaterHostByChannel = useMemo<Record<string, string | null>>(() => {
    if (!theaterChannelId || !theaterHostUserId) return {};
    return { [theaterChannelId]: theaterHostUserId };
  }, [theaterChannelId, theaterHostUserId]);

  const items = useMemo(
    () => buildItems(categories, channels, voiceRoomUsers, theaterRoomUsers, theaterHostByChannel),
    [categories, channels, voiceRoomUsers, theaterRoomUsers, theaterHostByChannel],
  );

  useEffect(() => {
    debugLog('ChannelsSheet', 'selector-snapshot', {
      open,
      activeServerId,
      activeChannelId,
      channelCount: channels.length,
      categoryCount: categories.length,
      itemCount: items.length,
    });
  }, [open, activeServerId, activeChannelId, channels.length, categories.length, items.length]);

  useEffect(() => {
    if (open) Keyboard.dismiss();
  }, [open]);

  const drawerWidth = isTablet ? Math.min(440, Math.max(360, Math.floor(viewportWidth * 0.38))) : DRAWER_WIDTH;
  const listRef = useRef<FlatList<ListItem>>(null);
  const restoredScrollRef = useRef(false);

  const { slideAnim, fadeAnim, mounted } = useDrawerTransition(open, drawerWidth, () => finishDrawerClose('channels'), closeRequested, 'channels');
  const inServerChannelOnTablet = isTablet && pathname.startsWith('/server/');

  useEffect(() => {
    if (inServerChannelOnTablet && open) {
      setOpen(false);
    }
  }, [inServerChannelOnTablet, open, setOpen]);

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
  useEffect(() => {
    if (!mounted) restoredScrollRef.current = false;
  }, [mounted]);
  const [roomNowMs, setRoomNowMs] = useState(() => Date.now());

  useEffect(() => {
    const hasVoiceRooms = Object.keys(voiceRoomStartedAt).length > 0;
    const hasTheaterRooms = Object.values(theaterRoomStartedAt).some((startedAt) => startedAt != null);
    if (!hasVoiceRooms && !hasTheaterRooms) return;
    const timer = globalThis.setInterval(() => setRoomNowMs(Date.now()), 1000);
    return () => globalThis.clearInterval(timer);
  }, [voiceRoomStartedAt, theaterRoomStartedAt]);

  // Computed before early-return so the voice modal survives the drawer unmounting.
  const voiceModalEl = voiceModal ? (
    <Modal visible transparent animationType="fade" onRequestClose={() => setVoiceModal(null)} statusBarTranslucent
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}>
      <View style={styles.voiceModalScrim}>
        <RNPressable style={StyleSheet.absoluteFill} onPress={() => setVoiceModal(null)} />
        <View style={[styles.voiceModalPanel, { backgroundColor: theme.colors.bgApp, borderColor: theme.colors.line }]}>
          <VoiceChannelContent
            channelId={voiceModal.channelId}
            serverId={voiceModal.serverId}
            onClose={() => setVoiceModal(null)}
            topInset={0}
            bottomInset={0}
          />
        </View>
      </View>
    </Modal>
  ) : null;

  // Resolve banner URL — must be before early return to keep hook order stable
  const bannerUrl = activeServer?.bannerUrl
    ? (/^https?:\/\//i.test(activeServer.bannerUrl)
      ? activeServer.bannerUrl
      : `${activeServer.url}${activeServer.bannerUrl}`)
    : null;
  const cachedBannerUrl = useCachedUri(bannerUrl, realmScope(activeServer?.url ?? bannerUrl ?? ''));

  if (inServerChannelOnTablet || !mounted || replaced) return voiceModalEl;

  const scrollKey = activeServerId ?? '';

  const handleChannelPress = (channel: Channel) => {
    debugTap('ChannelsSheet', 'channel-row', {
      channelId: channel.id,
      channelType: channel.type,
      activeServerId,
      activeChannelId,
    });
    Keyboard.dismiss();
    setOpen(false);
    const sid = activeServerId ?? '';
    if (channel.type === 'voice') {
      if (isDesktopLike) {
        debugLog('ChannelsSheet', 'modal:voice', { serverId: sid, channelId: channel.id });
        setVoiceModal({ channelId: channel.id, serverId: sid });
      } else {
        debugLog('ChannelsSheet', 'navigate:voice', { serverId: sid, channelId: channel.id });
        router.push({ pathname: '/server/[serverId]/voice/[channelId]', params: { serverId: sid, channelId: channel.id } });
      }
    } else if (channel.type === 'theater') {
      debugLog('ChannelsSheet', 'open:theater', { serverId: sid, channelId: channel.id });
      openTheater(sid, channel.id, channel.name);
    } else {
      debugLog('ChannelsSheet', 'navigate:channel', { serverId: sid, channelId: channel.id });
      router.replace({ pathname: '/server/[serverId]/channel/[channelId]', params: { serverId: sid, channelId: channel.id } });
    }
  };

  const renderItem = ({ item }: { item: ListItem }) => {
    if (item.kind === 'category') {
      return (
        <View style={styles.categoryRow}>
          <Text
            variant="caption"
            color={theme.colors.text3}
            style={styles.categoryLabel}
          >
            {item.name.toUpperCase()}
          </Text>
        </View>
      );
    }

    if (item.kind === 'voice-member') {
      const m = item.member;
      return (
        <View style={styles.memberRow}>
          <Avatar username={m.username} uri={m.avatar ?? null} size={20} showStatus={false} />
          <Text variant="caption" numberOfLines={1} style={[styles.memberName, { color: theme.colors.text3 }]}>
            {m.username}
          </Text>
          {m.muted && <MicOff size={13} color={theme.colors.danger} />}
          {m.deafened && <HeadphoneOff size={13} color={theme.colors.warning} />}
        </View>
      );
    }

    if (item.kind === 'theater-member') {
      const m = item.member;
      return (
        <View style={styles.memberRow}>
          <Avatar
            username={m.username}
            uri={m.avatar ?? null}
            size={20}
            baseUrl={m.accountType === 'local' ? (serverUrl ?? undefined) : undefined}
            showStatus={false}
          />
          <Text variant="caption" numberOfLines={1} style={[styles.memberName, { color: theme.colors.text3 }]}>
            {item.isHost ? '🎤 ' : ''}{m.username}
          </Text>
          {!m.micEnabled && <MicOff size={13} color={theme.colors.danger} />}
          {m.deafened && <HeadphoneOff size={13} color={theme.colors.warning} />}
        </View>
      );
    }

    // Channel row
    const { channel } = item;
    const isActive = channel.id === activeChannelId;
    // Still in this call/theater while viewing another channel.
    const connectedElsewhere = !isActive
      && (channel.id === connectedChannels.voiceChannelId || channel.id === connectedChannels.theaterChannelId);
    const connectedColor = connectedElsewhere ? theme.colors.statusColor.online : null;
    const unread = unreadByChannel[channel.id] ?? 0;
    const mentions = mentionByChannel[channel.id] ?? 0;
    const voiceStartedAt = channel.type === 'voice' ? voiceRoomStartedAt[channel.id] : null;
    const theaterStartedAt = channel.type === 'theater' ? theaterRoomStartedAt[channel.id] : null;
    const elapsedStartedAt = typeof voiceStartedAt === 'number'
      ? voiceStartedAt
      : (typeof theaterStartedAt === 'number' ? theaterStartedAt : null);

    return (
      <Pressable
        haptic
        onPress={() => handleChannelPress(channel)}
        style={[
          styles.channelRow,
          {
            backgroundColor: isActive ? theme.colors.accent + '22' : 'transparent',
            borderRadius: theme.radius.md,
          },
        ]}
      >
        {connectedElsewhere && <ConnectedChannelPulse radius={theme.radius.md} />}
        <ChannelIcon
          type={channel.type}
          size={17}
          color={isActive ? theme.colors.accent : connectedColor ?? (unread > 0 ? theme.colors.text : theme.colors.text3)}
        />
        <Text
          variant="body"
          numberOfLines={1}
          style={[
            styles.channelName,
            { color: isActive ? theme.colors.accent : connectedColor ?? (unread > 0 ? theme.colors.text : theme.colors.text2) },
          ]}
        >
          {channel.name}
        </Text>
        {!!channel.nsfw && (
          <View style={styles.nsfwTag} accessibilityLabel="18+ channel">
            <TriangleAlert size={14} color={theme.colors.warning} />
            <Text style={[styles.nsfwText, { color: theme.colors.danger }]}>18+</Text>
          </View>
        )}
        {elapsedStartedAt != null && (
          <Text variant="caption" style={[styles.roomElapsed, { color: theme.colors.accent }]}>
            {formatRoomElapsed(Math.max(0, roomNowMs - elapsedStartedAt))}
          </Text>
        )}
        {mentions > 0 && (
          <View style={[styles.badge, { backgroundColor: theme.colors.danger }]}>
            <Text style={styles.badgeText}>{mentions > 99 ? '99+' : mentions}</Text>
          </View>
        )}
        {unread > 0 && mentions === 0 && (
          <View style={[styles.badge, { backgroundColor: theme.colors.text }]}>
            <Text style={[styles.badgeText, { color: theme.colors.bgApp }]}>{unread > 99 ? '99+' : unread}</Text>
          </View>
        )}
      </Pressable>
    );
  };

  const keyExtractor = (item: ListItem) => {
    if (item.kind === 'category') return `cat-${item.id}`;
    if (item.kind === 'channel') return `ch-${item.channel.id}`;
    if (item.kind === 'voice-member') return `vm-${item.channelId}-${item.member.userId}`;
    return `tm-${item.channelId}-${item.member.userId}`;
  };

  return (
    <>
    {voiceModalEl}
    <View style={StyleSheet.absoluteFill} pointerEvents={open ? 'box-none' : 'none'}>
      {/* Backdrop */}
      <Animated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.42)', opacity: fadeAnim }]}
        pointerEvents={open ? 'auto' : 'none'}
      >
        <RNPressable
          style={StyleSheet.absoluteFill}
          onPress={() => {
            debugTap('ChannelsSheet', 'backdrop-close');
            setOpen(false);
          }}
        />
      </Animated.View>

      {/* Drawer */}
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
          {/* Unified Left Rail (Chats, Home, Servers, Add Server) */}
          <DrawerLeftRail onClose={() => setOpen(false)} />

          {/* Right column: Server header + Channel list */}
          <View style={{ flex: 1, minWidth: 0 }}>
            {/* Server header with banner */}
            <View style={[styles.header, { borderBottomColor: theme.colors.line }]}>
              {cachedBannerUrl && (
                <Image
                  source={{ uri: cachedBannerUrl }}
                  style={StyleSheet.absoluteFill}
                  resizeMode="cover"
                />
              )}
              {cachedBannerUrl && <View style={styles.headerScrim} />}
              <View style={styles.headerContent}>
                <Text
                  variant="subtitle"
                  numberOfLines={1}
                  style={[styles.serverName, cachedBannerUrl ? { color: '#fff' } : { color: theme.colors.text }]}
                >
                  {activeServer?.name ?? t('servers.defaultServerName')}
                </Text>
              </View>
            </View>

            {/* Channel list */}
            <FlatList
              ref={listRef}
              data={items}
              onScroll={(event) => scrollOffsetByServer.set(scrollKey, event.nativeEvent.contentOffset.y)}
              scrollEventThrottle={32}
              onContentSizeChange={() => {
                // Restore once per opening, as soon as the rows exist to scroll through.
                if (restoredScrollRef.current) return;
                restoredScrollRef.current = true;
                const offset = scrollOffsetByServer.get(scrollKey) ?? 0;
                if (offset > 0) listRef.current?.scrollToOffset({ offset, animated: false });
              }}
              keyExtractor={keyExtractor}
              renderItem={renderItem}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={[styles.list, { paddingBottom: 24 + DOCK_HEIGHT + dockBottomInset(insets.bottom) }]}
              showsVerticalScrollIndicator={false}
              windowSize={7}
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Text variant="bodySmall" color={theme.colors.text3}>{t('chat.noChannelsYet')}</Text>
                </View>
              }
            />
          </View>
        </View>

        {/* Bottom Footer (You / Profile & Settings + Notifications) */}
        <DrawerHubFooter onClose={() => setOpen(false)} />
      </Animated.View>
    </View>
    </>
  );
}

const styles = StyleSheet.create({
  drawer: {
    width: DRAWER_WIDTH,
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
    height: HEADER_HEIGHT,
    borderBottomWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  headerScrim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  headerContent: {
    padding: 14,
    zIndex: 1,
  },
  serverName: {
    fontWeight: '700',
    fontSize: 16,
  },
  list: {
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 32,
    gap: 2,
  },
  categoryRow: {
    paddingHorizontal: 8,
    paddingTop: 14,
    paddingBottom: 4,
  },
  categoryLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.7,
  },
  channelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 9,
  },
  channelName: {
    flex: 1,
    fontSize: 15,
  },
  nsfwTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  nsfwText: {
    fontSize: 11,
    fontWeight: '700',
  },
  badge: {
    borderRadius: 9,
    minWidth: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  badgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 14,
  },
  roomElapsed: {
    fontSize: 10,
    fontVariant: ['tabular-nums'],
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 32,
    paddingRight: 8,
    paddingVertical: 4,
  },
  memberName: {
    flex: 1,
    fontSize: 13,
  },
  empty: {
    padding: 20,
    alignItems: 'center',
  },
  voiceModalScrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.52)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  voiceModalPanel: {
    width: '100%',
    maxWidth: 640,
    height: '75%',
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    elevation: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
  },
});
