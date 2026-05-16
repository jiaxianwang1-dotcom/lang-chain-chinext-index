// 大盘指数 Tab：上证 + 创业板双卡片 + 折线图 + 5 分钟自动刷新。

(function () {
  "use strict";
  const { escapeHtml, createRangeSelector } = window.AppCommon;

  const TARGETS = [
    { code: "000001.SH", name: "上证指数" },
    { code: "399006.SZ", name: "创业板指" },
  ];
  const POLL_INTERVAL_MS = 5 * 60 * 1000;

  const root = document.querySelector('[data-panel="stock"]');
  if (!root) return;

  // ---------- DOM 骨架 ----------
  const selector = createRangeSelector("1m");
  root.appendChild(selector.root);

  const cardsWrap = document.createElement("div");
  cardsWrap.className = "stock-cards";
  root.appendChild(cardsWrap);

  // 卡片状态：每个 indexCode 对应 chart 实例 + DOM 引用
  const cards = new Map();

  TARGETS.forEach(({ code, name }) => {
    const card = document.createElement("section");
    card.className = "stock-card";
    card.innerHTML = `
      <header class="card-head">
        <div>
          <div class="card-title">${escapeHtml(name)}</div>
          <div class="card-sub">${escapeHtml(code)}</div>
        </div>
        <div class="card-latest">
          <div class="latest-close" data-role="latest-close">--</div>
          <div class="latest-pct" data-role="latest-pct">--</div>
          <div class="latest-time" data-role="latest-time">最近更新: -</div>
        </div>
      </header>
      <div class="card-predict" data-role="predict">
        <div class="pred-label" data-role="pred-label">AI 预测涨跌幅</div>
        <div class="pred-main">
          <span class="pred-pct" data-role="pred-pct">--</span>
          <span class="pred-range" data-role="pred-range"></span>
          <span class="pred-bucket" data-role="pred-bucket"></span>
          <span class="pred-conf" data-role="pred-conf"></span>
        </div>
        <div class="pred-dims" data-role="pred-dims"></div>
        <div class="pred-rationale" data-role="pred-rationale"></div>
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
        <button class="pred-refresh" data-role="pred-refresh" type="button">重新预测</button>
      </div>
      <div class="card-chart-wrap">
        <canvas data-role="chart" height="180"></canvas>
      </div>
      <div class="card-table-wrap">
        <table class="quotes-table">
          <thead>
            <tr>
              <th title="trade_date">日期</th>
              <th title="open_value">开盘</th>
              <th title="high_value">最高</th>
              <th title="low_value">最低</th>
              <th title="close_value">收盘</th>
              <th title="change">涨跌</th>
              <th title="change_pct">涨跌幅</th>
              <th title="predicted_change_pct">AI 预测涨跌幅</th>
              <th title="volume">成交量</th>
              <th title="turnover">成交额</th>
            </tr>
          </thead>
          <tbody data-role="tbody"></tbody>
        </table>
      </div>
      <div class="card-status" data-role="status"></div>
    `;
    cardsWrap.appendChild(card);
    const state = {
      card,
      tbody: card.querySelector('[data-role="tbody"]'),
      canvas: card.querySelector('[data-role="chart"]'),
      latestClose: card.querySelector('[data-role="latest-close"]'),
      latestPct: card.querySelector('[data-role="latest-pct"]'),
      latestTime: card.querySelector('[data-role="latest-time"]'),
      status: card.querySelector('[data-role="status"]'),
      predLabel: card.querySelector('[data-role="pred-label"]'),
      predPct: card.querySelector('[data-role="pred-pct"]'),
      predRange: card.querySelector('[data-role="pred-range"]'),
      predBucket: card.querySelector('[data-role="pred-bucket"]'),
      predConf: card.querySelector('[data-role="pred-conf"]'),
      predDims: card.querySelector('[data-role="pred-dims"]'),
      predRationale: card.querySelector('[data-role="pred-rationale"]'),
      predPromptToggle: card.querySelector('[data-role="pred-prompt-toggle"]'),
      predPromptBtn: card.querySelector('[data-role="pred-prompt-btn"]'),
      predPromptPanel: card.querySelector('[data-role="pred-prompt-panel"]'),
      predSystemPrompt: card.querySelector('[data-role="pred-system-prompt"]'),
      predUserPrompt: card.querySelector('[data-role="pred-user-prompt"]'),
      predRefresh: card.querySelector('[data-role="pred-refresh"]'),
      chart: null,
      rows: [],
      predictions: new Map(), // target_date -> prediction row
    };
    state.predRefresh.addEventListener("click", () => loadCardPrediction(code, { force: true }));
    cards.set(code, state);
  });

  // ---------- 渲染 ----------
  function fmtNum(v, digits = 2) {
    if (v == null || !Number.isFinite(v)) return "-";
    return Number(v).toFixed(digits);
  }
  function fmtPct(v) {
    if (v == null || !Number.isFinite(v)) return "-";
    return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  }
  function fmtVolume(v) {
    if (v == null || !Number.isFinite(v)) return "-";
    if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿";
    if (v >= 1e4) return (v / 1e4).toFixed(2) + "万";
    return Math.round(v).toString();
  }
  function fmtTurnover(v) {
    if (v == null || !Number.isFinite(v)) return "-";
    if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿元";
    if (v >= 1e4) return (v / 1e4).toFixed(2) + "万元";
    return Math.round(v).toString() + "元";
  }
  function rowHtml(r, predictedPct) {
    const pctClass = r.change_pct == null ? "" : r.change_pct >= 0 ? "up" : "down";
    const predClass =
      predictedPct == null || !Number.isFinite(predictedPct)
        ? ""
        : predictedPct >= 0
        ? "up"
        : "down";
    return `
      <td>${escapeHtml(r.trade_date)}</td>
      <td>${fmtNum(r.open_value)}</td>
      <td>${fmtNum(r.high_value)}</td>
      <td>${fmtNum(r.low_value)}</td>
      <td>${fmtNum(r.close_value)}</td>
      <td class="${pctClass}">${fmtNum(r.change)}</td>
      <td class="${pctClass}">${fmtPct(r.change_pct)}</td>
      <td class="${predClass}">${fmtPct(predictedPct)}</td>
      <td>${fmtVolume(r.volume)}</td>
      <td>${fmtTurnover(r.turnover)}</td>
    `;
  }

  function predictedPctFor(c, date) {
    const p = c.predictions.get(date);
    return p && p.predicted_change_pct != null ? p.predicted_change_pct : null;
  }

  function renderCard(code, payload) {
    const c = cards.get(code);
    if (!c) return;
    c.rows = payload.rows || [];
    c.status.textContent = "";

    // 表格倒序：最新在上
    const display = c.rows.slice().reverse();
    c.tbody.innerHTML = display
      .map(
        (r) =>
          `<tr data-date="${escapeHtml(r.trade_date)}">${rowHtml(r, predictedPctFor(c, r.trade_date))}</tr>`
      )
      .join("");

    // 头部最新点位
    const last = c.rows[c.rows.length - 1];
    if (last) {
      c.latestClose.textContent = fmtNum(last.close_value);
      c.latestPct.textContent = fmtPct(last.change_pct);
      c.latestPct.className = "latest-pct " + (last.change_pct == null ? "" : last.change_pct >= 0 ? "up" : "down");
      c.latestTime.textContent = `最近更新: ${last.trade_date}`;
    }

    // 折线图
    drawChart(c);
  }

  function drawChart(c) {
    if (!window.Chart) return;
    const labels = c.rows.map((r) => r.trade_date);
    const data = c.rows.map((r) => r.close_value);
    if (c.chart) {
      c.chart.data.labels = labels;
      c.chart.data.datasets[0].data = data;
      c.chart.update("none");
      return;
    }
    c.chart = new window.Chart(c.canvas.getContext("2d"), {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "close_value",
            data,
            borderColor: "#667eea",
            backgroundColor: "rgba(102, 126, 234, 0.08)",
            borderWidth: 1.5,
            pointRadius: 0,
            fill: true,
            tension: 0.18,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false } },
        scales: {
          x: { ticks: { maxTicksLimit: 8, font: { size: 10 } } },
          y: { ticks: { font: { size: 10 } } },
        },
        interaction: { mode: "nearest", axis: "x", intersect: false },
      },
    });
  }

  // ---------- 数据加载 ----------
  function buildQuery(range) {
    const u = new URLSearchParams();
    u.set("range", range.range);
    if (range.range === "custom") {
      if (range.from) u.set("from", range.from);
      if (range.to) u.set("to", range.to);
    }
    return u.toString();
  }

  async function loadPredictionsForRange(code, qsBase) {
    const c = cards.get(code);
    try {
      const res = await fetch(`/api/stock/predictions?indexCode=${encodeURIComponent(code)}&${qsBase}`);
      if (!res.ok) return;
      const payload = await res.json();
      c.predictions = new Map();
      for (const p of payload.rows || []) {
        c.predictions.set(p.target_date, p);
      }
    } catch (_) {
      /* 预测拉取失败不阻塞主表格渲染 */
    }
  }

  const BUCKET_LABEL = { small: "小幅", medium: "中幅", large: "大幅" };

  async function loadCardPrediction(code, { force = false } = {}) {
    const c = cards.get(code);
    if (!c) return;
    c.predRefresh.disabled = true;
    const prevPctText = c.predPct.textContent;
    c.predPct.textContent = "预测中...";
    c.predPct.className = "pred-pct";
    c.predRange.textContent = "";
    c.predBucket.textContent = "";
    c.predDims.textContent = "";
    try {
      const url = `/api/stock/predictions/card?indexCode=${encodeURIComponent(code)}${force ? "&force=1" : ""}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      const p = payload.prediction || {};
      const pct = p.predicted_change_pct;
      c.predLabel.textContent =
        (payload.label || "AI 预测涨跌幅") +
        (payload.target ? `（${payload.target}）` : "");
      const klass =
        pct == null || !Number.isFinite(pct) ? "" : pct >= 0 ? "up" : "down";
      c.predPct.className = "pred-pct " + klass;
      c.predPct.textContent = fmtPct(pct);

      // 区间
      const lo = p.predicted_change_pct_low;
      const hi = p.predicted_change_pct_high;
      if (lo != null && hi != null && Number.isFinite(lo) && Number.isFinite(hi)) {
        c.predRange.textContent = `区间 ${fmtPct(lo)} ~ ${fmtPct(hi)}`;
      } else {
        c.predRange.textContent = "";
      }

      // 档位
      const bucket = p.magnitude_bucket;
      if (bucket && BUCKET_LABEL[bucket]) {
        c.predBucket.textContent = BUCKET_LABEL[bucket];
        c.predBucket.className = "pred-bucket bucket-" + bucket;
      } else {
        c.predBucket.textContent = "";
        c.predBucket.className = "pred-bucket";
      }

      const conf =
        p.confidence != null && Number.isFinite(p.confidence)
          ? `置信度 ${(p.confidence * 100).toFixed(0)}%`
          : "";
      const basedOn = p.based_on_date ? ` · 基于 ${p.based_on_date}` : "";
      c.predConf.textContent = conf + basedOn;

      // 维度计数
      const dims = p.dimensions_used;
      if (dims != null && Number.isFinite(dims)) {
        c.predDims.textContent = `多信号维度: ${dims}/10`;
      } else {
        c.predDims.textContent = "";
      }
      c.predRationale.textContent = p.rationale || "";

      // 提示词展示
      const sysPrompt = payload.systemPrompt;
      const userPrompt = payload.userPrompt;
      if (sysPrompt || userPrompt) {
        c.predPromptToggle.style.display = "";
        c.predSystemPrompt.textContent = sysPrompt || "（无系统提示词）";
        c.predUserPrompt.textContent = userPrompt || "（无用户提示词）";
        // 绑定一次性点击事件（先移除旧的）
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

      // 同步到表格预测列：如果目标日已经在窗口内则就地更新
      if (payload.target) {
        c.predictions.set(payload.target, p);
        const tr = c.tbody.querySelector(`tr[data-date="${CSS.escape(payload.target)}"]`);
        if (tr) {
          const row = c.rows.find((r) => r.trade_date === payload.target);
          if (row) tr.innerHTML = rowHtml(row, pct);
        }
      }
    } catch (e) {
      c.predPct.textContent = prevPctText || "--";
      c.predRationale.textContent = "预测失败，请稍后重试";
    } finally {
      c.predRefresh.disabled = false;
    }
  }

  async function loadAll() {
    const range = selector.getRange();
    const qsBase = buildQuery(range);
    await Promise.all(
      TARGETS.map(async ({ code }) => {
        const c = cards.get(code);
        c.status.textContent = "加载中...";
        try {
          // 行情 + 预测列并行拉取；先拿到预测，渲染表格时即可填充预测列
          const [quoteRes] = await Promise.all([
            fetch(`/api/stock/quotes?indexCode=${encodeURIComponent(code)}&${qsBase}`),
            loadPredictionsForRange(code, qsBase),
          ]);
          if (!quoteRes.ok) throw new Error(`HTTP ${quoteRes.status}`);
          const payload = await quoteRes.json();
          renderCard(code, payload);
        } catch (e) {
          c.status.innerHTML = `行情拉取失败，请稍后重试 <button data-retry>重试</button>`;
          const btn = c.status.querySelector("[data-retry]");
          if (btn) btn.addEventListener("click", loadAll);
        }
      })
    );
    // 行情渲染完成后再触发卡片预测；卡片预测通常较慢（LLM）
    TARGETS.forEach(({ code }) => loadCardPrediction(code));
  }

  // ---------- 5 分钟轮询 ----------
  let pollTimer = null;
  let isStockTabActive = false;
  let tradingDayCache = null; // 当天判定结果

  async function checkTradingDay() {
    try {
      const res = await fetch("/api/stock/trading-day");
      if (!res.ok) return false;
      const data = await res.json();
      tradingDayCache = data;
      return !!data.isTradingDay;
    } catch (_) {
      return false;
    }
  }

  async function refreshToday() {
    const today = new Date().toISOString().slice(0, 10);
    await Promise.all(
      TARGETS.map(async ({ code }) => {
        const c = cards.get(code);
        try {
          const res = await fetch(`/api/stock/quotes/today?indexCode=${encodeURIComponent(code)}`);
          if (!res.ok) return;
          const payload = await res.json();
          if (!payload.row) return;
          // 就地替换：找到表格中 trade_date 匹配的那一行；找不到则插到最前面
          const row = payload.row;
          row.trade_date = row.trade_date || today;
          // 同步内存数组
          const idx = c.rows.findIndex((r) => r.trade_date === row.trade_date);
          if (idx >= 0) {
            // 保留原 change/change_pct（已链式计算过），只更新 OHLCV 与 close
            c.rows[idx] = { ...c.rows[idx], ...row };
          } else {
            c.rows.push(row);
          }
          // 重新计算最新一行的 change（基于上一行 close）
          const last = c.rows[c.rows.length - 1];
          const prev = c.rows[c.rows.length - 2];
          if (last && prev && Number.isFinite(prev.close_value) && prev.close_value !== 0) {
            last.change = last.close_value - prev.close_value;
            last.change_pct = (last.change / prev.close_value) * 100;
          }
          // 局部更新 DOM
          const tr = c.tbody.querySelector(`tr[data-date="${CSS.escape(last.trade_date)}"]`);
          const predPct = predictedPctFor(c, last.trade_date);
          if (tr) {
            tr.innerHTML = rowHtml(last, predPct);
          } else {
            const newTr = document.createElement("tr");
            newTr.dataset.date = last.trade_date;
            newTr.innerHTML = rowHtml(last, predPct);
            c.tbody.insertBefore(newTr, c.tbody.firstChild);
          }
          c.latestClose.textContent = fmtNum(last.close_value);
          c.latestPct.textContent = fmtPct(last.change_pct);
          c.latestPct.className = "latest-pct " + (last.change_pct == null ? "" : last.change_pct >= 0 ? "up" : "down");
          c.latestTime.textContent = `最近更新: ${new Date().toLocaleTimeString("zh-CN")}`;
          // 折线最后一个点
          if (c.chart) {
            const labels = c.chart.data.labels;
            const data = c.chart.data.datasets[0].data;
            if (labels[labels.length - 1] === last.trade_date) {
              data[data.length - 1] = last.close_value;
            } else {
              labels.push(last.trade_date);
              data.push(last.close_value);
            }
            c.chart.update("none");
          }
        } catch (_) {
          /* 单次刷新失败不打断节奏 */
        }
      })
    );
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function startPollingIfApplicable() {
    stopPolling();
    if (!isStockTabActive) return;
    if (!selector.includesToday()) return;
    const ok = await checkTradingDay();
    if (!ok) return;
    // 立即刷一次再起节奏
    refreshToday();
    pollTimer = setInterval(refreshToday, POLL_INTERVAL_MS);
  }

  selector.onChange(async () => {
    await loadAll();
    startPollingIfApplicable();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      stopPolling();
    } else if (document.visibilityState === "visible") {
      startPollingIfApplicable();
    }
  });

  // 暴露 Tab 切换钩子，给 index.html 的 setupTabs 回调
  window.StockTab = {
    onActivate() {
      isStockTabActive = true;
      // 第一次激活才加载 + 启动轮询
      if (!cards.get(TARGETS[0].code).rows.length) {
        loadAll().then(startPollingIfApplicable);
      } else {
        startPollingIfApplicable();
      }
    },
    onDeactivate() {
      isStockTabActive = false;
      stopPolling();
    },
  };
})();
