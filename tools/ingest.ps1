# Ingest: scans the closeout document folder and builds
#   public/data/catalog.json   (categories, plans, items, photos)
#   assets-upload/plans/*.pdf  (plan drawings; upload to R2, served at /assets/plans/)
#   assets-upload/photos/*     (images extracted from the xlsx photo sheets; same)
# Usage: powershell -ExecutionPolicy Bypass -File tools\ingest.ps1 [-Source <folder>] [-SkipPlanCopy]
param(
  [string]$Source = 'D:\เอกสารปิดโครงการก่อสร้าง ศูนย์การแพทย์\05.งานบัญชีครุภัณฑ์ประกอบอาคาร\02-ไฟล์เอกสารตามลิสต์รายการ',
  [string]$Extra = 'D:\เอกสารปิดโครงการก่อสร้าง ศูนย์การแพทย์\โครงการก่อสร้างอาคารศูนย์การแพทย์\11.งานครุภัณฑ์ทางการแพทย์',
  [string]$Out =(Join-Path $PSScriptRoot '..\public'),
  [switch]$SkipPlanCopy
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Out = [IO.Path]::GetFullPath($Out)
$assetsRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\assets-upload'))
$planDir = Join-Path $assetsRoot 'plans'; $photoDir = Join-Path $assetsRoot 'photos'; $dataDir = Join-Path $Out 'data'
foreach ($d in $planDir, $photoDir, $dataDir) { New-Item -ItemType Directory -Force $d | Out-Null }

function Read-Zip($z, $n) {
  $e = $z.GetEntry($n); if (-not $e) { return $null }
  $r = New-Object IO.StreamReader($e.Open(), [Text.Encoding]::UTF8); $t = $r.ReadToEnd(); $r.Close(); $t
}
function Col-Index([string]$ref) {
  $letters = ($ref -replace '\d', ''); $n = 0
  foreach ($ch in $letters.ToCharArray()) { $n = $n * 26 + ([int][char]$ch - 64) }
  $n - 1
}
function Norm([string]$s) {
  if (-not $s) { return '' }
  ($s.ToLower() -replace '[\s\-_\.,\(\)/]+', '')
}
function Clean([string]$s) { if ($null -eq $s) { return '' }; ($s -replace '\s+', ' ').Trim() }

# category from the top-level folder name e.g. "02-งานสถาปัตยกรรม" -> id 02
function Cat-Of([string]$full) {
  $rel = $full.Substring($Source.Length).TrimStart('\')
  $top = $rel.Split('\')[0]
  $top
}

# ---- read a worksheet into rows: hashtable rowNumber -> array of strings
function Read-Sheet($z, $sheetPath, $strs) {
  $x = Read-Zip $z $sheetPath; if (-not $x) { return @{} }
  [xml]$sh = $x; $rows = @{}
  foreach ($row in $sh.worksheet.sheetData.row) {
    if (-not $row.c) { continue }
    $arr = New-Object 'System.Collections.Generic.Dictionary[int,string]'
    foreach ($c in $row.c) {
      $v = $c.v
      if ($c.t -eq 's' -and $v) { $v = $strs[[int]$v] }
      elseif ($c.t -eq 'inlineStr') { $v = $c.is.t }
      if ($null -ne $v -and "$v" -ne '') { $arr[(Col-Index $c.r)] = "$v" }
    }
    if ($arr.Count) { $rows[[int]$row.r] = $arr }
  }
  $rows
}

function Open-Book($path) {
  $z = [IO.Compression.ZipFile]::OpenRead($path)
  $ss = Read-Zip $z 'xl/sharedStrings.xml'; $strs = @()
  if ($ss) { [xml]$sx = $ss; $strs = @($sx.sst.si | % { if ($_.t -is [string]) { $_.t } elseif ($_.t.'#text') { $_.t.'#text' } else { ($_.r | % { $_.t.'#text' }) -join '' } }) }
  [xml]$wb = Read-Zip $z 'xl/workbook.xml'
  [xml]$rel = Read-Zip $z 'xl/_rels/workbook.xml.rels'
  $relMap = @{}; foreach ($r in $rel.Relationships.Relationship) { $relMap[$r.Id] = $r.Target }
  $sheets = @()
  foreach ($s in $wb.workbook.sheets.sheet) {
    $rid = $s.GetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
    $t = $relMap[$rid]; if ($t -notmatch '^/') { $t = 'xl/' + $t } else { $t = $t.TrimStart('/') }
    $sheets += [pscustomobject]@{ Name = $s.name; Hidden = ($s.state -eq 'hidden' -or $s.state -eq 'veryHidden'); Path = $t }
  }
  [pscustomobject]@{ Zip = $z; Strs = $strs; Sheets = $sheets }
}

$HeaderMap = @(
  @('name', '^รายการ'), @('brand', '^ยี่ห้อ'), @('model', '^รุ่น'), @('qty', '^จำนวน'),
  @('unit', '^หน่วย'), @('price', '^ราคาต่อหน่วย'), @('location', '^สถานที่'), @('note', '^หมายเหตุ')
)
function Find-Header($row) {
  $hasSeq = $false; $hasName = $false
  foreach ($v in $row.Values) { $t = Clean $v; if ($t -match '^ลำดับ') { $hasSeq = $true }; if ($t -match '^รายการ') { $hasName = $true } }
  $hasSeq -and $hasName
}
function Build-ColMap($row) {
  $m = @{}
  foreach ($k in $row.Keys) {
    $t = Clean $row[$k]
    foreach ($h in $HeaderMap) { if (-not $m.ContainsKey($h[0]) -and $t -match $h[1]) { $m[$h[0]] = $k } }
    if ($t -match '^รูป') { $m['photo'] = $k }
  }
  $m
}
function Floor-Of([string]$s) {
  if ($s -match 'ชั้น\s*(ใต้ดิน|ดาดฟ้า|[A-Za-z]?\d+[A-Za-z]?)') { return $Matches[1] }
  if ($s -match '(\d+)\s*(FL|FLOOR)\b') { return $Matches[1] }
  if ($s -match '\b(B\d?|R|RF)\s*(FL|FLOOR)\b') { return $Matches[1] }
  $null
}

$items = New-Object System.Collections.ArrayList
$photos = New-Object System.Collections.ArrayList
$plans = New-Object System.Collections.ArrayList
$cats = [ordered]@{}
$seen = @{}; $itemN = 0; $photoN = 0; $planN = 0

$Sources = @(@{ Root = $Source; Cat = $null; Name = $null; PlanRx = '\\(02-แบบ|02-แปลน|แบบประกอบ|แบบแปลน)' })
if ($Extra -and (Test-Path -LiteralPath $Extra)) { $Sources += @{ Root = $Extra; Cat = '11'; Name = 'งานครุภัณฑ์ทางการแพทย์'; PlanRx = '\\(02_As-built|แบบประกอบ)' } }
$xlsx = @()
foreach ($s in $Sources) {
  $xlsx += Get-ChildItem -LiteralPath $s.Root -Recurse -File -Filter *.xlsx -ErrorAction SilentlyContinue | ? { $_.Name -notmatch '^~\$' } |
    % { $_ | Add-Member -NotePropertyName Src -NotePropertyValue $s -PassThru }
}
foreach ($f in $xlsx) {
  $Source = $f.Src.Root
  $top = Cat-Of $f.FullName
  $catId = if ($f.Src.Cat) { $f.Src.Cat } else { ($top -split '-')[0] }
  if (-not $cats.Contains($catId)) { $cats[$catId] = $(if ($f.Src.Name) { $f.Src.Name } else { ($top -replace '^\d+-', '') }) }
  $isPhoto = ($f.FullName -match '\\(03-|รูป)') -or ($f.Name -match 'รูป|ภาพ')
  $rel = $f.FullName.Substring($Source.Length).TrimStart('\')
  Write-Host ("[{0}] {1}" -f $(if ($isPhoto) { 'photo' } else { 'list ' }), $rel)
  try { $bk = Open-Book $f.FullName } catch { Write-Warning "skip (cannot open): $rel"; continue }
  try {
    foreach ($sheet in $bk.Sheets) {
      if ($sheet.Hidden) { continue }
      $rows = Read-Sheet $bk.Zip $sheet.Path $bk.Strs
      if ($rows.Count -eq 0) { continue }
      $colMap = $null; $floor = $null; $group = $null
      $rowNums = $rows.Keys | Sort-Object
      $perRow = @{}   # row -> item/photo name for photo mapping
      foreach ($rn in $rowNums) {
        $row = $rows[$rn]
        if (Find-Header $row) { $colMap = Build-ColMap $row; continue }
        if (-not $colMap) { continue }
        $a = if ($row.ContainsKey(0)) { Clean $row[0] } else { '' }
        $nameCol = if ($colMap.ContainsKey('name')) { $colMap['name'] } else { 1 }
        $name = if ($row.ContainsKey($nameCol)) { Clean $row[$nameCol] } else { '' }
        if (-not $name) { continue }
        $isItem = ($a -match '^\d+(\.\d+)?$')
        if (-not $isItem -and -not $isPhoto) {
          $fl = Floor-Of $name
          if ($fl) { $floor = $fl } elseif ($name -match '^(หมวด|งาน)|^[A-Z ]{4,}$') { $group = $name } else { $group = $name }
          continue
        }
        if ($isPhoto) { $perRow[$rn] = @{ name = $name; brand = $(if ($colMap.ContainsKey('brand') -and $row.ContainsKey($colMap['brand'])) { Clean $row[$colMap['brand']] } else { '' }) }; continue }
        $get = { param($k) if ($colMap.ContainsKey($k) -and $row.ContainsKey($colMap[$k])) { Clean $row[$colMap[$k]] } else { '' } }
        $loc = & $get 'location'
        $fl2 = $floor; $f3 = Floor-Of $loc; if ($f3) { $fl2 = $f3 }
        $key = "$catId|$fl2|$(Norm $name)|$(Norm $loc)"
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = 1; $itemN++
        $qtyS = & $get 'qty'; $qty = 0; [double]::TryParse($qtyS, [ref]$qty) | Out-Null
        [void]$items.Add([ordered]@{
            id = "i$itemN"; cat = $catId; floor = $fl2; group = $group; name = $name
            brand = (& $get 'brand'); model = (& $get 'model'); qty = $qty; unit = (& $get 'unit')
            location = $loc; note = (& $get 'note'); source = $rel; norm = (Norm $name); photos = @()
          })
      }
      if ($isPhoto) {
        # map drawing images to rows
        $relPath = $sheet.Path -replace 'worksheets/', 'worksheets/_rels/' -replace '$', '.rels'
        $rx = Read-Zip $bk.Zip $relPath; if (-not $rx) { continue }
        [xml]$rxx = $rx; $drw = $null
        foreach ($r in $rxx.Relationships.Relationship) { if ($r.Type -match 'drawing$') { $drw = 'xl/' + ($r.Target -replace '^\.\./', '') } }
        if (-not $drw) { continue }
        $dx = Read-Zip $bk.Zip $drw; $drx = Read-Zip $bk.Zip ($drw -replace 'drawings/', 'drawings/_rels/' -replace '$', '.rels')
        if (-not $dx -or -not $drx) { continue }
        [xml]$dxx = $dx; [xml]$drxx = $drx
        $imgMap = @{}; foreach ($r in $drxx.Relationships.Relationship) { $imgMap[$r.Id] = 'xl/' + ($r.Target -replace '^\.\./', '') }
        $ns = New-Object Xml.XmlNamespaceManager($dxx.NameTable)
        $ns.AddNamespace('xdr', 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing')
        $ns.AddNamespace('a', 'http://schemas.openxmlformats.org/drawingml/2006/main')
        $nodes = $dxx.SelectNodes('//xdr:twoCellAnchor|//xdr:oneCellAnchor', $ns)
        foreach ($an in $nodes) {
          $blip = $an.SelectSingleNode('.//a:blip', $ns); if (-not $blip) { continue }
          $emb = $blip.GetAttribute('embed', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
          $mp = $imgMap[$emb]; if (-not $mp) { continue }
          $ext = [IO.Path]::GetExtension($mp).ToLower()
          if ($ext -notin '.jpg', '.jpeg', '.png', '.gif', '.webp') { continue }
          $r0 = [int]$an.SelectSingleNode('xdr:from/xdr:row', $ns).InnerText + 1
          $nm = $null
          for ($k = 0; $k -le 6 -and -not $nm; $k++) { if ($perRow.ContainsKey($r0 - $k)) { $nm = $perRow[$r0 - $k] } }
          $photoN++; $fn = "p$photoN$ext"
          $ent = $bk.Zip.GetEntry($mp); if (-not $ent) { continue }
          [IO.Compression.ZipFileExtensions]::ExtractToFile($ent, (Join-Path $photoDir $fn), $true)
          [void]$photos.Add([ordered]@{
              id = "p$photoN"; cat = $catId; file = $fn; name = $(if ($nm) { $nm.name } else { '' }); brand = $(if ($nm) { $nm.brand } else { '' })
              norm = $(if ($nm) { Norm $nm.name } else { '' }); sheet = $sheet.Name; source = $rel
            })
        }
      }
    }
  } finally { $bk.Zip.Dispose() }
}

# ---- link photos to items by normalised name within the same category
foreach ($p in $photos) {
  if (-not $p.norm) { continue }
  foreach ($it in $items) {
    if ($it.cat -ne $p.cat -or -not $it.norm) { continue }
    $a = $it.norm; $b = $p.norm
    if ($a -eq $b -or ($a.Length -ge 6 -and $b.Length -ge 6 -and ($a.Contains($b) -or $b.Contains($a)))) { $it.photos += $p.id }
  }
}

# ---- plans: PDFs inside drawing / plan folders
$pdfs = @()
foreach ($s in $Sources) {
  $pdfs += Get-ChildItem -LiteralPath $s.Root -Recurse -File -Filter *.pdf -ErrorAction SilentlyContinue | ? { $_.FullName -match $s.PlanRx } |
    % { $_ | Add-Member -NotePropertyName Src -NotePropertyValue $s -PassThru }
}
$seenPlan = @{}
foreach ($f in $pdfs) {
  $Source = $f.Src.Root
  $pk = "$($f.Name)|$($f.Length)"; if ($seenPlan.ContainsKey($pk)) { continue }; $seenPlan[$pk] = 1
  $top = Cat-Of $f.FullName; $catId = if ($f.Src.Cat) { $f.Src.Cat } else { ($top -split '-')[0] }
  if (-not $cats.Contains($catId)) { $cats[$catId] = $(if ($f.Src.Name) { $f.Src.Name } else { ($top -replace '^\d+-', '') }) }
  $planN++; $id = "pl$planN"; $rel = $f.FullName.Substring($Source.Length).TrimStart('\')
  if (-not $SkipPlanCopy) { Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $planDir "$id.pdf") -Force }
  [void]$plans.Add([ordered]@{
      id = $id; cat = $catId; title = [IO.Path]::GetFileNameWithoutExtension($f.Name); floor = (Floor-Of $f.Name)
      file = "$id.pdf"; sizeMB = [math]::Round($f.Length / 1MB, 1); source = $rel
    })
  Write-Host ("[plan ] {0} ({1} MB)" -f $rel, [math]::Round($f.Length / 1MB, 1))
}

$catList = @(); foreach ($k in $cats.Keys) { $catList += [ordered]@{ id = $k; name = $cats[$k] } }
$cat = [ordered]@{ generated = (Get-Date -Format s); assetBase = 'assets'; categories = $catList; plans = $plans; items = $items; photos = $photos }
$json = $cat | ConvertTo-Json -Depth 8 -Compress
[IO.File]::WriteAllText((Join-Path $dataDir 'catalog.json'), $json, (New-Object Text.UTF8Encoding($false)))
Write-Host ("Done: {0} categories, {1} plans, {2} items, {3} photos" -f $catList.Count, $plans.Count, $items.Count, $photos.Count)
$big = $plans | ? { $_.sizeMB -gt 24 }
if ($big) { Write-Warning ("Plans over 24 MB can't be served by Cloudflare Pages - upload these to R2: " + (($big | % { $_.file }) -join ', ')) }
