## ADDED Requirements

### Requirement: 实时窗口拉取

`realtime-quote-service` 模块 SHALL 提供 `fetchQuoteWindow(indexCode, range, opts?)` 函数，按用户指定的时间范围（`3d`/`10d`/`1m`/`2m`/`3m`/`1y`/`custom`）从 `QuoteProvider` 实时拉取该指数在窗口内的每日 OHLCV，并以与 `index_quotes` 行同形（`index_code`、`index_name`、`trade_date`、`close_value`、`open_value`、`high_value`、`low_value`、`volume`、`turnover`、`change`、`change_pct`）的对象数组返回，且 MUST NOT 写入任何持久化存储。

#### Scenario: 预设窗口拉取

- **WHEN** 调用方传入 `indexCode="000001.SH"`、`range="1m"`
- **THEN** 服务端将 `range` 解析为 `[今日-30, 今日]` 的日期区间，调用 `provider.fetchHistoricalQuotes` 拉取该区间内所有交易日的 OHLCV，并按 `trade_date` 升序返回数组；每行字段名与 `index_quotes` 一致

#### Scenario: 自定义起止日期

- **WHEN** 调用方传入 `range="custom"`、`opts.from="2026-01-01"`、`opts.to="2026-03-01"`
- **THEN** 服务端忽略预设窗口、用 `from`/`to` 作为区间，并在 `from > to` 或区间超过 1 年时抛出参数错误

#### Scenario: 字段对齐

- **WHEN** 数据源未提供 `volume` 字段
- **THEN** 返回行中 `volume` SHALL 为 `null`，其余字段保持 `index_quotes` 同名口径，调用方无需做额外字段映射

### Requirement: 涨跌计算

模块 SHALL 在返回数组前为每一行计算 `change` 与 `change_pct`：第一行（窗口最早一天）的两值为 `null`，其后每行 `change = close_value - prev.close_value`、`change_pct = change / prev.close_value * 100`，结果保留与现有 `computeChange` 一致的精度。

#### Scenario: 窗口内涨跌链式计算

- **WHEN** 拉到 5 个交易日 `close_value` 为 `[3000, 3030, 3015, 3060, 3050]`
- **THEN** 返回数组对应 `change_pct` 依次为 `[null, 1.0, -0.495..., 1.493..., -0.327...]`

### Requirement: 当日实时点位

模块 SHALL 提供 `fetchTodayIntraday(indexCode)` 函数，调用 `provider.fetchDailyQuote(today)` 返回当日（含分钟级延迟）的 `QuoteRow`；若今日为非交易日（数据源返回 `null`）则函数返回 `null`。

#### Scenario: 交易日盘中调用

- **WHEN** 在 `2026-05-11 10:30 CST` 调用 `fetchTodayIntraday("000001.SH")`
- **THEN** 返回包含 `trade_date=2026-05-11`、当时最新 `close_value` 与对应 OHLCV 的对象

#### Scenario: 非交易日调用

- **WHEN** 在周六调用 `fetchTodayIntraday("000001.SH")`
- **THEN** 函数返回 `null`，且不抛错

### Requirement: 短 TTL 缓存

模块 SHALL 内置进程内 LRU 缓存：`fetchQuoteWindow` 对相同 `(indexCode, start, end)` 5 秒内重复调用直接返回上次结果；`fetchTodayIntraday` 对相同 `indexCode` 30 秒内重复调用直接返回上次结果。缓存命中时 MUST NOT 触发数据源请求。

#### Scenario: 5 秒内重复请求合并

- **WHEN** 在 1 秒内连续 3 次以相同参数调用 `fetchQuoteWindow("000001.SH", "1m")`
- **THEN** `provider.fetchHistoricalQuotes` 仅被调用 1 次，后两次返回同一份缓存对象

#### Scenario: TTL 过期后回源

- **WHEN** 距上次调用已超过 5 秒，再次以相同参数调用 `fetchQuoteWindow`
- **THEN** 触发一次新的 `provider.fetchHistoricalQuotes` 调用并刷新缓存

### Requirement: 长窗口降采样

当 `fetchQuoteWindow` 返回的日线超过 90 行时，模块 SHALL 额外提供 `aggregateForLlm(rows)`：按 5 个交易日为一周窗口聚合（`open=首日 open`、`close=末日 close`、`high=max`、`low=min`、`volume=sum`、`turnover=sum`、`change_pct=(末close - 首close)/首close*100`）。原始日线数组保持不变（供前端使用），聚合结果仅供注入 LLM 上下文使用。

#### Scenario: 一年窗口聚合

- **WHEN** `fetchQuoteWindow("000001.SH", "1y")` 返回 244 行日线，调用方再调 `aggregateForLlm(rows)`
- **THEN** 返回约 49 行（244 / 5 向上取整）周线对象，字段集合与日线一致
