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
    // Noms purement numériques — ex: 002, 031
    // ATTENTION: peut se chevaucher entre cmine et everminer (ex: cmine.017 et everminer.017)
    test: (name) => /^\d+$/.test(name),
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
    test: (name) => /^(ngs|yna|pie|olt)/i.test(name),
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
    test: (name) => /^18x/i.test(name),
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
