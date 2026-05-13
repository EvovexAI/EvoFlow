"use client";

import { useEffect, useRef, useCallback, useState } from "react";

const DEFAULT_PARTICLE_COUNT = 1200;
const CONNECTION_DISTANCE = 0.08;
const MOUSE_INFLUENCE_RADIUS = 0.15;
const MOUSE_REPEL_STRENGTH = 0.0004;

// ─── WebGPU Shaders ─────────────────────────────────────────────

const COMPUTE_SHADER = /* wgsl */ `
struct Params {
  deltaTime: f32,
  mouseX: f32,
  mouseY: f32,
  mouseActive: f32,
  time: f32,
  particleCount: u32,
  mouseRadius: f32,
  mouseStrength: f32,
}

struct Particle {
  pos: vec2f,
  vel: vec2f,
  life: f32,
  size: f32,
  colorIdx: f32,
  _pad: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;

fn hash(p: vec2f) -> f32 {
  var h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= params.particleCount) { return; }

  var p = particles[idx];
  let t = params.time;

  // Organic flow field (curl noise approximation)
  let freq = 2.5;
  let px = p.pos.x * freq + t * 0.06;
  let py = p.pos.y * freq + t * 0.04;
  let angle = sin(px) * cos(py) * 3.14159 + sin(px * 0.7 + py * 1.3) * 1.5;
  let flowForce = vec2f(cos(angle), sin(angle)) * 0.00015;

  p.vel += flowForce;

  // Mouse interaction
  if (params.mouseActive > 0.5) {
    let toMouse = p.pos - vec2f(params.mouseX, params.mouseY);
    let dist = length(toMouse);
    if (dist < params.mouseRadius && dist > 0.001) {
      let strength = (1.0 - dist / params.mouseRadius);
      let repel = normalize(toMouse) * strength * strength * params.mouseStrength;
      p.vel += repel;
    }
  }

  // Damping
  p.vel *= 0.985;

  // Apply velocity
  p.pos += p.vel * params.deltaTime * 60.0;

  // Wrap around edges
  if (p.pos.x < -0.02) { p.pos.x += 1.04; p.vel.x *= 0.3; }
  if (p.pos.x > 1.02) { p.pos.x -= 1.04; p.vel.x *= 0.3; }
  if (p.pos.y < -0.02) { p.pos.y += 1.04; p.vel.y *= 0.3; }
  if (p.pos.y > 1.02) { p.pos.y -= 1.04; p.vel.y *= 0.3; }

  // Gentle drift to keep particles from clustering
  let center = vec2f(0.5, 0.5);
  let toCenter = center - p.pos;
  p.vel += toCenter * 0.000008;

  // Life cycle: pulse gently
  p.life = 0.3 + 0.7 * (0.5 + 0.5 * sin(t * 0.5 + f32(idx) * 0.1));

  particles[idx] = p;
}
`;

const VERTEX_SHADER = /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) alpha: f32,
  @location(1) colorIdx: f32,
}

struct Particle {
  pos: vec2f,
  vel: vec2f,
  life: f32,
  size: f32,
  colorIdx: f32,
  _pad: f32,
}

@group(0) @binding(0) var<storage, read> particles: array<Particle>;

struct ViewParams {
  resolution: vec2f,
  dpr: f32,
  _pad: f32,
}

@group(0) @binding(1) var<uniform> view: ViewParams;

@vertex
fn vs(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> VsOut {
  let p = particles[iid];
  let size = p.size * view.dpr;

  // Quad vertices: 0,1,2,3,4,5 -> two triangles
  var quadPos = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let qp = quadPos[vid];

  // Map particle [0,1] space to clip [-1,1]
  let clipPos = vec2f(p.pos.x * 2.0 - 1.0, -(p.pos.y * 2.0 - 1.0));
  let offset = qp * size / view.resolution;

  var out: VsOut;
  out.pos = vec4f(clipPos + offset, 0.0, 1.0);
  out.alpha = p.life * 0.6;
  out.colorIdx = p.colorIdx;
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  // Soft circle
  // Since we're using a quad, compute distance from center
  // (not needed with point-based, but we use instanced quads)
  let ci = u32(in.colorIdx * 3.0) % 3u;
  var col: vec3f;
  if (ci == 0u) {
    col = vec3f(0.816, 0.737, 1.0); // primary (purple-ish)
  } else if (ci == 1u) {
    col = vec3f(0.365, 0.902, 1.0); // secondary (cyan)
  } else {
    col = vec3f(1.0, 0.725, 0.373);  // tertiary (amber)
  }
  return vec4f(col, in.alpha);
}
`;

// ─── Types ──────────────────────────────────────────────────────

interface ParticleData {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
  colorIdx: number;
}

// ─── Canvas 2D Fallback ─────────────────────────────────────────

function runCanvas2DFallback(
  canvas: HTMLCanvasElement,
  getMouseRef: () => { x: number; y: number; active: boolean },
  count: number,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};

  const particles: ParticleData[] = [];
  for (let i = 0; i < count * 0.4; i++) {
    particles.push({
      x: Math.random(),
      y: Math.random(),
      vx: (Math.random() - 0.5) * 0.0003,
      vy: (Math.random() - 0.5) * 0.0003,
      life: Math.random(),
      size: 1 + Math.random() * 1.5,
      colorIdx: Math.random(),
    });
  }

  const colors = [
    "rgba(208,188,255,", // primary
    "rgba(93,230,255,",  // secondary
    "rgba(255,185,95,",  // tertiary
  ];

  let animId = 0;
  let time = 0;

  function draw() {
    const w = canvas.width;
    const h = canvas.height;
    ctx!.clearRect(0, 0, w, h);

    const mouse = getMouseRef();
    time += 0.016;

    for (const p of particles) {
      const freq = 2.5;
      const px = p.x * freq + time * 0.06;
      const py = p.y * freq + time * 0.04;
      const angle =
        Math.sin(px) * Math.cos(py) * Math.PI +
        Math.sin(px * 0.7 + py * 1.3) * 1.5;
      p.vx += Math.cos(angle) * 0.00015;
      p.vy += Math.sin(angle) * 0.00015;

      if (mouse.active) {
        const dx = p.x - mouse.x;
        const dy = p.y - mouse.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < MOUSE_INFLUENCE_RADIUS && dist > 0.001) {
          const s = 1 - dist / MOUSE_INFLUENCE_RADIUS;
          p.vx += (dx / dist) * s * s * MOUSE_REPEL_STRENGTH;
          p.vy += (dy / dist) * s * s * MOUSE_REPEL_STRENGTH;
        }
      }

      p.vx *= 0.985;
      p.vy *= 0.985;
      p.x += p.vx;
      p.y += p.vy;

      if (p.x < -0.02) p.x += 1.04;
      if (p.x > 1.02) p.x -= 1.04;
      if (p.y < -0.02) p.y += 1.04;
      if (p.y > 1.02) p.y -= 1.04;

      p.life = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(time * 0.5 + particles.indexOf(p) * 0.1));

      const ci = Math.floor(p.colorIdx * 3) % 3;
      const alpha = p.life * 0.4;
      ctx!.fillStyle = colors[ci] + alpha.toFixed(2) + ")";
      ctx!.beginPath();
      ctx!.arc(p.x * w, p.y * h, p.size * devicePixelRatio, 0, Math.PI * 2);
      ctx!.fill();
    }

    // Draw a few connections
    ctx!.lineWidth = 0.5;
    const connDist = CONNECTION_DISTANCE * Math.max(w, h);
    const step = Math.max(1, Math.floor(particles.length / 200));
    for (let i = 0; i < particles.length; i += step) {
      const a = particles[i];
      for (let j = i + step; j < particles.length; j += step) {
        const b = particles[j];
        const dx = (a.x - b.x) * w;
        const dy = (a.y - b.y) * h;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < connDist) {
          const alpha = (1 - d / connDist) * 0.12;
          ctx!.strokeStyle = `rgba(208,188,255,${alpha.toFixed(3)})`;
          ctx!.beginPath();
          ctx!.moveTo(a.x * w, a.y * h);
          ctx!.lineTo(b.x * w, b.y * h);
          ctx!.stroke();
        }
      }
    }

    animId = requestAnimationFrame(draw);
  }
  animId = requestAnimationFrame(draw);
  return () => cancelAnimationFrame(animId);
}

// ─── WebGPU Renderer ────────────────────────────────────────────

async function initWebGPU(
  canvas: HTMLCanvasElement,
  getMouseRef: () => { x: number; y: number; active: boolean },
  count: number,
) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No GPU adapter");
  const device = await adapter.requestDevice();
  const gpuContext = canvas.getContext("webgpu");
  if (!gpuContext) throw new Error("No WebGPU context");

  const format = navigator.gpu.getPreferredCanvasFormat();
  gpuContext.configure({ device, format, alphaMode: "premultiplied" });

  const particleStride = 8 * 4; // 8 floats × 4 bytes
  const particleBuffer = device.createBuffer({
    size: count * particleStride,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  // Initialize particles
  const initData = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) {
    const off = i * 8;
    initData[off + 0] = Math.random(); // x
    initData[off + 1] = Math.random(); // y
    initData[off + 2] = (Math.random() - 0.5) * 0.0003; // vx
    initData[off + 3] = (Math.random() - 0.5) * 0.0003; // vy
    initData[off + 4] = Math.random(); // life
    initData[off + 5] = 1.0 + Math.random() * 1.5; // size
    initData[off + 6] = Math.random(); // colorIdx
    initData[off + 7] = 0; // padding
  }
  device.queue.writeBuffer(particleBuffer, 0, initData);

  // Uniforms
  const paramBuffer = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const viewBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Compute pipeline
  const computeModule = device.createShaderModule({ code: COMPUTE_SHADER });
  const computePipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module: computeModule },
  });
  const computeBG = device.createBindGroup({
    layout: computePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramBuffer } },
      { binding: 1, resource: { buffer: particleBuffer } },
    ],
  });

  // Render pipeline
  const renderModule = device.createShaderModule({
    code: VERTEX_SHADER,
  });
  const renderPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: renderModule },
    fragment: {
      module: renderModule,
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });
  const renderBG = device.createBindGroup({
    layout: renderPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: particleBuffer } },
      { binding: 1, resource: { buffer: viewBuffer } },
    ],
  });

  let lastTime = performance.now();
  let time = 0;
  let animId = 0;

  function frame() {
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    time += dt;

    const mouse = getMouseRef();
    const dpr = devicePixelRatio;

    // Update uniforms
    const params = new Float32Array([
      dt,
      mouse.x,
      mouse.y,
      mouse.active ? 1 : 0,
      time,
      0, 0, 0, // particleCount as u32 — handled via u32 view
    ]);
    const paramsU32 = new Uint32Array(params.buffer);
    paramsU32[5] = count;
    device.queue.writeBuffer(paramBuffer, 0, params.buffer, 0, 32);

    const viewData = new Float32Array([canvas.width, canvas.height, dpr, 0]);
    device.queue.writeBuffer(viewBuffer, 0, viewData);

    const commandEncoder = device.createCommandEncoder();

    // Compute pass
    const computePass = commandEncoder.beginComputePass();
    computePass.setPipeline(computePipeline);
    computePass.setBindGroup(0, computeBG);
    computePass.dispatchWorkgroups(Math.ceil(count / 64));
    computePass.end();

    // Render pass
    const textureView = gpuContext!.getCurrentTexture().createView();
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: textureView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    renderPass.setPipeline(renderPipeline);
    renderPass.setBindGroup(0, renderBG);
    renderPass.draw(6, count);
    renderPass.end();

    device.queue.submit([commandEncoder.finish()]);
    animId = requestAnimationFrame(frame);
  }

  animId = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(animId);
    device.destroy();
  };
}

// ─── React Component ────────────────────────────────────────────

interface ParticleFieldProps {
  className?: string;
  /** Fixed fullscreen mode for global site background */
  global?: boolean;
  /** Particle count override */
  count?: number;
}

export function ParticleField({
  className,
  global = false,
  count = DEFAULT_PARTICLE_COUNT,
}: ParticleFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef({ x: 0.5, y: 0.5, active: false });
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  const getMouse = useCallback(() => mouseRef.current, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const resize = () => {
      if (global) {
        const dpr = Math.min(devicePixelRatio, 2);
        canvas.width = window.innerWidth * dpr;
        canvas.height = window.innerHeight * dpr;
        canvas.style.width = `${window.innerWidth}px`;
        canvas.style.height = `${window.innerHeight}px`;
      } else {
        const rect = container.getBoundingClientRect();
        const dpr = Math.min(devicePixelRatio, 2);
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
      }
    };
    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(global ? document.documentElement : container);

    // Global mode: track mouse on window; local mode: track on container
    const onMouse = (e: MouseEvent) => {
      if (global) {
        mouseRef.current = {
          x: e.clientX / window.innerWidth,
          y: e.clientY / window.innerHeight,
          active: true,
        };
      } else {
        const rect = container.getBoundingClientRect();
        mouseRef.current = {
          x: (e.clientX - rect.left) / rect.width,
          y: (e.clientY - rect.top) / rect.height,
          active: true,
        };
      }
    };
    const onLeave = () => {
      mouseRef.current = { ...mouseRef.current, active: false };
    };

    const mouseTarget = global ? window : container;
    const leaveTarget = global ? document : container;
    mouseTarget.addEventListener("mousemove", onMouse as EventListener, { passive: true });
    leaveTarget.addEventListener("mouseleave", onLeave);

    let cleanup: (() => void) | undefined;

    const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;

    if (hasWebGPU) {
      initWebGPU(canvas, getMouse, count)
        .then((dispose) => {
          cleanup = dispose;
          setReady(true);
        })
        .catch(() => {
          cleanup = runCanvas2DFallback(canvas, getMouse, count);
          setReady(true);
        });
    } else {
      cleanup = runCanvas2DFallback(canvas, getMouse, count);
      setReady(true);
    }

    return () => {
      cleanup?.();
      ro.disconnect();
      mouseTarget.removeEventListener("mousemove", onMouse as EventListener);
      leaveTarget.removeEventListener("mouseleave", onLeave);
    };
  }, [getMouse, global, count]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        position: global ? "fixed" : "absolute",
        inset: 0,
        pointerEvents: "none",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: 0,
          opacity: ready ? 1 : 0,
          transition: "opacity 1.5s ease",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
