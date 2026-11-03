import { render } from '@testing-library/react-native';
import { BottomDock, TopHubBar } from '../../BottomDock';
import { DOCK_HEIGHT } from '@/lib/dockLayout';

jest.setTimeout(15_000);
jest.mock('expo-router', () => ({ usePathname: () => mockPath, useRouter: () => ({ replace: jest.fn(), push: jest.fn() }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 48, left: 0, right: 0 }) }));
jest.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }) }));
jest.mock('@/hooks/useDeviceLayout', () => ({ useDeviceLayout: () => ({ isTablet: false }) }));
jest.mock('@/components/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/Pressable', () => ({ Pressable: require('react-native').Pressable }));
jest.mock('@/components/Avatar', () => ({ Avatar: require('react-native').View }));
jest.mock('@/components/ServerIcon', () => ({ ServerIcon: require('react-native').View }));
jest.mock('@/components/TourAnchor', () => ({ TourAnchor: require('react-native').View }));
jest.mock('@/lib/realmReadState', () => ({ useRealmUnreadStore: (select: (state: unknown) => unknown) => select({ byServer: {} }) }));
jest.mock('lucide-react-native', () => ({
  Bell: 'Icon',
  Cat: 'Icon',
  Folder: 'Icon',
  Home: 'Icon',
  Menu: 'Icon',
  MessageCircle: 'Icon',
  Palette: 'Icon',
  Plus: 'Icon',
  Settings: 'Icon',
}));
jest.mock('@/stores/theaterStore', () => ({ useTheaterStore: (select: (state: unknown) => unknown) => select(mockTheater) }));
jest.mock('@/stores/authStore', () => ({ useAuthStore: (select: (state: unknown) => unknown) => select({ user: null }) }));
jest.mock('@/stores/serverStore', () => ({ useServerStore: (select: (state: unknown) => unknown) => select({ activeServerId: null, servers: [] }) }));
jest.mock('@/stores/dmStore', () => ({ useDMStore: (select: (state: unknown) => unknown) => select({ conversations: [] }) }));
jest.mock('@/stores/groupChatStore', () => ({ useGroupChatStore: (select: (state: unknown) => unknown) => select({ groups: [] }) }));
jest.mock('@/stores/friendStore', () => ({ useFriendStore: (select: (state: unknown) => unknown) => select({ incoming: [] }) }));
jest.mock('@/stores/notificationStore', () => ({ useNotificationStore: (select: (state: unknown) => unknown) => select({ summary: null }) }));
jest.mock('@/stores/channelStore', () => ({ useChannelStore: (select: (state: unknown) => unknown) => select({ lastChannelByServer: {} }) }));
jest.mock('@/stores/uiStore', () => ({ useUIStore: (select: (state: unknown) => unknown) => select({}) }));

const mockPath = '/home';
const mockTheater = { overlayMode: 'expanded', focused: false };

test('BottomDock is eliminated from the bottom of the screen (DOCK_HEIGHT = 0)', async () => {
  expect(DOCK_HEIGHT).toBe(0);
  const screen = await render(<BottomDock />);
  expect(screen.toJSON()).toBeNull();
});

test('TopHubBar renders all primary navigation destinations at the top of the hub', async () => {
  const screen = await render(<TopHubBar />);
  expect(screen.getByTestId('top-hub-bar')).toBeTruthy();
  expect(screen.getByText('tabs.chats')).toBeTruthy();
  expect(screen.getByText('tabs.home')).toBeTruthy();
  expect(screen.getByText('tabs.servers')).toBeTruthy();
  expect(screen.getByText('tabs.you')).toBeTruthy();
});
