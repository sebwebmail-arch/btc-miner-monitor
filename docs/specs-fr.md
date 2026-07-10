# Capone Watcher — Spécifications Techniques

**Version** : 1.0 — Juillet 2026  
**Dashboard** : https://watcher.capone.market  
**Dépôt** : https://github.com/sebwebmail-arch/btc-miner-monitor

---

## 1. Objectif

Capone Watcher est un système de surveillance en temps réel pour les opérations de minage Bitcoin sur f2pool. Il suit deux comptes de minage — **Cyberian Mine** (`cmine`) et **Everminer** (`everminer`) — et fournit une visibilité en direct sur l'état des workers, la santé du hashrate par datacenter, et des alertes automatiques en cas de problème.

---

## 2. Architecture

```
API f2pool (toutes les 30 min)
       │
       ▼
GitHub Actions (hashrate-collector.js)
       │  ├─ écrit data/*.json → dépôt GitHub
       │  ├─ envoie alertes Telegram (chutes de groupe)
       │  └─ envoie alertes Email (chutes de groupe)
       │
GitHub Actions (monitor.js, quotidien 07:00 Paris)
       │  ├─ écrit data/history.json
       │  └─ envoie rapport email quotidien
       │
       ▼
Vercel (hébergement statique)
       │
       ▼
https://watcher.capone.market (index.html lit les data/*.json)
```

**Principe clé** : il n'y a pas de runtime côté serveur. Tous les calculs se font dans GitHub Actions ; le dashboard est une page HTML statique qui lit des fichiers JSON pré-calculés committé dans le dépôt.

---

## 3. Infrastructure

| Composant | Service | Détails |
|-----------|---------|---------|
| Hébergement dashboard | Vercel | Tier gratuit, déploiement auto sur push vers `main` |
| Scheduling | GitHub Actions | Cron via `cron-job.org` (déclencheur externe via `workflow_dispatch`) |
| Email | Resend | Depuis `noreply@capone.market` |
| Alertes | Bot Telegram | `Capone Watcher bot` |
| DNS | Cloudflare | Nameservers pour `capone.market` |
| Registrar domaine | Hostinger | Nameservers délégués à Cloudflare |
| Pool source | f2pool | API sur `api.f2pool.com/v2/hash_rate/worker/list` |

---

## 4. Pipeline de données

### 4.1 Collecteur de hashrate (`hashrate-collector.js`) — toutes les 30 minutes

Déclenché par le workflow GitHub Actions `hashrate.yml` :

1. Récupère tous les workers depuis l'API f2pool pour les deux comptes
2. Ajoute un nouveau snapshot à la série temporelle de chaque worker dans `data/hashrate.json` (fenêtre glissante 7 jours, max 337 snapshots)
3. Calcule le hashrate courant du groupe (somme des h1_hash_rate de tous les workers du groupe)
4. Compare avec le hashrate de référence (moyenne des 3 derniers snapshots stockés = fenêtre ~1h30)
5. Si chute > 30% et cooldown (4h) non actif → déclenche alerte Telegram + Email
6. Détecte les anomalies par worker (chute prolongée ou volatilité) → met à jour `data/worker-issues.json`
7. Exécute la logique du rapport matin à 05:00 UTC (email quotidien)
8. Committe tous les fichiers de données modifiés dans le dépôt

### 4.2 Rapport matin (`monitor.js`) — quotidien à 07:00 Paris (05:00 UTC)

1. Lit la liste des workers courants depuis f2pool
2. Classe les workers en Online / Offline (<24h) / Dead (>24h)
3. Envoie un email si des workers offline ou dead sont détectés
4. Maintient `data/history.json` (archive glissante 30 jours)

### 4.3 ATO (Actual Transfer Out)

Chaque snapshot de hashrate récupère également la valeur ATO depuis l'API web publique de f2pool. L'ATO est le hashrate effectivement engagé vers le pool. Quand Total (somme des workers) > ATO, l'écart est interne au datacenter (moins urgent). Quand Total < ATO, les livrables clients sont impactés (priorité plus haute).

---

## 5. Groupes de datacenters

Les workers sont assignés à des groupes selon leur nom (défini dans `groups.js`) :

| ID Groupe | Fournisseur | Compte(s) | Motif worker |
|-----------|-------------|-----------|--------------|
| R1 | IZTM | cmine | `^r` |
| R3 | Minto | cmine | `^k2lx` |
| E1 | BitCluster | cmine | `^\d{1,4}$` (1–4 chiffres) |
| E2 | AmityAge | cmine + everminer | `^aa` |
| U1+U2 | Dataprana | everminer | `^(ngs\|yna\|pie\|olt\|dga)`, format MAC, ou numérique long |
| U3 | ValueHash (NY) | cmine + everminer | `^(c21\|e21)` |
| P1 | Altos | everminer | `^s21` |
| F1 | Terahash | cmine | Liste explicite de 14 noms de machines |
| OM | Open Mine | — | `^(omx\|openfall)` |
| No Group | — | — | Tout le reste — exclu de tous les rapports |

**Note** : E1 (BitCluster) est exclu des alertes temps-réel car son hashrate fluctue normalement au cours de la journée.

---

## 6. Système d'alertes

### 6.1 Alerte groupe temps-réel (Telegram + Email)

| Paramètre | Valeur |
|-----------|--------|
| Déclencheur | Hashrate total du groupe chute > 30% vs. référence 1h30 |
| Cooldown | 4 heures par groupe |
| Fenêtre de référence | 3 derniers snapshots (~1h30) |
| Routage Telegram | Par compte : `TELEGRAM_CHAT_ID_CMINE`, `TELEGRAM_CHAT_ID_EVERMINER` |
| Canaux dupliqués | P1 (Altos) → aussi envoyé à `TELEGRAM_CHAT_ID_PARAGUAY` ; R3 (Minto) → aussi envoyé à `TELEGRAM_CHAT_ID_MINTO` |
| Email | Email par compte + adresse d'alerte principale |

Exemple de format d'alerte :
```
⚠️ Hashrate Alert — capone watcher
📍 IZTM (R1) — Cyberian Mine
📉 Provider hashrate dropped by 48%
Before (avg 1h30): 29189.5 TH/s
Now: 15146.7 TH/s
🕐 05:30 UTC — 07:30 GMT+2
📊 https://watcher.capone.market
```

### 6.2 Notification de reprise

Quand un groupe récupère ≥75% de son hashrate de référence après une alerte, un message de reprise est envoyé sur le même canal Telegram.

### 6.3 Détection d'anomalies par worker (Dashboard uniquement)

Les anomalies sur workers individuels sont détectées et affichées dans le dashboard mais ne déclenchent **pas** d'alertes Telegram ou email (trop de bruit). Les workers sont signalés comme :

- **level_drop** : moyenne 3h courante < 60% de la baseline 12h
- **volatile** : coefficient de variation > 55% ou taux de zéro > 35%

Seuils :
- Fenêtre courante : 6 snapshots (3h)
- Baseline : 24 snapshots (12h), minimum 12 requis
- Baseline minimale pour être analysé : 5 TH/s

### 6.4 Rapport email quotidien (07:00 Paris)

Envoyé si un worker est offline ou dead, ou si des anomalies de hashrate sont détectées.  
Format sujet : `[ALERT] 3 offline · 2 anomalies — Mardi 1 Juillet 2026`  
Couleur entête : rouge si workers offline présents, orange si anomalies uniquement.

---

## 7. Fichiers de données

| Fichier | Mis à jour | Description |
|---------|------------|-------------|
| `data/hashrate.json` | Toutes les 30 min | Snapshots de hashrate par worker, fenêtre 7 jours |
| `data/history.json` | Quotidien | Snapshots de statut workers + current_issues |
| `data/alert-state.json` | Toutes les 30 min | Timestamps cooldown alertes groupe + watchlist workers |
| `data/worker-issues.json` | Toutes les 30 min | Anomalies hashrate courantes (level_drop / volatile) |
| `data/offline-status.json` | Toutes les 30 min | Carte des workers offline courants |
| `data/worker-hosts.json` | Toutes les 30 min | Mapping worker → IP/host |
| `data/sla-daily.json` | Quotidien | Métriques uptime par groupe |
| `data/ghost-workers.json` | Toutes les 30 min | Workers dead >24h, conservés 90 jours |
| `data/watchlist.json` | Toutes les 30 min | Workers avec anomalies prolongées, expire après 14 jours |

---

## 8. Dashboard (index.html)

Application JavaScript vanilla mono-page. Pas de framework. Toutes les données chargées depuis les fichiers JSON servis par Vercel.

### Sections

1. **Cartes de santé** — Compteurs Online / Offline <24h / Dead actionnable / Dead archivé
2. **Hashrate par compte** — Onglets cmine/everminer, graphique TH/s agrégé, sélecteur 24h/72h
3. **Datacenters en un coup d'œil** — Grille de cellules par groupe colorées ok/warn/critique
4. **Workers nécessitant attention** — Table offline + dead avec filtres et tri style Excel
5. **Tracker dead + tendance 30 jours** — Historique des workers dead
6. **Workers online** — Tous les workers actifs (avg 3h > 1 TH/s), badges anomalies, triés anomalies en premier

### Modal worker

Cliquer sur un nom de worker ouvre un modal avec la pilule de statut, compte + datacenter, graphique hashrate 24h/72h (SVG), texte de recommandation, et lien direct vers f2pool.

### Commentaires workers

N'importe quel opérateur peut laisser un commentaire sur n'importe quel worker. Les commentaires sont stockés dans le `localStorage` du navigateur (local à l'appareil). Les workers avec commentaires affichent une icône bulle verte (💬) à côté de leur nom.

### Indicateur ATO

Chaque graphique de hashrate montre la ligne ATO. Quand le hashrate total est au-dessus de l'ATO, l'écart est non-urgent. En dessous, c'est signalé comme critique.

---

## 9. Secrets GitHub

| Secret | Description |
|--------|-------------|
| `F2POOL_TOKEN_CMINE` | Clé API f2pool — Cyberian Mine |
| `F2POOL_TOKEN_EVERMINER` | Clé API f2pool — Everminer |
| `RESEND_API_KEY` | Clé API Resend (email) |
| `ALERT_FROM` | Adresse expéditeur (`noreply@capone.market`) |
| `ALERT_EMAIL` | Destinataire alerte par défaut |
| `ALERT_EMAIL_CMINE` | Destinataire alerte pour cmine |
| `ALERT_EMAIL_EVERMINER` | Destinataire alerte pour everminer |
| `TELEGRAM_BOT_TOKEN` | Token bot Telegram (depuis @BotFather) |
| `TELEGRAM_CHAT_ID` | Chat Telegram par défaut (fallback) |
| `TELEGRAM_CHAT_ID_CMINE` | Groupe Telegram alertes cmine |
| `TELEGRAM_CHAT_ID_EVERMINER` | Groupe Telegram alertes everminer |
| `TELEGRAM_CHAT_ID_PARAGUAY` | Groupe Telegram alertes Altos/P1 |
| `TELEGRAM_CHAT_ID_MINTO` | Groupe Telegram alertes Minto/R3 |

---

## 10. API f2pool

```
POST https://api.f2pool.com/v2/hash_rate/worker/list
Header: F2P-API-SECRET: <token>
Body: { "mining_user_name": "cmine", "currency": "bitcoin" }
```

**Important** : le champ `status` dans la réponse API est non fiable. Le statut online/offline d'un worker est toujours dérivé de `last_share_at` (timestamp Unix).

Champs worker utilisés :
- `hash_rate_info.name` — nom du worker
- `hash_rate_info.h1_hash_rate` — hashrate moyen 1h (H/s)
- `hash_rate_info.hash_rate` — fallback si h1 absent
- `last_share_at` — timestamp dernier share
- `host` — IP ou hostname du worker

Liens publics lecture seule :
- cmine : `https://www.f2pool.com/mining-user/dad5e8d0452ce3262084e3afef6003ec?user_name=cmine`
- everminer : `https://www.f2pool.com/mining-user/d87416827c22b5c9aadb86e10535c4e0?user_name=everminer`

---

## 11. Comportements connus et cas limites

- **Préchauffage de la baseline** : la détection d'anomalies nécessite au moins 9h de données avant de pouvoir se déclencher.
- **E1 (BitCluster) exclu** : intentionnellement exclu des alertes temps-réel à cause des cycles normaux de hashrate en journée.
- **Logique métier ATO** : total > ATO = moins urgent (problème interne datacenter) ; total < ATO = impact client = priorité haute.
- **Stockage commentaires workers** : stocké dans `localStorage` du navigateur — non partagé entre appareils ou opérateurs.
- **Champ `status` f2pool** : toujours `0` (online) dans l'API — l'ignorer ; utiliser `last_share_at`.
- **Commits GitHub Actions data** : s'exécutent toutes les 30 minutes. Lors d'un push local, toujours rebaser d'abord pour éviter les conflits.
- **Expiration token bot Telegram** : si le bot cesse d'envoyer, lancer le workflow GitHub Actions "Test Telegram" pour diagnostiquer. Si expiré, régénérer via @BotFather et mettre à jour le secret `TELEGRAM_BOT_TOKEN`.
