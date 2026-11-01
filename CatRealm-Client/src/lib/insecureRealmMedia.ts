import { isHttpGatewayRealm } from './httpRealmGateway';

type MediaContext = 'voice' | 'theater';
type FallbackCapability = { enabled: boolean; liveKitFallbackContexts?: readonly string[] } | null;

export type InsecureRealmMediaDecision = 'proceed' | 'confirm' | 'unavailable';

// Realms the user already accepted the warning for, for this app session.
const acknowledgedRealms = new Set<string>();

export function isInsecureRealmUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && (url.startsWith('http://') || isHttpGatewayRealm(url));
}

/**
 * HTTP realms (directly or through the gateway) can still use Central's
 * LiveKit. Media then travels encrypted to Central, but the realm's own
 * traffic, including the join request carrying the media token, does not.
 * Gateway realms without Central fallback have no reachable media server.
 */
export async function checkInsecureRealmMedia(
  serverUrl: string | null | undefined,
  context: MediaContext,
  probeCapability: (url: string) => Promise<FallbackCapability>,
  acknowledged = false,
): Promise<InsecureRealmMediaDecision> {
  if (!serverUrl || !isInsecureRealmUrl(serverUrl)) return 'proceed';
  const capability = await probeCapability(serverUrl);
  const usesCentralFallback = !!capability && !capability.enabled
    && capability.liveKitFallbackContexts?.includes(context) === true;
  if (!usesCentralFallback) return isHttpGatewayRealm(serverUrl) ? 'unavailable' : 'proceed';
  if (acknowledged) acknowledgedRealms.add(serverUrl);
  return acknowledgedRealms.has(serverUrl) ? 'proceed' : 'confirm';
}

export function resetInsecureRealmAcknowledgements() {
  acknowledgedRealms.clear();
}
