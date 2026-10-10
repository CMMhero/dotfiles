#!/usr/bin/env pwsh
# ==============================================================================
# install.ps1 - STEP ONE. The bootstrapper, for a bare Windows machine.
#
# This lives in the WSL dotfiles repo rather than dotfiles-win on purpose: it is
# the entrypoint someone reaches for who has *nothing* installed yet, and it has
# to be fetchable from a URL. dotfiles-win/install.ps1 cannot serve that role --
# it clones itself, so it needs git, and on a fresh Windows box git is the thing
# you do not have.
#
# What this does, and nothing more:
#   1. makes sure winget exists
#   2. installs git and the GitHub CLI
#   3. clones dotfiles-win
#   4. hands over to dotfiles-win/install.ps1, which does everything else
#
# Step 4 is the whole install. This script deliberately stops at "you can now
# clone a git repo", because that is the point at which the real installer
# becomes reachable. Duplicating any of its logic here would be two copies to
# keep in sync.
#
# Usage:
#   # the normal case, from a bare machine
#   irm https://raw.githubusercontent.com/CMMhero/dotfiles/main/install.ps1 | iex
#
#   # or download and run it
#   irm https://raw.githubusercontent.com/CMMhero/dotfiles/main/install.ps1 -OutFile install.ps1
#   .\install.ps1
#
#   # clone somewhere else
#   .\install.ps1 -SourceDir D:\dotfiles-win
#
# Runs on Windows PowerShell 5.1, so it works before PowerShell 7 exists.
#
# Requires no admin: winget installs git and gh per-user by default. An
# elevation prompt will still appear if Windows decides a package needs it --
# that one cannot be bypassed and should not be.
# ==============================================================================

[CmdletBinding()]
param(
    # Where to clone dotfiles-win. Defaults to ~/dotfiles-win, which is what
    # dotfiles-win's own scripts assume.
    [string]$SourceDir,

    # Print what would happen and install nothing.
    [switch]$DryRun,

    # Stop after git + gh and print the clone command, without running it.
    [switch]$NoHandoff
)

# `irm | iex` gives no $PSScriptRoot, and no script path either. Everything below
# therefore resolves paths explicitly rather than relying on either.
$ErrorActionPreference = 'Continue'

$DotfilesWin = 'https://github.com/CMMhero/dotfiles-win.git'
if (-not $SourceDir) { $SourceDir = Join-Path $HOME 'dotfiles-win' }

# ------------------------------------------------------------------------------
# Logging -- the same four levels install.sh uses, so the two entrypoints read
# alike.
# ------------------------------------------------------------------------------
$Rule = '==============================================================='
function step {
    param([string]$Title)
    Write-Host ''
    Write-Host $Rule -ForegroundColor Green
    Write-Host ('  ' + $Title.PadRight(62)) -ForegroundColor Green
    Write-Host $Rule -ForegroundColor Green
}
function info { param([string]$Message) Write-Host "   -> $Message" -ForegroundColor Cyan }
function ok    { param([string]$Message) Write-Host "   [ok]   $Message" -ForegroundColor Green }
function warn  { param([string]$Message) Write-Host "   [warn] $Message" -ForegroundColor Yellow }
function err   { param([string]$Message) Write-Host "   [err]  $Message" -ForegroundColor Red }

function Test-Command { param([string]$Name) [bool](Get-Command $Name -ErrorAction Ignore) }

# Run winget and report the exit code. Non-zero is a warning, not a fatal error:
# a package that will not install must not stop the ones after it.
function Invoke-Winget {
    param([Parameter(Mandatory)][string[]]$Arguments, [string]$What)
    if ($What) { info $What }
    Write-Host "      winget $($Arguments -join ' ')" -ForegroundColor DarkGray
    if ($DryRun) { return 0 }
    winget @Arguments *>$null
    return $LASTEXITCODE
}

# True when winget already has this id. Runs even under -DryRun: it is a
# read-only query, and a dry run that cannot tell you what is missing is not
# worth running.
function Test-WingetInstalled {
    param([string]$Id)
    $out = winget list --id $Id --exact --accept-source-agreements --disable-interactivity 2>$null
    return ($LASTEXITCODE -eq 0) -and ($out -match [regex]::Escape($Id))
}

# ==============================================================================
# 1. winget
# ==============================================================================
step 'winget'

if (Test-Command 'winget') {
    ok "winget present ($(winget --version))"
} else {
    # Windows 11 ships App Installer, which provides winget. Windows 10 does too,
    # but on plenty of LTSC and stripped images it is absent or too old to have
    # `install`. There is nothing to fall back to -- this is the one hard
    # dependency, so say exactly what to do rather than failing obscurely.
    err 'winget is not available on this machine.'
    err ''
    err '  Windows 11:  Microsoft Store -> search "App Installer" -> Update'
    err '  Windows 10:  Microsoft Store -> search "App Installer" -> Update,'
    err '                or install it from https://aka.ms/getwinget'
    err ''
    err 'Then re-run this script. Everything below needs it.'
    exit 1
}

# ==============================================================================
# 2. git + gh
#
# git because the next step is a clone. gh because dotfiles-win is a private
# repository, so a plain `git clone` over HTTPS needs credentials -- and gh is
# both the credential helper and the thing that can log you in non-interactively.
# ==============================================================================
step 'git + GitHub CLI'

foreach ($id in @('Git.Git', 'GitHub.cli')) {
    if (Test-WingetInstalled $id) {
        ok "$id already installed"
        continue
    }
    $rc = Invoke-Winget -What "winget install $id" -Arguments @(
        'install', '--id', $id, '--exact',
        '--silent', '--disable-interactivity',
        '--accept-package-agreements', '--accept-source-agreements'
    )
    if (Test-WingetInstalled $id) { ok "installed $id" }
    else { warn "winget could not install $id (exit $rc)" }
}

# winget only adds shims to PATH for shells started AFTER the install. This
# session predates it, so refresh the machine PATH block in-process or `git`
# does not resolve for the very next step -- and the clone would fail with
# "git is not recognized" on a machine that just installed it successfully.
$env:Path = (@(
    [Environment]::GetEnvironmentVariable('Path', 'Machine'),
    [Environment]::GetEnvironmentVariable('Path', 'User')
) -join ';')

if (-not (Test-Command 'git')) {
    # Last resort: the winget package dir is already on PATH on most machines,
    # and the shim is inside it.
    $gitExe = Get-ChildItem -Path "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" `
        -Filter 'git.exe' -Recurse -ErrorAction Ignore |
        Where-Object { $_.FullName -match 'cmd' } | Select-Object -First 1
    if ($gitExe) {
        $env:Path = "$($gitExe.DirectoryName);$env:Path"
        info "git resolved by path: $($gitExe.DirectoryName)"
    }
}

if (-not (Test-Command 'git')) {
    err 'git is still not on PATH after installing it.'
    err 'Open a NEW terminal and re-run this script -- winget shims only reach'
    err 'shells started after the install, and this one predates it.'
    exit 1
}
ok "git $(git --version)"

if (Test-Command 'gh') { ok "gh present ($(gh --version | Select-Object -First 1))" }
else { warn 'gh not on PATH yet; a new terminal will fix it' }

# ==============================================================================
# 3. Credentials
#
# dotfiles-win is private. Over HTTPS a clone needs a token, and git has no
# credential helper until `gh auth setup-git` writes one. Both steps are
# skipped when the repo is already cloned -- `gh auth login` is interactive, and
# hanging on it would be the worst possible outcome for a bootstrapper.
# ==============================================================================
$alreadyCloned = Test-Path (Join-Path $SourceDir '.git')

if ($alreadyCloned) {
    ok "already cloned at $SourceDir"
} else {
    step 'GitHub credentials'

    $ghAuthed = $false
    if (Test-Command 'gh') {
        # `gh auth status` exits non-zero when not logged in.
        gh auth status *>$null
        $ghAuthed = ($LASTEXITCODE -eq 0)
    }

    if ($ghAuthed) {
        ok 'gh is already authenticated'
    } elseif ($DryRun) {
        info 'would check gh auth and prompt if needed'
    } else {
        warn 'dotfiles-win is private, so the clone needs GitHub credentials.'
        warn ''
        warn '  Run this after the script finishes, then re-run it:'
        warn '    gh auth login'
        warn ''
        warn 'Continuing anyway -- if the clone fails, that is why.'
    }
}

# ==============================================================================
# 4. Clone
# ==============================================================================
step 'Clone dotfiles-win'

if ($alreadyCloned) {
    info "pulling $SourceDir"
    if (-not $DryRun) {
        Push-Location $SourceDir
        git pull --rebase --autostash *>$null
        $pullStatus = $LASTEXITCODE
        Pop-Location
        if ($pullStatus -ne 0) { warn "git pull failed (exit $pullStatus)" }
        else { ok 'pulled' }
    } else {
        info "would git pull --rebase --autostash in $SourceDir"
    }
} elseif ($DryRun) {
    info "would clone $DotfilesWin -> $SourceDir"
} else {
    info "cloning $DotfilesWin -> $SourceDir"
    git clone $DotfilesWin $SourceDir *>$null
    if ($LASTEXITCODE -ne 0) {
        err 'git clone failed.'
        err ''
        err 'If the repository is private, authenticate first:'
        err '  gh auth login'
        err 'then re-run this script.'
        exit 1
    }
    ok "cloned into $SourceDir"
}

if ($NoHandoff) {
    step 'Handoff skipped (-NoHandoff)'
    info 'The rest of the install is:'
    info "  pwsh -File `"$SourceDir\install.ps1`""
    exit 0
}

$handoff = Join-Path $SourceDir 'install.ps1'

if ($DryRun) {
    # Nothing was cloned, so the file genuinely is not there -- and reporting
    # that as an error would make every dry run on a fresh machine look like a
    # failure. Say what WOULD happen instead.
    step 'Handing over to dotfiles-win'
    info "would run: pwsh -File `"$SourceDir\install.ps1`""
    Write-Host ''
    info 'dry run: nothing was installed, cloned or run'
    exit 0
}

if (-not (Test-Path $handoff)) {
    err "expected $handoff after cloning, but it is not there."
    err 'The clone may be incomplete, or the repo layout has changed.'
    exit 1
}

# ==============================================================================
# 5. Hand over
#
# dotfiles-win/install.ps1 installs everything else: PowerShell 7, chezmoi, mise,
# the CLI toolchain, the desktop apps, and the configs. This script stops here on
# purpose -- it exists to make that script reachable, not to replace it.
# ==============================================================================
step 'Handing over to dotfiles-win'
info "pwsh -File `"$handoff`""

# PowerShell 7 if it is already here, otherwise 5.1 -- dotfiles-win/install.ps1
# supports both, and this script does not wait for winget to finish putting 7 on
# PATH when the thing it is launching works on 5.1 today.
$pwsh = Get-Command pwsh -ErrorAction Ignore
if ($pwsh) {
    & $pwsh.Source -NoLogo -File $handoff
} else {
    & powershell.exe -NoLogo -ExecutionPolicy Bypass -File $handoff
}

if ($LASTEXITCODE -ne 0) {
    warn "dotfiles-win/install.ps1 exited $LASTEXITCODE"
    warn "Re-run it on its own once the above is sorted:"
    warn "  pwsh -File `"$handoff`""
}

# ------------------------------------------------------------------------------
# Done
# ------------------------------------------------------------------------------
Write-Host ''
info "Bootstrapper finished. Source repo: $SourceDir"
Write-Host ''
Write-Host '   Open a NEW terminal before anything else.' -ForegroundColor Yellow
Write-Host '   winget, mise and vite+ all add themselves to PATH for new shells'
Write-Host '   only, so this one still has the old PATH.'
Write-Host ''