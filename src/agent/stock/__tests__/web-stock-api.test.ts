import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// 必须在 import web-agent 之前设置环境变量，避免它启动 listen + 读 ZHIPU_API_KEY 时崩。
process.env.WEB_AGENT_NO_LISTEN = "1";
process.env.ZHIPU_API_KEY ??= "test-key";
process.env.PORT ??= "0";

// Mock 数据源：把 defaultProvider 替换成可控的 mock，避免真实网络。
// realtime/index.ts 从这里读 defaultProvider，所以这一层 mock 即可拦截两个 fetchXxx。
vi.mock("../providers/index.js", async () => {
  const actual = await vi.importActual<typeof import("../providers/index.js")>(
    "../providers/index.js"
  );
  return {
    ...actual,
    defaultProvider: {
      fetchDailyQuote: vi.fn(async (code: string) => ({
        index_code: code,
        index_name: code === "000001.SH" ? "上证指数" : "创业板指",
        trade_date: "2026-05-11",
        close_value: 3500,
        open_value: 3490,
        high_value: 3510,
        low_value: 3480,
      })),
      fetchHistoricalQuotes: vi.fn(async (code: string) => [
        { index_code: code, index_name: "上证指数", trade_date: "2026-05-09", close_value: 3000 },
        { index_code: code, index_name: "上证指数", trade_date: "2026-05-10", close_value: 3030 },
      ]),
    },
  };
});

// 防止 stockGraph 真实跑 LLM：mock 掉 stream，返回空异步迭代器。
vi.mock("../graph/index.js", async () => {
  const actual = await vi.importActual<typeof import("../graph/index.js")>("../graph/index.js");
  return {
    ...actual,
    stockGraph: {
      stream: vi.fn(async function* () {
        yield {};
      }),
    },
  };
});

let request: typeof import("supertest").default;
let app: import("express").Express;

beforeAll(async () => {
  // 动态 import：确保上面的 vi.mock hoist 生效后再加载 web-agent
  request = (await import("supertest")).default;
  const mod = await import("../../../../web-agent.js");
  app = mod._appForTest;
});

beforeEach(async () => {
  const realtime = await import("../realtime/index.js");
  realtime._clearSharedCache();
});

describe("GET /api/stock/quotes", () => {
  it("默认 200 + 字段名与 IndexQuoteRow 一致", async () => {
    const res = await request(app).get("/api/stock/quotes?indexCode=000001.SH");
    expect(res.status).toBe(200);
    expect(res.body.indexCode).toBe("000001.SH");
    expect(res.body.indexName).toBe("上证指数");
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.rows.length).toBeGreaterThan(0);
    const row = res.body.rows[0];
    for (const k of [
      "index_code",
      "index_name",
      "trade_date",
      "close_value",
      "open_value",
      "high_value",
      "low_value",
      "volume",
      "turnover",
      "change",
      "change_pct",
    ]) {
      expect(row).toHaveProperty(k);
    }
  });

  it("非法 range 返 400", async () => {
    const res = await request(app).get("/api/stock/quotes?indexCode=000001.SH&range=2y");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid range/);
  });

  it("非法 indexCode 返 400", async () => {
    const res = await request(app).get("/api/stock/quotes?indexCode=ABCDE");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported indexCode/);
  });

  it("custom 缺少 from/to 返 400", async () => {
    const res = await request(app).get("/api/stock/quotes?indexCode=000001.SH&range=custom");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/stock/quotes/today", () => {
  it("返回最新点位与 fetchedAt", async () => {
    const res = await request(app).get("/api/stock/quotes/today?indexCode=000001.SH");
    expect(res.status).toBe(200);
    expect(res.body.row.close_value).toBe(3500);
    expect(typeof res.body.fetchedAt).toBe("string");
  });
});

describe("GET /api/stock/trading-day", () => {
  it("周末返回 isTradingDay=false", async () => {
    // 2026-05-09 是星期六；让启发式判定走"非今日且 DB 无 row" → false
    const res = await request(app).get("/api/stock/trading-day?date=2026-05-09");
    expect(res.status).toBe(200);
    expect(res.body.date).toBe("2026-05-09");
    expect(res.body.isTradingDay).toBe(false);
  });
});

describe("GET /api/stock/signals", () => {
  it("无数据时也返回 200 + 7 大类结构完整", async () => {
    const res = await request(app).get("/api/stock/signals");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("asOfDate");
    expect(res.body).toHaveProperty("macro");
    expect(Array.isArray(res.body.macro)).toBe(true);
    expect(res.body).toHaveProperty("external");
    expect(res.body.external).toHaveProperty("latest");
    expect(res.body.external).toHaveProperty("cnhRecent");
    expect(Array.isArray(res.body.futures)).toBe(true);
    expect(Array.isArray(res.body.margin)).toBe(true);
    expect(Array.isArray(res.body.breadth)).toBe(true);
    expect(Array.isArray(res.body.sector)).toBe(true);
    expect(res.body.lhb).toHaveProperty("total_count");
    expect(Array.isArray(res.body.news)).toBe(true);
  });

  it("macro 维度即使空库也会自动写入启发式种子", async () => {
    const res = await request(app).get("/api/stock/signals");
    expect(res.status).toBe(200);
    // 启发式种子覆盖 CN CPI / PMI / LPR / US CPI / 非农
    const names = (res.body.macro as Array<{ event_name: string }>).map((e) => e.event_name);
    expect(names.length).toBeGreaterThan(0);
    // 至少其中之一会出现
    expect(
      names.some((n) => /CPI|PMI|LPR|非农/.test(n))
    ).toBe(true);
  });
});

describe("GET /api/stock/macro", () => {
  it("接受 start/end，返回种子事件", async () => {
    const res = await request(app).get("/api/stock/macro?start=2026-05-01&end=2026-05-31");
    expect(res.status).toBe(200);
    expect(res.body.start).toBe("2026-05-01");
    expect(res.body.end).toBe("2026-05-31");
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.rows.length).toBeGreaterThan(0);
  });
});

describe("GET /api/stock/external", () => {
  it("空表也返回 200，latest=[]", async () => {
    const res = await request(app).get("/api/stock/external");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.latest)).toBe(true);
    expect(Array.isArray(res.body.cnhRecent)).toBe(true);
  });
});

describe("GET /api/stock/futures", () => {
  it("空表也返回 200，rows=[]", async () => {
    const res = await request(app).get("/api/stock/futures");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
  });
});

describe("POST /api/stock/chat", () => {
  it("空 message 返 400", async () => {
    const res = await request(app).post("/api/stock/chat").send({ message: "" });
    expect(res.status).toBe(400);
  });

  it("正常请求返回 SSE 流（{done:true} 收尾）", async () => {
    const res = await request(app)
      .post("/api/stock/chat")
      .send({ message: "你好" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.text).toMatch(/"done":true/);
  });
});
