# Rust migration 01: база Node.js

Дата: 25 октября 2026 (Europe/Moscow). Версия: 0.3.0.
Базовый commit N0: `fc3aaea64de4878cfa655072d5f5830d44829892`.
Production-код `src/`, `extension/`, `scripts/`, package.json и lockfile совпадает с этим commit.
В рамках пункта изменён только интеграционный тест и документация; новый commit не создавался.
Имеющиеся пользовательские staged-удаления документов/experiments и изменения .gitignore сохранены.

## Окружение и воспроизведение

- macOS 15.6.1, build 24G90, arm64; Apple M1, RAM 8589934592 байт.
- Node.js v20.12.2, npm 10.5.0, TypeScript 7.0.2.
- MCP client/server 2.3.1, ws 8.22.0, zod 4.6.7, fzstd 0.1.1, kiwi-schema 0.5.0.
- SHA-256 package-lock.json: `68488974f4c75b635dd096aa0091f4c058561507f5b0e998731644859aff3407`.
- Использованы установленные зависимости; переустановка не выполнялась.

Из корня проекта:

```sh
npm ci
npm run check
npm test
node --test --test-name-pattern='capture timeout disconnects' tests/network-transfer.test.mjs
```

Последняя команда требует предварительной сборки (`npm test` её выполняет).
Локальные сырые результаты находятся в `artifacts/rust-baseline-01/` (каталог исключён из Git):
`environment.json` содержит версии, исходный Git status и SHA-256 файлов кода/тестов;
`check-before.log`, `test-before.log`, `check.log`, `test-after.log`, `test-repeat-*.log` — проверки;
`repro-before.log` и `repro-after.log` — контролируемое воспроизведение задержки.
Для передачи полного доказательного набора нужно отдельно передать этот каталог.

## Зафиксированный контракт N0

- Публичные инструменты: `get_connection_status`, `get_selection`, `get_design_context`, `get_screenshot`, `export_assets`. `get_network_tree` включается только диагностикой (`src/server.ts`).
- `get_design_context` использует наблюдаемый сетевой снимок; source=network, без UI fallback. По умолчанию maxBytes=24000 UTF-8 байт, depth=4, maxNodes=200, includeHidden=false. Для полного чтения необходимо пройти continuation до null с неизменными параметрами.
- Сохраняются snapshot/file/selection identity, порядок узлов, фильтрация скрытых веток, HMAC continuation, revision/freshness, явные ошибки stale и неполнота результата (`src/network-reader.ts`, `src/network-session.ts`).
- Вход — managed NDJSON и legacy probe; Kiwi разбирается выборочно, узлы и связи индексируются на диске. Selection-кэш ограничен 2048 узлами и 4 МиБ учтённых данных; это не ограничение RSS (`src/network-source.ts`, `src/network-wire.ts`, `src/network-disk.ts`).
- Retained worker переиспользуется между страницами; части снимка проверяются на целостность. Idle TTL — 60 секунд. Сохраняются отмена, очистка scratch, освобождение при ошибках/смене selection и ограничение тяжёлых операций (`src/network-reader.ts`).
- Полезный контекст включает layout, styles, text, instances/overrides и native variables/UI-kit с явными unresolved. Screenshot/export остаются отдельным UI-путём.
- Capture: последовательность и подтверждения частей, ограниченные очереди, отмена незавершённого поколения; новая авторизация ожидает освобождения предыдущего transfer. Production capture timeout — 30000 мс; observation heartbeat — 15000 мс (`src/index.ts`, `src/bridge.ts`, `src/network-transfer.ts`).

## Причина нестабильного теста и исправление

Тест `capture timeout disconnects idle producer and new connection can capture a fresh generation`
передавал 80 мс в Bridge. Этот бюджет действует и для первого зависшего producer, и для каждого
действия следующего, исправного capture, включая асинхронный disk I/O. Под нагрузкой успешное
поколение может получить `Capture observation timeout` до завершения записи.

Контролируемый опыт: во временной копии теста обёртка store.begin задерживала только generation=2
на 120 мс (`await new Promise(resolve => setTimeout(resolve, 120))` перед настоящим begin).
При старых 80 мс тест завершился с exit=1 и указанной ошибкой; после исправления тот же сценарий
прошёл с exit=0. Временная копия удалена. Это воспроизводит конкретный механизм нестабильности;
stack trace исторического прогона 282/283 не сохранён, поэтому его точная фаза не установлена.

Исправление: использовать штатный бюджет fixture 2000 мс. Проверка всё ещё ждёт настоящий timeout,
а затем выполняет новый capture через тот же bridge/store. Дополнительно проверяются успешный begin,
явная capture-error с причиной timeout и закрытие WebSocket с кодом 1008. Listener close установлен
до begin. Production timeout и поведение сервера не менялись. Очень сильная задержка свыше 2 секунд
по-прежнему может вызвать сбой: это интеграционный тест с реальными часами, сокетом и диском.

## Результаты и ограничения

- До исправления: `npm run check` успешно; `npm test` — 283/283. Исторические 282/283 не подменяют этот результат.
- После исправления: `npm run check` успешно; `npm test` — 283/283.
- Три дополнительных полных прогона `npm test` — каждый 283/283, без skipped/cancelled; всего четыре успешных полных прогона после исправления. `git diff --check` прошёл.
- Контролируемая задержка 120 мс: старый тест падает, исправленный проходит.
- Self-review: проверены общий timeout двух поколений, ожидание очистки в Bridge, неизменность production-кода и сохранение assertions о ready/неопубликованном поколении.

Это функциональная база, а не профиль производительности. Время всего test runner не является
latency MCP. CPU/RSS, общий бюджет 500000000 байт, реальные Figma/Kilo и Windows здесь не измерялись.
Чистая установка не проверялась. Такие проверки относятся к следующим этапам; открытые пункты
19–20 сетевого плана остаются открытыми.
