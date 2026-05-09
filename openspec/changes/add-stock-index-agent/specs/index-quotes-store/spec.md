## ADDED Requirements

### Requirement: 指数行情持久化数据模型
系统 SHALL 在 SQLite 数据库中维护一张 `index_quotes` 表，至少包含以下字段：`index_code`（指数代码，如 `000001.SH`）、`index_name`（指数名称，如 `上证指数`）、`trade_date`（交易日，`YYYY-MM-DD`）、`close_value`（收盘点位，REAL）、`change`（相较上一交易日点数变化，REAL）、`change_pct`（相较上一交易日涨跌百分比，REAL）、`change_reason`（涨跌原因文本，TEXT，可空）、`reason_source`（原因来源/链接，TEXT，可空）、`created_at`、`updated_at`。

`(index_code, trade_date)` MUST 为唯一约束；`trade_date` MUST 建立索引以支持按日期范围查询。

#### Scenario: 数据库初始化时创建表结构
- **WHEN** 智能体进程首次启动且 `index_quotes` 表不存在
- **THEN** 系统使用 `CREATE TABLE IF NOT EXISTS` 创建该表，并在 `(index_code, trade_date)` 上建立唯一索引

#### Scenario: 重复插入同一交易日数据时执行 upsert
- **WHEN** 同一 `(index_code, trade_date)` 已存在且新行情到达
- **THEN** 系统更新 `close_value / change / change_pct / change_reason / reason_source / updated_at`，不创建重复行

### Requirement: 行情查询接口
系统 SHALL 暴露 `getQuote(indexCode, tradeDate)`、`getLatestQuote(indexCode)`、`getQuotesInRange(indexCode, startDate, endDate)`、`getPreviousTradingDay(indexCode, tradeDate)` 四个查询函数，用于上层归因与预测模块按指数和日期检索数据。

#### Scenario: 获取上一交易日行情
- **WHEN** 调用 `getPreviousTradingDay("000001.SH", "2026-05-09")`
- **THEN** 返回该指数在 `2026-05-09` 之前最近一条已存在的 `index_quotes` 记录；若不存在则返回 `null`

#### Scenario: 按区间查询近 1 年行情
- **WHEN** 调用 `getQuotesInRange("399006.SZ", "2025-05-09", "2026-05-09")`
- **THEN** 返回区间内所有交易日的行情，按 `trade_date` 升序排列

### Requirement: 数据库文件隔离
系统 SHALL 将指数行情数据写入独立的 SQLite 文件 `.memory/stock_agent.db`，不与现有的 `web_agent.db` 共用。

#### Scenario: 与现有通用 agent 隔离
- **WHEN** 同时运行通用 web-agent 与 stock-index-agent
- **THEN** 双方各自只读写自己的数据库文件，互不影响
