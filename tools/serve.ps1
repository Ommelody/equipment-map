# Local dev server (no Node needed). Serves public/ and maps /assets/* to assets-upload/ (with Range support for PDFs).
# /api/state is stored in dev-state.json so pins persist locally the same way KV does in Cloudflare.
param([int]$Port = 3131)
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\public'))
$assets = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\assets-upload'))
$stateFile = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\dev-state.json'))
$mime = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'
  '.pdf' = 'application/pdf'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'; '.png' = 'image/png'; '.gif' = 'image/gif'; '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon' }
$l = New-Object Net.HttpListener
$l.Prefixes.Add("http://localhost:$Port/"); $l.Start()
Write-Host "Serving http://localhost:$Port/"
while ($l.IsListening) {
  $ctx = $l.GetContext(); $rq = $ctx.Request; $rs = $ctx.Response
  try {
    $path = [Uri]::UnescapeDataString($rq.Url.AbsolutePath)
    if ($path -eq '/api/state') {
      if ($rq.HttpMethod -eq 'PUT') {
        $sr = New-Object IO.StreamReader($rq.InputStream, [Text.Encoding]::UTF8); $body = $sr.ReadToEnd()
        [IO.File]::WriteAllText($stateFile, $body, (New-Object Text.UTF8Encoding($false)))
        $b = [Text.Encoding]::UTF8.GetBytes('{"ok":true}')
      } else {
        $txt = if (Test-Path $stateFile) { [IO.File]::ReadAllText($stateFile) } else { '{"pins":[],"photoLinks":{}}' }
        $b = [Text.Encoding]::UTF8.GetBytes($txt)
      }
      $rs.ContentType = 'application/json'; $rs.OutputStream.Write($b, 0, $b.Length); continue
    }
    if ($path -eq '/') { $path = '/index.html' }
    $file = if ($path.StartsWith('/assets/')) { Join-Path $assets $path.Substring(8) } else { Join-Path $root $path.TrimStart('/') }
    $file = [IO.Path]::GetFullPath($file)
    if (-not ($file.StartsWith($root) -or $file.StartsWith($assets)) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { $rs.StatusCode = 404; continue }
    $ext = [IO.Path]::GetExtension($file).ToLower()
    $rs.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
    $rs.AddHeader('Accept-Ranges', 'bytes')
    $fs = [IO.File]::Open($file, 'Open', 'Read', 'ReadWrite')
    try {
      $len = $fs.Length; $start = 0; $end = $len - 1
      $rh = $rq.Headers['Range']
      if ($rh -and $rh -match 'bytes=(\d*)-(\d*)') {
        if ($Matches[1]) { $start = [long]$Matches[1] }
        if ($Matches[2]) { $end = [long]$Matches[2] }
        if ($end -ge $len) { $end = $len - 1 }
        $rs.StatusCode = 206; $rs.AddHeader('Content-Range', "bytes $start-$end/$len")
      }
      $count = $end - $start + 1; $rs.ContentLength64 = $count
      $fs.Seek($start, 'Begin') | Out-Null
      $buf = New-Object byte[] 262144; $left = $count
      while ($left -gt 0) { $n = $fs.Read($buf, 0, [int][Math]::Min($buf.Length, $left)); if ($n -le 0) { break }; $rs.OutputStream.Write($buf, 0, $n); $left -= $n }
    } finally { $fs.Dispose() }
  } catch { } finally { try { $rs.Close() } catch { } }
}
