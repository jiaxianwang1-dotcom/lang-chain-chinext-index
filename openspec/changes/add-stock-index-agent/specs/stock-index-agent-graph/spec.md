## ADDED Requirements

### Requirement: 独立的 LangGraph 工作流
系统 SHALL 在 `src/agent/stockGraph.ts`（或等价位置）构建一个独立的 LangGraph 工作流 `stockIndexAgent`，不修改现有通用 `graph.ts`。该工作流 MUST 复用 `ChatOpenAI` (智谱 GLM) 配置，并通过 `bindTools` 注入以下工具：`fetchIndexQuote`、`upsertQuote`、`analyzeChangeReason`、`bootstrapPredictionMemory`、`predictNextTradingDay`、`sendPredictionSms`、以及现有 `webSearch` / `webFetch`。

#### Scenario: 子图与通用 agent 隔离
- **WHEN** 同一进程内同时存在通用 agent 与 stock agent
- **THEN** 二者拥有独立的 `StateGraph` / `MemorySaver`，互不污染状态

### Requirement: 一键启动入口
系统 SHALL 在 `package.json` 增加 `npm run stock` 脚本，启动后完成以下事项：

1. 初始化 SQLite 表；
2. 若数据库为空，触发首次回填 + 批量归因 + bootstrap 长期记忆；
3. 注册 `node-cron` 定时任务（北京时间每个交易日 14:00 触发采集 → 归因 → 预测 → 短信）；
4. 暴露一个进程级别的 `runOnce()` 函数（也可通过 CLI 参数 `--once` 立即执行一次完整流程，供调试 / 手动触发）。

#### Scenario: 首次启动完成全链路初始化
- **WHEN** 用户执行 `npm run stock` 且数据库为空
- **THEN** 系统先完成回填 + 归因 + bootstrap，再注册 cron 任务并保持进程常驻；首次启动期间不立即发送短信，除非加 `--once`

#### Scenario: 手动触发一次完整流程
- **WHEN** 用户执行 `npm run stock -- --once`
- **THEN** 系统按"采集 → 归因 → 预测 → 发送短信"顺序执行一次后退出，进程返回码为 0（成功）或非 0（失败）

### Requirement: 端到端可观测性
工作流 MUST 在每个关键节点输出结构化日志（JSON 一行一条）：阶段名、指数代码、耗时毫秒、是否成功、错误信息（如有）；当 `LANGCHAIN_TRACING_V2=true` 时，所有 LLM 调用 MUST 自动上报到 LangSmith（项目名沿用现有 `LANGCHAIN_PROJECT` 或新增 `stock-index-agent`）。

#### Scenario: cron 触发一次完整流程并落盘日志
- **WHEN** cron 触发完成
- **THEN** 控制台至少包含 `ingest`、`analyze`、`predict`、`notify` 四个阶段的成功日志
