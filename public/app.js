const COLORS = ["#4f8cff", "#3ecf8e", "#ffb545", "#c46bff", "#ff5d6c", "#3ec8d8"];
let STATE = null;

const $ = (sel) => document.querySelector(sel);

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

function fmtDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

function memberColor(idx) { return COLORS[idx % COLORS.length]; }

async function load() {
  STATE = await api("/api/state");
  renderBadge();
  renderEquity();
  renderLogs();
  renderResult(STATE.history[0]);
  renderHistory();
  $("#period-label").textContent = `${STATE.periodIndex}회차 진행 중`;
}

function renderBadge() {
  const b = $("#mode-badge");
  b.classList.remove("hidden", "mock", "live");
  if (STATE.hasApiKey) {
    b.classList.add("live");
    b.textContent = "✅ Deepseek 실시간 평가 모드";
  } else {
    b.classList.add("mock");
    b.textContent = "⚠️ 목(mock) 평가 모드 — .env에 DEEPSEEK_API_KEY 설정 필요";
  }
}

function renderEquity() {
  const el = $("#equity-bars");
  el.innerHTML = "";
  STATE.members.forEach((m, i) => {
    const row = document.createElement("div");
    row.className = "eq-row";
    row.innerHTML = `
      <div class="eq-top">
        <div><span class="eq-name">${escape(m.name)}</span><span class="eq-role">${escape(m.role)}</span></div>
        <div class="eq-pct">${m.equity}%</div>
      </div>
      <div class="eq-track"><div class="eq-fill" style="width:${m.equity}%;background:${memberColor(i)}"></div></div>`;
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
        <span class="log-name">${escape(m.name)} <span class="eq-role">${escape(m.role)}</span></span>
        <span class="log-save" data-save="${m.id}"></span>
      </div>
      <textarea data-id="${m.id}" placeholder="이번 2주간 한 일을 구체적으로 적어주세요...">${escape(val)}</textarea>`;
    el.appendChild(item);
  });

  el.querySelectorAll("textarea").forEach((ta) => {
    let timer;
    ta.addEventListener("input", () => {
      clearTimeout(timer);
      const badge = el.querySelector(`[data-save="${ta.dataset.id}"]`);
      badge.textContent = "입력 중...";
      timer = setTimeout(async () => {
        try {
          await api("/api/logs", {
            method: "POST",
            body: JSON.stringify({ memberId: ta.dataset.id, text: ta.value }),
          });
          badge.textContent = "저장됨 ✓";
          setTimeout(() => (badge.textContent = ""), 1500);
        } catch (e) {
          badge.textContent = "저장 실패";
        }
      }, 600);
    });
  });
}

function changeClass(delta) {
  if (delta > 0) return "up";
  if (delta < 0) return "down";
  return "flat";
}
function changeText(delta) {
  if (delta > 0) return `▲ +${delta}%p`;
  if (delta < 0) return `▼ ${delta}%p`;
  return "– 0%p";
}

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
          <span class="adj-name">${escape(a.name)}</span>
          <span class="adj-summary">${escape(ev.summary || "")}</span>
        </div>
        <div class="adj-right">
          <div class="adj-score">점수 ${ev.score ?? "-"}점 · ${a.before}% → ${a.after}%</div>
          <div class="adj-change ${changeClass(a.delta)}">${changeText(a.delta)}</div>
        </div>
      </div>`;
  }).join("");

  $("#result").innerHTML = `
    <div class="hist-meta" style="margin-bottom:8px">${period.id} · ${fmtDate(period.end)}${period.mock ? " · 목 모드" : ""}</div>
    ${rows}
    ${period.overallComment ? `<div class="overall">🧠 ${escape(period.overallComment)}</div>` : ""}`;
}

function renderHistory() {
  const el = $("#history");
  el.innerHTML = "";
  if (!STATE.history.length) {
    el.innerHTML = `<div class="empty">아직 완료된 평가 회차가 없습니다.</div>`;
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
          <span class="adj-name">${escape(a.name)}</span>
          <span class="adj-summary">${escape(ev.reasoning || ev.summary || "")}</span>
        </div>
        <div class="adj-right">
          <div class="adj-score">점수 ${ev.score ?? "-"}점 · ${a.before}% → ${a.after}%</div>
          <div class="adj-change ${changeClass(a.delta)}">${changeText(a.delta)}</div>
        </div>
      </div>`;
    }).join("");

    item.innerHTML = `
      <div class="hist-head">
        <span class="hist-title">${p.id} <span class="hist-meta">${fmtDate(p.start)} ~ ${fmtDate(p.end)}${p.mock ? " · 목" : ""}</span></span>
        <span class="hist-meta">▾</span>
      </div>
      <div class="hist-body">
        ${details}
        ${p.overallComment ? `<div class="overall">🧠 ${escape(p.overallComment)}</div>` : ""}
      </div>`;
    item.querySelector(".hist-head").addEventListener("click", () => item.classList.toggle("open"));
    el.appendChild(item);
  });
}

async function runEvaluation() {
  const btn = $("#evaluate-btn");
  const status = $("#eval-status");
  btn.disabled = true;
  status.textContent = "AI가 평가 중입니다... (최대 30초)";
  try {
    const { period } = await api("/api/evaluate", { method: "POST" });
    status.textContent = "완료 ✓";
    await load();
    renderResult(period);
    $("#result-card").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (e) {
    status.textContent = "❌ " + e.message;
  } finally {
    btn.disabled = false;
    setTimeout(() => (status.textContent = ""), 4000);
  }
}

async function resetAll() {
  if (!confirm("지분·기록·히스토리를 모두 초기 상태(40/20/20/20)로 되돌립니다. 계속할까요?")) return;
  await api("/api/reset", { method: "POST" });
  await load();
}

function escape(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("#evaluate-btn").addEventListener("click", runEvaluation);
$("#reset-btn").addEventListener("click", resetAll);
load().catch((e) => alert("로드 실패: " + e.message));
