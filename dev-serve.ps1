# dev-serve.ps1 — docs/ 를 http://localhost:8765/ 로 띄우는 개발용 정적 서버.
#
# file:// 로 열면 ES 모듈과 Google 로그인(OAuth 원본 검사)이 동작하지 않는다.
# 로컬에서 테스트하려면 이 스크립트로 띄운 뒤, Cloud Console 의 OAuth 클라이언트에
# "승인된 JavaScript 원본" 으로 http://localhost:8765 를 함께 등록해 두면 된다.
#
# 사용: powershell -ExecutionPolicy Bypass -File dev-serve.ps1

$root = Join-Path $PSScriptRoot 'docs'
$port = 8765

$listener = New-Object System.Net.HttpListener
# localhost 하나만 등록하면 브라우저가 127.0.0.1 로 붙을 때 HTTP.sys 가 400 을 준다
# (Host 헤더가 안 맞는다). 실제로 "로컬에 안 띄워졌어" 의 원인이었다.
# '+' 는 관리자 권한이 필요하므로, 흔히 쓰는 주소를 각각 등록한다.
foreach ($h in 'localhost', '127.0.0.1', '[::1]') {
  $listener.Prefixes.Add("http://${h}:$port/")
}

try {
  $listener.Start()
} catch {
  Write-Output "서버를 띄우지 못했습니다: $($_.Exception.Message)"
  Write-Output "같은 포트를 이미 쓰고 있는지 확인하세요: netstat -ano | findstr $port"
  exit 1
}

Write-Output "준비됐습니다. 브라우저에서 아래 주소를 여세요. (Ctrl+C 로 종료)"
Write-Output "  http://localhost:$port/"
Write-Output "  자체 검증: http://localhost:$port/dev/selftest.html"

$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.svg'  = 'image/svg+xml'
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.LocalPath).TrimStart('/')
  if ([string]::IsNullOrEmpty($rel)) { $rel = 'index.html' }
  $file = Join-Path $root $rel

  if (Test-Path -LiteralPath $file -PathType Leaf) {
    $bytes = [System.IO.File]::ReadAllBytes($file)
    $ext = [System.IO.Path]::GetExtension($file).ToLower()
    $ct = $types[$ext]
    if (-not $ct) { $ct = 'application/octet-stream' }
    $ctx.Response.ContentType = $ct
    $ctx.Response.Headers.Add('Cache-Control', 'no-store')
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $ctx.Response.StatusCode = 404
  }
  $ctx.Response.Close()
}
