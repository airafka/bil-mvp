$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    . .\scripts\docker-command.ps1
    $billingDocker = Resolve-BillingDocker
    & $billingDocker compose -f compose.db-viewer.yaml stop
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось остановить просмотр БД' }
} finally { Pop-Location }
