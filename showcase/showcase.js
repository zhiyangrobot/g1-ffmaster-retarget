import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const STAGE_BG = 0x1a2a3a;
const el = {
  canvas: document.getElementById("stage"),
  status: document.getElementById("status"),
};

const renderer = new THREE.WebGLRenderer({
  canvas: el.canvas,
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setClearColor(STAGE_BG, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(STAGE_BG);
const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 120);
camera.up.set(0, 0, 1);

scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4a5a, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 2.0);
key.position.set(-4, -6, 10);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -10;
key.shadow.camera.right = 10;
key.shadow.camera.top = 10;
key.shadow.camera.bottom = -10;
key.shadow.bias = -0.0002;
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.7);
fill.position.set(5, 4, 6);
scene.add(fill);

function makeCheckerTexture() {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const cells = 16;
  const cell = size / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? "#0f2740" : "#1c3a55";
      ctx.fillRect(x * cell, y * cell, cell + 1, cell + 1);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 8);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshStandardMaterial({ map: makeCheckerTexture(), roughness: 0.95, metalness: 0 }),
);
ground.receiveShadow = true;
scene.add(ground);

function f16ToF32(u) {
  const sign = (u & 0x8000) >> 15;
  const exp = (u & 0x7c00) >> 10;
  const frac = u & 0x03ff;
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

function brighten(geometry) {
  const attr = geometry.getAttribute("color");
  if (!attr) return;
  for (let i = 0; i < attr.count; i++) {
    let r = attr.getX(i), g = attr.getY(i), b = attr.getZ(i);
    if (r > 0.85 && g > 0.25 && g < 0.7 && b < 0.35) continue;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luma >= 0.72) attr.setXYZ(i, 1, 1, 1);
    else if (luma >= 0.45) {
      const t = 0.55;
      attr.setXYZ(i, r + (1 - r) * t, g + (1 - g) * t, b + (1 - b) * t);
    }
  }
  attr.needsUpdate = true;
}

function prepareMaterials(root) {
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.castShadow = true;
    obj.receiveShadow = true;
    if (obj.geometry) {
      brighten(obj.geometry);
      obj.geometry.deleteAttribute("normal");
      obj.geometry.computeVertexNormals();
    }
    const hasColor = !!(obj.geometry && obj.geometry.getAttribute("color"));
    const olds = Array.isArray(obj.material) ? obj.material : [obj.material];
    const next = olds.map((old) => {
      const color = old?.color ? old.color.clone() : new THREE.Color(0xb3b3b3);
      const mat = new THREE.MeshStandardMaterial({
        color: hasColor ? 0xffffff : color,
        roughness: 0.4,
        metalness: 0,
        vertexColors: hasColor,
      });
      old?.dispose?.();
      return mat;
    });
    obj.material = Array.isArray(obj.material) ? next : next[0];
  });
}

function collectNodes(root) {
  const map = {};
  root.traverse((obj) => {
    if (!obj.name || obj.name === "Scene" || obj.name === "world") return;
    if (!(obj.name in map) || obj.children.length > 0) map[obj.name] = obj;
  });
  return map;
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _mat = new THREE.Matrix4();

function applyFrame(nodes, data, frameIdx) {
  const { bodies, names, xforms } = data;
  const f = ((frameIdx % data.frames) + data.frames) % data.frames;
  const base = f * bodies * 7;
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

function resize() {
  const w = innerWidth || 1;
  const h = innerHeight || 1;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

const agents = [];
let fps = 40;
let playing = true;
let lastTs = performance.now();

function tick(ts) {
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;
  if (playing) {
    for (const a of agents) {
      a.accum += dt;
      const frameDt = 1 / fps;
      while (a.accum >= frameDt) {
        a.accum -= frameDt;
        a.frame = (a.frame + 1) % a.motion.frames;
      }
      applyFrame(a.nodes, a.motion, a.frame);
      a.root.updateMatrixWorld(true);
    }
  }
  const t = ts * 0.00015;
  const r = 9.5;
  camera.position.set(Math.cos(t) * r, Math.sin(t) * r - 2.5, 5.2);
  camera.lookAt(0, 0, 0.9);
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

async function boot() {
  resize();
  addEventListener("resize", resize);
  el.status.textContent = "Loading showcase config…";
  const cfg = await (await fetch("./showcase_clips.json")).json();
  fps = cfg.fps || 40;
  el.status.textContent = "Loading robot mesh…";
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(cfg.model);
  prepareMaterials(gltf.scene);

  el.status.textContent = `Loading ${cfg.clips.length} motions…`;
  for (const spec of cfg.clips) {
    const data = await (await fetch(spec.file)).json();
    if (!data.ff_master) throw new Error(`missing ff_master in ${spec.file}`);
    const motion = decodeXforms(data.ff_master);
    const root = new THREE.Group();
    const clone = gltf.scene.clone(true);
    root.add(clone);
    scene.add(root);
    const nodes = collectNodes(clone);
    for (const obj of Object.values(nodes)) obj.matrixAutoUpdate = false;
    const ox = motion.xforms[0];
    const oy = motion.xforms[1];
    root.position.set(spec.x - ox, spec.y - oy, 0);
    agents.push({ root, nodes, motion, frame: 0, accum: Math.random() * 0.5 });
    applyFrame(nodes, motion, 0);
    root.updateMatrixWorld(true);
  }
  el.status.textContent = `${agents.length} robots · FF Master motions`;
  window.__SHOWCASE_READY__ = true;
  requestAnimationFrame(tick);
}

boot().catch((err) => {
  el.status.textContent = String(err.message || err);
  console.error(err);
});
