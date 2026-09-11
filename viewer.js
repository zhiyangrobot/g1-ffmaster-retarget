import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// Apple-like product studio: bright near-white void + seamless matte floor.
const G1_Y = -0.85;
const FF_MASTER_Y = 0.85;
const STAGE_BG = 0xf5f5f7;   // Apple system light grey
const FLOOR_COLOR = 0xf0f0f2; // barely darker than void — almost one surface

const el = {
  title: document.getElementById("title"),
  filter: document.getElementById("filter"),
  clipBody: document.getElementById("clip-body"),
  clipCount: document.getElementById("clip-count"),
  status: document.getElementById("status"),
  canvas: document.getElementById("stage"),
  scrub: document.getElementById("scrub"),
  timeLabel: document.getElementById("time-label"),
  speed: document.getElementById("speed"),
  speedLabel: document.getElementById("speed-label"),
  loop: document.getElementById("loop"),
  btnPlay: document.getElementById("btn-play"),
  btnPrev: document.getElementById("btn-prev"),
  btnNext: document.getElementById("btn-next"),
  btnGrid: document.getElementById("btn-grid"),
  btnCenter: document.getElementById("btn-center"),
  mName: document.getElementById("m-name"),
  mCat: document.getElementById("m-cat"),
  mFrames: document.getElementById("m-frames"),
  mDur: document.getElementById("m-dur"),
  mFps: document.getElementById("m-fps"),
  mG1Link: document.getElementById("m-g1-link"),
  mFfLink: document.getElementById("m-ff-link"),
};

let manifest = null;
let filtered = [];
let clipIndex = -1;
let clip = null;
let playing = true;
let frame = 0;
let accum = 0;
let speed = 1;
let lastTs = performance.now();
let showMode = "both"; // both | g1 | ff_master

const renderer = new THREE.WebGLRenderer({
  canvas: el.canvas,
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(STAGE_BG, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(STAGE_BG);
scene.fog = new THREE.Fog(STAGE_BG, 14, 36);
const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 80);
camera.up.set(0, 0, 1);

// Soft, even product lighting — bright, low drama.
scene.add(new THREE.HemisphereLight(0xffffff, 0xe8e8ed, 1.25));
const key = new THREE.DirectionalLight(0xffffff, 1.55);
key.position.set(0.25, -0.4, 0.9).normalize().multiplyScalar(12);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -5;
key.shadow.camera.right = 5;
key.shadow.camera.top = 5;
key.shadow.camera.bottom = -5;
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 30;
key.shadow.bias = -0.0002;
key.shadow.normalBias = 0.025;
key.shadow.radius = 6;
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.55);
fill.position.set(-2.5, 3.0, 4.0);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 0.28);
rim.position.set(1.5, 4.0, 2.0);
scene.add(rim);

// Flat matte floor — no map/grain; contact shadows do the work.
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(48, 48),
  new THREE.MeshStandardMaterial({
    color: FLOOR_COLOR,
    roughness: 1.0,
    metalness: 0.0,
  }),
);
floor.receiveShadow = true;
scene.add(floor);

// Optional measure grid — off by default for a clean product look.
const grid = new THREE.GridHelper(10, 20, 0xd2d2d7, 0xe5e5ea);
grid.rotation.x = Math.PI / 2;
grid.position.z = 0.001;
const gridMats = Array.isArray(grid.material) ? grid.material : [grid.material];
for (const m of gridMats) {
  m.transparent = true;
  m.opacity = 0.22;
  m.depthWrite = false;
}
grid.visible = false;
scene.add(grid);

const axes = new THREE.AxesHelper(0.2);
axes.position.z = 0.012;
axes.visible = false;
scene.add(axes);

const g1Root = new THREE.Group();
const ffMasterRoot = new THREE.Group();
g1Root.position.y = G1_Y;
ffMasterRoot.position.y = FF_MASTER_Y;
scene.add(g1Root, ffMasterRoot);

let g1Nodes = {};
let ffMasterNodes = {};
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _mat = new THREE.Matrix4();

function f16ToF32(u16) {
  const sign = (u16 & 0x8000) >> 15;
  const exp = (u16 & 0x7c00) >> 10;
  const frac = u16 & 0x03ff;
  if (exp === 0) {
    if (frac === 0) return sign ? -0 : 0;
    return (sign ? -1 : 1) * Math.pow(2, -14) * (frac / 1024);
  }
  if (exp === 31) return frac ? NaN : (sign ? -Infinity : Infinity);
  return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

function decodeXforms(robot) {
  const bin = atob(robot.xform_f16_b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const u16 = new Uint16Array(bytes.buffer);
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) out[i] = f16ToF32(u16[i]);
  return { frames: robot.frames, bodies: robot.bodies, names: robot.names, xforms: out };
}

function splitClipId(id) {
  const parts = id.replace(/\.csv$/i, "").split("/");
  const name = parts[parts.length - 1];
  const cat = parts.length > 1 ? parts[parts.length - 2] : (parts[0] || "—");
  return { category: cat, name };
}

function brightenFfMasterVertexColors(geometry) {
  // White shells should read white (FF Master look); keep dark joints + orange feet.
  const attr = geometry.getAttribute("color");
  if (!attr) return;
  for (let i = 0; i < attr.count; i++) {
    let r = attr.getX(i);
    let g = attr.getY(i);
    let b = attr.getZ(i);
    // Orange / yellow accents (ankles): leave alone.
    if (r > 0.85 && g > 0.25 && g < 0.7 && b < 0.35) continue;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luma >= 0.72) {
      // near-white panels → pure white
      attr.setXYZ(i, 1, 1, 1);
    } else if (luma >= 0.45) {
      // light grey panels → lift toward white
      const t = 0.55;
      attr.setXYZ(i, r + (1 - r) * t, g + (1 - g) * t, b + (1 - b) * t);
    }
    // dark greys (head / joints / pelvis) stay for contrast
  }
  attr.needsUpdate = true;
}

function prepareRobotMaterials(root, { whiten = false } = {}) {
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.castShadow = true;
    obj.receiveShadow = true;
    if (obj.geometry) {
      if (whiten) brightenFfMasterVertexColors(obj.geometry);
      obj.geometry.deleteAttribute("normal");
      obj.geometry.computeVertexNormals();
    }
    const hasColor = !!(obj.geometry && obj.geometry.getAttribute("color"));
    const olds = Array.isArray(obj.material) ? obj.material : [obj.material];
    const next = olds.map((old) => {
      const color = old?.color ? old.color.clone() : new THREE.Color(0xb3b3b3);
      const mat = new THREE.MeshStandardMaterial({
        color: hasColor ? 0xffffff : color,
        roughness: whiten ? 0.4 : 0.5,
        metalness: 0.0,
        envMapIntensity: 0.0,
        vertexColors: hasColor,
        side: THREE.FrontSide,
      });
      // Soft lift only for whitened light shells (skip orange / dark meshes).
      if (whiten && hasColor) {
        const attr = obj.geometry.getAttribute("color");
        let sr = 0, sg = 0, sb = 0;
        const n = Math.min(attr.count, 64);
        for (let i = 0; i < n; i++) {
          sr += attr.getX(i); sg += attr.getY(i); sb += attr.getZ(i);
        }
        sr /= n; sg /= n; sb /= n;
        const luma = 0.2126 * sr + 0.7152 * sg + 0.0722 * sb;
        const isOrange = sr > 0.85 && sg > 0.25 && sg < 0.7 && sb < 0.35;
        if (!isOrange && luma > 0.55) {
          mat.emissive = new THREE.Color(0x333333);
          mat.emissiveIntensity = 1.0;
        }
      }
      old?.dispose?.();
      return mat;
    });
    obj.material = Array.isArray(obj.material) ? next : next[0];
  });
}

function collectNamedNodes(root) {
  const map = {};
  root.traverse((obj) => {
    if (!obj.name || obj.name === "Scene" || obj.name === "world") return;
    if (!(obj.name in map) || obj.children.length > 0) map[obj.name] = obj;
  });
  return map;
}

async function loadRobotGlb(url, parent, opts = {}) {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  parent.clear();
  parent.add(gltf.scene);
  prepareRobotMaterials(gltf.scene, opts);
  const nodes = collectNamedNodes(gltf.scene);
  for (const obj of Object.values(nodes)) obj.matrixAutoUpdate = false;
  return nodes;
}

function applyFrame(nodes, data, frameIdx) {
  const { bodies, names, xforms } = data;
  const base = frameIdx * bodies * 7;
  for (let b = 0; b < bodies; b++) {
    const node = nodes[names[b]];
    if (!node) continue;
    const o = base + b * 7;
    _pos.set(xforms[o], xforms[o + 1], xforms[o + 2]);
    _quat.set(xforms[o + 3], xforms[o + 4], xforms[o + 5], xforms[o + 6]);
    _mat.compose(_pos, _quat, _scale);
    node.matrix.copy(_mat);
    node.matrixWorldNeedsUpdate = true;
  }
}

function setShowMode(mode) {
  showMode = mode;
  g1Root.visible = mode === "both" || mode === "g1";
  ffMasterRoot.visible = mode === "both" || mode === "ff_master";
  document.querySelectorAll(".model-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
  // When solo, drop the side offset so the robot sits on origin.
  if (clip) centerRoots();
}

function centerRoots() {
  if (!clip) return;
  const ox = 0.5 * (clip.g1.xforms[0] + clip.ff_master.xforms[0]);
  if (showMode === "both") {
    g1Root.position.set(-ox, G1_Y, 0);
    ffMasterRoot.position.set(-ox, FF_MASTER_Y, 0);
  } else if (showMode === "g1") {
    g1Root.position.set(-clip.g1.xforms[0], 0, 0);
  } else {
    ffMasterRoot.position.set(-clip.ff_master.xforms[0], 0, 0);
  }
}

function resize() {
  const parent = el.canvas.parentElement;
  const w = parent.clientWidth || 1;
  const h = parent.clientHeight || 1;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// Screen-space orbit (not world-up turntable): horizontal drag only moves
// left/right on screen; vertical drag only moves up/down. Avoids the
// "drag left but pitch also changes" coupling of Z-up OrbitControls.
const orbit = {
  target: new THREE.Vector3(0, 0, 0.85),
  dragging: false,
  lastX: 0,
  lastY: 0,
  minR: 1.4,
  maxR: 14,
  minPitch: -0.15,
  maxPitch: 1.4,
};
const _offset = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 0, 1);

function applyCamera() {
  camera.up.copy(_worldUp);
  camera.lookAt(orbit.target);
}

function placeOrbit(yaw, pitch, radius) {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  camera.position.set(
    orbit.target.x + radius * cp * Math.cos(yaw),
    orbit.target.y + radius * cp * Math.sin(yaw),
    orbit.target.z + radius * sp,
  );
  applyCamera();
}

function setView(name) {
  const d = 4.2;
  const map = {
    front: { yaw: -Math.PI / 2, pitch: 0.22, r: d },
    back: { yaw: Math.PI / 2, pitch: 0.22, r: d },
    left: { yaw: Math.PI, pitch: 0.22, r: d },
    right: { yaw: 0, pitch: 0.22, r: d },
    top: { yaw: -Math.PI / 2, pitch: 1.35, r: d },
    persp: { yaw: 0.55, pitch: 0.55, r: d },
  };
  const v = map[name] || map.persp;
  placeOrbit(v.yaw, v.pitch, v.r);
}

function pitchFromOffset(offset) {
  const r = offset.length();
  if (r < 1e-6) return 0;
  return Math.asin(THREE.MathUtils.clamp(offset.z / r, -1, 1));
}

function orbitByScreenDelta(dx, dy) {
  const h = Math.max(1, el.canvas.clientHeight);
  // Same angular scale as Three.js OrbitControls.
  const sx = (2 * Math.PI * dx) / h;
  const sy = (2 * Math.PI * dy) / h;

  _offset.copy(camera.position).sub(orbit.target);

  // Horizontal: rotate about camera screen-up → pure left/right on screen.
  _axis.set(0, 1, 0).transformDirection(camera.matrixWorld).normalize();
  _offset.applyAxisAngle(_axis, -sx);
  camera.position.copy(orbit.target).add(_offset);
  applyCamera();

  // Vertical: rotate about camera screen-right → pure up/down on screen.
  _offset.copy(camera.position).sub(orbit.target);
  const before = _offset.clone();
  _axis.set(1, 0, 0).transformDirection(camera.matrixWorld).normalize();
  _offset.applyAxisAngle(_axis, -sy);
  const pitch = pitchFromOffset(_offset);
  if (pitch >= orbit.minPitch && pitch <= orbit.maxPitch) {
    camera.position.copy(orbit.target).add(_offset);
  } else {
    camera.position.copy(orbit.target).add(before);
  }
  applyCamera();
}

el.canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  orbit.dragging = true;
  orbit.lastX = e.clientX;
  orbit.lastY = e.clientY;
  el.canvas.setPointerCapture(e.pointerId);
});
el.canvas.addEventListener("pointerup", (e) => {
  orbit.dragging = false;
  try { el.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
});
el.canvas.addEventListener("pointermove", (e) => {
  if (!orbit.dragging) return;
  const dx = e.clientX - orbit.lastX;
  const dy = e.clientY - orbit.lastY;
  orbit.lastX = e.clientX;
  orbit.lastY = e.clientY;
  orbitByScreenDelta(dx, dy);
});
el.canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  _offset.copy(camera.position).sub(orbit.target);
  const next = _offset.length() * (e.deltaY > 0 ? 1.08 : 0.92);
  _offset.setLength(THREE.MathUtils.clamp(next, orbit.minR, orbit.maxR));
  camera.position.copy(orbit.target).add(_offset);
  applyCamera();
}, { passive: false });

function renderTable() {
  el.clipBody.innerHTML = "";
  for (let i = 0; i < filtered.length; i++) {
    const c = filtered[i];
    const { category, name } = splitClipId(c.id);
    const tr = document.createElement("tr");
    tr.dataset.idx = String(i);
    if (i === clipIndex) tr.classList.add("active");
    tr.innerHTML = `<td title="${category}">${category}</td><td title="${name}">${name}</td>`;
    tr.addEventListener("click", () => setClipIndex(i));
    el.clipBody.appendChild(tr);
  }
  el.clipCount.textContent = `${filtered.length} / ${manifest.clips.length} clips`;
}

function applyFilter() {
  const q = (el.filter.value || "").trim().toLowerCase();
  filtered = !q
    ? manifest.clips.slice()
    : manifest.clips.filter((c) => c.id.toLowerCase().includes(q));
  const keep = clip ? filtered.findIndex((c) => c.id === clip.name) : -1;
  renderTable();
  if (filtered.length) setClipIndex(keep >= 0 ? keep : 0);
  else {
    clip = null;
    el.status.textContent = "No clips match";
  }
}

const G1_HF_DATASET = "CMRobot/MotionDecode";
const G1_HF_CSV = (relCsv) =>
  `https://huggingface.co/datasets/${G1_HF_DATASET}/resolve/main/samples/${String(relCsv).replace(/^\/+/, "")}`;
const FF_HF_DATASET = "zhiyangrobot/g1-ffmaster-retarget";
const FF_HF_CSV = (relCsv) =>
  `https://huggingface.co/datasets/${FF_HF_DATASET}/resolve/main/csv/ff_master/${String(relCsv).replace(/^\/+/, "")}`;

function updateMeta(entry) {
  const { category, name } = splitClipId(entry.id);
  el.mName.textContent = name;
  el.mCat.textContent = category;
  el.mFrames.textContent = String(entry.frames);
  el.mDur.textContent = `${entry.duration_s.toFixed(2)} s`;
  el.mFps.textContent = String(manifest.fps);
  if (el.mG1Link) {
    const url = G1_HF_CSV(entry.id);
    el.mG1Link.innerHTML = `<a href="${url}" target="_blank" rel="noopener">Download Unitree G1 CSV</a>`;
  }
  if (el.mFfLink) {
    const url = FF_HF_CSV(entry.id);
    el.mFfLink.innerHTML = `<a href="${url}" target="_blank" rel="noopener">Download FF Master CSV</a>`;
  }
}

function assetUrl(path) {
  if (!path) return path;
  if (/^https?:\/\//i.test(path)) return path;
  const base = (manifest && manifest.baseUrl) || "";
  if (!base) return path;
  return base + String(path).replace(/^\.\//, "").replace(/^\//, "");
}

async function loadClip(entry) {
  el.status.textContent = `Loading ${entry.id}…`;
  const res = await fetch(assetUrl(entry.file));
  if (!res.ok) throw new Error(`Failed to load ${entry.file}`);
  const data = await res.json();
  const g1 = decodeXforms(data.g1);
  if (!data.ff_master) throw new Error("clip missing ff_master motion");
  const ff_master = decodeXforms(data.ff_master);
  clip = {
    name: data.name,
    fps: data.fps || manifest.fps,
    frames: Math.min(g1.frames, ff_master.frames),
    g1,
    ff_master,
  };
  centerRoots();
  frame = 0;
  accum = 0;
  el.scrub.max = String(Math.max(0, clip.frames - 1));
  el.scrub.value = "0";
  updateMeta(entry);
  el.status.textContent = entry.id;
  drawFrame(0);
  renderTable();
}

async function setClipIndex(i) {
  if (!filtered.length) return;
  clipIndex = ((i % filtered.length) + filtered.length) % filtered.length;
  try {
    await loadClip(filtered[clipIndex]);
  } catch (err) {
    el.status.textContent = String(err.message || err);
    console.error(err);
  }
}

function drawFrame(f) {
  if (!clip) return;
  applyFrame(g1Nodes, clip.g1, f);
  applyFrame(ffMasterNodes, clip.ff_master, f);
  g1Root.updateMatrixWorld(true);
  ffMasterRoot.updateMatrixWorld(true);
  el.timeLabel.textContent = `${f} / ${clip.frames - 1}`;
  el.scrub.value = String(f);
}

function tick(ts) {
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;
  if (playing && clip && clip.frames > 1) {
    accum += dt * speed;
    const frameDt = 1 / clip.fps;
    while (accum >= frameDt) {
      accum -= frameDt;
      frame += 1;
      if (frame >= clip.frames) {
        if (el.loop.checked) frame = 0;
        else {
          frame = clip.frames - 1;
          playing = false;
          el.btnPlay.textContent = "▶";
        }
      }
      drawFrame(frame);
    }
  }
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

el.btnPlay.addEventListener("click", () => {
  playing = !playing;
  el.btnPlay.textContent = playing ? "⏸" : "▶";
});
el.btnPrev.addEventListener("click", () => setClipIndex(clipIndex - 1));
el.btnNext.addEventListener("click", () => setClipIndex(clipIndex + 1));
el.scrub.addEventListener("input", () => {
  frame = Number(el.scrub.value) | 0;
  accum = 0;
  drawFrame(frame);
});
el.speed.addEventListener("input", () => {
  speed = Number(el.speed.value);
  el.speedLabel.textContent = `${speed}×`;
});
el.filter.addEventListener("input", applyFilter);
el.btnGrid.addEventListener("click", () => { grid.visible = !grid.visible; });
el.btnCenter.addEventListener("click", () => {
  orbit.target.set(0, 0, 0.85);
  setView("persp");
});
document.querySelectorAll("#view-cube button").forEach((b) => {
  b.addEventListener("click", () => setView(b.dataset.view));
});
document.querySelectorAll(".model-btn").forEach((b) => {
  b.addEventListener("click", () => setShowMode(b.dataset.mode));
});

window.addEventListener("keydown", (e) => {
  if (e.target === el.filter) return;
  if (e.key === " ") {
    e.preventDefault();
    el.btnPlay.click();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    setClipIndex(clipIndex - 1);
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    setClipIndex(clipIndex + 1);
  } else if (e.key === "ArrowLeft") {
    frame = Math.max(0, frame - 1);
    drawFrame(frame);
  } else if (e.key === "ArrowRight" && clip) {
    frame = Math.min(clip.frames - 1, frame + 1);
    drawFrame(frame);
  }
});
window.addEventListener("resize", resize);

async function boot() {
  resize();
  setView("persp");
  // Always show product name; ignore stale cached manifest titles.
  const brandTitle = "Unitree G1 → FF Master Retargeter";
  el.title.textContent = brandTitle;
  document.title = brandTitle;
  const res = await fetch(`data/manifest.json?v=${Date.now()}`);
  if (!res.ok) {
    el.status.textContent = "Missing data/manifest.json — run bake_web_reviewer.py";
    requestAnimationFrame(tick);
    return;
  }
  manifest = await res.json();
  // Keep brand fixed even if manifest.title is stale.
  el.title.textContent = brandTitle;
  document.title = brandTitle;
  el.status.textContent = "Loading meshes…";
  g1Nodes = await loadRobotGlb(assetUrl(manifest.models.g1), g1Root);
  const ffMesh = (manifest.models && manifest.models.ff_master) || "models/ff_master.glb";
  ffMasterNodes = await loadRobotGlb(assetUrl(ffMesh), ffMasterRoot, { whiten: true });
  applyFilter();
  requestAnimationFrame(tick);
}

boot().catch((err) => {
  el.status.textContent = String(err.message || err);
  console.error(err);
});
