[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = Split-Path -Parent $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)
foreach ($folder in @('data/db', 'data/audio', 'data/inbox', 'data/container/db', 'data/container/audio', 'data/container/inbox')) {
    New-Item -ItemType Directory -Path (Join-Path $projectRoot $folder) -Force | Out-Null
}
$rootEnv = Join-Path $projectRoot '.env'
if (-not (Test-Path -LiteralPath $rootEnv)) {
    $randomBytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($randomBytes) } finally { $rng.Dispose() }
    $token = ([BitConverter]::ToString($randomBytes)).Replace('-', '').ToLowerInvariant()
    [System.IO.File]::WriteAllText($rootEnv, "API_TOKEN=$token`nHTTP_BIND=127.0.0.1`nHTTP_PORT=8080`nMUSIC_API_IMAGE=remote-music-api:local`n", $utf8)
}
$hostEnv = Join-Path $projectRoot 'api/.env'
$adminLine = Get-Content -LiteralPath $rootEnv -Encoding UTF8 | Where-Object { $_ -match '^ADMIN_TOKEN=.' } | Select-Object -First 1
if (-not $adminLine) {
    $adminBytes = New-Object byte[] 32
    $adminRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $adminRng.GetBytes($adminBytes) } finally { $adminRng.Dispose() }
    $adminLine = 'ADMIN_TOKEN=' + ([BitConverter]::ToString($adminBytes)).Replace('-', '').ToLowerInvariant()
    [System.IO.File]::AppendAllText($rootEnv, "`n$adminLine`n", $utf8)
}
if (-not (Test-Path -LiteralPath $hostEnv)) {
    $tokenLine = Get-Content -LiteralPath $rootEnv -Encoding UTF8 | Where-Object { $_ -match '^API_TOKEN=' } | Select-Object -First 1
    if (-not $tokenLine) { throw 'Root .env must define API_TOKEN' }
    $template = [System.IO.File]::ReadAllText((Join-Path $projectRoot 'api/.env.example'), [System.Text.Encoding]::UTF8)
    $template = [regex]::Replace($template, '(?m)^API_TOKEN=.*$', [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $tokenLine })
    $template = [regex]::Replace($template, '(?m)^ADMIN_TOKEN=.*$', [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $adminLine })
    [System.IO.File]::WriteAllText($hostEnv, $template, $utf8)
}
if (-not (Get-Content -LiteralPath $hostEnv -Encoding UTF8 | Where-Object { $_ -match '^ADMIN_TOKEN=.' })) {
    [System.IO.File]::AppendAllText($hostEnv, "`n$adminLine`n", $utf8)
}
Write-Host 'Created data directories and missing environment files. Existing settings were preserved.'

