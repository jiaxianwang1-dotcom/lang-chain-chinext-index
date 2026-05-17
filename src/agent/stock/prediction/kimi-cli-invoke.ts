import { execSync, execFileSync } from "child_process";
import { logStage } from "../utils/log.js";

export interface KimiCliInvokeOptions {
  /** kimi CLI 可执行文件路径，默认从 PATH 找 */
  cliPath?: string;
  /** 调用超时（毫秒），默认 120 秒 */
  timeoutMs?: number;
}

function findKimiCli(): string {
  try {
    return execSync("which kimi", { encoding: "utf-8" }).trim();
  } catch {
    throw new Error(
      "kimi CLI not found in PATH. Please install it: https://moonshotai.github.io/kimi-cli/"
    );
  }
}

/**
 * 通过 kimi CLI (Kimi for Coding) 调用 LLM。
 *
 * 要求：
 * 1. 系统已安装 kimi CLI (`pip install kimi-cli` 或 `uv tool install kimi-cli`)
 * 2. ~/.kimi/config.toml 已配置好 providers.kimi + models.kimi-for-coding
 *
 * 输出：从 kimi --quiet 的纯文本中提取 ```json...``` 代码块里的 JSON 字符串。
 *
 * 实现说明：使用 stdin 传入 prompt，避免命令行参数长度限制和 shell 转义问题。
 */
export function createKimiCliInvoke(opts: KimiCliInvokeOptions = {}) {
  const cliPath = opts.cliPath ?? findKimiCli();
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return async function kimiCliInvoke(
    systemPrompt: string,
    userPrompt: string
  ): Promise<string> {
    const fullPrompt = systemPrompt
      ? `${systemPrompt}\n\n${userPrompt}`
      : userPrompt;

    logStage({
      stage: "kimi_cli.invoke_start",
      cliPath,
      promptLength: fullPrompt.length,
    });

    const start = Date.now();
    let raw = "";
    const attempts = [
      ["--quiet"],
      ["--print"],
      [],
    ];
    let lastError: Error | undefined;
    for (const args of attempts) {
      try {
        // 临时清空 KIMI_BASE_URL，防止项目 .env 覆盖 config.toml 中的 Coding API URL
        const env = { ...process.env };
        delete env.KIMI_BASE_URL;
        raw = execFileSync(cliPath, args, {
          input: fullPrompt,
          encoding: "utf-8",
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024, // 10MB
          env,
        });
        lastError = undefined;
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("No such option")) {
          lastError = e instanceof Error ? e : new Error(msg);
          continue; // try next fallback
        }
        logStage({
          stage: "kimi_cli.invoke_failed",
          ok: false,
          error: msg,
          elapsed_ms: Date.now() - start,
        });
        throw e;
      }
    }
    if (lastError) {
      logStage({
        stage: "kimi_cli.invoke_failed",
        ok: false,
        error: lastError.message,
        elapsed_ms: Date.now() - start,
      });
      throw lastError;
    }

    const elapsed = Date.now() - start;

    // 去掉末尾 "To resume this session: ..." 行
    const cleaned = raw
      .split("\n")
      .filter((line) => !line.startsWith("To resume this session:"))
      .join("\n")
      .trim();

    // 提取 ```json ... ``` 代码块
    const codeBlockMatch = cleaned.match(/```json\s*([\s\S]*?)\s*```/);
    const jsonText = codeBlockMatch ? codeBlockMatch[1].trim() : cleaned;

    logStage({
      stage: "kimi_cli.invoke_done",
      ok: true,
      elapsed_ms: elapsed,
      raw_length: raw.length,
      json_length: jsonText.length,
    });

    return jsonText;
  };
}
