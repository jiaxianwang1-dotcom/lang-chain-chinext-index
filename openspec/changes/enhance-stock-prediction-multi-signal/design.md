## Context

`add-stock-index-agent` 已落地，但在实战中暴露出两个核心问题：

1. **数据维度过窄**：模型只看 OHLCV + 一句归因；用户期望"判读社会因素"（战争/经济/芯片突破等）和"识别异动"（疑似内幕领先）
2. **置信度难以校准**：单一维度信号要么很弱要么过强，无法把 0.5–0.92 这个梯度真正用起来

本次升级把预测从单维度扩到 7 维，每个维度独立验证、独立持久化、独立喂给 LLM，让模型在 rationale 中能交叉印证、给出更有梯度的置信度。

## Goals / Non-Goals

### Goals
- 每日预测前能拿到当日真实的：OHLCV、两融、广度、行业轮动、龙虎榜个股、当日新闻分类、异动信号
- 预测 rationale 必须引用至少 4 个不同维度的具体数字
- 全流程 fail-safe：任一外部数据源失败都不阻塞预测，仅在 rationale 中标注"该维度数据缺失"

### Non-Goals
- 不接付费数据源（Wind / Choice / 同花顺 iFinD）
- 不抓"真内幕"（技术上不可能，合规上不应该）
- 不做高频实时（cron 仍是日度，不做盘中信号）
- 不做组合优化或仓位建议——只输出"下一交易日方向 + 置信度"

## Decisions

### D1：放弃北向资金这个维度
**事实**：港交所 2024-08 起取消北向资金每日实时披露（监管层面的预期管理工具），东方财富 `kamt.kline` 接口虽然还在返回，但**所有交易日数据完全一致**——即缓存的旧值。

**结论**：宁可少做一个维度也不要假数据。在 proposal 里明确剔除，避免后人误以为是 bug。

### D2：行业轮动用"涨幅榜 Top5/Bottom5"而不是"申万一级 31 行业"
**事实**：东方财富没有干净的"申万一级"批量接口；现有 `m:90+t:2` 返回 496 个板块（混合概念/二三级行业/地域）。

**取舍**：
- 方案 A（坚持申万一级）：硬编码 28-31 个 BK 编码 + 逐个查 → 接口口径会随东方财富后台调整漂移
- 方案 B（涨幅榜 Top/Bottom）：直接对 496 个板块按 `f3`（涨幅）排序取首尾各 5 → 自然反映"今天什么主题在动"

**选 B**：实战中"今天涨幅前 5 是半导体/AI 算力/通信" 比 "今天申万传媒板块 +1.2%" 信息密度更高。

### D3：新闻不做常驻爬虫，改为预测前临时 webSearch
**事实**：财联社 v3 / 东方财富 7x24 / 新浪滚动 都有反爬/签名/废弃 lid 问题。

**方案**：每次 `predictNextTradingDay()` 调用前，先用现有 `webSearch` 工具抓"今日 A 股 财经要闻 重大政策"等 2-3 个查询，把结果（标题 + 摘要 + URL）传给一个轻量 LLM 调用做事件分类，写入 `news_event` 表（带 `as_of_date` 索引避免重复）。

**好处**：
- 没有反爬维护成本
- 失败兜底：搜不到就标注"今日无重大公开事件"
- 质量虽不稳但比硬接 7x24 后写入假数据强
- 当日已分类过的事件直接复用，不重复消耗 LLM token

### D4：事件分类标签体系（10 类 + 情感分）
| 类别 | 示例 |
|---|---|
| `policy_macro` | 央行降准/MLF/利率/财政部表态 |
| `geopolitics` | 中美/俄乌/中东/关税/制裁 |
| `industry_semi` | 半导体/芯片/EUV/制程突破 |
| `industry_ai` | AI 大模型/算力/英伟达 |
| `industry_property` | 地产政策/销售/万科 |
| `industry_energy` | 新能源/锂电/光伏 |
| `industry_finance` | 银行/券商/保险 |
| `market_event` | IPO 节奏/再融资/退市/北交所 |
| `overseas` | 美联储/美股/欧元区 |
| `accident` | 黑天鹅/突发事故 |

每条新闻同时打：`sentiment ∈ [-1, 1]`、`expected_impact_indices: ["000001.SH", "399006.SZ"] | "broad"`。

### D5：异动信号纯本地计算
不接外部"龙虎榜异动指数"，避免引入新的反爬源。规则：

- **量比**：`today_volume / mean(last_30d_volume)`，> 1.5 标记 `high_volume`，< 0.7 标记 `low_volume`
- **量价背离**：`high_volume == true && abs(change_pct) < 1.0` → `abnormal_silent`（高量但价格几乎没动 → 有人吸筹/出货迹象）
- **龙虎榜活跃**：当日 lhb_record 中存在该指数成分股（用首字母判：上证 = `60xxxx/68xxxx`，创业板 = `30xxxx`）→ `lhb_active=true`，给出净买入金额合计

这些信号在 prompt 里只作"提示"，不让 LLM 据此推断方向，避免过度解读。

### D6：预测 prompt 的分层窗口结构
直接把 60/90 行明细全部塞进去会让 prompt 爆 8k+ tokens。改为：

```
近 5 日：完整字段（OHLCV + 两融净买 + 广度 + 行业轮动 + lhb_active + 异动 + reason）
近 30 日：OHLCV + chg% + volume + reason（旧版结构）
近 60/90 日：仅统计聚合（max/min/median close、累计涨跌、量能均值、上下分位数）
当日补充：板块 Top5/Bottom5、涨停数、当日新闻事件 ≤ 10 条
```

预估 prompt 长度：~2500-3500 tokens；glm-4-flash 上下文 32k，远未爆表。

### D7：所有外部 API 调用都 fail-safe
每个 provider 都包一层 `try/catch`：

- 失败时返回 `null`/空数组，不抛出
- 调用方收到空值后在 prompt 里写"<该维度数据缺失>"
- 失败计入 logStage，便于 grafana / 人工排查

这样即使两融接口/龙虎榜接口某天挂了，预测仍能完成（仅置信度可能下调）。

## Schema 设计

### Table: `margin_balance`
```sql
CREATE TABLE margin_balance (
  trade_date     TEXT PRIMARY KEY,
  finance_balance REAL,    -- RZYE 融资余额（元）
  finance_buy     REAL,    -- RZMRE 融资买入额
  finance_repay   REAL,    -- RZCHE 融资偿还额
  finance_net     REAL,    -- RZJME 融资净买入
  finance_net_3d  REAL,    -- RZJME3D
  finance_net_5d  REAL,    -- RZJME5D
  short_balance   REAL,    -- RQYE 融券余额
  short_net       REAL,    -- RQJMG 融券净卖出
  total_balance   REAL,    -- RZRQYE 两融总余额
  market_index    REAL,    -- NEW 当日大盘指数（参考用）
  raw_json        TEXT,    -- 原始 JSON 备份，便于后续字段补齐
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
```

### Table: `market_breadth`
```sql
CREATE TABLE market_breadth (
  trade_date    TEXT NOT NULL,
  scope         TEXT NOT NULL, -- 'sse' | 'szse' | 'chinext'
  advancing     INTEGER,   -- f104 上涨家数
  declining     INTEGER,   -- f105 下跌家数
  unchanged     INTEGER,   -- f106 平家数
  limit_up      INTEGER,   -- 涨停数（来自 ZTPool）
  limit_down    INTEGER,   -- 跌停数（暂留 NULL）
  raw_json      TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (trade_date, scope)
);
```

### Table: `sector_quote`
```sql
CREATE TABLE sector_quote (
  trade_date   TEXT NOT NULL,
  sector_code  TEXT NOT NULL,  -- BK0xxx
  sector_name  TEXT NOT NULL,
  change_pct   REAL,           -- f3
  total_value  REAL,           -- f4 (现价/指数点位)
  total_amount REAL,           -- f6 成交额
  turnover_pct REAL,           -- f8 换手率
  rank_type    TEXT NOT NULL,  -- 'top5' | 'bottom5'
  rank_pos     INTEGER NOT NULL, -- 1..5
  created_at   TEXT NOT NULL,
  PRIMARY KEY (trade_date, sector_code, rank_type)
);
```

### Table: `lhb_record`
```sql
CREATE TABLE lhb_record (
  trade_date     TEXT NOT NULL,
  security_code  TEXT NOT NULL,
  security_name  TEXT,
  close_price    REAL,
  change_rate    REAL,
  net_amount     REAL,    -- BILLBOARD_NET_AMT 净买入（正负）
  buy_amount     REAL,
  sell_amount    REAL,
  market         TEXT,    -- 'SH' | 'SZ'
  explanation    TEXT,
  raw_json       TEXT,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (trade_date, security_code)
);
CREATE INDEX idx_lhb_date ON lhb_record(trade_date);
```

### Table: `news_event`
```sql
CREATE TABLE news_event (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of_date     TEXT NOT NULL,           -- 决策当日
  source         TEXT,                    -- 'web_search:ddg' / 'manual'
  url            TEXT,
  title          TEXT NOT NULL,
  summary        TEXT,
  category       TEXT,                    -- D4 中的 10 类标签之一
  sentiment      REAL,                    -- -1.0 ~ +1.0
  impact_indices TEXT,                    -- JSON 数组 ['000001.SH','399006.SZ'] 或 'broad'
  rationale      TEXT,                    -- LLM 生成的"为何影响 A 股"
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_news_event_date ON news_event(as_of_date);
```

## Risks / Trade-offs

| 风险 | 影响 | 缓解 |
|---|---|---|
| 东方财富改字段（如 RPTA_RZRQ_LSHJ 改名） | provider 拉空 | 每个 provider 单元测试 + 启动期 self-check |
| 两融 T+1 滞后 | 当日预测拿不到当日两融 | prompt 里明确标注"截至 T-1" |
| webSearch 中文召回弱 | 事件分类基于空数据 | LLM 兜底文案 + sentiment=0 + 在 rationale 里说明"今日无重大公开事件" |
| Prompt 变长导致延迟 | 单次预测 4s → ~10s | glm-4-flash 已经是最快档；可接受 |
| 龙虎榜信号"事后诸葛亮" | 当日数据 T+1 才出 | 用 T-1 龙虎榜，标注"昨日机构动向" |
| 新闻分类 LLM 主观偏差 | 误读事件方向 | rationale 字段保存可追溯；后续可标注校正 |
| 多源拼装后置信度反而虚高 | 模型把所有维度都堆上来声称"高置信" | system prompt 强调"维度冲突时降低置信度" |

## Migration Plan

### 数据库
- 5 张表全部用 `CREATE TABLE IF NOT EXISTS`
- 不动现有 `index_quotes` / `index_analysis_memory` 表
- 上线后跑一次 `--refresh-fundflow`（仅回填两融，约 250 条）；广度/行业/龙虎榜按日累积，不回填历史

### 代码
1. 先合并第 1-2 阶段（Phase 1+2，纯数据层），不动 LLM
2. 验证两融/广度/行业/龙虎榜入库 OK 后再合并第 3 阶段（事件分析）
3. 最后合并第 5 阶段（预测引擎重写），单独 PR/commit

### Cron
- 14:00 主任务流程：ingest_quote → ingest_margin → ingest_breadth → ingest_sector → ingest_lhb → news_search_classify → predict → notify
- 任一步失败都不阻塞下一步（fail-safe）
