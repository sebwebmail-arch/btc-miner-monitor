# Spécification Fonctionnelle — Capone Watcher

**Produit** : watcher.capone.market  
**Version** : juillet 2026  
**Objet** : référence complète des règles métier — dashboard, détection d'anomalies, watchlist, alertes Telegram, emails, page SLA.

---

## 1. Vue d'ensemble

Capone Watcher est un système de surveillance de mineurs Bitcoin (pool f2pool). Il collecte le hashrate de tous les workers toutes les 30 minutes, détecte les anomalies (chutes de hashrate, instabilité, workers hors ligne, workers disparus), et diffuse des alertes via Telegram et email. Un dashboard statique publié sur Vercel permet de visualiser l'état en temps réel.

**Philosophie de base** : le système joue le rôle de filtre pour attraper les workers qui "posent problème". Il ne cherche pas à être plus précis que le pool f2pool lui-même. Un worker déclaré "Online" par f2pool mais à 0 TH/s est techniquement correct ; ce qui compte, c'est que la détection d'anomalie le capture.

**Comptes surveillés** :
- **Cyberian Mine** (`cmine`)
- **Everminer** (`everminer`)

---

## 2. Datacenters et groupes

Chaque worker appartient à un groupe (datacenter) identifié par son nom.

| Groupe | Provider | Règle de nommage |
|--------|----------|-----------------|
| R1 | IZTM | Commence par `r` |
| R3 | Minto | Commence par `k2lx` |
| E1 | BitCluster | Nom purement numérique court (1 à 4 chiffres — ex: `002`, `031`) |
| E2 | AmityAge | Commence par `aa` |
| U1+U2 | Dataprana | Ancien format : commence par `ngs`, `yna`, `pie`, `olt` ou `dga` — Nouveau format (juillet 2026) : adresse MAC 12 caractères hex (ex: `02011366de33`) ou numérique long ≥ 9 chiffres (ex: `23181238824`) |
| U3 | ValueHash (NY) | Commence par `c21` (cmine) ou `e21` (everminer) |
| P1 | Altos | Commence par `s21` |
| F1 | Terahash | Commence par `18x` |
| OM | Open Mine | Commence par `omx` ou `openfall` |

**Dataprana — note juillet 2026** : Dataprana a migré de noms par numéro de série (regroupant plusieurs machines) vers des adresses MAC (1 worker = 1 machine). Cette granularité améliore significativement la précision de détection des anomalies. Le groupe `U1+U2` couvre deux sites physiques : U1 = South Carolina, U2 = Texas.

**No Group** : tout worker ne correspondant à aucune règle ci-dessus est classé `No Group / Unknown`. C'est un signal d'action immédiate : le worker n'est pas surveillé et doit être assigné à un groupe sur f2pool puis référencé dans `groups.js`.

---

## 3. Dashboard (watcher.capone.market)

### 3.1 Chargement des données

À chaque chargement de page, le dashboard récupère en parallèle les fichiers JSON suivants depuis GitHub (raw.githubusercontent.com) avec un timestamp `?t=Date.now()` pour invalider le cache navigateur :

| Fichier | Contenu |
|---------|---------|
| `data/hashrate.json` | Snapshots workers (7 jours glissants) |
| `data/worker-issues.json` | Anomalies actives (dernière détection) |
| `data/watchlist.json` | Workers/groupes en surveillance prolongée |
| `data/offline-status.json` | Workers offline et dead (temps réel) |
| `data/history.json` | Historique compte-niveau (35 jours) |
| `data/sla-daily.json` | Agrégats SLA journaliers (30 jours) |
| `data/worker-hosts.json` | Mapping worker → lien hôte |
| `data/no-group.json` | Workers sans groupe (temps réel) |

### 3.2 Cartes d'état (header)

Trois métriques sont affichées en haut du dashboard :

- **Workers offline** : nombre de workers dont le statut f2pool est OFFLINE (code 1) ou dont le dernier share remonte à plus de 60 minutes.
- **Hashrate actif** : somme du hashrate 1h (`h1_hash_rate`) de tous les workers actifs, en TH/s.
- **Workers actifs** : nombre de workers avec un hashrate 3h moyen > 1 TH/s.

### 3.3 Comparaison ATO

Le dashboard affiche le hashrate total (somme workers) vs. l'**ATO** (_Actual Transfer Out_ — hashrate distribué aux clients). La couleur indique le sens de l'écart :

- **Total > ATO** : le pool capte plus que ce que les clients reçoivent → moins urgent.
- **Total < ATO** : le pool produit moins que ce que les clients devraient recevoir → impact direct sur la distribution → prioritaire.

### 3.4 Graphique hashrate (7 jours)

Graphique courbe basé sur `history.json`, affichant l'évolution du hashrate agrégé (tous comptes confondus) sur les 7 derniers jours.

### 3.5 Filtres

- **Filtre datacenter** : chips cliquables (un par groupe). Activer un filtre masque tous les workers n'appartenant pas au groupe sélectionné. Plusieurs groupes peuvent être actifs simultanément.
- **Recherche** : champ texte filtrant les workers par nom (correspondance partielle, insensible à la casse).

### 3.6 Table "Online Workers"

Affiche les workers dont le hashrate 3h moyen est > 1 TH/s, **sauf** ceux déjà présents dans les sections spéciales ci-dessous.

Colonnes : Nom, Compte, Groupe/Provider, Badge anomalie (si applicable), Hashrate actuel (TH/s), Hashrate moyen 3h (TH/s), Sparkline 6h.

**Section "No Group"** (bandeau violet — en tête de table, si applicable) :
- Affiche les workers retournés par l'API f2pool mais ne correspondant à aucun groupe connu.
- Fond violet, label "🏷️ No Group", note "workers sans groupe — assigner sur f2pool".
- Action requise de l'opérateur : assigner sur f2pool et mettre à jour `groups.js`.

**Section "Still Degraded"** (bandeau rouge — après No Group, si applicable) :
- Affiche les entrées de `watchlist.json` dont `duration_h >= 1`.
- Les workers dans cette section sont **exclus** du reste de la table Online Workers (pas de doublon).
- Les entrées avec `duration_h < 1` (drop détecté depuis moins d'une heure) restent dans la table normale pour ce premier run, puis basculent en Still Degraded au run suivant si non rétablis.
- Fond rouge, label "⚠ Still degraded", note "not yet recovered to 75% of baseline".

### 3.7 Tracker "Workers requiring attention"

Section dédiée aux workers offline, dead et archivés. Les workers listés ici sont **exclus** de la table Online Workers.

Les workers y sont répartis en 3 buckets selon l'âge du dernier share :

| Bucket | Durée | Couleur | Instruction |
|--------|-------|---------|-------------|
| < 24 hours | Offline récent | Jaune | Vérifier immédiatement |
| 1–7 days | Dead récent | Orange | Surveiller quotidiennement |
| 8–90 days | Dead tardif | Rouge | Contacter le provider |
| > 90 days | Archivé | Gris | Probablement perdu — archivé |

**Source des données** :
- Workers retournés par l'API f2pool mais avec `last_share > 60 min` → catégorie `< 24h` ou `1-7 days` selon l'âge.
- Workers **fantômes** (Dead — absents de l'API depuis > 24h) → injectés depuis `ghost-workers.json` (voir § 4.5). Leur catégorie est calculée à partir de la date de leur dernier snapshot connu.

Les colonnes du tracker sont alignées de manière fixe entre tous les buckets : Worker, Account, Datacenter, Status, Last Share (UTC).

### 3.8 Modale worker

Accessible en cliquant sur un worker dans les tables Online ou Still Degraded.

Contenu :
- Nom, compte, groupe/provider
- **Status pill** : Online (vert) ou Offline (rouge) selon `offline-status.json`
- **Badge Watchlist** (si worker en watchlist) : badge rouge "−X% · durée" avec valeurs au moment de la détection initiale
- **Badge Anomalie live** (si worker en watchlist) : badge secondaire indiquant la détection courante
- Sparkline 12h et graphique courbe hashrate

---

## 4. Détection des anomalies

Le script `hashrate-collector.js` s'exécute toutes les 30 minutes et effectue plusieurs types de détection.

### 4.1 Chute de groupe

**Déclencheur** : le hashrate actuel d'un groupe chute de plus de 30% par rapport à sa référence.

**Calcul** :
- Hashrate actuel = somme des `h1_hash_rate` de tous les workers du groupe (API temps-réel)
- Référence = moyenne des 3 derniers snapshots stockés, sommée sur le groupe (~1h30)
- Condition : `current < reference × (1 − 0.30)`

**Cooldown** : 4h par groupe. **Groupes exclus** : `E1` (BitCluster — yoyo normal).

**Routage** : canal Telegram du compte + duplications P1→Paraguay, R3→Minto + email compte.

**Watchlist** : si alerte envoyée → groupe ajouté à la watchlist.

### 4.2 Anomalie worker — Level Drop

**Déclencheur** : hashrate moyen 3h < 60% de la baseline 12h (chute > 40%).

**Fenêtres** : courante = 6 derniers snapshots (~3h) ; baseline = snapshots 7 à 30 (~3h30–15h en arrière).

**Override top-quartile** : si le worker a ≥ 96 snapshots et que le top 25% de l'historique dépasse 1.5× la baseline rolling, la baseline top-quartile est utilisée à la place.

**Cooldown** : 8h. **Groupes exclus** : `E1`. **Watchlist** : entrée créée si alerte envoyée.

### 4.3 Anomalie worker — Volatile / Instable

**Déclencheur** (l'un ou l'autre) :
1. Coefficient de variation `stddev / mean > 55%`
2. Taux de snapshots à zéro (< 5 TH/s) > 35%

**Cooldown**, **exclusions**, **watchlist** : identiques au Level Drop (§ 4.2).

### 4.4 Worker offline

Un worker est "offline" si son dernier share remonte à plus de 60 minutes **ou** si son statut f2pool est OFFLINE (code `1`). Cette information est utilisée dans le rapport matin et le tracker.

Un worker est "dead" selon f2pool s'il est inactif depuis > 24h. **Au-delà de ~24h, f2pool retire le worker de sa réponse API** (il passe dans un onglet "Dead" invisible à l'API).

### 4.5 Workers fantômes (Dead — absents de l'API)

**Problème** : f2pool cesse de retourner les workers Dead dans la réponse API après ~24h. Sans mécanisme de compensation, ces workers deviendraient invisibles dans tout le système.

**Solution — détection initiale** : à chaque run, `findGhostWorkers()` compare les clés de `hashrate.json` avec les noms retournés par l'API. Tout worker ayant des snapshots récents (< 7 jours) mais absent de l'API est détecté comme "fantôme".

**Solution — persistance** : les workers fantômes sont enregistrés dans `ghost-workers.json` (registre persistant). Ce registre survit aux purges de `hashrate.json` (fenêtre 7 jours) et permet de suivre les workers Dead **jusqu'à 90 jours**.

**Cycle de vie du registre** (mis à jour à chaque run de 30 min) :
- Nouveaux fantômes détectés via `hashrate.json` → ajoutés au registre avec `lastSnapIso` et `detectedAt`
- Workers revenus dans l'API → supprimés du registre (résolus)
- Workers > 90 jours → expirés et supprimés du registre

**Catégories** (recalculées à chaque run selon l'âge de `lastSnapIso`) :
- < 24h → `offline`
- 1–7 jours → `dead_recent`
- 8–90 jours → `dead_mid`
- > 90 jours → `dead_old` (expirés, non affichés)

**Utilisation** :
- `offline-status.json` : les fantômes sont inclus avec `dead: true`, `category`, `last_share` (utilisés par le dashboard pour les classer dans le bon bucket du tracker)
- Rapport matin : section Workers offline inclut les fantômes avec la mention "Dead (no longer in pool API)"
- Dashboard : les fantômes sont injectés dans `_deadIssues` et apparaissent dans le bon bucket du tracker

### 4.6 Workers No Group

À chaque run, le script détecte tous les workers retournés par l'API f2pool dont le nom ne correspond à aucun groupe connu (résultat `No Group` de `getGroup()`).

**Sauvegarde** : `no-group.json` (mis à jour à chaque run).

**Alertes** (cooldown 12h par worker) :
- Telegram vers `TELEGRAM_CHAT_ID` (canal général)
- Email vers `ALERT_EMAIL`

**Rapport matin** : section dédiée "🏷️ Workers sans groupe — action requise" si des workers No Group existent.

**Dashboard** : bandeau violet en tête de la table Online Workers si `no-group.json` contient des entrées.

---

## 5. Watchlist (Still Degraded)

### 5.1 Principe

La watchlist suit les workers/groupes dégradés après une alerte, jusqu'à leur rétablissement complet.

### 5.2 Création d'une entrée

Une entrée est créée lorsqu'une alerte est envoyée (cooldown OK) pour une chute de groupe, un level drop ou une anomalie volatile.

**Clés** : `w.{account}.{workerName}` (worker) ou `g.{account}.{groupId}` (groupe).

### 5.3 Check de récupération (toutes les 30 min)

- **Condition worker** : `current_hr >= baseline_hr × 0.75`
- **Condition groupe** : `current_group_hr >= baseline_group_hr × 0.75`
- Si remplie → entrée supprimée de la watchlist

### 5.4 Expiration automatique

Entrée supprimée automatiquement après **14 jours** sans rétablissement.

### 5.5 Affichage dans le dashboard

- `duration_h < 1` : non affiché dans "Still Degraded" (reste dans la table normale)
- `duration_h >= 1` : affiché dans le bandeau Still Degraded

---

## 6. Alertes Telegram

### 6.1 Routage

| Canal | Variable | Déclencheur |
|-------|----------|-------------|
| `TELEGRAM_CHAT_ID_CMINE` | Compte cmine | Chute groupe, anomalie worker cmine |
| `TELEGRAM_CHAT_ID_EVERMINER` | Compte everminer | Chute groupe, anomalie worker everminer |
| `TELEGRAM_CHAT_ID_PARAGUAY` | Duplication | Groupe P1 uniquement |
| `TELEGRAM_CHAT_ID_MINTO` | Duplication | Groupe R3 uniquement |
| `TELEGRAM_CHAT_ID` | Canal général | Workers No Group |

### 6.2 Chute de groupe

Message : `📉 Hashrate locally dropped by X%` avec les valeurs avant (avg 1h30) et maintenant, en UTC uniquement.

### 6.3 Anomalie worker

Message texte avec type, worker, drop%, valeurs courante et baseline.

### 6.4 Workers No Group

Message : `🏷️ Workers sans groupe détectés` avec la liste par compte. Cooldown 12h par worker.

### 6.5 Ce qui ne génère PAS d'alerte Telegram

- Rétablissement watchlist
- Rapport matin (email uniquement)
- Expiration watchlist
- Workers Dead fantômes (visibles dans le rapport matin et le dashboard)

---

## 7. Emails d'alerte

### 7.1 Adresses

- `cmine` → `ALERT_EMAIL_CMINE` (défaut : support@cyberianmine.de)
- `everminer` → `ALERT_EMAIL_EVERMINER` (défaut : support@cyberianmine.de)
- Rapport matin + No Group → `ALERT_EMAIL` (seb.webmail@gmail.com)

Expéditeur : `noreply@capone.market`

### 7.2 Alerte chute de groupe (temps réel)

En-tête orange, icône de drop stylisée (courbe descendante), tableau datacenter/compte/avant/maintenant/drop. Heure en UTC uniquement.

### 7.3 Alerte No Group (temps réel)

En-tête violet, tableau worker/compte/host. Cooldown 12h par worker.

### 7.4 Rapport du matin

**Heure** : 05:00 UTC — **Anti-doublon** : cooldown 20h

**Contenu (dans cet ordre)** :

1. **🏷️ Workers sans groupe** (si applicable) : tableau worker/compte/host avec instruction d'action.
2. **Still Degraded** : entrées watchlist actives, drop%, hashrate, durée.
3. **Workers offline** : liste par compte des workers offline + workers Dead (fantômes du registre), groupés par datacenter. Les workers Dead portent la mention "Dead (no longer in pool API)".
4. **Hashrate Warnings** : anomalies actives (worker-issues.json), **sauf** les workers déjà listés en Still Degraded (pas de doublon).

**Couleur de l'en-tête** :
- Vert : tout va bien
- Rouge : au moins un worker offline
- Orange : anomalies ou watchlist mais pas d'offline

**Sujet** : `[Morning Report] ✅ All online` ou `[Morning Report] N offline · N warnings · N no group — {date}`

---

## 8. Page SLA (sla.html)

### 8.1 Principe

Métriques de performance par datacenter sur les 30 derniers jours, calculées une fois par jour à 05:00 UTC et stockées dans `sla-daily.json`.

### 8.2 Métriques par datacenter

**Continuity SLA** : proportion de temps où les machines sont effectivement en ligne.
- Score r² par snapshot : `(workers_en_ligne / total_actifs)²`
- Moyenne journalière de ces scores

**Throughput** : le datacenter produit-il le hashrate attendu quand il est en ligne ?
- Part attendue = moyenne de `(hashrate_DC / hashrate_total)` sur les snapshots actifs
- Score par snapshot : `min(1, hashrate_DC / (total × part_attendue))`

**Combined** : `Continuity × Throughput` (plafonné à 1.0)

**Breach** : `1 − Combined` — exprimé en pourcentage.

### 8.3 Performance compte (ATO)

Mesure si le hashrate total des workers couvre l'**ATO** (_Actual Transfer Out_ — hashrate distribué aux clients).

**Calcul** : `min(1, total_workers_hr / ATO_hr)` par snapshot, moyenné sur la journée. L'ATO est le snapshot le plus proche temporellement (±75 min). Un score > 1.0 est plafonné à 1.0.

### 8.4 Fréquence de mise à jour

Une ligne par jour dans `sla-daily.json`, calculée sur le jour J-1 lors du run 05:00 UTC. Fenêtre glissante de 30 jours.

---

## 9. Règles globales

### 9.1 Snapshots et fenêtres de temps

| Constante | Valeur | Signification |
|-----------|--------|---------------|
| Snapshot interval | 30 min | Fréquence de collecte |
| MAX_SNAPSHOTS | 337 | ~7 jours de rétention par worker dans hashrate.json |
| CURRENT_WINDOW | 6 snaps | = 3h "actuel" pour les anomalies |
| BASELINE_SNAPS | 24 snaps | = 12h de baseline (snaps 7 à 30) |
| REF_SNAPSHOTS (groupe) | 3 snaps | = 1h30 de référence pour alertes groupe |
| MIN_HR_TH | 5 TH/s | Seuil "near zero" |
| OFFLINE_MINUTES | 60 min | Seuil last_share → offline |
| DEAD_THRESHOLD_H | 24h | Seuil f2pool "dead" |
| GHOST_MAX_DAYS | 90 jours | Rétention des workers Dead dans ghost-workers.json |

### 9.2 Cooldowns et seuils d'alerte

| Type | Seuil | Cooldown |
|------|-------|---------|
| Chute de groupe | > 30% | 4h |
| Level drop worker | > 40% | 8h |
| Volatile worker (CV) | stddev/mean > 55% | 8h |
| Volatile worker (zéros) | > 35% à zéro | 8h |
| No Group | — | 12h par worker |
| Rapport matin | — | 20h |
| Watchlist recovery | 75% de la baseline | — |
| Watchlist expiry | — | 14 jours |
| Ghost workers expiry | — | 90 jours |

### 9.3 Groupes exclus des alertes temps-réel

- `E1` (BitCluster) : hashrate yoyo quotidien normal, exclus des alertes de chute groupe et anomalies workers.

### 9.4 f2pool API — statuts

- `status = 0` : ONLINE
- `status = 1` : OFFLINE (contre-intuitif)

---

*Document de référence — capone watcher — juillet 2026*
