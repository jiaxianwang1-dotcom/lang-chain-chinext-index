## 1. realtime-quote-service 模块

- [x] 1.1 在 `src/agent/stock/realtime/types.ts` 定义 `RangeKey` 类型与 `QuoteRow` 接口（字段集合与 `IndexQuoteRow` 对齐：`index_code / index_name / trade_date / open_value / high_value / low_value / close_value / volume / turnover / change / change_pct`）
- [x] 1.2 在 `src/agent/stock/realtime/range.ts` 实现 `parseRange({ range, from?, to? })`：把 `3d/10d/1m/2m/3m/1y` 映射为 `[start, end]`（`end=今日 UTC+8`），`custom` 走 `from/to` 校验（`to >= from` 且区间 ≤ 366 天）；非法输入抛 `RangeError`
- [x] 1.3 在 `src/agent/stock/realtime/cache.ts` 实现一个最小 LRU（容量 64，按 key 过期）：暴露 `getOrFetch(key, ttlMs, loader)`
- [x] 1.4 在 `src/agent/stock/realtime/index.ts` 实现 `fetchQuoteWindow(indexCode, range, opts?)`：调 `defaultProvider.fetchHistoricalQuotes(indexCode, start, end)`，按 `trade_date` 升序排序，链式计算 `change`/`change_pct`（首行为 `null`），通过 1.3 的缓存包装（TTL=5s，key=`q:${indexCode}:${start}:${end}`）
- [x] 1.5 在同文件实现 `fetchTodayIntraday(indexCode)`：调 `defaultProvider.fetchDailyQuote(indexCode, today)`，无返回则 `null`，TTL=30s，key=`t:${indexCode}:${today}`
- [x] 1.6 在同文件实现 `aggregateForLlm(rows)`：当 `rows.length > 90` 时按 5 个交易日窗口聚合 OHLCV/turnover/change_pct；否则直接返回原数组
- [x] 1.7 在 `src/agent/stock/__tests__/realtime.test.ts` 写单测：mock `QuoteProvider`，覆盖 (a) 默认窗口拉取 + 字段对齐 (b) 自定义日期非法输入抛错 (c) 缓存 5 秒命中 (d) 链式 change_pct 计算 (e) 90+ 行触发周聚合且行数符合预期 (f) 非交易日 `fetchTodayIntraday` 返回 `null`

## 2. stock-web-api 端点

- [x] 2.1 在 `web-agent.ts` 顶部新增 `import` 引入 `realtime-quote-service`、`listTargetIndexes`、`findIndexMeta`
- [x] 2.2 抽出 `parseStockRangeQuery(req)` 中间件:从 `req.query` / `req.body` 读取 `range` / `from` / `to`，调用 `parseRange`，失败时 `res.status(400).json({ error })` 并返回 `null`
- [x] 2.3 实现 `GET /api/stock/quotes`：参数校验 → `findIndexMeta(indexCode)`（不存在返 400）→ `fetchQuoteWindow` → 返回 `{ indexCode, indexName, range, from, to, rows }`；`fetchQuoteWindow` 抛错时返 502 + 写 `realtime.fetch_failed` 日志
- [x] 2.4 实现 `GET /api/stock/quotes/today?indexCode=`：调 `fetchTodayIntraday`，返回 `{ indexCode, indexName, row, fetchedAt: new Date().toISOString() }`
- [x] 2.5 实现 `GET /api/stock/trading-day?date=`：参数缺省视为今日（Asia/Shanghai）；判定逻辑 = "DB 已存在该日 row" OR "现在处于 09:30–11:30 / 13:00–15:00 且 dayOfWeek in [1..5]"；返 `{ date, isTradingDay }`
- [x] 2.6 实现 `POST /api/stock/chat`：校验 `message` 非空 → 通过中间件解析 `range`（默认 `1m`） → 关键字判定（命中表 `["大盘","上证","创业板","000001","399006","指数","A股","盘面"]`） → 命中则并行 `fetchQuoteWindow` 两个目标指数，超过 90 行用 `aggregateForLlm` 降采样，序列化为 system 消息附在用户消息前 → 调 `stockGraph.invoke` 并把 token 增量以 SSE `data: {"content": "..."}` 推送，结束推送 `{"done": true}`
- [x] 2.7 在 `web-agent.ts` 的 `app.use(express.json())` 之后注册 4 个路由；保留 `/api/chat` 与 `/api/memories` 不变
- [x] 2.8 写最小 e2e 测试 `src/agent/stock/__tests__/web-stock-api.test.ts`：用 `supertest`（如未引入则在 devDeps 加）覆盖 (a) `/api/stock/quotes` 默认 200 + 字段名 (b) 非法 `range` 返 400 (c) 非法 `indexCode` 返 400 (d) `/api/stock/trading-day` 周末为 false（mock `Date`）

## 3. stock-index-agent-graph 接入

- [x] 3.1 在 `src/agent/stock/graph/index.ts` 新增导出 `buildContextSystemMessage(quotes: { indexCode: string, rows: QuoteRow[] }[]): SystemMessage`：把每个指数的窗口数据拼成 JSON 字符串，并在头部说明"以下为实时盘中数据，时间窗口=XX，可能与收盘后归因不一致"
- [x] 3.2 验证 `stockGraph.invoke({ messages: [SystemMessage, HumanMessage] })` 在不调用任何 DB 的前提下能正常工作（已经如此，仅做集成确认 + 写注释）
- [x] 3.3 在 `src/agent/stock/__tests__/graph.context.test.ts` 写单测：`buildContextSystemMessage` 输出包含全部字段名、行数 = 输入行数；空数组时仅含说明语

## 4. 前端 Tab 化（无构建工具）

- [x] 4.1 把 `public/index.html` 的现有内联脚本与样式拆出：新建 `public/common.css`、`public/common.js`（escapeHtml / SSE helper / range selector 组件工厂）
- [x] 4.2 改造 `public/index.html`：顶部加 `<nav class="tabs">` 含两个按钮（`data-tab="chat"` / `data-tab="stock"`），`<main>` 内放两个 `<section data-panel>`，默认显示 chat；切换时 toggle `.active` 并写 `localStorage.activeTab`
- [x] 4.3 新建 `public/chat.js`：保留原对话 UI，新增范围选择器（默认 `1m`），`sendMessage` 改为 POST `/api/stock/chat` 并带 `range`/`from`/`to`；SSE 解析逻辑从原 `index.html` 迁移
- [x] 4.4 新建 `public/stock.js`：渲染两张子卡片骨架（上证/创业板）；范围选择器默认 `1m`；切换或首次激活 Tab 时并行 `GET /api/stock/quotes` 两次，渲染明细表（9 列：`trade_date / open_value / high_value / low_value / close_value / change / change_pct / volume / turnover`）+ 折线图
- [x] 4.5 在 `public/index.html` 用 `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js">` 引入 Chart.js；`stock.js` 用 `new Chart(ctx, { type: "line", ... })` 画收盘价折线
- [x] 4.6 在 `stock.js` 实现 5 分钟轮询：激活 Tab 时调 `GET /api/stock/trading-day`，若 `isTradingDay && 当前窗口包含今日`，则 `setInterval(refreshToday, 5*60*1000)`；`refreshToday` 调 `/api/stock/quotes/today`，对每个指数定位明细表中 `trade_date === row.trade_date` 的那一行做就地替换 + 更新折线最后一个点 + 更新卡片头部最新点位
- [x] 4.7 在 `stock.js` 监听 `visibilitychange` 与 Tab 切换，`hidden`/切走时 `clearInterval`，`visible`/切回时立刻 `refreshToday()` 并重启
- [x] 4.8 自定义日期：选 `custom` 时显示两个 `<input type="date">`，`from > to` 时禁用查询按钮并显示提示

## 5. 接线与回归

- [x] 5.1 在 `web-agent.ts` 顶部确认 `app.use(express.static(join(__dirname, "public")))` 仍生效；本地 `npm run web` 后访问 `/` 能看到 Tab 化页面
- [x] 5.2 在 README.md 增补"Web UI（Tab 化版）"段落：截图占位 + Tab 说明 + API 列表 + 5 分钟刷新机制
- [ ] 5.3 手动验证 7 个时间范围在两个 Tab 都能切换：(a) 智能咨询提问"上证最近表现"，确认 server 日志显示注入了对应窗口；(b) 大盘 Tab 切换时表格 + 折线图正确刷新（**需用户在浏览器中执行**）
- [ ] 5.4 手动验证 5 分钟刷新：mock 系统时间到交易日盘中，确认每 5 分钟仅"今日"那一行被替换且不闪屏（**需用户在浏览器中执行**）
- [x] 5.5 跑 `npm test` 确认新单测 + 既有用例全绿（不影响 cron / 短信链路用例）— 7 文件 / 59 用例全绿
- [x] 5.6 用 `openspec validate realtime-quotes-tabbed-web-ui` 确认 change 通过 spec 校验
