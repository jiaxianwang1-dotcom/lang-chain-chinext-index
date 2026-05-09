# 指数预测智能体（stock-index-agent）

基于 LangGraph + 智谱 GLM-4-Flash 的 A 股大盘指数预测智能体。每个交易日下午 14:00 自动采集上证指数（`000001.SH`）和创业板指（`399006.SZ`）的最新行情，结合宏观/热点信息分析涨跌原因，再基于"长期分析记忆"预测下一个交易日方向，最后通过阿里云短信推送结论。

## 1. 架构

```
┌────────────────────────┐
│  npm run stock         │   常驻进程
│  (src/agent/stock/main)│   ├─ DB 初始化（.memory/stock_agent.db）
└──────────┬─────────────┘   ├─ 若库为空：回填 1 年 + 归因 + bootstrap 长期记忆
           │                  └─ 注册 cron `0 14 * * 1-5` (Asia/Shanghai)
           ▼
   每个交易日 14:00
           ▼
┌─────────────────────────────────────────────────────────────┐
│ runOnce()  (src/agent/stock/graph/index.ts)                │
│  ① ingestToday        ─→  index_quotes (upsert)             │
│  ② analyzeChangeReason ─→ index_quotes.change_reason       │
│  ③ predictAllTargets  ─→  index_analysis_memory (新版本)    │
│  ④ sendPredictionSms  ─→  阿里云短信 → SMS_PHONE            │
└─────────────────────────────────────────────────────────────┘
```

模块划分（`src/agent/stock/`）：

| 目录 | 职责 |
| --- | --- |
| `db/` | SQLite schema + CRUD（`index_quotes`、`index_analysis_memory`） |
| `providers/` | `QuoteProvider` 抽象 + 腾讯/东方财富默认实现 + 重试；`ingestion.ts` 负责 `backfillOneYear` / `ingestToday` |
| `analysis/` | `analyzeChangeReason`、`backfillReasons`：调用 LLM + 联网搜索写回涨跌原因 |
| `prediction/` | `bootstrapPredictionMemory`、`predictNextTradingDay`、`predictAllTargets`：基于长期记忆做增量预测 |
| `notify/` | `SmsNotifier`、`AliyunSmsNotifier`、`DryRunSmsNotifier`：发送短信、失败回退 |
| `graph/` | LangGraph `StateGraph`，把上述能力包装为 `tool(...)` 供 LLM 决策；同时暴露 `runOnce()` 直函数版本（更稳） |
| `utils/log.ts` | 结构化日志 + `timed` 包装 |

## 2. 数据模型

### `index_quotes`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK |  |
| `index_code` | TEXT | 如 `000001.SH` |
| `index_name` | TEXT | 如 `上证指数` |
| `trade_date` | TEXT | `YYYY-MM-DD` |
| `close_value` | REAL | 收盘点位 |
| `change` | REAL | 较上一交易日点数变化（首条为 NULL） |
| `change_pct` | REAL | 百分比 |
| `change_reason` | TEXT | LLM 归因结果 |
| `reason_source` | TEXT | 引用 URL，多个用 `,` 分隔 |
| `created_at / updated_at` | TEXT | ISO |

唯一约束 `(index_code, trade_date)`，索引 `trade_date`。

### `index_analysis_memory`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK |  |
| `index_code` | TEXT |  |
| `as_of_date` | TEXT | 该版本记忆所基于的最近交易日 |
| `summary` | TEXT | LLM 输出的中文总结 |
| `features` | TEXT | JSON，结构化特征（趋势 / 波动 / 关键因子等） |
| `version` | INTEGER | 自增（`(index_code, version)` 唯一） |
| `created_at / updated_at` | TEXT |  |

## 3. 运行方式

### 一次性

```bash
npm run stock:dry-run     # 跑全流程，但短信只打印不发送
npm run stock:once        # 跑全流程，真正发送短信（需 SMS_* 配置齐全）
npm run stock:self-check  # 仅校验 DB 表结构
```

### 常驻 + cron

```bash
npm run stock
# 触发表达式：0 14 * * 1-5（Asia/Shanghai）
# 控制台会一直输出结构化 JSON 日志
```

建议生产用 PM2 / systemd 托管，避免笔记本休眠 miss cron。

## 4. 配置

`.env` / `.env.example` 中需要填写以下字段（详见 `README.md`）：

```env
ZHIPU_API_KEY=...                # 智谱 GLM
LANGCHAIN_TRACING_V2=true        # 可选，开启 LangSmith
LANGCHAIN_PROJECT=stock-index-agent

SMS_PROVIDER=aliyun
SMS_ACCESS_KEY_ID=...
SMS_ACCESS_KEY_SECRET=...
SMS_SIGN_NAME=...
SMS_TEMPLATE_CODE=SMS_xxx
SMS_PHONE=15136489941
```

阿里云短信模板需含 `${content}`、`${time}` 两个变量，例如：

> 【签名】指数预测：${content}（${time}）。仅供参考，非投资建议。

## 5. 测试

```bash
npm test
```

覆盖：
- `__tests__/ingestion.test.ts` — backfill 跳重 / 非交易日跳过 / 5xx 重试 / 区间查询
- `__tests__/analysis.test.ts` — JSON 解析容错 / 空检索回退 / LLM 异常回退
- `__tests__/prediction.test.ts` — bootstrap → predict 自动衔接 / 增量切片 / fallback 预测
- `__tests__/notify.test.ts` — 配置校验 / 模板渲染 / 重试 / 失败落盘

## 6. 风险与免责声明

- 本智能体使用免费数据源 + LLM 启发式分析，**不构成任何投资建议**，请自行评估后决策。
- 行情接口稳定性外部依赖，已在 provider 层做指数退避重试。
- LLM 输出全部带 zod 严格校验，解析失败有保守兜底。
- 短信失败连续 3 次会落盘到 `.memory/stock_agent_failed_sms.log`，cron 周期不会因此中断。
