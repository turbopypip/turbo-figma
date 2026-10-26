# Этап 07: ограниченный Kiwi-декодер

**Решение пользователя: этап 07 (R03, Kiwi-декодер) принят на Rust. Ранее принятые R01/R02 сохраняются; этап 08 развивает общий Rust-путь до индекса, обхода и selection-кэша. Это не решение о полном переписывании всей серверной части: контекст, MCP-обвязка и ассеты оцениваются на своих этапах.**

Платформа проверки — macOS arm64. Текущий production ещё Node.js; его переключение относится к этапам интеграции и приёмки.
Новых зависимостей нет; используется lockfile этапа 06. Windows проверяется на этапе 15.

## Реализация и граница

`rust/helper/src/wire.rs` переносит cold/snapshot-режим production `BoundedWireDecoder`,
а не `compileWireSchema`. Динамическая схема валидируется до декодирования: имена,
уникальность полей/тегов, ссылки типов, обязательные Message/NodeChange, отсутствие хвоста.
Выбранные `nodeFields` передаются из Node.js. Фильтр вложенных style-полей повторяет
`keepStyleField`; parity-тест покрывает typography, overrides и variable values.

Сохранены ограничения: схема 2 МиБ, кадр 64 МиБ, 2000 definitions, 20000 fields,
200000 элементов массива, 10000 retained элементов, строка 1 МиБ, глубина 64,
32000000 операций сообщения, 100000 операций узла, расчётный retained budget узла 2 МиБ.
Последний является тем же логическим счётчиком, что в JS, а не гарантией размера malloc.
Byte-blobs пропускаются с проверкой границ, без массива/побайтового посещения.
Узлы передаются callback по одному; весь документ не собирается в RAM.

Kiwi uint64 использует до девяти байтов, с восемью значащими битами последнего;
значения int64/uint64 возвращаются десятичными строками. Float32 переводится в f64
без округления. Порядок полей сохраняется. Служебный JSON-маркер `$kiwiFloat` сохраняет
NaN/±Infinity через pipe; такой ключ невозможен в валидной Kiwi-схеме. Отрицательный ноль
сохраняется. UTF-8 retained строк проверяется строго; один начальный BOM удаляется,
как у TextDecoder. Содержимое пропущенных строк не проверяется на UTF-8 — это существующая
семантика production; длина и терминатор проверяются всегда.

`--stage7 stream CONFIG` выполняет managed input → Zstandard → Kiwi в одном Rust-процессе.
Выход — ограниченные length-prefixed пакеты: `S` (схема), `N` (один узел), `M` (метаданные сообщения).
В Node остаются дисковый индекс, построение контекста, variables, pagination и MCP.
Pipe/backpressure ограничивает очередь. Схема возвращается один раз для существующего liveCodec;
распакованные сообщения обратно в Node не передаются.

`compatibleDecode` сохраняет fallback этапа 06: при native-отказе повторяет исходный Node-путь,
проверяет SHA-256 уже выданного префикса и не выдаёт его повторно. Consumer/index errors,
отмена и таймаут не запускают fallback. Caller обязан держать read lease на всю операцию.
Проверка fallback включает отказ serde_json после успешно выданного префикса.

Strict live, presence, selection и validateField остаются существующими Node-путями.
Этот эксперимент не заменяет initial inspector или liveCodec и не объявляет готовыми этапы 10–11.

## Методика

Пороги сохранены из этапа 04: время −20% (warm также ≥2 мс), либо RAM −15%,
регрессия второй метрики ≤5%; полезный отдельный cold-участок должен дать ≥10% полного запроса.
N1 не создавался. Production src совпадает с N0; тестируется текущая сборка того же кода.

Команды из корня проекта:

```sh
CARGO_HOME="$PWD/.local/cargo" RUSTUP_HOME="$PWD/.local/rustup" .local/cargo/bin/cargo build --locked --release --manifest-path rust/helper/Cargo.toml
npm run build
node --test tests/rust-stage7.test.mjs
node scripts/rust-helper/stage7-measure.mjs
STAGE7_CASES=real STAGE7_PHASES=request STAGE7_VARIABLES=.cache/figma-network/rust-corpus-real/profile-ui-kit.variables.scss node scripts/rust-helper/stage7-measure.mjs
STAGE7_RUNS=3 STAGE7_CASES=real STAGE7_PHASES=request STAGE7_SELECTION=real-typical STAGE7_VARIABLES=.cache/figma-network/rust-corpus-real/profile-ui-kit.variables.scss node scripts/rust-helper/stage7-measure.mjs
```

На каждом из наборов real / synthetic 1000 / synthetic 4097: 30 свежих процессов
на вариант для cold, отдельный процесс с 10 прогревочными + 100 измеряемыми проходами.
Порядок Node/Rust в cold чередуется. Исходные распакованные bytes/hash одинаковы;
R03 разделяет схему и собственно decode. Чтение файлов находится вне decode timer,
но включено в CPU work и RSS; CPU work также включает schema/setup и warmup.
В full-request CPU work включает весь проверочный обход страниц и release, а не только cold timer.
Standalone RSS включает базовую память runtime; для интеграционного решения используется combined RSS.
Пиковый RSS standalone получен через getrusage/process.resourceUsage.
Объём суммарных временных аллокаций не измерен и не подменяется RSS.

Полный cold-request — `readStoredNetworkSnapshot` до первой готовой страницы:
manifest/freshness/read lease, worker, input, Zstandard, Kiwi, DiskNetworkSnapshot,
query, variables-путь, continuation и проверка общего UTF-8-бюджета.
Для Rust используется автоматически созданная копия dist в `.cache/figma-network/`,
в которой заменено только потребление managed snapshot в worker.
Исходная dist и production src не изменяются. Это совокупный R01+R02+R03 против N0,
а не оценка чистого вклада языка в Kiwi; отдельно этот вклад характеризует R03.
Полный обход selection после первого ответа проверяется вне cold timer:
нормализуются только разрешённые корпусом continuation/capturedAt, сравнивается digest всех страниц.
Наблюдение freshness моделируется владельцем NetworkStore. Браузер, Kilo и MCP stdio здесь не измеряются.

Combined RSS — одновременно sampled host (включая worker threads) + helper;
максимумы разных PID не складываются. Observer измеряется отдельно, ps CPU не включён.
Короткие пики между семплами могут быть пропущены. Live extension не измерено,
общий бюджет 500000000 байт не считается принятым. Cold означает свежий процесс,
а не очищенный файловый кэш ОС; принудительный GC не используется.

## Результаты и решение

### R03 — реальные распакованные сообщения

| Метрика | N0 median / p95 | Rust median / p95 | Изменение median |
| --- | ---: | ---: | ---: |
| Подготовка схемы cold, мс | 9.51 / 9.96 | 1.49 / 1.69 | -84.3% |
| Декодирование cold, мс | 610.86 / 694.51 | 379.17 / 395.87 | -37.9% |
| Декодирование warm, мс | 606.57 / 621.42 | 377.38 / 392.46 | -37.8% |
| CPU work cold, мс | 676.74 / 720.98 | 384.02 / 396.18 | -43.3% |
| Standalone peak RSS cold, МиБ | 92.62 / 93.64 | 25.14 / 25.44 | -72.9% |
| Standalone peak RSS warm, МиБ | 154.59 / 154.59 | 28.27 / 28.27 | -81.7% |

### Полный cold-request

| Сценарий | N0, мс median / p95 | Rust, мс median / p95 | Δ median |
| --- | ---: | ---: | ---: |
| Кнопка без UI-kit, 30+30 | 1480.25 / 1806.09 | 1444.79 / 1735.29 | -2.4% |
| Кнопка с UI-kit, 30+30 | 1477.27 / 1741.65 | 1440.24 / 1534.36 | -2.5% |
| Секция с UI-kit, 3+3 (контроль) | 1503.33 / 1587.38 | 1461.03 / 1586.24 | -2.8% |

Кнопка с UI-kit: simultaneous sampled peak RSS median **171.40 → 136.91 МиБ (-20.1%)**;
CPU work median **1741.82 → 2185.83 мс (+25.5%)**.
Реальный snapshot — те же 15 частей. Все сравниваемые digests совпали; native fallback = 0.
Без UI-kit кнопка — 5 узлов / 1 страница, с UI-kit — 5 / 2; секция — 39 / 13.
CPU work включает проверочный обход и release. Небольшая серия секции не используется как основа решения.

Synthetic cold: 1000 узлов — 9.56 → 2.05 мс;
4097 узлов — 18.27 → 7.16 мс.
Полные median/p95/CPU/RSS и hashes — [числовая сводка](rust-stage7-results.json).
Изолированная warm-синтетика 1000 не проходит абсолютный порог ≥2 мс; это не скрыто общим real-результатом.

**Актуальное решение пользователя: принять R03 (Kiwi-декодер этапа 07) на Rust.**
R01/R02/R03 образуют выбранную основу этапа 08. Промежуточная граница JSON → Node-индекс
устраняется переносом индекса в Rust. Первоначальная рекомендация об отсрочке отдельного
включения гибрида заменена этим решением; перенос Kiwi не отложен.
R03 проходит пороги времени и памяти. Full cold проходит альтернативный критерий памяти
(−20.1%, время не регрессирует), но не достигает отдельного порога ≥10% ускорения полного cold-запроса.
Пользователь принял Kiwi на Rust с этими результатами и ограничениями. Экономия RAM — полезный
результат; ускорение production по этой промежуточной границе пока не заявляется.
Рост CPU принят как допустимое направление по указанию пользователя, а не скрыт или выдан за ускорение.
Индекс, retained lifecycle и устранение передачи всех узлов через IPC относятся к этапам 08/10.
Production остаётся Node.js. N1 не создавался; результаты не приписываются только смене языка.

Успешных измерительных процессов: **312**.
Run-id: `stage7-benchmark-rLN2etKhvqG3`, `stage7-benchmark-QHWh2iw2LJgH`, `stage7-benchmark-fd2sOtHfOxJO`.
Сырые JSON, RSS-семплы, stderr и копии экспериментальной dist находятся локально
в одноимённых каталогах `.cache/figma-network/`. Пробные/неуспешные серии в выводы не включены.
Исходник измерителя основной серии сохранён рядом с ней как `measure-source.mjs`;
в последующих сериях добавлены только параметры выбора scenario/phase/UI-kit.


## Проверки и self-review

Differential: общий wire-корпус и реальная запись, числовые пределы/NaN/Infinity,
Unicode/двойной BOM, retained и skipped malformed UTF-8, truncation, schema/tag/type errors,
дубли, enum errors, хвосты, глубина, лимиты строк/массивов/узла, skip blobs,
style overrides/variables, prefix replay, cancellation/reaping и consumer errors;
100 воспроизводимых мутаций wire-байтов, большие таблицы тегов.
Model-only сценарии общего корпуса продолжают проходить существующие тесты Node-индекса;
они не выдаются за дополнительные wire-сценарии Rust.

Self-review: проверены порядок объектов, отсутствие аккумуляции документа, bounded IPC,
несуммирование worker RSS, точная нормализация ответов, различие тайминга decode/CPU work,
исключение fallback при consumer errors, отсутствие production switch и новых crates.

Итоговые проверки macOS: release build; cargo test **2/2**; `npm run check`;
полный `npm test` **321/321**, включая **10/10** stage7 и локальный реальный корпус,
без skipped; `git diff --check`. macOS CI дополнен, удалённый CI не запускался.
Логи находятся в `.cache/figma-network/stage7-{check,full-tests,cargo-test}.log`.
Production src/extension/package.json/package-lock.json совпадают с N0 `fc3aaea`.
Незакоммиченные изменения этапа 06 сохранены; commit этапа 07 не создавался.
