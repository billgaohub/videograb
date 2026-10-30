---
name: Bug report — a video was not detected / a download failed
about: Report a site where VideoGrab missed a video or a download broke
title: "[bug] "
labels: bug
---

**Browser and version** (e.g. Chrome 130, Firefox 128):

**VideoGrab version** (see chrome://extensions or the popup):

**Page URL where it happened** (a public page, please — resolver bugs
cannot be diagnosed without a reproducible URL):

**What you expected**: the video playing on the page appears in the popup.

**What actually happened** (nothing detected / wrong quality / download
error message — quote the exact text):

**Anything in the service-worker / background console?**
(chrome://extensions → VideoGrab → "Inspect views"; Firefox:
about:debugging → Inspect. Paste errors in a code block.)

```
paste errors here
```

> Note: VideoGrab is maintained best-effort in spare time. Reports with
> a public reproducible URL are far more likely to be fixed. DRM sites
> (Netflix, Disney+, Max, …) are out of scope by design, and YouTube
> downloads are capped at the progressive streams the player API
> returns (usually 360p) — see the README's limitations section before
> reporting those.
