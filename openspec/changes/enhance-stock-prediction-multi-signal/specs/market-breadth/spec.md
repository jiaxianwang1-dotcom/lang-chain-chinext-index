## ADDED Requirements

### Requirement: 市场广度数据持久化
系统 SHALL 维护 `market_breadth` 表，主键 `(trade_date, scope)`，`scope` 取值 `'sse' | 'szse' | 'chinext'`，包含字段：`advancing`（涨家数）、`declining`（跌家数）、`unchanged`（平家数）、`limit_up`（涨停数）、`limit_down`（跌停数，可为 NULL）、`raw_json`、`created_at / updated_at`。

#### Scenario: 一次入库三个 scope
- **WHEN** 调用 `ingestMarketBreadth()` 成功
- **THEN** 当日同时写入 `('YYYY-MM-DD', 'sse')` / `('YYYY-MM-DD', 'szse')` / `('YYYY-MM-DD', 'chinext')` 三条记录

### Requirement: 当日涨跌家数采集
系统 SHALL 通过东方财富 `push2.eastmoney.com/api/qt/ulist.np/get?secids=1.000001,0.399001,0.399006&fields=...,f104,f105,f106` 单次请求拿到三大指数当日上涨/下跌/平家数；`f104=涨家数 f105=跌家数 f106=平家数`。

#### Scenario: 成功拿到三大指数广度
- **WHEN** 接口返回 `data.diff` 数组长度为 3 且每项含 f104/f105/f106
- **THEN** 系统分别按 secid 解析为 sse/szse/chinext 写入 `market_breadth`

### Requirement: 当日涨停数采集
系统 SHALL 通过东方财富 `push2ex.eastmoney.com/getTopicZTPool?date=YYYYMMDD` 接口拉取当日涨停个股列表，统计总数后写入 `market_breadth.limit_up`（按 m 字段区分沪/深）。同时 SHALL 把当日涨停股全集（含连板数 `lbc`、行业 `hybk`、涨停时间 `fbt`）保存到 `raw_json` 以便后续追溯。

#### Scenario: 5/8 当日 98 只涨停
- **WHEN** 接口返回 `data.tc=98` 且 `pool` 数组长度=98
- **THEN** sse / szse / chinext 三行各按 market 划分汇总 limit_up（m=1 入沪市，m=0 入深市，code 30 开头入创业板）

### Requirement: 跌停统计降级处理
跌停接口 `getTopicDTPool` 在某些日期可能返回 `data:null`（如周末或接口波动）。系统 MUST 在该情况下写入 `limit_down=NULL`，不抛异常。

#### Scenario: 跌停接口返回 null
- **WHEN** 跌停接口返回 `rc=206 data:null`
- **THEN** 当日 `limit_down` 写入 NULL；预测 prompt 中标注"跌停数缺失"

### Requirement: 市场广度查询
系统 SHALL 暴露 `getLatestBreadth()` 与 `getBreadthInRange(start, end, scope?)`。

#### Scenario: 取近 5 日上证广度
- **WHEN** 调用 `getBreadthInRange("2026-05-04", "2026-05-08", "sse")`
- **THEN** 返回 5 行（每行 advancing/declining/limit_up），按 trade_date 升序

### Requirement: 市场广度 web 查询工具
web-agent SHALL 暴露 `query_market_breadth` 工具。

#### Scenario: 用户问"今天涨家多还是跌家多"
- **WHEN** 用户问"今天市场情绪怎么样"
- **THEN** Agent 调用 `query_market_breadth(limit=1)`，返回三大指数当日 `涨/跌/平 + 涨停数`
