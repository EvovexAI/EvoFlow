// 独立实现的柔和灰阶流场，不包含第三方付费预设代码。
const vertexSource = `
attribute vec2 position;
varying vec2 uv;
void main() { uv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }
`;
const fragmentSource = `
precision mediump float;
varying vec2 uv;
uniform float time;
uniform float aspect;
uniform vec3 tint;
void main() {
  vec2 p = vec2(uv.x, 1.0 - uv.y);
  float t = time * 2.0;
  vec2 q = p;
  q.x += 0.17 * sin(p.y * 4.1 + t) + 0.08 * cos(p.y * 7.0 - t * 0.6);
  q.y += 0.12 * sin(p.x * 3.5 - t * 0.8);
  float sweep = q.x * 0.78 + q.y * 0.58;
  float band = exp(-pow((sweep - 0.7 - 0.06 * sin(t)) * 4.0, 2.0));
  float fold = smoothstep(0.29, 0.64, sweep) * (1.0 - smoothstep(0.65, 1.18, sweep));
  float halo = exp(-length((p - vec2(0.82, 0.22)) * vec2(aspect, 1.0)) * 2.4);
  float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  // 下半区逐渐收暗，避免背景亮度变化经过固定文案。
  float shade = 1.0 - smoothstep(0.42, 0.88, p.y);
  float light = (band * 0.30 + fold * 0.12 + halo * 0.14) * (0.3 + 0.7 * shade);
  float alpha = clamp(light + grain * 0.012, 0.0, 0.55);
  gl_FragColor = vec4(tint * alpha, alpha);
}
`;

export function createOnboardingMeshRenderer(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    powerPreference: "low-power",
  });
  if (!gl) return null;
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
    gl.deleteShader(shader);
    return null;
  };
  const vertex = compile(gl.VERTEX_SHADER, vertexSource);
  if (!vertex) return null;
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
  if (!fragment) {
    gl.deleteShader(vertex);
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    return null;
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  const buffer = gl.createBuffer();
  if (!buffer) {
    gl.deleteProgram(program);
    return null;
  }
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const time = gl.getUniformLocation(program, "time");
  const aspect = gl.getUniformLocation(program, "aspect");
  const tint = gl.getUniformLocation(program, "tint");
  return {
    draw(
      seconds: number,
      width: number,
      height: number,
      color: readonly [number, number, number] = [1, 1, 1],
    ) {
      const scale = Math.min(1, 960 / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.uniform3f(tint, ...color);
      gl.uniform1f(time, seconds);
      gl.uniform1f(aspect, width / height);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    dispose() {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}
