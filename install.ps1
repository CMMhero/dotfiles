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
#   1. makes sure winget exists -- installing it if the machine has none
#   2. installs git and the GitHub CLI
#   3. clones dotfiles-win
#   4. hands over to dotfiles-win/install.ps1, which does everything else
#
# Step 1 is not the usual case, but it is not hypothetical either: Windows
# Sandbox has no App Installer and no Microsoft Store, so winget simply is not
# there. The bootstrap fetches the App Installer MSIX straight from the
# winget-cli GitHub release rather than via https://aka.ms/getwinget, because
# that shortcut routes through the Store -- which is exactly what Sandbox lacks.
# Everywhere else winget is already present and this is a single `ok` line.

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

# Put winget on PATH if the App Installer is installed but its alias directory is
# not reachable. This is a real case on a fresh Windows profile, and downloading
# a 200MB MSIX to fix a PATH problem would be absurd.
function Add-WingetToPath {
    $aliasDir = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'
    if (Test-Path (Join-Path $aliasDir 'winget.exe')) {
        $env:Path = "$aliasDir;$env:Path"
        if (Test-Command 'winget') {
            ok "winget found at $aliasDir (added to PATH)"
            return $true
        }
    }
    return $false
}

# Install winget itself, for machines that do not have it at all.
#
# This is the Windows Sandbox case, and it is why https://aka.ms/getwinget is
# NOT used: that link routes through the Microsoft Store, and Sandbox has no
# Store and no Store account. So the App Installer is fetched straight from the
# winget-cli GitHub release instead -- the same artifact, minus the Store.
#
# Add-AppxPackage is used rather than winget itself, because winget is what is
# missing.
function Install-Winget {
    if (Add-WingetToPath) { return }

    if (-not (Get-Command Add-AppxPackage -ErrorAction Ignore)) {
        err 'winget is not available, and Add-AppxPackage is missing too.'
        err 'This is not a Windows image that can self-provision.'
        err 'Install "App Installer" by hand, then re-run.'
        exit 1
    }

    info 'winget is not installed; fetching the App Installer from GitHub'
    info '  (the aka.ms/getwinget shortcut needs the Store, which Windows'
    info '   Sandbox does not have)'

    if ($DryRun) {
        info 'would download Microsoft.DesktopAppInstaller msixbundle and Add-AppxPackage it'
        return
    }

    # Resolve "latest" through the releases API rather than hardcoding a version,
    # so this keeps working without edits. The asset name embeds the publisher
    # hash, which is stable for a given release, so match on the pattern instead.
    $release = 'https://api.github.com/repos/microsoft/winget-cli/releases/latest'
    $tmp = Join-Path $env:TEMP 'winget-msixbundle.msixbundle'

    try {
        info "querying $release"
        $rel = Invoke-RestMethod -Uri $release -Headers @{ 'User-Agent' = 'dotfiles-bootstrap' }
        $asset = $rel.assets | Where-Object { $_.name -like 'Microsoft.DesktopAppInstaller_*.msixbundle' } |
            Select-Object -First 1
        if (-not $asset) {
            throw 'no msixbundle asset in the latest winget-cli release'
        }
        info "$($rel.tag_name) -> $($asset.name) ($([math]::Round($asset.size / 1MB)) MB)"

        info 'downloading (this is the big step; a minute or two on a slow link)'
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tmp -UseBasicParsing
        ok "downloaded $([math]::Round((Get-Item $tmp).Length / 1MB)) MB"
    } catch {
        err "could not download the App Installer: $($_.Exception.Message)"
        Remove-Item $tmp -Force -ErrorAction Ignore
        exit 1
    }

    # The bundle declares a dependency on the Microsoft.VCLibs / UI.Xaml
    # frameworks. On a normal Windows build they are already present; on a
    # stripped image they may not be, and Add-AppxPackage then fails with a
    # dependency error rather than anything actionable. Say so explicitly.
    info 'installing (Add-AppxPackage)'
    try {
        Add-AppxPackage -Path $tmp -ErrorAction Stop
        ok 'App Installer installed'
    } catch {
        err "Add-AppxPackage failed: $($_.Exception.Message)"
        if ($_.Exception.Message -match '0x80073CF|dependency|framework') {
            err ''
            err 'That usually means the Microsoft.VCLibs / UI.Xaml frameworks are'
            err 'missing. Install them, then re-run:'
            err '  https://learn.microsoft.com/windows/apps/desktop/modernize/framework-packages'
        }
        err "The download is kept at $tmp in case you want to install it by hand."
        exit 1
    } finally {
        Remove-Item $tmp -Force -ErrorAction Ignore
    }

    # The winget.exe alias is created at install time, but the alias directory is
    # commonly absent from PATH on a fresh profile. Re-add it here rather than
    # telling the user to open a new terminal and re-run the whole bootstrap --
    # the install has already succeeded and there is nothing left to fix.
    if (Add-WingetToPath) {
        ok "winget $(winget --version)"
        return
    }

    # The alias may be a reparse point that PowerShell's Get-Command does not
    # resolve until the session PATH is rebuilt. That is the common case right
    # after an AppX install, so try the known absolute path before giving up.
    $aliasExe = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
    if (Test-Path $aliasExe) {
        $env:Path = "$(Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps');$env:Path"
        # clear the negative cache Get-Command keeps for a path that did not exist
        # a moment ago
        & $aliasExe --version *>$null
        if ($LASTEXITCODE -eq 0 -or (Test-Command 'winget')) {
            ok "winget present at $aliasExe (added to PATH)"
            return
        }
    }

    err 'App Installer installed, but winget.exe does not resolve from this session.'
    err "It is at $aliasExe."
    err 'Open a NEW terminal and re-run this script -- AppX shims only appear in'
    err 'a session started after the install.'
}

# ==============================================================================
# 1. winget
# ==============================================================================
step 'winget'

# winget is a hard dependency: every other step in this script, and every step
# in dotfiles-win/install.ps1, goes through it.
#
# Three ways it can be missing, in the order they are tried:
#   1. On PATH already.
#   2. The App Installer MSIX is installed but its alias directory is not on
#      PATH -- a real case on a fresh profile. Checked before downloading
#      anything.
#   3. Not installed at all -- Windows Sandbox, LTSC, a stripped image.
if (Test-Command 'winget') {
    ok "winget present ($(winget --version))"
} else {
    Install-Winget
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