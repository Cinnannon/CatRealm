mod app_security;
mod capture;
mod commands;
mod native_voice;
mod screen_publish;
mod obs_overlay;
mod settings;
mod webview_lifecycle;
mod webview_permissions;
#[cfg(target_os = "windows")]
mod windows_process;

use settings::Settings;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::menu::MenuBuilder;
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[cfg(target_os = "linux")]
fn set_linux_taskbar_icon(window: &tauri::WebviewWindow, icon: &tauri::image::Image<'_>) {
    use gtk::prelude::WidgetExt;

    let Ok(gtk_window) = window.gtk_window() else {
        return;
    };
    let Some(gdk_window) = gtk_window.window() else {
        return;
    };

    // GTK 3 only sets the legacy WM_HINTS pixmap for a window icon. Cinnamon
    // and several other Linux taskbars prefer the EWMH _NET_WM_ICON property,
    // so publish a compact ARGB copy as well. Limit it to 128px to avoid
    // placing the full 1024px bundle image on every X11 window.
    let source_width = icon.width() as usize;
    let source_height = icon.height() as usize;
    if source_width == 0 || source_height == 0 {
        return;
    }

    let target_width = source_width.min(128);
    let target_height = source_height.min(128);
    let rgba = icon.rgba();
    let mut argb = Vec::with_capacity(2 + target_width * target_height);
    argb.push(target_width as _);
    argb.push(target_height as _);
    for y in 0..target_height {
        let source_y = y * source_height / target_height;
        for x in 0..target_width {
            let source_x = x * source_width / target_width;
            let offset = (source_y * source_width + source_x) * 4;
            if let Some(pixel) = rgba.get(offset..offset + 4) {
                let value = ((pixel[3] as u32) << 24)
                    | ((pixel[0] as u32) << 16)
                    | ((pixel[1] as u32) << 8)
                    | pixel[2] as u32;
                argb.push(value as _);
            }
        }
    }

    let property = gdk::Atom::intern("_NET_WM_ICON");
    let cardinal = gdk::Atom::intern("CARDINAL");
    gdk::property_change(
        &gdk_window,
        &property,
        &cardinal,
        32,
        gdk::PropMode::Replace,
        gdk::ChangeData::ULongs(&argb),
    );
}

/// Injected into every page before load; recreates the `window.electron`
/// surface from CatRealm-Client/electron/preload.cjs on top of Tauri IPC.
const ELECTRON_SHIM: &str = include_str!("../injected/electron-shim.js");

pub(crate) struct AppState {
    pub(crate) settings: Mutex<Settings>,
    pub(crate) settings_path: PathBuf,
    pub(crate) game_activity: commands::game_activity::GameActivityService,
    pub(crate) app_audio: capture::AppAudioCaptureService,
    pub(crate) native_whip: capture::NativeWhipPublisherService,
    pub(crate) overlay: obs_overlay::OverlayServer,
    pub(crate) native_voice: native_voice::NativeVoiceService,
    pub(crate) screen_publish: screen_publish::ScreenPublishService,
    pub(crate) updater: commands::updates::UpdaterService,
    pub(crate) reactive_avatar_gate: Mutex<()>,
    pub(crate) background_media_active: AtomicBool,
    pub(crate) ad_frame_count: AtomicUsize,
}

impl AppState {
    pub(crate) fn save(&self) {
        self.settings.lock().unwrap().save(&self.settings_path);
    }
}

pub(crate) fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

/// PowerShell invocations must set CREATE_NO_WINDOW, or a console window
/// flashes on screen for every call — very visible during periodic polls
/// like game activity.
#[allow(dead_code)]
pub(crate) fn hidden_powershell() -> std::process::Command {
    #[allow(unused_mut)]
    let mut command = std::process::Command::new("powershell");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

/// Tauri's AppImage media bundle prefers GStreamer's direct PipeWire plugin.
/// That plugin loads the host libpipewire into the bundled WebKit process and
/// crashes on newer Ubuntu/PipeWire combinations. PipeWire's PulseAudio server
/// is ABI-stable across the AppImage boundary, so prefer the Pulse elements for
/// both ordinary playback and microphone capture.
#[cfg(target_os = "linux")]
fn configure_linux_media_backend() {
    const SAFE_RANKS: &str =
        "pipewiresink:NONE,pipewiresrc:NONE,pulsesink:MAX,pulsesrc:MAX";
    let ranks = std::env::var("GST_PLUGIN_FEATURE_RANK")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!("{value},{SAFE_RANKS}"))
        .unwrap_or_else(|| SAFE_RANKS.to_string());
    std::env::set_var("GST_PLUGIN_FEATURE_RANK", ranks);
}

/// WebKitGTK 2.40+ defaults to a DMABUF/GBM-based GPU renderer. On the NVIDIA
/// proprietary driver under X11 that path frequently fails to engage the GPU and
/// WebKit silently falls back to software (CPU) compositing — the whole React UI
/// is then painted on one CPU thread, which reads as "the GPU isn't being used"
/// and shows up as lag (most visibly in Settings). Forcing the DMABUF renderer
/// off drops WebKit onto the legacy GLX accelerated-compositing path, which uses
/// the NVIDIA GPU reliably on X11.
///
/// There is no D3D11 on Linux; this legacy GL compositing path is the closest
/// equivalent to the Windows WebView2/D3D11 backend.
///
/// The backend is selectable via the persisted `webview_render_backend` setting;
/// an explicit `WEBKIT_*` env var set by the user always wins over the setting.
#[cfg(target_os = "linux")]
fn configure_linux_webview_gpu(settings: &Settings) {
    fn nvidia_proprietary_loaded() -> bool {
        std::path::Path::new("/proc/driver/nvidia/version").exists()
    }

    let dmabuf_overridden = std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some();
    let compositing_overridden = std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_some();

    let disable_dmabuf = |on: bool| {
        if !dmabuf_overridden {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", if on { "1" } else { "0" });
        }
    };

    match settings.webview_render_backend.trim() {
        // Force the modern DMABUF renderer on (default WebKit behaviour).
        "gpu-dmabuf" => disable_dmabuf(false),
        // Always use the legacy GLX accelerated-compositing path.
        "gpu-legacy" => disable_dmabuf(true),
        // Last-resort debugging: force software compositing.
        "software" => {
            if !compositing_overridden {
                std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
            }
        }
        // "auto" (and anything unrecognised): apply the NVIDIA-safe legacy path
        // only when the proprietary NVIDIA driver is actually loaded, so Intel/
        // AMD/Nouveau users keep WebKit's default DMABUF renderer.
        _ => {
            if nvidia_proprietary_loaded() {
                disable_dmabuf(true);
            }
        }
    }
}

pub fn run() {
    #[cfg(target_os = "linux")]
    configure_linux_media_backend();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                webview_lifecycle::resume(&window);
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            commands::diagnostics::init_client_debug_log(app.handle());
            let settings_path = app.path().app_config_dir()?.join("desktop-settings.json");
            let settings = Settings::load(&settings_path);

            // Apply the Linux webview GPU backend before the webview (and its web
            // process) is created below, so WebKit reads the env at spawn time.
            #[cfg(target_os = "linux")]
            configure_linux_webview_gpu(&settings);

            app.manage(AppState {
                settings: Mutex::new(settings),
                settings_path,
                game_activity: commands::game_activity::GameActivityService::new(),
                app_audio: capture::AppAudioCaptureService::default(),
                native_whip: capture::NativeWhipPublisherService::default(),
                overlay: obs_overlay::OverlayServer::default(),
                native_voice: native_voice::NativeVoiceService::default(),
                screen_publish: screen_publish::ScreenPublishService::default(),
                updater: commands::updates::UpdaterService::new(),
                reactive_avatar_gate: Mutex::new(()),
                background_media_active: AtomicBool::new(false),
                ad_frame_count: AtomicUsize::new(0),
            });

            // Background updater: initial check shortly after launch, then
            // periodic checks (Windows-only; a no-op elsewhere).
            commands::updates::start_periodic_updater(app.handle().clone());
            commands::notifications::register_app_identity(app.handle());

            let window_icon = app.default_window_icon().unwrap().clone();
            let popup_app = app.handle().clone();
            let main_window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("CatRealm")
                .icon(window_icon.clone())?
                .inner_size(1280.0, 800.0)
                .min_inner_size(940.0, 560.0)
                .initialization_script(ELECTRON_SHIM)
                // Tauri's native file-drop handler consumes drag events on
                // Windows. Disable it so the renderer's HTML5 drag-and-drop
                // interactions (channel/category reordering, pins, etc.) work.
                .disable_drag_drop_handler()
                .on_navigation(crate::app_security::is_navigation_url)
                .on_new_window(move |url, _| {
                    commands::app::handle_new_window_request(&popup_app, &url);
                    tauri::webview::NewWindowResponse::Deny
                })
                .on_page_load(|window, _| {
                    commands::app::reset_ad_frame_guard(window.app_handle());
                })
                .build()?;
            app_security::install_main_document_guard(&main_window)?;
            #[cfg(target_os = "linux")]
            set_linux_taskbar_icon(&main_window, &window_icon);
            webview_permissions::install_media_autogrant(&main_window);

            let menu = MenuBuilder::new(app)
                .text("open", "Open CatRealm")
                .separator()
                .text("quit", "Quit")
                .build()?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("CatRealm")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            webview_lifecycle::resume(&window);
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        capture::stop_all_native_whip_publishers(app);
                        tauri::async_runtime::block_on(app.state::<AppState>().screen_publish.stop());
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let minimize = window
                        .app_handle()
                        .state::<AppState>()
                        .settings
                        .lock()
                        .unwrap()
                        .minimize_to_tray;
                    if minimize {
                        api.prevent_close();
                        let _ = window.hide();
                        // Keep the chat webview running so sockets can deliver
                        // messages and native alerts while the window is in the tray.
                    } else {
                        capture::stop_all_native_whip_publishers(window.app_handle());
                        tauri::async_runtime::block_on(window.app_handle().state::<AppState>().screen_publish.stop());
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::get_app_version,
            commands::notifications::desktop_notification_show,
            commands::notifications::desktop_notification_dismiss,
            commands::app::quit_app,
            commands::app::app_relaunch,
            commands::app::open_external_url,
            commands::app::open_protected_link,
            commands::app::set_ad_frame_mounted,
            commands::app::set_window_fullscreen,
            commands::app::get_window_fullscreen,
            commands::app::set_background_media_active,
            commands::app::open_passkey_window,
            commands::app::open_screenshare_wizard,
            commands::settings::get_minimize_to_tray,
            commands::settings::set_minimize_to_tray,
            commands::settings::get_open_links_in_app,
            commands::settings::set_open_links_in_app,
            commands::settings::get_screen_share_video_encoding,
            commands::settings::set_screen_share_video_encoding,
            commands::settings::get_webview_render_backend,
            commands::settings::set_webview_render_backend,
            commands::settings::get_open_on_startup,
            commands::settings::set_open_on_startup,
            commands::updates::get_update_channel,
            commands::updates::set_update_channel,
            commands::updates::check_for_updates,
            commands::updates::get_update_status,
            commands::updates::get_next_update_check_at,
            commands::updates::queue_next_update_install,
            commands::updates::install_update,
            commands::updates::downgrade_client,
            commands::updates::clear_and_retry_update,
            commands::diagnostics::get_app_metrics,
            commands::diagnostics::get_debug_log_paths,
            commands::diagnostics::client_debug_log,
            commands::diagnostics::voice_debug_log,
            commands::diagnostics::set_voice_debug_console_enabled,
            commands::game_activity::get_game_activity_state,
            commands::game_activity::set_game_activity_enabled,
            commands::game_activity::invalidate_game_activity_catalog,
            commands::capture::desktop_sources,
            commands::capture::list_screenshare_gpus,
            commands::capture::list_video_capture_devices,
            commands::capture::desktop_audio_capture_support,
            commands::capture::native_whip_publisher_support,
            commands::capture::native_whip_publisher_start,
            commands::capture::native_whip_publisher_stop,
            commands::capture::native_screen_publish_support,
            commands::capture::native_screen_publish_start,
            commands::capture::native_screen_publish_stop,
            commands::capture::app_audio_capture_start,
            commands::capture::app_audio_capture_stop,
            commands::capture::fix_screenshare_firewall_rule,
            commands::voice::native_voice_supported,
            commands::voice::native_voice_list_devices,
            commands::voice::native_voice_set_input_device,
            commands::voice::native_voice_set_output_device,
            commands::voice::native_voice_microphone_test,
            commands::voice::native_voice_microphone_level,
            commands::voice::native_voice_start_video,
            commands::voice::native_voice_stop_video,
            commands::voice::native_voice_connect,
            commands::voice::native_voice_leave,
            commands::voice::native_voice_set_muted,
            commands::voice::native_voice_set_deafened,
            commands::overlay::obs_overlay_set_enabled,
            commands::overlay::obs_overlay_update_state,
            commands::reactive_avatar::reactive_avatar_save_image,
            commands::reactive_avatar::reactive_avatar_read_image,
            commands::reactive_avatar::reactive_avatar_prune,
            commands::auth_windows::embed_login_open,
            commands::auth_windows::embed_login_status,
            commands::auth_windows::embed_login_logout,
            commands::auth_windows::theater_youtube_cookie_open,
            commands::auth_windows::theater_youtube_cookie_status,
            commands::auth_windows::theater_youtube_cookie_export,
            commands::auth_windows::theater_youtube_cookie_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CatRealm");
}
