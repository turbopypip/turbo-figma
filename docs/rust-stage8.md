# Этап 08: дисковый индекс и selection-кэш

**Последующее изменение направления:** пользователь выбрал перенос всех технически
переносимых серверных частей в Rust, включая NetworkStore. Его перенос пока только
запланирован: 08б — файлы/публикация/retention, 10 — coordinator/read leases,
11 — freshness/live ownership. Ниже сохранены измерения и прежние решения этапа 08;
они не означают, что NetworkStore уже реализован или навсегда оставлен на Node.

**Решение пользователя от 26 октября 2026:** оптимизированный Rust выбран для R04
(дисковый индекс, обход и selection-кэш). Измеренный RAM-компромисс принят; исходные
числа и пороги сохранены. На момент приёмки R04 R06 оставался Node; новым направлением выше он включён в перенос.
Включение в production и сквозная приёмка выполняются по последующим этапам плана.

**Обновление:** последующая [оптимизация Rust](rust-stage8-optimization.md) устранила
real warm-регрессию: 3.81 → 0.66 мс в контрольном сравнении. Кэш теперь хранит
разобранные узлы с другим memory charge, а edges включают sibling position.
Ниже сохранён исходный отчёт до оптимизации; новые цифры и RAM-компромисс —
в [отдельной сводке](rust-stage8-optimization-results.json).

## Объём и критерии, зафиксированные до замеров

Общий экспериментальный Rust-путь: managed input → Zstandard → bounded Kiwi →
дисковый hash index/node log/child edges/variable asset index → raw selection.
Node получает только ограниченные результаты команд, не поток всех узлов.
Projection геометрии/styles/instance expansion/variables — этап 09; retained service,
TTL/live invalidation и публичная пагинация — этапы 10/11. Здесь raw storage traversal,
lookup зависимостей и ограниченный кэш проверяются отдельно от публичного контекста.

Пороги сохраняются из этапа 04: ≥20% времени (для warm также ≥2 мс) либо ≥15% RAM,
регрессия другой метрики ≤5%; вклад в полный cold ≥10% проверяется на этапе полного
контекста, не подменяется временем raw запроса. CPU измеряется отдельно.
N0 — текущий production DiskNetworkSnapshot и BoundedWireDecoder. N1 не создаётся.
Индекс Node сохраняет variable-assets и остальные издержки. Для сравнения raw
обход использует production private node/children/slot, но не вызывает дизайн projection.

R04: отдельная загрузка одинаковых model records, managed путь целиком, raw страницы,
100 warm queries после 10 разогревочных, 100 смен selection, logical read/write calls и
bytes, logical/allocated scratch, simultaneous sampled host+helper RSS и CPU.
Cold означает новый процесс, файловый кэш ОС не сбрасывается. Нет forced GC.
R06: отдельное решение о NetworkStore; публикация/retention не переносятся без
подтверждённого выигрыша и сохранения их гарантий. Приёмка Windows — этап 15.

## Реализация и контракт

- `rust/helper/src/disk.rs`: 524288 дисковых slots по 48 байт, append-only node log,
  24-байтные child edges, отдельный variable-assets key/version index. Полной карты
  документа в RAM нет. На macOS используются позиционные read/write без лишнего seek;
  для остальных платформ оставлен переносимый seek/read/write, проверка Windows позже.
- Сохранены 200000 узлов, 400000 identities, 4096 probes, 1 МиБ на узел,
  512 МиБ node log, 10000 siblings и 2 МиБ ключей сортировки. Cache: 2048 узлов,
  4 МиБ charged storage, сброс при смене root и release. Charge учитывает UTF-16
  формулу Node и не может быть меньше реального UTF-8 payload с overhead.
- Сортировка positions — UTF-16 как JS; одинаковые positions сортируются по GUID
  с порядком `localeCompare` для десятичных digits/colon. Paint-order reversal и
  Auto Layout order сохранены. Глубина 0–50, maxNodes 1–500, bounded raw page.
- `stage8.rs`: managed input → native Zstd → bounded Kiwi → index без возврата
  всех узлов в Node. Diagnostic model mode читает по одной length-prefixed JSON
  записи. Node/Rust читают один и тот же файл логических records.
- `json.rs`: дисковые числа/NaN/Infinity/−0 следуют JSON.stringify семантике;
  serde_json использует `float_roundtrip`, чтобы чтение индекса не теряло последний
  бит double. Включена feature уже согласованной зависимости, новых crates нет.
- Экспериментальный host передаёт config ≤64 КиБ; до 1000 последовательных commands,
  ответ ≤2 МиБ, raw query budget 4096–1048576 байт. Output streamed с backpressure.
  Query возвращает raw node properties, traversal counters, ancestry path и offset.
  Lookup/asset сохраняют доступ к definition/master вне selection; разрешение и
  расширение instances/variables будет принято в этапе 09.
- Host очищает scratch после выхода/error/timeout/abort. Native rejection до выдачи
  результата может целиком повторить работу в неизменённом Node. После выдачи
  результата, consumer error, timeout или abort replay запрещён. Сбой не публикует
  частично построенный индекс. Live не подключён; production остаётся Node.js.

## Методика и ограничения

Реальная неизменённая запись содержит 15 managed parts, 2395716 байт; обычная выборка
— секция `3215:21200`. Raw selection содержит исходные записи, а не expanded context
этапа 07: число rendered nodes/страниц с instance projection нельзя сравнивать с этим
замером. Дополнительно synthetic 1000 и 4097 nodes. На каждый cold variant/case —
30 свежих процессов с чередованием Node/Rust. Warm — 10 разогревочных + 100 запросов
одного root. Churn — 100 смен root; обе реализации заново обходят дерево, retained
cursor или memoized full traversal не внедрены.

Model load включает чтение records, JSON parse, построение представления и индекс;
`indexMs` отдельно суммирует callback accept/message (в Rust model также clone входного
Value). Managed load включает input/verification/Zstd/Kiwi/index, но не public context.
Query time включает traversal и raw page budgeting, исключает IPC/финальную сериализацию.
Wall/CPU включают host, helper, нормализацию/digest ответов и очистку. Нельзя приписывать
совокупный выигрыш только языку или только индексу.

RSS — максимум одновременной суммы host+helper с шагом наблюдателя около 10 мс;
короткие пики могут быть пропущены. Observer CPU записан отдельно. Сумма независимых
пиков не используется. В серии model Node также работает в отдельном процессе,
Rust учитывается вместе с Node host. Scratch logical bytes включают sparse tables;
allocated bytes получены через stat.blocks × 512. Read/write counts — логические
операции индексного слоя, не syscall trace и не фактический I/O накопителя. Входные
file reads/OS cache не входят в индексные счётчики. В R06 отдельно считаются части.

Общий бюджет дополнительной RAM 500000000 байт не принят: extension/CDP/Kilo/live
и Windows не измерены. Нет замера публичного get_design_context, retained TTL или
реального медленного диска. Неприменимые метрики не заменяются нулями.

## Воспроизведение

```sh
npm run build
cargo build --locked --release --manifest-path rust/helper/Cargo.toml
REQUIRE_RUST_HELPER=1 node --test tests/rust-stage8.test.mjs
node scripts/rust-helper/stage8-measure.mjs
node scripts/rust-helper/stage8-store-measure.mjs
```

Нужен локальный разрешённый корпус `.cache/figma-network/rust-corpus-real/snapshot/`.
Для синтетики без него: `STAGE8_CASES=typical,beyond-selection-cache`.
Переменные `STAGE8_RUNS`, `STAGE8_PHASES` позволяют diagnostic series; краткие pilot
не включаются в итог. Сырые отчёты/config сохраняются только в локальном cache.

## Результаты R04

Реальная секция; времена — median / p95, RSS — медиана sampled peaks по 30 процессам.
Warm — 100 запросов после 10 разогревочных. N1 отсутствует.

| Метрика | N0 | Rust | Изменение |
| --- | ---: | ---: | ---: |
| Model load → index, мс | 1319.26 / 1365.67 | 1083.27 / 1137.84 | −17.89% |
| Только index callbacks в model, мс | 665.78 / 692.52 | 663.87 / 702.29 | −0.29% |
| Model sampled host+helper RSS, МиБ | 75.98 | 60.11 | −20.88% |
| Managed input → Zstd → Kiwi → index, мс | 1378.01 / 1508.80 | 972.40 / 1045.59 | −29.43% |
| Managed index callbacks, мс | 585.62 / 673.82 | 670.78 / 728.63 | +14.54% |
| Managed sampled host+helper RSS, МиБ | 153.73 | 92.61 | −39.76% |
| Managed CPU work, мс | 1573.26 / 1640.08 | 986.91 / 1020.97 | −37.27% |
| Raw query после cold load, мс | 3.34 / 3.65 | 4.15 / 4.28 | +24.15% |
| Raw query warm, мс | 1.98 / 2.17 | 3.76 / 3.87 | +89.52% |
| Scratch logical bytes | 68205316 | 68205316 | 0% |
| Scratch allocated bytes, median | 67102720 | 66719744 | −0.57% |
| Index build: reads / bytes | 39685 / 1905632 | 39685 / 1905632 | 0% |
| Index build: writes / bytes | 98117 / 44032820 | 98117 / 44032820 | 0% |
| Cold raw traversal: reads / bytes | 188 / 330180 | 162 / 328932 | −13.83% calls; −0.38% bytes |
| Selection cache: nodes / charged bytes | 27 / 328502 | 27 / 328502 | 0% |

Синтетические наборы (cold managed + warm raw):

| Узлов | Cold N0/Rust, мс | Cold изменение | RSS N0/Rust, МиБ | Warm N0/Rust, мс | Warm изменение |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1000 | 42.49 / 15.97 | −62.42% | 71.03 / 54.19 | 6.55 / 5.86 | −10.49% |
| 4097 | 118.31 / 59.52 | −49.69% | 78.99 / 57.30 | 37.17 / 28.37 | −23.66% |

Реальный индекс содержит 19605 записей: node log 2077.73 байта/record, весь
logical scratch 3478.98 байта/record у обеих реализаций. Charged cache size —
оценка удерживаемых строк и entry overhead, не измерение heap allocator.

На 4097 узлах обе стороны удерживают ровно 2048 nodes / 1271524 charged bytes;
после release — 0/0. Полный raw обход в 9 страниц по ≤500 узлов проверен без потерь
и дубликатов. Отдельный крупный Unicode-case достигает byte cap раньше node cap.

После 100 смен selection cache не накапливает старые roots. Native high-water RSS
после 50/100 запросов: real 40.83/40.83 МиБ, typical 4.69/4.69 МиБ, 4097 —
8.16/8.20 МиБ. Малое изменение high-water на последнем наборе не выдаётся за
нулевой allocator overhead; code review подтверждает освобождение старой map и
ограниченность текущего cache. Это не длительный retained-service soak test.

## Результаты R06 и отдельное решение

30 свежих процессов, существующий Node NetworkStore, неизменные реальные части.
Rust publication/retention не реализовывались; N1 и соответствующие Rust-цифры отсутствуют.

| Метрика N0 | Median / p95 |
| --- | ---: |
| Запись + fsync + atomic publication, мс | 81.39 / 86.07 |
| Чтение + проверка частей, мс | 14.11 / 15.72 |
| Inventory одной generation, мс | 2.07 / 2.26 |
| Очистка одной generation, мс | 2.74 / 2.97 |
| CPU измеренной работы, мс | 36.15 / 42.61 |
| Пиковый RSS процесса, МиБ | 56.88 / 57.75 |
| Части / bytes | 15 / 2395716 |
| Логические file writes / очередь append | 17 / 1 |
| Максимальная часть, байт | 262144 |
| Scratch logical / allocated, байт | 2397401 / 2428928 |

ReadVerify включает дополнительную проверку ожидаемого SHA-256 измерителем, сверх
внутренней проверки NetworkStore. Число syscall/read metadata не инструментировалось.
Входные части загружаются до timed work; RSS включает эти buffers. Slow-disk/consumer
стресс здесь не запускался; FIFO не добавлялась, append последовательно await-ится.

**R06: оставить managed NetworkStore на Node.js.** Публикация имеет fsync/atomic
rename/retention/lease обязанности и выполняется отдельно от запроса. Чтение с
проверкой занимает около 1% cold load N0; подтверждённой пользы от переноса
writer/coordination нет. Принятый Rust-reader R01 остаётся внутри общего пути.

## Решение R04 и незакрытые приёмки

**Принять реализованный общий cold-путь индекса как основу этапов 09/10.**
На реальном наборе model load быстрее на 17.89%, sampled RSS меньше на 20.88%:
проходит альтернативный порог RAM при улучшении времени. Собственно accept callback
в model почти не меняется (−0.29%). Общий managed load быстрее на 29.43%, RAM меньше
на 39.76%, CPU меньше на 37.27%. Это совокупный результат R01–R04 с устранением
Kiwi → Node-index IPC, а не обещание такого ускорения публичного MCP. В managed
серии собственно accept callback Rust медленнее на 14.54% — это сохранено в таблице.

**Warm real selection пока не проходит критерий:** 1.98 → 3.76 мс (+89.52%, +1.77 мс).
Порог не меняется и регрессия не скрывается. Typical warm также не достигает
минимального полезного выигрыша; 4097-node warm проходит (−23.66%, −8.79 мс).
Перед production-переключением обязательно устранить или отдельно принять real warm
регрессию в этапах 09/10/13. Исполнение этапа 08 завершено: совместимость слоя,
измерения и отдельные решения получены; production acceptance не объявляется.

## Проверки, review и артефакты

macOS arm64: release build; Cargo **3/3**, `npm run check`, `npm test` **332/332**,
новые stage8 **11/11**, без skipped. Общий реальный corpus verify: 3 cases / 19 files.
Проверены model/wire corpus, real button/section/page, assets вне selection, duplicate,
cycle/ancestry depth, child-before-parent, hidden/order/UTF-16/ties across sessions,
node/sibling byte/count limits, cache node/byte caps, raw pagination, malformed storage,
JSON float roundtrip и nonfinite normalization, fallback, timeout/abort/consumer error,
удаление scratch и отсутствие helper PID после выхода.

Self-review исправил float rounding при serde parsing, tie ordering GUID разных
sessions и лишний seek на macOS. Production src/extension/package manifests совпадают
с N0 fc3aaea. Новых crates нет. macOS CI включает stage8 tests, удалённый CI не запускался.

Основная серия: `stage8-benchmark-riTsCxpKJi6O`, **372** успешных процесса.
R06: `stage8-store-benchmark-rpQjgrgXXhrW`, **30** процессов.
[Машиночитаемая сводка](rust-stage8-results.json) содержит source/binary/input hashes,
median/p95, counters и cache/RSS checkpoints. Сырые отчёты — в одноимённых локальных
каталогах `.cache/figma-network/`; check/test logs — `stage8-*.log`. Предварительные
PKLznMHZI1wX, iMyXYpHXatSO и JEw0UnQOlilq в итог не включены.

Финальная сверка source/binary hashes со сводкой прошла. Оставшихся stage8
decode/index/test scratch-каталогов и работающих helper нет; git diff --check прошёл.
