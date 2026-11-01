import { useEffect, useState } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';
import { clearRealtimeReconnectTarget } from '../../lib/realtimeReconnect';
import { useVoiceStore } from '../../stores/voiceStore';
import { useTheaterStore } from '../../stores/theaterStore';
import { isHttpGatewayRealm } from '../../lib/httpRealmGateway';
import { useMediaStore } from '../../stores/mediaStore';

const RESTART_DELAY_S = 10;

export function ConnectionStatus() {
  const status = useUIStore((s) => s.connectionStatus);
  const serverRestartPending = useUIStore((s) => s.serverRestartPending);
  const reconnectPrompt = useUIStore((s) => s.realtimeReconnectPrompt);
  const [restartCountdown, setRestartCountdown] = useState(RESTART_DELAY_S);

  useEffect(() => {
    if (!serverRestartPending) {
      setRestartCountdown(RESTART_DELAY_S);
      return;
    }
    setRestartCountdown(RESTART_DELAY_S);
    const interval = setInterval(() => {
      setRestartCountdown((c) => (c > 0 ? c - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [serverRestartPending]);
  const clearRealtimeReconnectPrompt = useUIStore((s) => s.clearRealtimeReconnectPrompt);
  const sslBlockedServerUrl = useUIStore((s) => s.sslBlockedServerUrl);
  const isCentral = useAuthStore((s) => s.user?.accountType === 'central');
  const activeServerUrl = useServerStore((s) => s.activeServerUrl);
  const localServerUrl = useAuthStore((s) => s.serverUrl);
  const currentServerUrl = isCentral ? activeServerUrl : localServerUrl;
  const isGatewayRealm = isHttpGatewayRealm(currentServerUrl);
  const originalHttpOrigin = useServerStore((s) => s.servers.find((entry) => entry.url === currentServerUrl)?.originalHttpOrigin);
  // Gateway realms can still reach voice/theater through Central Fallback.
  const [gatewayFallback, setGatewayFallback] = useState<{ url: string; available: boolean } | null>(null);
  useEffect(() => {
    if (!isGatewayRealm || !currentServerUrl) return;
    let cancelled = false;
    void useMediaStore.getState().probeSelfHostCapability(currentServerUrl).then((capability) => {
      if (cancelled) return;
      const available = !!capability && !capability.enabled && (capability.liveKitFallbackContexts?.length ?? 0) > 0;
      setGatewayFallback({ url: currentServerUrl, available });
    });
    return () => { cancelled = true; };
  }, [isGatewayRealm, currentServerUrl]);
  const gatewayHasFallback = gatewayFallback?.url === currentServerUrl && gatewayFallback.available;

  const visibleReconnectPrompt = reconnectPrompt && reconnectPrompt.serverUrl === currentServerUrl
    ? reconnectPrompt
    : null;

  // Don't show disconnected banner on HomeView (no active server for central accounts)
  if (status !== 'connected' && isCentral && !activeServerUrl && !sslBlockedServerUrl && !visibleReconnectPrompt && !serverRestartPending) return null;

  const serverUrl = sslBlockedServerUrl ?? (isCentral ? activeServerUrl : localServerUrl);
  const isSecureContext = typeof window !== 'undefined' && window.location.protocol === 'https:';
  if (isSecureContext && serverUrl?.startsWith('http://')) {
    return (
      <div className="relative z-40 shrink-0 bg-warning text-white text-center text-sm py-1 font-medium">
        This realm uses HTTP. <button onClick={() => useUIStore.getState().openModal('offlineServers')} className="underline font-semibold">Review gateway option</button>
      </div>
    );
  }

  const config = {
    reconnecting: { color: 'bg-warning', text: 'Reconnecting...' },
    disconnected: { color: 'bg-danger', text: 'Disconnected' },
  } as const;

  // Restart banner supersedes the normal status banner
  const statusBanner = serverRestartPending || status === 'connected' ? null : config[status];

  if (!visibleReconnectPrompt && !statusBanner && !serverRestartPending && !isGatewayRealm) return null;

  const handleReconnect = () => {
    if (!visibleReconnectPrompt) return;
    clearRealtimeReconnectPrompt();
    if (visibleReconnectPrompt.kind === 'voice') {
      void useVoiceStore.getState().joinVoice(visibleReconnectPrompt.channelId);
      return;
    }
    void useTheaterStore.getState().joinTheater(
      visibleReconnectPrompt.channelId,
      visibleReconnectPrompt.channelName ?? undefined,
    );
  };

  const handleDismissReconnect = () => {
    if (!visibleReconnectPrompt) return;
    clearRealtimeReconnectTarget(visibleReconnectPrompt.kind);
    clearRealtimeReconnectPrompt();
  };

  return (
    <div className="relative z-40 shrink-0 flex flex-col">
      {isGatewayRealm ? (
        <div className="bg-warning text-white text-center text-sm py-1 font-medium">
          {originalHttpOrigin || 'This realm'} uses HTTP between the gateway and its server.{' '}
          {gatewayHasFallback
            ? 'Voice and theater use Central Fallback, but this Realm\'s own traffic is not encrypted.'
            : 'Voice and theater are unavailable here.'}
        </div>
      ) : null}
      {visibleReconnectPrompt ? (
        <div className="bg-warning text-white shadow-md">
          <div className="flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-center flex-wrap">
            <span>Cats was unable to automatically reconnect you but you can try</span>
            <button
              onClick={handleReconnect}
              className="rounded bg-black/20 px-2.5 py-1 text-xs font-semibold hover:bg-black/30 transition-colors"
            >
              Reconnect
            </button>
            <span className="text-white/70">|</span>
            <button
              onClick={handleDismissReconnect}
              className="rounded bg-black/20 px-2.5 py-1 text-xs font-semibold hover:bg-black/30 transition-colors"
            >
              Its Good
            </button>
          </div>
        </div>
      ) : null}
      {serverRestartPending ? (
        <div className="bg-warning text-white text-center text-sm py-1 font-medium">
          {restartCountdown > 0
            ? `Realm is restarting... Reconnecting in ${restartCountdown}s`
            : 'Realm is restarting... Waiting for Realm to start...'}
        </div>
      ) : statusBanner ? (
        <div className={`${statusBanner.color} text-white text-center text-sm py-1 font-medium`}>
          {statusBanner.text}
        </div>
      ) : null}
    </div>
  );
}
