## ADDED Requirements

### Requirement: 龙虎榜个股持久化
系统 SHALL 维护 `lhb_record` 表，主键 `(trade_date, security_code)`，包含字段：`security_name`、`close_price`、`change_rate`、`net_amount`（净买入，正负）、`buy_amount`、`sell_amount`、`market`（'SH' / 'SZ'）、`explanation`（上榜原因）、`raw_json`、`created_at`。

#### Scenario: 当日上榜入库
- **WHEN** 调用 `ingestLhb("2026-05-08")` 成功
- **THEN** 当日所有龙虎榜个股全部 upsert 入 `lhb_record`，重复执行幂等

### Requirement: 龙虎榜数据采集
系统 SHALL 使用东方财富 `datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&filter=(TRADE_DATE='YYYY-MM-DD')` 接口分页拉取数据。

接口字段映射：`SECURITY_CODE → security_code` / `SECURITY_NAME_ABBR → security_name` / `CLOSE_PRICE → close_price` / `CHANGE_RATE → change_rate` / `BILLBOARD_NET_AMT → net_amount` / `BILLBOARD_BUY_AMT → buy_amount` / `BILLBOARD_SELL_AMT → sell_amount` / `MARKET → market` / `EXPLANATION → explanation`。

#### Scenario: 分页拉取直到无数据
- **WHEN** 当日上榜超过 50 只
- **THEN** 系统按 `pageSize=50` 翻页直到 `data` 数组为空，全部入库

### Requirement: 龙虎榜信号查询
系统 SHALL 暴露 `getLhbActivity(date)` 返回当日龙虎榜聚合统计：`total_count`、`net_buy_total`（所有正向净买入合计）、`net_sell_total`（所有负向净买入合计）、`top_3_by_net_amount`（净买入 Top 3 个股）。

#### Scenario: 当日聚合统计
- **WHEN** 调用 `getLhbActivity("2026-05-08")`
- **THEN** 返回结构 `{ total_count: 42, net_buy_total: 850000000, net_sell_total: -320000000, top_3: [...] }`，用于异动信号判定

### Requirement: 龙虎榜成分股映射到目标指数
系统 SHALL 提供工具函数 `isIndexConstituent(code, indexCode)`，使用首字母判规则：

- 上证指数 `000001.SH`：股票代码以 `60`、`68`、`90` 开头
- 创业板指 `399006.SZ`：股票代码以 `30` 开头
- 深证成指 `399001.SZ`：股票代码以 `00`、`30` 开头

预测时通过该函数过滤出"当日影响目标指数的龙虎榜个股"，写入异动信号。

#### Scenario: 5/8 上证有 5 只龙虎榜个股
- **WHEN** 当日 lhb_record 中代码 60xxxx / 68xxxx 共 5 条
- **THEN** 异动信号 `lhb_active` for 上证指数 = true，附 `lhb_net_buy_sum` 合计金额

### Requirement: 龙虎榜 web 查询工具
web-agent SHALL 暴露 `query_lhb_today` 工具，返回当日净买入 Top 5 与净卖出 Top 5 个股，附上榜原因。

#### Scenario: 用户问"今天龙虎榜机构看上谁"
- **WHEN** 用户问"今天谁上龙虎榜了"
- **THEN** Agent 调用 `query_lhb_today()` 返回结构化 Top 5
