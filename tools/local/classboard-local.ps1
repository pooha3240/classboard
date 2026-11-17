# classboard 로컬판 실행기 (교사 PC)
# 바탕화면 'classboard 칠판' 바로가기가 classboard-local.vbs 를 거쳐 이 파일을 창 없이 실행합니다.
#   (인자 없음)  칠판 서버가 꺼져 있으면 켜고, 브라우저(크롬·엣지) 앱 창으로 칠판을 엶
#   -Server      서버만 켬(Windows 를 켤 때 미리 켜 두기용)
#   -Stop        서버 끄기(설치 창의 업데이트·지우기가 씀)
# 설정은 %LOCALAPPDATA%\classboard\local.json (설치 창이 만듦): node, app, data, port
param([switch]$Server, [switch]$Stop)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$Work = Join-Path $env:LOCALAPPDATA 'classboard'
$CfgPath = Join-Path $Work 'local.json'
$LogPath = Join-Path $Work 'local-server.log'

function Show-Error([string]$msg) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [void][Windows.Forms.MessageBox]::Show($msg, 'classboard 칠판', 'OK', 'Error')
  } catch { }
}

try { $cfg = Get-Content -LiteralPath $CfgPath -Raw -Encoding UTF8 | ConvertFrom-Json }
catch { Show-Error "로컬판 설정을 찾지 못했습니다.`n설치 창(install-windows.bat)에서 로컬판을 다시 설치해 주세요.`n($CfgPath)"; exit 1 }
$port = 8790
if ($cfg.port) { $port = [int]$cfg.port }
$url = "http://127.0.0.1:$port"

function Test-Up {
  try {
    $r = Invoke-WebRequest -Uri "$url/api/health" -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode -eq 200 -and $r.Content -match '"edition":"local"')
  } catch { return $false }
}

function Stop-Server {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*wrangler.local.jsonc*' })
  foreach ($p in $procs) { & taskkill.exe /T /F /PID $p.ProcessId 2>&1 | Out-Null }
}

if ($Stop) { Stop-Server; exit 0 }

if (-not (Test-Up)) {
  Stop-Server     # 반쯤 켜진 채 남은 것 정리
  $node = [string]$cfg.node
  $app = [string]$cfg.app
  $data = [string]$cfg.data
  $wr = Join-Path $app 'node_modules\wrangler\bin\wrangler.js'
  if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $wr)) {
    Show-Error "칠판 프로그램 파일이 없습니다. 설치 창에서 로컬판을 다시 설치(업데이트)해 주세요."; exit 1
  }
  New-Item -ItemType Directory -Force -Path $data | Out-Null
  $env:WRANGLER_SEND_METRICS = 'false'
  $env:NO_COLOR = '1'
  $env:FORCE_COLOR = '0'
  $env:CI = '1'
  $q = { param($s) '"' + $s + '"' }
  $line = "$(& $q $node) $(& $q $wr) dev -c wrangler.local.jsonc --ip 127.0.0.1 --port $port --persist-to $(& $q $data) --show-interactive-dev-session=false > $(& $q $LogPath) 2>&1"
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = Join-Path $env:WINDIR 'System32\cmd.exe'
  $psi.Arguments = '/d /s /c "' + $line + '"'
  $psi.WorkingDirectory = $app
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  [void][Diagnostics.Process]::Start($psi)

  # 켜지는 동안 작은 안내 창(서버만 켤 때는 띄우지 않음)
  $splash = $null
  if (-not $Server) {
    try {
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      $splash = New-Object Windows.Forms.Form
      $splash.Text = 'classboard 칠판'
      $splash.FormBorderStyle = 'FixedToolWindow'
      $splash.StartPosition = 'CenterScreen'
      $splash.TopMost = $true
      $splash.ClientSize = New-Object Drawing.Size(360, 90)
      $l = New-Object Windows.Forms.Label
      $l.Text = '칠판을 켜는 중입니다… (10초쯤)'
      $l.Font = New-Object Drawing.Font('Malgun Gothic', 12)
      $l.Dock = 'Fill'
      $l.TextAlign = 'MiddleCenter'
      $splash.Controls.Add($l)
      $splash.Show()
      [Windows.Forms.Application]::DoEvents()
    } catch { $splash = $null }
  }
  $ok = $false
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt 120) {
    if (Test-Up) { $ok = $true; break }
    for ($i = 0; $i -lt 10; $i++) { if ($splash) { [Windows.Forms.Application]::DoEvents() }; Start-Sleep -Milliseconds 100 }
  }
  if ($splash) { $splash.Close(); $splash.Dispose() }
  if (-not $ok) {
    $tail = ''
    try { $tail = (Get-Content -LiteralPath $LogPath -Tail 8 -Encoding UTF8) -join "`n" } catch { }
    Show-Error "칠판을 켜지 못했습니다. PC 를 다시 켠 뒤 다시 해 보세요.`n계속 안 되면 설치 창에서 로컬판을 업데이트하세요.`n`n기록: $LogPath`n$tail"
    exit 1
  }
}

if ($Server) { exit 0 }

# 크롬·엣지가 있으면 주소창 없는 앱 창으로, 없으면 기본 브라우저로
$candidates = @(
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
)
$exe = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if ($exe) { Start-Process -FilePath $exe -ArgumentList @("--app=$url/", '--start-maximized') }
else { Start-Process "$url/" }
exit 0
