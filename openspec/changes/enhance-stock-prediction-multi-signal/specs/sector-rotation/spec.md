## ADDED Requirements

### Requirement: 板块轮动持久化（Top5 / Bottom5）
系统 SHALL 维护 `sector_quote` 表，主键 `(trade_date, sector_code, rank_type)`，`rank_type ∈ {'top5', 'bottom5'}`。每个交易日仅入库**当日涨幅榜前 5 + 跌幅榜后 5** 共 10 条，不全量入库 496 个板块。

#### Scenario: 当日 5/8 入库 10 条
- **WHEN** 调用 `ingestSectorRotation("2026-05-08")` 成功
- **THEN** `sector_quote` 表多 10 行；其中 `rank_type='top5' AND rank_pos=1` 的记录是当日涨幅最大的板块

### Requirement: 板块数据采集
系统 SHALL 通过东方财富 `push2.eastmoney.com/api/qt/clist/get?fs=m:90+t:2&fields=f3,f4,f6,f8,f12,f14&po=1&fid=f3` 单次请求拉取全量 496 个板块，按 `f3` 涨幅排序，分别取前 5 与后 5 入库。

`f3=涨跌幅 f4=指数现值 f6=成交额 f8=换手率 f12=板块代码 BKxxxx f14=板块名称`。

#### Scenario: 接口口径正确
- **WHEN** 接口返回 `data.diff` 长度 ≥ 10 且第一项 f3 值最大
- **THEN** 前 5 项写入 rank_type=top5 / rank_pos=1..5；末 5 项（按涨幅升序）写入 bottom5 / rank_pos=1..5

### Requirement: 板块数据查询
系统 SHALL 暴露 `getLatestSectorRotation()` 返回当日 Top5/Bottom5；`getSectorByCode(code, days=30)` 返回某板块近 30 日的入榜历史（用于追溯"哪些板块连续在 Top5"）。

#### Scenario: 追溯连续上榜板块
- **WHEN** 调用 `getSectorByCode("BK1408", 7)`
- **THEN** 返回近 7 个交易日内 BK1408（机器人）入榜的所有记录，可用于判断"机器人板块连续 5 日上榜涨幅前 5"

### Requirement: 板块数据 web 查询工具
web-agent SHALL 暴露 `query_sector_rotation` 工具，返回当日 Top5/Bottom5 板块名称与涨跌幅。

#### Scenario: 用户问"今天什么板块在动"
- **WHEN** 用户在网页里问"今天涨什么"
- **THEN** Agent 调用 `query_sector_rotation()`，返回类似"今日板块涨幅 Top5：航天装备 +8.23% / 印染 +5.46% / 房产租赁 +4.44% / 诊断服务 +4.17% / 机器人 +3.60%"
