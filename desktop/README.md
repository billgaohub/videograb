# VideoGrab 桌面版 v0.2

粘贴网址 → 解析 → 下载。四个站（X / 抖音 / Bilibili / YouTube）+ 通用
MP4/HLS，带进度条，ffmpeg 合并（HLS 转 MP4、双流 DASH 合并）。
与浏览器扩展共用同一套解析逻辑，全程本地运行，零数据收集。

## 运行（打包版）

- **Windows**：双击 `VideoGrab-Desktop-v0.2-Windows.exe`（单文件，
  首次运行会在同目录释放一个 ffmpeg.exe，并自动打开浏览器界面）。
  未签名程序，SmartScreen 会警告，点「更多信息 → 仍要运行」。
- **Linux**：`chmod +x VideoGrab-Desktop-v0.1-Linux && ./VideoGrab-Desktop-v0.1-Linux`，
  需要系统装有 ffmpeg，然后浏览器打开 http://127.0.0.1:17890/
- 文件默认保存到程序同目录的 `downloads/` 文件夹。

## 运行（源码）

```bash
node server.js   # 需要 Node 18+ 与 ffmpeg 在 PATH 中
```

## 打包

```bash
npx esbuild server.js --bundle --platform=node --target=node24 --outfile=dist/app.cjs
node --experimental-sea-config sea-config.json        # Linux blob
node --experimental-sea-config sea-config-win.json    # Windows blob（含 ffmpeg 资产）
# 再用 postject 把 blob 注入对应平台的 node 可执行文件
```

## 实测记录（2026-11-05，云端 Linux 环境）

| 路径 | 结果 |
|---|---|
| 通用 MP4 直链 | ✅ 下载完成，逐字节完整校验 |
| 通用 HLS（Mux 测试流 1080p/634s） | ✅ ffmpeg 转 MP4 完成 |
| X（SpaceX 帖，5 个清晰度） | ✅ 解析 + 270p 下载完成，音画齐全 |
| Bilibili 解析 | ✅ 经 pagelist 取 cid（view 接口常被风控 412，此路绕开） |
| Bilibili MP4 直下 720p | ✅ 29,968,701 字节，与独立下载一致 |
| Bilibili DASH 合并 480p | ✅ 双流下载后本地合并，音画各 221s，尾段解码正常 |
| YouTube 解析/下载 | ✅ 单文件直下（360p）与高清双流合并（1080p/1280p/4K DASH + ffmpeg）及在线预览全部验通 |
| 抖音解析 | ⚠️ 解析器已实现（页面 SSR 数据提取），但抖音对机房 IP 只返回空壳页面、无播放数据，需在国内普通网络验证 |
| 打包版（Linux 单文件） | ✅ 界面/解析/下载全程验通 |
| 打包版（Windows 单文件） | ⚠️ 已构建并注入成功（PE 校验通过），无 Windows 环境未实跑；机制与 Linux 版相同 |

已知上限：Bilibili 未登录 DASH 最高约 480p、直下 720p（扩展版同）；
YouTube 若解析成功可提供最高 1080p+ 的双流合并选项（视接口返回）。

## 实现要点（踩过的坑）

- Bilibili 的 view 接口与视频页对很多 IP 返回 412 风控页，但
  `x/player/pagelist` 与 `x/player/playurl` 不受影响——cid 走 pagelist。
- Bilibili DASH 不能让 ffmpeg 直读 CDN URL：CDN 会中途截断流而 ffmpeg
  仍以 0 退出，生成"看似成功"的残缺文件。现实现为两步：先用普通下载
  拉双流（带备用 URL 与重试 + 完整性校验），再本地合并，最后校验时长。
- 直下同理加了字节完整性校验，不完整直接报错并删文件，不留残件充数。

## v0.2 新增：播放

- 解析结果中 MP4 选项带「▶ 播放」：经本地代理预览（透传平台所需
  请求头与 Range，可拖动进度），不用先下载。
- 下载完成后任务卡片带「▶ 播放」：播本地文件（Range 分段已实测 206）。
- HLS/DASH 选项不支持在线预览（浏览器不能直播），下载完成后可播
  （产物是 MP4）。文件播放接口只允许访问 downloads 目录内的文件，
  路径穿越已拦。
