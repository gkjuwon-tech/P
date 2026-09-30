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

// Shared transition: a 1-bit ordered-dither dissolve whose order follows the depth map
// (nearest surfaces resolve first), broken up by low-frequency noise.
const dissolve = /* glsl */ `
  float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
  float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
  float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }
  float maskKey(vec2 uv, float d) {
    return clamp(0.78 - d * 0.7 + snoise(vec3(uv * vec2(7.0, 16.0), 3.1)) * 0.07, 0.0, 1.0);
  }
  // 0..1 progress -> how far past the threshold this key is, in band units (>= dither value means shown)
  float maskAmount(float key, float p) { return ((p * 1.4 - 0.2) - key) / 0.2; }
`;

export const pointsVert = /* glsl */ `
  uniform sampler2D uTex;
  uniform vec2 uSize;          // world width / height of the figure
  uniform vec2 uCell;          // uv size of one grid cell (for jitter)
  uniform float uDepth;
  uniform float uTime;
  uniform float uForm;         // 0 = loose sphere, 1 = gathered into the shape
  uniform float uKnot;         // 0 = torus knot, 1 = untied into the scanning ring
  uniform vec3 uKnotPos;
  uniform vec3 uKnotRot;       // x tilt, y spin, knot scale
  uniform float uFlow;         // phase of the light running along the strand
  uniform vec3 uRingPos;       // ring centre
  uniform float uTilt;         // ring tilt towards the camera (rad)
  uniform vec2 uRingR;         // major, minor radius
  uniform float uSpin;
  uniform float uSweep;        // world y of the build line: particles above it take their place in the figure
  uniform float uRingAlpha;    // ring-only particles
  uniform float uMaskOut;      // dither-dissolve the built figure away (0..1)
  uniform float uScatter;
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
  ${dissolve}

  // (3,5) torus knot
  vec3 knot(float t) {
    float r = 2.0 + cos(5.0 * t);
    return vec3(r * cos(3.0 * t), -sin(5.0 * t) * 1.25, r * sin(3.0 * t));
  }
  mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
  mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }

  void main() {
    vec2 uv = aUv + (aRnd.xy - 0.5) * uCell;
    float a = packedAlpha(uTex, uv);
    vec3 col = packedColor(uTex, uv);
    float d = packedDepth(uTex, uv);
    float vis = smoothstep(0.35, 0.6, a);
    // particles outside the figure: a share of them only ever makes up the ring
    float ringOnly = (1.0 - step(0.5, vis)) * step(aRnd.z, 0.2);

    vec3 target = vec3((uv.x - 0.5) * uSize.x, (uv.y - 0.5) * uSize.y, (d - 0.35) * uDepth);

    // --- torus knot: a fine woven strand, a faint dust halo, and long light streaks running along it ---
    float comet = step(0.8, aRnd.w);
    float halo = (1.0 - comet) * step(0.86, aRnd.z);
    float lane = floor(aRnd.x * 22.0);
    float speed = 0.22 + fract(lane * 0.618) * 0.2;
    float tBody = aRnd.x * 6.28318;
    float tComet = (lane + aRnd.y * 0.9) / 22.0 * 6.28318 + uFlow * speed;
    float kt = mix(tBody, tComet, comet);
    vec3 c0 = knot(kt);
    vec3 T = normalize(knot(kt + 0.01) - c0);
    vec3 N = normalize(cross(T, vec3(0.0, 1.0, 0.0)) + 1e-4);
    vec3 Bn = cross(T, N);
    float ph = aRnd.y * 6.28318 * 7.0 + aRnd.z * 6.28318;
    float breathe = 0.8 + 0.3 * snoise(vec3(kt * 1.3, uTime * 0.25, 0.0));
    float tube = breathe * (comet > 0.5 ? 0.05 : (halo > 0.5 ? 0.55 * aRnd.w + 0.2 : 0.2 * sqrt(aRnd.z)));
    vec3 kp = c0 + (N * cos(ph) + Bn * sin(ph)) * tube;
    kp = rotY(uKnotRot.y) * rotX(uKnotRot.x) * (kp * uKnotRot.z) + uKnotPos;
    float headB = pow(aRnd.y, 4.0);
    float shapeBright = comet > 0.5 ? 0.4 + headB * 2.2 : (halo > 0.5 ? 0.22 : 0.32 + aRnd.z * 0.28);
    float shapeAlpha = halo > 0.5 ? 0.4 : 1.0;

    // --- ring: the knot unties into it, keeping each particle's angle around the axis ---
    float th = atan(c0.z, c0.x) + uSpin;
    float R = uRingR.x + (aRnd.w - 0.5) * 0.015;
    float rph = aRnd.y * 6.28318;
    vec3 tp = vec3((R + uRingR.y * cos(rph)) * cos(th), uRingR.y * sin(rph), (R + uRingR.y * cos(rph)) * sin(th));
    float ct = cos(uTilt), st = sin(uTilt);
    tp = vec3(tp.x, tp.y * ct - tp.z * st, tp.y * st + tp.z * ct) + uRingPos;

    // untie with a per-particle stagger so the strand peels apart rather than lerping as one
    float m = smoothstep(aRnd.w * 0.4, aRnd.w * 0.4 + 0.6, uKnot);
    vec3 shapeP = mix(kp, tp, m);
    vec3 sw = vec3(snoise(kp * 0.8 + 3.0), snoise(kp * 0.8 + 9.0), snoise(kp * 0.8 + 15.0));
    shapeP += sw * sin(m * 3.14159) * 0.35;
    shapeBright = mix(shapeBright, 0.42, m);

    // gather into the shape from a loose sphere, staggered
    vec3 dir = normalize(aRnd.xyz - 0.5 + 1e-4);
    vec3 from = dir * (2.2 + aRnd.w * 3.0) + vec3(0.0, 0.0, -1.5);
    float g = smoothstep(aRnd.w * 0.55, aRnd.w * 0.55 + 0.45, uForm);
    g = g * g * (3.0 - 2.0 * g);
    vec3 ringP = mix(from, shapeP, g);

    // build: once the sweep has passed below a particle's place, it leaves the ring for it
    float k = (1.0 - ringOnly) * clamp((target.y - uSweep) / 0.3 - aRnd.w * 0.3, 0.0, 1.0);
    k = k * k * (3.0 - 2.0 * k);
    vec3 pos = mix(ringP, target, k);

    vec3 np = pos * 1.4 + vec3(0.0, 0.0, uTime * 0.12);
    pos += vec3(snoise(np), snoise(np + 17.3), snoise(np + 41.9)) * uScatter;

    // cursor repulsion
    vec2 dm = pos.xy - uMouse.xy;
    float md = length(dm);
    float push = uMouseForce * exp(-md * md / 0.015) * 0.11;
    pos.xy += dm / max(md, 1e-3) * push;
    pos.z += push * 1.8;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    // dither-dissolve out, same order as the planes use to come in
    float out_ = step(aRnd.z, maskAmount(maskKey(uv, d), uMaskOut)) * k;

    float l = luma(col);
    float figBright = 0.34 + l * 0.75 + d * 0.3;
    vBright = mix(shapeBright, figBright, k) + push * 1.5;
    float A = mix(vis, uRingAlpha, ringOnly) * g * (1.0 - out_) * mix(shapeAlpha, 1.0, max(k, m));
    vAlpha = uOpacity * A;
    gl_PointSize = A < 0.01 ? 0.0 : uPointSize * uPixelRatio * (0.75 + aRnd.z * 0.6 - (1.0 - k) * (1.0 - m) * 0.25) * (6.0 / -mv.z);
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

// Video quad with the dither dissolve in (uIn) and out (uOut).
export const planeFrag = /* glsl */ `
  uniform sampler2D uTex;
  uniform float uOpacity;
  uniform float uIn;
  uniform float uOut;
  uniform float uExposure;
  uniform float uLift;         // lift dark surfaces by depth (so they survive the ASCII pass)
  uniform float uPixelRatio;
  varying vec2 vUv;
  ${packed}
  ${noise}
  ${dissolve}
  void main() {
    vec2 uv = vUv;
    float a = packedAlpha(uTex, uv);
    float d = packedDepth(uTex, uv);
    float l = luma(packedColor(uTex, uv)) * uExposure;

    float key = maskKey(uv, d);
    float b = bayer8(gl_FragCoord.xy / max(1.0, 2.0 * uPixelRatio));
    float amtIn = maskAmount(key, uIn);
    float shown = step(b, amtIn) * (1.0 - step(b, maskAmount(key, uOut)));
    // pixels still inside the band glow a little as they settle
    float hot = shown * (1.0 - clamp(amtIn, 0.0, 1.0));

    l = max(l, (0.22 + d * 0.55) * uLift);
    vec3 c = vec3(l) + hot * 0.22;
    float A = a * shown * uOpacity;
    gl_FragColor = vec4(c * A, A);
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
