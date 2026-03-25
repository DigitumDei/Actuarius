param(
  [string]$ContainerName = "actuarius",
  [string]$ImageName = "actuarius:latest",
  [string]$EnvFile = ".env",
  [string]$DataVolume = "actuarius_data",
  [Alias("HomeVolume")]
  [string]$LegacyHomeVolume = "actuarius_home",
  [string]$CredentialsPath = ".\.claude.credentials.json",
  [switch]$SkipBuild,
  [switch]$Logs
)

$ErrorActionPreference = "Stop"

function Require-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

Require-Command docker

if (-not (Test-Path -LiteralPath $EnvFile)) {
  throw "Environment file not found: $EnvFile"
}

$resolvedCredPath = $null
if (Test-Path -LiteralPath $CredentialsPath) {
  $resolvedCredPath = (Resolve-Path -LiteralPath $CredentialsPath).Path
}

if (-not $SkipBuild) {
  Write-Host "Building image $ImageName..."
  docker build -t $ImageName .
}

Write-Host "Ensuring volumes exist..."
docker volume create $DataVolume | Out-Null

$legacyHomeVolumeExists = docker volume ls --filter "name=^${LegacyHomeVolume}$" --format "{{.Name}}"
if ($legacyHomeVolumeExists) {
  Write-Host "Ensuring one-time migration from legacy volume $LegacyHomeVolume into $DataVolume..."
  docker run --rm -v "${DataVolume}:/target" -v "${LegacyHomeVolume}:/legacy:ro" alpine sh -lc @'
set -eu
sentinel=/target/home/.legacy-home-migrated
mkdir -p /target/home/appuser
if [ ! -f "$sentinel" ]; then
  cp -a /legacy/. /target/home/appuser/
  touch "$sentinel"
fi
chown -R 1001:1001 /target/home
'@
}

$existing = docker ps -a --filter "name=^$ContainerName$" --format "{{.Names}}"
if ($existing) {
  Write-Host "Removing existing container $ContainerName..."
  docker rm -f $ContainerName | Out-Null
}

Write-Host "Starting container $ContainerName..."
docker run -d --name $ContainerName --env-file $EnvFile -v "${DataVolume}:/data" $ImageName | Out-Null

if ($resolvedCredPath) {
  Write-Host "Copying Claude credentials from $resolvedCredPath..."
  docker exec -u 0 $ContainerName sh -lc "mkdir -p /data/home/appuser/.claude"
  docker cp $resolvedCredPath "${ContainerName}:/data/home/appuser/.claude/.credentials.json"
  docker exec -u 0 $ContainerName sh -lc "chown -R appuser:appuser /data/home/appuser/.claude && chmod 700 /data/home/appuser/.claude && chmod 600 /data/home/appuser/.claude/.credentials.json"
} else {
  Write-Host "Credentials file not found at $CredentialsPath. Skipping credential bootstrap."
}

Write-Host "Container status:"
docker ps --filter "name=^$ContainerName$" --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"

Write-Host "Claude auth status:"
docker exec $ContainerName sh -lc "claude auth status || true"

if ($Logs) {
  Write-Host "Streaming logs (Ctrl+C to stop):"
  docker logs -f $ContainerName
}
