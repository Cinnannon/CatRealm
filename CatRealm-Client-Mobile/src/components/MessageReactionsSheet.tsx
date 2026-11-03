/**
 * MessageReactionsSheet — View Cat Reactions details on Mobile & Tablet.
 * Desktop parity for "View Cat Reactions" (MessageReactionsDialog).
 * Displays who reacted to the message, grouped or filtered by emoji,
 * with member avatar, display name, handle, role styling, and reaction icon.
 */

import { useMemo, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable as RNPressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/theme';
import { useDeviceLayout } from '@/hooks/useDeviceLayout';
import { Text } from './Text';
import { Avatar } from './Avatar';
import { Pressable } from './Pressable';
import { IconBtn } from './IconBtn';
import { Sheet } from './Sheet';
import { ReactionEmoji } from './ReactionChips';
import { RoleNameText } from '@/lib/roleStyles';
import { usePresenceStore } from '@/stores/presenceStore';
import { useAuthStore } from '@/stores/authStore';
import { useFriendStore } from '@/stores/friendStore';
import { useDMStore } from '@/stores/dmStore';
import type { Reaction, UserStatus } from '@/types';

export interface MessageReactionsSheetProps {
  open: boolean;
  onClose: () => void;
  reactions?: ReadonlyArray<Reaction> | null;
  serverUrl?: string | null;
  initialEmoji?: string | null;
}

interface ReactorDisplayEntry {
  userId: string;
  emoji: string;
  username: string;
  displayName: string;
  avatar: string | null;
  roleColor: string | null;
  roleStyleType: string | null;
  roleStyleColors: string | null | undefined;
  status?: UserStatus | null;
}

function resolveReactor(userId: string, fallbackLabel: string): Omit<ReactorDisplayEntry, 'emoji'> {
  const presence = usePresenceStore.getState();
  const allMembers = presence.allMembers;
  const onlineUsers = presence.onlineUsers;

  const member = allMembers.find((m) => m.id === userId) ?? onlineUsers.find((m) => m.id === userId);
  if (member) {
    return {
      userId,
      username: member.username,
      displayName: member.displayName || member.username,
      avatar: member.avatar ?? null,
      roleColor: member.roleColor ?? null,
      roleStyleType: member.roleStyleType ?? null,
      roleStyleColors: member.roleStyleColors ?? null,
      status: member.status ?? null,
    };
  }

  const authUser = useAuthStore.getState().user;
  if (authUser && authUser.id === userId) {
    return {
      userId,
      username: authUser.username,
      displayName: authUser.displayName || authUser.username,
      avatar: authUser.avatar ?? null,
      roleColor: null,
      roleStyleType: null,
      roleStyleColors: null,
      status: (authUser.status as UserStatus) ?? 'online',
    };
  }

  const friends = useFriendStore.getState().friends;
  const friend = friends.find((f) => f.id === userId);
  if (friend) {
    return {
      userId,
      username: friend.username,
      displayName: friend.username,
      avatar: friend.avatar ?? null,
      roleColor: null,
      roleStyleType: null,
      roleStyleColors: null,
      status: null,
    };
  }

  const convos = useDMStore.getState().conversations;
  const convo = convos.find((c) => c.otherUserId === userId);
  if (convo) {
    return {
      userId,
      username: convo.otherUsername,
      displayName: convo.otherDisplayName || convo.otherUsername,
      avatar: convo.otherAvatar ?? null,
      roleColor: null,
      roleStyleType: null,
      roleStyleColors: null,
      status: null,
    };
  }

  return {
    userId,
    username: userId,
    displayName: fallbackLabel,
    avatar: null,
    roleColor: null,
    roleStyleType: null,
    roleStyleColors: null,
    status: null,
  };
}

export function MessageReactionsSheet({
  open,
  onClose,
  reactions,
  serverUrl,
  initialEmoji = null,
}: MessageReactionsSheetProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const { isDesktopLike } = useDeviceLayout();

  const safeReactions = useMemo(() => reactions ?? [], [reactions]);

  const [selectedEmoji, setSelectedEmoji] = useState<string | 'all'>(() => {
    if (initialEmoji && safeReactions.some((r) => r.emoji === initialEmoji)) {
      return initialEmoji;
    }
    return 'all';
  });

  // Calculate total reactions count across all emojis
  const totalCount = useMemo(
    () => safeReactions.reduce((sum, r) => sum + (r.count || (r.users?.length ?? 0)), 0),
    [safeReactions],
  );

  // Build the filtered list of reactor entries
  const reactorEntries = useMemo<ReactorDisplayEntry[]>(() => {
    const list: ReactorDisplayEntry[] = [];
    const unknownLabel = t('chat.reactorUnknown');

    for (const r of safeReactions) {
      if (selectedEmoji !== 'all' && r.emoji !== selectedEmoji) continue;

      if (Array.isArray(r.users) && r.users.length > 0) {
        for (const uid of r.users) {
          const resolved = resolveReactor(uid, unknownLabel);
          list.push({ ...resolved, emoji: r.emoji });
        }
      } else {
        // In case user IDs were not attached, show count placeholders
        for (let idx = 0; idx < r.count; idx++) {
          list.push({
            userId: `${r.emoji}-${idx}`,
            emoji: r.emoji,
            username: unknownLabel,
            displayName: unknownLabel,
            avatar: null,
            roleColor: null,
            roleStyleType: null,
            roleStyleColors: null,
            status: null,
          });
        }
      }
    }

    return list;
  }, [safeReactions, selectedEmoji, t]);

  const renderContent = () => (
    <View style={styles.sheetContainer}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: theme.colors.lineSoft }]}>
        <Text variant="subtitle" style={{ flex: 1 }}>
          {t('chat.catReactionsTitle')}
        </Text>
        <IconBtn
          icon={X}
          accessibilityLabel={t('common.close')}
          onPress={onClose}
        />
      </View>

      {/* Emoji Filter Tabs */}
      <View style={styles.tabsWrapper}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabsScrollContent}
        >
          {/* 'All' Tab */}
          <Pressable
            haptic
            onPress={() => setSelectedEmoji('all')}
            style={[
              styles.filterTab,
              selectedEmoji === 'all'
                ? {
                    backgroundColor: theme.colors.accent + '26',
                    borderColor: theme.colors.accent,
                  }
                : {
                    backgroundColor: theme.colors.bgElev2,
                    borderColor: theme.colors.lineSoft,
                  },
            ]}
          >
            <Text
              variant="caption"
              style={[
                styles.filterTabLabel,
                {
                  color: selectedEmoji === 'all' ? theme.colors.accent : theme.colors.text2,
                  fontWeight: selectedEmoji === 'all' ? '700' : '500',
                },
              ]}
            >
              {t('chat.allReactions')}
            </Text>
            <Text
              variant="caption"
              style={{
                color: selectedEmoji === 'all' ? theme.colors.accent : theme.colors.text3,
                marginLeft: 4,
                fontSize: 12,
              }}
            >
              {totalCount}
            </Text>
          </Pressable>

          {/* Individual Reaction Tabs */}
          {safeReactions.map((r) => {
            const isSelected = selectedEmoji === r.emoji;
            const count = r.count || (r.users?.length ?? 0);
            return (
              <Pressable
                key={r.emoji}
                haptic
                onPress={() => setSelectedEmoji(r.emoji)}
                style={[
                  styles.filterTab,
                  isSelected
                    ? {
                        backgroundColor: theme.colors.accent + '26',
                        borderColor: theme.colors.accent,
                      }
                    : {
                        backgroundColor: theme.colors.bgElev2,
                        borderColor: theme.colors.lineSoft,
                      },
                ]}
              >
                <ReactionEmoji emoji={r.emoji} serverUrl={serverUrl} />
                <Text
                  variant="caption"
                  style={{
                    color: isSelected ? theme.colors.accent : theme.colors.text3,
                    marginLeft: 6,
                    fontSize: 12,
                    fontWeight: isSelected ? '700' : '500',
                  }}
                >
                  {count}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Reactors List */}
      <FlatList
        data={reactorEntries}
        keyExtractor={(item, index) => `${item.userId}-${item.emoji}-${index}`}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, paddingTop: 4 }}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text variant="bodySmall" color={theme.colors.text3}>
              {t('chat.noReactions')}
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={[styles.reactorRow, { borderBottomColor: theme.colors.lineSoft }]}>
            <Avatar
              username={item.displayName || item.username}
              uri={item.avatar}
              baseUrl={serverUrl ?? undefined}
              size={38}
              status={item.status ?? undefined}
              showStatus={item.status !== undefined && item.status !== null}
            />
            <View style={styles.reactorInfo}>
              <RoleNameText
                color={item.roleColor ?? undefined}
                styleType={item.roleStyleType ?? undefined}
                styleColors={item.roleStyleColors ?? undefined}
                numberOfLines={1}
                style={styles.reactorDisplayName}
              >
                {item.displayName}
              </RoleNameText>
              {item.displayName !== item.username && (
                <Text variant="caption" color={theme.colors.text3} numberOfLines={1}>
                  @{item.username}
                </Text>
              )}
            </View>
            <View style={[styles.reactionBadge, { backgroundColor: theme.colors.bgElev2, borderColor: theme.colors.lineSoft }]}>
              <ReactionEmoji emoji={item.emoji} serverUrl={serverUrl} />
            </View>
          </View>
        )}
      />
    </View>
  );

  if (isDesktopLike) {
    return (
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={onClose}
        statusBarTranslucent
      >
        <View style={styles.desktopScrim}>
          <RNPressable style={StyleSheet.absoluteFill} onPress={onClose} />
          <View style={[styles.desktopPanel, { backgroundColor: theme.colors.bgElev1, borderColor: theme.colors.line }]}>
            {renderContent()}
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <Sheet open={open} onClose={onClose} maxHeightFraction={0.75}>
      {renderContent()}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  sheetContainer: {
    flex: 1,
    minHeight: 280,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tabsWrapper: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'transparent',
  },
  tabsScrollContent: {
    paddingHorizontal: 16,
    gap: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  filterTab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
  },
  filterTabLabel: {
    fontSize: 13,
  },
  reactorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  reactorInfo: {
    flex: 1,
    minWidth: 0,
  },
  reactorDisplayName: {
    fontSize: 14,
    fontWeight: '600',
  },
  reactionBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyContainer: {
    paddingVertical: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  desktopScrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.52)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  desktopPanel: {
    width: '100%',
    maxWidth: 480,
    maxHeight: '80%',
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
