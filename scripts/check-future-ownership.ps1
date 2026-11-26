# Restores the published fixture into a private tmpfs database and runs the future ownership check.
[CmdletBinding()]
param([switch]$SkipBuild, [switch]$MinuteCadence)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'docker-command.ps1')
$docker = Resolve-BillingDocker
$root = Split-Path $PSScriptRoot
$network = 'billing-register-owner'
$database = 'billing_register_owner_test'
$dbContainer = 'billing-register-owner-db'
$backend = 'billing-register-owner-new'
$label = 'billing.task=register-owner'
$watch = [Diagnostics.Stopwatch]::StartNew()

function Invoke-TestDocker {
    & $docker @args
    if ($LASTEXITCODE -ne 0) { throw "Docker $($args[0]) $($args[1]) failed (exit $LASTEXITCODE)." }
}
function Wait-TestService($id) {
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    do {
        $state = Invoke-TestDocker inspect --format '{{.State.Status}} {{.State.Health.Status}}' $id
        if ($state -eq 'running healthy') { return }
        if ($state -ne 'running starting') { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    Invoke-TestDocker logs --tail 40 $id
    throw "Test container $id did not become healthy ($state)."
}

$dump = Join-Path $root 'database/billing-next-snapshot.dump'
$manifest = Get-Content -Raw -LiteralPath (Join-Path $root 'database/billing-next-snapshot.json') | ConvertFrom-Json
if ((Get-FileHash -LiteralPath $dump -Algorithm SHA256).Hash -ne $manifest.sha256) { throw 'Snapshot checksum mismatch.' }
$null = Get-Command node -ErrorAction Stop
$names = @(Invoke-TestDocker ps -a --format '{{.Names}}')
if (($names -contains $dbContainer) -or ($names -contains $backend) -or
    (@(Invoke-TestDocker network ls --format '{{.Name}}') -contains $network)) { throw 'The ownership test environment already exists.' }
if (-not $SkipBuild) {
    Invoke-TestDocker compose -p billing-mvp -f (Join-Path $root 'compose.yaml') build backend
}
$image = Invoke-TestDocker image inspect --format '{{.Id}}' billing-mvp-backend
$netId = $dbId = $backendId = $null
$previousDocker = $env:DOCKER_EXE
try {
    $netId = Invoke-TestDocker network create --label $label $network
    $dbId = Invoke-TestDocker create --name $dbContainer --label $label --network $network --network-alias db `
        --tmpfs /var/lib/postgresql/data --health-cmd "pg_isready -h 127.0.0.1 -U billing -d $database" `
        --health-interval 1s --health-start-period 30s -e POSTGRES_DB=$database -e POSTGRES_USER=billing -e POSTGRES_PASSWORD=billing postgres:16-alpine
    Invoke-TestDocker start $dbId | Out-Null
    Wait-TestService $dbId
    Invoke-TestDocker cp $dump "${dbId}:/tmp/fixture.dump"
    Invoke-TestDocker exec $dbId pg_restore --no-owner --no-acl --single-transaction --exit-on-error -U billing -d $database /tmp/fixture.dump

    $cadence = if ($MinuteCadence) { @('-e', 'OWNERSHIP_CHECK_CRON=0 * * * * *') } else { @() }
    $backendId = Invoke-TestDocker create --name $backend --label $label --network $network -p 127.0.0.1:8355:8080 `
        -e DB_HOST=db -e DB_PORT=5432 -e DB_USER=billing -e DB_PASSWORD=billing -e DB_NAME=$database @cadence `
        --health-cmd 'wget -q --spider http://localhost:8080/actuator/health' --health-interval 1s --health-start-period 90s $image
    Invoke-TestDocker start $backendId | Out-Null
    Wait-TestService $backendId

    $env:DOCKER_EXE = $docker
    $scenario = [Diagnostics.Stopwatch]::StartNew()
    & node (Join-Path $PSScriptRoot 'future-ownership-source-check.cjs')
    if ($LASTEXITCODE -ne 0) { throw "Ownership scenario failed (exit $LASTEXITCODE)." }
    Write-Host ('Ownership scenario: {0:N1} s' -f $scenario.Elapsed.TotalSeconds)
} finally {
    $env:DOCKER_EXE = $previousDocker
    $cleanupErrors = @()
    foreach ($id in @($backendId, $dbId)) {
        if ($id) {
            try {
                # Stop all sessions before removing the temporary database.
                Invoke-TestDocker stop -t 5 $id | Out-Null
                Invoke-TestDocker rm $id | Out-Null
            } catch { $cleanupErrors += $_.Exception.Message }
        }
    }
    if ($netId) {
        try { Invoke-TestDocker network rm $netId | Out-Null }
        catch { $cleanupErrors += $_.Exception.Message }
    }
    Write-Host ('Total including setup and cleanup: {0:N1} s' -f $watch.Elapsed.TotalSeconds)
    if ($cleanupErrors) { throw ($cleanupErrors -join [Environment]::NewLine) }
}
