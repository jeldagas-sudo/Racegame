import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// ============================================================
// CONSTANTS
// ============================================================
const ROAD_WIDTH = 28;
const LANE_COUNT = 2;
const LANE_WIDTH = ROAD_WIDTH / LANE_COUNT;
const CHUNK_LENGTH = 140;
const VISIBLE_CHUNKS = 6;
const BASE_SPEED = 82;
const MAX_SPEED = 320;
const SPEED_INCREASE_RATE = 0.35;
const STEER_SPEED = 0;
const STEER_LIMIT = 210;
const OBSTACLE_INTERVAL_MIN = 18;
const OBSTACLE_INTERVAL_MAX = 45;
const NEAR_MISS_DISTANCE = 2.8;
const COLLISION_DISTANCE = 1.3;
const TURN_RATE = 1.65;
const MAP_LIMIT = 220;

// ============================================================
// RADIAL BLUR SHADER
// ============================================================
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

// ============================================================
// AUDIO MANAGER (Web Audio API procedural sounds)
// ============================================================
class AudioManager {
  constructor() {
    this.ctx = null;
    this.initialized = false;
    this.masterGain = null;
    this.engineNodes = null;
    this.windNode = null;
    this.turnSfxCooldown = 0;
  }

  init() {
    if (this.initialized) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.6;
      this.masterGain.connect(this.ctx.destination);
      this.initialized = true;
    } catch (e) {
      console.warn('Web Audio not available');
    }
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  // Continuous engine sound
  startEngine() {
    if (!this.initialized) return;
    this.resume();

    const ctx = this.ctx;
    // Engine oscillators
    const engineGain = ctx.createGain();
    engineGain.gain.value = 0.0;
    engineGain.connect(this.masterGain);

    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = 80;
    const osc1Gain = ctx.createGain();
    osc1Gain.gain.value = 0.15;

    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.value = 120;
    const osc2Gain = ctx.createGain();
    osc2Gain.gain.value = 0.08;

    const osc3 = ctx.createOscillator();
    osc3.type = 'triangle';
    osc3.frequency.value = 60;
    const osc3Gain = ctx.createGain();
    osc3Gain.gain.value = 0.12;

    // Distortion for engine grit
    const distortion = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i * 2) / 256 - 1;
      curve[i] = Math.tanh(x * 2);
    }
    distortion.curve = curve;

    // Low-pass filter
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 300;
    filter.Q.value = 2;

    osc1.connect(osc1Gain);
    osc2.connect(osc2Gain);
    osc3.connect(osc3Gain);
    osc1Gain.connect(distortion);
    osc2Gain.connect(distortion);
    osc3Gain.connect(distortion);
    distortion.connect(filter);
    filter.connect(engineGain);

    osc1.start();
    osc2.start();
    osc3.start();

    this.engineNodes = { osc1, osc2, osc3, engineGain, filter };

    // Wind noise
    const windGain = ctx.createGain();
    windGain.gain.value = 0.0;
    windGain.connect(this.masterGain);

    const bufferSize = ctx.sampleRate * 2;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    noiseSource.loop = true;

    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 800;
    windFilter.Q.value = 0.5;

    noiseSource.connect(windFilter);
    windFilter.connect(windGain);
    noiseSource.start();

    this.windNode = { source: noiseSource, gain: windGain, filter: windFilter };
  }

  updateEngine(speedNorm, delta = 0) {
    this.turnSfxCooldown = Math.max(0, this.turnSfxCooldown - delta);
    if (!this.engineNodes) return;
    const t = Math.min(speedNorm, 1);

    // Engine pitch and volume
    const baseFreq = 60 + t * 180;
    this.engineNodes.osc1.frequency.value = baseFreq;
    this.engineNodes.osc2.frequency.value = baseFreq * 1.5;
    this.engineNodes.osc3.frequency.value = baseFreq * 0.5;
    this.engineNodes.filter.frequency.value = 200 + t * 1500;
    this.engineNodes.engineGain.gain.value = 0.08 + t * 0.18;

    // Wind
    if (this.windNode) {
      this.windNode.gain.gain.value = t * t * 0.15;
      this.windNode.filter.frequency.value = 400 + t * 2500;
    }
  }


  playTurnSkid() {
    if (!this.initialized || this.turnSfxCooldown > 0) return;
    this.resume();
    this.turnSfxCooldown = 0.18;
    const ctx = this.ctx;

    const buffer = ctx.createBuffer(1, ctx.sampleRate * 0.08, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1800;
    const gain = ctx.createGain();
    gain.gain.value = 0.0;
    gain.gain.linearRampToValueAtTime(0.08, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    source.start();
    source.stop(ctx.currentTime + 0.1);
  }

  stopEngine() {
    if (this.engineNodes) {
      const t = this.ctx.currentTime;
      this.engineNodes.engineGain.gain.linearRampToValueAtTime(0, t + 0.3);
      setTimeout(() => {
        try {
          this.engineNodes.osc1.stop();
          this.engineNodes.osc2.stop();
          this.engineNodes.osc3.stop();
        } catch (e) {}
        this.engineNodes = null;
      }, 400);
    }
    if (this.windNode) {
      const t = this.ctx.currentTime;
      this.windNode.gain.gain.linearRampToValueAtTime(0, t + 0.3);
      setTimeout(() => {
        try { this.windNode.source.stop(); } catch (e) {}
        this.windNode = null;
    this.turnSfxCooldown = 0;
      }, 400);
    }
  }

  // One-shot sounds
  playBoost() {
    if (!this.initialized) return;
    this.resume();
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 200;
    osc.frequency.linearRampToValueAtTime(800, ctx.currentTime + 0.15);
    osc.frequency.linearRampToValueAtTime(400, ctx.currentTime + 0.4);

    const gain = ctx.createGain();
    gain.gain.value = 0.2;
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.4);

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  }

  playCrash() {
    if (!this.initialized) return;
    this.resume();
    const ctx = this.ctx;

    // Impact noise
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = buffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.05));
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 500;

    const gain = ctx.createGain();
    gain.gain.value = 0.4;
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.5);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    source.start();

    // Low thump
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 60;
    osc.frequency.linearRampToValueAtTime(20, ctx.currentTime + 0.3);

    const tGain = ctx.createGain();
    tGain.gain.value = 0.35;
    tGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);

    osc.connect(tGain);
    tGain.connect(this.masterGain);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  }

  playNearMiss() {
    if (!this.initialized) return;
    this.resume();
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 600;
    osc.frequency.linearRampToValueAtTime(1200, ctx.currentTime + 0.08);
    osc.frequency.linearRampToValueAtTime(800, ctx.currentTime + 0.15);

    const gain = ctx.createGain();
    gain.gain.value = 0.12;
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.15);

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  }

  playUIClick() {
    if (!this.initialized) return;
    this.resume();
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 880;

    const gain = ctx.createGain();
    gain.gain.value = 0.15;
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.08);

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
  }
}

// ============================================================
// VEHICLE BUILDER
// ============================================================
function createVehicle() {
  const group = new THREE.Group();

  // Body
  const bodyGeom = new THREE.BoxGeometry(1.8, 0.5, 4.0);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xf36f6f,
    metalness: 0.9,
    roughness: 0.2,
  });
  const body = new THREE.Mesh(bodyGeom, bodyMat);
  body.position.y = 0.5;
  group.add(body);

  // Cabin
  const cabinGeom = new THREE.BoxGeometry(1.4, 0.45, 1.8);
  const cabinMat = new THREE.MeshStandardMaterial({
    color: 0xc7d9ff,
    metalness: 0.8,
    roughness: 0.1,
    transparent: true,
    opacity: 0.7,
  });
  const cabin = new THREE.Mesh(cabinGeom, cabinMat);
  cabin.position.set(0, 0.95, -0.3);
  group.add(cabin);

  // Soft underglow
  const underglow = new THREE.PointLight(0xffc9de, 1.2, 5);
  underglow.position.set(0, 0.15, 0);
  group.add(underglow);

  // Front lights
  const headlightGeom = new THREE.BoxGeometry(0.3, 0.12, 0.05);
  const headlightMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 2,
  });
  const hl1 = new THREE.Mesh(headlightGeom, headlightMat);
  hl1.position.set(-0.55, 0.5, -2.0);
  group.add(hl1);
  const hl2 = hl1.clone();
  hl2.position.x = 0.55;
  group.add(hl2);

  // Tail lights
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0xff0033,
    emissive: 0xff0033,
    emissiveIntensity: 2,
  });
  const tl1 = new THREE.Mesh(headlightGeom, tailMat);
  tl1.position.set(-0.6, 0.5, 2.0);
  group.add(tl1);
  const tl2 = tl1.clone();
  tl2.position.x = 0.6;
  group.add(tl2);

  // Tail light glow
  const tailGlow = new THREE.PointLight(0xff0033, 1, 4);
  tailGlow.position.set(0, 0.5, 2.5);
  group.add(tailGlow);

  // Wheels
  const wheelGeom = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 8);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.5 });
  const wheelPositions = [
    [-0.9, 0.3, -1.2],
    [0.9, 0.3, -1.2],
    [-0.9, 0.3, 1.2],
    [0.9, 0.3, 1.2],
  ];
  wheelPositions.forEach(([x, y, z]) => {
    const wheel = new THREE.Mesh(wheelGeom, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(x, y, z);
    group.add(wheel);
  });

  // Side accent strips
  const stripGeom = new THREE.BoxGeometry(0.05, 0.08, 3.6);
  const stripMat = new THREE.MeshStandardMaterial({
    color: 0xfff5b8,
    emissive: 0xfff5b8,
    emissiveIntensity: 0.5,
  });
  const strip1 = new THREE.Mesh(stripGeom, stripMat);
  strip1.position.set(-0.92, 0.35, 0);
  group.add(strip1);
  const strip2 = strip1.clone();
  strip2.position.x = 0.92;
  group.add(strip2);

  group.castShadow = true;
  return group;
}

// ============================================================
// OBSTACLE VEHICLE BUILDER
// ============================================================
function createObstacleVehicle() {
  const group = new THREE.Group();
  const colors = [0xff0044, 0xff8800, 0xffff00, 0x00ff88, 0xff00ff, 0x8800ff];
  const color = colors[Math.floor(Math.random() * colors.length)];

  const bodyGeom = new THREE.BoxGeometry(1.6, 0.6, 3.5);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x181828,
    metalness: 0.7,
    roughness: 0.3,
  });
  const body = new THREE.Mesh(bodyGeom, bodyMat);
  body.position.y = 0.55;
  group.add(body);

  const cabinGeom = new THREE.BoxGeometry(1.2, 0.4, 1.4);
  const cabin = new THREE.Mesh(cabinGeom, bodyMat);
  cabin.position.set(0, 1.0, -0.2);
  group.add(cabin);

  // Neon accents
  const stripGeom = new THREE.BoxGeometry(0.05, 0.1, 3.2);
  const stripMat = new THREE.MeshStandardMaterial({
    color: color,
    emissive: color,
    emissiveIntensity: 1.5,
  });
  const s1 = new THREE.Mesh(stripGeom, stripMat);
  s1.position.set(-0.82, 0.45, 0);
  group.add(s1);
  const s2 = s1.clone();
  s2.position.x = 0.82;
  group.add(s2);

  // Tail lights
  const tlGeom = new THREE.BoxGeometry(0.5, 0.12, 0.05);
  const tlMat = new THREE.MeshStandardMaterial({
    color: 0xff0000,
    emissive: 0xff0000,
    emissiveIntensity: 2,
  });
  const tl1 = new THREE.Mesh(tlGeom, tlMat);
  tl1.position.set(-0.4, 0.55, 1.76);
  group.add(tl1);
  const tl2 = tl1.clone();
  tl2.position.x = 0.4;
  group.add(tl2);

  return group;
}

// ============================================================
// SPEED PARTICLES
// ============================================================
class SpeedParticles {
  constructor(scene) {
    this.count = 200;
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(this.count * 3);
    const velocities = new Float32Array(this.count * 3);

    for (let i = 0; i < this.count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 30;
      positions[i * 3 + 1] = Math.random() * 8 + 1;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 100;
      velocities[i * 3 + 2] = 0.5 + Math.random() * 1.5;
    }

    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.velocities = velocities;
    this.positions = positions;

    const mat = new THREE.PointsMaterial({
      color: 0xf7fbff,
      size: 0.15,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.mesh = new THREE.Points(geom, mat);
    scene.add(this.mesh);
  }

  update(speed, playerZ) {
    const speedNorm = Math.min(speed / MAX_SPEED, 1);
    this.mesh.material.opacity = speedNorm * 0.8;
    this.mesh.material.size = 0.08 + speedNorm * 0.35;

    const pos = this.mesh.geometry.attributes.position;
    for (let i = 0; i < this.count; i++) {
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * speedNorm * 3;

      if (this.positions[i * 3 + 2] > playerZ + 20) {
        this.positions[i * 3] = (Math.random() - 0.5) * 30;
        this.positions[i * 3 + 1] = Math.random() * 8 + 1;
        this.positions[i * 3 + 2] = playerZ - 60 - Math.random() * 40;
      }
    }
    pos.array.set(this.positions);
    pos.needsUpdate = true;
  }
}

// ============================================================
// WORLD GENERATOR
// ============================================================
class WorldGenerator {
  constructor(scene) {
    this.scene = scene;
    this.tiles = new Map();
    this.tileSize = 110;
    this.tileRadius = 2;

    this.groundMats = [
      new THREE.MeshStandardMaterial({ color: 0xc9eec6, roughness: 0.95 }),
      new THREE.MeshStandardMaterial({ color: 0xbfe5f7, roughness: 0.95 }),
      new THREE.MeshStandardMaterial({ color: 0xf7e6bd, roughness: 0.95 }),
      new THREE.MeshStandardMaterial({ color: 0xe8d6f8, roughness: 0.95 }),
    ];

    this.roadMat = new THREE.MeshStandardMaterial({
      color: 0xd8d2c8,
      roughness: 0.92,
      metalness: 0.05,
    });

    this.roadLineMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.7,
    });
  }

  createChunk() {}
  spawnObstacle() {}
  spawnBoostPad() {}

  createTile(tx, tz) {
    const tile = new THREE.Group();
    const x0 = tx * this.tileSize;
    const z0 = tz * this.tileSize;

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(this.tileSize, this.tileSize),
      this.groundMats[Math.abs((tx * 13 + tz * 17)) % this.groundMats.length]
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(x0, 0, z0);
    tile.add(ground);

    const roadW = 22;
    const roadX = new THREE.Mesh(new THREE.PlaneGeometry(roadW, this.tileSize), this.roadMat);
    roadX.rotation.x = -Math.PI / 2;
    roadX.position.set(x0, 0.02, z0);
    tile.add(roadX);

    const roadZ = new THREE.Mesh(new THREE.PlaneGeometry(this.tileSize, roadW), this.roadMat);
    roadZ.rotation.x = -Math.PI / 2;
    roadZ.position.set(x0, 0.021, z0);
    tile.add(roadZ);

    const lineA = new THREE.Mesh(new THREE.PlaneGeometry(0.3, this.tileSize), this.roadLineMat);
    lineA.rotation.x = -Math.PI / 2;
    lineA.position.set(x0, 0.03, z0);
    tile.add(lineA);

    const lineB = new THREE.Mesh(new THREE.PlaneGeometry(this.tileSize, 0.3), this.roadLineMat);
    lineB.rotation.x = -Math.PI / 2;
    lineB.position.set(x0, 0.031, z0);
    tile.add(lineB);

    for (let i = 0; i < 16; i++) {
      const px = x0 + (Math.random() - 0.5) * this.tileSize * 0.9;
      const pz = z0 + (Math.random() - 0.5) * this.tileSize * 0.9;
      if (Math.abs(px - x0) < 16 || Math.abs(pz - z0) < 16) continue;

      if (Math.random() < 0.6) {
        const tree = new THREE.Group();
        const trunk = new THREE.Mesh(
          new THREE.CylinderGeometry(0.5, 0.65, 3.2, 8),
          new THREE.MeshStandardMaterial({ color: 0x9b7653, roughness: 0.95 })
        );
        trunk.position.y = 1.6;
        tree.add(trunk);

        const crown = new THREE.Mesh(
          new THREE.SphereGeometry(2.3 + Math.random() * 0.8, 10, 10),
          new THREE.MeshStandardMaterial({
            color: [0x8ed39a, 0x9cc8f2, 0xf5c2dd, 0xf7dca8][Math.floor(Math.random()*4)],
            roughness: 0.9,
          })
        );
        crown.position.y = 4.2;
        tree.add(crown);
        tree.position.set(px, 0, pz);
        tile.add(tree);
      } else {
        const h = 6 + Math.random() * 18;
        const building = new THREE.Mesh(
          new THREE.BoxGeometry(6 + Math.random() * 8, h, 6 + Math.random() * 8),
          new THREE.MeshStandardMaterial({
            color: [0xf8c9c9, 0xc9e0ff, 0xd7f3cf, 0xf9e4b7, 0xe3d2ff][Math.floor(Math.random()*5)],
            roughness: 0.8,
            metalness: 0.05,
          })
        );
        building.position.set(px, h / 2, pz);
        tile.add(building);
      }
    }

    this.scene.add(tile);
    this.tiles.set(`${tx},${tz}`, tile);
  }

  update(playerX, playerZ) {
    const tx = Math.floor(playerX / this.tileSize);
    const tz = Math.floor(playerZ / this.tileSize);

    for (let x = tx - this.tileRadius; x <= tx + this.tileRadius; x++) {
      for (let z = tz - this.tileRadius; z <= tz + this.tileRadius; z++) {
        const key = `${x},${z}`;
        if (!this.tiles.has(key)) this.createTile(x, z);
      }
    }

    for (const [key, tile] of this.tiles) {
      const [x, z] = key.split(',').map(Number);
      if (Math.abs(x - tx) > this.tileRadius + 1 || Math.abs(z - tz) > this.tileRadius + 1) {
        this.scene.remove(tile);
        tile.traverse((child) => { if (child.geometry) child.geometry.dispose(); });
        this.tiles.delete(key);
      }
    }
  }

  reset() {
    for (const tile of this.tiles.values()) {
      this.scene.remove(tile);
      tile.traverse((child) => { if (child.geometry) child.geometry.dispose(); });
    }
    this.tiles.clear();
  }
}

// ============================================================
// TOUCH CONTROLS
// ============================================================
class TouchControls {
  constructor() {
    this.steerInput = 0;    // -1 to 1
    this.touchStartX = 0;
    this.touching = false;
    this.screenWidth = window.innerWidth;
    this.touchPadEl = document.getElementById('touchPad');
    this.touchKnobEl = document.getElementById('touchKnob');
    this.padActive = false;

    // Touch events (screen drag fallback)
    window.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    window.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    window.addEventListener('touchend', () => this.onTouchEnd());
    window.addEventListener('touchcancel', () => this.onTouchEnd());

    // Virtual touch pad for mobile
    if (this.touchPadEl) {
      this.touchPadEl.style.display = 'block';
      this.touchPadEl.addEventListener('pointerdown', (e) => this.onPadDown(e));
      window.addEventListener('pointermove', (e) => this.onPadMove(e));
      window.addEventListener('pointerup', () => this.onPadUp());
      window.addEventListener('pointercancel', () => this.onPadUp());
    }

    // Mouse fallback for desktop testing
    window.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', () => this.onMouseUp());

    // Keyboard fallback
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
    this.touchStartX = touch.clientX;
    this.touching = true;
    this.updateSteerFromPosition(touch.clientX);
  }

  onTouchMove(e) {
    e.preventDefault();
    if (!this.touching) return;
    const touch = e.touches[0];
    this.updateSteerFromPosition(touch.clientX);
  }

  onTouchEnd() {
    this.touching = false;
    this.steerInput = 0;
  }

  onMouseDown(e) {
    this.touching = true;
    this.touchStartX = e.clientX;
    this.updateSteerFromPosition(e.clientX);
  }

  onMouseMove(e) {
    if (!this.touching) return;
    this.updateSteerFromPosition(e.clientX);
  }

  onMouseUp() {
    this.touching = false;
    this.steerInput = 0;
  }

  updateSteerFromPosition(x) {
    // Position-based: left half = steer left, right half = steer right
    const normalized = (x / this.screenWidth - 0.5) * 2; // -1 to 1
    this.steerInput = Math.max(-1, Math.min(1, normalized * 1.5));
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
    // Keyboard override
    if (this.keys['ArrowLeft'] || this.keys['a']) return -1;
    if (this.keys['ArrowRight'] || this.keys['d']) return 1;
    return this.steerInput;
  }
}

// ============================================================
// MAIN GAME
// ============================================================
class Game {
  constructor() {
    this.state = 'menu'; // menu, playing, gameover
    this.score = 0;
    this.distance = 0;
    this.speed = BASE_SPEED;
    this.boostTimer = 0;
    this.comboCount = 0;
    this.comboTimer = 0;
    this.cameraShake = { x: 0, y: 0 };
    this.freeDriveDistance = 0;
    this.heading = -Math.PI / 2;

    // DOM elements
    this.startScreen = document.getElementById('startScreen');
    this.hudEl = document.getElementById('hud');
    this.gameOverEl = document.getElementById('gameOver');
    this.scoreDisplay = document.getElementById('scoreDisplay');
    this.speedDisplay = document.getElementById('speedDisplay');
    this.comboDisplay = document.getElementById('comboDisplay');
    this.finalScoreEl = document.getElementById('finalScore');
    this.bestScoreEl = document.getElementById('bestScoreDisplay');
    this.newRecordEl = document.getElementById('newRecord');
    this.speedLinesEl = document.getElementById('speedLines');
    this.steerLeftEl = document.getElementById('steerLeft');
    this.steerRightEl = document.getElementById('steerRight');
    this.loadingEl = document.getElementById('loading');


    // Three.js setup
    this.canvas = document.getElementById('gameCanvas');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb);
    this.scene.fog = new THREE.FogExp2(0xbfe1ff, 0.0012);

    // Camera
    this.baseFOV = 65;
    this.camera = new THREE.PerspectiveCamera(
      this.baseFOV,
      window.innerWidth / window.innerHeight,
      0.1,
      800
    );
    this.camera.position.set(0, 4.5, 8);
    this.camera.lookAt(0, 1, -20);

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.65);
    this.scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
    dirLight.position.set(5, 20, 10);
    this.scene.add(dirLight);

    // Hemisphere light for subtle sky/ground distinction
    const hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x7bb36a, 0.8);
    this.scene.add(hemiLight);

    // Post-processing
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.65,   // strength
      0.35,   // radius
      0.9   // threshold
    );
    this.composer.addPass(this.bloomPass);

    this.radialBlurPass = new ShaderPass(RadialBlurShader);
    this.radialBlurPass.uniforms.intensity.value = 0;
    this.composer.addPass(this.radialBlurPass);

    // Game objects
    this.vehicle = createVehicle();
    this.vehicle.position.set(0, 0, 0);
    this.heading = -Math.PI / 2;
    this.vehicle.rotation.y = 0;
    this.scene.add(this.vehicle);

    this.world = new WorldGenerator(this.scene);
    this.particles = new SpeedParticles(this.scene);
    this.controls = new TouchControls();
    this.audio = new AudioManager();

    // Skybox-like distant elements (subtle neon horizon)
    this.createSkyElements();

    // Initial world generation
    this.world.update(0, 0);

    // Event listeners
    document.getElementById('startBtn').addEventListener('click', () => this.startGame());
    document.getElementById('restartBtn').addEventListener('click', () => this.restartGame());
    window.addEventListener('resize', () => this.onResize());

    // Hide loading
    this.loadingEl.style.display = 'none';

    // Clock
    this.clock = new THREE.Clock();
    this.lastTime = 0;

    // Start render loop
    this.animate();

    // Auto-start immediately after initialization
    this.startGame({ playClickSound: false });
  }

  createSkyElements() {
    const cloudMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });

    this.clouds = [];
    for (let i = 0; i < 30; i++) {
      const cloud = new THREE.Mesh(
        new THREE.PlaneGeometry(26 + Math.random() * 36, 8 + Math.random() * 10),
        cloudMat.clone()
      );
      cloud.position.set((Math.random() - 0.5) * 240, 25 + Math.random() * 22, -60 - Math.random() * 900);
      cloud.userData.speed = 1 + Math.random() * 1.4;
      this.scene.add(cloud);
      this.clouds.push(cloud);
    }

    const sunGeom = new THREE.SphereGeometry(18, 24, 24);
    const sunMat = new THREE.MeshBasicMaterial({ color: 0xffe8a8 });
    const sun = new THREE.Mesh(sunGeom, sunMat);
    sun.position.set(90, 50, -280);
    this.scene.add(sun);
    this.sunMesh = sun;
  }

  startGame(options = {}) {
    const { playClickSound = true } = options;

    if (this.state === 'playing') return;

    this.audio.init();
    if (playClickSound) {
      this.audio.playUIClick();
    }
    this.state = 'playing';
    this.score = 0;
    this.distance = 0;
    this.speed = BASE_SPEED;
    this.boostTimer = 0;
    this.comboCount = 0;
    this.comboTimer = 0;

    this.vehicle.position.set(0, 0, 0);
    this.heading = -Math.PI / 2;
    this.vehicle.rotation.y = 0;

    this.startScreen.style.display = 'none';
    this.hudEl.style.display = 'block';
    this.gameOverEl.style.display = 'none';

    this.audio.startEngine();
    this.comboDisplay.style.opacity = '1';
    this.comboDisplay.textContent = 'FREE DRIVE MODE';
    this.clock.start();
  }

  restartGame() {
    this.audio.init();
    this.audio.playUIClick();

    // Reset world
    this.world.reset();
    this.world.update(0, 0);

    this.state = 'playing';
    this.score = 0;
    this.distance = 0;
    this.speed = BASE_SPEED;
    this.boostTimer = 0;
    this.comboCount = 0;
    this.comboTimer = 0;
    this.vehicle.position.set(0, 0, 0);
    this.heading = -Math.PI / 2;
    this.vehicle.rotation.y = 0;

    this.gameOverEl.style.display = 'none';
    this.hudEl.style.display = 'block';

    this.audio.startEngine();
    this.comboDisplay.style.opacity = '1';
    this.comboDisplay.textContent = 'FREE DRIVE MODE';
    this.clock.start();
  }

  gameOver() {
    return;
  }

  checkCollisions() {
    // Free-drive mode: no collisions or score events.
  }

  update(delta) {
    if (this.state !== 'playing') return;

    delta = Math.min(delta, 0.05); // Cap delta to prevent large jumps

    // Speed management
    this.speed = THREE.MathUtils.lerp(this.speed, MAX_SPEED * 0.92, SPEED_INCREASE_RATE * delta);
    let currentSpeed = this.speed;

    // Boost
    if (this.boostTimer > 0) {
      this.boostTimer -= delta;
      currentSpeed *= 1.5;
    }

    // Steering + heading for free directional driving
    const steerInput = this.controls.getSteerInput();
    const speedNorm = Math.min(currentSpeed / MAX_SPEED, 1);
    this.heading += steerInput * TURN_RATE * delta * (0.5 + speedNorm * 0.8);

    // Move vehicle forward in heading direction
    const moveDistance = currentSpeed * delta;
    const forwardX = Math.cos(this.heading);
    const forwardZ = Math.sin(this.heading);
    this.vehicle.position.x += forwardX * moveDistance;
    this.vehicle.position.z += forwardZ * moveDistance;

    // Square map bounds
    this.vehicle.position.x = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, this.vehicle.position.x));
    this.vehicle.position.z = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, this.vehicle.position.z));

    this.distance += moveDistance;
    this.freeDriveDistance = this.distance / 1000;

    // Vehicle orientation / lean
    const targetYaw = this.heading + Math.PI / 2;
    this.vehicle.rotation.y = THREE.MathUtils.lerp(this.vehicle.rotation.y, targetYaw, 0.16);
    this.vehicle.rotation.z = THREE.MathUtils.lerp(this.vehicle.rotation.z, -steerInput * 0.1, 0.1);

    if (Math.abs(steerInput) > 0.82 && speedNorm > 0.5) {
      this.audio.playTurnSkid();
    }

    // Steer indicators
    this.steerLeftEl.classList.toggle('active', steerInput < -0.2);
    this.steerRightEl.classList.toggle('active', steerInput > 0.2);

    // Collisions disabled in free-drive mode
    this.checkCollisions();

    // Camera follow
    const dirX = Math.cos(this.heading);
    const dirZ = Math.sin(this.heading);
    const camDistance = 10 + speedNorm * 6;
    const camTargetX = this.vehicle.position.x - dirX * camDistance;
    const camTargetZ = this.vehicle.position.z - dirZ * camDistance;
    const camTargetY = 5.8 - speedNorm * 1.2;

    this.camera.position.x = THREE.MathUtils.lerp(this.camera.position.x, camTargetX, 0.09);
    this.camera.position.z = THREE.MathUtils.lerp(this.camera.position.z, camTargetZ, 0.09);
    this.camera.position.y = THREE.MathUtils.lerp(this.camera.position.y, camTargetY, 0.08);

    // Camera look ahead
    this.camera.lookAt(
      this.vehicle.position.x + dirX * (26 + speedNorm * 28),
      1.4,
      this.vehicle.position.z + dirZ * (26 + speedNorm * 28)
    );

    // Camera shake at high speed
    const shakeIntensity = speedNorm * speedNorm * 0.15;
    this.camera.position.x += (Math.random() - 0.5) * shakeIntensity;
    this.camera.position.y += (Math.random() - 0.5) * shakeIntensity * 0.5;

    // Crash shake decay
    if (this.cameraShake.x > 0.01) {
      this.camera.position.x += (Math.random() - 0.5) * this.cameraShake.x;
      this.camera.position.y += (Math.random() - 0.5) * this.cameraShake.y;
      this.cameraShake.x *= 0.9;
      this.cameraShake.y *= 0.9;
    }

    // Dynamic FOV
    const targetFOV = this.baseFOV + speedNorm * 25 + (this.boostTimer > 0 ? 10 : 0);
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFOV, 0.05);
    this.camera.updateProjectionMatrix();

    // Radial blur intensity
    this.radialBlurPass.uniforms.intensity.value = speedNorm * speedNorm * 1.2;

    // Bloom intensity
    this.bloomPass.strength = 0.6 + speedNorm * 0.25;

    // Speed lines overlay
    this.speedLinesEl.style.opacity = String(speedNorm * speedNorm * 0.8);

    // Update world
    this.world.update(this.vehicle.position.x, this.vehicle.position.z);

    // Update particles
    this.particles.update(currentSpeed, this.vehicle.position.z);

    // Move sun with player
    if (this.sunMesh) {
      this.sunMesh.position.z = this.vehicle.position.z - 220;
      this.sunMesh.position.x = this.vehicle.position.x + 120;
    }

    if (this.clouds) {
      for (const cloud of this.clouds) {
        cloud.position.z += cloud.userData.speed * delta * 16;
        if (cloud.position.z > this.vehicle.position.z + 140 || Math.abs(cloud.position.x - this.vehicle.position.x) > 260) {
          cloud.position.z = this.vehicle.position.z - 700 - Math.random() * 260;
          cloud.position.x = this.vehicle.position.x + (Math.random() - 0.5) * 260;
          cloud.position.y = 25 + Math.random() * 22;
        }
      }
    }

    // Update audio
    this.audio.updateEngine(speedNorm, delta);

    // Update HUD
    this.scoreDisplay.textContent = `CRUISE ${this.freeDriveDistance.toFixed(1)} KM`;
    const displaySpeed = Math.floor(currentSpeed * 3.6); // Convert to km/h feel
    this.speedDisplay.innerHTML = `${displaySpeed}<span> KM/H</span>`;
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    const delta = this.clock.getDelta();

    this.update(delta);

    // Menu animation
    if (this.state === 'menu') {
      const t = this.clock.getElapsedTime();
      this.camera.position.x = Math.sin(t * 0.3) * 3;
      this.camera.position.z = -t * 5;
      this.camera.position.y = 5 + Math.sin(t * 0.5) * 0.5;
      this.camera.lookAt(0, 1, this.camera.position.z - 30);

      // Keep generating world for menu background
      this.world.update(this.camera.position.x, this.camera.position.z);
      this.particles.update(30, this.camera.position.z);

      if (this.sunMesh) {
        this.sunMesh.position.z = this.camera.position.z - 380;
      }
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

// ============================================================
// BOOT
// ============================================================
const game = new Game();
