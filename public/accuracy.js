// 预测准确率 Tab：方向命中率 + 区间命中率 + 平均绝对误差 MAE + 明细表
(function () {
  "use strict";
  const { escapeHtml } = window.AppCommon;

  const TARGETS = [
    { code: "000001.SH", name: "上证指数" },
    { code: "399006.SZ", name: "创业板指" },
  ];

  const root = document.querySelector('[data-panel="accuracy"]');
  if (!root) return;

  // ---------- DOM 骨架 ----------
  const wrap = document.createElement("div");
  wrap.className = "acc-wrap";
  wrap.innerHTML = `
    <div class="acc-toolbar">
      <label>时间窗口：
        <select data-role="days">
          <option value="7">近 7 天</option>
          <option value="30" selected>近 30 天</option>
          <option value="60">近 60 天</option>
          <option value="90">近 90 天</option>
          <option value="180">近 180 天</option>
        </select>
      </label>
      <label>指数：
        <select data-role="index">
          <option value="">全部</option>
          <option value="000001.SH">上证指数</option>
          <option value="399006.SZ">创业板指</option>
        </select>
      </label>
      <button data-role="refresh">重新比对</button>
      <button data-role="reload">刷新数据</button>
    </div>
    <div class="acc-stats" data-role="stats"></div>
    <div class="acc-reviews-table-wrap">
      <table class="acc-reviews-table">
        <thead>
          <tr>
            <th>指数</th>
            <th>目标日</th>
            <th>预测方向</th>
            <th>预测幅度</th>
            <th>区间 (low~high)</th>
            <th>实际幅度</th>
            <th>方向命中</th>
            <th>区间命中</th>
            <th>幅度误差</th>
            <th>置信度</th>
          </tr>
        </thead>
        <tbody data-role="tbody"></tbody>
      </table>
    </div>
  `;
  root.appendChild(wrap);

  const daysSel = wrap.querySelector('[data-role="days"]');
  const indexSel = wrap.querySelector('[data-role="index"]');
  const statsBox = wrap.querySelector('[data-role="stats"]');
  const tbody = wrap.querySelector('[data-role="tbody"]');
  const refreshBtn = wrap.querySelector('[data-role="refresh"]');
  const reloadBtn = wrap.querySelector('[data-role="reload"]');

  // ---------- helpers ----------
  function fmtPct(v) {
    if (v == null || !Number.isFinite(v)) return "-";
    return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  }
  function fmtRatio(v) {
    if (v == null || !Number.isFinite(v)) return "-";
    return (v * 100).toFixed(1) + "%";
  }
  function dirText(d) {
    if (d === "up") return "买涨";
    if (d === "down") return "买跌";
    return "-";
  }

  function renderStats(stats) {
    statsBox.innerHTML = stats
      .map((s) => {
        const dirAcc = s.direction_accuracy;
        const dirCls = dirAcc == null ? "" : dirAcc >= 0.6 ? "good" : dirAcc < 0.5 ? "bad" : "";
        const rangeCls =
          s.range_accuracy == null ? "" : s.range_accuracy >= 0.6 ? "good" : s.range_accuracy < 0.5 ? "bad" : "";
        const maeCls = s.mean_abs_error == null ? "" : s.mean_abs_error < 0.5 ? "good" : s.mean_abs_error > 1.0 ? "bad" : "";
        return `
          <div class="acc-stat-card">
            <div class="acc-stat-name">${escapeHtml(s.index_name || s.index_code)}</div>
            <div class="acc-stat-row">样本数 <b>${s.total}</b></div>
            <div class="acc-stat-row">方向命中率 <b class="${dirCls}">${fmtRatio(dirAcc)}</b></div>
            <div class="acc-stat-row">区间命中率 <b class="${rangeCls}">${fmtRatio(s.range_accuracy)} <span style="font-size:11px;color:#999;">(${s.range_hits}/${s.range_total})</span></b></div>
            <div class="acc-stat-row">平均绝对误差 <b class="${maeCls}">${s.mean_abs_error == null ? "-" : s.mean_abs_error.toFixed(2) + " pp"}</b></div>
          </div>
        `;
      })
      .join("");
  }

  function renderReviews(rows) {
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:#888;padding:20px;">暂无回顾数据。请先让系统采集预测，并在收盘后点击"重新比对"。</td></tr>`;
      return;
    }
    const indexName = (code) => {
      const t = TARGETS.find((x) => x.code === code);
      return t ? t.name : code;
    };
    tbody.innerHTML = rows
      .map((r) => {
        const predDirClass = r.predicted_direction === "up" ? "up" : "down";
        const actDirClass = r.actual_pct == null ? "" : r.actual_pct >= 0 ? "up" : "down";
        const dirHitClass = r.direction_hit == null ? "" : r.direction_hit === 1 ? "hit" : "miss";
        const rangeHitClass = r.range_hit == null ? "" : r.range_hit === 1 ? "hit" : "miss";
        const rangeText =
          r.predicted_low == null || r.predicted_high == null
            ? "-"
            : `${fmtPct(r.predicted_low)} ~ ${fmtPct(r.predicted_high)}`;
        return `
          <tr>
            <td>${escapeHtml(indexName(r.index_code))}</td>
            <td>${escapeHtml(r.target_date)}</td>
            <td class="${predDirClass}">${dirText(r.predicted_direction)}</td>
            <td class="${predDirClass}">${fmtPct(r.predicted_pct)}</td>
            <td>${rangeText}</td>
            <td class="${actDirClass}">${fmtPct(r.actual_pct)}</td>
            <td class="${dirHitClass}">${r.direction_hit == null ? "-" : r.direction_hit === 1 ? "✓" : "✗"}</td>
            <td class="${rangeHitClass}">${r.range_hit == null ? "-" : r.range_hit === 1 ? "✓" : "✗"}</td>
            <td>${r.pct_abs_error == null ? "-" : r.pct_abs_error.toFixed(2)}</td>
            <td>${r.confidence == null ? "-" : (r.confidence * 100).toFixed(0) + "%"}</td>
          </tr>
        `;
      })
      .join("");
  }

  // ---------- 数据加载 ----------
  async function loadAll() {
    const days = daysSel.value;
    const idx = indexSel.value;

    try {
      const accUrl = idx
        ? `/api/stock/accuracy?days=${days}&indexCode=${encodeURIComponent(idx)}`
        : `/api/stock/accuracy?days=${days}`;
      const accRes = await fetch(accUrl);
      if (accRes.ok) {
        const data = await accRes.json();
        renderStats(data.stats || []);
      }
    } catch (_) {
      statsBox.innerHTML = `<div class="acc-stat-card" style="color:#c0392b;">准确率加载失败</div>`;
    }

    try {
      const codes = idx ? [idx] : TARGETS.map((t) => t.code);
      const all = [];
      for (const code of codes) {
        const res = await fetch(`/api/stock/reviews?indexCode=${encodeURIComponent(code)}&days=${days}`);
        if (!res.ok) continue;
        const data = await res.json();
        for (const row of data.rows || []) all.push(row);
      }
      // 按 target_date 倒序
      all.sort((a, b) => (a.target_date < b.target_date ? 1 : a.target_date > b.target_date ? -1 : 0));
      renderReviews(all);
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:#c0392b;padding:20px;">加载明细失败</td></tr>`;
    }
  }

  async function refreshReviews() {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "比对中...";
    try {
      const days = daysSel.value;
      await fetch(`/api/stock/reviews/refresh?days=${days}`, { method: "POST" });
      await loadAll();
    } catch (_) {
      // 静默
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = "重新比对";
    }
  }

  daysSel.addEventListener("change", loadAll);
  indexSel.addEventListener("change", loadAll);
  reloadBtn.addEventListener("click", loadAll);
  refreshBtn.addEventListener("click", refreshReviews);

  let loaded = false;
  window.AccuracyTab = {
    onActivate() {
      if (!loaded) {
        loaded = true;
        loadAll();
      }
    },
  };
})();
