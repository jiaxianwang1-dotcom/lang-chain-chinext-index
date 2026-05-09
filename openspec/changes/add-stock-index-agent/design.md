## Context

当前仓库是一个 LangGraph + LangChain.js 的实验性智能体项目（参考 `src/agent/graph.ts`、`src/agent/tools.ts`），已经具备：

- 智谱 GLM-4-Flash 作为 LLM；
- `webSearch` / `webFetch` 工具；
- `better-sqlite3` 实现的 `memories` 表 + `saveMemory / searchMemory` 工具；
- 上下文压缩、`MemorySaver` checkpoint。

需求方希望在不破坏既有通用 agent 的前提下，新增一个**面向 A 股指数（上证指数 / 创业板指）的预测短信智能体**：

- 数据采集：近 1 年回填 + 每日 14:00 增量；
- 归因分析：每日涨跌原因（基于宏观/热点联网搜索）；
- 趋势预测：首次全量分析→长期记忆，后续仅在记忆 + 当日新数据上增量；
- 通知：短信至 `15136489941`。

约束：

- 个人项目，部署在用户本地 macOS 笔记本；
- 免费数据源优先；
- LLM 配额有限（智谱 GLM-4-Flash），需要节流；
- 预测结果"仅供参考"，非合规投资建议。

## Goals / Non-Goals

**Goals:**

- 在 `src/agent/stock/` 下交付一个端到端、可独立运行的指数预测智能体；
- 数据库 schema 满足"指数名称、数值、日期、相对上一交易日涨跌、原因"的需求；
- 支持首次回填 1 年 + 每日 14:00 自动采集；
- 实现"首次全量分析→长期记忆→增量预测"机制，避免每天重新喂全量历史；
- 通过短信下发买涨/买跌结论；
- 与已有通用 agent 解耦，复用现有依赖与配置风格。

**Non-Goals:**

- 不做行情可视化 / Web UI；
- 不接入实时分钟线 / Tick 数据；
- 不实现自动下单或与券商对接；
- 不保证预测准确率；
- 不构建跨进程任务系统（K8s / Airflow），仅使用本地 `node-cron`；
- 不接入付费 Wind / Choice 等数据源（首版）。

## Decisions

### 1. 行情数据源：腾讯财经 HTTP 接口（默认实现）

**选择**：使用 `https://qt.gtimg.cn/q=sh000001,sz399006`（实时）和东方财富免费历史 K 线接口（如 `push2his.eastmoney.com/api/qt/stock/kline/get`）做日线回填。

**为什么**：

- 免费、无需 token、字段稳定；
- 腾讯实时接口非常轻量，适合 14:00 抓取；
- 东方财富的 `kline/get` 支持指定起止日期与日线 frequency。

**替代方案**：

- AKShare / Tushare：需要 Python 或注册 token，与本仓库 TS 栈不匹配；
- Yahoo Finance：A 股覆盖与时区频繁踩坑；
- 自己爬交易所页面：维护成本高。

**抽象**：通过 `QuoteProvider` 接口隔离，未来可以替换为付费源而不动业务逻辑。

### 2. 定时任务：`node-cron`（进程内）

**选择**：在 `npm run stock` 启动的常驻进程中用 `node-cron` 注册 `0 14 * * 1-5`（北京时间，依靠系统时区或在代码里显式 `Asia/Shanghai`）。

**为什么**：

- 个人本地部署，不需要外部调度器；
- `node-cron` 简单稳定、零依赖。

**替代方案**：

- macOS launchd / cron + `tsx` 一次性脚本：每次冷启动 LangGraph + SQLite 略慢；
- BullMQ / Redis：超出当前需求复杂度。

**风险**：进程被关闭就不再触发 → 文档中明确"如需高可用请自行用 PM2 / systemd 托管"。

### 3. 数据库：独立 `.memory/stock_agent.db`

**选择**：与现有 `web_agent.db` 隔离，单独建表 `index_quotes` + `index_analysis_memory`。

**为什么**：

- 业务边界清晰；
- 删除 / 重置回填数据时不影响通用 agent 的记忆；
- 复用现有 `better-sqlite3` 依赖与 WAL 模式。

### 4. 长期分析记忆采用版本化结构而非"覆盖式"

**选择**：`index_analysis_memory` 不只保留一条最新记忆，而是按 `version` 递增保存历史，最新版本通过 `MAX(version)` 查询。

**为什么**：

- 满足需求中"分析完后做成长期记忆，下次基于上一次结果再结合当天数据"的语义；
- 同时保留了演化轨迹，便于调试 LLM 漂移、做对比；
- SQLite 存储成本可忽略。

### 5. 涨跌归因：先搜索再喂 LLM，明确禁止编造

**选择**：

- `analyzeChangeReason` 内部先用 `web_search`（关键词形如 `"2026-05-09 上证指数 涨跌 原因"`）+ 至多 1 次 `web_fetch`；
- 把"行情数据 + 检索摘要"塞进 prompt，明确要求 LLM 只在有依据时下结论，否则返回保守描述；
- `reason_source` 字段保存 1–3 个 URL，便于人工核验。

**Trade-off**：归因质量强依赖搜索结果。回填阶段历史日期搜索召回较弱时，归因可能偏空泛 → 接受，并在预测层用结构化特征兜底。

### 6. LLM 节流与成本控制

- 回填阶段 ≈ 230 个交易日 × 2 指数 = 460 次归因调用，每次至少 1 次 LLM 调用 + 1 次 `web_search`：在批量循环中加 `await sleep(1500ms)`；
- 预测阶段每天 1 次 bootstrap（仅首日）+ 之后每天 2 次增量预测；
- 全部统一用 `glm-4-flash`（与现有项目一致），不引入新模型。

### 7. 短信：阿里云短信（首版唯一实现）

**选择**：使用 `@alicloud/dysmsapi20170525`，通过环境变量配置签名 / 模板。

**为什么**：

- 国内手机号送达率高；
- 用户预计后续会自助申请签名/模板；
- 接口稳定、文档完善。

**替代**：Twilio（国际，国内送达不稳定）、网关聚合厂商（成本不可控）。

**降级**：发送失败连续 3 次 → 写 `.memory/stock_agent_failed_sms.log` + 控制台告警，避免拖垮 cron。

### 8. LangGraph 形态：独立 graph 而非通用 agent 子图

**选择**：在 `src/agent/stockGraph.ts` 单独构建 `StateGraph`，节点 `agent`（LLM）+ `tools`，工具集合是本次新增的指数相关工具 + 现有 web 工具；不复用 `src/agent/graph.ts` 的通用工作流。

**为什么**：

- 通用 agent 的 system prompt 与工具集合定位不同（生活/记忆助手），混在一起会让 prompt 膨胀；
- 解耦后两个 graph 独立演进，调试更简单；
- LangSmith 追踪可分项目（`stock-index-agent`）。

## Risks / Trade-offs

- **行情源稳定性**：免费 HTTP 接口可能调整字段或被风控 → `QuoteProvider` 抽象 + 重试 + 单元测试 mock。
- **LLM 漂移导致预测口径不稳**：每次 bootstrap/predict 用相同的 system prompt 模板，并把 `direction / confidence` 用结构化 JSON 输出（zod 校验），避免自然语言解析。
- **节假日 / 半日市判定**：默认通过"当日是否能取到行情"判断；后续如有误判可加交易日历表。
- **短信成本/合规**：用户需自行通过阿里云审核签名 / 模板；模板内容一定要含"仅供参考，非投资建议"，避免合规风险。
- **数据合规与法律提示**：项目 README 与短信内容均显式声明非投资建议、不构成要约。
- **本地进程可用性**：用户笔记本休眠会导致 cron miss → README 中提示用 PM2 / 服务器托管或使用 `node-cron` 的 `runOnInit` + 启动时补跑当天任务。

## Migration Plan

不涉及既有功能的破坏性变更：

1. 新增依赖：`node-cron`、`@alicloud/dysmsapi20170525`、`@alicloud/openapi-client`、`@alicloud/tea-util`；
2. 新增 `.env` 字段（见 proposal）；用户首次运行时若缺失，进程在 init 阶段就报错；
3. `npm run stock` 单独入口；老 `npm run dev / web / memory` 等脚本保持不变；
4. 回滚：删除 `.memory/stock_agent.db` 与 `src/agent/stock/` 目录、移除 `package.json` 的新脚本与依赖即可，不影响通用 agent。

## Open Questions

- 是否需要把"今日 vs 上一交易日"的对比口径扩展到周/月级别？（首版仅日线）
- 是否需要把短信改为飞书 / 微信公众号模板消息？（首版只做短信，按需求）
- 长期分析记忆版本是否要设上限（如保留最近 30 个版本）以避免无限增长？（首版不限制，后续视情况加 GC）
