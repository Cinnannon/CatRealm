// Tiered capture fps matched to GCC estimate. Prevents pacer buffer growth and
// A/V desync — captures only as many frames as the network can actually drain.
// Very low tiers matter for capture card / device sources (e.g. Elgato) where
// the GCC cold-starts at 100-300 Kbps; at that bitrate a single 1440p keyframe
// takes 10-30 seconds so we must cut fps to near-zero until bandwidth ramps up.
const CAPTURE_FPS_TIERS = [
  { minKbps: 8_000, fps: 60 },
  { minKbps: 4_000, fps: 30 },
  { minKbps: 1_500, fps: 15 },
  { minKbps:   400, fps:  5 },
  { minKbps:     0, fps:  2 },
] as const;

// The tiers assume the top tier's 8 Mbps is reachable. Under a lower sender
// ceiling (e.g. the 'catrealm' preset on Central-fallback realms, 4-5 Mbps) the
// GCC target can never get there and settles a little under the cap, which
// pinned shares at 15 fps (and 2 fps while the estimate ramped). So a lower
// ceiling scales the tiers down, with the top tier at 85% of that ceiling.
const CAPTURE_FPS_TOP_TIER_KBPS = CAPTURE_FPS_TIERS[0].minKbps;
const CAPTURE_FPS_CEILING_HEADROOM = 0.85;

export function targetCaptureFps(targetKbps: number, maxFps: number, ceilingKbps?: number): number {
  const scale = ceilingKbps && ceilingKbps < CAPTURE_FPS_TOP_TIER_KBPS
    ? (ceilingKbps * CAPTURE_FPS_CEILING_HEADROOM) / CAPTURE_FPS_TOP_TIER_KBPS
    : 1;
  for (const tier of CAPTURE_FPS_TIERS) {
    if (targetKbps >= tier.minKbps * scale) return Math.min(tier.fps, maxFps);
  }
  return Math.min(2, maxFps);
}
