## Why

用户希望基于已有的 LangGraph 智能体能力，构建一个面向个人投资决策的"指数行情分析智能体"：自动采集上证指数（000001.SH）和创业板指（399006.SZ）的日线数据，结合宏观背景和热点事件分析每日涨跌原因，并对下一交易日方向（买涨/买跌）做出预测，最终通过短信推送到指定手机号。

当前项目仅有通用对话/记忆/搜索工具（`src/agent/tools.ts`），缺少行情数据采集、归因分析、定时任务、长期分析记忆与短信通知能力，无法支撑该业务场景。

## What Changes

- 新增"指数行情数据"领域：在 SQLite 中建立 `index_quotes` 表，存储完整 OHLCV 日线（`index_name / open / high / low / close / volume / turnover / date / change / change_pct / change_reason`），支持按指数 + 日期检索与更新。OHLCV 五列为可空，向前迁移幂等。
- 新增**首次回填**流程：通过行情数据源拉取上证指数 + 创业板指近 1 年的日线数据（含 OHLCV）；对每个交易日调用 LLM + `web_search` 分析涨跌原因并入库。
- 新增**每日定时采集**流程：每个交易日 14:00 触发，抓取当日 SSE 与 ChiNext 行情（含开高低收 + 量额），计算相较上一交易日涨跌，调用 LLM 联网分析原因，写入 `index_quotes`。
- 新增**下一交易日预测**流程（实时分析模式）：每次预测**只**读取最近 30 个交易日的真实日线（OHLCV + 归因），不消费长期记忆作为 LLM 上下文；输出方向（买涨 / 买跌）、置信度与理由，结果写入 `index_analysis_memory.features.last_prediction` 用于事后查询。
- 新增**历史 OHLCV 一次性回填工具**（`refreshOhlcvForExistingQuotes` / `--refresh-ohlcv`）：用 COALESCE 策略只补已有行的 OHLCV 字段，不动 close/change/reason，保证 schema 演进不破坏既有归因。
- 新增**短信通知**：将每日预测结论以短信形式推送至 `15136489941`，内容覆盖上证指数与创业板指两个标的（用户只买这两只指数基金）。
- 新增 LangGraph 子图（或独立 graph）`stockIndexAgent`，通过 `tools` 节点调用上述能力；保留现有通用 agent 不变。

## Capabilities

### New Capabilities
- `index-quotes-store`: 指数行情持久化与查询（schema、CRUD、按日期 / 指数检索）。
- `index-quote-ingestion`: 行情数据采集（首次 1 年回填 + 每日 14:00 定时增量），含数据源适配与去重。
- `index-change-analysis`: 单日涨跌归因（LLM + 联网搜索宏观/热点信息）并写回 `change_reason`。
- `index-trend-prediction`: 下一交易日方向预测，含"全量首次分析 → 长期分析记忆 → 增量更新"机制。
- `sms-notification`: 通过短信网关向指定手机号发送预测结论。
- `stock-index-agent-graph`: LangGraph 智能体编排，串联采集 → 归因 → 预测 → 通知。

### Modified Capabilities
<!-- 当前 openspec/specs/ 为空，无既有 capability 需要修改。 -->

## Impact

- 代码：
  - 新增 `src/agent/stock/`（数据库、采集、归因、预测、通知模块）。
  - 新增 LangGraph 子图入口（如 `src/agent/stockGraph.ts`）并在 `langgraph.json` / `package.json` 暴露 `npm run stock`。
  - 复用 `src/agent/tools.ts` 中的 `webSearch` / `webFetch`，新增 `fetchIndexQuote` / `analyzeChange` / `predictNextDay` / `sendSms` 工具。
- 数据：
  - SQLite 文件 `.memory/stock_agent.db`（与现有 `web_agent.db` 隔离），新增表 `index_quotes`、`index_analysis_memory`。
- 依赖：
  - 新增定时任务库（`node-cron`）。
  - 新增行情数据源（推荐：腾讯财经/新浪财经免费行情接口；备选：东方财富开放接口）——通过 HTTP 即可调用，无需 SDK。
  - 新增短信网关 SDK（推荐阿里云短信 `@alicloud/dysmsapi20170525`，需用户提供 AccessKey；备选 Twilio）。
- 配置：
  - `.env` 新增：`SMS_PROVIDER` / `SMS_ACCESS_KEY_ID` / `SMS_ACCESS_KEY_SECRET` / `SMS_SIGN_NAME` / `SMS_TEMPLATE_CODE` / `SMS_PHONE`。
- 运维：
  - 需要常驻进程承载 `node-cron`（开发期 `npm run stock`，生产期可由 PM2 / systemd 托管）。
- 风险：
  - 免费行情源稳定性、字段口径差异；需要在采集层做适配与重试。
  - LLM 涨跌归因的准确性受联网搜索质量影响——本期定位"辅助参考"，不构成投资建议。
