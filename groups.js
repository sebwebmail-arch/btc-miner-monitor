// Mapping worker name patterns → groupe f2pool / provider
// IMPORTANT: status API f2pool : 0 = ONLINE, 1 = OFFLINE (contre-intuitif)

const GROUPS = [
  {
    id: 'R1',
    provider: 'IZTM',
    test: (name) => /^r/i.test(name),
  },
  {
    id: 'R3',
    provider: 'Minto',
    test: (name) => /^k2lx/i.test(name),
  },
  {
    id: 'E1',
    provider: 'BitCluster',
    // Noms purement numériques COURTS — ex: 002, 031 (max 4 chiffres)
    // Limité à 1-4 chiffres pour ne pas capturer les adresses MAC numériques de Dataprana (11 chiffres)
    test: (name) => /^\d{1,4}$/.test(name),
  },
  {
    id: 'E2',
    provider: 'AmityAge',
    // ATTENTION: peut se chevaucher entre cmine et everminer (ex: cmine.aa14 et everminer.aa14)
    test: (name) => /^aa/i.test(name),
  },
  {
    id: 'U1+U2',
    provider: 'Dataprana',
    // Ancien format (serial numbers): ngs, yna, pie, olt, dga
    // Nouveau format (adresses MAC): 12 hex chars (ex: 02011366de33)
    // Ou numérique long 11 chiffres (ex: 23181238824) — transition juillet 2026
    test: (name) => /^(ngs|yna|pie|olt|dga)/i.test(name)
                 || /^[0-9a-f]{12}$/i.test(name)
                 || /^\d{9,}$/.test(name),
  },
  {
    id: 'U3',
    provider: 'ValueHash (NY)',
    // c21 = workers cmine, e21 = workers everminer
    test: (name) => /^(c21|e21)/i.test(name),
  },
  {
    id: 'P1',
    provider: 'Altos',
    test: (name) => /^s21/i.test(name),
  },
  {
    id: 'F1',
    provider: 'Terahash',
    // Liste explicite des 14 machines Terahash (Cyberian Mine).
    // On évite le regex /^18x/ pour ne pas capturer des connexions
    // transitoires (machines fallback, tests ponctuels, etc.)
    // Si une nouvelle machine Terahash est ajoutée, ajouter son nom ici.
    test: (name) => new Set([
      '18x0x157', '18x0x168', '18x0x18',  '18x0x199',
      '18x0x22',  '18x0x238', '18x0x30',  '18x0x61',
      '18x0x72',  '18x0x73',  '18x0x91',  '18x0x94',
      '18x1x179', '18x1x68',
    ]).has(name),
  },
  {
    id: 'OM',
    provider: 'Open Mine',
    test: (name) => /^(omx|openfall)/i.test(name),
  },
];

function getGroup(workerName) {
  for (const group of GROUPS) {
    if (group.test(workerName)) {
      return { id: group.id, provider: group.provider };
    }
  }
  return { id: 'No Group', provider: 'Unknown' };
}

module.exports = { GROUPS, getGroup };
