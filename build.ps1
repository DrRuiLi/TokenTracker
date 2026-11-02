# Build the combined TokenTracker + TRCC side-screen installer from this tree.
# Output: TokenTrackerWin\installer\Output\TokenTracker-Setup-v<version>.exe
# Requires: Node.js, Python 3.12, .NET 8 SDK, Inno Setup 6.
param([string]$BuildVersion, [switch]$SkipTests)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$packageVersion = (Get-Content -Raw (Join-Path $Root 'package.json') | ConvertFrom-Json).version
if (-not $BuildVersion) { $BuildVersion = $packageVersion }
if ($BuildVersion -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') {
    throw "BuildVersion must be x.y.z or x.y.z.n, got '$BuildVersion'."
}

function Find-FirstPath([string[]]$Candidates) {
    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    throw "Required tool not found. Looked for: $($Candidates -join '; ')"
}

function Invoke-Checked([scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code $LASTEXITCODE" }
}

$dotnet = Find-FirstPath @(
    "$env:LOCALAPPDATA\Microsoft\dotnet\dotnet.exe",
    "$env:ProgramFiles\dotnet\dotnet.exe"
)
$iscc = Find-FirstPath @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
)

$python = $null
foreach ($candidate in @(
    "$env:USERPROFILE\miniconda3\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
)) {
    if (Test-Path -LiteralPath $candidate) { $python = $candidate; break }
}
if (-not $python -and (Get-Command py -ErrorAction SilentlyContinue)) {
    $python = (& py -3.12 -c "import sys; print(sys.executable)").Trim()
}
if (-not $python -or -not (Test-Path -LiteralPath $python)) {
    throw "Python 3.12 not found. Install it or put python.exe on PATH."
}

$sdks = & $dotnet --list-sdks
if ($LASTEXITCODE -ne 0 -or -not $sdks) { throw "dotnet at $dotnet has no SDK. Install the .NET 8 SDK." }
Write-Host "dotnet: $dotnet"
Write-Host "python: $python"
Write-Host "iscc:   $iscc"

Write-Host '== dashboard dependencies =='
Invoke-Checked { npm ci --prefix dashboard --no-audit --no-fund }

Write-Host '== dashboard =='
$env:TOKENTRACKER_BUILD_PET = '1'
$env:VITE_INSFORGE_BASE_URL = 'https://srctyff5.us-east.insforge.app'
$env:VITE_INSFORGE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3OC0xMjM0LTU2NzgtOTBhYi1jZGVmMTIzNDU2NzgiLCJlbWFpbCI6ImFub25AaW5zZm9yZ2UuY29tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNDU5NDd9.T0auta_IrVIh0uXW1bob5QSnzvsnJmN28r5XkSGEuQY'
Invoke-Checked { npm run dashboard:build }
foreach ($page in @('index.html', 'pet.html', 'quota.html')) {
    $file = Join-Path $Root "dashboard\dist\$page"
    if (-not (Test-Path -LiteralPath $file)) { throw "dashboard build missing $file" }
}

Write-Host '== side screen =='
$venvPython = Join-Path $Root 'trcc\.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) {
    Invoke-Checked { & $python -m venv (Join-Path $Root 'trcc\.venv') }
}
Invoke-Checked { & $venvPython -m pip install -r (Join-Path $Root 'trcc\requirements.txt') }
if (-not $SkipTests) {
    Invoke-Checked { & $venvPython (Join-Path $Root 'trcc\test_unit.py') }
}
Push-Location (Join-Path $Root 'trcc')
try {
    Invoke-Checked { & $venvPython -m PyInstaller --noconfirm trcc-bundle.spec }
} finally {
    Pop-Location
}
$trccExe = Join-Path $Root 'trcc\dist\trcc-token-dash\trcc-token-dash.exe'
$lhmDll = Join-Path $Root 'trcc\dist\trcc-token-dash\_internal\lhm\LibreHardwareMonitorLib.dll'
if (-not (Test-Path -LiteralPath $trccExe)) { throw "PyInstaller did not produce $trccExe" }
if (-not (Test-Path -LiteralPath $lhmDll)) { throw "Hardware library missing from the side-screen bundle: $lhmDll" }

Write-Host '== embedded Node server =='
Invoke-Checked { powershell -ExecutionPolicy Bypass -File (Join-Path $Root 'TokenTrackerWin\scripts\bundle-node.ps1') }

Write-Host '== publish =='
$publish = Join-Path $Root 'TokenTrackerWin\publish'
if (Test-Path -LiteralPath $publish) { Remove-Item -LiteralPath $publish -Recurse -Force }
Invoke-Checked {
    & $dotnet publish (Join-Path $Root 'TokenTrackerWin\TokenTrackerWin.csproj') `
        -c Release -r win-x64 --self-contained true -o $publish `
        "/p:Version=$BuildVersion" "/p:FileVersion=$BuildVersion" "/p:AssemblyVersion=$BuildVersion"
}
Copy-Item (Join-Path $Root 'TokenTrackerWin\EmbeddedServer') (Join-Path $publish 'EmbeddedServer') -Recurse -Force
Copy-Item (Join-Path $Root 'trcc\dist\trcc-token-dash') (Join-Path $publish 'trcc') -Recurse -Force

$required = @(
    'TokenTracker.exe',
    'EmbeddedServer\node.exe',
    'EmbeddedServer\tokentracker\bin\tracker.js',
    'EmbeddedServer\tokentracker\src\lib\trcc-sidecar.js',
    'EmbeddedServer\tokentracker\dashboard\dist\index.html',
    'EmbeddedServer\tokentracker\dashboard\dist\pet.html',
    'EmbeddedServer\tokentracker\dashboard\dist\quota.html',
    'trcc\trcc-token-dash.exe',
    'trcc\_internal\lhm\LibreHardwareMonitorLib.dll',
    'trcc\_internal\libusb-1.0.dll'
)
foreach ($relative in $required) {
    $file = Join-Path $publish $relative
    if (-not (Test-Path -LiteralPath $file)) { throw "Publish is missing $file" }
}
$sidecar = Get-Content -Raw (Join-Path $publish 'EmbeddedServer\tokentracker\src\lib\trcc-sidecar.js')
if ($sidecar -notlike '*path.resolve(__dirname, "..", "..", "trcc")*') {
    throw 'Published sidecar does not point at the in-tree trcc folder.'
}

Write-Host '== installer =='
$driveLetter = @('T', 'S', 'R', 'Q', 'P', 'O', 'N', 'M', 'L', 'K') |
    Where-Object { -not (Get-PSDrive -Name $_ -ErrorAction SilentlyContinue) } |
    Select-Object -First 1
if (-not $driveLetter) { throw 'No free drive letter is available for the short-path installer build.' }
$shortDrive = "${driveLetter}:"
$subst = Join-Path $env:SystemRoot 'System32\subst.exe'
Invoke-Checked { & $subst $shortDrive $Root }
try {
    $shortIss = "$shortDrive\TokenTrackerWin\installer\TokenTracker.iss"
    $shortOutput = "$shortDrive\TokenTrackerWin\installer\Output"
    Invoke-Checked { & $iscc "/DMyAppVersion=$BuildVersion" "/O$shortOutput" $shortIss }
} finally {
    & $subst $shortDrive /d | Out-Null
}
$setup = Join-Path $Root "TokenTrackerWin\installer\Output\TokenTracker-Setup-v$BuildVersion.exe"
if (-not (Test-Path -LiteralPath $setup)) { throw "Installer was not produced at $setup" }
Write-Host "BUILD OK: $setup"
