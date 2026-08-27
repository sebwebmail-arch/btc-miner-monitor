# Technical Specification — Capone Watcher

**Product**: watcher.capone.market  
**Version**: July 2026  
**Purpose**: Architecture, technologies, frontend and backend design.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  SCHEDULER                                                          │
│  cron-job.org → POST GitHub API (workflow_dispatch) every 30 min   │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  BACKEND (GitHub Actions — Ubuntu Runner)                           │
│  hashrate-collector.js (Node.js 20)                                 │
│  ├── f2pool API calls (workers + ATO)                               │
│  ├── Anomaly detection                                              │
│  ├── Telegram alerts (Bot API)                                      │
│  ├── Email alerts (Resend API)                                      │
│  └── Commit + push → data/*.json into GitHub repo                  │
└────────────────────────────┬────────────────────────────────────────┘
                             │ git push (main)
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  DATA LAYER (GitHub — public repository)                            │
│  sebwebmail-arch/btc-miner-monitor                                  │
│  └── data/*.json (static JSON files)                                │
└────────────────────────────┬────────────────────────────────────────┘
                             │ raw.githubusercontent.com
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  FRONTEND (Vercel — static CDN)                                     │
│  index.html (single-file vanilla HTML/CSS/JS)                       │
│  sla.html   (SLA page, single-file)                                 │
└─────────────────────────────────────────────────────────────────────┘
```

**Key characteristic**: the system is entirely serverless. There is no database, no exposed backend API, no persistent service. State is stored in versioned JSON files on GitHub.

---

## 2. Technology Stack

| Component | Technology / Service | Role |
|-----------|---------------------|------|
| Scheduler | cron-job.org (free) | Triggers GitHub Actions workflow every 30 min |
| Backend | Node.js 20, GitHub Actions | Collection, detection, alerts |
| Data storage | GitHub (public repo) | JSON storage, accessible via raw URLs |
| Frontend | Vanilla HTML/CSS/JS | Static dashboard, zero framework |
| Frontend hosting | Vercel (free) | CDN, HTTPS, deployment from GitHub |
| Email | Resend API (free tier) | HTML email delivery |
| Messaging | Telegram Bot API | Real-time alerts |
| Mining pool | f2pool API v2 | Worker data source |

---

## 3. GitHub Repository

**Name**: `sebwebmail-arch/btc-miner-monitor`  
**Visibility**: **public** (required so that raw URLs are accessible without authentication by the dashboard)

### File Structure

```
btc-miner-monitor/
├── hashrate-collector.js      # Main script (backend)
├── groups.js                  # Worker name → group/provider mapping
├── package.json               # Node config (no external dependencies)
├── index.html                 # Main dashboard (frontend)
├── sla.html                   # SLA page (frontend)
├── data/
│   ├── hashrate.json          # Worker snapshots (rolling 7 days)
│   ├── alert-state.json       # Cooldown state + watchlist (backend)
│   ├── worker-issues.json     # Active anomalies (for dashboard)
│   ├── watchlist.json         # Still Degraded (for dashboard)
│   ├── offline-status.json    # Offline + dead workers (for dashboard)
│   ├── history.json           # Account-level history (35 days)
│   ├── sla-daily.json         # Daily SLA aggregates (30 days)
│   ├── worker-hosts.json      # Worker → host URL mapping (static)
│   ├── ghost-workers.json     # Registry of Dead workers absent from API (90 days)
│   └── no-group.json          # Workers without a group assignment (real-time)
└── .github/
    └── workflows/
        └── hashrate.yml       # GitHub Actions workflow
```

---

## 4. Backend — hashrate-collector.js

### 4.1 Triggering

The GitHub Actions workflow is triggered by a `workflow_dispatch` event (HTTP POST to the GitHub API). cron-job.org sends this request every 30 minutes using a GitHub authentication token (secret `CRON_TOKEN`).

### 4.2 Execution Sequence

```
1. git pull --rebase origin main           # Sync with recent data commits
2. For each account (cmine, everminer):
   a. fetchWorkers()                       # f2pool API v2 call → worker list
   b. fetchATO()                           # f2pool web call → current ATO
   c. Update hashrate.json                 # Snapshot stored per worker
3. Detect group drops                      # Telegram + email if threshold exceeded
4. Detect worker anomalies                 # Telegram + email if threshold exceeded
5. Update ghost-workers.json              # Detect ghosts, remove resolved, expire 90d
6. Detect No Group workers                # Telegram + email alerts if cooldown OK
7. Update offline-status.json             # Offline workers + Dead ghosts
8. Watchlist check (recovery + expiry)    # Update watchlist.json
9. Morning report (if 05:00 UTC)          # Summary email
10. Daily SLA computation (if 05:00 UTC) # Update sla-daily.json
11. git add data/*.json
    git commit -m "data: snapshot {timestamp}"
    git push origin main
```

### 4.3 f2pool API

**Workers** (real-time list):
- URL: `POST https://api.f2pool.com/v2/hash_rate/worker/list`
- Auth: `F2P-API-SECRET: {token}` header
- Body: `{ "mining_user_name": "{user}", "currency": "bitcoin" }`
- Response: `workers` array with `hash_rate_info.h1_hash_rate`, `hash_rate_info.status`, `hash_rate_info.last_share_at`, etc.
- **Important**: f2pool only returns Online and Offline workers in this response. Dead workers (inactive > 24h) are removed from the API response after ~24h.

**ATO** (hashrate distributed to clients — _Actual Transfer Out_):
- URL: `https://www.f2pool.com/mining-user/{readKey}?user_name={user}&...&action=load_by_duration&duration=1`
- Undocumented web endpoint, discovered by browser network inspection
- Returns `transfer_actually_hashrate.values` (array of [timestamp, TH/s] points)
- Last point converted to H/s for consistency with worker data

**Worker status codes**:
- `status = 0` → ONLINE
- `status = 1` → OFFLINE (counter-intuitive)

### 4.4 Data Files — Structure and Retention

#### hashrate.json

```json
{
  "last_updated": "2026-07-05T20:30:54Z",
  "workers": {
    "cmine.s21xp001": [
      { "ts": "2026-07-05T20:00:00Z", "hr": 102400000000000 },
      ...
    ]
  },
  "accounts": {
    "cmine": [
      { "ts": "2026-07-05T20:00:00Z", "ato": 512000000000000 },
      ...
    ]
  }
}
```

- Worker retention: 337 snapshots max (~7 days)
- Internal units are **H/s** (not TH/s) for calculation precision

#### alert-state.json

Flat JSON file. Several key types:

```json
{
  "cmine.P1": "2026-06-30T19:00:58Z",           // group cooldown
  "w.cmine.s21xp002": "2026-06-30T22:01Z",      // worker cooldown
  "morning_2026-07-05": "2026-07-05T05:00Z",    // morning anti-duplicate
  "nogroup.cmine.02011366de33": "2026-07-06T08:00Z", // No Group cooldown
  "watchlist": {
    "w.cmine.s21xp002": {
      "type": "worker_anomaly",
      "baselineHR": 513200000000000,
      "currentHR": 28948919479755,
      "worker": "s21xp002",
      "account": "cmine",
      "groupId": "P1",
      "anomalyType": "level_drop",
      "detectedAt": "2026-06-30T19:00:00Z"
    }
  }
}
```

#### watchlist.json

File produced by the backend for the dashboard (rebuilt each run):

```json
{
  "last_updated": "2026-07-05T20:30:54Z",
  "entries": [
    {
      "key": "w.cmine.s21xp002",
      "type": "worker_anomaly",
      "provider": "Altos",
      "group_id": "P1",
      "account": "cmine",
      "account_name": "Cyberian Mine",
      "worker": "s21xp002",
      "anomaly_type": "level_drop",
      "baseline_hr": 513200000000000,
      "current_hr": 28948919479755,
      "drop_pct": 94,
      "detected_at": "2026-06-30T19:00:00Z",
      "duration_h": 121.5
    }
  ]
}
```

#### worker-issues.json

Active anomalies from the last run. Key = `{account}.{worker}`:

```json
{
  "issues": {
    "cmine.s21xp002": {
      "type": "level_drop",
      "worker": "s21xp002",
      "account_name": "Cyberian Mine",
      "group_id": "P1",
      "provider": "Altos",
      "drop_pct": 94,
      "current_avg_ths": "28.9",
      "baseline_avg_ths": "513.2"
    }
  }
}
```

#### offline-status.json

Offline and dead workers from the last run. Now includes ghost workers (Dead workers absent from the API):

```json
{
  "last_updated": "2026-07-06T08:00:00Z",
  "offline": {
    "cmine.s21xp005": {
      "account": "cmine",
      "account_name": "Cyberian Mine",
      "name": "s21xp005",
      "group_id": "P1",
      "provider": "Altos",
      "dead": false,
      "category": "offline",
      "last_share": "2026-07-06T07:15:00Z"
    },
    "cmine.c21xp001": {
      "account": "cmine",
      "account_name": "Cyberian Mine",
      "name": "c21xp001",
      "group_id": "U3",
      "provider": "ValueHash (NY)",
      "dead": true,
      "category": "dead_recent",
      "last_share": "2026-07-02T18:58:00Z"
    }
  }
}
```

Ghost worker fields:
- `dead: true` — ghost marker
- `category` — `offline` / `dead_recent` / `dead_mid` / `dead_old` (recalculated each run)
- `last_share` — ISO string of the last known snapshot (used by `categoryOf()` in the dashboard)

#### ghost-workers.json

Persistent registry of Dead workers that have disappeared from the f2pool API. Survives `hashrate.json`'s 7-day rolling window:

```json
{
  "last_updated": "2026-07-06T08:00:00Z",
  "ghosts": {
    "cmine.c21xp001": {
      "account": "cmine",
      "account_name": "Cyberian Mine",
      "name": "c21xp001",
      "groupId": "U3",
      "provider": "ValueHash (NY)",
      "lastSnapIso": "2026-07-02T18:58:00Z",
      "detectedAt": "2026-07-03T10:30:00Z"
    }
  }
}
```

Registry lifecycle on each run:
1. `findGhostWorkers(hrData, accountUser, currentWorkerNames, now)`: compares `hashrate.json` vs API → returns workers absent from API with a snapshot < 7 days old
2. New ghosts → added to registry with `lastSnapIso` and `detectedAt`
3. Workers returning to the API → removed from registry (resolved)
4. Workers > 90 days old → expired and deleted

`getGhostsFromStore(ghostData, accountUser, now)`: reads the registry, recalculates category, filters out `dead_old`.

#### no-group.json

Workers returned by the API but matching no known group:

```json
{
  "last_updated": "2026-07-06T08:00:00Z",
  "workers": [
    {
      "account": "cmine",
      "account_name": "Cyberian Mine",
      "name": "unknownworker01",
      "hr3h": 98000000000000,
      "host": "?"
    }
  ]
}
```

Updated every run. Empty if no No Group workers exist.

#### sla-daily.json

```json
{
  "days": [
    {
      "date": "2026-07-04",
      "continuity":   { "cmine::P1": 0.94, "cmine::U3": 0.87, ... },
      "dc_combined":  { "cmine::P1": 0.91, ... },
      "account_perf": { "cmine": 0.96, "everminer": 0.98 }
    },
    ...
  ]
}
```

### 4.5 GitHub Actions Workflow — hashrate.yml

```yaml
name: Hashrate Collector
on:
  workflow_dispatch:
  schedule:
    - cron: '*/30 * * * *'   # Fallback if cron-job.org is unavailable

jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - name: Pull latest data
        run: git pull --rebase --autostash origin main
      - name: Run collector
        run: node hashrate-collector.js
        env:
          F2POOL_TOKEN_CMINE:          ${{ secrets.F2POOL_TOKEN_CMINE }}
          F2POOL_TOKEN_EVERMINER:      ${{ secrets.F2POOL_TOKEN_EVERMINER }}
          RESEND_API_KEY:              ${{ secrets.RESEND_API_KEY }}
          ALERT_EMAIL:                 ${{ secrets.ALERT_EMAIL }}
          TELEGRAM_BOT_TOKEN:          ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID:            ${{ secrets.TELEGRAM_CHAT_ID }}
          TELEGRAM_CHAT_ID_CMINE:      ${{ secrets.TELEGRAM_CHAT_ID_CMINE }}
          TELEGRAM_CHAT_ID_EVERMINER:  ${{ secrets.TELEGRAM_CHAT_ID_EVERMINER }}
          TELEGRAM_CHAT_ID_PARAGUAY:   ${{ secrets.TELEGRAM_CHAT_ID_PARAGUAY }}
          TELEGRAM_CHAT_ID_MINTO:      ${{ secrets.TELEGRAM_CHAT_ID_MINTO }}
      - name: Commit & push data
        run: |
          git config user.name  "capone-watcher[bot]"
          git config user.email "bot@capone.market"
          git add data/hashrate.json data/worker-issues.json \
                  data/alert-state.json data/offline-status.json \
                  data/history.json data/sla-daily.json \
                  data/watchlist.json data/ghost-workers.json \
                  data/no-group.json 2>/dev/null || true
          git diff --cached --quiet || git commit -m "data: snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ)"
          git push origin main
```

### 4.6 GitHub Secrets

| Secret | Usage |
|--------|-------|
| `F2POOL_TOKEN_CMINE` | f2pool API auth for cmine account |
| `F2POOL_TOKEN_EVERMINER` | f2pool API auth for everminer account |
| `RESEND_API_KEY` | Resend email auth |
| `ALERT_EMAIL` | Morning report + No Group alert recipient |
| `ALERT_FROM` | Email sender address (noreply@capone.market) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` | General Telegram channel (No Group alerts) |
| `TELEGRAM_CHAT_ID_CMINE` | Cyberian Mine Telegram channel |
| `TELEGRAM_CHAT_ID_EVERMINER` | Everminer Telegram channel |
| `TELEGRAM_CHAT_ID_PARAGUAY` | Paraguay Telegram channel (P1 duplication) |
| `TELEGRAM_CHAT_ID_MINTO` | Minto Telegram channel (R3 duplication) |

---

## 5. Frontend — index.html

### 5.1 General Architecture

The dashboard is a **single HTML file**. CSS and JavaScript are inlined within `<style>` and `<script>` tags. No framework, no bundler, no npm dependencies.

**Deployment**: the GitHub/Vercel webhook is unreliable on this project. Always deploy with `npx vercel --prod` from the local terminal (see § 7.2).

### 5.2 Data Loading

On page load, a `Promise.all()` fetches all JSON files in parallel:

```javascript
const [hrRes, issRes, wlRes, offRes, histRes, slaRes, hostsRes, ngRes] = await Promise.all([
  fetch(RAW + 'data/hashrate.json?t='      + Date.now()),
  fetch(RAW + 'data/worker-issues.json?t=' + Date.now()),
  fetch(RAW + 'data/watchlist.json?t='     + Date.now()).catch(() => null),
  fetch(RAW + 'data/offline-status.json?t='+ Date.now()).catch(() => null),
  fetch(RAW + 'data/history.json?t='       + Date.now()).catch(() => null),
  fetch(RAW + 'data/sla-daily.json?t='     + Date.now()).catch(() => null),
  fetch(RAW + 'data/worker-hosts.json?t='  + Date.now()).catch(() => null),
  fetch(RAW + 'data/no-group.json?t='      + Date.now()).catch(() => null),
]);
```

Optional files (`.catch(() => null)`) do not block rendering on error.

### 5.3 Global State

Global variables initialized after fetch:

| Variable | Source | Content |
|----------|--------|---------|
| `_allData` | hashrate.json | All worker snapshots |
| `_workerIssues` | worker-issues.json | Active anomalies |
| `_watchlist` | watchlist.json | Still Degraded entries |
| `_offlineStatus` | offline-status.json | Offline + dead workers |
| `_history` | history.json | Account history |
| `_slaDaily` | sla-daily.json | SLA 30 days |
| `_workerHosts` | worker-hosts.json | Host links |
| `_noGroup` | no-group.json | Workers without a group |
| `_deadIssues` | computed in-memory | Dead workers (tracker) |
| `_dcFilter` | UI | Set() of active groups (filter) |
| `_onlineSearch` | UI | Search string for Online table |

### 5.4 Table Rendering

Rendering is entirely based on `innerHTML` with JavaScript template literals. No individual DOM manipulation.

**`renderOnlineTable()` flow**:

```
1. Build _deadIssues from _offlineStatus (dead/ghost workers injected from offline-status.json)
2. Compute wlEntries (filtered watchlist entries, duration_h >= 1)
3. Compute wlWorkerKeys (Set of watchlist workers → excluded from normal table)
4. Filter ngWorkers from _noGroup (DC/search filters applied)
5. Filter workers: avg3h > 1 TH/s, not in wlWorkerKeys, not in _deadIssues, DC/search filters
6. Generate ngRows (No Group section HTML — purple banner)
7. Generate wlRows (Still Degraded section HTML — red banner)
8. Generate workerRows (normal table HTML)
9. tbody = ngRows + wlRows + workerRows (order guaranteed)
```

**Ghost worker injection into `_deadIssues`**:
```javascript
if (_offlineStatus) {
  for (const [key, w] of Object.entries(_offlineStatus.offline || {})) {
    if (w.dead && !_deadIssues[key]) {
      _deadIssues[key] = {
        account: w.account, account_name: w.account_name,
        name: w.name, group_id: w.group_id, provider: w.provider,
        host: '—',
        last_share: w.last_share || null,  // ISO string → categoryOf() computes correct category
        category: w.category || 'dead_recent',
      };
    }
  }
}
```

**Group rules replication (GROUPS_RULES)**: the frontend duplicates the rules from `groups.js` to classify workers client-side. Always keep both files consistent.

```javascript
const GROUPS_RULES = [
  { id:'E1',    provider:'BitCluster',    test: n => /^\d{1,4}$/.test(n) },
  { id:'U1+U2', provider:'Dataprana',     test: n => /^(ngs|yna|pie|olt|dga)/i.test(n)
                                                  || /^[0-9a-f]{12}$/i.test(n)
                                                  || /^\d{9,}$/.test(n) },
  // ... other groups
];
```

### 5.5 "Workers Requiring Attention" Tracker — CSS

Tracker sections use `table-layout: fixed` to align columns across independent table elements:

```css
.dead-section .issues-table { table-layout: fixed; }
.dead-section .issues-table th:nth-child(1) { width: 22%; }
.dead-section .issues-table th:nth-child(2) { width: 15%; }
.dead-section .issues-table th:nth-child(3) { width: 25%; }
.dead-section .issues-table th:nth-child(4) { width: 13%; }
.dead-section .issues-table th:nth-child(5) { width: 25%; }
```

### 5.6 Sparklines

Sparklines are dynamically generated inline SVGs. To avoid call stack overflow on large arrays, the algorithm uses a loop (not `Math.max(...largeArray)`):

```javascript
let maxHr = 1;
for (const s of snaps) { if (s.hr > maxHr) maxHr = s.hr; }
```

### 5.7 CSS Variables and Theme

The dashboard uses CSS variables for the entire color system:

```css
:root {
  --bg:              #1a1a14;
  --surface:         #22221a;
  --border:          #2e2e24;
  --text:            #e8e6dc;
  --text-muted:      #8a8878;
  --accent-red:      #c0392b;
  --accent-red-dim:  rgba(192,57,43,0.08);
  --accent-orange:   #e67e22;
  --accent-green:    #27ae60;
  --primary:         #D97757;
  ...
}
```

Dark theme only, no light mode.

### 5.8 Worker Modal

The modal is a full-screen overlay generated in the DOM on click. It is destroyed on close (no DOM reuse).

### 5.9 Filters and Interactions

- **DC filter**: clicking a chip → toggles in `_dcFilter` (Set) → re-renders tables
- **Search**: `input` event → immediate re-render (JSON data already in memory)
- **Sorting**: tables sorted by descending hashrate (no interactive sort)

---

## 6. Frontend — sla.html

Independent single HTML file, same structure as index.html.

Fetches only `data/sla-daily.json` and `data/hashrate.json`.

All calculations (DC share, continuity, throughput, combined, breach) are performed **client-side** from the JSON data. 30-day sparklines are generated as inline SVG.

---

## 7. Deployment

### 7.1 Vercel

- Project connected to GitHub repo (`sebwebmail-arch/btc-miner-monitor`)
- Production branch: `main`
- Build command: none (static files)
- Output directory: repository root
- Domain: `watcher.capone.market` (DNS configured at registrar)

**Important**: the GitHub/Vercel webhook is unreliable on this project. `git push` alone does not consistently trigger a Vercel deployment. Reliable deploy command:

```bash
npx vercel --prod
```

### 7.2 Updating the Frontend or Backend

```bash
cd "ERP Project/btc-miner-monitor"
git add index.html sla.html groups.js hashrate-collector.js
git commit -m "feat: description of change"
git pull --rebase origin main    # Pulls data commits from GitHub Actions
git push origin main
npx vercel --prod
```

**If `git push` is rejected** (GitHub Actions committed data files in the meantime):
```bash
git pull --rebase origin main && git push origin main
```

### 7.3 Updating the Backend Only

The backend runs via GitHub Actions: pushing `hashrate-collector.js` to `main` is sufficient — the next run (within 0 to 30 min) will use the new version.

---

## 8. Operations and Limits

### 8.1 Free Tier Limits

| Service | Free Limit | Current Usage |
|---------|-----------|---------------|
| GitHub Actions | 2,000 min/month | ~1,440 runs/month × ~1 min = ~1,440 min |
| Vercel | 100 GB bandwidth | Marginal (static JSON files) |
| Resend | 100 emails/day | ~30/month (morning reports) |
| cron-job.org | Free | 1 job every 30 min |

### 8.2 Operational Notes

- **Git conflicts**: the GitHub Actions script commits data files every 30 minutes. A local `git push` to the same repo can create conflicts. Always run `git pull --rebase origin main` before pushing.

- **Public repository**: `data/*.json` files are publicly readable. Never store sensitive data in these files. `ghost-workers.json` and `no-group.json` are included in this scope.

- **No automatic retry**: if a run fails (network error, f2pool API down), the next run picks up in 30 minutes. No internal retry mechanism.

- **Atomicity**: the script writes all JSON files before the git commit. If the script crashes mid-run, a partial state may exist until the next run.

- **Top-quartile baseline**: only activates if the worker has ≥ 96 snapshots (2 days of history). Newly added or recently restarted workers do not benefit from this protection.

- **`findGhostWorkers` window**: ghost detection is limited to workers with a snapshot in the last 7 days of `hashrate.json`. Beyond that, persistence is handled by `ghost-workers.json` for up to 90 days.

---

*Reference document — capone watcher — July 2026*
