# Achievements

Badge faces in this directory are original TokenTracker artwork (256px,
pngquant-quantized), one PNG per badge id.

## Badges: how to earn them

Every badge has four tiers — Bronze / Silver / Gold / Diamond. Tiers are
monotonic (once earned, never lost) and each tier's first-achieved date is
recorded. Cloud badges are recomputed every 6 hours from the account's
deduplicated cross-device history (UTC days); local badges are computed
on-device in real time and never leave the machine.

> Threshold source of truth: the `tokentracker_badge_catalog` seed in
> `scripts/ops/user-badges.sql` (cloud) and `LOCAL_BADGE_THRESHOLDS` in
> `src/lib/local-api.js` (local). The table below is documentation — if it
> ever disagrees with those, they win.

### Cloud badges

| Badge | Condition | Bronze | Silver | Gold | Diamond |
|---|---|---|---|---|---|
| **Token Titan** (`token_titan`) | Lifetime total tokens across all tools | 100M | 1B | 10B | 100B |
| **Big Day** (`big_day`) | Most tokens in a single UTC day | 10M | 100M | 500M | 3B |
| **Wordsmith** (`wordsmith`) | Lifetime output tokens (text/code the models actually generated — cache reads don't count) | 5M | 25M | 100M | 300M |
| **Marathoner** (`marathoner`) | Total active days (any usage that UTC day) | 7 | 30 | 100 | 365 |
| **On Fire** (`streak`) | Longest run of consecutive active days | 3 | 7 | 30 | 100 |
| **Weekend Warrior** (`weekend_warrior`) | Active days falling on a UTC Saturday or Sunday | 5 | 20 | 50 | 100 |
| **Momentum** (`momentum`) | Biggest week-over-week growth between two *adjacent* ISO weeks; the earlier week must have ≥10M tokens | 2× | 6× | 15× | 40× |
| **Model Polyglot** (`polyglot`) | Distinct models used | 5 | 15 | 30 | 60 |
| **Trendsetter** (`trendsetter`) | Models you started using within 7 days of their global debut across all TokenTracker users (only models with ≥5 users count, so private/BYO model names can't self-qualify) | 2 | 5 | 10 | 20 |
| **Multitool** (`multitool`) | Distinct AI tools (providers) tracked | 2 | 4 | 6 | 10 |
| **Podium** (`podium`) | Best-ever rank on the all-time leaderboard | Top 100 | Top 30 | Top 10 | Top 3 |
| **Veteran** (`veteran`) | Days since your first tracked day | 30 | 90 | 180 | 365 |

### Local badges (this device only, never uploaded)

| Badge | Condition | Bronze | Silver | Gold | Diamond |
|---|---|---|---|---|---|
| **Project Hopper** (`project_hopper`) | Distinct projects with tracked usage | 3 | 5 | 10 | 20 |
| **Project Devotion** (`project_devotion`) | Lifetime tokens poured into a single project | 1M | 10M | 100M | 1B |
| **Night Owl** (`night_owl`) | Active hours between midnight and 6 AM local time | 5 | 20 | 60 | 150 |
