import "dotenv/config";
import Database from "better-sqlite3";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..", "..");

// ==================== SQLite 长期记忆 ====================
const MEMORY_DIR = join(PROJECT_ROOT, ".memory");
if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

const db = new Database(join(MEMORY_DIR, "web_agent.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    key       TEXT    NOT NULL UNIQUE,
    content   TEXT    NOT NULL,
    createdAt TEXT    NOT NULL,
    updatedAt TEXT    NOT NULL
  )
`);

export const saveMemory = tool(
  ({ key, content }: { key: string; content: string }) => {
    const now = new Date().toISOString();
    const existing = db.prepare("SELECT id FROM memories WHERE key = ?").get(key);
    if (existing) {
      db.prepare("UPDATE memories SET content = ?, updatedAt = ? WHERE key = ?").run(content, now, key);
      return `已更新记忆 [${key}]: ${content}`;
    }
    db.prepare("INSERT INTO memories (key, content, createdAt, updatedAt) VALUES (?, ?, ?, ?)").run(key, content, now, now);
    return `已保存记忆 [${key}]: ${content}`;
  },
  {
    name: "save_memory",
    description: "将重要信息保存到长期记忆数据库中。当用户提到个人信息、偏好、重要事实时主动保存。",
    schema: z.object({
      key: z.string().describe("记忆键名，如 '用户姓名'"),
      content: z.string().describe("记忆内容"),
    }),
  }
);

export const searchMemory = tool(
  ({ query }: { query: string }) => {
    const rows = db.prepare(
      "SELECT key, content, updatedAt FROM memories WHERE key LIKE ? OR content LIKE ?"
    ).all(`%${query}%`, `%${query}%`) as Array<{ key: string; content: string; updatedAt: string }>;

    if (rows.length === 0) {
      const all = db.prepare("SELECT key, content FROM memories").all() as Array<{ key: string; content: string }>;
      if (all.length === 0) return "长期记忆为空。";
      return `未找到与"${query}"相关记忆。所有记忆：\n${all.map((m) => `- [${m.key}]: ${m.content}`).join("\n")}`;
    }
    return rows.map((m) => `[${m.key}]: ${m.content} (${m.updatedAt})`).join("\n");
  },
  {
    name: "search_memory",
    description: "从长期记忆中搜索信息。需要回忆用户信息时调用。",
    schema: z.object({ query: z.string().describe("搜索关键词") }),
  }
);

// ==================== 联网搜索工具 ====================
export const webSearch = tool(
  async ({ query }: { query: string }) => {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url);
    const data = await res.json() as {
      AbstractText?: string;
      AbstractURL?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      Results?: Array<{ Text?: string; FirstURL?: string }>;
    };
    const results: string[] = [];
    if (data.AbstractText) {
      results.push(`摘要: ${data.AbstractText}\n来源: ${data.AbstractURL ?? ""}`);
    }
    for (const topic of data.RelatedTopics ?? []) {
      if (topic.Text) results.push(`${topic.Text}\n链接: ${topic.FirstURL ?? ""}`);
    }
    for (const r of data.Results ?? []) {
      if (r.Text) results.push(`${r.Text}\n链接: ${r.FirstURL ?? ""}`);
    }
    return results.length ? results.join("\n\n") : `未找到"${query}"的相关信息`;
  },
  {
    name: "web_search",
    description: "联网搜索互联网获取实时信息。当用户问及最新事件、实时数据或你不确定的知识时使用。",
    schema: z.object({ query: z.string().describe("搜索关键词") }),
  }
);

export const webFetch = tool(
  async ({ url }: { url: string }) => {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Agent/1.0)" },
    });
    const html = await res.text();
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, 5000);
  },
  {
    name: "web_fetch",
    description: "获取指定URL网页的文本内容。当搜索结果中有需要深入阅读的链接时使用。",
    schema: z.object({ url: z.string().describe("要访问的网页URL") }),
  }
);

export const allTools = [saveMemory, searchMemory, webSearch, webFetch];
