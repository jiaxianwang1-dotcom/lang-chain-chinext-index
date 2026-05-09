import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import {
  HumanMessage,
  SystemMessage,
  isAIMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { StateGraph, START, END, MemorySaver, Annotation } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";

import { defaultProvider } from "../providers/index.js";
import { backfillOneYear, ingestToday } from "../providers/ingestion.js";
import { analyzeChangeReason, backfillReasons } from "../analysis/index.js";
import {
  bootstrapPredictionMemory,
  predictAllTargets,
  predictNextTradingDay,
} from "../prediction/index.js";
import { buildNotifier, type SmsNotifier } from "../notify/index.js";
import { logStage, timed } from "../utils/log.js";

// ==================== Tools ====================

const fetchAndIngestToday = tool(
  async () => {
    const rows = await ingestToday(defaultProvider);
    return JSON.stringify(rows.map((r) => ({ index_code: r.index_code, trade_date: r.trade_date, close: r.close_value, change_pct: r.change_pct })));
  },
  {
    name: "fetch_and_ingest_today",
    description: "拉取上证指数和创业板指当日实时点位，并 upsert 入库。返回入库的行（非交易日返回空数组）。",
    schema: z.object({}),
  }
);

const backfillOneYearTool = tool(
  async () => JSON.stringify(await backfillOneYear(defaultProvider)),
  {
    name: "backfill_one_year",
    description: "首次回填两个目标指数近 1 年的日线数据。",
    schema: z.object({}),
  }
);

const analyzeChangeReasonTool = tool(
  async ({ index_code, trade_date }) => {
    const r = await analyzeChangeReason(index_code, trade_date);
    return JSON.stringify(r);
  },
  {
    name: "analyze_change_reason",
    description: "针对指定指数 + 交易日，调用搜索 + LLM 分析涨跌原因并写回数据库。",
    schema: z.object({
      index_code: z.string().describe("如 000001.SH 或 399006.SZ"),
      trade_date: z.string().describe("YYYY-MM-DD"),
    }),
  }
);

const backfillReasonsTool = tool(
  async () => JSON.stringify(await backfillReasons()),
  {
    name: "backfill_reasons",
    description: "对所有 change_reason 缺失的记录批量补齐归因。",
    schema: z.object({}),
  }
);

const bootstrapMemoryTool = tool(
  async ({ index_code }) => {
    const m = await bootstrapPredictionMemory(index_code);
    return JSON.stringify({ version: m.version, as_of_date: m.as_of_date });
  },
  {
    name: "bootstrap_prediction_memory",
    description: "对指定指数生成 version=1 的长期分析记忆（仅在首次运行使用）。",
    schema: z.object({ index_code: z.string() }),
  }
);

const predictNextTool = tool(
  async ({ index_code }) => JSON.stringify(await predictNextTradingDay(index_code)),
  {
    name: "predict_next_trading_day",
    description: "基于上一份长期记忆 + 增量行情，预测下一交易日方向（买涨/买跌）。",
    schema: z.object({ index_code: z.string() }),
  }
);

const predictAllTool = tool(
  async () => JSON.stringify(await predictAllTargets()),
  {
    name: "predict_all_targets",
    description: "对所有目标指数依次预测下一交易日方向。",
    schema: z.object({}),
  }
);

const sendPredictionSmsTool = tool(
  async ({ dry_run }) => {
    const predictions = await predictAllTargets();
    const notifier = buildNotifier({ dryRun: dry_run ?? false });
    await notifier.sendPredictionSms(predictions);
    return JSON.stringify({ ok: true, count: predictions.length });
  },
  {
    name: "send_prediction_sms",
    description: "对所有目标指数预测后通过短信通知用户。dry_run=true 时只打印不真正发送。",
    schema: z.object({ dry_run: z.boolean().optional() }),
  }
);

export const stockTools = [
  fetchAndIngestToday,
  backfillOneYearTool,
  analyzeChangeReasonTool,
  backfillReasonsTool,
  bootstrapMemoryTool,
  predictNextTool,
  predictAllTool,
  sendPredictionSmsTool,
];

// ==================== Graph ====================

const StockState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
});

const SYSTEM_PROMPT = `你是 A 股大盘指数行情智能体，专门负责跟踪上证指数（000001.SH）与创业板指（399006.SZ）。

工作流程通常是：
1) fetch_and_ingest_today 拉当日行情
2) analyze_change_reason 给两个指数补充原因
3) predict_all_targets 输出下一交易日方向
4) send_prediction_sms 通知用户

如果用户只问行情或原因，直接调用对应工具即可，不必跑全流程。
所有结论结尾要附"仅供参考，非投资建议"。`;

let _llm: ChatOpenAI | null = null;
function getLlm(): ChatOpenAI {
  if (_llm) return _llm;
  _llm = new ChatOpenAI({
    model: "glm-4-flash",
    apiKey: process.env.ZHIPU_API_KEY,
    configuration: { baseURL: "https://open.bigmodel.cn/api/paas/v4" },
    temperature: 0.2,
  });
  return _llm;
}

async function agentNode(state: typeof StockState.State) {
  const llmWithTools = getLlm().bindTools(stockTools);
  const messages: BaseMessage[] = [new SystemMessage(SYSTEM_PROMPT), ...state.messages];
  const response = await llmWithTools.invoke(messages);
  return { messages: [response] };
}

const toolNode = new ToolNode(stockTools);

function shouldContinue(state: typeof StockState.State) {
  const last = state.messages[state.messages.length - 1];
  if (isAIMessage(last) && last.tool_calls?.length) return "tools";
  return END;
}

const workflow = new StateGraph(StockState)
  .addNode("agent", agentNode)
  .addNode("tools", toolNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", shouldContinue)
  .addEdge("tools", "agent");

const checkpointer = new MemorySaver();
export const stockGraph = workflow.compile({ checkpointer });

// ==================== runOnce（直接函数调用，不走 LLM 决策）====================

export interface RunOnceOptions {
  dryRun?: boolean;
  notifier?: SmsNotifier;
}

export async function runOnce(opts: RunOnceOptions = {}): Promise<void> {
  const ingested = await timed("ingest", undefined, () => ingestToday(defaultProvider));
  if (ingested.length === 0) {
    logStage({ stage: "runOnce.skip_non_trading", ok: true });
    return;
  }
  for (const row of ingested) {
    await timed("analyze", row.index_code, () => analyzeChangeReason(row.index_code, row.trade_date));
  }
  const predictions = await timed("predict", undefined, () => predictAllTargets());
  const notifier = opts.notifier ?? buildNotifier({ dryRun: opts.dryRun });
  await timed("notify", undefined, () => notifier.sendPredictionSms(predictions));
}
