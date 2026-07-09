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
const TELEGRAM_CHAT_MINTO   = process.env.TELEGRAM_CHAT_ID_MINTO;

const F2POOL_API        = 'https://api.f2pool.com/v2/hash_rate/worker/list';
const HASHRATE_PATH     = path.join(__dirname, 'data', 'hashrate.json');
const ALERTSTATE_PATH   = path.join(__dirname, 'data', 'alert-state.json');
const WORKERISSUES_PATH = path.join(__dirname, 'data', 'worker-issues.json');
const HISTORY_PATH      = path.join(__dirname, 'data', 'history.json');
const OFFLINESTATUS_PATH = path.join(__dirname, 'data', 'offline-status.json');
const WORKERHOSTS_PATH   = path.join(__dirname, 'data', 'worker-hosts.json');
const SLA_DAILY_PATH     = path.join(__dirname, 'data', 'sla-daily.json');
const WATCHLIST_PATH     = path.join(__dirname, 'data', 'watchlist.json');
const GHOSTWORKERS_PATH  = path.join(__dirname, 'data', 'ghost-workers.json');
const MAX_DAILY_ENTRIES  = 31; // 30 jours glissants + 1 marge
const GHOST_MAX_DAYS     = 90; // garder les workers Dead dans le registre jusqu'à 90 jours
// No Group : détection uniquement dans le rapport matin (05:00 UTC)

const RECOVERY_THRESHOLD = 0.75; // 75% de la baseline = considéré récupéré
const WATCHLIST_MAX_DAYS = 14;   // auto-expire après 14 jours sans récupération

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

// Groupes Minto — alertes dupliquées vers TELEGRAM_CHAT_ID_MINTO
const MINTO_GROUPS = ['R3'];

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

    // Sustained drop detection: si la baseline de 12h est elle-même dégradée
    // (chute ancienne de >12h), on utilise le top-25% de tout l'historique disponible
    let effectiveBaseline = baselineAvg;
    if (snaps.length >= 96) { // au moins 48h d'historique
      const allHR   = snaps.map(p => p.hr).sort((a, b) => b - a);
      const topQ    = allHR.slice(0, Math.ceil(allHR.length * 0.25));
      const topQAvg = topQ.reduce((s, h) => s + h, 0) / topQ.length;
      if (topQAvg > effectiveBaseline * 1.5) effectiveBaseline = topQAvg;
    }

    const dropPct = effectiveBaseline > 0 ? (effectiveBaseline - currentAvg) / effectiveBaseline : 0;

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
      current_avg_ths:  +(currentAvg         / 1e12).toFixed(1),
      baseline_avg_ths: +(effectiveBaseline  / 1e12).toFixed(1),
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
    `🕐 ${timeUTC} UTC`,
    `📊 https://watcher.capone.market`,
  ].join('\n');

  await sendTelegram(account.telegramChatId, tgText);
  console.log(`   📲 Alerte worker → ${issue.worker} (${issue.type})`);
}

// ─────────────────────────────────────────────────────────────────────────────

async function sendHashrateAlert(account, groupId, provider, currentHR, refHR, dropPct, now) {
  // Vérification critique : si chatId manquant, on throw pour que alertState ne soit PAS mis à jour.
  // Sans ça, le secret vide fait croire que l'alerte est partie (retour silencieux de sendTelegram).
  if (!account.telegramChatId) {
    throw new Error(`Telegram non configuré pour ${account.name} — vérifier secret TELEGRAM_CHAT_ID_${account.user.toUpperCase()} dans GitHub Actions`);
  }

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
    `📉 Hashrate locally dropped by <b>${dropLabel}</b>`,
    ``,
    `Before (avg 1h30): <b>${fmtTH(refHR)}</b>`,
    `Now: <b>${fmtTH(currentHR)}</b>`,
    ``,
    `🕐 ${timeUTC} UTC`,
    `📊 https://watcher.capone.market`,
  ].join('\n');

  // Groupe compte (Cyberian Mine ou Everminer) — throw si échec (alertState non mis à jour)
  await sendTelegram(account.telegramChatId, tgText);
  console.log(`   📲 Alerte → ${account.name}`);

  // Groupe Paraguay — best-effort (ne bloque pas alertState si échec)
  if (PARAGUAY_GROUPS.includes(groupId) && TELEGRAM_CHAT_PARAGUAY && TELEGRAM_CHAT_PARAGUAY !== account.telegramChatId) {
    try {
      await sendTelegram(TELEGRAM_CHAT_PARAGUAY, tgText);
      console.log(`   📲 Alerte → groupe Paraguay (${groupId})`);
    } catch (err) {
      console.error(`   ⚠️  Alerte Paraguay non envoyée : ${err.message}`);
    }
  }

  // Groupe Minto — best-effort
  if (MINTO_GROUPS.includes(groupId) && TELEGRAM_CHAT_MINTO && TELEGRAM_CHAT_MINTO !== account.telegramChatId) {
    try {
      await sendTelegram(TELEGRAM_CHAT_MINTO, tgText);
      console.log(`   📲 Alerte → groupe Minto (${groupId})`);
    } catch (err) {
      console.error(`   ⚠️  Alerte Minto non envoyée : ${err.message}`);
    }
  }

  // ── Email — best-effort (échec email ne bloque pas alertState) ──
  const subject = `[ALERT] Hashrate drop ${dropLabel} — ${provider} (${groupId}) — ${account.name}`;
  const html = `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f6f2;font-family:'DM Sans',-apple-system,BlinkMacSystemFont,sans-serif">
<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
  <div style="background:#D97757;padding:24px 32px">
    <h1 style="margin:0;color:#fff;font-size:20px">📉 Hashrate drop ${dropLabel}</h1>
    <p style="margin:4px 0 0;color:rgba(255,255,255,.85);font-size:14px">${dateFmt}</p>
    <p style="margin:2px 0 0;color:rgba(255,255,255,.7);font-size:13px">${timeUTC} UTC</p>
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

  try {
    await sendEmail(account.alertEmail, subject, html);
  } catch (emailErr) {
    console.error(`   ⚠️  Email non envoyé (Telegram OK) : ${emailErr.message}`);
  }
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

// ─── Détection workers "fantômes" (Dead — retirés de l'API f2pool après ~24h) ─
// f2pool ne retourne plus les workers Dead dans la réponse API normale.
// On les détecte en comparant hashrate.json avec la liste API courante.
// Paramètre currentWorkerNames = Set des noms présents dans la réponse API.
function findGhostWorkers(hrData, accountUser, currentWorkerNames, now) {
  const ghosts   = [];
  const nowMs    = now.getTime();
  const SEVEN_DAYS_MS = 7 * 86400 * 1000;

  for (const [key, snaps] of Object.entries(hrData.workers || {})) {
    if (!key.startsWith(accountUser + '.')) continue;
    const workerName = key.slice(accountUser.length + 1);
    if (currentWorkerNames.has(workerName)) continue; // encore dans l'API
    if (!snaps || snaps.length === 0) continue;

    // Dernier snapshot connu
    let lastSnapMs = 0;
    for (const s of snaps) {
      const t = new Date(s.ts).getTime();
      if (t > lastSnapMs) lastSnapMs = t;
    }
    if (lastSnapMs === 0) continue;
    if (nowMs - lastSnapMs > SEVEN_DAYS_MS) continue; // trop ancien → ignoré

    const group = getGroup(workerName);
    if (group.id === 'No Group') continue;

    const minutesAgo  = Math.round((nowMs - lastSnapMs) / 60000);
    const lastSeenStr = new Date(lastSnapMs).toISOString().replace('T', ' ').slice(0, 19);
    const lastSnapIso = new Date(lastSnapMs).toISOString();

    // Catégorie selon ancienneté (même logique que classifyWorker côté API)
    const ageH = minutesAgo / 60;
    const ageD = ageH / 24;
    let category;
    if (ageH < 24)       category = 'offline';
    else if (ageD <= 7)  category = 'dead_recent';
    else if (ageD <= 90) category = 'dead_mid';
    else                 category = 'dead_old';

    ghosts.push({
      account:    accountUser,
      name:       workerName,
      groupId:    group.id,
      provider:   group.provider,
      lastSeen:   `${lastSeenStr} UTC (${minutesAgo}m ago) — Dead (no longer in pool API)`,
      minutesAgo,
      lastSnapIso,
      category,
      host:       '—',
      isGhost:    true,
    });
  }
  return ghosts;
}

// ─── Ghost workers — registre persistant (survit aux purges de hashrate.json) ──
// Nécessaire pour couvrir 8–90 jours (hashrate.json ne garde que 7 jours).
function loadGhostWorkers() {
  try { return JSON.parse(fs.readFileSync(GHOSTWORKERS_PATH, 'utf8')); }
  catch { return { last_updated: null, ghosts: {} }; }
}

function saveGhostWorkers(gw) {
  fs.mkdirSync(path.dirname(GHOSTWORKERS_PATH), { recursive: true });
  fs.writeFileSync(GHOSTWORKERS_PATH, JSON.stringify(gw, null, 2));
}

// Retourne les ghosts actifs depuis le registre pour un compte donné (sans dead_old).
// Recalcule la catégorie à chaque appel pour refléter l'âge actuel.
function getGhostsFromStore(ghostData, accountUser, now) {
  const nowMs = now.getTime();
  return Object.entries(ghostData.ghosts || {})
    .filter(([key]) => key.startsWith(accountUser + '.'))
    .map(([, g]) => {
      const lastMs     = new Date(g.lastSnapIso).getTime();
      const minutesAgo = Math.round((nowMs - lastMs) / 60000);
      const lastSeenStr = new Date(lastMs).toISOString().replace('T', ' ').slice(0, 19);
      const ageH = minutesAgo / 60;
      const ageD = ageH / 24;
      let category;
      if (ageH < 24)       category = 'offline';
      else if (ageD <= 7)  category = 'dead_recent';
      else if (ageD <= 90) category = 'dead_mid';
      else                 category = 'dead_old';
      const group = getGroup(g.name);
      return {
        account:    accountUser,
        name:       g.name,
        groupId:    g.groupId || group.id,
        provider:   g.provider || group.provider,
        lastSeen:   `${lastSeenStr} UTC (${minutesAgo}m ago) — Dead (no longer in pool API)`,
        minutesAgo,
        lastSnapIso: g.lastSnapIso,
        category,
        host:       '—',
        isGhost:    true,
      };
    })
    .filter(g => g.category !== 'dead_old'); // exclure >90j du rapport et de l'affichage
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

function buildMorningEmail(offlineByAccount, workerIssues, watchlistEntries, noGroupWorkers, now) {
  const date      = now.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const timeUTC   = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  const timeParis = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
  const tzLabel   = new Intl.DateTimeFormat('en', { timeZoneName: 'short', timeZone: 'Europe/Paris' })
    .formatToParts(now).find(p => p.type === 'timeZoneName')?.value || 'CET';

  const totalOffline    = offlineByAccount.reduce((s, a) => s + a.workers.length, 0);
  // Exclure de la section "warnings" les workers déjà listés en Still Degraded
  const wlWorkerSet = new Set(
    watchlistEntries
      .filter(e => e.type === 'worker_anomaly')
      .map(e => `${e.account}.${e.worker}`)
  );
  const anomalyList     = Object.entries(workerIssues)
    .filter(([key]) => !wlWorkerSet.has(key))
    .map(([, v]) => v);
  const totalAnomalies  = anomalyList.length;
  const totalWatchlist  = watchlistEntries.length;
  const totalNoGroup    = (noGroupWorkers || []).length;
  const allGood         = totalOffline === 0 && totalAnomalies === 0 && totalWatchlist === 0 && totalNoGroup === 0;

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
      const dropIcon = `<img src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTUiIGhlaWdodD0iOSIgdmlld0JveD0iMCAwIDE1IDkiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgZmlsbD0ibm9uZSI+PHBhdGggZD0iTTAsMyBMMS41LDEuNSBMMywzLjUgTDQuNSwyIEw2LDMgTDcsMS41IEw4LjUsNSBMMTAsNi41IEwxMS41LDUuNSBMMTMsOCBMMTUsOC41IiBzdHJva2U9IiNjMDM5MmIiIHN0cm9rZS13aWR0aD0iMS42IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48L3N2Zz4=" width="15" height="9" style="vertical-align:middle;margin-right:3px">`;
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

  // ── Section watchlist ──
  const watchlistSection = totalWatchlist === 0 ? '' : (() => {
    const rows = watchlistEntries.map(e => {
      const label   = e.type === 'group_drop'
        ? `${e.provider} (${e.group_id}) — ${e.account_name}`
        : `${e.worker} · ${e.provider} (${e.group_id}) — ${e.account_name}`;
      const typeTag = e.type === 'group_drop' ? 'Group drop' : (e.anomaly_type === 'level_drop' ? 'Level drop' : 'Unstable');
      const baseTH  = (e.baseline_hr / 1e12).toFixed(1);
      const nowTH   = (e.current_hr  / 1e12).toFixed(1);
      const durLabel = e.duration_h < 24
        ? `${e.duration_h}h`
        : `${Math.floor(e.duration_h / 24)}d ${Math.round(e.duration_h % 24)}h`;
      return `
        <tr>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;font-weight:600">${label}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0"><span style="display:inline-block;padding:2px 8px;border-radius:100px;background:#fdecea;color:#c0392b;font-size:11px;font-weight:700">−${e.drop_pct}%</span></td>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;font-size:12px;color:#666">${nowTH} TH/s <span style="color:#aaa">/ ${baseTH} baseline</span></td>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;font-size:12px;color:#e67e22;font-weight:600">Since ${durLabel}</td>
        </tr>`;
    }).join('');
    return `
      <h3 style="margin:28px 0 8px;color:#1a1a14;font-size:16px">🔴 Still degraded — ongoing watch</h3>
      <p style="margin:0 0 10px;font-size:12px;color:#999">These workers/groups were flagged and have not recovered to ≥75% of their baseline.</p>
      <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #ddd;border-radius:6px;overflow:hidden">
        <thead><tr style="background:#fdecea">
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#c0392b;font-weight:600">WORKER / GROUP</th>
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#c0392b;font-weight:600">DROP</th>
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#c0392b;font-weight:600">NOW / BASELINE</th>
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#c0392b;font-weight:600">DURATION</th>
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
        totalWatchlist  > 0 ? `🔴 ${totalWatchlist} still degraded` : '',
        totalNoGroup    > 0 ? `🏷️ ${totalNoGroup} no group` : '',
      ].filter(Boolean).join(' · ');

  const allGoodSection = allGood
    ? `<p style="font-size:14px;color:#27ae60;font-weight:600;margin:0 0 16px">✅ All workers are online and reporting normally.</p>`
    : '';

  const noGroupSection = totalNoGroup === 0 ? '' : (() => {
    const rows = (noGroupWorkers || []).map(w => `
      <tr>
        <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;font-family:'DM Mono',monospace;font-size:13px">${w.name}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;font-size:13px">${w.account_name}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#999">${w.host}</td>
      </tr>`).join('');
    return `
    <div style="margin-bottom:28px">
      <div style="font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#8e44ad;margin-bottom:10px">🏷️ Workers sans groupe — action requise</div>
      <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #eee;border-radius:6px;overflow:hidden">
        <tr style="background:#f5eef8">
          <td style="padding:7px 12px;font-size:11px;color:#8e44ad;font-weight:700;text-transform:uppercase">Worker</td>
          <td style="padding:7px 12px;font-size:11px;color:#8e44ad;font-weight:700;text-transform:uppercase">Account</td>
          <td style="padding:7px 12px;font-size:11px;color:#8e44ad;font-weight:700;text-transform:uppercase">Host</td>
        </tr>
        ${rows}
      </table>
      <p style="font-size:12px;color:#666;margin:8px 0 0">Assigner à un groupe sur f2pool, puis mettre à jour <code>groups.js</code>.</p>
    </div>`;
  })();

  const html = `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f6f2;font-family:'DM Sans',-apple-system,BlinkMacSystemFont,sans-serif">
<div style="max-width:680px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
  <div style="background:${headerBg};padding:24px 32px">
    <h1 style="margin:0;color:#fff;font-size:20px">${headerTitle}</h1>
    <p style="margin:4px 0 0;color:rgba(255,255,255,.85);font-size:14px">${date}</p>
    <p style="margin:2px 0 0;color:rgba(255,255,255,.7);font-size:13px">${timeUTC} UTC</p>
  </div>
  <div style="padding:24px 32px">
    ${allGoodSection}${watchlistSection}${offlineSection}${anomalySection}${noGroupSection}
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
    totalNoGroup   > 0 ? `${totalNoGroup} no group` : '',
  ].filter(Boolean);
  const subject = subjectParts.length > 0
    ? `[Morning Report] ${subjectParts.join(' · ')} — ${date}`
    : `[Morning Report] ✅ All online — ${date}`;

  return { html, subject };
}

// ─── SLA Daily aggregate ──────────────────────────────────────────────────────
// Écrit une ligne par jour dans data/sla-daily.json (appelé au run 05:00 UTC).
// Agrège les métriques SLA du jour UTC précédent depuis hashrate.json.

function loadSLADaily() {
  try { return JSON.parse(fs.readFileSync(SLA_DAILY_PATH, 'utf8')); }
  catch { return { days: [] }; }
}

function saveSLADaily(d) {
  fs.mkdirSync(path.dirname(SLA_DAILY_PATH), { recursive: true });
  fs.writeFileSync(SLA_DAILY_PATH, JSON.stringify(d));
}

function writeDailySLA(hrData, now) {
  // Jour UTC précédent (ex: si on est 05:00 le 3, on calcule le 2)
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const dateStr   = yesterday.toISOString().slice(0, 10); // "YYYY-MM-DD"

  const daily = loadSLADaily();
  if (daily.days.some(d => d.date === dateStr)) {
    console.log(`📊 SLA daily: déjà présent pour ${dateStr}`);
    return;
  }

  const dayStart = yesterday.getTime();
  const dayEnd   = dayStart + 86400000; // exclusif
  const nowMs    = now.getTime();

  // Filtre les snapshots du jour J-1
  const dayWorkers = {};
  for (const [wkey, snaps] of Object.entries(hrData.workers || {})) {
    const filtered = snaps.filter(s => {
      const t = new Date(s.ts).getTime();
      return t >= dayStart && t < dayEnd;
    });
    if (filtered.length) dayWorkers[wkey] = filtered;
  }

  const dayAccounts = {};
  for (const [aname, aSnaps] of Object.entries(hrData.accounts || {})) {
    const filtered = aSnaps.filter(s => {
      const t = new Date(s.ts).getTime();
      return t >= dayStart && t < dayEnd;
    });
    if (filtered.length) dayAccounts[aname] = filtered;
  }

  if (Object.keys(dayWorkers).length === 0) {
    console.log(`📊 SLA daily: aucun snapshot pour ${dateStr}, ignoré`);
    return;
  }

  // Structure groupée (même logique que sla.html)
  const groupData = {};
  for (const [wkey, snaps] of Object.entries(dayWorkers)) {
    const dot   = wkey.indexOf('.');
    const acct  = wkey.slice(0, dot);
    const wname = wkey.slice(dot + 1);
    const g     = getGroup(wname);
    if (!g || g.id === 'No Group') continue;
    const gkey  = `${acct}::${g.id}`;
    if (!groupData[gkey]) groupData[gkey] = { id: g.id, provider: g.provider, account: acct, workers: {} };
    groupData[gkey].workers[wkey] = snaps;
  }

  const DEAD_7D = 7 * 86400000;

  // ── 1. Continuity SLA (r² moyen par groupe) ────────────────────────────────
  const continuity = {};
  for (const [gkey, gd] of Object.entries(groupData)) {
    const active = new Set();
    for (const [wk] of Object.entries(gd.workers)) {
      // Utilise l'historique complet pour détecter les workers inactifs >7j
      const allSnaps = hrData.workers[wk] || gd.workers[wk];
      if (!allSnaps.length) continue;
      const lastTs = Math.max(...allSnaps.map(s => new Date(s.ts).getTime()));
      if (nowMs - lastTs <= DEAD_7D) active.add(wk);
    }
    const total = active.size;
    if (!total) continue;

    const tsOnline = new Map();
    for (const [wk, snaps] of Object.entries(gd.workers)) {
      if (!active.has(wk)) continue;
      for (const s of snaps) {
        if (!tsOnline.has(s.ts)) tsOnline.set(s.ts, 0);
        if (s.hr > 0) tsOnline.set(s.ts, tsOnline.get(s.ts) + 1);
      }
    }
    if (!tsOnline.size) continue;

    const scores = [...tsOnline.values()].map(o => { const r = o / total; return r * r; });
    continuity[gkey] = scores.reduce((s, v) => s + v, 0) / scores.length;
  }

  // ── 2. Account Performance SLA (ATO) ──────────────────────────────────────
  const account_perf = {};
  for (const [acctName, atoSnaps] of Object.entries(dayAccounts)) {
    const totalByTs = new Map();
    for (const [wkey, snaps] of Object.entries(dayWorkers)) {
      if (!wkey.startsWith(acctName + '.')) continue;
      for (const s of snaps) totalByTs.set(s.ts, (totalByTs.get(s.ts) || 0) + s.hr);
    }
    const atoSorted = [...atoSnaps].sort((a, b) => new Date(a.ts) - new Date(b.ts));
    let sumSLA = 0, n = 0;
    for (const [ts, totalHr] of totalByTs) {
      const tMs = new Date(ts).getTime();
      let best = null, bd = Infinity;
      for (const a of atoSorted) {
        const d = Math.abs(new Date(a.ts).getTime() - tMs);
        if (d < bd) { bd = d; best = a; }
      }
      if (!best || bd > 75 * 60000) continue;
      sumSLA += Math.min(1, totalHr / best.ato); n++;
    }
    if (n) account_perf[acctName] = sumSLA / n;
  }

  // ── 3. DC Combined SLA (continuity × throughput) ──────────────────────────
  const dc_combined = {};
  const acctNames = [...new Set(Object.values(groupData).map(g => g.account))];

  for (const acctName of acctNames) {
    const atoSnaps = dayAccounts[acctName];
    if (!atoSnaps?.length) continue;

    const totalByTs = new Map();
    for (const [wkey, snaps] of Object.entries(dayWorkers)) {
      if (!wkey.startsWith(acctName + '.')) continue;
      for (const s of snaps) totalByTs.set(s.ts, (totalByTs.get(s.ts) || 0) + s.hr);
    }

    for (const [gkey, gd] of Object.entries(groupData)) {
      if (gd.account !== acctName) continue;

      const dcByTs = new Map();
      for (const [, snaps] of Object.entries(gd.workers))
        for (const s of snaps) dcByTs.set(s.ts, (dcByTs.get(s.ts) || 0) + s.hr);

      // DC share — snapshots online seulement
      let sumDC = 0, sumTot = 0, nDC = 0;
      for (const [ts, hrDC] of dcByTs) {
        if (hrDC <= 0) continue;
        sumDC += hrDC; sumTot += (totalByTs.get(ts) || 0); nDC++;
      }
      if (!nDC || !sumTot) continue;
      const dcShare = (sumDC / nDC) / (sumTot / nDC);

      // Throughput
      const allTs = [...new Set([...dcByTs.keys(), ...totalByTs.keys()])];
      let sumTp = 0, nTp = 0;
      for (const ts of allTs) {
        const hrDC = dcByTs.get(ts) || 0;
        const tot  = totalByTs.get(ts) || 0;
        if (hrDC <= 0 || tot <= 0) continue;
        sumTp += Math.min(1, hrDC / (tot * dcShare)); nTp++;
      }
      if (!nTp) continue;
      const throughput = sumTp / nTp;

      // Combined = continuity × throughput
      const cont = continuity[gkey] ?? 1;
      dc_combined[gkey] = Math.min(1, cont * throughput);
    }
  }

  daily.days.push({ date: dateStr, continuity, account_perf, dc_combined });
  if (daily.days.length > MAX_DAILY_ENTRIES) daily.days = daily.days.slice(-MAX_DAILY_ENTRIES);
  daily.last_updated = now.toISOString();
  saveSLADaily(daily);
  console.log(`📊 SLA daily: ${dateStr} écrit — ${Object.keys(continuity).length} groupes, ${Object.keys(account_perf).length} comptes`);
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
      // Watchlist : surveillance post-drop
      if (!alertState.watchlist) alertState.watchlist = {};
      alertState.watchlist[`g.${a.stateKey}`] = {
        type:        'group_drop',
        baselineHR:  a.refHR,
        currentHR:   a.currentHR,
        provider:    a.provider,
        groupId:     a.gid,
        account:     a.account.user,
        accountName: a.account.name,
        detectedAt:  now.toISOString(),
      };
      console.log(`   👁️  Watchlist: ${a.stateKey} ajouté (baseline ${fmtTH(a.refHR)})`);
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
      alertState[stateKey] = now.toISOString(); // mise à jour cooldown
      console.log(`   🚨 ${key}: ${issue.type} — drop ${issue.drop_pct}% / CV ${issue.cv_pct}%`);
      // Watchlist : surveillance post-anomalie
      if (!alertState.watchlist) alertState.watchlist = {};
      const wlKey = `w.${key}`;
      if (!alertState.watchlist[wlKey]) {
        alertState.watchlist[wlKey] = {
          type:        'worker_anomaly',
          baselineHR:  issue.baseline_avg_ths * 1e12,
          currentHR:   issue.current_avg_ths  * 1e12,
          worker:      issue.worker,
          provider:    issue.provider,
          groupId:     issue.group_id,
          account:     issue.account,
          accountName: issue.account_name,
          anomalyType: issue.type,
          detectedAt:  now.toISOString(),
        };
        console.log(`   👁️  Watchlist: ${wlKey} ajouté (baseline ${issue.baseline_avg_ths} TH/s)`);
      }
    } else {
      console.log(`   ⏳ ${key}: anomalie persistante (cooldown)`);
    }
    workerIssueCount++;
  }
  if (workerIssueCount === 0) console.log('   Aucune anomalie détectée.');

  // Alertes Telegram worker désactivées — trop de bruit (fluctuations normales)
  // Les anomalies restent visibles dans le dashboard (worker-issues.json)

  // ── 3c. Watchlist — recovery check (toutes les 30 min) ───────────────────
  console.log('\n👁️  Vérification watchlist...');
  if (!alertState.watchlist) alertState.watchlist = {};
  const watchlistKeys = Object.keys(alertState.watchlist);
  if (watchlistKeys.length === 0) {
    console.log('   Watchlist vide.');
  }
  for (const wlKey of watchlistKeys) {
    const entry = alertState.watchlist[wlKey];
    // Auto-expire
    const ageDays = (now - new Date(entry.detectedAt)) / 86400000;
    if (ageDays > WATCHLIST_MAX_DAYS) {
      console.log(`   🗑️  ${wlKey}: expiré (${Math.floor(ageDays)}j) — retiré`);
      delete alertState.watchlist[wlKey];
      continue;
    }
    // Récupère le HR actuel
    let currentHR = 0;
    if (entry.type === 'group_drop') {
      const acct = ACCOUNTS.find(a => a.user === entry.account);
      if (acct && allWorkers[acct.user]) {
        currentHR = groupCurrentHR(allWorkers[acct.user], acct.user, entry.groupId);
      }
    } else if (entry.type === 'worker_anomaly') {
      const workers = allWorkers[entry.account] || [];
      const w = workers.find(w => w.hash_rate_info?.name === entry.worker);
      currentHR = w ? (w.hash_rate_info?.h1_hash_rate ?? w.hash_rate_info?.hash_rate ?? 0) : 0;
    }
    entry.currentHR = currentHR;
    const dropPct = entry.baselineHR > 0 ? Math.round((1 - currentHR / entry.baselineHR) * 100) : 0;
    if (currentHR >= RECOVERY_THRESHOLD * entry.baselineHR) {
      console.log(`   ✅ ${wlKey}: récupéré (${fmtTH(currentHR)} ≥ ${Math.round(RECOVERY_THRESHOLD*100)}% baseline) — retiré`);
      delete alertState.watchlist[wlKey];
    } else {
      const durationH = ((now - new Date(entry.detectedAt)) / 3600000).toFixed(1);
      console.log(`   ⚠️  ${wlKey}: toujours dégradé ${dropPct}% — ${fmtTH(currentHR)} depuis ${durationH}h`);
    }
  }
  // Sauvegarde watchlist.json (lu par le dashboard)
  const watchlistForDash = Object.entries(alertState.watchlist).map(([wlKey, entry]) => {
    const durationH = +((now - new Date(entry.detectedAt)) / 3600000).toFixed(1);
    const dropPct   = entry.baselineHR > 0 ? Math.round((1 - (entry.currentHR || 0) / entry.baselineHR) * 100) : 0;
    return {
      key:          wlKey,
      type:         entry.type,
      provider:     entry.provider,
      group_id:     entry.groupId,
      account:      entry.account,
      account_name: entry.accountName,
      worker:       entry.worker   || null,
      anomaly_type: entry.anomalyType || null,
      baseline_hr:  entry.baselineHR,
      current_hr:   entry.currentHR || 0,
      drop_pct:     dropPct,
      detected_at:  entry.detectedAt,
      duration_h:   durationH,
    };
  });
  fs.writeFileSync(WATCHLIST_PATH, JSON.stringify({
    last_updated: now.toISOString(),
    entries: watchlistForDash,
  }, null, 2));
  console.log(`   ${watchlistForDash.length} entrée(s) en surveillance.`);

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

  // ── 4d. Maintenance ghost-workers.json (registre persistant 90 jours) ────────
  // hashrate.json ne garde que 7 jours → ghost-workers.json assure la continuité jusqu'à 90j.
  const ghostData = loadGhostWorkers();
  for (const account of ACCOUNTS) {
    const currentNames = new Set(
      (allWorkers[account.user] || []).map(w => w.hash_rate_info?.name).filter(Boolean)
    );
    // 1. Nouveaux ghosts détectés via hashrate.json (window 7j)
    for (const g of findGhostWorkers(h, account.user, currentNames, now)) {
      const key = `${account.user}.${g.name}`;
      if (!ghostData.ghosts[key]) {
        ghostData.ghosts[key] = {
          account:      g.account,
          account_name: ACCOUNTS.find(a => a.user === g.account)?.name || g.account,
          name:         g.name,
          groupId:      g.groupId,
          provider:     g.provider,
          lastSnapIso:  g.lastSnapIso,
          detectedAt:   now.toISOString(),
        };
        console.log(`   👻 Nouveau ghost enregistré : ${key} (last seen ${g.lastSnapIso})`);
      }
    }
    // 2. Supprimer les workers revenus dans l'API (résolus)
    for (const key of Object.keys(ghostData.ghosts)) {
      if (!key.startsWith(account.user + '.')) continue;
      const name = key.slice(account.user.length + 1);
      if (currentNames.has(name)) {
        console.log(`   ✅ Ghost résolu : ${key} (revenu dans l'API)`);
        delete ghostData.ghosts[key];
      }
    }
  }
  // 3. Expirer les ghosts > 90 jours
  for (const [key, g] of Object.entries(ghostData.ghosts)) {
    const ageD = (now - new Date(g.lastSnapIso)) / 86400000;
    if (ageD > GHOST_MAX_DAYS) {
      console.log(`   🗑️  Ghost expiré : ${key} (${Math.round(ageD)}j > ${GHOST_MAX_DAYS}j)`);
      delete ghostData.ghosts[key];
    }
  }
  ghostData.last_updated = now.toISOString();
  saveGhostWorkers(ghostData);
  console.log(`   Ghosts actifs : ${Object.keys(ghostData.ghosts).length}`);

  // ── 5. Sauvegarde worker-issues.json (lu par le dashboard) ───────────────
  fs.mkdirSync(path.dirname(WORKERISSUES_PATH), { recursive: true });
  fs.writeFileSync(WORKERISSUES_PATH, JSON.stringify({
    last_updated: now.toISOString(),
    issues: workerIssues,
  }, null, 2));

  // ── 5b. Sauvegarde offline-status.json (statut temps réel des DCs) ────────
  // Critère : last_share_at > OFFLINE_MINUTES (même logique que le rapport matin)
  // + workers "fantômes" : disparus de l'API f2pool (Dead >24h) mais historique récent
  const offlineNow = {};
  for (const account of ACCOUNTS) {
    // Workers retournés par l'API (offline mais encore visibles)
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
    // Workers fantômes : Dead, retirés de l'API → lus depuis ghost-workers.json (90j)
    for (const g of getGhostsFromStore(ghostData, account.user, now)) {
      offlineNow[`${account.user}.${g.name}`] = {
        account:      account.user,
        account_name: account.name,
        name:         g.name,
        group_id:     g.groupId,
        provider:     g.provider,
        dead:         true,
        category:     g.category,
        last_share:   g.lastSnapIso, // utilisé par categoryOf() dans le dashboard
      };
    }
  }
  fs.writeFileSync(OFFLINESTATUS_PATH, JSON.stringify({
    last_updated: now.toISOString(),
    offline: offlineNow,
  }, null, 2));
  console.log(`   Offline temps réel: ${Object.keys(offlineNow).length} worker(s)`);

  // No Group : détection uniquement dans le rapport matin (pas à chaque snapshot).

  // ── 6. Rapport matin (05:00 UTC) ──────────────────────────────────────────
  if (now.getUTCHours() === MORNING_HOUR_UTC && now.getUTCMinutes() < 15) {
    const morningKey = 'morning_report';
    const lastMorning = alertState[morningKey];
    const morningOk   = !lastMorning || (now - new Date(lastMorning)) > MORNING_COOLDOWN_H * 3600000;

    if (morningOk) {
      console.log('\n🌅 Rapport matin...');

      // Offline workers (tous comptes) + workers fantômes depuis ghost-workers.json (90j)
      const offlineByAccount = ACCOUNTS.map(account => {
        const offline = findOfflineWorkers(allWorkers[account.user] || [], account.user);
        const ghosts  = getGhostsFromStore(ghostData, account.user, now);
        return {
          accountName: account.name,
          accountUser: account.user,
          workers: [...offline, ...ghosts],
        };
      });

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

      // SLA daily aggregate (données du jour J-1)
      writeDailySLA(h, now);

      // Détection workers No Group (une seule fois par jour, au rapport matin)
      console.log('   🏷️  Vérification workers No Group...');
      const noGroupWorkers = [];
      for (const account of ACCOUNTS) {
        for (const w of allWorkers[account.user] || []) {
          const name  = w.hash_rate_info?.name || '?';
          const group = getGroup(name);
          if (group.id !== 'No Group') continue;
          noGroupWorkers.push({
            account:      account.user,
            account_name: account.name,
            name,
            hr3h: w.hash_rate_info?.h3_hash_rate ?? w.hash_rate_info?.hash_rate ?? 0,
            host: w.host || '?',
          });
        }
      }
      if (noGroupWorkers.length > 0) {
        console.log(`   ⚠️  ${noGroupWorkers.length} worker(s) No Group → inclus dans le rapport matin.`);
      }

      // Email
      try {
        const { subject, html } = buildMorningEmail(offlineByAccount, workerIssues, watchlistForDash, noGroupWorkers, now);
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
