import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canReceiveVideoMimeType,
  knownH264HardwareEncode,
  probeH264HardwareEncode,
  resetH264HardwareEncodeProbe,
  resetVideoReceiveCapabilities,
} from '../screenShareCodecSupport';

function mockEncodingInfo(impl: () => Promise<{ supported: boolean; powerEfficient: boolean }>) {
  const encodingInfo = vi.fn(impl);
  vi.stubGlobal('navigator', { mediaCapabilities: { encodingInfo } });
  return encodingInfo;
}

describe('probeH264HardwareEncode', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetH264HardwareEncodeProbe();
  });

  it('reports software H.264 (OpenH264) as not hardware', async () => {
    mockEncodingInfo(async () => ({ supported: true, powerEfficient: false }));
    expect(knownH264HardwareEncode()).toBeNull();
    await expect(probeH264HardwareEncode()).resolves.toBe(false);
    expect(knownH264HardwareEncode()).toBe(false);
  });

  it('reports hardware H.264 and asks the browser only once', async () => {
    const encodingInfo = mockEncodingInfo(async () => ({ supported: true, powerEfficient: true }));
    await probeH264HardwareEncode();
    await probeH264HardwareEncode();
    expect(knownH264HardwareEncode()).toBe(true);
    expect(encodingInfo).toHaveBeenCalledTimes(1);
  });

  it('stays unknown when the browser cannot say', async () => {
    mockEncodingInfo(async () => { throw new TypeError('unsupported'); });
    await expect(probeH264HardwareEncode()).resolves.toBeNull();
    resetH264HardwareEncodeProbe();
    vi.stubGlobal('navigator', {});
    await expect(probeH264HardwareEncode()).resolves.toBeNull();
  });
});

describe('canReceiveVideoMimeType', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetVideoReceiveCapabilities();
  });

  it('rejects H.264 in a Firefox without OpenH264', () => {
    vi.stubGlobal('RTCRtpReceiver', {
      getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }, { mimeType: 'video/VP9' }, { mimeType: 'video/AV1' }] }),
    });
    expect(canReceiveVideoMimeType('video/H264')).toBe(false);
    expect(canReceiveVideoMimeType('video/vp8')).toBe(true);
  });

  it('assumes a codec plays when the browser can not list them', () => {
    vi.stubGlobal('RTCRtpReceiver', undefined);
    expect(canReceiveVideoMimeType('video/H265')).toBe(true);
  });
});
