/**
 * Certificate (digital ID) signatures, done entirely on this computer.
 *
 * A signature is added as an incremental update: the original bytes stay
 * exactly as they were and the signature is appended, so earlier signatures
 * remain valid. The signature itself is a detached PKCS#7 blob over every byte
 * of the file except the space reserved for it.
 */
import * as Forge from 'node-forge';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, StandardFonts, type PDFPage } from '@cantoo/pdf-lib';
import { visualFrame, visualRect, uprightMatrix, textOf, type PdfSource } from './pdf';
import { safeText } from './fonts';

// node-forge is CommonJS that fills in its exports as it runs, which static
// named-export detection can't see; the module object itself is on `default`.
const forge = ((Forge as unknown as { default?: typeof Forge }).default ?? Forge) as typeof Forge;

/** Bytes reserved for the signature. A certificate chain of a few links fits easily. */
const SIG_BYTES = 12_000;
const PLACEHOLDER = 1_111_111_111;

export interface DigitalId {
  name: string;
  email?: string;
  key: Forge.pki.rsa.PrivateKey;
  cert: Forge.pki.Certificate;
  chain: Forge.pki.Certificate[];
}

function toBinary(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

function fromBinary(s: string) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function attr(cert: Forge.pki.Certificate, short: string, where: 'subject' | 'issuer' = 'subject') {
  const f = cert[where].getField(short) as { value?: string; valueTagClass?: number } | null;
  if (!f?.value) return '';
  // UTF8String values come back as raw UTF-8 bytes.
  if (f.valueTagClass !== forge.asn1.Type.UTF8) return f.value;
  try {
    return forge.util.decodeUtf8(f.value);
  } catch {
    return f.value;
  }
}

export function certName(cert: Forge.pki.Certificate) {
  return attr(cert, 'CN') || attr(cert, 'O') || attr(cert, 'E') || 'Unknown signer';
}

/** Open a .pfx / .p12 digital ID. Throws on a wrong password. */
export function readPfx(bytes: Uint8Array, password: string): DigitalId {
  let p12: Forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(toBinary(bytes)), false, password);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(/mac|password|decrypt|invalid/i.test(msg) ? 'Wrong password for this digital ID.' : 'That file is not a digital ID (.pfx or .p12) Folio can read.');
  }
  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []).map((b) => b.cert).filter((c): c is Forge.pki.Certificate => !!c);
  const key = keyBags.find((b) => b.key)?.key as Forge.pki.rsa.PrivateKey | undefined;
  if (!key || !('n' in key)) throw new Error('This digital ID has no RSA private key, so it can’t sign.');
  const cert = certs.find((c) => (c.publicKey as Forge.pki.rsa.PublicKey).n?.equals(key.n)) ?? certs[0];
  if (!cert) throw new Error('This digital ID has no certificate.');
  return { name: certName(cert), email: attr(cert, 'E') || undefined, key, cert, chain: certs.filter((c) => c !== cert) };
}

/** Make a new self-signed digital ID and its password-protected .pfx file. */
export async function createDigitalId(o: { name: string; email?: string; organization?: string; password: string; years: number }) {
  // The browser's crypto makes the key quickly; forge takes it from there.
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const key = forge.pki.privateKeyFromAsn1(forge.asn1.fromDer(toBinary(pkcs8)));
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(key.n, key.e);
  // Positive serial number: clear the top bit.
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] &= 0x7f;
  cert.serialNumber = [...serial].map((b) => b.toString(16).padStart(2, '0')).join('');
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + o.years);
  // UTF8String so any name works; email addresses must be IA5String. (The
  // typings declare valueTagClass as a Class, but forge reads it as a Type.)
  const tag = (t: Forge.asn1.Type) => t as unknown as Forge.asn1.Class;
  const subject: Forge.pki.CertificateField[] = [
    { shortName: 'CN', value: o.name, valueTagClass: tag(forge.asn1.Type.UTF8) },
    ...(o.organization ? [{ shortName: 'O', value: o.organization, valueTagClass: tag(forge.asn1.Type.UTF8) }] : []),
    ...(o.email ? [{ name: 'emailAddress', value: o.email, valueTagClass: tag(forge.asn1.Type.IA5STRING) }] : []),
  ];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'extKeyUsage', emailProtection: true },
    { name: 'subjectKeyIdentifier' },
    ...(o.email ? [{ name: 'subjectAltName', altNames: [{ type: 1, value: o.email }] }] : []),
  ]);
  cert.sign(key, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(key, [cert], o.password, { algorithm: '3des', friendlyName: o.name });
  const pfx = fromBinary(forge.asn1.toDer(p12).getBytes());
  return { id: { name: o.name, email: o.email, key, cert, chain: [] } as DigitalId, pfx };
}

/**
 * forge rebuilds the signer's issuer name from the parsed certificate, and in
 * doing so re-encodes it (UTF-8 names come out double-encoded, other string
 * types change). Validators then can't match the signer to its certificate.
 * Put back the issuer exactly as the certificate itself has it.
 */
function withCertificateIssuer(contentInfo: Forge.asn1.Asn1, cert: Forge.pki.Certificate) {
  const tbs = (cert as unknown as { tbsCertificate?: Forge.asn1.Asn1 }).tbsCertificate;
  const fields = tbs && Array.isArray(tbs.value) ? (tbs.value as Forge.asn1.Asn1[]) : null;
  if (!fields) return contentInfo;
  // TBSCertificate: [0] version (optional), serialNumber, signature, issuer, ...
  const offset = fields[0]?.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC ? 1 : 0;
  const issuer = fields[offset + 2];
  const signedData = ((contentInfo.value as Forge.asn1.Asn1[])[1].value as Forge.asn1.Asn1[])[0];
  const parts = signedData.value as Forge.asn1.Asn1[];
  const signerInfos = parts[parts.length - 1].value as Forge.asn1.Asn1[];
  const issuerAndSerial = (signerInfos[0].value as Forge.asn1.Asn1[])[1].value as Forge.asn1.Asn1[];
  issuerAndSerial[0] = issuer;
  return contentInfo;
}

/** Is the file encrypted? Signing changes it in place, which encryption gets in the way of. */
async function isEncrypted(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  return !!doc.context.trailerInfo.Encrypt;
}

export interface SignOptions {
  reason?: string;
  location?: string;
  contact?: string;
  /** A visible box on a page; omit for an invisible signature. */
  visible?: { page: number; corner: 'bl' | 'br' | 'tl' | 'tr' };
}

async function appearance(doc: PDFDocument, page: PDFPage, id: DigitalId, o: SignOptions, w: number, hgt: number) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const lines: [typeof font, number, string][] = [
    [font, 7.5, 'Digitally signed by'],
    [bold, 11, id.name],
    [font, 7.5, `Date: ${new Date().toLocaleString()}`],
    ...(o.reason ? [[font, 7.5, `Reason: ${o.reason}`] as [typeof font, number, string]] : []),
    ...(o.location ? [[font, 7.5, `Location: ${o.location}`] as [typeof font, number, string]] : []),
  ];
  const ops = ['q', '0.96 0.97 1 rg', `0 0 ${w} ${hgt} re f`, '0.25 0.45 0.85 RG', '1 w', `0.5 0.5 ${w - 1} ${hgt - 1} re S`, 'BT', '0.12 0.12 0.12 rg'];
  let y = hgt - 6;
  for (const [f, size, text] of lines) {
    y -= size * 1.2;
    // Shrink long lines to fit the box.
    const t = safeText(f, text);
    const s = Math.min(size, ((w - 12) / Math.max(1, f.widthOfTextAtSize(t, 1))) * 0.98);
    ops.push(`/${f === bold ? 'F2' : 'F1'} ${s.toFixed(2)} Tf`, `1 0 0 1 6 ${y.toFixed(2)} Tm`, `${f.encodeText(t).toString()} Tj`);
  }
  ops.push('ET', 'Q');
  const matrix = uprightMatrix(visualFrame(page).rotation);
  const stream = doc.context.stream(ops.join('\n'), {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, w, hgt],
    Matrix: matrix,
    Resources: { Font: { F1: font.ref, F2: bold.ref } },
  });
  return doc.context.register(stream);
}

export async function signPdf(src: PdfSource, id: DigitalId, o: SignOptions): Promise<Uint8Array> {
  if (src.password !== undefined || (await isEncrypted(src.bytes))) {
    throw new Error('This PDF is encrypted. Remove its password with the Unlock tool first, then sign the unlocked copy.');
  }
  const doc = await PDFDocument.load(src.bytes, { forIncrementalUpdate: true, updateMetadata: false });
  const ctx = doc.context;
  const N = (s: string) => PDFName.of(s);

  const sig = ctx.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [0, PLACEHOLDER, PLACEHOLDER, PLACEHOLDER],
  });
  sig.set(N('Contents'), PDFHexString.of('0'.repeat(SIG_BYTES * 2)));
  sig.set(N('M'), PDFString.fromDate(new Date()));
  sig.set(N('Name'), PDFHexString.fromText(id.name));
  if (o.reason) sig.set(N('Reason'), PDFHexString.fromText(o.reason));
  if (o.location) sig.set(N('Location'), PDFHexString.fromText(o.location));
  if (o.contact) sig.set(N('ContactInfo'), PDFHexString.fromText(o.contact));
  const sigRef = ctx.register(sig);

  // Unique field name.
  const acro = doc.catalog.lookupMaybe(N('AcroForm'), PDFDict) ?? ctx.obj({});
  const fields = acro.lookupMaybe(N('Fields'), PDFArray) ?? ctx.obj([]);
  const taken = new Set(fields.asArray().map((r) => textOf(ctx.lookupMaybe(r, PDFDict)?.get(N('T')))));
  let n = 1;
  while (taken.has(`Signature${n}`)) n++;

  const pageIndex = Math.max(0, Math.min(doc.getPageCount() - 1, (o.visible?.page ?? 1) - 1));
  const page = doc.getPage(pageIndex);
  const widget = ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', F: 132, Rect: [0, 0, 0, 0], P: page.ref });
  widget.set(N('T'), PDFHexString.fromText(`Signature${n}`));
  widget.set(N('V'), sigRef);
  if (o.visible) {
    const frame = visualFrame(page);
    const [w, hgt, m] = [200, 62, 36];
    const vx = o.visible.corner[1] === 'l' ? m : frame.width - m - w;
    const vy = o.visible.corner[0] === 't' ? m : frame.height - m - hgt;
    widget.set(N('Rect'), ctx.obj(visualRect(page, vx, vy, w, hgt)));
    widget.set(N('AP'), ctx.obj({ N: await appearance(doc, page, id, o, w, hgt) }));
  }
  const widgetRef = ctx.register(widget);

  // Not page.node.addAnnot(): that first "normalizes" the page, wrapping its
  // content and rewriting its resources, which a validator rightly reports as
  // the page changing after earlier signatures. Only the annotation list may change.
  const annots = page.node.lookupMaybe(N('Annots'), PDFArray);
  if (annots) annots.push(widgetRef);
  // Re-set direct containers on their parent so the incremental update picks them up.
  if (!annots || !ctx.getObjectRef(annots)) page.node.set(N('Annots'), annots ?? ctx.obj([widgetRef]));
  fields.push(widgetRef);
  acro.set(N('Fields'), fields);
  acro.set(N('SigFlags'), PDFNumber.of(3));
  doc.catalog.set(N('AcroForm'), ctx.getObjectRef(acro) ?? acro);

  // Object streams would compress the signature dictionary and hide the placeholders.
  const out = await doc.save({ useObjectStreams: false });

  const text = new TextDecoder('latin1').decode(out);
  const hole = `<${'0'.repeat(SIG_BYTES * 2)}>`;
  const start = text.lastIndexOf(hole);
  if (start < 0) throw new Error('Could not find the space reserved for the signature.');
  const end = start + hole.length;
  const brAt = text.lastIndexOf('/ByteRange', start);
  const open = text.indexOf('[', brAt);
  const close = text.indexOf(']', open);
  if (brAt < 0 || open < 0 || close < 0 || close > start) throw new Error('Could not find the signature’s byte range.');
  const range = `[0 ${start} ${end} ${out.length - end}]`;
  const slot = close - open + 1;
  if (range.length > slot) throw new Error('This file is too large to sign.');
  out.set(new TextEncoder().encode(range.padEnd(slot, ' ')), open);

  const signed = new Uint8Array(out.length - hole.length);
  signed.set(out.subarray(0, start));
  signed.set(out.subarray(end), start);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(toBinary(signed));
  p7.addCertificate(id.cert);
  for (const c of id.chain) p7.addCertificate(c);
  p7.addSigner({
    key: id.key,
    certificate: id.cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime },
    ],
  });
  p7.sign({ detached: true });
  const der = forge.asn1.toDer(withCertificateIssuer(p7.toAsn1(), id.cert)).getBytes();
  if (der.length > SIG_BYTES) throw new Error('This digital ID’s certificate chain is too long to fit.');
  const hex = [...der].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(SIG_BYTES * 2, '0');
  out.set(new TextEncoder().encode(hex), start + 1);
  return out;
}

/* ---------- checking existing signatures ---------- */

export interface SignatureInfo {
  field: string;
  signer: string;
  issuer: string;
  selfSigned: boolean;
  signedAt?: Date;
  reason?: string;
  /** The bytes it covers are unchanged since signing. */
  intact: boolean | null;
  /** The signer's key really made this signature. */
  genuine: boolean | null;
  /** Later changes were added after this signature. */
  coversWholeFile: boolean;
  note?: string;
}

const DIGESTS: Record<string, { web: string; forge: () => Forge.md.MessageDigest }> = {
  [forge.pki.oids.sha256]: { web: 'SHA-256', forge: () => forge.md.sha256.create() },
  [forge.pki.oids.sha1]: { web: 'SHA-1', forge: () => forge.md.sha1.create() },
  [forge.pki.oids.sha384]: { web: 'SHA-384', forge: () => forge.md.sha384.create() },
  [forge.pki.oids.sha512]: { web: 'SHA-512', forge: () => forge.md.sha512.create() },
};

/** The signature blob without the zeros that pad out its reserved space, read off its DER length. */
function withoutPadding(der: Uint8Array) {
  if (der.length < 2) return der;
  const first = der[1];
  if (first < 0x80) return der.subarray(0, 2 + first);
  const n = first & 0x7f;
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + der[2 + i];
  return der.subarray(0, Math.min(der.length, 2 + n + len));
}

type Asn = Forge.asn1.Asn1;
const kids = (a: Asn) => (Array.isArray(a.value) ? (a.value as Asn[]) : []);

async function checkOne(bytes: Uint8Array, field: string, v: PDFDict): Promise<SignatureInfo> {
  const N = (s: string) => PDFName.of(s);
  const base: SignatureInfo = {
    field,
    signer: textOf(v.get(N('Name'))) || 'Unknown signer',
    issuer: '',
    selfSigned: false,
    reason: textOf(v.get(N('Reason'))) || undefined,
    intact: null,
    genuine: null,
    coversWholeFile: false,
  };
  const br = v.lookupMaybe(N('ByteRange'), PDFArray)?.asArray().map((x) => (x as PDFNumber).asNumber());
  const contents = v.get(N('Contents'));
  if (!br || br.length !== 4 || !(contents instanceof PDFHexString || contents instanceof PDFString)) return { ...base, note: 'This signature is incomplete.' };
  base.coversWholeFile = br[2] + br[3] === bytes.length;
  const sub = v.get(N('SubFilter'))?.toString();
  if (sub !== '/adbe.pkcs7.detached' && sub !== '/ETSI.CAdES.detached') return { ...base, note: `Folio can’t check signatures of type ${sub ?? 'unknown'}.` };
  try {
    const msg = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(toBinary(withoutPadding(contents.asBytes())))) as Forge.pkcs7.PkcsSignedData & { rawCapture: Record<string, unknown> };
    const raw = msg.rawCapture.signerInfos as Asn[] | Asn;
    const info = (Array.isArray(raw) ? raw : kids(raw))[0];
    const parts = kids(info);
    const serial = forge.util.bytesToHex(kids(parts[1])[1]?.value as string);
    const cert = msg.certificates.find((c) => c.serialNumber.replace(/^0+/, '') === serial.replace(/^0+/, '')) ?? msg.certificates[0];
    if (cert) {
      base.signer = certName(cert);
      base.issuer = attr(cert, 'CN', 'issuer') || attr(cert, 'O', 'issuer');
      base.selfSigned = cert.isIssuer(cert);
    }
    const digestOid = forge.asn1.derToOid(kids(parts[2])[0].value as string);
    const digest = DIGESTS[digestOid];
    const attrs = parts.find((p) => p.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && p.type === 0);
    const sigValue = parts.find((p) => p.tagClass === forge.asn1.Class.UNIVERSAL && p.type === forge.asn1.Type.OCTETSTRING);
    if (!digest || !attrs || !sigValue) return { ...base, note: 'Folio can’t check this kind of signature.' };
    let expected = '';
    for (const a of kids(attrs)) {
      const [oid, set] = kids(a);
      const id = forge.asn1.derToOid(oid.value as string);
      if (id === forge.pki.oids.messageDigest) expected = kids(set)[0].value as string;
      if (id === forge.pki.oids.signingTime) base.signedAt = forge.asn1.utcTimeToDate(kids(set)[0].value as string);
    }
    const covered = new Uint8Array(br[1] + br[3]);
    covered.set(bytes.subarray(br[0], br[0] + br[1]));
    covered.set(bytes.subarray(br[2], br[2] + br[3]), br[1]);
    const actual = toBinary(new Uint8Array(await crypto.subtle.digest(digest.web, covered)));
    base.intact = actual === expected;
    try {
      const der = forge.asn1.toDer(forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, kids(attrs))).getBytes();
      const md = digest.forge();
      md.update(der);
      base.genuine = (cert.publicKey as Forge.pki.rsa.PublicKey).verify(md.digest().getBytes(), sigValue.value as string);
    } catch {
      base.genuine = null;
    }
    return base;
  } catch (err) {
    console.error(err);
    return { ...base, note: 'Folio couldn’t read this signature.' };
  }
}

/** Every signed signature field in the file, checked. */
export async function listSignatures(src: PdfSource): Promise<SignatureInfo[]> {
  const doc = await PDFDocument.load(src.bytes, { ignoreEncryption: true, updateMetadata: false });
  const N = (s: string) => PDFName.of(s);
  const checks: Promise<SignatureInfo>[] = [];
  const acro = doc.catalog.lookupMaybe(N('AcroForm'), PDFDict);
  const walk = (arr: PDFArray | undefined, prefix: string, depth: number) => {
    for (const r of arr?.asArray() ?? []) {
      const d = doc.context.lookupMaybe(r, PDFDict);
      if (!d || depth > 32) continue;
      const name = [prefix, textOf(d.get(N('T')))].filter(Boolean).join('.');
      const v = d.lookupMaybe(N('V'), PDFDict);
      if (d.get(N('FT'))?.toString() === '/Sig' && v) checks.push(checkOne(src.bytes, name, v));
      walk(d.lookupMaybe(N('Kids'), PDFArray), name, depth + 1);
    }
  };
  walk(acro?.lookupMaybe(N('Fields'), PDFArray), '', 0);
  return Promise.all(checks);
}
