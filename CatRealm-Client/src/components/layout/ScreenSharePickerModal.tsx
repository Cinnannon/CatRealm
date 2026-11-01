import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { findBestDeviceAudioInput, getAudioInputDevices, getDesktopAudioCaptureSupport, getDesktopSources, getVideoDevices, isElectronDesktop, type DesktopAudioCaptureSupport, type VideoCaptureDeviceInfo } from '../../lib/desktopCapture';
import { useVoiceStore } from '../../stores/voiceStore';
import { useCallStore } from '../../stores/callStore';
import { useSettingsStore, type ScreenShareDesktopCaptureMode } from '../../stores/settingsStore';
import { useMediaStore } from '../../stores/mediaStore';
import { useGameActivityStore } from '../../stores/gameActivityStore';
import { useScreenshareSettingsSync } from '../../lib/screenshareSettingsSync';
import { ScreenshareSettingsPanel } from './ScreenshareSettingsPanel';
import { ScreenshareWizardModal } from './ScreenshareWizardModal';

type PickerDesktopSource = { id: string; name: string; thumbnail: string | null; appIcon: string | null };

function isScreenSource(source: PickerDesktopSource) {
  return source.id.startsWith('screen:') || source.id.startsWith('display:');
}

function isWindowSource(source: PickerDesktopSource) {
  return source.id.startsWith('window:');
}

function sourceMatchesGame(source: PickerDesktopSource, activity: DesktopGameActivity | null) {
  const haystack = source.name.toLowerCase();
  const title = activity?.activityText?.trim().toLowerCase();
  const processName = activity?.processName?.replace(/\.exe$/i, '').trim().toLowerCase();
  return Boolean((title && haystack.includes(title)) || (processName && haystack.includes(processName)));
}

function isNativeVideoDevice(device: VideoCaptureDeviceInfo) {
  return device.nativeOnly === true || !!device.devicePath || device.deviceId.startsWith('native-video:');
}

export function ScreenSharePickerModal() {
  const { t } = useTranslation();
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData) as { mode?: 'pick' | 'manage' | 'camera'; context?: 'voice' | 'call' } | null;
  const closeModal = useUIStore((s) => s.closeModal);
  const [sources, setSources] = useState<PickerDesktopSource[]>([]);
  const [devices, setDevices] = useState<VideoCaptureDeviceInfo[]>([]);
  const [activeTab, setActiveTab] = useState<'screens' | 'apps' | 'devices'>('screens');
  const [selectedSource, setSelectedSource] = useState<{ kind: 'desktop' | 'device'; id: string; label?: string | null; devicePath?: string | null } | null>(null);
  const [step, setStep] = useState<'select' | 'settings'>('select');
  const [loading, setLoading] = useState(false);
  const [deviceProbeActive, setDeviceProbeActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioSupport, setAudioSupport] = useState<DesktopAudioCaptureSupport | null>(null);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioDeviceId, setSelectedAudioDeviceId] = useState<string | null>(null);
  const startShare = useVoiceStore((s) => s.startShare);
  const stopShare = useVoiceStore((s) => s.stopShare);
  const restartShare = useVoiceStore((s) => s.restartShare);
  const isVoiceSharing = useVoiceStore((s) => s.isSharing);
  const isCallSharing = useCallStore((s) => s.isSharingScreen);
  const startCallShare = useCallStore((s) => s.startScreenShare);
  const stopCallShare = useCallStore((s) => s.toggleScreenShare);
  const startCallCamera = useCallStore((s) => s.startVideo);
  const screenshareFps = useSettingsStore((s) => s.screenshareFps);
  const screenshareResolution = useSettingsStore((s) => s.screenshareResolution);
  const screenshareAudio = useSettingsStore((s) => s.screenshareAudio);
  const setScreenshareFps = useSettingsStore((s) => s.setScreenshareFps);
  const setScreenshareResolution = useSettingsStore((s) => s.setScreenshareResolution);
  const setScreenshareAudio = useSettingsStore((s) => s.setScreenshareAudio);
  const screenShareDesktopCaptureMode = useSettingsStore((s) => s.screenShareDesktopCaptureMode);
  const setScreenShareDesktopCaptureMode = useSettingsStore((s) => s.setScreenShareDesktopCaptureMode);
  const screenShareNativeWhipEnabled = useSettingsStore((s) => s.screenShareNativeWhipEnabled);
  const wizardCompletedAt = useSettingsStore((s) => s.screenshareWizardCompletedAt);
  const gameActivity = useGameActivityStore((s) => s.detectorState.activity);
  const startVoiceCamera = useMediaStore((s) => s.startCamera);
  const [wizardOverlayOpen, setWizardOverlayOpen] = useState(false);
  const cameraMode = modalData?.mode === 'camera';
  const context = modalData?.context === 'call' ? 'call' : 'voice';
  const isSharing = context === 'call' ? isCallSharing : isVoiceSharing;
  const runningOnDesktop = isElectronDesktop();
  const linuxNativeCapture = runningOnDesktop
    && typeof navigator !== 'undefined'
    && /Linux/i.test(navigator.userAgent)
    && typeof window.electron?.nativeVoiceStartVideo === 'function';
  // Starting a NEW screen/device share requires the one-time setup wizard so the
  // share never runs on unvalidated defaults. (Camera and manage-an-active-share
  // are exempt.) Keep in sync with the standalone wizard window.
  useScreenshareSettingsSync();
  const mustRunWizard = !linuxNativeCapture && !cameraMode && modalData?.mode !== 'manage' && wizardCompletedAt === null;
  const openWizard = useCallback(() => {
    if (window.electron?.openScreenshareWizard) {
      window.electron.openScreenshareWizard()
        .then((result) => {
          if (!result?.ok) setWizardOverlayOpen(true);
        })
        .catch(() => setWizardOverlayOpen(true));
      return;
    }
    setWizardOverlayOpen(true);
  }, []);
  const effectiveActiveTab = (!runningOnDesktop || linuxNativeCapture) && activeTab === 'apps' ? 'screens' : activeTab;
  const selectedIsApplicationShare = selectedSource?.kind === 'desktop' && selectedSource.id.startsWith('window:');
  const selectedIsDeviceShare = selectedSource?.kind === 'device';
  const nativeDeviceWhipActive = context === 'voice' && runningOnDesktop && screenShareNativeWhipEnabled && selectedIsDeviceShare;
  const appAudioAvailable = !!audioSupport?.appAudio.available;
  const selectedAppAudioUnavailable = runningOnDesktop && selectedIsApplicationShare && !appAudioAvailable;
  const audioCaptureAvailable = selectedSource?.kind === 'desktop' && (!runningOnDesktop || !selectedIsApplicationShare || appAudioAvailable);
  const audioCaptureDisabled = !audioCaptureAvailable || !screenshareAudio;
  const shouldShowDesktopCaptureSettings = runningOnDesktop && selectedSource?.kind === 'desktop' && selectedSource.id !== 'browser-picker';
  const shouldShowBrowserCaptureSettings = !runningOnDesktop && selectedSource?.kind === 'desktop';
  const screenSources = sources.filter(isScreenSource);
  const windowSources = sources.filter(isWindowSource);
  const recommendedMonitorSource = runningOnDesktop
    && effectiveActiveTab === 'apps'
    && screenShareDesktopCaptureMode !== 'window-wgc'
    && gameActivity
    ? screenSources[0] ?? null
    : null;
  const visibleSources = effectiveActiveTab === 'apps' ? windowSources : screenSources;
  const selectedMatchesGame = selectedSource?.kind === 'desktop'
    && selectedSource.id.startsWith('window:')
    && gameActivity
    && sourceMatchesGame(sources.find((source) => source.id === selectedSource.id) ?? { id: selectedSource.id, name: '', thumbnail: null, appIcon: null }, gameActivity);
  const shouldUseMonitorForSelectedWindow = selectedSource?.kind === 'desktop'
    && selectedSource.id.startsWith('window:')
    && (
      screenShareDesktopCaptureMode === 'monitor-dxgi'
      || (screenShareDesktopCaptureMode === 'auto' && selectedMatchesGame)
    );
  const forcedMonitorSource = shouldUseMonitorForSelectedWindow
    ? screenSources[0] ?? null
    : null;
  // Only Sushi can list native (GStreamer) capture devices. Sparky has no such
  // listing, so filtering to native devices there left the tab empty; it shares
  // its Chromium devices instead.
  const canListNativeDevices = !!window.electron?.listVideoCaptureDevices;
  const usingNativeDevicePicker = !cameraMode && runningOnDesktop && canListNativeDevices && effectiveActiveTab === 'devices';
  const visibleDevices = usingNativeDevicePicker
    ? devices.filter(isNativeVideoDevice)
    : devices;

  useEffect(() => {
    if (activeModal !== 'screenSharePicker') return;
    setSelectedSource(null);
    setStep('select');
    setLoading(true);
    setDeviceProbeActive(false);
    setError(null);
    if (cameraMode) setActiveTab('devices');
    if (runningOnDesktop) {
      void getDesktopAudioCaptureSupport()
        .then(setAudioSupport)
        .catch(() => setAudioSupport(null));
    } else {
      setAudioSupport(null);
    }
    if (cameraMode || effectiveActiveTab === 'devices') {
      if (usingNativeDevicePicker) {
        setDeviceProbeActive(true);
        setDevices([]);
        void getVideoDevices({ native: 'cached' })
          .then((res) => {
            const nativeDevices = res.filter(isNativeVideoDevice);
            if (nativeDevices.length > 0) setDevices(res);
          })
          .catch(() => {});
        getVideoDevices({ native: 'include', timeoutMs: 30_000 })
          .then((res) => setDevices(res))
          .catch(() => setError(t('settingsContent.ssPickerCouldNotListDevices')))
          .finally(() => {
            setDeviceProbeActive(false);
            setLoading(false);
          });
      } else {
        getVideoDevices({ native: runningOnDesktop ? 'include' : 'skip', timeoutMs: 30_000 })
          .then((res) => setDevices(res))
          .catch(() => setError(t('settingsContent.ssPickerCouldNotListDevices')))
          .finally(() => setLoading(false));
      }
      return;
    }
    if (!runningOnDesktop) {
      setSources([]);
      setLoading(false);
      return;
    }
    getDesktopSources({ includeWindowThumbnails: effectiveActiveTab === 'apps' })
      .then((res) => setSources(res))
      .catch(() => setError(t('settingsContent.ssPickerCouldNotListScreens')))
      .finally(() => setLoading(false));
  }, [activeModal, effectiveActiveTab, cameraMode, runningOnDesktop, t]);

  if (activeModal !== 'screenSharePicker') return null;

  const wizardOverlay = wizardOverlayOpen
    ? <ScreenshareWizardModal onClose={() => setWizardOverlayOpen(false)} />
    : null;

  if (mustRunWizard) {
    return (
      <>
        <Modal open={activeModal === 'screenSharePicker'} onClose={closeModal} title={t('settingsContent.ssPickerChooseScreen')}>
          <div className="space-y-3">
            <div className="rounded border border-border bg-bg-input/50 p-4 space-y-3 text-center">
              <p className="text-sm font-medium text-text-primary">{t('settingsContent.ssGateTitle')}</p>
              <p className="text-[11px] text-text-muted">{t('settingsContent.ssGateBody')}</p>
              <button
                type="button"
                onClick={openWizard}
                className="w-full px-3 py-2 rounded text-xs font-medium bg-accent text-white"
              >
                {t('settingsContent.ssWizardGuide')}
              </button>
            </div>
          </div>
        </Modal>
        {wizardOverlay}
      </>
    );
  }

  return (
    <>
    <Modal open={activeModal === 'screenSharePicker'} onClose={closeModal} title={cameraMode ? t('settingsContent.ssPickerChooseCamera') : t('settingsContent.ssPickerChooseScreen')}>
      <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
        {modalData?.mode === 'manage' && isSharing && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                className="px-3 py-1.5 rounded-full text-xs bg-danger text-white"
                onClick={() => {
                  if (context === 'call') {
                    void stopCallShare();
                  } else {
                    stopShare();
                  }
                  closeModal();
                }}
              >
                {t('settingsContent.ssPickerStopSharing')}
              </button>
              {context === 'voice' && (
                <button
                  className="px-3 py-1.5 rounded-full text-xs bg-accent text-white"
                  title={t('settingsContent.ssPickerRestreamTitle')}
                  onClick={async () => {
                    closeModal();
                    await restartShare();
                  }}
                >
                  {t('settingsContent.ssPickerRestream')}
                </button>
              )}
              <span className="text-xs text-text-muted">{t('settingsContent.ssPickerChooseAnotherSource')}</span>
            </div>

            <ScreenshareSettingsPanel />
          </div>
        )}
        {!cameraMode && (
          <div className="flex items-center gap-2">
            <button
              className={`px-3 py-1.5 rounded-full text-xs ${effectiveActiveTab === 'screens' ? 'bg-bg-hover text-text-primary' : 'text-text-muted'}`}
              onClick={() => setActiveTab('screens')}
            >
              {t('settingsContent.ssPickerScreens')}
            </button>
            {runningOnDesktop && !linuxNativeCapture && (
              <button
                className={`px-3 py-1.5 rounded-full text-xs ${effectiveActiveTab === 'apps' ? 'bg-bg-hover text-text-primary' : 'text-text-muted'}`}
                onClick={() => setActiveTab('apps')}
              >
                {t('settingsContent.ssPickerApplications')}
              </button>
            )}
            <button
              className={`px-3 py-1.5 rounded-full text-xs ${effectiveActiveTab === 'devices' ? 'bg-bg-hover text-text-primary' : 'text-text-muted'}`}
              onClick={() => setActiveTab('devices')}
            >
              {t('settingsContent.ssPickerDevices')}
            </button>
          </div>
        )}
        {loading && <p className="text-xs text-text-muted">{t('settingsContent.ssPickerLoadingSources')}</p>}
        {error && <p className="text-xs text-danger">{error}</p>}
        {step === 'select' && (
          <>
            {cameraMode || activeTab === 'devices' ? (
              <div className="grid grid-cols-2 gap-3">
                {deviceProbeActive && visibleDevices.length === 0 && (
                  <div className="col-span-2 border border-border rounded-lg bg-bg-input/60 p-3">
                    <div className="text-xs text-text-primary">{t('settingsContent.ssPickerProbingDevices')}</div>
                    <div className="text-[11px] text-text-muted">{t('settingsContent.ssPickerNativeDeviceProbeHint')}</div>
                  </div>
                )}
                {!deviceProbeActive && visibleDevices.length === 0 && (
                  <div className="col-span-2 border border-border rounded-lg bg-bg-input/60 p-3 text-xs text-text-muted">
                    {t('settingsContent.ssPickerNoDevicesFound')}
                  </div>
                )}
                {visibleDevices.map((d) => (
                  <button
                    key={d.deviceId}
                    className="border border-border rounded-lg bg-bg-input hover:border-accent transition-colors text-left p-3"
                    onClick={() => {
                      setSelectedSource({ kind: 'device', id: d.deviceId, label: d.label || null, devicePath: d.devicePath ?? null });
                      setAudioDevices([]);
                      setSelectedAudioDeviceId(null);
                      setStep('settings');
                      window.setTimeout(() => {
                        void getAudioInputDevices().catch(() => [])
                          .then(async (inputs) => {
                            const auto = await findBestDeviceAudioInput(d, inputs).catch(() => null);
                            setAudioDevices(inputs);
                            setSelectedAudioDeviceId(auto?.deviceId ?? null);
                          });
                      }, 0);
                    }}
                  >
                    <div className="text-xs text-text-primary truncate">{d.label || t('settingsContent.ssPickerDeviceFallback', { id: d.deviceId.slice(0, 6) })}</div>
                    <div className="text-[11px] text-text-muted">{t('settingsContent.ssPickerVideoDevice')}</div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {!runningOnDesktop && (
                  <button
                    key="browser-picker"
                    className="border border-border rounded-lg overflow-hidden bg-bg-input hover:border-accent transition-colors text-left"
                    onClick={() => {
                      setSelectedSource({ kind: 'desktop', id: 'browser-picker' });
                      setStep('settings');
                    }}
                  >
                    <div className="w-full aspect-video bg-black/30 flex items-center justify-center text-xs text-text-muted">
                      {t('settingsContent.ssPickerBrowserSharePicker')}
                    </div>
                    <div className="p-2 flex items-center gap-2">
                      <span className="text-xs text-text-primary truncate">
                        {t('settingsContent.ssPickerBrowserPrompt')}
                      </span>
                    </div>
                  </button>
                )}
                {recommendedMonitorSource && (
                  <button
                    key={`recommended-${recommendedMonitorSource.id}`}
                    className="border border-emerald-400/70 rounded-lg overflow-hidden bg-emerald-500/10 hover:border-emerald-300 transition-colors text-left"
                    onClick={() => {
                      setSelectedSource({ kind: 'desktop', id: recommendedMonitorSource.id });
                      setStep('settings');
                    }}
                  >
                    <div className="w-full aspect-video bg-black/30 flex items-center justify-center">
                      {recommendedMonitorSource.thumbnail ? (
                        <img src={recommendedMonitorSource.thumbnail} alt={recommendedMonitorSource.name} className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-3xl select-none">ðŸ–¥ï¸</span>
                      )}
                    </div>
                    <div className="p-2 space-y-1">
                      <div className="text-[10px] uppercase text-emerald-300">{t('settingsContent.ssPickerRecommendedMonitor')}</div>
                      <div className="text-xs text-text-primary truncate">{recommendedMonitorSource.name}</div>
                      <div className="text-[11px] text-text-muted truncate">
                        {gameActivity?.activityText
                          ? t('settingsContent.ssPickerGameViaMonitor', { activity: gameActivity.activityText })
                          : t('settingsContent.ssPickerMonitorCapture')}
                      </div>
                    </div>
                  </button>
                )}
                {visibleSources.map((s) => {
                  const isScreen = isScreenSource(s);
                  const isGameWindow = !isScreen && sourceMatchesGame(s, gameActivity);
                  return (
                    <button
                      key={s.id}
                      className="border border-border rounded-lg overflow-hidden bg-bg-input hover:border-accent transition-colors text-left"
                      onClick={() => {
                        setSelectedSource({ kind: 'desktop', id: s.id });
                        setStep('settings');
                      }}
                    >
                      <div className="w-full aspect-video bg-black/30 flex items-center justify-center">
                        {s.thumbnail ? (
                          <img src={s.thumbnail} alt={s.name} className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-3xl select-none">{isScreen ? '🖥️' : '🪟'}</span>
                        )}
                      </div>
                      <div className="p-2 flex items-center gap-2">
                        <span className="text-xs text-text-primary truncate">{s.name}</span>
                        {isGameWindow && screenShareDesktopCaptureMode !== 'window-wgc' && (
                          <span className="ml-auto shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                            WGC
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
        {/* Screenshare settings (wizard-gated) are visible BEFORE streaming —
            not just in the manage modal of an active share. */}
        {step === 'select' && !cameraMode && context === 'voice' && modalData?.mode !== 'manage' && (
          <ScreenshareSettingsPanel />
        )}
        {step === 'settings' && selectedSource && (
          <div className="space-y-3">
            <div className="rounded border border-border bg-bg-input p-3 space-y-2">
              <p className="text-xs text-text-primary">
                {cameraMode
                  ? t('settingsContent.ssPickerCameraSettings')
                  : context === 'voice'
                    ? t('settingsContent.ssPickerSourceSettings')
                    : t('settingsContent.screenshareSettings')}
              </p>
              {!cameraMode && context === 'call' && (
                <div className="flex items-center justify-between">
                <label className="text-[11px] text-text-muted">{t('settingsContent.ssFrameRate')}</label>
                <select
                  value={screenshareFps}
                  onChange={(e) => setScreenshareFps(Number(e.target.value) as 24 | 48 | 60)}
                  className="bg-bg-input border border-border rounded px-2 py-1 text-xs text-text-primary"
                >
                  <option value={24}>24 fps</option>
                  <option value={48}>48 fps</option>
                  <option value={60}>60 fps</option>
                </select>
                </div>
              )}
              {!cameraMode && context === 'call' && (
                <div className="flex items-center justify-between">
                <label className="text-[11px] text-text-muted">{t('settingsContent.ssResolution')}</label>
                <select
                  value={screenshareResolution}
                  onChange={(e) => setScreenshareResolution(Number(e.target.value) as 720 | 1080 | 1440)}
                  className="bg-bg-input border border-border rounded px-2 py-1 text-xs text-text-primary"
                >
                  <option value={720}>720p</option>
                  <option value={1080}>1080p</option>
                  <option value={1440}>1440p</option>
                </select>
                </div>
              )}
              {!cameraMode && selectedSource.kind === 'device' && (
                <div className="flex items-start justify-between gap-2">
                  <label className="text-[11px] text-text-muted mt-1.5">{t('settingsContent.ssPickerAudioInput')}</label>
                  <div className="flex flex-col items-end gap-1">
                    <select
                      value={selectedAudioDeviceId ?? ''}
                      onChange={(e) => setSelectedAudioDeviceId(e.target.value || null)}
                      className="bg-bg-input border border-border rounded px-2 py-1 text-xs text-text-primary max-w-[200px]"
                    >
                      <option value="">{t('settingsContent.ssPickerNoAudio')}</option>
                      {audioDevices.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label || t('settingsContent.ssPickerInputFallback', { id: d.deviceId.slice(0, 6) })}
                        </option>
                      ))}
                    </select>
                    {selectedAudioDeviceId && (
                      <p className="text-[11px] text-emerald-300">
                        {t('settingsContent.ssPickerDeviceAudioCaptured')}
                      </p>
                    )}
                    {!selectedAudioDeviceId && nativeDeviceWhipActive && (
                      <p className="text-[11px] text-text-muted">{t('settingsContent.ssPickerNativeDeviceVideoOnly')}</p>
                    )}
                  </div>
                </div>
              )}
              {!cameraMode && shouldShowBrowserCaptureSettings && (
                <p className="text-[11px] text-text-muted">
                  {t('settingsContent.ssPickerBrowserCaptureNote')}
                </p>
              )}
              {!cameraMode && selectedSource.kind === 'desktop' && (
                <div className="space-y-1">
                  {shouldShowDesktopCaptureSettings && (
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11px] text-text-muted">{t('settingsContent.ssPickerDesktopCapture')}</label>
                      <select
                        value={screenShareDesktopCaptureMode}
                        onChange={(e) => setScreenShareDesktopCaptureMode(e.target.value as ScreenShareDesktopCaptureMode)}
                        className="bg-bg-input border border-border rounded px-2 py-1 text-xs text-text-primary"
                      >
                        <option value="auto">{t('settingsContent.ssPickerAuto')}</option>
                        <option value="monitor-dxgi">{t('settingsContent.ssPickerMonitorDxgi')}</option>
                        <option value="window-wgc">{t('settingsContent.ssPickerWindowWgc')}</option>
                      </select>
                    </div>
                  )}
                  {shouldShowDesktopCaptureSettings && selectedMatchesGame && screenShareDesktopCaptureMode !== 'window-wgc' && (
                    <p className="text-[11px] text-amber-300">
                      {t('settingsContent.ssPickerGameMonitorAutoNote')}
                    </p>
                  )}
                  {shouldShowDesktopCaptureSettings && forcedMonitorSource && (
                    <p className="text-[11px] text-emerald-300">
                      {t('settingsContent.ssPickerForcedMonitorNote', {
                        mode: screenShareDesktopCaptureMode === 'auto'
                          ? t('settingsContent.ssPickerAuto')
                          : t('settingsContent.ssPickerMonitorDxgi'),
                        source: forcedMonitorSource.name,
                      })}
                    </p>
                  )}
                  <label className="flex items-center gap-2 text-[11px] text-text-muted">
                    <input
                      type="checkbox"
                      checked={audioCaptureDisabled}
                      disabled={!audioCaptureAvailable}
                      onChange={(e) => setScreenshareAudio(!e.target.checked)}
                    />
                    {t('settingsContent.ssPickerDisableAudioCapture')}
                  </label>
                  {audioCaptureAvailable && screenshareAudio && (
                    <p className="text-[11px] text-emerald-300">
                      {selectedIsApplicationShare
                        ? t('settingsContent.ssPickerAppAudioCaptured')
                        : t('settingsContent.ssPickerSystemAudioCaptured')}
                    </p>
                  )}
                  {audioCaptureAvailable && !screenshareAudio && (
                    <p className="text-[11px] text-text-muted">
                      {t('settingsContent.ssPickerShareNoAudio')}
                    </p>
                  )}
                  {selectedAppAudioUnavailable && (
                    <p className="text-[11px] text-amber-300">
                      {t('settingsContent.ssPickerAppAudioUnavailable')}
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between">
              <button
                className="px-3 py-1.5 rounded-full text-xs bg-bg-hover text-text-primary"
                onClick={() => { setStep('select'); setAudioDevices([]); setSelectedAudioDeviceId(null); }}
              >
                {t('common.back')}
              </button>
              <button
                className="px-4 py-2 rounded-full text-xs bg-success text-white"
                onClick={async () => {
                  if (cameraMode) {
                    if (selectedSource.kind === 'device') {
                      if (context === 'call') {
                        await startCallCamera(selectedSource.id);
                      } else {
                        await startVoiceCamera(selectedSource.id);
                      }
                    }
                    closeModal();
                    return;
                  }
                  if (context === 'call') {
                    if (isSharing) stopCallShare();
                    if (selectedSource.kind === 'device') {
                      await startCallShare({ kind: 'device', deviceId: selectedSource.id, audioDeviceId: selectedAudioDeviceId });
                    } else if (runningOnDesktop && selectedSource.id !== 'browser-picker') {
                      await startCallShare({ kind: 'desktop', sourceId: forcedMonitorSource?.id ?? selectedSource.id });
                    } else {
                      await startCallShare();
                    }
                    closeModal();
                    return;
                  }

                  if (selectedSource.kind === 'device') {
                    const selectedAudioLabel = selectedAudioDeviceId
                      ? audioDevices.find((device) => device.deviceId === selectedAudioDeviceId)?.label ?? null
                      : null;
                    await startShare({
                      kind: 'device',
                      deviceId: selectedSource.id,
                      deviceLabel: selectedSource.label ?? null,
                      devicePath: selectedSource.devicePath ?? null,
                      audioDeviceId: selectedAudioDeviceId,
                      audioDeviceLabel: selectedAudioLabel,
                    });
                  } else if (runningOnDesktop && selectedSource.id !== 'browser-picker') {
                    await startShare({ kind: 'desktop', sourceId: forcedMonitorSource?.id ?? selectedSource.id });
                  } else {
                    await startShare();
                  }
                  closeModal();
                }}
              >
                {cameraMode ? t('settingsContent.ssPickerTurnCameraOn') : t('settingsContent.ssPickerLetsGo')}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
    {wizardOverlay}
    </>
  );
}
