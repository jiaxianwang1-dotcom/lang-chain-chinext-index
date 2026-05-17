#!/bin/bash
# 测试 Kimi API 连通性和响应时间
API_KEY="${KIMI_API_KEY:-$1}"
if [ -z "$API_KEY" ]; then
  echo "用法: KIMI_API_KEY=sk-xxx ./test-kimi-api.sh"
  exit 1
fi

echo "=== 测试 1: 简单列表模型 (GET) ==="
time curl -s -w "\nHTTP %{http_code} | 耗时: %{time_total}s\n" \
  -H "Authorization: Bearer $API_KEY" \
  https://api.moonshot.cn/v1/models

echo ""
echo "=== 测试 2: 带 web_search 工具的 chat/completions (POST) ==="
time curl -s -w "\nHTTP %{http_code} | 耗时: %{time_total}s\n" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{
    "model": "moonshot-v1-8k",
    "messages": [
      {"role": "system", "content": "你是一个搜索助手。请使用 web_search 工具搜索用户的问题。"},
      {"role": "user", "content": "今日 A股 财经 重大政策"}
    ],
    "tools": [{"type": "builtin_function", "function": {"name": "$web_search"}}],
    "temperature": 0.1
  }' \
  https://api.moonshot.cn/v1/chat/completions | head -c 500

echo ""
echo ""
echo "=== 测试 3: 用 kimi-k2.6 模型做同样的请求 ==="
time curl -s -w "\nHTTP %{http_code} | 耗时: %{time_total}s\n" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{
    "model": "kimi-k2.6",
    "messages": [
      {"role": "system", "content": "你是一个搜索助手。请使用 web_search 工具搜索用户的问题。"},
      {"role": "user", "content": "今日 A股 财经 重大政策"}
    ],
    "tools": [{"type": "builtin_function", "function": {"name": "$web_search"}}],
    "temperature": 1
  }' \
  https://api.moonshot.cn/v1/chat/completions | head -c 500

echo ""
