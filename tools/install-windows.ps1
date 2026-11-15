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
  Info "처음이면 workers.dev 주소 이름을 물어봅니다. 영어 소문자로 짧게(예: 학교명+이름) 정하세요."
  Info "계정이 여러 개면 어느 계정에 올릴지 고르라고 나옵니다."
  $out = Join-Path $Work 'deploy-output.ndjson'
  if (Test-Path $out) { Remove-Item -Force $out }
  $env:WRANGLER_OUTPUT_FILE_PATH = $out
  Wrangler deploy
  $code = $LASTEXITCODE
  Remove-Item Env:\WRANGLER_OUTPUT_FILE_PATH
  if ($code -ne 0) { Fail "올리지 못했습니다. 위의 영어 오류 메시지를 확인하세요. (안내 문서의 '문제 해결' 참고)" }
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
  try { $names = @((Wrangler secret list --format json 2>$null | Out-String | ConvertFrom-Json) | ForEach-Object { $_.name }) } catch { }
  $memo = Join-Path ([Environment]::GetFolderPath('Desktop')) 'classboard-설치정보.txt'
  if ($names -contains 'SETUP_KEY') {
    Info "설치 키가 이미 있습니다(업데이트). 처음 설치 때 저장한 메모를 쓰세요."
  } else {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.ToCharArray()
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 16; $rng.GetBytes($bytes)
    $raw = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
    $key = ($raw -split '(.{4})' | Where-Object { $_ }) -join '-'
    $key | & $WR secret put SETUP_KEY          # 파이프는 함수를 거치면 전달되지 않아 직접 호출
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
