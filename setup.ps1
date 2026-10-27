$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path


if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    Write-Error 'Node.js 20 or newer is required. Install it from https://nodejs.org/, reopen PowerShell, and run .\setup.ps1 again.'
    exit 1
}

$nodeVersion = (& node --version).Trim()
if ($nodeVersion -notmatch '^v?(\d+)\.') {
    Write-Error 'Unable to determine the installed Node.js version.'
    exit 1
}
if ([int]$Matches[1] -lt 20) {
    Write-Error "Node.js 20 or newer is required; found $nodeVersion. Install the current LTS release and try again."
    exit 1
}

if (-not (Test-Path '.env')) {
    $randomBytes = New-Object byte[] 32
    $randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $randomGenerator.GetBytes($randomBytes)
    } finally {
        $randomGenerator.Dispose()
    }
    $resetCodeSecret = ([BitConverter]::ToString($randomBytes) -replace '-', '').ToLowerInvariant()
    [Array]::Clear($randomBytes, 0, $randomBytes.Length)

    $environment = @"
PORT=3000
DATABASE_PATH=private/miracle-school.sqlite
ADMIN_EMAIL=
ADMIN_PASSWORD=
RESET_CODE_SECRET=$resetCodeSecret

SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-username
SMTP_PASS=your-smtp-password
MAIL_FROM=Miracle School <no-reply@example.com>
"@
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
    [IO.File]::WriteAllText((Join-Path $projectRoot '.env'), $environment, $utf8WithoutBom)
    Write-Output 'Created .env with a generated reset-code secret. You will create the admin account on the Admin Portal page.'
    Write-Output 'Email password resets will work after you configure the SMTP values in .env.'
}

if (-not (Test-Path 'node_modules')) {
    Write-Output 'Installing server dependencies...'
    & npm.cmd install
    if ($LASTEXITCODE -ne 0) {
        Write-Error 'Dependency installation failed. Review the npm error above and try again.'
        exit $LASTEXITCODE
    }
}

New-Item -ItemType Directory -Force 'private' | Out-Null
Write-Output 'Starting the portal. SQLite database will be created at private\miracle-school.sqlite.'
Write-Output 'Open http://localhost:3000/admin after the server reports that it is running. Press Ctrl+C to stop it.'
& npm.cmd start
exit $LASTEXITCODE
