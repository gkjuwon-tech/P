let STATE = null;
const $ = (sel) => document.querySelector(sel);

async function api(path, opts) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청에 실패했습니다 (${res.status})`);
  return data;
}

function fmtDate(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}. ${p(d.getMonth() + 1)}. ${p(d.getDate())}`;
}

async function load() {
  STATE = await api("/api/state");
  renderEquity();
  renderLogs();
  renderResult(STATE.history[0]);
  renderHistory();
  $("#period-label").textContent = `${STATE.periodIndex}차 평가 진행 중`;
}

function renderEquity() {
  const el = $("#equity-table");
  el.innerHTML = "";
  STATE.members.forEach((m) => {
    const row = document.createElement("div");
    row.className = "eq-row";
    row.innerHTML = `
      <div class="eq-head">
        <span class="eq-id"><span class="eq-name">${esc(m.name)}</span><span class="eq-role">${esc(m.role)}</span></span>
        <span class="eq-pct">${m.equity}%</span>
      </div>
      <div class="eq-track"><div class="eq-fill" style="width:${m.equity}%"></div></div>`;
    el.appendChild(row);
  });
}

function renderLogs() {
  const el = $("#logs");
  el.innerHTML = "";
  STATE.members.forEach((m) => {
    const val = STATE.currentLogs[m.id] || "";
    const item = document.createElement("div");
    item.className = "log-item";
    item.innerHTML = `
      <div class="log-head">
        <span class="log-name">${esc(m.name)}<span class="log-role">${esc(m.role)}</span></span>
        <span class="log-save" data-save="${m.id}"></span>
      </div>
      <textarea data-id="${m.id}" placeholder="이번 평가 기간의 주요 업무와 성과를 작성합니다.">${esc(val)}</textarea>`;
    el.appendChild(item);
  });

  el.querySelectorAll("textarea").forEach((ta) => {
    let timer;
    ta.addEventListener("input", () => {
      clearTimeout(timer);
      const badge = el.querySelector(`[data-save="${ta.dataset.id}"]`);
      badge.textContent = "입력 중";
      timer = setTimeout(async () => {
        try {
          await api("/api/logs", { method: "POST", body: JSON.stringify({ memberId: ta.dataset.id, text: ta.value }) });
          badge.textContent = "저장됨";
          setTimeout(() => (badge.textContent = ""), 1400);
        } catch {
          badge.textContent = "저장 실패";
        }
      }, 600);
    });
  });
}

function changeClass(d) { return d > 0 ? "pos" : d < 0 ? "neg" : "flat"; }
function changeText(d) { return d > 0 ? `+${d}%p` : d < 0 ? `${d}%p` : "0%p"; }

function renderResult(period) {
  const card = $("#result-card");
  if (!period) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");

  const evalById = new Map(period.evaluations.map((e) => [e.memberId, e]));
  const rows = period.adjustments.map((a) => {
    const ev = evalById.get(a.id) || {};
    return `
      <div class="adj-row">
        <div class="adj-left">
          <div class="adj-name">${esc(a.name)}</div>
          <div class="adj-summary">${esc(ev.summary || "")}</div>
        </div>
        <div class="adj-right">
          <div class="adj-meta">평가 ${ev.score ?? "-"} · ${a.before}% → ${a.after}%</div>
          <div class="adj-change ${changeClass(a.delta)}">${changeText(a.delta)}</div>
        </div>
      </div>`;
  }).join("");

  $("#result").innerHTML = `
    <div class="result-date">${esc(period.id)} · ${fmtDate(period.end)}</div>
    ${rows}
    ${period.overallComment ? `<div class="overall">${esc(period.overallComment)}</div>` : ""}`;
}

function renderHistory() {
  const el = $("#history");
  el.innerHTML = "";
  if (!STATE.history.length) {
    el.innerHTML = `<div class="empty">완료된 평가 기록이 없습니다.</div>`;
    return;
  }
  STATE.history.forEach((p) => {
    const item = document.createElement("div");
    item.className = "hist-item";
    const evalById = new Map(p.evaluations.map((e) => [e.memberId, e]));
    const details = p.adjustments.map((a) => {
      const ev = evalById.get(a.id) || {};
      return `<div class="adj-row">
        <div class="adj-left">
          <div class="adj-name">${esc(a.name)}</div>
          <div class="adj-summary">${esc(ev.reasoning || ev.summary || "")}</div>
        </div>
        <div class="adj-right">
          <div class="adj-meta">평가 ${ev.score ?? "-"} · ${a.before}% → ${a.after}%</div>
          <div class="adj-change ${changeClass(a.delta)}">${changeText(a.delta)}</div>
        </div>
      </div>`;
    }).join("");

    item.innerHTML = `
      <div class="hist-head">
        <span class="hist-title">${esc(p.id)}<span class="hist-meta">${fmtDate(p.start)} – ${fmtDate(p.end)}</span></span>
        <span class="hist-toggle">보기</span>
      </div>
      <div class="hist-body">
        ${details}
        ${p.overallComment ? `<div class="overall">${esc(p.overallComment)}</div>` : ""}
      </div>`;
    const toggle = item.querySelector(".hist-toggle");
    item.querySelector(".hist-head").addEventListener("click", () => {
      item.classList.toggle("open");
      toggle.textContent = item.classList.contains("open") ? "닫기" : "보기";
    });
    el.appendChild(item);
  });
}

function collectLogs() {
  const logs = {};
  document.querySelectorAll("#logs textarea").forEach((ta) => { logs[ta.dataset.id] = ta.value; });
  return logs;
}

async function runEvaluation() {
  const btn = $("#evaluate-btn");
  const status = $("#eval-status");
  btn.disabled = true;
  status.textContent = "평가를 진행하고 있습니다.";
  try {
    const { period } = await api("/api/evaluate", { method: "POST", body: JSON.stringify({ logs: collectLogs() }) });
    status.textContent = "완료되었습니다.";
    const afterById = new Map(period.adjustments.map((a) => [a.id, a.after]));
    STATE.members = STATE.members.map((m) => ({ ...m, equity: afterById.has(m.id) ? afterById.get(m.id) : m.equity }));
    STATE.currentLogs = {};
    STATE.history = [period, ...STATE.history];
    STATE.periodIndex = STATE.history.length + 1;
    renderEquity();
    renderLogs();
    renderHistory();
    $("#period-label").textContent = `${STATE.periodIndex}차 평가 진행 중`;
    renderResult(period);
    $("#result-card").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    status.textContent = e.message;
  } finally {
    btn.disabled = false;
    setTimeout(() => (status.textContent = ""), 4000);
  }
}

async function resetAll() {
  if (!confirm("지분과 기록을 초기 상태로 되돌립니다. 계속하시겠습니까?")) return;
  const { members } = await api("/api/reset", { method: "POST" });
  STATE.members = members;
  STATE.currentLogs = {};
  STATE.history = [];
  STATE.periodIndex = 1;
  renderEquity();
  renderLogs();
  renderHistory();
  renderResult(null);
  $("#period-label").textContent = `1차 평가 진행 중`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("#evaluate-btn").addEventListener("click", runEvaluation);
$("#reset-btn").addEventListener("click", resetAll);
load().catch((e) => alert("불러오기에 실패했습니다: " + e.message));
