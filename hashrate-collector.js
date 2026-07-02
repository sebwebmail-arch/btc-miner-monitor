#!/usr/bin/env node
// Hashrate Collector — snapshot 30 min + détection chute hashrate par groupe.
// Envoie alertes Telegram + email si chute > DROP_THRESHOLD sur un datacenter.

const { getGroup, GROUPS } = require('./groups');
const fs   = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

// Chaque compte a son propre canal Telegram et email d'alerte.
// Pour tester, TELEGRAM_CHAT_ID_CMINE et TELEGRAM_CHAT_ID_EVERMINER peuvent pointer
// vers le même groupe — à séparer quand les vrais groupes seront créés.
const ACCOUNTS = [
  {
    name:           'Cyberian Mine',
    user:           'cmine',
    readKey:        'dad5e8d0452ce3262084e3afef6003ec',
    token:          process.env.F2POOL_TOKEN_CMINE,
    alertEmail:     process.env.ALERT_EMAIL_CMINE    || process.env.ALERT_EMAIL || 'support@cyberianmine.de',
    telegramChatId: process.env.TELEGRAM_CHAT_ID_CMINE || process.env.TELEGRAM_CHAT_ID,
  },
  {
    name:           'Everminer',
    user:           'everminer',
    readKey:        'd87416827c22b5c9aadb86e10535c4e0',
    token:          process.env.F2POOL_TOKEN_EVERMINER,
    alertEmail:     process.env.ALERT_EMAIL_EVERMINER  || process.env.ALERT_EMAIL || 'support@cyberianmine.de',
    telegramChatId: process.env.TELEGRAM_CHAT_ID_EVERMINER || process.env.TELEGRAM_CHAT_ID,
  },
];

const RESEND_API_KEY        = process.env.RESEND_API_KEY;
const ALERT_FROM            = process.env.ALERT_FROM || 'noreply@capone.market';
const TELEGRAM_TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_PARAGUAY = process.env.TELEGRAM_CHAT_ID_PARAGUAY;

const F2POOL_API        = 'https://api.f2pool.com/v2/hash_rate/worker/list';
const HASHRATE_PATH     = path.join(__dirname, 'data', 'hashrate.json');
const ALERTSTATE_PATH   = path.join(__dirname, 'data', 'alert-state.json');
const WORKERISSUES_PATH = path.join(__dirname, 'data', 'worker-issues.json');
const HISTORY_PATH      = path.join(__dirname, 'data', 'history.json');
const OFFLINESTATUS_PATH = path.join(__dirname, 'data', 'offline-status.json');
const WORKERHOSTS_PATH   = path.join(__dirname, 'data', 'worker-hosts.json');

// Email destinataire rapport matin (commun aux deux comptes)
const MORNING_ALERT_TO = process.env.ALERT_EMAIL || 'seb.webmail@gmail.com';

const MAX_SNAPSHOTS   = 337;  // 7 jours × 48 snapshots/jour + 1 (fenêtre 7j glissants)
const REF_SNAPSHOTS   = 3;    // 3 derniers snapshots = référence 1h30
const DROP_THRESHOLD  = 0.30; // alerte si chute > 30% (groupe)
const COOLDOWN_H      = 4;    // pas de double alerte sur le même groupe avant 4h

// Groupes exclus des alertes temps-réel (hashrate drop + anomalie worker)
// E1 = BitCluster : hashrate yoyo quotidien normal, pas une anomalie
const ALERT_EXCLUDED_GROUPS = ['E1'];

// Groupes Paraguay — alertes dupliquées vers TELEGRAM_CHAT_ID_PARAGUAY
const PARAGUAY_GROUPS = ['P1'];

// ─── Rapport matin ────────────────────────────────────────────────────────────
const MORNING_HOUR_UTC   = 5;   // 05:00 UTC = 07:00 Paris (CEST)
const MORNING_COOLDOWN_H = 20;  // anti-doublon
const OFFLINE_MINUTES    = 60;  // worker offline si pas de share depuis > 60 min
const DEAD_THRESHOLD_H   = 24;  // seuil "dead" f2pool
const MAX_HISTORY_SNAPS  = 35;  // ~30 jours

// ─── Anomalie par worker (hashrate dégradé / instable) ───────────────────────
const CURRENT_WINDOW   = 6;    // 6 derniers snapshots = 3h "actuel"
const BASELINE_SNAPS   = 24;   // 12h de baseline (snaps 7 à 30)
const MIN_BASELINE     = 12;   // baseline minimum pour être significatif
const LEVEL_DROP_THR   = 0.40; // alerte si current < baseline * (1 - 0.40)
const CV_THR           = 0.55; // alerte si stddev/mean > 55% (très volatile)
const ZERO_RATE_THR    = 0.35; // alerte si >35% des points ≈ 0 (yoyo ON/OFF)
const MIN_HR_TH        = 5e12; // < 5 TH/s = considéré "near zero"
const MIN_ACTIVE_TH    = 5e12; // baseline doit dépasser 5 TH/s pour être analysé
const WORKER_COOLDOWN_H = 8;   // pas de re-alerte sur le même worker avant 8h

// ─── f2pool API ───────────────────────────────────────────────────────────────

// Fetch hashrate chart data (Total + ATO) via the public f2pool web endpoint
// URL discovered from browser network requests on the public mining-user page
async function fetchATO(account) {
  const url = `https://www.f2pool.com/mining-user/${account.readKey}?user_name=${account.user}&params=user_name%3D${account.user}&action=load_by_duration&duration=1`;
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json, text/javascript, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `https://www.f2pool.com/mining-user/${account.readKey}?user_name=${account.user}`,
        'User-Agent': 'Mozilla/5.0 (compatible; capone-watcher/1.0)',
      },
    });
    if (!res.ok) { console.warn(`   ⚠️  ATO ${account.user}: HTTP ${res.status}`); return null; }
    const data = await res.json();
    // transfer_actually_hashrate = Actual Transfer Out (valeurs en TH/s)
    const payload = data.data || data;
    const atoVals = payload.transfer_actually_hashrate?.values || [];
    if (atoVals.length === 0) { console.warn(`   ⚠️  ATO ${account.user}: aucune valeur`); return null; }
    // Dernier point du bucket 30min courant (en TH/s → converti en H/s pour cohérence workers)
    const lastATO = atoVals[atoVals.length - 1][1] * 1e12;
    console.log(`   ATO ${account.user}: ${(lastATO / 1e12).toFixed(0)} TH/s`);
    return lastATO;
  } catch (err) {
    console.warn(`   ⚠️  ATO ${account.user}: ${err.message}`);
    return null;
  }
}

async function fetchWorkers(account) {
  const res = await fetch(F2POOL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'F2P-API-SECRET': account.token },
    body: JSON.stringify({ mining_user_name: account.user, currency: 'bitcoin' }),
  });
  if (!res.ok) throw new Error(`f2pool API error for ${account.user}: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.workers || [];
}

// ─── Storage ─────────────────────────────────────────────────────────────────

function loadHashrate() {
  try { return JSON.parse(fs.readFileSync(HASHRATE_PATH, 'utf8')); }
  catch { return { last_updated: null, workers: {} }; }
}

function saveHashrate(h) {
  fs.mkdirSync(path.dirname(HASHRATE_PATH), { recursive: true });
  fs.writeFileSync(HASHRATE_PATH, JSON.stringify(h));
}

function loadAlertState() {
  try { return JSON.parse(fs.readFileSync(ALERTSTATE_PATH, 'utf8')); }
  catch { return {}; }
}

function saveAlertState(s) {
  fs.mkdirSync(path.dirname(ALERTSTATE_PATH), { recursive: true });
  fs.writeFileSync(ALERTSTATE_PATH, JSON.stringify(s, null, 2));
}

// ─── Hashrate helpers ─────────────────────────────────────────────────────────

function fmtTH(hr) {
  return (hr / 1e12).toFixed(1) + ' TH/s';
}

// Hashrate actuel d'un groupe pour un compte = somme h1 de tous ses workers
function groupCurrentHR(workersList, accountUser, groupId) {
  return workersList
    .filter(w => {
      const name = w.hash_rate_info?.name || '?';
      return getGroup(name).id === groupId;
    })
    .reduce((s, w) => s + (w.hash_rate_info?.h1_hash_rate ?? w.hash_rate_info?.hash_rate ?? 0), 0);
}

// Référence : moyenne des REF_SNAPSHOTS derniers points stockés pour un groupe/compte
function groupReferenceHR(hrData, accountUser, groupId) {
  // Trouve tous les workers du groupe pour ce compte
  const keys = Object.keys(hrData.workers).filter(k => {
    if (!k.startsWith(accountUser + '.')) return false;
    const workerName = k.slice(accountUser.length + 1);
    return getGroup(workerName).id === groupId;
  });

  if (keys.length === 0) return null;

  // Pour chaque worker, prend les REF_SNAPSHOTS derniers points
  let totalRef = 0;
  let counted  = 0;

  for (const key of keys) {
    const snaps = hrData.workers[key];
    if (!snaps || snaps.length === 0) continue;
    const recent = snaps.slice(-REF_SNAPSHOTS);
    const avg    = recent.reduce((s, p) => s + p.hr, 0) / recent.length;
    totalRef += avg;
    counted++;
  }

  return counted > 0 ? totalRef : null;
}

// ─── Alertes Telegram ─────────────────────────────────────────────────────────

async function sendTelegram(chatId, text) {
  if (!TELEGRAM_TOKEN || !chatId) {
    console.warn('⚠️  Telegram non configuré pour ce compte');
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram error: ${JSON.stringify(data)}`);
  console.log(`📲 Telegram envoyé → chat ${chatId}`);
}

// ─── Alertes Email (Resend) ──────────────────────────────────────────────────

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) { console.warn('⚠️  RESEND_API_KEY manquant'); return; }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({ from: ALERT_FROM, to: [to], subject, html }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Resend error: ${JSON.stringify(data)}`);
  console.log(`✉️  Email envoyé → ${to} — id: ${data.id}`);
}

// ─── Détection anomalies par worker ──────────────────────────────────────────

function detectWorkerAnomalies(hrData) {
  const issues = {};

  for (const [key, snaps] of Object.entries(hrData.workers || {})) {
    // Besoin de suffisamment d'historique
    if (snaps.length < CURRENT_WINDOW + MIN_BASELINE) continue;

    const current  = snaps.slice(-CURRENT_WINDOW);
    const baseline = snaps.slice(-(CURRENT_WINDOW + BASELINE_SNAPS), -CURRENT_WINDOW);
    if (baseline.length < MIN_BASELINE) continue;

    const currentAvg  = current.reduce((s, p) => s + p.hr, 0) / current.length;
    const baselineAvg = baseline.reduce((s, p) => s + p.hr, 0) / baseline.length;

    // Baseline trop faible → worker peu actif, pas pertinent
    if (baselineAvg < MIN_ACTIVE_TH) continue;

    // Fraction des snapshots actuels proches de zéro
    const zeroRate = current.filter(p => p.hr < MIN_HR_TH).length / current.length;

    // Volatilité : coefficient de variation sur la fenêtre actuelle
    const mean     = currentAvg || 1;
    const variance = current.reduce((s, p) => s + Math.pow(p.hr - mean, 2), 0) / current.length;
    const cv       = Math.sqrt(variance) / mean;

    const dropPct = baselineAvg > 0 ? (baselineAvg - currentAvg) / baselineAvg : 0;

    // Worker complètement offline → déjà suivi ailleurs, on skip
    if (currentAvg < MIN_HR_TH) continue;

    let type = null;
    if (dropPct > LEVEL_DROP_THR && zeroRate < 0.5) {
      type = 'level_drop';
    } else if (cv > CV_THR || zeroRate > ZERO_RATE_THR) {
      type = 'volatile';
    }

    if (!type) continue;

    // Retrouve account à partir du préfixe de la clé
    const dotIdx = key.indexOf('.');
    const accountUser = key.slice(0, dotIdx);
    const workerName  = key.slice(dotIdx + 1);
    const account     = ACCOUNTS.find(a => a.user === accountUser);
    if (!account) continue;

    const group = require('./groups').getGroup(workerName);

    // Groupes exclus des alertes (yoyo normal)
    if (ALERT_EXCLUDED_GROUPS.includes(group.id)) continue;

    issues[key] = {
      account:          accountUser,
      account_name:     account.name,
      worker:           workerName,
      group_id:         group.id,
      provider:         group.provider,
      type,
      current_avg_ths:  +(currentAvg  / 1e12).toFixed(1),
      baseline_avg_ths: +(baselineAvg / 1e12).toFixed(1),
      drop_pct:         Math.round(dropPct * 100),
      cv_pct:           Math.round(cv * 100),
      zero_rate_pct:    Math.round(zeroRate * 100),
    };
  }

  return issues;
}

async function sendWorkerAlert(account, issue, now) {
  const timeUTC = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  const tzLabel = new Intl.DateTimeFormat('en', { timeZoneName: 'short', timeZone: 'Europe/Paris' })
    .formatToParts(now).find(p => p.type === 'timeZoneName')?.value || 'CET';
  const timeParis = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

  let emoji, typeLabel, detail;
  if (issue.type === 'level_drop') {
    emoji     = '📉';
    typeLabel = `Hashrate drop ${issue.drop_pct}%`;
    detail    = `Before (avg 12h): <b>${issue.baseline_avg_ths} TH/s</b>\nNow (avg 3h):      <b>${issue.current_avg_ths} TH/s</b>`;
  } else {
    emoji     = '📊';
    typeLabel = `Unstable hashrate`;
    detail    = `Avg 3h: <b>${issue.current_avg_ths} TH/s</b>  |  Volatility: <b>${issue.cv_pct}%</b>\n${issue.zero_rate_pct}% of snapshots near zero`;
  }

  const tgText = [
    `${emoji} <b>${typeLabel} — capone watcher</b>`,
    ``,
    `🔧 <b>${issue.worker}</b> — ${account.name}`,
    `📍 ${issue.provider} (${issue.group_id})`,
    ``,
    detail,
    ``,
    `🕐 ${timeUTC} UTC — ${timeParis} ${tzLabel}`,
    `📊 https://watcher.capone.market`,
  ].join('\n');

  await sendTelegram(account.telegramChatId, tgText);
  console.log(`   📲 Alerte worker → ${issue.worker} (${issue.type})`);
}

// ─────────────────────────────────────────────────────────────────────────────

async function sendHashrateAlert(account, groupId, provider, currentHR, refHR, dropPct, now) {
  const timeUTC   = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  const dateFmt   = now.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const timeParis = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
  const tzLabel   = new Intl.DateTimeFormat('en', { timeZoneName: 'short', timeZone: 'Europe/Paris' })
    .formatToParts(now).find(p => p.type === 'timeZoneName')?.value || 'CET';

  const dropLabel = `${Math.round(dropPct * 100)}%`;

  // ── Telegram ──
  const tgText = [
    `⚠️ <b>Hashrate Alert — capone watcher</b>`,
    ``,
    `📍 <b>${provider} (${groupId})</b> — ${account.name}`,
    `📉 Hashrate dropped <b>${dropLabel}</b>`,
    ``,
    `Before (avg 1h30): <b>${fmtTH(refHR)}</b>`,
    `Now:               <b>${fmtTH(currentHR)}</b>`,
    ``,
    `🕐 ${timeUTC} UTC — ${timeParis} ${tzLabel}`,
    `📊 https://watcher.capone.market`,
  ].join('\n');

  // Groupe compte (Cyberian Mine ou Everminer)
  await sendTelegram(account.telegramChatId, tgText);

  // Groupe Paraguay — si le datacenter concerné est au Paraguay
  if (PARAGUAY_GROUPS.includes(groupId) && TELEGRAM_CHAT_PARAGUAY && TELEGRAM_CHAT_PARAGUAY !== account.telegramChatId) {
    await sendTelegram(TELEGRAM_CHAT_PARAGUAY, tgText);
    console.log(`   📲 Alerte → groupe Paraguay (${groupId})`);
  }

  // ── Email ──
  const subject = `[ALERT] Hashrate drop ${dropLabel} — ${provider} (${groupId}) — ${account.name}`;
  const html = `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f6f2;font-family:'DM Sans',-apple-system,BlinkMacSystemFont,sans-serif">
<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
  <div style="background:#D97757;padding:24px 32px">
    <h1 style="margin:0;color:#fff;font-size:20px">📉 Hashrate drop ${dropLabel}</h1>
    <p style="margin:4px 0 0;color:rgba(255,255,255,.85);font-size:14px">${dateFmt}</p>
    <p style="margin:2px 0 0;color:rgba(255,255,255,.7);font-size:13px">${timeUTC} UTC — ${timeParis} ${tzLabel}</p>
  </div>
  <div style="padding:24px 32px">
    <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #eee;border-radius:6px;overflow:hidden;margin-bottom:20px">
      <tr style="background:#efede7">
        <td style="padding:10px 16px;font-size:12px;color:#999;font-weight:700;text-transform:uppercase">Datacenter</td>
        <td style="padding:10px 16px;font-size:12px;color:#999;font-weight:700;text-transform:uppercase">Account</td>
        <td style="padding:10px 16px;font-size:12px;color:#999;font-weight:700;text-transform:uppercase">Before (avg 1h30)</td>
        <td style="padding:10px 16px;font-size:12px;color:#999;font-weight:700;text-transform:uppercase">Now</td>
        <td style="padding:10px 16px;font-size:12px;color:#999;font-weight:700;text-transform:uppercase">Drop</td>
      </tr>
      <tr>
        <td style="padding:12px 16px;font-size:14px;font-weight:700">${provider} <span style="color:#999;font-weight:400">(${groupId})</span></td>
        <td style="padding:12px 16px;font-size:14px">${account.name}</td>
        <td style="padding:12px 16px;font-size:14px">${fmtTH(refHR)}</td>
        <td style="padding:12px 16px;font-size:14px;font-weight:700;color:#e67e22">${fmtTH(currentHR)}</td>
        <td style="padding:12px 16px;font-size:14px;font-weight:700;color:#c0392b">▼ ${dropLabel}</td>
      </tr>
    </table>
    <p style="font-size:13px;color:#666">Check the dashboard for worker details: <a href="https://watcher.capone.market" style="color:#D97757;font-weight:600">watcher.capone.market</a></p>
    <div style="margin-top:32px;border-top:1px solid #f0f0f0;padding-top:20px;text-align:center">
      <img src="https://capone.market/capone-fish-avatar-48-orange.svg" alt="capone" width="56" height="56" style="display:block;margin:0 auto 8px"/>
      <p style="margin:0;color:#999;font-size:11px">This email was sent automatically — please do not reply.</p>
    </div>
  </div>
</div>
</body></html>`;

  await sendEmail(account.alertEmail, subject, html);
}

// ─── Rapport matin — offline detection + history ──────────────────────────────

function isWorkerOffline(w) {
  const lastShare = w.last_share_at || 0;
  return (Date.now() / 1000 - lastShare) / 60 > OFFLINE_MINUTES;
}

function classifyWorker(w) {
  const ageH = (Date.now() / 1000 - (w.last_share_at || 0)) / 3600;
  if (ageH < DEAD_THRESHOLD_H) return 'offline';
  const ageD = ageH / 24;
  if (ageD <= 7)  return 'dead_recent';
  if (ageD <= 90) return 'dead_mid';
  return 'dead_old';
}

function findOfflineWorkers(workers, accountUser) {
  return workers
    .filter(isWorkerOffline)
    .map(w => {
      const name  = w.hash_rate_info?.name || '?';
      const group = getGroup(name);
      if (group.id === 'No Group') return null;
      const lastShare  = w.last_share_at || 0;
      const minutesAgo = Math.round((Date.now() / 1000 - lastShare) / 60);
      return {
        account:   accountUser,
        name,
        groupId:   group.id,
        provider:  group.provider,
        lastSeen:  lastShare
          ? `${new Date(lastShare * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC (${minutesAgo}m ago)`
          : 'never',
        minutesAgo,
        host: w.host || '?',
      };
    })
    .filter(Boolean);
}

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); }
  catch { return { last_updated: null, snapshots: [], current_issues: {} }; }
}

function saveHistory(h) {
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(h, null, 2));
}

function updateHistory(h, now, allResults) {
  const issues = {};
  for (const { accountName, accountUser, allWorkers } of allResults) {
    for (const w of allWorkers) {
      const ageMin = (Date.now() / 1000 - (w.last_share_at || 0)) / 60;
      if (ageMin <= OFFLINE_MINUTES) continue;
      const name  = w.hash_rate_info?.name || '?';
      const group = getGroup(name);
      if (group.id === 'No Group') continue;
      const key = `${accountUser}.${name}`;
      issues[key] = {
        account: accountUser, account_name: accountName,
        name, group_id: group.id, provider: group.provider,
        host: w.host || '?',
        last_share: w.last_share_at ? new Date(w.last_share_at * 1000).toISOString() : null,
        category: classifyWorker(w),
      };
    }
  }

  const counts = { offline: 0, dead_recent: 0, dead_mid: 0, dead_old: 0 };
  for (const w of Object.values(issues)) counts[w.category]++;

  const by_account = {};
  for (const { accountName, accountUser, totalWorkers } of allResults) {
    const ai = Object.values(issues).filter(w => w.account === accountUser);
    by_account[accountUser] = {
      name: accountName, total: totalWorkers,
      online:  totalWorkers - ai.length,
      offline: ai.filter(w => w.category === 'offline').length,
      dead:    ai.filter(w => w.category !== 'offline').length,
    };
  }

  h.snapshots.push({ ts: now.toISOString(), by_account, ...counts });
  if (h.snapshots.length > MAX_HISTORY_SNAPS) h.snapshots = h.snapshots.slice(-MAX_HISTORY_SNAPS);
  h.last_updated    = now.toISOString();
  h.current_issues  = issues;
  return h;
}

function buildMorningEmail(offlineByAccount, workerIssues, now) {
  const date      = now.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const timeUTC   = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  const timeParis = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
  const tzLabel   = new Intl.DateTimeFormat('en', { timeZoneName: 'short', timeZone: 'Europe/Paris' })
    .formatToParts(now).find(p => p.type === 'timeZoneName')?.value || 'CET';

  const totalOffline    = offlineByAccount.reduce((s, a) => s + a.workers.length, 0);
  const anomalyList     = Object.values(workerIssues);
  const totalAnomalies  = anomalyList.length;
  const allGood         = totalOffline === 0 && totalAnomalies === 0;

  // ── Section workers offline ──
  const offlineSection = offlineByAccount
    .filter(a => a.workers.length > 0)
    .map(({ accountName, workers }) => {
      const byGroup = {};
      for (const w of workers) {
        const key = `${w.groupId} — ${w.provider}`;
        if (!byGroup[key]) byGroup[key] = [];
        byGroup[key].push(w);
      }
      const groupRows = Object.entries(byGroup).map(([label, ws]) => {
        const wRows = ws.map(w => `
          <tr>
            <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;font-family:'DM Mono',monospace;font-size:13px">${w.name}</td>
            <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;color:#666;font-size:13px">${w.lastSeen}</td>
            <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;color:#999;font-size:13px">${w.host}</td>
          </tr>`).join('');
        return `
          <tr><td colspan="3" style="padding:8px 12px;background:#fff3cd;font-weight:600;font-size:13px;color:#856404">
            ${label} — ${ws.length} worker${ws.length > 1 ? 's' : ''} offline
          </td></tr>${wRows}`;
      }).join('');
      return `
        <h3 style="margin:24px 0 8px;color:#1a1a14;font-size:16px">${accountName}</h3>
        <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #ddd;border-radius:6px;overflow:hidden">
          <thead><tr style="background:#efede7">
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;font-weight:600">WORKER</th>
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;font-weight:600">LAST SHARE</th>
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;font-weight:600">HOST</th>
          </tr></thead>
          <tbody>${groupRows}</tbody>
        </table>`;
    }).join('');

  // ── Section anomalies hashrate ──
  const anomalySection = totalAnomalies === 0 ? '' : (() => {
    const rows = anomalyList.map(w => {
      const dropIcon = `<img src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTQiIGhlaWdodD0iMTQiIHZpZXdCb3g9IjAgMCAxNCAxNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cG9seWxpbmUgcG9pbnRzPSIxLDMgNSwzIDksOSAxMywxMSIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjYzAzOTJiIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPjxwb2x5bGluZSBwb2ludHM9IjEwLDExIDEzLDExIDEzLDgiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2MwMzkyYiIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48L3N2Zz4=" width="13" height="13" style="vertical-align:middle;margin-right:3px">`;
      const waveIcon = `<img src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTQiIGhlaWdodD0iMTQiIHZpZXdCb3g9IjAgMCAxNCAxNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cG9seWxpbmUgcG9pbnRzPSIxLDcgMywzIDUsMTAgNywyIDksOSAxMSw0IDEzLDciIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2I3OTUwYiIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48L3N2Zz4=" width="13" height="13" style="vertical-align:middle;margin-right:3px">`;
      const badge = w.type === 'level_drop'
        ? `<span style="display:inline-flex;align-items:center;padding:3px 9px;border-radius:100px;background:#fdecea;color:#c0392b;font-size:11px;font-weight:700">${dropIcon}Drop −${w.drop_pct}%</span>`
        : `<span style="display:inline-flex;align-items:center;padding:3px 9px;border-radius:100px;background:#fef9e7;color:#b7950b;font-size:11px;font-weight:700">${waveIcon}Unstable</span>`;
      return `
        <tr>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;font-family:'DM Mono',monospace;font-size:13px">${w.worker}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;font-size:12px;color:#666">${w.account_name} · ${w.provider} (${w.group_id})</td>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0">${badge}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;font-size:12px;font-weight:600">${w.current_avg_ths} TH/s</td>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;font-size:12px;color:#aaa">${w.baseline_avg_ths} TH/s</td>
        </tr>`;
    }).join('');
    return `
      <h3 style="margin:28px 0 8px;color:#1a1a14;font-size:16px">⚡ Hashrate warnings — degraded or unstable workers</h3>
      <p style="margin:0 0 10px;font-size:12px;color:#999">Based on last 3h avg vs 12h baseline</p>
      <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #ddd;border-radius:6px;overflow:hidden">
        <thead><tr style="background:#efede7">
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;font-weight:600">WORKER</th>
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;font-weight:600">ACCOUNT · DATACENTER</th>
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;font-weight:600">ISSUE</th>
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;font-weight:600">NOW (3H AVG)</th>
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;font-weight:600">BASELINE (12H)</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  })();

  // ── En-tête ──
  const headerBg    = allGood ? '#27ae60' : totalOffline > 0 ? '#c0392b' : '#e67e22';
  const headerTitle = allGood
    ? '✅ All workers online — no issues'
    : [
        totalOffline    > 0 ? `⚠️ ${totalOffline} worker${totalOffline > 1 ? 's' : ''} offline` : '',
        totalAnomalies  > 0 ? `⚡ ${totalAnomalies} warning${totalAnomalies > 1 ? 's' : ''}` : '',
      ].filter(Boolean).join(' · ');

  const allGoodSection = allGood
    ? `<p style="font-size:14px;color:#27ae60;font-weight:600;margin:0 0 16px">✅ All workers are online and reporting normally.</p>`
    : '';

  const html = `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f6f2;font-family:'DM Sans',-apple-system,BlinkMacSystemFont,sans-serif">
<div style="max-width:680px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
  <div style="background:${headerBg};padding:24px 32px">
    <h1 style="margin:0;color:#fff;font-size:20px">${headerTitle}</h1>
    <p style="margin:4px 0 0;color:rgba(255,255,255,.85);font-size:14px">${date}</p>
    <p style="margin:2px 0 0;color:rgba(255,255,255,.7);font-size:13px">${timeUTC} UTC — ${timeParis} ${tzLabel}</p>
  </div>
  <div style="padding:24px 32px">
    ${allGoodSection}${offlineSection}${anomalySection}
    <div style="margin-top:32px;border-top:1px solid #f0f0f0;padding-top:24px;text-align:center">
      <a href="https://watcher.capone.market" style="display:inline-block;margin-bottom:16px;padding:8px 20px;background:#D97757;color:#000;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600">Open dashboard →</a><br>
      <img src="https://capone.market/capone-fish-avatar-48-orange.svg" alt="capone" width="56" height="56" style="display:block;margin:0 auto 8px"/>
      <p style="margin:4px 0 2px;color:#555;font-size:13px;font-weight:600">Morning report — capone watcher</p>
      <p style="margin:0;color:#999;font-size:11px">This email was sent automatically — please do not reply.</p>
    </div>
  </div>
</div>
</body></html>`;

  const subjectParts = [
    totalOffline   > 0 ? `${totalOffline} offline`                       : '',
    totalAnomalies > 0 ? `${totalAnomalies} warning${totalAnomalies > 1 ? 's' : ''}` : '',
  ].filter(Boolean);
  const subject = subjectParts.length > 0
    ? `[Morning Report] ${subjectParts.join(' · ')} — ${date}`
    : `[Morning Report] ✅ All online — ${date}`;

  return { html, subject };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date();
  console.log(`\n📊 Hashrate Collector — ${now.toISOString()}\n`);

  // Charge l'état avant les nouvelles données (référence = anciens snapshots)
  const h           = loadHashrate();
  const alertState  = loadAlertState();
  const allWorkers  = {}; // { accountUser: [workers] }

  const atoData = {}; // { user: raw response from load_by_duration }

  // ── 1. Fetch tous les workers + ATO ──────────────────────────────────────
  for (const account of ACCOUNTS) {
    if (!account.token) { console.warn(`⚠️  Token manquant pour ${account.name}`); continue; }
    console.log(`📡 Fetch — ${account.name} (${account.user})...`);
    try {
      allWorkers[account.user] = await fetchWorkers(account);
      console.log(`   ${allWorkers[account.user].length} workers`);
    } catch (err) {
      console.error(`   ❌ Erreur: ${err.message}`);
      allWorkers[account.user] = [];
    }
    // Fetch ATO via public web endpoint (no auth required, uses read key)
    atoData[account.user] = await fetchATO(account);
  }

  // ── 2. Détection chutes par groupe (avant de sauvegarder les nouveaux points) ──
  console.log('\n🔍 Vérification chutes hashrate par groupe...');
  const alertsToSend = [];
  const workerAlertsToSend = [];

  for (const account of ACCOUNTS) {
    if (!allWorkers[account.user]?.length) continue;

    for (const group of GROUPS) {
      const gid      = group.id;
      const provider = group.provider;
      const stateKey = `${account.user}.${gid}`;

      // Groupes exclus des alertes temps-réel (ex: E1/BitCluster — yoyo normal)
      if (ALERT_EXCLUDED_GROUPS.includes(gid)) {
        console.log(`   ⏭️  ${stateKey}: exclu des alertes hashrate (${provider})`);
        continue;
      }

      const currentHR = groupCurrentHR(allWorkers[account.user], account.user, gid);
      const refHR     = groupReferenceHR(h, account.user, gid);

      // Pas assez d'historique ou groupe vide
      if (refHR === null || refHR < 1e9) continue; // < 1 GH/s = pas significatif

      const dropPct = (refHR - currentHR) / refHR;

      if (dropPct > DROP_THRESHOLD) {
        // Vérif cooldown
        const lastAlert = alertState[stateKey];
        const cooldownOk = !lastAlert || (now - new Date(lastAlert)) > COOLDOWN_H * 3600000;

        if (cooldownOk) {
          console.log(`   🚨 ${stateKey}: chute ${Math.round(dropPct*100)}% (${fmtTH(refHR)} → ${fmtTH(currentHR)})`);
          alertsToSend.push({ account, gid, provider, currentHR, refHR, dropPct, stateKey });
        } else {
          console.log(`   ⏳ ${stateKey}: chute détectée mais cooldown actif (dernière alerte: ${lastAlert})`);
        }
      } else {
        console.log(`   ✓ ${stateKey}: ${fmtTH(currentHR)} (ref: ${fmtTH(refHR)})`);
      }
    }
  }

  // ── 3. Envoi des alertes ──────────────────────────────────────────────────
  for (const a of alertsToSend) {
    try {
      await sendHashrateAlert(a.account, a.gid, a.provider, a.currentHR, a.refHR, a.dropPct, now);
      alertState[a.stateKey] = now.toISOString();
    } catch (err) {
      console.error(`   ❌ Alerte non envoyée pour ${a.stateKey}: ${err.message}`);
    }
  }

  if (alertsToSend.length === 0) console.log('   Aucune chute détectée.');

  // ── 3b. Détection anomalies par worker (dégradé / instable) ───────────────
  console.log('\n🔬 Vérification anomalies workers (hashrate instable/dégradé)...');
  const workerIssues = detectWorkerAnomalies(h);
  let workerIssueCount = 0;

  for (const [key, issue] of Object.entries(workerIssues)) {
    const stateKey   = `w.${key}`;
    const lastAlert  = alertState[stateKey];
    const cooldownOk = !lastAlert || (now - new Date(lastAlert)) > WORKER_COOLDOWN_H * 3600000;

    if (cooldownOk) {
      const account = ACCOUNTS.find(a => a.user === issue.account);
      if (account) workerAlertsToSend.push({ issue, account, stateKey });
      console.log(`   🚨 ${key}: ${issue.type} — drop ${issue.drop_pct}% / CV ${issue.cv_pct}%`);
    } else {
      console.log(`   ⏳ ${key}: anomalie persistante (cooldown)`);
    }
    workerIssueCount++;
  }
  if (workerIssueCount === 0) console.log('   Aucune anomalie détectée.');

  // Alertes Telegram worker désactivées — trop de bruit (fluctuations normales)
  // Les anomalies restent visibles dans le dashboard (worker-issues.json)

  // ── 4. Sauvegarde nouveaux snapshots ──────────────────────────────────────
  for (const account of ACCOUNTS) {
    const workers = allWorkers[account.user] || [];
    for (const w of workers) {
      const name  = w.hash_rate_info?.name || '?';
      const group = getGroup(name);
      if (group.id === 'No Group') continue;
      const key = `${account.user}.${name}`;
      if (!h.workers[key]) h.workers[key] = [];
      h.workers[key].push({
        ts: now.toISOString(),
        hr: w.hash_rate_info?.h1_hash_rate ?? w.hash_rate_info?.hash_rate ?? 0,
      });
      if (h.workers[key].length > MAX_SNAPSHOTS) {
        h.workers[key] = h.workers[key].slice(-MAX_SNAPSHOTS);
      }
    }
  }

  // ── 4b. Sauvegarde snapshots ATO par compte ──────────────────────────────
  if (!h.accounts) h.accounts = {};
  for (const account of ACCOUNTS) {
    const ato = atoData[account.user];
    if (ato == null) continue;
    if (!h.accounts[account.user]) h.accounts[account.user] = [];
    h.accounts[account.user].push({ ts: now.toISOString(), ato });
    if (h.accounts[account.user].length > MAX_SNAPSHOTS)
      h.accounts[account.user] = h.accounts[account.user].slice(-MAX_SNAPSHOTS);
  }

  // ── 4c. Sauvegarde worker-hosts.json (IP de chaque worker actif) ─────────────
  const workerHosts = {};
  for (const account of ACCOUNTS) {
    for (const w of allWorkers[account.user] || []) {
      const name = w.hash_rate_info?.name || '?';
      const key  = `${account.user}.${name}`;
      if (w.host) workerHosts[key] = w.host;
    }
  }
  fs.writeFileSync(WORKERHOSTS_PATH, JSON.stringify(workerHosts, null, 2));

  h.last_updated = now.toISOString();
  saveHashrate(h);
  saveAlertState(alertState);

  // ── 5. Sauvegarde worker-issues.json (lu par le dashboard) ───────────────
  fs.mkdirSync(path.dirname(WORKERISSUES_PATH), { recursive: true });
  fs.writeFileSync(WORKERISSUES_PATH, JSON.stringify({
    last_updated: now.toISOString(),
    issues: workerIssues,
  }, null, 2));

  // ── 5b. Sauvegarde offline-status.json (statut temps réel des DCs) ────────
  // Critère : last_share_at > OFFLINE_MINUTES (même logique que le rapport matin)
  const offlineNow = {};
  for (const account of ACCOUNTS) {
    for (const w of allWorkers[account.user] || []) {
      if (!isWorkerOffline(w)) continue;
      const name  = w.hash_rate_info?.name || '?';
      const group = getGroup(name);
      if (group.id === 'No Group') continue;
      offlineNow[`${account.user}.${name}`] = {
        account:      account.user,
        account_name: account.name,
        name,
        group_id:     group.id,
        provider:     group.provider,
      };
    }
  }
  fs.writeFileSync(OFFLINESTATUS_PATH, JSON.stringify({
    last_updated: now.toISOString(),
    offline: offlineNow,
  }, null, 2));
  console.log(`   Offline temps réel: ${Object.keys(offlineNow).length} worker(s)`);

  // ── 6. Rapport matin (05:00 UTC) ──────────────────────────────────────────
  if (now.getUTCHours() === MORNING_HOUR_UTC) {
    const morningKey = 'morning_report';
    const lastMorning = alertState[morningKey];
    const morningOk   = !lastMorning || (now - new Date(lastMorning)) > MORNING_COOLDOWN_H * 3600000;

    if (morningOk) {
      console.log('\n🌅 Rapport matin...');

      // Offline workers (tous comptes)
      const offlineByAccount = ACCOUNTS.map(account => ({
        accountName: account.name,
        accountUser: account.user,
        workers: findOfflineWorkers(allWorkers[account.user] || [], account.user),
      }));

      // History
      const historyResults = ACCOUNTS.map(account => ({
        accountName:  account.name,
        accountUser:  account.user,
        totalWorkers: (allWorkers[account.user] || []).length,
        allWorkers:   allWorkers[account.user] || [],
      }));
      const hist = loadHistory();
      saveHistory(updateHistory(hist, now, historyResults));
      console.log(`   History: ${hist.snapshots.length + 1} snapshots`);

      // Email
      try {
        const { subject, html } = buildMorningEmail(offlineByAccount, workerIssues, now);
        await sendEmail(MORNING_ALERT_TO, subject, html);
        alertState[morningKey] = now.toISOString();
        console.log(`   ✉️  Rapport envoyé → ${MORNING_ALERT_TO}`);
      } catch (err) {
        console.error(`   ❌ Rapport matin non envoyé: ${err.message}`);
      }
    } else {
      console.log('\n🌅 Rapport matin: déjà envoyé aujourd\'hui (cooldown)');
    }
  }

  console.log(`\n✅ Sauvegardé — ${Object.keys(h.workers).length} workers | ${alertsToSend.length} alerte(s) groupe\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
