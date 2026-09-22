import { PDFDocument, PDFFont, StandardFonts } from '@cantoo/pdf-lib';

export type FontFamily = 'helvetica' | 'times' | 'courier';

export const FONT_OPTIONS: [FontFamily, string][] = [
  ['helvetica', 'Sans (Helvetica)'],
  ['times', 'Serif (Times)'],
  ['courier', 'Mono (Courier)'],
];

/** CSS stacks that match the metrics of the standard PDF fonts closely enough for on-screen editing. */
export const CSS_FONT: Record<FontFamily, string> = {
  helvetica: 'Helvetica, Arial, sans-serif',
  times: '"Times New Roman", Times, serif',
  courier: '"Courier New", Courier, monospace',
};

const BASELINE_FALLBACK: Record<FontFamily, number> = { helvetica: 0.95, times: 0.93, courier: 0.86 };
const baselineCache = new Map<FontFamily, number>();

/**
 * Distance from the top of a CSS line box (line-height 1.2) to the text baseline, in ems.
 * Measured in the live DOM so on-screen text and the saved PDF line up exactly.
 */
export function baselineEm(family: FontFamily): number {
  let v = baselineCache.get(family);
  if (v !== undefined) return v;
  try {
    const div = document.createElement('div');
    div.style.cssText = `position:absolute;visibility:hidden;top:0;left:0;font:100px ${CSS_FONT[family]};line-height:1.2;white-space:pre`;
    const marker = document.createElement('span');
    marker.style.cssText = 'display:inline-block;width:1px;height:0;vertical-align:baseline';
    div.append('Hxg', marker);
    document.body.append(div);
    v = (marker.getBoundingClientRect().top - div.getBoundingClientRect().top) / 100;
    div.remove();
    if (!(v > 0.6 && v < 1.2)) v = BASELINE_FALLBACK[family];
  } catch {
    v = BASELINE_FALLBACK[family];
  }
  baselineCache.set(family, v);
  return v;
}

export function standardFont(family: FontFamily, bold = false, italic = false): StandardFonts {
  switch (family) {
    case 'times':
      return bold && italic
        ? StandardFonts.TimesRomanBoldItalic
        : bold
          ? StandardFonts.TimesRomanBold
          : italic
            ? StandardFonts.TimesRomanItalic
            : StandardFonts.TimesRoman;
    case 'courier':
      return bold && italic
        ? StandardFonts.CourierBoldOblique
        : bold
          ? StandardFonts.CourierBold
          : italic
            ? StandardFonts.CourierOblique
            : StandardFonts.Courier;
    default:
      return bold && italic
        ? StandardFonts.HelveticaBoldOblique
        : bold
          ? StandardFonts.HelveticaBold
          : italic
            ? StandardFonts.HelveticaOblique
            : StandardFonts.Helvetica;
  }
}

/** Embeds each standard font at most once per document. */
export class FontCache {
  private cache = new Map<string, Promise<PDFFont>>();
  constructor(private doc: PDFDocument) {}
  get(family: FontFamily, bold = false, italic = false) {
    const key = standardFont(family, bold, italic);
    let f = this.cache.get(key);
    if (!f) {
      f = this.doc.embedFont(key);
      this.cache.set(key, f);
    }
    return f;
  }
}

const encodable = new Map<string, boolean>();

/**
 * Standard PDF fonts only cover WinAnsi (Western European). Replace anything else with the
 * closest ASCII-ish equivalent, or "?" so drawing never throws.
 */
export function safeText(font: PDFFont, text: string): string {
  let out = '';
  for (const ch of text.replace(/\t/g, '    ').replace(/\r/g, '')) {
    if (ch === '\n') {
      out += ch;
      continue;
    }
    if (canEncode(font, ch)) {
      out += ch;
      continue;
    }
    const stripped = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    out += stripped && [...stripped].every((c) => canEncode(font, c)) ? stripped : FALLBACKS[ch] ?? '?';
  }
  return out;
}

const FALLBACKS: Record<string, string> = {
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  '​': '',
  '﻿': '',
  '−': '-',
  '‐': '-',
  '‑': '-',
  '→': '->',
  '←': '<-',
  '≤': '<=',
  '≥': '>=',
  '≠': '!=',
  '✓': 'v',
  '✔': 'v',
  '●': '•',
  '◦': 'o',
  '▪': '•',
};

function canEncode(font: PDFFont, ch: string) {
  const key = font.name + ch;
  let ok = encodable.get(key);
  if (ok === undefined) {
    try {
      font.encodeText(ch);
      font.widthOfTextAtSize(ch, 10);
      ok = true;
    } catch {
      ok = false;
    }
    encodable.set(key, ok);
  }
  return ok;
}
