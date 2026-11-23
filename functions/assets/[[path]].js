// Cloudflare Pages Function: serves /assets/* (plan PDFs, photos) from R2 binding BUCKET, with Range support for PDF.js.
export async function onRequestGet({ request, env, params }) {
  if (!env.BUCKET) return new Response('R2 binding BUCKET not configured', { status: 501 });
  const key = (Array.isArray(params.path) ? params.path : [params.path]).join('/');
  const range = request.headers.get('range');
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  const head = await env.BUCKET.head(key);
  if (!head) return new Response('Not found', { status: 404 });
  const size = head.size;
  const type = key.endsWith('.pdf') ? 'application/pdf' : (head.httpMetadata && head.httpMetadata.contentType) || 'application/octet-stream';
  const base = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=86400', etag: head.httpEtag };
  if (m) {
    const start = m[1] ? +m[1] : 0;
    const end = Math.min(m[2] ? +m[2] : size - 1, size - 1);
    const obj = await env.BUCKET.get(key, { range: { offset: start, length: end - start + 1 } });
    return new Response(obj.body, { status: 206, headers: { ...base, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) } });
  }
  const obj = await env.BUCKET.get(key);
  return new Response(obj.body, { headers: { ...base, 'content-length': String(size) } });
}
