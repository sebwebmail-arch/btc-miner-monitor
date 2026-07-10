# Capone Watcher — Operator Guide

**Dashboard**: https://watcher.capone.market  
**Works on mobile** — the dashboard is fully usable on any smartphone browser.

---

## What is Capone Watcher?

Capone Watcher is a live monitoring dashboard for our Bitcoin mining fleet on f2pool. It covers two mining accounts: **Cyberian Mine** and **Everminer**. The system automatically checks every 30 minutes and sends alerts when something needs attention.

You don't need to log in. The dashboard is public and readable by anyone with the link.

---

## The Dashboard at a Glance

Open **https://watcher.capone.market** on any browser (desktop or smartphone). The page refreshes its data automatically.

### Top — Health Cards

Four counters at the top of the page give you an instant overview:

- **Online** — workers currently hashing normally
- **Offline** — workers that stopped hashing in the last 24h (may be temporary)
- **Dead (actionable)** — workers offline for more than 24h that need a physical check
- **Dead (archived)** — workers that have been dead a long time, kept for records

If all four numbers look normal for your current fleet, everything is fine.

### Datacenters at a Glance

A grid of boxes, one per datacenter. Each box shows:
- Datacenter name and provider
- Current hashrate (TH/s)
- Color: **green** = normal, **orange** = degraded, **red** = critical drop

This is the fastest way to spot a datacenter issue. On mobile, scroll down to see all boxes.

### Hashrate Charts

Select the **cmine** or **everminer** tab to see the account's aggregated hashrate over the last 24h or 72h. The dotted line is the ATO (Actual Transfer Out — what is committed to the pool). If the hashrate drops below the ATO line, that is the more critical scenario.

### Workers Requiring Attention

A table of offline and dead workers, sorted by urgency. You can filter by datacenter or account using the dropdowns at the top of the table.

### Online Workers

The full list of all active workers. Workers with a hashrate anomaly (sustained drop or instability) are shown at the top with a colored badge. Click any worker name to open its detail modal.

---

## Worker Detail Modal

Click any worker name anywhere in the dashboard to open its detail view:

- **Status pill** — Online / Offline Xh / Dead Xd
- **Account + Datacenter** — which account and provider this worker belongs to
- **Hashrate chart** — 24h or 72h history as a graph
- **Recommendation** — what action to consider
- **f2pool link** — opens the worker directly in f2pool

This modal works the same on mobile — tap any worker name to open it.

---

## Telegram Alerts

When a datacenter's total hashrate drops more than 30% compared to the previous 1h30, you receive a Telegram message like this:

```
⚠️ Hashrate Alert — capone watcher
📍 IZTM (R1) — Cyberian Mine
📉 Provider hashrate dropped by 48%
Before (avg 1h30): 29189.5 TH/s
Now: 15146.7 TH/s
🕐 05:30 UTC — 07:30 GMT+2
📊 https://watcher.capone.market
```

**What to do when you receive this:**

1. Open https://watcher.capone.market (works on your phone)
2. Look at the **Datacenters at a Glance** section — the affected datacenter will be red
3. Open the **Online Workers** section and check for workers with anomaly badges in that datacenter
4. If the drop is widespread (many workers), it is likely a datacenter or power issue — contact the hosting provider
5. If only a few workers are affected, check them individually using the worker modal

When the datacenter recovers, you will receive a second Telegram message confirming the recovery.

**Alert routing:**
- Cyberian Mine alerts → cmine Telegram group
- Everminer alerts → everminer Telegram group
- Altos (P1) alerts → also sent to the Paraguay group
- Minto (R3) alerts → also sent to the Minto group

---

## Daily Email Report (07:00 Paris time)

Every morning at 7am Paris time, if there are any offline or dead workers, you receive an email with:
- Offline workers grouped by datacenter
- Hashrate anomalies if any
- Direct links to f2pool for each affected worker

No email = no issues detected overnight.

---

## Worker Comments

You can leave a note on any worker directly in the dashboard:
1. Click the worker name to open its modal
2. Type your comment at the bottom of the modal
3. Click Save

A green speech bubble icon (💬) appears next to the worker's name to remind you the comment is there.

**Note**: Comments are saved locally in your browser on your device. They are not shared with other operators or other devices. If you need to share notes, use the Telegram group.

---

## Understanding the ATO Line

ATO (Actual Transfer Out) is the hashrate we are actually delivering to the pool, as reported by f2pool. The hashrate chart shows both our measured total (sum of all workers) and the ATO.

- **Total > ATO**: some workers are hashing but the work is not reaching the pool — this can happen due to connectivity issues within the datacenter. Less urgent.
- **Total < ATO**: we are delivering less to the pool than expected — this directly impacts mining output. Higher priority.

---

## Datacenter Groups Reference

| Group | Provider | Account |
|-------|----------|---------|
| R1 | IZTM | Cyberian Mine |
| R3 | Minto | Cyberian Mine |
| E1 | BitCluster | Cyberian Mine |
| E2 | AmityAge | Cyberian Mine + Everminer |
| U1+U2 | Dataprana | Everminer |
| U3 | ValueHash (NY) | Cyberian Mine + Everminer |
| P1 | Altos | Everminer |
| F1 | Terahash | Cyberian Mine |

**Note on BitCluster (E1)**: this datacenter's hashrate fluctuates significantly throughout the day as a normal operational pattern. It does not trigger Telegram alerts.

---

## Quick Reference

| I want to… | Where to look |
|------------|---------------|
| Check if everything is OK | Health cards (top of page) |
| See which datacenter has a problem | Datacenters at a Glance grid |
| See the hashrate trend over 24h | Hashrate by Account charts |
| Find which workers are offline | Workers Requiring Attention table |
| Check a specific worker's history | Click its name → modal |
| Understand a Telegram alert | Open dashboard → Datacenters grid |
| Leave a note on a worker | Click its name → modal → comment |
