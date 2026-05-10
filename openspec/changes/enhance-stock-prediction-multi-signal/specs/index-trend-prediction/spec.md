## MODIFIED Requirements

### Requirement: 实时分析（短窗 OHLCV + 归因驱动）
系统 SHALL 提供 `predictNextTradingDay(indexCode, opts?: { windowDays?: number })`：每次调用时**只读取**该指数 `index_quotes` 中最近 `windowDays`（默认 30）个交易日的真实日线数据，并把每行的 OHLCV（`open_value / high_value / low_value / close_value / volume`）+ `change_pct` + `change_reason` 一并喂给 LLM 进行实时分析。

**新增**：从本 change 起，预测同时读取以下 6 个新维度并拼装到 LLM prompt：

1. **近 5 日资金面**：`margin_balance` 表中 RZJME（融资净买入）的 5 日序列（截至 T-1）
2. **近 5 日市场广度**：`market_breadth` 表中 advancing / declining / limit_up 的 5 日序列
3. **当日板块轮动**：`sector_quote` 当日 Top5 / Bottom5
4. **当日龙虎榜异动**：`getLhbActivity(today)` 返回的聚合统计 + 影响目标指数的成分股 Top 3
5. **当日新闻事件**：`getTodayNews(asOfDate)` 返回的 ≤ 10 条已分类事件
6. **本地异动信号**：volume 量比、价量背离、lhb_active 三个布尔/数值标记

**不读取**任何 `index_analysis_memory` 中的历史长期记忆作为输入上下文（与原 spec 一致）。

LLM 系统提示 MUST 满足以下硬性纪律（在原 spec 5 条基础上扩展）：

1. 表格列含义为 `date / open / high / low / close / chg% / volume / reason`
2. 硬性禁止模型引用表格之外的指标（如 MACD、北向资金、换手率等数据库未提供的字段）
3. **新增**：rationale **必须**至少覆盖 4 个独立维度，并各引用一条真实数字。维度清单：
   - 价格趋势（30 日明细）
   - 量能（30 日 + 当日量比）
   - 资金面（融资净买入趋势）
   - 市场广度（涨跌家数 / 涨停数）
   - 行业轮动（Top5 / Bottom5 板块名）
   - 龙虎榜异动
   - 新闻事件（至少引用 1 条 title）
4. `direction` 必须二选一（`"up"` 买涨 / `"down"` 买跌），不允许中立
5. `confidence` 在 `[0,1]` 内按信号清晰度梯度给出（明确信号 0.75–0.92；中性偏向 0.6–0.75；混乱 0.5–0.6），禁止刻意压低
6. **新增**：当多维度信号冲突（例如价格上涨但融资净流出）时 MUST 把置信度降到 0.55–0.65，并在 rationale 中明确指出"维度冲突"

预测结果新增字段（持久化到 `index_analysis_memory.features.last_prediction`）：

- 原有 `direction / confidence / rationale / based_on_trade_date / window_days / window_start / predicted_at / mode`
- **新增** `signals: { trend, volume, fund_flow, breadth, sector, lhb, news }`：每个维度记录该维度对最终方向的支持度（'up' / 'down' / 'neutral' / 'missing'）
- **新增** `dimensions_used: number`：实际入 prompt 的维度数（满分 7）
- **新增** `mode: "multi-signal-30d"` 替代旧的 `"direct-30d"`

#### Scenario: 全部 7 维度数据齐备时
- **WHEN** 调用 `predictNextTradingDay("000001.SH")` 且 margin / breadth / sector / lhb / news 全部有当日数据
- **THEN** `dimensions_used=7`，rationale 中至少出现 4 个不同维度的具体数字（包含至少 1 个量能数字、1 个资金面数字、1 个新闻事件标题、1 个行业板块名）

#### Scenario: 部分维度数据缺失时不阻塞
- **WHEN** margin 接口当日失败、news webSearch 返回空、其余维度齐备
- **THEN** prompt 中 margin / news 标注"<数据缺失>"；`dimensions_used=5`；预测仍正常完成；rationale 不引用缺失维度的虚假数字；置信度 SHOULD 比满数据情况低 5-10%

#### Scenario: 多维度信号冲突时降低置信度
- **WHEN** 价格连续 3 日上涨 + 量能放大，但融资净流出 + 当日新闻偏负面（地缘风险）
- **THEN** direction 仍可输出 `up` 或 `down`，但 confidence MUST 在 [0.55, 0.65]，rationale 中 MUST 出现"维度冲突"或"分歧"等表述

### Requirement: 当日数据预拉与缓存
系统 SHALL 在 `runOnce()` 入口处按顺序调用 `ingestLatestMargin → ingestMarketBreadth → ingestSectorRotation → ingestLhb → classifyTodayNews`，确保 `predictNextTradingDay` 调用时 6 个新维度已就位。

**关键约束**：上述 5 个 ingest 任一失败时 SHALL 仅记录错误日志，不阻塞后续步骤；`predictNextTradingDay` 在该维度数据缺失时按上一条 scenario 行为降级。

#### Scenario: 板块接口当天挂掉
- **WHEN** `ingestSectorRotation` 抛出异常
- **THEN** runOnce 继续执行 lhb / news / predict，预测中 sector 维度被标注缺失但流程不中断
