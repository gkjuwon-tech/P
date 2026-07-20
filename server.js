import "dotenv/config";
import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getState, saveLog, commitEvaluation, resetAll } from "./lib/store.js";
import { evaluateLogs } from "./lib/deepseek.js";
import { computeAdjustments } from "./lib/equity.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(join(__dirname, "public")));

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: err.message || "서버 오류" });
});

// 현재 상태 (팀원, 지분, 진행 중 기록, 히스토리)
app.get("/api/state", wrap(async (_req, res) => {
  const s = await getState();
  res.json({
    members: s.members,
    currentLogs: s.currentLogs,
    currentPeriodStart: s.currentPeriodStart,
    periodIndex: s.history.length + 1,
    history: s.history,
    hasApiKey: !!process.env.DEEPSEEK_API_KEY,
  });
}));

// 개별 팀원 업무 기록 저장
app.post("/api/logs", wrap(async (req, res) => {
  const { memberId, text } = req.body || {};
  const s = await saveLog(memberId, text);
  res.json({ ok: true, currentLogs: s.currentLogs });
}));

// AI 평가 실행 → 지분 조정안 계산 → 회차 마감 & 반영
app.post("/api/evaluate", wrap(async (req, res) => {
  const s = await getState();
  const filled = s.members.filter((m) => (s.currentLogs[m.id] || "").trim().length > 0);
  if (filled.length === 0) {
    return res.status(400).json({ error: "평가할 업무 기록이 하나도 없습니다. 먼저 기록을 저장하세요." });
  }

  const { evaluations, overallComment, mock } = await evaluateLogs(s.members, s.currentLogs);
  const adjustments = computeAdjustments(s.members, evaluations);
  const { period } = await commitEvaluation({ evaluations, adjustments, overallComment, mock });

  res.json({ ok: true, period });
}));

// 전체 초기화 (지분/기록/히스토리 리셋)
app.post("/api/reset", wrap(async (_req, res) => {
  const s = await resetAll();
  res.json({ ok: true, members: s.members });
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  🟢 지분 베스팅 앱 실행 중: http://localhost:${PORT}`);
  if (!process.env.DEEPSEEK_API_KEY) {
    console.log("  ⚠️  DEEPSEEK_API_KEY 미설정 → 목(mock) 평가 모드로 동작합니다.\n");
  } else {
    console.log("  ✅ Deepseek API 연동됨.\n");
  }
});
