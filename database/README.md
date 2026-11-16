# Запуск, обновление и перенос БД

Сверено 16.11.2026 с compose.yaml, скриптами запуска/восстановления и манифестом снимка. Рабочая БД — billing_next, PostgreSQL 16; активный каталог миграций backend содержит V1–V31. Версию конкретной работающей БД проверять отдельно по flyway_schema_history.

## Что переносится через Git

Код хранится в main. Переносимый снимок — [billing-next-snapshot.dump](billing-next-snapshot.dump), метаданные и SHA-256 — [billing-next-snapshot.json](billing-next-snapshot.json).

Снимок остаётся на V28; при запуске нового backend Flyway применяет V29 (отмена заявок и восстановление остатков), V30 (аудит перемещения КТК между вагонами накладных) и V31 (исходная и целевая накладные в истории переноса). Перед обновлением существующей базы нужна свежая резервная копия. Изменения редактора накладных после V31 не добавляют миграций. Более новый снимок БД не опубликован.

Текущий снимок экспортирован 10.11.2026 в 10:02 МСК. Манифест фиксирует успешную проверку восстановления с совпадением 45 таблиц и 6 последовательностей. Это результат проверки при экспорте, а не новая проверка при каждом чтении документа. Снимок содержит и справочники, и документы на момент экспорта.

Git не синхронизирует работающие PostgreSQL двух компьютеров. Получение нового файла dump не меняет локальную БД. .env, роли PostgreSQL, локальные резервные копии и последующие изменения данных в снимок автоматически не входят.

Исторический billing-snapshot.dump относится к прежней схеме V1–V44. Он ещё хранится в репозитории, но **не используется для текущего развёртывания**. Локальные initial/before/test дампы также не заменяют переносимый снимок.

## Новый компьютер: Windows

Нужны Git и работающий Docker Desktop с Linux containers и Compose v2. Отдельная установка Java, Node.js и PostgreSQL для запуска через Docker не требуется. Порты 3001/8081/5433 должны быть свободны.

Выполнять по одной команде; при ошибке остановиться:

```powershell
git clone --branch main --single-branch https://github.com/airafka/bil.git bil-next
cd bil-next
Copy-Item .env.example .env
powershell -NoProfile -ExecutionPolicy Bypass -File .\restore-snapshot.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

**Сначала восстановление, затем приложение.** Если backend запустить раньше, Flyway создаст объекты, и restore-snapshot.ps1 откажется заменять их.

[restore-snapshot.ps1](../restore-snapshot.ps1) проверяет SHA-256, имя billing_next, отсутствие работающих backend/frontend и пользовательских объектов БД. Затем восстанавливает одной транзакцией. Скрипт не очищает существующую базу. Для нового клона при уже существующем Compose billing-next сначала разобраться с окружением: одно имя проекта использует те же контейнеры и volume.

Настройки — [.env.example](../.env.example). Порты меняются через FRONTEND_PORT/BACKEND_PORT/DB_PORT. Пароль и имя пользователя можно настроить до первого создания volume; последующая правка .env сама по себе не меняет пароль уже созданной роли. .env не публикуется.

## Обычный запуск и остановка

Из корня репозитория:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\stop.ps1
```

Это отдельные действия: start запускает с пересборкой, stop останавливает. БД остаётся в billing-next_postgres-data. Автоматического восстановления dump при запуске нет.

Проверка при стандартных портах:

```powershell
. .\scripts\docker-command.ps1
$billingDocker = Resolve-BillingDocker
& $billingDocker compose -p billing-next ps
Invoke-RestMethod http://localhost:8081/actuator/health
(Invoke-WebRequest -UseBasicParsing http://localhost:3001).StatusCode
```

Ожидается backend UP, frontend HTTP 200. Compose ждёт готовности БД перед backend, затем backend перед frontend. Скрипты находят Docker через PATH или стандартные пути установки.

## Обновление кода на втором компьютере

1. Проверить ветку, HEAD, origin и git status. Сохранить незакоммиченные изменения.
2. Выполнить git fetch origin main и изучить разницу с локальной версией. Общая ветка — main.
3. Если появились новые активные миграции, до запуска обновлённого backend сделать свежую резервную копию.
4. При совместимой истории выполнить git merge --ff-only origin/main.
5. Запустить start.ps1 и проверить приложение.

Если старый клон отслеживал другую ветку, сначала настроить получение main и безопасно переключиться на неё после сохранения работы. Не пытаться исправлять расхождение истории принудительной отправкой.

При обычном обновлении сохраняется локальная БД. Flyway применяет новые миграции из **backend/src/main/resources/db/baseline**. Старый каталог db/migration не подключён в application.yml. Применённые миграции не редактировать.

## Резервная копия перед изменениями

Из корня проекта, после проверки назначения контейнеров. Пример для стандартных billing_next / billing; при других настройках подставить проверенные имена:

```powershell
$ErrorActionPreference = 'Stop'
. .\scripts\docker-command.ps1
$billingDocker = Resolve-BillingDocker
$backupName = 'billing-next-before-change-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.dump'
$backupDir = Join-Path (Get-Location) 'backups'
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$backupPath = Join-Path $backupDir $backupName
& $billingDocker compose -p billing-next exec -T db pg_dump -U billing -d billing_next -Fc -f "/tmp/$backupName"
if ($LASTEXITCODE -ne 0) { throw 'pg_dump завершился ошибкой' }
& $billingDocker compose -p billing-next exec -T db pg_restore --list "/tmp/$backupName" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Оглавление дампа не читается' }
& $billingDocker compose -p billing-next cp "db:/tmp/$backupName" $backupPath
if ($LASTEXITCODE -ne 0) { throw 'Не удалось сохранить локальную копию' }
Get-FileHash -LiteralPath $backupPath -Algorithm SHA256
```

Дамп передаётся файлом: не перенаправлять бинарный stdout pg_dump через текстовый PowerShell pipeline. Проверка оглавления и SHA-256 не заменяет проверку восстановления; перед существенным изменением данных восстановить копию в отдельную тестовую БД и проверить результат. Резервные копии не публиковать автоматически.

## Перенос новых данных между компьютерами

Новый переносимый снимок создаётся только по отдельному запросу. Обновлять dump и JSON-манифест вместе, проверив восстановление и содержимое таблиц/последовательностей на изолированной БД.

Если целевая billing_next уже заполнена, restore-snapshot.ps1 не предназначен для её замены. Порядок отдельной операции переноса:

1. Сделать свежую резервную копию целевой БД.
2. Восстановить новый снимок в отдельную БД, проверить схему, данные и работу совместимого backend.
3. Остановить запись приложения и выполнить контролируемое переключение с сохранением прежней БД для отката.
4. Проверить приложение после переключения.

Замена снимком не объединяет изменения двух БД. Сначала определить, какая копия данных является актуальной. Не удалять рабочий volume ради импорта.

## Тестовые сценарии

Изменяющие проверки выполняются на отдельной БД, с backend, подключённым именно к ней, и свободным портом. Одного другого URL недостаточно для изоляции.

Исторические scripts содержат старые порты, жёсткие пути, имена контейнеров и одноразовые операции. Перед запуском читать код; массовые seed/cleanup/renumber не повторять автоматически. Временные отчёты и тестовые дампы не считать частью поставки приложения.
