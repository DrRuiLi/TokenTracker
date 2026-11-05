"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
const TOKEN_KEYS = [
  "prompt-text-tokens",
  "completion-text-tokens",
  "cached-prompt-text-tokens",
  "cache-write-text-tokens",
];
const EDGE =
  process.platform === "win32"
    ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
    : null;
const DOWNLOAD_TIMEOUT_MS = 120_000;

class GrokBillingError extends Error {
  constructor(message) {
    super(message);
    this.name = "GrokBillingError";
  }
}

function legacyAppDir() {
  const base =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "trcc-token-dash");
}

function resolveQueuePath(queuePath) {
  return (
    queuePath ||
    path.join(os.homedir(), ".tokentracker", "tracker", "queue.jsonl")
  );
}

function trackerDirFromQueue(queuePath) {
  return path.dirname(resolveQueuePath(queuePath));
}

/** Billing store beside the queue (same directory as merged-usage.jsonl). */
function resolveGrokBillingPath(queuePath) {
  const queue = resolveQueuePath(queuePath);
  return path.join(trackerDirFromQueue(queue), "grok-billing.jsonl");
}

function resolveEdgeProfileDir(queuePath) {
  const billing = resolveGrokBillingPath(queuePath);
  if (!billing) return null;
  return path.join(path.dirname(billing), "edge-profile");
}

function zulu(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

function localWindow(nowMs = Date.now(), daysBack = 1) {
  const local = new Date(nowMs + TZ_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const startLocal = Date.UTC(y, m, d - daysBack, -8, 0, 0);
  const endLocal = Date.UTC(y, m, d + 1, -8, 0, 0);
  return { startMs: startLocal, endMs: endLocal };
}

function exportUrl(startMs, endMs) {
  const q = new URLSearchParams({
    scope: "user",
    startTime: zulu(startMs),
    endTime: zulu(endMs),
  });
  return `https://grok.com/dashboard/api/dashboard/v2/export-billing-items-csv?${q}`;
}

function usageTokens(raw) {
  if (!raw) return 0;
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return 0;
    }
  }
  if (!data || typeof data !== "object") return 0;
  let total = 0;
  for (const key of TOKEN_KEYS) {
    const n = Number(data[key]);
    if (Number.isFinite(n)) total += Math.floor(n);
  }
  return total;
}

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function stripQuotes(s) {
  const t = String(s || "").trim();
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

function eventsFromCsvText(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]).map(stripQuotes);
  const idx = new Map(header.map((name, i) => [name, i]));
  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    const fields = parseCsvLine(lines[i]).map(stripQuotes);
    const get = (name) => {
      const j = idx.get(name);
      return j === undefined ? "" : fields[j] || "";
    };
    const itemId = get("Billing Item ID").trim();
    const rawTime = get("Event Time").trim();
    if (!itemId || !rawTime) continue;
    const model =
      get("Model").trim() || get("Product").trim() || "unknown";
    out.push({
      id: itemId,
      t: rawTime,
      model,
      tokens: usageTokens(get("Usage")),
      product: get("Product").trim(),
    });
  }
  return out;
}

async function readStore(storePath) {
  const items = new Map();
  let text;
  try {
    text = await fsp.readFile(storePath, "utf8");
  } catch {
    return items;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && row.id) items.set(row.id, row);
    } catch {
      // skip truncated line
    }
  }
  return items;
}

async function mergeStore(events, storePath) {
  const items = await readStore(storePath);
  let changed = 0;
  for (const row of events) {
    const prev = items.get(row.id);
    if (JSON.stringify(prev) !== JSON.stringify(row)) {
      items.set(row.id, row);
      changed += 1;
    }
  }
  const payload =
    Array.from(items.values())
      .map((row) => JSON.stringify(row))
      .join("\n") + (items.size ? "\n" : "");
  const tmp = `${storePath}.tmp`;
  await fsp.writeFile(tmp, payload, "utf8");
  await fsp.rename(tmp, storePath);
  return changed;
}

function spawnHidden(command, args) {
  return cp.spawn(command, args, {
    windowsHide: true,
    stdio: "ignore",
    detached: false,
  });
}

function runHidden(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawnHidden(command, args);
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new GrokBillingError("命令超时"));
    }, timeoutMs);
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function isHeadlessCommand(commandLine) {
  return String(commandLine || "").toLowerCase().includes("--headless");
}

// Headless Edge is stopped by Cloudflare and never starts the CSV download.
// The billing window is a real Edge placed off-screen; the login window is not.
function isBillingDownloadCommand(commandLine) {
  const text = String(commandLine || "").toLowerCase();
  return text.includes("--headless") || text.includes("--window-position=-32000,-32000");
}

function billingDownloadArgs(profileDir, url) {
  return [
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-notifications",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--window-position=-32000,-32000",
    "--window-size=200,200",
    url,
  ];
}

async function profileProcesses(profileDir) {
  if (process.platform !== "win32") return [];
  const marker = profileDir.toLowerCase();
  const script =
    "Get-CimInstance Win32_Process -Filter \"name='msedge.exe'\" " +
    "| Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
  try {
    const out = cp.execFileSync(
      "powershell",
      ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script],
      { encoding: "utf8", timeout: 20_000, windowsHide: true },
    );
    if (!out.trim()) return [];
    let data = JSON.parse(out);
    if (!Array.isArray(data)) data = [data];
    return data
      .filter(
        (row) =>
          row &&
          row.ProcessId &&
          String(row.CommandLine || "")
            .toLowerCase()
            .includes(marker),
      )
      .map((row) => ({
        pid: Number(row.ProcessId),
        commandLine: String(row.CommandLine || ""),
      }));
  } catch {
    return [];
  }
}

async function killPids(pids) {
  for (const pid of pids) {
    try {
      await runHidden("taskkill", ["/PID", String(pid), "/T", "/F"], 15_000);
    } catch {
      /* ignore */
    }
  }
}

async function killHeadless(profileDir) {
  const rows = await profileProcesses(profileDir);
  await killPids(rows.filter((row) => isHeadlessCommand(row.commandLine)).map((row) => row.pid));
}

async function killBillingBrowsers(profileDir) {
  const rows = await profileProcesses(profileDir);
  await killPids(rows.filter((row) => isBillingDownloadCommand(row.commandLine)).map((row) => row.pid));
}

function startOffscreenWatch(rootPid, profileDir) {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Add-Type -Namespace TT -Name WinHide -UsingNamespace System.Runtime.InteropServices -MemberDefinition @'",
    "[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);",
    "public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);",
    "[DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);",
    "[DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);",
    "[DllImport(\"user32.dll\")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);",
    "[DllImport(\"user32.dll\")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);",
    "'@",
    "$root = [int]$env:TT_EDGE_ROOT",
    "$marker = $env:TT_EDGE_PROFILE.ToLower()",
    "$until = [DateTime]::UtcNow.AddMinutes(3)",
    "while ([DateTime]::UtcNow -lt $until) {",
    "  if (-not (Get-Process -Id $root -ErrorAction SilentlyContinue)) { break }",
    "  $script:hidePids = New-Object 'System.Collections.Generic.HashSet[uint32]'",
    "  [void]$script:hidePids.Add([uint32]$root)",
    "  Get-CimInstance Win32_Process -Filter \"name='msedge.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($marker) } | ForEach-Object { [void]$script:hidePids.Add([uint32]$_.ProcessId) }",
    "  $cb = [TT.WinHide+EnumProc]{ param($hwnd, $lp)",
    "    $procId = [uint32]0",
    "    [void][TT.WinHide]::GetWindowThreadProcessId($hwnd, [ref]$procId)",
    "    if ($script:hidePids.Contains($procId)) {",
    "      $style = [TT.WinHide]::GetWindowLong($hwnd, -20)",
    "      [void][TT.WinHide]::SetWindowLong($hwnd, -20, ($style -bor 128) -band (-bnot 262144))",
    "      [void][TT.WinHide]::ShowWindow($hwnd, 0)",
    "    }",
    "    return $true",
    "  }",
    "  [void][TT.WinHide]::EnumWindows($cb, [IntPtr]::Zero)",
    "  Start-Sleep -Milliseconds 250",
    "}",
  ].join("\n");
  return cp.spawn(
    "powershell",
    ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script],
    {
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        TT_EDGE_ROOT: String(rootPid),
        TT_EDGE_PROFILE: profileDir,
      },
    },
  );
}

async function setDownloadDir(profileDir, destDir) {
  const prefsPath = path.join(profileDir, "Default", "Preferences");
  if (!fs.existsSync(prefsPath)) {
    throw new GrokBillingError(
      "专用 Edge 还没有登录，请运行 scripts/open-grok-login.bat 或在 TokenTracker 中登录 X 订阅用量",
    );
  }
  const prefs = JSON.parse(await fsp.readFile(prefsPath, "utf8"));
  prefs.download = prefs.download || {};
  prefs.download.default_directory = destDir;
  prefs.download.prompt_for_download = false;
  prefs.download.directory_upgrade = true;
  await fsp.writeFile(prefsPath, JSON.stringify(prefs), "utf8");
}

async function waitCsv(destDir, startedMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const partial = fs
      .readdirSync(destDir)
      .filter((name) => name.endsWith(".crdownload"));
    const ready = fs
      .readdirSync(destDir)
      .filter((name) => name.endsWith(".csv"))
      .map((name) => path.join(destDir, name))
      .filter((p) => fs.statSync(p).mtimeMs >= startedMs - 1000);
    if (ready.length && !partial.length) {
      return ready.reduce((a, b) =>
        fs.statSync(a).mtimeMs > fs.statSync(b).mtimeMs ? a : b,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new GrokBillingError("专用 Edge 没有在限定时间内下完用量 CSV。请先在限额页完成 X 登录，并关掉那个窗口");
}

async function downloadCsv({ queuePath, startMs, endMs, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  if (process.platform !== "win32") {
    throw new GrokBillingError("X 订阅账单导出仅支持 Windows");
  }
  if (!EDGE || !fs.existsSync(EDGE)) {
    throw new GrokBillingError("找不到 Microsoft Edge");
  }
  const profileDir = resolveEdgeProfileDir(queuePath);
  const storePath = resolveGrokBillingPath(queuePath);
  if (!profileDir || !storePath) {
    throw new GrokBillingError("无法解析 TokenTracker 用量目录");
  }
  const cookies = path.join(profileDir, "Default", "Network", "Cookies");
  if (!fs.existsSync(cookies)) {
    throw new GrokBillingError(
      "专用 Edge 还没有登录，请运行 scripts/open-grok-login.bat 或在 TokenTracker 中登录 X 订阅用量",
    );
  }
  const running = await profileProcesses(profileDir);
  if (running.some((row) => !isBillingDownloadCommand(row.commandLine))) {
    const error = new GrokBillingError("专用登录窗口还开着，请先关掉它");
    error.code = "login-window";
    throw error;
  }
  await killBillingBrowsers(profileDir);
  const destDir = path.join(path.dirname(storePath), "grok-download");
  await fsp.mkdir(destDir, { recursive: true });
  for (const name of fs.readdirSync(destDir)) {
    try {
      await fsp.unlink(path.join(destDir, name));
    } catch {
      /* ignore */
    }
  }
  await setDownloadDir(profileDir, destDir);
  const startedMs = Date.now();
  const url = exportUrl(startMs, endMs);
  const proc = spawnHidden(EDGE, billingDownloadArgs(profileDir, url));
  const hider = proc.pid ? startOffscreenWatch(proc.pid, profileDir) : null;
  try {
    return await waitCsv(destDir, startedMs, timeoutMs);
  } finally {
    try {
      hider?.kill();
    } catch {
      /* ignore */
    }
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    await killBillingBrowsers(profileDir);
  }
}

let refreshJob = null;

async function refreshGrokBillingExport({ queuePath, daysBack = 1, nowMs } = {}) {
  if (refreshJob) return refreshJob;
  refreshJob = refreshGrokBillingOnce({ queuePath, daysBack, nowMs }).finally(() => {
    refreshJob = null;
  });
  return refreshJob;
}

async function refreshGrokBillingOnce({ queuePath, daysBack = 1, nowMs } = {}) {
  const storePath = resolveGrokBillingPath(queuePath);
  if (!storePath) return 0;
  const { startMs, endMs } = localWindow(nowMs, daysBack);
  let csvPath;
  try {
    csvPath = await downloadCsv({ queuePath, startMs, endMs });
  } catch (error) {
    if (error && error.code === "login-window") return 0;
    throw error;
  }
  try {
    const text = await fsp.readFile(csvPath, "utf8");
    const events = eventsFromCsvText(text);
    if (!events.length) {
      throw new GrokBillingError("用量 CSV 没有记录");
    }
    return mergeStore(events, storePath);
  } finally {
    try {
      await fsp.unlink(csvPath);
    } catch {
      /* ignore */
    }
  }
}

async function migrateLegacyGrokBilling({ queuePath } = {}) {
  const storePath = resolveGrokBillingPath(queuePath);
  const profileDir = resolveEdgeProfileDir(queuePath);
  if (!storePath || !profileDir) return;
  await fsp.mkdir(path.dirname(storePath), { recursive: true });
  await fsp.mkdir(profileDir, { recursive: true });
  const legacyDir = legacyAppDir();
  const legacyStore = path.join(legacyDir, "grok-billing.jsonl");
  const legacyProfile = path.join(legacyDir, "edge-profile");
  if (!fs.existsSync(storePath) && fs.existsSync(legacyStore)) {
    await fsp.copyFile(legacyStore, storePath);
  }
  const cookies = path.join(profileDir, "Default", "Network", "Cookies");
  const legacyCookies = path.join(legacyProfile, "Default", "Network", "Cookies");
  if (!fs.existsSync(cookies) && fs.existsSync(legacyCookies)) {
    await fsp.cp(legacyProfile, profileDir, { recursive: true, force: true });
  }
}

async function openGrokLogin({ queuePath } = {}) {
  if (process.platform !== "win32") {
    throw new GrokBillingError("X 订阅登录仅支持 Windows");
  }
  if (!EDGE || !fs.existsSync(EDGE)) {
    throw new GrokBillingError("找不到 Microsoft Edge");
  }
  const profileDir = resolveEdgeProfileDir(queuePath);
  if (!profileDir) throw new GrokBillingError("无法解析 TokenTracker 用量目录");
  fs.mkdirSync(profileDir, { recursive: true });
  await killHeadless(profileDir);
  cp.spawn(
    EDGE,
    [
      `--user-data-dir=${profileDir}`,
      "https://grok.com/dashboard/usage",
    ],
    { detached: true, stdio: "ignore", windowsHide: false },
  ).unref();
}

module.exports = {
  GrokBillingError,
  resolveGrokBillingPath,
  resolveEdgeProfileDir,
  legacyAppDir,
  eventsFromCsvText,
  mergeStore,
  readStore,
  downloadCsv,
  refreshGrokBillingExport,
  migrateLegacyGrokBilling,
  openGrokLogin,
  isHeadlessCommand,
  isBillingDownloadCommand,
  billingDownloadArgs,
  localWindow,
  exportUrl,
  usageTokens,
};
