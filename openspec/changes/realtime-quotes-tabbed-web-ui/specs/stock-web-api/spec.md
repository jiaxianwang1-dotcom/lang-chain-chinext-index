## ADDED Requirements

### Requirement: 智能体实时问答端点

服务端 SHALL 提供 `POST /api/stock/chat`，接收 JSON `{ message: string, range?: RangeKey, from?: string, to?: string, thread_id?: string }`，使用 SSE（`text/event-stream`）流式返回 LLM 回复。处理流程为：

1. 校验 `message` 非空；若 `range` 缺省则取 `"1m"`（30 天）；
2. 用关键字表（包含但不限于 `["大盘", "上证", "创业板", "000001", "399006", "指数", "A股", "盘面"]`）判定该问题是否涉及大盘；
3. 若涉及大盘，则用 `realtime-quote-service.fetchQuoteWindow` 实时拉取上证指数与创业板指在该窗口的数据（必要时调用 `aggregateForLlm` 降采样），以系统消息形式注入 `stockGraph`；若不涉及，则不注入；
4. 调用 `stockGraph.invoke({ messages })` 并把 token 增量以 `data: {"content": "..."}` 形式推送，结束推送 `data: {"done": true}`。

#### Scenario: 大盘问题默认 30 天窗口

- **WHEN** 客户端 POST `{ "message": "今天上证表现怎么样" }`（不带 `range`）
- **THEN** 服务端取 `range="1m"`，从 `realtime-quote-service` 拉取近 30 个交易日数据，序列化为系统消息后再调用 `stockGraph`，最终通过 SSE 把 LLM 回复流式吐回，结束后发送 `{"done": true}`

#### Scenario: 显式时间范围

- **WHEN** 客户端 POST `{ "message": "近半年大盘走势", "range": "custom", "from": "2025-11-11", "to": "2026-05-11" }`
- **THEN** 服务端按 `[from, to]` 区间拉取并注入数据；窗口 > 90 个交易日时改用周线聚合再注入

#### Scenario: 非大盘问题不注入

- **WHEN** 客户端 POST `{ "message": "TypeScript 怎么定义泛型" }`
- **THEN** 服务端 SHALL NOT 调用 `realtime-quote-service`，直接把 `message` 喂给 `stockGraph`

#### Scenario: 参数校验失败

- **WHEN** 客户端 POST `{ "message": "" }` 或 `range="custom"` 但缺少 `from`/`to`
- **THEN** 服务端返回 HTTP 400 + JSON `{ "error": "<原因>" }`，且不调用 LLM

### Requirement: 历史窗口查询端点

服务端 SHALL 提供 `GET /api/stock/quotes`，查询参数 `indexCode`（必填）、`range`（可选，默认 `"1m"`）、`from` / `to`（仅 `range=custom` 时必填）。响应为 JSON `{ indexCode, indexName, range, from, to, rows: QuoteRow[] }`，`rows` 字段集合与 `realtime-quote-service.fetchQuoteWindow` 返回保持一致。

#### Scenario: 默认窗口查询

- **WHEN** 客户端 `GET /api/stock/quotes?indexCode=000001.SH`
- **THEN** 响应 200，`rows` 为近 30 个交易日数组、按 `trade_date` 升序，且每行字段名与 `index_quotes` 表一致

#### Scenario: 非法 indexCode

- **WHEN** 客户端传 `indexCode=ABCDE`（不在 `listTargetIndexes()` 中）
- **THEN** 响应 400 + `{ "error": "unsupported indexCode" }`

#### Scenario: 数据源失败

- **WHEN** `provider.fetchHistoricalQuotes` 抛错
- **THEN** 服务端记录 `realtime.fetch_failed` 日志并返回 502 + `{ "error": "upstream quote provider failed" }`

### Requirement: 当日实时端点

服务端 SHALL 提供 `GET /api/stock/quotes/today?indexCode=...`，返回 `{ indexCode, indexName, row: QuoteRow | null, fetchedAt: ISOString }`。`row` 在非交易日为 `null`。

#### Scenario: 交易日 5 分钟轮询

- **WHEN** 前端每 5 分钟调用一次 `GET /api/stock/quotes/today?indexCode=000001.SH`
- **THEN** 服务端通过 `realtime-quote-service.fetchTodayIntraday` 获取最新点位返回；30s 内的连续请求由缓存合并，不打满数据源

#### Scenario: 非交易日

- **WHEN** 在周日调用 `GET /api/stock/quotes/today?indexCode=000001.SH`
- **THEN** 响应 200 + `{ row: null, ... }`

### Requirement: 交易日判定端点

服务端 SHALL 提供 `GET /api/stock/trading-day?date=YYYY-MM-DD`（`date` 缺省视为今日 Asia/Shanghai），返回 `{ date, isTradingDay: boolean }`。判定逻辑：当日已存在 `index_quotes` 行 OR 当前时间处于 09:30-11:30 / 13:00-15:00（Asia/Shanghai）且为周一至周五 → `true`，否则 `false`。

#### Scenario: 今天是周三

- **WHEN** `GET /api/stock/trading-day`（无参数）于周三 10:00 调用
- **THEN** 响应 `{ "date": "<今日>", "isTradingDay": true }`

#### Scenario: 周末

- **WHEN** 周六调用
- **THEN** 响应 `{ "isTradingDay": false }`

### Requirement: 范围参数解析中间件

所有 `/api/stock/*` 端点 SHALL 共用同一个范围参数解析逻辑：合法 `range` 取值为 `["3d","10d","1m","2m","3m","1y","custom"]`；`custom` 必须同时提供合法的 `from` 与 `to`，且 `to >= from`，区间 ≤ 366 天。校验失败统一返回 400。

#### Scenario: 非法 range

- **WHEN** 客户端传 `range="2y"`
- **THEN** 响应 400 + `{ "error": "invalid range" }`

#### Scenario: custom 区间过长

- **WHEN** `range="custom"`, `from="2024-01-01"`, `to="2026-05-11"`
- **THEN** 响应 400 + `{ "error": "custom range exceeds 1 year" }`
