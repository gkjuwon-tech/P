// 상태 저장소.
// - 로컬 개발: data/ 폴더의 JSON 파일들
// - Vercel 배포: Vercel Blob (BLOB_READ_WRITE_TOKEN 존재 시)
//
// Blob은 같은 경로 덮어쓰기 전파에 지연이 있고, 한 파일에 모든 걸 담아
// 읽기-수정-쓰기를 하면 동시/연속 저장 시 서로 덮어써 유실된다.
// 그래서 키를 분리한다:
//   - state.json            : members(지분) / currentPeriodStart / history  (평가·초기화 때만 기록)
//   - draft-<memberId>.json : 팀원별 진행 중 업무 기록 초안 (해당 팀원 저장 시에만 기록)
// 평가 시에는 클라이언트가 보낸 최신 기록을 신뢰하므로 초안 저장은 새로고침 복구용이다.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const useBlob = !!process.env.BLOB_READ_WRITE_TOKEN;

const STATE_KEY = "state.json";
const draftKey = (id) => `draft-${id}.json`;

const SEED_MEMBERS = [
  { id: "haju", name: "하주원", role: "대표 · 기획/개발", equity: 40 },
  { id: "leejy", name: "이주영", role: "영업", equity: 20 },
  { id: "ohjs", name: "오준서", role: "투자유치", equity: 20 },
  { id: "leegh", name: "이건희", role: "재무관리", equity: 20 },
];
const seedState = () => ({
  members: structuredClone(SEED_MEMBERS),
  currentPeriodStart: new Date().toISOString(),
  history: [],
});

// ---------- 백엔드: 로컬 파일 ----------
async function ensureDir() {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
}
async function fileReadJson(name) {
  const p = join(DATA_DIR, name);
  if (!existsSync(p)) return null;
  return JSON.parse(await readFile(p, "utf8"));
}
async function fileWriteJson(name, obj) {
  await ensureDir();
  await writeFile(join(DATA_DIR, name), JSON.stringify(obj, null, 2), "utf8");
}
async function fileListNames() {
  await ensureDir();
  return readdir(DATA_DIR);
}

// ---------- 백엔드: Vercel Blob ----------
async function blobListMap() {
  const { list } = await import("@vercel/blob");
  const { blobs } = await list({ limit: 1000 });
  const m = new Map();
  for (const b of blobs) m.set(b.pathname, b.url);
  return m;
}
async function blobReadJson(name, urlMap) {
  const map = urlMap || (await blobListMap());
  const url = map.get(name);
  if (!url) return null;
  const res = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}
async function blobWriteJson(name, obj) {
  const { put } = await import("@vercel/blob");
  await put(name, JSON.stringify(obj, null, 2), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
  });
}

// ---------- 공통 ----------
async function readState(urlMap) {
  const s = useBlob ? await blobReadJson(STATE_KEY, urlMap) : await fileReadJson(STATE_KEY);
  if (!s) {
    const fresh = seedState();
    await writeState(fresh);
    return fresh;
  }
  return s;
}
async function writeState(s) {
  return useBlob ? blobWriteJson(STATE_KEY, s) : fileWriteJson(STATE_KEY, s);
}
async function readDraft(id, urlMap) {
  const d = useBlob ? await blobReadJson(draftKey(id), urlMap) : await fileReadJson(draftKey(id));
  return d?.text ?? "";
}
async function writeDraft(id, text) {
  const obj = { text: String(text ?? "") };
  return useBlob ? blobWriteJson(draftKey(id), obj) : fileWriteJson(draftKey(id), obj);
}

// ---------- 공개 API ----------
export async function getState() {
  const urlMap = useBlob ? await blobListMap() : null;
  const s = await readState(urlMap);
  const currentLogs = {};
  for (const m of s.members) {
    const t = await readDraft(m.id, urlMap);
    if (t) currentLogs[m.id] = t;
  }
  return { ...s, currentLogs };
}

export async function saveLog(memberId, text) {
  const s = await readState();
  if (!s.members.find((m) => m.id === memberId)) {
    throw new Error("존재하지 않는 팀원입니다.");
  }
  await writeDraft(memberId, text);
  return { ok: true };
}

// logs: 클라이언트가 보낸 { memberId: text }. 신뢰 소스.
export async function commitEvaluation({ logs, evaluations, adjustments, overallComment, mock }) {
  const s = await readState();

  const period = {
    id: `P${s.history.length + 1}`,
    index: s.history.length + 1,
    start: s.currentPeriodStart,
    end: new Date().toISOString(),
    logs: { ...logs },
    evaluations,
    adjustments,
    overallComment: overallComment ?? "",
    mock: !!mock,
  };

  const afterById = new Map(adjustments.map((a) => [a.id, a.after]));
  s.members = s.members.map((m) => ({
    ...m,
    equity: afterById.has(m.id) ? afterById.get(m.id) : m.equity,
  }));
  s.history.unshift(period);
  s.currentPeriodStart = new Date().toISOString();

  await writeState(s);
  // 초안 비우기 (best-effort)
  await Promise.all(s.members.map((m) => writeDraft(m.id, "")));

  return { state: s, period };
}

export async function resetAll() {
  const fresh = seedState();
  await writeState(fresh);
  await Promise.all(SEED_MEMBERS.map((m) => writeDraft(m.id, "")));
  return fresh;
}
