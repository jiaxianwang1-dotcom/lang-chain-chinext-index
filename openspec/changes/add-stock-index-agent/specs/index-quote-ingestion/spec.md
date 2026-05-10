## ADDED Requirements

### Requirement: 支持上证指数与创业板指
系统 MUST 至少支持两个目标指数：上证指数（`index_code="000001.SH"`，`index_name="上证指数"`）和创业板指（`index_code="399006.SZ"`，`index_name="创业板指"`）。指数清单 SHALL 以常量数组形式集中维护，便于后续扩展。

#### Scenario: 列出所有目标指数
- **WHEN** 调用 `listTargetIndexes()`
- **THEN** 返回包含上证指数与创业板指的数组，每项至少含 `index_code` 与 `index_name`

### Requirement: 首次回填近 1 年日线
系统 SHALL 在首次启动（或显式触发回填命令）时，从行情数据源拉取每个目标指数最近 365 个自然日内的全部交易日日线数据，计算每条记录的 `change` 与 `change_pct`，并通过 upsert 方式写入 `index_quotes`。

每条入库记录 MUST 同时尽力填充 OHLCV 字段（`open_value / high_value / low_value / volume / turnover`）；当行情源返回该字段缺失时 MAY 写入 NULL，但不得用 0 占位。

回填过程 MUST 跳过非交易日，并在网络/数据源失败时记录错误且继续处理其他日期，整体作业以"已成功回填 N 条 / 失败 M 条"汇总日志结束。

#### Scenario: 数据库为空时执行全量回填
- **WHEN** `index_quotes` 表中目标指数无任何记录，且执行 `backfillOneYear()`
- **THEN** 系统按交易日顺序写入近 1 年所有交易日数据，每个指数应至少包含 200+ 个交易日记录，且 `open_value / high_value / low_value / volume` 在数据源能返回的日子里均为非空

#### Scenario: 已部分存在历史数据时只补齐缺失日期
- **WHEN** `index_quotes` 已包含部分历史日期
- **THEN** 回填仅请求并写入缺失日期的数据，不覆盖已有 `change_reason`

### Requirement: 历史 OHLCV 一次性回填
系统 SHALL 提供一个独立入口（CLI flag `--refresh-ohlcv` 或等价函数 `refreshOhlcvForExistingQuotes()`），用于在 schema 演进或数据源补齐后，重新拉取最近 N 天历史日线并仅以 COALESCE 方式补齐已有行的 OHLCV 字段，不修改 `close_value / change / change_pct / change_reason / reason_source`。

#### Scenario: 老库已有 close 但缺 OHLCV，执行一次刷新
- **WHEN** `index_quotes` 中已有 200+ 条历史记录但 `open_value / high_value / low_value / volume` 全为 NULL，并执行 `--refresh-ohlcv`
- **THEN** 系统对每个目标指数重新拉取近 1 年日线，对每条命中已存在 `(index_code, trade_date)` 的记录，仅更新当前为 NULL 的 OHLCV 列；归因 (`change_reason`) 与 `change` / `change_pct` 维持原值不变；最终写出"updated=N failed=0"汇总日志

### Requirement: 每个交易日 14:00 自动采集
系统 SHALL 通过 `node-cron`（或等价定时任务）在每个交易日北京时间 14:00 触发一次行情采集任务，对每个目标指数：拉取当日最新点位、读取上一交易日的 `close_value`、计算 `change` 与 `change_pct`、upsert 到 `index_quotes`，随后调用归因模块写回 `change_reason`。

定时任务 MUST 在节假日 / 周末跳过执行（通过当日是否能取到有效行情或交易日历判断）。

#### Scenario: 交易日 14:00 自动采集成功
- **WHEN** 北京时间到达交易日 14:00
- **THEN** 系统在 60 秒内完成两个目标指数当日行情入库与归因写入，并写入一条 INFO 日志说明结果

#### Scenario: 周末或节假日触发器仍被调度但跳过执行
- **WHEN** cron 触发器在非交易日触发
- **THEN** 系统检测到当日无有效行情后立即返回，不写入任何记录

### Requirement: 行情数据源适配层
系统 SHALL 提供一个 `QuoteProvider` 抽象（接口或类型），至少暴露 `fetchDailyQuote(indexCode, date)` 与 `fetchHistoricalQuotes(indexCode, startDate, endDate)` 两个方法；默认实现使用一种公开免费的 HTTP 行情源（如腾讯财经 / 新浪财经 / 东方财富其中之一）。

`QuoteProvider` 实现 MUST 在 HTTP 失败时进行至少 3 次指数退避重试。

#### Scenario: 行情数据源临时不可用时重试
- **WHEN** 调用 `fetchDailyQuote` 时第一次返回 5xx
- **THEN** 系统按 1s / 2s / 4s 退避重试，最多 3 次后再向上抛出错误
