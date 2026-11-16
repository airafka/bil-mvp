$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    . .\scripts\docker-command.ps1
    $billingDocker = Resolve-BillingDocker
    & $billingDocker compose -f compose.db-viewer.yaml up -d --build
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось запустить просмотр БД' }
} finally { Pop-Location }
