# Spécification Technique — Capone Watcher

**Produit** : watcher.capone.market  
**Version** : juillet 2026  
**Objet** : architecture, technologies, fonctionnement du frontend et du backend.

---

## 1. Vue d'ensemble de l'architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  SCHEDULER                                                          │
│  cron-job.org → POST GitHub API (workflow_dispatch) toutes les 30min│
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  BACKEND (GitHub Actions — Runner Ubuntu)                           │
│  hashrate-collector.js (Node.js 20)                                 │
│  ├── Appels API f2pool (workers + ATO)                              │
│  ├── Détection anomalies                                            │
│  ├── Alertes Telegram (Bot API)                                     │
│  ├── Alertes email (Resend API)                                     │
│  └── Commit + push → data/*.json dans le dépôt GitHub              │
└────────────────────────────┬────────────────────────────────────────┘
                             │ git push (main)
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  DONNÉES (GitHub — dépôt public)                                    │
│  sebwebmail-arch/btc-miner-monitor                                  │
│  └── data/*.json (fichiers JSON statiques)                          │
└────────────────────────────┬────────────────────────────────────────┘
                             │ raw.githubusercontent.com
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  FRONTEND (Vercel — CDN statique)                                   │
│  index.html (HTML/CSS/JS vanilla, fichier unique)                   │
│  sla.html   (page SLA, fichier unique)                              │
└─────────────────────────────────────────────────────────────────────┘
```

**Caractéristique clé** : le système est entièrement sans serveur (_serverless_). Il n'y a ni base de données, ni API backend exposée, ni service persistant. L'état est stocké dans des fichiers JSON versionnés sur GitHub.

---

## 2. Technologies et services

| Composant | Technologie / Service | Rôle |
|-----------|----------------------|------|
| Scheduler | cron-job.org (gratuit) | Déclenche le workflow GitHub Actions toutes les 30 min |
| Backend | Node.js 20, GitHub Actions | Collecte, détection, alertes |
| Données | GitHub (dépôt public) | Stockage JSON, accessible via URL raw |
| Frontend | HTML/CSS/JS vanilla | Dashboard statique, zéro framework |
| Hébergement frontend | Vercel (gratuit) | CDN, HTTPS, déploiement depuis GitHub |
| Email | Resend API (gratuit) | Envoi emails HTML |
| Telegram | Telegram Bot API | Alertes instantanées |
| Pool de minage | f2pool API v2 | Source de données workers |

---

## 3. Dépôt GitHub

**Nom** : `sebwebmail-arch/btc-miner-monitor`  
**Visibilité** : **public** (requis pour que les URLs raw soient accessibles sans authentification par le dashboard)

### Structure des fichiers

```
btc-miner-monitor/
├── hashrate-collector.js      # Script principal (backend)
├── groups.js                  # Mapping worker name → groupe/provider
├── package.json               # Dépendances Node (aucune dépendance externe)
├── index.html                 # Dashboard principal (frontend)
├── sla.html                   # Page SLA (frontend)
├── data/
│   ├── hashrate.json          # Snapshots workers (7j glissants)
│   ├── alert-state.json       # État cooldowns + watchlist (backend)
│   ├── worker-issues.json     # Anomalies actives (pour dashboard)
│   ├── watchlist.json         # Still Degraded (pour dashboard)
│   ├── offline-status.json    # Workers offline + dead (pour dashboard)
│   ├── history.json           # Historique compte (35 jours)
│   ├── sla-daily.json         # Agrégats SLA journaliers (30 jours)
│   ├── worker-hosts.json      # Mapping worker → lien hôte (statique)
│   ├── ghost-workers.json     # Registre workers Dead disparus de l'API (90 jours)
│   └── no-group.json          # Workers sans groupe (temps réel)
└── .github/
    └── workflows/
        └── hashrate.yml       # Workflow GitHub Actions
```

---

## 4. Backend — hashrate-collector.js

### 4.1 Déclenchement

Le workflow GitHub Actions est déclenché par un événement `workflow_dispatch` (appel HTTP POST à l'API GitHub). cron-job.org envoie cette requête toutes les 30 minutes avec un token d'authentification GitHub (secret `CRON_TOKEN`).

### 4.2 Séquence d'exécution

```
1. git pull --rebase origin main          # Synchronisation avec les commits data récents
2. Pour chaque compte (cmine, everminer) :
   a. fetchWorkers()                      # Appel f2pool API v2 → liste workers
   b. fetchATO()                          # Appel f2pool web → ATO actuel
   c. Mise à jour hashrate.json           # Snapshot stocké par worker
3. Détection chutes de groupe             # Alertes Telegram + email si seuil dépassé
4. Détection anomalies worker             # Alertes Telegram + email si seuil dépassé
5. Mise à jour ghost-workers.json         # Détection fantômes, suppression résolus, expiration 90j
6. Détection workers No Group             # Alertes Telegram + email si cooldown OK
7. Mise à jour offline-status.json        # Workers offline + workers Dead (fantômes)
8. Check watchlist (recovery + expiry)   # Mise à jour watchlist.json
9. Rapport matin (si 05:00 UTC)          # Email récapitulatif
10. Calcul SLA daily (si 05:00 UTC)      # Mise à jour sla-daily.json
11. git add data/*.json
    git commit -m "data: snapshot {timestamp}"
    git push origin main
```

### 4.3 API f2pool

**Workers** (liste temps-réel) :
- URL : `POST https://api.f2pool.com/v2/hash_rate/worker/list`
- Auth : header `F2P-API-SECRET: {token}`
- Body : `{ "mining_user_name": "{user}", "currency": "bitcoin" }`
- Réponse : tableau `workers` avec `hash_rate_info.h1_hash_rate`, `hash_rate_info.status`, `hash_rate_info.last_share_at`, etc.
- **Important** : f2pool ne retourne que les workers Online et Offline dans cette réponse. Les workers Dead (inactifs > 24h) sont retirés de la réponse API après ~24h.

**ATO** (hashrate distribué aux clients — _Actual Transfer Out_) :
- URL : `https://www.f2pool.com/mining-user/{readKey}?user_name={user}&...&action=load_by_duration&duration=1`
- Endpoint web non documenté, découvert par inspection réseau navigateur
- Retourne `transfer_actually_hashrate.values` (tableau de points [timestamp, TH/s])
- Dernier point converti en H/s pour cohérence avec les données workers

**Statuts worker** :
- `status = 0` → ONLINE
- `status = 1` → OFFLINE (contre-intuitif)

### 4.4 Fichiers de données — structure et rétention

#### hashrate.json

```json
{
  "last_updated": "2026-07-05T20:30:54Z",
  "workers": {
    "cmine.s21xp001": [
      { "ts": "2026-07-05T20:00:00Z", "hr": 102400000000000 },
      ...
    ]
  },
  "accounts": {
    "cmine": [
      { "ts": "2026-07-05T20:00:00Z", "ato": 512000000000000 },
      ...
    ]
  }
}
```

- Rétention worker : 337 snapshots max (~7 jours)
- Les unités internes sont en **H/s** (pas TH/s) pour la précision des calculs

#### alert-state.json

Fichier plat JSON. Plusieurs types de clés :

```json
{
  "cmine.P1": "2026-06-30T19:00:58Z",           // cooldown groupe
  "w.cmine.s21xp002": "2026-06-30T22:01Z",      // cooldown worker
  "morning_2026-07-05": "2026-07-05T05:00Z",    // anti-doublon matin
  "nogroup.cmine.02011366de33": "2026-07-06T08:00Z", // cooldown No Group
  "watchlist": {
    "w.cmine.s21xp002": {
      "type": "worker_anomaly",
      "baselineHR": 513200000000000,
      "currentHR": 28948919479755,
      "worker": "s21xp002",
      "account": "cmine",
      "groupId": "P1",
      "anomalyType": "level_drop",
      "detectedAt": "2026-06-30T19:00:00Z"
    }
  }
}
```

#### watchlist.json

Fichier produit par le backend pour le dashboard (reconstruit à chaque run) :

```json
{
  "last_updated": "2026-07-05T20:30:54Z",
  "entries": [
    {
      "key": "w.cmine.s21xp002",
      "type": "worker_anomaly",
      "provider": "Altos",
      "group_id": "P1",
      "account": "cmine",
      "account_name": "Cyberian Mine",
      "worker": "s21xp002",
      "anomaly_type": "level_drop",
      "baseline_hr": 513200000000000,
      "current_hr": 28948919479755,
      "drop_pct": 94,
      "detected_at": "2026-06-30T19:00:00Z",
      "duration_h": 121.5
    }
  ]
}
```

#### worker-issues.json

Anomalies actives au dernier run. Clé = `{account}.{worker}` :

```json
{
  "issues": {
    "cmine.s21xp002": {
      "type": "level_drop",
      "worker": "s21xp002",
      "account_name": "Cyberian Mine",
      "group_id": "P1",
      "provider": "Altos",
      "drop_pct": 94,
      "current_avg_ths": "28.9",
      "baseline_avg_ths": "513.2"
    }
  }
}
```

#### offline-status.json

Workers offline et dead au dernier run. Inclut désormais les workers fantômes (Dead absents de l'API) :

```json
{
  "last_updated": "2026-07-06T08:00:00Z",
  "offline": {
    "cmine.s21xp005": {
      "account": "cmine",
      "account_name": "Cyberian Mine",
      "name": "s21xp005",
      "group_id": "P1",
      "provider": "Altos",
      "dead": false,
      "category": "offline",
      "last_share": "2026-07-06T07:15:00Z"
    },
    "cmine.c21xp001": {
      "account": "cmine",
      "account_name": "Cyberian Mine",
      "name": "c21xp001",
      "group_id": "U3",
      "provider": "ValueHash (NY)",
      "dead": true,
      "category": "dead_recent",
      "last_share": "2026-07-02T18:58:00Z"
    }
  }
}
```

Champs des workers Dead (fantômes) :
- `dead: true` — marqueur fantôme
- `category` — `offline` / `dead_recent` / `dead_mid` / `dead_old` (calculé à chaque run)
- `last_share` — ISO string du dernier snapshot connu (utilisé par `categoryOf()` dans le dashboard)

#### ghost-workers.json

Registre persistant des workers Dead disparus de l'API f2pool. Survit à la fenêtre 7j de `hashrate.json` :

```json
{
  "last_updated": "2026-07-06T08:00:00Z",
  "ghosts": {
    "cmine.c21xp001": {
      "account": "cmine",
      "account_name": "Cyberian Mine",
      "name": "c21xp001",
      "groupId": "U3",
      "provider": "ValueHash (NY)",
      "lastSnapIso": "2026-07-02T18:58:00Z",
      "detectedAt": "2026-07-03T10:30:00Z"
    }
  }
}
```

Cycle de vie à chaque run :
1. `findGhostWorkers(hrData, accountUser, currentWorkerNames, now)` : compare `hashrate.json` vs API → retourne les workers absents avec un snapshot < 7 jours
2. Nouveaux fantômes → ajoutés au registre avec `lastSnapIso` et `detectedAt`
3. Workers revenus dans l'API → supprimés du registre (résolus)
4. Workers > 90 jours → expirés et supprimés

`getGhostsFromStore(ghostData, accountUser, now)` : lit le registre, recalcule la catégorie, filtre `dead_old`.

#### no-group.json

Workers retournés par l'API mais ne correspondant à aucun groupe connu :

```json
{
  "last_updated": "2026-07-06T08:00:00Z",
  "workers": [
    {
      "account": "cmine",
      "account_name": "Cyberian Mine",
      "name": "unknownworker01",
      "hr3h": 98000000000000,
      "host": "?"
    }
  ]
}
```

Mis à jour à chaque run. Vide si aucun worker No Group.

#### sla-daily.json

```json
{
  "days": [
    {
      "date": "2026-07-04",
      "continuity": { "cmine::P1": 0.94, "cmine::U3": 0.87, ... },
      "dc_combined": { "cmine::P1": 0.91, ... },
      "account_perf": { "cmine": 0.96, "everminer": 0.98 }
    },
    ...
  ]
}
```

### 4.5 Workflow GitHub Actions — hashrate.yml

```yaml
name: Hashrate Collector
on:
  workflow_dispatch:
  schedule:
    - cron: '*/30 * * * *'   # Fallback si cron-job.org indisponible

jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - name: Pull latest data
        run: git pull --rebase --autostash origin main
      - name: Run collector
        run: node hashrate-collector.js
        env:
          F2POOL_TOKEN_CMINE:          ${{ secrets.F2POOL_TOKEN_CMINE }}
          F2POOL_TOKEN_EVERMINER:      ${{ secrets.F2POOL_TOKEN_EVERMINER }}
          RESEND_API_KEY:              ${{ secrets.RESEND_API_KEY }}
          ALERT_EMAIL:                 ${{ secrets.ALERT_EMAIL }}
          TELEGRAM_BOT_TOKEN:          ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID:            ${{ secrets.TELEGRAM_CHAT_ID }}
          TELEGRAM_CHAT_ID_CMINE:      ${{ secrets.TELEGRAM_CHAT_ID_CMINE }}
          TELEGRAM_CHAT_ID_EVERMINER:  ${{ secrets.TELEGRAM_CHAT_ID_EVERMINER }}
          TELEGRAM_CHAT_ID_PARAGUAY:   ${{ secrets.TELEGRAM_CHAT_ID_PARAGUAY }}
          TELEGRAM_CHAT_ID_MINTO:      ${{ secrets.TELEGRAM_CHAT_ID_MINTO }}
      - name: Commit & push data
        run: |
          git config user.name  "capone-watcher[bot]"
          git config user.email "bot@capone.market"
          git add data/hashrate.json data/worker-issues.json \
                  data/alert-state.json data/offline-status.json \
                  data/history.json data/sla-daily.json \
                  data/watchlist.json data/ghost-workers.json \
                  data/no-group.json 2>/dev/null || true
          git diff --cached --quiet || git commit -m "data: snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ)"
          git push origin main
```

### 4.6 Secrets GitHub

| Secret | Usage |
|--------|-------|
| `F2POOL_TOKEN_CMINE` | Auth f2pool API compte cmine |
| `F2POOL_TOKEN_EVERMINER` | Auth f2pool API compte everminer |
| `RESEND_API_KEY` | Auth Resend pour les emails |
| `ALERT_EMAIL` | Email destinataire rapport matin + alertes No Group |
| `ALERT_FROM` | Adresse expéditeur email (noreply@capone.market) |
| `TELEGRAM_BOT_TOKEN` | Token du bot Telegram |
| `TELEGRAM_CHAT_ID` | Canal Telegram général (alertes No Group) |
| `TELEGRAM_CHAT_ID_CMINE` | Canal Telegram Cyberian Mine |
| `TELEGRAM_CHAT_ID_EVERMINER` | Canal Telegram Everminer |
| `TELEGRAM_CHAT_ID_PARAGUAY` | Canal Telegram Paraguay (duplication P1) |
| `TELEGRAM_CHAT_ID_MINTO` | Canal Telegram Minto (duplication R3) |

---

## 5. Frontend — index.html

### 5.1 Architecture générale

Le dashboard est un **fichier HTML unique** (single-file). CSS et JavaScript sont inclus inline dans `<style>` et `<script>`. Aucun framework, aucun bundler, aucune dépendance npm.

**Déploiement** : le webhook GitHub/Vercel étant instable, le déploiement se fait toujours avec `npx vercel --prod` depuis le terminal local (voir § 7.2).

### 5.2 Chargement des données

Au chargement de la page, un `Promise.all()` fetch les fichiers JSON en parallèle :

```javascript
const [hrRes, issRes, wlRes, offRes, histRes, slaRes, hostsRes, ngRes] = await Promise.all([
  fetch(RAW + 'data/hashrate.json?t='      + Date.now()),
  fetch(RAW + 'data/worker-issues.json?t=' + Date.now()),
  fetch(RAW + 'data/watchlist.json?t='     + Date.now()).catch(() => null),
  fetch(RAW + 'data/offline-status.json?t='+ Date.now()).catch(() => null),
  fetch(RAW + 'data/history.json?t='       + Date.now()).catch(() => null),
  fetch(RAW + 'data/sla-daily.json?t='     + Date.now()).catch(() => null),
  fetch(RAW + 'data/worker-hosts.json?t='  + Date.now()).catch(() => null),
  fetch(RAW + 'data/no-group.json?t='      + Date.now()).catch(() => null),
]);
```

Les fichiers optionnels (`.catch(() => null)`) ne bloquent pas le rendu en cas d'erreur.

### 5.3 État global

Variables globales initialisées après le fetch :

| Variable | Source | Contenu |
|----------|--------|---------|
| `_allData` | hashrate.json | Tous les snapshots workers |
| `_workerIssues` | worker-issues.json | Anomalies actives |
| `_watchlist` | watchlist.json | Entrées Still Degraded |
| `_offlineStatus` | offline-status.json | Workers offline + Dead |
| `_history` | history.json | Historique compte |
| `_slaDaily` | sla-daily.json | SLA 30 jours |
| `_workerHosts` | worker-hosts.json | Liens hôtes |
| `_noGroup` | no-group.json | Workers sans groupe |
| `_deadIssues` | calculé en mémoire | Workers dead (tracker) |
| `_dcFilter` | UI | Set() de groupes actifs (filtre) |
| `_onlineSearch` | UI | Chaîne recherche table Online |

### 5.4 Rendu des tables

Le rendu est entièrement basé sur `innerHTML` avec des template literals JavaScript. Aucun DOM manipulation individuel.

**Flux de rendu `renderOnlineTable()`** :

```
1. Construire _deadIssues depuis _offlineStatus (workers dead/fantômes injectés depuis offline-status.json)
2. Calculer wlEntries (entrées watchlist filtrées, duration_h >= 1)
3. Calculer wlWorkerKeys (Set des workers en watchlist → exclusion table normale)
4. Filtrer ngWorkers depuis _noGroup (No Group, filtre DC/search appliqué)
5. Filtrer workers : avg3h > 1 TH/s, pas dans wlWorkerKeys, pas dans _deadIssues, filtres DC/search
6. Générer ngRows (HTML section No Group — bandeau violet)
7. Générer wlRows (HTML section Still Degraded — bandeau rouge)
8. Générer workerRows (HTML table normale)
9. tbody = ngRows + wlRows + workerRows (ordre garanti)
```

**Injection des workers Dead dans `_deadIssues`** :
```javascript
if (_offlineStatus) {
  for (const [key, w] of Object.entries(_offlineStatus.offline || {})) {
    if (w.dead && !_deadIssues[key]) {
      _deadIssues[key] = {
        account: w.account, account_name: w.account_name,
        name: w.name, group_id: w.group_id, provider: w.provider,
        host: '—',
        last_share: w.last_share || null,  // ISO string → categoryOf() calcule la bonne catégorie
        category: w.category || 'dead_recent',
      };
    }
  }
}
```

**Réplication des règles de groupe (GROUPS_RULES)** : le frontend duplique les règles de `groups.js` pour classer les workers côté client. Toujours maintenir la cohérence entre les deux fichiers.

```javascript
const GROUPS_RULES = [
  { id:'E1',    provider:'BitCluster',    test: n => /^\d{1,4}$/.test(n) },
  { id:'U1+U2', provider:'Dataprana',     test: n => /^(ngs|yna|pie|olt|dga)/i.test(n)
                                                  || /^[0-9a-f]{12}$/i.test(n)
                                                  || /^\d{9,}$/.test(n) },
  // ... autres groupes
];
```

### 5.5 Tracker "Workers requiring attention" — CSS

Les sections du tracker utilisent `table-layout: fixed` pour aligner les colonnes entre les tableaux indépendants :

```css
.dead-section .issues-table { table-layout: fixed; }
.dead-section .issues-table th:nth-child(1) { width: 22%; }
.dead-section .issues-table th:nth-child(2) { width: 15%; }
.dead-section .issues-table th:nth-child(3) { width: 25%; }
.dead-section .issues-table th:nth-child(4) { width: 13%; }
.dead-section .issues-table th:nth-child(5) { width: 25%; }
```

### 5.6 Sparklines

Les sparklines sont des SVG inline générés dynamiquement. Pour éviter le dépassement de pile sur de grands tableaux, l'algorithme utilise une boucle (pas `Math.max(...largeArray)`) :

```javascript
let maxHr = 1;
for (const s of snaps) { if (s.hr > maxHr) maxHr = s.hr; }
```

### 5.7 Variables CSS et thème

Le dashboard utilise des variables CSS pour tout le système de couleurs :

```css
:root {
  --bg:              #1a1a14;
  --surface:         #22221a;
  --border:          #2e2e24;
  --text:            #e8e6dc;
  --text-muted:      #8a8878;
  --accent-red:      #c0392b;
  --accent-red-dim:  rgba(192,57,43,0.08);
  --accent-orange:   #e67e22;
  --accent-green:    #27ae60;
  --primary:         #D97757;
  ...
}
```

Thème sombre uniquement, pas de mode clair.

### 5.8 Modale worker

La modale est un overlay full-screen généré dans le DOM au clic. Elle est détruite à la fermeture (pas de réutilisation DOM).

### 5.9 Filtres et interactions

- **Filtre DC** : clic sur un chip → toggle dans `_dcFilter` (Set) → re-render des tables
- **Recherche** : événement `input` → re-render immédiat (données JSON déjà en mémoire)
- **Tri** : tables triées par hashrate décroissant (pas de tri interactif)

---

## 6. Frontend — sla.html

Fichier HTML unique indépendant, même structure que index.html.

Fetch uniquement `data/sla-daily.json` et `data/hashrate.json`.

Calculs effectués **côté client** : DC share, continuity, throughput, combined, breach. Les sparklines 30 jours sont générées en SVG.

---

## 7. Déploiement

### 7.1 Vercel

- Projet connecté au dépôt GitHub (`sebwebmail-arch/btc-miner-monitor`)
- Branche de production : `main`
- Build command : aucun (fichiers statiques)
- Output directory : racine du dépôt
- Domaine : `watcher.capone.market` (DNS configuré chez le registrar)

**Important** : le webhook GitHub/Vercel est instable sur ce projet. `git push` seul ne déclenche pas toujours un déploiement. Commande de déploiement fiable :

```bash
npx vercel --prod
```

### 7.2 Mise à jour du frontend ou backend

```bash
cd "ERP Project/btc-miner-monitor"
git add index.html sla.html groups.js hashrate-collector.js
git commit -m "feat: description du changement"
git pull --rebase origin main    # Récupère les commits data de GitHub Actions
git push origin main
npx vercel --prod
```

**Si `git push` est rejeté** (GitHub Actions a commité des fichiers data entre-temps) :
```bash
git pull --rebase origin main && git push origin main
```

### 7.3 Mise à jour du backend uniquement

Le backend est exécuté par GitHub Actions : pousser `hashrate-collector.js` sur `main` suffit — le prochain run (dans 0 à 30 min) utilisera la nouvelle version.

---

## 8. Monitoring et limites

### 8.1 Limites gratuites

| Service | Limite gratuite | Usage actuel |
|---------|----------------|-------------|
| GitHub Actions | 2000 min/mois | ~1440 runs/mois × ~1 min = ~1440 min |
| Vercel | 100 GB bande passante | Marginal (fichiers JSON statiques) |
| Resend | 100 emails/jour | ~30/mois (rapports matin) |
| cron-job.org | Gratuit | 1 job toutes les 30 min |

### 8.2 Points d'attention opérationnels

- **Conflits git** : le script GitHub Actions commite des fichiers data toutes les 30 min. Un `git push` local peut créer des conflits. Toujours faire `git pull --rebase origin main` avant de pusher.

- **Dépôt public** : les fichiers `data/*.json` sont publics. Ne jamais y stocker de données sensibles. `ghost-workers.json` et `no-group.json` sont inclus dans ce périmètre.

- **Pas de retry automatique** : si un run échoue, le prochain run reprend dans 30 min.

- **Atomicité** : si le script plante en cours, un état partiel peut exister jusqu'au prochain run.

- **Top-quartile baseline** : uniquement actif si le worker a ≥ 96 snapshots (2 jours). Les workers récemment ajoutés ou remis en service n'en bénéficient pas.

- **Fenêtre `findGhostWorkers`** : détection des fantômes limitée aux workers ayant un snapshot dans les 7 derniers jours de `hashrate.json`. Au-delà, la persistance est assurée par `ghost-workers.json` jusqu'à 90 jours.

---

*Document de référence — capone watcher — juillet 2026*
