import { describe, expect, it } from 'vitest';
import { buildUnplayableScreenShares } from '../LiveKitScreenShare';

describe('buildUnplayableScreenShares', () => {
  const voiceUsers = { alice: { username: 'Alice' }, bob: { username: 'Bob' } };

  it('lists remote shares this browser cannot decode under their owner', () => {
    const shares = buildUnplayableScreenShares({
      active: true,
      participants: {
        alice: { name: 'alice', unplayableScreenShareMimeType: 'video/H264' },
        'catrealm-ingress:bob:screen:chan': { name: null, unplayableScreenShareMimeType: 'video/H264' },
        carol: { name: 'Carol' },
      },
      voiceUsers,
      playableIds: new Set(),
    });
    expect(shares).toEqual([
      { id: 'alice', username: 'Alice', mimeType: 'video/H264' },
      { id: 'bob', username: 'Bob', mimeType: 'video/H264' },
    ]);
  });

  it('skips self, playable shares and inactive sessions', () => {
    const participants = {
      alice: { name: 'alice', unplayableScreenShareMimeType: 'video/H265' },
      bob: { name: 'bob', unplayableScreenShareMimeType: 'video/H264' },
    };
    expect(buildUnplayableScreenShares({ active: true, participants, voiceUsers, playableIds: new Set(['bob']), selfUserId: 'alice' })).toEqual([]);
    expect(buildUnplayableScreenShares({ active: false, participants, voiceUsers, playableIds: new Set() })).toEqual([]);
  });
});
