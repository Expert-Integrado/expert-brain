// Servidor de mídia (avatares) do R2 — extraído do index.ts (spec 20-frontend/24)
// pra ser compartilhado entre a rota da API `GET /media/:hash` (Bearer) e o
// espelho do Console `GET /app/media/:hash` (sessão), sem ciclo de import
// index.ts <-> web/handler.ts.

import type { Env } from "./env";

const mediaErr = (status: number, message: string) =>
  new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export async function handleGetMedia(hash: string, env: Env): Promise<Response> {
  if (!env.MEDIA) return mediaErr(503, "R2 bucket not configured");
  for (const ext of ["jpg", "png", "webp", "ogg", "mp3", "bin"]) {
    const obj = await env.MEDIA.get(`sha256/${hash}.${ext}`);
    if (obj) {
      const headers = new Headers();
      headers.set("content-type", obj.httpMetadata?.contentType || "application/octet-stream");
      headers.set("cache-control", "private, max-age=3600");
      return new Response(obj.body, { headers });
    }
  }
  return mediaErr(404, "media not found");
}
