// Leitor ZIP mínimo pros testes (specs/50-console-v2/67-backup-export.md):
// parseia EOCD + diretório central, valida CRC e tamanhos e inflaciona
// deflate-raw com DecompressionStream — verificação INDEPENDENTE do escritor
// (src/backup/zip.ts), sem dependência externa (adm-zip não roda no workerd).
import { crc32 } from '../../src/backup/zip.js';

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(data).body!.pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzip(buf: Uint8Array): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // EOCD: assinatura procurada de trás pra frente (comentário pode ter até 64 KB).
  let eocd = -1;
  const stop = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('EOCD não encontrado — ZIP inválido');
  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);

  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('entrada do diretório central inválida');
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));

    if (dv.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`local header inválido em ${name}`);
    const lNameLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + csize);
    const data = method === 8 ? await inflateRaw(raw) : raw.slice();
    if (data.length !== usize) throw new Error(`tamanho descomprimido errado em ${name}`);
    if (crc32(data) !== crc) throw new Error(`CRC divergente em ${name}`);
    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
