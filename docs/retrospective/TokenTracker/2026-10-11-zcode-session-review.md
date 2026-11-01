---
repo: TokenTracker
layer: fullstack
module: session-analytics
severity: S2
design_mismatch: yes
detection_gap: yes
---

# ZCode session review — 2026-10-11

New activity since the v1.3.5 publication was concentrated in [PR #779](https://github.com/xiufengsun/TokenTracker/pull/779). The author's latest shared timestamp-coercion commit, b127c081, was incorporated before final validation. The older held PRs and issue evidence gaps have not been represented as newly resolved.

## Reviewed behavior

- ZCode native and legacy usage uses the existing normalized reader. Input/cache and output/reasoning stay disjoint; separately reported reasoning remains part of the total and cost. Unknown model rates retain tokens and expose partial cost estimates.
- Windows install selection respects all five modes, including both. Native and WSL databases form one inventory. Shared session/event identities collapse while each install's distinct sessions and divergent tails remain. Database copies do not double their request timing, turn or edit counters.
- Forked history follows the ledger's existing narrow fingerprint contract: both timestamps, every token category, model, provider and source. A different session is required for a fork-copy match; distinct same-session turns remain counted. A regression compares scanned totals with a real parseOpencodeDbIncremental queue.
- Session lineage is keyed by source and session ID throughout parent lookup, cycle detection, aggregation and root resolution. Identical Codex and ZCode IDs cannot connect unrelated parents or children. ZCode children participate in observed subagent summaries.
- Model/API retry counts do not become repeated user requests. The native numeric records provide no prompt-repetition evidence, so retry provenance is unavailable rather than inferred from model retries.
- The cache signature includes every selected database and its WAL/SHM sidecars. A failed read retains the last complete ZCode inventory and cache metadata, reports skipped files, and retries rather than caching an empty or partial inventory. A separate durable marker invalidates TTL, signature and per-file reuse after a real SQLite lock that leaves file stats unchanged. UNC reads use one local snapshot per database; metadata queries are read-only.
- The sidecar schema is version 21 so older cached metrics are rebuilt. Minute usage buckets retain the number of requests sharing each minute, feed the existing local-day filters and preserve token-category/model parity in details and descendant totals.

## Validation

- Stable final local CLI run: 3,962 passed, zero failed, 57 platform/precondition skips; 4,019 tests total. A previous run overlapped a Git merge and two subprocesses read temporary conflict markers; that run was discarded and the full suite rerun after freezing the source.
- Full dashboard suite: 152 files and 1,528 tests passed. Dashboard TypeScript checking and the production build passed.
- Final focused analytics/performance/fork suite: 62 passed. All 24 ZCode tests passed. Windows fixtures exercise both-install discovery, shared-prefix/divergent-tail preservation, cache hits, appends, failed scans, real unchanged-stat SQLite locks and recovery.
- Copy registry, Chinese coverage, UI string guard, architecture guards, bot frames and managed versions passed. All release version locations are synchronized to 1.3.6.
- Browser acceptance used an isolated, synthetic local database. ZCode filtering, parent/child expansion, unknown-price labeling and disabled unverified resume commands worked. Unrestricted usage was 3,800 tokens; October 10 scoped to 2,000, and October 11 scoped to 1,800. The first-day detail showed input 200, cache read 1,000, output 700 and reasoning 100. The second-day parent showed 1,000 own tokens plus 400 child tokens, without counting the child twice in the overall 1,800 total.

## Release gates and limits

Merge requires current-head platform CI and review. Publication requires exact-main CI, npm source/integrity verification, all six desktop assets with downloaded-byte checksums, and matching Homebrew metadata. This change does not require cloud edge deployment, schema migration or a customer-history reset.

Populated, real WSL end-to-end acceptance remains environment-dependent: the contributor's real WSL scan used an empty database. The Windows mode/cache fixtures and existing snapshot implementation are tested; they do not prove every WSL filesystem or locking configuration.
