import { writeFileSync, mkdirSync, existsSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { PredictionResult } from "../prediction/index.js";
import { logStage, sleep } from "../utils/log.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..", "..", "..", "..");
const FAILED_LOG = join(PROJECT_ROOT, ".memory", "stock_agent_failed_sms.log");

// ==================== 接口 ====================

export interface SmsConfig {
  provider: string;
  accessKeyId: string;
  accessKeySecret: string;
  signName: string;
  templateCode: string;
  phone: string;
}

export interface SmsNotifier {
  sendPredictionSms(predictions: PredictionResult[]): Promise<void>;
}

// ==================== 工具 ====================

const REQUIRED_KEYS: Array<keyof SmsConfig> = [
  "provider",
  "accessKeyId",
  "accessKeySecret",
  "signName",
  "templateCode",
  "phone",
];

export function loadSmsConfig(env: NodeJS.ProcessEnv = process.env): SmsConfig {
  const config: SmsConfig = {
    provider: env.SMS_PROVIDER ?? "",
    accessKeyId: env.SMS_ACCESS_KEY_ID ?? "",
    accessKeySecret: env.SMS_ACCESS_KEY_SECRET ?? "",
    signName: env.SMS_SIGN_NAME ?? "",
    templateCode: env.SMS_TEMPLATE_CODE ?? "",
    phone: env.SMS_PHONE ?? "",
  };
  const missing = REQUIRED_KEYS.filter((k) => !config[k]);
  if (missing.length) {
    throw new Error(
      `SMS 配置缺失：${missing.map((k) => "SMS_" + k.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase()).join(", ")}。请在 .env 中补全后再启动。`
    );
  }
  if (config.provider !== "aliyun") {
    throw new Error(`SMS_PROVIDER 当前仅支持 aliyun，收到: ${config.provider}`);
  }
  return config;
}

export function renderSmsContent(predictions: PredictionResult[]): {
  content: string;
  time: string;
} {
  const time = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  const parts = predictions.map((p) => {
    const dirText = p.direction === "up" ? "买涨" : p.direction === "down" ? "买跌" : "观望";
    const conf = p.calibrated_confidence != null
      ? `校准置信度${(p.calibrated_confidence * 100).toFixed(1)}%`
      : `置信度${(p.confidence * 100).toFixed(1)}%`;
    return `${p.index_name}${dirText}(${conf})`;
  });
  const content = parts.join("，");
  return { content, time };
}

function appendFailedLog(text: string): void {
  const dir = dirname(FAILED_LOG);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const line = `[${new Date().toISOString()}] ${text}\n`;
  try {
    appendFileSync(FAILED_LOG, line);
  } catch {
    writeFileSync(FAILED_LOG, line);
  }
}

// ==================== Dry-run ====================

export class DryRunSmsNotifier implements SmsNotifier {
  constructor(private readonly phone: string = process.env.SMS_PHONE ?? "15136489941") {}
  async sendPredictionSms(predictions: PredictionResult[]): Promise<void> {
    const { content, time } = renderSmsContent(predictions);
    logStage({
      stage: "sms.dry_run",
      ok: true,
      phone: this.phone,
      content,
      time,
      hint: "dry-run，未真正发送",
    });
    console.log(
      `\n[DRY-RUN SMS]\n收件人: ${this.phone}\n签名/模板渲染:\n  指数预测：${content}（${time}）。仅供参考，非投资建议。\n`
    );
  }
}

// ==================== Aliyun ====================

interface AliyunSendApi {
  sendSms(req: {
    phoneNumbers: string;
    signName: string;
    templateCode: string;
    templateParam: string;
  }): Promise<{ body?: { code?: string; message?: string; requestId?: string } }>;
}

async function buildAliyunClient(config: SmsConfig): Promise<AliyunSendApi> {
  // 动态加载，避免在 dry-run / 单测中触碰原生 SDK
  const sdk: any = await import("@alicloud/dysmsapi20170525");
  const openapi: any = await import("@alicloud/openapi-client");
  const ClientCtor = sdk.default ?? sdk.Client ?? sdk;
  const ConfigCtor = openapi.default?.Config ?? openapi.Config;
  if (!ClientCtor || !ConfigCtor) {
    throw new Error("阿里云短信 SDK 加载失败：未找到 Client / Config 构造函数");
  }
  const aliConfig = new ConfigCtor({
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    endpoint: "dysmsapi.aliyuncs.com",
  });
  const client = new ClientCtor(aliConfig);
  const SendSmsRequest = sdk.SendSmsRequest;
  return {
    async sendSms(req) {
      const request = new SendSmsRequest({
        phoneNumbers: req.phoneNumbers,
        signName: req.signName,
        templateCode: req.templateCode,
        templateParam: req.templateParam,
      });
      return client.sendSms(request);
    },
  };
}

export class AliyunSmsNotifier implements SmsNotifier {
  constructor(
    private readonly config: SmsConfig,
    private readonly clientFactory: () => Promise<AliyunSendApi> = () => buildAliyunClient(this.config)
  ) {}

  async sendPredictionSms(predictions: PredictionResult[]): Promise<void> {
    const { content, time } = renderSmsContent(predictions);
    const templateParam = JSON.stringify({ content, time });

    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const client = await this.clientFactory();
        const res = await client.sendSms({
          phoneNumbers: this.config.phone,
          signName: this.config.signName,
          templateCode: this.config.templateCode,
          templateParam,
        });
        const code = res?.body?.code ?? "";
        if (code === "OK") {
          logStage({
            stage: "sms.sent",
            ok: true,
            phone: this.config.phone,
            requestId: res?.body?.requestId ?? null,
            content,
          });
          return;
        }
        lastError = new Error(`阿里云返回非 OK：code=${code} msg=${res?.body?.message ?? ""}`);
        logStage({
          stage: "sms.send_non_ok",
          ok: false,
          attempt,
          error: String(lastError),
          requestId: res?.body?.requestId ?? null,
        });
      } catch (e) {
        lastError = e;
        logStage({
          stage: "sms.send_failed",
          ok: false,
          attempt,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      if (attempt < 2) await sleep(1000 * Math.pow(2, attempt));
    }

    appendFailedLog(
      JSON.stringify({
        phone: this.config.phone,
        content,
        time,
        templateParam,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      })
    );
    logStage({
      stage: "sms.fallback_to_log",
      ok: false,
      file: FAILED_LOG,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
  }
}

export function buildNotifier(opts: { dryRun?: boolean } = {}): SmsNotifier {
  if (opts.dryRun) {
    return new DryRunSmsNotifier(process.env.SMS_PHONE);
  }
  const config = loadSmsConfig();
  return new AliyunSmsNotifier(config);
}
