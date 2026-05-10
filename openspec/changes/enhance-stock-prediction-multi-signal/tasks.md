# 实施任务清单

## Phase 0: 准备
- [x] 0.1 接口可用性验证（北向已死，其余 OK/需妥协）
- [x] 0.2 OpenSpec change 骨架（proposal / design / 6 个 spec / tasks）

## Phase 1: 数据库 schema
- [x] 1.1 `db/index.ts` 新增 5 张表 CREATE 语句：margin_balance / market_breadth / sector_quote / lhb_record / news_event
- [x] 1.2 与现有 OHLCV 一样使用 `CREATE TABLE IF NOT EXISTS` + 幂等迁移

## Phase 2: 4 个数据 provider
- [x] 2.1 `providers/margin.ts`：`fetchMarginPage()` + `backfillMarginHistory()` + `ingestLatestMargin()`（实测 5/7 数据 +296 亿净买入）
- [x] 2.2 `providers/breadth.ts`：`fetchUlist()` + `fetchZTPool(date)` + `fetchDTPool(date)` + `ingestMarketBreadth()`（实测 5/8 涨家 1441 / 跌家 842 / 涨停 48）
- [x] 2.3 `providers/sector.ts`：`fetchAllSectors()` + `ingestSectorRotation()`（实测 5/8 印染/房产/机器人 Top5）
- [x] 2.4 `providers/lhb.ts`：`fetchLhbPage()` + `ingestLhb()` + `getLhbForIndex()` + `isIndexConstituent()`（实测 5/8 上证 53 只 +61.72 亿）
- [x] 2.5 全部 fail-safe：失败返回空/null，不抛异常
- [x] 2.6 现有 vitest 全过（33/33）

## Phase 3: 新闻事件
- [x] 3.1 `news/index.ts`：`classifyTodayNews(asOfDate)` 走 webSearch + glm-4-flash 分类
- [x] 3.2 LLM prompt：明确 10 类标签 + 输出 schema（11 类含 other 兜底）
- [x] 3.3 去重：按 (as_of_date, title) 跳过已分类
- [x] 3.4 webSearch 失败兜底（写一条 placeholder）
- [x] 3.5 实测：mock webSearch（央行降准 / 长存 NAND / 美国实体清单）→ LLM 分类全部正确

## Phase 4: 异动信号 + 查询函数
- [x] 4.1 `signals/index.ts`：`computeAnomalySignals(indexCode)` 计算量比/价量背离/lhb_active
- [x] 4.2 在 `db/index.ts` 添加 `getLatestMargin / getMarginInRange / getLatestBreadth / getBreadthInRange / getLatestSectorRotation / getLhbByDate / insertNewsEventIfAbsent / getNewsByDate`
- [x] 4.3 实测 5/8：上证量比 1.16、龙虎榜 53 只成分股 +61.72 亿，与板块涨幅榜（通信 +3.29%）+ 龙虎榜（中天科技/烽火通信通信主题）自洽

## Phase 5: 预测引擎重写
- [x] 5.1 `prediction/index.ts`：重写 `predictNextTradingDay`，按"近 30 日 OHLCV + 60/90 日摘要 + 资金面 + 广度 + 板块 + lhb + news + signals"分层组装 prompt
- [x] 5.2 新增 `PREDICT_MULTI_SIGNAL_SYSTEM`：维度定义 + 5 条硬性纪律（覆盖 4+ 维度、冲突降置信度等）；旧 `PREDICT_DIRECT_SYSTEM` 保留作 legacy 兜底
- [x] 5.3 输出 schema 扩展：`signals` 7 字段 + `dimensions_used` + `mode='multi-signal-30d'`
- [x] 5.4 持久化：features.last_prediction 写入完整新结构
- [x] 5.5 单元测试新增 2 个 multi-signal 用例 + 旧 7 个 legacy 用例（multiSignal:false）全部通过

## Phase 6: 集成 + Web 工具 + Cron
- [x] 6.1 `graph/index.ts`：runOnce 流水线扩展为 ingest_quote → analyze → ingest_margin → ingest_breadth → ingest_sector → ingest_lhb → classify_news → predict → notify；通过 `safeStep` 包装每步 fail-safe
- [x] 6.2 `web-agent.ts`：新增 5 个查询工具（query_margin_balance / query_market_breadth / query_sector_rotation / query_lhb_today / query_today_events）+ system prompt 升级（多信号引导 + 北向资金已废弃说明）
- [x] 6.3 `main.ts`：新增 CLI flag `--backfill-fundflow`（仅回填两融，1 年）
- [x] 6.4 vitest 全量通过 33/33

## Phase 7: 端到端验证
- [x] 7.1 跑一次真实 LLM 多信号预测：5/8 上证 -0.00% 平盘，但 6/7 维度齐备时 LLM 输出 `direction=up confidence=0.75`，rationale 同时引用价格/量能/融资/广度/龙虎榜 5 个维度的具体数字（含中天科技 +20 亿 / 烽火通信 +12.8 亿股票名）
- [x] 7.2 端到端 prompt 长度约 3.5K tokens，glm-4-flash 调用 ~14s（vs 旧版 ~4s），仍可接受
- [x] 7.3 OpenSpec strict 校验通过

## 不做（明确）
- ❌ 北向资金 → 港交所 2024-08 后已无每日数据
- ❌ 真"内幕消息" → 技术不可行
- ❌ 常驻新闻爬虫 → 反爬维护成本太高
- ❌ 龙虎榜机构席位标签 → 报表名待东方财富后续探明，本期先用"是否上榜"二值信号

## 上线前剩余 ops 项
- [x] 8.1 浏览器手动验证 web-agent 5 个新工具响应（重启 web-agent 后访问）
- [ ] 8.2 等下一交易日（5/9 周六、5/12 周一）观察 cron 14:00 自动跑全流水线
- [x] 8.3 PR 描述附上 Phase 7.1 的真实样例 prompt + 输出

## 不做（明确）
- ❌ 北向资金 → 港交所 2024-08 后已无每日数据
- ❌ 真"内幕消息" → 技术不可行
- ❌ 常驻新闻爬虫 → 反爬维护成本太高
- ❌ 龙虎榜机构席位标签 → 报表名待东方财富后续探明，本期先用"是否上榜"二值信号
