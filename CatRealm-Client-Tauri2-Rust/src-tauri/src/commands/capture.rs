use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(any(target_os = "windows", test))]
use base64::{engine::general_purpose, Engine as _};
#[cfg(target_os = "windows")]
use std::process::Stdio;
#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

#[tauri::command]
pub async fn desktop_sources(app: AppHandle, opts: Value) -> Value {
    tauri::async_runtime::spawn_blocking(move || crate::capture::desktop_sources(&app, opts))
        .await
        .unwrap_or_else(|_| json!([]))
}

#[tauri::command]
pub async fn list_screenshare_gpus() -> Value {
    tauri::async_runtime::spawn_blocking(crate::capture::list_screenshare_gpus)
        .await
        .unwrap_or_else(|_| json!({ "gpus": [], "encoders": [] }))
}

#[tauri::command]
pub async fn list_video_capture_devices() -> Value {
    tauri::async_runtime::spawn_blocking(crate::capture::list_video_capture_devices)
        .await
        .unwrap_or_else(|_| json!([]))
}

#[tauri::command]
pub fn desktop_audio_capture_support(app: AppHandle) -> Value {
    crate::capture::desktop_audio_capture_support(&app)
}

#[tauri::command]
pub async fn native_whip_publisher_support(opts: Value) -> Value {
    tauri::async_runtime::spawn_blocking(move || crate::capture::whip_publisher_support(opts))
        .await
        .unwrap_or_else(|_| {
            json!({
                "ok": false,
                "reason": "Native publisher support probe failed.",
            })
        })
}

#[tauri::command]
pub fn native_whip_publisher_start(app: AppHandle, opts: Value) -> Value {
    crate::capture::whip_publisher_start(&app, opts)
}

#[tauri::command]
pub fn native_screen_publish_support() -> Value {
    crate::screen_publish::support()
}

#[tauri::command]
pub async fn native_screen_publish_start(app: AppHandle, opts: Value) -> Value {
    let state = app.state::<crate::AppState>();
    state.screen_publish.start(app.clone(), opts).await
}

#[tauri::command]
pub async fn native_screen_publish_stop(app: AppHandle) -> Value {
    app.state::<crate::AppState>().screen_publish.stop().await
}

#[tauri::command]
pub fn native_whip_publisher_stop(app: AppHandle, publisher_id: Value) -> Value {
    crate::capture::whip_publisher_stop(&app, publisher_id)
}

#[tauri::command]
pub fn app_audio_capture_start(app: AppHandle, opts: Value) -> Value {
    crate::capture::app_audio_capture_start(&app, opts)
}

#[tauri::command]
pub fn app_audio_capture_stop(app: AppHandle, capture_id: Value) -> Value {
    crate::capture::app_audio_capture_stop(&app, capture_id)
}

fn emit_firewall_status(app: &AppHandle, level: &str, message: &str) {
    let _ = app.emit(
        "screenshare-firewall-rule-status",
        json!({
            "at": crate::now_ms(),
            "level": level,
            "message": message,
        }),
    );
}

#[cfg(any(target_os = "windows", test))]
fn powershell_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(any(target_os = "windows", test))]
fn encode_powershell(script: &str) -> String {
    let utf16le = script
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    general_purpose::STANDARD.encode(utf16le)
}

#[cfg(target_os = "windows")]
fn run_elevated_firewall_repair(app: &AppHandle) -> Value {
    const RULE_NAME: &str = "CatRealm Screenshare Publisher";
    const TIMEOUT: Duration = Duration::from_secs(120);

    emit_firewall_status(app, "info", "Looking for the bundled CatRealm screenshare publisher...");
    let Some(program_path) = crate::capture::screenshare_publisher_program() else {
        emit_firewall_status(app, "error", "CatRealm screenshare publisher was not found.");
        return json!({
            "ok": false,
            "reason": "missing-streamer",
            "message": "CatRealmStreamer.exe or gst-launch-1.0.exe was not found. Rebuild the GStreamer runtime or use a packaged desktop build.",
        });
    };
    let program = program_path.to_string_lossy().into_owned();
    emit_firewall_status(app, "info", &format!("Found publisher: {program}"));

    let inner_script = format!(
        r#"
$ErrorActionPreference = 'Stop'
$program = {program}
$displayName = {rule_name}
if (-not (Test-Path -LiteralPath $program -PathType Leaf)) {{
  throw "CatRealm screenshare publisher was not found at $program"
}}
$existingRules = @(Get-NetFirewallRule -DisplayName $displayName -ErrorAction SilentlyContinue)
if ($existingRules.Count -gt 0) {{
  $existingRules | Remove-NetFirewallRule
}}
New-NetFirewallRule -DisplayName $displayName -Direction Inbound -Action Allow -Program $program -Profile Private,Public -Enabled True -Description 'Allows the CatRealm screenshare publisher to receive WebRTC/WHIP traffic.' | Out-Null
$createdRule = Get-NetFirewallRule -DisplayName $displayName -ErrorAction Stop | Select-Object -First 1
if (-not $createdRule -or $createdRule.Enabled -ne 'True') {{
  throw 'The firewall rule was created but could not be verified.'
}}
"#,
        program = powershell_literal(&program),
        rule_name = powershell_literal(RULE_NAME),
    );
    let encoded_inner = encode_powershell(&inner_script);
    let outer_script = format!(
        r#"
$ErrorActionPreference = 'Stop'
try {{
  $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','{encoded_inner}')
  exit $process.ExitCode
}} catch {{
  Write-Error $_.Exception.Message
  exit 1
}}
"#,
    );

    emit_firewall_status(app, "info", "Opening Windows administrator approval prompt.");
    let mut command = crate::hidden_powershell();
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encode_powershell(&outer_script),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = format!("Could not open Windows administrator approval: {error}");
            emit_firewall_status(app, "error", &message);
            return json!({ "ok": false, "reason": "spawn-failed", "message": message });
        }
    };

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() < TIMEOUT => std::thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("Timed out waiting for Windows administrator approval.".to_string());
            }
            Err(error) => break Err(format!("Could not wait for firewall repair: {error}")),
        }
    };

    match status {
        Ok(status) if status.success() => {
            let _ = child.wait_with_output();
            emit_firewall_status(app, "success", "Firewall rule added for CatRealm Screenshare Publisher.");
            json!({ "ok": true, "ruleName": RULE_NAME, "programPath": program })
        }
        Ok(_) => {
            let detail = child.wait_with_output().ok()
                .and_then(|output| {
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    (!stderr.is_empty()).then_some(stderr).or_else(|| (!stdout.is_empty()).then_some(stdout))
                });
            let message = detail.unwrap_or_else(|| {
                "Windows did not apply the firewall rule. The administrator prompt may have been cancelled.".to_string()
            });
            emit_firewall_status(app, "error", &message);
            json!({ "ok": false, "reason": "failed", "message": message })
        }
        Err(message) => {
            emit_firewall_status(app, "error", &message);
            json!({ "ok": false, "reason": "failed", "message": message })
        }
    }
}

#[tauri::command]
pub async fn fix_screenshare_firewall_rule(app: AppHandle) -> Value {
    #[cfg(target_os = "windows")]
    {
        let task_app = app.clone();
        return tauri::async_runtime::spawn_blocking(move || run_elevated_firewall_repair(&task_app))
            .await
            .unwrap_or_else(|error| {
                let message = format!("Firewall repair task failed: {error}");
                emit_firewall_status(&app, "error", &message);
                json!({ "ok": false, "reason": "task-failed", "message": message })
            });
    }

    #[cfg(not(target_os = "windows"))]
    {
        let message = "Stream firewall rules are only available on Windows.";
        emit_firewall_status(&app, "error", message);
        json!({ "ok": false, "reason": "unsupported", "message": message })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn powershell_literals_escape_single_quotes() {
        assert_eq!(powershell_literal("C:\\It's Here\\streamer.exe"), "'C:\\It''s Here\\streamer.exe'");
    }

    #[test]
    fn powershell_encoding_is_utf16le_base64() {
        assert_eq!(encode_powershell("A"), "QQA=");
    }
}
