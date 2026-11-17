# classboard 설치 도우미 (Windows, 설치 창)
# install-windows.bat 이 실행합니다. 창에서 판·주소 이름·학급·교사 정보를 받은 뒤
#  1) 설치 도구 준비(Node.js·wrangler, 관리자 권한 필요 없음)
#  2) Cloudflare 로그인(브라우저에서 [Allow] 한 번)
#  3) 계정·주소 이름 정하기
#  4) 칠판 올리기
#  5) 설치 키 만들기, 주소가 열릴 때까지 기다리기
#  6) 학급·교사 정보 넣기(웹의 '처음 설정'을 대신함)
# 까지 혼자 진행합니다. 이미 설치한 PC 에서 다시 실행하면 업데이트 화면으로 열립니다.
# 창을 열 수 없으면 종료 코드 1 로 끝나고, bat 이 글자판 도우미(install-windows.ps1)를 대신 엽니다.

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$Root = Split-Path -Parent $PSScriptRoot
$Work = Join-Path $env:LOCALAPPDATA 'classboard'
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$LogPath = Join-Path $Work 'install-log.txt'
$InfoPath = Join-Path $Work 'install.json'
$WranglerJs = Join-Path $Root 'node_modules\wrangler\bin\wrangler.js'
$env:WRANGLER_SEND_METRICS = 'false'
$env:NO_COLOR = '1'
$env:FORCE_COLOR = '0'
$AppVersion = ''
try { $AppVersion = [string](Get-Content -LiteralPath (Join-Path $Root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { }

$script:Cancel = $false
$script:Running = $false
$script:CloseAfter = $false
$script:Action = 'install'
$script:Proc = $null
$script:LogBox = $null
$script:NodeExe = $null

# ───────────── 공통 도구(창 없이도 동작) ─────────────

function Log([string]$s) {
  if ($null -eq $s) { return }
  $s = $s -replace "\x1b\[[0-9;]*[A-Za-z]", ''
  try { [IO.File]::AppendAllText($LogPath, $s + "`r`n", (New-Object Text.UTF8Encoding($false))) } catch { }
  if ($script:LogBox) { try { $script:LogBox.AppendText($s + "`r`n") } catch { } }
  if ($script:LoginLink -and $s -match '(https://dash\.cloudflare\.com/oauth2/auth\S+)') {
    $script:LoginUrl = $Matches[1]
    $script:LoginLink.Visible = $true
  }
}

function Pump { if ($script:Ui) { [Windows.Forms.Application]::DoEvents() } }
function Check-Cancel { if ($script:Cancel) { throw 'CANCELLED' } }
function Wait-Ms([int]$ms) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $ms) { Pump; Check-Cancel; Start-Sleep -Milliseconds 40 }
}

function Quote-Arg([string]$a) {
  if ($a -eq '') { return '""' }
  if ($a -notmatch '[\s"]') { return $a }
  $q = $a -replace '(\\*)"', '$1$1\"'
  $q = $q -replace '(\\+)$', '$1$1'
  return '"' + $q + '"'
}

function Kill-Tree($p) {
  try { if (-not $p.HasExited) { & taskkill.exe /T /F /PID $p.Id 2>&1 | Out-Null } } catch { }
  try { if (-not $p.HasExited) { $p.Kill() } } catch { }
}

# 외부 프로그램을 창이 멈추지 않게 실행(출력은 한 줄씩 기록). Out = 표준 출력만, All = 둘 다
function Run-Proc([string]$exe, [string[]]$argv, [string]$stdin = $null, [switch]$Quiet) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = (@($argv) | ForEach-Object { Quote-Arg $_ }) -join ' '
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.RedirectStandardInput = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
  $p = [Diagnostics.Process]::Start($psi)
  $script:Proc = $p
  if ($stdin) { $p.StandardInput.Write($stdin) }
  $p.StandardInput.Close()
  $out = New-Object Text.StringBuilder
  $all = New-Object Text.StringBuilder
  $rs = @(
    @{ R = $p.StandardOutput; T = $null; O = $true },
    @{ R = $p.StandardError; T = $null; O = $false }
  )
  foreach ($r in $rs) { $r.T = $r.R.ReadLineAsync() }
  $open = 2
  while ($open -gt 0) {
    $idle = $true
    foreach ($r in $rs) {
      if ($null -ne $r.T -and $r.T.IsCompleted) {
        $idle = $false
        $line = $r.T.Result
        if ($null -eq $line) { $r.T = $null; $open-- }
        else {
          if ($r.O) { [void]$out.AppendLine($line) }
          [void]$all.AppendLine($line)
          if (-not $Quiet) { Log $line }
          $r.T = $r.R.ReadLineAsync()
        }
      }
    }
    Pump
    if ($script:Cancel) { Kill-Tree $p; $script:Proc = $null; throw 'CANCELLED' }
    if ($idle) { Start-Sleep -Milliseconds 40 }
  }
  $p.WaitForExit()
  $script:Proc = $null
  return [pscustomobject]@{ Code = $p.ExitCode; Out = $out.ToString(); All = $all.ToString() }
}

function WR([string[]]$a, [string]$stdin = $null, [switch]$Quiet) {
  return Run-Proc $script:NodeExe (@($WranglerJs) + @($a)) $stdin -Quiet:$Quiet
}

function Wait-Task($t, [int]$timeoutSec, $wc) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while (-not $t.IsCompleted) {
    Pump
    if ($script:Cancel) { if ($wc) { $wc.CancelAsync() }; throw 'CANCELLED' }
    if ($timeoutSec -gt 0 -and $sw.Elapsed.TotalSeconds -gt $timeoutSec) { if ($wc) { $wc.CancelAsync() }; throw '응답 시간이 지났습니다' }
    Start-Sleep -Milliseconds 40
  }
  if ($t.IsFaulted) { throw $t.Exception.InnerException }
  if ($t.IsCanceled) { throw '취소됨' }
}

function New-Web($headers) {
  $wc = New-Object Net.WebClient
  $wc.Encoding = [Text.Encoding]::UTF8
  $wc.Headers['User-Agent'] = 'classboard-installer'
  if ($headers) { foreach ($k in $headers.Keys) { $wc.Headers[$k] = $headers[$k] } }
  return $wc
}
function Fetch-Text([string]$url, [int]$timeoutSec = 20, $headers = $null) {
  $wc = New-Web $headers
  $t = $wc.DownloadStringTaskAsync($url)
  Wait-Task $t $timeoutSec $wc
  return $t.Result
}
function Post-Json([string]$url, $body, [int]$timeoutSec = 30) {
  $wc = New-Web @{ 'Content-Type' = 'application/json; charset=utf-8' }
  $t = $wc.UploadStringTaskAsync($url, 'POST', ($body | ConvertTo-Json -Compress))
  Wait-Task $t $timeoutSec $wc
  return $t.Result
}
# 실패한 요청에서 HTTP 상태와 서버가 보낸 오류(JSON)를 꺼냄
function Web-Error($e) {
  $x = $e
  while ($x -and -not ($x -is [Net.WebException]) -and $x.InnerException) { $x = $x.InnerException }
  $r = [pscustomobject]@{ Status = 0; Code = ''; Message = "$($e.Message)" }
  if ($x -is [Net.WebException] -and $x.Response) {
    try { $r.Status = [int]$x.Response.StatusCode } catch { }
    try {
      $sr = New-Object IO.StreamReader($x.Response.GetResponseStream(), [Text.Encoding]::UTF8)
      $txt = $sr.ReadToEnd(); $sr.Close()
      $j = $txt | ConvertFrom-Json
      $d = $j; if ($j.detail) { $d = $j.detail }
      if ($d.error) { $r.Code = [string]$d.error }
      if ($d.message) { $r.Message = [string]$d.message }
    } catch { }
  }
  return $r
}

# Cloudflare API(짧은 요청이라 그대로 기다림)
function Cf($method, $path, $body) {
  $h = @{ Authorization = "Bearer $script:CfToken" }
  $p = @{ Method = $method; Uri = "https://api.cloudflare.com/client/v4$path"; Headers = $h; UseBasicParsing = $true; ErrorAction = 'Stop'; TimeoutSec = 30 }
  if ($body) { $p.Body = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Compress)); $p.ContentType = 'application/json' }
  Pump
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

function Test-SubName([string]$n) {
  if (-not $n) { return '주소 이름을 넣으세요.' }
  if ($n -match '[^\x00-\x7F]') { return '주소 이름에 한글이 들어갔습니다. 영어 소문자로 넣으세요.' }
  if ($n -cnotmatch '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$') { return '주소 이름은 영어 소문자·숫자·- 만 쓰고, -로 시작하거나 끝나면 안 됩니다.' }
  return $null
}
function Test-LoginId([string]$n) { return ($n -match '^[A-Za-z0-9_.-]{3,30}$') }

function New-SetupKey {
  $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.ToCharArray()
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] 16; $rng.GetBytes($bytes)
  $raw = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
  return (($raw -split '(.{4})' | Where-Object { $_ }) -join '-')
}

function Read-DeployUrl([string]$file) {
  $url = $null
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  foreach ($line in Get-Content -LiteralPath $file -Encoding UTF8) {
    try { $o = $line | ConvertFrom-Json } catch { continue }
    if ($o.type -eq 'deploy' -and $o.targets) {
      $url = @($o.targets | Where-Object { $_ -match 'workers\.dev' })[0]
      if (-not $url) { $url = @($o.targets)[0] }
    }
  }
  return $url
}

function First-Error([string]$text) {
  $lines = @($text -split "`r?`n" | ForEach-Object { ($_ -replace "\x1b\[[0-9;]*[A-Za-z]", '').Trim() } | Where-Object { $_ })
  $e = @($lines | Where-Object { $_ -match '\[ERROR\]|^Error|✘' })
  if ($e.Count -gt 0) { return ($e[0] -replace '^[✘X\s]*\[ERROR\]\s*', '') }
  if ($lines.Count -gt 0) { return $lines[-1] }
  return ''
}

function Load-Info {
  if (Test-Path -LiteralPath $InfoPath) { try { return (Get-Content -LiteralPath $InfoPath -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { } }
  return $null
}

# 시험할 때는 여기까지만 읽음
if ($env:CLASSBOARD_GUI_TEST -eq '1') { return }

# ───────────── 창 준비 ─────────────

try {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
  Add-Type -AssemblyName System.Drawing -ErrorAction Stop
} catch { exit 1 }
try { Add-Type -Namespace ClassboardSetup -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' -ErrorAction Stop; [void][ClassboardSetup.Native]::SetProcessDPIAware() } catch { }
try { [Windows.Forms.Application]::EnableVisualStyles() } catch { }
try { [Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false) } catch { }
$script:Ui = $true

try {
  [IO.File]::WriteAllText($LogPath, "classboard 설치 기록 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  (판 $AppVersion)`r`n설치 폴더: $Root`r`n", (New-Object Text.UTF8Encoding($false)))
} catch { }

$Info = Load-Info
$PrevEdition = ''
if ($Info -and $Info.edition) { $PrevEdition = [string]$Info.edition }
elseif (Test-Path -LiteralPath (Join-Path $Work 'edition.txt')) { $PrevEdition = (Get-Content -LiteralPath (Join-Path $Work 'edition.txt') -Raw).Trim() }
$script:Mode = 'install'
if ($Info -and $Info.url) { $script:Mode = 'update' }

$F = New-Object Drawing.Font('Malgun Gothic', 10)
$FB = New-Object Drawing.Font('Malgun Gothic', 10, [Drawing.FontStyle]::Bold)
$FS = New-Object Drawing.Font('Malgun Gothic', 9)
$FH = New-Object Drawing.Font('Malgun Gothic', 15, [Drawing.FontStyle]::Bold)
$FBig = New-Object Drawing.Font('Malgun Gothic', 13, [Drawing.FontStyle]::Bold)
$FMark = New-Object Drawing.Font('Segoe UI Symbol', 10, [Drawing.FontStyle]::Bold)
$FLog = New-Object Drawing.Font('Consolas', 9)
$U = [int][Math]::Ceiling($F.Height)
if ($U -lt 12) { $U = 17 }

$cBlue = [Drawing.Color]::FromArgb(31, 111, 235)
$cGray = [Drawing.Color]::FromArgb(105, 105, 105)
$cGreen = [Drawing.Color]::FromArgb(26, 127, 55)
$cRed = [Drawing.Color]::FromArgb(200, 30, 40)

function New-Label([string]$text, $font = $null, $color = $null, [int]$maxW = 0) {
  $l = New-Object Windows.Forms.Label
  $l.Text = $text
  $l.AutoSize = $true
  if ($font) { $l.Font = $font }
  if ($color) { $l.ForeColor = $color }
  if ($maxW -gt 0) { $l.MaximumSize = New-Object Drawing.Size($maxW, 0) }
  $l.Margin = New-Object Windows.Forms.Padding(3, [int]($U * 0.3), 3, 2)
  return $l
}
function New-Button([string]$text) {
  $b = New-Object Windows.Forms.Button
  $b.Text = $text
  $b.AutoSize = $true
  $b.MinimumSize = New-Object Drawing.Size([int]($U * 5.5), [int]($U * 1.9))
  $b.Padding = New-Object Windows.Forms.Padding([int]($U * 0.4), 0, [int]($U * 0.4), 0)
  $b.Margin = New-Object Windows.Forms.Padding(4, [int]($U * 0.35), 4, [int]($U * 0.35))
  return $b
}
function New-Text([int]$w, [switch]$Ascii, [switch]$Password) {
  $t = New-Object Windows.Forms.TextBox
  $t.Width = $w
  $t.Margin = New-Object Windows.Forms.Padding(3, [int]($U * 0.2), 3, 2)
  if ($Ascii) { $t.ImeMode = [Windows.Forms.ImeMode]::Disable }
  if ($Password) { $t.UseSystemPasswordChar = $true; $t.ImeMode = [Windows.Forms.ImeMode]::Disable }
  return $t
}
function New-Num([int]$min, [int]$max, [int]$val) {
  $n = New-Object Windows.Forms.NumericUpDown
  $n.Minimum = $min; $n.Maximum = $max; $n.Value = $val
  $n.Width = [int]($U * 3.6)
  $n.TextAlign = 'Right'
  $n.Margin = New-Object Windows.Forms.Padding(3, [int]($U * 0.2), 2, 2)
  return $n
}
function New-Flow {
  $f = New-Object Windows.Forms.FlowLayoutPanel
  $f.AutoSize = $true
  $f.WrapContents = $false
  $f.Margin = New-Object Windows.Forms.Padding(0)
  return $f
}

# ───────────── 창 ─────────────

$form = New-Object Windows.Forms.Form
$form.Text = 'classboard 전자칠판 설치'
$form.Font = $F
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.ClientSize = New-Object Drawing.Size([int]($U * 36), [int]($U * 33))
$W = [int]($U * 33)     # 내용 폭(줄바꿈 기준)

# 위: 제목
$header = New-Object Windows.Forms.Panel
$header.Dock = 'Top'
$header.Height = [int]($U * 3.8)
$header.BackColor = $cBlue
$lblTitle = New-Label 'classboard 전자칠판 설치' $FH ([Drawing.Color]::White)
$lblTitle.Location = New-Object Drawing.Point([int]($U * 0.9), [int]($U * 0.35))
$lblSub = New-Label '' $FS ([Drawing.Color]::White) ([int]($U * 34))
$lblSub.Location = New-Object Drawing.Point([int]($U * 1.0), [int]($U * 2.25))
$header.Controls.Add($lblTitle)
$header.Controls.Add($lblSub)

# 아래: 버튼
$footer = New-Object Windows.Forms.TableLayoutPanel
$footer.Dock = 'Bottom'
$footer.Height = [int]($U * 3.0)
$footer.ColumnCount = 2
[void]$footer.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle([Windows.Forms.SizeType]::Percent, 50)))
[void]$footer.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle([Windows.Forms.SizeType]::Percent, 50)))
$footer.Padding = New-Object Windows.Forms.Padding([int]($U * 0.6), 0, [int]($U * 0.6), 0)
$footL = New-Flow
$footL.Dock = 'Fill'
$footR = New-Flow
$footR.Dock = 'Fill'
$footR.FlowDirection = 'RightToLeft'
$footer.Controls.Add($footL, 0, 0)
$footer.Controls.Add($footR, 1, 0)

$btnMain = New-Button '설치 시작'
$btnMain.Font = $FB
$btnClose = New-Button '닫기'
$btnBack = New-Button '이전'
$btnLog = New-Button '자세히 보기'
$btnOpenLog = New-Button '기록 파일 열기'
$footR.Controls.Add($btnMain)
$footR.Controls.Add($btnClose)
$footR.Controls.Add($btnBack)
$footL.Controls.Add($btnLog)
$footL.Controls.Add($btnOpenLog)

# 가운데: 화면들
$body = New-Object Windows.Forms.Panel
$body.Dock = 'Fill'
$body.Padding = New-Object Windows.Forms.Padding([int]($U * 0.9), [int]($U * 0.6), [int]($U * 0.9), 0)

$form.Controls.Add($body)
$form.Controls.Add($footer)
$form.Controls.Add($header)
$body.BringToFront()

# ── 화면 1: 입력 ──
$pgForm = New-Object Windows.Forms.TableLayoutPanel
$pgForm.Dock = 'Fill'
$pgForm.AutoScroll = $true
$pgForm.ColumnCount = 2
[void]$pgForm.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle([Windows.Forms.SizeType]::AutoSize)))
[void]$pgForm.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle([Windows.Forms.SizeType]::Percent, 100)))
$script:Rows = @{}

function Add-Row([string]$key, [string]$label, $control, [string]$help = '') {
  $items = @()
  $r = $pgForm.RowCount
  $pgForm.RowCount = $r + 1
  [void]$pgForm.RowStyles.Add((New-Object Windows.Forms.RowStyle([Windows.Forms.SizeType]::AutoSize)))
  if ($label) {
    $l = New-Label $label $FB
    $pgForm.Controls.Add($l, 0, $r)
    $pgForm.Controls.Add($control, 1, $r)
    $items += $l
  } else {
    $pgForm.Controls.Add($control, 0, $r)
    $pgForm.SetColumnSpan($control, 2)
  }
  $items += $control
  if ($help) {
    $r2 = $pgForm.RowCount
    $pgForm.RowCount = $r2 + 1
    [void]$pgForm.RowStyles.Add((New-Object Windows.Forms.RowStyle([Windows.Forms.SizeType]::AutoSize)))
    $h = New-Label $help $FS $cGray ([int]($U * 24))
    $h.Margin = New-Object Windows.Forms.Padding(3, 0, 3, [int]($U * 0.45))
    $pgForm.Controls.Add($h, 1, $r2)
    $items += $h
  }
  $script:Rows[$key] = $items
  return $items
}
function Show-Row([string]$key, [bool]$on) { foreach ($c in $script:Rows[$key]) { $c.Visible = $on } }

$lblUpdate = New-Label '' $F $null $W
[void](Add-Row 'update' '' $lblUpdate)

$edFlow = New-Flow
$rbBasic = New-Object Windows.Forms.RadioButton
$rbBasic.Text = '기본판'; $rbBasic.AutoSize = $true
$rbStorage = New-Object Windows.Forms.RadioButton
$rbStorage.Text = '확장판'; $rbStorage.AutoSize = $true
$rbStorage.Margin = New-Object Windows.Forms.Padding([int]($U * 1.2), 3, 3, 3)
$lnkCompare = New-Object Windows.Forms.LinkLabel
$lnkCompare.Text = '판 비교 보기'
$lnkCompare.AutoSize = $true
$lnkCompare.Font = $FB
$lnkCompare.Margin = New-Object Windows.Forms.Padding([int]($U * 1.6), 4, 3, 3)
$lnkCompare.Add_LinkClicked({ Show-EditionCompare })
$edFlow.Controls.Add($rbBasic)
$edFlow.Controls.Add($rbStorage)
$edFlow.Controls.Add($lnkCompare)
if ($PrevEdition -eq 'storage') { $rbStorage.Checked = $true } else { $rbBasic.Checked = $true }
[void](Add-Row 'edition' '판' $edFlow '기본판: 카드 등록 없이 무료(자료 700MB, 판서 재생 60일). 확장판: R2 사용(자료 6GB, 판서 기록 계속 보관). 확장판은 Cloudflare 에 카드(또는 PayPal)를 등록하고 R2 를 먼저 켜야 합니다. 로컬판(가입 없이 교사 PC 한 대)과 서버판(합반·원격 수업)은 [판 비교 보기]에 있습니다.')

$tbSub = New-Text ([int]($U * 13)) -Ascii
$tbSub.CharacterCasing = 'Lower'
$tbSub.MaxLength = 63
$subHelpBase = '영어 소문자·숫자·- 만 씁니다. 계정에 이미 정한 이름이 있으면 그 이름을 그대로 씁니다.'
$items = Add-Row 'sub' '주소 이름' $tbSub ('주소: https://classboard.(이름).workers.dev' + "`n" + $subHelpBase)
$lblSubHelp = $items[-1]
$tbSub.Add_TextChanged({
  $n = $tbSub.Text.Trim()
  if (-not $n) { $n = '(이름)' }
  $lblSubHelp.Text = "주소: https://classboard.$n.workers.dev`n$subHelpBase"
})

$clsFlow = New-Flow
$numGrade = New-Num 1 6 5
$numClass = New-Num 1 30 1
$numSize = New-Num 1 60 25
$clsFlow.Controls.Add($numGrade); $clsFlow.Controls.Add((New-Label '학년'))
$clsFlow.Controls.Add($numClass); $clsFlow.Controls.Add((New-Label '반'))
$clsFlow.Controls.Add($numSize); $clsFlow.Controls.Add((New-Label '명'))
[void](Add-Row 'class' '학급' $clsFlow)

$tbName = New-Text ([int]($U * 9))
$tbName.MaxLength = 20
[void](Add-Row 'name' '교사 이름' $tbName '칠판에 보일 이름입니다. 비워 두면 "선생님".')

$tbId = New-Text ([int]($U * 9)) -Ascii
$tbId.MaxLength = 30
[void](Add-Row 'id' '아이디' $tbId '영어·숫자 3~30자. 칠판에 로그인할 때 씁니다.')

$tbPw = New-Text ([int]($U * 9)) -Password
[void](Add-Row 'pw' '비밀번호' $tbPw)
$tbPw2 = New-Text ([int]($U * 9)) -Password
[void](Add-Row 'pw2' '비밀번호 확인' $tbPw2 '8자 이상. 이 PC 에는 저장하지 않습니다.')

$chkRelogin = New-Object Windows.Forms.CheckBox
$chkRelogin.Text = '다른 Cloudflare 계정으로 로그인하기'
$chkRelogin.AutoSize = $true
$chkRelogin.Font = $FS
$chkRelogin.Margin = New-Object Windows.Forms.Padding(3, [int]($U * 0.5), 3, 0)
[void](Add-Row 'relogin' '' $chkRelogin)

$lnkMode = New-Object Windows.Forms.LinkLabel
$lnkMode.AutoSize = $true
$lnkMode.Font = $FS
$lnkMode.Margin = New-Object Windows.Forms.Padding(3, [int]($U * 0.3), 3, 0)
[void](Add-Row 'modelink' '' $lnkMode)

$lnkRemove = New-Object Windows.Forms.LinkLabel
$lnkRemove.Text = '칠판 지우기(Cloudflare 와 이 PC 에서 삭제)'
$lnkRemove.AutoSize = $true
$lnkRemove.Font = $FS
$lnkRemove.LinkColor = $cRed
$lnkRemove.Margin = New-Object Windows.Forms.Padding(3, [int]($U * 0.6), 3, 0)
[void](Add-Row 'remove' '' $lnkRemove)

# ── 화면 2: 진행 ──
$pgRun = New-Object Windows.Forms.TableLayoutPanel
$pgRun.Dock = 'Fill'
$pgRun.ColumnCount = 1
$pgRun.RowCount = 4
[void]$pgRun.RowStyles.Add((New-Object Windows.Forms.RowStyle([Windows.Forms.SizeType]::AutoSize)))
[void]$pgRun.RowStyles.Add((New-Object Windows.Forms.RowStyle([Windows.Forms.SizeType]::AutoSize)))
[void]$pgRun.RowStyles.Add((New-Object Windows.Forms.RowStyle([Windows.Forms.SizeType]::AutoSize)))
[void]$pgRun.RowStyles.Add((New-Object Windows.Forms.RowStyle([Windows.Forms.SizeType]::Percent, 100)))
$stepTbl = New-Object Windows.Forms.TableLayoutPanel
$stepTbl.AutoSize = $true
$stepTbl.ColumnCount = 2
[void]$stepTbl.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle([Windows.Forms.SizeType]::AutoSize)))
[void]$stepTbl.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle([Windows.Forms.SizeType]::AutoSize)))
$lblStatus = New-Label '' $FB $null $W
$lblStatus.Margin = New-Object Windows.Forms.Padding(3, [int]($U * 0.8), 3, [int]($U * 0.4))
$bar = New-Object Windows.Forms.ProgressBar
$bar.Style = 'Marquee'
$bar.MarqueeAnimationSpeed = 30
$bar.Width = $W
$bar.Height = [int]($U * 0.9)
$txtLog = New-Object Windows.Forms.TextBox
$txtLog.Multiline = $true
$txtLog.ReadOnly = $true
$txtLog.ScrollBars = 'Vertical'
$txtLog.Font = $FLog
$txtLog.Dock = 'Fill'
$txtLog.Visible = $false
$txtLog.Margin = New-Object Windows.Forms.Padding(3, [int]($U * 0.6), 3, 3)
$pgRun.Controls.Add($stepTbl, 0, 0)
$pgRun.Controls.Add($lblStatus, 0, 1)
$lnkLogin = New-Object Windows.Forms.LinkLabel
$lnkLogin.Text = '브라우저가 열리지 않았으면 여기를 눌러 로그인 화면을 여세요'
$lnkLogin.AutoSize = $true
$lnkLogin.Visible = $false
$lnkLogin.Margin = New-Object Windows.Forms.Padding(3, 0, 3, [int]($U * 0.4))
$lnkLogin.Add_LinkClicked({ if ($script:LoginUrl) { Start-Process $script:LoginUrl } })
$runTop = New-Object Windows.Forms.FlowLayoutPanel
$runTop.FlowDirection = 'TopDown'
$runTop.WrapContents = $false
$runTop.AutoSize = $true
$runTop.Margin = New-Object Windows.Forms.Padding(0)
$runTop.Controls.Add($lnkLogin)
$runTop.Controls.Add($bar)
$pgRun.Controls.Add($runTop, 0, 2)
$pgRun.Controls.Add($txtLog, 0, 3)
$script:LoginLink = $lnkLogin
$script:LogBox = $txtLog
$script:StepMarks = @()
$script:StepTexts = @()

function Init-Steps([string[]]$names) {
  $stepTbl.SuspendLayout()
  $stepTbl.Controls.Clear()
  $stepTbl.RowStyles.Clear()
  $stepTbl.RowCount = $names.Count
  $script:StepMarks = @()
  $script:StepTexts = @()
  for ($i = 0; $i -lt $names.Count; $i++) {
    [void]$stepTbl.RowStyles.Add((New-Object Windows.Forms.RowStyle([Windows.Forms.SizeType]::AutoSize)))
    $m = New-Label ([string][char]0x25CB) $FMark $cGray
    $t = New-Label $names[$i] $F $cGray
    $stepTbl.Controls.Add($m, 0, $i)
    $stepTbl.Controls.Add($t, 1, $i)
    $script:StepMarks += $m
    $script:StepTexts += $t
  }
  $stepTbl.ResumeLayout()
}
function Set-Step([int]$i, [string]$state) {
  if ($i -lt 0 -or $i -ge $script:StepMarks.Count) { return }
  $m = $script:StepMarks[$i]; $t = $script:StepTexts[$i]
  switch ($state) {
    'run'  { $m.Text = [string][char]0x25B6; $m.ForeColor = $cBlue;  $t.ForeColor = [Drawing.Color]::Black; $t.Font = $FB }
    'ok'   { $m.Text = [string][char]0x2713; $m.ForeColor = $cGreen; $t.ForeColor = [Drawing.Color]::Black; $t.Font = $F }
    'skip' { $m.Text = [string][char]0x2013; $m.ForeColor = $cGray;  $t.ForeColor = $cGray; $t.Font = $F }
    'fail' { $m.Text = [string][char]0x2715; $m.ForeColor = $cRed;   $t.ForeColor = $cRed; $t.Font = $FB }
  }
  Pump
}
function Set-Status([string]$text, $color = $null) {
  $lblStatus.Text = $text
  if ($color) { $lblStatus.ForeColor = $color } else { $lblStatus.ForeColor = [Drawing.Color]::Black }
  Log "· $text"
  Pump
}

# ── 화면 3: 완료 ──
$pgDone = New-Object Windows.Forms.FlowLayoutPanel
$pgDone.Dock = 'Fill'
$pgDone.FlowDirection = 'TopDown'
$pgDone.WrapContents = $false
$pgDone.AutoScroll = $true
$lblDoneTitle = New-Label '' $FBig $cGreen $W
$lnkUrl = New-Object Windows.Forms.LinkLabel
$lnkUrl.AutoSize = $true
$lnkUrl.Font = $FBig
$lnkUrl.Margin = New-Object Windows.Forms.Padding(3, [int]($U * 0.6), 3, [int]($U * 0.3))
$doneBtns = New-Flow
$btnCopy = New-Button '주소 복사'
$btnMemo = New-Button '설치 정보 열기'
$doneBtns.Controls.Add($btnCopy)
$doneBtns.Controls.Add($btnMemo)
$lblDone = New-Label '' $F $null $W
$lblDone.Margin = New-Object Windows.Forms.Padding(3, [int]($U * 0.6), 3, 3)
$pgDone.Controls.Add($lblDoneTitle)
$pgDone.Controls.Add($lnkUrl)
$pgDone.Controls.Add($doneBtns)
$pgDone.Controls.Add($lblDone)

$body.Controls.Add($pgForm)
$body.Controls.Add($pgRun)
$body.Controls.Add($pgDone)

$script:State = 'form'
function Show-Page([string]$name) {
  $pgForm.Visible = ($name -eq 'form')
  $pgRun.Visible = ($name -eq 'run')
  $pgDone.Visible = ($name -eq 'done')
}

function Apply-Mode {
  $upd = ($script:Mode -eq 'update')
  $lblTitle.Text = 'classboard 전자칠판 설치'
  foreach ($k in @('sub', 'class', 'name', 'id', 'pw', 'pw2')) { Show-Row $k (-not $upd) }
  Show-Row 'update' $upd
  if ($upd) {
    $lblSub.Text = '새 버전으로 업데이트합니다. 판서·자료·설정은 그대로입니다.'
    if ($Info -and $Info.url) { $lblUpdate.Text = "이 PC 에서 설치한 칠판: $($Info.url)`n새 파일로 다시 올립니다. 판서·자료·설정·로그인은 바뀌지 않습니다." }
    else { $lblUpdate.Text = "이미 설치한 칠판을 새 파일로 다시 올립니다. 판서·자료·설정·로그인은 바뀌지 않습니다.`n칠판을 설치한 Cloudflare 계정으로 로그인하세요." }
    $lnkMode.Text = '업데이트 대신 처음부터 새로 설치하기(다른 계정 등)'
    $btnMain.Text = '업데이트'
  } else {
    $lblSub.Text = '정보를 넣고 [설치 시작]을 누르면 끝까지 혼자 진행합니다. (판 ' + $AppVersion + ')'
    $lnkMode.Text = '이미 설치한 칠판이면 여기를 눌러 업데이트하기'
    $btnMain.Text = '설치 시작'
  }
}

function Set-Buttons([string]$state) {
  $script:State = $state
  $btnBack.Visible = $false
  $btnOpenLog.Visible = $false
  $btnLog.Visible = ($state -ne 'form')
  $btnMain.Enabled = $true
  $btnClose.Text = '닫기'
  switch ($state) {
    'form'    { Apply-Mode }
    'running' { $btnMain.Text = '진행 중…'; $btnMain.Enabled = $false; $btnClose.Text = '취소' }
    'error'   { $btnMain.Text = '다시 시도'; $btnBack.Visible = $true; $btnOpenLog.Visible = $true }
    'done'    { $btnMain.Text = '칠판 열기' }
    'removed' { $btnMain.Text = '폴더 열기'; $btnLog.Visible = $false }
  }
}

# ───────────── 작은 대화 상자 ─────────────

# 판 비교: 네 판을 한눈에. 기본판·확장판은 여기서 바로 고름(로컬판은 준비 중, 서버판은 곧 릴리스)
function Show-EditionCompare {
  $d = New-Object Windows.Forms.Form
  $d.Text = '판 비교 - 어느 판을 설치할까요?'; $d.Font = $F
  $d.FormBorderStyle = 'FixedDialog'; $d.MaximizeBox = $false; $d.MinimizeBox = $false
  $d.StartPosition = 'CenterParent'
  $d.AutoSize = $true; $d.AutoSizeMode = 'GrowAndShrink'
  $d.Padding = New-Object Windows.Forms.Padding($U)

  $cols = @('로컬판', '기본판', '확장판', '서버판')
  $rows = @(
    @('설치 위치',            '교사 PC 한 대',        'Cloudflare 무료 계정', 'Cloudflare 무료 계정 + R2', '학교·개인 서버(Docker)'),
    @('가입·카드',            '필요 없음',            'Cloudflare 가입 (카드 없음)', '가입 + 카드 또는 PayPal 등록 (무료 10GB 안에서는 청구 없음)', '필요 없음'),
    @('학생 호출(칠판에 풀기)', '안 됨',               '됨',                   '됨',                         '됨'),
    @('교사 태블릿·전자칠판 함께 쓰기', '안 됨 (기기 하나)', '됨',             '됨',                         '됨'),
    @('집에서 판서 기록 보기',  '안 됨',               '됨',                   '됨',                         '됨'),
    @('사진·PDF 자료',         'PC 디스크만큼',        '700MB',                '6GB',                        '서버 디스크만큼'),
    @('차시에 붙이는 자료',     'PC 디스크만큼',        '300MB',                '2GB',                        '서버 디스크만큼'),
    @('판서 재생 기록',         '계속 보관',            '60일 (그 뒤 완성된 판서만)', '계속 보관',            '계속 보관'),
    @('동영상 파일',            '이 기기에서 재생',      '이 기기에서 재생',      '이 기기에서 재생',            '서버에 올려 모든 기기에서'),
    @('합반·원격 수업',         '안 됨',               '안 됨',                '안 됨',                      '됨'),
    @('백업 내려받기·되살리기', '됨',                  '됨',                   '됨',                         '됨'),
    @('이런 분께',              '가입 없이 판서·진도 도구만 쓸 분', '대부분의 선생님', '판서 기록을 오래 쌓거나 자료를 많이 둘 분', '서버를 운영하는 분'),
    @('상태',                   '준비 중',              '설치 가능',            '설치 가능',                  '곧 릴리스')
  )

  $f = New-Object Windows.Forms.FlowLayoutPanel
  $f.FlowDirection = 'TopDown'; $f.AutoSize = $true; $f.WrapContents = $false
  $f.Controls.Add((New-Label '판마다 할 수 있는 일과 필요한 것이 다릅니다. 나중에 판을 바꿔도 판서·설정은 백업으로 옮길 수 있습니다.' $F $null ([int]($U * 40))))

  $t = New-Object Windows.Forms.TableLayoutPanel
  $t.AutoSize = $true
  $t.CellBorderStyle = 'Single'
  $t.BackColor = [Drawing.Color]::White
  $t.ColumnCount = 5
  $t.RowCount = $rows.Count + 1
  $t.Margin = New-Object Windows.Forms.Padding(3, [int]($U * 0.5), 3, [int]($U * 0.5))
  for ($c = 0; $c -lt 5; $c++) { [void]$t.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle([Windows.Forms.SizeType]::AutoSize))) }
  $cellW = [int]($U * 8.2)
  $cellLabel = {
    param([string]$text, $font, $color, $back)
    $l = New-Label $text $font $color $cellW
    $l.Margin = New-Object Windows.Forms.Padding([int]($U * 0.3), [int]($U * 0.15), [int]($U * 0.3), [int]($U * 0.15))
    if ($back) { $l.BackColor = $back }
    return $l
  }
  $cHead = [Drawing.Color]::FromArgb(232, 240, 254)
  $t.Controls.Add((& $cellLabel '' $FB $null $null), 0, 0)
  for ($c = 0; $c -lt 4; $c++) {
    $name = $cols[$c]
    $color = if ($c -eq 1 -or $c -eq 2) { $cBlue } else { $cGray }
    $t.Controls.Add((& $cellLabel $name $FBig $color $null), $c + 1, 0)
  }
  for ($r = 0; $r -lt $rows.Count; $r++) {
    $row = $rows[$r]
    $t.Controls.Add((& $cellLabel $row[0] $FB $null $null), 0, $r + 1)
    for ($c = 1; $c -le 4; $c++) {
      $v = $row[$c]
      $color = $null
      if ($v -like '안 됨*') { $color = $cGray }
      elseif ($v -eq '됨' -or $v -eq '설치 가능') { $color = $cGreen }
      $back = if ($c -eq 2 -or $c -eq 3) { $cHead } else { $null }
      $t.Controls.Add((& $cellLabel $v $FS $color $back), $c, $r + 1)
    }
  }
  $f.Controls.Add($t)
  $f.Controls.Add((New-Label '이 설치 창은 기본판·확장판을 설치합니다. 확장판은 Cloudflare 대시보드 → R2 Object Storage 에서 R2 를 먼저 켜야 합니다.' $FS $cGray ([int]($U * 40))))

  $bf = New-Flow
  $bBasic = New-Button '기본판으로 설치'; $bBasic.DialogResult = 'Yes'
  $bStorage = New-Button '확장판으로 설치'; $bStorage.DialogResult = 'No'
  $bClose = New-Button '닫기'; $bClose.DialogResult = 'Cancel'
  $bBasic.Font = $FB
  $bf.Controls.Add($bBasic); $bf.Controls.Add($bStorage); $bf.Controls.Add($bClose)
  $f.Controls.Add($bf)
  $d.Controls.Add($f)
  $d.CancelButton = $bClose
  $r = $d.ShowDialog($form)
  $d.Dispose()
  if ($r -eq 'Yes') { $rbBasic.Checked = $true }
  elseif ($r -eq 'No') { $rbStorage.Checked = $true }
}

function Ask-Text([string]$title, [string]$message, [string]$initial = '') {
  $d = New-Object Windows.Forms.Form
  $d.Text = $title; $d.Font = $F
  $d.FormBorderStyle = 'FixedDialog'; $d.MaximizeBox = $false; $d.MinimizeBox = $false
  $d.StartPosition = 'CenterParent'
  $d.AutoSize = $true; $d.AutoSizeMode = 'GrowAndShrink'
  $d.Padding = New-Object Windows.Forms.Padding($U)
  $f = New-Object Windows.Forms.FlowLayoutPanel
  $f.FlowDirection = 'TopDown'; $f.AutoSize = $true; $f.WrapContents = $false
  $f.Controls.Add((New-Label $message $F $null ([int]($U * 22))))
  $t = New-Text ([int]($U * 14)) -Ascii
  $t.CharacterCasing = 'Lower'
  $t.Text = $initial
  $f.Controls.Add($t)
  $bf = New-Flow
  $ok = New-Button '확인'; $ok.DialogResult = 'OK'
  $no = New-Button '멈추기'; $no.DialogResult = 'Cancel'
  $bf.Controls.Add($ok); $bf.Controls.Add($no)
  $f.Controls.Add($bf)
  $d.Controls.Add($f)
  $d.AcceptButton = $ok; $d.CancelButton = $no
  $r = $d.ShowDialog($form)
  $v = $t.Text.Trim().ToLower()
  $d.Dispose()
  if ($r -ne 'OK') { return $null }
  return $v
}

function Choose-Item([string]$title, [string]$message, [string[]]$names) {
  $d = New-Object Windows.Forms.Form
  $d.Text = $title; $d.Font = $F
  $d.FormBorderStyle = 'FixedDialog'; $d.MaximizeBox = $false; $d.MinimizeBox = $false
  $d.StartPosition = 'CenterParent'
  $d.AutoSize = $true; $d.AutoSizeMode = 'GrowAndShrink'
  $d.Padding = New-Object Windows.Forms.Padding($U)
  $f = New-Object Windows.Forms.FlowLayoutPanel
  $f.FlowDirection = 'TopDown'; $f.AutoSize = $true; $f.WrapContents = $false
  $f.Controls.Add((New-Label $message $F $null ([int]($U * 22))))
  $lb = New-Object Windows.Forms.ListBox
  $lb.Width = [int]($U * 22)
  $lb.Height = [int]($U * 1.3 * [Math]::Min(8, [Math]::Max(3, $names.Count))) + 6
  foreach ($n in $names) { [void]$lb.Items.Add($n) }
  $lb.SelectedIndex = 0
  $f.Controls.Add($lb)
  $bf = New-Flow
  $ok = New-Button '확인'; $ok.DialogResult = 'OK'
  $no = New-Button '멈추기'; $no.DialogResult = 'Cancel'
  $bf.Controls.Add($ok); $bf.Controls.Add($no)
  $f.Controls.Add($bf)
  $d.Controls.Add($f)
  $d.AcceptButton = $ok; $d.CancelButton = $no
  $lb.Add_DoubleClick({ $this.FindForm().DialogResult = 'OK' })
  $r = $d.ShowDialog($form)
  $i = $lb.SelectedIndex
  $d.Dispose()
  if ($r -ne 'OK') { return -1 }
  return $i
}

function Msg([string]$text, [string]$buttons = 'OK', [string]$icon = 'Information') {
  return [Windows.Forms.MessageBox]::Show($form, $text, 'classboard 설치', $buttons, $icon)
}

# ───────────── 설치 단계 ─────────────

function Ensure-Node {
  $nodeHome = $null
  $sys = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($sys) {
    try {
      $v = (& $sys.Source -v) -replace '^v', ''
      $npmCli = Join-Path (Split-Path $sys.Source) 'node_modules\npm\bin\npm-cli.js'
      if ([version]$v -ge [version]'22.12.0' -and (Test-Path -LiteralPath $npmCli)) { $nodeHome = Split-Path $sys.Source; Log "컴퓨터에 있는 Node.js $v 를 씁니다." }
    } catch { }
  }
  if (-not $nodeHome) {
    $local = Get-ChildItem -Path (Join-Path $Work 'node') -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'node.exe') } | Select-Object -First 1
    if ($local) { $nodeHome = $local.FullName; Log '전에 받아 둔 Node.js 를 씁니다.' }
  }
  if (-not $nodeHome) {
    $arch = switch ($env:PROCESSOR_ARCHITECTURE) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { $null } }
    if (-not $arch) { throw '64비트 Windows 에서만 설치할 수 있습니다.' }
    Set-Status 'Node.js 를 받는 중입니다(처음 한 번, 1~3분)…'
    try { $index = (Fetch-Text 'https://nodejs.org/dist/index.json' 60) | ConvertFrom-Json }
    catch { if ("$_" -eq 'CANCELLED') { throw }; throw 'Node.js 를 받지 못했습니다(nodejs.org 접속 실패). 학교망에서 막혔다면 집이나 휴대폰 핫스팟에서 다시 실행하세요.' }
    $lts = $index | Where-Object { $_.lts -and ($_.files -contains "win-$arch-zip") } | Select-Object -First 1
    if (-not $lts) { throw 'Node.js 정보를 받지 못했습니다. 인터넷 연결을 확인하세요.' }
    $name = "node-$($lts.version)-win-$arch"
    $zip = Join-Path $Work "$name.zip"
    $wc = New-Web $null
    $t = $wc.DownloadFileTaskAsync("https://nodejs.org/dist/$($lts.version)/$name.zip", $zip)
    try { Wait-Task $t 900 $wc } catch { if ("$_" -eq 'CANCELLED') { throw }; throw "Node.js 를 받지 못했습니다: $($_.Exception.Message)" }
    Set-Status 'Node.js 압축을 푸는 중입니다…'
    $dest = Join-Path $Work 'node'
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    $q = { param($s) "'" + ($s -replace "'", "''") + "'" }
    $r = Run-Proc 'powershell.exe' @('-NoProfile', '-NonInteractive', '-Command', "Expand-Archive -LiteralPath $(& $q $zip) -DestinationPath $(& $q $dest) -Force")
    Remove-Item -Force $zip -ErrorAction SilentlyContinue
    $nodeHome = Join-Path $dest $name
    if ($r.Code -ne 0 -or -not (Test-Path (Join-Path $nodeHome 'node.exe'))) { throw 'Node.js 압축을 풀지 못했습니다. 보안 프로그램이 막았는지 확인하세요.' }
    Log "Node.js $($lts.version) 준비 완료"
  }
  $env:Path = "$nodeHome;$env:Path"
  $script:NodeExe = Join-Path $nodeHome 'node.exe'
  $script:NpmCli = Join-Path $nodeHome 'node_modules\npm\bin\npm-cli.js'
}

function Ensure-Wrangler {
  $lock = Join-Path $Root 'package-lock.json'
  $marker = Join-Path $Root 'node_modules\.classboard-lock'
  $hash = ''
  try { $hash = (Get-FileHash -LiteralPath $lock -Algorithm SHA256).Hash } catch { }
  if ($hash -and (Test-Path -LiteralPath $WranglerJs) -and (Test-Path -LiteralPath $marker) -and ((Get-Content -LiteralPath $marker -Raw).Trim() -eq $hash)) {
    Log '설치 도구(wrangler)가 이미 준비되어 있습니다.'
    return
  }
  Set-Status '설치 도구(wrangler)를 받는 중입니다(1~3분)…'
  $r = Run-Proc $script:NodeExe @($script:NpmCli, 'ci', '--no-audit', '--no-fund', '--loglevel=error')
  if ($r.Code -ne 0 -or -not (Test-Path -LiteralPath $WranglerJs)) { throw '설치 도구를 받지 못했습니다. 인터넷 연결(학교망이면 보안 프로그램)을 확인하고 다시 시도하세요.' }
  if ($hash) { Set-Content -LiteralPath $marker -Value $hash -Encoding ASCII }
}

function Get-CfToken {
  $r = WR @('auth', 'token', '--json') -Quiet
  if ($r.Code -ne 0) { return $null }
  $s = $r.Out
  $a = $s.IndexOf('{'); $b = $s.LastIndexOf('}')
  if ($a -lt 0 -or $b -le $a) { return $null }
  try { $t = $s.Substring($a, $b - $a + 1) | ConvertFrom-Json } catch { return $null }
  if (($t.type -eq 'oauth' -or $t.type -eq 'api_token') -and $t.token) { return [string]$t.token }
  return $null
}

function Ensure-Login {
  if ($chkRelogin.Checked) {
    Set-Status '전에 로그인한 Cloudflare 계정에서 로그아웃합니다…'
    [void](WR @('logout'))
  } else {
    $script:CfToken = Get-CfToken
    if ($script:CfToken) { Log '이미 로그인되어 있습니다.'; return }
  }
  Set-Status "브라우저가 열리면 Cloudflare 에 로그인하고 [Allow](허용)를 누르세요.`n허용한 뒤 이 창으로 돌아오면 이어서 진행합니다."
  $r = WR @('login')
  $lnkLogin.Visible = $false
  if ($r.Code -ne 0) {
    if ($r.All -match 'EADDRINUSE|8976') { throw 'Cloudflare 로그인을 받을 수 없습니다(다른 설치 창이 열려 있을 수 있습니다). 다른 창을 닫고 다시 시도하세요.' }
    throw 'Cloudflare 로그인을 마치지 못했습니다. [다시 시도]를 누르세요.'
  }
  $script:CfToken = Get-CfToken
  if (-not $script:CfToken) { throw 'Cloudflare 로그인 정보를 읽지 못했습니다. [다시 시도]를 누르세요.' }
}

function Select-Account {
  try { $accts = @((Cf GET '/accounts?per_page=50').result) } catch { throw "Cloudflare 계정 목록을 읽지 못했습니다. ($($_ -replace '^CF:',''))" }
  if ($accts.Count -eq 0) { throw 'Cloudflare 계정을 찾지 못했습니다. 가입 인증 메일의 링크를 눌렀는지 확인하세요.' }
  $acct = $null
  if (($script:Mode -eq 'update' -or $script:Action -eq 'uninstall') -and $Info -and $Info.account_id) { $acct = @($accts | Where-Object { $_.id -eq $Info.account_id })[0] }
  if (-not $acct -and $script:Mode -eq 'update' -and $script:Action -eq 'install' -and $Info -and $Info.account_id) {
    $a = Msg "이 PC 에서 칠판을 설치했던 계정($($Info.account_name))이 아닌 다른 계정으로 로그인되어 있습니다.`n계속하면 이 계정에 칠판을 새로 올립니다(원래 칠판의 판서·자료는 옮겨지지 않습니다).`n`n원래 계정으로 하려면 [아니요]를 누른 뒤 [이전]에서 '다른 Cloudflare 계정으로 로그인하기'를 체크하고 다시 하세요.`n이 계정에 계속 올릴까요?" 'YesNo' 'Warning'
    if ($a -ne 'Yes') { throw '원래 계정으로 로그인한 뒤 다시 하세요.' }
  }
  if (-not $acct -and $accts.Count -eq 1) { $acct = $accts[0] }
  if (-not $acct) {
    $i = Choose-Item '계정 고르기' 'Cloudflare 계정이 여러 개입니다. 칠판을 올릴 계정을 고르세요.' @($accts | ForEach-Object { [string]$_.name })
    if ($i -lt 0) { throw '계정을 고르지 않아 멈췄습니다.' }
    $acct = $accts[$i]
  }
  $script:Account = $acct
  $env:CLOUDFLARE_ACCOUNT_ID = $acct.id
  Log "계정: $($acct.name)"
}

function Ensure-Account {
  Select-Account
  $acct = $script:Account

  # 확장판: R2 가 켜져 있는지 먼저 확인
  if ($script:Edition -eq 'storage') {
    $r2off = $false
    try { [void](Cf GET "/accounts/$($acct.id)/r2/buckets?per_page=1") } catch { if ("$_" -match '10042|enable R2') { $r2off = $true } }
    if ($r2off) {
      $a = Msg "이 계정은 아직 R2 가 켜져 있지 않습니다. 확장판은 R2 를 먼저 켜야 합니다.`n(카드 또는 PayPal 등록, 무료 10GB 안에서는 청구 없음)`n`n지금 Cloudflare 의 R2 화면을 열까요? R2 를 켠 뒤 이 창에서 [다시 시도]를 누르세요." 'YesNo' 'Warning'
      if ($a -eq 'Yes') { Start-Process "https://dash.cloudflare.com/$($acct.id)/r2/overview" }
      throw 'R2 를 켠 뒤 [다시 시도]를 누르세요. 카드 등록 없이 쓰려면 [이전]에서 기본판을 고르세요.'
    }
  }

  # workers.dev 주소 이름
  $sub = $null
  try { $sub = (Cf GET "/accounts/$($acct.id)/workers/subdomain").result.subdomain } catch { $sub = $null }
  if ($sub) {
    if ($script:WantSub -and $script:WantSub -ne $sub) { Log "이 계정은 이미 '$sub' 주소 이름을 씁니다. 그 이름을 그대로 씁니다." }
    $script:Sub = $sub
    return
  }
  $name = $script:WantSub
  $why = ''
  while ($true) {
    if (-not $name) {
      $msg = '칠판 주소에 쓸 이름을 넣으세요. 주소는 https://classboard.(이름).workers.dev 가 됩니다. 영어 소문자·숫자·- 만 씁니다.'
      if ($why) { $msg = "$why`n`n$msg" }
      $name = Ask-Text '주소 이름' $msg
      if ($null -eq $name) { throw '주소 이름을 정하지 않아 멈췄습니다.' }
    }
    $bad = Test-SubName $name
    if ($bad) { $why = $bad; $name = $null; continue }
    Set-Status "주소 이름 '$name' 을(를) 쓸 수 있는지 확인하는 중…"
    $free = $true
    try { [void](Cf GET "/accounts/$($acct.id)/workers/subdomains/$name"); $free = $false } catch { if ("$_" -match '10031') { $free = $false } }
    if (-not $free) { $why = "'$name' 은(는) 이미 누가 쓰는 이름입니다. 다른 이름을 넣으세요(뒤에 숫자를 붙여 보세요)."; $name = $null; continue }
    try {
      $r = Cf PUT "/accounts/$($acct.id)/workers/subdomain" @{ subdomain = $name }
      $sub = $r.result.subdomain
      if (-not $sub) { $sub = $name }
      $script:Sub = $sub
      $script:NewSub = $true
      Log "주소 이름을 정했습니다: $sub"
      return
    } catch {
      $e = "$_"
      if ($e -match 'unavailable|taken|already|exists|10031') { $why = "'$name' 은(는) 이미 누가 쓰는 이름입니다. 다른 이름을 넣으세요." }
      elseif ($e -match 'invalid|10013') { $why = "'$name' 은(는) 쓸 수 없는 이름입니다. 다른 이름을 넣으세요." }
      else { $why = "주소 이름을 정하지 못했습니다: $($e -replace '^CF:','')" }
      $name = $null
    }
  }
}

function Do-Deploy {
  $out = Join-Path $Work 'deploy-output.ndjson'
  if (Test-Path -LiteralPath $out) { Remove-Item -Force -LiteralPath $out }
  $env:WRANGLER_OUTPUT_FILE_PATH = $out
  try { $r = WR @('deploy', '-c', $script:Conf) } finally { Remove-Item Env:\WRANGLER_OUTPUT_FILE_PATH -ErrorAction SilentlyContinue }
  if ($r.Code -ne 0) {
    $why = First-Error $r.All
    if ($script:Edition -eq 'storage' -and $r.All -match 'R2|10042') { throw "올리지 못했습니다. R2 가 켜져 있는지 확인하세요.`n($why)" }
    throw "올리지 못했습니다: $why"
  }
  $url = Read-DeployUrl $out
  if (-not $url -and $script:Sub) { $url = "https://classboard.$($script:Sub).workers.dev" }
  if (-not $url) { throw '올렸지만 칠판 주소를 알아내지 못했습니다. [자세히 보기]에서 https://…workers.dev 주소를 확인하세요.' }
  $script:Url = $url.TrimEnd('/')
  Set-Content -LiteralPath (Join-Path $Work 'edition.txt') -Value $script:Edition -Encoding ASCII
  Log "주소: $script:Url"
}

function Flush-Dns { try { [void](Run-Proc 'ipconfig.exe' @('/flushdns') -Quiet) } catch { if ("$_" -eq 'CANCELLED') { throw } } }

# 새 주소는 퍼지는 데 몇 분 걸릴 수 있음. 너무 일찍 열면 Windows 가 '없음'을 기억해 버리므로
# 먼저 Cloudflare DNS 로 주소가 생겼는지 본 뒤 접속함
function Wait-Reachable {
  $hostName = ([Uri]$script:Url).Host
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt 240) {
    try {
      $j = (Fetch-Text "https://cloudflare-dns.com/dns-query?name=$hostName&type=A" 10 @{ accept = 'application/dns-json' }) | ConvertFrom-Json
      if ($j.Status -eq 0 -and $j.Answer) { break }
    } catch { if ("$_" -eq 'CANCELLED') { throw }; break }
    Wait-Ms 4000
  }
  Flush-Dns
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $lastFlush = 0
  while ($sw.Elapsed.TotalSeconds -lt 300) {
    try {
      $h = (Fetch-Text "$($script:Url)/api/health" 15) | ConvertFrom-Json
      if ($h.ok) { return $h }
    } catch { if ("$_" -eq 'CANCELLED') { throw }; Log "  아직 열리지 않음: $($_.Exception.Message)" }
    if ($sw.Elapsed.TotalSeconds - $lastFlush -gt 60) { Flush-Dns; $lastFlush = $sw.Elapsed.TotalSeconds }
    Wait-Ms 5000
  }
  return $null
}

function Get-SetupStatus {
  try { return ((Fetch-Text "$($script:Url)/eboard-api/setup/status" 15) | ConvertFrom-Json) } catch { if ("$_" -eq 'CANCELLED') { throw }; return $null }
}

function Put-SetupKey {
  $key = New-SetupKey
  $r = WR @('secret', 'put', 'SETUP_KEY', '-c', $script:Conf) $key
  if ($r.Code -ne 0) { throw "설치 키를 저장하지 못했습니다: $(First-Error $r.All)" }
  $script:Key = $key
  $script:KeyNew = $true
}

function Write-Memo {
  $memo = Join-Path ([Environment]::GetFolderPath('Desktop')) 'classboard-설치정보.txt'
  $lines = @(
    "classboard 전자칠판 설치 정보  ($(Get-Date -Format 'yyyy-MM-dd HH:mm'))",
    '',
    "주소: $($script:Url)"
  )
  if ($script:LoginId) { $lines += "교사 아이디: $($script:LoginId)  (비밀번호는 적어 두지 않았습니다)" }
  $lines += @(
    "설치 키(SETUP_KEY): $($script:Key)",
    '',
    '설치 키는 처음 설정과 비밀번호를 잊었을 때만 씁니다.',
    '다른 사람에게 보여 주지 말고, 이 파일은 안전한 곳에 옮겨 두세요.'
  )
  $lines | Set-Content -LiteralPath $memo -Encoding UTF8
  $script:MemoPath = $memo
}

function Save-Info {
  $o = [ordered]@{
    edition = $script:Edition
    url = $script:Url
    account_id = $script:Account.id
    account_name = [string]$script:Account.name
    subdomain = $script:Sub
    setup_key = $script:Key
    version = $script:ServerVersion
    updated = (Get-Date -Format 'yyyy-MM-dd HH:mm')
  }
  ($o | ConvertTo-Json) | Set-Content -LiteralPath $InfoPath -Encoding UTF8
}

function Do-Setup {
  $body = @{
    setup_key = $script:Key
    grade = [int]$numGrade.Value; class = [int]$numClass.Value; size = [int]$numSize.Value
    name = $tbName.Text.Trim()
    login_id = $tbId.Text.Trim()
    password = $tbPw.Text
  }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $retried = $false
  while ($true) {
    try { [void](Post-Json "$($script:Url)/eboard-api/setup" $body 30); return }
    catch {
      if ("$_" -eq 'CANCELLED') { throw }
      $e = Web-Error $_.Exception
      Log "  처음 설정 응답: $($e.Status) $($e.Code) $($e.Message)"
      if ($e.Status -eq 400) { throw "학급·교사 정보를 넣지 못했습니다: $($e.Message)" }
      if ($sw.Elapsed.TotalSeconds -gt 90) {
        if ($e.Status -eq 403 -and -not $retried) { Put-SetupKey; $body.setup_key = $script:Key; $retried = $true; $sw.Restart(); continue }
        throw "학급·교사 정보를 넣지 못했습니다: $($e.Message)"
      }
      Wait-Ms 4000
    }
  }
}

function Do-Install {
  $script:Action = 'install'
  $script:Running = $true
  $script:Cancel = $false
  $script:KeyNew = $false
  $script:Key = $null
  $script:NewSub = $false
  $script:SetupDone = $false
  $script:AlreadyConfigured = $false
  $script:MemoPath = $null
  $script:ServerVersion = ''
  $script:Edition = 'basic'
  if ($rbStorage.Checked) { $script:Edition = 'storage' }
  $script:Conf = 'wrangler.jsonc'
  if ($script:Edition -eq 'storage') { $script:Conf = 'wrangler.storage.jsonc' }
  $script:WantSub = $tbSub.Text.Trim().ToLower()
  $script:LoginId = $null
  if ($script:Mode -ne 'update') { $script:LoginId = $tbId.Text.Trim() }

  $upd = ($script:Mode -eq 'update')
  $last = '학급·교사 정보 넣기'
  if ($upd) { $last = '새 버전 확인' }
  Init-Steps @('설치 도구 준비', 'Cloudflare 로그인', '계정과 칠판 주소', '칠판 올리기', '설치 키와 주소 열림 확인', $last)
  Show-Page 'run'
  Set-Buttons 'running'
  $bar.Visible = $true
  $bar.Style = 'Marquee'
  $lblSub.Text = '창을 닫지 말고 기다려 주세요. 브라우저에서 허용할 때만 손이 갑니다.'
  Log "── 시작: $(if ($upd) { '업데이트' } else { '새로 설치' }), $($script:Edition)"
  $cur = 0
  try {
    Set-Step 0 'run'; Set-Status '설치 도구를 준비하는 중입니다…'
    Ensure-Node; Ensure-Wrangler
    Set-Step 0 'ok'

    $cur = 1; Set-Step 1 'run'; Set-Status 'Cloudflare 로그인을 확인하는 중…'
    Ensure-Login
    Set-Step 1 'ok'

    $cur = 2; Set-Step 2 'run'; Set-Status '계정과 칠판 주소를 확인하는 중…'
    Ensure-Account
    Set-Step 2 'ok'

    $cur = 3; Set-Step 3 'run'; Set-Status '내 Cloudflare 계정에 칠판을 올리는 중입니다(1~2분)…'
    Do-Deploy
    Set-Step 3 'ok'

    $cur = 4; Set-Step 4 'run'
    $names = @()
    $sl = WR @('secret', 'list', '-c', $script:Conf, '--format', 'json') -Quiet
    try { $s = $sl.Out; $a = $s.IndexOf('['); $b = $s.LastIndexOf(']'); if ($a -ge 0 -and $b -gt $a) { $names = @(($s.Substring($a, $b - $a + 1) | ConvertFrom-Json) | ForEach-Object { $_.name }) } } catch { }
    $hasKey = $names -contains 'SETUP_KEY'
    $wait = '칠판 주소가 열리기를 기다리는 중입니다…'
    if ($script:NewSub) { $wait = "새 주소가 퍼지기를 기다리는 중입니다(처음엔 2~5분 걸릴 수 있습니다)…" }
    Set-Status $wait
    $health = Wait-Reachable
    $configured = $null
    if ($health) {
      $script:ServerVersion = [string]$health.version
      $st = Get-SetupStatus
      if ($st) { $configured = [bool]$st.configured }
    }
    if ($configured -eq $true) { $script:AlreadyConfigured = $true }
    if (-not $hasKey -or $configured -eq $false) {
      Set-Status '설치 키를 만드는 중…'
      Put-SetupKey
      Write-Memo
    } elseif ($Info -and $Info.setup_key -and $Info.url -eq $script:Url) {
      $script:Key = [string]$Info.setup_key
    }
    Set-Step 4 'ok'

    $cur = 5; Set-Step 5 'run'
    if ($upd) {
      if ($script:ServerVersion) { Log "칠판 판: $($script:ServerVersion)" }
      Set-Step 5 'ok'
    } elseif (-not $health) {
      Set-Step 5 'skip'
    } elseif ($script:AlreadyConfigured) {
      Log '이미 처음 설정이 된 칠판이라 학급·교사 정보는 바꾸지 않았습니다.'
      Set-Step 5 'skip'
    } else {
      Set-Status '학급·교사 정보를 넣는 중…'
      Do-Setup
      $script:SetupDone = $true
      Set-Step 5 'ok'
    }
    Save-Info
    $script:Health = $health
    Show-Done
  } catch {
    $msg = "$($_.Exception.Message)"
    if (-not $msg) { $msg = "$_" }
    if ($msg -eq 'CANCELLED') {
      Set-Step $cur 'fail'
      Set-Status '취소했습니다. [다시 시도]를 누르면 처음부터 다시 진행합니다(이미 한 단계는 빠르게 지나갑니다).' $cRed
    } else {
      Log "오류: $msg"
      Set-Step $cur 'fail'
      Set-Status "설치를 마치지 못했습니다.`n$msg" $cRed
    }
    $lblSub.Text = '문제를 해결한 뒤 [다시 시도]를 누르세요. 기록 파일을 보내 주시면 원인을 찾는 데 도움이 됩니다.'
    $bar.Visible = $false
    $lnkLogin.Visible = $false
    Set-Buttons 'error'
  } finally {
    $script:Running = $false
    $script:Proc = $null
  }
  if ($script:CloseAfter) { $form.Close() }
}

# ───────────── 지우기 ─────────────

# 칠판 Worker 가 이 계정에 있는지, 연결된 R2 버킷
function Get-Board {
  $o = [pscustomobject]@{ Exists = $true; Buckets = @() }
  try {
    $r = Cf GET "/accounts/$($script:Account.id)/workers/scripts/classboard/settings"
    $o.Buckets = @(@($r.result.bindings) | Where-Object { $_.type -eq 'r2_bucket' -and $_.bucket_name } | ForEach-Object { [string]$_.bucket_name })
  } catch {
    if ("$_" -match '10007|not found|does not exist') { $o.Exists = $false }
    else { Log "칠판 설정을 읽지 못했습니다(계속 진행): $_" }
  }
  # 설정을 못 읽었거나 Worker 가 이미 없어도, 자동으로 만들어진 버킷이 남아 있으면 지움
  if ($o.Buckets -notcontains 'classboard-files') {
    try { [void](Cf GET "/accounts/$($script:Account.id)/r2/buckets/classboard-files"); $o.Buckets += 'classboard-files' } catch { }
  }
  return $o
}

function Confirm-Typed([string]$word) {
  $why = ''
  while ($true) {
    $msg = "정말 지우려면 아래 칸에 '$word' 를 그대로 넣고 [확인]을 누르세요.`n지운 칠판은 되살릴 수 없습니다."
    if ($why) { $msg = "$why`n`n$msg" }
    $v = Ask-Text '칠판 지우기 확인' $msg
    if ($null -eq $v) { throw '지우기를 멈췄습니다. 아무것도 지우지 않았습니다.' }
    if ($v -eq $word) { return }
    $why = "'$v' 은(는) '$word' 와 다릅니다."
  }
}

# 버킷은 비어 있어야 지울 수 있음. 바깥에서는 버킷 안 파일 목록을 볼 수 없으므로 칠판(Worker)이 직접 비움
function Wipe-Files {
  $url = "https://classboard.$($script:Sub).workers.dev"
  $script:Url = $url
  Set-Status '확장판 자료를 지울 수 있게 칠판을 준비하는 중…'
  Put-SetupKey
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $redeployed = $false
  $total = 0
  while ($true) {
    try {
      $r = (Post-Json "$url/eboard-api/uninstall/wipe-files" @{ setup_key = $script:Key } 60) | ConvertFrom-Json
      $total += [int]$r.deleted
      Set-Status "확장판 자료를 지우는 중… ($total 개)"
      if ($r.done) { Log "R2 파일 $total 개를 지웠습니다."; return $true }
      $sw.Restart()
      continue
    } catch {
      if ("$_" -eq 'CANCELLED') { throw }
      $e = Web-Error $_.Exception
      Log "  자료 지우기 응답: $($e.Status) $($e.Code) $($e.Message)"
      if ($e.Status -eq 404 -and -not $redeployed) {
        # 예전 판이라 지우기 기능이 없음 → 이 폴더의 판으로 먼저 올림
        Set-Status '예전 판이라 지우기 기능이 없어 새 판으로 먼저 올리는 중…'
        $script:Conf = 'wrangler.storage.jsonc'
        Do-Deploy
        $redeployed = $true
        $sw.Restart()
        continue
      }
      if ($sw.Elapsed.TotalSeconds -gt 120) { return $false }
      Wait-Ms 4000
    }
  }
}

function Clean-Pc {
  Set-Status '이 PC 의 Cloudflare 로그인을 끊는 중…'
  try { [void](WR @('logout')) } catch { if ("$_" -eq 'CANCELLED') { throw } }
  Set-Status '이 PC 에 남은 설치 파일을 지우는 중…'
  $desk = [Environment]::GetFolderPath('Desktop')
  if ($desk) { Remove-Item -LiteralPath (Join-Path $desk 'classboard-설치정보.txt') -Force -ErrorAction SilentlyContinue }
  foreach ($n in @('install.json', 'edition.txt', 'deploy-output.ndjson')) { Remove-Item -LiteralPath (Join-Path $Work $n) -Force -ErrorAction SilentlyContinue }
  $nodeDir = Join-Path $Work 'node'
  if (Test-Path -LiteralPath $nodeDir) {
    # 받아 둔 Node.js 를 쓰고 있으면 PATH 에서 빼고 지움
    $env:Path = (($env:Path -split ';') | Where-Object { $_ -and -not $_.StartsWith($nodeDir, [StringComparison]::OrdinalIgnoreCase) }) -join ';'
    Remove-Dir $nodeDir
  }
  Remove-Dir (Join-Path $Root 'node_modules')
}

# 파일이 많은 폴더는 창이 멈추지 않게 따로 지움
function Remove-Dir([string]$dir) {
  if (-not (Test-Path -LiteralPath $dir)) { return }
  try { [void](Run-Proc 'cmd.exe' @('/d', '/c', 'rmdir', '/s', '/q', $dir) -Quiet) } catch { if ("$_" -eq 'CANCELLED') { throw } }
  if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
}

function Do-Uninstall {
  $script:Action = 'uninstall'
  $script:Running = $true
  $script:Cancel = $false
  $script:Key = $null
  $script:Sub = $null
  $script:Leftover = @()
  $script:RemovedBoard = $false
  $script:RemovedBuckets = @()
  $script:Edition = 'storage'
  $script:Conf = 'wrangler.storage.jsonc'
  Init-Steps @('설치 도구 준비', 'Cloudflare 로그인', '계정과 칠판 확인', '확장판 자료 비우기', '칠판 지우기', '이 PC 정리')
  Show-Page 'run'
  Set-Buttons 'running'
  $bar.Visible = $true
  $bar.Style = 'Marquee'
  $lblTitle.Text = 'classboard 전자칠판 지우기'
  $lblSub.Text = '창을 닫지 말고 기다려 주세요.'
  Log '── 시작: 지우기'
  $cur = 0
  try {
    Set-Step 0 'run'; Set-Status '설치 도구를 준비하는 중입니다…'
    Ensure-Node; Ensure-Wrangler
    Set-Step 0 'ok'

    $cur = 1; Set-Step 1 'run'; Set-Status 'Cloudflare 로그인을 확인하는 중…'
    Ensure-Login
    Set-Step 1 'ok'

    $cur = 2; Set-Step 2 'run'; Set-Status '칠판이 어느 계정에 있는지 확인하는 중…'
    Select-Account
    try { $script:Sub = (Cf GET "/accounts/$($script:Account.id)/workers/subdomain").result.subdomain } catch { }
    $board = Get-Board
    if (-not $board.Exists -and $board.Buckets.Count -eq 0) {
      $a = Msg "이 계정($($script:Account.name))에는 칠판이 없습니다.`n이 PC 에 남은 설치 파일과 로그인만 정리할까요?" 'YesNo' 'Question'
      if ($a -ne 'Yes') { throw '지우기를 멈췄습니다. 아무것도 지우지 않았습니다.' }
    } else {
      $word = 'classboard'
      if ($script:Sub) { $word = [string]$script:Sub }
      $what = "계정: $($script:Account.name)"
      if ($script:Sub) { $what += "`n칠판 주소: https://classboard.$($script:Sub).workers.dev" }
      if ($board.Buckets.Count -gt 0) { $what += "`n확장판 R2 버킷: $($board.Buckets -join ', ')" }
      Set-Status "지울 칠판:`n$what"
      Confirm-Typed $word
    }
    Set-Step 2 'ok'

    $cur = 3; Set-Step 3 'run'
    if ($board.Buckets.Count -eq 0) { Set-Step 3 'skip' }
    else {
      $wiped = $false
      if ($board.Exists -and $script:Sub) { $wiped = Wipe-Files }
      if (-not $wiped) {
        Log 'R2 자료를 칠판으로 비우지 못했습니다. 버킷 지우기만 시도합니다.'
      }
      Set-Step 3 'ok'
    }

    $cur = 4; Set-Step 4 'run'
    if ($board.Exists) {
      Set-Status 'Cloudflare 에서 칠판을 지우는 중…'
      $r = WR @('delete', '--name', 'classboard', '--force')
      if ($r.Code -ne 0) { throw "칠판을 지우지 못했습니다: $(First-Error $r.All)" }
      $script:RemovedBoard = $true
    }
    foreach ($b in $board.Buckets) {
      Set-Status "R2 버킷 $b 을(를) 지우는 중…"
      $r = WR @('r2', 'bucket', 'delete', $b)
      if ($r.Code -eq 0) { $script:RemovedBuckets += $b } else { $script:Leftover += $b; Log "버킷을 지우지 못했습니다: $(First-Error $r.All)" }
    }
    Set-Step 4 'ok'

    $cur = 5; Set-Step 5 'run'
    Clean-Pc
    Set-Step 5 'ok'
    Show-Removed
  } catch {
    $msg = "$($_.Exception.Message)"
    if (-not $msg) { $msg = "$_" }
    if ($msg -eq 'CANCELLED') { $msg = '취소했습니다.' }
    Log "오류: $msg"
    Set-Step $cur 'fail'
    Set-Status "지우기를 마치지 못했습니다.`n$msg" $cRed
    $lblSub.Text = '[다시 시도]를 누르면 남은 것만 이어서 지웁니다.'
    $bar.Visible = $false
    $lnkLogin.Visible = $false
    Set-Buttons 'error'
  } finally {
    $script:Running = $false
    $script:Proc = $null
  }
  if ($script:CloseAfter) { $form.Close() }
}

function Show-Removed {
  Show-Page 'done'
  Set-Buttons 'removed'
  $lnkUrl.Visible = $false
  $doneBtns.Visible = $false
  $lblDoneTitle.Text = [string][char]0x2713 + ' 칠판을 지웠습니다'
  $lblSub.Text = '설치한 것을 모두 정리했습니다.'
  $t = @()
  if ($script:RemovedBoard) { $t += 'Cloudflare 에서 칠판(판서 기록·자료·설정)을 지웠습니다.' }
  if ($script:RemovedBuckets.Count -gt 0) { $t += "확장판 R2 버킷($($script:RemovedBuckets -join ', '))도 지웠습니다." }
  if ($script:Leftover.Count -gt 0) {
    $lblDoneTitle.ForeColor = [Drawing.Color]::FromArgb(154, 103, 0)
    $t += "R2 버킷 $($script:Leftover -join ', ') 은(는) 지우지 못했습니다. Cloudflare 대시보드 → R2 Object Storage 에서 버킷을 비운 뒤 직접 지우세요."
  }
  $t += '이 PC 의 설치 도구·설치 정보·바탕화면 메모를 지우고, Cloudflare 로그인도 끊었습니다.'
  $t += ''
  $t += '남은 것'
  $t += '  · 압축을 푼 classboard 폴더: 이 창을 닫은 뒤 직접 지우세요. [폴더 열기]를 누르면 열립니다.'
  $t += '  · Cloudflare 계정과 workers.dev 주소 이름: 비용이 들지 않습니다. 다시 설치하면 같은 주소를 씁니다.'
  $lblDone.Text = ($t -join "`n")
  try { Remove-Item -LiteralPath $LogPath -Force -ErrorAction SilentlyContinue } catch { }
}

function Show-Done {
  Show-Page 'done'
  Set-Buttons 'done'
  $lnkUrl.Visible = $true
  $doneBtns.Visible = $true
  $lnkUrl.Text = $script:Url
  $upd = ($script:Mode -eq 'update')
  $t = @()
  if ($upd) {
    $lblDoneTitle.Text = [string][char]0x2713 + ' 업데이트가 끝났습니다'
    $lblSub.Text = '칠판을 열어 둔 기기는 새로 고침하면 새 버전이 됩니다.'
    if ($script:ServerVersion) { $t += "지금 판: $($script:ServerVersion)" }
    $t += '판서·자료·설정·로그인은 그대로입니다.'
    $btnMemo.Visible = $false
  } else {
    $lblDoneTitle.Text = [string][char]0x2713 + ' 설치가 끝났습니다'
    $lblSub.Text = '이 주소를 교사 PC·전자칠판·학생 태블릿에서 엽니다.'
    if ($script:SetupDone) {
      $t += "아이디 $($script:LoginId) 와(과) 방금 정한 비밀번호로 로그인하세요."
    } elseif ($script:AlreadyConfigured) {
      $t += '이 칠판은 이미 처음 설정이 되어 있어 학급·교사 정보는 바꾸지 않았습니다. 원래 아이디로 로그인하세요.'
      $t += '비밀번호를 잊었다면 로그인 화면 아래 "비밀번호를 잊었을 때"에서 설치 키로 다시 정합니다.'
    } else {
      $lblDoneTitle.Text = [string][char]0x2713 + ' 올리기는 끝났습니다'
      $lblDoneTitle.ForeColor = [Drawing.Color]::FromArgb(154, 103, 0)
      $t += '새 주소가 아직 열리지 않아 학급·교사 정보는 넣지 못했습니다.'
      $t += '몇 분 뒤 [칠판 열기]를 누르면 "처음 설정" 화면이 나옵니다. 바탕화면 메모의 설치 키와 학급·교사 정보를 넣으면 끝납니다.'
    }
    if ($script:KeyNew) { $t += "설치 키는 바탕화면 'classboard-설치정보.txt' 에 저장했습니다. 비밀번호를 잊었을 때 쓰니 안전한 곳에 옮겨 두세요." }
    $btnMemo.Visible = [bool]$script:MemoPath
    $t += ''
    $t += '다음 할 일'
    $t += '  1. 칠판 메뉴(⋯) → 교시·시간표 설정에서 우리 학교 종 시각 넣기'
    $t += '  2. 교실 전자칠판 브라우저로 주소를 열어 로그인 → "이 기기를 전자칠판으로 등록"'
    $t += '  3. 학생은 칠판의 학급 도구 → 호출 탭의 QR 로 들어옵니다'
  }
  $lblDone.Text = ($t -join "`n")
}

function Validate-Form {
  if ($script:Mode -eq 'update') { return $true }
  $n = $tbSub.Text.Trim().ToLower()
  if ($n) { $bad = Test-SubName $n; if ($bad) { [void](Msg $bad 'OK' 'Warning'); $tbSub.Focus(); return $false } }
  if (-not (Test-LoginId $tbId.Text.Trim())) { [void](Msg '아이디는 영어·숫자(그리고 _ . -) 3~30자로 넣으세요.' 'OK' 'Warning'); $tbId.Focus(); return $false }
  if ($tbPw.Text.Length -lt 8) { [void](Msg '비밀번호는 8자 이상으로 넣으세요.' 'OK' 'Warning'); $tbPw.Focus(); return $false }
  if ($tbPw.Text -ne $tbPw2.Text) { [void](Msg '비밀번호 확인이 다릅니다. 같은 비밀번호를 두 번 넣으세요.' 'OK' 'Warning'); $tbPw2.Focus(); return $false }
  if ($PrevEdition -eq 'storage' -and $rbBasic.Checked) {
    $a = Msg "전에 확장판으로 설치했습니다. 기본판으로 바꾸면 R2 에 둔 자료와 보관한 판서 기록을 칠판에서 열 수 없게 됩니다.`n그래도 기본판으로 할까요?" 'YesNo' 'Warning'
    if ($a -ne 'Yes') { return $false }
  }
  return $true
}

# ───────────── 버튼 ─────────────

$btnMain.Add_Click({
  switch ($script:State) {
    'form' {
      if ($script:Mode -eq 'update' -and $PrevEdition -eq 'storage' -and $rbBasic.Checked) {
        $a = Msg "전에 확장판으로 설치했습니다. 기본판으로 바꾸면 R2 에 둔 자료와 보관한 판서 기록을 칠판에서 열 수 없게 됩니다.`n그래도 기본판으로 할까요?" 'YesNo' 'Warning'
        if ($a -ne 'Yes') { return }
      }
      if (Validate-Form) { Do-Install }
    }
    'error' { if ($script:Action -eq 'uninstall') { Do-Uninstall } else { Do-Install } }
    'removed' { Start-Process explorer.exe -ArgumentList ('"' + $Root + '"') }
    'done'  { Start-Process "$($script:Url)/login" }
    'done-log' { Start-Process "$($script:Url)/login" }
  }
})
$btnBack.Add_Click({ Show-Page 'form'; Set-Buttons 'form' })
$btnClose.Add_Click({ $form.Close() })
$btnLog.Add_Click({
  if ($script:State -eq 'done') { Show-Page 'run'; $txtLog.Visible = $true; $btnLog.Text = '결과 보기'; $script:State = 'done-log'; return }
  if ($script:State -eq 'done-log') { Show-Page 'done'; $btnLog.Text = '자세히 보기'; $script:State = 'done'; return }
  $txtLog.Visible = -not $txtLog.Visible
  if ($txtLog.Visible) { $btnLog.Text = '간단히 보기'; $txtLog.SelectionStart = $txtLog.TextLength; $txtLog.ScrollToCaret() } else { $btnLog.Text = '자세히 보기' }
})
$btnOpenLog.Add_Click({ Start-Process notepad.exe -ArgumentList ('"' + $LogPath + '"') })
$btnCopy.Add_Click({ try { [Windows.Forms.Clipboard]::SetText($script:Url); $btnCopy.Text = '복사했습니다' } catch { } })
$btnMemo.Add_Click({ if ($script:MemoPath) { Start-Process notepad.exe -ArgumentList ('"' + $script:MemoPath + '"') } })
$lnkUrl.Add_LinkClicked({ Start-Process "$($script:Url)/login" })
$lnkRemove.Add_LinkClicked({
  $a = Msg "칠판을 지우면 판서 기록·자료·설정이 모두 지워지고 되살릴 수 없습니다.`n`n백업을 내려받아 두었나요?`n(칠판 메뉴 → 교시·시간표 설정 → 저장 공간과 백업 → 백업 내려받기)`n`n[예] 백업했거나 필요 없음, 계속 진행`n[아니요] 멈추고 백업부터 하기" 'YesNo' 'Warning'
  if ($a -ne 'Yes') { return }
  Do-Uninstall
})
$lnkMode.Add_LinkClicked({
  if ($script:Mode -eq 'update') { $script:Mode = 'install' } else { $script:Mode = 'update' }
  Apply-Mode
})
$form.Add_FormClosing({
  param($s, $e)
  if ($script:Running) {
    $a = Msg '설치를 멈출까요? 다시 실행하면 이어서 진행할 수 있습니다.' 'YesNo' 'Question'
    if ($a -eq 'Yes') {
      $script:Cancel = $true
      $script:CloseAfter = $true
      if ($script:Proc) { Kill-Tree $script:Proc }
    }
    $e.Cancel = $true
  }
})
$form.Add_Shown({
  $form.Activate()
  if ($script:Mode -ne 'update') {
    if (-not $PrevEdition) { Show-EditionCompare }     # 처음 설치: 판을 고르기 전에 비교부터
    $tbSub.Focus()
  }
})

$form.AcceptButton = $btnMain
Show-Page 'form'
Set-Buttons 'form'

try {
  [void]$form.ShowDialog()
} catch {
  Log "창 오류: $_"
  try { [Windows.Forms.MessageBox]::Show("설치 창에 문제가 생겼습니다. 글자 화면 도우미로 다시 엽니다.`n$_", 'classboard 설치', 'OK', 'Error') | Out-Null } catch { }
  exit 2
}
exit 0
