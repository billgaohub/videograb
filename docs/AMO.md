# Firefox Add-ons (AMO) submission pack

Why Firefox first among the stores: AMO gives users a normal one-click
install (no developer mode), registration is free (a Firefox Account, no
fee — unlike the Chrome Web Store's $5), and Mozilla's policies do not
ban video downloaders the way the Chrome Web Store bans YouTube
downloading.

## Account & submission checklist

- [ ] Firefox Account created (use the siflie identity, not ONNOK's)
- [ ] Developer agreement accepted at addons.mozilla.org/developers
- [ ] Build the package: `./build.sh` → `release/videograb-firefox-v*.zip`
- [ ] Submit as **Listed** (public). The alternative, unlisted
      self-distribution (AMO only signs the .xpi, siflie.com hosts it),
      keeps zero store exposure but loses AMO search traffic — decide
      after the open-source validation window if listing underperforms.
- [ ] Add-on ID is already pinned in `firefox/manifest.json`
      (`videograb@siflie.com`); do not change it after first submission.
- [ ] License field: GPL-3.0. Privacy policy URL:
      https://siflie.com/videograb/privacy
- [ ] **Source code submission (mandatory here)**: AMO requires source
      for any minified/bundled code. Upload a source zip and paste the
      notes from the "Reviewer notes" section below.

## Listing copy (EN)

**Name**: VideoGrab — Free Video Downloader

**Summary (250 chars)**:
Download videos you are watching: X/Twitter up to 4K with audio, Douyin,
Bilibili, YouTube and most sites (MP4/HLS). Open source, runs 100%
locally, zero data collection.

**Description**:
VideoGrab detects the videos playing in your browser and saves them
locally.

- X/Twitter: highest-bitrate direct MP4, up to 4K, audio included
- Douyin and Bilibili: dedicated resolvers
- YouTube: progressive MP4 streams (typically 360p — higher resolutions
  are adaptive streams and are not merged yet)
- HLS streams: background download with resume, AES-128 support and
  in-browser TS→MP4 remux
- Netflix/Disney+/Max and other DRM-protected services are not
  supported, by design

Privacy: VideoGrab collects no data at all. There is no server and no
analytics; everything is processed locally in your browser, and the
full source code is public under GPL-3.0.

Please only download content you have the right to save, and respect
each site's terms of service and your local copyright law.

## Listing copy (中文)

**摘要**：下载你正在看的视频：X/Twitter 最高 4K 带声音、抖音、
Bilibili、YouTube 与绝大多数站点的 MP4/HLS 流。开源、纯本地运行、
零数据收集。

## Reviewer notes (paste into the AMO source-submission form)

> All first-party code is original and unminified, and is identical to
> the public repository: <REPO URL>. The Firefox package is produced by
> `build.sh` in that repo: it copies the root sources, replaces
> `manifest.json` with `firefox/manifest.json`, and adds
> `firefox/firefox-bridge.js`.
>
> One bundled third-party file is minified: `mux.min.js` is mux.js
> v6.3.0 (Apache-2.0), the official prebuilt `dist/mux.min.js` from
> https://github.com/videojs/mux.js — unmodified. Its full source is
> that repository at tag v6.3.0. See `THIRD-PARTY-NOTICES.md`.
>
> Firefox differences: Firefox has no chrome.offscreen API, so the
> manifest loads the HLS engine (`offscreen.js`) into the background
> page and `firefox-bridge.js` routes its messages; `background.js`
> branches on `chrome.offscreen` in exactly two places
> (ensureOffscreenDocument and the START_HLS dispatch). Everything else
> is shared with the Chrome build.
>
> Testing: install, open a page with an HTML5 video (e.g. the
> W3Schools HTML5 video page), press play, click the toolbar icon —
> the playing video is listed and downloads as MP4. On x.com, opening
> a post with a video resolves the highest-quality MP4 automatically.
> No account or test credentials are needed. The extension collects no
> user data; the only network calls go to the video platforms
> themselves.

## Known AMO review risks

- `<all_urls>` host permission + `webRequest`: justification = the
  extension's single purpose is detecting media on whatever site the
  user is watching; it filters by extension/Content-Type and stores
  matches per-tab only, in session storage.
- `declarativeNetRequest` Referer rules: justification = several CDNs
  refuse to serve the media file unless the Referer matches the page
  the user is playing it on.
- Expect a manual review round because of the permission set; the
  reviewer notes above are written to answer it pre-emptively.

## Validator notes (added 2026-10-30 after first validation run)

- The Firefox manifest declares
  `browser_specific_settings.gecko.data_collection_permissions:
  {required: ["none"]}` — mandatory for new AMO add-ons since Nov 2025 —
  and `strict_min_version` is 140.0 (the first version supporting that
  key).
- The validator warning "offscreen.createDocument is not supported" is
  expected and harmless: the call sits behind a `chrome.offscreen`
  feature check and never executes in Firefox (the background-page
  bridge handles HLS instead). Verified locally with the same
  addons-linter AMO uses: 0 errors.
