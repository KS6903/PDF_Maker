/**
 * A standard sRGB colour profile (ICC version 2, display class), built in code
 * rather than shipped as a file. PDF/A needs one as the file's output intent
 * so the colours on its pages have a defined meaning.
 */

const D50 = [0.9642, 1.0, 0.8249];
// sRGB primaries adapted to D50 (Bradford), as in the reference profiles.
const RED = [0.4360747, 0.2225045, 0.0139322];
const GREEN = [0.3850649, 0.7168786, 0.0971045];
const BLUE = [0.1430804, 0.0606169, 0.7141733];

let cached: Uint8Array | null = null;

export function srgbProfile(): Uint8Array {
  if (cached) return cached;
  const enc = new TextEncoder();
  const sig = (s: string) => [...enc.encode(s.padEnd(4, ' '))];
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const s15 = (v: number) => u32(Math.round(v * 65536) >>> 0);
  const pad4 = (b: number[]) => {
    while (b.length % 4) b.push(0);
    return b;
  };

  const description = 'sRGB IEC61966-2.1';
  const desc = pad4([
    ...sig('desc'),
    0, 0, 0, 0,
    ...u32(description.length + 1),
    ...enc.encode(description),
    0,
    ...u32(0), // Unicode language
    ...u32(0), // Unicode count
    0, 0, // ScriptCode code
    0, // ScriptCode count
    ...new Array(67).fill(0),
  ]);
  const cprt = pad4([...sig('text'), 0, 0, 0, 0, ...enc.encode('No copyright, use freely'), 0]);
  const xyz = (v: number[]) => [...sig('XYZ '), 0, 0, 0, 0, ...v.flatMap(s15)];
  // The sRGB tone curve, sampled.
  const points = 1024;
  const curve = [...sig('curv'), 0, 0, 0, 0, ...u32(points)];
  for (let i = 0; i < points; i++) {
    const c = i / (points - 1);
    const lin = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    const v = Math.round(lin * 65535);
    curve.push((v >> 8) & 255, v & 255);
  }
  pad4(curve);

  const tags: [string, number[]][] = [
    ['desc', desc],
    ['cprt', cprt],
    ['wtpt', xyz(D50)],
    ['rXYZ', xyz(RED)],
    ['gXYZ', xyz(GREEN)],
    ['bXYZ', xyz(BLUE)],
    ['rTRC', curve],
  ];
  // The three tone curves share one copy of the data.
  const tableSize = 4 + (tags.length + 2) * 12;
  let offset = 128 + tableSize;
  const table: number[] = [...u32(tags.length + 2)];
  const data: number[] = [];
  let curveAt = 0;
  for (const [name, bytes] of tags) {
    if (name === 'rTRC') curveAt = offset;
    table.push(...sig(name), ...u32(offset), ...u32(bytes.length));
    data.push(...bytes);
    offset += bytes.length;
  }
  for (const name of ['gTRC', 'bTRC']) table.push(...sig(name), ...u32(curveAt), ...u32(curve.length));

  const size = 128 + table.length + data.length;
  const now = new Date();
  const header = [
    ...u32(size),
    ...u32(0), // preferred CMM
    0x02, 0x10, 0, 0, // version 2.1
    ...sig('mntr'),
    ...sig('RGB '),
    ...sig('XYZ '),
    ...[now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds()].flatMap((n) => [(n >> 8) & 255, n & 255]),
    ...sig('acsp'),
    ...u32(0), // platform
    ...u32(0), // flags
    ...u32(0), // manufacturer
    ...u32(0), // model
    ...u32(0), ...u32(0), // attributes
    ...u32(0), // perceptual intent
    ...D50.flatMap(s15),
    ...u32(0), // creator
  ];
  while (header.length < 128) header.push(0);
  cached = new Uint8Array([...header, ...table, ...data]);
  return cached;
}
