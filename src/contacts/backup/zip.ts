// ZIP mínimo (método STORE, sem compressão) pro export do Console — sem
// dependência externa. JSONL é texto repetitivo, mas o volume atual do vault é
// pequeno (poucos MB); se um dia apertar, trocar por DEFLATE via CompressionStream.
//
// Estrutura clássica: local file headers + central directory + EOCD, tudo
// little-endian. Flag 0x0800 marca nomes UTF-8. Sem ZIP64 (snapshot << 4GB).

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

// Tabela CRC-32 (polinômio 0xEDB88320, o padrão do ZIP).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Data/hora no formato DOS (2s de resolução) exigido pelos headers do ZIP.
function dosDateTime(d: Date): { time: number; date: number } {
  const time =
    (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const date =
    ((Math.max(0, d.getUTCFullYear() - 1980) & 0x7f) << 9) |
    ((d.getUTCMonth() + 1) << 5) |
    d.getUTCDate();
  return { time, date };
}

export function buildZip(entries: ZipEntry[], now = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(now);

  const prepared = entries.map((e) => ({
    nameBytes: encoder.encode(e.name),
    data: e.data,
    crc: crc32(e.data),
  }));

  const localSize = prepared.reduce((a, p) => a + 30 + p.nameBytes.length + p.data.length, 0);
  const centralSize = prepared.reduce((a, p) => a + 46 + p.nameBytes.length, 0);
  const total = localSize + centralSize + 22; // +EOCD

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  const offsets: number[] = [];

  // Local file headers + dados (STORE: compSize == uncompSize, sem transformação).
  for (const p of prepared) {
    offsets.push(offset);
    view.setUint32(offset, 0x04034b50, true); // assinatura local
    view.setUint16(offset + 4, 20, true); // versão mínima (2.0)
    view.setUint16(offset + 6, 0x0800, true); // flags: nome em UTF-8
    view.setUint16(offset + 8, 0, true); // método 0 = STORE
    view.setUint16(offset + 10, time, true);
    view.setUint16(offset + 12, date, true);
    view.setUint32(offset + 14, p.crc, true);
    view.setUint32(offset + 18, p.data.length, true); // compressed
    view.setUint32(offset + 22, p.data.length, true); // uncompressed
    view.setUint16(offset + 26, p.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true); // extra len
    out.set(p.nameBytes, offset + 30);
    out.set(p.data, offset + 30 + p.nameBytes.length);
    offset += 30 + p.nameBytes.length + p.data.length;
  }

  // Central directory.
  const centralStart = offset;
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    view.setUint32(offset, 0x02014b50, true); // assinatura central
    view.setUint16(offset + 4, 20, true); // made by
    view.setUint16(offset + 6, 20, true); // versão mínima
    view.setUint16(offset + 8, 0x0800, true); // flags UTF-8
    view.setUint16(offset + 10, 0, true); // método STORE
    view.setUint16(offset + 12, time, true);
    view.setUint16(offset + 14, date, true);
    view.setUint32(offset + 16, p.crc, true);
    view.setUint32(offset + 20, p.data.length, true);
    view.setUint32(offset + 24, p.data.length, true);
    view.setUint16(offset + 28, p.nameBytes.length, true);
    view.setUint16(offset + 30, 0, true); // extra len
    view.setUint16(offset + 32, 0, true); // comment len
    view.setUint16(offset + 34, 0, true); // disco
    view.setUint16(offset + 36, 0, true); // atributos internos
    view.setUint32(offset + 38, 0, true); // atributos externos
    view.setUint32(offset + 42, offsets[i], true); // offset do local header
    out.set(p.nameBytes, offset + 46);
    offset += 46 + p.nameBytes.length;
  }

  // End of central directory.
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 4, 0, true); // disco
  view.setUint16(offset + 6, 0, true); // disco do CD
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, offset - centralStart, true); // tamanho do CD
  view.setUint32(offset + 16, centralStart, true); // offset do CD
  view.setUint16(offset + 20, 0, true); // comment len

  return out;
}
