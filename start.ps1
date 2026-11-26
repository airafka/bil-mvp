param([ValidateSet('frontend', 'backend')][string]$Service)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts/docker-command.ps1')
$dockerCommand = Resolve-BillingDocker
$composeArgs = @('compose', '--project-directory', $PSScriptRoot, '-f', (Join-Path $PSScriptRoot 'compose.yaml'), '-p', 'billing-mvp')

if ($Service) {
    & $dockerCommand @composeArgs build $Service
    if ($LASTEXITCODE -ne 0) { throw "Не удалось собрать $Service" }
    & $dockerCommand @composeArgs up -d --no-build --wait --force-recreate $Service
} else {
    & $dockerCommand @composeArgs up -d --build --wait
}
if ($LASTEXITCODE -ne 0) { throw 'Не удалось запустить приложение' }
if ($Service -eq 'backend') {
    # Nginx resolves the backend container address when reading its configuration.
    & $dockerCommand @composeArgs exec -T frontend nginx -s reload
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось обновить адрес backend в nginx' }
}
$address = & $dockerCommand @composeArgs port frontend 80
if ($LASTEXITCODE -ne 0) { throw 'Не удалось определить порт интерфейса' }
Write-Host "MVP: http://localhost:$(($address -split ':')[-1])"
