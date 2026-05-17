// 体育彩票 Tab：大乐透 + 双色球双卡片 + 历史开奖 + AI 预测。

(function () {
  "use strict";
  const { escapeHtml, createRangeSelector } = window.AppCommon;

  const TARGETS = [
    { type: "daletou", name: "大乐透", desc: "前区 35 选 5 + 后区 12 选 2" },
    { type: "shuangseqiu", name: "双色球", desc: "红球 33 选 6 + 蓝球 16 选 1" },
  ];

  const root = document.querySelector('[data-panel="lottery"]');
  if (!root) return;

  // ---------- DOM 骨架 ----------
  const selector = createRangeSelector("1m");
  root.appendChild(selector.root);

  // 免责声明
  const disclaimer = document.createElement("div");
  disclaimer.className = "lottery-disclaimer";
  disclaimer.textContent = "免责声明：彩票开奖为随机事件，AI 预测仅基于历史数据统计规律，不构成任何投注建议。请理性购彩，量力而行。";
  root.appendChild(disclaimer);

  const cardsWrap = document.createElement("div");
  cardsWrap.className = "lottery-cards";
  root.appendChild(cardsWrap);

  // 卡片状态
  const cards = new Map();

  TARGETS.forEach(({ type, name, desc }) => {
    const card = document.createElement("section");
    card.className = "lottery-card";
    card.innerHTML = `
      <header class="card-head">
        <div>
          <div class="card-title">${escapeHtml(name)}</div>
          <div class="card-sub">${escapeHtml(desc)}</div>
        </div>
      </header>
      <div class="lottery-predict" data-role="predict">
        <div class="pred-label" data-role="pred-label">
          <span>AI 预测下一期号码</span>
          <span data-role="pred-status"></span>
        </div>
        <div data-role="pred-groups"></div>
        <button class="pred-refresh" data-role="pred-refresh" type="button">重新预测</button>
        <div class="pred-prompt-toggle" data-role="pred-prompt-toggle" style="display:none;">
          <button class="pred-prompt-btn" data-role="pred-prompt-btn" type="button">查看提示词</button>
        </div>
        <div class="pred-prompt-panel" data-role="pred-prompt-panel" style="display:none;">
          <div class="pred-prompt-section">
            <div class="pred-prompt-title">系统提示词 (System Prompt)</div>
            <pre class="pred-prompt-content" data-role="pred-system-prompt"></pre>
          </div>
          <div class="pred-prompt-section">
            <div class="pred-prompt-title">用户提示词 (User Prompt)</div>
            <pre class="pred-prompt-content" data-role="pred-user-prompt"></pre>
          </div>
        </div>
      </div>
      <div class="lottery-table-wrap">
        <table class="lottery-table">
          <thead>
            <tr>
              <th>开奖日期</th>
              <th>期号</th>
              <th>红球/前区</th>
              <th>蓝球/后区</th>
              <th>AI 预测</th>
            </tr>
          </thead>
          <tbody data-role="tbody"></tbody>
        </table>
      </div>
      <div class="lottery-status" data-role="status"></div>
    `;
    cardsWrap.appendChild(card);
    const state = {
      card,
      tbody: card.querySelector('[data-role="tbody"]'),
      status: card.querySelector('[data-role="status"]'),
      predLabel: card.querySelector('[data-role="pred-label"]'),
      predStatus: card.querySelector('[data-role="pred-status"]'),
      predGroups: card.querySelector('[data-role="pred-groups"]'),
      predRefresh: card.querySelector('[data-role="pred-refresh"]'),
      predPromptToggle: card.querySelector('[data-role="pred-prompt-toggle"]'),
      predPromptBtn: card.querySelector('[data-role="pred-prompt-btn"]'),
      predPromptPanel: card.querySelector('[data-role="pred-prompt-panel"]'),
      predSystemPrompt: card.querySelector('[data-role="pred-system-prompt"]'),
      predUserPrompt: card.querySelector('[data-role="pred-user-prompt"]'),
      rows: [],
    };
    state.predRefresh.addEventListener("click", () => loadPrediction(type, { force: true }));
    cards.set(type, state);
  });

  // ---------- 渲染工具 ----------
  function renderBalls(redBalls, blueBalls) {
    const redHtml = redBalls.map((n) => `<span class="lottery-ball">${n}</span>`).join("");
    const blueHtml = blueBalls.map((n) => `<span class="lottery-ball blue">${n}</span>`).join("");
    return `
      <div class="lottery-balls">
        ${redHtml}
        <span class="lottery-ball plus">+</span>
        ${blueHtml}
      </div>
    `;
  }

  function renderPredictionCell(row) {
    if (!row.aiPredictions || row.aiPredictions.length === 0) {
      return `<td>-</td>`;
    }
    const actualRed = new Set(row.redBalls);
    const actualBlue = new Set(row.blueBalls);

    const html = row.aiPredictions.map((p) => {
      const redHits = p.redBalls.filter((n) => actualRed.has(n)).length;
      const blueHits = p.blueBalls.filter((n) => actualBlue.has(n)).length;
      const redHtml = p.redBalls
        .map((n) => {
          const hit = actualRed.has(n) ? "hit" : "";
          return `<span class="lottery-ball ${hit}">${n}</span>`;
        })
        .join("");
      const blueHtml = p.blueBalls
        .map((n) => {
          const hit = actualBlue.has(n) ? "hit blue" : "blue";
          return `<span class="lottery-ball ${hit}">${n}</span>`;
        })
        .join("");
      return `
        <div class="ai-pred-group">
          <div class="ai-pred-meta">第${p.predictionNo}组 (${redHits}+${blueHits})</div>
          <div class="lottery-balls">
            ${redHtml}
            <span class="lottery-ball plus">+</span>
            ${blueHtml}
          </div>
        </div>
      `;
    }).join("");

    return `<td>${html}</td>`;
  }

  function renderRow(row) {
    return `
      <td>${escapeHtml(row.drawDate)}</td>
      <td>${escapeHtml(row.drawPeriod ?? "-")}</td>
      <td>${renderBalls(row.redBalls, [])}</td>
      <td>${renderBalls([], row.blueBalls)}</td>
      ${renderPredictionCell(row)}
    `;
  }

  function renderCard(type, payload) {
    const c = cards.get(type);
    if (!c) return;
    c.rows = payload.rows || [];
    c.status.textContent = "";

    // 表格倒序：最新在上
    const display = c.rows.slice().reverse();
    c.tbody.innerHTML = display
      .map((r) => `<tr>${renderRow(r)}</tr>`)
      .join("");
  }

  // ---------- 预测渲染 ----------
  async function loadPrediction(type, { force = false } = {}) {
    const c = cards.get(type);
    if (!c) return;
    c.predRefresh.disabled = true;
    c.predStatus.textContent = "预测中...";
    c.predGroups.innerHTML = "";

    try {
      const range = selector.getRange();
      const qs = new URLSearchParams();
      qs.set("type", type);
      qs.set("range", range.range);
      if (range.range === "custom") {
        if (range.from) qs.set("from", range.from);
        if (range.to) qs.set("to", range.to);
      }
      if (force) qs.set("force", "1");

      const res = await fetch(`/api/lottery/predictions?${qs.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();

      c.predStatus.textContent = `预测目标: ${payload.targetDate}`;
      c.predGroups.innerHTML = (payload.predictions || [])
        .map((p) => `
          <div class="pred-group">
            <div class="pred-group-title">第 ${p.predictionNo} 组推荐（置信度 ${(p.confidence * 100).toFixed(0)}%）</div>
            ${renderBalls(p.redBalls, p.blueBalls)}
            <div class="pred-rationale">${escapeHtml(p.rationale)}</div>
          </div>
        `)
        .join("");

      // 提示词展示
      if (payload.systemPrompt || payload.userPrompt) {
        c.predPromptToggle.style.display = "";
        c.predSystemPrompt.textContent = payload.systemPrompt || "（无系统提示词）";
        c.predUserPrompt.textContent = payload.userPrompt || "（无用户提示词）";
        const btn = c.predPromptBtn;
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        c.predPromptBtn = newBtn;
        let expanded = false;
        newBtn.addEventListener("click", () => {
          expanded = !expanded;
          c.predPromptPanel.style.display = expanded ? "" : "none";
          newBtn.textContent = expanded ? "收起提示词" : "查看提示词";
        });
      } else {
        c.predPromptToggle.style.display = "none";
        c.predPromptPanel.style.display = "none";
      }
    } catch (e) {
      c.predStatus.textContent = "预测失败";
      c.predGroups.innerHTML = `<div style="color:#c0392b;font-size:12px;">预测失败，请稍后重试</div>`;
    } finally {
      c.predRefresh.disabled = false;
    }
  }

  // ---------- 数据加载 ----------
  function buildQuery() {
    const range = selector.getRange();
    const u = new URLSearchParams();
    u.set("range", range.range);
    if (range.range === "custom") {
      if (range.from) u.set("from", range.from);
      if (range.to) u.set("to", range.to);
    }
    return u.toString();
  }

  async function loadAll() {
    const qsBase = buildQuery();
    await Promise.all(
      TARGETS.map(async ({ type }) => {
        const c = cards.get(type);
        c.status.textContent = "加载中...";
        try {
          const res = await fetch(`/api/lottery/draws?type=${type}&${qsBase}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const payload = await res.json();
          renderCard(type, payload);
        } catch (e) {
          c.status.innerHTML = `数据拉取失败，请稍后重试 <button data-retry>重试</button>`;
          const btn = c.status.querySelector("[data-retry]");
          if (btn) btn.addEventListener("click", loadAll);
        }
      })
    );
    // 历史数据加载完成后再触发预测
    TARGETS.forEach(({ type }) => loadPrediction(type));
  }

  selector.onChange(async () => {
    await loadAll();
  });

  // ---------- Tab 切换 ----------
  let isLotteryTabActive = false;

  window.LotteryTab = {
    onActivate() {
      isLotteryTabActive = true;
      if (!cards.get(TARGETS[0].type).rows.length) {
        loadAll();
      }
    },
    onDeactivate() {
      isLotteryTabActive = false;
    },
  };
})();
