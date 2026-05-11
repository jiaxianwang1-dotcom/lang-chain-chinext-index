## Why

当前 `stock-index-agent` 的智能体问答与定时分析都依赖 `.memory/stock_agent.db` 中的 `index_quotes` 表，必须先完成"采集→入库"才能消费。问题是：

- 数据有 T-N 延迟（需要等 14:00 cron 写库），无法响应"现在大盘怎么样"这种实时提问；
- 库里只覆盖两个目标指数 + 固定字段，不支持用户在网页上动态切窗口（近 3 天 / 近 1 月 / 近 1 年 / 自定义）；
- 当前网页只有"智能助手"对话框，没有任何大盘指数数据可视化界面，无法满足"看盘 + 问 AI"的双向使用场景。

本次改造把指数行情从"先入库再读库"切换为"按需实时拉取"，并升级前端为带 Tab 的 Web 应用（智能咨询 + 大盘指数），让用户可以即点即查、即问即答。

## What Changes

- **BREAKING**：`stockIndexAgent` 的问答路径不再读取 `index_quotes` 表喂给 LLM；改为通过新模块 `realtime-quote-service` 按用户指定窗口（默认近 30 天）实时拉取 OHLCV，再以**与原 DB 行结构相同的 JSON 形状**注入到 LLM 上下文，保证下游 prompt / 工具不变。
- 新增 `realtime-quote-service`：基于现有 `QuoteProvider` 抽象，暴露 `fetchQuoteWindow(indexCode, range)` 与 `fetchTodayIntraday(indexCode)`，内部按时间窗口调度 `fetchHistoricalQuotes` / `fetchDailyQuote` 并做 5 秒级 LRU 缓存（避免 5 分钟刷新打爆数据源）。
- 新增 `stock-web-api`：在现有 `web-agent.ts` 同进程的 Express 服务中，新增以下端点：
  - `POST /api/stock/chat`：替代 / 并列 `/api/chat`，接收 `{ message, range }`；服务端把 range 解析为窗口并调用 `realtime-quote-service` 注入上下文后再启动 `stockGraph`。
  - `GET /api/stock/quotes?indexCode=&range=&from=&to=`：返回窗口内每日 OHLCV + change/change_pct（字段与 `index_quotes` 一致），供大盘 Tab 表格/图表渲染。
  - `GET /api/stock/quotes/today?indexCode=`：返回当日（含分时）最新点位，用于 5 分钟刷新轮询。
  - `GET /api/stock/trading-day?date=`：判断指定日期是否为交易日，前端用来决定是否启用今日轮询。
- 新增 `stock-web-tabbed-ui`：将 `public/index.html` 扩成带 Tab 的单页应用：
  - Tab 1「智能咨询」：保留现有对话 UI，新增时间范围选择器（近 3 天 / 近 10 天 / 近一月 / 近 2 月 / 近 3 月 / 近一年 / 自定义起止日期），未涉及大盘的问题不强制带窗口，涉及大盘默认 30 天。
  - Tab 2「大盘指数」：上证指数 + 创业板指两张子卡片，含相同的时间范围选择器，默认近 30 天；表格 / 折线图按 `index_quotes` 字段口径展示；当所选窗口包含**今日**且今日为交易日时，自动每 5 分钟调一次 `/api/stock/quotes/today` 仅替换今日那一行。
- **Modified**：`stock-index-agent-graph` —— 智能体的问答入口（非 cron `runOnce`）改为消费实时数据；定时 14:00 入库流程保持不变（用于归因 / 长期记忆 / 短信通知）。
- **Modified**：现有 `web-agent.ts` 的根路由继续返回 `public/index.html`（升级后的 Tab 版），并挂载上述新 API。

## Capabilities

### New Capabilities
- `realtime-quote-service`: 复用 `QuoteProvider`，按时间窗口拉取实时 / 历史 OHLCV，输出"与 `index_quotes` 行同形状"的 JSON，并提供短 TTL 缓存以承接前端 5 分钟轮询。
- `stock-web-api`: HTTP 层；负责窗口解析、交易日判定、把实时数据喂给 `stockGraph` 与前端。
- `stock-web-tabbed-ui`: 浏览器侧 Tab 化 UI，含时间范围选择器、当日 5 分钟自动刷新、上证/创业板双卡片展示。

### Modified Capabilities
<!-- openspec/specs/ 当前为空（既往 change 尚未 archive），故无需 Modified Capabilities 条目。
     stock-index-agent-graph 的问答路径行为变更通过新 capability `realtime-quote-service` + `stock-web-api`
     间接体现，cron `runOnce` 写库行为保持不变。 -->

## Impact

- 代码：
  - 新增 `src/agent/stock/realtime/index.ts`（`fetchQuoteWindow` / `fetchTodayIntraday` / `parseRange` / 缓存层）。
  - 改造 `web-agent.ts`：注册 `/api/stock/*` 路由；问答入口在调用 `stockGraph.invoke` 前用 `realtime-quote-service` 构造 system 注入消息（替代 DB 读），且仅在判定为"涉及大盘"的提问时注入。
  - 改造 `src/agent/stock/graph/index.ts`：新增 `runChatTurn(message, contextQuotes)` 类型的纯函数入口（不读 DB），保留现有 `stockGraph` / `runOnce` 不变。
  - 重写 `public/index.html` 为 Tab 化结构（或拆分为 `public/index.html` + `public/stock.html` + 共用 JS），引入轻量图表（建议直接使用 `<canvas>` + 简易折线，避免新增大依赖）。
- 数据：
  - 不新增表；现有 `index_quotes` / `index_analysis_memory` 仅保留给 cron 流程使用。
- 依赖：
  - 不引入新的服务端依赖；前端如需图表可考虑 CDN 引入 `chart.js`（4.x），或保持原生 canvas。任选其一在 design.md 中定稿。
- 配置：
  - 无新增 `.env` 字段；已有 `ZHIPU_API_KEY` / `SMS_*` 不受影响。
- 风险：
  - 实时数据源（腾讯 / 东方财富）QPS 与稳定性：通过 5s LRU 缓存 + 现有指数退避重试缓解；前端轮询固定 5 分钟，最大并发 = 指数数 × 客户端数。
  - 智能体上下文体积：30 个交易日 × 2 指数 × ~10 字段 ≈ 600 行 JSON，对 GLM-4-Flash 仍在可控 token 预算内；自定义最长 1 年窗口需在服务端按"日 → 周聚合"降采样后再喂 LLM（在 design.md 细化阈值）。
  - 行为变更（不再读 DB）会让"长期记忆"和"实时上下文"出现口径差异：本期约定"问答=实时"，"短信预测=长期记忆+cron"，互不污染。
