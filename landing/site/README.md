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
| Hero | 입자 인물이 형성되며 회전, 커서가 입자를 밀어냄 |
| 01 Prompt | 인물이 구름으로 흩어지고 프롬프트 문장이 드러남 |
| 02 Point cloud | 다시 모여 좌우로 흔들리며 깊이감 노출 |
| 03 Geometry | Sobel 와이어프레임 → 클레이 채움 |
| 04 Material | 아래에서 위로 스캔 라인과 함께 텍스처 공개 |
| 05 Rig & motion | 아스키 글리치로 T포즈 전환 → 스크롤로 머리 움켜쥐기 동작 스크럽 |
| Statement | 멈춘 자세가 아스키로 바뀌며 머리부터 흩어짐 |
| Models | 오른쪽에 작은 아스키 인물로 재형성 |
| Finale | 인물이 처음 자리로 돌아오며 히어로와 수미상관 |

## 메모
- 영상은 `<source>` 순서대로 VP9 webm → H.264 mp4. (Safari는 mp4)
- 브랜드명 `PLINTH`는 가칭입니다. `index.html`의 텍스트만 바꾸면 됩니다.
- 모바일: 입자 수 1/2.25, DPR 1.5 상한. `prefers-reduced-motion`이면 부드러운 스크롤/형성 연출 생략.
