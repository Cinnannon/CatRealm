// Native screen-share publishing for realms without WHIP ingress (e.g. realms
// on CatRealm Central LiveKit fallback). GStreamer captures and GPU-encodes
// H.264 (see capture::spawn_encoded_screen_capture); this module joins the
// LiveKit room with a screen-only token from the realm's /api/media/screen-token
// and publishes the encoded frames directly, so nothing transcodes server-side.
// Voice stays in the WebView; this is a second participant identified as
// catrealm-ingress:<userId>:screen:<channelId>, which clients already render
// as that user's screen share.

use serde_json::{json, Value};
use tauri::AppHandle;

/// Splits an Annex-B H.264 byte stream into access units (frames).
///
/// Boundaries come from the slices themselves, so encoders that do not emit
/// access-unit delimiters (e.g. mfh264enc) still split correctly: a new frame
/// starts at any non-VCL NAL (SEI/SPS/PPS/AUD) after a slice, or at a slice
/// whose first_mb_in_slice is 0. A frame is emitted as soon as the header of
/// the next frame's first NAL arrives, so it adds no extra frame of latency.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Default)]
pub(crate) struct AccessUnitSplitter {
    pending: Vec<u8>,
    au: Vec<u8>,
    au_has_slice: bool,
    au_is_key: bool,
    // The NAL at the front of `pending` has already been checked for a frame boundary.
    front_classified: bool,
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const MAX_PENDING_BYTES: usize = 8 * 1024 * 1024;

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn find_start_code(data: &[u8], from: usize) -> Option<(usize, usize)> {
    let mut index = from;
    while index + 3 <= data.len() {
        if data[index] == 0 && data[index + 1] == 0 && data[index + 2] == 1 {
            return Some(if index > from && data[index - 1] == 0 { (index - 1, 4) } else { (index, 3) });
        }
        index += 1;
    }
    None
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
impl AccessUnitSplitter {
    /// Feeds encoder output; calls `emit(frame, is_keyframe)` per complete frame.
    pub(crate) fn push(&mut self, data: &[u8], emit: &mut impl FnMut(&[u8], bool)) {
        self.pending.extend_from_slice(data);
        if self.pending.len() > MAX_PENDING_BYTES {
            self.pending.clear();
            self.front_classified = false;
        }
        loop {
            let Some((start, prefix)) = find_start_code(&self.pending, 0) else { return };
            if start > 0 {
                // Bytes before the first start code belong to no NAL.
                self.pending.drain(..start);
                continue;
            }
            if !self.front_classified {
                let Some(&header) = self.pending.get(prefix) else { return };
                let nal_type = header & 0x1f;
                let is_slice = (1..=5).contains(&nal_type);
                // first_mb_in_slice is ue(v); a value of 0 encodes as a leading 1 bit.
                let first_slice = if is_slice {
                    let Some(&byte) = self.pending.get(prefix + 1) else { return };
                    byte & 0x80 != 0
                } else {
                    false
                };
                if self.au_has_slice && (matches!(nal_type, 6..=9) || first_slice) {
                    emit(&self.au, self.au_is_key);
                    self.au.clear();
                    self.au_has_slice = false;
                    self.au_is_key = false;
                }
                self.front_classified = true;
            }
            let Some((end, _)) = find_start_code(&self.pending, prefix) else { return };
            let nal_type = self.pending[prefix] & 0x1f;
            self.au.extend_from_slice(&self.pending[..end]);
            if (1..=5).contains(&nal_type) {
                self.au_has_slice = true;
                self.au_is_key |= nal_type == 5;
            }
            self.pending.drain(..end);
            self.front_classified = false;
        }
    }
}

#[cfg(all(target_os = "windows", feature = "native-voice"))]
mod imp {
    use super::*;
    use livekit::options::{AudioEncoding, TrackPublishOptions, VideoCodec, VideoEncoderBackend, VideoEncoding};
    use livekit::prelude::*;
    use livekit::webrtc::audio_frame::AudioFrame;
    use livekit::webrtc::audio_source::{native::NativeAudioSource, AudioSourceOptions, RtcAudioSource};
    use livekit::webrtc::video_frame::{EncodedFrameType, EncodedVideoCodec, EncodedVideoFrame};
    use livekit::webrtc::video_source::{native::NativeVideoSource, RtcVideoSource, VideoResolution};
    use std::io::Read;
    use std::process::Child;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use tauri::Emitter;

    struct Publisher {
        room: Room,
        child: Arc<Mutex<Child>>,
        feed: tauri::async_runtime::JoinHandle<()>,
        events: tauri::async_runtime::JoinHandle<()>,
        // Set before a deliberate teardown so the feed thread, which only
        // notices once GStreamer's stdout closes, doesn't report the share
        // as ended underneath a replacement publisher.
        stopping: Arc<AtomicBool>,
        // The share's audio (capture card input, desktop or app loopback) as
        // raw PCM from a second GStreamer process, when the share has any.
        audio: Option<AudioFeed>,
    }

    struct AudioFeed {
        child: Arc<Mutex<Child>>,
        feed: tauri::async_runtime::JoinHandle<()>,
    }

    const AUDIO_SAMPLE_RATE: u32 = 48_000;
    const AUDIO_CHANNELS: u32 = 2;
    const AUDIO_FRAME_SAMPLES: u32 = AUDIO_SAMPLE_RATE / 100; // 10 ms

    fn feed_audio(child: Arc<Mutex<Child>>, source: NativeAudioSource) {
        let Some(mut stdout) = child.lock().unwrap().stdout.take() else { return };
        let mut bytes = vec![0u8; (AUDIO_FRAME_SAMPLES * AUDIO_CHANNELS * 2) as usize];
        while stdout.read_exact(&mut bytes).is_ok() {
            let samples: Vec<i16> = bytes.chunks_exact(2).map(|pair| i16::from_le_bytes([pair[0], pair[1]])).collect();
            let frame = AudioFrame {
                data: samples.into(),
                sample_rate: AUDIO_SAMPLE_RATE,
                num_channels: AUDIO_CHANNELS,
                samples_per_channel: AUDIO_FRAME_SAMPLES,
            };
            if tauri::async_runtime::block_on(source.capture_frame(&frame)).is_err() {
                break;
            }
        }
    }

    #[derive(Default)]
    pub struct ScreenPublishService {
        current: Mutex<Option<Publisher>>,
        // Held for a whole start/stop. A start takes seconds (connect, publish,
        // first frame), and two overlapping starts would both connect with the
        // same identity: LiveKit kicks one (DuplicateIdentity) and its
        // GStreamer process is orphaned when `current` is overwritten.
        op: tauri::async_runtime::Mutex<()>,
    }

    fn kill(child: &Arc<Mutex<Child>>) {
        let mut child = child.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }

    fn feed_frames(
        app: AppHandle,
        child: Arc<Mutex<Child>>,
        source: NativeVideoSource,
        resolution: VideoResolution,
        started_tx: std::sync::mpsc::Sender<()>,
        stopping: Arc<AtomicBool>,
    ) {
        let Some(mut stdout) = child.lock().unwrap().stdout.take() else { return };
        let started = std::time::Instant::now();
        let mut splitter = AccessUnitSplitter::default();
        let mut chunk = [0u8; 64 * 1024];
        let mut started_tx = Some(started_tx);
        // Viewer feedback the pass-through encoder raises (PLI/FIR keyframe
        // requests, bandwidth-estimate targets). GStreamer runs out of process
        // and can't act on it yet, so for now it is only reported.
        let mut keyframe_requests = 0u32;
        let mut rate_target_bps: Option<u64> = None;
        let mut frames = 0u32;
        let mut last_report = std::time::Instant::now();
        loop {
            let read = match stdout.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            if source.take_keyframe_request() {
                keyframe_requests += 1;
            }
            if let Some(rate) = source.take_rate_control_request() {
                rate_target_bps = Some(rate.target_bitrate_bps);
            }
            if last_report.elapsed() >= std::time::Duration::from_secs(5) {
                crate::commands::diagnostics::voice_debug_log(app.clone(), json!({
                    "at": crate::now_ms(),
                    "level": if keyframe_requests > 0 { "warn" } else { "info" },
                    "scope": "native-screen-publish",
                    "message": "encoder feedback",
                    "details": {
                        "framesSent": frames,
                        "keyframeRequests": keyframe_requests,
                        "rateTargetBps": rate_target_bps,
                    },
                }));
                keyframe_requests = 0;
                frames = 0;
                last_report = std::time::Instant::now();
            }
            splitter.push(&chunk[..read], &mut |frame, key| {
                let accepted = source.capture_encoded_frame(&EncodedVideoFrame {
                    codec: EncodedVideoCodec::H264,
                    payload: frame,
                    timestamp_us: started.elapsed().as_micros().min(i64::MAX as u128) as i64,
                    frame_type: if key { EncodedFrameType::Key } else { EncodedFrameType::Delta },
                    resolution: resolution.clone(),
                    frame_metadata: None,
                });
                if accepted {
                    frames += 1;
                    if let Some(tx) = started_tx.take() {
                        let _ = tx.send(());
                    }
                }
            });
        }
        if !stopping.load(Ordering::SeqCst) {
            let _ = app.emit("native-screen-publish-stopped", json!({ "reason": "capture-ended" }));
        }
    }

    impl ScreenPublishService {
        pub async fn start(&self, app: AppHandle, opts: Value) -> Value {
            let _op = self.op.lock().await;
            self.stop_current().await;
            let (Some(url), Some(token)) = (
                opts.get("url").and_then(Value::as_str).map(str::to_string),
                opts.get("token").and_then(Value::as_str).map(str::to_string),
            ) else {
                return json!({ "ok": false, "reason": "bad-options", "message": "Missing LiveKit url or token." });
            };
            let fps = opts.get("fps").and_then(Value::as_u64).unwrap_or(60).clamp(5, 60) as u32;
            let height = (opts.get("height").and_then(Value::as_u64).unwrap_or(1080).clamp(180, 2160) as u32) & !1;
            let width = (opts.get("width").and_then(Value::as_u64).unwrap_or(u64::from(height) * 16 / 9).clamp(320, 3840) as u32) & !1;
            let bitrate = opts.get("bitrate").and_then(Value::as_u64).unwrap_or(8_000_000).clamp(500_000, 50_000_000);
            // The encoder must output exactly the resolution we announce.
            let mut capture_opts = opts.clone();
            capture_opts["width"] = json!(width);
            capture_opts["height"] = json!(height);
            capture_opts["fps"] = json!(fps);

            let mut room_options = RoomOptions::default();
            room_options.auto_subscribe = false;
            let (room, mut room_events) = match Room::connect(&url, &token, room_options).await {
                Ok(connected) => connected,
                Err(err) => return json!({ "ok": false, "reason": "connect-failed", "message": err.to_string() }),
            };

            let resolution = VideoResolution { width, height };
            let source = NativeVideoSource::new_encoded(resolution.clone());
            let track = LocalVideoTrack::create_video_track(
                &format!("catrealm:screen-share-video:{height}p{fps}"),
                RtcVideoSource::Native(source.clone()),
            );
            let publication = match room.local_participant().publish_track(
                LocalTrack::Video(track),
                TrackPublishOptions {
                    source: TrackSource::Screenshare,
                    // Without this the SDK picks its largest screenshare preset
                    // (1080p30 at 3 Mbps). Pre-encoded frames can't be
                    // re-encoded to fit, so WebRTC drops whole frames instead:
                    // a 14 Mbps 60 fps encode arrived at ~13 fps.
                    video_encoding: Some(VideoEncoding { max_bitrate: bitrate, max_framerate: f64::from(fps) }),
                    simulcast: false,
                    video_codec: VideoCodec::H264,
                    video_encoder: VideoEncoderBackend::PreEncoded,
                    ..Default::default()
                },
            ).await {
                Ok(publication) => publication,
                Err(err) => {
                    let _ = room.close().await;
                    return json!({ "ok": false, "reason": "publish-failed", "message": err.to_string() });
                }
            };

            let child = match crate::capture::spawn_encoded_screen_capture(&capture_opts) {
                Ok(child) => Arc::new(Mutex::new(child)),
                Err(message) => {
                    let _ = room.close().await;
                    return json!({ "ok": false, "reason": "capture-failed", "message": message });
                }
            };
            let (started_tx, started_rx) = std::sync::mpsc::channel();
            let stopping = Arc::new(AtomicBool::new(false));
            let feed_app = app.clone();
            let feed_child = child.clone();
            let feed_resolution = resolution.clone();
            let feed_stopping = stopping.clone();
            let feed = tauri::async_runtime::spawn_blocking(move || {
                feed_frames(feed_app, feed_child, source, feed_resolution, started_tx, feed_stopping)
            });
            let events_app = app.clone();
            let events_stopping = stopping.clone();
            let events = tauri::async_runtime::spawn(async move {
                while let Some(event) = room_events.recv().await {
                    if let RoomEvent::Disconnected { reason } = event {
                        if events_stopping.load(Ordering::SeqCst) {
                            break;
                        }
                        let _ = events_app.emit(
                            "native-screen-publish-stopped",
                            json!({ "reason": "disconnected", "detail": format!("{reason:?}") }),
                        );
                        break;
                    }
                }
            });

            let started = tauri::async_runtime::spawn_blocking(move || {
                started_rx.recv_timeout(std::time::Duration::from_secs(5)).is_ok()
            }).await.unwrap_or(false);
            let mut publisher = Publisher { room, child, feed, events, stopping, audio: None };
            if !started {
                Self::teardown(publisher).await;
                return json!({ "ok": false, "reason": "no-video-frames", "message": "GStreamer produced no H.264 frames within 5 seconds." });
            }
            publisher.audio = Self::start_audio(&app, &publisher.room, &capture_opts).await;
            let has_audio = publisher.audio.is_some();
            *self.current.lock().unwrap() = Some(publisher);
            json!({
                "ok": true, "trackSid": publication.sid().to_string(),
                "width": width, "height": height, "fps": fps, "codec": "h264", "encoder": "pre-encoded",
                "audio": has_audio,
            })
        }

        // Publishes the share's audio from the same screen identity, which
        // viewers already pair with its video. Best-effort: a share whose
        // audio can't start still goes out silent rather than failing.
        async fn start_audio(app: &AppHandle, room: &Room, opts: &Value) -> Option<AudioFeed> {
            let wanted = opts.get("includeAudio").and_then(Value::as_bool).unwrap_or(false)
                || opts.get("audioDeviceLabel").and_then(Value::as_str).is_some_and(|label| !label.trim().is_empty());
            if !wanted {
                return None;
            }
            let report = |message: &str, detail: Value| {
                crate::commands::diagnostics::voice_debug_log(app.clone(), json!({
                    "at": crate::now_ms(), "level": "warn", "scope": "native-screen-publish",
                    "message": message, "details": detail,
                }));
            };
            let child = match crate::capture::spawn_raw_audio_capture(opts) {
                Ok(Some(child)) => Arc::new(Mutex::new(child)),
                Ok(None) => {
                    report("audio unavailable", json!({ "captureMode": opts.get("captureMode"), "audioDeviceLabel": opts.get("audioDeviceLabel") }));
                    return None;
                }
                Err(message) => {
                    report("audio capture failed", json!({ "message": message }));
                    return None;
                }
            };
            let source = NativeAudioSource::new(
                AudioSourceOptions { echo_cancellation: false, noise_suppression: false, auto_gain_control: false },
                AUDIO_SAMPLE_RATE,
                AUDIO_CHANNELS,
                100,
            );
            let kind = if opts.get("captureMode").and_then(Value::as_str) == Some("window-wgc") { "app" } else { "system" };
            let track = LocalAudioTrack::create_audio_track(
                &format!("catrealm:screen-share-audio:{kind}"),
                RtcAudioSource::Native(source.clone()),
            );
            if let Err(err) = room.local_participant().publish_track(
                LocalTrack::Audio(track),
                TrackPublishOptions {
                    source: TrackSource::ScreenshareAudio,
                    // Same Opus rate as the WHIP path's audio branch.
                    audio_encoding: Some(AudioEncoding { max_bitrate: 128_000 }),
                    // Game and desktop audio is stereo; without this the SFU
                    // negotiates mono Opus (vendored livekit patch).
                    stereo: true,
                    dtx: false,
                    red: false,
                    ..Default::default()
                },
            ).await {
                kill(&child);
                report("audio publish failed", json!({ "message": err.to_string() }));
                return None;
            }
            let feed_child = child.clone();
            let feed = tauri::async_runtime::spawn_blocking(move || feed_audio(feed_child, source));
            Some(AudioFeed { child, feed })
        }

        async fn teardown(publisher: Publisher) {
            publisher.stopping.store(true, Ordering::SeqCst);
            kill(&publisher.child);
            publisher.feed.abort();
            if let Some(audio) = &publisher.audio {
                kill(&audio.child);
                audio.feed.abort();
            }
            publisher.events.abort();
            let _ = publisher.room.close().await;
        }

        async fn stop_current(&self) -> bool {
            let current = self.current.lock().unwrap().take();
            let stopped = current.is_some();
            if let Some(publisher) = current {
                Self::teardown(publisher).await;
            }
            stopped
        }

        pub async fn stop(&self) -> Value {
            let _op = self.op.lock().await;
            json!({ "ok": true, "stopped": self.stop_current().await })
        }
    }
}

#[cfg(not(all(target_os = "windows", feature = "native-voice")))]
mod imp {
    use super::*;

    #[derive(Default)]
    pub struct ScreenPublishService;

    impl ScreenPublishService {
        pub async fn start(&self, _app: AppHandle, _opts: Value) -> Value {
            json!({ "ok": false, "reason": "unsupported", "message": "Native screen publishing is Windows-only." })
        }

        pub async fn stop(&self) -> Value {
            json!({ "ok": true, "stopped": false })
        }
    }
}

pub use imp::ScreenPublishService;

pub fn support() -> Value {
    if !cfg!(feature = "native-voice") {
        return json!({ "ok": false, "reason": "unsupported", "message": "Built without the native LiveKit backend." });
    }
    crate::capture::encoded_screen_capture_support()
}

#[cfg(test)]
mod tests {
    use super::AccessUnitSplitter;

    const SPS: &[u8] = &[0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1f];
    const PPS: &[u8] = &[0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80];
    const AUD: &[u8] = &[0, 0, 0, 1, 0x09, 0xf0];
    // Real NAL units never end in 0x00 (rbsp_trailing_bits), so fixtures do not either.
    const IDR: &[u8] = &[0, 0, 1, 0x65, 0x88, 0x84, 0x10];
    const SLICE: &[u8] = &[0, 0, 1, 0x41, 0x9a, 0x02, 0x03];
    // A second slice of the same frame: first_mb_in_slice != 0.
    const SLICE_CONT: &[u8] = &[0, 0, 1, 0x41, 0x40, 0x11, 0x22];

    fn split(stream: &[u8], chunk: usize) -> Vec<(Vec<u8>, bool)> {
        let mut splitter = AccessUnitSplitter::default();
        let mut frames = Vec::new();
        for piece in stream.chunks(chunk) {
            splitter.push(piece, &mut |frame, key| frames.push((frame.to_vec(), key)));
        }
        frames
    }

    #[test]
    fn splits_frames_without_access_unit_delimiters() {
        let stream = [SPS, PPS, IDR, SLICE, SLICE_CONT, SLICE, SPS].concat();
        for chunk in [1, 3, 7, 4096] {
            let frames = split(&stream, chunk);
            assert_eq!(frames.len(), 3, "chunk size {chunk}");
            assert_eq!(frames[0], ([SPS, PPS, IDR].concat(), true));
            assert_eq!(frames[1], ([SLICE, SLICE_CONT].concat(), false));
            assert_eq!(frames[2], (SLICE.to_vec(), false));
        }
    }

    #[test]
    fn splits_frames_with_access_unit_delimiters() {
        let stream = [AUD, SPS, PPS, IDR, AUD, SLICE, AUD].concat();
        let frames = split(&stream, 5);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0], ([AUD, SPS, PPS, IDR].concat(), true));
        assert_eq!(frames[1], ([AUD, SLICE].concat(), false));
    }

    #[test]
    fn skips_garbage_before_the_first_start_code() {
        let stream = [&[0xde, 0xad, 0xbe][..], IDR, SLICE, SLICE].concat();
        let frames = split(&stream, 2);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0], (IDR.to_vec(), true));
    }
}
