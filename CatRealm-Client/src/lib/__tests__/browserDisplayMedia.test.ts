import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBrowserDisplayMedia } from '../desktopCapture';

function fakeStream() {
  const track = { applyConstraints: vi.fn(async () => {}) };
  return { stream: { getVideoTracks: () => [track], getAudioTracks: () => [] } as unknown as MediaStream, track };
}

function mockGetDisplayMedia(impl: (constraints: MediaStreamConstraints) => Promise<MediaStream>) {
  const getDisplayMedia = vi.fn(impl);
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });
  return getDisplayMedia;
}

const options = { width: 1920, height: 1080, frameRate: 60, includeAudio: true };

describe('getBrowserDisplayMedia', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the preferred constraints when the browser accepts them', async () => {
    const { stream, track } = fakeStream();
    const getDisplayMedia = mockGetDisplayMedia(async () => stream);
    await expect(getBrowserDisplayMedia(options)).resolves.toBe(stream);
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    // A minimum frame rate keeps a still screen from dropping to ~20 fps.
    expect(track.applyConstraints).toHaveBeenCalledWith(expect.objectContaining({
      frameRate: { ideal: 60, max: 60, min: 60 },
      width: { ideal: 1920, max: 1920 },
    }));
  });

  it('keeps the size limits when the browser refuses a minimum frame rate', async () => {
    const { stream, track } = fakeStream();
    track.applyConstraints.mockImplementationOnce(async () => { throw Object.assign(new Error('min'), { name: 'OverconstrainedError' }); });
    mockGetDisplayMedia(async () => stream);
    await getBrowserDisplayMedia(options);
    await Promise.resolve();
    expect(track.applyConstraints).toHaveBeenLastCalledWith({
      frameRate: { ideal: 60, max: 60 },
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
    });
  });

  it('retries unconstrained after OverconstrainedError and applies limits best-effort', async () => {
    const { stream, track } = fakeStream();
    const getDisplayMedia = mockGetDisplayMedia(async (constraints) => {
      if (typeof constraints.video === 'object') throw Object.assign(new Error('nope'), { name: 'OverconstrainedError', constraint: 'width' });
      return stream;
    });
    await expect(getBrowserDisplayMedia(options)).resolves.toBe(stream);
    expect(getDisplayMedia).toHaveBeenLastCalledWith({ video: true, audio: true });
    expect(track.applyConstraints).toHaveBeenCalledWith(expect.objectContaining({ width: { ideal: 1920, max: 1920 } }));
  });

  it('does not reopen the picker when the user cancels', async () => {
    const getDisplayMedia = mockGetDisplayMedia(async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); });
    await expect(getBrowserDisplayMedia(options)).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
  });
});
