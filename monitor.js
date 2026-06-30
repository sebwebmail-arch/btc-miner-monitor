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

function findOffline(workers, accountUser) {
  return workers
    .filter((w) => w.status !== 0) // 0=online, 1=offline
    .map((w) => {
      const name = w.hash_rate_info?.name || '?';
      const group = getGroup(name);
      const lastSeen = w.last_share_at
        ? new Date(w.last_share_at * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
        : 'never';
      const hashrate = formatHashrate(w.hash_rate_info?.h1_hash_rate || 0);
      return {
        account: accountUser,
        name,
        groupId: group.id,
        provider: group.provider,
        lastSeen,
        hashrate,
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
  const date = new Date().toLocaleDateString('fr-FR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'UTC',
  });

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
              <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;font-weight:600">DERNIER SHARE</th>
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
    </div>

    <div style="padding:24px 32px">
      ${accountBlocks}
      <p style="margin-top:32px;color:#999;font-size:12px;border-top:1px solid #f0f0f0;padding-top:16px">
        Rapport généré automatiquement — Bitcoin Miner Monitor via f2pool API
      </p>
    </div>

  </div>
</body>
</html>`;

  const subject = `[ALERTE] ${totalOffline} worker${totalOffline > 1 ? 's' : ''} offline — ${date}`;

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
