// UTIF.js ships without types; this covers the calls Folio makes.
declare module 'utif' {
  type Ifd = Record<string, unknown> & { width: number; height: number };
  const UTIF: {
    decode(buffer: ArrayBuffer): Ifd[];
    decodeImage(buffer: ArrayBuffer, ifd: Ifd): void;
    toRGBA8(ifd: Ifd): Uint8Array;
  };
  export default UTIF;
}
