export {};

declare global {
  type EmbedLoginPlatform = 'youtube' | 'x';
  type EmbedLoginStatusResult = { loggedIn: boolean };
  type EmbedLoginActionResult = { ok: boolean; reason?: string; message?: string };
  type TheaterYouTubeCookieStatusResult = { loggedIn: boolean; cookieCount: number };
  type TheaterYouTubeCookieExportResult = {
    ok: boolean;
    cookieCount?: number;
    cookieText?: string;
    reason?: string;
    message?: string;
  };
  type AppQueuedUpdateAction = 'force-next' | 'downgrade-stable';

  type AppUpdateStatus =
    | { state: 'idle'; queuedAction?: AppQueuedUpdateAction }
    | { state: 'queued'; queuedAction: AppQueuedUpdateAction; message?: string }
    | { state: 'checking'; queuedAction?: AppQueuedUpdateAction }
    | { state: 'downloading'; version?: string | null; percent?: number; queuedAction?: AppQueuedUpdateAction }
    | { state: 'downloaded'; version?: string | null; queuedAction?: AppQueuedUpdateAction }
    | { state: 'not-available'; queuedAction?: AppQueuedUpdateAction; message?: string }
    | { state: 'error'; message?: string; stalled?: boolean; canRetry?: boolean; queuedAction?: AppQueuedUpdateAction }
    | { state: 'unsupported' };

  type AppUpdateActionResult = { ok: true } | { ok: false; reason: string; message?: string };
  type AppUpdateChannel = string;
  type AppUpdateChannelResult = { ok: true; channel: AppUpdateChannel };
  type VoiceDebugLogEntry = {
    at: number;
    level?: 'debug' | 'info' | 'warn' | 'error';
    scope: string;
    message: string;
    details?: unknown;
  };
  type DesktopStartupSettingsResult = {
    supported: boolean;
    enabled: boolean;
    ok?: boolean;
    reason?: string;
    message?: string;
  };
  type ScreenshareFirewallRuleResult =
    | { ok: true; ruleName: string; programPath: string }
    | { ok: false; reason: string; message?: string };
  type ScreenshareFirewallRuleStatus = {
    at: number;
    level: 'info' | 'success' | 'error';
    message: string;
  };
  type DesktopGameActivity = {
    activityType: 'Playing';
    activityText: string;
    activityStartedAt: number | null;
    processName?: string;
    processId?: number;
  };
  type DesktopGameActivityState = {
    supported: boolean;
    enabled: boolean;
    status: 'unsupported' | 'disabled' | 'detecting' | 'idle' | 'active' | 'error';
    activity: DesktopGameActivity | null;
    lastError?: string | null;
    updatedAt: number;
  };
  type ScreenShareVideoEncoderBackend = 'auto' | 'd3d11' | 'vulkan';
  type ScreenShareDesktopCaptureMode = 'auto' | 'monitor-dxgi' | 'window-wgc';
  type ScreenShareVideoEncodingDiagnostics = {
    hardwareEncodeAvailable: boolean;
    chromiumVideoEncode: string | null;
    chromiumGpuCompositing: string | null;
    hardwareEncodeProfiles: Array<{
      profile: number | string | null;
      minResolutionWidth: number | null;
      minResolutionHeight: number | null;
      maxResolutionWidth: number | null;
      maxResolutionHeight: number | null;
      maxFramerateNumerator: number | null;
      maxFramerateDenominator: number | null;
    }> | null;
    reason: string | null;
  };
  type ScreenShareVideoEncodingConfig = {
    hardwareEncoding: boolean;
    encoderBackend: ScreenShareVideoEncoderBackend;
    diagnostics?: ScreenShareVideoEncodingDiagnostics;
    applied?: {
      hardwareEncoding: boolean;
      encoderBackend: ScreenShareVideoEncoderBackend;
    };
    ok?: boolean;
    requiresRestart?: boolean;
  };
  type DesktopAudioCaptureSupport = {
    platform: NodeJS.Platform | 'browser' | 'unknown';
    appAudio: {
      available: boolean;
      helperPath?: string;
      reason?: string;
    };
    systemAudio: {
      available: boolean;
      reason?: string;
    };
  };
  type NativeWhipPublisherSupport = {
    ok: boolean;
    platform: NodeJS.Platform | 'browser' | 'unknown';
    backend?: 'ffmpeg' | 'gstreamer';
    gstPath?: string;
    ffmpegPath?: string;
    reason?: string | null;
    features?: {
      whipMuxer: boolean;
      ddagrab: boolean;
      gfxcapture: boolean;
      dshowInput: boolean;
      h264Nvenc: boolean;
      libopus: boolean;
      whipDtlsBackend: boolean;
    };
    tlsBackends?: {
      gnutls: boolean;
      openssl: boolean;
      schannel: boolean;
    };
    checkedAt: number;
  };
  type ScreenShareGpu = {
    id: string;
    label: string;
    vendor: 'nvidia' | 'amd' | 'intel' | 'other';
    encoder: 'nvh264enc' | 'amfh264enc' | 'mfh264enc';
    integrated: boolean;
  };
  type NativeVoiceSupport = {
    ok: boolean;
    backend?: string;
    platform?: string;
    reason?: string;
  };
  type NativeVoiceConnectResult =
    | {
        ok: true;
        roomName: string;
        identity: string;
        participants: Array<{ identity: string; name: string }>;
        micPublished: boolean;
        micError: string | null;
      }
    | { ok: false; reason: string; message?: string };
  type NativeVoiceEvent =
    | { type: 'connection'; state: 'connected' | 'reconnecting' | 'disconnected' }
    | { type: 'participant-connected'; identity: string; name: string }
    | { type: 'participant-disconnected'; identity: string }
    | { type: 'active-speakers'; identities: string[] }
    | { type: 'video-preview'; kind: 'camera' | 'screen'; dataUrl: string }
    | { type: 'video-preview-ended'; kind: 'camera' | 'screen' }
    | { type: 'remote-video-frame'; identity: string; trackSid: string; kind: 'camera' | 'screen'; dataUrl: string; width: number; height: number }
    | { type: 'remote-video-ended'; identity?: string; trackSid: string; kind?: 'camera' | 'screen' }
    | { type: 'disconnected'; reason: string };
  type NativeVideoCaptureDevice = {
    deviceId: string;
    kind: 'videoinput';
    label: string;
    groupId?: string | null;
    devicePath?: string | null;
  };
  type NativeWhipPublisherStartOptions = {
    sourceId: string;
    sourceName?: string;
    deviceLabel?: string;
    devicePath?: string | null;
    audioDeviceLabel?: string | null;
    captureMode: 'monitor-dxgi' | 'window-wgc' | 'device-dshow';
    monitorIndex?: number;
    fps: number;
    width?: number;
    height: number;
    bitrate: number;
    // Quality preset drives the native encoder rate-control: 'quality' = capped
    // VBR (lets complex scenes burst), everything else = CBR (steady rate).
    preset?: 'quality' | 'efficiency' | 'compressed' | 'catrealm';
    // H.264 profile for the native encoder ('high' = best quality-per-bit).
    h264Profile?: 'high' | 'main' | 'baseline' | 'constrained-baseline';
    // GStreamer H.264 encoder element to use (GPU chooser). Omit/undefined = auto
    // (best available). nvh264enc=NVIDIA, amfh264enc=AMD, mfh264enc=Media Foundation.
    videoEncoder?: 'nvh264enc' | 'amfh264enc' | 'mfh264enc' | null;
    includeAudio?: boolean;
    whip: {
      url: string;
      streamKey: string;
    };
  };
  type NativeWhipPublisherStartResult =
    | {
        ok: true;
        publisherId: string;
        backend?: 'ffmpeg' | 'gstreamer';
        ffmpegPath?: string;
        gstPath?: string;
        argsBuiltMs?: number;
        spawnElapsedMs?: number;
        captureMode: 'monitor-dxgi' | 'window-wgc' | 'device-dshow';
        sourceId: string;
        support?: NativeWhipPublisherSupport;
      }
    | {
        ok: false;
        reason: string;
        message?: string;
        support?: NativeWhipPublisherSupport;
      };
  type NativeWhipPublisherStatus = {
    publisherId: string;
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    at: number;
  };
  type NativeWhipPublisherStopped = {
    publisherId: string;
    code: number | null;
    signal: string | null;
    error?: string;
    at: number;
  };
  interface Window {
    electron?: {
      showDesktopNotification?: (notification: { id: string; sourceKind: 'dm' | 'server'; sourceId: string; subsourceId?: string; title: string; body: string }) => Promise<{ ok: boolean }>;
      dismissDesktopNotifications?: (target: { sourceKind: 'dm' | 'server'; sourceId: string; subsourceId?: string }) => Promise<{ ok: boolean }>;
      onDesktopNotificationClick?: (callback: (target: { id: string; sourceKind: 'dm' | 'server'; sourceId: string; subsourceId?: string }) => void) => () => void;
      getDesktopSources: (opts?: {
        types?: Array<'screen' | 'window'>;
        thumbnailSize?: { width: number; height: number };
        includeWindowThumbnails?: boolean;
      }) => Promise<Array<{ id: string; name: string; thumbnail: string | null; appIcon: string | null }>>;
      getDesktopAudioCaptureSupport: () => Promise<DesktopAudioCaptureSupport>;
      startAppAudioCapture: (opts: { sourceId?: string; processId?: number }) => Promise<
        | { ok: true; captureId: string; sampleRate: number; channels: number }
        | { ok: false; reason: string; message?: string }
      >;
      stopAppAudioCapture: (captureId: string) => Promise<{ ok: true }>;
      getNativeWhipPublisherSupport?: (opts?: { forceRefresh?: boolean }) => Promise<NativeWhipPublisherSupport>;
      listScreenShareGpus?: () => Promise<{ gpus: ScreenShareGpu[]; encoders: string[] }>;
      listVideoCaptureDevices?: () => Promise<NativeVideoCaptureDevice[]>;
      startNativeWhipPublisher?: (opts: NativeWhipPublisherStartOptions) => Promise<NativeWhipPublisherStartResult>;
      stopNativeWhipPublisher?: (publisherId?: string) => Promise<{ ok: true }>;
      // Sushi on Windows: GPU-encoded screen share published straight into the
      // LiveKit room with a realm screen token (no WHIP ingress needed).
      getNativeScreenPublishSupport?: () => Promise<{ ok: boolean; reason?: string; message?: string }>;
      startNativeScreenPublish?: (opts: {
        url: string;
        token: string;
        sourceId: string;
        captureMode: string;
        width: number;
        height: number;
        fps: number;
        bitrate?: number;
        preset?: string;
        h264Profile?: string;
        videoEncoder?: string;
        // Screens/windows: publish desktop or app loopback audio.
        includeAudio?: boolean;
        // Capture cards (captureMode 'device-dshow'): the device and its audio input.
        deviceLabel?: string;
        devicePath?: string;
        audioDeviceLabel?: string;
      }) => Promise<{ ok: boolean; reason?: string; message?: string; trackSid?: string; width?: number; height?: number; fps?: number; audio?: boolean }>;
      stopNativeScreenPublish?: () => Promise<{ ok: boolean; stopped?: boolean }>;
      // Native voice fallback (Linux Sushi; WebKitGTK has no WebRTC).
      getNativeVoiceSupport?: () => Promise<NativeVoiceSupport>;
      nativeVoiceListDevices?: () => Promise<{
        ok: boolean;
        reason?: string;
        message?: string;
        inputs: Array<{ deviceId: string; label: string; kind: 'audioinput' }>;
        outputs: Array<{ deviceId: string; label: string; kind: 'audiooutput' }>;
      }>;
      nativeVoiceSetInputDevice?: (deviceId: string | null) => Promise<{ ok: boolean; reason?: string; message?: string }>;
      nativeVoiceSetOutputDevice?: (deviceId: string | null) => Promise<{ ok: boolean; reason?: string; message?: string }>;
      nativeVoiceMicrophoneTest?: (opts: { durationMs: number; rnnoise: boolean; gate: boolean; gateThresholdDb: number }) => Promise<{
        ok: boolean; reason?: string; message?: string; mimeType?: string; audioBase64?: string;
      }>;
      nativeVoiceMicrophoneLevel?: () => Promise<{ ok: boolean; db?: number; reason?: string; message?: string }>;
      nativeVoiceStartVideo?: (opts: { kind: 'camera' | 'screen'; sourceId: string; width: number; height: number; fps: number }) => Promise<{
        ok: boolean; reason?: string; message?: string; trackSid?: string; width?: number; height?: number; fps?: number;
        codec?: string; encoder?: string;
      }>;
      nativeVoiceStopVideo?: (kind: 'camera' | 'screen') => Promise<{ ok: boolean; reason?: string; message?: string }>;
      nativeVoiceConnect?: (opts: { url: string; token: string; muted: boolean }) => Promise<NativeVoiceConnectResult>;
      nativeVoiceLeave?: () => Promise<{ ok: boolean }>;
      nativeVoiceSetMuted?: (muted: boolean) => Promise<{ ok: boolean; reason?: string }>;
      nativeVoiceSetDeafened?: (deafened: boolean) => Promise<{ ok: boolean; reason?: string }>;
      onNativeVoiceEvent?: (callback: (payload: NativeVoiceEvent) => void) => () => void;
      onAppAudioCaptureData: (callback: (payload: { captureId: string; chunk: ArrayBuffer }) => void) => () => void;
      onAppAudioCaptureStatus?: (callback: (payload: { captureId: string; message: string }) => void) => () => void;
      onAppAudioCaptureStopped: (callback: (payload: { captureId: string; code: number | null; signal: string | null; error?: string }) => void) => () => void;
      onNativeWhipPublisherStatus?: (callback: (payload: NativeWhipPublisherStatus) => void) => () => void;
      onNativeWhipPublisherStopped?: (callback: (payload: NativeWhipPublisherStopped) => void) => () => void;
      onNativeScreenPublishStopped?: (callback: (payload: { reason?: string; detail?: string }) => void) => () => void;
      getAppVersion: () => Promise<{ version: string }>;
      openScreenshareWizard?: () => Promise<{ ok: boolean }>;
      // Relaunch the desktop app (used by the GPU Encoding restart-&-reconnect flow).
      relaunchApp?: () => Promise<{ ok: boolean }>;
      checkForUpdates: () => Promise<AppUpdateActionResult>;
      queueNextUpdateInstall: () => Promise<AppUpdateActionResult>;
      downgradeClient: () => Promise<AppUpdateActionResult>;
      clearAndRetryUpdate?: () => Promise<AppUpdateActionResult>;
      setUpdateChannel: (channel: AppUpdateChannel) => Promise<AppUpdateChannelResult>;
      getUpdateChannel: () => Promise<{ channel: AppUpdateChannel }>;
      getUpdateStatus: () => Promise<AppUpdateStatus>;
      getNextUpdateCheckAt: () => Promise<{ nextCheckAt: number | null }>;
      setVoiceDebugConsoleEnabled: (enabled: boolean) => Promise<{ ok: boolean; enabled: boolean }>;
      voiceDebugLog: (entry: VoiceDebugLogEntry) => Promise<{ ok: boolean }>;
      clientDebugLog?: (entry: VoiceDebugLogEntry) => Promise<{ ok: boolean }>;
      captureTestDebugEnabled?: () => boolean;
      getDebugLogPaths?: () => Promise<{
        voiceDebug: string | null;
        clientDebug: string | null;
        logsDir: string | null;
        crashDumps: string | null;
      }>;
      getAppMetrics?: () => Promise<{
        at: number;
        count: number;
        totalMB: number;
        privateTotalMB?: number;
        rows: Array<{ pid: number; type: string; name: string | null; memMB: number; privateMB?: number; cpu: number }>;
      }>;
      setBackgroundMediaActive?: (active: boolean) => Promise<{ ok: boolean }>;
      getOpenOnStartup: () => Promise<DesktopStartupSettingsResult>;
      setOpenOnStartup: (enabled: boolean) => Promise<DesktopStartupSettingsResult>;
      getMinimizeToTray: () => Promise<DesktopStartupSettingsResult>;
      setMinimizeToTray: (enabled: boolean) => Promise<DesktopStartupSettingsResult>;
      fixScreenshareFirewallRule?: () => Promise<ScreenshareFirewallRuleResult>;
      onScreenshareFirewallRuleStatus?: (callback: (payload: ScreenshareFirewallRuleStatus) => void) => () => void;
      getOpenLinksInApp: () => Promise<{ enabled: boolean }>;
      setOpenLinksInApp: (enabled: boolean) => Promise<{ ok: boolean; enabled: boolean }>;
      getScreenShareVideoEncoding: () => Promise<ScreenShareVideoEncodingConfig>;
      setScreenShareVideoEncoding: (config: {
        hardwareEncoding: boolean;
        encoderBackend: ScreenShareVideoEncoderBackend;
      }) => Promise<ScreenShareVideoEncodingConfig>;
      getGameActivityState: () => Promise<DesktopGameActivityState>;
      setGameActivityEnabled: (enabled: boolean) => Promise<DesktopGameActivityState>;
      invalidateGameActivityCatalog: () => Promise<{ ok: boolean; state?: DesktopGameActivityState }>;
      quitApp: () => Promise<{ ok: boolean }>;
      installUpdate: () => Promise<AppUpdateActionResult>;
      openExternal: (url: string) => Promise<{ ok: boolean; reason?: string; message?: string }>;
      openProtectedLink?: (url: string) => Promise<{ ok: boolean; reason?: string }>;
      onProtectedLinkRequest?: (callback: (url: string) => void) => () => void;
      setAdFrameMounted?: (mounted: boolean) => Promise<{ ok: boolean }>;
      openPasskeyWindow?: (url: string) => Promise<{ ok: boolean; reason?: string; message?: string }>;
      onUpdateStatus: (callback: (status: AppUpdateStatus) => void) => () => void;
      obsOverlaySetEnabled: (enabled: boolean, port: number) => Promise<{ ok: boolean }>;
      obsOverlayUpdateState: (state: unknown) => Promise<{ ok: boolean }>;
      reactiveAvatarSaveImage?: (bytes: Uint8Array, options?: { received?: boolean }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
      reactiveAvatarReadImage?: (id: string) => Promise<{ ok: true; bytes: Uint8Array<ArrayBuffer>; mime: string } | { ok: false }>;
      reactiveAvatarPrune?: (keepIds: string[]) => Promise<{ ok: boolean; removed?: number }>;
      embedLoginOpen: (platform: EmbedLoginPlatform) => Promise<EmbedLoginActionResult>;
      embedLoginStatus: (platform: EmbedLoginPlatform) => Promise<EmbedLoginStatusResult>;
      embedLoginLogout: (platform: EmbedLoginPlatform) => Promise<EmbedLoginActionResult>;
      theaterYouTubeCookieOpen: () => Promise<EmbedLoginActionResult>;
      theaterYouTubeCookieStatus: () => Promise<TheaterYouTubeCookieStatusResult>;
      theaterYouTubeCookieExport: () => Promise<TheaterYouTubeCookieExportResult>;
      theaterYouTubeCookieClear: () => Promise<EmbedLoginActionResult>;
      onGameActivityState: (callback: (state: DesktopGameActivityState) => void) => () => void;
      setWindowFullscreen: (fullscreen: boolean) => Promise<void>;
      getWindowFullscreen: () => Promise<boolean>;
      onWindowFullscreenChanged: (callback: (fullscreen: boolean) => void) => () => void;
    };
  }
}
