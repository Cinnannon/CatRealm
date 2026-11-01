import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, PictureInPicture2, Volume1, Volume2, VolumeX } from 'lucide-react';
import { VideoQuality } from 'livekit-client';
import type { ScreenShareAudioStatus } from '../../lib/desktopCapture';
import { applySinkId } from '../../lib/mediaPlayback';
import { useSettingsStore, type ScreenShareViewerQuality } from '../../stores/settingsStore';
import { useLastAudibleVolume } from '../../hooks/useLastAudibleVolume';

export type LiveKitAttachableVideoTrack = {
  attach: (element: HTMLMediaElement) => HTMLMediaElement;
  detach?: (element: HTMLMediaElement) => void;
  // observeElementInfo is @internal in LiveKit but lets us pin the
  // quality hint to full source dimensions, overriding adaptive stream's
  // element-size-based downsampling for the main viewer tile.
  observeElementInfo?: (info: ScreenShareFullQualityElementInfo) => void;
  stopObservingElementInfo?: (info: ScreenShareFullQualityElementInfo) => void;
  dimensions?: { width: number; height: number };
};

type ScreenShareFullQualityElementInfo = {
  element: object;
  width(): number;
  height(): number;
  visible: boolean;
  pictureInPicture: boolean;
  visibilityChangedAt: number | undefined;
  observe(): void;
  stopObserving(): void;
};

type LiveKitRemoteMediaTrack = {
  participantId: string;
  source: string;
  kind: 'audio' | 'video';
  subscribedAt?: number;
  mediaStream?: MediaStream;
  remoteTrack?: LiveKitAttachableVideoTrack;
  remotePublication?: LiveKitRemotePublicationControls;
  screenShareAudioStatus?: ScreenShareAudioStatus;
  screenShareVideoTarget?: ScreenShareVideoTarget;
};

type LiveKitRemotePublicationControls = {
  setVideoDimensions?: (dimensions: { width: number; height: number }) => void;
  setVideoFPS?: (fps: number) => void;
  setVideoQuality?: (quality: VideoQuality) => void;
  // LiveKit RemoteTrackPublication exposes the negotiated codec, e.g. "video/h265".
  mimeType?: string;
};

type LiveKitParticipant = {
  name: string | null;
  metadata?: Record<string, unknown> | null;
  unplayableScreenShareMimeType?: string;
};

type VoiceUserLike = {
  username: string;
};

export type LiveKitScreenCandidate = {
  id: string;
  username: string;
  stream: MediaStream;
  title: string;
  liveKitVideoTrack: LiveKitAttachableVideoTrack;
  remotePublication?: LiveKitRemotePublicationControls;
  audioStatus: ScreenShareAudioStatus;
  videoTarget?: ScreenShareVideoTarget;
};

export type ScreenShareVideoTarget = {
  height: number;
  fps: number;
};

function getScreenShareOwnerId(participantId: string, participant?: LiveKitParticipant | null) {
  const ownerIdentity = participant?.metadata?.ownerIdentity;
  if (typeof ownerIdentity === 'string' && ownerIdentity.trim()) return ownerIdentity;
  const ingressMatch = participantId.match(/^catrealm-ingress:([^:]+):screen:/);
  return ingressMatch?.[1] || participantId;
}

export type UnplayableScreenShare = {
  id: string;
  username: string;
  mimeType: string;
};

// Shares this browser can't decode never get a track (LiveKit refuses the
// subscription), so they are listed from the publications instead.
export function buildUnplayableScreenShares({
  active,
  participants,
  voiceUsers,
  playableIds,
  selfUserId,
}: {
  active: boolean;
  participants: Record<string, LiveKitParticipant>;
  voiceUsers: Record<string, VoiceUserLike>;
  playableIds: Set<string>;
  selfUserId?: string | null;
}): UnplayableScreenShare[] {
  if (!active) return [];
  return Object.entries(participants).flatMap(([participantId, participant]) => {
    if (!participant.unplayableScreenShareMimeType) return [];
    const id = getScreenShareOwnerId(participantId, participant);
    if (id === selfUserId || playableIds.has(id)) return [];
    const username = voiceUsers[id]?.username || participant.name || id.slice(0, 6);
    return [{ id, username, mimeType: participant.unplayableScreenShareMimeType }];
  });
}

type ReceivedVideoStats = {
  width: number | null;
  height: number | null;
  fps: number | null;
};

type VideoFrameCallbackMetadata = {
  presentedFrames?: number;
  width?: number;
  height?: number;
};

type VideoElementWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: VideoFrameCallbackMetadata) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
  getVideoPlaybackQuality?: () => { totalVideoFrames?: number };
};

export function buildLiveKitScreenCandidates({
  active,
  tracks,
  participants,
  voiceUsers,
  selfUserId,
  includeSelf = false,
  audibleParticipantIds,
}: {
  active: boolean;
  tracks: Record<string, LiveKitRemoteMediaTrack>;
  participants: Record<string, LiveKitParticipant>;
  voiceUsers: Record<string, VoiceUserLike>;
  selfUserId?: string | null;
  includeSelf?: boolean;
  audibleParticipantIds?: Set<string>;
}): LiveKitScreenCandidate[] {
  if (!active) return [];
  const sortedTracks = Object.values(tracks)
    .filter((track) => track.source === 'screen_share' || track.source === 'screen_share_audio')
    .sort((a, b) => (a.subscribedAt ?? 0) - (b.subscribedAt ?? 0));
  const byParticipant = sortedTracks.reduce<Record<string, { participantId: string; stream: MediaStream; latestAudioAt: number; latestVideoAt: number; videoTrack?: LiveKitAttachableVideoTrack; remotePublication?: LiveKitRemotePublicationControls; audioStatus?: ScreenShareAudioStatus; videoTarget?: ScreenShareVideoTarget }>>((acc, track) => {
    const ownerId = getScreenShareOwnerId(track.participantId, participants[track.participantId]);
    if (!includeSelf && ownerId === selfUserId) return acc;
    if (!track.mediaStream) return acc;
    const entry = acc[ownerId] ?? {
      participantId: track.participantId,
      stream: new MediaStream(),
      latestAudioAt: -1,
      latestVideoAt: -1,
    };
    const desiredKind = track.source === 'screen_share' ? 'video' : 'audio';
    const subscribedAt = track.subscribedAt ?? 0;
    if (desiredKind === 'audio' && subscribedAt < entry.latestAudioAt) return acc;
    if (desiredKind === 'video' && subscribedAt < entry.latestVideoAt) return acc;
    track.mediaStream.getTracks().forEach((mediaTrack) => {
      if (mediaTrack.kind !== desiredKind) return;
      if (
        track.source === 'screen_share_audio'
        && !audibleParticipantIds?.has(track.participantId)
        && !audibleParticipantIds?.has(ownerId)
      ) return;
      if (desiredKind === 'audio') {
        entry.stream.getAudioTracks().forEach((existing) => entry.stream.removeTrack(existing));
        entry.latestAudioAt = subscribedAt;
      } else {
        entry.stream.getVideoTracks().forEach((existing) => entry.stream.removeTrack(existing));
        entry.latestVideoAt = subscribedAt;
      }
      if (entry.stream.getTracks().some((existing) => existing.id === mediaTrack.id)) return;
      entry.stream.addTrack(mediaTrack);
    });
    if (track.source === 'screen_share' && track.kind === 'video' && track.remoteTrack) {
      entry.videoTrack = track.remoteTrack;
      entry.remotePublication = track.remotePublication;
      entry.videoTarget = track.screenShareVideoTarget;
    }
    if (track.source === 'screen_share_audio' && track.screenShareAudioStatus) {
      entry.audioStatus = track.screenShareAudioStatus;
    }
    acc[ownerId] = entry;
    return acc;
  }, {});

  return Object.entries(byParticipant)
    .map<LiveKitScreenCandidate | null>(([id, entry]) => {
      if (!entry.videoTrack) return null;
      const hasLiveVideoTrack = entry.stream.getVideoTracks().some((track) => track.readyState === 'live');
      if (!hasLiveVideoTrack) return null;
      const label = voiceUsers[id]?.username || participants[entry.participantId]?.name || participants[id]?.name || id.slice(0, 6);
      return {
        id,
        username: label,
        stream: entry.stream,
        title: `${label}'s Screen`,
        liveKitVideoTrack: entry.videoTrack,
        remotePublication: entry.remotePublication,
        audioStatus: entry.audioStatus ?? (entry.stream.getAudioTracks().length > 0
          ? { mode: 'system', label: 'System audio', requested: true, available: true }
          : { mode: 'none', label: 'No audio', requested: true, available: false }),
        videoTarget: entry.videoTarget,
      };
    })
    .filter((tile): tile is LiveKitScreenCandidate => Boolean(tile));
}

function formatStreamBadge(height: number | null | undefined, fps: number | null | undefined) {
  const heightLabel = height && Number.isFinite(height) ? `${Math.round(height)}p` : '--p';
  const fpsLabel = fps && Number.isFinite(fps) ? Math.round(fps).toString() : '--';
  return `${heightLabel}${fpsLabel}`;
}

function getTargetWidth(target: ScreenShareVideoTarget | undefined) {
  if (!target?.height || !Number.isFinite(target.height)) return null;
  return Math.round((target.height * 16) / 9);
}

function isHevcMimeType(mimeType?: string | null): boolean {
  if (!mimeType) return false;
  return /h\.?265|hevc/i.test(mimeType);
}

// Whether this browser/runtime can RECEIVE (decode) H.265 over WebRTC. Reflects
// actual negotiated capability, so HEVC-capable runtimes (the desktop app, Safari,
// Firefox 134+, Chrome 136+ with hardware HEVC) report true and play normally;
// only runtimes that genuinely can't decode it report false. Cached after first call.
let cachedHevcReceiveSupport: boolean | null = null;
function browserCanReceiveHevc(): boolean {
  if (cachedHevcReceiveSupport !== null) return cachedHevcReceiveSupport;
  try {
    const caps = typeof RTCRtpReceiver !== 'undefined' && RTCRtpReceiver.getCapabilities
      ? RTCRtpReceiver.getCapabilities('video')
      : null;
    // If capabilities are unavailable we can't be sure, so assume supported and
    // avoid showing a misleading warning over a stream that might actually play.
    cachedHevcReceiveSupport = caps ? caps.codecs.some((codec) => isHevcMimeType(codec.mimeType)) : true;
  } catch {
    cachedHevcReceiveSupport = true;
  }
  return cachedHevcReceiveSupport;
}

const VIEWER_QUALITY_OPTIONS: ScreenShareViewerQuality[] = ['auto', 'high', 'medium', 'low'];

function getQualityTarget(
  quality: ScreenShareViewerQuality,
  videoTarget: ScreenShareVideoTarget | undefined,
  container: HTMLElement | null,
) {
  if (quality === 'high' && videoTarget) {
    return { width: getTargetWidth(videoTarget) ?? 1920, height: videoTarget.height, fps: videoTarget.fps };
  }
  if (quality === 'medium') {
    const height = videoTarget ? Math.min(720, Math.max(360, Math.round(videoTarget.height / 2))) : 720;
    return { width: Math.round((height * 16) / 9), height, fps: videoTarget ? Math.min(videoTarget.fps, 48) : 48 };
  }
  if (quality === 'low') {
    const height = videoTarget ? Math.min(360, Math.max(180, Math.round(videoTarget.height / 4))) : 360;
    return { width: Math.round((height * 16) / 9), height, fps: videoTarget ? Math.min(videoTarget.fps, 24) : 24 };
  }
  const bounds = container?.getBoundingClientRect();
  const pixelDensity = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return {
    width: Math.max(320, Math.round((bounds?.width || 1280) * pixelDensity)),
    height: Math.max(180, Math.round((bounds?.height || 720) * pixelDensity)),
    fps: videoTarget?.fps ?? 30,
  };
}

function formatQualityLabel(
  quality: ScreenShareViewerQuality,
  videoTarget: ScreenShareVideoTarget | undefined,
) {
  if (quality === 'auto') return 'Auto (fit)';
  if (quality === 'high') {
    return videoTarget ? `Source ${videoTarget.height}p${videoTarget.fps}` : 'Source';
  }
  const target = getQualityTarget(quality, videoTarget, null);
  return `${target.height}p${target.fps}`;
}

function syncScreenAudio(element: HTMLMediaElement, stream: MediaStream) {
  const current = element.srcObject instanceof MediaStream ? element.srcObject : new MediaStream();
  const desiredAudioTrackIds = new Set(stream.getAudioTracks().map((track) => track.id));
  current.getAudioTracks().forEach((track) => {
    if (!desiredAudioTrackIds.has(track.id)) {
      current.removeTrack(track);
    }
  });
  stream.getAudioTracks().forEach((track) => {
    if (!current.getTracks().some((existing) => existing.id === track.id)) {
      current.addTrack(track);
    }
  });
  if (element.srcObject !== current) {
    element.srcObject = current;
  }
}

export type ScreenShareAudioMixSource = {
  id: string;
  stream: MediaStream;
  volumePct: number;
};

const SECONDARY_SCREEN_AUDIO_GAIN = 0.25;

function clampScreenVolumePct(volumePct: number) {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(volumePct) ? volumePct : 100)));
}

function ScreenShareAudioElement({
  stream,
  volumePct,
}: ScreenShareAudioMixSource) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const outputDeviceId = useSettingsStore((s) => s.voiceOutputDeviceId);

  const applyAudioState = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    syncScreenAudio(el, stream);
    const effectiveVolume = (clampScreenVolumePct(volumePct) / 100) * SECONDARY_SCREEN_AUDIO_GAIN;
    el.volume = Math.max(0, Math.min(1, effectiveVolume));
    el.muted = stream.getAudioTracks().length === 0 || effectiveVolume <= 0;
    void applySinkId(el, outputDeviceId);
    if (!el.muted) {
      void el.play().catch(() => {});
    }
  }, [outputDeviceId, stream, volumePct]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.dataset.catrealmScreenShareAudio = 'secondary';
    el.autoplay = true;
    el.preload = 'auto';
    applyAudioState();
    return () => {
      try {
        el.pause();
        el.srcObject = null;
      } catch {
        // Ignore already-detached playback elements.
      }
    };
  }, [applyAudioState]);

  useEffect(() => {
    applyAudioState();
  }, [applyAudioState, outputDeviceId, stream, volumePct]);

  useEffect(() => {
    let trackCleanups: Array<() => void> = [];
    const bindTrackListeners = () => {
      trackCleanups.forEach((cleanup) => cleanup());
      trackCleanups = stream.getAudioTracks().map((track) => {
        const handleTrackState = () => applyAudioState();
        track.addEventListener('mute', handleTrackState);
        track.addEventListener('unmute', handleTrackState);
        track.addEventListener('ended', handleTrackState);
        return () => {
          track.removeEventListener('mute', handleTrackState);
          track.removeEventListener('unmute', handleTrackState);
          track.removeEventListener('ended', handleTrackState);
        };
      });
    };
    const handleStreamChange = () => {
      bindTrackListeners();
      applyAudioState();
    };
    handleStreamChange();
    stream.addEventListener('addtrack', handleStreamChange);
    stream.addEventListener('removetrack', handleStreamChange);
    return () => {
      stream.removeEventListener('addtrack', handleStreamChange);
      stream.removeEventListener('removetrack', handleStreamChange);
      trackCleanups.forEach((cleanup) => cleanup());
    };
  }, [applyAudioState, stream]);

  useEffect(() => {
    const onInteract = () => applyAudioState();
    window.addEventListener('pointerdown', onInteract);
    window.addEventListener('keydown', onInteract);
    return () => {
      window.removeEventListener('pointerdown', onInteract);
      window.removeEventListener('keydown', onInteract);
    };
  }, [applyAudioState]);

  return <audio ref={audioRef} aria-hidden="true" style={{ display: 'none' }} />;
}

export function ScreenShareAudioMixer({
  sources,
}: {
  sources: ScreenShareAudioMixSource[];
}) {
  return (
    <>
      {sources.map((source) => (
        <ScreenShareAudioElement
          key={source.id}
          id={source.id}
          stream={source.stream}
          volumePct={source.volumePct}
        />
      ))}
    </>
  );
}

export function LiveKitStreamStripTile({
  stream,
  title,
  liveKitVideoTrack,
  selected,
  onClick,
}: {
  stream: MediaStream;
  title: string;
  liveKitVideoTrack: LiveKitAttachableVideoTrack;
  selected: boolean;
  onClick: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    liveKitVideoTrack.attach(el);
    el.muted = true;
    void el.play().catch(() => {});
    return () => {
      liveKitVideoTrack.detach?.(el);
    };
  }, [liveKitVideoTrack]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    syncScreenAudio(el, stream);
    el.muted = true;
    void el.play().catch(() => {});
  }, [stream]);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative shrink-0 w-56 overflow-hidden rounded-xl border text-left transition-all ${
        selected
          ? 'border-amber-300 shadow-[0_0_0_1px_rgba(252,211,77,0.65)]'
          : 'border-white/10 hover:border-white/30'
      }`}
    >
      <div className="aspect-video bg-black/40">
        <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
      </div>
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-2 py-1.5">
        <span className="truncate text-[11px] text-white/90">{title}</span>
        {selected && <span className="text-[10px] font-semibold text-amber-300">Selected</span>}
      </div>
    </button>
  );
}

export function LiveKitScreenTile({
  stream,
  title,
  liveKitVideoTrack,
  remotePublication,
  onLeave,
  peerId,
  audioStatus,
  videoTarget,
  disabled = false,
  volumePct: controlledVolumePct,
  onVolumePctChange,
}: {
  stream: MediaStream;
  title: string;
  liveKitVideoTrack: LiveKitAttachableVideoTrack;
  remotePublication?: LiveKitRemotePublicationControls;
  onLeave?: () => void;
  peerId?: string;
  audioStatus?: ScreenShareAudioStatus;
  videoTarget?: ScreenShareVideoTarget;
  disabled?: boolean;
  volumePct?: number;
  onVolumePctChange?: (volumePct: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const outputDeviceId = useSettingsStore((s) => s.voiceOutputDeviceId);
  const viewerQuality = useSettingsStore((s) => s.screenShareViewerQuality);
  const setViewerQuality = useSettingsStore((s) => s.setScreenShareViewerQuality);
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPip, setIsPip] = useState(false);
  const [playFailed, setPlayFailed] = useState(false);
  const [internalVolumePct, setInternalVolumePct] = useState(100);
  const [receivedStats, setReceivedStats] = useState<ReceivedVideoStats>({
    width: null,
    height: null,
    fps: null,
  });
  // Grace window before we trust "no frames decoded" — a healthy stream produces
  // frames within a second or two; this avoids flashing the notice on slow starts.
  const [decodeGraceElapsed, setDecodeGraceElapsed] = useState(false);

  const resolvedAudioStatus = audioStatus ?? (stream.getAudioTracks().length > 0
    ? { mode: 'system', label: 'System audio', requested: true, available: true }
    : { mode: 'none', label: 'No audio', requested: true, available: false });
  const hasStreamAudio = resolvedAudioStatus.available && stream.getAudioTracks().length > 0;
  const volumePct = controlledVolumePct ?? internalVolumePct;
  const isMuted = volumePct === 0;
  const getLastAudibleVolumePct = useLastAudibleVolume(volumePct);
  const VolumeIcon = !hasStreamAudio || isMuted ? VolumeX : volumePct < 50 ? Volume1 : Volume2;
  const pipSupported = typeof document !== 'undefined' && !!(document as any).pictureInPictureEnabled;
  const effectiveViewerQuality: ScreenShareViewerQuality = peerId ? viewerQuality : 'high';
  const selectedQualityLabel = formatQualityLabel(effectiveViewerQuality, videoTarget);
  // Whether the element is actually decoding video (frames are arriving). This is
  // ground truth — unlike RTCRtpReceiver.getCapabilities('video'), which under-
  // reports HEVC on some browsers (e.g. Chrome that decodes negotiated H.265 fine
  // yet omits it from the static capability list).
  const isDecodingVideo = Boolean(receivedStats.width && receivedStats.height) || (receivedStats.fps ?? 0) > 0;
  // The publisher's share is H.265 and, after a grace window, this browser is still
  // not decoding any frames — show an explainer instead of a permanently blank tile.
  const hevcUnsupported = isHevcMimeType(remotePublication?.mimeType) && decodeGraceElapsed && !isDecodingVideo;
  const streamRef = useRef(stream);
  const audioStateRef = useRef({
    disabled,
    hasStreamAudio,
    outputDeviceId,
    peerId,
    volumePct,
  });
  streamRef.current = stream;
  audioStateRef.current = {
    disabled,
    hasStreamAudio,
    outputDeviceId,
    peerId,
    volumePct,
  };

  const tryPlayVideo = useCallback(() => {
    const el = videoRef.current;
    if (!el || !el.paused) return;
    el.play().then(() => setPlayFailed(false)).catch(() => setPlayFailed(true));
  }, []);

  const tryPlayAudio = useCallback(() => {
    const el = videoRef.current;
    const audioState = audioStateRef.current;
    const targetStream = streamRef.current;
    if (!el || targetStream.getAudioTracks().length === 0 || audioState.disabled || audioState.volumePct <= 0) return;
    syncScreenAudio(el, targetStream);
    void el.play().catch(() => {});
  }, []);

  const applyAudioState = useCallback((nextVolumePct?: number) => {
    const el = videoRef.current;
    if (!el) return;
    const audioState = audioStateRef.current;
    const targetVolumePct = nextVolumePct ?? audioState.volumePct;
    const targetStream = streamRef.current;
    syncScreenAudio(el, targetStream);
    const hasAudioNow = targetStream.getAudioTracks().length > 0;
    el.muted = !audioState.peerId || !hasAudioNow || audioState.disabled || targetVolumePct <= 0;
    el.volume = Math.max(0, Math.min(1, targetVolumePct / 100));
    void applySinkId(el, audioState.outputDeviceId);
    if (!el.muted) {
      void el.play().catch(() => {});
    }
  }, []);

  const handleVolumeChange = (nextVolumePct: number) => {
    const normalized = Math.max(0, Math.min(100, Math.round(nextVolumePct)));
    setInternalVolumePct(normalized);
    onVolumePctChange?.(normalized);
    applyAudioState(normalized);
  };

  const toggleMute = () => {
    handleVolumeChange(isMuted ? getLastAudibleVolumePct() : 0);
  };

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    liveKitVideoTrack.attach(el);
    syncScreenAudio(el, streamRef.current);
    applyAudioState();
    tryPlayVideo();
    const targetWidth = getTargetWidth(videoTarget);
    let qualityInfo: ScreenShareFullQualityElementInfo | null = null;
    if (effectiveViewerQuality === 'high' && liveKitVideoTrack.observeElementInfo) {
      const dims = liveKitVideoTrack.dimensions;
      qualityInfo = {
        element: el,
        width: () => targetWidth ?? dims?.width ?? 1920,
        height: () => videoTarget?.height ?? dims?.height ?? 1080,
        visible: true,
        pictureInPicture: false,
        visibilityChangedAt: undefined,
        observe: () => {},
        stopObserving: () => {},
      };
      liveKitVideoTrack.observeElementInfo(qualityInfo);
    }
    return () => {
      if (qualityInfo) liveKitVideoTrack.stopObservingElementInfo?.(qualityInfo);
      liveKitVideoTrack.detach?.(el);
    };
  }, [applyAudioState, effectiveViewerQuality, liveKitVideoTrack, tryPlayVideo, videoTarget]);

  useEffect(() => {
    if (!remotePublication) return;
    const applyQuality = () => {
      const target = getQualityTarget(effectiveViewerQuality, videoTarget, containerRef.current);
      remotePublication.setVideoFPS?.(target.fps);
      if (effectiveViewerQuality === 'high') remotePublication.setVideoQuality?.(VideoQuality.HIGH);
      else if (effectiveViewerQuality === 'medium') remotePublication.setVideoQuality?.(VideoQuality.MEDIUM);
      else if (effectiveViewerQuality === 'low') remotePublication.setVideoQuality?.(VideoQuality.LOW);
      else remotePublication.setVideoDimensions?.({ width: target.width, height: target.height });
    };
    applyQuality();
    if (effectiveViewerQuality !== 'auto' || typeof ResizeObserver === 'undefined') return;
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(applyQuality);
    observer.observe(container);
    return () => observer.disconnect();
  }, [effectiveViewerQuality, remotePublication, videoTarget]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    syncScreenAudio(el, stream);
    applyAudioState();
    tryPlayVideo();
  }, [applyAudioState, stream, tryPlayVideo]);

  useEffect(() => {
    applyAudioState();
  }, [applyAudioState, disabled, hasStreamAudio, outputDeviceId, peerId, volumePct]);

  useEffect(() => {
    let trackCleanups: Array<() => void> = [];
    const syncAndPlay = () => {
      const el = videoRef.current;
      if (!el) return;
      syncScreenAudio(el, stream);
      applyAudioState();
      tryPlayVideo();
      tryPlayAudio();
    };
    const bindTrackListeners = () => {
      trackCleanups.forEach((cleanup) => cleanup());
      trackCleanups = stream.getAudioTracks().map((track) => {
        const handleTrackState = () => syncAndPlay();
        track.addEventListener('mute', handleTrackState);
        track.addEventListener('unmute', handleTrackState);
        track.addEventListener('ended', handleTrackState);
        return () => {
          track.removeEventListener('mute', handleTrackState);
          track.removeEventListener('unmute', handleTrackState);
          track.removeEventListener('ended', handleTrackState);
        };
      });
    };
    const handleStreamChange = () => {
      bindTrackListeners();
      syncAndPlay();
    };
    handleStreamChange();
    stream.addEventListener('addtrack', handleStreamChange);
    stream.addEventListener('removetrack', handleStreamChange);
    return () => {
      stream.removeEventListener('addtrack', handleStreamChange);
      stream.removeEventListener('removetrack', handleStreamChange);
      trackCleanups.forEach((cleanup) => cleanup());
    };
  }, [applyAudioState, stream, tryPlayAudio, tryPlayVideo]);

  useEffect(() => {
    const el = videoRef.current as VideoElementWithFrameCallback | null;
    if (!el) return;

    const updateDimensions = (fps: number | null) => {
      const [track] = stream.getVideoTracks();
      const settings = track?.getSettings();
      setReceivedStats({
        width: el.videoWidth || settings?.width || null,
        height: el.videoHeight || settings?.height || null,
        fps: fps ?? settings?.frameRate ?? null,
      });
    };

    let stopped = false;
    let frameCallbackId: number | null = null;
    if (el.requestVideoFrameCallback) {
      let frames = 0;
      let lastAt = 0;
      let lastPresentedFrames: number | null = null;
      const onFrame = (now: number, metadata: VideoFrameCallbackMetadata) => {
        if (stopped) return;
        if (lastAt === 0) {
          lastAt = now;
          lastPresentedFrames = metadata.presentedFrames ?? null;
          setReceivedStats({
            width: metadata.width || el.videoWidth || null,
            height: metadata.height || el.videoHeight || null,
            fps: null,
          });
          frameCallbackId = el.requestVideoFrameCallback?.(onFrame) ?? null;
          return;
        }
        if (typeof metadata.presentedFrames === 'number' && lastPresentedFrames !== null) {
          frames += Math.max(0, metadata.presentedFrames - lastPresentedFrames);
          lastPresentedFrames = metadata.presentedFrames;
        } else {
          frames += 1;
        }
        if (now - lastAt >= 1000) {
          const fps = (frames * 1000) / Math.max(1, now - lastAt);
          setReceivedStats({
            width: metadata.width || el.videoWidth || null,
            height: metadata.height || el.videoHeight || null,
            fps,
          });
          frames = 0;
          lastAt = now;
        }
        frameCallbackId = el.requestVideoFrameCallback?.(onFrame) ?? null;
      };
      frameCallbackId = el.requestVideoFrameCallback(onFrame);
      updateDimensions(null);
      return () => {
        stopped = true;
        if (frameCallbackId !== null) el.cancelVideoFrameCallback?.(frameCallbackId);
      };
    }

    let previousFrames = el.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    const interval = window.setInterval(() => {
      const currentFrames = el.getVideoPlaybackQuality?.().totalVideoFrames ?? previousFrames;
      const fps = Math.max(0, currentFrames - previousFrames);
      previousFrames = currentFrames;
      updateDimensions(fps);
    }, 1000);
    updateDimensions(null);
    return () => window.clearInterval(interval);
  }, [stream]);

  useEffect(() => {
    const onInteract = () => {
      applyAudioState();
      tryPlayVideo();
      tryPlayAudio();
    };
    window.addEventListener('pointerdown', onInteract);
    window.addEventListener('keydown', onInteract);
    return () => {
      window.removeEventListener('pointerdown', onInteract);
      window.removeEventListener('keydown', onInteract);
    };
  }, [applyAudioState, tryPlayAudio, tryPlayVideo]);

  const enterPip = () => {
    const el = videoRef.current;
    if (!el || !(document as any).pictureInPictureEnabled) return;
    el.requestPictureInPicture().catch(() => {});
  };

  const exitPip = () => {
    if ((document as any).pictureInPictureElement) {
      (document as any).exitPictureInPicture().catch(() => {});
    }
  };

  const enterFullscreen = () => {
    const el = containerRef.current;
    const req = (el as any)?.requestFullscreen ?? (el as any)?.webkitRequestFullscreen;
    req?.call(el).catch(() => {});
  };

  const exitFullscreen = () => {
    const exit = (document as any).exitFullscreen ?? (document as any).webkitExitFullscreen;
    if ((document as any).fullscreenElement ?? (document as any).webkitFullscreenElement) {
      exit?.call(document).catch(() => {});
    }
  };

  const scheduleHide = () => {
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setOverlayVisible(false), 2500);
  };

  const cancelHide = () => {
    if (hideTimerRef.current) { window.clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
  };

  useEffect(() => {
    const onFs = () => {
      const fsEl = (document as any).fullscreenElement ?? (document as any).webkitFullscreenElement;
      setIsFullscreen(fsEl === containerRef.current);
      setOverlayVisible(true);
    };
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('webkitfullscreenchange', onFs);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const onEnter = () => setIsPip(true);
    const onLeave = () => setIsPip(false);
    el.addEventListener('enterpictureinpicture', onEnter);
    el.addEventListener('leavepictureinpicture', onLeave);
    return () => {
      el.removeEventListener('enterpictureinpicture', onEnter);
      el.removeEventListener('leavepictureinpicture', onLeave);
    };
  }, []);

  // Restart the decode grace window whenever the stream changes.
  useEffect(() => {
    setDecodeGraceElapsed(false);
    const timer = window.setTimeout(() => setDecodeGraceElapsed(true), 6000);
    return () => window.clearTimeout(timer);
  }, [stream]);

  // One-shot diagnostic so a browser viewer can read in DevTools why a screen
  // share did/didn't get the H.265-unsupported notice. Note browserCanReceiveHevc
  // (getCapabilities) is informational only — actual decode is the real signal.
  useEffect(() => {
    const mimeType = remotePublication?.mimeType;
    if (!mimeType) return;
    const caps = typeof RTCRtpReceiver !== 'undefined' && RTCRtpReceiver.getCapabilities
      ? RTCRtpReceiver.getCapabilities('video')
      : null;
    console.info('[CatRealm] screen-share codec diagnostic', {
      trackMimeType: mimeType,
      trackIsHevc: isHevcMimeType(mimeType),
      browserCanReceiveHevc: browserCanReceiveHevc(),
      isDecodingVideo,
      hevcUnsupportedNotice: hevcUnsupported,
      videoReceiveCodecs: caps ? caps.codecs.map((codec) => codec.mimeType) : 'getCapabilities unavailable',
    });
  }, [remotePublication, hevcUnsupported, isDecodingVideo]);

  return (
    <div
      ref={containerRef}
      className={`relative w-full overflow-hidden bg-black/40 border border-white/10 shadow-lg group ${
        isFullscreen ? 'h-full rounded-none' : 'aspect-video rounded-xl'
      }`}
      onMouseEnter={() => { setOverlayVisible(true); cancelHide(); }}
      onMouseMove={() => { setOverlayVisible(true); cancelHide(); }}
      onMouseLeave={scheduleHide}
      onDoubleClick={() => { if (isFullscreen) exitFullscreen(); else enterFullscreen(); }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        controls={false}
        className="w-full h-full object-contain"
        onPause={tryPlayVideo}
        onLoadedMetadata={tryPlayVideo}
        onCanPlay={tryPlayVideo}
        onPlaying={() => setPlayFailed(false)}
        onContextMenu={(e) => e.preventDefault()}
        style={{ pointerEvents: 'none' }}
      />

      <div className={`absolute left-3 top-3 z-10 overflow-hidden rounded border border-black/20 shadow-lg pointer-events-none transition-opacity duration-200 ${overlayVisible ? 'opacity-100' : 'opacity-0'}`}>
        <div className="bg-emerald-500/95 px-2.5 py-1 text-[11px] font-bold leading-none text-emerald-950">
          {formatStreamBadge(videoTarget?.height, videoTarget?.fps)} <span className="font-semibold opacity-75">Target</span>
        </div>
        <div className="bg-black/70 px-2.5 py-1 text-[11px] font-semibold leading-none text-white">
          {formatStreamBadge(receivedStats.height, receivedStats.fps)} <span className="font-medium text-white/65">Received</span>
        </div>
      </div>

      {hevcUnsupported && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 px-4 text-center text-white pointer-events-none">
          <div className="max-w-sm">
            <div className="text-sm font-semibold">Can&apos;t play this screen share</div>
            <div className="mt-1.5 text-xs text-white/75">
              This screen share is encoded in H.265 (HEVC), which your browser can&apos;t decode.
              Open CatRealm in the desktop app — or a browser with HEVC support — to watch it.
            </div>
          </div>
        </div>
      )}

      {playFailed && !hevcUnsupported && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/35 px-4 text-center text-white pointer-events-none">
          <div>
            <div className="text-sm font-semibold">Click to resume screen playback</div>
            <div className="mt-1 text-xs text-white/70">Browser autoplay blocked the stream until the next interaction.</div>
          </div>
        </div>
      )}

      {/* Always-visible bottom gradient + title */}
      <div className="absolute bottom-0 left-0 right-0 flex items-center px-3 py-2 bg-gradient-to-t from-black/80 via-black/40 to-transparent pointer-events-none">
        <span className="text-xs text-white/80 truncate">{title}</span>
      </div>

      {/* Controls — fade on inactivity */}
      <div
        className={`absolute bottom-0 left-0 right-0 flex items-center justify-end gap-2 px-3 py-2 transition-opacity duration-200 ${
          overlayVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {onLeave && (
          <button type="button" onClick={onLeave} className="shrink-0 text-xs px-2 py-0.5 rounded bg-white/20 hover:bg-white/30 text-white">
            Stop Watching
          </button>
        )}
        {peerId ? (
          <label className="shrink-0 flex items-center gap-1 rounded bg-black/45 border border-white/10 px-2 py-1 text-[11px] text-white/70">
            <span>Quality</span>
            <select
              value={viewerQuality}
              onChange={(event) => setViewerQuality(event.target.value as ScreenShareViewerQuality)}
              className="bg-transparent text-white font-semibold outline-none"
              title={`Screen share quality: ${selectedQualityLabel}`}
            >
              {VIEWER_QUALITY_OPTIONS.map((value) => (
                <option key={value} value={value} className="bg-[#111827] text-white">
                  {formatQualityLabel(value, videoTarget)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div
            className="shrink-0 rounded bg-black/45 border border-white/10 px-2 py-1 text-[11px] font-semibold text-white/80"
            title={`Screen share quality: ${selectedQualityLabel}`}
          >
            {selectedQualityLabel}
          </div>
        )}
        {peerId && hasStreamAudio && (
          <div className="shrink-0 flex items-center gap-1.5">
            <span className="text-[11px] text-white/55">{resolvedAudioStatus.label}</span>
            <button
              type="button"
              onClick={toggleMute}
              className="text-white/70 hover:text-white"
              title={isMuted ? 'Unmute stream audio' : 'Mute stream audio'}
            >
              <VolumeIcon size={16} />
            </button>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={isMuted ? 0 : volumePct}
              onChange={(e) => handleVolumeChange(Number(e.target.value))}
              className="w-20 h-1 accent-white cursor-pointer"
              title={`Volume: ${isMuted ? 0 : volumePct}%`}
            />
          </div>
        )}
        {peerId && !hasStreamAudio && (
          <div className="shrink-0 flex items-center gap-1 text-white/45" title="This stream has no shared audio track">
            <VolumeX size={16} />
            <span className="text-[11px]">No audio</span>
          </div>
        )}
        {pipSupported && (
          <button type="button" onClick={isPip ? exitPip : enterPip} className="shrink-0 text-white/70 hover:text-white" title={isPip ? 'Exit Picture-in-Picture' : 'Picture-in-Picture'}>
            <PictureInPicture2 size={16} />
          </button>
        )}
        <button type="button" onClick={isFullscreen ? exitFullscreen : enterFullscreen} className="shrink-0 text-white/70 hover:text-white" title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}>
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>
    </div>
  );
}
