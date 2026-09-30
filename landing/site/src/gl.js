import * as THREE from 'three';
import { pointsVert, pointsFrag, planeVert, planeFrag, postVert, postFrag } from './shaders.js';

export const FIG_H = 2.3; // world height of the figure
const CAM_Z = 6;
const FOV = 28;
const GLYPHS = ' .·:-=+*#%@';

function videoTexture(video) {
  const t = new THREE.Texture(video);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

function glyphAtlas() {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = s * GLYPHS.length;
  c.height = s;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#fff';
  g.font = `500 ${s * 0.78}px "JetBrains Mono Variable", monospace`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  [...GLYPHS].forEach((ch, i) => g.fillText(ch, i * s + s / 2, s / 2 + s * 0.04));
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

// One grid of particles per video source, one particle per `step` source pixels.
function makePoints(src, step, uniformsCommon) {
  const cols = Math.round(src.w / step);
  const rows = Math.round(src.h / step);
  const n = cols * rows;
  const uv = new Float32Array(n * 2);
  const rnd = new Float32Array(n * 4);
  let k = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++, k++) {
      uv[k * 2] = (x + 0.5) / cols;
      uv[k * 2 + 1] = (y + 0.5) / rows;
      for (let j = 0; j < 4; j++) rnd[k * 4 + j] = Math.random();
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 4));
  const aspect = src.w / src.h;
  const mat = new THREE.ShaderMaterial({
    vertexShader: pointsVert,
    fragmentShader: pointsFrag,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      ...uniformsCommon,
      uTex: { value: src.texture },
      uSize: { value: new THREE.Vector2(FIG_H * aspect, FIG_H) },
      uCell: { value: new THREE.Vector2(1 / cols, 1 / rows) },
      uDepth: { value: 0.9 },
      uForm: { value: 1 },
      uKnot: { value: 0 },
      uKnotPos: { value: new THREE.Vector3() },
      uKnotRot: { value: new THREE.Vector3(0.9, 0, 0.24) },
      uFlow: { value: 0 },
      uRingPos: { value: new THREE.Vector3() },
      uTilt: { value: 1 },
      uRingR: { value: new THREE.Vector2(0.7, 0.15) },
      uSpin: { value: 0 },
      uSweep: { value: -9 },
      uRingAlpha: { value: 0 },
      uMaskOut: { value: 0 },
      uScatter: { value: 0 },
      uPointSize: { value: 1.9 },
      uMouseForce: { value: 0 },
      uOpacity: { value: 1 },
    },
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

function makePlane(src, uniformsCommon) {
  const aspect = src.w / src.h;
  const mat = new THREE.ShaderMaterial({
    vertexShader: planeVert,
    fragmentShader: planeFrag,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    premultipliedAlpha: true,
    uniforms: {
      ...uniformsCommon,
      uTex: { value: src.texture },
      uPixelRatio: uniformsCommon.uPixelRatio,
      uOpacity: { value: 0 },
      uTexel: { value: new THREE.Vector2(1 / src.w, 1 / src.h) },
      uIn: { value: 1 },
      uOut: { value: 0 },
      uExposure: { value: 1.15 },
      uLift: { value: 0 },
    },
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(FIG_H * aspect, FIG_H), mat);
  m.frustumCulled = false;
  return m;
}

export class Stage {
  constructor(canvas, sources, { pixelRatio = 1, preserve = false } = {}) {
    this.canvas = canvas;
    this.sources = sources; // { tex, clay, grip } -> { video, w, h }
    this.pixelRatio = pixelRatio;
    this.renderer = new THREE.WebGLRenderer({
      canvas, alpha: true, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: preserve,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(pixelRatio);

    for (const s of Object.values(sources)) s.texture = videoTexture(s.video);

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 50);
    this.camera.position.set(0, 0, CAM_Z);
    this.scene = new THREE.Scene();
    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.common = {
      uTime: { value: 0 },
      uPixelRatio: { value: pixelRatio },
      uMouse: { value: new THREE.Vector3(9, 9, 0) },
    };
    const step = 2;
    this.points = { tex: makePoints(sources.tex, step, this.common) };
    this.planes = {
      clay: makePlane(sources.clay, this.common),
      tex: makePlane(sources.tex, this.common),
      grip: makePlane(sources.grip, this.common),
    };
    // draw order: clay under the material reveal, rig on top, particles last
    [this.planes.clay, this.planes.tex, this.planes.grip, this.points.tex].forEach((o, i) => {
      o.renderOrder = i;
      this.group.add(o);
    });

    this.rt = new THREE.WebGLRenderTarget(2, 2, { depthBuffer: false });
    this.post = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader: postVert,
        fragmentShader: postFrag,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending,
        uniforms: {
          tScene: { value: this.rt.texture },
          tGlyphs: { value: glyphAtlas() },
          uGlyphCount: { value: GLYPHS.length },
          uCell: { value: 10 * pixelRatio },
          uRes: { value: new THREE.Vector2(2, 2) },
          uAscii: { value: 0 },
          uGain: { value: 1.25 },
          uGain: { value: 1.25 },
          uOpacity: { value: 1 },
          uTime: this.common.uTime,
        },
      }),
    );
    this.post.frustumCulled = false;
    this.postScene = new THREE.Scene();
    this.postScene.add(this.post);
    this.postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.raycaster = new THREE.Raycaster();
    this.zPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const pr = this.pixelRatio;
    this.rt.setSize(Math.round(w * pr), Math.round(h * pr));
    this.post.material.uniforms.uRes.value.set(Math.round(w * pr), Math.round(h * pr));
  }

  // half width of the visible world at z = 0
  get worldHalfW() {
    return Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * CAM_Z * this.camera.aspect;
  }

  pointerToWorld(nx, ny, out) {
    this.raycaster.setFromCamera({ x: nx, y: ny }, this.camera);
    const hit = new THREE.Vector3();
    this.raycaster.ray.intersectPlane(this.zPlane, hit);
    // into group space
    this.group.worldToLocal(hit);
    out.copy(hit);
  }

  render(s) {
    const c = this.common;
    c.uTime.value = s.time;

    this.group.position.set(s.offsetX, s.offsetY, 0);
    this.group.scale.setScalar(s.scale);
    this.group.rotation.y = s.rotY;
    this.camera.position.x = s.camX;
    this.camera.position.y = s.camY;
    this.camera.lookAt(s.offsetX * 0.15, 0, 0);

    const P = this.points, L = this.planes;
    const pt = P.tex.material.uniforms;
    pt.uOpacity.value = s.texPts;
    pt.uForm.value = s.form;
    pt.uKnot.value = s.knot;
    pt.uKnotPos.value.set(0, s.knotY, 0);
    pt.uKnotRot.value.set(s.knotTilt, s.knotSpin, s.knotScale);
    pt.uFlow.value = s.flow;
    pt.uRingPos.value.set(0, s.ringY, 0);
    pt.uTilt.value = s.tilt;
    pt.uRingR.value.set(s.ringR, s.ringr);
    pt.uSpin.value = s.spin;
    pt.uSweep.value = s.sweep;
    pt.uRingAlpha.value = s.ringAlpha;
    pt.uMaskOut.value = s.ptsOut;
    pt.uScatter.value = s.scatter;
    pt.uMouseForce.value = s.mouseForce;
    pt.uDepth.value = s.depth;
    P.tex.visible = s.texPts > 0.001;

    const set = (m, o, i, u) => {
      const U = m.material.uniforms;
      U.uOpacity.value = o;
      U.uIn.value = i;
      U.uOut.value = u;
      m.visible = o > 0.001 && i > 0 && u < 1;
    };
    set(L.clay, s.clay, s.clayIn, s.clayOut);
    set(L.tex, s.texPlane, s.texIn, s.texOut);
    set(L.grip, s.gripPlane, 1, s.gripOut);
    L.grip.material.uniforms.uLift.value = s.gripLift ?? 0;

    // upload only the video frames that are on screen
    const need = {
      tex: P.tex.visible || L.tex.visible,
      clay: L.clay.visible,
      grip: L.grip.visible,
    };
    for (const k in need) {
      const src = this.sources[k];
      const v = src.video;
      // re-upload when the frame changed (or a capture seek landed); never mid-seek
      if (need[k] && v.readyState >= 2 && !v.seeking && (src.dirty || v.currentTime !== src.lastUpload)) {
        src.texture.needsUpdate = true;
        src.lastUpload = v.currentTime;
        src.dirty = false;
      }
    }

    const pu = this.post.material.uniforms;
    pu.uAscii.value = s.ascii;
    pu.uGain.value = s.asciiGain;
    pu.uGain.value = s.asciiGain ?? 1.25;
    pu.uOpacity.value = s.canvasOpacity;

    this.renderer.setRenderTarget(this.rt);
    this.renderer.clear();
    if (s.canvasOpacity > 0.001) this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.clear();
    if (s.canvasOpacity > 0.001) this.renderer.render(this.postScene, this.postCam);
  }
}
