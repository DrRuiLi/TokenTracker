# AI_CONTEXT — TokenTracker-TRCC（TokenTracker + 利民副屏）

> 架构地图。AI 助手在新会话开始时先读本文件。**本文件只读，修改需用户明确同意。**
> 最后更新：2026-11-13（合入上游 v1.5.19，本树版本 v1.5.19.1）

## 1. 目标

Windows 上的一份程序同时做两件事：

- **TokenTracker**（本树 `package.json` 为 v1.5.19.1，内容基线是上游 v1.5.19，MIT）：托盘程序 + 本地仪表盘。主用量读 `merged-usage.jsonl`（队列 + X 订阅账单）。按来源的细项、成就、项目用量仍读原始 `queue.jsonl`。
- **副屏**（`trcc/`，协议源自 thermalright-trcc-linux，GPL-3.0）：把 token 和本机状态画成 960×320，经 USB Bulk 推到利民 **HydroNous R1**（`87AD:70DB`，握手 PM=17 SUB=5，0° 即正向）。

副屏是 TokenTracker 的子进程，随它启动和退出，没有单独的托盘图标。设置页在仪表盘「工具」里的 `/trcc`，不另开 Tk 窗口。副屏自己不联网，只读 TokenTracker 写好的合并文件。

作者机器时区 UTC+8。已安装的程序在 `%LOCALAPPDATA%\Programs\TokenTracker`。源码树里的安装包是另一次编译产物，覆盖安装前，正在运行的仍是安装目录里的那一份。

## 2. 工作区

本文件在**本仓库根目录**。上一级目录不是源码：那里有另一个 git 仓库、`.tmp`，以及被那个仓库忽略的截图 `trcc-page-light.png`。

| 路径 | 说明 |
|---|---|
| 本仓库 | **唯一要改的源码**。副屏在 `trcc/` |
| `build.ps1` | 从这份源码打出 Windows 安装包。版本号取 `package.json` |
| `TokenTrackerWin/installer/Output/` | 安装包输出，已 gitignore。文件名 `TokenTracker-Setup-v<version>.exe` |
| `AI_CONTEXT.md` | 本文件 |

`node_modules`、`dashboard/dist`、`trcc/.venv`、`trcc/build`、`trcc/dist`、`trcc/preview*.png`、`TokenTrackerWin/publish`、`EmbeddedServer` 都不入库。预览图由 `test_unit.py`、`render.py` 和 `--preview-only` 写出。

### 2.1 源码里各块是什么

| 路径 | 职责 |
|---|---|
| `src/`、`bin/tracker.js`、`dashboard/` | TokenTracker CLI 和 React 仪表盘 |
| `src/lib/grok-billing-export.js` | Windows 上用专用 Edge 下载 grok.com 账单 |
| `src/lib/grok-billing-prefs.js` | 账单拉取间隔（默认 5 分钟），写入 `grok-billing-pref.json` |
| `src/lib/grok-billing-scheduler.js` | 按偏好定时拉账单并重排间隔 |
| `src/lib/merged-usage.js` | 把队列和账单合成 `merged-usage.jsonl` |
| `src/lib/grok-login-route.js` | `/api/grok-x-login`（登录 + GET/PUT 账单间隔） |
| `TokenTrackerWin/` | .NET 8 托盘壳（WebView2）。`scripts/bundle-node.ps1` 打进 Node 22.22.2 |
| `TokenTrackerBar/`、`TokenTrackerLinux/` | 上游的 macOS / Linux 壳，Windows 安装包不用它们 |
| `trcc/` | 副屏 Python。`vendor/libusb-1.0.dll` 管 USB；`vendor/lhm/` 是嵌入的 LibreHardwareMonitorLib 0.9.6 及依赖 DLL |
| `dashboard/src/pages/TrccPage.jsx` | 工具页。路由 `/trcc`，侧栏 id `trcc` |
| `dashboard/src/pages/trcc/GrokLoginCard.jsx` | `/trcc` 上的 X 订阅登录 |
| `src/lib/trcc-sidecar.js` | `tracker serve` 拉起副屏，并传入 `--usage-file` |
| `src/commands/serve.js` | 监听之后、启动同步之前调用 `startTrccSidecar()`，退出时 `stop()`；同时刷新账单和合并文件。启动同步可能很久，副屏不等它 |

## 3. 进程

```
TokenTracker.exe
  └─ EmbeddedServer\node.exe  tracker serve
       ├─ 按设定间隔（默认 5 分钟）：Edge 下载账单 → grok-billing.jsonl → merged-usage.jsonl
       └─ trcc\trcc-token-dash.exe --serve --parent-pid <node pid> --usage-file <merged-usage.jsonl>
```

Node 在 Windows Job Object 里（`KILL_ON_JOB_CLOSE`）。`--serve` 无 Tk、无 pystray，父进程没了就退出。日志：`%LOCALAPPDATA%\trcc-token-dash\serve.log`。

`resolveTrccLaunch` 的顺序：

1. `TOKENTRACKER_TRCC_DISABLE=1` 则不启动。
2. `TOKENTRACKER_TRCC_PYTHON` 和 `TOKENTRACKER_TRCC_MAIN` 都存在。
3. 安装目录里的 `trcc\trcc-token-dash.exe`（优先于下面两项）。
4. `%LOCALAPPDATA%\TokenTracker\trcc-host.json`（去掉 BOM）。这是旧的开发路径，有打包 exe 时不会用到。
5. 源码树 `trcc\.venv\Scripts\pythonw.exe` + `trcc\main.py`。

`TOKENTRACKER_TRCC_PYTHON` / `TOKENTRACKER_TRCC_MAIN` 仍可指向外部 Python，只在开发时需要。

## 4. 副屏模块（`trcc/`）

| 文件 | 职责 |
|---|---|
| `main.py` | 入口。`--serve` 走 `host.py`；另有 GUI / `--cli` / `--once` / `--preview-only` |
| `host.py` | 无界面宿主，以及给仪表盘用的设置白名单 |
| `control_api.py` | 只听 `127.0.0.1`，默认端口 **17691**（`settings.api_port`，0 为关闭） |
| `worker.py` | 渲染 + USB 推送线程。改设置时同步刷新周期和采样周期 |
| `usage_reader.py` | 只读 `merged-usage.jsonl`（没有则退回 `queue.jsonl`）。默认每 2 秒看一次，不联网 |
| `device.py` | USBLCDNew Bulk（pyusb）。libusb 找 `_MEIPASS`、exe 目录、源码 `vendor/` |
| `render.py` | 960×320 画面。默认统计合并文件里的全部来源，同一 `(source, model, hour_start)` 取最后一条 |
| `layouts.py` | 六种版面：经典、用量聚焦、系统优先、星环仪表、信号波形、遥测控制台 |
| `sysmetrics.py` | CPU / 内存 / 网速每帧用 psutil。温度和功耗在 `SensorPoller` |
| `settings.py` | `%LOCALAPPDATA%\trcc-token-dash\settings.json` |
| `gui.py` | 独立运行时的 Tk 窗口。`--serve` 不显示 |
| `theme_edit.py`、`theme_presets.py` | 主题色派生和预设 |
| `trcc-bundle.spec` | 打进安装包的 onedir、无控制台 PyInstaller 规格 |
| `test_unit.py` | 不碰 USB 的单元测试。会写出 `preview.png`，该图已 gitignore |

依赖见 `requirements.txt`：pillow、psutil、pyusb、requests、pystray、pywin32、pythonnet、pyinstaller。运行时不需要 `cryptography` 或 `curl_cffi`。

账单下载不在这里。`cursor_usage.py`、`grok_billing.py`、`trcc/open-grok-login.bat` 已删除。

## 5. 用量

副屏大数字是**今天**的 token（UTC+8，一位小数 + M），数字来自合并文件，和仪表盘主用量同一份。

X 订阅（Cursor + Grok）没有公开的 token 历史接口。下载在 `tracker serve` 里，只在 Windows 上跑：

- 专用 Edge 配置在队列旁边：`~/.tokentracker/tracker/edge-profile`。启动时若新位置还没有 Cookie，会从 `%LOCALAPPDATA%\trcc-token-dash\edge-profile` 复制一次。
- 下载 `GET https://grok.com/dashboard/api/dashboard/v2/export-billing-items-csv?scope=user&startTime&endTime`。窗口是本地昨天 00:00 到明天 00:00。用专用配置启动一个真实 Edge，窗口放到屏幕外。无头 Edge 和普通 HTTP 请求会被 Cloudflare 挡住，所以不能用 `--headless`。日常使用的 Edge 不用退出。
- 登录：仪表盘用量限额里 Cursor 行同时有上游的浏览器连接，以及 X 登录（旁可输入账单同步间隔，单位分钟，默认 5；允许约 1–1440 分钟）。`/trcc` 上的登录卡打到同一处。都走 `/api/grok-x-login`（`PUT` 写间隔，服务端存秒）。也可以运行 `scripts/open-grok-login.bat`。登完关掉那个窗口。专用窗口还开着时，刷新会报「专用登录窗口还开着」，这一轮跳过下载。账单下载若遇到 Cloudflare 人机验证，限额页会提示，并暂停这一轮同步。
- token = `prompt-text-tokens` + `completion-text-tokens` + `cached-prompt-text-tokens` + `cache-write-text-tokens`。
- 只把账单 id、时间、模型、token、产品写入 `~/.tokentracker/tracker/grok-billing.jsonl`。原始 CSV 解析后删除。旧文件同样只迁移一次。
- `merged-usage.js` 的规则：其他来源的队列行始终保留；某一天的账单里有 `cursor` 或 `grok-bot` 时，这一天同产品的队列行让位给账单。账单按产品、模型、小时合成队列形状的行。有 Usage 拆分时写入输入、输出和缓存列；只有总量的旧行这几列仍是 0。行上带 `billing_included`，费用保持 $0。
- `serve.js` 按 `grok-billing-pref.json` 的间隔下载并重写合并文件（默认 300 秒），另外每 30 秒只重写合并文件（不重新下 CSV）。改间隔后立即按新周期重排定时器。副屏约每 2 秒重读该文件。

禁止记录或打印 JWT、Cookie。不要把 `state.vscdb` 再接回副屏：该库可以到几十 GB，以前的只读 CSV 路径已经去掉。

## 6. 温度和功耗

采样和画面刷新是两个设置。用量刷新不在副屏设置里。

| 设置 | 范围 | 默认 | 作用 |
|---|---|---|---|
| `render_interval` | 0.2–10 秒，步进 0.2 | 1 | 重画画面 |
| `sensor_interval` | 0.5–60 秒，步进 0.5 | 2 | 只采样 CPU 温度和功耗 |

`sensor_interval` 改完立刻写到 `SensorPoller.period`。缩短会在当前等待里生效（每 0.25 秒看一次剩余时间）；加长从下一次循环开始。

传感器顺序：嵌入的 LibreHardwareMonitorLib（要管理员、.NET 8、本机已装的 PawnIO）→ LibreHardwareMonitor / OpenHardwareMonitor 的 WMI → MSAcpi。ACPI 兜底仍是最多 60 秒一次，不受 `sensor_interval` 控制。非管理员时温度和功耗为 0，状态是「需要管理员权限」。CPU、内存、网速不走这条采样线程。

## 7. 控制接口和设置页

`control_api` 只接受本机。Host 必须是 `127.0.0.1` / `localhost` / `[::1]` 且端口一致。POST 必须是 `application/json`。

`host.API_EDITABLE`：`rotation`、`mirror`、`render_interval`、`sensor_interval`、`close_action`、`colors`、`theme_preset`、`layout`。数值先按 `RANGES` 夹取，再 `settings.sanitize`。`RANGES` 只有 `render_interval` 和 `sensor_interval`。

仪表盘通过 `dashboard/src/lib/trcc-api.js` 访问。页面文案在 `dashboard/src/content/copy.csv`，中文和繁体在 `i18n/zh/core.json`、`i18n/zh-TW/core.json`。

默认序列号 `181104191B22C003` 不是这台机器时，程序警告并使用第一台 `87AD:70DB`。

## 8. 编译

在仓库根目录：

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

需要 Node、Python 3.12、.NET 8 SDK、Inno Setup 6。本机 SDK 在 `%LOCALAPPDATA%\Microsoft\dotnet\dotnet.exe`（`Program Files` 里的 `dotnet` 可能只有运行时）。脚本会：

1. `npm ci` 并编译仪表盘（`TOKENTRACKER_BUILD_PET=1`，这样才有 `pet.html` 和 `quota.html`）。
2. 建 `trcc\.venv`，跑 `test_unit.py`，再用 `trcc-bundle.spec` 打出 `trcc-token-dash.exe`（带 libusb 和 `lhm\`）。
3. `bundle-node.ps1`，然后 `dotnet publish` 自包含 win-x64。
4. 把 EmbeddedServer 和 `trcc\` 放进 `TokenTrackerWin\publish`。
5. Inno Setup 打出 `TokenTracker-Setup-v<package.json version>.exe`。当前版本是 v1.5.19.1。AppId `{8F2A6C71-4E9D-4B7A-9C3E-1D5F0A2B6E84}`，安装到 `%LOCALAPPDATA%\Programs\TokenTracker`，可覆盖同目录的旧安装。用户数据不在安装目录里。四段版本只写 `package.json`、根 `package-lock.json` 和 `TokenTrackerWin.csproj`；`scripts/sync-versions.cjs` 只接受 `x.y.z`，不要用它把 1.5.19.1 写进 macOS / Linux 版本文件。

脚本只编译，不安装。静默覆盖安装要先退出正在运行的 TokenTracker，否则 Inno 会因为文件占用而中止（退出码 5）。

单独测副屏：建好 venv 后运行 `trcc\.venv\Scripts\python test_unit.py`。仪表盘页：在 `dashboard` 里 `npx vitest run src/pages/TrccPage.test.jsx`。

## 9. 修改约定

- 只改本仓库。不要改上一级目录。
- 主用量走 `merged-usage.jsonl`。按来源的细项、成就、项目用量留在原始 `queue.jsonl`。账单合成行带 `billing_included`，费用保持 $0。有 Usage 拆分时输入/输出列有数，仍不要改 `computeRowCost` 去给它们计价。
- 不记录、不打印 JWT 或 Cookie。不把 `state.vscdb` 接回副屏，不整文件读取或复制它。
- 副屏界面线程不做 USB 和网络。账单下载留在 `tracker serve`。慢的传感器读取留在采样线程。COM/WMI 线程自己 `CoInitialize()`。
- 新的副屏设置要同时接到 `settings.py`、`host.API_EDITABLE` / `RANGES`、`worker.update_settings`，以及 `TrccPage` 和文案。
- 不要操作用户的桌面（鼠标、键盘）。需要看界面时，让用户截图。
- 许可证：副屏协议 GPL-3.0（见 `trcc/NOTICE`），TokenTracker 为 MIT。
