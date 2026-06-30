# Capone Watcher — Context

## What this is

Bitcoin miner monitoring system for f2pool. Two accounts: **Cyberian Mine** (`cmine`) and **Everminer** (`everminer`). Tracks worker status, hashrate health, sends alerts, and publishes a live dashboard.

## Stack

- **Dashboard**: static `index.html` served by **Vercel** at https://watcher.capone.market
- **DNS**: Cloudflare (nameservers: `ara.ns.cloudflare.com`, `jarred.ns.cloudflare.com`) — Hostinger is registrar only
- **Data**: JSON files committed to GitHub, served statically by Vercel from `data/`
- **Scheduling**: GitHub Actions (NOT Vercel cron — already used for another project)
- **Email**: Resend API, from `noreply@capone.market`, to `support@cyberianmine.de`
- **Telegram**: bot `Capone Watcher bot`, token in `TELEGRAM_BOT_TOKEN` secret

## Repository

`github.com/sebwebmail-arch/btc-miner-monitor`

### Git identity rules (IMPORTANT)
- Local commits: `seb.webmail@gmail.com` (matches GitHub account → Vercel allows deploy)
- GitHub Actions commits: `github-actions[bot]@users.noreply.github.com`
- Vercel blocks deployments from committers not matched to a GitHub user

### Recurring git issue
GitHub Actions commits to `data/` every 30min. Before pushing locally, always:
```bash
git pull --rebase --autostash origin main && git push
```

## Files

| File | Role |
|------|------|
| `monitor.js` | Daily report: fetch workers, detect offline/dead, send email, update history.json |
| `hashrate-collector.js` | Every 30min: collect hashrate snapshots, detect group drops + worker anomalies, send Telegram/email alerts |
| `groups.js` | Worker name → group mapping (shared by both scripts) |
| `index.html` | Full dashboard SPA (no framework, vanilla JS) |
| `data/history.json` | Daily snapshots + current_issues (offline/dead workers) |
| `data/hashrate.json` | Per-worker hashrate snapshots, 30min intervals, 3-day rolling window |
| `data/alert-state.json` | Cooldown timestamps for group + worker alerts |
| `data/worker-issues.json` | Current hashrate anomalies (level_drop / volatile), written every 30min |
| `.github/workflows/monitor.yml` | Cron: 05:00 UTC (07:00 Paris CEST) |
| `.github/workflows/hashrate.yml` | Cron: every 30min (0,30 * * * *) |

## GitHub Secrets

| Secret | Value / Notes |
|--------|---------------|
| `F2POOL_TOKEN_CMINE` | f2pool API key for cmine |
| `F2POOL_TOKEN_EVERMINER` | f2pool API key for everminer |
| `RESEND_API_KEY` | Resend API key |
| `ALERT_FROM` | `noreply@capone.market` |
| `ALERT_EMAIL` | `support@cyberianmine.de` (fallback) |
| `ALERT_EMAIL_CMINE` | `support@cyberianmine.de` |
| `ALERT_EMAIL_EVERMINER` | `support@cyberianmine.de` |
| `TELEGRAM_BOT_TOKEN` | `8631394959:AAEKKObqAtE01ClQztCNJotFnX9GxdU6jno` |
| `TELEGRAM_CHAT_ID` | `4857292784` (fallback) |
| `TELEGRAM_CHAT_ID_CMINE` | `4857292784` (same for now — separate later) |
| `TELEGRAM_CHAT_ID_EVERMINER` | `4857292784` (same for now — separate later) |

## f2pool API

```
POST https://api.f2pool.com/v2/hash_rate/worker/list
Header: F2P-API-SECRET: <token>
Body: { "mining_user_name": "cmine", "currency": "bitcoin" }
```

**CRITICAL**: `status` field is unreliable. Always derive online/offline from `last_share_at`.

Worker fields used:
- `hash_rate_info.name` — worker name
- `hash_rate_info.h1_hash_rate` — 1h average hashrate in H/s
- `hash_rate_info.hash_rate` — fallback if h1 missing
- `last_share_at` — Unix timestamp of last share
- `host` — IP or hostname

## Worker groups (groups.js)

| ID | Provider | Pattern |
|----|----------|---------|
| R1 | IZTM | `^r` |
| R3 | Minto | `^k2lx` |
| E1 | BitCluster | `^\d+$` (all digits) |
| E2 | AmityAge | `^aa` |
| U1+U2 | Dataprana | `^(ngs\|yna\|pie\|olt\|dga)` |
| U3 | ValueHash (NY) | `^(c21\|e21)` |
| P1 | Altos | `^s21` |
| F1 | Terahash | `^18x` |
| No Group | — | anything else → excluded from all reports |

## Dashboard sections (index.html)

1. **Health cards** — Online / Offline <24h / Dead actionable / Dead archived counts
2. **Hashrate by account** — Tabs cmine/everminer, aggregated TH/s chart, 24h/72h selector. Source: `hashrate.json`
3. **Datacenters at a glance** — Tabs cmine/everminer, grid of group cells (ok/warn/critical)
4. **Workers requiring attention** — Offline + dead (≤90d) table with Excel-style filters + sort
5. **Dead tracker + 30-day trend** — Side by side
6. **Online workers** — ALL active workers (avg 3h > 1 TH/s), anomalies shown inline with badge + colored row, sorted anomalies-first

### Worker modal
Opens on click of any worker name. Shows:
- Status pill (Online / Offline Xh / Dead Xd)
- Account + datacenter
- Hashrate SVG chart, 24h/72h selector
- Recommendation text
- Link to f2pool

Works for both issue workers (from `history.json`) and online workers (derived from `hashrate.json`).

### f2pool read-only links
- cmine: `https://www.f2pool.com/mining-user/dad5e8d0452ce3262084e3afef6003ec?user_name=cmine`
- everminer: `https://www.f2pool.com/mining-user/d87416827c22b5c9aadb86e10535c4e0?user_name=everminer`

## Emails sent

### 1. Daily report — 07:00 Paris (monitor.yml)
- **Trigger**: at least 1 offline worker OR at least 1 hashrate anomaly
- **To**: `support@cyberianmine.de`
- **Subject**: `[ALERT] 3 offline · 2 anomalies — Tuesday 1 July 2026`
- **Content**: offline workers grouped by datacenter, then hashrate anomaly table
- **Header color**: red if offline, orange if anomalies only

### 2. Real-time group alert — every 30min (hashrate.yml)
- **Trigger**: group total hashrate drops >30% vs 1h30 reference, cooldown 4h per group
- **Channels**: Telegram + email, routed per account (cmine → TELEGRAM_CHAT_ID_CMINE, etc.)

### 3. Real-time worker alert — every 30min (hashrate.yml)
- **Trigger**: individual worker level_drop or volatile, cooldown 8h per worker
- **Channels**: Telegram only

## Known issues / notes

- `data/alert-state.json` and `data/worker-issues.json` may not exist on first run — both scripts handle this gracefully
- Hashrate anomaly detection requires **9h+ of data** before it can fire (needs baseline window)
- Telegram chat IDs for cmine and everminer both point to `4857292784` for now — separate when real groups are set up
- Gmail blocks `raw.githubusercontent.com` images and base64 URIs → always use hosted SVG at `https://capone.market/capone-fish-avatar-48-orange.svg`
