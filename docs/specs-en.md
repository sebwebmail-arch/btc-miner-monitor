# Capone Watcher — Technical Specifications

**Version**: 1.0 — July 2026  
**Dashboard**: https://watcher.capone.market  
**Repository**: https://github.com/sebwebmail-arch/btc-miner-monitor

---

## 1. Purpose

Capone Watcher is a real-time monitoring system for Bitcoin mining operations on f2pool. It tracks two mining accounts — **Cyberian Mine** (`cmine`) and **Everminer** (`everminer`) — and provides live visibility into worker status, datacenter-level hashrate health, and automated alerts when things go wrong.

---

## 2. Architecture

```
f2pool API (every 30 min)
       │
       ▼
GitHub Actions (hashrate-collector.js)
       │  ├─ writes data/*.json → GitHub repo
       │  ├─ sends Telegram alerts (group drops)
       │  └─ sends Email alerts (group drops)
       │
GitHub Actions (monitor.js, daily 07:00 Paris)
       │  ├─ writes data/history.json
       │  └─ sends daily Email report
       │
       ▼
Vercel (static hosting)
       │
       ▼
https://watcher.capone.market (index.html reads data/*.json)
```

**Key principle**: there is no server-side runtime. All computation happens in GitHub Actions; the dashboard is a static HTML page that reads pre-computed JSON files committed to the repository.

---

## 3. Infrastructure

| Component | Service | Details |
|-----------|---------|---------|
| Dashboard hosting | Vercel | Free tier, auto-deploy on push to `main` |
| Scheduling | GitHub Actions | Cron via `cron-job.org` (external trigger via `workflow_dispatch`) |
| Email delivery | Resend | From `noreply@capone.market` |
| Alerts | Telegram Bot | `Capone Watcher bot` |
| DNS | Cloudflare | Nameservers for `capone.market` |
| Domain registrar | Hostinger | Nameservers delegated to Cloudflare |
| Source pool | f2pool | API at `api.f2pool.com/v2/hash_rate/worker/list` |

---

## 4. Data Pipeline

### 4.1 Hashrate Collector (`hashrate-collector.js`) — every 30 minutes

Triggered by GitHub Actions workflow `hashrate.yml`:

1. Fetches all workers from f2pool API for both accounts
2. Appends a new snapshot to each worker's time series in `data/hashrate.json` (7-day rolling window, max 337 snapshots)
3. Computes the current group hashrate (sum of h1_hash_rate for all workers in the group)
4. Compares against the reference hashrate (average of the last 3 stored snapshots = ~1h30 window)
5. If drop > 30% and cooldown (4h) not active → fires Telegram + Email alert
6. Detects per-worker anomalies (sustained drop or volatility) → updates `data/worker-issues.json`
7. Runs the morning report logic at 05:00 UTC (daily email)
8. Commits all modified data files back to the repository

### 4.2 Morning Report (`monitor.js`) — daily at 07:00 Paris (05:00 UTC)

1. Reads current worker list from f2pool
2. Classifies workers as Online / Offline (<24h) / Dead (>24h)
3. Sends email if any offline or dead workers are found
4. Maintains `data/history.json` (30-day rolling archive)

### 4.3 ATO (Actual Transfer Out)

Each hashrate snapshot also fetches the ATO value from the public f2pool web API. ATO is the hashrate actually committed to the pool — when Total (sum of workers) > ATO, the shortfall is internal to the datacenter (less urgent). When Total < ATO, client deliverables are impacted (higher priority).

---

## 5. Datacenter Groups

Workers are assigned to groups based on their name pattern (defined in `groups.js`):

| Group ID | Provider | Account(s) | Worker Pattern |
|----------|----------|------------|----------------|
| R1 | IZTM | cmine | `^r` |
| R3 | Minto | cmine | `^k2lx` |
| E1 | BitCluster | cmine | `^\d{1,4}$` (1–4 digits) |
| E2 | AmityAge | cmine + everminer | `^aa` |
| U1+U2 | Dataprana | everminer | `^(ngs\|yna\|pie\|olt\|dga)`, MAC format, or long numeric |
| U3 | ValueHash (NY) | cmine + everminer | `^(c21\|e21)` |
| P1 | Altos | everminer | `^s21` |
| F1 | Terahash | cmine | Explicit list of 14 machine names |
| OM | Open Mine | — | `^(omx\|openfall)` |
| No Group | — | — | Anything else — excluded from all reports |

**Note**: E1 (BitCluster) is excluded from real-time alerts because its hashrate fluctuates normally throughout the day.

---

## 6. Alert System

### 6.1 Real-time Group Alert (Telegram + Email)

| Parameter | Value |
|-----------|-------|
| Trigger | Group total hashrate drops > 30% vs. 1h30 reference |
| Cooldown | 4 hours per group |
| Reference window | Last 3 snapshots (~1h30) |
| Telegram routing | Per account: `TELEGRAM_CHAT_ID_CMINE`, `TELEGRAM_CHAT_ID_EVERMINER` |
| Duplicate channels | P1 (Altos) → also sent to `TELEGRAM_CHAT_ID_PARAGUAY`; R3 (Minto) → also sent to `TELEGRAM_CHAT_ID_MINTO` |
| Email | Per account email + cc to main alert address |

Alert format example:
```
⚠️ Hashrate Alert — capone watcher
📍 IZTM (R1) — Cyberian Mine
📉 Provider hashrate dropped by 48%
Before (avg 1h30): 29189.5 TH/s
Now: 15146.7 TH/s
🕐 05:30 UTC — 07:30 GMT+2
📊 https://watcher.capone.market
```

### 6.2 Recovery Notification

When a group recovers to ≥75% of its reference hashrate after an alert, a recovery message is sent to the same Telegram channel.

### 6.3 Worker Anomaly Detection (Dashboard only)

Individual worker anomalies are detected and shown in the dashboard but do **not** trigger Telegram or email alerts (too noisy). Workers are flagged as:

- **level_drop**: current 3h average < 60% of 12h baseline
- **volatile**: coefficient of variation > 55% or zero-rate > 35%

Thresholds:
- Current window: 6 snapshots (3h)
- Baseline: 24 snapshots (12h), minimum 12 required
- Minimum baseline to be analyzed: 5 TH/s

### 6.4 Daily Email Report (07:00 Paris)

Sent if any worker is offline or dead, or if there are hashrate anomalies.  
Subject format: `[ALERT] 3 offline · 2 anomalies — Tuesday 1 July 2026`  
Header color: red if offline workers present, orange if anomalies only.

---

## 7. Data Files

| File | Updated | Description |
|------|---------|-------------|
| `data/hashrate.json` | Every 30 min | Per-worker hashrate snapshots, 7-day rolling window |
| `data/history.json` | Daily | Daily worker status snapshots + current_issues |
| `data/alert-state.json` | Every 30 min | Cooldown timestamps for group alerts + worker watchlist |
| `data/worker-issues.json` | Every 30 min | Current hashrate anomalies (level_drop / volatile) |
| `data/offline-status.json` | Every 30 min | Current offline worker map |
| `data/worker-hosts.json` | Every 30 min | Worker → IP/host mapping |
| `data/sla-daily.json` | Daily | Per-group uptime metrics |
| `data/ghost-workers.json` | Every 30 min | Workers dead >24h, kept for 90 days |
| `data/watchlist.json` | Every 30 min | Workers with sustained anomalies, auto-expires after 14 days |

---

## 8. Dashboard (index.html)

A single-page vanilla JavaScript application. No framework. All data loaded from JSON files served by Vercel.

### Sections

1. **Health Cards** — Online / Offline <24h / Dead actionable / Dead archived counts
2. **Hashrate by Account** — Tabs cmine/everminer, aggregated TH/s chart, 24h/72h selector
3. **Datacenters at a Glance** — Grid of group cells colored ok/warn/critical
4. **Workers Requiring Attention** — Offline + dead workers table with Excel-style filters and sort
5. **Dead Tracker + 30-day Trend** — Historical dead worker counts
6. **Online Workers** — All active workers (avg 3h > 1 TH/s), anomaly badges, sorted anomalies-first

### Worker Modal

Clicking any worker name opens a modal with status pill, account + datacenter, 24h/72h hashrate chart (SVG), recommendation text, and a direct link to f2pool.

### Worker Comments

Any operator can leave a comment on any worker. Comments are stored in `localStorage` in the browser (device-local). Workers with comments show a green speech bubble icon (💬) next to their name.

### ATO Indicator

Each hashrate chart shows the ATO line. When total hashrate is above ATO, the gap is non-urgent. When below, it is shown as critical.

---

## 9. GitHub Secrets

| Secret | Description |
|--------|-------------|
| `F2POOL_TOKEN_CMINE` | f2pool API key — Cyberian Mine |
| `F2POOL_TOKEN_EVERMINER` | f2pool API key — Everminer |
| `RESEND_API_KEY` | Resend email API key |
| `ALERT_FROM` | Sender address (`noreply@capone.market`) |
| `ALERT_EMAIL` | Fallback alert recipient |
| `ALERT_EMAIL_CMINE` | Alert recipient for cmine |
| `ALERT_EMAIL_EVERMINER` | Alert recipient for everminer |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (from @BotFather) |
| `TELEGRAM_CHAT_ID` | Fallback Telegram chat ID |
| `TELEGRAM_CHAT_ID_CMINE` | Telegram group for cmine alerts |
| `TELEGRAM_CHAT_ID_EVERMINER` | Telegram group for everminer alerts |
| `TELEGRAM_CHAT_ID_PARAGUAY` | Telegram group for Altos/P1 alerts |
| `TELEGRAM_CHAT_ID_MINTO` | Telegram group for Minto/R3 alerts |

---

## 10. f2pool API

```
POST https://api.f2pool.com/v2/hash_rate/worker/list
Header: F2P-API-SECRET: <token>
Body: { "mining_user_name": "cmine", "currency": "bitcoin" }
```

**Important**: the `status` field in the API response is unreliable. Worker online/offline status is always derived from `last_share_at` (Unix timestamp).

Worker fields used:
- `hash_rate_info.name` — worker name
- `hash_rate_info.h1_hash_rate` — 1h average hashrate (H/s)
- `hash_rate_info.hash_rate` — fallback if h1 missing
- `last_share_at` — last share timestamp
- `host` — worker IP or hostname

Read-only public links:
- cmine: `https://www.f2pool.com/mining-user/dad5e8d0452ce3262084e3afef6003ec?user_name=cmine`
- everminer: `https://www.f2pool.com/mining-user/d87416827c22b5c9aadb86e10535c4e0?user_name=everminer`

---

## 11. Known Behaviors and Edge Cases

- **Baseline warm-up**: anomaly detection requires at least 9h of data before it can fire.
- **E1 (BitCluster) excluded**: intentionally excluded from real-time alerts due to normal daily hashrate cycling.
- **ATO business logic**: total > ATO = less urgent (internal datacenter issue); total < ATO = client impact = higher priority.
- **Worker comment storage**: stored in browser `localStorage` — not shared between devices or operators.
- **f2pool `status` field**: always `0` (online) in the API — ignore it; use `last_share_at`.
- **GitHub Actions data commits**: run every 30 minutes. When pushing local code changes, always rebase first to avoid conflicts.
- **Telegram bot token expiry**: if the bot stops sending, run the "Test Telegram" GitHub Actions workflow to diagnose. If expired, regenerate via @BotFather and update the `TELEGRAM_BOT_TOKEN` secret.
