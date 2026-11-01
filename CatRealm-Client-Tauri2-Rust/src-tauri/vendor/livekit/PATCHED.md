# Patched livekit 0.7.53

Vendored from crates.io `livekit` 0.7.53 and wired in through
`[patch.crates-io]` in `src-tauri/Cargo.toml`.

## Why

The upstream SDK has no way to publish a stereo audio track: its
`AddTrackRequest` never sets `stereo` / `TF_STEREO`, so the SFU negotiates
mono Opus and Sushi's screen-share and capture-card audio (captured and fed in
stereo by `screen_publish.rs`) is downmixed.

## Changes

- `src/room/options.rs`: `TrackPublishOptions::stereo` (default `false`).
- `src/room/participant/local_participant.rs`: when `stereo` is set, the add-track
  request carries `stereo = true` and `AudioTrackFeature::TfStereo`.
- `src/lib.rs`: `#![allow(warnings)]`, since a path dependency is built with full
  warnings and upstream's would flood Sushi's build output.

Search for `CatRealm patch` to find every change.

## Upgrading livekit

Re-vendor the new version, re-apply the changes above, and bump the version in
`Cargo.toml`. Drop this copy and the `[patch.crates-io]` entry once upstream
offers a stereo publish option.
