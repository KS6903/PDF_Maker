/**
 * Finding, editing and removing the JavaScript a PDF carries. Folio never
 * runs any of it: this only reads and rewrites the code as text.
 */
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRef, PDFStream, type PDFDocument, type PDFObject } from '@cantoo/pdf-lib';
import { textOf } from './pdf';

export interface ScriptEntry {
  /** Where the script runs from, in words. */
  label: string;
  code: string;
  /** The action dictionary holding the code. */
  action: PDFDict;
  /** Document-level scripts have a name. */
  name?: string;
  /** Unhook this script from whatever runs it. Document scripts are rewritten with setDocumentScripts instead. */
  remove(): void;
}

const JS = PDFName.of('JavaScript');
const S = PDFName.of('S');

const DOC_TRIGGERS: Record<string, string> = {
  WC: 'before the document closes',
  WS: 'before the document is saved',
  DS: 'after the document is saved',
  WP: 'before the document is printed',
  DP: 'after the document is printed',
};
const PAGE_TRIGGERS: Record<string, string> = { O: 'when the page opens', C: 'when the page closes' };
const FIELD_TRIGGERS: Record<string, string> = {
  E: 'when the mouse enters',
  X: 'when the mouse leaves',
  D: 'on mouse down',
  U: 'on click',
  Fo: 'on focus',
  Bl: 'when focus leaves',
  PO: 'when its page opens',
  PC: 'when its page closes',
  PV: 'when its page becomes visible',
  PI: 'when its page is hidden',
  K: 'on each keystroke',
  F: 'to format the value',
  V: 'to check the value',
  C: 'to calculate the value',
};

function resolve(doc: PDFDocument, obj: PDFObject | undefined) {
  return obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
}

function isJs(doc: PDFDocument, obj: PDFObject | undefined): obj is PDFDict {
  const d = resolve(doc, obj);
  return d instanceof PDFDict && d.get(S) === JS;
}

const NEXT = PDFName.of('Next');

/** The action stored under `key`, and any it chains to through /Next, each with where it hangs. */
function chain(doc: PDFDocument, owner: PDFDict, key: PDFName, seen = new Set<PDFDict>()): [PDFDict, PDFDict, PDFName][] {
  const v = resolve(doc, owner.get(key));
  const list = v instanceof PDFArray ? v.asArray().map((o) => resolve(doc, o)) : [v];
  const out: [PDFDict, PDFDict, PDFName][] = [];
  for (const d of list) {
    if (!(d instanceof PDFDict) || seen.has(d)) continue;
    seen.add(d);
    out.push([d, owner, key], ...chain(doc, d, NEXT, seen));
  }
  return out;
}

/** Take one action out of the slot it hangs in, keeping whatever it chained to. */
function unhook(doc: PDFDocument, action: PDFDict, owner: PDFDict, key: PDFName) {
  const v = resolve(doc, owner.get(key));
  const next = action.get(NEXT);
  if (v instanceof PDFArray) {
    owner.set(key, doc.context.obj(v.asArray().flatMap((o) => (resolve(doc, o) === action ? (next ? [next] : []) : [o]))));
  } else if (next) {
    owner.set(key, next);
  } else {
    owner.delete(key);
  }
}

/** The document-level script name tree, flattened into [name, action] pairs. */
function nameTree(doc: PDFDocument, node: PDFObject | undefined, out: [string, PDFDict][] = []) {
  const d = resolve(doc, node);
  if (!(d instanceof PDFDict)) return out;
  const names = resolve(doc, d.get(PDFName.of('Names')));
  if (names instanceof PDFArray) {
    for (let i = 0; i + 1 < names.size(); i += 2) {
      const action = resolve(doc, names.get(i + 1));
      if (action instanceof PDFDict) out.push([textOf(resolve(doc, names.get(i))), action]);
    }
  }
  const kids = resolve(doc, d.get(PDFName.of('Kids')));
  if (kids instanceof PDFArray) for (const k of kids.asArray()) nameTree(doc, k, out);
  return out;
}

function fieldName(doc: PDFDocument, dict: PDFDict): string {
  const parts: string[] = [];
  let d: PDFObject | undefined = dict;
  for (let guard = 0; d instanceof PDFDict && guard < 32; guard++) {
    const t = textOf(resolve(doc, d.get(PDFName.of('T'))));
    if (t) parts.unshift(t);
    d = resolve(doc, d.get(PDFName.of('Parent')));
  }
  return parts.join('.');
}

export function findScripts(doc: PDFDocument): ScriptEntry[] {
  const out: ScriptEntry[] = [];
  const seen = new Set<PDFDict>();
  const add = (label: string, owner: PDFDict, key: PDFName) => {
    for (const [action, at, k] of chain(doc, owner, key)) {
      if (seen.has(action) || action.get(S) !== JS) continue;
      seen.add(action);
      out.push({ label, code: textOf(resolve(doc, action.get(JS))), action, remove: () => unhook(doc, action, at, k) });
    }
  };
  /** Every trigger in an additional-actions dictionary. */
  const addAll = (who: string, owner: PDFDict, triggers: Record<string, string>) => {
    const aa = resolve(doc, owner.get(PDFName.of('AA')));
    if (aa instanceof PDFDict) for (const k of aa.keys()) add(`${who}${triggers[k.decodeText()] ?? k.decodeText()}`, aa, k);
  };
  const catalog = doc.catalog;

  const names = resolve(doc, catalog.get(PDFName.of('Names')));
  if (names instanceof PDFDict) {
    for (const [name, action] of nameTree(doc, names.get(JS))) {
      if (seen.has(action)) continue;
      seen.add(action);
      out.push({ label: `Document script “${name}”`, code: textOf(resolve(doc, action.get(JS))), action, name, remove: () => undefined });
    }
  }
  add('When the document opens', catalog, PDFName.of('OpenAction'));
  addAll('Document, ', catalog, DOC_TRIGGERS);

  doc.getPages().forEach((page, i) => {
    addAll(`Page ${i + 1}, `, page.node, PAGE_TRIGGERS);
    for (const ref of page.node.Annots()?.asArray() ?? []) {
      const annot = resolve(doc, ref);
      if (!(annot instanceof PDFDict)) continue;
      const fname = fieldName(doc, annot);
      const who = fname ? `Field “${fname}”` : `Link or annotation on page ${i + 1}`;
      add(`${who}, on click`, annot, PDFName.of('A'));
      addAll(`${who}, `, annot, FIELD_TRIGGERS);
    }
  });

  // Fields whose scripts sit on a parent rather than on the widget itself.
  const walkFields = (obj: PDFObject | undefined, depth = 0) => {
    const d = resolve(doc, obj);
    if (d instanceof PDFArray) return d.asArray().forEach((o) => walkFields(o, depth));
    if (!(d instanceof PDFDict) || depth > 32) return;
    addAll(`Field “${fieldName(doc, d)}”, `, d, FIELD_TRIGGERS);
    walkFields(d.get(PDFName.of('Kids')), depth + 1);
  };
  const acro = resolve(doc, catalog.get(PDFName.of('AcroForm')));
  if (acro instanceof PDFDict) walkFields(acro.get(PDFName.of('Fields')));
  return out;
}

/** Replace the code of an existing script. */
export function setScriptCode(action: PDFDict, code: string) {
  action.set(JS, PDFHexString.fromText(code));
}

/** Rewrite the document-level scripts as a single flat name tree, sorted by name. */
export function setDocumentScripts(doc: PDFDocument, scripts: { name: string; code: string }[]) {
  const catalog = doc.catalog;
  let names = resolve(doc, catalog.get(PDFName.of('Names')));
  if (!(names instanceof PDFDict)) {
    if (!scripts.length) return;
    names = doc.context.obj({});
    catalog.set(PDFName.of('Names'), names);
  }
  const dict = names as PDFDict;
  if (!scripts.length) {
    dict.delete(JS);
    return;
  }
  // Names in a name tree must be unique.
  const used = new Set<string>();
  const unique = scripts.map((s) => {
    let name = s.name;
    for (let i = 2; used.has(name); i++) name = `${s.name} (${i})`;
    used.add(name);
    return { ...s, name };
  });
  const sorted = unique.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const entries: PDFObject[] = [];
  for (const s of sorted) {
    const action = doc.context.obj({ Type: 'Action', S: 'JavaScript' });
    action.set(JS, PDFHexString.fromText(s.code));
    entries.push(PDFHexString.fromText(s.name), doc.context.register(action));
  }
  dict.set(JS, doc.context.obj({ Names: doc.context.obj(entries) }));
}

/**
 * Remove every script: document scripts, open actions, triggers on the
 * document, pages, links and form fields. Returns how many were removed.
 */
export function stripJavaScript(doc: PDFDocument) {
  let removed = 0;
  const names = resolve(doc, doc.catalog.get(PDFName.of('Names')));
  if (names instanceof PDFDict && names.has(JS)) {
    removed += nameTree(doc, names.get(JS)).length;
    names.delete(JS);
  }
  const visited = new Set<PDFObject>();
  const clean = (d: PDFDict) => {
    for (const key of ['A', 'OpenAction', 'Next']) {
      const k = PDFName.of(key);
      const v = resolve(doc, d.get(k));
      if (isJs(doc, v)) {
        d.delete(k);
        removed++;
      } else if (v instanceof PDFArray && key === 'Next') {
        const keep = v.asArray().filter((o) => !isJs(doc, o));
        removed += v.size() - keep.length;
        if (keep.length !== v.size()) d.set(k, doc.context.obj(keep));
      }
    }
    const aaKey = PDFName.of('AA');
    const aa = resolve(doc, d.get(aaKey));
    if (aa instanceof PDFDict) {
      for (const [k, v] of aa.entries()) {
        if (isJs(doc, v)) {
          aa.delete(k);
          removed++;
        }
      }
      if (!aa.keys().length) d.delete(aaKey);
    }
  };
  const visit = (obj: PDFObject | undefined) => {
    if (!obj || visited.has(obj)) return;
    visited.add(obj);
    if (obj instanceof PDFDict) {
      clean(obj);
      for (const v of obj.values()) if (!(v instanceof PDFRef)) visit(v);
    } else if (obj instanceof PDFArray) {
      for (const v of obj.asArray()) if (!(v instanceof PDFRef)) visit(v);
    } else if (obj instanceof PDFStream) {
      visit(obj.dict);
    }
  };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) visit(obj);
  return removed;
}
