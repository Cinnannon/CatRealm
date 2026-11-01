import { lazy, Suspense, useEffect, useState } from 'react';
import { useSocket } from '../../hooks/useSocket';
import { useDMSocket } from '../../messaging/socket/useDMSocket';
import { useCallSocket } from '../../hooks/useCallSocket';
import { useChannelStore } from '../../stores/channelStore';
import { useUIStore } from '../../stores/uiStore';
import { rememberKnownAccount } from '../../lib/knownAccounts';
import { decideAppTour, fetchAccountAppTourDone, hasDeviceSeenAppTour, useAppTourStore } from '../../lib/appTour';
import { AppTour } from '../onboarding/AppTour';
import { AppTourOffer } from '../onboarding/AppTourOffer';
import { Sidebar } from './Sidebar';
import { MemberList } from './MemberList';
import { ChatArea } from '../../components/chat/ChatArea';
import { ConnectionStatus } from '../ui/ConnectionStatus';
import { DynamicImportBoundary } from '../ui/DynamicImportBoundary';
import { ClaimAdminBanner } from '../admin/ClaimAdminBanner';
import { LogoutConfirmDialog } from './LogoutConfirmDialog';
import { DeleteMessageDialog } from '../chat/DeleteMessageDialog';
import { DeleteBatchDialog } from '../chat/DeleteBatchDialog';
import { UserQuickDrawer } from './UserQuickDrawer';
import { PinsDrawer } from '../chat/PinsDrawer';
import { ThreadPanel } from '../chat/ThreadPanel';
import { MediaViewerModal } from '../chat/MediaViewerModal';

const ServerSettingsModal  = lazy(() => import('../admin/ServerSettingsModal').then(m => ({ default: m.ServerSettingsModal })));
const EditChannelModal     = lazy(() => import('../admin/EditChannelModal').then(m => ({ default: m.EditChannelModal })));
const CreateInviteModal    = lazy(() => import('../admin/CreateInviteModal').then(m => ({ default: m.CreateInviteModal })));
const CreateChannelModal   = lazy(() => import('../admin/CreateChannelModal').then(m => ({ default: m.CreateChannelModal })));
const EditCategoryModal    = lazy(() => import('../admin/EditCategoryModal').then(m => ({ default: m.EditCategoryModal })));
const CreateCategoryModal  = lazy(() => import('../admin/CreateCategoryModal').then(m => ({ default: m.CreateCategoryModal })));
const DeleteCategoryDialog = lazy(() => import('../admin/DeleteCategoryDialog').then(m => ({ default: m.DeleteCategoryDialog })));
const KickMemberDialog     = lazy(() => import('../admin/KickMemberDialog').then(m => ({ default: m.KickMemberDialog })));
const BanMemberDialog      = lazy(() => import('../admin/BanMemberDialog').then(m => ({ default: m.BanMemberDialog })));
const DeleteChannelDialog  = lazy(() => import('../admin/DeleteChannelDialog').then(m => ({ default: m.DeleteChannelDialog })));
const ProfileSettingsModal = lazy(() => import('./ProfileSettingsModal').then(m => ({ default: m.ProfileSettingsModal })));
const ProfileViewerModal   = lazy(() => import('./ProfileViewerModal').then(m => ({ default: m.ProfileViewerModal })));
const FriendsModal         = lazy(() => import('../friends/FriendsModal').then(m => ({ default: m.FriendsModal })));
const ViewAsRoleModal      = lazy(() => import('../admin/ViewAsRoleModal').then(m => ({ default: m.ViewAsRoleModal })));
const BotConsentModal      = lazy(() => import('../bots/BotConsentModal').then(m => ({ default: m.BotConsentModal })));
import { LeaveServerDialog } from './LeaveServerDialog';
import { OfflineServersModal } from './OfflineServersModal';
import { createApi } from '../../lib/api';
import { createAuthenticatedApi } from '../../lib/authApi';
import { useAuthStore } from '../../stores/authStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { useFriendStore } from '../../stores/friendStore';
import { useDMStore } from '../../stores/dmStore';
import { useNotificationStore } from '../../messaging/notifications/notificationStore';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { useServerStore } from '../../stores/serverStore';
import { ServerListBar } from './ServerListBar';
import { ServerView } from './ServerView';
import { UserProfileBar } from './UserProfileBar';
import { TaskbarDock } from './TaskbarDock';
import { PinConfirmModal } from './PinConfirmModal';
import { HomeView } from '../home/HomeView';
import { HomeNav } from '../home/HomeNav';
import { AddServerModal } from '../home/AddServerModal';
import { SocialProfileEditorView } from './SocialProfileEditorView';
import type { Tab } from '../home/HomeNav';
import { VoiceFloatingBar } from './VoiceFloatingBar';
import { VoiceScreenSharePopout } from './VoiceScreenSharePopout';
import { TheaterAudioManager } from '../theater/TheaterAudioManager';
import { TheaterVideoManager } from '../theater/TheaterVideoManager';
import { ScreenSharePickerModal } from './ScreenSharePickerModal';
import { AudioTracksMixerModal } from '../voice/AudioTracksMixerModal';
import { PrivacySummaryModal } from './PrivacySummaryModal';
import { ChangelogModal } from './ChangelogModal';
import { VoiceNoMicrophoneDialog } from './VoiceNoMicrophoneDialog';
import { InsecureRealmMediaDialog } from './InsecureRealmMediaDialog';
import { VoicePermissionDeniedDialog } from './VoicePermissionDeniedDialog';
import { ScreenShareVp8FallbackDialog } from './ScreenShareVp8FallbackDialog';
import { TemplateImportOverlay } from './TemplateImportOverlay';
import { ExternalLinkModal } from './ExternalLinkModal';
import { InviteEmbedModal } from './InviteEmbedModal';
import { MobileShell } from './mobile/MobileShell';
import { RealmTrustWarningBanner } from './RealmTrustWarningBanner';
import { DMKeyReverificationBanner } from './DMKeyReverificationBanner';
import { PasskeyRecommendationBanner } from './PasskeyRecommendationBanner';
import { PrivateBrowsingBanner } from './PrivateBrowsingBanner';
import { MessageActionDrawer } from '../chat/MessageActionDrawer';
import { KeybindsModal } from './KeybindsModal';
import { AmbiencePixelsOverlay } from './AmbiencePixelsOverlay';
import { useGlobalKeybinds } from '../../hooks/useGlobalKeybinds';
import { useVoiceStore } from '../../stores/voiceStore';
import { useCallStore } from '../../stores/callStore';
import { useTheaterStore } from '../../stores/theaterStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { DMCallFloatingBar } from '../calls/DMCallFloatingBar';
import { DMCallRejoinBanner } from '../calls/DMCallRejoinBanner';
import { DMCallScreenSharePopout } from '../calls/DMCallScreenSharePopout';
import { GroupCallScreenSharePopout } from '../calls/GroupCallScreenSharePopout';
import { WelcomeFlow } from '../onboarding/WelcomeFlow';
import { useViewedChannels } from '../../hooks/useViewedChannels';
import { useViewAsRoleStore } from '../../stores/viewAsRoleStore';
import { logViewAsRoleDebug } from '../../lib/viewAsRoleDebug';
import type { Role } from '../../types';

export function AppLayout() {
  useSocket();
  useDMSocket(); // Initialize DM socket for central accounts
  useCallSocket(); // Initialize call socket for central accounts
  useGlobalKeybinds();

  const user = useAuthStore((s) => s.user);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const applyServerAuthRefresh = useAuthStore((s) => s.applyServerAuthRefresh);
  const isCentral = user?.accountType === 'central';
  const activeServerUrl = useServerStore((s) => s.activeServerUrl);

  // Home tab state (lifted here so HomeNav and HomeView share it)
  const [homeTab, setHomeTab] = useState<Tab>('friends');

  // For decentralized accounts, use legacy layout with direct store access
  const fetchChannels = useChannelStore((s) => s.fetchChannels);
  const refreshChannelsIfStale = useChannelStore((s) => s.refreshChannelsIfStale);
  const activeChannelId = useChannelStore((s) => s.activeChannelId);
  const setActiveChannel = useChannelStore((s) => s.setActiveChannel);
  const updateUser = useAuthStore((s) => s.updateUser);
  const setOnboardingCompleted = useAuthStore((s) => s.setOnboardingCompleted);
  const serverInfo = useAuthStore((s) => s.serverInfo);
  const updateOnlineUser = usePresenceStore((s) => s.updateOnlineUser);
  const fetchFriends = useFriendStore((s) => s.fetchFriends);
  const fetchRequests = useFriendStore((s) => s.fetchRequests);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const memberListOpen = useUIStore((s) => s.memberListOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const toggleMemberList = useUIStore((s) => s.toggleMemberList);
  const setMobileNavOpen = useUIStore((s) => s.setMobileNavOpen);
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData);
  const closeModal = useUIStore((s) => s.closeModal);
  const openModal = useUIStore((s) => s.openModal);
  const activeFullscreenView = useUIStore((s) => s.activeFullscreenView);
  const closeFullscreenView = useUIStore((s) => s.closeFullscreenView);
  const createInviteOpen = useUIStore((s) => s.createInviteModalOpen);
  const setCreateInviteModalOpen = useUIStore((s) => s.setCreateInviteModalOpen);
  const voiceBarRetracted = useUIStore((s) => s.voiceBarRetracted);
  const setVoiceBarRetracted = useUIStore((s) => s.setVoiceBarRetracted);
  const goHome = useServerStore((s) => s.goHome);
  const forceMobileViewOnDesktop = useSettingsStore((s) => s.forceMobileViewOnDesktop);
  const [isNarrowViewport, setIsNarrowViewport] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);
  const [loadedModals, setLoadedModals] = useState<Set<string>>(() => new Set<string>());
  const [switchingRoleView, setSwitchingRoleView] = useState(false);
  const viewedChannels = useViewedChannels();
  const roleViewActive = useViewAsRoleStore((s) => s.active);
  const roleViewServerUrl = useViewAsRoleStore((s) => s.serverUrl);
  const roleViewRole = useViewAsRoleStore((s) => s.role);
  const endRoleView = useViewAsRoleStore((s) => s.endSession);
  const syncRoleViewFromUser = useViewAsRoleStore((s) => s.syncFromUser);

  useEffect(() => {
    if (user) rememberKnownAccount(user);
  }, [user]);

  useEffect(() => {
    const toAdd: string[] = [];
    if (activeModal) toAdd.push(activeModal);
    if (createInviteOpen) toAdd.push('createInvite');
    if (toAdd.length > 0) {
      setLoadedModals((prev) => {
        const next = new Set(prev);
        toAdd.forEach((m) => next.add(m));
        return next;
      });
    }
  }, [activeModal, createInviteOpen]);
  const isMobile = isNarrowViewport || forceMobileViewOnDesktop;
  const voiceActiveChannelId = useVoiceStore((s) => s.activeChannelId);
  const theaterActiveChannelId = useTheaterStore((s) => s.activeChannelId);
  const showVoiceBar = !!voiceActiveChannelId && !voiceBarRetracted;
  const activeDMCall = useCallStore((s) => s.activeDMCall);
  const activeGroupCall = useCallStore((s) => s.activeGroupCall);
  const isCallSharingScreen = useCallStore((s) => s.isSharingScreen);
  const activeGroupChatId = useGroupChatStore((s) => s.activeGroupId);
  const selectGroupChat = useGroupChatStore((s) => s.selectGroup);
  const dmViewOpen = useDMStore((s) => s.dmViewOpen);
  const dmActiveConversationId = useDMStore((s) => s.activeConversationId);
  const dmConversations = useDMStore((s) => s.conversations);
  const openDMConversation = useDMStore((s) => s.openConversation);
  useEffect(() => window.electron?.onDesktopNotificationClick?.((target) => {
    const notification = useNotificationStore.getState().items.find((item) => item.id === target.id);
    if (target.sourceKind === 'dm') {
      const conversation = useDMStore.getState().conversations.find((item) => item.id === target.sourceId);
      const payload = notification?.payload ?? {};
      const otherUserId = conversation?.otherUserId ?? (typeof payload.otherUserId === 'string' ? payload.otherUserId : null);
      goHome();
      setHomeTab('dms');
      if (otherUserId) {
        void openDMConversation(
          otherUserId,
          conversation?.otherUsername ?? String(payload.otherUsername ?? notification?.actorName ?? 'Unknown'),
          conversation?.otherAvatar ?? (typeof payload.otherAvatar === 'string' ? payload.otherAvatar : null),
        );
      }
    } else if (target.sourceKind === 'server') {
      useServerStore.getState().switchServer(target.sourceId);
      const channelId = target.subsourceId ?? notification?.subsourceId;
      if (channelId && useServerStore.getState().activeServerUrl === target.sourceId) {
        useChannelStore.getState().setActiveChannel(channelId);
      }
    }
  }), [goHome, openDMConversation]);
  useEffect(() => {
    if (activeModal !== 'dm' || !isCentral || useUIStore.getState().activeModal !== 'dm') return;
    const target = modalData as { userId?: string; username?: string; avatar?: string | null } | null;
    closeModal();
    if (!target?.userId) return;
    useDMStore.setState({ activeConversationId: null, error: null });
    goHome();
    setHomeTab('dms');
    void openDMConversation(target.userId, target.username || target.userId, target.avatar);
  }, [activeModal, modalData, isCentral, closeModal, goHome, openDMConversation]);
  const activeDMConversation = dmActiveConversationId
    ? (dmConversations.find((conversation) => conversation.id === dmActiveConversationId) ?? null)
    : null;
  const hasActiveDMCall = !!activeDMCall && activeDMCall.status === 'active';
  const hasActiveGroupCall = !!activeGroupCall && activeGroupCall.status === 'active';
  const isViewingActiveDMCall = !!(
    hasActiveDMCall
    && dmViewOpen
    && !activeServerUrl
    && homeTab === 'dms'
    && activeDMConversation?.otherUserId === activeDMCall?.otherUserId
  );
  const isViewingActiveGroupCall = !!(
    hasActiveGroupCall
    && !activeServerUrl
    && homeTab === 'groupChats'
    && activeGroupChatId === activeGroupCall?.groupChatId
  );

  useEffect(() => {
    if (voiceActiveChannelId || theaterActiveChannelId) return;
    setVoiceBarRetracted(false);
  }, [voiceActiveChannelId, theaterActiveChannelId, setVoiceBarRetracted]);

  useEffect(() => {
    const currentServerUrl = isCentral ? activeServerUrl : serverUrl;
    logViewAsRoleDebug('sync-from-user', {
      currentServerUrl,
      active: !!user?.viewAsRole,
      role: user?.viewAsRole?.roleName ?? null,
      permissions: user?.permissions,
    });
    syncRoleViewFromUser({ serverUrl: currentServerUrl ?? null, user });
  }, [syncRoleViewFromUser, isCentral, activeServerUrl, serverUrl, user]);

  useEffect(() => {
    if (!roleViewActive) return;
    const currentServerUrl = isCentral ? activeServerUrl : serverUrl;
    if (roleViewServerUrl && currentServerUrl && roleViewServerUrl !== currentServerUrl) {
      useViewAsRoleStore.getState().endSession();
    }
  }, [roleViewActive, roleViewServerUrl, isCentral, activeServerUrl, serverUrl]);

  useEffect(() => {
    if (!viewedChannels.length) {
      if (roleViewActive && activeChannelId) {
        useChannelStore.setState({ activeChannelId: null });
      }
      return;
    }
    if (!activeChannelId || !viewedChannels.some((channel) => channel.id === activeChannelId)) {
      setActiveChannel(viewedChannels[0].id);
    }
  }, [viewedChannels, roleViewActive, activeChannelId, setActiveChannel]);
  const showCallFloatingBar = (hasActiveDMCall || hasActiveGroupCall) && !(isViewingActiveDMCall || isViewingActiveGroupCall);
  const showDMCallFloatingBar = hasActiveDMCall && !isViewingActiveDMCall;
  const showDMSharePopout = showDMCallFloatingBar && (
    !!activeDMCall?.otherSharingScreen || isCallSharingScreen
  );
  const activeGroupRemoteSharing = !!activeGroupCall?.participants.some((participant) => !!participant.sharingScreen);
  const showGroupSharePopout = hasActiveGroupCall && !isViewingActiveGroupCall && (
    activeGroupRemoteSharing || isCallSharingScreen
  );

  const handleReturnToActiveCall = () => {
    if (activeDMCall?.status === 'active') {
      if (activeServerUrl) goHome();
      if (homeTab !== 'dms') setHomeTab('dms');
      if (isMobile) setMobileNavOpen(false);
      void openDMConversation(activeDMCall.otherUserId, activeDMCall.otherUsername, activeDMCall.otherAvatar);
      return;
    }

    if (activeGroupCall?.status === 'active') {
      if (activeServerUrl) goHome();
      if (homeTab !== 'groupChats') setHomeTab('groupChats');
      if (isMobile) setMobileNavOpen(false);
      selectGroupChat(activeGroupCall.groupChatId);
    }
  };

  const handleEndRoleView = async () => {
    try {
      logViewAsRoleDebug('end:requested', {
        currentRole: roleViewRole?.name ?? null,
      });
      const api = createApi();
      await api.delete('/api/roles/view-as');
      const identity = await api.get('/api/auth/me');
      logViewAsRoleDebug('end:auth-me', {
        role: identity.data?.user?.role,
        permissions: identity.data?.user?.permissions,
        viewAsRole: identity.data?.user?.viewAsRole ?? null,
      });
      applyServerAuthRefresh({
        serverUrl: isCentral ? activeServerUrl : serverUrl,
        token: typeof identity.data?.token === 'string' ? identity.data.token : null,
        user: identity.data?.user && typeof identity.data.user === 'object' ? identity.data.user : null,
      });
      await fetchChannels();
      logViewAsRoleDebug('end:channels-refetched', {
        visibleChannelIds: useChannelStore.getState().channels.map((channel) => channel.id),
      });
    } catch {
      // Best-effort local reset if the server session was already cleared.
    } finally {
      endRoleView();
    }
  };

  const handleSwitchRoleView = async () => {
    if (switchingRoleView) return;
    setSwitchingRoleView(true);
    try {
      const api = createApi();
      const response = await api.get('/api/roles?all=1').catch(() => api.get('/api/roles'));
      const roles = Array.isArray(response.data)
        ? response.data
        : Array.isArray(response.data?.roles)
          ? response.data.roles
          : [];
      const selectedRole = roles.find((role: Role) => role.id === roleViewRole?.id)
        ?? (roleViewRole
          ? {
              id: roleViewRole.id,
              name: roleViewRole.name,
              color: null,
              permissions: 0,
              position: 0,
              is_default: 0,
            }
          : roles[0]);
      if (!selectedRole) return;
      openModal('viewRoleAs', {
        role: selectedRole,
        roles,
      });
    } finally {
      setSwitchingRoleView(false);
    }
  };

  const roleViewBanner = roleViewActive && roleViewRole ? (
    <div className="shrink-0 px-4 py-2 border-b border-fuchsia-400/30 bg-fuchsia-500/15 text-fuchsia-100 flex items-center justify-between gap-3">
      <div className="text-xs font-medium">
        Viewing server as <span className="font-semibold">{roleViewRole.name}</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleSwitchRoleView()}
          disabled={switchingRoleView}
          className="px-2.5 py-1 rounded-md border border-fuchsia-300/40 bg-fuchsia-500/10 text-fuchsia-50 text-xs font-semibold hover:bg-fuchsia-500/20 disabled:opacity-60 transition-colors"
        >
          {switchingRoleView ? 'Loading Roles...' : 'Switch Role'}
        </button>
        <button
          type="button"
          onClick={() => void handleEndRoleView()}
          className="px-2.5 py-1 rounded-md bg-fuchsia-400 text-black text-xs font-semibold shadow-[0_0_18px_rgba(217,70,239,0.45)] hover:bg-fuchsia-300 transition-colors"
        >
          End Session
        </button>
      </div>
    </div>
  ) : null;

  const currentServerUrl = isCentral ? activeServerUrl : serverUrl;
  const showOnboarding = !!currentServerUrl
    && !!(serverInfo?.welcomeBoardEnabled)
    && user?.onboardingCompleted === false;

  // Mirrors the consent gate: an account that never had the tour gets it; an
  // account that did, on a device that didn't, is offered it. Waits for the
  // layout to settle and for any open modal to close first.
  const userId = user?.id;
  useEffect(() => {
    if (!userId || isMobile || showOnboarding) return;
    const deviceDone = hasDeviceSeenAppTour(userId);
    let cancelled = false;
    let timer: number | undefined;
    let unsubscribe: (() => void) | null = null;
    const whenNoModal = (action: () => void) => {
      if (!useUIStore.getState().activeModal) return action();
      unsubscribe = useUIStore.subscribe((state) => {
        if (state.activeModal) return;
        unsubscribe?.();
        unsubscribe = null;
        action();
      });
    };
    void (async () => {
      const accountDone = isCentral ? await fetchAccountAppTourDone() : deviceDone;
      if (cancelled || accountDone === null) return; // Central unreachable: don't guess
      const decision = decideAppTour(accountDone, deviceDone);
      if (!decision) return;
      const action = decision === 'offer'
        ? () => useUIStore.getState().openModal('appTourOffer')
        : () => useAppTourStore.getState().start();
      timer = window.setTimeout(() => whenNoModal(action), 1200);
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      unsubscribe?.();
    };
  }, [userId, isCentral, isMobile, showOnboarding]);

  const handleOnboardingDone = () => {
    setOnboardingCompleted();
    fetchChannels();
  };

  const handleIgnoreLazyOverlayFailure = () => {
    closeModal();
    setCreateInviteModalOpen(false);
    setLoadedModals(new Set());
  };

  const renderLazyOverlays = (showMobileDockedCallBar: boolean) => (
    <>
      {loadedModals.has('createChannel') && <Suspense fallback={null}><CreateChannelModal /></Suspense>}
      {loadedModals.has('createInvite') && <Suspense fallback={null}><CreateInviteModal /></Suspense>}
      {loadedModals.has('createCategory') && <Suspense fallback={null}><CreateCategoryModal /></Suspense>}
      {loadedModals.has('editCategory') && <Suspense fallback={null}><EditCategoryModal /></Suspense>}
      {loadedModals.has('deleteCategory') && <Suspense fallback={null}><DeleteCategoryDialog /></Suspense>}
      {loadedModals.has('editChannel') && <Suspense fallback={null}><EditChannelModal /></Suspense>}
      {loadedModals.has('deleteChannel') && <Suspense fallback={null}><DeleteChannelDialog /></Suspense>}
      {loadedModals.has('kickMember') && <Suspense fallback={null}><KickMemberDialog /></Suspense>}
      {loadedModals.has('banMember') && <Suspense fallback={null}><BanMemberDialog /></Suspense>}
      <DeleteMessageDialog />
      <DeleteBatchDialog />
      <PinsDrawer />
      <LogoutConfirmDialog />
      <UserQuickDrawer />
      {loadedModals.has('adminSettings') && <Suspense fallback={null}><ServerSettingsModal /></Suspense>}
      <MediaViewerModal />
      {loadedModals.has('profileSettings') && <Suspense fallback={null}><ProfileSettingsModal /></Suspense>}
      {loadedModals.has('profileView') && <Suspense fallback={null}><ProfileViewerModal /></Suspense>}
      {loadedModals.has('botConsent') && <Suspense fallback={null}><BotConsentModal /></Suspense>}
      {loadedModals.has('friends') && <Suspense fallback={null}><FriendsModal /></Suspense>}
      {loadedModals.has('viewRoleAs') && <Suspense fallback={null}><ViewAsRoleModal /></Suspense>}
      <AddServerModal />
      <LeaveServerDialog />
      <OfflineServersModal />
      <PrivacySummaryModal />
      <ChangelogModal />
      <VoiceNoMicrophoneDialog />
      <InsecureRealmMediaDialog />
      <VoicePermissionDeniedDialog />
      <ScreenShareVp8FallbackDialog />
      <ExternalLinkModal />
      <InviteEmbedModal />
      <MessageActionDrawer />
      <KeybindsModal />
      {showVoiceBar && <VoiceFloatingBar />}
      <VoiceScreenSharePopout />
      <TheaterAudioManager />
      <TheaterVideoManager />
      {showDMCallFloatingBar && showMobileDockedCallBar && (
        <DMCallFloatingBar
          onReturnToCall={handleReturnToActiveCall}
          bottomOffset={showVoiceBar ? 84 : 20}
        />
      )}
      {!hasActiveDMCall && !hasActiveGroupCall && !showVoiceBar && (
        <div className="fixed left-1/2 -translate-x-1/2 z-50" style={{ bottom: 'calc(20px + var(--mobile-dock-offset, 0px))' }}>
          <DMCallRejoinBanner />
        </div>
      )}
      {showDMSharePopout && (
        <DMCallScreenSharePopout
          visible={showDMSharePopout}
          onReturnToCall={handleReturnToActiveCall}
        />
      )}
      {showGroupSharePopout && (
        <GroupCallScreenSharePopout
          visible={showGroupSharePopout}
          onReturnToCall={handleReturnToActiveCall}
        />
      )}
      <ScreenSharePickerModal />
      <AudioTracksMixerModal />
      {showOnboarding && <WelcomeFlow onComplete={handleOnboardingDone} />}
      {!isMobile && <AppTour />}
      {!isMobile && <AppTourOffer />}
    </>
  );

  // Decentralized-only effects
  useEffect(() => {
    if (isCentral) return;
    void refreshChannelsIfStale();
  }, [isCentral, refreshChannelsIfStale]);

  useEffect(() => {
    if (!isCentral || !user?.id) return;

    const refresh = () => {
      fetchFriends();
      fetchRequests();
    };

    refresh();
    const intervalId = window.setInterval(() => refresh(), 60_000);
    const onFocus = () => refresh();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh();
      }
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [isCentral, user?.id, fetchFriends, fetchRequests]);

  useEffect(() => {
    if (isCentral) return;
    if (!serverUrl || !user || user.accountType !== 'local') return;
    const api = createApi();
    api.get('/api/profile/me')
      .then((res) => {
        const activityType = res.data.activityType ?? res.data.activity_type ?? null;
        const activityText = res.data.activityText ?? res.data.activity_text ?? null;
        const activityStartedAt = res.data.activityStartedAt ?? res.data.activity_started_at ?? null;
        updateUser({
          avatar: res.data.avatar ?? null,
          bio: res.data.bio ?? null,
          status: res.data.status ?? 'online',
          customStatusText: res.data.customStatusText ?? res.data.custom_status_text ?? null,
          activityType,
          activityText,
          activityStartedAt,
        });
        updateOnlineUser(res.data.id, {
          avatar: res.data.avatar ?? null,
          status: res.data.status ?? 'online',
          customStatusText: res.data.customStatusText ?? res.data.custom_status_text ?? null,
          activityType,
          activityText,
          activityStartedAt,
        });
      })
      .catch(() => {});
  }, [isCentral, serverUrl, user?.id, user?.accountType, updateUser, updateOnlineUser]);

  useEffect(() => {
    if (isCentral) return;
    if (!serverUrl || !user || user.accountType !== 'local') return;
    const api = createApi();
    let lastActivity = Date.now();
    let idle = false;
    let nextWakeAttemptAt = 0;
    const idleMs = 30 * 60 * 1000;

    const markActive = () => {
      lastActivity = Date.now();
      if ((user.status === 'sleeping' || idle) && Date.now() >= nextWakeAttemptAt) {
        idle = false;
        nextWakeAttemptAt = Date.now() + 30 * 1000;
        api.put('/api/profile/me/status', { status: 'online' })
          .then((res) => {
            updateUser({ status: res.data.status });
            updateOnlineUser(res.data.id, { status: res.data.status });
          })
          .catch(() => {});
      }
    };

    const interval = setInterval(() => {
      if (idle) return;
      if (user.status && user.status !== 'online') return;
      if (Date.now() - lastActivity >= idleMs) {
        idle = true;
        api.put('/api/profile/me/status', { status: 'sleeping' })
          .then((res) => {
            updateUser({ status: res.data.status });
            updateOnlineUser(res.data.id, { status: res.data.status });
          })
          .catch(() => {});
      }
    }, 30 * 1000);

    const events: Array<keyof WindowEventMap> = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'];
    events.forEach((evt) => window.addEventListener(evt, markActive, { passive: true }));
    return () => {
      clearInterval(interval);
      events.forEach((evt) => window.removeEventListener(evt, markActive));
    };
  }, [isCentral, serverUrl, user?.id, user?.accountType, user?.status, updateUser, updateOnlineUser]);

  // Central auto-sleep: mirrors the realm server's 10-minute idle timer so friends,
  // DMs and group chats show the same "Sleeping" state realm member lists do.
  useEffect(() => {
    if (!isCentral || !user?.id) return;
    const api = createAuthenticatedApi();
    let lastActivity = Date.now();
    let idle = false;
    let nextWakeAttemptAt = 0;
    const idleMs = 10 * 60 * 1000;
    const putStatus = (status: 'online' | 'sleeping') => {
      api.put('/api/profile/me/status', { status })
        .then((res) => updateUser({ status: res.data.status }))
        .catch(() => {});
    };

    const markActive = () => {
      lastActivity = Date.now();
      if ((user.status === 'sleeping' || idle) && Date.now() >= nextWakeAttemptAt) {
        idle = false;
        nextWakeAttemptAt = Date.now() + 30 * 1000;
        putStatus('online');
      }
    };

    const interval = setInterval(() => {
      if (idle) return;
      // Never override a manual away/invisible.
      if (user.status && user.status !== 'online') return;
      if (Date.now() - lastActivity >= idleMs) {
        idle = true;
        putStatus('sleeping');
      }
    }, 30 * 1000);

    const events: Array<keyof WindowEventMap> = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'];
    events.forEach((evt) => window.addEventListener(evt, markActive, { passive: true }));
    return () => {
      clearInterval(interval);
      events.forEach((evt) => window.removeEventListener(evt, markActive));
    };
  }, [isCentral, user?.id, user?.status, updateUser]);

  useEffect(() => {
    const handler = () => setIsNarrowViewport(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  // On mobile: auto-close the channel sidebar after a channel is selected,
  // so the user can see the chat content behind it.
  const closeSidebarOnChannelSelect = toggleSidebar;
  useEffect(() => {
    if (isMobile && sidebarOpen) {
      closeSidebarOnChannelSelect();
    }
    // Only run when activeChannelId changes, not on sidebarOpen/isMobile changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChannelId]);

  // Central account layout
  if (isCentral) {
    return (
      <TaskbarDock enabled={!isMobile} onNavigateHomeTab={setHomeTab}>
        <ConnectionStatus />
        <RealmTrustWarningBanner />
        <DMKeyReverificationBanner />
        <PasskeyRecommendationBanner />
        <PrivateBrowsingBanner />

        {activeFullscreenView === 'socialProfileEditor' ? (
          <SocialProfileEditorView onBack={closeFullscreenView} />
        ) : isMobile ? (
          /* ── MOBILE LAYOUT — mirrors the mobile app (bottom dock) ── */
          <MobileShell homeTab={homeTab} setHomeTab={setHomeTab} roleViewBanner={roleViewBanner} />
        ) : (
          /* ── DESKTOP LAYOUT (unchanged) ── */
          <div className="flex flex-1 min-h-0 overflow-x-hidden">
            {/* Left panel group: ServerListBar + Sidebar/HomeNav + UserProfileBar */}
            <div className="flex flex-col shrink-0">
              <div className="flex flex-1 min-h-0">
                <ServerListBar onNavigateToHomeTab={setHomeTab} />
                {activeServerUrl ? (
                  <>
                    <div className="shrink-0 md:relative fixed inset-y-0 left-0 z-20">
                      <div
                        className={`h-full transition-all duration-300 ease-out overflow-hidden ${sidebarOpen ? 'w-full md:w-60 opacity-100 translate-x-0' : 'w-0 opacity-0 -translate-x-full pointer-events-none'}`}
                      >
                        <Sidebar showFooter={false} />
                      </div>
                    </div>
                    {sidebarOpen && (
                      <div
                        className="fixed inset-0 bg-black/50 z-10 md:hidden"
                        onClick={toggleSidebar}
                      />
                    )}
                  </>
                ) : (
                  <HomeNav tab={homeTab} setTab={setHomeTab} />
                )}
              </div>
              <UserProfileBar
                showDMCallFloatingBar={showCallFloatingBar && !isMobile}
                onReturnToDMCall={handleReturnToActiveCall}
              />
            </div>

            {/* Main content */}
            <div className="flex-1 min-w-0 min-h-0 flex flex-col">
              {activeServerUrl && roleViewBanner}
              <div className="flex-1 min-w-0 min-h-0 flex">
                {activeServerUrl ? (
                  <ServerView />
                ) : (
                  <HomeView tab={homeTab} setTab={setHomeTab} />
                )}
              </div>
            </div>
          </div>
        )}

        <DynamicImportBoundary
          ignorable
          contextLabel="a popout or modal"
          onIgnore={handleIgnoreLazyOverlayFailure}
        >
          {renderLazyOverlays(isMobile)}
        </DynamicImportBoundary>
        <AmbiencePixelsOverlay />
        <PinConfirmModal />
      </TaskbarDock>
    );
  }

  // Decentralized account layout: legacy layout (no ServerListBar)
  return (
    <TaskbarDock enabled={!isMobile} onNavigateHomeTab={setHomeTab}>
      <ConnectionStatus />

      {/* Mobile header */}
      <div className="h-12 flex items-center gap-2 px-3 bg-bg-sidebar border-b border-border md:hidden shrink-0">
        <button onClick={toggleSidebar} className="text-text-secondary hover:text-text-primary p-1">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
        </button>
        <span className="text-sm font-semibold text-text-primary flex-1">CatRealm</span>
        <button onClick={toggleMemberList} className="text-text-secondary hover:text-text-primary p-1">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        </button>
      </div>

      <div className="flex flex-1 min-h-0 overflow-x-hidden">
        {/* Sidebar - always visible on desktop, toggle on mobile */}
        <div className="shrink-0 md:relative fixed inset-y-0 left-0 z-20">
          <div
            className={`h-full transition-all duration-300 ease-out overflow-hidden ${sidebarOpen ? 'w-full md:w-60 opacity-100 translate-x-0' : 'w-0 opacity-0 -translate-x-full pointer-events-none'}`}
          >
            <Sidebar />
          </div>
        </div>
        {/* Mobile overlay - tap outside to close */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 bg-black/50 z-10 md:hidden"
            onClick={toggleSidebar}
          />
        )}

        {/* Chat area */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <ClaimAdminBanner />
          <ChatArea />
        </div>

        {/* Thread panel */}
        <ThreadPanel />

        {/* Member list - always visible on desktop, toggle on mobile */}
        <div className="shrink-0 md:relative fixed inset-y-0 right-0 z-20">
          <div
            className={`h-full transition-all duration-300 ease-out overflow-hidden ${memberListOpen ? 'w-full md:w-60 opacity-100 translate-x-0' : 'w-0 opacity-0 translate-x-full pointer-events-none'}`}
          >
            <MemberList />
          </div>
        </div>
        {/* Mobile overlay */}
        {memberListOpen && (
          <div
            className="fixed inset-0 bg-black/50 z-10 md:hidden"
            onClick={toggleMemberList}
          />
        )}
      </div>

      <DynamicImportBoundary
        ignorable
        contextLabel="a popout or modal"
        onIgnore={handleIgnoreLazyOverlayFailure}
      >
        {renderLazyOverlays(true)}
      </DynamicImportBoundary>
      <AmbiencePixelsOverlay />
      <PinConfirmModal />
      <TemplateImportOverlay />
    </TaskbarDock>
  );
}
