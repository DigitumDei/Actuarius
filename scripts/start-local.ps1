param(
  [string]$ContainerName = "actuarius",
  [string]$ImageName = "actuarius:latest",
  [string]$EnvFile = ".env",
  [string]$DataVolume = "actuarius_data",
  [string]$HomeVolume = "actuarius_home",
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
docker volume create $HomeVolume | Out-Null

$existing = docker ps -a --filter "name=^$ContainerName$" --format "{{.Names}}"
if ($existing) {
  Write-Host "Removing existing container $ContainerName..."
  docker rm -f $ContainerName | Out-Null
}

Write-Host "Starting container $ContainerName..."
docker run -d --name $ContainerName --env-file $EnvFile -v "${DataVolume}:/data" -v "${HomeVolume}:/home/appuser" $ImageName | Out-Null

if ($resolvedCredPath) {
  Write-Host "Copying Claude credentials from $resolvedCredPath..."
  docker exec -u 0 $ContainerName sh -lc "mkdir -p /home/appuser/.claude"
  docker cp $resolvedCredPath "${ContainerName}:/home/appuser/.claude/.credentials.json"
  docker exec -u 0 $ContainerName sh -lc "chown appuser:appuser /home/appuser/.claude/.credentials.json && chmod 600 /home/appuser/.claude/.credentials.json"
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
