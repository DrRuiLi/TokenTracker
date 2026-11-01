const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("Windows glass reset targets only the desktop navigation sidebar", () => {
  const sidebar = read("dashboard/src/ui/components/Sidebar.jsx");
  const styles = read("dashboard/src/styles.css");
  const dashboardWindow = read("TokenTrackerWin/DashboardWindow.cs");

  assert.match(sidebar, /<aside\s+data-native-sidebar/);
  assert.equal(
    sidebar.match(/data-native-sidebar/g)?.length,
    1,
    "only the desktop sidebar should receive the native glass reset",
  );
  assert.match(styles, /aside\[data-native-sidebar\]/);
  assert.match(dashboardWindow, /aside\[data-native-sidebar\]/);

  assert.doesNotMatch(styles, /aside\[aria-label\]/);
  assert.doesNotMatch(dashboardWindow, /aside\[aria-label\]/);
});

test("Cloud routes keep their theme inside the shared application shell", () => {
  const app = read("dashboard/src/App.jsx");
  assert.doesNotMatch(app, /content\s*=\s*<div className="tt-cloud-theme"/);
  for (const page of ["CloudPage", "CloudCheckoutPage", "SelfHostPage"]) {
    assert.match(read(`dashboard/src/pages/${page}.jsx`), /className="tt-cloud-theme\b/);
  }
});
