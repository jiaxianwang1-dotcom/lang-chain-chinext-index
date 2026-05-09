## ADDED Requirements

### Requirement: 单日涨跌归因生成
系统 SHALL 提供 `analyzeChangeReason(indexCode, tradeDate)` 能力，针对指定指数 + 交易日：

1. 读取该日 `close_value` 与上一交易日的 `close_value`，得出 `change_pct` 与方向；
2. 调用 `web_search` / `web_fetch` 检索该日的宏观事件、政策、行业热点、海外联动等信息；
3. 将"行情数据 + 检索摘要"传给 LLM，要求其用中文产出 ≤ 200 字、结构化的涨跌原因，并在末尾列出 1–3 条参考来源链接；
4. 将结果写回 `index_quotes.change_reason`、`reason_source`。

`change_reason` 必须基于检索到的当时社会背景、经济状况、热点问题，禁止凭空编造。

#### Scenario: 已有当日行情但无原因时填充原因
- **WHEN** `index_quotes` 中存在 `2026-05-09` 上证指数的 `close_value` 但 `change_reason IS NULL`
- **THEN** 调用 `analyzeChangeReason` 后该行的 `change_reason` 与 `reason_source` 被写入，且 `change_reason` 包含至少一条与当天宏观/政策/事件相关的描述

#### Scenario: 检索结果为空时降级
- **WHEN** `web_search` 对当日关键词检索为空
- **THEN** 系统在 `change_reason` 中写入"无显著公开事件，可能由资金面/技术面驱动"等保守表述，并在 `reason_source` 中明确记录"无外部来源"

### Requirement: 回填阶段批量归因
系统 SHALL 在首次回填完成后，对所有 `change_reason IS NULL` 的记录逐条调用 `analyzeChangeReason`，并对调用频率做节流（至少 1 秒一次）以避免对外部接口造成压力。

#### Scenario: 回填后批量补齐原因
- **WHEN** 回填刚完成且 LLM/搜索接口可用
- **THEN** 系统遍历缺失原因的记录并依次填充，期间任意单条失败不应阻塞其他记录的处理
