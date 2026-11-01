# DuMate usage collection

TokenTracker reads DuMate's local OpenCode database without installing hooks or reading credentials. Usage appears under the independent `dumate` source alongside native OpenCode. It counts the Qianfan runtime identified by `providerID=QianfanPersonalQuota`, including the nested OpenCode model form. It does not infer the provider from model names.

On Windows, automatic discovery scans every installation under `%APPDATA%\qianfan-desktop-app\qianfan_desk_xdg\<install-id>\data\opencode\opencode.db`. The fallback when `APPDATA` is unset is `AppData\Roaming` under the user home.

To override discovery, set `TOKENTRACKER_DUMATE_HOME` to one of these directories:

- An installation's `data\opencode` directory.
- An installation's XDG directory containing `data\opencode`.
- The `qianfan_desk_xdg` directory containing all installation IDs.

An explicit override pins the scan to that directory. It also works on macOS and Linux for copied databases. It does not replace `OPENCODE_HOME`.

Run `tracker sync` to collect usage and `tracker status` to see detected databases. Reinstalled copies share a message cursor, so copying an existing database to another installation does not add its usage again. If copies differ, the row with the newest database update timestamp wins.

DuMate's OpenAI-compatible adapter reports reasoning as a subset of output. The DuMate reader subtracts reasoning from raw output before the existing OpenCode parser stores the separate columns. The issue's sample becomes input 1,070 + output 70 + reasoning 818 + cache 768 = 2,726 tokens; output pricing applies to 888 tokens once. The SQLite integration tests cover this complete sample, multi-install discovery, copied history, stale-copy recovery, independent OpenCode cursors, and consecutive syncs. A real Windows DuMate installation remains to be verified.

The official [macOS installer](https://dumate-app-public.cdn.bcebos.com/release-info/artifacts/Dumate-mac-arm64-latest.dmg), downloaded on 2026-10-12 from the [DuMate website](https://www.dumate.cn/), reports version 1.0.83. Its SHA-256 is `6f30eaa15451e38c1b22817e048a5753e7d58cc0dcf5305e400d4742bbe91ddd`. Read-only inspection found the default provider in `Contents/Resources/config/opencode/opencode.json`, and the bundled `dumate-opencode` binary contains OpenCode's `import <file>` command. That command stores the imported message IDs, provider IDs and tokens without an import marker. Filtering on the Qianfan provider prevents imported non-Qianfan Claude or OpenCode history from being counted again as DuMate. Other custom providers are currently excluded.

Inspection of the Electron application code and kernel strings did not find `claude_import`, `importedFrom`, or `.claude/projects`. This does not prove that all automatic history mirroring is absent. Import behavior was inspected in the official binary; no application was launched, and a runtime import test remains to be verified.
