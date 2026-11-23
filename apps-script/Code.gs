/**
 * Equipment Map backend on Google Apps Script (Google Sheet = database, Google Drive = plan/photo storage).
 * Bind this script to a Google Sheet (Extensions > Apps Script), set ROOT_FOLDER_ID, deploy as Web app
 * (Execute as: Me, Who has access: Anyone). See SHEETS-SETUP.md.
 *
 * GET  ?action=state            -> { pins:[...], photoLinks:{itemId:[photoId]} }
 * GET  ?action=files            -> { plans:{pl1.pdf:id}, photos:{p1.jpg:id} }
 * GET  ?action=chunk&id=&n=&size=-> { total, data(base64) }   (plan PDFs streamed in chunks; works for private files)
 * POST (text/plain JSON body)   -> saves the whole state; optional token check (Script property EDIT_TOKEN)
 */
var ROOT_FOLDER_ID = 'PUT_DRIVE_FOLDER_ID_HERE';   // Drive folder that contains sub-folders "plans" and "photos"
var PIN_HEAD = ['id', 'plan', 'page', 'x', 'y', 'item', 'asset', 'label', 'updated'];

function sheet_(name, head) {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(head); sh.setFrozenRows(1); }
  return sh;
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function doGet(e) {
  var a = (e.parameter.action || 'state');
  try {
    if (a === 'state') return json_(readState_());
    if (a === 'files') return json_(readFiles_());
    if (a === 'chunk') return json_(readChunk_(e.parameter.id, +e.parameter.n || 0, +e.parameter.size || 8 * 1024 * 1024));
    return json_({ error: 'unknown action' });
  } catch (err) { return json_({ error: String(err) }); }
}

function doPost(e) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var body = JSON.parse(e.postData.contents);
    var tok = PropertiesService.getScriptProperties().getProperty('EDIT_TOKEN');
    if (tok && body.token !== tok) return json_({ error: 'unauthorized', status: 401 });
    writeState_(body.state || {});
    return json_({ ok: true });
  } catch (err) { return json_({ error: String(err) }); }
  finally { lock.releaseLock(); }
}

function readState_() {
  var pins = [], v = sheet_('pins', PIN_HEAD).getDataRange().getValues();
  for (var i = 1; i < v.length; i++) {
    var r = v[i]; if (!r[0]) continue;
    var p = { id: String(r[0]), plan: String(r[1]), page: +r[2], x: +r[3], y: +r[4], item: String(r[5]) };
    if (r[6] !== '') p.asset = String(r[6]); if (r[7] !== '') p.label = String(r[7]);
    pins.push(p);
  }
  var links = {}, lv = sheet_('links', ['item', 'photo']).getDataRange().getValues();
  for (var j = 1; j < lv.length; j++) { if (!lv[j][0]) continue; (links[lv[j][0]] = links[lv[j][0]] || []).push(String(lv[j][1])); }
  var mo = {}, ov = sheet_('overrides', ['asset', 'item']).getDataRange().getValues();
  for (var k = 1; k < ov.length; k++) if (ov[k][0]) mo[String(ov[k][0])] = String(ov[k][1]);
  return { pins: pins, photoLinks: links, matchOverrides: mo };
}

function writeState_(st) {
  var now = new Date().toISOString(), rows = (st.pins || []).map(function (p) {
    return [p.id, p.plan, p.page, p.x, p.y, p.item, p.asset || '', p.label || '', now];
  });
  var sh = sheet_('pins', PIN_HEAD); sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), PIN_HEAD.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, PIN_HEAD.length).setValues(rows);
  var lr = [], pl = st.photoLinks || {};
  Object.keys(pl).forEach(function (k) { pl[k].forEach(function (ph) { lr.push([k, ph]); }); });
  var ls = sheet_('links', ['item', 'photo']); ls.getRange(2, 1, Math.max(ls.getMaxRows() - 1, 1), 2).clearContent();
  if (lr.length) ls.getRange(2, 1, lr.length, 2).setValues(lr);
  var mo = st.matchOverrides || {}, orows = Object.keys(mo).map(function (c) { return [c, mo[c]]; });
  var os = sheet_('overrides', ['asset', 'item']); os.getRange(2, 1, Math.max(os.getMaxRows() - 1, 1), 2).clearContent();
  if (orows.length) os.getRange(2, 1, orows.length, 2).setValues(orows);
}

/** Run once after uploading files to Drive (and again when files change): builds the name -> Drive id index. */
function buildIndex() {
  var root = DriveApp.getFolderById(ROOT_FOLDER_ID), out = [['kind', 'name', 'id']];
  ['plans', 'photos'].forEach(function (kind) {
    var it = root.getFoldersByName(kind); if (!it.hasNext()) throw new Error('missing sub-folder: ' + kind);
    var fs = it.next().getFiles();
    while (fs.hasNext()) { var f = fs.next(); out.push([kind, f.getName(), f.getId()]); }
  });
  var sh = sheet_('files', ['kind', 'name', 'id']); sh.clearContents();
  sh.getRange(1, 1, out.length, 3).setValues(out);
  CacheService.getScriptCache().remove('files');
  Logger.log('indexed ' + (out.length - 1) + ' files');
}

function readFiles_() {
  var c = CacheService.getScriptCache(), hit = c.get('files'); if (hit) return JSON.parse(hit);
  var v = sheet_('files', ['kind', 'name', 'id']).getDataRange().getValues(), o = { plans: {}, photos: {} };
  for (var i = 1; i < v.length; i++) if (o[v[i][0]]) o[v[i][0]][v[i][1]] = v[i][2];
  var s = JSON.stringify(o); if (s.length < 90000) c.put('files', s, 600);
  return o;
}

function readChunk_(id, n, size) {
  var total = DriveApp.getFileById(id).getSize(), start = n * size, end = Math.min(total, (n + 1) * size) - 1;
  if (start >= total) return { total: total, data: '' };
  var r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), Range: 'bytes=' + start + '-' + end }, muteHttpExceptions: true
  });
  if (r.getResponseCode() >= 300) throw new Error('drive ' + r.getResponseCode());
  return { total: total, data: Utilities.base64Encode(r.getContent()) };
}
