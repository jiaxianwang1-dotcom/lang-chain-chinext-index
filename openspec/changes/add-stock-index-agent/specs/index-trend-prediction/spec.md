## ADDED Requirements

### Requirement: 长期分析记忆数据模型
系统 SHALL 维护 `index_analysis_memory` 表，至少包含字段：`id`、`index_code`、`as_of_date`（最近一次分析所基于的交易日）、`summary`（LLM 总结的长期分析记忆，TEXT）、`features`（JSON 文本，存储趋势特征/关键因子等结构化信息）、`version`（自增整数）、`created_at`、`updated_at`。`(index_code, version)` MUST 唯一。

#### Scenario: 表结构初始化
- **WHEN** 智能体首次启动
- **THEN** 系统创建 `index_analysis_memory` 并按需建立索引

### Requirement: 首次全量分析
系统 SHALL 提供 `bootstrapPredictionMemory(indexCode)`：当目标指数尚无任何 `index_analysis_memory` 记录时，读取该指数 `index_quotes` 全部历史（含 `change_reason`），通过 LLM 一次性生成长期分析记忆并写入 `index_analysis_memory`，`as_of_date` 为最近一条已入库交易日，`version=1`。

#### Scenario: 历史数据已就绪后初始化记忆
- **WHEN** 上证指数已完成近 1 年回填且 `index_analysis_memory` 中无该指数记录
- **THEN** 调用 `bootstrapPredictionMemory("000001.SH")` 写入 `version=1` 的长期记忆，`summary` 至少包含趋势、波动、关键宏观因素三个维度

### Requirement: 增量分析与下一交易日预测
系统 SHALL 提供 `predictNextTradingDay(indexCode)`：基于 `index_analysis_memory` 中该指数的最新版本（`previous_memory`）+ `index_quotes` 中 `as_of_date` 之后的新增行情，调用 LLM 输出：

- `direction`：`"up"` | `"down"`（即买涨 / 买跌）
- `confidence`：0–1 的小数
- `rationale`：≤ 150 字中文说明
- `updated_memory`：合并后的新长期分析记忆

预测完成后，系统 MUST 将 `updated_memory` 作为新版本（`version = previous.version + 1`）写入 `index_analysis_memory`，并以最新交易日作为 `as_of_date`，从而保证下次预测仅基于"上次记忆 + 当日新增数据"，不再重新读取全部历史。

#### Scenario: 第一次预测使用 bootstrap 后的记忆
- **WHEN** `index_analysis_memory` 已有 `version=1` 记忆且当日 14:00 行情入库
- **THEN** `predictNextTradingDay` 返回 `direction / confidence / rationale`，并写入 `version=2` 的新记忆

#### Scenario: 长期记忆缺失时自动 bootstrap
- **WHEN** 调用 `predictNextTradingDay` 时该指数无任何记忆
- **THEN** 系统先调用 `bootstrapPredictionMemory` 再继续预测，调用方无需感知差异

### Requirement: 预测结果对外接口
系统 SHALL 暴露 `predictAllTargets()`，对所有目标指数依次调用 `predictNextTradingDay`，返回数组 `[{indexCode, indexName, direction, confidence, rationale}]`，供短信通知模块使用。

#### Scenario: 同时预测多指数
- **WHEN** 当日所有目标指数行情已入库
- **THEN** `predictAllTargets()` 返回长度为 2 的数组，分别覆盖上证指数与创业板指
