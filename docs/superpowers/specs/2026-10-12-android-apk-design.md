# P5 Manager for Android: the app, and Remote Play from the phone

Date: 2026-10-12

## What this is for

A phone should be able to open P5 Manager and play. Today that means a
browser pointed at the server, where Remote Play arrives as WebRTC or MJPEG
that the server transcodes from p5rp - a detour that costs latency and
breaks when the browser refuses to play H.264 in an insecure context.

The app keeps the management UI as it is on the web and takes Remote Play
off that detour: the phone pairs and streams straight from the console with
libchiaki, the same library the server uses.

## Decisions taken with the user

- A native client built on libchiaki, not a wrapper around the web player.
- The management UI stays what it is on the web, inside the app.
- The app finds the server by a URL the user types, or by a QR code the web
  UI shows.
- The APK is built by GitHub Actions and attached to a release, signed with
  a release key when the repository has one and debug-signed until then.

## How it is put together

```
android/app
  ui/        WebView onto <server>/ - the whole manager, as on the web
  setup/     server list: add by URL or QR, switch, remember
  rp/        Remote Play: discovery, pairing, session, decode, input
  cpp/       JNI over libchiaki (chiaki-ng, the version rpnative pins)
```

- **UI**: one WebView, cleartext allowed for private addresses only, with
  fullscreen video, landscape and a wake lock while a session runs.
- **Server**: `ServerStore` keeps the list in shared preferences. The web UI
  grows a QR code of its own address in Settings for the phone to read.
- **Remote Play**: `ddp` for discovery and wake, `regist` for pairing (PSN
  account id and the PIN, as the server does), then a session whose video
  goes to `MediaCodec` on a `SurfaceView` and whose audio goes to
  `AudioTrack`. Touch controls and a connected gamepad produce the same
  controller state the server's `ChiakiController` builds.
- **Native**: `app/src/main/cpp` builds chiaki-lib through the NDK with the
  same CMake options `rpnative/` uses, and a JNI layer that mirrors
  `p5rp.c`: the session's callbacks become JNI calls, the controller state
  goes the other way.

## Order of work

1. The app itself: Gradle project, WebView, server setup with QR, the CI
   workflow that produces an installable APK. Nothing native yet: Remote
   Play still plays the server's stream, as the browser does today.
2. The native module: chiaki-lib for arm64-v8a, the JNI bridge, pairing and
   a session decoded on the phone. The app switches Remote Play to it and
   keeps the server stream as the fallback.

Stage 1 is a usable app on its own, which is why it comes first; stage 2 is
where the latency goes away.

## What cannot be verified here

This machine has no Android SDK and no device. The CI build is the check
that the project compiles and that an APK comes out; whether a session
really streams has to be tried on the user's phone.

## Out of scope

Play Store distribution, remote (PSN relay) sessions, and anything that
would make the phone a second server.
