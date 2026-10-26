# Rust-helper: текущий runtime и история прототипов

**Актуально на 26 октября 2026:** helper подключён к рабочему managed MCP-пути на macOS. Сборка: `npm run build:rust`. Контракт runtime, границы переноса и проверки: [отчёт](rust-runtime-status.md). Ниже сохранена история этапов 05–08; утверждения об отсутствии production-интеграции относятся к тем этапам.

**Решение пользователя: этап 07 (R03, Kiwi-декодер) принят на Rust. Ранее принятые R01/R02 сохраняются; этап 08 развивает общий Rust-путь до индекса, обхода и selection-кэша. Это не решение о полном переписывании всей серверной части: контекст, MCP-обвязка и ассеты оцениваются на своих этапах.**

Это исторический отчёт каркаса. Текущие зависимости, дополнительные режимы
и результаты этапа 06 описаны в [отдельном отчёте](rust-stage6.md).

25 октября 2026. Решение для прототипов — дочерний процесс, без сторонних
Rust/npm-зависимостей. Production Node.js не вызывает helper.

Процесс позволяет изолировать native crash и принудительно прервать работу на
macOS/Windows. FFI потребовал бы ABI/Node-совместимых сборок и кооперативной
отмены внутри процесса; авария могла бы завершить MCP. Цена выбранной границы —
запуск процесса, pipe I/O и копирование. Финальный выбор архитектуры остаётся
этапом 12. Здесь один запрос на процесс; retained lifecycle — этап 10.

## Сборка и проверка

Rust 1.99.1, edition 2021; Cargo.lock зафиксирован, crates отсутствуют.

```sh
cargo +1.99.1 test --locked --manifest-path rust/helper/Cargo.toml
cargo +1.99.1 build --locked --release --manifest-path rust/helper/Cargo.toml
node --test tests/rust-helper.test.mjs
node scripts/rust-helper/measure.mjs
```

Локально toolchain установлен в `.local/cargo` и `.local/rustup`. Для команд
нужны CARGO_HOME/RUSTUP_HOME с этими абсолютными путями и `.local/cargo/bin`
в PATH. Установка не меняла профиль shell. Release: LTO, один codegen unit,
strip, panic=abort. Результат — `rust/helper/target/release/figma-rust-helper`
(Windows: `.exe`). CI `rust-helper.yml` собирает и тестирует macOS/Windows,
публикует бинарник как артефакт с ОС/архитектурой в имени. Сейчас доставка только
для разработчиков: локальная сборка или CI artifact. Автоустановка, подпись,
проверка скачанного бинарника и production-поставка относятся к этапу 14.

## Контракт v1

UTF-8, одна строка: `version<TAB>id<TAB>operation<TAB>argument<LF>`.
ID всегда `1`, одна операция на процесс, лимит всей строки 65536 байт.
Ответ: `1<TAB>id<TAB>ok|error<TAB>value<LF>`. При повреждённом frame ID=0.
stdout содержит только ответ, stderr зарезервирован под диагностику.
Это внутренний диагностический протокол, не MCP и не benchmark-driver этапа 03.
Перед добавлением произвольных данных нужен новый явно описанный контракт.

- `ping` + пустой аргумент → `pong`.
- `shutdown` + пустой аргумент → `bye`, выход 0.
- `delay` + миллисекунды 0–60000 → `done`; диагностическая проверка отмены.
- `crash` + пустой аргумент → аварийное завершение; только тестовый каркас.
- Ошибки: INVALID_FRAME, UNSUPPORTED_VERSION, INVALID_ARGUMENT, UNKNOWN_OPERATION.
- Некорректный UTF-8/read/write failure завершают процесс с ошибкой.

Хост запускает абсолютный путь без shell; лимитирует stdout и stderr (64 КиБ
каждый), проверяет ответ и exit status. Таймаут по умолчанию 2 секунды, максимум
60 секунд. AbortSignal/таймаут завершают дочерний процесс; Promise завершается
после события close, включая закрытие pipe. Нет очереди или фоновой службы.
Helper не создаёт дочерних процессов и scratch. Ошибки запуска, протокола,
аварии и отмены доступны через `error.code`. Отмена уничтожает этот процесс;
следующий вызов создаёт новый.

## Проверки и ограничения

На macOS arm64: Cargo test 1/1, интеграционные тесты 4/4, npm check успешно,
полный npm test 301/301. Проверены версии, ошибки, нормальный выход, отсутствующий
бинарник, таймаут, отмена, crash и повторный вызов. После нормального выхода,
отмены и таймаута PID недоступен. Self-review: проверены ограничения до выделения
памяти, очистка таймера/listener, обработка EPIPE и spawn failure.

[Сырые 30 запусков и median/p95](rust-helper-overhead.json) измеряют суммарно
spawn + ping IPC + завершение. Это отдельный диагностический замер на macOS,
с неконтролируемым OS cache; он не доказывает ускорение декодера. CPU/RSS здесь
не измерены; общий бюджет 500 МБ не принят. Нет замера retained/warm IPC.
Windows CI подготовлен, но в этой сессии не запускался. По решению пользователя
все Windows-проверки вынесены в отдельный этап 15 плана миграции. Этап 05 закрыт
по результатам macOS; Windows ещё не принят. Этап 06 не начат.

Этап 07 добавляет `--stage7` (dynamic bounded Kiwi + общий input/Zstandard/decode stream).
Контракт, сравнительные результаты и решение — [rust-stage7.md](rust-stage7.md).
Production и strict live остаются на Node.js; новых crates в этапе 07 нет.

Этап 08 добавляет `--stage8 managed|model CONFIG`: Rust строит disposable disk index,
читает команды query/lookup/children/asset/release из ограниченного job config и
отдаёт bounded length-prefixed JSON. В production не импортируется. Scratch создаёт
и удаляет Node-хост после нормального выхода, ошибки, отмены или timeout; на native
отказе до публикации результата возможен полный Node fallback. Caller удерживает
NetworkStore read lease; immutable benchmark-копии не изменяются во время job.
Это одно задание с последовательными командами, не retained service этапа 10.
[Контракт, измерения и решения этапа 08](rust-stage8.md).

После этапа 08 [оптимизированы cache и обход](rust-stage8-optimization.md): parsed
Rc cache с консервативным charge в том же 4-МиБ бюджете, immutable edge ordering
keys и budget по размеру записанного JSON. Disk scratch format внутренний и
одноразовый; старый индекс не открывается новой сборкой. Диагностический host
принимает optional binary для сравнения с сохранённой release-сборкой.
