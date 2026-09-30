// Packed video layout (see landing/README.md): rows = colour (top), alpha, depth (bottom).
// With flipY textures, v=0 is the bottom of the image.
const packed = /* glsl */ `
  vec3 packedColor(sampler2D t, vec2 uv) { return texture2D(t, vec2(uv.x, uv.y / 3.0 + 2.0 / 3.0)).rgb; }
  float packedAlpha(sampler2D t, vec2 uv) { return texture2D(t, vec2(uv.x, uv.y / 3.0 + 1.0 / 3.0)).r; }
  float packedDepth(sampler2D t, vec2 uv) { return texture2D(t, vec2(uv.x, uv.y / 3.0)).r; }
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

// Ashima simplex noise 3D
const noise = /* glsl */ `
  vec4 permute(vec4 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + 2.0 * C.xxx;
    vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
    i = mod(i, 289.0);
    vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 1.0 / 7.0;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  }
`;

export const pointsVert = /* glsl */ `
  uniform sampler2D uTex;
  uniform vec2 uSize;          // world width / height of the figure
  uniform vec2 uCell;          // uv size of one grid cell (for jitter)
  uniform float uDepth;
  uniform float uTime;
  uniform float uForm;         // 0 = scattered cloud, 1 = formed figure
  uniform float uScatter;      // noise displacement
  uniform float uDissolve;     // head-first upward dissolve
  uniform float uPointSize;
  uniform float uPixelRatio;
  uniform vec3 uMouse;
  uniform float uMouseForce;
  uniform float uOpacity;
  attribute vec2 aUv;
  attribute vec4 aRnd;
  varying float vBright;
  varying float vAlpha;
  ${packed}
  ${noise}
  void main() {
    vec2 uv = aUv + (aRnd.xy - 0.5) * uCell;
    float a = packedAlpha(uTex, uv);
    vec3 col = packedColor(uTex, uv);
    float d = packedDepth(uTex, uv);

    vec3 target = vec3((uv.x - 0.5) * uSize.x, (uv.y - 0.5) * uSize.y, (d - 0.35) * uDepth);

    // formation: each particle arrives from a loose sphere, staggered
    vec3 dir = normalize(aRnd.xyz - 0.5 + 1e-4);
    vec3 from = dir * (2.2 + aRnd.w * 3.0) + vec3(0.0, 0.0, -1.5);
    float t = smoothstep(aRnd.w * 0.55, aRnd.w * 0.55 + 0.45, uForm);
    t = t * t * (3.0 - 2.0 * t);
    vec3 pos = mix(from, target, t);

    // drifting noise field
    vec3 np = target * 1.4 + vec3(0.0, 0.0, uTime * 0.12);
    vec3 n = vec3(snoise(np), snoise(np + 17.3), snoise(np + 41.9));
    pos += n * uScatter * (0.8 + aRnd.w * 1.2);

    // dissolve from the head down, carried up and away
    float f = clamp((uDissolve * 1.45 - (1.0 - uv.y) - aRnd.w * 0.35) / 0.35, 0.0, 1.0);
    pos += (n * 1.1 + vec3(0.25, 0.9, 0.3)) * f * f * (0.6 + aRnd.z * 1.2);

    // cursor repulsion
    vec2 dm = pos.xy - uMouse.xy;
    float md = length(dm);
    float push = uMouseForce * exp(-md * md / 0.015) * 0.11;
    pos.xy += dm / max(md, 1e-3) * push;
    pos.z += push * 1.8;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    float vis = smoothstep(0.35, 0.6, a);
    float l = luma(col);
    // black suit on black: shade by depth so the form still reads
    vBright = 0.34 + l * 0.75 + d * 0.3 + push * 1.5;
    vAlpha = uOpacity * vis * (1.0 - f * 0.4);
    gl_PointSize = vis < 0.01 ? 0.0 : uPointSize * uPixelRatio * (0.75 + aRnd.z * 0.6) * (6.0 / -mv.z);
  }
`;

export const pointsFrag = /* glsl */ `
  varying float vBright;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float m = smoothstep(0.5, 0.2, length(c));
    if (m * vAlpha < 0.004) discard;
    gl_FragColor = vec4(vec3(vBright), m * vAlpha);
  }
`;

export const planeVert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Video quad: sobel "wireframe", shaded fill, and a noisy bottom-up reveal with a scan line.
export const planeFrag = /* glsl */ `
  uniform sampler2D uTex;
  uniform vec2 uTexel;         // 1 / (width, height of one row)
  uniform float uOpacity;
  uniform float uWire;
  uniform float uFill;
  uniform float uReveal;       // 1 = fully shown
  uniform float uExposure;
  uniform float uTime;
  varying vec2 vUv;
  ${packed}
  ${noise}
  float lumAt(vec2 uv) { return luma(packedColor(uTex, uv)) + packedAlpha(uTex, uv) * 0.25; }
  void main() {
    vec2 uv = vUv;
    float a = packedAlpha(uTex, uv);
    vec3 col = packedColor(uTex, uv);
    float l = luma(col) * uExposure;

    vec2 e = uTexel;
    float tl = lumAt(uv + vec2(-e.x, e.y)), t = lumAt(uv + vec2(0.0, e.y)), tr = lumAt(uv + vec2(e.x, e.y));
    float ml = lumAt(uv + vec2(-e.x, 0.0)), mr = lumAt(uv + vec2(e.x, 0.0));
    float bl = lumAt(uv + vec2(-e.x, -e.y)), b = lumAt(uv + vec2(0.0, -e.y)), br = lumAt(uv + vec2(e.x, -e.y));
    float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
    float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
    float edge = smoothstep(0.06, 0.26, length(vec2(gx, gy)));

    float edgeT = uv.y * 0.9 + snoise(vec3(uv * vec2(5.0, 16.0), 0.0)) * 0.06 + 0.05;
    float thr = uReveal * 1.12;
    float shown = smoothstep(edgeT - 0.006, edgeT + 0.006, thr);
    float scan = smoothstep(0.018, 0.0, abs(edgeT - thr)) * step(0.001, uReveal) * step(uReveal, 0.999);

    vec3 fill = vec3(l);
    vec3 wire = vec3(edge);
    vec3 c = max(fill * uFill, wire * uWire * 0.85);
    float A = max(a * uFill, edge * uWire);
    c = c * shown + vec3(1.0) * scan * a;
    A = A * shown + scan * a;
    A *= uOpacity;
    gl_FragColor = vec4(c * uOpacity, A);
  }
`;

export const postVert = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Composite: direct image, or per-cell ASCII glyphs. Cells flip individually for the transition.
export const postFrag = /* glsl */ `
  uniform sampler2D tScene;
  uniform sampler2D tGlyphs;
  uniform float uGlyphCount;
  uniform float uCell;         // device px
  uniform vec2 uRes;           // device px
  uniform float uAscii;
  uniform float uGain;
  uniform float uOpacity;
  uniform float uTime;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vec4 direct = texture2D(tScene, vUv);

    vec2 cell = floor(gl_FragCoord.xy / uCell);
    vec2 cuv = (cell + 0.5) * uCell / uRes;
    vec2 o = 0.3 * uCell / uRes;
    vec4 s = (texture2D(tScene, cuv + vec2(-o.x, -o.y)) + texture2D(tScene, cuv + vec2(o.x, -o.y)) +
              texture2D(tScene, cuv + vec2(-o.x, o.y)) + texture2D(tScene, cuv + vec2(o.x, o.y))) * 0.25;
    float lum = clamp(max(s.r, max(s.g, s.b)) * uGain, 0.0, 1.0);
    float idx = floor(lum * (uGlyphCount - 0.001));
    vec2 local = fract(gl_FragCoord.xy / uCell);
    float g = texture2D(tGlyphs, vec2((idx + local.x) / uGlyphCount, local.y)).r;
    vec4 ascii = vec4(vec3(g) * (0.45 + 0.55 * lum), g);

    float r = 0.05 + hash(cell) * 0.9; // so 0 and 1 are exact
    float on = smoothstep(r - 0.04, r + 0.04, uAscii);
    // brief flicker while a cell is mid-flip
    float flick = step(0.5, hash(cell + floor(uTime * 24.0))) * (1.0 - abs(on * 2.0 - 1.0));
    on = clamp(on + flick * 0.6, 0.0, 1.0);

    gl_FragColor = mix(direct, ascii, on) * uOpacity;
  }
`;
