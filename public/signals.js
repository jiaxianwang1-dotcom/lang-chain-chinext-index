// 多信号面板 Tab：把后端 /api/stock/signals 的 7 大类数据可视化。
(function () {
  "use strict";
  const { escapeHtml } = window.AppCommon;

  const root = document.querySelector('[data-panel="signals"]');
  if (!root) return;

  const wrap = document.createElement("div");
  wrap.className = "sig-wrap";
  wrap.innerHTML = `
    <div class="sig-toolbar">
      <button data-role="reload">刷新数据</button>
      <button class="secondary" data-role="ingest" title="同步触发：今日行情 / 涨跌广度 / 板块 / 外资代理 / 股指期货 / 龙虎榜 / 宏观种子（不含两融 T+1 与新闻 LLM 分类）">即时采集全量</button>
      <span class="sig-asof" data-role="asof"></span>
    </div>
    <div class="sig-grid" data-role="grid"></div>
  `;
  root.appendChild(wrap);

  const grid = wrap.querySelector('[data-role="grid"]');
  const asofEl = wrap.querySelector('[data-role="asof"]');
  const reloadBtn = wrap.querySelector('[data-role="reload"]');
  const ingestBtn = wrap.querySelector('[data-role="ingest"]');

  // ============ helpers ============
  function fmtNum(v, digits = 2) {
    if (v == null || !Number.isFinite(v)) return "-";
    return Number(v).toFixed(digits);
  }
  function fmtPct(v) {
    if (v == null || !Number.isFinite(v)) return "-";
    return (v >= 0 ? "+" : "") + Number(v).toFixed(2) + "%";
  }
  function fmtSignedYi(v) {
    // 输入：元，输出：±X.XX 亿元
    if (v == null || !Number.isFinite(v)) return "-";
    return (v >= 0 ? "+" : "") + (v / 1e8).toFixed(2) + "亿";
  }
  function pctClass(v) {
    if (v == null || !Number.isFinite(v)) return "";
    return v >= 0 ? "up" : "down";
  }
  function dirTag(label) {
    if (label === "up") return `<span class="sig-tag up">${escapeHtml(label)}</span>`;
    if (label === "down") return `<span class="sig-tag down">${escapeHtml(label)}</span>`;
    return `<span class="sig-tag neutral">${escapeHtml(label)}</span>`;
  }
  function emptyHint(text) {
    return `<div class="sig-empty">${escapeHtml(text)}</div>`;
  }

  // ============ 渲染：宏观日历 ============
  function renderMacro(events, asOf) {
    if (!events || events.length === 0) {
      return emptyHint("近邻无重大宏观事件，或种子未写入");
    }
    const items = events
      .slice(0, 14)
      .map((e) => {
        const rel =
          e.event_date === asOf
            ? "(今日)"
            : e.event_date < asOf
            ? "(已发布)"
            : "(待发布)";
        const importanceClass = `sig-tag imp-${e.importance}`;
        const importance = "★".repeat(e.importance);
        const meta = e.actual || e.expectation || "";
        return `
          <div class="sig-event">
            <span class="sig-event-date">${escapeHtml(e.event_date)}<span class="sig-event-rel">${escapeHtml(rel)}</span></span>
            <span class="${importanceClass}" title="importance=${e.importance}">${escapeHtml(importance)}</span>
            <span>
              <span class="sig-event-name">[${escapeHtml(e.country || "-")}] ${escapeHtml(e.event_name)}</span>
              ${meta ? `<span class="sig-event-meta"> · ${escapeHtml(meta)}</span>` : ""}
            </span>
          </div>
        `;
      })
      .join("");
    return `<div class="sig-event-list">${items}</div>`;
  }

  // ============ 渲染：外资代理 ============
  const PROXY_LABEL = {
    CNH: "离岸人民币 CNH",
    HSI: "恒生指数 HSI",
    HSTECH: "恒生科技 HSTECH",
    "510300": "沪深300 ETF (510300)",
    "159915": "创业板 ETF (159915)",
    A50: "富时A50期货",
    KWEB: "中概互联网ETF (KWEB)",
  };

  function renderExternal(latest, cnhRecent) {
    if (!latest || latest.length === 0) {
      return emptyHint("外资代理数据为空。点击「即时采集」可拉取实时数据。");
    }
    const order = ["CNH", "HSI", "HSTECH", "510300", "159915", "A50", "KWEB"];
    const byKey = new Map(latest.map((r) => [r.symbol, r]));
    const rows = order
      .filter((k) => byKey.has(k))
      .map((k) => {
        const r = byKey.get(k);
        const digits = k === "CNH" ? 4 : 2;
        return `
          <div class="sig-row">
            <span>${escapeHtml(PROXY_LABEL[k] || k)}</span>
            <span>
              <b>${fmtNum(r.close_value, digits)}</b>
              <b class="${pctClass(r.change_pct)}" style="margin-left:8px;">${fmtPct(r.change_pct)}</b>
            </span>
          </div>
        `;
      })
      .join("");

    let cnhSeq = "";
    if (cnhRecent && cnhRecent.length >= 2) {
      const seq = cnhRecent
        .slice(-5)
        .map((r) => `${r.trade_date.slice(5)}=${fmtNum(r.close_value, 4)}`)
        .join(" → ");
      cnhSeq = `
        <div class="sig-row" style="margin-top:6px; padding-top:6px; border-top:1px dashed #f0f0f0;">
          <span style="color:#888;">CNH 近 5 日</span>
          <span style="font-family:SFMono-Regular,monospace; font-size:11px; color:#666;">${escapeHtml(seq)}</span>
        </div>
      `;
    }
    return rows + cnhSeq + `<div style="margin-top:6px; font-size:11px; color:#aaa;">※ CNH 走弱 = 外资进场成本下降；恒指领涨往往传导到 A 股次日。北向资金数据 2024-08 起已停止公开。</div>`;
  }

  // ============ 渲染：股指期货升贴水 ============
  const FUTURES_LABEL = {
    IF: "IF · 沪深300",
    IH: "IH · 上证50",
    IC: "IC · 中证500",
    IM: "IM · 中证1000",
  };
  function futuresSignal(basisPct) {
    if (basisPct == null || !Number.isFinite(basisPct)) return { text: "中性", cls: "neutral" };
    if (basisPct > 0.3) return { text: "明显升水·看多", cls: "up" };
    if (basisPct < -0.8) return { text: "深度贴水·看空", cls: "down" };
    if (basisPct < -0.3) return { text: "温和贴水·谨慎", cls: "down" };
    return { text: "中性", cls: "neutral" };
  }

  function renderFutures(rows) {
    if (!rows || rows.length === 0) {
      return emptyHint("股指期货数据为空。点击「即时采集」可拉取。");
    }
    const body = rows
      .map((r) => {
        const sig = futuresSignal(r.basis_pct);
        const basisClass = pctClass(r.basis);
        return `
          <tr>
            <td>${escapeHtml(FUTURES_LABEL[r.contract] || r.contract)}</td>
            <td>${escapeHtml(r.contract_code || "-")}</td>
            <td>${fmtNum(r.futures_close)}</td>
            <td>${fmtNum(r.spot_close)}</td>
            <td class="${basisClass}">${r.basis == null ? "-" : (r.basis >= 0 ? "+" : "") + r.basis.toFixed(2)}</td>
            <td class="${basisClass}">${r.basis_pct == null ? "-" : (r.basis_pct >= 0 ? "+" : "") + r.basis_pct.toFixed(3) + "%"}</td>
            <td><span class="sig-tag ${sig.cls}">${escapeHtml(sig.text)}</span></td>
          </tr>
        `;
      })
      .join("");
    return `
      <table class="sig-mini-table">
        <thead>
          <tr>
            <th>合约</th><th>代码</th><th>期货</th><th>现货</th><th>basis</th><th>basis %</th><th>信号</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    `;
  }

  // ============ 渲染：两融 ============
  function renderMargin(rows) {
    if (!rows || rows.length === 0) {
      return emptyHint(
        "无数据。两融由交易所 T 日盘后 18:00+ 公布；盘中查询最多能拿到 T-1。点击「即时采集」可主动拉取。"
      );
    }
    const tail = rows.slice(-7);
    const body = tail
      .map((r) => {
        const net = r.finance_net;
        return `
          <tr>
            <td>${escapeHtml(r.trade_date)}</td>
            <td>${r.finance_balance == null ? "-" : (r.finance_balance / 1e8).toFixed(0)}</td>
            <td class="${pctClass(net)}">${net == null ? "-" : fmtSignedYi(net)}</td>
            <td>${r.short_balance == null ? "-" : (r.short_balance / 1e8).toFixed(0)}</td>
          </tr>
        `;
      })
      .join("");
    const sum = tail.reduce((a, r) => a + (r.finance_net ?? 0), 0);
    return `
      <table class="sig-mini-table">
        <thead><tr><th>日期</th><th>融资余额(亿)</th><th>融资净买入</th><th>融券余额(亿)</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
      <div class="sig-row" style="margin-top:6px;">
        <span>近 ${tail.length} 日累计融资净买入</span>
        <b class="${pctClass(sum)}">${fmtSignedYi(sum)}元</b>
      </div>
    `;
  }

  // ============ 渲染：市场广度 ============
  function renderBreadth(rows) {
    if (!rows || rows.length === 0) return emptyHint("市场广度数据为空");
    const byDate = new Map();
    for (const r of rows) {
      const arr = byDate.get(r.trade_date) || [];
      arr.push(r);
      byDate.set(r.trade_date, arr);
    }
    const dates = [...byDate.keys()].sort().slice(-5);
    const body = dates
      .map((d) => {
        const g = byDate.get(d) || [];
        const fmt = (scope) => {
          const x = g.find((y) => y.scope === scope);
          if (!x) return "-";
          return `${x.advancing ?? "-"}/${x.declining ?? "-"}/${x.limit_up ?? "-"}`;
        };
        return `
          <tr>
            <td>${escapeHtml(d)}</td>
            <td>${fmt("sse")}</td>
            <td>${fmt("szse")}</td>
            <td>${fmt("chinext")}</td>
          </tr>
        `;
      })
      .join("");
    return `
      <table class="sig-mini-table">
        <thead><tr><th>日期</th><th>上证(涨/跌/涨停)</th><th>深证(涨/跌/涨停)</th><th>创业板(涨/跌/涨停)</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    `;
  }

  // ============ 渲染：板块轮动 ============
  function renderSector(rows) {
    if (!rows || rows.length === 0) return emptyHint("板块数据为空");
    const top = rows.filter((r) => r.rank_type === "top5").sort((a, b) => a.rank_pos - b.rank_pos);
    const bot = rows.filter((r) => r.rank_type === "bottom5").sort((a, b) => a.rank_pos - b.rank_pos);
    const renderList = (list, klass) =>
      list
        .map(
          (r) => `
        <div class="sig-row">
          <span>${r.rank_pos}. ${escapeHtml(r.sector_name)}</span>
          <b class="${klass}">${fmtPct(r.change_pct)}</b>
        </div>
      `
        )
        .join("");
    return `
      <div style="font-size:11px;color:#c0392b;margin-bottom:2px;font-weight:500;">涨幅 Top 5</div>
      ${renderList(top, "up")}
      <div style="font-size:11px;color:#27ae60;margin-top:10px;margin-bottom:2px;font-weight:500;">跌幅 Bottom 5</div>
      ${renderList(bot, "down")}
    `;
  }

  // ============ 渲染：龙虎榜 ============
  function renderLhb(lhb) {
    if (!lhb || lhb.total_count === 0) {
      return emptyHint(
        "无数据。龙虎榜由交易所 T 日盘后 17:30+ 公布；盘中查询只会拿到 T-1。点击「即时采集」可主动拉取。"
      );
    }
    const top3 = (lhb.top_3_by_net_amount || [])
      .map(
        (t) => `
          <div class="sig-row">
            <span>${escapeHtml(t.code)} ${escapeHtml(t.name)}</span>
            <b class="${pctClass(t.net_amount)}">${fmtSignedYi(t.net_amount)}</b>
          </div>
          ${t.explanation ? `<div style="font-size:11px;color:#888;margin-left:8px;">↳ ${escapeHtml(t.explanation.slice(0, 60))}</div>` : ""}
        `
      )
      .join("");
    return `
      <div class="sig-row">
        <span>上榜只数</span><b>${lhb.total_count}</b>
      </div>
      <div class="sig-row">
        <span>净买入合计</span><b class="up">${fmtSignedYi(lhb.net_buy_total)}元</b>
      </div>
      <div class="sig-row">
        <span>净卖出合计</span><b class="down">${fmtSignedYi(lhb.net_sell_total)}元</b>
      </div>
      <div style="margin-top:8px;font-size:11px;color:#888;font-weight:500;">Top 3 个股（按 |净额|）</div>
      ${top3}
    `;
  }

  // ============ 渲染：新闻事件（不限当日，含日期列，创业板高亮）============
  function renderNews(events) {
    if (!events || events.length === 0) return emptyHint("暂无已分类新闻事件");
    return events
      .map((e) => {
        const sentLabel =
          e.sentiment == null
            ? "neutral"
            : e.sentiment > 0.05
            ? "up"
            : e.sentiment < -0.05
            ? "down"
            : "neutral";
        const sentText =
          e.sentiment == null ? "0" : (e.sentiment >= 0 ? "+" : "") + e.sentiment.toFixed(2);
        const isChiNext =
          e.impact_indices === "broad" ||
          (e.impact_indices && e.impact_indices.includes("399006.SZ"));
        return `
          <div class="sig-news-item ${isChiNext ? "chi-next" : ""}">
            <div class="sig-news-head">
              <span class="sig-tag ${sentLabel}">${escapeHtml(sentText)}</span>
              <span style="font-size:11px;color:#888;">${escapeHtml(e.as_of_date ?? "-")} · [${escapeHtml(e.category || "other")}] ${escapeHtml(e.impact_indices || "broad")}</span>
            </div>
            <div class="sig-news-title">${escapeHtml(e.title)}</div>
            ${e.rationale ? `<div class="sig-news-rationale">↳ ${escapeHtml(e.rationale.slice(0, 120))}</div>` : ""}
          </div>
        `;
      })
      .join("");
  }

  // ============ 主渲染 ============
  function render(payload) {
    asofEl.textContent = `截至: ${payload.asOfDate}`;
    const cards = [
      {
        title: "宏观日历",
        hint: "近 7 天 / 后 5 天",
        body: renderMacro(payload.macro, payload.asOfDate),
      },
      {
        title: "外资情绪代理",
        hint: "CNH / 港股 / ETF",
        body: renderExternal(payload.external.latest, payload.external.cnhRecent),
      },
      {
        title: "股指期货升贴水",
        hint: "IF / IH / IC / IM",
        body: renderFutures(payload.futures),
      },
      {
        title: "资金面（两融余额）",
        hint: "T+1 滞后",
        body: renderMargin(payload.margin),
      },
      {
        title: "市场广度",
        hint: "近 5 个交易日",
        body: renderBreadth(payload.breadth),
      },
      {
        title: "板块轮动",
        hint: "当日涨/跌幅榜",
        body: renderSector(payload.sector),
      },
      {
        title: "龙虎榜",
        hint: "全市场聚合",
        body: renderLhb(payload.lhb),
      },
      {
        title: "新闻事件",
        hint: "近期已分类",
        body: renderNews(payload.news),
      },
    ];
    grid.innerHTML = cards
      .map(
        (c) => `
          <div class="sig-card">
            <div class="sig-card-title">
              <span>${escapeHtml(c.title)}</span>
              <span class="sig-card-hint">${escapeHtml(c.hint)}</span>
            </div>
            <div class="sig-card-body">${c.body}</div>
          </div>
        `
      )
      .join("");
  }

  async function loadAll() {
    grid.innerHTML = `<div class="sig-card"><div class="sig-card-body sig-empty">加载中...</div></div>`;
    try {
      const res = await fetch("/api/stock/signals");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      render(payload);
    } catch (e) {
      grid.innerHTML = `<div class="sig-card"><div class="sig-card-body" style="color:#c0392b;">加载失败：${escapeHtml(e.message || String(e))}</div></div>`;
    }
  }

  async function ingestNow() {
    ingestBtn.disabled = true;
    ingestBtn.textContent = "采集中...";
    try {
      await fetch("/api/stock/signals/refresh", { method: "POST" });
      await loadAll();
    } catch (_) {
      /* ignore */
    } finally {
      ingestBtn.disabled = false;
      ingestBtn.textContent = "即时采集全量";
    }
  }

  reloadBtn.addEventListener("click", loadAll);
  ingestBtn.addEventListener("click", ingestNow);

  let loaded = false;
  window.SignalsTab = {
    onActivate() {
      if (!loaded) {
        loaded = true;
        loadAll();
      }
    },
  };
})();
