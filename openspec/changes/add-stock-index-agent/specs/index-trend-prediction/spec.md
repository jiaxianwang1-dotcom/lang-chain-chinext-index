## ADDED Requirements

### Requirement: 长期分析记忆数据模型
系统 SHALL 维护 `index_analysis_memory` 表，至少包含字段：`id`、`index_code`、`as_of_date`（最近一次分析所基于的交易日）、`summary`（LLM 总结的长期分析记忆，TEXT）、`features`（JSON 文本，存储趋势特征/关键因子等结构化信息）、`version`（自增整数）、`created_at`、`updated_at`。`(index_code, version)` MUST 唯一。

#### Scenario: 表结构初始化
- **WHEN** 智能体首次启动
- **THEN** 系统创建 `index_analysis_memory` 并按需建立索引

### Requirement: 实时分析（短窗 OHLCV + 归因驱动）
系统 SHALL 提供 `predictNextTradingDay(indexCode, opts?: { windowDays?: number })`：每次调用时**只读取**该指数 `index_quotes` 中最近 `windowDays`（默认 30）个交易日的真实日线数据，并把每行的 OHLCV（`open_value / high_value / low_value / close_value / volume`）+ `change_pct` + `change_reason` 一并喂给 LLM 进行实时分析，**不读取**任何 `index_analysis_memory` 中的历史长期记忆作为输入上下文。

LLM 系统提示 MUST 满足：

1. 明确告知模型表格列含义为 `date / open / high / low / close / chg% / volume / reason`
2. 硬性禁止模型引用表格之外的指标（如 MACD、北向资金、换手率等数据库未提供的字段）
3. 要求 `direction` 必须二选一（`"up"` 买涨 / `"down"` 买跌），不允许中立
4. 要求 `confidence` 在 `[0,1]` 内按信号清晰度梯度给出（明确信号 0.75–0.92；中性偏向 0.6–0.75；混乱 0.5–0.6），禁止刻意压低
5. 要求 `rationale` 必须引用具体收盘点位、涨跌幅，以及表格中真实出现的成交量数字

预测结果（`direction / confidence / rationale / based_on_trade_date / window_days / window_start / predicted_at / mode`）MUST 持久化到 `index_analysis_memory.features.last_prediction`，`summary` 字段记录人类可读的概要，`version` 自增。该记忆**只用于事后查询**（如 `query_latest_prediction`），不再作为下次预测的 LLM 输入上下文。

#### Scenario: 实时分析仅依赖近 30 天数据
- **WHEN** 调用 `predictNextTradingDay("000001.SH")` 且 `index_quotes` 中该指数已有 ≥ 30 个交易日含 OHLCV 的数据
- **THEN** LLM user prompt 中 MUST 出现近 30 行表格、每行包含开高低收 + 涨跌% + 成交量；MUST NOT 出现来自任何旧 `index_analysis_memory.summary` 的内容；返回 `direction ∈ {"up","down"}`、`confidence ∈ [0,1]`、`rationale` 引用真实点位与量能

#### Scenario: 不依赖 bootstrap：无任何长期记忆也能直接预测
- **WHEN** `index_analysis_memory` 中该指数无任何记录，调用 `predictNextTradingDay`
- **THEN** 系统直接基于近 30 天 OHLCV 完成预测，不会调用 `bootstrapPredictionMemory`，也不会因记忆缺失而抛错

#### Scenario: 每次调用都生成新版本记忆
- **WHEN** 同一交易日内连续调用 `predictNextTradingDay` 两次
- **THEN** 第一次写入 `version=N`、第二次写入 `version=N+1`，二者互不读取

### Requirement: 历史长期记忆 bootstrap 仍保留作为可选工具
系统 SHALL 保留 `bootstrapPredictionMemory(indexCode)` 函数导出，用于离线生成一次"近 1 年趋势总结"长期记忆并写入 `index_analysis_memory`。该函数 NOT IN 主流程（`runOnce` 与 cron 不再调用），仅在需要离线分析时由调用方手动触发。

#### Scenario: 显式调用 bootstrap 生成长期总结
- **WHEN** 在 REPL 或 web-agent 中显式调用 `bootstrapPredictionMemory("000001.SH")`
- **THEN** 系统读取 `index_quotes` 全部历史并生成 `version=1`（或递增）的长期记忆，但不会被后续 `predictNextTradingDay` 自动作为输入上下文消费

### Requirement: 预测结果对外接口
系统 SHALL 暴露 `predictAllTargets()`，对所有目标指数依次调用 `predictNextTradingDay`，返回数组 `[{indexCode, indexName, direction, confidence, rationale}]`，供短信通知模块使用。

#### Scenario: 同时预测多指数
- **WHEN** 当日所有目标指数行情已入库
- **THEN** `predictAllTargets()` 返回长度为 2 的数组，分别覆盖上证指数与创业板指
