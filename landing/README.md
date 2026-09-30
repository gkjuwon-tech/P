# Landing — 영상 에셋

> 랜딩 페이지는 [`site/`](site/), 데스크톱 스크롤 녹화는 [`recordings/plinth-desktop-scroll.mp4`](recordings/plinth-desktop-scroll.mp4).

Google Flow(Veo)로 생성한 원본 3개를 누끼 → 깊이맵 → 웹용 인코딩까지 처리한 결과물입니다.

## 에셋 목록

| 폴더 | 원본 | 용도 | 길이 | 편집 |
|---|---|---|---|---|
| `assets/video/hero-turntable` | 블랙 수트 회전 | 히어로 / 파이프라인 (파티클·아스키·와이어 원본) | 211f · 8.79s | 이음새 없는 루프 (마지막 12프레임 크로스페이드) |
| `assets/video/hero-clay-turntable` | 클레이 회전 | 파이프라인 `MESH` 단계 | 222f · 9.25s | 이음새 없는 루프 |
| `assets/video/hero-rig-grip` | T포즈 → 머리 움켜쥐기 | 파이프라인 `RIGGED` 단계 | 276f · 11.5s | 마지막 0.5초 ease-out 감속 + 1초 정지 |

전부 24fps, 높이 720px, 가로는 프레임 중앙(원본 x=640) 기준으로 잘라서 **세 영상 모두 같은 중심선과 스케일**을 공유합니다. 원본 좌표는 `<name>.json`의 `crop_x_in_source`에 있습니다.

## 파일 형식 (클립마다)

| 파일 | 형식 | 언제 쓰나 |
|---|---|---|
| `<name>_packed.mp4` | H.264, 세로 3단: **컬러 / 알파 / 깊이** | WebGL 파티클 모드. 텍스처 하나로 전부 샘플링 |
| `<name>_packed.webm` | VP9, 같은 3단 구성 | H.264가 없는 Chromium 빌드용 (사이트가 먼저 시도) |
| `<name>_stacked.mp4` | H.264, 세로 2단: **컬러 / 알파** | WebGL 일반 합성 (모든 브라우저, 모바일) |
| `<name>.webm` | VP9 + 알파 | DOM `<video>`에 바로 투명 재생 (Chrome/Edge/Firefox. Safari는 stacked 사용) |
| `<name>_depth.mp4` | H.264, 깊이만 | 디버그 / 별도 합성 |
| `<name>_poster.webp` | RGBA 첫 프레임 | 로딩 · 폴백 · reduced-motion |
| `<name>_master_green.mp4` | 1280×720 그린 원본 | 재편집용 마스터 (로고 제거, 타이밍 편집 적용) |

- 컬러는 **premultiplied**(알파 밖은 검정)라서 셰이더에서 가장자리 번짐 없이 샘플링됩니다.
- 깊이는 **흰색 = 가까움**, 피사체 밖은 0, 프레임별 상대값(절대 거리 아님).
- H.264는 GOP 12, B프레임 없음 → 스크롤로 `currentTime`을 조절할 때 탐색이 가볍습니다.

### 셰이더에서 packed 샘플링 예시

```glsl
// uv: 0..1 (한 칸 기준)
vec3  col   = texture2D(uVideo, vec2(uv.x, uv.y / 3.0 + 2.0/3.0)).rgb; // WebGL uv는 아래가 0 → 맨 위 칸이 컬러
float alpha = texture2D(uVideo, vec2(uv.x, uv.y / 3.0 + 1.0/3.0)).r;
float depth = texture2D(uVideo, vec2(uv.x, uv.y / 3.0)).r;
```
(stacked는 `/ 2.0`, 컬러 `+ 0.5`, 알파 `+ 0.0`)

## 처리 파이프라인 (`tools/`)

1. `key.py` — 크로마키. 배경색을 프레임 테두리에서 추정 → 알파 → 가장자리 배경색 역산 → 스필 제거 → 가장자리 무채색화. 면적 3000px 미만 덩어리는 버림(영상 중간에 튀어나오는 Flow 로고 제거). 그린 마스터는 피사체 주변 외 배경을 단색으로 다시 칠함.
2. `depth.py` — **Depth Anything V2 Small** (Apache-2.0, 상업 사용 가능). 클립 전체의 피사체 영역으로 고정 크롭해서 입력 해상도를 확보, 퍼센타일 정규화를 시간축으로 스무딩해 깜빡임 억제.
   - Base/Large 모델은 CC-BY-NC(비상업)라 쓰지 않았습니다.
3. `build.py` — 루프 크로스페이드 / ease-out + 정지 → 크롭 → 인코딩.

재생성 (`landing/` 폴더에서 실행, 중간 산출물은 `frames/ rgba/ green/ depth/`에 생김):
```bash
pip install opencv-python-headless numpy torch transformers imageio-ffmpeg
# 프레임 추출: ffmpeg -i in.mp4 -an frames/<clip>/%04d.png
python tools/key.py frames/<clip> rgba/<clip> green/<clip>
python tools/depth.py rgba/<clip> depth/<clip>
python tools/build.py assets/video      # build.py 안의 CLIPS 표에서 클립/편집 지정
```
