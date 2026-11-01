// Recreates the `window.electron` API surface from
// CatRealm-Client/electron/preload.cjs on top of Tauri IPC, so the 32 renderer
// files that consume it run unchanged. Injected as an initialization script
// before any page code runs (requires app.withGlobalTauri in tauri.conf.json).
(function () {
  'use strict';
  if (window.top !== window || window.electron) return;

  const invoke = (cmd, args, options) => window.__TAURI__.core.invoke(cmd, args, options);
  // Windows shows native toasts (app identity, avatar, click-to-open) from
  // Rust; elsewhere the command answers { fallback: true } and the WebView
  // Notification API is used instead.
  const showDesktopNotification = async (payload) => {
    if (!payload?.id) return { ok: false };
    const native = await invoke('desktop_notification_show', { payload }).catch(() => ({ fallback: true }));
    if (!native?.fallback) return native;
    if (!window.Notification) return { ok: false };
    const granted = window.Notification.permission === 'granted'
      || (await window.Notification.requestPermission()) === 'granted';
    if (!granted) return { ok: false };
    new window.Notification(String(payload.title).slice(0, 120), {
      body: String(payload.body).slice(0, 300),
      silent: true,
      ...(typeof payload.iconUrl === 'string' && /^https?:\/\//i.test(payload.iconUrl) ? { icon: payload.iconUrl } : {}),
    });
    return { ok: true };
  };

  const dismissDesktopNotifications = async (target) => invoke('desktop_notification_dismiss', { target })
    .catch(() => ({ ok: false }));

  // Preload listeners return an unsubscribe function; Tauri's listen() returns
  // a Promise of one, so the unsubscribe defers until registration resolves.
  const makeListener = (event, mapPayload) => (callback) => {
    if (typeof callback !== 'function') return () => {};
    const unlisten = window.__TAURI__.event.listen(event, (e) => callback(mapPayload ? mapPayload(e.payload) : e.payload));
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  };

  const base64ToArrayBuffer = (encoded) => {
    const binary = atob(String(encoded || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  };

  const normalizeAppAudioData = (payload) => {
    if (!payload || typeof payload !== 'object') return payload;
    if (payload.chunkBase64 && !payload.chunk) {
      return { ...payload, chunk: base64ToArrayBuffer(payload.chunkBase64) };
    }
    return payload;
  };

  window.electron = {
    showDesktopNotification,
    dismissDesktopNotifications,
    onDesktopNotificationClick: makeListener('desktop-notification-click'),
    getDesktopSources: (opts) => invoke('desktop_sources', { opts: opts ?? null }),
    getDesktopAudioCaptureSupport: () => invoke('desktop_audio_capture_support'),
    startAppAudioCapture: (opts) => invoke('app_audio_capture_start', { opts: opts ?? null }),
    stopAppAudioCapture: (captureId) => invoke('app_audio_capture_stop', { captureId: captureId ?? null }),
    getNativeWhipPublisherSupport: (opts) => invoke('native_whip_publisher_support', { opts: opts ?? null }),
    listScreenShareGpus: () => invoke('list_screenshare_gpus'),
    listVideoCaptureDevices: () => invoke('list_video_capture_devices'),
    startNativeWhipPublisher: (opts) => invoke('native_whip_publisher_start', { opts: opts ?? null }),
    stopNativeWhipPublisher: (publisherId) => invoke('native_whip_publisher_stop', { publisherId: publisherId ?? null }),
    // Sushi-only: publish GPU-encoded screen share straight into the LiveKit
    // room when the realm has no WHIP ingress (e.g. Central fallback).
    getNativeScreenPublishSupport: () => invoke('native_screen_publish_support'),
    startNativeScreenPublish: (opts) => invoke('native_screen_publish_start', { opts: opts ?? null }),
    stopNativeScreenPublish: () => invoke('native_screen_publish_stop'),
    // Native voice fallback for webviews without WebRTC (Linux WebKitGTK):
    // the renderer fetches the LiveKit token, then the Rust process runs the
    // room via the LiveKit Rust SDK and mirrors state over native-voice-event.
    getNativeVoiceSupport: () => invoke('native_voice_supported'),
    nativeVoiceListDevices: () => invoke('native_voice_list_devices'),
    nativeVoiceSetInputDevice: (deviceId) => invoke('native_voice_set_input_device', { deviceId: deviceId || null }),
    nativeVoiceSetOutputDevice: (deviceId) => invoke('native_voice_set_output_device', { deviceId: deviceId || null }),
    nativeVoiceMicrophoneTest: (opts) => invoke('native_voice_microphone_test', {
      durationMs: opts?.durationMs ?? 5000,
      rnnoise: !!opts?.rnnoise,
      gate: !!opts?.gate,
      gateThresholdDb: opts?.gateThresholdDb ?? -50,
    }),
    nativeVoiceMicrophoneLevel: () => invoke('native_voice_microphone_level'),
    nativeVoiceStartVideo: (opts) => invoke('native_voice_start_video', {
      kind: opts?.kind ?? 'camera', sourceId: opts?.sourceId ?? '',
      width: opts?.width ?? 1280, height: opts?.height ?? 720, fps: opts?.fps ?? 30,
    }),
    nativeVoiceStopVideo: (kind) => invoke('native_voice_stop_video', { kind: kind ?? 'camera' }),
    nativeVoiceConnect: (opts) => invoke('native_voice_connect', {
      url: opts?.url ?? '',
      token: opts?.token ?? '',
      muted: !!(opts && opts.muted),
    }),
    nativeVoiceLeave: () => invoke('native_voice_leave'),
    nativeVoiceSetMuted: (muted) => invoke('native_voice_set_muted', { muted: !!muted }),
    nativeVoiceSetDeafened: (deafened) => invoke('native_voice_set_deafened', { deafened: !!deafened }),
    onNativeVoiceEvent: makeListener('native-voice-event'),
    onAppAudioCaptureData: makeListener('app-audio-capture-data', normalizeAppAudioData),
    onAppAudioCaptureStatus: makeListener('app-audio-capture-status'),
    onAppAudioCaptureStopped: makeListener('app-audio-capture-stopped'),
    onNativeWhipPublisherStatus: makeListener('native-whip-publisher-status'),
    onNativeWhipPublisherStopped: makeListener('native-whip-publisher-stopped'),
    onNativeScreenPublishStopped: makeListener('native-screen-publish-stopped'),
    getAppVersion: () => invoke('get_app_version'),
    openScreenshareWizard: () => invoke('open_screenshare_wizard'),
    relaunchApp: () => invoke('app_relaunch'),
    checkForUpdates: () => invoke('check_for_updates'),
    queueNextUpdateInstall: () => invoke('queue_next_update_install'),
    downgradeClient: () => invoke('downgrade_client'),
    clearAndRetryUpdate: () => invoke('clear_and_retry_update'),
    setUpdateChannel: (channel) => invoke('set_update_channel', { channel }),
    getUpdateChannel: () => invoke('get_update_channel'),
    getUpdateStatus: () => invoke('get_update_status'),
    getNextUpdateCheckAt: () => invoke('get_next_update_check_at'),
    setVoiceDebugConsoleEnabled: (enabled) => invoke('set_voice_debug_console_enabled', { enabled: !!enabled }),
    voiceDebugLog: (entry) => invoke('voice_debug_log', { entry: entry ?? null }),
    clientDebugLog: (entry) => invoke('client_debug_log', { entry: entry ?? null }),
    captureTestDebugEnabled: () => true,
    getDebugLogPaths: () => invoke('get_debug_log_paths'),
    getAppMetrics: () => invoke('get_app_metrics'),
    setBackgroundMediaActive: (active) => invoke('set_background_media_active', { active: !!active }),
    getOpenOnStartup: () => invoke('get_open_on_startup'),
    setOpenOnStartup: (enabled) => invoke('set_open_on_startup', { enabled: !!enabled }),
    getMinimizeToTray: () => invoke('get_minimize_to_tray'),
    setMinimizeToTray: (enabled) => invoke('set_minimize_to_tray', { enabled: !!enabled }),
    fixScreenshareFirewallRule: () => invoke('fix_screenshare_firewall_rule'),
    onScreenshareFirewallRuleStatus: makeListener('screenshare-firewall-rule-status'),
    getOpenLinksInApp: () => invoke('get_open_links_in_app'),
    setOpenLinksInApp: (enabled) => invoke('set_open_links_in_app', { enabled: !!enabled }),
    getScreenShareVideoEncoding: () => invoke('get_screen_share_video_encoding'),
    setScreenShareVideoEncoding: (config) => invoke('set_screen_share_video_encoding', { config: config ?? null }),
    getGameActivityState: () => invoke('get_game_activity_state'),
    setGameActivityEnabled: (enabled) => invoke('set_game_activity_enabled', { enabled: !!enabled }),
    invalidateGameActivityCatalog: () => invoke('invalidate_game_activity_catalog'),
    quitApp: () => invoke('quit_app'),
    installUpdate: () => invoke('install_update'),
    openExternal: (url) => invoke('open_external_url', { url }),
    openProtectedLink: (url) => invoke('open_protected_link', { url }),
    onProtectedLinkRequest: makeListener('protected-link-request'),
    setAdFrameMounted: (mounted) => invoke('set_ad_frame_mounted', { mounted: mounted === true }),
    openPasskeyWindow: (url) => invoke('open_passkey_window', { url }),
    onUpdateStatus: makeListener('app-update-status'),
    obsOverlaySetEnabled: (enabled, port) => invoke('obs_overlay_set_enabled', { enabled: !!enabled, port: port ?? null }),
    obsOverlayUpdateState: (state) => invoke('obs_overlay_update_state', { overlayState: state ?? null }),
    reactiveAvatarSaveImage: (bytes, options) => invoke(
      'reactive_avatar_save_image',
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []),
      { headers: { 'x-catrealm-received': options?.received === true ? '1' : '0' } },
    ),
    reactiveAvatarReadImage: async (id) => {
      try {
        const raw = await invoke('reactive_avatar_read_image', { id });
        const bytes = raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : raw instanceof Uint8Array
            ? raw
            : new Uint8Array(raw || []);
        const extension = String(id || '').split('.').pop();
        const mime = extension === 'webm' ? 'video/webm' : `image/${extension}`;
        return { ok: true, bytes, mime };
      } catch {
        return { ok: false };
      }
    },
    reactiveAvatarPrune: (keepIds) => invoke('reactive_avatar_prune', { keepIds: keepIds ?? [] }),
    embedLoginOpen: (platform) => invoke('embed_login_open', { platform }),
    embedLoginStatus: (platform) => invoke('embed_login_status', { platform }),
    embedLoginLogout: (platform) => invoke('embed_login_logout', { platform }),
    theaterYouTubeCookieOpen: () => invoke('theater_youtube_cookie_open'),
    theaterYouTubeCookieStatus: () => invoke('theater_youtube_cookie_status'),
    theaterYouTubeCookieExport: () => invoke('theater_youtube_cookie_export'),
    theaterYouTubeCookieClear: () => invoke('theater_youtube_cookie_clear'),
    onGameActivityState: makeListener('game-activity-state'),
    setWindowFullscreen: (fullscreen) => invoke('set_window_fullscreen', { fullscreen: !!fullscreen }),
    getWindowFullscreen: () => invoke('get_window_fullscreen'),
    onWindowFullscreenChanged: makeListener('window-fullscreen-changed'),
  };
})();
