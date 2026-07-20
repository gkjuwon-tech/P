// 지분 조정 로직
//
// 규칙
//  - 합계는 항상 100%를 유지한다 (제로섬).
//  - 한 번의 평가(2주)에서 1인당 변동폭은 최대 ±5%p.
//  - 평균보다 잘한 사람은 지분을 얻고, 못한 사람은 잃는다.
//  - 지분은 음수가 될 수 없다 (최소 0%).
//
// 방식
//  1. 각자 점수(0~100)에서 팀 평균 점수를 뺀 편차를 구한다. (편차의 합은 0)
//  2. 편차 1점당 RATE(%p) 만큼을 잠정 변동폭으로 둔다.
//  3. 가장 큰 변동폭이 CAP(5%p)를 넘으면, 전체를 같은 비율로 축소해
//     최대 변동폭이 정확히 CAP가 되도록 맞춘다. (편차 합이 0이므로 축소해도 합은 0 유지)
//  4. 변동을 적용한 뒤 음수는 0으로 막고, 반올림 잔차를 보정해 합계 100%를 맞춘다.

export const MAX_DELTA = 5; // 1인당 최대 변동폭(%p)
const RATE = 0.15; // 평균 대비 편차 1점당 잠정 변동폭(%p). 33점 차이에서 CAP 도달

export function computeAdjustments(members, evaluations) {
  // members: [{ id, name, equity }]
  // evaluations: [{ memberId, score }]
  const scoreById = new Map(evaluations.map((e) => [e.memberId, clampScore(e.score)]));

  const scores = members.map((m) => scoreById.get(m.id) ?? 50);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;

  // 1~2단계: 편차 기반 잠정 변동폭
  let deltas = members.map((_, i) => (scores[i] - mean) * RATE);

  // 3단계: CAP 초과 시 전체 비례 축소
  const maxAbs = Math.max(...deltas.map((d) => Math.abs(d)), 0);
  if (maxAbs > MAX_DELTA) {
    const scale = MAX_DELTA / maxAbs;
    deltas = deltas.map((d) => d * scale);
  }

  // 4단계: 적용 + 음수 방지
  let next = members.map((m, i) => ({
    id: m.id,
    name: m.name,
    before: round1(m.equity),
    rawDelta: deltas[i],
    after: m.equity + deltas[i],
  }));

  // 음수는 0으로. 부족분은 지분이 남는 사람들에게 비례 재분배해 합계 100 유지.
  next = enforceNonNegativeAndNormalize(next);

  // 표시용 반올림 + 잔차 보정
  next = roundEquities(next);

  return next.map((n) => ({
    id: n.id,
    name: n.name,
    before: n.before,
    after: n.after,
    delta: round1(n.after - n.before),
  }));
}

function enforceNonNegativeAndNormalize(rows) {
  const total = rows.reduce((a, r) => a + r.after, 0); // 이론상 100
  // 음수 클리핑
  let clipped = rows.map((r) => ({ ...r, after: Math.max(0, r.after) }));
  const clippedTotal = clipped.reduce((a, r) => a + r.after, 0);
  if (clippedTotal <= 0) {
    // 극단적 상황 방어: 균등 분배
    const even = total / rows.length;
    return rows.map((r) => ({ ...r, after: even }));
  }
  // 합계를 원래 total(=100)로 정규화
  const factor = total / clippedTotal;
  return clipped.map((r) => ({ ...r, after: r.after * factor }));
}

function roundEquities(rows) {
  const rounded = rows.map((r) => ({ ...r, after: round1(r.after) }));
  const sum = rounded.reduce((a, r) => a + r.after, 0);
  const diff = round1(100 - sum);
  if (diff !== 0) {
    // 잔차는 지분이 가장 큰 사람에게 몰아 합계를 100으로 맞춘다.
    let idx = 0;
    rounded.forEach((r, i) => {
      if (r.after > rounded[idx].after) idx = i;
    });
    rounded[idx] = { ...rounded[idx], after: round1(rounded[idx].after + diff) };
  }
  return rounded;
}

function clampScore(s) {
  const n = Number(s);
  if (Number.isNaN(n)) return 50;
  return Math.min(100, Math.max(0, n));
}

export function round1(n) {
  return Math.round(n * 10) / 10;
}
