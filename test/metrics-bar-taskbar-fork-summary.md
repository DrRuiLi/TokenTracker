# TokenTracker 任务栏硬件横条（TRCC Fork）— 工作总结

> 范围：在 Windows 托盘壳里内建 LiteMonitor 风格的任务栏指标条，数据优先走 TRCC 本机 API；不捆绑 LiteMonitor.exe。  
> 记录时间：2026-11-19（对话迭代至 v1.5.24.x 开发构建）

---

## 1. 目标与结论

| 目标 | 结果 |
|------|------|
| 托盘旁显示 CPU/内存/温度/功耗/网速，而非第二个悬浮大黑条 | 通过 `SetParent(Shell_TrayWnd)` 把 WinForms 窗体嵌进系统任务栏高度内 |
| 外观接近本机已使用的 LiteMonitor 任务栏模式 | 双行三列成对布局 + LiteMonitor 任务栏配色/阈值 + 紧凑网速单位 |
| 与上游 TokenTracker 易于合并 | 逻辑集中在 `TokenTrackerWin/TrccFork/MetricsBar/`；宿主文件仅用 `#region TRCC fork` 薄接线 |
| 数据来源 | `GET http://127.0.0.1:<TrccPort>/api/metrics`；API 不可用时 C# 侧 fallback（CPU/内存/网卡，温度/功耗为 `—`） |

---

## 2. 数据链（TRCC）

在 `trcc/` 侧增加可轮询的快照接口（fork 专用，不改变主 TokenTracker 云同步路径）：

1. **Worker**（`trcc/worker.py`）在推送循环里缓存 `_last_metrics`。
2. **宿主**（`trcc/host.py` / `trcc/gui.py`）暴露 `get_metrics`。
3. **HTTP**（`trcc/metrics_api.py`，经 `control_api.py` 挂路由）提供 **`GET /api/metrics`**，JSON 内含 `metrics` 对象（`cpu`、`mem`、`temp`、`power`、`up`、`dl` 等键）。
4. **测试**（`trcc/test_unit.py`）覆盖该 HTTP 端点。

Windows 横条由 `MetricsBarPoller` 按 `metrics-bar.json` 中的 `RefreshMs`、`TrccPort` 轮询上述接口。

---

## 3. Windows 端模块（`TokenTrackerWin/TrccFork/MetricsBar/`）

| 文件 | 职责 |
|------|------|
| `MetricsBarHost.cs` | 唯一对外入口：挂托盘菜单、读写设置、启停轮询与窗体 |
| `MetricsBarForm.cs` | 无边框子窗体；`ShowWithoutActivation`；不置顶 |
| `TaskbarNative.cs` | Win32 P/Invoke（`Shell_TrayWnd`、`SetParent`、`WS_CHILD`、`WS_EX_LAYERED` 等） |
| `TaskbarEmbedder.cs` | 查找任务栏/托盘 HWND、主题色键、挂载、定位；Explorer 重启后定时重挂 |
| `MetricsTaskbarLayout.cs` | **LiteMonitor 式**三列双行：`cpu/temp`、`power/mem`、`up/dl`；按文本测量列宽 |
| `MetricsTaskbarPalette.cs` | 任务栏字体与三色（对齐 LiteMonitor `TaskbarRenderer` 浅色/深色预设） |
| `MetricsBarRenderer.cs` | 任务栏绘制（ClearType、标签左/数值右）；仪表盘预览仍可用旧单列 `Render` |
| `MetricsBarPoller.cs` | HTTP 轮询 + `MetricsBarFallbackSampler` |
| `MetricsBarSettings.cs` | `%LocalAppData%\TokenTracker\metrics-bar.json` |
| `MetricsBarStrings.cs` | 托盘菜单文案 |

**宿主接线（薄）**

- `TrayApplicationContext.cs`：`MetricsBarHost.Attach(...)`
- `DashboardWindow.cs`：WebView2 消息 `metrics_bar_get` / `metrics_bar_settings`

**仪表盘**

- `dashboard/src/pages/trcc/MetricsBarSection.jsx`、`dashboard/src/lib/metrics-bar.js`
- `TrccPage.jsx` 引入设置块；文案在 `dashboard/src/content/copy.csv`

合并说明见仓库根目录 `docs/trcc-fork-merge.md`。

---

## 4. 任务栏嵌入：从「悬浮」到「进任务条」

### 4.1 早期问题

- 旧 `TaskbarDock`：`TopMost` + 坐标放在 **`taskbar.Top - barHeight`** → 横条浮在任务栏上方。
- 早期 `SetParent` 未真正生效（GDI 窗口 `parent=0`）：仅去掉 `WS_POPUP` 不够，WinForms 仍带 `WS_CAPTION` 等顶层样式。

### 4.2 当前做法（参考 LiteMonitor / FluentFlyout 类项目）

1. `FindWindow("Shell_TrayWnd")` + `FindWindowEx(..., "TrayNotifyWnd", ...)`。
2. `SetParent(form.Handle, hTaskbar)`。
3. `GWL_STYLE`：清除 `CAPTION/THICKFRAME/SYSMENU/...`，加 `WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS`。
4. `GWL_EXSTYLE`：在挂载后设置 `WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`。
5. **色键透明**：浅色任务栏 `RGB(210,210,211)`，深色 `(40,40,41)`（与 LiteMonitor 默认一致）；背景 `Clear(chromaKey)`，只画文字。
6. **位置**：面板放在托盘区左侧，`SetWindowPos` 使用任务栏客户区坐标；高度 = 整条任务栏带高度。
7. **`MetricsBarHost`**：约 1.5s 定时 `MaintainTaskbarEmbed()`（主题、父窗口、布局）。

日志：`%LocalAppData%\TokenTracker\windows-host.log`，关键字 `[metrics-bar]`（含 `embedded parent=<Shell_TrayWnd>`）。

---

## 5. 布局与配色（对齐 LiteMonitor 任务栏）

依据本机 LiteMonitor `settings.json` 与上游 `TaskbarRenderer.cs` / `HorizontalLayout.cs`（`LayoutMode.Taskbar`）：

- **列成对**（与任务栏项排序一致）  
  - 第 1 列：CPU 使用率 / CPU 温度  
  - 第 2 列：PWR / 内存  
  - 第 3 列：🔼 上行 / 🔽 下行  
- **字体**：`Microsoft YaHei UI` 10pt 粗体（避免在高 DPI 上再乘 `DeviceDpi/96` 导致挤成一行）。
- **浅色任务栏数值色**：绿 `#008040`、警告 `#B57500`、严重 `#C03030`；标签 `#141414`。
- **网速**：任务栏显示 `KB`/`MB` 紧凑写法（无 `/s`），与 LiteMonitor 横条习惯一致。
- **阈值（示意）**：负载/内存 warn 60% / crit 85%；温度 warn 50°C / crit 70°C。

用户可在副屏页切换显示项、刷新间隔等；列顺序在代码里按上述成对关系解释 `settings.Columns` 中的键。

---

## 6. 设置与运维

| 项 | 路径 / 说明 |
|----|----------------|
| 横条开关与选项 | 托盘菜单「任务栏横条」；或仪表盘 **副屏** 页 |
| 配置文件 | `%LocalAppData%\TokenTracker\metrics-bar.json`（`Enabled`、`Columns`、`RefreshMs`、`TrccPort`、主题色字段等） |
| 本机快速试跑 | `$env:DOTNET_ROOT = "$env:LOCALAPPDATA\Microsoft\dotnet"` 后 `dotnet build TokenTrackerWin/TokenTrackerWin.csproj -c Release`，将 `bin\Release\...\TokenTracker.dll` 复制到 `TokenTrackerWin\publish\`，重启 `TokenTracker.exe` |
| 完整包 | 根目录 `build.ps1`（需 Node、Python、.NET 8 SDK、Inno Setup） |

**注意**：`Program Files\dotnet\dotnet.exe` 可能只有 Host、无 SDK；本机 SDK 常在 `%LocalAppData%\Microsoft\dotnet`。

---

## 7. 已知限制与后续可做

- **Win10 / 竖条任务栏 / 多显示器**：当前以 Win11 水平底栏 + `SetParent(Shell_TrayWnd)` 为主；LiteMonitor 的 Win10 ReBar 挤占、竖条布局、多屏 `TaskbarMonitorDevice` 尚未移植。
- **与 LiteMonitor 同时开启**：两条都会在托盘左侧占空间，对比时请二选一。
- **温度/功耗**：依赖 TRCC 侧 `/api/metrics` 与传感器；无数据时显示 `—`（fallback 不编造温度/功耗）。
- **仪表盘 `npm run dashboard:build`**：若本地 Vite 报错，托盘内嵌 `publish/EmbeddedServer` 的设置 UI 可能滞后于源码；横条本体只依赖 DLL 更新。
- **未在本文档范围**：安装包版本号 bump、git 提交、edge/云发布（按 `CLAUDE.md` release 表单独处理）。

---

## 8. 相关提交/版本上下文（参考）

- 功能首次合入 **v1.5.24.3**（任务栏横条 + API + 仪表盘设置）。
- **v1.5.24.4** 把横条嵌进任务栏，并修正刷新时内容不全和闪烁：`/api/metrics` 的 `temp_c` / `power_w` / `up_bps` / `dl_bps` 映射到横条字段；列宽按样本字符串固定；数值变化只重画，不再每次 `SetParent`。色键只看 `SystemUsesLightTheme`。

---

## 9. 致谢

任务栏嵌入与绘制思路参考 [LiteMonitor](https://github.com/Diorser/LiteMonitor)（MIT，Diorser）的 `TaskbarWinHelper` / `TaskbarRenderer` / `HorizontalLayout`（`LayoutMode.Taskbar`）。