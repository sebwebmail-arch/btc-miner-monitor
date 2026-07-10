# Capone Watcher — Maintenance Guide

**Repository**: https://github.com/sebwebmail-arch/btc-miner-monitor  
**Dashboard**: https://watcher.capone.market  
**Version**: 1.0 — July 2026

This document is for operators who need to maintain or contribute to the Capone Watcher codebase.

---

## 1. Repository Access

The source code is hosted on GitHub:

```
https://github.com/sebwebmail-arch/btc-miner-monitor
```

To clone locally:

```bash
git clone https://github.com/sebwebmail-arch/btc-miner-monitor.git
cd btc-miner-monitor
```

You will need Node.js 20+ installed. No build step is required — the project uses plain Node.js scripts and a vanilla HTML file.

---

## 2. File Structure

```
btc-miner-monitor/
├── index.html              # Dashboard SPA (single file, no framework)
├── hashrate-collector.js   # Runs every 30min: snapshots + alerts
├── monitor.js              # Runs daily at 07:00 Paris: morning report
├── groups.js               # Worker name → group/datacenter mapping
├── test-telegram.js        # Diagnostic script for Telegram config
├── data/                   # JSON data files (auto-committed by Actions)
│   ├── hashrate.json       # Per-worker snapshots (7-day rolling)
│   ├── history.json        # Daily worker status archive (30 days)
│   ├── alert-state.json    # Alert cooldown timestamps
│   ├── worker-issues.json  # Current anomalies
│   ├── offline-status.json # Current offline worker map
│   ├── worker-hosts.json   # Worker → IP mapping
│   ├── sla-daily.json      # Per-group uptime metrics
│   ├── ghost-workers.json  # Dead workers (kept 90 days)
│   └── watchlist.json      # Anomaly watchlist (auto-expires 14 days)
└── .github/workflows/
    ├── hashrate.yml        # Triggers hashrate-collector.js every 30min
    ├── monitor.yml         # Triggers monitor.js daily at 05:00 UTC
    └── test-telegram.yml   # Manual Telegram diagnostic
```

---

## 3. Deployment

### How it works

Every push to the `main` branch triggers an automatic Vercel deployment. The dashboard is live at https://watcher.capone.market within ~30 seconds of push.

### Standard deploy command

After any code change to `index.html` or the scripts, run from your terminal inside the `btc-miner-monitor` folder:

```bash
git add -A
git commit -m "describe your change"
git pull --rebase origin main && git push origin main
npx vercel --prod
```

**Why `git pull --rebase` before push?** GitHub Actions commits data files to the repo every 30 minutes. Your local branch may be behind — rebasing pulls those commits in before you push, avoiding a rejected push.

**Why `npx vercel --prod`?** Vercel's GitHub integration sometimes needs a manual trigger to pick up the latest commit as a production deployment. This command forces it.

---

## 4. GitHub Actions & Secrets

### Workflows

| Workflow | File | Trigger | What it does |
|----------|------|---------|--------------|
| Hashrate Collector | `hashrate.yml` | Every 30min (via cron-job.org) | Snapshots + alerts |
| Daily Monitor | `monitor.yml` | Daily 05:00 UTC | Morning email report |
| Test Telegram | `test-telegram.yml` | Manual (workflow_dispatch) | Validates all Telegram secrets |

### Secrets (GitHub → Settings → Secrets and variables → Actions)

| Secret | Purpose |
|--------|---------|
| `F2POOL_TOKEN_CMINE` | f2pool API key — Cyberian Mine |
| `F2POOL_TOKEN_EVERMINER` | f2pool API key — Everminer |
| `RESEND_API_KEY` | Resend email delivery API key |
| `ALERT_FROM` | Email sender (`noreply@capone.market`) |
| `ALERT_EMAIL` | Fallback alert recipient |
| `ALERT_EMAIL_CMINE` | Alert email for cmine account |
| `ALERT_EMAIL_EVERMINER` | Alert email for everminer account |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Fallback Telegram chat ID |
| `TELEGRAM_CHAT_ID_CMINE` | Telegram group for cmine alerts |
| `TELEGRAM_CHAT_ID_EVERMINER` | Telegram group for everminer alerts |
| `TELEGRAM_CHAT_ID_PARAGUAY` | Telegram group for Altos/P1 alerts |
| `TELEGRAM_CHAT_ID_MINTO` | Telegram group for Minto/R3 alerts |

---

## 5. Key Configuration Constants

These are defined at the top of `hashrate-collector.js`:

| Constant | Value | Meaning |
|----------|-------|---------|
| `DROP_THRESHOLD` | 0.30 | Group alert fires if hashrate drops >30% |
| `COOLDOWN_H` | 4 | Hours before the same group can alert again |
| `REF_SNAPSHOTS` | 3 | Last N snapshots used as reference (~1h30) |
| `MAX_SNAPSHOTS` | 337 | Max snapshots per worker (7-day rolling window) |
| `LEVEL_DROP_THR` | 0.40 | Worker anomaly: current < baseline × 60% |
| `CV_THR` | 0.55 | Worker anomaly: coefficient of variation >55% |
| `WORKER_COOLDOWN_H` | 8 | Hours before the same worker anomaly re-alerts |
| `ALERT_EXCLUDED_GROUPS` | `['E1']` | Groups excluded from real-time alerts |
| `RECOVERY_THRESHOLD` | 0.75 | Group must reach 75% of reference to send recovery |
| `GHOST_MAX_DAYS` | 90 | Dead workers kept in ghost-workers.json for 90 days |
| `WATCHLIST_MAX_DAYS` | 14 | Worker anomalies auto-expire after 14 days |

---

## 6. Adding a New Datacenter / Group

1. Open `groups.js`
2. Add a new entry to the `GROUPS` array:

```javascript
{
  id: 'X1',           // short unique ID
  provider: 'Name',   // display name
  test: (name) => /^prefix/i.test(name),  // regex matching worker names
},
```

3. If this datacenter should send alerts to a separate Telegram group, add a new `TELEGRAM_CHAT_ID_XXX` secret to GitHub Actions and add the routing logic in `hashrate-collector.js` (follow the Paraguay/Minto pattern).

4. If this datacenter has normal daily fluctuations that would produce false alerts, add its ID to `ALERT_EXCLUDED_GROUPS` in `hashrate-collector.js`.

---

## 7. Troubleshooting Telegram Alerts

**If Telegram alerts stop arriving:**

1. Go to: https://github.com/sebwebmail-arch/btc-miner-monitor/actions
2. Select **"Test Telegram"** workflow → click **"Run workflow"** → **"Run workflow"**
3. View the run logs — each secret is tested individually

Common errors:
- `401 Unauthorized` → bot token expired. Regenerate via @BotFather → update `TELEGRAM_BOT_TOKEN` secret
- `403 Forbidden` → bot was removed from the group. Re-add it and make it an admin
- `400 Bad Request` → invalid chat_id. Check the `TELEGRAM_CHAT_ID_xxx` secret value

**Why alerts may fire correctly but no message arrives:**
The alert system uses a 4-hour cooldown per group. If an alert fired in the last 4 hours, no new alert is sent even if the drop persists. Check `data/alert-state.json` in the repository to see the last alert timestamps.

---

## 8. Git Workflow Notes

GitHub Actions commits to `data/` every 30 minutes. This means your local branch can fall behind quickly. Always use this before pushing:

```bash
git pull --rebase origin main && git push origin main
```

If you get lock file errors during rebase:

```bash
rm -f .git/index.lock .git/refs/heads/main.lock
git stash
git pull --rebase origin main
git stash pop
git push origin main
```

---

## 9. f2pool API Notes

- **Status field is unreliable**: the `status` field always returns `0` regardless of actual worker state. Always derive online/offline from `last_share_at`.
- **Worker offline threshold**: a worker is considered offline if `last_share_at` is more than 60 minutes ago.
- **Worker dead threshold**: offline for more than 24 hours.
- **Hashrate field priority**: use `h1_hash_rate` (1h average); fall back to `hash_rate` if missing.

---

## 10. Dashboard (index.html) Notes

The dashboard is a single vanilla HTML/JS file — no build process, no dependencies to install. To make changes:

1. Edit `index.html` directly
2. Test by opening it in a browser locally (data loads from the live Vercel URLs)
3. Deploy with the standard deploy command above

Key areas in the file:
- **CSS variables** (`:root` block, ~line 19) — colors, spacing
- **`renderDashboard()` function** — main render loop, reads JSON data
- **`openWorkerModal()` function** — worker detail modal
- **`detectWorkerAnomalies()` equivalent in JS** — mirrors the Node.js logic for display
- **Comment system** (~line 1280) — localStorage-based worker notes

---

## 11. Monitoring the Monitor

To verify the system is running correctly:
- Check https://github.com/sebwebmail-arch/btc-miner-monitor/actions — the Hashrate Collector should run every 30 minutes with green checkmarks
- Check `data/hashrate.json` in the repo — `last_updated` should be recent
- Run the Test Telegram workflow to validate all alert channels

If GitHub Actions shows failures, check the run logs — common causes are f2pool API rate limits or temporary GitHub infrastructure issues (transient, resolve themselves).
