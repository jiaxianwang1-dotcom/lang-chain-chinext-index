import { describe, it, expect, vi } from "vitest";
import {
  loadSmsConfig,
  renderSmsContent,
  AliyunSmsNotifier,
  DryRunSmsNotifier,
  type SmsConfig,
} from "../notify/index.js";
import type { PredictionResult } from "../prediction/index.js";

const SAMPLE: PredictionResult[] = [
  {
    index_code: "000001.SH",
    index_name: "上证指数",
    direction: "up",
    confidence: 0.62,
    rationale: "x",
    as_of_date: "2026-05-09",
    version: 2,
  },
  {
    index_code: "399006.SZ",
    index_name: "创业板指",
    direction: "down",
    confidence: 0.55,
    rationale: "y",
    as_of_date: "2026-05-09",
    version: 2,
  },
];

const VALID_CFG: SmsConfig = {
  provider: "aliyun",
  accessKeyId: "AKID",
  accessKeySecret: "SECRET",
  signName: "测试签名",
  templateCode: "SMS_TEST",
  phone: "15136489941",
};

describe("loadSmsConfig", () => {
  it("缺失任一字段抛错", () => {
    expect(() =>
      loadSmsConfig({ SMS_PROVIDER: "aliyun" } as NodeJS.ProcessEnv)
    ).toThrow(/SMS 配置缺失/);
  });
  it("非 aliyun 抛错", () => {
    expect(() =>
      loadSmsConfig({
        SMS_PROVIDER: "twilio",
        SMS_ACCESS_KEY_ID: "x",
        SMS_ACCESS_KEY_SECRET: "x",
        SMS_SIGN_NAME: "x",
        SMS_TEMPLATE_CODE: "x",
        SMS_PHONE: "x",
      } as NodeJS.ProcessEnv)
    ).toThrow(/aliyun/);
  });
  it("齐全时返回配置", () => {
    const c = loadSmsConfig({
      SMS_PROVIDER: "aliyun",
      SMS_ACCESS_KEY_ID: "a",
      SMS_ACCESS_KEY_SECRET: "b",
      SMS_SIGN_NAME: "c",
      SMS_TEMPLATE_CODE: "d",
      SMS_PHONE: "e",
    } as NodeJS.ProcessEnv);
    expect(c.accessKeyId).toBe("a");
  });
});

describe("renderSmsContent", () => {
  it("覆盖两个指数 + 中文方向 + 置信度百分比", () => {
    const r = renderSmsContent(SAMPLE);
    expect(r.content).toContain("上证指数");
    expect(r.content).toContain("买涨");
    expect(r.content).toContain("创业板指");
    expect(r.content).toContain("买跌");
    expect(r.content).toMatch(/62\.0%/);
    expect(r.content).toMatch(/55\.0%/);
    expect(r.time.length).toBeGreaterThan(0);
  });
});

describe("DryRunSmsNotifier", () => {
  it("不抛错并打印", async () => {
    const n = new DryRunSmsNotifier("15136489941");
    await expect(n.sendPredictionSms(SAMPLE)).resolves.toBeUndefined();
  });
});

describe("AliyunSmsNotifier", () => {
  it("发送成功（code=OK）", async () => {
    const sendSms = vi.fn().mockResolvedValue({ body: { code: "OK", requestId: "req-1" } });
    const notifier = new AliyunSmsNotifier(VALID_CFG, async () => ({ sendSms }));
    await notifier.sendPredictionSms(SAMPLE);
    expect(sendSms).toHaveBeenCalledTimes(1);
    const call = sendSms.mock.calls[0][0];
    expect(call.phoneNumbers).toBe("15136489941");
    expect(call.signName).toBe("测试签名");
    expect(call.templateCode).toBe("SMS_TEST");
    const param = JSON.parse(call.templateParam);
    expect(param.content).toContain("上证指数");
  });

  it("非 OK 时退避重试 3 次后落盘", async () => {
    const sendSms = vi
      .fn()
      .mockResolvedValue({ body: { code: "isv.BUSINESS_LIMIT_CONTROL", message: "limited", requestId: "r" } });
    const notifier = new AliyunSmsNotifier(VALID_CFG, async () => ({ sendSms }));
    await notifier.sendPredictionSms(SAMPLE);
    expect(sendSms).toHaveBeenCalledTimes(3);
  }, 15000);

  it("异常失败时也退避重试 3 次", async () => {
    const sendSms = vi.fn().mockRejectedValue(new Error("network"));
    const notifier = new AliyunSmsNotifier(VALID_CFG, async () => ({ sendSms }));
    await notifier.sendPredictionSms(SAMPLE);
    expect(sendSms).toHaveBeenCalledTimes(3);
  }, 15000);
});
