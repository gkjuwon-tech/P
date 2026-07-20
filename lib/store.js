// 아주 단순한 JSON 파일 기반 저장소.
// 작은 팀 도구용이라 별도 DB 없이 파일 하나로 상태를 관리한다.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const DATA_FILE = join(DATA_DIR, "data.json");

// 초기 팀 구성 (요청 기준)
const SEED = {
  members: [
    { id: "haju", name: "하주원", role: "대표 · 기획/개발", equity: 40 },
    { id: "leejy", name: "이주영", role: "영업", equity: 20 },
    { id: "ohjs", name: "오준서", role: "투자유치", equity: 20 },
    { id: "leegh", name: "이건희", role: "재무관리", equity: 20 },
  ],
  // 진행 중인 이번 회차의 각자 업무 기록 { memberId: text }
  currentLogs: {},
  currentPeriodStart: new Date().toISOString(),
  // 완료된 평가 회차 기록
  history: [],
};

let cache = null;

async function ensure() {
  if (cache) return cache;
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  if (existsSync(DATA_FILE)) {
    cache = JSON.parse(await readFile(DATA_FILE, "utf8"));
  } else {
    cache = structuredClone(SEED);
    await persist();
  }
  return cache;
}

async function persist() {
  await writeFile(DATA_FILE, JSON.stringify(cache, null, 2), "utf8");
}

export async function getState() {
  return ensure();
}

export async function saveLog(memberId, text) {
  const s = await ensure();
  if (!s.members.find((m) => m.id === memberId)) {
    throw new Error("존재하지 않는 팀원입니다.");
  }
  s.currentLogs[memberId] = String(text ?? "");
  await persist();
  return s;
}

// 평가 결과를 반영하고 회차를 마감한다.
export async function commitEvaluation({ evaluations, adjustments, overallComment, mock }) {
  const s = await ensure();

  const period = {
    id: `P${s.history.length + 1}`,
    index: s.history.length + 1,
    start: s.currentPeriodStart,
    end: new Date().toISOString(),
    logs: { ...s.currentLogs },
    evaluations,
    adjustments,
    overallComment: overallComment ?? "",
    mock: !!mock,
  };

  // 지분 반영
  const afterById = new Map(adjustments.map((a) => [a.id, a.after]));
  s.members = s.members.map((m) => ({
    ...m,
    equity: afterById.has(m.id) ? afterById.get(m.id) : m.equity,
  }));

  s.history.unshift(period); // 최신이 앞으로
  s.currentLogs = {};
  s.currentPeriodStart = new Date().toISOString();

  await persist();
  return { state: s, period };
}

export async function resetAll() {
  cache = structuredClone(SEED);
  cache.currentPeriodStart = new Date().toISOString();
  await persist();
  return cache;
}
