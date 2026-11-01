//! Screen-share + app-audio capture surface.
//!
//! These are the two high-risk ports from Electron:
//!   - electron/whipPublisherBridge.cjs  → spawn CatRealm-ffmpeg.exe / GStreamer
//!     as Tauri sidecars publishing hardware-encoded H.264 over WHIP.
//!   - electron/windowsAppAudioBridge.cjs → spawn CatRealmAppAudioCapture.exe
//!     (WASAPI process loopback) and stream PCM back to the renderer.
//!
//! Windows screen share is wired through GStreamer/WHIP and app-audio is wired
//! to the existing native helper so the renderer-facing contract can stay close
//! to the Electron client.

use base64::{engine::general_purpose, Engine as _};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

static NEXT_CAPTURE_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_PUBLISHER_ID: AtomicU64 = AtomicU64::new(1);
#[cfg(target_os = "windows")]
static DESKTOP_SOURCE_CACHE: OnceLock<Mutex<Option<DesktopSourceCacheEntry>>> = OnceLock::new();
#[cfg(target_os = "windows")]
static VIDEO_CAPTURE_DEVICE_CACHE: OnceLock<Mutex<Option<VideoCaptureDeviceCacheEntry>>> =
    OnceLock::new();
static GST_PUBLISHER_SUPPORT_CACHE: OnceLock<Mutex<Option<GstPublisherSupportCacheEntry>>> =
    OnceLock::new();
#[cfg(target_os = "windows")]
static GST_ENCODER_CACHE: OnceLock<Mutex<HashMap<String, GstEncoderCacheEntry>>> = OnceLock::new();
#[cfg(target_os = "windows")]
static GST_AUDIO_DEVICE_CACHE: OnceLock<Mutex<Option<GstAudioDeviceCacheEntry>>> = OnceLock::new();
#[cfg(target_os = "windows")]
const DESKTOP_SOURCE_CACHE_TTL: Duration = Duration::from_secs(5);
#[cfg(target_os = "windows")]
const VIDEO_CAPTURE_DEVICE_CACHE_TTL: Duration = Duration::from_secs(30);
const GST_PUBLISHER_SUPPORT_CACHE_TTL: Duration = Duration::from_secs(30);
#[cfg(target_os = "windows")]
const GST_ENCODER_CACHE_TTL: Duration = Duration::from_secs(60);
#[cfg(target_os = "windows")]
const GST_AUDIO_DEVICE_CACHE_TTL: Duration = Duration::from_secs(15);

#[cfg(target_os = "windows")]
struct DesktopSourceCacheEntry {
    checked_at: Instant,
    include_screens: bool,
    include_windows: bool,
    sources: Value,
}

#[cfg(target_os = "windows")]
struct VideoCaptureDeviceCacheEntry {
    checked_at: Instant,
    devices: Value,
}

struct GstPublisherSupportCacheEntry {
    checked_at: Instant,
    support: Value,
}

#[cfg(target_os = "windows")]
struct GstEncoderCacheEntry {
    checked_at: Instant,
    encoders: Vec<&'static str>,
}

#[derive(Clone)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
struct GstAudioDevice {
    name: String,
    class_name: String,
    id: String,
    description: String,
    actual_name: String,
    loopback: bool,
    api: String,
}

#[cfg(target_os = "windows")]
struct GstAudioDeviceCacheEntry {
    checked_at: Instant,
    devices: Vec<GstAudioDevice>,
}

#[derive(Default)]
pub(crate) struct AppAudioCaptureService {
    children: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
}

impl AppAudioCaptureService {
    fn insert(&self, capture_id: String, child: Arc<Mutex<Child>>) {
        self.children.lock().unwrap().insert(capture_id, child);
    }

    fn remove(&self, capture_id: &str) -> Option<Arc<Mutex<Child>>> {
        self.children.lock().unwrap().remove(capture_id)
    }
}

#[derive(Default)]
pub(crate) struct NativeWhipPublisherService {
    children: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
}

impl NativeWhipPublisherService {
    fn insert(&self, publisher_id: String, child: Arc<Mutex<Child>>) {
        self.children.lock().unwrap().insert(publisher_id, child);
    }

    fn remove(&self, publisher_id: &str) -> Option<Arc<Mutex<Child>>> {
        self.children.lock().unwrap().remove(publisher_id)
    }

    fn drain(&self) -> Vec<Arc<Mutex<Child>>> {
        self.children
            .lock()
            .unwrap()
            .drain()
            .map(|(_id, child)| child)
            .collect()
    }
}

fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

pub fn desktop_sources(app: &AppHandle, opts: Value) -> Value {
    #[cfg(all(not(target_os = "windows"), not(target_os = "linux")))]
    {
        let _ = opts;
        return json!([]);
    }

    #[cfg(target_os = "linux")]
    {
        let wants_screens = opts.get("types").and_then(Value::as_array)
            .map(|types| types.iter().any(|entry| entry.as_str() == Some("screen")))
            .unwrap_or(true);
        if !wants_screens { return json!([]); }
        let monitors = app.available_monitors().ok()
            .map(|monitors| monitors.into_iter().enumerate().map(|(index, monitor)| {
                let label = monitor.name()
                    .filter(|name| !name.trim().is_empty())
                    .map(|name| format!("Monitor {} ({name})", index + 1))
                    .unwrap_or_else(|| format!("Monitor {}", index + 1));
                json!({
                    "id": format!("screen:{index}"),
                    "name": label,
                    "thumbnail": Value::Null,
                    "appIcon": Value::Null,
                })
            }).collect::<Vec<_>>()).unwrap_or_default();
        if monitors.is_empty() {
            json!([{ "id": "screen:0", "name": "Desktop", "thumbnail": Value::Null, "appIcon": Value::Null }])
        } else {
            Value::Array(monitors)
        }
    }

    #[cfg(target_os = "windows")]
    {
        let wants_type = |source_type: &str| {
            opts.get("types")
                .and_then(Value::as_array)
                .map(|types| {
                    types
                        .iter()
                        .any(|entry| entry.as_str() == Some(source_type))
                })
                .unwrap_or(true)
        };
        let include_screens = wants_type("screen");
        let include_windows = wants_type("window");
        let cache = DESKTOP_SOURCE_CACHE.get_or_init(|| Mutex::new(None));
        if let Some(entry) = cache.lock().unwrap().as_ref() {
            if entry.include_screens == include_screens
                && entry.include_windows == include_windows
                && entry.checked_at.elapsed() < DESKTOP_SOURCE_CACHE_TTL
            {
                return entry.sources.clone();
            }
        }

        let sources = windows_desktop_sources(app, include_screens, include_windows)
            .unwrap_or_else(|| json!([]));
        *cache.lock().unwrap() = Some(DesktopSourceCacheEntry {
            checked_at: Instant::now(),
            include_screens,
            include_windows,
            sources: sources.clone(),
        });
        sources
    }
}

pub fn list_screenshare_gpus() -> Value {
    #[cfg(not(target_os = "windows"))]
    {
        json!({
            "gpus": [],
            "encoders": [],
            "hasDiscrete": false,
        })
    }

    #[cfg(target_os = "windows")]
    {
        let encoders = resolve_gstreamer_launcher()
            .map(|gst_path| available_gst_h264_encoders_for_path(&gst_path))
            .unwrap_or_default();
        let gpus = windows_video_adapters()
            .into_iter()
            .filter_map(|adapter| {
                let vendor = adapter_vendor(&adapter);
                if vendor == "other" {
                    return None;
                }

                let preferred = match vendor {
                    "nvidia" => "nvh264enc",
                    "amd" => "amfh264enc",
                    "intel" => "mfh264enc",
                    _ => "mfh264enc",
                };
                let encoder = if encoders.contains(&preferred) {
                    preferred
                } else if encoders.contains(&"mfh264enc") {
                    "mfh264enc"
                } else {
                    return None;
                };

                Some(json!({
                    "id": format!("{vendor}:{}", adapter.name),
                    "label": adapter.name,
                    "vendor": vendor,
                    "encoder": encoder,
                    "integrated": is_integrated_gpu(vendor, &adapter.name),
                }))
            })
            .fold(Vec::<Value>::new(), |mut acc, gpu| {
                let id = gpu.get("id").and_then(Value::as_str).unwrap_or_default();
                if !acc
                    .iter()
                    .any(|existing| existing.get("id").and_then(Value::as_str) == Some(id))
                {
                    acc.push(gpu);
                }
                acc
            });
        let has_discrete = gpus
            .iter()
            .any(|gpu| gpu.get("integrated").and_then(Value::as_bool) == Some(false));
        json!({
            "gpus": gpus,
            "encoders": encoders,
            "hasDiscrete": has_discrete,
        })
    }
}

pub fn list_video_capture_devices() -> Value {
    #[cfg(all(not(target_os = "windows"), not(target_os = "linux")))]
    {
        json!([])
    }


    #[cfg(target_os = "linux")]
    {
        let mut devices = Vec::new();
        if let Ok(entries) = std::fs::read_dir("/sys/class/video4linux") {
            for entry in entries.flatten() {
                let node = entry.file_name().to_string_lossy().into_owned();
                let path = format!("/dev/{node}");
                // Metadata-only V4L2 nodes (common as video1 beside a webcam's
                // video0) do not advertise Video Capture and cannot be used by
                // v4l2src. Query the kernel directly instead of starting one
                // v4l2-ctl process for every node.
                if !linux_v4l2_capture_device(Path::new(&path)) {
                    continue;
                }
                let label = std::fs::read_to_string(entry.path().join("name"))
                    .unwrap_or_else(|_| node.clone()).trim().to_string();
                devices.push(json!({
                    "deviceId": format!("native-video:{node}"),
                    "kind": "videoinput",
                    "label": label,
                    "groupId": "v4l2",
                    "devicePath": path,
                    "nativeOnly": true,
                }));
            }
        }
        Value::Array(devices)
    }

    #[cfg(target_os = "windows")]
    {
        let cache = VIDEO_CAPTURE_DEVICE_CACHE.get_or_init(|| Mutex::new(None));
        if let Some(entry) = cache.lock().unwrap().as_ref() {
            if entry.checked_at.elapsed() < VIDEO_CAPTURE_DEVICE_CACHE_TTL {
                return entry.devices.clone();
            }
        }

        let devices = windows_video_capture_devices().unwrap_or_else(|| json!([]));
        *cache.lock().unwrap() = Some(VideoCaptureDeviceCacheEntry {
            checked_at: Instant::now(),
            devices: devices.clone(),
        });
        devices
    }
}

#[cfg(target_os = "linux")]
#[repr(C)]
#[derive(Default)]
struct V4l2Capability {
    driver: [u8; 16],
    card: [u8; 32],
    bus_info: [u8; 32],
    version: u32,
    capabilities: u32,
    device_caps: u32,
    reserved: [u32; 3],
}

#[cfg(any(target_os = "linux", test))]
fn v4l2_supports_video_capture(capabilities: u32, device_caps: u32) -> bool {
    const V4L2_CAP_VIDEO_CAPTURE: u32 = 0x0000_0001;
    const V4L2_CAP_VIDEO_CAPTURE_MPLANE: u32 = 0x0000_1000;
    const V4L2_CAP_DEVICE_CAPS: u32 = 0x8000_0000;
    let effective = if capabilities & V4L2_CAP_DEVICE_CAPS != 0 {
        device_caps
    } else {
        capabilities
    };
    effective & (V4L2_CAP_VIDEO_CAPTURE | V4L2_CAP_VIDEO_CAPTURE_MPLANE) != 0
}

#[cfg(target_os = "linux")]
fn linux_v4l2_capture_device(path: &Path) -> bool {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;

    // _IOR('V', 0, struct v4l2_capability), whose ABI size is 104 bytes.
    const VIDIOC_QUERYCAP: libc::c_ulong = 0x8068_5600;
    let Ok(device) = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
    else {
        return false;
    };
    let mut capability = V4l2Capability::default();
    let result = unsafe { libc::ioctl(device.as_raw_fd(), VIDIOC_QUERYCAP, &mut capability) };
    result >= 0
        && v4l2_supports_video_capture(capability.capabilities, capability.device_caps)
}

#[cfg(target_os = "windows")]
struct VideoAdapter {
    name: String,
    compat: String,
    ven: String,
}

#[cfg(target_os = "windows")]
fn windows_video_adapters() -> Vec<VideoAdapter> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};

    let Ok(factory) = (unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }) else {
        return Vec::new();
    };
    let mut adapters = Vec::new();
    let mut index = 0u32;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(index) } {
        if let Ok(description) = unsafe { adapter.GetDesc1() } {
            let name_len = description
                .Description
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(description.Description.len());
            let name = String::from_utf16_lossy(&description.Description[..name_len]);
            adapters.push(VideoAdapter {
                name: if name.trim().is_empty() { "GPU".into() } else { name.trim().into() },
                compat: String::new(),
                ven: format!("{:04x}", description.VendorId),
            });
        }
        index += 1;
    }
    adapters
}

#[cfg(target_os = "windows")]
fn adapter_vendor(adapter: &VideoAdapter) -> &'static str {
    let haystack = format!("{} {}", adapter.compat, adapter.name).to_ascii_lowercase();
    if adapter.ven == "10de" || haystack.contains("nvidia") {
        "nvidia"
    } else if adapter.ven == "1002"
        || haystack.contains("advanced micro")
        || haystack.contains("amd")
        || haystack.contains("radeon")
    {
        "amd"
    } else if adapter.ven == "8086" || haystack.contains("intel") {
        "intel"
    } else {
        "other"
    }
}

#[cfg(target_os = "windows")]
fn is_integrated_gpu(vendor: &str, name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    match vendor {
        "intel" => !name.contains("arc"),
        "amd" => name.trim_end().ends_with("graphics"),
        _ => false,
    }
}

#[cfg(target_os = "windows")]
fn windows_desktop_sources(
    app: &AppHandle,
    include_screens: bool,
    include_windows: bool,
) -> Option<Value> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetAncestor, GetShellWindow, GetWindowLongPtrW, GetWindowTextLengthW,
        GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, GA_ROOTOWNER,
        GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };

    struct WindowScan {
        sources: Vec<Value>,
        /// Sushi's main window stays shareable; its other windows don't.
        main_window: isize,
    }

    unsafe extern "system" fn collect_window(hwnd: HWND, data: LPARAM) -> BOOL {
        let scan = unsafe { &mut *(data.0 as *mut WindowScan) };
        if hwnd.0.is_null()
            || hwnd == unsafe { GetShellWindow() }
            || !unsafe { IsWindowVisible(hwnd) }.as_bool()
            // Minimized windows capture as black or a stale frame.
            || unsafe { IsIconic(hwnd) }.as_bool()
            || unsafe { GetAncestor(hwnd, GA_ROOTOWNER) } != hwnd
        {
            return true.into();
        }
        // Tool windows (tray/helper popups) stay out unless they opt into the
        // taskbar, matching Alt+Tab.
        let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
        if ex_style & WS_EX_TOOLWINDOW.0 != 0 && ex_style & WS_EX_APPWINDOW.0 == 0 {
            return true.into();
        }
        // Sushi's helper windows (e.g. the single-instance window) aren't share targets.
        let mut process_id = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)) };
        if process_id == std::process::id() && hwnd.0 as isize != scan.main_window {
            return true.into();
        }
        let mut cloaked = 0u32;
        if unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                (&mut cloaked as *mut u32).cast(),
                std::mem::size_of::<u32>() as u32,
            )
        }
        .is_ok()
            && cloaked != 0
        {
            return true.into();
        }
        let length = unsafe { GetWindowTextLengthW(hwnd) };
        if length <= 0 {
            return true.into();
        }
        let mut title = vec![0u16; length as usize + 1];
        let copied = unsafe { GetWindowTextW(hwnd, &mut title) };
        if copied <= 0 {
            return true.into();
        }
        let title = String::from_utf16_lossy(&title[..copied as usize]);
        let title = title.trim();
        if title.is_empty() {
            return true.into();
        }
        scan.sources.push(json!({
            "id": format!("window:{}:0", hwnd.0 as usize),
            "name": title,
            "thumbnail": Value::Null,
            "appIcon": Value::Null,
        }));
        true.into()
    }

    let mut sources = Vec::new();
    if include_screens {
        let primary = app.primary_monitor().ok().flatten();
        for (index, monitor) in app.available_monitors().ok()?.into_iter().enumerate() {
            let size = monitor.size();
            let is_primary = primary.as_ref().is_some_and(|candidate| {
                candidate.position() == monitor.position() && candidate.size() == size
            });
            let primary_label = if is_primary { " (Primary)" } else { "" };
            sources.push(json!({
                "id": format!("screen:{index}:0"),
                "name": format!("Screen {}{primary_label} {}x{}", index + 1, size.width, size.height),
                "thumbnail": Value::Null,
                "appIcon": Value::Null,
            }));
        }
    }
    if include_windows {
        let main_window = app
            .get_webview_window("main")
            .and_then(|window| window.hwnd().ok())
            .map_or(0, |hwnd| hwnd.0 as isize);
        let mut scan = WindowScan { sources, main_window };
        let data = LPARAM((&mut scan as *mut WindowScan) as isize);
        unsafe { EnumWindows(Some(collect_window), data) }.ok()?;
        sources = scan.sources;
    }
    Some(Value::Array(sources))
}

#[cfg(target_os = "windows")]
fn windows_video_capture_devices() -> Option<Value> {
    let gst_path = resolve_gstreamer_launcher()?;
    let monitor = gst_path.parent()?.join("gst-device-monitor-1.0.exe");
    if !monitor.is_file() {
        return Some(json!([]));
    }

    let mut command = Command::new(monitor);
    command
        .arg("Video/Source")
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    for (key, value) in gstreamer_env(&gst_path) {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let output = command.output().ok()?;
    if !output.status.success() {
        return Some(json!([]));
    }

    let stdout = String::from_utf8(output.stdout).ok()?;
    let mut devices = Vec::new();
    let mut current_name: Option<String> = None;
    let mut current_path: Option<String> = None;

    let push_device =
        |devices: &mut Vec<Value>, name: &mut Option<String>, path: &mut Option<String>| {
            let Some(label) = name.take().map(|value| value.trim().to_string()) else {
                *path = None;
                return;
            };
            if label.is_empty() || devices.iter().any(|device| device["label"] == label) {
                *path = None;
                return;
            }
            let index = devices.len();
            devices.push(json!({
                "deviceId": format!("native-video:{index}"),
                "kind": "videoinput",
                "label": label,
                "groupId": "",
                "devicePath": path.take(),
            }));
        };

    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed == "Device found:" {
            push_device(&mut devices, &mut current_name, &mut current_path);
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("name  :") {
            current_name = Some(value.trim().to_string());
            continue;
        }
        if current_name.is_none() {
            if let Some(value) = trimmed.strip_prefix("device.name =") {
                current_name = Some(value.trim().to_string());
                continue;
            }
        }
        if let Some(value) = trimmed.strip_prefix("device.path =") {
            current_path = Some(value.trim().to_string());
        }
    }
    push_device(&mut devices, &mut current_name, &mut current_path);

    Some(Value::Array(devices))
}

#[cfg(target_os = "windows")]
fn gstreamer_publisher_support() -> Value {
    let Some(gst_path) = resolve_gstreamer_launcher() else {
        return json!({
            "ok": false,
            "platform": platform(),
            "reason": "CatRealmStreamer.exe or gst-launch-1.0.exe was not found.",
            "backend": "gstreamer",
            "features": gst_feature_json(false, false, false, false, false, false, false),
            "tlsBackends": { "gnutls": false, "openssl": false, "schannel": false },
            "checkedAt": crate::now_ms(),
        });
    };

    let whip_muxer = gst_element_available(&gst_path, "whipsink");
    let whip_client = gst_element_available(&gst_path, "whipclientsink");
    let webrtc = gst_element_available(&gst_path, "webrtcbin");
    let d3d11_screen_capture = gst_element_available(&gst_path, "d3d11screencapturesrc");
    let media_foundation_capture = gst_element_available(&gst_path, "mfvideosrc");
    let wasapi2 = gst_element_available(&gst_path, "wasapi2src");
    let opus = gst_element_available(&gst_path, "opusenc");
    let h264_pay = gst_element_available(&gst_path, "rtph264pay");
    let h264_parse = gst_element_available(&gst_path, "h264parse");
    let h264_nvenc = gst_element_available(&gst_path, "nvh264enc");

    let elements = [
        ("whipsink", whip_muxer),
        ("whipclientsink", whip_client),
        ("webrtcbin", webrtc),
        ("d3d11screencapturesrc", d3d11_screen_capture),
        ("mfvideosrc", media_foundation_capture),
        ("wasapi2src", wasapi2),
        ("opusenc", opus),
        ("rtph264pay", h264_pay),
        ("h264parse", h264_parse),
    ];
    let mut missing = Vec::new();
    for (element, available) in elements {
        if !available {
            missing.push(element);
        }
    }

    let encoders = available_gst_h264_encoders_for_path(&gst_path);
    let has_encoder = !encoders.is_empty();
    if !has_encoder {
        missing.push("nvh264enc/amfh264enc/mfh264enc");
    }

    let ok = missing.is_empty();
    json!({
        "ok": ok,
        "platform": platform(),
        "backend": "gstreamer",
        "gstPath": gst_path.to_string_lossy(),
        "reason": if ok {
            Value::Null
        } else {
            json!(format!("gstreamer is missing: {}", missing.join(", ")))
        },
        "features": {
            "whipMuxer": whip_muxer,
            "whipClient": whip_client,
            "webrtc": webrtc,
            "d3d11ScreenCapture": d3d11_screen_capture,
            "mediaFoundationCapture": media_foundation_capture,
            "wasapi2": wasapi2,
            "h264Encoder": has_encoder,
            "h264Encoders": encoders,

            "ddagrab": false,
            "gfxcapture": false,
            "dshowInput": false,
            "h264Nvenc": h264_nvenc,
            "libopus": opus,
            "whipDtlsBackend": ok,
        },
        "tlsBackends": {
            "gnutls": false,
            "openssl": true,
            "schannel": false,
        },
        "checkedAt": crate::now_ms(),
    })
}

#[cfg(not(target_os = "windows"))]
fn gstreamer_publisher_support() -> Value {
    json!({
        "ok": false,
        "platform": platform(),
        "reason": "native WHIP publishing is Windows-only",
        "backend": "gstreamer",
        "checkedAt": crate::now_ms(),
    })
}

#[cfg(target_os = "windows")]
fn gst_feature_json(
    whip_muxer: bool,
    ddagrab: bool,
    gfxcapture: bool,
    dshow_input: bool,
    h264_nvenc: bool,
    libopus: bool,
    whip_dtls_backend: bool,
) -> Value {
    json!({
        "whipMuxer": whip_muxer,
        "ddagrab": ddagrab,
        "gfxcapture": gfxcapture,
        "dshowInput": dshow_input,
        "h264Nvenc": h264_nvenc,
        "libopus": libopus,
        "whipDtlsBackend": whip_dtls_backend,
    })
}

#[cfg(target_os = "windows")]
fn available_gst_h264_encoders_for_path(gst_path: &Path) -> Vec<&'static str> {
    let cache_key = gst_path.to_string_lossy().to_string();
    let cache = GST_ENCODER_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(entry) = cache.lock().unwrap().get(&cache_key) {
        if entry.checked_at.elapsed() < GST_ENCODER_CACHE_TTL {
            return entry.encoders.clone();
        }
    }

    let encoders: Vec<&'static str> = ["nvh264enc", "amfh264enc", "mfh264enc"]
        .into_iter()
        .filter(|encoder| gst_element_available(gst_path, encoder))
        .collect();
    cache.lock().unwrap().insert(
        cache_key,
        GstEncoderCacheEntry {
            checked_at: Instant::now(),
            encoders: encoders.clone(),
        },
    );
    encoders
}

#[cfg(target_os = "windows")]
fn gst_element_available(gst_path: &Path, element: &str) -> bool {
    let inspect = gst_path
        .parent()
        .map(|bin_dir| bin_dir.join("gst-inspect-1.0.exe"))
        .filter(|candidate| candidate.is_file())
        .unwrap_or_else(|| PathBuf::from("gst-inspect-1.0.exe"));
    command_status_ok(&inspect, &[element], Some(gstreamer_env(gst_path)))
}

// Non-Windows stubs: native WHIP publishing is Windows-only. whip_publisher_start
// bails out before reaching these, but they must exist for the crate to compile.
#[cfg(not(target_os = "windows"))]
fn available_gst_h264_encoders_for_path(_gst_path: &Path) -> Vec<&'static str> {
    Vec::new()
}

#[cfg(not(target_os = "windows"))]
fn resolve_gstreamer_launcher() -> Option<PathBuf> {
    None
}

#[cfg(not(target_os = "windows"))]
fn gstreamer_env(_gst_path: &Path) -> Vec<(OsString, OsString)> {
    Vec::new()
}

#[cfg(target_os = "windows")]
fn resolve_gstreamer_launcher() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("CATREALM_GSTREAMER_BIN").map(PathBuf::from) {
        if path.is_file() {
            return Some(path);
        }
    }

    let mut candidates = Vec::new();
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            candidates.extend(gstreamer_launcher_candidates_from_root(
                parent.to_path_buf(),
            ));
        }
    }
    if let Ok(current_dir) = std::env::current_dir() {
        candidates.extend(gstreamer_launcher_candidates_from_root(current_dir.clone()));
        if let Some(parent) = current_dir.parent() {
            candidates.extend(gstreamer_launcher_candidates_from_root(
                parent.to_path_buf(),
            ));
        }
        if let Some(grandparent) = current_dir.parent().and_then(|parent| parent.parent()) {
            candidates.extend(gstreamer_launcher_candidates_from_root(
                grandparent.to_path_buf(),
            ));
        }
    }
    if let Some(root) = std::env::var_os("GSTREAMER_1_0_ROOT_MSVC_X86_64").map(PathBuf::from) {
        candidates.push(root.join("bin").join("gst-launch-1.0.exe"));
    }
    candidates.push(PathBuf::from(
        r"C:\Program Files\GStreamer\1.0\msvc_x86_64\bin\gst-launch-1.0.exe",
    ));

    candidates.into_iter().find(|candidate| candidate.is_file())
}

#[cfg(target_os = "windows")]
pub(crate) fn screenshare_publisher_program() -> Option<PathBuf> {
    resolve_gstreamer_launcher()
}

#[cfg(target_os = "windows")]
fn gstreamer_launcher_candidates_from_root(root: PathBuf) -> Vec<PathBuf> {
    [
        root.join("gstreamer").join("win-msvc-x64").join("bin"),
        root.join("native")
            .join("gstreamer")
            .join("win-msvc-x64")
            .join("bin"),
        root.join("electron")
            .join("native")
            .join("gstreamer")
            .join("win-msvc-x64")
            .join("bin"),
        root.join("CatRealm-Client")
            .join("electron")
            .join("native")
            .join("gstreamer")
            .join("win-msvc-x64")
            .join("bin"),
        root.join("..")
            .join("CatRealm-Client")
            .join("electron")
            .join("native")
            .join("gstreamer")
            .join("win-msvc-x64")
            .join("bin"),
    ]
    .into_iter()
    .flat_map(|bin_dir| {
        [
            bin_dir.join("CatRealmStreamer.exe"),
            bin_dir.join("gst-launch-1.0.exe"),
        ]
    })
    .collect()
}

#[cfg(target_os = "windows")]
fn gstreamer_env(gst_path: &Path) -> Vec<(OsString, OsString)> {
    let Some(bin_dir) = gst_path.parent() else {
        return Vec::new();
    };
    let root = if bin_dir.file_name().and_then(|value| value.to_str()) == Some("bin") {
        bin_dir.parent().map(Path::to_path_buf)
    } else {
        None
    };

    let mut env = Vec::new();
    let mut path_value = OsString::from(bin_dir.as_os_str());
    if let Some(existing_path) = std::env::var_os("PATH") {
        path_value.push(";");
        path_value.push(existing_path);
    }
    env.push((OsString::from("PATH"), path_value));

    if let Some(root) = root {
        let plugin_path = root.join("lib").join("gstreamer-1.0");
        if plugin_path.is_dir() {
            env.push((
                OsString::from("GST_PLUGIN_PATH"),
                plugin_path.clone().into_os_string(),
            ));
            env.push((
                OsString::from("GST_PLUGIN_SYSTEM_PATH"),
                plugin_path.clone().into_os_string(),
            ));
            env.push((
                OsString::from("GST_PLUGIN_PATH_1_0"),
                plugin_path.clone().into_os_string(),
            ));
            env.push((
                OsString::from("GST_PLUGIN_SYSTEM_PATH_1_0"),
                plugin_path.into_os_string(),
            ));
        }

        let scanner = root
            .join("libexec")
            .join("gstreamer-1.0")
            .join("gst-plugin-scanner.exe");
        if scanner.is_file() {
            env.push((
                OsString::from("GST_PLUGIN_SCANNER"),
                scanner.clone().into_os_string(),
            ));
            env.push((
                OsString::from("GST_PLUGIN_SCANNER_1_0"),
                scanner.into_os_string(),
            ));
        }
    }
    env
}

#[cfg(target_os = "windows")]
fn command_status_ok(
    command: &Path,
    args: &[&str],
    env: Option<Vec<(OsString, OsString)>>,
) -> bool {
    let mut cmd = Command::new(command);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(env) = env {
        for (key, value) in env {
            cmd.env(key, value);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd.status().map(|status| status.success()).unwrap_or(false)
}

pub fn desktop_audio_capture_support(app: &AppHandle) -> Value {
    let app_audio = if cfg!(target_os = "windows") {
        match app_audio_helper_path(app) {
            Some(helper_path) => json!({
                "available": true,
                "helperPath": helper_path.to_string_lossy(),
            }),
            None => json!({
                "available": false,
                "reason": "The Windows native application audio capture module is not bundled in this build.",
            }),
        }
    } else {
        json!({
            "available": false,
            "reason": "Windows application audio capture is only supported on Windows desktop builds.",
        })
    };

    json!({
        "platform": platform(),
        "appAudio": app_audio,
        "systemAudio": {
            "available": cfg!(target_os = "windows"),
            "reason": if cfg!(target_os = "windows") {
                Value::Null
            } else {
                json!("Desktop loopback audio support depends on the operating system and Chromium capture backend.")
            },
        },
    })
}

pub fn whip_publisher_support(opts: Value) -> Value {
    if cfg!(target_os = "windows") {
        let force_refresh = opts
            .get("forceRefresh")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let cache = GST_PUBLISHER_SUPPORT_CACHE.get_or_init(|| Mutex::new(None));
        if !force_refresh {
            if let Some(entry) = cache.lock().unwrap().as_ref() {
                if entry.checked_at.elapsed() < GST_PUBLISHER_SUPPORT_CACHE_TTL {
                    return entry.support.clone();
                }
            }
        }

        let support = gstreamer_publisher_support();
        *cache.lock().unwrap() = Some(GstPublisherSupportCacheEntry {
            checked_at: Instant::now(),
            support: support.clone(),
        });
        return support;
    }

    json!({
        "ok": false,
        "platform": platform(),
        "reason": "native WHIP publishing is Windows-only",
        "features": {
            "whipMuxer": false,
            "ddagrab": false,
            "gfxcapture": false,
            "dshowInput": false,
            "h264Nvenc": false,
            "libopus": false,
            "whipDtlsBackend": false,
        },
        "tlsBackends": {
            "gnutls": false,
            "openssl": false,
            "schannel": false,
        },
        "checkedAt": crate::now_ms(),
    })
}

pub fn whip_publisher_start(app: &AppHandle, opts: Value) -> Value {
    let started_at = Instant::now();
    if !cfg!(target_os = "windows") {
        return json!({
            "ok": false,
            "reason": "unsupported",
            "message": "Native WHIP publishing is Windows-only.",
            "support": whip_publisher_support(json!({})),
        });
    }

    let Some(gst_path) = resolve_gstreamer_launcher() else {
        return json!({
            "ok": false,
            "reason": "unsupported",
            "message": "CatRealmStreamer.exe or gst-launch-1.0.exe was not found.",
            "support": whip_publisher_support(json!({})),
        });
    };

    let args = match build_gstreamer_publisher_args(&gst_path, &opts) {
        Ok(args) => args,
        Err(message) => {
            return json!({
                "ok": false,
                "reason": "bad-options",
                "message": message,
                "support": whip_publisher_support(json!({})),
            });
        }
    };
    let args_built_ms = started_at.elapsed().as_millis();

    stop_tracked_native_whip_publishers(app);
    kill_stale_catrealm_gstreamer_publishers();

    let publisher_id = format!(
        "{}-{}",
        crate::now_ms(),
        NEXT_PUBLISHER_ID.fetch_add(1, Ordering::Relaxed)
    );
    let mut command = Command::new(&gst_path);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    for (key, value) in gstreamer_env(&gst_path) {
        command.env(key, value);
    }
    command.env(
        "GST_DEBUG",
        std::env::var("GST_DEBUG")
            .unwrap_or_else(|_| "2,webrtc-whip-signaller:3,webrtcbin:3,whipsink:3".to_string()),
    );
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return json!({
                "ok": false,
                "reason": "spawn-failed",
                "message": format!("Failed to start GStreamer publisher: {error}"),
                "support": whip_publisher_support(json!({})),
            });
        }
    };
    let spawn_elapsed_ms = started_at.elapsed().as_millis();

    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    app.state::<crate::AppState>()
        .native_whip
        .insert(publisher_id.clone(), Arc::clone(&child));

    emit_native_whip_status(
        app,
        &publisher_id,
        "info",
        format!(
            "spawn gstreamer={} args_built_ms={} spawn_elapsed_ms={} args={}",
            gst_path.to_string_lossy(),
            args_built_ms,
            spawn_elapsed_ms,
            safe_gst_args(&args).join(" ")
        ),
    );

    if let Some(stderr) = stderr {
        spawn_gstreamer_stderr_reader(app.clone(), publisher_id.clone(), stderr);
    }
    spawn_gstreamer_waiter(app.clone(), publisher_id.clone(), child);

    json!({
        "ok": true,
        "publisherId": publisher_id,
        "backend": "gstreamer",
        "gstPath": gst_path.to_string_lossy(),
        "argsBuiltMs": args_built_ms,
        "spawnElapsedMs": spawn_elapsed_ms,
        "captureMode": opts.get("captureMode").and_then(Value::as_str).unwrap_or("monitor-dxgi"),
        "sourceId": opts.get("sourceId").cloned().unwrap_or_else(|| json!(null)),
        "support": whip_publisher_support(json!({})),
    })
}

pub fn whip_publisher_stop(app: &AppHandle, publisher_id: Value) -> Value {
    if let Some(publisher_id) = publisher_id.as_str().filter(|value| !value.is_empty()) {
        if let Some(child) = app
            .state::<crate::AppState>()
            .native_whip
            .remove(publisher_id)
        {
            kill_native_whip_child(child);
        }
    } else {
        stop_tracked_native_whip_publishers(app);
    }
    kill_stale_catrealm_gstreamer_publishers();
    json!({ "ok": true })
}

pub fn stop_all_native_whip_publishers(app: &AppHandle) {
    stop_tracked_native_whip_publishers(app);
    kill_stale_catrealm_gstreamer_publishers();
}

fn stop_tracked_native_whip_publishers(app: &AppHandle) {
    for child in app.state::<crate::AppState>().native_whip.drain() {
        kill_native_whip_child(child);
    }
}

fn kill_native_whip_child(child: Arc<Mutex<Child>>) {
    if let Ok(mut child) = child.lock() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(target_os = "windows")]
fn kill_stale_catrealm_gstreamer_publishers() {
    let Ok(processes) = crate::windows_process::snapshot() else {
        return;
    };
    for process in processes {
        if !process.name.eq_ignore_ascii_case("CatRealmStreamer.exe")
            && !process.name.eq_ignore_ascii_case("gst-launch-1.0.exe")
        {
            continue;
        }
        let Some(command_line) = crate::windows_process::command_line(process.pid) else {
            continue;
        };
        let command_line = command_line.to_ascii_lowercase();
        let is_whip = command_line.contains("whipsink")
            || command_line.contains("whipclientsink")
            || command_line.contains("whip-endpoint=");
        let is_catrealm = command_line.contains("catrealm")
            || command_line.contains("cat.mcneko.net");
        if is_whip && is_catrealm {
            crate::windows_process::terminate(process.pid);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn kill_stale_catrealm_gstreamer_publishers() {}

/// Starts the screen capture + GPU H.264 encode pipeline with Annex-B output
/// on stdout, for the native screen publisher. `opts` takes the same capture
/// options as the WHIP publisher (captureMode, sourceId, width, height, fps,
/// bitrate, encoder); the WHIP and audio settings are ignored.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn spawn_encoded_screen_capture(opts: &Value) -> Result<Child, String> {
    let gst_path = resolve_gstreamer_launcher()
        .ok_or_else(|| "CatRealmStreamer.exe or gst-launch-1.0.exe was not found.".to_string())?;
    let mut opts = opts.clone();
    opts["sink"] = json!("fd");
    let args = build_gstreamer_publisher_args(&gst_path, &opts)?;
    let mut command = Command::new(&gst_path);
    command
        // -q: gst-launch prints its status lines ("Setting pipeline to
        // PLAYING", "Redistribute latency") to stdout, which here carries the
        // media itself.
        .arg("-q")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (key, value) in gstreamer_env(&gst_path) {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.spawn().map_err(|error| format!("Failed to start GStreamer capture: {error}"))
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn encoded_screen_capture_support() -> Value {
    json!({ "ok": false, "reason": "unsupported", "message": "Native screen publishing is Windows-only." })
}

/// Whether this machine can capture and GPU-encode screen share natively.
#[cfg(target_os = "windows")]
pub(crate) fn encoded_screen_capture_support() -> Value {
    let Some(gst_path) = resolve_gstreamer_launcher() else {
        return json!({ "ok": false, "reason": "missing-gstreamer", "message": "GStreamer was not found." });
    };
    let capture = gst_element_available(&gst_path, "d3d11screencapturesrc");
    let encoder = ["nvh264enc", "amfh264enc", "mfh264enc"].iter().any(|name| gst_element_available(&gst_path, name));
    json!({
        "ok": capture && encoder,
        "reason": if capture && encoder { "ok" } else { "missing-elements" },
        "capture": capture,
        "encoder": encoder,
    })
}

fn build_gstreamer_publisher_args(gst_path: &Path, opts: &Value) -> Result<Vec<String>, String> {
    let capture_mode = opts
        .get("captureMode")
        .and_then(Value::as_str)
        .unwrap_or("monitor-dxgi");
    let source_id = opts.get("sourceId").and_then(Value::as_str).unwrap_or("");
    // "fd" ends the pipeline in Annex-B H.264 on stdout for the native screen
    // publisher (screen_publish.rs) instead of a WHIP sink; video only.
    let fd_sink = opts.get("sink").and_then(Value::as_str) == Some("fd");
    let endpoint = if fd_sink { Some(String::new()) } else { join_whip_endpoint(
        opts.get("whip")
            .and_then(|whip| whip.get("url"))
            .and_then(Value::as_str)
            .unwrap_or(""),
        opts.get("whip")
            .and_then(|whip| whip.get("streamKey"))
            .and_then(Value::as_str)
            .unwrap_or(""),
    ) }
    .ok_or_else(|| "Missing WHIP endpoint.".to_string())?;

    let fps = number_option(opts.get("fps").and_then(Value::as_i64), 60, 1, 240);
    let height = number_option(opts.get("height").and_then(Value::as_i64), 1080, 16, 4320);
    let width = number_option(
        opts.get("width").and_then(Value::as_i64),
        (height * 16) / 9,
        16,
        7680,
    );
    let bitrate = number_option(
        opts.get("bitrate").and_then(Value::as_i64),
        8_000_000,
        500_000,
        50_000_000,
    );
    let include_audio = !fd_sink && opts
        .get("includeAudio")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || opts
            .get("audioDeviceLabel")
            .and_then(Value::as_str)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
    let audio_device_label = opts
        .get("audioDeviceLabel")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut app_audio_pid = None;

    let mut args = match capture_mode {
        "monitor-dxgi" => {
            let monitor_index = opts
                .get("monitorIndex")
                .and_then(Value::as_i64)
                .or_else(|| parse_screen_source_index(source_id).map(|value| value as i64))
                .unwrap_or(0);
            vec![
                "d3d11screencapturesrc".to_string(),
                "capture-api=dxgi".to_string(),
                format!("monitor-index={monitor_index}"),
                "show-cursor=true".to_string(),
                "do-timestamp=true".to_string(),
            ]
        }
        "window-wgc" => {
            let hwnd = parse_desktop_source_window_id(source_id)
                .ok_or_else(|| "Window capture requires a window:<hwnd> source id.".to_string())?;
            app_audio_pid = window_process_id(hwnd);
            vec![
                "d3d11screencapturesrc".to_string(),
                "capture-api=wgc".to_string(),
                format!("window-handle={hwnd}"),
                "window-capture-mode=default".to_string(),
                "show-cursor=true".to_string(),
                "do-timestamp=true".to_string(),
            ]
        }
        "device-dshow" => {
            let device_path = opts
                .get("devicePath")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let device = opts
                .get("deviceLabel")
                .or_else(|| opts.get("sourceName"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "GStreamer device capture requires a device label.".to_string())?;
            let mut tokens = vec!["mfvideosrc".to_string()];
            if let Some(path) = device_path {
                tokens.push(format!("device-path={}", gst_quoted(path)));
            } else {
                tokens.push(format!("device-name={}", gst_quoted(device)));
            }
            tokens.push("do-timestamp=true".to_string());
            tokens
        }
        _ => {
            return Err(format!(
                "Unsupported GStreamer capture mode: {capture_mode}"
            ));
        }
    };

    let h264_profile = h264_profile(opts);
    let encoder = resolve_gst_video_encoder(gst_path, opts);
    let mut encoder_tokens = build_h264_encoder_tokens(
        encoder,
        (bitrate / 1000).max(500),
        (fps * 2).max(15),
        h264_profile == "high" || h264_profile == "main",
        rate_control(opts),
    );
    if fd_sink && encoder == "nvh264enc" {
        // NVENC's default VBV lets one frame balloon on a sudden full-screen
        // change (flashbangs, big effects); pre-encoded frames go out as-is,
        // so that burst overruns the path and viewers stall. Cap the buffer
        // at ~4 frames: tight enough to stop the stalls, loose enough that
        // periodic IDRs aren't starved (a 2-frame cap made text visibly
        // pulse soft/sharp at every keyframe).
        encoder_tokens.push(format!("vbv-buffer-size={}", ((bitrate / 1000) * 4 / fps).max(100)));
    }

    args.extend([
        "!".to_string(),
        "queue".to_string(),
        "leaky=downstream".to_string(),
        "max-size-buffers=2".to_string(),
        "max-size-bytes=0".to_string(),
        "max-size-time=0".to_string(),
        "!".to_string(),
        "videorate".to_string(),
        "!".to_string(),
        "videoscale".to_string(),
        "!".to_string(),
        "videoconvert".to_string(),
        "!".to_string(),
        format!(
            "video/x-raw,width=(int){width},height=(int){height},framerate=(fraction){fps}/1,pixel-aspect-ratio=(fraction)1/1"
        ),
        "!".to_string(),
        "queue".to_string(),
        "leaky=downstream".to_string(),
        "max-size-buffers=2".to_string(),
        "max-size-bytes=0".to_string(),
        "max-size-time=0".to_string(),
        "!".to_string(),
    ]);
    args.extend(encoder_tokens);
    if fd_sink {
        args.extend([
            "!".to_string(),
            format!("video/x-h264,profile=(string){h264_profile},stream-format=(string)byte-stream,alignment=(string)au"),
            "!".to_string(),
            "h264parse".to_string(),
            "config-interval=-1".to_string(),
            "!".to_string(),
            "video/x-h264,stream-format=(string)byte-stream,alignment=(string)au".to_string(),
            "!".to_string(),
            "fdsink".to_string(),
            "fd=1".to_string(),
            "sync=false".to_string(),
        ]);
        return Ok(args);
    }
    args.extend([
        "!".to_string(),
        format!("video/x-h264,profile=(string){h264_profile},stream-format=(string)byte-stream,alignment=(string)au"),
        "!".to_string(),
        "h264parse".to_string(),
        "config-interval=-1".to_string(),
        "!".to_string(),
        "rtph264pay".to_string(),
        "config-interval=-1".to_string(),
        "pt=96".to_string(),
        "!".to_string(),
        "whipsink".to_string(),
        "name=whip".to_string(),
        "use-link-headers=true".to_string(),
        "timeout=8".to_string(),
        format!("whip-endpoint={endpoint}"),
    ]);
    if include_audio {
        args.extend(build_gstreamer_audio_branch(
            gst_path,
            capture_mode,
            app_audio_pid,
            audio_device_label,
        ));
    }
    Ok(args)
}

fn build_gstreamer_audio_branch(
    gst_path: &Path,
    capture_mode: &str,
    process_id: Option<u32>,
    audio_device_label: Option<&str>,
) -> Vec<String> {
    let Some(mut branch) = gstreamer_audio_source_tokens(gst_path, capture_mode, process_id, audio_device_label) else {
        return Vec::new();
    };
    branch.extend([
        "!".to_string(),
        "queue".to_string(),
        "leaky=downstream".to_string(),
        "max-size-buffers=0".to_string(),
        "max-size-bytes=0".to_string(),
        "max-size-time=200000000".to_string(),
        "!".to_string(),
        "audioconvert".to_string(),
        "!".to_string(),
        "audioresample".to_string(),
        "!".to_string(),
        "audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved".to_string(),
        "!".to_string(),
        "opusenc".to_string(),
        "bitrate=128000".to_string(),
        "bitrate-type=cbr".to_string(),
        "audio-type=generic".to_string(),
        "frame-size=20".to_string(),
        "perfect-timestamp=true".to_string(),
        "hard-resync=true".to_string(),
        "!".to_string(),
        "rtpopuspay".to_string(),
        "pt=97".to_string(),
        "!".to_string(),
        "whip.".to_string(),
    ]);
    branch
}

/// The `wasapi2src` capturing a share's audio: the device's own audio input
/// for capture cards, the target process tree for windows, otherwise desktop
/// loopback. None when the source has no audio to capture.
fn gstreamer_audio_source_tokens(
    gst_path: &Path,
    capture_mode: &str,
    process_id: Option<u32>,
    audio_device_label: Option<&str>,
) -> Option<Vec<String>> {
    if capture_mode == "window-wgc" && process_id.is_none() {
        return None;
    }

    let mut branch = vec![
        "wasapi2src".to_string(),
        "low-latency=true".to_string(),
        "provide-clock=false".to_string(),
        "do-timestamp=true".to_string(),
        "slave-method=resample".to_string(),
        "latency-time=10000".to_string(),
        "buffer-time=200000".to_string(),
    ];

    if capture_mode == "device-dshow" {
        let audio_device = find_gst_audio_device(gst_path, audio_device_label?)?;
        branch.insert(1, format!("device={}", gst_quoted(&audio_device.id)));
        if audio_device.loopback {
            branch.insert(2, "loopback=true".to_string());
        }
    } else {
        branch.insert(1, "loopback=true".to_string());
        if capture_mode == "window-wgc" {
            if let Some(process_id) = process_id {
                branch.push("loopback-mode=include-process-tree".to_string());
                branch.push(format!("loopback-target-pid={process_id}"));
            }
        }
    }
    Some(branch)
}

/// Starts an audio-only capture of a share's audio (same source choice as the
/// WHIP publisher) with raw 48 kHz stereo S16LE PCM on stdout, for the native
/// screen publisher. Ok(None) when the share has no audio to capture.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn spawn_raw_audio_capture(opts: &Value) -> Result<Option<Child>, String> {
    let gst_path = resolve_gstreamer_launcher()
        .ok_or_else(|| "CatRealmStreamer.exe or gst-launch-1.0.exe was not found.".to_string())?;
    let capture_mode = opts.get("captureMode").and_then(Value::as_str).unwrap_or("monitor-dxgi");
    let process_id = (capture_mode == "window-wgc")
        .then(|| parse_desktop_source_window_id(opts.get("sourceId").and_then(Value::as_str).unwrap_or("")))
        .flatten()
        .and_then(window_process_id);
    let audio_device_label = opts
        .get("audioDeviceLabel")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(mut args) = gstreamer_audio_source_tokens(&gst_path, capture_mode, process_id, audio_device_label) else {
        return Ok(None);
    };
    args.extend([
        "!".to_string(),
        "queue".to_string(),
        "leaky=downstream".to_string(),
        "max-size-buffers=0".to_string(),
        "max-size-bytes=0".to_string(),
        "max-size-time=200000000".to_string(),
        "!".to_string(),
        "audioconvert".to_string(),
        "!".to_string(),
        "audioresample".to_string(),
        "!".to_string(),
        "audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved".to_string(),
        "!".to_string(),
        "fdsink".to_string(),
        "fd=1".to_string(),
        "sync=false".to_string(),
    ]);
    let mut command = Command::new(&gst_path);
    command
        // -q: keep gst-launch's status text out of the PCM on stdout; even a
        // few bytes misalign every sample after them into full-scale noise.
        .arg("-q")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (key, value) in gstreamer_env(&gst_path) {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .spawn()
        .map(Some)
        .map_err(|error| format!("Failed to start GStreamer audio capture: {error}"))
}

#[cfg(target_os = "windows")]
fn find_gst_audio_device(gst_path: &Path, requested_label: &str) -> Option<GstAudioDevice> {
    let requested = requested_label.trim();
    if requested.is_empty() {
        return None;
    }

    gst_audio_devices(gst_path)
        .into_iter()
        .map(|device| {
            let score = score_gst_audio_device(&device, requested);
            (device, score)
        })
        .filter(|(_device, score)| *score > 0)
        .max_by_key(|(_device, score)| *score)
        .map(|(device, _score)| device)
}

#[cfg(not(target_os = "windows"))]
fn find_gst_audio_device(_gst_path: &Path, _requested_label: &str) -> Option<GstAudioDevice> {
    None
}

#[cfg(target_os = "windows")]
fn gst_audio_devices(gst_path: &Path) -> Vec<GstAudioDevice> {
    let cache = GST_AUDIO_DEVICE_CACHE.get_or_init(|| Mutex::new(None));
    if let Some(entry) = cache.lock().unwrap().as_ref() {
        if entry.checked_at.elapsed() < GST_AUDIO_DEVICE_CACHE_TTL {
            return entry.devices.clone();
        }
    }

    let devices = read_gst_audio_devices(gst_path);
    *cache.lock().unwrap() = Some(GstAudioDeviceCacheEntry {
        checked_at: Instant::now(),
        devices: devices.clone(),
    });
    devices
}

#[cfg(target_os = "windows")]
fn read_gst_audio_devices(gst_path: &Path) -> Vec<GstAudioDevice> {
    let Some(parent) = gst_path.parent() else {
        return Vec::new();
    };
    let monitor = parent.join("gst-device-monitor-1.0.exe");
    if !monitor.is_file() {
        return Vec::new();
    }

    let mut command = Command::new(monitor);
    command.arg("Audio/Source").stdin(Stdio::null());
    for (key, value) in gstreamer_env(gst_path) {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let Ok(output) = command.output() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    parse_gst_audio_devices(&text)
}

#[cfg(target_os = "windows")]
fn parse_gst_audio_devices(output: &str) -> Vec<GstAudioDevice> {
    let mut devices = Vec::new();
    let mut current: Option<GstAudioDevice> = None;

    let push_current = |devices: &mut Vec<GstAudioDevice>, current: &mut Option<GstAudioDevice>| {
        let Some(device) = current.take() else {
            return;
        };
        if device.name.trim().is_empty()
            || device.id.trim().is_empty()
            || !device
                .class_name
                .to_ascii_lowercase()
                .contains("audio/source")
            || (!device.api.is_empty() && !device.api.eq_ignore_ascii_case("wasapi2"))
        {
            return;
        }
        devices.push(device);
    };

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case("Device found:") {
            push_current(&mut devices, &mut current);
            current = Some(GstAudioDevice {
                name: String::new(),
                class_name: String::new(),
                id: String::new(),
                description: String::new(),
                actual_name: String::new(),
                loopback: false,
                api: String::new(),
            });
            continue;
        }

        let Some(device) = current.as_mut() else {
            continue;
        };
        if let Some(value) = trimmed.strip_prefix("name  :") {
            device.name = value.trim().to_string();
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("class :") {
            device.class_name = value.trim().to_string();
            continue;
        }
        let Some((raw_key, raw_value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = raw_key.trim().to_ascii_lowercase();
        let value = clean_gst_property_value(raw_value);
        match key.as_str() {
            "device.api" => device.api = value,
            "device.id" => device.id = value,
            "wasapi2.device.description" => device.description = value,
            "device.actual-name" => device.actual_name = value,
            "wasapi2.device.loopback" => {
                device.loopback = value.to_ascii_lowercase().starts_with("true")
            }
            _ => {}
        }
    }
    push_current(&mut devices, &mut current);
    devices
}

#[cfg(target_os = "windows")]
fn clean_gst_property_value(value: &str) -> String {
    let mut cleaned = value.trim().to_string();
    if cleaned.starts_with('"') && cleaned.ends_with('"') && cleaned.len() >= 2 {
        cleaned = cleaned[1..cleaned.len() - 1].to_string();
    }
    if let Some(open) = cleaned.rfind(" (") {
        if cleaned.ends_with(')') {
            cleaned.truncate(open);
        }
    }
    cleaned.trim().to_string()
}

#[cfg(target_os = "windows")]
fn normalize_device_label(value: &str) -> String {
    let mut normalized = value.trim().to_ascii_lowercase();
    if let Some(stripped) = normalized.strip_prefix("default -") {
        normalized = stripped.trim().to_string();
    }
    normalized = normalized.replace("(default)", " ");
    normalized
        .chars()
        .map(|ch| if ch.is_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(target_os = "windows")]
fn score_gst_audio_device(device: &GstAudioDevice, requested_label: &str) -> i32 {
    let requested = normalize_device_label(requested_label);
    if requested.is_empty() {
        return 0;
    }
    if device.id.eq_ignore_ascii_case(requested_label) {
        return 200;
    }

    let mut score = 0;
    for candidate in [&device.name, &device.description, &device.actual_name] {
        let candidate = normalize_device_label(candidate);
        if candidate.is_empty() {
            continue;
        }
        if candidate == requested {
            score = score.max(120);
        } else if candidate.contains(&requested) || requested.contains(&candidate) {
            score = score.max(70);
        }
    }
    if score > 0 && !device.loopback {
        score += 5;
    }
    score
}

#[cfg(target_os = "windows")]
fn window_process_id(hwnd: u64) -> Option<u32> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    let mut process_id = 0u32;
    let hwnd = HWND(hwnd as usize as *mut std::ffi::c_void);
    let thread_id = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)) };
    (thread_id != 0 && process_id != 0).then_some(process_id)
}

#[cfg(not(target_os = "windows"))]
fn window_process_id(_hwnd: u64) -> Option<u32> {
    None
}

fn parse_screen_source_index(source_id: &str) -> Option<i32> {
    if !source_id.starts_with("screen:") {
        return None;
    }
    source_id
        .split(':')
        .nth(1)
        .and_then(|raw| raw.parse::<i32>().ok())
        .filter(|value| *value >= 0)
}

fn join_whip_endpoint(url: &str, stream_key: &str) -> Option<String> {
    let base = url.trim().trim_end_matches('/');
    let key = stream_key.trim();
    if base.is_empty() {
        return None;
    }
    if key.is_empty() || base.ends_with(&format!("/{key}")) {
        Some(base.to_string())
    } else {
        Some(format!("{}/{}", base, url_component_encode(key)))
    }
}

fn url_component_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn number_option(value: Option<i64>, default: i64, min: i64, max: i64) -> i64 {
    value.unwrap_or(default).clamp(min, max)
}

fn h264_profile(opts: &Value) -> &'static str {
    match std::env::var("CATREALM_WHIP_H264_PROFILE")
        .ok()
        .or_else(|| {
            opts.get("h264Profile")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "high".to_string())
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "main" => "main",
        "baseline" => "baseline",
        "constrained-baseline" => "constrained-baseline",
        _ => "high",
    }
}

fn rate_control(opts: &Value) -> &'static str {
    let override_value = std::env::var("CATREALM_WHIP_RC").unwrap_or_default();
    match override_value.trim().to_ascii_lowercase().as_str() {
        "cbr" => return "cbr",
        "vbr" => return "vbr",
        _ => {}
    }
    if opts
        .get("preset")
        .and_then(Value::as_str)
        .map(|value| value.eq_ignore_ascii_case("quality"))
        .unwrap_or(false)
    {
        "vbr"
    } else {
        "cbr"
    }
}

fn resolve_gst_video_encoder(gst_path: &Path, opts: &Value) -> &'static str {
    let choice = std::env::var("CATREALM_WHIP_VIDEO_ENCODER")
        .ok()
        .or_else(|| {
            opts.get("videoEncoder")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let available = available_gst_h264_encoders_for_path(gst_path);
    for encoder in ["nvh264enc", "amfh264enc", "mfh264enc"] {
        if choice == encoder && available.contains(&encoder) {
            return encoder;
        }
    }
    available.into_iter().next().unwrap_or("nvh264enc")
}

fn build_h264_encoder_tokens(
    encoder: &str,
    kbps: i64,
    gop: i64,
    cabac: bool,
    rc_mode: &str,
) -> Vec<String> {
    let max_kbps = (kbps as f64 * 1.5).round() as i64;
    match encoder {
        "amfh264enc" => {
            let mut tokens = vec![
                "amfh264enc".to_string(),
                "usage=ultra-low-latency".to_string(),
                format!(
                    "rate-control={}",
                    if rc_mode == "vbr" { "lcvbr" } else { "cbr" }
                ),
                format!("bitrate={kbps}"),
            ];
            if rc_mode == "vbr" {
                tokens.push(format!("max-bitrate={max_kbps}"));
            }
            tokens.extend([
                format!("gop-size={gop}"),
                "b-frames=0".to_string(),
                format!("cabac={cabac}"),
                "aud=true".to_string(),
            ]);
            tokens
        }
        "mfh264enc" => {
            let mut tokens = vec![
                "mfh264enc".to_string(),
                "low-latency=true".to_string(),
                format!("rc-mode={}", if rc_mode == "vbr" { "pcvbr" } else { "cbr" }),
                format!("bitrate={kbps}"),
            ];
            if rc_mode == "vbr" {
                tokens.push(format!("max-bitrate={max_kbps}"));
            }
            tokens.extend([format!("gop-size={gop}"), format!("cabac={cabac}")]);
            tokens
        }
        _ => {
            let mut tokens = vec![
                "nvh264enc".to_string(),
                format!("rc-mode={rc_mode}"),
                format!("bitrate={kbps}"),
            ];
            if rc_mode == "vbr" {
                tokens.push(format!("max-bitrate={max_kbps}"));
            }
            tokens.extend([
                format!("gop-size={gop}"),
                "bframes=0".to_string(),
                "zerolatency=true".to_string(),
                "repeat-sequence-header=true".to_string(),
                format!("cabac={cabac}"),
            ]);
            tokens
        }
    }
}

fn gst_quoted(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn safe_gst_args(args: &[String]) -> Vec<String> {
    args.iter()
        .map(|arg| {
            if arg.starts_with("whip-endpoint=") || arg.starts_with("signaller::whip-endpoint=") {
                "whip-endpoint=<whip-endpoint>".to_string()
            } else {
                arg.clone()
            }
        })
        .collect()
}

fn emit_native_whip_status(app: &AppHandle, publisher_id: &str, level: &str, message: String) {
    let _ = app.emit(
        "native-whip-publisher-status",
        json!({
            "publisherId": publisher_id,
            "level": level,
            "message": message,
            "at": crate::now_ms(),
        }),
    );
}

fn should_emit_gst_status(text: &str) -> bool {
    let debug = std::env::var("CATREALM_NATIVE_WHIP_DEBUG")
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false);
    if debug {
        return true;
    }
    let lower = text.to_ascii_lowercase();
    lower.contains("ice connection state")
        || lower.contains("peer connection state")
        || lower.contains("whip resource")
        || lower.contains("201 created")
        || lower.contains("error")
        || lower.contains("fail")
        || lower.contains("could not")
        || lower.contains("not-negotiated")
        || lower.contains("no element")
        || lower.contains("setting pipeline to playing")
        || lower.contains("setting pipeline to null")
}

fn gst_status_level(text: &str) -> &'static str {
    let lower = text.to_ascii_lowercase();
    if lower.contains("error")
        || lower.contains("fail")
        || lower.contains("could not")
        || lower.contains("not-negotiated")
        || lower.contains("no element")
    {
        "warn"
    } else {
        "debug"
    }
}

fn spawn_gstreamer_stderr_reader(
    app: AppHandle,
    publisher_id: String,
    mut stderr: impl Read + Send + 'static,
) {
    thread::spawn(move || {
        let mut buffer = vec![0_u8; 8192];
        loop {
            match stderr.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let text = String::from_utf8_lossy(&buffer[..count]).to_string();
                    if should_emit_gst_status(&text) {
                        emit_native_whip_status(&app, &publisher_id, gst_status_level(&text), text);
                    }
                }
                Err(error) => {
                    emit_native_whip_status(
                        &app,
                        &publisher_id,
                        "warn",
                        format!("stderr read failed: {error}"),
                    );
                    break;
                }
            }
        }
    });
}

fn spawn_gstreamer_waiter(app: AppHandle, publisher_id: String, child: Arc<Mutex<Child>>) {
    thread::spawn(move || loop {
        let status = {
            let mut child = match child.lock() {
                Ok(child) => child,
                Err(_) => {
                    let _ = app
                        .state::<crate::AppState>()
                        .native_whip
                        .remove(&publisher_id);
                    let _ = app.emit(
                        "native-whip-publisher-stopped",
                        json!({
                            "publisherId": publisher_id,
                            "code": null,
                            "signal": null,
                            "error": "GStreamer publisher process lock was poisoned.",
                            "at": crate::now_ms(),
                        }),
                    );
                    return;
                }
            };
            child.try_wait()
        };

        match status {
            Ok(Some(exit_status)) => {
                let _ = app
                    .state::<crate::AppState>()
                    .native_whip
                    .remove(&publisher_id);
                let _ = app.emit(
                    "native-whip-publisher-stopped",
                    json!({
                        "publisherId": publisher_id,
                        "code": exit_status.code(),
                        "signal": null,
                        "at": crate::now_ms(),
                    }),
                );
                return;
            }
            Ok(None) => thread::sleep(Duration::from_millis(200)),
            Err(error) => {
                let _ = app
                    .state::<crate::AppState>()
                    .native_whip
                    .remove(&publisher_id);
                let _ = app.emit(
                    "native-whip-publisher-stopped",
                    json!({
                        "publisherId": publisher_id,
                        "code": null,
                        "signal": null,
                        "error": error.to_string(),
                        "at": crate::now_ms(),
                    }),
                );
                return;
            }
        }
    });
}

pub fn app_audio_capture_start(app: &AppHandle, opts: Value) -> Value {
    if !cfg!(target_os = "windows") {
        return json!({
            "ok": false,
            "reason": "unavailable",
            "message": "Windows app audio capture is only supported on Windows desktop builds.",
        });
    }

    let Some(helper_path) = app_audio_helper_path(app) else {
        return json!({
            "ok": false,
            "reason": "unavailable",
            "message": "Windows app audio capture helper is not available.",
        });
    };

    let hwnd = opts
        .get("sourceId")
        .and_then(Value::as_str)
        .and_then(parse_desktop_source_window_id);
    let process_id = opts
        .get("processId")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .map(|value| value as u32);

    if hwnd.is_none() && process_id.is_none() {
        return json!({
            "ok": false,
            "reason": "bad-source",
            "message": "Selected app source did not include a capturable window id.",
        });
    }

    let capture_id = format!(
        "{}-{}",
        crate::now_ms(),
        NEXT_CAPTURE_ID.fetch_add(1, Ordering::Relaxed)
    );
    let sample_rate = 48_000;
    let channels = 2;
    let mut args = vec![
        "--format".to_string(),
        "f32le".to_string(),
        "--sample-rate".to_string(),
        sample_rate.to_string(),
        "--channels".to_string(),
        channels.to_string(),
        "--include-child-processes".to_string(),
    ];

    if let Some(process_id) = process_id {
        args.push("--pid".to_string());
        args.push(process_id.to_string());
    } else if let Some(hwnd) = hwnd {
        args.push("--hwnd".to_string());
        args.push(hwnd.to_string());
    }

    let mut command = Command::new(&helper_path);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return json!({
                "ok": false,
                "reason": "spawn-failed",
                "message": format!("Failed to start Windows app audio capture helper: {error}"),
            });
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    app.state::<crate::AppState>()
        .app_audio
        .insert(capture_id.clone(), Arc::clone(&child));

    emit_app_audio_status(
        app,
        &capture_id,
        format!(
            "info: spawn helper={} sourceId={} hwnd={} processId={} args={}",
            helper_path.to_string_lossy(),
            opts.get("sourceId").and_then(Value::as_str).unwrap_or(""),
            hwnd.map(|value| value.to_string())
                .unwrap_or_else(|| "null".to_string()),
            process_id
                .map(|value| value.to_string())
                .unwrap_or_else(|| "null".to_string()),
            args.join(" ")
        ),
    );

    if let Some(stdout) = stdout {
        spawn_app_audio_stdout_reader(app.clone(), capture_id.clone(), stdout);
    }
    if let Some(stderr) = stderr {
        spawn_app_audio_stderr_reader(app.clone(), capture_id.clone(), stderr);
    }
    spawn_app_audio_waiter(app.clone(), capture_id.clone(), child);

    json!({
        "ok": true,
        "captureId": capture_id,
        "sampleRate": sample_rate,
        "channels": channels,
    })
}

pub fn app_audio_capture_stop(app: &AppHandle, capture_id: Value) -> Value {
    let capture_id = capture_id.as_str().unwrap_or_default().to_string();
    if let Some(child) = app.state::<crate::AppState>().app_audio.remove(&capture_id) {
        if let Ok(mut child) = child.lock() {
            let _ = child.kill();
        }
    }
    json!({ "ok": true })
}

fn parse_desktop_source_window_id(source_id: &str) -> Option<u64> {
    if !source_id.starts_with("window:") {
        return None;
    }
    source_id
        .split(':')
        .nth(1)
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|value| *value > 0)
}

fn app_audio_helper_path(app: &AppHandle) -> Option<PathBuf> {
    if !cfg!(target_os = "windows") {
        return None;
    }

    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.extend(helper_candidates_from_root(resource_dir));
    }
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            candidates.extend(helper_candidates_from_root(parent.to_path_buf()));
        }
    }
    if let Ok(current_dir) = std::env::current_dir() {
        candidates.extend(helper_candidates_from_root(current_dir.clone()));
        if let Some(parent) = current_dir.parent() {
            candidates.extend(helper_candidates_from_root(parent.to_path_buf()));
        }
        if let Some(grandparent) = current_dir.parent().and_then(|parent| parent.parent()) {
            candidates.extend(helper_candidates_from_root(grandparent.to_path_buf()));
        }
    }

    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn helper_candidates_from_root(root: PathBuf) -> Vec<PathBuf> {
    let helper = PathBuf::from("CatRealmAppAudioCapture.exe");
    vec![
        root.join("CatRealmAppAudioCapture.exe"),
        root.join("native")
            .join("win-app-audio")
            .join("bin")
            .join(&helper),
        root.join("native").join("win-app-audio").join(&helper),
        root.join("electron")
            .join("native")
            .join("win-app-audio")
            .join("bin")
            .join(&helper),
        root.join("electron")
            .join("native")
            .join("win-app-audio")
            .join(&helper),
        root.join("CatRealm-Client")
            .join("electron")
            .join("native")
            .join("win-app-audio")
            .join("bin")
            .join(&helper),
        root.join("CatRealm-Client")
            .join("electron")
            .join("native")
            .join("win-app-audio")
            .join(&helper),
        root.join("..")
            .join("CatRealm-Client")
            .join("electron")
            .join("native")
            .join("win-app-audio")
            .join("bin")
            .join(&helper),
        root.join("..")
            .join("CatRealm-Client")
            .join("electron")
            .join("native")
            .join("win-app-audio")
            .join(&helper),
    ]
}

fn emit_app_audio_status(app: &AppHandle, capture_id: &str, message: impl Into<String>) {
    let _ = app.emit(
        "app-audio-capture-status",
        json!({
            "captureId": capture_id,
            "message": message.into(),
        }),
    );
}

fn spawn_app_audio_stdout_reader(
    app: AppHandle,
    capture_id: String,
    mut stdout: impl Read + Send + 'static,
) {
    thread::spawn(move || {
        let mut buffer = vec![0_u8; 32 * 1024];
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let chunk = general_purpose::STANDARD.encode(&buffer[..count]);
                    let _ = app.emit(
                        "app-audio-capture-data",
                        json!({
                            "captureId": capture_id,
                            "chunkBase64": chunk,
                        }),
                    );
                }
                Err(error) => {
                    emit_app_audio_status(
                        &app,
                        &capture_id,
                        format!("error: stdout read failed: {error}"),
                    );
                    break;
                }
            }
        }
    });
}

fn spawn_app_audio_stderr_reader(
    app: AppHandle,
    capture_id: String,
    mut stderr: impl Read + Send + 'static,
) {
    thread::spawn(move || {
        let mut buffer = vec![0_u8; 4096];
        loop {
            match stderr.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    emit_app_audio_status(
                        &app,
                        &capture_id,
                        String::from_utf8_lossy(&buffer[..count]).to_string(),
                    );
                }
                Err(error) => {
                    emit_app_audio_status(
                        &app,
                        &capture_id,
                        format!("error: stderr read failed: {error}"),
                    );
                    break;
                }
            }
        }
    });
}

fn spawn_app_audio_waiter(app: AppHandle, capture_id: String, child: Arc<Mutex<Child>>) {
    thread::spawn(move || loop {
        let status = {
            let mut child = match child.lock() {
                Ok(child) => child,
                Err(_) => {
                    let _ = app.state::<crate::AppState>().app_audio.remove(&capture_id);
                    let _ = app.emit(
                        "app-audio-capture-stopped",
                        json!({
                            "captureId": capture_id,
                            "code": null,
                            "signal": null,
                            "error": "App audio capture process lock was poisoned.",
                        }),
                    );
                    return;
                }
            };
            child.try_wait()
        };

        match status {
            Ok(Some(exit_status)) => {
                let _ = app.state::<crate::AppState>().app_audio.remove(&capture_id);
                let _ = app.emit(
                    "app-audio-capture-stopped",
                    json!({
                        "captureId": capture_id,
                        "code": exit_status.code(),
                        "signal": null,
                    }),
                );
                return;
            }
            Ok(None) => thread::sleep(Duration::from_millis(200)),
            Err(error) => {
                let _ = app.state::<crate::AppState>().app_audio.remove(&capture_id);
                let _ = app.emit(
                    "app-audio-capture-stopped",
                    json!({
                        "captureId": capture_id,
                        "code": null,
                        "signal": null,
                        "error": error.to_string(),
                    }),
                );
                return;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::v4l2_supports_video_capture;

    #[test]
    fn v4l2_capture_capabilities_include_single_and_multiplanar_devices() {
        assert!(v4l2_supports_video_capture(0x0000_0001, 0));
        assert!(v4l2_supports_video_capture(0x0000_1000, 0));
        assert!(!v4l2_supports_video_capture(0x0000_0002, 0));
    }

    #[test]
    fn v4l2_device_caps_override_aggregate_capabilities() {
        assert!(v4l2_supports_video_capture(0x8000_0000, 0x0000_0001));
        assert!(!v4l2_supports_video_capture(
            0x8000_0001,
            0x0000_0002
        ));
    }
}
