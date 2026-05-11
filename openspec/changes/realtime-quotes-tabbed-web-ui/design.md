## Context

现有 `stock-index-agent` 走"采集 → SQLite → 读库 → 喂 LLM / 短信"的离线模式：

- `src/agent/stock/providers/{ingestion,index,...}.ts` 通过 `QuoteProvider` 抽象（默认腾讯实时 + 东方财富历史）拉数据，写入 `index_quotes`；
- `src/agent/stock/db/index.ts` 提供 `getQuote` / `getLatestQuote` / `getQuotesInRange`；
- `web-agent.ts` 是同一个 Express 进程里的"通用助手"前端，目前只读 `web_agent.db` 的 `memories` 表，没有任何指数面板；
- `stockGraph` 接收消息后内部既能调工具，也能直接调 `predictAllTargets`，预测路径会读 `index_quotes` 与 `index_analysis_memory`。

需求文档 `docs/requirement/11.md` 要求：

1. 智能体问答路径**实时拉数据**，不再依赖入库时延；
2. 网页加 Tab：智能咨询 + 大盘指数；
3. 两个 Tab 都要有时间范围选择器（3 天 / 10 天 / 1 月 / 2 月 / 3 月 / 1 年 / 自定义），默认 30 天；
4. 大盘 Tab 在交易日内对"今日"那行每 5 分钟刷新一次。

约束：复用 `QuoteProvider`、不引入重型前端框架、不破坏现有 cron / 短信链路。

## Goals / Non-Goals

**Goals:**

- 智能体问答（无论用户问"近 3 天"还是"近 1 年"或没指定）都拿到实时数据，且数据形状与原 DB 行兼容，最大化复用现有 prompt / tools。
- 给前端提供一组干净的 HTTP API，足以支撑 Tab 化 UI 与 5 分钟轮询。
- 前端在不新增构建流程（Vite/webpack）前提下完成 Tab 化升级（继续走 Express 静态 `public/`）。

**Non-Goals:**

- 不改造 cron `runOnce` 入库链路与短信通知（继续依赖 SQLite + 长期记忆，避免风险扩散）。
- 不重写 `prediction/` 模块；预测仍只在定时任务里跑。
- 不引入用户登录 / 多租户 / WebSocket 推送（5 分钟轮询足够）。
- 不在本期添加除上证 / 创业板以外的指数。

## Decisions

### D1：实时数据通过新模块 `realtime-quote-service` 暴露，与 DB 层物理隔离

**选择**：新建 `src/agent/stock/realtime/index.ts`，对外仅暴露纯函数：

```ts
type RangeKey = "3d" | "10d" | "1m" | "2m" | "3m" | "1y" | "custom";
interface QuoteRow { /* 与 IndexQuoteRow 同形（去掉 id/created_at/updated_at） */ }

export function parseRange(input: { range: RangeKey; from?: string; to?: string }): { start: string; end: string };
export async function fetchQuoteWindow(indexCode: string, range: RangeKey, opts?: { from?: string; to?: string }): Promise<QuoteRow[]>;
export async function fetchTodayIntraday(indexCode: string): Promise<QuoteRow | null>;
```

内部实现直接调用现有 `defaultProvider.fetchHistoricalQuotes` / `fetchDailyQuote`，**不写库**。

**Rationale**：

- DB 模块（`src/agent/stock/db/index.ts`）继续被 cron / 短信 / 预测使用，零改动 = 零回归风险；
- 智能体问答与 Web API 走新模块，关注点单一（"按窗口拉")；
- 计算 `change` / `change_pct` 仍在服务端完成，保证返回结构与 `IndexQuoteRow` 字段一致 → 前端表格 / LLM prompt 都不用改字段映射。

**Alternative considered**：在 `db/index.ts` 加一个"先查 DB，DB miss 再实时拉"的混合接口。否决，因为容易在不同来源间出现脏数据，调试成本高。

### D2：5s LRU + 5min 前端轮询，避免雪崩

**选择**：`realtime-quote-service` 内部对每个 `(indexCode, start, end)` 键缓存 5 秒；`fetchTodayIntraday` 缓存 30 秒。前端轮询固定 5 分钟。

**Rationale**：

- 单页面 2 个指数 → 一次轮询最多 2 次拉取；用户切窗口时 5s 缓存可吸收"双击"等抖动；
- 数据源（腾讯实时）本身就是分钟级延迟，30s 缓存对今日分时几乎无信息损失；
- 不引入 Redis 等外部依赖，进程内 Map 即可。

### D3：HTTP API 形态——继续基于 Express 同进程，新增 `/api/stock/*` 命名空间

**选择**：在现有 `web-agent.ts` 里新增 4 个端点（见 proposal）。`/api/chat` 保留向后兼容，新增 `/api/stock/chat`。

**Rationale**：

- 现有部署只有一个 Node 进程；拆 BFF 会让 cron 进程与 Web 进程数据源不一致，得不偿失；
- `/api/stock/chat` 与 `/api/chat` 分开，避免改动既有"通用助手"行为；
- 所有 `/api/stock/*` 用同一段中间件解析 `range` / `from` / `to`，集中校验。

**Alternative considered**：把指数 API 拆到独立 `npm run stock-web` 进程。否决，部署面复杂度上升，且没有性能必要。

### D4：智能体上下文注入——服务端做，graph 不改签名

**选择**：

1. 在 `web-agent.ts` 的 `/api/stock/chat` 处理函数里：
   - 用轻量启发式 / 关键字判定"是否涉及大盘"（例如命中 `["大盘", "上证", "创业板", "000001", "399006", "指数"]`）；
   - 命中则按 `range`（默认 30 天）拉两个指数的 `QuoteRow[]`，序列化为 system 消息附加在用户消息之前；
   - 调用 `stockGraph.invoke({ messages: [...] }, { configurable: { thread_id } })`。
2. `src/agent/stock/graph/index.ts` 暴露的 `stockGraph` 与 `runOnce` 签名保持不变；新增一个 `runChatTurn(message, contextQuotes)` 助手是可选的，只是把上一步的拼装抽出来便于单测。

**Rationale**：

- LangGraph 的 system prompt 拼装在外层做更直观、也更容易在不调 LLM 的情况下测试"窗口 → JSON"路径；
- 关键字判定保留逃生通道：用户问"今天天气"时不会浪费 token 注入大盘数据；
- 数据 JSON 用与 `IndexQuoteRow` 一样的 key（`index_code` / `trade_date` / `close_value` / `open_value` / ...），LLM 看到的"形状"与原来读 DB 完全一致 → prompt 不必修改。

### D5：自定义最长 1 年窗口的降采样

**选择**：服务端在拉到 `QuoteRow[]` 后，若 `end - start > 90 个交易日`，按"周（5 个交易日）"做 OHLC 聚合（`open=首日 open`、`close=末日 close`、`high=max`、`low=min`、`volume=sum`、`turnover=sum`、`change_pct=(end.close - start.close) / start.close * 100`）后再喂 LLM；返回给前端的依然是日线（前端图表负责降采样展示）。

**Rationale**：

- 一年 ~244 个交易日 × 2 指数 ≈ 488 行 JSON，对 GLM-4-Flash 仍在 token 预算上限附近；周聚合后约 100 行，留出空间给问句和归因。
- 前端表格 / 折线图保留日线粒度，不损失用户视觉信息。

### D6：前端不引入构建工具，Tab 化用原生方案

**选择**：

- 把 `public/index.html` 拆为：
  - `public/index.html`：只剩外壳 + Tab 切换（通过 `data-tab` + class toggle 即可）；
  - `public/chat.js` / `public/stock.js` / `public/common.js`：分别承载两个 Tab 逻辑；
  - 图表用 CDN `chart.js@4`（约 70KB gz），仅在 `stock.js` 中按需 `import` 形式不可用，所以用 `<script>` 标签；
- 5 分钟轮询用 `setInterval`；离开 Tab 时 `clearInterval`，回到 Tab / `visibilitychange === 'visible'` 时重启。

**Rationale**：

- 无构建链路 = 无 CI 改造，符合现有项目风格；
- Chart.js 是工程界事实标准，UMD 单文件即可用，省事。

**Alternative considered**：自建 `<canvas>` 折线图。可行但调试成本高、也无显著收益，否决。

### D7：交易日判定

**选择**：服务端 `/api/stock/trading-day` 通过"已有 `index_quotes` 的最近 5 条 `trade_date` + `Date.now() < 15:00`"做一个低成本判定即可：当天若已写入或正处于交易时段（9:30–11:30 或 13:00–15:00 Asia/Shanghai）即认为是交易日。前端拿这个布尔值决定是否启用 5 分钟轮询。

**Rationale**：

- 不引入交易日历依赖；
- 误差只发生在极少数节假日开盘前的几小时，最坏后果是多发了几次实时请求 → 已被 5s 缓存吸收。

## Risks / Trade-offs

- **[风险] 数据源限频**：腾讯/东方财富免费接口有未公开 QPS 限制 → **缓解**：5s LRU + 现有 `withRetry` 指数退避；前端轮询固定 5 分钟。
- **[风险] LLM 上下文 token 超限**（1 年 × 2 指数）→ **缓解**：D5 周聚合；并在 system 消息里写明"以下为周聚合数据"。
- **[权衡] 关键字启发式可能漏判** "今天 A 股怎样"→ **缓解**：关键字表覆盖常见说法，必要时用户可在前端选 Tab 2 直接看数据；后续可换为小模型分类器。
- **[权衡] 不再走 DB 后，问答与短信预测使用的数据可能口径不一致**（实时 vs 14:00 入库）→ 在 system 消息开头明确"以下为实时盘中数据，可能与 14:00 收盘后归因不一致"。
- **[风险] 前端 5 分钟轮询多 Tab 重复**：用户开多个浏览器 Tab → 服务端 5s LRU 已能合并；客户端不另做去重。
- **[迁移] 无破坏性数据库迁移**：本期不动 schema；如果未来要把"实时分时"也入库，再单独发起 change。

## Migration Plan

1. 上线 `realtime-quote-service` 与 `/api/stock/*` 端点（仅 add，不动旧路径） → 灰度可通过新 URL 直接访问。
2. 前端 `public/index.html` 升级为 Tab 版（Tab 1 仍旧调 `/api/chat` 不变）。
3. 把 Tab 1 的提交切到 `/api/stock/chat`，验证大盘问题确实喂了实时数据。
4. 监控 1–2 个交易日：观察日志中 `realtime.fetch_failed` 计数、token 用量、5 分钟轮询命中率。
5. 回滚：仅需把前端 `chat.js` 切回 `/api/chat` + 去掉 Tab 2，新模块/API 可保留不删。

## Open Questions

- 是否要在 Tab 2 增加"换股"下拉（除上证/创业板外加沪深 300 / 中证 500）？本期默认两只；扩展只需在 `listTargetIndexes()` 注册并不改 API。
- 自定义起止日期跨年是否要支持？本期约束 ≤ 1 年（与"近一年"上限一致）；超出由前端禁用。
- 是否需要在前端 5 分钟轮询时同时刷新整窗（不仅是今日行）？默认只刷今日，避免历史日线无意义抖动；如发现历史行有修订需求再扩。
