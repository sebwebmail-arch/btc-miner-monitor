# Functional Specification — Capone Watcher

**Product**: watcher.capone.market  
**Version**: July 2026  
**Purpose**: Complete reference for all business rules — dashboard, anomaly detection, watchlist, Telegram alerts, emails, SLA page.

---

## 1. Overview

Capone Watcher is a Bitcoin miner monitoring system (f2pool mining pool). It collects hashrate data from all workers every 30 minutes, detects anomalies (hashrate drops, instability, offline workers, disappeared workers), and sends alerts via Telegram and email. A static dashboard published on Vercel provides a real-time view.

**Core philosophy**: the system acts as a filter to catch problematic workers. It does not aim to be more precise than the f2pool pool itself. A worker reported as "Online" by f2pool but at 0 TH/s is technically correct; what matters is that anomaly detection catches it.

**Monitored accounts**:
- **Cyberian Mine** (`cmine`)
- **Everminer** (`everminer`)

---

## 2. Datacenters and Groups

Each worker belongs to a group (datacenter) identified by its name.

| Group | Provider | Naming Rule |
|-------|----------|------------|
| R1 | IZTM | Starts with `r` |
| R3 | Minto | Starts with `k2lx` |
| E1 | BitCluster | Short purely numeric name, 1–4 digits (e.g. `002`, `031`) |
| E2 | AmityAge | Starts with `aa` |
| U1+U2 | Dataprana | Old format: starts with `ngs`, `yna`, `pie`, `olt` or `dga` — New format (July 2026): 12-character hex MAC address (e.g. `02011366de33`) or long numeric ≥ 9 digits (e.g. `23181238824`) |
| U3 | ValueHash (NY) | Starts with `c21` (cmine) or `e21` (everminer) |
| P1 | Altos | Starts with `s21` |
| F1 | Terahash | Starts with `18x` |
| OM | Open Mine | Starts with `omx` or `openfall` |

**Dataprana — July 2026 note**: Dataprana migrated from serial-number-based names (grouping multiple machines) to MAC addresses (1 worker = 1 machine). This granularity significantly improves anomaly detection precision. Group `U1+U2` covers two physical sites: U1 = South Carolina, U2 = Texas.

**No Group**: any worker matching no rule above is classified as `No Group / Unknown`. This is an immediate action signal: the worker is not monitored and must be assigned to a group on f2pool then added to `groups.js`.

---

## 3. Dashboard (watcher.capone.market)

### 3.1 Data Loading

On every page load, the dashboard fetches the following JSON files in parallel from GitHub (raw.githubusercontent.com), with a `?t=Date.now()` timestamp to bypass browser cache:

| File | Content |
|------|---------|
| `data/hashrate.json` | Worker snapshots (rolling 7 days) |
| `data/worker-issues.json` | Active anomalies (latest detection run) |
| `data/watchlist.json` | Workers/groups under extended surveillance |
| `data/offline-status.json` | Offline and dead workers (real-time) |
| `data/history.json` | Account-level daily history (35 days) |
| `data/sla-daily.json` | Daily SLA aggregates (30 days) |
| `data/worker-hosts.json` | Worker → host URL mapping |
| `data/no-group.json` | Workers with no group assignment (real-time) |

### 3.2 Status Cards (header)

Three metrics are displayed at the top of the dashboard:

- **Workers offline**: count of workers whose f2pool status is OFFLINE (code 1) or whose last share was more than 60 minutes ago.
- **Active hashrate**: sum of the 1h hashrate (`h1_hash_rate`) of all active workers, in TH/s.
- **Active workers**: count of workers with a 3h average hashrate > 1 TH/s.

### 3.3 ATO Comparison

The dashboard displays total hashrate (sum of workers) vs. **ATO** (_Actual Transfer Out_ — hashrate distributed to clients). The color indicates the direction of the gap:

- **Total > ATO**: the pool captures more than what clients receive → less urgent.
- **Total < ATO**: the pool produces less than what clients should receive → direct impact on distribution → priority.

### 3.4 Hashrate Chart (7 days)

A line chart based on `history.json`, showing aggregated hashrate (all accounts combined) over the last 7 days.

### 3.5 Filters

- **Datacenter filter**: clickable chips (one per group). Activating a filter hides all workers not belonging to the selected group. Multiple groups can be active simultaneously.
- **Search**: text field filtering workers by name (partial match, case-insensitive).

### 3.6 "Online Workers" Table

Displays workers whose 3h average hashrate is > 1 TH/s, **except** those already shown in special sections below.

Columns: Name, Account, Group/Provider, Anomaly badge (if applicable), Current hashrate (TH/s), 3h average hashrate (TH/s), 6h sparkline.

**"No Group" section** (purple banner — at the top of the table, if applicable):
- Displays workers returned by the f2pool API but not matching any known group.
- Purple background, label "🏷️ No Group", note "workers without a group — assign on f2pool".
- Action required from the operator: assign on f2pool and update `groups.js`.

**"Still Degraded" section** (red banner — after No Group, if applicable):
- Displays `watchlist.json` entries where `duration_h >= 1`.
- Workers in this section are **excluded** from the rest of the Online Workers table (no duplicates).
- Entries with `duration_h < 1` (drop detected less than one hour ago) stay in the normal table for that first run, then move to Still Degraded on the next run if not recovered.
- Red background, label "⚠ Still degraded", note "not yet recovered to 75% of baseline".

### 3.7 "Workers Requiring Attention" Tracker

A dedicated section for offline, dead, and archived workers. Workers listed here are **excluded** from the Online Workers table.

Workers are distributed across 3 buckets based on age of last share:

| Bucket | Duration | Color | Instruction |
|--------|----------|-------|-------------|
| < 24 hours | Recently offline | Yellow | Check immediately |
| 1–7 days | Recently dead | Orange | Monitor daily |
| 8–90 days | Long-dead | Red | Contact the provider |
| > 90 days | Archived | Gray | Likely lost — archived |

**Data sources**:
- Workers returned by the f2pool API but with `last_share > 60 min` → category `< 24h` or `1-7 days` based on age.
- **Ghost workers** (Dead — absent from the API for > 24h) → injected from `ghost-workers.json` (see § 4.5). Their category is computed from the date of their last known snapshot.

Columns are fixed-width across all buckets: Worker, Account, Datacenter, Status, Last Share (UTC).

### 3.8 Worker Modal

Accessible by clicking on a worker in the Online or Still Degraded tables.

Content:
- Name, account, group/provider
- **Status pill**: Online (green) or Offline (red) based on `offline-status.json`
- **Watchlist badge** (if worker is on watchlist): red "−X% · duration" badge with values at the time of initial detection
- **Live anomaly badge** (if worker is on watchlist): secondary dimmed badge showing current detection
- 12h sparkline and hashrate line chart

---

## 4. Anomaly Detection

The `hashrate-collector.js` script runs every 30 minutes and performs several types of detection.

### 4.1 Group Drop

**Trigger**: a group's current hashrate drops more than 30% below its reference.

**Calculation**:
- Current group hashrate = sum of `h1_hash_rate` for all workers in the group (real-time API)
- Reference = average of the last 3 stored snapshots, summed across the group (~1h30)
- Condition: `current < reference × (1 − 0.30)`

**Cooldown**: 4 hours per group. **Excluded groups**: `E1` (BitCluster — daily fluctuation is normal).

**Routing**: account Telegram channel + duplications P1→Paraguay, R3→Minto + account email.

**Watchlist**: if alert sent → group added to watchlist.

### 4.2 Worker Anomaly — Level Drop

**Trigger**: 3h average hashrate < 60% of the 12h baseline (drop > 40%).

**Windows**: current = last 6 snapshots (~3h); baseline = snapshots 7 to 30 (~3h30–15h back).

**Top-quartile override**: if the worker has ≥ 96 snapshots and the top 25% of its history exceeds 1.5× the rolling baseline, the top-quartile average is used as the baseline.

**Cooldown**: 8h. **Excluded groups**: `E1`. **Watchlist**: entry created if alert sent.

### 4.3 Worker Anomaly — Volatile / Unstable

**Trigger** (either condition):
1. Coefficient of variation `stddev / mean > 55%`
2. Zero rate (snapshots < 5 TH/s) > 35%

**Cooldown**, **exclusions**, **watchlist**: identical to Level Drop (§ 4.2).

### 4.4 Offline Workers

A worker is "offline" if its last share was more than 60 minutes ago **or** if its f2pool status is OFFLINE (code `1`). Used in the morning report and the dead tracker.

A worker is "dead" according to f2pool if inactive for > 24h. **Beyond ~24h, f2pool removes the worker from its API response** (it moves to a "Dead" tab invisible to the API).

### 4.5 Ghost Workers (Dead — Absent from the API)

**Problem**: f2pool stops returning Dead workers in the API response after ~24h. Without a compensation mechanism, these workers become invisible to the entire system.

**Solution — initial detection**: on every run, `findGhostWorkers()` compares keys in `hashrate.json` against names returned by the API. Any worker with recent snapshots (< 7 days) but absent from the API is flagged as a "ghost".

**Solution — persistence**: ghost workers are stored in `ghost-workers.json` (persistent registry). This registry survives `hashrate.json` purges (7-day window) and tracks Dead workers **for up to 90 days**.

**Registry lifecycle** (updated every 30-min run):
- New ghosts detected via `hashrate.json` → added to the registry with `lastSnapIso` and `detectedAt`
- Workers returning to the API → removed from the registry (resolved)
- Workers > 90 days old → expired and removed from the registry

**Categories** (recalculated each run from `lastSnapIso` age):
- < 24h → `offline`
- 1–7 days → `dead_recent`
- 8–90 days → `dead_mid`
- > 90 days → `dead_old` (expired, not displayed)

**Usage**:
- `offline-status.json`: ghosts are included with `dead: true`, `category`, `last_share` (used by the dashboard to classify them in the correct tracker bucket)
- Morning report: Offline workers section includes ghosts labeled "Dead (no longer in pool API)"
- Dashboard: ghosts are injected into `_deadIssues` and appear in the correct tracker bucket

### 4.6 No Group Workers

On every run, the script detects all workers returned by the f2pool API whose name does not match any known group (`No Group` result from `getGroup()`).

**Saved to**: `no-group.json` (updated every run).

**Alerts** (cooldown 12h per worker):
- Telegram to `TELEGRAM_CHAT_ID` (general channel)
- Email to `ALERT_EMAIL`

**Morning report**: dedicated section "🏷️ Workers without a group — action required" if No Group workers exist.

**Dashboard**: purple banner at the top of the Online Workers table if `no-group.json` contains entries.

---

## 5. Watchlist (Still Degraded)

### 5.1 Principle

The watchlist tracks degraded workers/groups after an alert fires, until they fully recover.

### 5.2 Entry Creation

An entry is created when an alert is sent (cooldown OK) for a group drop, level drop, or volatile anomaly.

**Keys**: `w.{account}.{workerName}` (worker) or `g.{account}.{groupId}` (group).

### 5.3 Recovery Check (every 30 min)

- **Worker condition**: `current_hr >= baseline_hr × 0.75`
- **Group condition**: `current_group_hr >= baseline_group_hr × 0.75`
- If met → entry removed from watchlist

### 5.4 Automatic Expiry

Entry automatically removed after **14 days** without recovery.

### 5.5 Dashboard Display

- `duration_h < 1`: not shown in "Still Degraded" (stays in normal table)
- `duration_h >= 1`: displayed in the Still Degraded banner

---

## 6. Telegram Alerts

### 6.1 Routing

| Channel | Variable | Trigger |
|---------|----------|---------|
| `TELEGRAM_CHAT_ID_CMINE` | cmine account | Group drop, worker anomaly for cmine |
| `TELEGRAM_CHAT_ID_EVERMINER` | everminer account | Group drop, worker anomaly for everminer |
| `TELEGRAM_CHAT_ID_PARAGUAY` | Duplication | Group P1 only |
| `TELEGRAM_CHAT_ID_MINTO` | Duplication | Group R3 only |
| `TELEGRAM_CHAT_ID` | General channel | No Group workers |

### 6.2 Group Drop

Message: `📉 Hashrate locally dropped by X%` with before (avg 1h30) and now values, UTC timestamps only.

### 6.3 Worker Anomaly

Text message with type, worker, drop%, current and baseline values.

### 6.4 No Group Workers

Message: `🏷️ Workers without group detected` with the list per account. Cooldown 12h per worker.

### 6.5 What Does NOT Trigger a Telegram Alert

- Watchlist recovery
- Morning report (email only)
- Watchlist expiry
- Ghost (Dead) workers — visible in morning report and dashboard only

---

## 7. Alert Emails

### 7.1 Addresses

- `cmine` → `ALERT_EMAIL_CMINE` (default: support@cyberianmine.de)
- `everminer` → `ALERT_EMAIL_EVERMINER` (default: support@cyberianmine.de)
- Morning report + No Group → `ALERT_EMAIL` (seb.webmail@gmail.com)

Sender: `noreply@capone.market`

### 7.2 Group Drop Alert (real-time)

Orange header, stylized drop icon (descending curve), table datacenter/account/before/now/drop. UTC timestamps only.

### 7.3 No Group Alert (real-time)

Purple header, table worker/account/host. Cooldown 12h per worker.

### 7.4 Morning Report

**Time**: 05:00 UTC — **Anti-duplicate**: 20h cooldown

**Content (in this order)**:

1. **🏷️ Workers without a group** (if applicable): table worker/account/host with action instruction.
2. **Still Degraded**: active watchlist entries, drop%, hashrate, duration.
3. **Offline workers**: per-account list of offline workers + Dead ghost workers (from the 90-day registry), grouped by datacenter. Dead workers carry the label "Dead (no longer in pool API)".
4. **Hashrate Warnings**: active anomalies (worker-issues.json), **excluding** workers already listed in Still Degraded (no duplicates).

**Email header color**:
- Green: all good
- Red: at least one worker offline
- Orange: anomalies or watchlist items but no offline workers

**Subject**: `[Morning Report] ✅ All online` or `[Morning Report] N offline · N warnings · N no group — {date}`

---

## 8. SLA Page (sla.html)

### 8.1 Principle

Per-datacenter performance metrics over the last 30 days. Data is computed once per day at 05:00 UTC and stored in `sla-daily.json`.

### 8.2 Per-Datacenter Metrics

**Continuity SLA**: proportion of time machines are actually online.
- r² score per snapshot: `(online_workers / total_active)²`
- Daily average of these scores

**Throughput**: does the datacenter produce its expected hashrate when online?
- Expected share = average of `(DC_hashrate / total_hashrate)` across active snapshots
- Score per snapshot: `min(1, DC_hashrate / (total × expected_share))`

**Combined**: `Continuity × Throughput` (capped at 1.0)

**Breach**: `1 − Combined` — expressed as a percentage.

### 8.3 Account Performance (ATO)

Measures whether total worker hashrate covers the **ATO** (_Actual Transfer Out_ — hashrate distributed to clients).

**Calculation**: `min(1, total_workers_hr / ATO_hr)` per snapshot, averaged across the day. The ATO is the nearest-in-time snapshot (within ±75 min). Scores > 1.0 are capped at 1.0.

### 8.4 Update Frequency

One line per day in `sla-daily.json`, computed for UTC day J-1 during the 05:00 UTC run. Rolling 30-day window.

---

## 9. Global Rules

### 9.1 Snapshots and Time Windows

| Constant | Value | Meaning |
|----------|-------|---------|
| Snapshot interval | 30 min | Collection frequency |
| MAX_SNAPSHOTS | 337 | ~7 days retention per worker in hashrate.json |
| CURRENT_WINDOW | 6 snaps | = 3h "current" for anomalies |
| BASELINE_SNAPS | 24 snaps | = 12h baseline (snaps 7 to 30) |
| REF_SNAPSHOTS (group) | 3 snaps | = 1h30 reference for group alerts |
| MIN_HR_TH | 5 TH/s | "Near zero" threshold |
| OFFLINE_MINUTES | 60 min | last_share threshold → offline |
| DEAD_THRESHOLD_H | 24h | f2pool "dead" threshold |
| GHOST_MAX_DAYS | 90 days | Dead worker retention in ghost-workers.json |

### 9.2 Cooldowns and Alert Thresholds

| Type | Threshold | Cooldown |
|------|-----------|---------|
| Group drop | > 30% | 4h |
| Worker level drop | > 40% | 8h |
| Volatile (CV) | stddev/mean > 55% | 8h |
| Volatile (zero rate) | > 35% at zero | 8h |
| No Group | — | 12h per worker |
| Morning report | — | 20h |
| Watchlist recovery | 75% of baseline | — |
| Watchlist expiry | — | 14 days |
| Ghost workers expiry | — | 90 days |

### 9.3 Groups Excluded from Real-Time Alerts

- `E1` (BitCluster): daily hashrate fluctuation is normal behavior — excluded from all real-time alerts (group drops + worker anomalies).

### 9.4 f2pool API — Status Codes

- `status = 0`: ONLINE
- `status = 1`: OFFLINE (counter-intuitive)

---

*Reference document — capone watcher — July 2026*
