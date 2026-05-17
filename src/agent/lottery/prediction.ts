import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  getLotteryDrawsInRange,
  getLotteryPredictions,
  upsertLotteryPrediction,
  type LotteryPredictionRow,
} from "../stock/db/index.js";
import {
  LOTTERY_CONFIG,
  type LotteryType,
  computeLotteryStats,
  formatStatsForPrompt,
} from "./provider.js";
import { todayShanghai } from "../stock/realtime/range.js";
import { createKimiCliInvoke } from "../stock/prediction/kimi-cli-invoke.js";

// ==================== Schemas ====================

const LotteryPredictionSchema = z.object({
  predictions: z
    .array(
      z.object({
        red_balls: z.array(z.number().int().positive()).min(5).max(6),
        blue_balls: z.array(z.number().int().positive()).min(1).max(2),
        confidence: z.number().min(0).max(1),
        rationale: z.string().min(1),
      })
    )
    .length(2),
});

export type LotteryPredictionResult = z.infer<typeof LotteryPredictionSchema>;

export interface PredictionOutput {
  targetDate: string;
  predictions: Array<{
    predictionNo: number;
    redBalls: number[];
    blueBalls: number[];
    confidence: number;
    rationale: string;
  }>;
  systemPrompt: string;
  userPrompt: string;
  model: string;
}

// ==================== LLM ====================

let _kimiCliInvoke: ReturnType<typeof createKimiCliInvoke> | null = null;

function getModelName(): string {
  if (process.env.USE_KIMI_CLI === "true") return "kimi-for-coding";
  return process.env.KIMI_MODEL ?? "kimi-k2.6";
}

async function invokeLlm(systemPrompt: string, userPrompt: string): Promise<string> {
  if (process.env.USE_KIMI_CLI === "true") {
    if (!_kimiCliInvoke) {
      _kimiCliInvoke = createKimiCliInvoke({
        cliPath: process.env.KIMI_CLI_PATH,
        timeoutMs: process.env.KIMI_CLI_TIMEOUT_MS
          ? parseInt(process.env.KIMI_CLI_TIMEOUT_MS, 10)
          : 120_000,
      });
    }
    return _kimiCliInvoke(systemPrompt, userPrompt);
  }

  const llm = new ChatOpenAI({
    model: process.env.KIMI_MODEL ?? "kimi-k2.6",
    apiKey: process.env.KIMI_API_KEY,
    configuration: { baseURL: process.env.KIMI_BASE_URL ?? "https://api.moonshot.cn/v1" },
    temperature: 0.8,
  });
  const res = await llm.invoke([new SystemMessage(systemPrompt), new HumanMessage(userPrompt)]);
  return typeof res.content === "string" ? res.content : JSON.stringify(res.content);
}

// ==================== Prompts ====================

function buildLotterySystemPrompt(type: LotteryType): string {
  const cfg = LOTTERY_CONFIG[type];
  const isDaletou = type === "daletou";

  return `你是一位资深的彩票数据分析专家与预测设计师。你的任务是基于历史开奖数据的统计规律，为用户设计下一期的"参考号码"。

## 重要声明（必须在 rationale 中体现）
1. 彩票开奖本质上是独立随机事件，历史数据不能决定未来结果。
2. 你提供的号码仅是基于统计规律（热号、冷号、遗漏、奇偶比、大小比、连号、区间分布等）的"数据参考"，绝非中奖保证。
3. 用户应理性购彩，量力而行。

## 彩票规则
- 彩票类型：${cfg.name}
- 红球/前区：从 ${cfg.redRange[0]}-${cfg.redRange[1]} 中选 ${cfg.redCount} 个，不重复
- 蓝球/后区：从 ${cfg.blueRange[0]}-${cfg.blueRange[1]} 中选 ${cfg.blueCount} 个，不重复
${isDaletou ? "- 大乐透每周一、三、六开奖" : "- 双色球每周二、四、日开奖"}

## 分析维度（rationale 中至少引用 3 个）
1. **热号追踪**：近期出现频率高的号码，可能继续活跃（趋势延续）。
2. **冷号反弹**：长期未出现的冷号，从概率角度可能接近出现（均值回归）。
3. **奇偶平衡**：观察近期奇偶比是否失衡，适当向平衡方向调整。
4. **大小平衡**：观察近期大小比是否失衡，适当向平衡方向调整。
5. **连号规律**：连号出现率约 50%，可适当考虑一组连号。
6. **区间分布**：确保三个区间都有号码覆盖，避免过度集中。
7. **遗漏值**：选择部分遗漏期数适中的号码（非最长遗漏）。

## 号码选择策略
- 每组号码应兼顾热号（1-2个）+ 温号（2-3个）+ 冷号（1-2个）。
- 奇偶比建议 ${isDaletou ? "2:3 或 3:2" : "3:3 或 4:2"}。
- 大小比建议 ${isDaletou ? "2:3 或 3:2" : "3:3 或 4:2"}。
- 可考虑包含 1 组连号（如 12,13）。
- 三区分布尽量均匀，避免某一区缺失。
- 蓝球/后区可冷热搭配。

## 置信度规则
- confidence 表示该组号码与统计规律的匹配程度（非中奖概率）。
- 号码分布越均衡、覆盖维度越多 → confidence 越高（0.65-0.85）。
- 号码较为集中或偏离常见模式 → confidence 较低（0.50-0.65）。
- 严禁给 0.9 以上的极端值。

## 输出格式（严格 JSON，不要 Markdown）
{
  "predictions": [
    {
      "red_balls": [${isDaletou ? "a, b, c, d, e" : "a, b, c, d, e, f"}],
      "blue_balls": [${isDaletou ? "x, y" : "z"}],
      "confidence": 0.72,
      "rationale": "基于热号追踪选择...，兼顾冷号反弹...，奇偶比为...，大小比为...，覆盖三个区间..."
    },
    {
      "red_balls": [${isDaletou ? "a2, b2, c2, d2, e2" : "a2, b2, c2, d2, e2, f2"}],
      "blue_balls": [${isDaletou ? "x2, y2" : "z2"}],
      "confidence": 0.68,
      "rationale": "第二组选择..."
    }
  ]
}

## 硬性纪律
- 红球/前区号码必须在 ${cfg.redRange[0]}-${cfg.redRange[1]} 范围内，且不重复。
- 蓝球/后区号码必须在 ${cfg.blueRange[0]}-${cfg.blueRange[1]} 范围内，且不重复。
- 必须输出恰好 2 组预测（predictions 数组长度为 2）。
- rationale 必须包含 3 个以上分析维度的具体说明。
- rationale 开头必须包含"【声明】本预测仅基于历史数据统计规律，彩票开奖为随机事件，不构成任何投注建议。"`;
}

function buildLotteryUserPrompt(type: LotteryType, startDate: string, endDate: string): string {
  const cfg = LOTTERY_CONFIG[type];
  const draws = getLotteryDrawsInRange(type, startDate, endDate);

  if (draws.length === 0) {
    return `【${cfg.name}】在 ${startDate} 至 ${endDate} 期间无开奖数据。请基于通用统计规律给出预测。`;
  }

  const stats = computeLotteryStats(type, draws);
  const statsText = formatStatsForPrompt(stats, type);

  return `请基于以下历史数据统计，为【${cfg.name}】设计下一期（最近一期之后）的 2 组参考号码。

数据时间范围: ${startDate} 至 ${endDate}（共 ${draws.length} 期）

${statsText}

请严格按照系统提示中的格式输出 JSON，包含恰好 2 组预测号码。`;
}

// ==================== 解析 ====================

function safeParseJson<T>(raw: string, schema: z.ZodSchema<T>, fallback: T): T {
  const trimmed = raw.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^```json\s*/i, "").replace(/```$/, "").trim(),
    (trimmed.match(/\{[\s\S]*\}/) ?? [""])[0],
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      return schema.parse(JSON.parse(c));
    } catch {
      // try next
    }
  }
  return fallback;
}

function validateBalls(type: LotteryType, red: number[], blue: number[]): boolean {
  const cfg = LOTTERY_CONFIG[type];
  // 数量正确
  if (red.length !== cfg.redCount) return false;
  if (blue.length !== cfg.blueCount) return false;
  // 不重复
  if (new Set(red).size !== red.length) return false;
  if (new Set(blue).size !== blue.length) return false;
  // 范围正确
  if (!red.every((n) => n >= cfg.redRange[0] && n <= cfg.redRange[1])) return false;
  if (!blue.every((n) => n >= cfg.blueRange[0] && n <= cfg.blueRange[1])) return false;
  return true;
}

// ==================== 主预测函数 ====================

export async function predictLotteryNumbers(
  type: LotteryType,
  startDate: string,
  endDate: string,
  opts: { force?: boolean } = {}
): Promise<PredictionOutput> {
  const targetDate = todayShanghai();
  const model = getModelName();

  // 若未强制刷新，先查缓存
  if (!opts.force) {
    const cached = getLotteryPredictions(type, targetDate);
    if (cached.length >= 2) {
      return {
        targetDate,
        predictions: cached.map((c) => ({
          predictionNo: c.prediction_no,
          redBalls: JSON.parse(c.red_balls) as number[],
          blueBalls: JSON.parse(c.blue_balls) as number[],
          confidence: c.confidence,
          rationale: c.rationale,
        })),
        systemPrompt: "",
        userPrompt: cached[0]?.prompt_text ?? "",
        model: cached[0]?.model ?? getModelName(),
      };
    }
  }

  const systemPrompt = buildLotterySystemPrompt(type);
  const userPrompt = buildLotteryUserPrompt(type, startDate, endDate);

  const raw = await invokeLlm(systemPrompt, userPrompt);

  const parsed = safeParseJson(raw, LotteryPredictionSchema, { predictions: [] });

  // 验证并清理
  const validPredictions: Array<{
    predictionNo: number;
    redBalls: number[];
    blueBalls: number[];
    confidence: number;
    rationale: string;
  }> = [];

  for (let i = 0; i < parsed.predictions.length; i++) {
    const p = parsed.predictions[i];
    const red = p.red_balls.slice().sort((a, b) => a - b);
    const blue = p.blue_balls.slice().sort((a, b) => a - b);
    if (!validateBalls(type, red, blue)) {
      // 验证失败时生成一组随机合规号码作为 fallback
      const fallback = generateFallbackNumbers(type);
      validPredictions.push({
        predictionNo: i + 1,
        redBalls: fallback.red,
        blueBalls: fallback.blue,
        confidence: 0.55,
        rationale: "【声明】本预测仅基于历史数据统计规律，彩票开奖为随机事件，不构成任何投注建议。AI解析异常，此组为随机参考号码。",
      });
      continue;
    }
    validPredictions.push({
      predictionNo: i + 1,
      redBalls: red,
      blueBalls: blue,
      confidence: p.confidence,
      rationale: p.rationale,
    });
  }

  // 如果解析不到2组，补充到2组
  while (validPredictions.length < 2) {
    const no = validPredictions.length + 1;
    const fallback = generateFallbackNumbers(type);
    validPredictions.push({
      predictionNo: no,
      redBalls: fallback.red,
      blueBalls: fallback.blue,
      confidence: 0.55,
      rationale: `【声明】本预测仅基于历史数据统计规律，彩票开奖为随机事件，不构成任何投注建议。第${no}组为随机参考号码。`,
    });
  }

  // 存储到数据库
  for (const vp of validPredictions) {
    upsertLotteryPrediction({
      lottery_type: type,
      target_date: targetDate,
      prediction_no: vp.predictionNo,
      red_balls: JSON.stringify(vp.redBalls),
      blue_balls: JSON.stringify(vp.blueBalls),
      confidence: vp.confidence,
      rationale: vp.rationale,
      model,
      prompt_text: `${systemPrompt}\n\n--- USER PROMPT ---\n\n${userPrompt}`,
      predicted_at: new Date().toISOString(),
    });
  }

  return {
    targetDate,
    predictions: validPredictions,
    systemPrompt,
    userPrompt,
    model,
  };
}

function generateFallbackNumbers(type: LotteryType): { red: number[]; blue: number[] } {
  const cfg = LOTTERY_CONFIG[type];
  const pool = Array.from({ length: cfg.redRange[1] - cfg.redRange[0] + 1 }, (_, i) => cfg.redRange[0] + i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const red = pool.slice(0, cfg.redCount).sort((a, b) => a - b);

  const bluePool = Array.from({ length: cfg.blueRange[1] - cfg.blueRange[0] + 1 }, (_, i) => cfg.blueRange[0] + i);
  for (let i = bluePool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bluePool[i], bluePool[j]] = [bluePool[j], bluePool[i]];
  }
  const blue = bluePool.slice(0, cfg.blueCount).sort((a, b) => a - b);

  return { red, blue };
}
