// 共享工具：字符串转义、Tab 切换、范围选择器组件、SSE 解析。
// 不依赖任何外部库，直接由 <script> 标签按顺序加载。

(function () {
  "use strict";

  function escapeHtml(text) {
    const d = document.createElement("div");
    d.textContent = text == null ? "" : String(text);
    return d.innerHTML;
  }

  function setupTabs(onTabChange) {
    const tabs = document.querySelectorAll(".tab");
    const panels = document.querySelectorAll(".panel");
    function activate(name) {
      tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
      panels.forEach((p) => p.classList.toggle("active", p.dataset.panel === name));
      try {
        localStorage.setItem("activeTab", name);
      } catch (e) {
        /* localStorage 不可用时忽略 */
      }
      if (typeof onTabChange === "function") onTabChange(name);
    }
    tabs.forEach((t) => {
      t.addEventListener("click", () => activate(t.dataset.tab));
    });
    let initial = "chat";
    try {
      initial = localStorage.getItem("activeTab") || "chat";
    } catch (e) {
      /* ignore */
    }
    if (!document.querySelector(`.tab[data-tab="${initial}"]`)) initial = "chat";
    activate(initial);
  }

  /**
   * 创建一个时间范围选择器组件。返回 { root, getRange, onChange }。
   * onChange(({ range, from, to })) 在用户选择新窗口（含点击预设、点击 Apply）时触发。
   * 切到 "custom" 但未确认前不触发。
   */
  function createRangeSelector(initialRange) {
    const RANGES = [
      { key: "3d", label: "近3天" },
      { key: "10d", label: "近10天" },
      { key: "1m", label: "近一月" },
      { key: "2m", label: "近2月" },
      { key: "3m", label: "近3月" },
      { key: "1y", label: "近一年" },
      { key: "custom", label: "自定义" },
    ];
    const root = document.createElement("div");
    root.className = "range-bar";
    root.innerHTML = `
      <span class="label">时间范围:</span>
      <div class="chips"></div>
      <div class="custom-dates">
        <input type="date" data-input="from" />
        <span>~</span>
        <input type="date" data-input="to" />
        <button class="apply-btn" type="button">应用</button>
        <span class="hint" style="display:none"></span>
      </div>
    `;
    const chipsEl = root.querySelector(".chips");
    const customEl = root.querySelector(".custom-dates");
    const fromEl = root.querySelector('[data-input="from"]');
    const toEl = root.querySelector('[data-input="to"]');
    const applyBtn = root.querySelector(".apply-btn");
    const hintEl = root.querySelector(".hint");

    let currentRange = initialRange || "1m";
    let currentFrom;
    let currentTo;
    const listeners = [];

    function notify() {
      const payload = { range: currentRange };
      if (currentRange === "custom") {
        payload.from = currentFrom;
        payload.to = currentTo;
      }
      listeners.forEach((fn) => fn(payload));
    }

    function setActiveChip() {
      chipsEl.querySelectorAll(".chip").forEach((c) => {
        c.classList.toggle("active", c.dataset.range === currentRange);
      });
      customEl.classList.toggle("show", currentRange === "custom");
    }

    RANGES.forEach((r) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.dataset.range = r.key;
      btn.textContent = r.label;
      btn.addEventListener("click", () => {
        currentRange = r.key;
        setActiveChip();
        if (r.key !== "custom") notify();
      });
      chipsEl.appendChild(btn);
    });

    function validateCustom() {
      if (!fromEl.value || !toEl.value) {
        applyBtn.disabled = true;
        hintEl.style.display = "none";
        return false;
      }
      if (fromEl.value > toEl.value) {
        applyBtn.disabled = true;
        hintEl.textContent = "起始日期必须早于结束日期";
        hintEl.style.display = "inline";
        return false;
      }
      applyBtn.disabled = false;
      hintEl.style.display = "none";
      return true;
    }
    fromEl.addEventListener("change", validateCustom);
    toEl.addEventListener("change", validateCustom);
    applyBtn.addEventListener("click", () => {
      if (!validateCustom()) return;
      currentFrom = fromEl.value;
      currentTo = toEl.value;
      notify();
    });

    setActiveChip();

    return {
      root,
      getRange() {
        return currentRange === "custom"
          ? { range: "custom", from: currentFrom, to: currentTo }
          : { range: currentRange };
      },
      includesToday() {
        // 预设窗口 end 一律是今日；custom 必须 to >= 今日
        if (currentRange !== "custom") return true;
        if (!currentTo) return false;
        const today = new Date().toISOString().slice(0, 10);
        return currentTo >= today;
      },
      onChange(fn) {
        listeners.push(fn);
      },
    };
  }

  /**
   * 通用 SSE fetch：每收到一条 `data: {...}` 调一次 onEvent(payload)。
   * 完成或出错时返回；调用方负责 UI 状态。
   */
  async function fetchSse(url, init, onEvent) {
    const res = await fetch(url, init);
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const payload = JSON.parse(line.slice(6));
          onEvent(payload);
        } catch (_) {
          /* 忽略半截数据 */
        }
      }
    }
  }

  window.AppCommon = { escapeHtml, setupTabs, createRangeSelector, fetchSse };
})();
