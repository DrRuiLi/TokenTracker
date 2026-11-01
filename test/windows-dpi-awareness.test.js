const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = file => fs.readFileSync(path.join(__dirname, "../TokenTrackerWin", file), "utf8");

test("Windows host opts into per-monitor DPI instead of the SDK's SystemAware default", () => {
  assert.match(read("TokenTrackerWin.csproj"), /<ApplicationHighDpiMode>PerMonitorV2<\/ApplicationHighDpiMode>/);
});

test("DPI initialization precedes WPF and tray window creation", () => {
  const source = read("Program.cs");
  const initialize = source.indexOf("ApplicationConfiguration.Initialize();");
  const wpfApplication = source.indexOf("new System.Windows.Application");
  const trayContext = source.indexOf("new TrayApplicationContext(");
  assert.ok(initialize >= 0 && initialize < wpfApplication);
  assert.ok(initialize < trayContext);
  assert.equal(source.match(/ApplicationConfiguration\.Initialize\(\);/g)?.length, 1);
});
