// Starts the Thermalright side-screen host as a child of `tracker serve`.
// No window and no tray icon. The Windows app kills this server's process
// tree on quit, and the child also watches this pid, so it cannot outlive
// TokenTracker. Set TOKENTRACKER_TRCC_DISABLE=1 to skip it.

const cp = require("node:child_process");
const fssync = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function exists(file) {
  try {
    return Boolean(file) && fssync.existsSync(file);
  } catch {
    return false;
  }
}

function preferPythonw(python) {
  if (process.platform !== "win32" || !python) return python;
  const sibling = path.join(path.dirname(python), "pythonw.exe");
  return exists(sibling) ? sibling : python;
}

function configFile() {
  const base = process.env.LOCALAPPDATA
    || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "TokenTracker", "trcc-host.json");
}

function fromConfig() {
  try {
    const text = fssync.readFileSync(configFile(), "utf8").replace(/^\uFEFF/, "");
    const data = JSON.parse(text);
    if (exists(data.python) && exists(data.main)) {
      return { python: preferPythonw(data.python), main: data.main };
    }
  } catch {
    // missing or unreadable config
  }
  return null;
}

function fromSibling() {
  // TokenTracker/src/lib -> TokenTracker/trcc inside this source tree.
  const dash = path.resolve(__dirname, "..", "..", "trcc");
  const main = path.join(dash, "main.py");
  const python = path.join(dash, ".venv", "Scripts", process.platform === "win32" ? "python.exe" : "python");
  if (exists(main) && exists(python)) return { python: preferPythonw(python), main };
  return null;
}

function bundledExe() {
  // Installed layout: {app}\trcc\trcc-token-dash.exe next to TokenTracker.exe,
  // while this file lives in {app}\EmbeddedServer\tokentracker\src\lib.
  const name = "trcc-token-dash.exe";
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "..", "trcc", name),
    path.resolve(path.dirname(process.execPath), "..", "trcc", name),
  ];
  return candidates.find((file) => exists(file)) || null;
}

function resolveTrccLaunch(env = process.env) {
  if (String(env.TOKENTRACKER_TRCC_DISABLE || "") === "1") return null;
  const python = env.TOKENTRACKER_TRCC_PYTHON;
  const main = env.TOKENTRACKER_TRCC_MAIN;
  if (exists(python) && exists(main)) return { python: preferPythonw(python), main };
  const exe = bundledExe();
  if (exe) return { exe };
  return fromConfig() || fromSibling();
}

function startTrccSidecar({ spawnImpl = cp.spawn, log = (line) => process.stdout.write(line) } = {}) {
  const spec = resolveTrccLaunch();
  if (!spec) {
    log("[trcc] side screen host not found; set %LOCALAPPDATA%\\TokenTracker\\trcc-host.json\n");
    return null;
  }
  const command = spec.exe || spec.python;
  const args = spec.exe
    ? ["--serve", "--parent-pid", String(process.pid)]
    : [spec.main, "--serve", "--parent-pid", String(process.pid)];
  let child;
  try {
    child = spawnImpl(command, args, {
      windowsHide: true,
      stdio: "ignore",
      cwd: path.dirname(command === spec.exe ? spec.exe : spec.main),
    });
  } catch (error) {
    log(`[trcc] failed to start: ${error?.message || error}\n`);
    return null;
  }
  child.on("error", (error) => log(`[trcc] failed to start: ${error?.message || error}\n`));
  child.on("exit", (code, signal) => log(`[trcc] exited code=${code} signal=${signal || ""}\n`));
  log(`[trcc] side screen pid=${child.pid}\n`);

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode != null || child.signalCode) return;
    try { child.kill(); } catch { /* already gone */ }
  };
  process.on("exit", stop);
  return { stop, child };
}

module.exports = { resolveTrccLaunch, startTrccSidecar };
