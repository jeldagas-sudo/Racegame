import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const WORLD_SIZE = 520;
const BASE_SPEED = 72;
const MAX_SPEED = 240;
const TURN_RATE = 1.8;
const DRAG = 0.35;

const RadialBlurShader = {
  uniforms: {
    tDiffuse: { value: null },
    intensity: { value: 0.0 },
    center: { value: new THREE.Vector2(0.5, 0.5) },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float intensity;
    uniform vec2 center;
    varying vec2 vUv;
    void main() {
      vec2 dir = vUv - center;
      vec4 color = vec4(0.0);
      float totalWeight = 0.0;
      for (int i = 0; i < 12; i++) {
        float t = float(i) / 11.0;
        float weight = 1.0 - t * 0.5;
        color += texture2D(tDiffuse, vUv - dir * t * intensity * 0.04) * weight;
        totalWeight += weight;
      }
      gl_FragColor = color / totalWeight;
    }
  `,
};

class AudioManager {
  constructor() {
    this.ctx = null;
    this.initialized = false;
    this.masterGain = null;
    this.engineNodes = null;
    this.windNode = null;
    this.skidNode = null;
  }

  init() {
    if (this.initialized) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.65;
      this.masterGain.connect(this.ctx.destination);
      this.initialized = true;
    } catch (e) {
      console.warn('Web Audio not available');
    }
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  startEngine() {
    if (!this.initialized) return;
    this.resume();
    const ctx = this.ctx;

    const engineGain = ctx.createGain();
    engineGain.gain.value = 0;
    engineGain.connect(this.masterGain);

    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = 90;
    const g1 = ctx.createGain();
    g1.gain.value = 0.12;

    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.value = 130;
    const g2 = ctx.createGain();
    g2.gain.value = 0.07;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 500;

    osc1.connect(g1);
    osc2.connect(g2);
    g1.connect(filter);
    g2.connect(filter);
    filter.connect(engineGain);

    osc1.start();
    osc2.start();
    this.engineNodes = { osc1, osc2, filter, engineGain };

    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    windGain.connect(this.masterGain);

    const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;

    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 850;

    noise.connect(windFilter);
    windFilter.connect(windGain);
    noise.start();

    this.windNode = { source: noise, gain: windGain, filter: windFilter };

    const skidNoise = ctx.createBufferSource();
    skidNoise.buffer = noiseBuffer;
    skidNoise.loop = true;
    const skidFilter = ctx.createBiquadFilter();
    skidFilter.type = 'bandpass';
    skidFilter.frequency.value = 1800;
    const skidGain = ctx.createGain();
    skidGain.gain.value = 0;
    skidNoise.connect(skidFilter);
    skidFilter.connect(skidGain);
    skidGain.connect(this.masterGain);
    skidNoise.start();
    this.skidNode = { source: skidNoise, gain: skidGain, filter: skidFilter };
  }

  updateEngine(speedNorm, steerIntensity, accelNorm) {
    if (!this.engineNodes) return;
    const t = Math.min(Math.max(speedNorm, 0), 1);
    this.engineNodes.osc1.frequency.value = 75 + t * 210;
    this.engineNodes.osc2.frequency.value = 120 + t * 250 + accelNorm * 80;
    this.engineNodes.filter.frequency.value = 320 + t * 1700;
    this.engineNodes.engineGain.gain.value = 0.06 + t * 0.24 + accelNorm * 0.05;

    if (this.windNode) {
      this.windNode.gain.gain.value = 0.03 + t * t * 0.16;
      this.windNode.filter.frequency.value = 500 + t * 2400;
    }

    if (this.skidNode) {
      this.skidNode.gain.gain.value = steerIntensity * steerIntensity * t * 0.17;
      this.skidNode.filter.frequency.value = 1200 + steerIntensity * 900;
    }
  }

  stopEngine() {
    const t = this.ctx?.currentTime || 0;
    if (this.engineNodes) {
      this.engineNodes.engineGain.gain.linearRampToValueAtTime(0, t + 0.2);
      setTimeout(() => {
        try { this.engineNodes.osc1.stop(); this.engineNodes.osc2.stop(); } catch (e) {}
        this.engineNodes = null;
      }, 300);
    }
    if (this.windNode) {
      this.windNode.gain.gain.linearRampToValueAtTime(0, t + 0.2);
      setTimeout(() => {
        try { this.windNode.source.stop(); } catch (e) {}
        this.windNode = null;
      }, 300);
    }
    if (this.skidNode) {
      this.skidNode.gain.gain.linearRampToValueAtTime(0, t + 0.2);
      setTimeout(() => {
        try { this.skidNode.source.stop(); } catch (e) {}
        this.skidNode = null;
      }, 300);
    }
  }

  playUIClick() {
    if (!this.initialized) return;
    this.resume();
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.value = 0.14;
    gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.08);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.08);
  }
}

function createVehicle() {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.9, 0.55, 4.2),
    new THREE.MeshStandardMaterial({ color: 0xff8fab, metalness: 0.45, roughness: 0.35 })
  );
  body.position.y = 0.55;
  group.add(body);

  const sidePanel = new THREE.Mesh(
    new THREE.BoxGeometry(1.75, 0.24, 3.8),
    new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.2, roughness: 0.45 })
  );
  sidePanel.position.y = 0.72;
  group.add(sidePanel);

  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(1.35, 0.5, 1.9),
    new THREE.MeshStandardMaterial({ color: 0x89cff0, metalness: 0.55, roughness: 0.15, transparent: true, opacity: 0.8 })
  );
  cabin.position.set(0, 1.03, -0.25);
  group.add(cabin);

  const accent = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.08, 3.8),
    new THREE.MeshStandardMaterial({ color: 0xfff4b8, emissive: 0xfff4b8, emissiveIntensity: 0.7 })
  );
  accent.position.set(-0.95, 0.45, 0);
  group.add(accent);
  const accent2 = accent.clone();
  accent2.position.x = 0.95;
  group.add(accent2);

  const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.4 });
  const headGeom = new THREE.BoxGeometry(0.28, 0.12, 0.06);
  const h1 = new THREE.Mesh(headGeom, headMat);
  h1.position.set(-0.56, 0.52, -2.09);
  group.add(h1);
  const h2 = h1.clone();
  h2.position.x = 0.56;
  group.add(h2);

  const tailMat = new THREE.MeshStandardMaterial({ color: 0xff6b6b, emissive: 0xff6b6b, emissiveIntensity: 1.2 });
  const t1 = new THREE.Mesh(headGeom, tailMat);
  t1.position.set(-0.58, 0.52, 2.09);
  group.add(t1);
  const t2 = t1.clone();
  t2.position.x = 0.58;
  group.add(t2);

  const wheelGeom = new THREE.CylinderGeometry(0.31, 0.31, 0.2, 14);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x2b2d42, roughness: 0.65, metalness: 0.2 });
  [[-0.92,0.3,-1.25],[0.92,0.3,-1.25],[-0.92,0.3,1.25],[0.92,0.3,1.25]].forEach(([x,y,z]) => {
    const wheel = new THREE.Mesh(wheelGeom, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(x,y,z);
    group.add(wheel);
  });

  return group;
}

class SpeedParticles {
  constructor(scene) {
    this.count = 180;
    const geom = new THREE.BufferGeometry();
    this.positions = new Float32Array(this.count * 3);
    this.velocities = new Float32Array(this.count * 3);

    for (let i = 0; i < this.count; i++) {
      this.positions[i * 3] = (Math.random() - 0.5) * 40;
      this.positions[i * 3 + 1] = Math.random() * 9 + 1;
      this.positions[i * 3 + 2] = (Math.random() - 0.5) * 120;
      this.velocities[i * 3 + 2] = 1 + Math.random() * 2;
    }

    geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.mesh = new THREE.Points(
      geom,
      new THREE.PointsMaterial({
        color: 0xffffff,
        size: 0.12,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      })
    );
    scene.add(this.mesh);
  }

  update(speedNorm, worldPos) {
    this.mesh.material.opacity = 0.2 + speedNorm * 0.45;
    const pos = this.mesh.geometry.attributes.position;

    for (let i = 0; i < this.count; i++) {
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * (1 + speedNorm * 3);
      if (this.positions[i * 3 + 2] > 20) {
        this.positions[i * 3] = (Math.random() - 0.5) * 40;
        this.positions[i * 3 + 1] = 1 + Math.random() * 9;
        this.positions[i * 3 + 2] = -80 - Math.random() * 80;
      }
    }

    pos.needsUpdate = true;
    this.mesh.position.copy(worldPos);
  }
}

class WorldGenerator {
  constructor(scene) {
    this.scene = scene;
    this.decorations = new THREE.Group();
    this.scene.add(this.decorations);

    this.createGround();
    this.createRoadNetwork();
    this.createProps();
  }

  createGround() {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xb8e0d2, roughness: 0.95, metalness: 0.02 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    this.decorations.add(ground);

    const tintPatchColors = [0xf7d6e0, 0xcde7be, 0xbde0fe, 0xfff1b6, 0xe2d7ff];
    for (let i = 0; i < 55; i++) {
      const size = 10 + Math.random() * 30;
      const patch = new THREE.Mesh(
        new THREE.CircleGeometry(size, 20),
        new THREE.MeshStandardMaterial({
          color: tintPatchColors[Math.floor(Math.random() * tintPatchColors.length)],
          roughness: 1,
          metalness: 0,
          transparent: true,
          opacity: 0.25,
        })
      );
      patch.rotation.x = -Math.PI / 2;
      patch.position.set((Math.random() - 0.5) * (WORLD_SIZE - 20), -0.01, (Math.random() - 0.5) * (WORLD_SIZE - 20));
      this.decorations.add(patch);
    }
  }

  createRoadNetwork() {
    const roadMat = new THREE.MeshStandardMaterial({ color: 0x8f98ad, roughness: 0.7, metalness: 0.05 });
    const laneMat = new THREE.MeshStandardMaterial({ color: 0xfff6da, roughness: 0.6 });

    const lanes = [-140, -70, 0, 70, 140];
    lanes.forEach((x) => {
      const road = new THREE.Mesh(new THREE.PlaneGeometry(32, WORLD_SIZE - 20), roadMat);
      road.rotation.x = -Math.PI / 2;
      road.position.set(x, 0, 0);
      this.decorations.add(road);

      const centerLine = new THREE.Mesh(new THREE.PlaneGeometry(0.6, WORLD_SIZE - 20), laneMat);
      centerLine.rotation.x = -Math.PI / 2;
      centerLine.position.set(x, 0.02, 0);
      this.decorations.add(centerLine);
    });

    lanes.forEach((z) => {
      const road = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_SIZE - 20, 32), roadMat);
      road.rotation.x = -Math.PI / 2;
      road.position.set(0, 0.001, z);
      this.decorations.add(road);

      const centerLine = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_SIZE - 20, 0.6), laneMat);
      centerLine.rotation.x = -Math.PI / 2;
      centerLine.position.set(0, 0.021, z);
      this.decorations.add(centerLine);
    });

    const ringRoad = new THREE.Mesh(
      new THREE.RingGeometry(165, 182, 64),
      new THREE.MeshStandardMaterial({ color: 0x96a2b5, roughness: 0.72 })
    );
    ringRoad.rotation.x = -Math.PI / 2;
    ringRoad.position.y = 0.001;
    this.decorations.add(ringRoad);
  }

  createProps() {
    const treeTrunkMat = new THREE.MeshStandardMaterial({ color: 0xb08968, roughness: 0.95 });
    const treeLeafColors = [0xbde7c4, 0xd4f4dd, 0xc3f0ca, 0xaed9b4];

    for (let i = 0; i < 120; i++) {
      const x = (Math.random() - 0.5) * (WORLD_SIZE - 20);
      const z = (Math.random() - 0.5) * (WORLD_SIZE - 20);
      const nearRoad = (Math.abs((Math.abs(x) % 70) - 0) < 18) || (Math.abs((Math.abs(z) % 70) - 0) < 18);
      if (nearRoad) continue;

      const tree = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 4, 8), treeTrunkMat);
      trunk.position.y = 2;
      tree.add(trunk);
      const crown = new THREE.Mesh(
        new THREE.SphereGeometry(2.6 + Math.random() * 1.5, 14, 12),
        new THREE.MeshStandardMaterial({
          color: treeLeafColors[Math.floor(Math.random() * treeLeafColors.length)],
          roughness: 0.9,
          metalness: 0,
        })
      );
      crown.position.y = 5.2;
      tree.add(crown);
      tree.position.set(x, 0, z);
      this.decorations.add(tree);
    }

    const buildingPalette = [0xffcad4, 0xcdb4db, 0xa2d2ff, 0xbde0fe, 0xfff1b6];
    for (let i = 0; i < 65; i++) {
      const w = 7 + Math.random() * 10;
      const h = 6 + Math.random() * 28;
      const d = 7 + Math.random() * 10;
      const building = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshStandardMaterial({
          color: buildingPalette[Math.floor(Math.random() * buildingPalette.length)],
          roughness: 0.82,
          metalness: 0.08,
        })
      );
      building.position.set((Math.random() - 0.5) * (WORLD_SIZE - 35), h / 2, (Math.random() - 0.5) * (WORLD_SIZE - 35));
      if (Math.abs(building.position.x) < 30 || Math.abs(building.position.z) < 30) continue;
      this.decorations.add(building);
    }

    for (let i = 0; i < 8; i++) {
      const pond = new THREE.Mesh(
        new THREE.CircleGeometry(8 + Math.random() * 10, 24),
        new THREE.MeshStandardMaterial({ color: 0x9bd3ff, transparent: true, opacity: 0.75, roughness: 0.2, metalness: 0.15 })
      );
      pond.rotation.x = -Math.PI / 2;
      pond.position.set((Math.random() - 0.5) * (WORLD_SIZE - 40), 0.01, (Math.random() - 0.5) * (WORLD_SIZE - 40));
      this.decorations.add(pond);
    }
  }

  update() {}
  reset() {}
}

class TouchControls {
  constructor() {
    this.steerInput = 0;
    this.touching = false;
    this.screenWidth = window.innerWidth;
    this.touchPadEl = document.getElementById('touchPad');
    this.touchKnobEl = document.getElementById('touchKnob');
    this.padActive = false;

    window.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    window.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    window.addEventListener('touchend', () => this.onTouchEnd());
    window.addEventListener('touchcancel', () => this.onTouchEnd());

    if (this.touchPadEl) {
      this.touchPadEl.style.display = 'block';
      this.touchPadEl.addEventListener('pointerdown', (e) => this.onPadDown(e));
      window.addEventListener('pointermove', (e) => this.onPadMove(e));
      window.addEventListener('pointerup', () => this.onPadUp());
      window.addEventListener('pointercancel', () => this.onPadUp());
    }

    this.keys = {};
    window.addEventListener('keydown', (e) => { this.keys[e.key] = true; });
    window.addEventListener('keyup', (e) => { this.keys[e.key] = false; });

    window.addEventListener('resize', () => {
      this.screenWidth = window.innerWidth;
    });
  }

  onTouchStart(e) {
    e.preventDefault();
    const touch = e.touches[0];
    this.touching = true;
    this.updateSteerFromPosition(touch.clientX);
  }

  onTouchMove(e) {
    e.preventDefault();
    if (!this.touching) return;
    this.updateSteerFromPosition(e.touches[0].clientX);
  }

  onTouchEnd() {
    this.touching = false;
    if (!this.padActive) this.steerInput = 0;
  }

  updateSteerFromPosition(x) {
    const normalized = (x / this.screenWidth - 0.5) * 2;
    this.steerInput = Math.max(-1, Math.min(1, normalized * 1.35));
  }

  onPadDown(e) {
    if (!this.touchPadEl) return;
    this.padActive = true;
    this.touching = false;
    this.updatePadInput(e.clientX, e.clientY);
  }

  onPadMove(e) {
    if (!this.padActive) return;
    this.updatePadInput(e.clientX, e.clientY);
  }

  onPadUp() {
    if (!this.padActive) return;
    this.padActive = false;
    this.steerInput = 0;
    if (this.touchKnobEl) {
      this.touchKnobEl.style.left = '50%';
      this.touchKnobEl.style.top = '50%';
    }
  }

  updatePadInput(clientX, clientY) {
    const rect = this.touchPadEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const maxRadius = rect.width * 0.34;
    const dist = Math.hypot(dx, dy) || 1;
    const clamped = Math.min(dist, maxRadius);
    const nx = (dx / dist) * clamped;
    const ny = (dy / dist) * clamped;

    this.steerInput = Math.max(-1, Math.min(1, nx / maxRadius));

    if (this.touchKnobEl) {
      this.touchKnobEl.style.left = `${50 + (nx / (rect.width / 2)) * 50}%`;
      this.touchKnobEl.style.top = `${50 + (ny / (rect.height / 2)) * 50}%`;
    }
  }

  getSteerInput() {
    if (this.keys.ArrowLeft || this.keys.a) return -1;
    if (this.keys.ArrowRight || this.keys.d) return 1;
    return this.steerInput;
  }
}

class Game {
  constructor() {
    this.state = 'menu';
    this.distance = 0;
    this.speed = BASE_SPEED;
    this.heading = 0;
    this.freeDriveDistance = 0;

    this.startScreen = document.getElementById('startScreen');
    this.hudEl = document.getElementById('hud');
    this.gameOverEl = document.getElementById('gameOver');
    this.scoreDisplay = document.getElementById('scoreDisplay');
    this.speedDisplay = document.getElementById('speedDisplay');
    this.comboDisplay = document.getElementById('comboDisplay');
    this.speedLinesEl = document.getElementById('speedLines');
    this.steerLeftEl = document.getElementById('steerLeft');
    this.steerRightEl = document.getElementById('steerRight');
    this.loadingEl = document.getElementById('loading');

    this.canvas = document.getElementById('gameCanvas');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.03;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9dd9ff);
    this.scene.fog = new THREE.FogExp2(0xaadfff, 0.0019);

    this.baseFOV = 66;
    this.camera = new THREE.PerspectiveCamera(this.baseFOV, window.innerWidth / window.innerHeight, 0.1, 1200);
    this.camera.position.set(0, 6, 14);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.72));
    const dir = new THREE.DirectionalLight(0xfff8e6, 0.95);
    dir.position.set(25, 45, 10);
    this.scene.add(dir);
    this.scene.add(new THREE.HemisphereLight(0x9dd9ff, 0xc8efc8, 0.9));

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.25, 0.9);
    this.composer.addPass(this.bloomPass);
    this.radialBlurPass = new ShaderPass(RadialBlurShader);
    this.radialBlurPass.uniforms.intensity.value = 0;
    this.composer.addPass(this.radialBlurPass);

    this.vehicle = createVehicle();
    this.vehicle.position.set(0, 0, 0);
    this.scene.add(this.vehicle);

    this.world = new WorldGenerator(this.scene);
    this.particles = new SpeedParticles(this.scene);
    this.controls = new TouchControls();
    this.audio = new AudioManager();

    this.createSkyElements();

    document.getElementById('startBtn').addEventListener('click', () => this.startGame());
    document.getElementById('restartBtn').addEventListener('click', () => this.restartGame());
    window.addEventListener('resize', () => this.onResize());

    this.loadingEl.style.display = 'none';
    this.clock = new THREE.Clock();

    this.animate();
    this.startGame({ playClickSound: false });
  }

  createSkyElements() {
    this.clouds = [];
    const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.42, depthWrite: false });
    for (let i = 0; i < 38; i++) {
      const cloud = new THREE.Mesh(new THREE.PlaneGeometry(28 + Math.random() * 42, 10 + Math.random() * 12), cloudMat.clone());
      cloud.position.set((Math.random() - 0.5) * 560, 30 + Math.random() * 28, (Math.random() - 0.5) * 560);
      cloud.userData.drift = (Math.random() - 0.5) * 0.8;
      this.scene.add(cloud);
      this.clouds.push(cloud);
    }

    const sun = new THREE.Mesh(
      new THREE.SphereGeometry(18, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0xfff0b5 })
    );
    sun.position.set(150, 68, -180);
    this.scene.add(sun);
    this.sunMesh = sun;
  }

  startGame(options = {}) {
    if (this.state === 'playing') return;
    this.audio.init();
    if (options.playClickSound !== false) this.audio.playUIClick();

    this.state = 'playing';
    this.distance = 0;
    this.freeDriveDistance = 0;
    this.speed = BASE_SPEED;
    this.heading = 0;

    this.vehicle.position.set(0, 0, 0);
    this.vehicle.rotation.set(0, 0, 0);

    this.startScreen.style.display = 'none';
    this.hudEl.style.display = 'block';
    this.gameOverEl.style.display = 'none';
    this.comboDisplay.style.opacity = '1';
    this.comboDisplay.textContent = 'OPEN WORLD FREE DRIVE';

    this.audio.startEngine();
    this.clock.start();
  }

  restartGame() {
    this.audio.init();
    this.audio.playUIClick();
    this.state = 'playing';
    this.distance = 0;
    this.freeDriveDistance = 0;
    this.speed = BASE_SPEED;
    this.heading = 0;
    this.vehicle.position.set(0, 0, 0);
    this.vehicle.rotation.set(0, 0, 0);
    this.hudEl.style.display = 'block';
    this.gameOverEl.style.display = 'none';
    this.comboDisplay.style.opacity = '1';
    this.comboDisplay.textContent = 'OPEN WORLD FREE DRIVE';
    this.audio.startEngine();
    this.clock.start();
  }

  clampToWorld() {
    const half = WORLD_SIZE / 2 - 8;
    this.vehicle.position.x = Math.max(-half, Math.min(half, this.vehicle.position.x));
    this.vehicle.position.z = Math.max(-half, Math.min(half, this.vehicle.position.z));
  }

  update(delta) {
    if (this.state !== 'playing') return;
    delta = Math.min(delta, 0.05);

    const steerInput = this.controls.getSteerInput();
    const targetSpeed = MAX_SPEED * 0.82;
    this.speed = THREE.MathUtils.lerp(this.speed, targetSpeed, 0.35 * delta);
    this.speed = Math.max(BASE_SPEED, this.speed - DRAG * delta);

    this.heading -= steerInput * TURN_RATE * delta;
    this.vehicle.rotation.y = this.heading;

    const forward = new THREE.Vector3(Math.sin(this.heading), 0, -Math.cos(this.heading));
    const moveDist = this.speed * delta;
    this.vehicle.position.addScaledVector(forward, moveDist);
    this.clampToWorld();

    this.vehicle.rotation.z = THREE.MathUtils.lerp(this.vehicle.rotation.z, -steerInput * 0.17, 0.12);
    this.vehicle.rotation.x = THREE.MathUtils.lerp(this.vehicle.rotation.x, -Math.abs(steerInput) * 0.03, 0.08);

    this.steerLeftEl.classList.toggle('active', steerInput < -0.2);
    this.steerRightEl.classList.toggle('active', steerInput > 0.2);

    this.distance += moveDist;
    this.freeDriveDistance = this.distance / 1000;

    const speedNorm = Math.min(this.speed / MAX_SPEED, 1);

    const cameraOffset = new THREE.Vector3(0, 5.8 - speedNorm, 13 - speedNorm * 4);
    cameraOffset.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.heading);
    const camTarget = this.vehicle.position.clone().add(cameraOffset);
    this.camera.position.lerp(camTarget, 0.08);

    const lookAhead = this.vehicle.position.clone().add(forward.clone().multiplyScalar(35 + speedNorm * 30));
    this.camera.lookAt(lookAhead.x, 1.1, lookAhead.z);

    const targetFOV = this.baseFOV + speedNorm * 22;
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFOV, 0.05);
    this.camera.updateProjectionMatrix();

    this.radialBlurPass.uniforms.intensity.value = speedNorm * speedNorm * 1.1;
    this.bloomPass.strength = 0.5 + speedNorm * 0.25;
    this.speedLinesEl.style.opacity = String(0.25 + speedNorm * speedNorm * 0.45);

    this.particles.update(speedNorm, this.vehicle.position);
    this.audio.updateEngine(speedNorm, Math.abs(steerInput), 0.25);

    if (this.sunMesh) this.sunMesh.position.set(this.vehicle.position.x + 150, 68, this.vehicle.position.z - 180);
    for (const cloud of this.clouds) {
      cloud.position.x += cloud.userData.drift * delta * 8;
      if (Math.abs(cloud.position.x - this.vehicle.position.x) > 330) {
        cloud.position.x = this.vehicle.position.x - Math.sign(cloud.userData.drift || 1) * 330;
      }
      if (Math.abs(cloud.position.z - this.vehicle.position.z) > 330) {
        cloud.position.z = this.vehicle.position.z + (Math.random() - 0.5) * 620;
      }
    }

    this.scoreDisplay.textContent = `CRUISE ${this.freeDriveDistance.toFixed(1)} KM`;
    this.speedDisplay.innerHTML = `${Math.floor(this.speed * 3.6)}<span> KM/H</span>`;
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    const delta = this.clock.getDelta();

    this.update(delta);

    if (this.state === 'menu') {
      const t = this.clock.getElapsedTime();
      this.camera.position.x = Math.sin(t * 0.3) * 12;
      this.camera.position.z = Math.cos(t * 0.3) * 12;
      this.camera.position.y = 6;
      this.camera.lookAt(0, 1, 0);
    }

    this.composer.render();
  }

  onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloomPass.resolution.set(w, h);
  }
}

new Game();
