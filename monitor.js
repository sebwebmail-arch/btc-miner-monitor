#!/usr/bin/env node
// Bitcoin Miner Monitor — f2pool → Resend alert
// Runs via GitHub Actions cron each morning.
// IMPORTANT: f2pool status codes: 0 = ONLINE, 1 = OFFLINE

const { getGroup } = require('./groups');

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
        <img src="data:image/png;base64,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"
             alt="Capone" width="64" height="64"
             style="border-radius:50%;margin-bottom:8px;display:block;margin-left:auto;margin-right:auto" />
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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 Bitcoin Miner Monitor — ${new Date().toISOString()}\n`);

  const offlineByAccount = [];

  for (const account of ACCOUNTS) {
    if (!account.token) {
      console.warn(`⚠️  Token manquant pour ${account.name}, compte ignoré.`);
      continue;
    }

    console.log(`📡 Fetch workers — ${account.name} (${account.user})...`);
    try {
      const workers = await fetchWorkers(account);
      const offline = findOffline(workers, account.user);

      console.log(`   Total: ${workers.length} workers — Offline: ${offline.length}`);
      offlineByAccount.push({ accountName: account.name, workers: offline });
    } catch (err) {
      console.error(`   ❌ Erreur: ${err.message}`);
      offlineByAccount.push({ accountName: account.name, workers: [] });
    }
  }

  const totalOffline = offlineByAccount.reduce((s, a) => s + a.workers.length, 0);

  if (totalOffline === 0) {
    console.log('\n✅ Tous les workers sont online. Aucune alerte envoyée.\n');
    return;
  }

  console.log(`\n🚨 ${totalOffline} worker(s) offline détectés — envoi de l'alerte...`);

  // Log détail dans la console (visible dans GitHub Actions)
  for (const { accountName, workers } of offlineByAccount) {
    if (workers.length === 0) continue;
    console.log(`\n  ${accountName}:`);
    for (const w of workers) {
      console.log(`    [${w.groupId}] ${w.account}.${w.name} — last share: ${w.lastSeen} — host: ${w.host}`);
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
