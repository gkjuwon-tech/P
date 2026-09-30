# PLINTH — landing page

Vite + three.js + Lenis. 영상 에셋은 `../assets`(= `landing/assets`)를 그대로 public 폴더로 씁니다.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # dist/
npm run preview    # http://localhost:4173 (녹화는 이 서버를 사용)
npm run record     # ../recordings/plinth-desktop-scroll.mp4
node tools/record.mjs --stills   # 주요 지점 스틸만 빠르게
```

## 구조

| 파일 | 역할 |
|---|---|
| `index.html` | 섹션 마크업: hero → process(고정) → statement(고정) → models → finale |
| `src/main.js` | 로더, 리빌, 스크롤 → 상태 계산, 영상 동기화/스크럽, `?capture` 모드 |
| `src/gl.js` | 캔버스 하나: 파티클 2벌, 영상 평면 3장, 아스키 합성 |
| `src/shaders.js` | 파티클(깊이·형성·흩어짐·커서 밀어내기), 평면(Sobel 와이어·클레이·아래→위 리빌), 아스키 |
| `tools/record.mjs` | 프레임 단위 결정적 녹화 → ffmpeg |

모든 움직임은 **스크롤 위치와 시계(t) 하나의 함수**로 계산됩니다(CSS 트랜지션은 호버에만). 그래서 `?capture`에서 시간·스크롤·포인터를 외부에서 넣으면 어떤 속도의 기기에서도 같은 영상이 나옵니다.

## 스크롤 스토리

| 구간 | 캔버스 |
|---|---|
| Hero | 점으로 된 (3,5) 토러스 매듭. 3D로 천천히 회전하고, 가닥을 따라 빛줄기가 흐름. 커서가 입자를 밀어냄 |
| 01 Prompt | 매듭이 풀리며 머리 위의 얇은 링이 되고, 링이 아래로 내려가며 지나간 자리에 사람이 만들어짐 |
| 02 Point cloud | 좌우로 흔들리며 깊이감 노출 |
| 03 Geometry | 디더 디졸브로 곧바로 클레이 |
| 04 Material | 같은 디더 디졸브로 텍스처 |
| 05 Rig & motion | 아스키 글리치로 T포즈 전환 → 스크롤로 머리 움켜쥐기 동작 스크럽 |
| Statement | 멈춘 자세가 아스키로 바뀐 뒤 같은 디더 디졸브로 사라짐 |
| Models | 오른쪽에 아스키 클레이 인물로 나타났다 사라짐 |
| Finale | 매듭 → 링 → 사람이 다시 한 번 (히어로와 수미상관) |

전환은 전부 **깊이맵 순서(가까운 면부터)의 1비트 디더 디졸브** 하나로 통일했습니다(`shaders.js`의 `maskKey` / `maskAmount`).

## 메모
- 영상은 `<source>` 순서대로 VP9 webm → H.264 mp4. (Safari는 mp4)
- 브랜드명 `PLINTH`는 가칭입니다. `index.html`의 텍스트만 바꾸면 됩니다.
- 모바일: 입자 수 1/2.25, DPR 1.5 상한. `prefers-reduced-motion`이면 부드러운 스크롤/형성 연출 생략.
