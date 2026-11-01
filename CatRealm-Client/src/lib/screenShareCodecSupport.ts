// Browser screen shares that pick H.264 usually get OpenH264, a software
// encoder that Chromium only runs to ~48 fps and that we cap at 1080p, while
// VP8 holds the chosen resolution near the capture's own frame rate. Hardware
// H.264 in browsers goes through Media Foundation on Windows, which can't hold
// 60 fps for streaming, so a share prefers VP8 whenever the browser says H.264
// encoding isn't hardware-backed (mediaCapabilities' powerEfficient).

let h264HardwareEncode: boolean | null = null;
let probe: Promise<boolean | null> | null = null;

/** Resolves true/false once known, or null when the browser can't tell. Cached. */
export function probeH264HardwareEncode(): Promise<boolean | null> {
  probe ??= (async () => {
    try {
      const capabilities = typeof navigator !== 'undefined' ? navigator.mediaCapabilities : undefined;
      if (!capabilities?.encodingInfo) return null;
      const info = await capabilities.encodingInfo({
        type: 'webrtc',
        video: { contentType: 'video/H264', width: 1920, height: 1080, bitrate: 4_000_000, framerate: 60 },
      });
      h264HardwareEncode = info.supported && info.powerEfficient;
    } catch {
      h264HardwareEncode = null;
    }
    return h264HardwareEncode;
  })();
  return probe;
}

/** The probe's answer so far: null while unknown, so callers keep their default. */
export function knownH264HardwareEncode(): boolean | null {
  return h264HardwareEncode;
}

export function resetH264HardwareEncodeProbe() {
  h264HardwareEncode = null;
  probe = null;
}

// Viewers can lack a publisher's codec too: Firefox decodes H.264 only through
// the OpenH264 plugin, and no browser is required to decode H.265. LiveKit then
// refuses the subscription, so the client never gets a track to show.
let receivableVideoMimeTypes: Set<string> | null | undefined;

/** Whether this browser can decode the WebRTC video codec; true when it can't tell. */
export function canReceiveVideoMimeType(mimeType: string): boolean {
  if (receivableVideoMimeTypes === undefined) {
    try {
      const codecs = typeof RTCRtpReceiver !== 'undefined' ? RTCRtpReceiver.getCapabilities?.('video')?.codecs : undefined;
      receivableVideoMimeTypes = codecs ? new Set(codecs.map((codec) => codec.mimeType.toLowerCase())) : null;
    } catch {
      receivableVideoMimeTypes = null;
    }
  }
  return !receivableVideoMimeTypes || receivableVideoMimeTypes.has(mimeType.toLowerCase());
}

export function resetVideoReceiveCapabilities() {
  receivableVideoMimeTypes = undefined;
}
