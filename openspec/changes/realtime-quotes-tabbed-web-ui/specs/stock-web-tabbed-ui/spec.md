## ADDED Requirements

### Requirement: Tab 化主页

`public/index.html` SHALL 在页面顶部渲染两个互斥 Tab：「智能咨询」与「大盘指数」。任一时刻只显示一个 Tab 的内容；用户点击 Tab 头时切换内容并把当前选中项写入 `localStorage.activeTab` 以便刷新后保留。

#### Scenario: 首次访问

- **WHEN** 用户首次打开页面
- **THEN** 默认激活「智能咨询」Tab，「大盘指数」Tab 隐藏

#### Scenario: 切换并刷新

- **WHEN** 用户点击「大盘指数」后刷新页面
- **THEN** 页面再次加载时直接激活「大盘指数」Tab

### Requirement: 通用时间范围选择器组件

两个 Tab SHALL 各自渲染一个独立的时间范围选择器，提供 7 个选项：`近3天 / 近10天 / 近一月 / 近2月 / 近3月 / 近一年 / 自定义`。选择「自定义」时展开两个 `<input type="date">`。两 Tab 的选择互不影响。

#### Scenario: 默认选项

- **WHEN** Tab 首次显示
- **THEN** 选择器默认选中「近一月」（对应 API `range="1m"`），且对应窗口的数据立即加载

#### Scenario: 自定义日期校验

- **WHEN** 用户在「自定义」中选择 `from > to`
- **THEN** 前端禁用查询按钮并提示「起始日期必须早于结束日期」，不发起请求

### Requirement: 智能咨询 Tab 调用新端点

「智能咨询」Tab SHALL 把用户消息与当前选择的时间范围一起 POST 到 `/api/stock/chat`，并按 SSE 流式渲染回复。`range` / `from` / `to` 与时间范围选择器联动。

#### Scenario: 默认窗口对话

- **WHEN** 用户在选择器为「近一月」时输入「上证最近表现」并发送
- **THEN** 前端 POST `{ "message": "上证最近表现", "range": "1m" }`，并把 SSE 流增量写入对话气泡

#### Scenario: 切换窗口后再次提问

- **WHEN** 用户先切到「近一年」再问「半年来创业板涨跌幅」
- **THEN** 前端 POST `{ "message": "...", "range": "1y" }`

### Requirement: 大盘指数 Tab 双指数展示

「大盘指数」Tab SHALL 同时展示「上证指数（000001.SH）」与「创业板指（399006.SZ）」两张子卡片，每张卡片包含：当前最新点位 + 涨跌、所选窗口的折线图、所选窗口的明细表（共 9 列，依次对应 `trade_date / open_value / high_value / low_value / close_value / change / change_pct / volume / turnover`，表头使用中文展示文案：日期 / 开盘 / 最高 / 最低 / 收盘 / 涨跌 / 涨跌幅 / 成交量 / 成交额，并通过 `<th title="...">` 把原英文字段名保留为悬浮提示）。卡片数据通过 `GET /api/stock/quotes` 获取。

#### Scenario: 默认 30 天加载

- **WHEN** 用户首次打开「大盘指数」Tab
- **THEN** 前端并行调用 `/api/stock/quotes?indexCode=000001.SH&range=1m` 与 `/api/stock/quotes?indexCode=399006.SZ&range=1m`，渲染两张卡片；每张卡含完整 9 列明细表 + 折线图

#### Scenario: 切换窗口

- **WHEN** 用户把范围改为「近一年」
- **THEN** 前端重新拉取两个指数的窗口数据并替换卡片内容；折线图横轴自适应

#### Scenario: 数据加载失败

- **WHEN** 后端返回 502
- **THEN** 卡片显示「行情拉取失败，请稍后重试」并提供「重试」按钮，重试调用同一接口

### Requirement: 当日 5 分钟自动刷新

当且仅当所选窗口包含「今日」、且 `GET /api/stock/trading-day` 返回 `isTradingDay=true`、且当前页面 Tab = 「大盘指数」时，前端 SHALL 每 5 分钟调用一次 `GET /api/stock/quotes/today?indexCode=...` 并用返回的 `row` 替换卡片中今日那一行（包括最新点位与表格首行 / 末行），不重绘整张卡片。

#### Scenario: 交易日盘中刷新

- **WHEN** 用户在交易日 10:00 打开「大盘指数」Tab 并保持
- **THEN** 前端启动 5 分钟轮询；每次轮询命中后只更新「今日」那一行，且不闪屏、不重置滚动位置

#### Scenario: 非交易日不轮询

- **WHEN** 用户在周六打开 Tab
- **THEN** `/api/stock/trading-day` 返回 `false`，前端 SHALL NOT 启动轮询

#### Scenario: 切到其他 Tab 暂停

- **WHEN** 用户在轮询期间切换到「智能咨询」Tab
- **THEN** 前端调用 `clearInterval` 暂停轮询；切回「大盘指数」时立即触发一次拉取并重新启动 5 分钟节奏

#### Scenario: 标签页隐藏暂停

- **WHEN** 浏览器 `document.visibilityState === "hidden"`
- **THEN** 暂停轮询；`visibilitychange === "visible"` 时立即触发一次拉取并重启节奏

### Requirement: 字段口径与原 DB 一致

前端 JSON key、`<th title>` 提示文本 SHALL 与 `index_quotes` 表字段保持一致（`trade_date`、`open_value`、`high_value`、`low_value`、`close_value`、`change`、`change_pct`、`volume`、`turnover`），不引入 `open` / `high` 等省略写法，避免上下游字段漂移。表头展示文案可使用中文便于阅读，但中文与字段必须一一对应。

#### Scenario: 表头展示文案与字段对应

- **WHEN** 前端渲染明细表表头
- **THEN** 9 个 `<th>` 的中文文本（日期 / 开盘 / 最高 / 最低 / 收盘 / 涨跌 / 涨跌幅 / 成交量 / 成交额）按位置严格对应 9 个字段（`trade_date / open_value / high_value / low_value / close_value / change / change_pct / volume / turnover`），且每个 `<th title="...">` 保留原英文字段名作为悬浮提示

#### Scenario: 数据 JSON key 与原字段一致

- **WHEN** 前端从 `/api/stock/quotes` 接收响应
- **THEN** `rows[i]` 的 key 与 `IndexQuoteRow` TypeScript 类型字段一一对应；任何字段重命名 MUST 同步更新该 spec
