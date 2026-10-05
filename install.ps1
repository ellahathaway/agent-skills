[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$sourceDirectory = Join-Path $PSScriptRoot 'agents'
$skillsDirectory = Join-Path $PSScriptRoot 'skills'
$extensionSource = Join-Path $PSScriptRoot '.github\extensions\review-interaction'
$copilotHome = if ($env:COPILOT_HOME) {
    $env:COPILOT_HOME
} else {
    Join-Path $HOME '.copilot'
}
$destinationDirectory = Join-Path $copilotHome 'agents'
$extensionsDirectory = Join-Path $copilotHome 'extensions'
$extensionDestination = Join-Path $extensionsDirectory 'review-interaction'

if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) {
    throw "Agent source directory not found: $sourceDirectory"
}

$agents = @(Get-ChildItem -LiteralPath $sourceDirectory -Filter '*.md' -File)

if ($agents.Count -eq 0) {
    throw "No agent profiles found in: $sourceDirectory"
}

if (-not (Test-Path -LiteralPath $skillsDirectory -PathType Container)) {
    throw "Skill source directory not found: $skillsDirectory"
}

if (-not (Test-Path -LiteralPath (Join-Path $extensionSource 'extension.mjs') -PathType Leaf)) {
    throw "Review extension entry point not found in: $extensionSource"
}

Get-Command copilot -ErrorAction Stop | Out-Null

New-Item -ItemType Directory -Path $extensionsDirectory -Force | Out-Null
$existingExtension = Get-ChildItem -LiteralPath $extensionsDirectory -Force |
    Where-Object { $_.Name -eq 'review-interaction' }

if ($existingExtension) {
    if ($existingExtension.LinkType -notin @('Junction', 'SymbolicLink') -or $existingExtension.Target -ne $extensionSource) {
        throw "Review extension destination already exists: $extensionDestination. Move it aside before running this installer."
    }
    Write-Host "Review extension already linked to $extensionSource"
} else {
    New-Item -ItemType Junction -Path $extensionDestination -Target $extensionSource | Out-Null
    Write-Host "Linked $extensionDestination to $extensionSource"
}

New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null

foreach ($agent in $agents) {
    $destinationName = if ($agent.Name.EndsWith('.agent.md')) {
        $agent.Name
    } else {
        "$($agent.BaseName).agent.md"
    }
    $destination = Join-Path $destinationDirectory $destinationName

    Copy-Item -LiteralPath $agent.FullName -Destination $destination -Force
    Write-Host "Installed $destinationName"
}

Write-Host "Installed $($agents.Count) agent profile(s) to $destinationDirectory"

copilot skill add $skillsDirectory
if ($LASTEXITCODE -ne 0) {
    throw "Failed to install skills from $skillsDirectory (Copilot exit code: $LASTEXITCODE)."
}
