// 智能咨询 Tab：调用 /api/stock/chat（带时间范围），SSE 流式渲染。
// 复用原 public/index.html 内联脚本的对话气泡逻辑。

(function () {
  "use strict";
  const { escapeHtml, createRangeSelector, fetchSse } = window.AppCommon;

  const root = document.querySelector('[data-panel="chat"]');
  if (!root) return;

  // 注入范围选择器（在面板顶部）
  const selector = createRangeSelector("1m");
  root.insertBefore(selector.root, root.firstChild);

  const chatContainer = root.querySelector("#chatContainer");
  const messageInput = root.querySelector("#messageInput");
  const sendBtn = root.querySelector("#sendBtn");
  const welcome = root.querySelector("#welcome");
  let isStreaming = false;

  function autoResize(el) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }
  messageInput.addEventListener("input", () => autoResize(messageInput));
  messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  sendBtn.addEventListener("click", sendMessage);

  // 暴露给 inline onclick （suggestions 按钮）
  window.sendSuggestion = function (text) {
    messageInput.value = text;
    sendMessage();
  };
  window.clearChat = function () {
    chatContainer.innerHTML = "";
    if (welcome) {
      chatContainer.appendChild(welcome);
      welcome.style.display = "";
    }
  };

  function addMessage(role, content) {
    if (welcome) welcome.style.display = "none";
    const div = document.createElement("div");
    div.className = `message ${role}`;
    if (role === "user") {
      div.innerHTML = `<div class="bubble">${escapeHtml(content)}</div><div class="avatar">👤</div>`;
    } else {
      div.innerHTML = `<div class="avatar">🤖</div><div class="bubble">${content}</div>`;
    }
    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    return div;
  }

  function addStreamingMessage() {
    if (welcome) welcome.style.display = "none";
    const div = document.createElement("div");
    div.className = "message assistant";
    div.innerHTML = `
      <div class="avatar">🤖</div>
      <div class="bubble">
        <div class="typing-indicator"><span></span><span></span><span></span></div>
      </div>
    `;
    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    return div;
  }

  async function sendMessage() {
    const message = messageInput.value.trim();
    if (!message || isStreaming) return;

    isStreaming = true;
    sendBtn.disabled = true;
    messageInput.value = "";
    messageInput.style.height = "auto";

    addMessage("user", message);
    const assistantDiv = addStreamingMessage();
    const bubble = assistantDiv.querySelector(".bubble");

    const range = selector.getRange();
    const body = { message, ...range };
    let fullText = "";
    try {
      await fetchSse(
        "/api/stock/chat",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        (data) => {
          if (data.content) {
            fullText += data.content;
            bubble.innerHTML = escapeHtml(fullText);
            chatContainer.scrollTop = chatContainer.scrollHeight;
          }
          if (data.done && !fullText) {
            bubble.innerHTML = "（无回复）";
          }
        }
      );
    } catch (_) {
      bubble.innerHTML = "❌ 连接失败，请检查服务器是否正常运行";
    } finally {
      isStreaming = false;
      sendBtn.disabled = false;
      messageInput.focus();
    }
  }

  messageInput.focus();
})();
