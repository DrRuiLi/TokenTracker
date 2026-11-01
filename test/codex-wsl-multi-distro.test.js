/**
 * An empty `~/.codex` shell in an EARLIER distro must not hide a populated one.
 *
 * This is the original empty-shell-shadowing bug one level down. `sync` used to
 * resolve the WSL home itself with a plain existence probe, so `discoverWslHome`
 * returned the first distro that merely had a `.codex` directory; the
 * `requireAnyChild` check then ran too late, rejected that shell, and left the
 * WSL side null — the populated later distro was never even looked at.
 *
 * `status` passed `wslDir` instead, which folds `requireAnyChild` INTO the
 * existence probe so discovery skips the shell and keeps walking. The two
 * therefore disagreed, which also broke the promise in status.js that it lists
 * every root sync actually walks.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { resolveInstallPaths } = require("../src/lib/install-resolver");
const wsl = require("../src/lib/wsl-probe");
const { mockMethod } = require("./helpers/mock");

const NATIVE = "C:\\Users\\dev\\.codex";
const SHELL_DISTRO = "\\\\wsl$\\Empty\\home\\dev\\.codex";
const REAL_DISTRO = "\\\\wsl$\\Ubuntu\\home\\dev\\.codex";
const REQUIRE = ["sessions", "archived_sessions"];

// Only the native install and the SECOND distro hold sessions/. The first
// distro is a bare `.codex` directory, the shape a `codex --version` run leaves.
function existsSync(p) {
  const populated = [
    NATIVE,
    path.join(NATIVE, "sessions"),
    REAL_DISTRO,
    path.join(REAL_DISTRO, "sessions"),
    SHELL_DISTRO,
  ];
  return populated.includes(p);
}

const deps = { platform: "win32", existsSync };

// Stands in for the real prober: walks distros in order and returns the first
// candidate the probe it was HANDED accepts. That is what makes folding
// requireAnyChild into the probe load-bearing — with a plain existence probe the
// bare shell wins, with the folded one discovery keeps walking.
function stubDiscovery(t) {
  mockMethod(t, wsl, "discoverWslHome", (_providerDir, injected = {}) => {
    const probe = injected.existsSync || existsSync;
    for (const candidate of [SHELL_DISTRO, REAL_DISTRO]) {
      if (probe(candidate)) return candidate;
    }
    return null;
  });
}

test("wslDir discovery skips an empty shell distro and finds the populated one", (t) => {
  stubDiscovery(t);
  const resolved = resolveInstallPaths(
    { nativeValue: NATIVE, wslDir: ".codex", requireAnyChild: REQUIRE, union: true },
    { TOKENTRACKER_WSL_MODE: "both" },
    deps,
  );

  assert.equal(resolved.native, NATIVE);
  assert.equal(
    resolved.wsl,
    REAL_DISTRO,
    "an empty .codex in the first distro must not hide the populated second one",
  );
});

test("a pre-resolved empty shell still cannot shadow, it just yields no WSL root", (t) => {
  stubDiscovery(t);
  // The wslValue branch cannot rescue a caller that already picked the shell —
  // it can only reject it. This is why sync must pass wslDir, not wslValue.
  const resolved = resolveInstallPaths(
    { nativeValue: NATIVE, wslValue: SHELL_DISTRO, requireAnyChild: REQUIRE, union: true },
    { TOKENTRACKER_WSL_MODE: "both" },
    deps,
  );

  assert.equal(resolved.native, NATIVE);
  assert.equal(resolved.wsl, null);
});

test("native-only and wsl-only stay exclusive through wslDir discovery", (t) => {
  stubDiscovery(t);
  const nativeOnly = resolveInstallPaths(
    { nativeValue: NATIVE, wslDir: ".codex", requireAnyChild: REQUIRE, union: true },
    { TOKENTRACKER_WSL_MODE: "native-only" },
    deps,
  );
  assert.deepEqual([nativeOnly.native, nativeOnly.wsl], [NATIVE, null]);

  const wslOnly = resolveInstallPaths(
    { nativeValue: NATIVE, wslDir: ".codex", requireAnyChild: REQUIRE, union: true },
    { TOKENTRACKER_WSL_MODE: "wsl-only" },
    deps,
  );
  assert.deepEqual([wslOnly.native, wslOnly.wsl], [null, REAL_DISTRO]);
});
