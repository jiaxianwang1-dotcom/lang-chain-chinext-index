## ADDED Requirements

### Requirement: 当日新闻事件持久化
系统 SHALL 维护 `news_event` 表，主键 `id` 自增，包含字段：`as_of_date`（决策日，索引）、`source`（'web_search:ddg' 等）、`url`、`title`、`summary`、`category`、`sentiment`（-1.0 ~ +1.0）、`impact_indices`（JSON 数组）、`rationale`（LLM 生成的影响逻辑）、`created_at`。

`(as_of_date, title)` SHOULD 在应用层做幂等判重，避免同一标题重复入库。

#### Scenario: 当日重复跑分类不重复入库
- **WHEN** 同一交易日内对相同 `webSearch` 结果二次调用 `classifyTodayNews()`
- **THEN** 系统检测到 `(as_of_date, title)` 已存在则跳过 LLM 调用，直接复用旧分类

### Requirement: 事件分类标签体系
LLM 分类器 SHALL 把每条新闻打标到以下 10 个类别之一：

- `policy_macro`（宏观政策 / 央行 / 财政 / 监管）
- `geopolitics`（中美 / 关税 / 制裁 / 地缘冲突）
- `industry_semi`（半导体 / 芯片）
- `industry_ai`（AI 大模型 / 算力）
- `industry_property`（地产）
- `industry_energy`（新能源 / 锂电 / 光伏）
- `industry_finance`（银行 / 券商 / 保险）
- `market_event`（IPO / 退市 / 北交所 / 再融资）
- `overseas`（美联储 / 美股 / 海外）
- `accident`（黑天鹅 / 突发）

每条同时输出 `sentiment ∈ [-1, 1]` 与 `impact_indices`：取值为 `["000001.SH"]`、`["399006.SZ"]`、两者并列、或字符串 `"broad"`（影响整个 A 股）。

#### Scenario: 央行降准利好分类
- **WHEN** 标题为"央行宣布全面降准 0.5 个百分点 释放长期资金 1 万亿"
- **THEN** category=`policy_macro`，sentiment > 0.6，impact_indices=`broad`

#### Scenario: 半导体突破利好创业板
- **WHEN** 标题为"长江存储 232 层 3D NAND 量产突破 国产替代加速"
- **THEN** category=`industry_semi`，sentiment > 0.5，impact_indices=`["399006.SZ"]`（创业板含半导体权重股）

### Requirement: 预测前临时新闻采集
系统 SHALL 提供 `classifyTodayNews(asOfDate)`：

1. 用现有 `webSearch` 工具搜 2-3 个固定查询词组合（"今日 A 股 财经要闻"、"今日 重大政策 经济新闻"、"今日 半导体 芯片 AI 突破"）
2. 合并去重得到 ≤ 20 条候选标题
3. 用 glm-4-flash 一次性分类（批量调用，节省 token）
4. 写入 `news_event` 表

调用方 MUST 接受"网络搜索失败时仅写入空兜底"，预测流程不会因此阻塞。

#### Scenario: webSearch 失败时降级
- **WHEN** 所有 webSearch 调用都返回错误
- **THEN** 系统在 `news_event` 写入一条 `category='accident', sentiment=0, title='今日无可获取的公开新闻'` 的占位记录；预测 prompt 中标注"今日新闻数据缺失"

### Requirement: 当日事件查询
系统 SHALL 暴露 `getTodayNews(asOfDate)` 返回当日已分类的事件列表（已按 sentiment 绝对值降序排列），最多 ≤ 10 条供预测 prompt 使用。

#### Scenario: 取最重要的 10 条
- **WHEN** 调用 `getTodayNews("2026-05-09")` 时当日已分类 25 条
- **THEN** 返回按 |sentiment| 降序排序的前 10 条，过滤掉 sentiment 接近 0 的中性新闻

### Requirement: 事件 web 查询工具
web-agent SHALL 暴露 `query_today_events` 工具，返回当日已分类的全部事件，按类别分组展示。

#### Scenario: 用户问"今天有什么大新闻"
- **WHEN** 用户问"今天 A 股有什么消息面"
- **THEN** Agent 调用 `query_today_events()` 按类别分组返回，每条带 `[category +0.6 上证] 央行降准 → 释放流动性 1 万亿`
