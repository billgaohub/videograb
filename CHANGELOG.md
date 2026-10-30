# Changelog

All notable changes to VideoGrab. Versions follow the extension's
`manifest.json` version.

## [0.1.3] — 2026-10-30

- Added Bilibili resolver: official API chain (view → playurl, HTML5 MP4
  stream), up to 720p on that path.
- Added YouTube resolver: Innertube Android-client request returns
  progressive MP4 streams (typically 360p; higher resolutions are
  adaptive-only and not merged yet).
- Resolvers now also run automatically when a supported page finishes
  loading.
- Firefox build added (see `firefox/` and `build.sh`): background-page
  HLS engine via `firefox-bridge.js`, no Offscreen API required.

## [0.1.2] — 2026-10-30

- Rewritten detection core: browser-level `webRequest` capture combined
  with in-page hooks, multi-source deduplication and quality scoring.
- X/Twitter: resolves the highest-bitrate direct MP4 (up to 4K, with
  audio) through the syndication API.
- Douyin: Referer handling via declarativeNetRequest so the CDN serves
  the media.
- HLS downloads run in an offscreen document (Chrome): they survive the
  popup closing, cache segments for resume, decrypt AES-128, remux TS
  to MP4 with the bundled mux.js, and assemble fMP4 (EXT-X-MAP) streams
  directly.

## [0.1.0] — 2026-10-30

- First MVP: generic MP4/WebM detection and HLS (.m3u8) capture.
- YouTube and DRM-protected services (Netflix, Disney+, Max) excluded
  by design.
