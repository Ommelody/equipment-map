# Match catalog items (from the closeout documents) to real asset records in the fixasset register (.xls).
# Output: public/data/assets.json  - every register row with the catalog item it was matched to (field i) and a confidence (c).
# Usage: powershell -ExecutionPolicy Bypass -File tools\match.ps1 -Xls "C:\Users\USER\Downloads\fixasset 231126.xls"
param(
  [Parameter(Mandatory)][string]$Xls,
  [string]$Catalog = '',
  [string]$Out = '',
  [double]$MinFuzzy = 0.78
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Catalog) { $Catalog = Join-Path $here '..\public\data\catalog.json' }
if (-not $Out) { $Out = Join-Path $here '..\public\data\assets.json' }
$Catalog = [IO.Path]::GetFullPath($Catalog); $Out = [IO.Path]::GetFullPath($Out)

# ---------- 1. read the register through ACE/OLEDB ----------
$cn = New-Object Data.OleDb.OleDbConnection("Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$Xls;Extended Properties='Excel 8.0;HDR=NO;IMEX=1'")
$cn.Open(); $cmd = $cn.CreateCommand(); $cmd.CommandText = 'select * from [Sheet$]'; $cmd.CommandTimeout = 600
$r = $cmd.ExecuteReader()
$col = @{ code = 0; name = 1; brand = 4; model = 5; serial = 6; rfid = 7; po = 8; type = 10; dept = 14; status = 16; floor = 19; room = 20; note = 29 }
$rows = New-Object Collections.ArrayList; $first = $true
while ($r.Read()) {
  if ($first) { $first = $false; continue }
  $o = @{}; foreach ($k in $col.Keys) { $v = $r.GetValue($col[$k]); $o[$k] = if ($v -is [DBNull]) { '' } else { ("$v").Trim() } }
  if ($o.code) { [void]$rows.Add($o) }
}
$r.Close(); $cn.Close()
Write-Host "register rows: $($rows.Count)"

$cat = Get-Content $Catalog -Raw -Encoding UTF8 | ConvertFrom-Json
$items = @($cat.items)

# ---------- 2. matcher (C# for speed) ----------
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Globalization; using System.Text;
public static class Matcher {
  public static string Norm(string s) {
    if (string.IsNullOrEmpty(s)) return "";
    s = s.ToLowerInvariant().Replace("พร้อมรายการประกอบดังนี้", "");
    var sb = new StringBuilder();
    foreach (char c in s) {
      var cat = char.GetUnicodeCategory(c);
      if (char.IsLetterOrDigit(c) || cat == UnicodeCategory.NonSpacingMark || cat == UnicodeCategory.SpacingCombiningMark) sb.Append(c);
    }
    return sb.ToString();
  }
  static string FloorKey(string f) {
    if (string.IsNullOrEmpty(f)) return "";
    f = f.Replace("ชั้น", "").Trim();
    if (f.Contains("ใต้ดิน")) return "B"; if (f.Contains("ดาดฟ้า")) return "R";
    return f;
  }
  // equipment tag like "F-9/48", "CT-2A-1", "PTA-17": two names with different tags are different equipment
  static string CodeTok(string raw) {
    if (string.IsNullOrEmpty(raw)) return "";
    foreach (var t in raw.Split(new[] { ' ', '\t', '@' }, StringSplitOptions.RemoveEmptyEntries)) {
      bool d = false, l = false, sep = t.Contains("-") || t.Contains("/");
      foreach (char c in t) { if (char.IsDigit(c)) d = true; else if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) l = true; }
      if (d && l && sep && t.Length >= 3) return t.ToLowerInvariant().TrimEnd(',', '.');
    }
    return "";
  }
  static HashSet<string> Bigrams(string s) { var h = new HashSet<string>(); for (int i = 0; i + 1 < s.Length; i++) h.Add(s.Substring(i, 2)); return h; }
  static double Dice(HashSet<string> a, HashSet<string> b) {
    if (a.Count == 0 || b.Count == 0) return 0; int n = 0; foreach (var x in a) if (b.Contains(x)) n++;
    return 2.0 * n / (a.Count + b.Count);
  }
  // returns for each asset: item index (-1 none) and confidence
  public static void Run(string[] itemName, string[] itemFloor, int[] itemQty, string[] aName, string[] aFloor, double minFuzzy, out int[] aItem, out double[] aConf, out string[] aHow) {
    int ni = itemName.Length, na = aName.Length;
    var rItem = new int[na]; var rConf = new double[na]; var rHow = new string[na];
    aItem = rItem; aConf = rConf; aHow = rHow;
    var iKey = new string[ni]; var iFl = new string[ni]; var cap = new int[ni];
    var byKey = new Dictionary<string, List<int>>();
    for (int i = 0; i < ni; i++) {
      iKey[i] = Norm(itemName[i]); iFl[i] = FloorKey(itemFloor[i]); cap[i] = Math.Max(1, itemQty[i]);
      if (iKey[i].Length < 3) continue;
      List<int> l; if (!byKey.TryGetValue(iKey[i], out l)) byKey[iKey[i]] = l = new List<int>(); l.Add(i);
    }
    var aKey = new string[na]; var aFl = new string[na];
    for (int a = 0; a < na; a++) { aKey[a] = Norm(aName[a]); aFl[a] = FloorKey(aFloor[a]); rItem[a] = -1; }
    var used = new int[ni];
    Action<int, List<int>, double, string> assign = (a, group, conf, how) => {
      int best = -1;
      foreach (int i in group) if (used[i] < cap[i] && iFl[i] == aFl[a]) { best = i; break; }
      if (best < 0) foreach (int i in group) if (used[i] < cap[i]) { best = i; break; }
      string h = how;
      if (best < 0) { // capacity exhausted: keep the match but flag it
        foreach (int i in group) if (iFl[i] == aFl[a]) { best = i; break; }
        if (best < 0) best = group[0]; h = how + "+excess"; conf = Math.Min(conf, 0.6);
      }
      used[best]++; rItem[a] = best; rConf[a] = conf; rHow[a] = h;
    };
    // pass 1: exact normalised name
    for (int a = 0; a < na; a++) { List<int> g; if (aKey[a].Length >= 3 && byKey.TryGetValue(aKey[a], out g)) assign(a, g, 1.0, "exact"); }
    // pass 2: containment / bigram similarity on the remaining assets, by distinct name
    var keys = new List<string>(byKey.Keys); var bg = new Dictionary<string, HashSet<string>>();
    var kCode = new Dictionary<string, string>();
    foreach (var k in keys) { bg[k] = Bigrams(k); kCode[k] = CodeTok(itemName[byKey[k][0]]); }
    var cache = new Dictionary<string, KeyValuePair<string, double>>();
    for (int a = 0; a < na; a++) {
      if (rItem[a] >= 0 || aKey[a].Length < 4) continue;
      KeyValuePair<string, double> hit;
      if (!cache.TryGetValue(aKey[a], out hit)) {
        string bestK = null; double bestS = 0; var ab = Bigrams(aKey[a]); string ac = CodeTok(aName[a]);
        foreach (var k in keys) {
          double s;
          if (kCode[k] != ac) continue;
          string sh = aKey[a].Length <= k.Length ? aKey[a] : k, lo = aKey[a].Length <= k.Length ? k : aKey[a];
          if (sh.Length >= 8 && lo.Contains(sh) && (double)sh.Length / lo.Length >= 0.6) s = 0.85 + 0.1 * sh.Length / lo.Length;
          else { s = Dice(ab, bg[k]); if (s < minFuzzy) continue; }
          if (s > bestS) { bestS = s; bestK = k; }
        }
        hit = new KeyValuePair<string, double>(bestK, bestS); cache[aKey[a]] = hit;
      }
      if (hit.Key != null) assign(a, byKey[hit.Key], hit.Value, "fuzzy");
    }
  }
}
'@

[int[]]$aItem = $null; [double[]]$aConf = $null; [string[]]$aHow = $null
[Matcher]::Run([string[]]($items | % { $_.name }), [string[]]($items | % { "$($_.floor)" }), [int[]]($items | % { [int]$_.qty }),
  [string[]]($rows | % { $_.name }), [string[]]($rows | % { $_.floor }), $MinFuzzy, [ref]$aItem, [ref]$aConf, [ref]$aHow)

# ---------- 3. write assets.json ----------
$list = New-Object Collections.ArrayList
for ($k = 0; $k -lt $rows.Count; $k++) {
  $a = $rows[$k]; $ix = $aItem[$k]
  [void]$list.Add([ordered]@{
      c = $a.code; n = $a.name; b = $a.brand; m = $a.model; s = $a.serial; rf = $a.rfid; po = $a.po; t = $a.type; d = $a.dept
      st = $a.status; f = $a.floor; rm = $a.room; nt = $a.note
      i = $(if ($ix -ge 0) { $items[$ix].id } else { $null }); cf = [math]::Round($aConf[$k], 2); how = $aHow[$k]
    })
}
# the app only needs matched assets, with a few fields (full detail is in asset-match.csv)
$slim = $list | ? { $_.i } | % { [ordered]@{ c = $_.c; i = $_.i; s = $_.s; f = $_.f; st = $_.st; cf = $_.cf; how = $_.how; n = $_.n } }
$json = [ordered]@{ generated = (Get-Date -Format s); source = [IO.Path]::GetFileName($Xls); total = $list.Count; assets = @($slim) } | ConvertTo-Json -Depth 5 -Compress
[IO.File]::WriteAllText($Out, $json, (New-Object Text.UTF8Encoding($false)))

$m = $list | ? { $_.i }
Write-Host ("assets matched: {0} / {1}  (exact {2}, fuzzy {3}, excess {4})" -f $m.Count, $list.Count, ($m | ? { $_.how -eq 'exact' }).Count, ($m | ? { $_.how -eq 'fuzzy' }).Count, ($m | ? { $_.how -like '*excess' }).Count)
$itemsHit = ($m | Group-Object { $_.i }).Count
Write-Host ("catalog items with >=1 asset: {0} / {1}" -f $itemsHit, $items.Count)

# ---------- 4. CSV report (open in Excel) ----------
$im = @{}; foreach ($it in $items) { $im[$it.id] = $it }
$phm = @{}; foreach ($p in $cat.photos) { $phm[$p.id] = $p }
$pl = @{}; foreach ($p in $cat.plans) { $pl[$p.cat] = @($pl[$p.cat]) + $p.title }
$catName = @{}; foreach ($c in $cat.categories) { $catName[$c.id] = $c.name }
$csv = foreach ($a in $list) {
  $it = if ($a.i) { $im[$a.i] } else { $null }
  [pscustomobject][ordered]@{
    'รหัสทรัพย์สิน' = $a.c; 'ชื่อทรัพย์สิน' = $a.n; 'ยี่ห้อ' = $a.b; 'รุ่น' = $a.m; 'Serial' = $a.s; 'ชั้น(ทะเบียน)' = $a.f; 'ห้อง' = $a.rm
    'ผลจับคู่' = $(if ($it) { $a.how } else { 'ไม่พบในเอกสาร' }); 'ความมั่นใจ' = $(if ($it) { $a.cf } else { '' })
    'รายการในเอกสาร' = $(if ($it) { $it.name } else { '' }); 'หมวดงาน' = $(if ($it) { $catName[$it.cat] } else { '' })
    'ชั้น(เอกสาร)' = $(if ($it) { $it.floor } else { '' }); 'จำนวนในเอกสาร' = $(if ($it) { $it.qty } else { '' })
    'ไฟล์บัญชี' = $(if ($it) { $it.source } else { '' })
    'ไฟล์รูป' = $(if ($it) { (@($it.photos) | % { $phm[$_].source } | select -Unique) -join '; ' } else { '' })
    'รหัสรายการ' = $a.i
  }
}
$csvPath = Join-Path (Split-Path -Parent $Out) '..\..\asset-match.csv'; $csvPath = [IO.Path]::GetFullPath($csvPath)
$csv | Export-Csv -LiteralPath $csvPath -NoTypeInformation -Encoding UTF8
Write-Host "CSV: $csvPath"
