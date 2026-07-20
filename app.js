import "dotenv/config";
import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getState, saveLog, commitEvaluation, resetAll } from "./lib/store.js";
import { evaluateLogs } from "./lib/deepseek.js";
import { computeAdjustments } from "./lib/equity.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(join(__dirname, "public")));

  const wrap = (fn) => (req, res) =>
    fn(req, res).catch((err) => {
      console.error(err);
      res.status(500).json({ error: err.message || "서버 오류" });
    });

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

  app.post("/api/logs", wrap(async (req, res) => {
    const { memberId, text } = req.body || {};
    await saveLog(memberId, text);
    res.json({ ok: true });
  }));

  // 클라이언트가 현재 textarea의 최신 기록을 함께 보낸다 (Blob 전파 지연과 무관하게 정확).
  app.post("/api/evaluate", wrap(async (req, res) => {
    const s = await getState();
    const clientLogs = (req.body && req.body.logs) || {};
    // 클라이언트 기록 우선, 없으면 저장된 초안 사용
    const logs = {};
    for (const m of s.members) {
      const t = (clientLogs[m.id] ?? s.currentLogs[m.id] ?? "").toString();
      if (t.trim()) logs[m.id] = t;
    }
    if (Object.keys(logs).length === 0) {
      return res.status(400).json({ error: "평가할 업무 기록이 하나도 없습니다. 먼저 기록을 입력하세요." });
    }

    const { evaluations, overallComment, mock } = await evaluateLogs(s.members, logs);
    const adjustments = computeAdjustments(s.members, evaluations);
    const { period } = await commitEvaluation({ logs, evaluations, adjustments, overallComment, mock });

    res.json({ ok: true, period });
  }));

  app.post("/api/reset", wrap(async (_req, res) => {
    const s = await resetAll();
    res.json({ ok: true, members: s.members });
  }));

  return app;
}

// Vercel 및 로컬 공용: 유효한 default export (Express 앱 = 함수)
const app = createApp();
export default app;
