#!/usr/bin/env node
// Bitcoin Miner Monitor — f2pool → Resend alert + history tracker
// Runs via GitHub Actions cron each morning.

const { getGroup } = require('./groups');
const fs = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────────────

const ACCOUNTS = [
  {
    name: 'Cyberian Mine',
    user: 'cmine',
    token: process.env.F2POOL_TOKEN_CMINE,
  },
  {
    name: 'Everminer',
    user: 'everminer',
    token: process.env.F2POOL_TOKEN_EVERMINER,
  },
];

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_TO = process.env.ALERT_EMAIL || 'seb.webmail@gmail.com';
const ALERT_FROM = process.env.ALERT_FROM || 'monitor@yourdomain.com'; // domaine vérifié Resend

const F2POOL_API = 'https://api.f2pool.com/v2/hash_rate/worker/list';

// ─── f2pool API ─────────────────────────────────────────────────────────────

async function fetchWorkers(account) {
  const res = await fetch(F2POOL_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'F2P-API-SECRET': account.token,
    },
    body: JSON.stringify({ mining_user_name: account.user, currency: 'bitcoin' }),
  });

  if (!res.ok) {
    throw new Error(`f2pool API error for ${account.user}: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.workers || [];
}

// ─── Offline detection ──────────────────────────────────────────────────────
// Stratégie : on ne se fie PAS au champ `status` de l'API f2pool (peu fiable).
// Un worker est considéré offline si son dernier share remonte à plus de OFFLINE_MINUTES.
// Seuil : 30 min — suffisamment conservateur pour éviter les faux positifs.

const OFFLINE_MINUTES = 60; // alerte si aucun share depuis plus de 1 heure

function isWorkerOffline(w) {
  const lastShare = w.last_share_at || 0;
  const minutesSinceLastShare = (Date.now() / 1000 - lastShare) / 60;
  return minutesSinceLastShare > OFFLINE_MINUTES;
}

function findOffline(workers, accountUser) {
  return workers
    .filter(isWorkerOffline)
    .map((w) => {
      const name = w.hash_rate_info?.name || '?';
      const group = getGroup(name);
      return group.id === 'No Group' ? null : { name, group, w, accountUser };
    })
    .filter(Boolean)
    .map(({ name, group, w, accountUser }) => {
      const lastShare = w.last_share_at || 0;
      const minutesAgo = Math.round((Date.now() / 1000 - lastShare) / 60);
      const lastSeen = lastShare
        ? `${new Date(lastShare * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC (${minutesAgo}m ago)`
        : 'never';
      return {
        account: accountUser,
        name,
        groupId: group.id,
        provider: group.provider,
        lastSeen,
        minutesAgo,
        host: w.host || '?',
        status: w.status,
      };
    });
}

function formatHashrate(hs) {
  if (hs >= 1e15) return (hs / 1e15).toFixed(2) + ' PH/s';
  if (hs >= 1e12) return (hs / 1e12).toFixed(2) + ' TH/s';
  if (hs >= 1e9) return (hs / 1e9).toFixed(2) + ' GH/s';
  return '0';
}

// ─── Email HTML ─────────────────────────────────────────────────────────────

function buildEmail(offlineByAccount) {
  const now = new Date();

  const date = now.toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'UTC',
  });

  // UTC time
  const timeUTC = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

  // Paris local time + offset label (handles DST automatically)
  const timeParis = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
  const offsetMin = -new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' })).getTimezoneOffset?.() ??
    (now - new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }))) / 60000;
  // Determine offset label via Intl
  const offsetLabel = new Intl.DateTimeFormat('en', { timeZoneName: 'short', timeZone: 'Europe/Paris' })
    .formatToParts(now).find(p => p.type === 'timeZoneName')?.value || 'CET';
  const timeHeader = `${timeUTC} UTC — ${timeParis} ${offsetLabel}`;

  const totalOffline = offlineByAccount.reduce((s, a) => s + a.workers.length, 0);

  const accountBlocks = offlineByAccount
    .filter((a) => a.workers.length > 0)
    .map(({ accountName, workers }) => {
      // Group by datacenter
      const byGroup = {};
      for (const w of workers) {
        const key = `${w.groupId} — ${w.provider}`;
        if (!byGroup[key]) byGroup[key] = [];
        byGroup[key].push(w);
      }

      const groupRows = Object.entries(byGroup)
        .map(([groupLabel, ws]) => {
          const workerRows = ws
            .map(
              (w) => `
              <tr>
                <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;font-family:monospace;font-size:13px">${w.name}</td>
                <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;color:#666;font-size:13px">${w.lastSeen}</td>
                <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;color:#999;font-size:13px">${w.host}</td>
              </tr>`
            )
            .join('');

          return `
            <tr>
              <td colspan="3" style="padding:8px 12px;background:#fff3cd;font-weight:600;font-size:13px;color:#856404">
                ${groupLabel} — ${ws.length} worker${ws.length > 1 ? 's' : ''} offline
              </td>
            </tr>
            ${workerRows}`;
        })
        .join('');

      return `
        <h3 style="margin:24px 0 8px;color:#333;font-size:16px">${accountName}</h3>
        <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #ddd;border-radius:6px;overflow:hidden">
          <thead>
            <tr style="background:#f5f5f5">
              <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;font-weight:600">WORKER</th>
              <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;font-weight:600">LAST SHARE</th>
              <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;font-weight:600">HOST</th>
            </tr>
          </thead>
          <tbody>${groupRows}</tbody>
        </table>`;
    })
    .join('');

  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f9f9f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:680px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">

    <div style="background:#c0392b;padding:24px 32px">
      <h1 style="margin:0;color:#fff;font-size:20px">⚠️ ${totalOffline} worker${totalOffline > 1 ? 's' : ''} offline</h1>
      <p style="margin:4px 0 0;color:rgba(255,255,255,.85);font-size:14px">${date}</p>
      <p style="margin:2px 0 0;color:rgba(255,255,255,.7);font-size:13px">${timeHeader}</p>
    </div>

    <div style="padding:24px 32px">
      ${accountBlocks}
      <div style="margin-top:32px;border-top:1px solid #f0f0f0;padding-top:24px;text-align:center">
        <img src="https://capone.market/capone-fish-avatar-48-orange.svg" alt="Capone" width="72" height="72" style="margin-bottom:8px;display:block;margin-left:auto;margin-right:auto" />
        <p style="margin:4px 0 2px;color:#555;font-size:13px;font-weight:600">Report generated by Capone Watcher</p>
        <p style="margin:0;color:#999;font-size:11px">This email was sent automatically — please do not reply.</p>
      </div>
    </div>

  </div>
</body>
</html>`;

  const subject = `[ALERT] ${totalOffline} worker${totalOffline > 1 ? 's' : ''} offline — ${date}`;

  return { html, subject };
}

// ─── Resend ─────────────────────────────────────────────────────────────────

async function sendAlert(subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: ALERT_FROM,
      to: [ALERT_TO],
      subject,
      html,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Resend error: ${JSON.stringify(data)}`);
  console.log(`✉️  Email envoyé — id: ${data.id}`);
}

// ─── History ─────────────────────────────────────────────────────────────────

const HISTORY_PATH = path.join(__dirname, 'data', 'history.json');
const DEAD_THRESHOLD_H = 24;      // f2pool classifie "dead" après ~24h sans share
const MAX_SNAPSHOTS = 35;         // ~30 jours + marge

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  } catch {
    return { last_updated: null, snapshots: [], current_issues: {} };
  }
}

function saveHistory(h) {
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(h, null, 2));
}

function classifyWorker(w) {
  // Returns category based on how long the worker has been without a share
  const ageH = (Date.now() / 1000 - (w.last_share_at || 0)) / 3600;
  if (ageH < DEAD_THRESHOLD_H) return 'offline';
  const ageD = ageH / 24;
  if (ageD <= 7)  return 'dead_recent';   // 1–7 days
  if (ageD <= 90) return 'dead_mid';      // 8–90 days
  return 'dead_old';                       // >90 days — archived
}

function updateHistory(h, now, allResults) {
  // Build current issues map (all workers with last_share_at > OFFLINE_MINUTES)
  const issues = {};
  for (const { accountName, accountUser, allWorkers } of allResults) {
    for (const w of allWorkers) {
      const ageMin = (Date.now() / 1000 - (w.last_share_at || 0)) / 60;
      if (ageMin <= OFFLINE_MINUTES) continue; // online, skip
      const name = w.hash_rate_info?.name || '?';
      const group = getGroup(name);
      if (group.id === 'No Group') continue;
      const key = `${accountUser}.${name}`;
      issues[key] = {
        account: accountUser,
        account_name: accountName,
        name,
        group_id: group.id,
        provider: group.provider,
        host: w.host || '?',
        last_share: w.last_share_at ? new Date(w.last_share_at * 1000).toISOString() : null,
        category: classifyWorker(w),
      };
    }
  }

  // Count by category
  const counts = { offline: 0, dead_recent: 0, dead_mid: 0, dead_old: 0 };
  for (const w of Object.values(issues)) counts[w.category]++;

  // Build per-account totals
  const by_account = {};
  for (const { accountName, accountUser, totalWorkers, allWorkers } of allResults) {
    const accountIssues = Object.values(issues).filter(w => w.account === accountUser);
    by_account[accountUser] = {
      name: accountName,
      total: totalWorkers,
      online: totalWorkers - accountIssues.length,
      offline: accountIssues.filter(w => w.category === 'offline').length,
      dead: accountIssues.filter(w => w.category !== 'offline').length,
    };
  }

  // Append daily snapshot
  h.snapshots.push({
    ts: now.toISOString(),
    by_account,
    offline: counts.offline,
    dead_recent: counts.dead_recent,
    dead_mid: counts.dead_mid,
    dead_old: counts.dead_old,
  });

  // Keep only last MAX_SNAPSHOTS
  if (h.snapshots.length > MAX_SNAPSHOTS) {
    h.snapshots = h.snapshots.slice(-MAX_SNAPSHOTS);
  }

  h.last_updated = now.toISOString();
  h.current_issues = issues;

  return h;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date();
  console.log(`\n🔍 Bitcoin Miner Monitor — ${now.toISOString()}\n`);

  const offlineByAccount = []; // for email (filtered, no dead_old)
  const allResults = [];       // for history (everything)

  for (const account of ACCOUNTS) {
    if (!account.token) {
      console.warn(`⚠️  Token manquant pour ${account.name}, compte ignoré.`);
      continue;
    }

    console.log(`📡 Fetch workers — ${account.name} (${account.user})...`);
    try {
      const workers = await fetchWorkers(account);
      const offline = findOffline(workers, account.user);

      console.log(`   Total: ${workers.length} workers — Issues: ${offline.length}`);
      offlineByAccount.push({ accountName: account.name, accountUser: account.user, workers: offline });
      allResults.push({ accountName: account.name, accountUser: account.user, totalWorkers: workers.length, allWorkers: workers });
    } catch (err) {
      console.error(`   ❌ Erreur: ${err.message}`);
      offlineByAccount.push({ accountName: account.name, accountUser: account.user, workers: [] });
    }
  }

  // Always save history (even if all online — needed for trend chart)
  console.log('\n💾 Saving history...');
  const history = loadHistory();
  const updated = updateHistory(history, now, allResults);
  saveHistory(updated);
  console.log(`   Snapshots stored: ${updated.snapshots.length} — Issues tracked: ${Object.keys(updated.current_issues).length}`);

  // Email alert (only if issues)
  const totalOffline = offlineByAccount.reduce((s, a) => s + a.workers.length, 0);

  if (totalOffline === 0) {
    console.log('\n✅ All workers online. No alert sent.\n');
    return;
  }

  console.log(`\n🚨 ${totalOffline} worker(s) offline — sending alert...`);
  for (const { accountName, workers } of offlineByAccount) {
    if (workers.length === 0) continue;
    console.log(`\n  ${accountName}:`);
    for (const w of workers) {
      console.log(`    [${w.groupId}] ${w.account}.${w.name} — last share: ${w.lastSeen}`);
    }
  }

  const { subject, html } = buildEmail(offlineByAccount);
  await sendAlert(subject, html);

  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
