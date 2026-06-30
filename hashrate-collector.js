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
    token:          process.env.F2POOL_TOKEN_CMINE,
    alertEmail:     process.env.ALERT_EMAIL_CMINE    || process.env.ALERT_EMAIL || 'support@cyberianmine.de',
    telegramChatId: process.env.TELEGRAM_CHAT_ID_CMINE || process.env.TELEGRAM_CHAT_ID,
  },
  {
    name:           'Everminer',
    user:           'everminer',
    token:          process.env.F2POOL_TOKEN_EVERMINER,
    alertEmail:     process.env.ALERT_EMAIL_EVERMINER  || process.env.ALERT_EMAIL || 'support@cyberianmine.de',
    telegramChatId: process.env.TELEGRAM_CHAT_ID_EVERMINER || process.env.TELEGRAM_CHAT_ID,
  },
];

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_FROM     = process.env.ALERT_FROM || 'noreply@capone.market';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const F2POOL_API        = 'https://api.f2pool.com/v2/hash_rate/worker/list';
const HASHRATE_PATH     = path.join(__dirname, 'data', 'hashrate.json');
const ALERTSTATE_PATH   = path.join(__dirname, 'data', 'alert-state.json');
const WORKERISSUES_PATH = path.join(__dirname, 'data', 'worker-issues.json');

const MAX_SNAPSHOTS   = 145;  // 72h × 2 + 1 points (3 jours glissants)
const REF_SNAPSHOTS   = 3;    // 3 derniers snapshots = référence 1h30
const DROP_THRESHOLD  = 0.30; // alerte si chute > 30% (groupe)
const COOLDOWN_H      = 4;    // pas de double alerte sur le même groupe avant 4h

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
    `${emoji} <b>${typeLabel} — Capone Watcher</b>`,
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
    `⚠️ <b>Hashrate Alert — Capone Watcher</b>`,
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

  await sendTelegram(account.telegramChatId, tgText);

  // ── Email ──
  const subject = `[ALERT] Hashrate drop ${dropLabel} — ${provider} (${groupId}) — ${account.name}`;
  const html = `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9f9f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
  <div style="background:#e67e22;padding:24px 32px">
    <h1 style="margin:0;color:#fff;font-size:20px">📉 Hashrate drop ${dropLabel}</h1>
    <p style="margin:4px 0 0;color:rgba(255,255,255,.85);font-size:14px">${dateFmt}</p>
    <p style="margin:2px 0 0;color:rgba(255,255,255,.7);font-size:13px">${timeUTC} UTC — ${timeParis} ${tzLabel}</p>
  </div>
  <div style="padding:24px 32px">
    <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #eee;border-radius:6px;overflow:hidden;margin-bottom:20px">
      <tr style="background:#fafafa">
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
    <p style="font-size:13px;color:#666">Check the dashboard for worker details: <a href="https://watcher.capone.market" style="color:#3498db">watcher.capone.market</a></p>
    <div style="margin-top:32px;border-top:1px solid #f0f0f0;padding-top:20px;text-align:center">
      <img src="https://capone.market/capone-fish-avatar-48-orange.svg" alt="Capone" width="56" height="56" style="display:block;margin:0 auto 8px"/>
      <p style="margin:0;color:#999;font-size:11px">This email was sent automatically — please do not reply.</p>
    </div>
  </div>
</div>
</body></html>`;

  await sendEmail(account.alertEmail, subject, html);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date();
  console.log(`\n📊 Hashrate Collector — ${now.toISOString()}\n`);

  // Charge l'état avant les nouvelles données (référence = anciens snapshots)
  const h           = loadHashrate();
  const alertState  = loadAlertState();
  const allWorkers  = {}; // { accountUser: [workers] }

  // ── 1. Fetch tous les workers ──────────────────────────────────────────────
  for (const account of ACCOUNTS) {
    if (!account.token) { console.warn(`⚠️  Token manquant pour ${account.name}`); continue; }
    console.log(`📡 Fetch — ${account.name} (${account.user})...`);
    try {
      const workers = await fetchWorkers(account);
      allWorkers[account.user] = workers;
      console.log(`   ${workers.length} workers`);
    } catch (err) {
      console.error(`   ❌ Erreur: ${err.message}`);
      allWorkers[account.user] = [];
    }
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

  // Envoi alertes workers
  for (const { issue, account, stateKey } of workerAlertsToSend) {
    try {
      await sendWorkerAlert(account, issue, now);
      alertState[stateKey] = now.toISOString();
    } catch (err) {
      console.error(`   ❌ Alerte worker non envoyée pour ${issue.worker}: ${err.message}`);
    }
  }

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

  h.last_updated = now.toISOString();
  saveHashrate(h);
  saveAlertState(alertState);

  // ── 5. Sauvegarde worker-issues.json (lu par le dashboard) ───────────────
  fs.mkdirSync(path.dirname(WORKERISSUES_PATH), { recursive: true });
  fs.writeFileSync(WORKERISSUES_PATH, JSON.stringify({
    last_updated: now.toISOString(),
    issues: workerIssues,
  }, null, 2));

  console.log(`\n✅ Sauvegardé — ${Object.keys(h.workers).length} workers | ${alertsToSend.length} alerte(s) groupe | ${workerAlertsToSend.length} alerte(s) worker\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
