// Cloudflare Pages Function: GET/PUT /api/state  (pins + manual photo links), stored in KV binding STATE.
// Optional: set secret EDIT_TOKEN to require "Authorization: Bearer <token>" for PUT.
// Better: put the whole site behind Cloudflare Access.
const KEY = 'state-v1';
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export async function onRequestGet({ env }) {
  if (!env.STATE) return json({ error: 'KV binding STATE not configured' }, 501);
  const v = await env.STATE.get(KEY);
  return new Response(v || '{"pins":[],"photoLinks":{}}', { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

export async function onRequestPut({ request, env }) {
  if (!env.STATE) return json({ error: 'KV binding STATE not configured' }, 501);
  if (env.EDIT_TOKEN && request.headers.get('authorization') !== `Bearer ${env.EDIT_TOKEN}`) return json({ error: 'unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (!body || !Array.isArray(body.pins)) return json({ error: 'invalid state' }, 400);
  const clean = {
    pins: body.pins.slice(0, 20000).map(p => ({ id: String(p.id), plan: String(p.plan), page: p.page | 0, x: +p.x, y: +p.y, item: String(p.item), asset: p.asset ? String(p.asset).slice(0, 80) : undefined, label: p.label ? String(p.label).slice(0, 80) : '' })),
    photoLinks: body.photoLinks && typeof body.photoLinks === 'object' ? body.photoLinks : {},
    updated: new Date().toISOString(),
  };
  await env.STATE.put(KEY, JSON.stringify(clean));
  return json({ ok: true, updated: clean.updated });
}
