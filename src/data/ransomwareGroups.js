// Publicly reported operating bases of ransomware groups, used to draw origin → victim arcs.
// Deliberately conservative: only groups whose base is widely reported by governments or major
// security researchers, with the confidence of that reporting. Attribution is about where the
// operators are reported to be (often a language/ecosystem), not proof and not state sponsorship.
// Groups not listed here are shown as "origin unknown" and get no arc.
export const GROUP_ORIGINS = {
  lockbit: { cc: 'RU', conf: 'high', basis: 'US/UK/EU sanctions and indictment of its alleged leader, a Russian national (2024)' },
  blackbasta: { cc: 'RU', conf: 'high', basis: 'leaked internal chats; alleged leader identified as a Russian national (2025)' },
  conti: { cc: 'RU', conf: 'high', basis: 'leaked chats and US government reward notices (2022)' },
  '8base': { cc: 'RU', conf: 'high', basis: 'Russian nationals arrested and charged in the Phobos/8Base takedown (2025)' },
  phobos: { cc: 'RU', conf: 'high', basis: 'Russian nationals charged by the US Department of Justice (2024–25)' },
  qilin: { cc: 'RU', conf: 'medium', basis: 'Russian-speaking RaaS recruiting on Russian-language forums; avoids CIS targets' },
  akira: { cc: 'RU', conf: 'medium', basis: 'Russian-speaking; researchers link operators to former Conti members' },
  blacksuit: { cc: 'RU', conf: 'medium', basis: 'Royal/Conti lineage, Russian-speaking operators' },
  royal: { cc: 'RU', conf: 'medium', basis: 'Conti lineage, Russian-speaking operators' },
  clop: { cc: 'RU', conf: 'medium', basis: 'Russian-speaking TA505/FIN11 ecosystem' },
  play: { cc: 'RU', conf: 'medium', basis: 'Russian-speaking operators per vendor and government reporting' },
  funksec: { cc: 'DZ', conf: 'medium', basis: 'Check Point research links its developer to Algeria (2025)' },
  handala: { cc: 'IR', conf: 'medium', basis: 'Iran-linked hack-and-leak persona per multiple vendor reports' },
};

// "LockBit5", "lockbit3", "Cl0p", "BlackBasta" → table keys
export function groupOrigin(name) {
  if (!name) return null;
  const k = name.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/0/g, 'o').replace(/\d+$/, '');
  return GROUP_ORIGINS[k] || GROUP_ORIGINS[k.replace(/ransomware|team|group$/, '')] || (k === '8base' ? GROUP_ORIGINS['8base'] : null);
}

// Where an origin country's traffic enters the internet: its main exchange city. Routes start
// here; the "reported base" marker sits here too, labelled with the country only.
export const ORIGIN_HUBS = { RU: [55.76, 37.62], DZ: [36.75, 3.06], IR: [35.69, 51.39] };
