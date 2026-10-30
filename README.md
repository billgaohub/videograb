# VideoGrab — Free Video Downloader

An open-source browser extension that detects videos playing in your
browser and downloads them: X/Twitter in up to 4K with audio, Douyin,
Bilibili, YouTube, plus generic MP4/WebM and HLS streams on most sites.

Everything runs locally in your browser. No accounts, no uploads, no
tracking, no data collection of any kind — the code is right here, audit
it yourself.

License: GPL-3.0 · Status: beta (v0.1.3) · 中文说明见下方

## Features

- **Network-level detection** — watches media requests at the browser
  level (not just the page DOM), merges duplicates from every source and
  ranks them by quality, so the popup shows one clean best entry per
  video.
- **X/Twitter in full quality** — resolves the highest-bitrate direct
  MP4 (up to 4K, audio included) instead of the split audio/video HLS
  tracks most downloaders hand you.
- **Douyin & Bilibili resolvers** — platform APIs plus the Referer
  handling their CDNs require.
- **YouTube progressive streams** — downloads the combined audio+video
  MP4 the player API offers (see limitations: usually 360p).
- **Real HLS support** — background downloads that survive closing the
  popup, segment caching with resume, AES-128 decryption, TS→MP4 remux
  and fMP4 assembly, all in-browser.
- **Zero data collection** — no analytics, no remote servers, no remote
  code. The only network requests are to the video platforms themselves,
  to fetch the media and metadata for the page you are on.

## Supported sites & honest ceilings

| Site | What you get | Ceiling |
|---|---|---|
| X/Twitter | Direct MP4, highest bitrate | Up to 4K, with audio |
| Douyin | Direct MP4 via resolver + Referer handling | Best stream the page offers |
| Bilibili | Merged MP4 via official API | 720p on the HTML5 path |
| YouTube | Progressive MP4 (audio+video combined) | Usually 360p — 720p+ is adaptive-only |
| Most other sites | Generic MP4/WebM + HLS detection | Whatever the page plays |
| Netflix / Disney+ / Max | **Not supported** | DRM — out of scope by design |

## Install

### Chrome / Edge / Chromium

VideoGrab is not on the Chrome Web Store (store policy does not allow
listing extensions that download from YouTube), so it is installed from
GitHub:

1. Download this repository as a ZIP (green **Code** button →
   **Download ZIP**) — or clone it — and unzip it.
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped folder.
4. Pin VideoGrab, open a page with a video, press play, click the icon.

### Firefox

Install from Firefox Add-ons (AMO) once the listing is live — search
"VideoGrab" on addons.mozilla.org. For a manual test install meanwhile:
download `videograb-firefox-v*.zip`, then in Firefox open
`about:debugging` → **This Firefox** → **Load Temporary Add-on** and
pick the zip. (Temporary add-ons are removed when Firefox restarts;
the AMO build does not have this limitation.)

## How it works

- `inject.js` / `content.js` observe the page (fetch/XHR hooks,
  Performance entries) for media URLs.
- `background.js` adds browser-level `webRequest` capture, deduplicates
  and quality-ranks candidates, and runs the platform resolvers
  (X syndication API, Bilibili web API, YouTube Innertube).
- HLS downloads run in an offscreen document on Chrome
  (`offscreen.js` + bundled mux.js for TS→MP4 remux). Firefox has no
  Offscreen API, so the Firefox build loads the same engine into the
  background page via `firefox/firefox-bridge.js`.
- `declarativeNetRequest` rules set the Referer certain CDNs require
  before they will serve media you are already playing.

## Privacy

VideoGrab collects nothing. There is no server. Page URLs are processed
locally to detect media; platform APIs are called directly from your
browser with your own session, exactly as the site itself would.
Full policy: https://siflie.com/videograb/privacy

## Limitations (read before filing an issue)

- YouTube above ~360p and Bilibili above 720p require merging separate
  audio/video (DASH) streams; not implemented yet.
- Platform resolvers are a moving target: when a platform changes its
  API or risk controls, a resolver can break until it is updated.
  Failures are currently silent in the popup.
- No DRM circumvention, ever. If a site protects its streams with DRM,
  VideoGrab will not touch it.

## Disclaimer

VideoGrab is a general-purpose tool for downloading video you have the
right to save — your own uploads, Creative-Commons and public-domain
material, and content you are otherwise permitted to download. You are
responsible for complying with each site's terms of service and with
copyright law in your jurisdiction.

## Contributing & maintenance

Bug reports with a public reproducible URL are gold — resolvers break
when platforms change, and reports are how they get fixed. PRs welcome.

Maintenance is best-effort, in the maintainer's spare time: no SLA, no
guaranteed response time, and resolver fixes ship when they ship. The
bug-report template lists what a useful report contains.

## License

GPL-3.0 — see `LICENSE`. Bundled third-party code (mux.js, Apache-2.0)
is listed in `THIRD-PARTY-NOTICES.md`.

---

# VideoGrab — 免费视频下载插件（中文说明）

开源的浏览器视频下载插件：检测你正在播放的视频并下载到本地。支持
X/Twitter（最高 4K、带声音的直链 MP4）、抖音、Bilibili、YouTube，
以及绝大多数站点的通用 MP4/WebM 与 HLS 流。

全部处理都在你的浏览器本地完成：不注册、不上传、不追踪、不收集任何
数据。代码全在这里，欢迎审计。

## 安装（Chrome）

1. 到 Releases 下载 `videograb-chrome-v*.zip` 并解压；
2. 打开 `chrome://extensions`，开启右上角「开发者模式」；
3. 点「加载已解压的扩展程序」，选择解压出的文件夹；
4. 打开有视频的页面，先点播放，再点插件图标即可下载。

Firefox 版可通过 Firefox Add-ons (AMO) 安装（上架后），或用
`about:debugging` 临时加载 `videograb-firefox-v*.zip` 测试。

## 已知上限（提 issue 前先看）

- YouTube 渐进流一般只到 360p，B 站 HTML5 路径只到 720p；更高清需
  要 DASH 音视频合并，尚未实现。
- 净网/DRM 站点（Netflix、Disney+、Max 等）按设计不支持。
- 各平台解析器是移动靶：平台改接口或加强风控后可能临时失效，修好
  之前弹窗内暂时是静默失败。

## 使用边界

请只下载你有权保存的视频（自己的作品、CC 授权、公有领域或平台明确
允许下载的内容），并遵守各站点的服务条款与所在地版权法律。

维护为业余时间 best-effort：无 SLA，带公开可复现链接的 bug 报告最
容易被修。
