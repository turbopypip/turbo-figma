# Оптимизация Rust-индекса после этапа 08

**Последующее изменение направления:** пользователь выбрал перенос всех технически
переносимых серверных частей в Rust, включая NetworkStore. Его перенос пока только
запланирован: 08б — файлы/публикация/retention, 10 — coordinator/read leases,
11 — freshness/live ownership. Ниже сохранены измерения и прежние решения этапа 08;
они не означают, что NetworkStore уже реализован или навсегда оставлен на Node.

**Решение пользователя от 26 октября 2026:** оптимизированный Rust выбран для R04
(дисковый индекс, обход и selection-кэш). Измеренный RAM-компромисс принят; исходные
числа и пороги сохранены. На момент приёмки R04 R06 оставался Node; новым направлением выше он включён в перенос.
Включение в production и сквозная приёмка выполняются по последующим этапам плана.

Дата: 26 октября 2026. Цель — устранить real warm raw-query регрессию этапа 08,
сохранив результаты, лимиты памяти, Node fallback и отсутствие production switch.
Предыдущие измерения в rust-stage8.md / rust-stage8-results.json остаются исторической базой.

## Изменения

1. Selection-кэш хранит `Rc<NodeRecord>` с разобранным immutable JSON. Cache hit
   возвращает общий объект без повторного JSON parse и без глубокого clone.
   Lookup наружу возвращает отдельное значение; cached data нельзя изменить через него.
2. Byte budget страницы использует точный размер уже сохранённого canonical JSON
   и размер малого wrapper. Полный узел больше не сериализуется при каждом расчёте
   размера. Свойства копируются только для узлов, вошедших в ответ; массив готовых
   entries переносится в ответ без второй глубокой копии.
3. Immutable child edges содержат GUID, указатель следующей связи, длину и UTF-8
   sibling position. Сортировка не читает и не разбирает весь JSON дочернего узла.
   Header и position записываются одним позиционным write. Это отдельная оптимизация
   представления индекса, не преимущество языка само по себе. Дисковый node log не меняется.
4. Исходный лимит 2048 nodes / 4 МиБ сохранён, но charge теперь учитывает разобранные
   структуры: capacities строк/массивов, BTreeMap allocations, Rc и hash entry overhead.
   Поэтому число cached nodes может быть меньше прежнего при тех же входах.
   Старый string-charge и новый parsed-charge нельзя сравнивать как реальные RSS.

Оценка BTreeMap консервативна для используемой реализации std: до 11 pairs в leaf,
минимум 5 keys у non-root nodes, 768 bytes за leaf / 1024 за internal node плюс
string/array capacities. Структура проверена по [исходнику Rust std](https://doc.rust-lang.org/src/alloc/collections/btree/node.rs.html).
Unit test контролирует размеры Value/pairs; при изменении toolchain/представления
serde_json оценку нужно перепроверить. Это storage charge с запасом, не обещание
равенства heap allocator или общего RSS ровно 4 МиБ.

Данные индекса immutable в рамках одного задания. Live-изменения и invalidation
не включены: этап 11 должен перестраивать или обновлять ordering metadata вместе с
узлом. Полный контекст и retained cursor остаются своими этапами; обход selection
в этой оптимизации по-прежнему выполняется заново.

Новых crates и потоков нет. Вместо принудительного распараллеливания короткого
запроса убраны повторные операции; CPU и cold load измерены вместе с warm latency.

## Контрольное сравнение

Три варианта в одной серии: текущий Node.js, сохранённый release-бинарник Rust до
оптимизации, новый Rust. Чередование порядка трёх вариантов, 30 cold процессов на
набор/вариант, warm в трёх свежих процессах (10 warmup + 100 measured в каждом),
100 смен selection в отдельном процессе. Real + synthetic 1000/4097 nodes.
Итого 306 процессов. Пороги этапа 04 не меняются.

Публичный MCP не измеряется: query time — raw traversal, page budgeting и подготовка
ответа внутри helper; wall/CPU включают загрузку, IPC, проверки digest и cleanup.
RSS — sampled simultaneous host+helper; наблюдатель вынесен отдельно, OS cache не
сбрасывается. Все три варианта получают одни и те же файлы и команды, digests результатов
сравниваются. Старая бинарная сборка сохранена локально с SHA-256 исходной серии.

Запуск:

```sh
npm run build
cargo build --release --locked --manifest-path rust/helper/Cargo.toml
node scripts/rust-helper/stage8-opt-measure.mjs
```

Нужен старый бинарник `.cache/figma-network/stage8-opt-baseline/figma-rust-helper`
или путь `STAGE8_OLD_BINARY`. Его hash сверяется с исторической сводкой. Для пилота
есть STAGE8_RUNS / STAGE8_PHASES / STAGE8_WARM_PROCESSES; пилоты в итог не включены.

## Результаты

Warm raw query, median / p95 мс (300 измерений каждого варианта):

| Набор | Node.js | Rust до | Rust после | Изменение к Rust до |
| --- | ---: | ---: | ---: | ---: |
| real | 2.01 / 3.69 | 3.81 / 4.26 | 0.66 / 0.79 | −82.64% |
| typical | 6.52 / 7.06 | 5.76 / 6.24 | 2.38 / 2.59 | −58.65% |
| beyond-selection-cache | 37.57 / 40.20 | 28.44 / 37.46 | 18.39 / 19.68 | −35.33% |

Холодная загрузка managed input → Zstd → Kiwi → index, median мс; запрос отдельно:

| Набор | Node.js load | Rust до load | Rust после load | Изменение load к Rust до | Rust query до / после |
| --- | ---: | ---: | ---: | ---: | ---: |
| real | 1395.31 | 972.37 | 977.01 | +0.48% | 4.15 / 1.74 |
| typical | 43.67 | 16.18 | 16.30 | +0.74% | 9.12 / 5.22 |
| beyond-selection-cache | 118.86 | 60.03 | 60.16 | +0.22% | 35.15 / 21.06 |

Медиана sampled simultaneous host+helper peak RSS, МиБ:

| Набор | Cold Node / Rust до / после | Warm Node / Rust до / после |
| --- | ---: | ---: |
| real | 150.59 / 91.77 / 92.34 | 165.25 / 106.95 / 107.66 |
| typical | 70.29 / 53.92 / 57.39 | 80.45 / 72.27 / 74.88 |
| beyond-selection-cache | 79.16 / 57.46 / 58.68 | 105.23 / 70.19 / 76.19 |

CPU всего warm-сценария (load + 110 queries + проверка/cleanup), median мс:

| Набор | Node.js | Rust до | Rust после | Изменение к Rust до |
| --- | ---: | ---: | ---: | ---: |
| real | 1874.84 | 1553.16 | 1165.83 | −24.94% |
| typical | 998.57 | 794.66 | 417.19 | −47.50% |
| beyond-selection-cache | 4876.04 | 3398.99 | 2244.90 | −33.95% |

Cache и scratch нового Rust:

| Набор | Cache nodes / charged bytes | Scratch bytes до / после |
| --- | ---: | ---: |
| real | 25 / 3908122 | 68205316 / 68246353 |
| typical | 1000 / 4141203 | 27263449 / 27271441 |
| beyond-selection-cache | 1012 / 4191981 | 28086650 / 28119418 |

Byte cap теперь наступает раньше node cap: real 25/27, 4097 — 1012 cached nodes.
Это не потеря данных: остальные читаются из дискового индекса; полный paginated
обход и digest всех результатов совпали. После release у всех вариантов cache 0/0.
Ordering keys добавили 41037/7992/32768 bytes scratch соответственно. Aggregate
position bytes ограничены node log (не больше его 512 МиБ); offsets остаются <2^32.
Лимит JSON node log не увеличивался. Дополнительные position bytes — явная цена
нового scratch-формата, не скрываются как нулевые I/O.

## Решение и ограничения

Регрессия real warm устранена: новый Rust быстрее текущего Node примерно в 3 раза
и прежнего Rust примерно в 5.8 раза. Относительно прежнего Rust выигрыш real warm
3.15 мс, то есть проходит и ≥20%, и ≥2 мс; cold load +0.48%, cold RSS +0.62%.
Original N0 threshold ≥2 мс для маленькой real selection по-прежнему не достигнут
(выигрыш к Node 1.35 мс), хотя регрессии уже нет. На 1000/4097 warm выигрыш к Node
достигает обоих порогов. Старые пороги не изменены.

Есть измеренная цена parsed cache: warm 4097 combined RSS вырос на 6.00 МиБ
(+8.55%) к старому Rust; typical cold — +3.47 МиБ (+6.43%). Это превышает исходные
5% для второй метрики при сравнении именно двух Rust-версий. Нельзя объявлять
все Rust-before → after сценарии прошедшими этот критерий. Относительно N0 RSS
остаётся ниже на всех наборах; 4 МиБ charged cache соблюдается. Оптимизация сохранена
для дальнейшей интеграции с этим явным компромиссом, production не включён.

100 смен selection не накапливают предыдущие cache roots. Native high-water RSS
50 → 100: real 42.31 → 42.42 МиБ, typical 9.59 → 9.63, 4097 — 12.42 → 12.44.
Это короткая проверка ограниченности, не длительный soak test и не подтверждение
общего бюджета 500000000 байт с extension/Kilo. Windows остаётся этапом 15.

## Проверки и артефакты

Release build; Cargo **3/3**; `npm run check`; полный `npm test` **332/332**,
stage8 **11/11**, без skipped. Добавлены assertions shared cache identity, отсутствие
чтений на cache hit, освобождение Rc при clear и ограничение повреждённой длины
position до allocation. Byte-cap test теперь проверяет бюджет разобранных объектов,
а не прежнее число строк; semantic differential assertions не ослаблялись.

Self-review: immutable-node length accounting, bounded cache with conservative
heap estimate, read/write limits, edge loops/position bounds, GUID ordering, output
ownership, cancellation/fallback cleanup. Production runtime не менялся, crates
не добавлялись. Binary override добавлен только в экспериментальный host для
честного запуска сохранённого бинарника.

Серия `stage8-opt-benchmark-89IGTYP2FND1`: **306** успешных процессов.
[Числовая сводка](rust-stage8-optimization-results.json) содержит hashes обеих
бинарных сборок и источников, input hashes, median/p95/CPU/RSS, counters и churn
checkpoints. Hash старого бинарника совпал с исходным этапом 08; hash текущей
сборки и исходников проверен после замера. Сырые данные в `.cache/figma-network/`
под run-id; логи `stage8-opt-{check,full-tests,cargo-test,tests}.log`. Пилоты
VSe05MaOehDa, vvkpxdrHiFh0, K5N9ifeQNDWA не включены в итог.
