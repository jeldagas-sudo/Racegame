import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// ============================================================
// CONSTANTS
// ============================================================
const ROAD_WIDTH = 18;
const LANE_COUNT = 5;
const LANE_WIDTH = ROAD_WIDTH / LANE_COUNT;
const CHUNK_LENGTH = 120;
const VISIBLE_CHUNKS = 6;
const BASE_SPEED = 40;
const MAX_SPEED = 200;
const SPEED_INCREASE_RATE = 0.8;
const STEER_SPEED = 22;
const STEER_LIMIT = ROAD_WIDTH / 2 - 1.2;
const OBSTACLE_INTERVAL_MIN = 18;
const OBSTACLE_INTERVAL_MAX = 45;
const NEAR_MISS_DISTANCE = 2.8;
const COLLISION_DISTANCE = 1.3;

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

  updateEngine(speedNorm) {
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
    color: 0x111122,
    metalness: 0.9,
    roughness: 0.2,
  });
  const body = new THREE.Mesh(bodyGeom, bodyMat);
  body.position.y = 0.5;
  group.add(body);

  // Cabin
  const cabinGeom = new THREE.BoxGeometry(1.4, 0.45, 1.8);
  const cabinMat = new THREE.MeshStandardMaterial({
    color: 0x0a0a1a,
    metalness: 0.8,
    roughness: 0.1,
    transparent: true,
    opacity: 0.7,
  });
  const cabin = new THREE.Mesh(cabinGeom, cabinMat);
  cabin.position.set(0, 0.95, -0.3);
  group.add(cabin);

  // Neon underglow
  const underglow = new THREE.PointLight(0x00ffff, 2, 6);
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

  // Neon side strips
  const stripGeom = new THREE.BoxGeometry(0.05, 0.08, 3.6);
  const stripMat = new THREE.MeshStandardMaterial({
    color: 0x00ffff,
    emissive: 0x00ffff,
    emissiveIntensity: 1.5,
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
      color: 0x00ffff,
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
    this.chunks = [];
    this.obstacles = [];
    this.boostPads = [];
    this.nextObstacleZ = -80;
    this.furthestZ = 0;

    // Ground grid shader material
    this.groundMat = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        gridColor: { value: new THREE.Color(0x00ffff) },
        fogColor: { value: new THREE.Color(0x050510) },
      },
      vertexShader: `
        varying vec2 vWorldPos;
        varying float vDist;
        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPos = worldPos.xz;
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          vDist = -mvPos.z;
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        uniform float time;
        uniform vec3 gridColor;
        uniform vec3 fogColor;
        varying vec2 vWorldPos;
        varying float vDist;
        void main() {
          vec2 grid = abs(fract(vWorldPos * 0.2) - 0.5);
          float line = min(grid.x, grid.y);
          float gridLine = 1.0 - smoothstep(0.0, 0.03, line);
          float fog = exp(-vDist * 0.004);
          float edgeFade = smoothstep(0.0, 2.0, abs(vWorldPos.x) - 8.0);
          vec3 color = mix(fogColor, gridColor * 0.4, gridLine * fog);
          float alpha = max(gridLine * fog * 0.6, 0.0);
          alpha = mix(alpha, alpha * 0.3, edgeFade);
          gl_FragColor = vec4(color, alpha + 0.02);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
    });

    // Road material
    this.roadMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a18,
      metalness: 0.3,
      roughness: 0.8,
    });

    // Lane marking material
    this.laneMat = new THREE.MeshStandardMaterial({
      color: 0x00ffff,
      emissive: 0x00ffff,
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.6,
    });

    // Road edge material
    this.edgeMat = new THREE.MeshStandardMaterial({
      color: 0xff00ff,
      emissive: 0xff00ff,
      emissiveIntensity: 1.0,
    });

    // Building materials
    this.buildingMats = [
      new THREE.MeshStandardMaterial({ color: 0x0a0a1a, metalness: 0.5, roughness: 0.5 }),
      new THREE.MeshStandardMaterial({ color: 0x0e0e24, metalness: 0.5, roughness: 0.5 }),
      new THREE.MeshStandardMaterial({ color: 0x12122a, metalness: 0.5, roughness: 0.5 }),
    ];

    this.windowMat = new THREE.MeshStandardMaterial({
      color: 0x00ffff,
      emissive: 0x00ffff,
      emissiveIntensity: 0.8,
      transparent: true,
      opacity: 0.6,
    });

    // Boost pad material
    this.boostMat = new THREE.MeshStandardMaterial({
      color: 0xffff00,
      emissive: 0xffff00,
      emissiveIntensity: 2.0,
      transparent: true,
      opacity: 0.8,
    });
  }

  createChunk(zStart) {
    const chunk = new THREE.Group();
    chunk.userData.zStart = zStart;
    chunk.userData.zEnd = zStart - CHUNK_LENGTH;

    // Road surface
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(ROAD_WIDTH, CHUNK_LENGTH),
      this.roadMat
    );
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0.01, zStart - CHUNK_LENGTH / 2);
    chunk.add(road);

    // Ground grid (extends beyond road)
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(120, CHUNK_LENGTH),
      this.groundMat
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0, zStart - CHUNK_LENGTH / 2);
    chunk.add(ground);

    // Lane markings (dashed)
    for (let lane = 1; lane < LANE_COUNT; lane++) {
      const x = -ROAD_WIDTH / 2 + lane * LANE_WIDTH;
      for (let d = 0; d < CHUNK_LENGTH; d += 6) {
        const dash = new THREE.Mesh(
          new THREE.PlaneGeometry(0.08, 2.5),
          this.laneMat
        );
        dash.rotation.x = -Math.PI / 2;
        dash.position.set(x, 0.02, zStart - d - 1.25);
        chunk.add(dash);
      }
    }

    // Road edges (continuous neon strips)
    const edgeGeom = new THREE.BoxGeometry(0.15, 0.3, CHUNK_LENGTH);
    const leftEdge = new THREE.Mesh(edgeGeom, this.edgeMat);
    leftEdge.position.set(-ROAD_WIDTH / 2 - 0.1, 0.15, zStart - CHUNK_LENGTH / 2);
    chunk.add(leftEdge);

    const rightEdge = new THREE.Mesh(edgeGeom, this.edgeMat);
    rightEdge.position.set(ROAD_WIDTH / 2 + 0.1, 0.15, zStart - CHUNK_LENGTH / 2);
    chunk.add(rightEdge);

    // Buildings on both sides
    this.generateBuildings(chunk, zStart, -1); // Left
    this.generateBuildings(chunk, zStart, 1);  // Right

    this.scene.add(chunk);
    this.chunks.push(chunk);
    return chunk;
  }

  generateBuildings(chunk, zStart, side) {
    const baseX = side * (ROAD_WIDTH / 2 + 8);
    let z = zStart;

    while (z > zStart - CHUNK_LENGTH) {
      const width = 3 + Math.random() * 8;
      const height = 5 + Math.random() * 40;
      const depth = 4 + Math.random() * 8;

      const mat = this.buildingMats[Math.floor(Math.random() * this.buildingMats.length)];
      const building = new THREE.Mesh(
        new THREE.BoxGeometry(width, height, depth),
        mat
      );

      const offsetX = side * (Math.random() * 10);
      building.position.set(baseX + offsetX, height / 2, z - depth / 2);
      chunk.add(building);

      // Neon accent on building
      if (Math.random() > 0.3) {
        const accentColors = [0x00ffff, 0xff00ff, 0xffff00, 0xff0044, 0x00ff88];
        const accentColor = accentColors[Math.floor(Math.random() * accentColors.length)];
        const accentMat = new THREE.MeshStandardMaterial({
          color: accentColor,
          emissive: accentColor,
          emissiveIntensity: 1.2,
        });

        // Horizontal neon stripe
        const stripeHeight = 0.15;
        const stripeY = height * (0.3 + Math.random() * 0.5);
        const stripe = new THREE.Mesh(
          new THREE.BoxGeometry(width + 0.1, stripeHeight, depth + 0.1),
          accentMat
        );
        stripe.position.set(baseX + offsetX, stripeY, z - depth / 2);
        chunk.add(stripe);
      }

      // Windows
      if (height > 10 && Math.random() > 0.4) {
        const windowRows = Math.floor(height / 4);
        const windowCols = Math.floor(width / 2);
        const faceSide = side > 0 ? -1 : 1;
        for (let row = 0; row < windowRows; row++) {
          for (let col = 0; col < windowCols; col++) {
            if (Math.random() > 0.4) {
              const win = new THREE.Mesh(
                new THREE.PlaneGeometry(0.8, 1.2),
                this.windowMat
              );
              win.position.set(
                baseX + offsetX + faceSide * (width / 2 + 0.01),
                2 + row * 4,
                z - depth / 2 + (col - windowCols / 2) * 2
              );
              win.rotation.y = faceSide > 0 ? 0 : Math.PI;
              chunk.add(win);
            }
          }
        }
      }

      z -= depth + 1 + Math.random() * 3;
    }
  }

  spawnObstacle(z) {
    const lane = Math.floor(Math.random() * LANE_COUNT);
    const x = -ROAD_WIDTH / 2 + LANE_WIDTH / 2 + lane * LANE_WIDTH;

    const obstacle = createObstacleVehicle();
    obstacle.position.set(x, 0, z);
    obstacle.userData.lane = lane;
    obstacle.userData.active = true;

    this.scene.add(obstacle);
    this.obstacles.push(obstacle);
    return obstacle;
  }

  spawnBoostPad(z) {
    const lane = Math.floor(Math.random() * LANE_COUNT);
    const x = -ROAD_WIDTH / 2 + LANE_WIDTH / 2 + lane * LANE_WIDTH;

    const pad = new THREE.Group();
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(LANE_WIDTH * 0.8, 0.05, 3),
      this.boostMat
    );
    base.position.y = 0.03;
    pad.add(base);

    // Arrow shape
    const arrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.5, 1.5, 4),
      this.boostMat
    );
    arrow.rotation.x = Math.PI / 2;
    arrow.position.set(0, 0.4, 0);
    pad.add(arrow);

    const light = new THREE.PointLight(0xffff00, 2, 8);
    light.position.set(0, 1, 0);
    pad.add(light);

    pad.position.set(x, 0, z);
    pad.userData.active = true;

    this.scene.add(pad);
    this.boostPads.push(pad);
    return pad;
  }

  update(playerZ, score) {
    // Generate chunks ahead
    while (this.furthestZ > playerZ - CHUNK_LENGTH * VISIBLE_CHUNKS) {
      this.furthestZ -= CHUNK_LENGTH;
      this.createChunk(this.furthestZ);
    }

    // Remove old chunks
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      if (this.chunks[i].userData.zStart > playerZ + CHUNK_LENGTH) {
        this.scene.remove(this.chunks[i]);
        this.chunks[i].traverse((child) => {
          if (child.geometry) child.geometry.dispose();
        });
        this.chunks.splice(i, 1);
      }
    }

    // Spawn obstacles ahead
    while (this.nextObstacleZ > playerZ - CHUNK_LENGTH * (VISIBLE_CHUNKS - 1)) {
      this.spawnObstacle(this.nextObstacleZ);

      // Occasionally spawn a second obstacle in a different lane
      const difficulty = Math.min(score / 5000, 1);
      if (Math.random() < difficulty * 0.6) {
        this.spawnObstacle(this.nextObstacleZ + (Math.random() - 0.5) * 10);
      }

      // Spawn boost pads occasionally
      if (Math.random() < 0.15) {
        this.spawnBoostPad(this.nextObstacleZ - 15);
      }

      const interval = OBSTACLE_INTERVAL_MAX - (OBSTACLE_INTERVAL_MAX - OBSTACLE_INTERVAL_MIN) * difficulty;
      this.nextObstacleZ -= interval + Math.random() * interval * 0.5;
    }

    // Remove passed obstacles
    for (let i = this.obstacles.length - 1; i >= 0; i--) {
      if (this.obstacles[i].position.z > playerZ + 30) {
        this.scene.remove(this.obstacles[i]);
        this.obstacles.splice(i, 1);
      }
    }

    // Remove passed boost pads
    for (let i = this.boostPads.length - 1; i >= 0; i--) {
      if (this.boostPads[i].position.z > playerZ + 30) {
        this.scene.remove(this.boostPads[i]);
        this.boostPads.splice(i, 1);
      }
    }
  }

  reset() {
    this.chunks.forEach((c) => {
      this.scene.remove(c);
      c.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
      });
    });
    this.obstacles.forEach((o) => this.scene.remove(o));
    this.boostPads.forEach((b) => this.scene.remove(b));
    this.chunks = [];
    this.obstacles = [];
    this.boostPads = [];
    this.nextObstacleZ = -80;
    this.furthestZ = 0;
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

    // Touch events
    window.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    window.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    window.addEventListener('touchend', () => this.onTouchEnd());
    window.addEventListener('touchcancel', () => this.onTouchEnd());

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
    this.highScore = parseInt(localStorage.getItem('neonrush_highscore') || '0');

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
    this.startHighScoreEl = document.getElementById('startHighScore');

    // Show high score on start screen
    if (this.highScore > 0) {
      this.startHighScoreEl.style.display = 'block';
      this.startHighScoreEl.querySelector('span').textContent = this.highScore;
    }

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
    this.scene.background = new THREE.Color(0x050510);
    this.scene.fog = new THREE.FogExp2(0x050510, 0.006);

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
    const ambient = new THREE.AmbientLight(0x111133, 0.5);
    this.scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0x6666aa, 0.3);
    dirLight.position.set(5, 20, 10);
    this.scene.add(dirLight);

    // Hemisphere light for subtle sky/ground distinction
    const hemiLight = new THREE.HemisphereLight(0x0a0a2e, 0x050510, 0.4);
    this.scene.add(hemiLight);

    // Post-processing
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      1.2,   // strength
      0.4,   // radius
      0.85   // threshold
    );
    this.composer.addPass(this.bloomPass);

    this.radialBlurPass = new ShaderPass(RadialBlurShader);
    this.radialBlurPass.uniforms.intensity.value = 0;
    this.composer.addPass(this.radialBlurPass);

    // Game objects
    this.vehicle = createVehicle();
    this.vehicle.position.set(0, 0, 0);
    this.scene.add(this.vehicle);

    this.world = new WorldGenerator(this.scene);
    this.particles = new SpeedParticles(this.scene);
    this.controls = new TouchControls();
    this.audio = new AudioManager();

    // Skybox-like distant elements (subtle neon horizon)
    this.createSkyElements();

    // Initial chunk generation
    for (let i = 0; i < VISIBLE_CHUNKS + 2; i++) {
      this.world.createChunk(-i * CHUNK_LENGTH);
    }
    this.world.furthestZ = -(VISIBLE_CHUNKS + 2) * CHUNK_LENGTH;

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
  }

  createSkyElements() {
    // Distant neon horizon lines
    const horizonGeom = new THREE.PlaneGeometry(500, 0.5);
    const horizonMat = new THREE.MeshBasicMaterial({
      color: 0xff00ff,
      transparent: true,
      opacity: 0.15,
      blending: THREE.AdditiveBlending,
    });

    for (let i = 0; i < 5; i++) {
      const line = new THREE.Mesh(horizonGeom, horizonMat.clone());
      line.position.set(0, 0.5 + i * 3, -350);
      line.material.opacity = 0.08 - i * 0.01;
      this.scene.add(line);
    }

    // Distant "sun" glow
    const sunGeom = new THREE.PlaneGeometry(80, 80);
    const sunMat = new THREE.MeshBasicMaterial({
      color: 0xff0066,
      transparent: true,
      opacity: 0.08,
      blending: THREE.AdditiveBlending,
    });
    const sun = new THREE.Mesh(sunGeom, sunMat);
    sun.position.set(0, 20, -380);
    this.scene.add(sun);
    this.sunMesh = sun;
  }

  startGame() {
    this.audio.init();
    this.audio.playUIClick();
    this.state = 'playing';
    this.score = 0;
    this.distance = 0;
    this.speed = BASE_SPEED;
    this.boostTimer = 0;
    this.comboCount = 0;
    this.comboTimer = 0;

    this.vehicle.position.set(0, 0, 0);

    this.startScreen.style.display = 'none';
    this.hudEl.style.display = 'block';
    this.gameOverEl.style.display = 'none';

    this.audio.startEngine();
    this.clock.start();
  }

  restartGame() {
    this.audio.init();
    this.audio.playUIClick();

    // Reset world
    this.world.reset();
    for (let i = 0; i < VISIBLE_CHUNKS + 2; i++) {
      this.world.createChunk(-i * CHUNK_LENGTH);
    }
    this.world.furthestZ = -(VISIBLE_CHUNKS + 2) * CHUNK_LENGTH;

    this.state = 'playing';
    this.score = 0;
    this.distance = 0;
    this.speed = BASE_SPEED;
    this.boostTimer = 0;
    this.comboCount = 0;
    this.comboTimer = 0;
    this.vehicle.position.set(0, 0, 0);

    this.gameOverEl.style.display = 'none';
    this.hudEl.style.display = 'block';

    this.audio.startEngine();
    this.clock.start();
  }

  gameOver() {
    this.state = 'gameover';
    this.audio.playCrash();
    this.audio.stopEngine();

    // Screen shake
    this.cameraShake = { x: 2, y: 1 };

    // Update high score
    const isNewRecord = this.score > this.highScore;
    if (isNewRecord) {
      this.highScore = this.score;
      localStorage.setItem('neonrush_highscore', String(this.highScore));
    }

    // Show game over screen after delay
    setTimeout(() => {
      this.hudEl.style.display = 'none';
      this.gameOverEl.style.display = 'flex';
      this.finalScoreEl.textContent = this.score;
      this.bestScoreEl.textContent = `BEST: ${this.highScore}`;
      this.newRecordEl.style.display = isNewRecord ? 'block' : 'none';
    }, 600);
  }

  checkCollisions() {
    const px = this.vehicle.position.x;
    const pz = this.vehicle.position.z;

    for (const obs of this.world.obstacles) {
      if (!obs.userData.active) continue;
      const dx = Math.abs(px - obs.position.x);
      const dz = Math.abs(pz - obs.position.z);

      // Collision check
      if (dx < COLLISION_DISTANCE && dz < 3.0) {
        this.gameOver();
        return;
      }

      // Near miss check
      if (dx < NEAR_MISS_DISTANCE && dx > COLLISION_DISTANCE && dz < 2.5) {
        obs.userData.active = false;
        this.comboCount++;
        this.comboTimer = 2.0;
        this.score += 50 * this.comboCount;
        this.audio.playNearMiss();

        this.comboDisplay.textContent = `NEAR MISS x${this.comboCount}  +${50 * this.comboCount}`;
        this.comboDisplay.style.opacity = '1';
      }
    }

    // Boost pad check
    for (const pad of this.world.boostPads) {
      if (!pad.userData.active) continue;
      const dx = Math.abs(px - pad.position.x);
      const dz = Math.abs(pz - pad.position.z);

      if (dx < 1.8 && dz < 2.0) {
        pad.userData.active = false;
        this.boostTimer = 3.0;
        this.audio.playBoost();
        this.scene.remove(pad);
      }
    }
  }

  update(delta) {
    if (this.state !== 'playing') return;

    delta = Math.min(delta, 0.05); // Cap delta to prevent large jumps

    // Speed management
    this.speed = Math.min(this.speed + SPEED_INCREASE_RATE * delta, MAX_SPEED);
    let currentSpeed = this.speed;

    // Boost
    if (this.boostTimer > 0) {
      this.boostTimer -= delta;
      currentSpeed *= 1.5;
    }

    // Move vehicle forward
    const moveDistance = currentSpeed * delta;
    this.vehicle.position.z -= moveDistance;
    this.distance += moveDistance;
    this.score = Math.floor(this.distance);

    // Steering
    const steerInput = this.controls.getSteerInput();
    const steerAmount = steerInput * STEER_SPEED * delta;
    this.vehicle.position.x += steerAmount;
    this.vehicle.position.x = Math.max(-STEER_LIMIT, Math.min(STEER_LIMIT, this.vehicle.position.x));

    // Vehicle tilt on steering
    this.vehicle.rotation.z = THREE.MathUtils.lerp(this.vehicle.rotation.z, -steerInput * 0.08, 0.1);
    this.vehicle.rotation.y = THREE.MathUtils.lerp(this.vehicle.rotation.y, -steerInput * 0.03, 0.1);

    // Steer indicators
    this.steerLeftEl.classList.toggle('active', steerInput < -0.2);
    this.steerRightEl.classList.toggle('active', steerInput > 0.2);

    // Combo timer
    if (this.comboTimer > 0) {
      this.comboTimer -= delta;
      if (this.comboTimer <= 0) {
        this.comboCount = 0;
        this.comboDisplay.style.opacity = '0';
      }
    }

    // Collisions
    this.checkCollisions();

    // Camera follow
    const speedNorm = Math.min(currentSpeed / MAX_SPEED, 1);
    const camTargetX = this.vehicle.position.x * 0.3;
    const camTargetZ = this.vehicle.position.z + 8 + speedNorm * 3;
    const camTargetY = 4.5 - speedNorm * 1.0;

    this.camera.position.x = THREE.MathUtils.lerp(this.camera.position.x, camTargetX, 0.05);
    this.camera.position.z = THREE.MathUtils.lerp(this.camera.position.z, camTargetZ, 0.08);
    this.camera.position.y = THREE.MathUtils.lerp(this.camera.position.y, camTargetY, 0.05);

    // Camera look ahead
    const lookAheadZ = this.vehicle.position.z - 20 - speedNorm * 15;
    this.camera.lookAt(this.vehicle.position.x * 0.15, 1, lookAheadZ);

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
    this.bloomPass.strength = 1.0 + speedNorm * 0.8;

    // Speed lines overlay
    this.speedLinesEl.style.opacity = String(speedNorm * speedNorm * 0.8);

    // Update world
    this.world.update(this.vehicle.position.z, this.score);

    // Update particles
    this.particles.update(currentSpeed, this.vehicle.position.z);

    // Move sun with player
    if (this.sunMesh) {
      this.sunMesh.position.z = this.vehicle.position.z - 380;
    }

    // Update audio
    this.audio.updateEngine(speedNorm);

    // Update HUD
    this.scoreDisplay.textContent = this.score;
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
      this.world.update(this.camera.position.z - 10, 0);
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
