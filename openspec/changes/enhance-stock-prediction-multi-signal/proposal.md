## Why

`add-stock-index-agent` 已上线，但当前预测仅基于"近 30 天 OHLCV + 当日归因"，维度单薄：

- 只看价 + 量 + 一句归因，无法捕捉"资金面"（融资融券变化）
- 看不到"市场广度"（涨家/跌家/涨停数）反映的赚钱效应
- 看不到"行业轮动"——什么主题在动
- 看不到"机构异动"（龙虎榜大额买入）这种领先信号
- 当日新闻事件没有结构化喂入

用户原话：「其实有些时候涨跌是跟一些内幕消息有关的……提前知道内幕消息的人早就赚钱收手了」。**真内幕公开渠道无法获取**（合规上也不应当），但可以通过资金面 / 龙虎榜 / 量价异动等"代理信号"间接捕捉聪明钱动向。

本 change 的目标：把预测从"OHLCV 单维度"升级为"**7 维多信号**实时分析"，每个维度都有真实数据来源、可被 LLM 引用、不准编造。

## What Changes

### 新增数据维度（4 个）

1. **两融余额**（market-fund-flow capability）
   - 数据源：东方财富 `datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ`
   - 实测：391 页历史，含融资余额、融券、融资买入/偿还/净买入、3-5-10 日累计变化
   - T+1 滞后（晚一天，监管口径如此）

2. **市场广度**（market-breadth capability）
   - 数据源：东方财富 `push2.eastmoney.com/api/qt/ulist.np/get?secids=1.000001,0.399001,0.399006&fields=...,f104,f105,f106` 直接返回三大指数当日涨/跌/平家数
   - 数据源 2：东方财富 `push2ex.eastmoney.com/getTopicZTPool?date=YYYYMMDD` 当日涨停股完整列表
   - 跌停接口稍后补，先用涨停数

3. **行业轮动**（sector-rotation capability）
   - 数据源：东方财富 `push2.eastmoney.com/api/qt/clist/get?fs=m:90+t:2` 返回 496 个板块（含概念/二三级行业/地域）
   - 不强求"申万一级"严格分类——按当日涨幅排序取 Top 5 + Bottom 5 入库，反而更直观地反映"今天什么主题在动"

4. **龙虎榜个股异动**（billboard-record capability）
   - 数据源：东方财富 `datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_DETAILSNEW`
   - 含股票代码、净买入额、上榜原因、买卖席位
   - 当日上榜个股即"机构资金已出手"的信号

### 新增事件分析（1 个）

5. **当日新闻事件**（news-event-analysis capability）
   - 不做常驻爬虫（实测多家反爬/签名）
   - 改为：**预测前临时调用 `webSearch`**，用具体关键词（"今日 A 股 财经要闻 政策"）抓回 8-15 条；用 glm-4-flash 按 `category / sentiment / impact_indices` 结构化打标
   - 当日事件落入 `news_event` 表，避免重复抓取

### 新增本地派生信号（1 个）

6. **异动信号**（不单独建 capability，作为预测前置计算）
   - 量比：当日 volume / 30 日均 volume，> 1.5 标记 high_volume
   - 量价背离：高量 + 微涨 (|chg%| < 1%) → 标记 abnormal_silent
   - 龙虎榜出现该指数成分股 → 标记 lhb_active

### 改进预测引擎（index-trend-prediction capability MODIFIED）

- **多窗口分层**：近 5 日明细（含资金/广度）+ 近 30 日 OHLCV 明细 + 60/90 日统计摘要
- **system prompt 升级**：要求 rationale 至少覆盖 4 个维度并各引用一条真实数字
- **预测结果**新增字段：`signals` 数组记录"哪些维度支持了 up / down 判断"
- 仍然硬性禁止 LLM 引用表格之外的指标

### 不做（明确边界）

- ❌ **北向资金**：港交所 2024-08 起取消每日实时披露，东方财富接口返回的是缓存旧值（实测 10 天数据完全相同）。坚决不接，避免假数据误导
- ❌ **真"内幕消息"**：技术上不可获取，合规也不允许；用龙虎榜 + 异动信号代理
- ❌ **常驻新闻爬虫**：财联社/东方财富 7x24/新浪 RSS 都有反爬或签名；改用按需 webSearch + LLM 事件分类，更稳

## Capabilities

### New Capabilities

- `market-fund-flow`: 两融余额日度数据采集与查询（融资/融券/净买入）
- `market-breadth`: 当日市场广度（涨/跌/平家数 + 涨停统计）采集与查询
- `sector-rotation`: 当日板块涨跌榜 Top5/Bottom5 入库与查询
- `billboard-record`: 龙虎榜个股入库与查询
- `news-event-analysis`: 预测前按需 webSearch + LLM 事件分类入库

### Modified Capabilities

- `index-trend-prediction`: 从"OHLCV 单维度"升级为"7 维多信号实时分析"；prompt 结构重写为分层窗口 + 多源拼装

## Impact

- **代码**：~1500 行 / 15-20 个文件改动；包括 5 个新 provider、4 张新表迁移、1 个事件 LLM 分类器、预测引擎完全重写
- **数据**：`.memory/stock_agent.db` 新增 5 张表（margin / breadth / sector / lhb / news_event）；首次回填两融历史约 1 年（~250 行）
- **依赖**：无新增依赖（沿用 fetch + better-sqlite3 + glm-4-flash）
- **运维**：cron 频率不变（交易日 14:00 触发），但每次会多调 4 个 HTTP API + 1 次 webSearch + 1 次 LLM 分类
- **风险**：
  - 东方财富接口反爬/改字段：每个 provider 加结构化日志 + 失败兜底
  - 新闻 webSearch 召回质量：用兜底 prompt（即使搜不到也不阻塞预测）
  - LLM 单次预测 prompt 变长（~3000 tokens）→ 延迟从 4s 到 ~10s，glm-4-flash 仍能接受
  - 两融 T+1 滞后：prompt 里标注 "截至 T-1"，让 LLM 自己理解
