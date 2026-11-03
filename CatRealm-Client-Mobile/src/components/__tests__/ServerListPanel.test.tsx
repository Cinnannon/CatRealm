import { fireEvent, render } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { ServerListPanel } from '../ServerDrawer';

const mockPush = jest.fn();
const mockVerify = jest.fn();
const mockSetActive = jest.fn();
const mockFetch = jest.fn();
type MockServer = { id: string; name: string; membersOnline: number; realmTrust?: { state: string } };
let mockServers: MockServer[] = [];

jest.mock('expo-router', () => ({ usePathname: () => '/home', useRouter: () => ({ push: mockPush, replace: jest.fn() }) }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@/theme', () => ({ useTheme: () => ({ colors: {}, spacing: {}, radius: {} }) }));
jest.mock('lucide-react-native', () => ({ Link2: 'Icon', ShieldAlert: 'Icon', SquarePlus: 'Icon', X: 'Icon' }));
jest.mock('@/stores/serverStore', () => ({
  useServerStore: (select: (s: unknown) => unknown) => select({
    servers: mockServers, activeServerId: null, setActiveServer: mockSetActive,
    serverSyncStatus: 'idle', serverSyncMessage: null, fetchServersForCentral: mockFetch, verifyRealmTrust: mockVerify,
  }),
}));
jest.mock('@/stores/authStore', () => ({ useAuthStore: (select: (s: unknown) => unknown) => select({ user: { accountType: 'central' } }) }));
jest.mock('@/stores/channelStore', () => ({ useChannelStore: (select: (s: unknown) => unknown) => select({ lastChannelByServer: {} }) }));
jest.mock('@/stores/uiStore', () => ({ useUIStore: (select: (s: unknown) => unknown) => select({}) }));
jest.mock('@/hooks/useDeviceLayout', () => ({ useDeviceLayout: () => ({ isTablet: true, width: 1180 }) }));
jest.mock('../Text', () => ({ Text: require('react-native').Text }));
jest.mock('../Pressable', () => ({ Pressable: require('react-native').Pressable }));
jest.mock('../IconBtn', () => ({
  IconBtn: ({ accessibilityLabel, onPress }: { accessibilityLabel: string; onPress: () => void }) =>
    require('react').createElement(require('react-native').Pressable, { accessibilityLabel, onPress }),
}));
jest.mock('../DiscoverButton', () => ({
  DiscoverButton: ({ onPress }: { onPress: () => void }) =>
    require('react').createElement(require('react-native').Pressable, { accessibilityLabel: 'Discover', onPress }),
}));
jest.mock('../CreateInviteModal', () => ({ CreateInviteModal: () => require('react').createElement(require('react-native').View, { testID: 'invite-modal' }) }));
jest.mock('../BottomDock', () => ({ DrawerLeftRail: () => null, DrawerHubFooter: () => null }));
// Stand-in for the folder-aware list: one row per server, using the panel's renderers.
jest.mock('../ServerListSection', () => ({
  ServerListSection: ({ onServerPress, renderSubtitle, renderTrailing }: {
    onServerPress: (s: MockServer) => void; renderSubtitle: (s: MockServer) => unknown; renderTrailing: (s: MockServer) => unknown;
  }) => {
    const { createElement: h } = require('react');
    const RN = require('react-native');
    return mockServers.map((server) => h(RN.View, { key: server.id },
      h(RN.Pressable, { accessibilityLabel: `open ${server.name}`, onPress: () => onServerPress(server) }, h(RN.Text, null, server.name)),
      renderSubtitle(server),
      renderTrailing(server)));
  },
}));

beforeEach(() => { jest.clearAllMocks(); mockServers = [{ id: 'a', name: 'Vanilla', membersOnline: 4 }]; });

test('opening a trusted realm hands it to the caller', async () => {
  const onOpenServer = jest.fn();
  const screen = await render(<ServerListPanel onOpenServer={onOpenServer} />);
  await fireEvent.press(screen.getByLabelText('open Vanilla'));
  expect(onOpenServer).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
});

test('a realm with a changed identity must be re-approved first (iPad used to skip this)', async () => {
  mockServers = [{ id: 'a', name: 'Vanilla', membersOnline: 4, realmTrust: { state: 'changed' } }];
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  try {
    const onOpenServer = jest.fn();
    const screen = await render(<ServerListPanel onOpenServer={onOpenServer} />);
    expect(screen.getByText('server.reApprovalRequired')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('open Vanilla'));
    expect(onOpenServer).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith('server.realmChanged', expect.any(String), expect.any(Array));
  } finally { alert.mockRestore(); }
});

test('each server offers an invite link', async () => {
  const screen = await render(<ServerListPanel onOpenServer={jest.fn()} />);
  expect(screen.getByText('servers.membersOnline')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('server.createInvite'));
  expect(mockSetActive).toHaveBeenCalledWith('a');
  expect(screen.getByTestId('invite-modal')).toBeTruthy();
});

test('Add Server and Discover open their screens (not Notifications), leaving the panel first', async () => {
  const onLeave = jest.fn();
  const screen = await render(<ServerListPanel onOpenServer={jest.fn()} onLeave={onLeave} />);
  await fireEvent.press(screen.getByText('server.addServer'));
  expect(onLeave).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledWith('/(app)/add-server');
  await fireEvent.press(screen.getByLabelText('Discover'));
  expect(onLeave).toHaveBeenCalledTimes(2);
  expect(mockPush).toHaveBeenLastCalledWith('/(app)/discover-servers');
});

test('with no servers it offers a refresh', async () => {
  mockServers = [];
  const screen = await render(<ServerListPanel onOpenServer={jest.fn()} />);
  expect(screen.getByText('server.noServersLoaded')).toBeTruthy();
  await fireEvent.press(screen.getByText('common.refresh'));
  expect(mockFetch).toHaveBeenCalled();
});
