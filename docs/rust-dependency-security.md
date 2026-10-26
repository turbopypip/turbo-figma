# Проверка кандидатов зависимостей — 26 октября 2026

Пользователь согласовал tokio, tokio-tungstenite, rmcp и unicode-normalization при условии предварительной проверки безопасности. Проверка проведена в отдельном manifest в `.local/rust-security-review`; рабочий Cargo.toml на момент проверки не изменялся.

| Пакет | Проверенная версия | Решение |
| --- | --- | --- |
| tokio | 1.54.1 | Допустима с точным закреплением; не использовать 1.54.0 |
| tokio-tungstenite / tungstenite | 0.30.0 | Допустима; handshake, без TLS и исходящих подключений |
| rmcp | 3.7.0 | Допустима; только server + transport-io, без HTTP/OAuth |
| unicode-normalization | 0.1.26 | Допустима; std, исходник запрещает unsafe_code |
| futures-util | 0.3.34 | Дополнительно согласована пользователем; уже входила в проверенный граф, std + sink |

## Проверенные риски

- Tokio: [RUSTSEC-2026-0384](https://rustsec.org/advisories/RUSTSEC-2026-0384.html), use-after-free в Interval на многопоточном runtime 1.54.0, исправлен в 1.54.1. [RUSTSEC-2026-0386](https://rustsec.org/advisories/RUSTSEC-2026-0386.html), I/O safety AsyncFd, исправление/депрекация безопасных конструкторов включены в 1.54.1. Наш код не должен использовать deprecated-конструкторы AsyncFd.
- Tungstenite: [RUSTSEC-2023-0065](https://rustsec.org/advisories/RUSTSEC-2023-0065.html), handshake CPU DoS исправлен начиная с 0.20.1. Версия 0.30.0 вне уязвимого диапазона. Всё равно необходимы лимиты handshake/message/frame и таймауты.
- rmcp: [GHSA-4432-vg92-fqh6](https://github.com/modelcontextprotocol/rust-sdk/security/advisories/GHSA-4432-vg92-fqh6), неограниченный HTTP tool_schemas cache, исправлен в 3.6.0. [GHSA-5p52-q7pq-9fq2](https://github.com/modelcontextprotocol/rust-sdk/security/advisories/GHSA-5p52-q7pq-9fq2), SSRF OAuth discovery, исправлен в 3.7.0. Эти функции дополнительно отключаются feature-флагами.

## Метод и границы

Источники пакетов проверены по crates.io API: tokio-rs/tokio, snapview/tokio-tungstenite, modelcontextprotocol/rust-sdk, unicode-rs/unicode-normalization. Cargo получил версии из crates.io и проверил registry checksums. `cargo metadata` разрешил 95 registry-пакетов, включая платформенные транзитивные зависимости. OSV querybatch проверил каждую точную пару name/version: **0 найденных advisories**. Сырые результаты и список build/proc-macro кода — в [rust-dependency-security.json](rust-dependency-security.json).

Читались официальные RustSec/GitHub advisories, feature maps и build.rs прямых зависимостей. rmcp имеет build.rs, который на два каталога выше manifest ищет одновременно `.git` и `.githooks` и при их наличии меняет `core.hooksPath`. В стандартном registry-каталоге Cargo это условие не выполнено. Зависимость необходимо получать из registry, не подменять произвольным path/git checkout.

Это проверка известных уязвимостей и поверхности подключения, не полный аудит исходников 95 пакетов. Build scripts и proc macros транзитивных зависимостей выполняют код при сборке; их полный ручной аудит не проводился. Проверку надо повторять на итоговом рабочем Cargo.lock после любых изменений графа. Новые прямые зависимости, кроме четырёх согласованных, требуют отдельного согласования.

## Подключённый граф

После подключения пяти согласованных прямых зависимостей проверен рабочий Cargo.lock: **102 registry-пакета, 0 известных OSV advisories**. Результат сохранён в `productionLock` файла rust-dependency-security.json. Дополнительные к первоначальному графу пакеты включают уже существовавшие зависимости helper и объединённые build dependencies; HTTP/OAuth/TLS не включены. Cargo.lock сохраняет закреплённые версии, сборка выполняется с `--locked`.
