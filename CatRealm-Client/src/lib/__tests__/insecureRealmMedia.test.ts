import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkInsecureRealmMedia, resetInsecureRealmAcknowledgements } from '../insecureRealmMedia';

const gateway = `https://r-${'a'.repeat(40)}.bridge.catrealm.app`;
const central = { enabled: false, liveKitFallbackContexts: ['voice', 'theater'] };

describe('checkInsecureRealmMedia', () => {
  beforeEach(() => resetInsecureRealmAcknowledgements());

  it('never probes or warns for HTTPS realms', async () => {
    const probe = vi.fn();
    expect(await checkInsecureRealmMedia('https://realm.example', 'voice', probe)).toBe('proceed');
    expect(probe).not.toHaveBeenCalled();
  });

  it('asks once per realm when an HTTP realm uses Central Fallback', async () => {
    const probe = vi.fn(async () => central);
    expect(await checkInsecureRealmMedia('http://203.0.113.7:40500', 'voice', probe)).toBe('confirm');
    expect(await checkInsecureRealmMedia('http://203.0.113.7:40500', 'voice', probe, true)).toBe('proceed');
    expect(await checkInsecureRealmMedia('http://203.0.113.7:40500', 'theater', probe)).toBe('proceed');
    expect(await checkInsecureRealmMedia(gateway, 'voice', probe)).toBe('confirm');
  });

  it('keeps gateway realms without Central Fallback unavailable', async () => {
    const own = vi.fn(async () => ({ enabled: true, liveKitFallbackContexts: [] }));
    expect(await checkInsecureRealmMedia(gateway, 'voice', own)).toBe('unavailable');
    // A direct HTTP realm on its own LiveKit is outside this warning.
    expect(await checkInsecureRealmMedia('http://203.0.113.7', 'voice', own)).toBe('proceed');
    expect(await checkInsecureRealmMedia(gateway, 'voice', vi.fn(async () => null))).toBe('unavailable');
  });
});
