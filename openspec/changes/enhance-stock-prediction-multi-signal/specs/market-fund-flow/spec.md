## ADDED Requirements

### Requirement: 两融余额数据持久化
系统 SHALL 维护 `margin_balance` 表，按 `trade_date` 主键，至少包含字段：`finance_balance`（融资余额，元）、`finance_buy`（融资买入额）、`finance_repay`（融资偿还额）、`finance_net`（融资净买入）、`finance_net_3d / 5d`、`short_balance`（融券余额）、`short_net`（融券净卖出）、`total_balance`（两融总余额）、`market_index`（NEW，当日大盘指数参考）、`raw_json`（原始备份）、`created_at / updated_at`。

#### Scenario: 数据库初始化
- **WHEN** 智能体进程首次启动且 `margin_balance` 表不存在
- **THEN** 系统通过 `CREATE TABLE IF NOT EXISTS` 创建该表

### Requirement: 两融数据采集
系统 SHALL 提供 `MarginBalanceProvider`，使用东方财富 `datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ` 接口拉取数据。提供 `backfillMarginHistory(days=365)` 与 `ingestLatestMargin()` 两个入口；`ingestLatestMargin()` 在每个交易日 14:00 cron 中被调用。

数据接口 T+1 滞后属于市场监管口径，调用方 MUST 接受"今日的两融数据要明天才有"。

#### Scenario: 首次回填一年两融数据
- **WHEN** `margin_balance` 表为空，调用 `backfillMarginHistory()`
- **THEN** 系统拉取近 365 天数据，upsert 入库；日志输出 `inserted=N skipped=M failed=K`

#### Scenario: HTTP 失败时不阻塞主流程
- **WHEN** 调用 `ingestLatestMargin()` 时东方财富返回 5xx 或超时
- **THEN** 系统按 1s/2s/4s 退避重试 3 次后仍失败时返回 `null`，写一条 `stage=margin.fetch_failed` 的错误日志，但不抛异常；当日预测会以"两融数据缺失"标注继续执行

### Requirement: 两融数据查询
系统 SHALL 暴露 `getLatestMargin()` 与 `getMarginInRange(start, end)` 两个查询函数，供预测模块按窗口检索。

#### Scenario: 拿最近 30 天两融趋势
- **WHEN** 调用 `getMarginInRange("2026-04-09", "2026-05-08")`
- **THEN** 返回区间内所有交易日记录，按 `trade_date` 升序排列；缺失日期以 NULL 行表示而不是跳过

### Requirement: 两融数据 web 查询工具
web-agent SHALL 暴露 `query_margin_balance` 工具，参数 `start_date / end_date / limit`，返回该窗口的两融关键指标（融资余额、融资净买入、5/10 日累计）。

#### Scenario: 用户问"最近两融加仓还是减仓"
- **WHEN** 用户在网页里问"最近一周融资资金是流入还是流出"
- **THEN** Agent 调用 `query_margin_balance(limit=7)`，返回近 5-7 个交易日 RZJME（融资净买入）+ 累计值，并附"截至 T-1"提示
