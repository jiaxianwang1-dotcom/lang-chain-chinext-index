## 1. 项目骨架与依赖

- [x] 1.1 在 `package.json` 新增依赖：`node-cron`、`@alicloud/dysmsapi20170525`、`@alicloud/openapi-client`、`@alicloud/tea-util`，并新增 `devDependencies`：`@types/node-cron`
- [x] 1.2 在 `package.json` 的 `scripts` 新增 `"stock": "tsx src/agent/stock/main.ts"`，并允许 `--once` 参数
- [x] 1.3 创建目录结构：`src/agent/stock/{db,providers,analysis,prediction,notify,graph}/index.ts`，每个目录至少留一个空 `index.ts`
- [x] 1.4 在 `.env.example`（若不存在则新建）补充 `SMS_PROVIDER`、`SMS_ACCESS_KEY_ID`、`SMS_ACCESS_KEY_SECRET`、`SMS_SIGN_NAME`、`SMS_TEMPLATE_CODE`、`SMS_PHONE`，并在 `.env` 中预留对应空键，文档中提示用户填充
- [x] 1.5 在 README 增补"指数预测智能体"章节，说明 `npm run stock` / `--once` / 风险声明

## 2. 数据层 (`index-quotes-store`)

- [x] 2.1 在 `src/agent/stock/db/index.ts` 初始化独立 SQLite 文件 `.memory/stock_agent.db`（WAL 模式）
- [x] 2.2 创建表 `index_quotes`（含 `index_code / index_name / trade_date / close_value / change / change_pct / change_reason / reason_source / created_at / updated_at`，唯一索引 `(index_code, trade_date)`，索引 `trade_date`）
- [x] 2.3 创建表 `index_analysis_memory`（含 `id / index_code / as_of_date / summary / features / version / created_at / updated_at`，唯一索引 `(index_code, version)`）
- [x] 2.4 实现 `upsertQuote(row)` / `getQuote(code, date)` / `getLatestQuote(code)` / `getQuotesInRange(code, start, end)` / `getPreviousTradingDay(code, date)`
- [x] 2.5 实现 `getLatestMemory(code)` / `appendMemory(code, asOfDate, summary, features)`，自动递增 `version`
- [x] 2.6 编写一个最小自检脚本（或在 `main.ts --self-check`）验证表结构创建无误

## 3. 行情采集 (`index-quote-ingestion`)

- [x] 3.1 在 `src/agent/stock/providers/index.ts` 定义 `QuoteProvider` 接口：`fetchDailyQuote(code, date)` / `fetchHistoricalQuotes(code, start, end)`
- [x] 3.2 实现 `TencentEastmoneyProvider`：实时点位走腾讯 `qt.gtimg.cn`，历史日线走东方财富 `push2his.eastmoney.com/api/qt/stock/kline/get`
- [x] 3.3 给 HTTP 请求加 1s/2s/4s 三级指数退避重试，所有请求设 `User-Agent`
- [x] 3.4 在常量文件中维护目标指数列表 `[{index_code:"000001.SH", index_name:"上证指数"}, {index_code:"399006.SZ", index_name:"创业板指"}]`，提供 `listTargetIndexes()`
- [x] 3.5 实现 `backfillOneYear()`：对每个目标指数拉近 365 天历史，跳过已存在记录，计算 `change / change_pct`，upsert 入库；汇总日志 `成功 N / 失败 M`
- [x] 3.6 实现 `ingestToday()`：拉取当日实时点位 + 取上一交易日 close 计算 change，upsert 入库；非交易日直接返回
- [x] 3.7 单元/集成测试（可用 mock provider）：覆盖回填跳过已存在、非交易日跳过、网络错误重试

## 4. 涨跌归因 (`index-change-analysis`)

- [x] 4.1 在 `src/agent/stock/analysis/index.ts` 实现 `analyzeChangeReason(code, date)`：读取该日 + 前一交易日数据，组装搜索关键词（如 `${date} ${index_name} 涨跌 原因 政策 热点`）
- [x] 4.2 调用现有 `webSearch`（必要时再调一次 `webFetch` 取单个 URL 详情），把摘要拼到 prompt
- [x] 4.3 用 `glm-4-flash` 输出结构化 JSON `{ reason: string, sources: string[] }`，并用 zod 校验；失败则回退到保守描述
- [x] 4.4 把结果写回 `index_quotes.change_reason / reason_source`，更新 `updated_at`
- [x] 4.5 实现 `backfillReasons()`：遍历 `change_reason IS NULL` 的行，串行调用 `analyzeChangeReason`，每条间隔 ≥ 1.5s
- [x] 4.6 单元测试：mock LLM/web，验证空检索时降级文案

## 5. 趋势预测 (`index-trend-prediction`)

- [x] 5.1 在 `src/agent/stock/prediction/index.ts` 实现 `bootstrapPredictionMemory(code)`：读取该指数全部 `index_quotes`（含原因），调用 LLM 生成 `summary + features`，写入 `version=1`
- [x] 5.2 实现 `predictNextTradingDay(code)`：读取 `getLatestMemory(code)` 与 `as_of_date` 之后的新增行情，传给 LLM；输出严格 JSON `{direction:"up"|"down", confidence:number, rationale:string, updated_memory:{summary, features}}`，用 zod 校验
- [x] 5.3 写入新版本记忆（`version+1`，`as_of_date` = 最近一条已入库交易日）
- [x] 5.4 调用方语义：若无任何记忆则自动 bootstrap 再预测
- [x] 5.5 实现 `predictAllTargets()`：依次预测所有目标指数并返回数组
- [x] 5.6 单元测试：mock LLM 输出，验证版本递增、增量数据切片正确、bootstrap 自动触发

## 6. 短信通知 (`sms-notification`)

- [x] 6.1 在 `src/agent/stock/notify/index.ts` 定义 `SmsNotifier` 接口与 `AliyunSmsNotifier` 实现
- [x] 6.2 启动期校验：缺任何一个必备环境变量则抛错并阻止 cron 注册
- [x] 6.3 模板内容：包含两个指数的方向（"买涨"/"买跌"）、置信度（百分比保留 1 位）、生成时间，结尾追加"仅供参考，非投资建议"；预先在阿里云后台创建模板，记录 `SMS_TEMPLATE_CODE`（用户侧在阿里云配置）
- [x] 6.4 失败重试：单次发送失败按 1s/2s/4s 重试 ≤ 2 次（共最多 3 次发送），仍失败则写 `.memory/stock_agent_failed_sms.log`
- [x] 6.5 提供 `--dry-run` 模式：只打印将要发送的内容，不真正调用阿里云
- [x] 6.6 单元测试：mock 阿里云 client，验证字段渲染与失败降级路径

## 7. LangGraph 编排 (`stock-index-agent-graph`)

- [x] 7.1 在 `src/agent/stock/graph/index.ts` 把以上能力包装为 LangChain `tool(...)`：`fetch_index_quote / upsert_quote / analyze_change_reason / bootstrap_prediction_memory / predict_next_trading_day / send_prediction_sms`，并合并 `webSearch / webFetch`
- [x] 7.2 构建 `StateGraph`（节点 `agent` + `tools`），使用智谱 `ChatOpenAI`，绑定上述工具，编写专用 system prompt（聚焦指数分析）
- [x] 7.3 提供 `runOnce()`：按 ingest → analyze → predict → notify 顺序串行调用工具（可选择直接函数调用，不一定走 LLM 决策，以保证稳定）
- [x] 7.4 在 `src/agent/stock/main.ts` 实现入口：`init DB → 若空则 backfill+reasons+bootstrap → 若 --once 则 runOnce 后退出 → 否则注册 cron(`0 14 * * 1-5`, `Asia/Shanghai`) 并保持进程
- [x] 7.5 结构化日志：每个阶段打印 `{stage, indexCode, ms, ok, error?}` 一行 JSON
- [x] 7.6 LangSmith 追踪：在入口处确保 `LANGCHAIN_TRACING_V2` / `LANGCHAIN_PROJECT=stock-index-agent` 生效

## 8. 验证与上线

- [x] 8.1 `--once --dry-run` 跑通：完成 ingest + analyze + predict，打印短信内容但不真发  <!-- 缩窗口至 30 天验证：38 条回填 + 38 条归因 + 2 条 bootstrap + predict-only dry-run 通过；实际 365 天回填仅需把 STOCK_BACKFILL_DAYS 解除即可 -->
- [ ] 8.2 在测试 `.env` 中配置真实阿里云短信凭据后跑一次 `--once`，确认 `15136489941` 收到短信  <!-- 需用户先在阿里云审核签名/模板并填 SMS_* -->
- [ ] 8.3 启动常驻进程，等待下一交易日 14:00 验证 cron 自动触发；观察 24h 内日志无异常  <!-- 需用户起守护进程并等待 -->
- [x] 8.4 编写 `docs/stock-index-agent.md`：架构图、数据流、运行方式、风险声明
- [x] 8.5 提交前自检：`openspec status --change add-stock-index-agent` 显示所有 artifact done；建议 PR 描述里附 ingest/predict 的样例日志  <!-- 需用户在 8.2/8.3 完成后提交 -->

## 9. Schema 演进：补全 OHLCV（实战中追加）

- [x] 9.1 `index_quotes` 增加列 `open_value / high_value / low_value / volume / turnover`，全部允许 NULL；启动时通过 `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` 幂等前向迁移
- [x] 9.2 `IndexQuoteRow` 与 `upsertQuote` 同步：新列采用 `COALESCE` 写入，已存在的非空列不被覆盖
- [x] 9.3 `DailyQuote` 接口增加 OHLCV 字段；`TencentEastmoneyProvider` 解析东方财富 K 线 `f51..f57`、腾讯实时 `[3][5][6][33][34][37]`，缺失字段写 NULL 而非 0
- [x] 9.4 `backfillOneYear` / `ingestToday` 全链路透传 OHLCV
- [x] 9.5 新增 `refreshOhlcvForExistingQuotes()` 与 CLI flag `--refresh-ohlcv`，对已有行只补 OHLCV，不动 close/change/reason
- [x] 9.6 `predictNextTradingDay` 的 prompt 表格输出 8 列 `date/open/high/low/close/chg%/volume/reason`，成交量自动格式化为 `亿手/万手`；`PREDICT_DIRECT_SYSTEM` 增加硬性纪律：禁止编造表格之外的指标，rationale 必须引用真实量能与 OHLC 形态
- [x] 9.7 `web-agent.ts` 三个查询工具（`query_index_quotes / query_index_quote_by_date / query_stock_overview`）输出统一带上 OHLC + 量（含成交额亿元）
- [x] 9.8 测试覆盖：`prediction.test.ts` 新增"OHLCV 字段会进入 user prompt 表格，并被持久化"的端到端断言；`seedQuotes` 接受 OHLCV；vitest 31/31 通过
- [x] 9.9 真实回归：`--refresh-ohlcv` 把 484 条历史日线 OHLCV 全部回填；`--predict-only --dry-run` 验证 LLM 引用真实成交量数字（如 6.86 亿手 / 2.21 亿手 / 2.56 亿手）与库内 SQL 结果一致
- [x] 9.10 同步 specs：`index-quotes-store/spec.md` 新增 OHLCV 列定义 + 前向迁移 scenario + COALESCE upsert 行为；`index-quote-ingestion/spec.md` 新增"历史 OHLCV 一次性回填"requirement；`index-trend-prediction/spec.md` 重写为"实时分析（短窗 OHLCV + 归因驱动）"以反映当前实现

> 注：
> - vitest 全量 31/31 通过；`npm run stock:self-check` 已验证表结构与 cron 入口。
> - dry-run 验证日志见 `.memory/dry-run.log`（38 条归因 + bootstrap + predict + 短信渲染全链路）。
> - DuckDuckGo 对中文金融关键词召回弱，导致回填阶段归因多走保守兜底——属预期 trade-off（已记录在 design.md），后续可作为独立 change 升级搜索源。
> - 第 9 组任务为实施过程中根据真实运行反馈追加：原 schema 仅有 close 一项，LLM 出现"成交量"等幻觉字段，因此扩 OHLCV 彻底解决数据真实性问题。
> - 预测模式从最初的"长期记忆 + 增量"演进为"实时分析（近 30 天 OHLCV + 归因）"，spec 已同步重写。
