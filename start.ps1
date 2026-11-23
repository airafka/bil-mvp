$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts/docker-command.ps1')
$dockerCommand = Resolve-BillingDocker
$composeArgs = @('compose', '--project-directory', $PSScriptRoot, '-f', (Join-Path $PSScriptRoot 'compose.yaml'), '-p', 'billing-mvp')
& $dockerCommand @composeArgs up -d --build --wait
if ($LASTEXITCODE -ne 0) { throw 'Не удалось запустить новую копию' }
$address = & $dockerCommand @composeArgs port frontend 80
if ($LASTEXITCODE -ne 0) { throw 'Не удалось определить порт интерфейса' }
Write-Host "MVP: http://localhost:$(($address -split ':')[-1])"
