const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const WORKFLOW_DIR = path.join(__dirname, "..", ".github", "workflows");

function triggerBlock(content, fileName) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line === "on:");
  assert.ok(start >= 0, `${fileName} must declare on:`);
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === "" || line.startsWith("#")) {
      block.push(line);
      continue;
    }
    if (!/^\s/.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

test("every GitHub Actions workflow on this fork is manual-only", () => {
  const files = fs.readdirSync(WORKFLOW_DIR).filter((name) => name.endsWith(".yml"));
  assert.ok(files.length >= 12, "expected the existing workflow set");
  for (const name of files) {
    const block = triggerBlock(
      fs.readFileSync(path.join(WORKFLOW_DIR, name), "utf8"),
      name,
    );
    assert.doesNotMatch(block, /^\s*schedule\s*:/m, `${name} must not schedule`);
    assert.doesNotMatch(block, /^\s*push\s*:/m, `${name} must not run on push`);
    assert.doesNotMatch(block, /^\s*pull_request/m, `${name} must not run on pull requests`);
    assert.doesNotMatch(block, /^\s*workflow_run\s*:/m, `${name} must not chain off another workflow`);
    assert.match(block, /workflow_dispatch\s*:/, `${name} must stay manually runnable`);
  }
});
