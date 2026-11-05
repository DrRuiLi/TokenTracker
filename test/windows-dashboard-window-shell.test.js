const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("Windows dashboard borderless shell respects work area and caption hit-testing", () => {
  const dashboard = read("TokenTrackerWin/DashboardWindow.cs");
  const shell = read("TokenTrackerWin/BorderlessWindowShell.cs");

  assert.match(shell, /WM_GETMINMAXINFO/);
  assert.match(shell, /rcWork/);
  assert.match(shell, /GetMonitorInfo/);
  assert.match(shell, /NativeCaptionHeightPx = 28/);
  assert.match(shell, /WM_NCHITTEST/);
  assert.match(shell, /HTCLIENT/);

  assert.match(dashboard, /ApplyDashboardWindowChrome/);
  assert.match(dashboard, /BorderlessWindowShell\.NativeCaptionHeightPx/);
  assert.match(dashboard, /BorderlessWindowShell\.TryHandleMessage/);
  assert.match(dashboard, /WM_NCLBUTTONDBLCLK/);
  assert.match(dashboard, /HTTOP/);
});
