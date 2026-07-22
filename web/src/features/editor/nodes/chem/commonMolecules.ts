// A small BUNDLED map of common molecules so name <-> structure works fully offline.
// Name-to-structure resolution is genuinely hard offline, so this is best-effort: it
// covers the molecules a school / first-year chemistry student actually types. Anything
// outside the map falls back to the optional online PubChem lookup, which degrades
// silently when the network (or the whole AI gateway) is unreachable - the norm in prod.

export interface CommonMolecule {
  name: string;
  smiles: string;
  formula?: string;
}

// Curriculum-weighted, not exhaustive. SMILES kept simple and lowercase-matchable by name.
export const COMMON_MOLECULES: CommonMolecule[] = [
  { name: 'water', smiles: 'O', formula: 'H2O' },
  { name: 'hydrogen', smiles: '[H][H]', formula: 'H2' },
  { name: 'oxygen', smiles: 'O=O', formula: 'O2' },
  { name: 'nitrogen', smiles: 'N#N', formula: 'N2' },
  { name: 'carbon dioxide', smiles: 'O=C=O', formula: 'CO2' },
  { name: 'carbon monoxide', smiles: '[C-]#[O+]', formula: 'CO' },
  { name: 'ammonia', smiles: 'N', formula: 'NH3' },
  { name: 'methane', smiles: 'C', formula: 'CH4' },
  { name: 'ethane', smiles: 'CC', formula: 'C2H6' },
  { name: 'propane', smiles: 'CCC', formula: 'C3H8' },
  { name: 'butane', smiles: 'CCCC', formula: 'C4H10' },
  { name: 'ethene', smiles: 'C=C', formula: 'C2H4' },
  { name: 'ethylene', smiles: 'C=C', formula: 'C2H4' },
  { name: 'ethyne', smiles: 'C#C', formula: 'C2H2' },
  { name: 'acetylene', smiles: 'C#C', formula: 'C2H2' },
  { name: 'methanol', smiles: 'CO', formula: 'CH4O' },
  { name: 'ethanol', smiles: 'CCO', formula: 'C2H6O' },
  { name: 'propan-2-ol', smiles: 'CC(O)C', formula: 'C3H8O' },
  { name: 'isopropanol', smiles: 'CC(O)C', formula: 'C3H8O' },
  { name: 'methanoic acid', smiles: 'OC=O', formula: 'CH2O2' },
  { name: 'formic acid', smiles: 'OC=O', formula: 'CH2O2' },
  { name: 'ethanoic acid', smiles: 'CC(=O)O', formula: 'C2H4O2' },
  { name: 'acetic acid', smiles: 'CC(=O)O', formula: 'C2H4O2' },
  { name: 'methanal', smiles: 'C=O', formula: 'CH2O' },
  { name: 'formaldehyde', smiles: 'C=O', formula: 'CH2O' },
  { name: 'ethanal', smiles: 'CC=O', formula: 'C2H4O' },
  { name: 'acetaldehyde', smiles: 'CC=O', formula: 'C2H4O' },
  { name: 'acetone', smiles: 'CC(=O)C', formula: 'C3H6O' },
  { name: 'propanone', smiles: 'CC(=O)C', formula: 'C3H6O' },
  { name: 'benzene', smiles: 'C1=CC=CC=C1', formula: 'C6H6' },
  { name: 'toluene', smiles: 'Cc1ccccc1', formula: 'C7H8' },
  { name: 'phenol', smiles: 'Oc1ccccc1', formula: 'C6H6O' },
  { name: 'aniline', smiles: 'Nc1ccccc1', formula: 'C6H7N' },
  { name: 'pyridine', smiles: 'c1ccncc1', formula: 'C5H5N' },
  { name: 'cyclohexane', smiles: 'C1CCCCC1', formula: 'C6H12' },
  { name: 'glucose', smiles: 'OCC1OC(O)C(O)C(O)C1O', formula: 'C6H12O6' },
  { name: 'glycine', smiles: 'NCC(=O)O', formula: 'C2H5NO2' },
  { name: 'alanine', smiles: 'CC(N)C(=O)O', formula: 'C3H7NO2' },
  { name: 'acetylsalicylic acid', smiles: 'CC(=O)Oc1ccccc1C(=O)O', formula: 'C9H8O4' },
  { name: 'aspirin', smiles: 'CC(=O)Oc1ccccc1C(=O)O', formula: 'C9H8O4' },
  { name: 'paracetamol', smiles: 'CC(=O)Nc1ccc(O)cc1', formula: 'C8H9NO2' },
  { name: 'acetaminophen', smiles: 'CC(=O)Nc1ccc(O)cc1', formula: 'C8H9NO2' },
  { name: 'ibuprofen', smiles: 'CC(C)Cc1ccc(cc1)C(C)C(=O)O', formula: 'C13H18O2' },
  { name: 'caffeine', smiles: 'CN1C=NC2=C1C(=O)N(C)C(=O)N2C', formula: 'C8H10N4O2' },
  { name: 'nicotine', smiles: 'CN1CCCC1c1cccnc1', formula: 'C10H14N2' },
  { name: 'urea', smiles: 'NC(=O)N', formula: 'CH4N2O' },
  { name: 'sucrose', smiles: 'OCC1OC(OC2(CO)OC(CO)C(O)C2O)C(O)C(O)C1O', formula: 'C12H22O11' },
];

function norm(s: string): string {
  return s.trim().toLowerCase();
}

const byName = new Map<string, CommonMolecule>();
const bySmiles = new Map<string, CommonMolecule>();
for (const m of COMMON_MOLECULES) {
  if (!byName.has(norm(m.name))) byName.set(norm(m.name), m);
  // First name wins as the display name for a given structure (e.g. "ethanoic acid" over "acetic acid").
  if (!bySmiles.has(m.smiles)) bySmiles.set(m.smiles, m);
}

/** Best-effort offline name -> molecule. Returns undefined when the name is unknown. */
export function lookupByName(name: string): CommonMolecule | undefined {
  return byName.get(norm(name));
}

/** Best-effort offline structure -> common name, by exact SMILES match only. */
export function lookupBySmiles(smiles: string): CommonMolecule | undefined {
  return bySmiles.get(smiles.trim());
}

/** A short list surfaced as one-tap examples in the empty state. */
export const EXAMPLE_NAMES = ['benzene', 'caffeine', 'aspirin', 'glucose', 'ethanol', 'water'];

/**
 * Optional ONLINE name -> SMILES via PubChem. Must never throw, and must resolve to null
 * quickly when offline, so the caller can treat it as a pure enhancement. The AI gateway
 * and general network are frequently unreachable in production; this is the one place the
 * node touches the network and it is entirely optional.
 */
export async function resolveNameOnline(name: string, timeoutMs = 4000): Promise<string | null> {
  const q = name.trim();
  if (!q) return null;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url =
      'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/' +
      encodeURIComponent(q) +
      '/property/CanonicalSMILES/JSON';
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const smiles = (data as { PropertyTable?: { Properties?: Array<{ CanonicalSMILES?: string }> } })
      ?.PropertyTable?.Properties?.[0]?.CanonicalSMILES;
    return typeof smiles === 'string' && smiles.length > 0 ? smiles : null;
  } catch {
    // Offline, aborted, blocked, or malformed - all silent by design.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
