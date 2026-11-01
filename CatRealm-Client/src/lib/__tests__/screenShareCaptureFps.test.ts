import { describe, expect, it } from 'vitest';
import { targetCaptureFps } from '../screenShareCaptureFps';

describe('targetCaptureFps', () => {
  it('keeps the absolute tiers when the ceiling allows 8 Mbps or more', () => {
    expect(targetCaptureFps(8_000, 60, 22_000)).toBe(60);
    expect(targetCaptureFps(3_608, 60, 22_000)).toBe(15);
    expect(targetCaptureFps(300, 60, 22_000)).toBe(2);
    expect(targetCaptureFps(3_608, 60)).toBe(15);
  });

  it('lets a capped share reach full frame rate near its ceiling', () => {
    // Live Edge share on a Central-fallback realm: 4 Mbps 'catrealm' cap, GCC at 3.6 Mbps.
    expect(targetCaptureFps(3_608, 60, 4_000)).toBe(60);
    expect(targetCaptureFps(2_000, 60, 4_000)).toBe(30);
    expect(targetCaptureFps(700, 60, 4_000)).toBe(15);
  });

  it('still drops while the bandwidth estimate is genuinely low', () => {
    expect(targetCaptureFps(250, 60, 4_000)).toBe(5);
    expect(targetCaptureFps(100, 60, 4_000)).toBe(2);
  });

  it('never exceeds the requested frame rate', () => {
    expect(targetCaptureFps(3_608, 30, 4_000)).toBe(30);
  });
});
