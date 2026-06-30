#!/usr/bin/env node
// Hashrate Collector — stocke un snapshot du hashrate de tous les workers toutes les 30 min.
// Tourne via GitHub Actions cron. Alimente data/hashrate.json pour le graphe modal du dashboard.

const { getGroup } = require('./groups');
const fs   = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

const ACCOUNTS = [
  { name: 'Cyberian Mine', user: 'cmine',    token: process.env.F2POOL_TOKEN_CMINE },
  { name: 'Everminer',     user: 'everminer', token: process.env.F2POOL_TOKEN_EVERMINER },
];

const F2POOL_API    = 'https://api.f2pool.com/v2/hash_rate/worker/list';
const HASHRATE_PATH = path.join(__dirname, 'data', 'hashrate.json');
const MAX_SNAPSHOTS = 145; // 72h × 2 + 1 = 145 points à 30 min d'intervalle (3 jours glissants)

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

// ─── Storage ──────────────────────────────────────────────────────────────────

function loadHashrate() {
  try { return JSON.parse(fs.readFileSync(HASHRATE_PATH, 'utf8')); }
  catch { return { last_updated: null, workers: {} }; }
}

function saveHashrate(h) {
  fs.mkdirSync(path.dirname(HASHRATE_PATH), { recursive: true });
  fs.writeFileSync(HASHRATE_PATH, JSON.stringify(h));  // minifié — fichier plus léger
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date();
  console.log(`\n📊 Hashrate Collector — ${now.toISOString()}\n`);

  const h = loadHashrate();

  for (const account of ACCOUNTS) {
    if (!account.token) { console.warn(`⚠️  Token manquant pour ${account.name}`); continue; }

    console.log(`📡 Fetch — ${account.name} (${account.user})...`);
    try {
      const workers = await fetchWorkers(account);
      let tracked = 0;

      for (const w of workers) {
        const name = w.hash_rate_info?.name || '?';
        const group = getGroup(name);
        if (group.id === 'No Group') continue;

        const key = `${account.user}.${name}`;
        if (!h.workers[key]) h.workers[key] = [];

        // h1_hash_rate = moyenne sur 1h → courbe lisse comme f2pool
        h.workers[key].push({
          ts: now.toISOString(),
          hr: w.hash_rate_info?.h1_hash_rate ?? w.hash_rate_info?.hash_rate ?? 0,
        });

        // Garde uniquement les 145 derniers points (72h glissantes = 3 jours)
        if (h.workers[key].length > MAX_SNAPSHOTS) {
          h.workers[key] = h.workers[key].slice(-MAX_SNAPSHOTS);
        }
        tracked++;
      }

      console.log(`   ${workers.length} workers récupérés — ${tracked} stockés`);
    } catch (err) {
      console.error(`   ❌ Erreur: ${err.message}`);
    }
  }

  h.last_updated = now.toISOString();
  saveHashrate(h);
  console.log(`\n✅ Sauvegardé — ${Object.keys(h.workers).length} workers dans hashrate.json\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
