// Deepseek API 연동.
// 각 팀원의 2주간 업무 기록을 받아 0~100 점수와 평가 코멘트를 돌려준다.
// API 키가 없으면 목(mock) 평가로 폴백한다 (기록 길이/구체성 기반 대략 점수).

const API_URL = "https://api.deepseek.com/chat/completions";

export async function evaluateLogs(members, logs) {
  const key = process.env.DEEPSEEK_API_KEY;
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";

  const entries = members.map((m) => ({
    memberId: m.id,
    name: m.name,
    role: m.role,
    equity: m.equity,
    log: (logs[m.id] || "").trim(),
  }));

  if (!key) {
    return { ...mockEvaluate(entries), mock: true };
  }

  const system = [
    "당신은 스타트업 공동창업 팀의 2주 단위 기여도를 평가하는 냉정하고 공정한 심사관입니다.",
    "각 팀원이 자신의 역할에 맞게 실제로 만들어낸 성과, 구체성, 임팩트를 기준으로 0~100점을 매깁니다.",
    "말만 많고 실질 성과가 없으면 낮게, 구체적 결과물/수치/진전이 있으면 높게 줍니다.",
    "기록이 비어 있거나 '한 일 없음'이면 20점 이하로 줍니다.",
    "반드시 아래 JSON 스키마로만 답하세요.",
  ].join(" ");

  const schema = {
    evaluations: [{ memberId: "string", score: "0-100 정수", summary: "한 줄 요약", reasoning: "평가 근거 2~3문장" }],
    overallComment: "이번 회차 팀 전체에 대한 총평 2~3문장",
  };

  const user = [
    "다음은 이번 2주 회차 각 팀원의 업무 기록입니다. 역할과 기록을 근거로 평가하세요.",
    "",
    JSON.stringify(entries, null, 2),
    "",
    "출력 JSON 스키마:",
    JSON.stringify(schema, null, 2),
  ].join("\n");

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.3,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Deepseek API 오류 (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Deepseek 응답이 비어 있습니다.");

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Deepseek 응답을 JSON으로 파싱하지 못했습니다.");
  }

  const evaluations = normalizeEvaluations(members, parsed.evaluations);
  return {
    evaluations,
    overallComment: parsed.overallComment || "",
    mock: false,
  };
}

function normalizeEvaluations(members, raw) {
  const byId = new Map((raw || []).map((e) => [e.memberId, e]));
  return members.map((m) => {
    const e = byId.get(m.id) || {};
    let score = Number(e.score);
    if (Number.isNaN(score)) score = 50;
    score = Math.min(100, Math.max(0, Math.round(score)));
    return {
      memberId: m.id,
      name: m.name,
      score,
      summary: e.summary || "",
      reasoning: e.reasoning || "",
    };
  });
}

// --- 목 평가 (API 키 없을 때) ---
function mockEvaluate(entries) {
  const evaluations = entries.map((e) => {
    const log = e.log;
    let score;
    let summary;
    if (!log) {
      score = 10;
      summary = "제출된 업무 기록이 없어 기여도를 확인할 수 없습니다.";
    } else {
      const len = Math.min(log.length, 600);
      const hasNumbers = /\d/.test(log) ? 12 : 0;
      const bullets = (log.match(/[\n•\-]/g) || []).length;
      score = Math.round(35 + (len / 600) * 45 + hasNumbers + Math.min(bullets, 5) * 1.5);
      score = Math.min(95, Math.max(20, score));
      summary = "제출된 업무 기록을 기준으로 평가했습니다.";
    }
    return {
      memberId: e.memberId,
      name: e.name,
      score,
      summary,
      reasoning: "업무 기록의 구체성과 분량을 기준으로 산정된 평가입니다.",
    };
  });
  return {
    evaluations,
    overallComment: "제출된 업무 기록을 기준으로 이번 기간 평가를 완료했습니다.",
  };
}
