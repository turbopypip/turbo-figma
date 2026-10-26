#Requires -Version 5.1
<#
Windows 10/11 x64: install build dependencies, build Rust + TypeScript, create MCP config.
Run: powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Assets 'C:\Projects\site\public\figma'
Use -SkipDependencies when Node, Rust and MSVC are already installed.
The script does not run the test suite or change your Kilo configuration.
#>
[CmdletBinding()]
param(
    [string]$Assets,
    [switch]$SkipDependencies
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Use npm ci, npm run build:rust and npm run build on macOS/Linux.' }
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
$repoRoot = $PSScriptRoot
$toolchain = '1.99.1-x86_64-pc-windows-msvc'

function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed (exit $LASTEXITCODE)." }
}
function Refresh-Path {
    $cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE '.cargo' }
    $env:Path = @(
        (Join-Path $cargoHome 'bin'),
        [Environment]::GetEnvironmentVariable('Path', 'Machine'),
        [Environment]::GetEnvironmentVariable('Path', 'User'),
        $env:Path
    ) -join ';'
}
function Install-Package {
    param([string]$Id, [string[]]$Extra = @())
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw 'Install App Installer (winget) from Microsoft Store, then rerun install.ps1.'
    }
    Invoke-Checked 'winget.exe' (@('install', '--exact', '--id', $Id, '--source', 'winget',
        '--accept-source-agreements', '--accept-package-agreements') + $Extra)
    Refresh-Path
}
function Find-CppTools {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $vswhere) {
        $found = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($LASTEXITCODE -ne 0) { throw 'vswhere failed.' }
        if ($found) { return ($found | Select-Object -First 1) }
    }
    return $null
}
function Node-Ready {
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { return $false }
    $version = & node.exe -p 'process.versions.node'
    return ($LASTEXITCODE -eq 0 -and [version]$version -ge [version]'20.12.0')
}

Push-Location $repoRoot
$previousToolchain = $env:RUSTUP_TOOLCHAIN
try {
    Refresh-Path
    if (-not $SkipDependencies) {
        if (-not (Node-Ready)) { Install-Package 'OpenJS.NodeJS.LTS' }
        $cpp = Find-CppTools
        if (-not $cpp) {
            # The Visual Studio installer may request elevation. An installed C++
            # toolchain is reused; ordinary builds and the server need no admin rights.
            $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
            $existingVs = $null
            if (Test-Path $vswhere) { $existingVs = & $vswhere -latest -products '*' -property installationPath }
            if ($existingVs) {
                $installer = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\setup.exe'
                $installPath = $existingVs | Select-Object -First 1
                $process = Start-Process -FilePath $installer -Verb RunAs -Wait -PassThru -ArgumentList @(
                    'modify', '--installPath', ('"' + $installPath + '"'), '--passive', '--norestart',
                    '--add', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
                    '--add', 'Microsoft.VisualStudio.Component.Windows11SDK.26100')
                if ($process.ExitCode -notin @(0, 3010)) { throw "Visual Studio setup failed (exit $($process.ExitCode))." }
            } else {
                Install-Package 'Microsoft.VisualStudio.2022.BuildTools' @('--override',
                    '--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended')
            }
        }
        if (-not (Get-Command rustup.exe -ErrorAction SilentlyContinue)) { Install-Package 'Rustlang.Rustup' }
        Invoke-Checked 'rustup.exe' @('toolchain', 'install', $toolchain, '--profile', 'minimal')
    }
    if (-not (Node-Ready)) { throw 'Node.js 20.12+ is required. Rerun without -SkipDependencies.' }
    if (-not (Get-Command rustup.exe -ErrorAction SilentlyContinue)) { throw 'rustup is required. Rerun without -SkipDependencies.' }
    $cpp = Find-CppTools
    if (-not $cpp) { throw 'Install the Desktop development with C++ workload in Visual Studio Installer, then rerun.' }
    # Import the compiler and Windows SDK environment into this process only.
    $devCmd = Join-Path $cpp 'Common7\Tools\VsDevCmd.bat'
    $devEnvironment = & $env:ComSpec /d /s /c "`"`"$devCmd`" -no_logo -arch=x64 -host_arch=x64 && set`""
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the Visual C++ build environment.' }
    foreach ($line in $devEnvironment) {
        if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
    }
    $env:RUSTUP_TOOLCHAIN = $toolchain
    Invoke-Checked 'rustup.exe' @('run', $toolchain, 'rustc', '--version')
    Invoke-Checked 'npm.cmd' @('ci')
    Invoke-Checked 'npm.cmd' @('run', 'build:rust')
    Invoke-Checked 'npm.cmd' @('run', 'build')
    $binary = Join-Path $repoRoot 'rust\helper\target\release\figma-rust-helper.exe'
    if (-not (Test-Path $binary)) { throw "Build did not produce $binary" }
    if (-not $Assets) {
        $configPath = Join-Path $repoRoot '.local\config.json'
        if (Test-Path $configPath) { $Assets = (Get-Content -Raw -Encoding UTF8 $configPath | ConvertFrom-Json).assetDirectory }
        else { $Assets = Join-Path $repoRoot '.local\assets' }
    }
    Invoke-Checked 'npm.cmd' @('run', 'setup', '--', '--assets', $Assets)
    Write-Host "`nReady: $binary"
    Write-Host 'Merge .local\kilo.json into your Kilo CLI config, load extension\ in Chrome/Yandex,'
    Write-Host 'and use .local\pairing.txt to pair it. Start the MCP server through Kilo.'
} finally {
    $env:RUSTUP_TOOLCHAIN = $previousToolchain
    Pop-Location
}
