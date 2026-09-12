/** Separable Gaussian blur passes (WebGL1), inspired by liquid-glass-studio */

export const BLUR_VS = `
  attribute vec2 a_pos;
  varying vec2 v_uv;
  void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }
`

export const BLUR_H_FS = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_texture;
  uniform vec2 u_resolution;
  uniform int u_blurRadius;
  uniform float u_blurWeights[25];

  vec3 sampleTex(vec2 uv) {
    return texture2D(u_texture, vec2(uv.x, 1.0 - uv.y)).rgb;
  }

  void main() {
    vec2 texel = 1.0 / u_resolution;
    vec3 color = sampleTex(v_uv) * u_blurWeights[0];
    for (int i = 1; i < 25; i++) {
      if (i > u_blurRadius) break;
      float w = u_blurWeights[i];
      float off = float(i) * texel.x;
      color += sampleTex(v_uv + vec2(off, 0.0)) * w;
      color += sampleTex(v_uv - vec2(off, 0.0)) * w;
    }
    gl_FragColor = vec4(color, 1.0);
  }
`

export const BLUR_V_FS = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_texture;
  uniform vec2 u_resolution;
  uniform int u_blurRadius;
  uniform float u_blurWeights[25];

  vec3 sampleTex(vec2 uv) {
    return texture2D(u_texture, vec2(uv.x, 1.0 - uv.y)).rgb;
  }

  void main() {
    vec2 texel = 1.0 / u_resolution;
    vec3 color = sampleTex(v_uv) * u_blurWeights[0];
    for (int i = 1; i < 25; i++) {
      if (i > u_blurRadius) break;
      float w = u_blurWeights[i];
      float off = float(i) * texel.y;
      color += sampleTex(v_uv + vec2(0.0, off)) * w;
      color += sampleTex(v_uv - vec2(0.0, off)) * w;
    }
    gl_FragColor = vec4(color, 1.0);
  }
`
