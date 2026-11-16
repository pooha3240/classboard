# classboard 설치 도우미 (Windows)
# GitHub 계정 없이 내 Cloudflare 계정에 전자칠판을 설치·업데이트합니다.
#  1) Node.js 준비(없으면 이 사용자 폴더에만 받아 둠, 관리자 권한 필요 없음)
#  2) Cloudflare 로그인(브라우저가 열림)
#  3) 배포(처음이면 workers.dev 주소를 정함)
#  4) 설치 키(SETUP_KEY) 만들기(처음 한 번), 바탕화면에 메모로 저장
#  5) 처음 설정 화면 열기
# 다시 실행하면 같은 주소에 새 버전으로 업데이트합니다(판서·자료·설정은 그대로).

# 외부 프로그램(wrangler)은 경고를 stderr 로 내므로 'Stop' 이면 Windows PowerShell 5.1 이 오류로 멈춤 → 종료 코드로 판단
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $Root
$Work = Join-Path $env:LOCALAPPDATA 'classboard'
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$env:WRANGLER_SEND_METRICS = 'false'

function Step($n, $msg) { Write-Host ""; Write-Host "[$n/5] $msg" -ForegroundColor Cyan }
function Info($msg) { Write-Host "      $msg" }
function Warn($msg) { Write-Host "      $msg" -ForegroundColor Yellow }
function Fail($msg) { throw $msg }

$WR = Join-Path $Root 'node_modules\.bin\wrangler.cmd'
function Wrangler { & $WR @args }

# ── 계정·주소 이름(한국어로 묻고 Cloudflare API 로 처리) ──
function Cf($method, $path, $body) {
  $h = @{ Authorization = "Bearer $script:CfToken" }
  $p = @{ Method = $method; Uri = "https://api.cloudflare.com/client/v4$path"; Headers = $h; UseBasicParsing = $true; ErrorAction = 'Stop' }
  if ($body) { $p.Body = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Compress)); $p.ContentType = 'application/json' }
  try { return Invoke-RestMethod @p }
  catch {
    $err = $_; $msg = $null
    if ($err.ErrorDetails -and $err.ErrorDetails.Message) {
      try { $j = $err.ErrorDetails.Message | ConvertFrom-Json; $msg = (@($j.errors) | ForEach-Object { "$($_.code) $($_.message)" }) -join '; ' } catch { }
    }
    if (-not $msg) { $msg = $err.Exception.Message }
    throw "CF:$msg"
  }
}
function Prepare-Account {
  $script:CfToken = $null
  try { $t = (& $WR auth token --json 2>$null | Out-String | ConvertFrom-Json); if ($t.type -eq 'oauth' -or $t.type -eq 'api_token') { $script:CfToken = $t.token } } catch { }
  if (-not $script:CfToken) {
    Warn "계정 정보를 미리 읽지 못했습니다. 아래에서 영어로 물으면:"
    Warn "  register a workers.dev subdomain? → Enter,  subdomain to be? → 영어 소문자 주소 이름(예: ulsan-jungmu) + Enter"
    return
  }
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
  # 계정 고르기
  try { $accts = @((Cf GET '/accounts?per_page=50').result) } catch { Warn "계정 목록을 읽지 못했습니다($_). 영어로 물으면 올릴 계정을 고르세요."; return }
  if ($accts.Count -eq 0) { Warn "Cloudflare 계정을 찾지 못했습니다."; return }
  $acct = $accts[0]
  if ($accts.Count -gt 1) {
    Write-Host ""
    Write-Host "  Cloudflare 계정이 여러 개입니다. 어느 계정에 올릴까요?" -ForegroundColor Cyan
    for ($i = 0; $i -lt $accts.Count; $i++) { Write-Host ("    {0}) {1}" -f ($i + 1), $accts[$i].name) }
    while ($true) {
      $n = Read-Host "  번호를 넣고 Enter"
      if ($n -match '^\d+$' -and [int]$n -ge 1 -and [int]$n -le $accts.Count) { $acct = $accts[[int]$n - 1]; break }
      Warn "목록에 있는 번호를 넣으세요."
    }
  }
  $env:CLOUDFLARE_ACCOUNT_ID = $acct.id
  Info "계정: $($acct.name)"
  # workers.dev 주소 이름
  $sub = $null
  try { $sub = (Cf GET "/accounts/$($acct.id)/workers/subdomain").result.subdomain } catch { $sub = $null }
  if ($sub) { Info "칠판 주소: https://classboard.$sub.workers.dev"; return }
  Write-Host ""
  Write-Host "  칠판 주소에 쓸 이름을 정합니다. 주소는 https://classboard.<이름>.workers.dev 가 됩니다." -ForegroundColor Cyan
  Info "영어 소문자·숫자·- 만 쓸 수 있고, 계정마다 한 번 정하면 바꾸기 번거로우니 오래 쓸 이름으로 정하세요."
  Info "예: ulsan-jungmu, jmschool5  (한글이 들어가면 한/영 키를 눌러 영어로 바꾸세요)"
  while ($true) {
    $name = ([string](Read-Host "  주소 이름")).Trim().ToLower()
    if (-not $name) { Warn "이름을 넣으세요."; continue }
    if ($name -match '[^\x00-\x7F]') { Warn "한글이 들어갔습니다. 한/영 키를 눌러 영어로 바꾼 뒤 다시 넣으세요."; continue }
    if ($name -notmatch '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$') { Warn "영어 소문자·숫자·- 만 쓰고, -로 시작하거나 끝나면 안 됩니다."; continue }
    # 쓸 수 있는지 먼저 확인(wrangler 와 같은 방식: 10032 = 비어 있음, 10031 = 이미 씀)
    $free = $true
    try { Cf GET "/accounts/$($acct.id)/workers/subdomains/$name" | Out-Null; $free = $false } catch { if ("$_" -match '10031') { $free = $false } }
    if (-not $free) { Warn "이미 누가 쓰는 이름입니다. 다른 이름을 넣으세요(뒤에 숫자를 붙여 보세요)."; continue }
    if ((Read-Host "  https://classboard.$name.workers.dev 로 할까요? (Y/n)") -match '^[nN]') { continue }
    try {
      $r = Cf PUT "/accounts/$($acct.id)/workers/subdomain" @{ subdomain = $name }
      $sub = $r.result.subdomain; if (-not $sub) { $sub = $name }
      Info "주소 이름을 정했습니다: https://classboard.$sub.workers.dev"
      Info "(새 주소는 몇 분 뒤부터 열릴 수 있습니다)"
      return
    } catch {
      $e = "$_"
      if ($e -match 'unavailable|taken|already|exists|10031') { Warn "이미 누가 쓰는 이름입니다. 다른 이름을 넣으세요(뒤에 숫자를 붙여 보세요)." }
      elseif ($e -match 'invalid|10013') { Warn "쓸 수 없는 이름입니다. 다른 이름을 넣으세요." }
      else {
        Warn "주소 이름을 정하지 못했습니다: $($e -replace '^CF:','')"
        if ((Read-Host "  다른 이름으로 다시 할까요? (Y/n, n 이면 아래에서 영어로 다시 묻습니다)") -match '^[nN]') { return }
      }
    }
  }
}

Write-Host "==============================================" -ForegroundColor Green
Write-Host "  classboard 전자칠판 설치 도우미" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Green
Info "설치 폴더: $Root"

try {
  if (-not (Test-Path (Join-Path $Root 'wrangler.jsonc'))) { Fail "압축을 푼 classboard 폴더 안의 install-windows.bat 을 실행하세요. (wrangler.jsonc 가 없습니다)" }

  # ── 1. Node.js ──
  Step 1 "Node.js 준비"
  $nodeHome = $null
  $sys = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($sys) {
    $v = (& $sys.Source -v) -replace '^v', ''
    if ([version]$v -ge [version]'22.12.0') { $nodeHome = Split-Path $sys.Source; Info "컴퓨터에 있는 Node.js $v 를 씁니다." }
  }
  if (-not $nodeHome) {
    $local = Get-ChildItem -Path (Join-Path $Work 'node') -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'node.exe') } | Select-Object -First 1
    if ($local) { $nodeHome = $local.FullName; Info "전에 받아 둔 Node.js 를 씁니다." }
  }
  if (-not $nodeHome) {
    $arch = switch ($env:PROCESSOR_ARCHITECTURE) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { $null } }
    if (-not $arch) { Fail "64비트 Windows 에서만 설치할 수 있습니다." }
    Info "Node.js(장기 지원판)를 받는 중입니다. 1~3분 걸릴 수 있습니다…"
    try { $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing -ErrorAction Stop } catch { Fail "Node.js 를 받지 못했습니다(nodejs.org 접속 실패). 학교망에서 막혔다면 집이나 휴대폰 핫스팟에서 실행하세요." }
    $lts = $index | Where-Object { $_.lts -and ($_.files -contains "win-$arch-zip") } | Select-Object -First 1
    if (-not $lts) { Fail "Node.js 정보를 받지 못했습니다. 인터넷 연결을 확인하세요." }
    $name = "node-$($lts.version)-win-$arch"
    $zip = Join-Path $Work "$name.zip"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/$($lts.version)/$name.zip" -OutFile $zip -UseBasicParsing -ErrorAction Stop
    $dest = Join-Path $Work 'node'
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force -ErrorAction Stop
    Remove-Item -Force $zip
    $nodeHome = Join-Path $dest $name
    Info "Node.js $($lts.version) 준비 완료"
  }
  $env:Path = "$nodeHome;$env:Path"

  Info "설치 도구(wrangler)를 받는 중입니다…"
  & npm.cmd ci --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $WR)) { Fail "설치 도구를 받지 못했습니다. 인터넷 연결(학교망이면 보안 프로그램)을 확인하고 다시 실행하세요." }

  # ── 판 고르기: 기본판(R2 없음) / 저장판(R2, 카드 등록 필요) ──
  $edFile = Join-Path $Work 'edition.txt'
  $prev = if (Test-Path $edFile) { (Get-Content -LiteralPath $edFile -Raw).Trim() } else { '' }
  Write-Host ""
  Write-Host "  어느 판을 설치할까요?" -ForegroundColor Cyan
  Write-Host "    1) 기본판 - 카드 등록 없이 무료. 자료 700MB, 판서 재생 60일"
  Write-Host "    2) 저장판 - Cloudflare R2(무료 10GB) 사용. 자료 6GB, 판서 기록 계속 보관, 백업"
  Write-Host "               R2 를 켜려면 Cloudflare 에 카드(또는 PayPal) 등록이 필요합니다(무료 범위에서는 청구 없음)"
  $def = if ($prev -eq 'storage') { '2' } else { '1' }
  $ans = Read-Host "  번호를 넣고 Enter (그냥 Enter = $def)"
  if (-not $ans) { $ans = $def }
  $edition = if ($ans.Trim() -eq '2') { 'storage' } else { 'basic' }
  if ($prev -eq 'storage' -and $edition -eq 'basic') {
    Warn "전에 저장판으로 설치했습니다. 기본판으로 바꾸면 R2 에 둔 자료와 보관한 판서 기록을 칠판에서 열 수 없게 됩니다."
    if ((Read-Host "      그래도 기본판으로 할까요? (y/N)") -ne 'y') { $edition = 'storage' }
  }
  $Conf = if ($edition -eq 'storage') { 'wrangler.storage.jsonc' } else { 'wrangler.jsonc' }
  Info ("선택: " + $(if ($edition -eq 'storage') { '저장판' } else { '기본판' }))

  # ── 2. Cloudflare 로그인 ──
  Step 2 "Cloudflare 로그인"
  $who = (Wrangler whoami 2>&1 | Out-String)
  if ($who -match 'not authenticated|You are not logged in') {
    Info "브라우저가 열리면 Cloudflare 에 로그인하고 [Allow](허용)를 누르세요."
    Wrangler login
    if ($LASTEXITCODE -ne 0) { Fail "Cloudflare 로그인을 마치지 못했습니다. 다시 실행하세요." }
  } else {
    Info "이미 로그인되어 있습니다."
  }

  # ── 3. 배포 ──
  Step 3 "내 Cloudflare 계정에 올리기"
  # 계정 고르기·workers.dev 주소 이름 정하기를 한국어로 먼저 물어 처리(wrangler 가 영어로 묻지 않게)
  Prepare-Account
  $out = Join-Path $Work 'deploy-output.ndjson'
  if (Test-Path $out) { Remove-Item -Force $out }
  $env:WRANGLER_OUTPUT_FILE_PATH = $out
  Wrangler deploy -c $Conf
  $code = $LASTEXITCODE
  Remove-Item Env:\WRANGLER_OUTPUT_FILE_PATH
  if ($code -ne 0) {
    if ($edition -eq 'storage') { Fail "올리지 못했습니다. 저장판은 먼저 Cloudflare 대시보드 → R2 Object Storage 에서 R2 를 켜야 합니다(카드 또는 PayPal 등록). 켠 뒤 다시 실행하세요. 그래도 안 되면 위의 영어 오류 메시지를 확인하세요." }
    Fail "올리지 못했습니다. 위의 영어 오류 메시지를 확인하세요. (안내 문서의 '문제 해결' 참고)"
  }
  Set-Content -LiteralPath $edFile -Value $edition -Encoding ASCII
  $url = $null
  if (Test-Path $out) {
    foreach ($line in Get-Content -LiteralPath $out -Encoding UTF8) {
      try { $o = $line | ConvertFrom-Json } catch { continue }
      if ($o.type -eq 'deploy' -and $o.targets) { $url = @($o.targets | Where-Object { $_ -match 'workers\.dev' })[0]; if (-not $url) { $url = @($o.targets)[0] } }
    }
  }
  if ($url) { Info "주소: $url" } else { Warn "주소를 알아내지 못했습니다. 위 출력에서 https://…workers.dev 주소를 확인하세요." }

  # ── 4. 설치 키 ──
  Step 4 "설치 키(SETUP_KEY)"
  $names = @()
  try { $names = @((Wrangler secret list -c $Conf --format json 2>$null | Out-String | ConvertFrom-Json) | ForEach-Object { $_.name }) } catch { }
  $memo = Join-Path ([Environment]::GetFolderPath('Desktop')) 'classboard-설치정보.txt'
  if ($names -contains 'SETUP_KEY') {
    Info "설치 키가 이미 있습니다(업데이트). 처음 설치 때 저장한 메모를 쓰세요."
  } else {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.ToCharArray()
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 16; $rng.GetBytes($bytes)
    $raw = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
    $key = ($raw -split '(.{4})' | Where-Object { $_ }) -join '-'
    $key | & $WR secret put SETUP_KEY -c $Conf          # 파이프는 함수를 거치면 전달되지 않아 직접 호출
    if ($LASTEXITCODE -ne 0) { Fail "설치 키를 저장하지 못했습니다. 다시 실행하세요." }
    @(
      "classboard 전자칠판 설치 정보  ($(Get-Date -Format 'yyyy-MM-dd HH:mm'))",
      "",
      "주소: $url",
      "설치 키(SETUP_KEY): $key",
      "",
      "설치 키는 처음 설정과 비밀번호를 잊었을 때만 씁니다.",
      "다른 사람에게 보여 주지 말고, 이 파일은 안전한 곳에 옮겨 두세요."
    ) | Set-Content -LiteralPath $memo -Encoding UTF8
    Write-Host ""
    Write-Host "      설치 키: $key" -ForegroundColor Yellow
    Info "바탕화면의 'classboard-설치정보.txt' 에 저장했습니다."
  }

  # ── 5. 열기 ──
  Step 5 "처음 설정 화면 열기"
  if ($url) {
    Info "잠시 뒤 브라우저가 열립니다. (처음 배포는 주소가 퍼지는 데 1분쯤 걸릴 수 있습니다)"
    Start-Sleep -Seconds 5
    Start-Process "$url/login"
  }
  Write-Host ""
  Write-Host "끝났습니다. 업데이트할 때는 새 파일을 받아 같은 방법으로 다시 실행하세요." -ForegroundColor Green
} catch {
  Write-Host ""
  Write-Host "설치를 마치지 못했습니다:" -ForegroundColor Red
  Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "  같은 화면을 사진으로 찍어 두면 문제를 찾는 데 도움이 됩니다."
}
Write-Host ""
Read-Host "Enter 를 누르면 창이 닫힙니다"
