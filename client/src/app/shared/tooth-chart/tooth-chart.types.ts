/** FDI permanent dentition + per-tooth material assignment for case forms / print. */

export type ToothFdi =
  | '18' | '17' | '16' | '15' | '14' | '13' | '12' | '11'
  | '21' | '22' | '23' | '24' | '25' | '26' | '27' | '28'
  | '48' | '47' | '46' | '45' | '44' | '43' | '42' | '41'
  | '31' | '32' | '33' | '34' | '35' | '36' | '37' | '38';

/** One selected tooth: material + bridge group (same groupId = connected). */
export interface ToothAssignment {
  fdi: string;
  /** Display label e.g. Zircon / Emax */
  material: string;
  /** Teeth sharing groupId are a bridge / connected unit */
  groupId: string;
}

export const UPPER_RIGHT: ToothFdi[] = ['18', '17', '16', '15', '14', '13', '12', '11'];
export const UPPER_LEFT: ToothFdi[] = ['21', '22', '23', '24', '25', '26', '27', '28'];
export const LOWER_RIGHT: ToothFdi[] = ['48', '47', '46', '45', '44', '43', '42', '41'];
export const LOWER_LEFT: ToothFdi[] = ['31', '32', '33', '34', '35', '36', '37', '38'];

export const ALL_TEETH: ToothFdi[] = [
  ...UPPER_RIGHT,
  ...UPPER_LEFT,
  ...LOWER_RIGHT,
  ...LOWER_LEFT,
];

/** Adjacent FDI pairs within the same arch (for bridge linking). */
const ADJACENCY: Record<string, string[]> = (() => {
  const map: Record<string, string[]> = {};
  const link = (row: ToothFdi[]) => {
    for (let i = 0; i < row.length; i++) {
      const cur = row[i];
      const neighbors: string[] = [];
      if (i > 0) neighbors.push(row[i - 1]);
      if (i < row.length - 1) neighbors.push(row[i + 1]);
      map[cur] = [...(map[cur] || []), ...neighbors];
    }
  };
  // Across midline: 11-21 and 41-31
  link(UPPER_RIGHT);
  link(UPPER_LEFT);
  link(LOWER_RIGHT);
  link(LOWER_LEFT);
  map['11'] = [...(map['11'] || []), '21'];
  map['21'] = [...(map['21'] || []), '11'];
  map['41'] = [...(map['41'] || []), '31'];
  map['31'] = [...(map['31'] || []), '41'];
  return map;
})();

export function areAdjacent(a: string, b: string): boolean {
  return (ADJACENCY[a] || []).includes(b);
}

/** Stable colors so Zircon vs Emax are obvious on form + print. */
export const MATERIAL_COLORS: Record<string, string> = {
  Zircon: '#f97316',
  'German Zircon': '#f59e0b',
  Emax: '#0ea5e9',
  Peek: '#a855f7',
  Titanium: '#71717a',
  'Pmma Cad': '#14b8a6',
  'Try in': '#06b6d4',
  Mokup: '#ec4899',
  Mockup: '#ec4899',
  'Night Guard': '#8b5cf6',
  Wax: '#a1a1aa',
  Ring: '#78716c',
};

export function colorForMaterial(material: string): string {
  if (MATERIAL_COLORS[material]) return MATERIAL_COLORS[material];
  // hash fallback for custom materials
  let h = 0;
  for (let i = 0; i < material.length; i++) h = (h * 31 + material.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 65% 45%)`;
}

export function countByMaterial(assignments: ToothAssignment[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of assignments) {
    out[a.material] = (out[a.material] || 0) + 1;
  }
  return out;
}

export function newGroupId(): string {
  return `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
