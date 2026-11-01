# Sentry setup (TokenTracker)

Org: [`tokentracker`](https://tokentracker.sentry.io/) (Sponsored Business).

## Projects (created)

| Project slug | Platform | Used by | DSN env |
|---|---|---|---|
| `tokentracker-dashboard` | React / JavaScript | `dashboard/` (`@sentry/react`), including desktop WebViews | `VITE_SENTRY_DSN` |
| `tokentracker-node` | Node.js | CLI + EmbeddedServer (`@sentry/node` in `src/lib/sentry.js`) | `TOKENTRACKER_SENTRY_DSN` |

Do **not** add native Swift / .NET / Tauri projects in v1 — those shells mostly host the dashboard + Node runtime above.

Keys (rotate in Sentry UI if needed):

- Dashboard: https://tokentracker.sentry.io/settings/projects/tokentracker-dashboard/keys/
- Node: https://tokentracker.sentry.io/settings/projects/tokentracker-node/keys/

## Where DSNs are wired (do not commit DSN strings)

Public client DSNs are safe to embed (same model as PostHog / InsForge anon key), but this repo keeps them **out of git** and injects at build/deploy time.

| Surface | Env var | Where it is set |
|---|---|---|
| Hosted dashboard (`www.tokentracker.cc`) | `VITE_SENTRY_DSN` | **Vercel** project env (Production + Preview). Must be set in the Vercel dashboard or `vercel env add` while logged in as the project owner. |
| CI / release dashboard builds (desktop WebViews + npm `dashboard/dist`) | `VITE_SENTRY_DSN` | GitHub Actions secret `VITE_SENTRY_DSN`, passed into every `Build dashboard` step in `ci.yml`, `npm-publish.yml`, `release-dmg.yml`, `release-windows.yml` as `${{ secrets.VITE_SENTRY_DSN }}` (value is not echoed). |
| Node CLI / EmbeddedServer | `TOKENTRACKER_SENTRY_DSN` | Process env for local/operator use. Optional; leave unset to keep Node Sentry off. Not injected by release workflows yet (desktop shells do not currently forward this var). |

Until a DSN is set for a surface, Sentry stays fully off there.

Optional: `TOKENTRACKER_SENTRY_ENVIRONMENT` overrides the Node environment tag (`production` / `development`).

Local / `.env` names (empty values only) are listed in [`.env.example`](../.env.example).

### Vercel (hosted site)

From a machine logged into the Vercel project that serves `www.tokentracker.cc` (dashboard app):

```bash
cd dashboard
printf '%s' "$VITE_SENTRY_DSN" | npx vercel env add VITE_SENTRY_DSN production
printf '%s' "$VITE_SENTRY_DSN" | npx vercel env add VITE_SENTRY_DSN preview
```

Then redeploy production so the Vite build picks up the var. Or set the same name under Project → Settings → Environment Variables in the Vercel UI.

### GitHub Actions secret

Already configured on `xiufengsun/TokenTracker` as `VITE_SENTRY_DSN`. To rotate:

```bash
printf '%s' 'NEW_DSN' | gh secret set VITE_SENTRY_DSN -R xiufengsun/TokenTracker
```

## Auth for `sentry-cli` / source maps

Creating projects and uploading source maps needs an org auth token (not committed). **Skipped for v1** (no `SENTRY_AUTH_TOKEN` yet).

1. Sentry → Settings → Auth Tokens (or Custom Integrations → Internal Integration) with `project:write` + `org:read`.
2. `export SENTRY_AUTH_TOKEN=...`
3. `sentry-cli projects list -o tokentracker`

## Privacy

Sentry is covered by the same opt-out as anonymous telemetry: `TOKENTRACKER_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`, or `"telemetry": false` in `config.json`. See [PRIVACY.md](./PRIVACY.md).
