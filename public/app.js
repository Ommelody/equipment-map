'use strict';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS_STATE = 'eqmap-state-v1', LS_TOKEN = 'eqmap-token';

let CAT = null;                       // catalog.json
let state = { pins: [], photoLinks: {} };
let apiOK = false;
let itemById = {}, photoById = {}, planById = {};
let tab = 'plans', editMode = false;
let curPlan = null, pdfDoc = null, pageNo = 1, zoom = 1, fitZoom = 1, baseW = 0, baseH = 0, renderTok = 0;
let curItem = null, selPin = null, curAsset = null;   // curAsset = asset code chosen for the next pin
let assetsByItem = {}, assetByCode = {};
const docCache = new Map(), bmpCache = new Map(); let renderTask = null;   // opened PDFs / fit-size renders, so reopening a plan is instant
let shown = 150;                      // list paging

/* ---------------- storage ---------------- */
let saveTimer = null;
function setSync(txt, cls) { const e = $('syncState'); e.textContent = txt; e.className = 'sync ' + (cls || ''); }
function lsSave() { try { localStorage.setItem(LS_STATE, JSON.stringify(state)); } catch { } }
const SHEET = (window.CFG && window.CFG.api) || '';   // Google Apps Script web app URL (Sheet = database, Drive = files)
const DRIVE_KEY = (window.CFG && window.CFG.driveKey) || '';   // optional Google API key (HTTP-referrer restricted) for fast direct plan download
const PLANS_BASE = ((window.CFG && window.CFG.plansBase) || '').replace(/\/$/, '');   // e.g. http://localhost:3131/assets/plans
let FILES = { plans: {}, photos: {} };
async function sheetGet(q) { const r = await fetch(SHEET + '?' + q, { cache: 'no-store' }); const j = await r.json(); if (j.error) throw new Error(j.error); return j; }
async function loadPlanBytes(file, onProgress) {
  const id = FILES.plans[file]; if (!id) throw new Error('ไม่พบไฟล์ ' + file + ' ใน Google Drive (รัน buildIndex แล้วหรือยัง?)');
  const ckey = 'https://plans.local/' + id;                     // browser cache: a plan downloaded once opens instantly next time
  try { const c = await caches.open('eqmap-plans'), hit = await c.match(ckey); if (hit) return new Uint8Array(await hit.arrayBuffer()); } catch { }
  let bytes = null;
  if (DRIVE_KEY) {                                              // fast path: direct Drive API download (file must be shared "Anyone with the link")
    try { bytes = await loadPlanBytesDirect(id, onProgress); } catch (e) { console.warn('direct Drive load failed, falling back to Apps Script:', e.message); }
  }
  if (!bytes) bytes = await loadPlanBytesNet(id, onProgress);
  try { const c = await caches.open('eqmap-plans'); await c.put(ckey, new Response(bytes)); } catch { }
  return bytes;
}
async function loadPlanBytesDirect(id, onProgress) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&key=${encodeURIComponent(DRIVE_KEY)}`);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const total = +r.headers.get('content-length') || 0, rd = r.body.getReader(), parts = []; let got = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; if (onProgress && total) onProgress(got / total); }
  const out = new Uint8Array(got); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  if (got < 1000 || String.fromCharCode(out[0], out[1], out[2], out[3]) !== '%PDF') throw new Error('not a PDF');
  return out;
}
async function loadPlanBytesNet(id, onProgress) {
  const size = 2 * 1024 * 1024; let first = await sheetGet(`action=chunk&id=${id}&n=0&size=${size}`);
  const total = first.total, out = new Uint8Array(total), put = (n, b64) => { const bin = atob(b64); const off = n * size; for (let i = 0; i < bin.length; i++) out[off + i] = bin.charCodeAt(i); };
  put(0, first.data); onProgress && onProgress(Math.min(1, size / total));
  const n = Math.ceil(total / size); let done = 1;
  const queue = Array.from({ length: n - 1 }, (_, k) => k + 1);
  await Promise.all(Array.from({ length: 10 }, async () => { while (queue.length) { const k = queue.shift(); const c = await sheetGet(`action=chunk&id=${id}&n=${k}&size=${size}`); put(k, c.data); done++; onProgress && onProgress(done / n); } }));
  return out;
}
async function loadState() {
  if (SHEET) {
    try {
      const [st, fl] = await Promise.all([sheetGet('action=state'), sheetGet('action=files')]);
      state = Object.assign({ pins: [], photoLinks: {} }, st); FILES = fl; apiOK = true; setSync('● ซิงก์กับ Google Sheet', 'ok'); return;
    } catch (e) { setSync('✕ เชื่อม Google Sheet ไม่ได้: ' + e.message, 'err'); }
    try { const s = JSON.parse(localStorage.getItem(LS_STATE) || 'null'); if (s) state = Object.assign({ pins: [], photoLinks: {} }, s); } catch { }
    return;
  }
  try {
    const r = await fetch('api/state', { cache: 'no-store' });
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) {
      state = Object.assign({ pins: [], photoLinks: {} }, await r.json()); apiOK = true; setSync('● ซิงก์กับเซิร์ฟเวอร์', 'ok'); return;
    }
  } catch { }
  try { const s = JSON.parse(localStorage.getItem(LS_STATE) || 'null'); if (s) state = Object.assign({ pins: [], photoLinks: {} }, s); } catch { }
  setSync('○ บันทึกในเบราว์เซอร์นี้เท่านั้น', '');
}
function save() {
  lsSave();
  if (!apiOK) return;
  setSync('… กำลังบันทึก', '');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const tok = localStorage.getItem(LS_TOKEN);
      if (SHEET) {
        const r = await fetch(SHEET, { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token: tok || undefined, state }) });
        const j = await r.json();
        if (j.status === 401) { const t = prompt('ใส่รหัสสำหรับแก้ไข (EDIT_TOKEN)'); if (t) { localStorage.setItem(LS_TOKEN, t); return save(); } setSync('✕ ไม่มีสิทธิ์บันทึก', 'err'); return; }
        if (j.error) throw new Error(j.error);
        setSync('● บันทึกลง Google Sheet แล้ว', 'ok'); return;
      }
      const r = await fetch('api/state', { method: 'PUT', headers: Object.assign({ 'content-type': 'application/json' }, tok ? { authorization: 'Bearer ' + tok } : {}), body: JSON.stringify(state) });
      if (r.status === 401) { const t = prompt('ใส่รหัสสำหรับแก้ไข (EDIT_TOKEN)'); if (t) { localStorage.setItem(LS_TOKEN, t); return save(); } setSync('✕ ไม่มีสิทธิ์บันทึก', 'err'); return; }
      if (!r.ok) throw new Error(r.status);
      setSync('● บันทึกแล้ว', 'ok');
    } catch (e) { setSync('✕ บันทึกไม่สำเร็จ (เก็บไว้ในเครื่อง)', 'err'); }
  }, 600);
}
function toast(t) { const e = $('toast'); e.textContent = t; e.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => e.hidden = true, 2200); }

/* ---------------- helpers ---------------- */
const aUrl = (kind, file, big) => SHEET && FILES[kind] ? `https://drive.google.com/thumbnail?id=${FILES[kind][file] || ''}&sz=w${big ? 2000 : 600}` : `${CAT.assetBase}/${kind}/${file}`;
const pinsOfItem = id => state.pins.filter(p => p.item === id);
const pinsOfPlan = () => state.pins.filter(p => curPlan && p.plan === curPlan.id && p.page === pageNo);
const itemPhotos = it => { const ids = new Set([...(it.photos || []), ...(state.photoLinks[it.id] || [])]); return [...ids].map(i => photoById[i]).filter(Boolean); };
const floorLbl = f => !f ? '—' : /^\d+$/.test(f) ? 'ชั้น ' + f : (f === 'B' ? 'ชั้นใต้ดิน (B)' : f);
const catName = id => (CAT.categories.find(c => c.id === id) || {}).name || id;
const uid = () => 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ---------------- left lists ---------------- */
function filteredItems() {
  const cat = $('catSel').value, fl = $('floorSel').value, q = $('q').value.trim().toLowerCase(), un = $('onlyUnpinned').checked;
  return CAT.items.filter(it => {
    if (cat && it.cat !== cat) return false;
    if (fl && (it.floor || '') !== fl) return false;
    if (un && pinsOfItem(it.id).length >= Math.max(1, it.qty || 1)) return false;
    if (q && !(`${it.name} ${it.brand} ${it.model} ${it.location} ${it.group || ''} ${(assetsByItem[it.id] || []).map(a => a.c + ' ' + a.s).join(' ')}`.toLowerCase().includes(q))) return false;
    return true;
  });
}
function refreshFloors() {
  const cat = $('catSel').value, s = $('floorSel'), keep = s.value;
  const set = new Set(CAT.items.filter(i => !cat || i.cat === cat).map(i => i.floor || ''));
  const arr = [...set].sort((a, b) => (+a || 99) - (+b || 99) || a.localeCompare(b));
  s.innerHTML = '<option value="">ทุกชั้น</option>' + arr.map(f => `<option value="${esc(f)}">${f ? floorLbl(f) : '(ไม่ระบุชั้น)'}</option>`).join('');
  if (arr.includes(keep)) s.value = keep;
}
function renderList() {
  const el = $('list'), cat = $('catSel').value, q = $('q').value.trim().toLowerCase();
  $('floorSel').hidden = tab !== 'items' && tab !== 'photos'; $('pinFilterWrap').hidden = tab !== 'items';
  if (tab === 'plans') {
    let arr = CAT.plans.filter(p => (!cat || p.cat === cat) && (!q || p.title.toLowerCase().includes(q)));
    const rel = curItem ? new Set(relatedPlans(curItem).map(p => p.id)) : null;   // plans for the selected item float to the top
    if (rel) arr = [...arr.filter(p => rel.has(p.id)), ...arr.filter(p => !rel.has(p.id))];
    el.innerHTML = (rel ? `<div class="grp">แปลนที่เกี่ยวข้องกับ “${esc(curItem.name.slice(0, 40))}” อยู่บนสุด</div>` : `<div class="grp">${arr.length} แปลน${cat ? ' ในหมวด ' + esc(catName(cat)) : ''}</div>`) + arr.map(p => {
      const n = state.pins.filter(x => x.plan === p.id).length;
      return `<div class="row ${curPlan && curPlan.id === p.id ? 'sel' : ''}" data-plan="${p.id}"><div class="t">${esc(p.title)}</div>
        <div class="s"><span class="badge">${esc(catName(p.cat))}</span>${p.floor ? `<span class="badge">${floorLbl(p.floor)}</span>` : ''}<span class="badge">${p.sizeMB} MB</span>${n ? `<span class="badge ok">${n} หมุด</span>` : ''}</div></div>`;
    }).join('') || '<div class="more muted">ไม่พบแปลน</div>';
  } else if (tab === 'items') {
    const arr = filteredItems(); const slice = arr.slice(0, shown);
    el.innerHTML = `<div class="grp">${arr.length.toLocaleString()} รายการ</div>` + slice.map(it => {
      const n = pinsOfItem(it.id).length, ph = itemPhotos(it).length, need = Math.max(1, it.qty || 1);
      return `<div class="row ${curItem && curItem.id === it.id ? 'sel' : ''}" data-item="${it.id}"><div class="t">${esc(it.name)}</div>
        <div class="s">${esc([it.brand, it.model].filter(Boolean).join(' · '))}</div>
        <div class="s"><span class="badge">${floorLbl(it.floor)}</span>${it.location ? `<span class="badge">${esc(it.location.slice(0, 40))}</span>` : ''}
        <span class="badge ${n ? 'ok' : ''}">หมุด ${n}/${need}</span>${(assetsByItem[it.id] || []).length ? `<span class="badge cam">เลขครุภัณฑ์ ${assetsByItem[it.id].length}</span>` : ''}${ph ? `<span class="badge cam">📷 ${ph}</span>` : ''}</div></div>`;
    }).join('') + (arr.length > shown ? `<div class="more"><button class="ghost" id="moreBtn">แสดงเพิ่ม</button></div>` : '');
  } else if (tab === 'progress') {
    el.innerHTML = renderProgress();
  } else {
    el.innerHTML = `<div class="grp">แกลเลอรีรูปภาพ</div><p class="muted" style="padding:10px">เลือกหมวด/ชั้น/คำค้นด้านบน ผลลัพธ์แสดงเป็นแกลเลอรีทางขวา คลิกรูปเพื่อดูภาพใหญ่ ข้อมูลรายการ และไปที่หมุดบนแปลน</p>`;
    renderGallery();
  }
  document.body.classList.toggle('gal', tab === 'photos');
}

/* ---------------- photo gallery ---------------- */
let photoItemMap = null;
function photoItems(pid) {
  if (!photoItemMap) { photoItemMap = {}; CAT.items.forEach(it => (it.photos || []).forEach(p => (photoItemMap[p] = photoItemMap[p] || []).push(it))); }
  const out = [...(photoItemMap[pid] || [])];
  for (const [iid, ids] of Object.entries(state.photoLinks)) if (ids.includes(pid) && itemById[iid] && !out.includes(itemById[iid])) out.push(itemById[iid]);
  return out;
}
function renderGallery() {
  const cat = $('catSel').value, fl = $('floorSel').value, q = $('q').value.trim().toLowerCase();
  const arr = CAT.photos.filter(p => {
    if (cat && p.cat !== cat) return false;
    if (fl && !photoItems(p.id).some(it => (it.floor || '') === fl)) return false;
    if (q && !`${p.name} ${p.brand} ${p.sheet} ${photoItems(p.id).map(i => i.name).join(' ')}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const counts = {}; CAT.photos.forEach(p => counts[p.cat] = (counts[p.cat] || 0) + 1);
  $('galChips').innerHTML = `<button class="chip ${!cat ? 'on' : ''}" data-gcat="">ทั้งหมด (${CAT.photos.length})</button>` + CAT.categories.filter(c => counts[c.id]).map(c => `<button class="chip ${cat === c.id ? 'on' : ''}" data-gcat="${c.id}">${esc(c.name)} (${counts[c.id]})</button>`).join('');
  $('galCount').textContent = arr.length.toLocaleString() + ' รูป';
  const slice = arr.slice(0, Math.max(shown, 150));
  $('galGrid').innerHTML = slice.map(p => {
    const its = photoItems(p.id), it = its[0];
    return `<div class="gcard" data-photo="${p.id}"><img loading="lazy" src="${aUrl('photos', p.file)}" alt=""><div><div class="n">${esc(it ? it.name : (p.name || p.sheet || 'ไม่ระบุชื่อ'))}</div><div class="muted">${it ? floorLbl(it.floor) : 'ยังไม่ผูกรายการ'}${p.brand ? ' · ' + esc(p.brand) : ''}</div></div>
      ${curItem && !its.includes(curItem) ? `<button class="ghost" style="width:100%;border-radius:0" data-link="${p.id}">+ ผูกกับรายการที่เลือก</button>` : ''}</div>`;
  }).join('') + (arr.length > slice.length ? `<div class="more" style="grid-column:1/-1"><button class="ghost" id="galMore">แสดงเพิ่ม</button></div>` : '') || '<p class="muted" style="padding:20px">ไม่พบรูปในเงื่อนไขนี้</p>';
}
$('galChips').addEventListener('click', e => { const b = e.target.closest('[data-gcat]'); if (!b) return; $('catSel').value = b.dataset.gcat; refreshFloors(); shown = 150; renderList(); });
$('galGrid').addEventListener('click', e => {
  if (e.target.id === 'galMore') { shown += 150; renderGallery(); return; }
  const lk = e.target.closest('[data-link]');
  if (lk) { e.stopPropagation(); const l = state.photoLinks[curItem.id] = state.photoLinks[curItem.id] || []; if (!l.includes(lk.dataset.link)) { l.push(lk.dataset.link); photoItemMap = null; save(); renderGallery(); toast('ผูกรูปกับรายการแล้ว'); } return; }
  const c = e.target.closest('[data-photo]'); if (c) openLightbox(photoById[c.dataset.photo]);
});
function openLightbox(p) {
  const its = photoItems(p.id), it = its[0];
  $('lbImg').src = aUrl('photos', p.file, true); $('lbImg').alt = p.name;
  $('lbInfo').innerHTML = it ? `<h3>${esc(it.name)}</h3><span class="badge">${esc(catName(it.cat))}</span><span class="badge">${floorLbl(it.floor)}</span>
    <dl style="display:grid;grid-template-columns:70px 1fr;gap:3px 8px;margin:10px 0">${it.brand ? `<dt class="muted">ยี่ห้อ</dt><dd style="margin:0">${esc(it.brand)}</dd>` : ''}${it.model ? `<dt class="muted">รุ่น</dt><dd style="margin:0">${esc(it.model)}</dd>` : ''}<dt class="muted">จำนวน</dt><dd style="margin:0">${it.qty || '—'} ${esc(it.unit)}</dd>${it.location ? `<dt class="muted">สถานที่</dt><dd style="margin:0">${esc(it.location)}</dd>` : ''}</dl>
    ${its.length > 1 ? `<p class="muted">รูปนี้ใช้กับอีก ${its.length - 1} รายการ</p>` : ''}
    ${(() => { const pn = pinsOfItem(it.id); return `<button id="lbGoto" data-lbitem="${it.id}" ${pn.length ? '' : 'disabled title="รายการนี้ยังไม่ได้ปักหมุด"'}>📍 ไปที่หมุดบนแปลน${pn.length ? ' (' + pn.length + ')' : ''}</button>`; })()}`
    : `<h3>${esc(p.name || p.sheet || 'ไม่ระบุชื่อ')}</h3><p class="muted">รูปนี้ยังไม่ผูกกับรายการครุภัณฑ์ ไปที่แท็บ “ครุภัณฑ์” เลือกรายการ แล้วกลับมากด “ผูกกับรายการที่เลือก”</p>`;
  $('lightbox').hidden = false;
}
$('lightbox').addEventListener('click', e => {
  const g = e.target.closest('#lbGoto');
  if (g) { if (g.disabled) return; const it = itemById[g.dataset.lbitem]; $('lightbox').hidden = true; setTab('items'); selectItem(it, { focusPin: true }); return; }
  if (e.target.closest('#lbInfo')) return;
  $('lightbox').hidden = true;
});

/* ---------------- progress dashboard ---------------- */
function progStats(items) {
  let done = 0, pinned = 0, withAsset = 0;
  for (const it of items) { const n = pinsOfItem(it.id).length; if (n >= Math.max(1, it.qty || 1)) done++; if (n) pinned++; if ((assetsByItem[it.id] || []).length) withAsset++; }
  return { total: items.length, done, pinned, withAsset };
}
const pct = (a, b) => b ? Math.round(a * 100 / b) : 0;
function progRow(label, s, attr) {
  return `<div class="prow" ${attr}><div class="nm"><span>${esc(label)}</span><span class="muted">${s.done}/${s.total} · ${pct(s.done, s.total)}%</span></div><div class="bar"><i style="width:${pct(s.done, s.total)}%"></i></div></div>`;
}
function renderProgress() {
  const all = progStats(CAT.items), assetsPinned = new Set(state.pins.filter(p => p.asset).map(p => p.asset)).size;
  const byCat = CAT.categories.map(c => progRow(c.name, progStats(CAT.items.filter(i => i.cat === c.id)), `data-pcat="${c.id}"`)).join('');
  const floors = [...new Set(CAT.items.map(i => i.floor || ''))].sort((a, b) => (+a || 99) - (+b || 99) || a.localeCompare(b));
  const byFloor = floors.map(f => progRow(f ? floorLbl(f) : '(ไม่ระบุชั้น)', progStats(CAT.items.filter(i => (i.floor || '') === f)), `data-pfloor="${esc(f)}"`)).join('');
  return `<div class="prog"><div><div class="big">${pct(all.done, all.total)}%</div><div class="muted">ปักหมุดครบจำนวน ${all.done.toLocaleString()} / ${all.total.toLocaleString()} รายการ</div><div class="bar"><i style="width:${pct(all.done, all.total)}%"></i></div></div>
    <div class="muted">หมุดทั้งหมด ${state.pins.length.toLocaleString()} · รายการที่มีเลขครุภัณฑ์ ${all.withAsset.toLocaleString()} · เลขครุภัณฑ์ที่ปักแล้ว ${assetsPinned.toLocaleString()} / ${Object.keys(assetByCode).length.toLocaleString()}</div>
    <h3>ตามหมวดงาน (คลิกเพื่อดูรายการ)</h3>${byCat}<h3>ตามชั้น</h3>${byFloor}</div>`;
}

/* ---------------- detail panel ---------------- */
function renderDetail() {
  const d = $('detail');
  if (!curItem) { d.innerHTML = '<p class="muted">คลิกหมุดบนแปลน หรือเลือกรายการครุภัณฑ์ เพื่อดูรายละเอียดและรูปภาพ</p>'; return; }
  const it = curItem, pins = pinsOfItem(it.id), photos = itemPhotos(it);
  d.innerHTML = `<h2>${esc(it.name)}</h2>
    <span class="badge">${esc(catName(it.cat))}</span><span class="badge">${floorLbl(it.floor)}</span>
    <dl>
      ${it.brand ? `<dt>ยี่ห้อ</dt><dd>${esc(it.brand)}</dd>` : ''}${it.model ? `<dt>รุ่น</dt><dd>${esc(it.model)}</dd>` : ''}
      <dt>จำนวน</dt><dd>${it.qty || '—'} ${esc(it.unit)}</dd>
      ${it.location ? `<dt>สถานที่</dt><dd>${esc(it.location)}</dd>` : ''}${it.group ? `<dt>หมวด</dt><dd>${esc(it.group)}</dd>` : ''}
      ${it.note ? `<dt>หมายเหตุ</dt><dd>${esc(it.note)}</dd>` : ''}
      <dt>ที่มา</dt><dd class="muted" style="font-size:12px">${esc(it.source)}</dd>
    </dl>
    <div class="actions"><button id="btnPlace">📍 ปักหมุดรายการนี้</button></div>
    ${renderAssets(it)}
    <h3 style="font-size:14px;margin:16px 0 4px">แปลนที่เกี่ยวข้อง</h3>
    ${relatedPlans(it).slice(0, 8).map(p => `<div class="row" style="padding:6px 0" data-relplan="${p.id}"><div class="t" style="font-weight:400">${curPlan && curPlan.id === p.id ? '▶ ' : ''}${esc(p.title)}</div></div>`).join('') || '<p class="muted">ไม่พบแปลนในหมวดนี้</p>'}
    <h3 style="font-size:14px;margin:16px 0 4px">ตำแหน่งบนแปลน (${pins.length})</h3>
    ${pins.map(p => { const pl = planById[p.plan]; return `<div class="row" style="padding:6px 0" data-gopin="${p.id}"><div class="t" style="font-weight:400">${p.asset ? '<b>' + esc(p.asset) + '</b> · ' : ''}${esc(pl ? pl.title : p.plan)} <span class="muted">· หน้า ${p.page}</span></div>
      <div class="s"><button class="ghost" data-delpin="${p.id}">ลบหมุด</button></div></div>`; }).join('') || '<p class="muted">ยังไม่ได้ปักหมุด</p>'}
    <h3 style="font-size:14px;margin:16px 0 4px">รูปภาพ (${photos.length})</h3>
    <div class="gallery">${photos.map(p => `<div><img src="${aUrl('photos', p.file)}" data-lb="${p.id}" alt="${esc(p.name)}">${(state.photoLinks[it.id] || []).includes(p.id) ? `<button class="ghost" style="width:100%" data-unlink="${p.id}">เลิกผูก</button>` : ''}</div>`).join('') || '<p class="muted">ไม่พบรูปที่ตรงกัน — ไปแท็บ “รูปภาพ” เพื่อผูกรูปเอง</p>'}</div>`;
}
/* ---- manual re-matching of registry numbers (stored in state.matchOverrides, applied on boot) ---- */
function applyOverride(code, itemId) {
  const a = assetByCode[code]; if (!a) return;
  if (assetsByItem[a.i]) assetsByItem[a.i] = assetsByItem[a.i].filter(x => x !== a);
  a.i = itemId || ''; if (itemId) { a.how = 'manual'; a.cf = 1; (assetsByItem[itemId] = assetsByItem[itemId] || []).push(a); }
}
function setMatch(code, itemId) {
  (state.matchOverrides = state.matchOverrides || {})[code] = itemId || '';
  applyOverride(code, itemId);
  if (!itemId) state.pins.forEach(p => { if (p.asset === code) { delete p.asset; delete p.label; } });
  else state.pins.forEach(p => { if (p.asset === code && p.item !== itemId) { delete p.asset; delete p.label; } });
  save(); renderDetail(); renderList(); renderPins();
}
function openRematch(it) {
  const d = $('dlg'); d.hidden = false;
  d.innerHTML = `<div><b>แก้การจับคู่เลขครุภัณฑ์</b><div class="muted" style="font-size:12.5px">รายการ: ${esc(it.name)}</div>
    <input type="search" id="dlgQ" placeholder="ค้นหาเลขครุภัณฑ์ / ชื่อ / Serial ในทะเบียน"><div class="res" id="dlgRes"></div><div style="text-align:right"><button class="ghost" id="dlgClose">ปิด</button></div></div>`;
  const draw = () => {
    const q = $('dlgQ').value.trim().toLowerCase(), all = Object.values(assetByCode);
    const hit = (q ? all.filter(a => `${a.c} ${a.n} ${a.s} ${a.rm || ''} ${a.d || ''} ${a.loc || ''}`.toLowerCase().includes(q)) : (assetsByItem[it.id] || []).concat(all.filter(a => !a.i).slice(0, 20))).slice(0, 60);
    $('dlgRes').innerHTML = hit.map(a => `<div class="asset"><div><b>${esc(a.c)}</b> ${a.i === it.id ? '<span class="badge ok">ปัจจุบัน</span>' : a.i ? `<span class="badge">ใช้กับ: ${esc((itemById[a.i] || {}).name || a.i).slice(0, 40)}</span>` : '<span class="badge cam">ว่าง</span>'}</div>
      <div class="s muted">${esc([a.n, a.f, a.rm || a.d, a.s && 'S/N ' + a.s].filter(Boolean).join(' · '))}</div>
      ${a.i === it.id ? `<button class="ghost" data-rm="${esc(a.c)}">ปลดออกจากรายการนี้</button>` : `<button data-pick="${esc(a.c)}">จับคู่กับรายการนี้</button>`}</div>`).join('') || '<p class="muted">ไม่พบในทะเบียน</p>';
  };
  draw(); $('dlgQ').oninput = draw;
  d.onclick = e => {
    if (e.target === d || e.target.id === 'dlgClose') { d.hidden = true; return; }
    if (e.target.dataset.pick) { setMatch(e.target.dataset.pick, it.id); toast('จับคู่ด้วยมือแล้ว'); draw(); }
    if (e.target.dataset.rm) { setMatch(e.target.dataset.rm, ''); toast('ปลดเลขครุภัณฑ์แล้ว'); draw(); }
  };
}
function renderAssets(it) {
  const as = assetsByItem[it.id] || [];
  if (!as.length) return '<h3 style="font-size:14px;margin:16px 0 4px">เลขครุภัณฑ์</h3><p class="muted">ไม่พบเลขครุภัณฑ์ที่ตรงกันในทะเบียน</p><button class="ghost" id="btnRematch">แก้การจับคู่</button>';
  const pinned = new Set(state.pins.filter(p => p.item === it.id && p.asset).map(p => p.asset));
  return `<h3 style="font-size:14px;margin:16px 0 4px">เลขครุภัณฑ์ (${as.length}) <span class="muted" style="font-weight:400;font-size:12px">· ปักแล้ว ${pinned.size}</span> <button class="ghost" id="btnRematch" style="padding:1px 8px;font-size:12px">แก้การจับคู่</button></h3>
    <div class="assets">${as.slice(0, 200).map(a => `<div class="asset ${curAsset === a.c ? 'sel' : ''}" data-asset="${esc(a.c)}">
      <div><b>${esc(a.c)}</b>${a.how !== 'exact' ? ` <span class="badge" title="ความมั่นใจ ${a.cf}">${a.how === 'manual' ? 'จับคู่ด้วยมือ' : a.how.includes('excess') ? 'เกินจำนวนในเอกสาร' : 'ชื่อใกล้เคียง'}</span>` : ''}</div>
      <div class="s muted">${esc([a.n !== it.name && a.n, a.f, a.rm || a.d, a.loc, a.b, a.m, a.s && 'S/N ' + a.s, a.st].filter(Boolean).join(' · '))}</div>
      <button class="ghost" data-placeasset="${esc(a.c)}">${pinned.has(a.c) ? '✓ ปักแล้ว · ปักใหม่' : '📍 ปักหมุด'}</button></div>`).join('')}
    ${as.length > 200 ? `<p class="muted">แสดง 200 จาก ${as.length}</p>` : ''}</div>`;
}
/* item <-> plan linking: same work category + matching floor (floors parsed from the plan title) */
const normFloor = f => /ใต้ดิน|^B/i.test(f) ? 'B' : String(f).trim();
function planFloors(p) {
  const out = new Set(); const m = (p.title || '').match(/ชั้น\s*([^\s]*(?:\s*,\s*\d+)*)/g) || [];
  m.forEach(s => (s.match(/\d+|ใต้ดิน/g) || []).forEach(x => out.add(normFloor(x))));
  if (/ใต้ดิน|ชั้น\s*B/i.test(p.title || '')) out.add('B');
  if (!out.size && p.floor) out.add(normFloor(p.floor));
  return out;
}
function relatedPlans(it) {
  const same = CAT.plans.filter(p => p.cat === it.cat); if (!same.length) return [];
  const f = it.floor ? normFloor(it.floor) : '';
  const hit = f ? same.filter(p => planFloors(p).has(f)) : [];
  return hit.length ? hit : same;
}
function plansWithPins(it) { return [...new Set(pinsOfItem(it.id).map(p => p.plan))].map(id => planById[id]).filter(Boolean); }
function selectItem(it, opts = {}) {
  curItem = it; curAsset = null; renderDetail(); renderList(); renderEditBar();
  if (innerWidth <= 1000 && opts.focusPin) { $('left').classList.remove('open'); $('right').classList.add('open'); }
  if (!opts.focusPin) return;
  const pins = pinsOfItem(it.id);
  const here = pins.find(p => curPlan && p.plan === curPlan.id && p.page === pageNo);
  if (here) { selPin = here.id; renderPins(); scrollToPin(here); return; }
  if (pins.length) { const p = pins[0]; selPin = p.id; loadPlan(planById[p.plan], p.page, p); return; }
  const rel = relatedPlans(it);
  if (rel.length && !(curPlan && rel.some(p => p.id === curPlan.id))) { loadPlan(rel[0]); toast('เปิดแปลนที่เกี่ยวข้อง: ' + rel[0].title); }
}
function showItemsOfPlan(p) {
  const fl = [...planFloors(p)]; $('catSel').value = p.cat; refreshFloors();
  $('floorSel').value = fl.length === 1 && [...$('floorSel').options].some(o => normFloor(o.value) === fl[0]) ? [...$('floorSel').options].find(o => normFloor(o.value) === fl[0]).value : '';
  $('q').value = ''; setTab('items'); $('left').classList.add('open');
}

/* ---------------- plan viewer ---------------- */
async function loadPlan(plan, page = 1, focus = null) {
  curPlan = plan; $('planTitle').textContent = plan.title; $('btnPlanItems').hidden = false; if (curItem) renderDetail(); $('msg').textContent = 'กำลังโหลดแปลน… (' + plan.sizeMB + ' MB)'; $('msg').style.display = 'flex'; $('stage').style.display = 'none';
  renderList();
  try {
    const cached = docCache.get(plan.id);
    if (cached) { docCache.delete(plan.id); docCache.set(plan.id, cached); pdfDoc = cached; pageNo = page; $('pgTot').textContent = cached.numPages; $('pageCtl').hidden = cached.numPages < 2; await renderPage(true, focus); return; }
    let localDoc = null;                                           // plans served from this machine (tools\serve.ps1) – fastest
    if (PLANS_BASE) { try { localDoc = await pdfjsLib.getDocument({ url: `${PLANS_BASE}/${plan.file}`, rangeChunkSize: 1 << 20 }).promise; } catch (e) { console.warn('local plan server unavailable, falling back:', e.message || e); } }
    const src = localDoc ? null : SHEET ? { data: await loadPlanBytes(plan.file, f => { if (curPlan === plan) $('msg').textContent = `กำลังโหลดแปลนจาก Google Drive… ${Math.round(f * 100)}% (${plan.sizeMB} MB)`; }) } : { url: plan.url || aUrl('plans', plan.file), rangeChunkSize: 1 << 20 };
    const task = localDoc ? { promise: Promise.resolve(localDoc) } : pdfjsLib.getDocument(src);
    $('msg').textContent = 'กำลังเปิดไฟล์แปลน…';
    const doc = await task.promise; if (curPlan !== plan) { doc.destroy(); return; }
    docCache.set(plan.id, doc); while (docCache.size > 4) { const k = docCache.keys().next().value; docCache.get(k).destroy(); docCache.delete(k); bmpCache.forEach((_, bk) => bk.startsWith(k + ':') && bmpCache.delete(bk)); }
    pdfDoc = doc; pageNo = page; $('pgTot').textContent = doc.numPages; $('pageCtl').hidden = doc.numPages < 2;
    await renderPage(true, focus);
  } catch (e) { $('msg').textContent = 'โหลดแปลนไม่สำเร็จ: ' + (e.message || e) + '\n(ถ้ายังไม่ได้อัปโหลดไฟล์ไป R2 ให้ตรวจสอบโฟลเดอร์ assets-upload)'; }
}
async function renderPage(fit, focus) {
  const tok = ++renderTok; if (renderTask) { try { renderTask.cancel(); } catch { } renderTask = null; }
  const pg = await pdfDoc.getPage(pageNo); if (tok !== renderTok) return;
  const v1 = pg.getViewport({ scale: 1 }); baseW = v1.width; baseH = v1.height;
  const sc = $('scroller'), cv = $('cv'), key = curPlan.id + ':' + pageNo + ':' + sc.clientWidth + 'x' + sc.clientHeight;
  if (fit) { fitZoom = Math.min((sc.clientWidth - 40) / baseW, (sc.clientHeight - 40) / baseH); zoom = fitZoom; }
  const vp = pg.getViewport({ scale: zoom });
  const dpr = Math.min(window.devicePixelRatio || 1, 2), cap = 9000;
  const out = Math.min(dpr, cap / vp.width, cap / vp.height);
  cv.style.width = vp.width + 'px'; cv.style.height = vp.height + 'px';
  $('msg').style.display = 'none'; $('stage').style.display = 'block'; $('pgNum').textContent = pageNo; $('zLbl').textContent = Math.round(zoom / fitZoom * 100) + '%';
  renderPins();
  const hit = fit && bmpCache.get(key);
  if (hit) { cv.width = hit.width; cv.height = hit.height; cv.getContext('2d').drawImage(hit, 0, 0); if (focus) scrollToPin(focus); return; }
  // render off-screen so the previous (blurry) image stays visible until the sharp one is ready
  const tmp = document.createElement('canvas'); tmp.width = Math.floor(vp.width * out); tmp.height = Math.floor(vp.height * out);
  if (fit) { cv.width = tmp.width; cv.height = tmp.height; }
  $('msg').textContent = 'กำลังวาดแปลน… (ไฟล์แปลนละเอียด อาจใช้เวลาสักครู่)'; $('msg').style.display = 'flex';
  renderTask = pg.render({ canvasContext: tmp.getContext('2d'), viewport: pg.getViewport({ scale: zoom * out }) });
  try { await renderTask.promise; } catch { return; }
  if (tok !== renderTok) return;
  renderTask = null; $('msg').style.display = 'none';
  cv.width = tmp.width; cv.height = tmp.height; cv.getContext('2d').drawImage(tmp, 0, 0);
  if (fit) { bmpCache.set(key, tmp); while (bmpCache.size > 6) bmpCache.delete(bmpCache.keys().next().value); }
  if (focus) scrollToPin(focus);
}
function setZoom(z, anchor) {
  const sc = $('scroller'); const ax = anchor ? anchor.x : sc.clientWidth / 2, ay = anchor ? anchor.y : sc.clientHeight / 2;
  const px = (sc.scrollLeft + ax - $('stage').offsetLeft) / $('stage').offsetWidth, py = (sc.scrollTop + ay - $('stage').offsetTop) / $('stage').offsetHeight;
  zoom = Math.max(fitZoom * 0.3, Math.min(fitZoom * 12, z));
  clearTimeout(setZoom.t); setTimeout(renderPins, 0);
  // resize instantly with CSS, re-render sharply shortly after
  const w = baseW * zoom, h = baseH * zoom, cv = $('cv'); cv.style.width = w + 'px'; cv.style.height = h + 'px'; $('zLbl').textContent = Math.round(zoom / fitZoom * 100) + '%';
  sc.scrollLeft = px * w + $('stage').offsetLeft - ax; sc.scrollTop = py * h + $('stage').offsetTop - ay;
  setZoom.t = setTimeout(() => renderPage(false), 250);
}
function scrollToPin(p) {
  const sc = $('scroller'), st = $('stage');
  sc.scrollTo({ left: st.offsetLeft + p.x * st.offsetWidth - sc.clientWidth / 2, top: st.offsetTop + p.y * st.offsetHeight - sc.clientHeight / 2, behavior: 'smooth' });
}
function renderPins() {
  const W = $('stage').offsetWidth || 1, H = $('stage').offsetHeight || 1, CELL = 40, canMerge = zoom < fitZoom * 11;
  const groups = {};
  for (const p of pinsOfPlan()) { const k = canMerge ? Math.floor(p.x * W / CELL) + ',' + Math.floor(p.y * H / CELL) : p.id; (groups[k] = groups[k] || []).push(p); }
  const pinColor = p => {
    if ($('pinColor').value === 'status') { const a = p.asset && assetByCode[p.asset]; return !p.asset ? '#8a95a1' : !a || a.how === 'exact' || a.how === 'manual' ? '#2f9e5b' : a.how.includes('excess') ? '#e5484d' : '#e0a100'; }
    const it = itemById[p.item], i = it ? CAT.categories.findIndex(c => c.id === it.cat) : -1;
    return i < 0 ? '#8a95a1' : `hsl(${(i * 47) % 360} 65% 46%)`;
  };
  $('pins').innerHTML = Object.values(groups).map(g => {
    if (g.length > 1 && !g.some(p => p.id === selPin)) {
      const cx = g.reduce((s, p) => s + p.x, 0) / g.length, cy = g.reduce((s, p) => s + p.y, 0) / g.length;
      return `<div class="cluster" data-cluster="${cx},${cy}" style="left:${cx * 100}%;top:${cy * 100}%">${g.length}</div>`;
    }
    return g.map(p => {
      const it = itemById[p.item];
      return `<div class="pin ${selPin === p.id ? 'sel' : ''}" data-pin="${p.id}" style="left:${p.x * 100}%;top:${p.y * 100}%;--pc:${pinColor(p)}"><span class="lbl">${esc(p.label || (it ? it.name : '?'))}</span><span class="dot"></span></div>`;
    }).join('');
  }).join('');
  $('stage').parentElement.classList.toggle('hide-labels', !$('showLabels').checked);
}
function renderEditBar() {
  const b = $('editBar'); b.hidden = !editMode; $('scroller').classList.toggle('placing', editMode && !!curItem);
  if (!editMode) return;
  b.innerHTML = curItem ? `📍 คลิกบนแปลนเพื่อวางหมุดของ: <b>${esc(curItem.name)}</b>${curAsset ? ' · เลข <b>' + esc(curAsset) + '</b>' : ''} (วางได้หลายหมุด · ลากหมุดเพื่อย้าย)` : 'โหมดปักหมุด: เลือกรายการครุภัณฑ์ในแท็บ “ครุภัณฑ์” ก่อน แล้วคลิกบนแปลน';
}

/* ---------------- pointer interaction on the plan ---------------- */
let drag = null;
$('scroller').addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  const pinEl = e.target.closest('.pin');
  if (pinEl && editMode) { drag = { type: 'pin', id: pinEl.dataset.pin, moved: false, sx: e.clientX, sy: e.clientY }; e.preventDefault(); return; }
  drag = { type: 'pan', sx: e.clientX, sy: e.clientY, l: e.currentTarget.scrollLeft, t: e.currentTarget.scrollTop, moved: false };
});
window.addEventListener('mousemove', e => {
  if (!drag) return;
  if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4) drag.moved = true;
  if (!drag.moved) return;
  if (drag.type === 'pan') { const sc = $('scroller'); sc.classList.add('dragging'); sc.scrollLeft = drag.l - (e.clientX - drag.sx); sc.scrollTop = drag.t - (e.clientY - drag.sy); }
  else { const r = $('stage').getBoundingClientRect(); const p = state.pins.find(p => p.id === drag.id); p.x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); p.y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)); renderPins(); }
});
window.addEventListener('mouseup', e => {
  if (!drag) return; const d = drag; drag = null; $('scroller').classList.remove('dragging');
  if (d.type === 'pin') { if (d.moved) save(); else pinClicked(d.id); return; }
  if (d.moved) return;
  const pinEl = e.target.closest && e.target.closest('.pin'); if (pinEl) { pinClicked(pinEl.dataset.pin); return; }
  const cl = e.target.closest && e.target.closest('.cluster');
  if (cl) { const [cx, cy] = cl.dataset.cluster.split(',').map(Number), sc = $('scroller'), st = $('stage'), r = sc.getBoundingClientRect();
    setZoom(zoom * 2, { x: st.getBoundingClientRect().left - r.left + cx * st.offsetWidth, y: st.getBoundingClientRect().top - r.top + cy * st.offsetHeight }); return; }
  if (editMode && curItem && curPlan && $('stage').contains(e.target)) {
    const r = $('stage').getBoundingClientRect();
    const p = { id: uid(), plan: curPlan.id, page: pageNo, x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, item: curItem.id };
    if (curAsset) { p.asset = curAsset; p.label = curAsset; curAsset = null; }
    state.pins.push(p); selPin = p.id; save(); renderPins(); renderDetail(); renderList(); renderEditBar(); toast('วางหมุดแล้ว');
  }
});
$('scroller').addEventListener('wheel', e => {
  if (!pdfDoc) return;
  if (e.ctrlKey || e.shiftKey || true) { e.preventDefault(); const r = $('scroller').getBoundingClientRect(); setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), { x: e.clientX - r.left, y: e.clientY - r.top }); }
}, { passive: false });
function pinClicked(id) {
  const p = state.pins.find(p => p.id === id); if (!p) return; selPin = id; renderPins();
  const it = itemById[p.item]; if (it) { curItem = it; renderDetail(); renderList(); renderEditBar(); if (innerWidth <= 1000) $('right').classList.add('open'); }
}

/* ---------------- events ---------------- */
$('list').addEventListener('click', e => {
  const t = e.target;
  if (t.id === 'moreBtn') { shown += 150; renderList(); return; }
  const lk = t.closest('[data-link]'); if (lk) { e.stopPropagation(); const l = state.photoLinks[curItem.id] = state.photoLinks[curItem.id] || []; if (!l.includes(lk.dataset.link)) { l.push(lk.dataset.link); save(); renderDetail(); toast('ผูกรูปกับรายการแล้ว'); } return; }
  const pc = t.closest('[data-pcat],[data-pfloor]');
  if (pc) { setTab('items'); if (pc.dataset.pcat) { $('catSel').value = pc.dataset.pcat; refreshFloors(); $('floorSel').value = ''; } else { $('floorSel').value = pc.dataset.pfloor; } renderList(); return; }
  const pl = t.closest('[data-plan]'); if (pl) { loadPlan(planById[pl.dataset.plan]); document.body.classList.remove('x'); $('left').classList.remove('open'); return; }
  const it = t.closest('[data-item]'); if (it) { selectItem(itemById[it.dataset.item], { focusPin: true }); return; }
  const ph = t.closest('[data-photo]'); if (ph) openLightbox(photoById[ph.dataset.photo]);
});
$('detail').addEventListener('click', e => {
  const t = e.target;
  const rp = t.closest('[data-relplan]'); if (rp) { loadPlan(planById[rp.dataset.relplan]); if (innerWidth <= 1000) $('right').classList.remove('open'); return; }
  if (t.id === 'btnRematch') { openRematch(curItem); return; }
  if (t.id === 'btnPlace') { $('editMode').checked = true; setEdit(true); if (!curPlan) toast('เลือกแปลนทางซ้ายก่อน แล้วคลิกบนแปลน'); return; }
  if (t.dataset.placeasset) { curAsset = t.dataset.placeasset; $('editMode').checked = true; setEdit(true); renderDetail(); toast(curPlan ? 'คลิกบนแปลนเพื่อวางหมุดของ ' + curAsset : 'เลือกแปลนทางซ้ายก่อน แล้วคลิกบนแปลน'); return; }
  if (t.dataset.delpin) { e.stopPropagation(); if (confirm('ลบหมุดนี้?')) { state.pins = state.pins.filter(p => p.id !== t.dataset.delpin); save(); renderPins(); renderDetail(); renderList(); } return; }
  if (t.dataset.unlink) { const l = state.photoLinks[curItem.id]; state.photoLinks[curItem.id] = l.filter(i => i !== t.dataset.unlink); save(); renderDetail(); return; }
  if (t.dataset.lb) { openLightbox(photoById[t.dataset.lb]); return; }
  const g = t.closest('[data-gopin]'); if (g) { const p = state.pins.find(p => p.id === g.dataset.gopin); if (!p) return; selPin = p.id; const pl = planById[p.plan]; if (curPlan && curPlan.id === pl.id && pageNo === p.page) { renderPins(); scrollToPin(p); } else loadPlan(pl, p.page, p); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('lightbox').hidden = true; if ((e.key === 'Delete') && editMode && selPin && !/INPUT|SELECT/.test(document.activeElement.tagName)) { state.pins = state.pins.filter(p => p.id !== selPin); selPin = null; save(); renderPins(); renderDetail(); renderList(); } });
function setTab(t) { tab = t; document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x.dataset.tab === t)); $('catSel').parentElement.hidden = t === 'progress'; shown = 150; renderList(); }
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => setTab(b.dataset.tab));
$('pinColor').onchange = renderPins;
$('btnPlanItems').onclick = () => curPlan && showItemsOfPlan(curPlan);
$('btnLeft').onclick = () => { $('right').classList.remove('open'); $('left').classList.toggle('open'); };
$('btnRight').onclick = () => { $('left').classList.remove('open'); $('right').classList.toggle('open'); };
$('catSel').onchange = () => {
  const cat = $('catSel').value; refreshFloors(); shown = 150;
  if (cat && curItem && curItem.cat !== cat) { curItem = null; curAsset = null; selPin = null; renderDetail(); renderEditBar(); }
  if (cat && curPlan && curPlan.cat !== cat && tab !== 'photos') {          // plan viewer follows the category
    const first = CAT.plans.find(p => p.cat === cat);
    if (first) loadPlan(first); else { curPlan = null; pdfDoc = null; $('planTitle').textContent = 'หมวดนี้ไม่มีไฟล์แปลน'; $('stage').style.display = 'none'; $('msg').style.display = 'flex'; $('msg').textContent = 'หมวดงานนี้ไม่มีแปลนในเอกสาร'; $('btnPlanItems').hidden = true; $('pageCtl').hidden = true; }
  }
  renderPins(); renderList();
};
$('floorSel').onchange = () => { shown = 150; renderList(); };
$('onlyUnpinned').onchange = () => { shown = 150; renderList(); };
let qT; $('q').oninput = () => { clearTimeout(qT); qT = setTimeout(() => { shown = 150; renderList(); }, 200); };
function setEdit(v) { editMode = v; renderEditBar(); }
$('editMode').onchange = e => setEdit(e.target.checked);
$('showLabels').onchange = renderPins;
$('zIn').onclick = () => setZoom(zoom * 1.25); $('zOut').onclick = () => setZoom(zoom / 1.25); $('zFit').onclick = () => pdfDoc && renderPage(true);
$('pgPrev').onclick = () => { if (pageNo > 1) { pageNo--; renderPage(true); } }; $('pgNext').onclick = () => { if (pdfDoc && pageNo < pdfDoc.numPages) { pageNo++; renderPage(true); } };
window.addEventListener('resize', () => { clearTimeout(window._rz); window._rz = setTimeout(() => pdfDoc && renderPage(true), 300); });
$('btnExport').onclick = () => {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' }));
  a.download = 'equipment-pins-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
};
$('btnImport').onclick = () => $('fileImport').click();
$('fileImport').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const s = JSON.parse(await f.text()); if (!Array.isArray(s.pins)) throw 0;
    if (!confirm(`นำเข้า ${s.pins.length} หมุด? (รวมกับข้อมูลเดิม โดยหมุดที่ id ซ้ำจะถูกแทนที่)`)) return;
    const m = new Map(state.pins.map(p => [p.id, p])); s.pins.forEach(p => m.set(p.id, p)); state.pins = [...m.values()];
    Object.entries(s.photoLinks || {}).forEach(([k, v]) => state.photoLinks[k] = [...new Set([...(state.photoLinks[k] || []), ...v])]);
    save(); renderPins(); renderList(); renderDetail(); toast('นำเข้าแล้ว');
  } catch { toast('ไฟล์ไม่ถูกต้อง'); }
  e.target.value = '';
};

/* ---------------- theme ---------------- */
function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; const dark = (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light')) === 'dark'; $('btnTheme').textContent = dark ? '☀' : '☾'; }
try { applyTheme(localStorage.getItem('eqmap-theme')); } catch { applyTheme(); }
$('btnTheme').onclick = () => { const dark = $('btnTheme').textContent === '☀'; const t = dark ? 'light' : 'dark'; applyTheme(t); try { localStorage.setItem('eqmap-theme', t); } catch { } };

/* ---------------- boot ---------------- */
(async function boot() {
  try {
    CAT = await (await fetch('data/catalog.json')).json();
  } catch { $('msg').textContent = 'ไม่พบ data/catalog.json — รัน tools/ingest.ps1 ก่อน'; return; }
  CAT.items.forEach(i => itemById[i.id] = i); CAT.photos.forEach(p => photoById[p.id] = p); CAT.plans.forEach(p => planById[p.id] = p);
  try {
    const A = await (await fetch('data/assets.json')).json();
    A.assets.forEach(a => { if (a.i) (assetsByItem[a.i] = assetsByItem[a.i] || []).push(a); assetByCode[a.c] = a; });   // unmatched register rows stay in assetByCode (free to pick in the re-match dialog)
  } catch { /* assets.json is optional */ }
  await loadState();
  Object.entries(state.matchOverrides || {}).forEach(([c, i]) => applyOverride(c, i));
  const counts = {}; CAT.items.forEach(i => counts[i.cat] = (counts[i.cat] || 0) + 1);
  $('catSel').innerHTML = '<option value="">ทุกหมวดงาน</option>' + CAT.categories.map(c => `<option value="${c.id}">${c.id} · ${esc(c.name)}${counts[c.id] ? ' (' + counts[c.id] + ')' : ''}</option>`).join('');
  refreshFloors(); renderList();
})();
