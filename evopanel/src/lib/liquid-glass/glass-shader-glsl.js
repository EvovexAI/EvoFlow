/** GLSL sources for EvoFlow liquid glass */
export const VS_SRC = `
  attribute vec2 a_pos;
  void main() {
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }
`

export const FS_SRC = `
  precision mediump float;

  uniform sampler2D u_texture;
  uniform sampler2D u_blurred_texture;
  uniform int u_has_blurred;
  uniform vec2 u_resolution;
  
  // Layer 1: 侧边栏、模态弹窗与气泡弹出菜单几何材质
  uniform float u_sidebar_width_px;
  uniform vec4 u_modal_rect; // xy: centerPx, zw: halfPx
  uniform float u_modal_radius;
  uniform float u_modal_progress;
  uniform int u_has_modal;
  uniform int u_has_chat;
  uniform vec4 u_chat_rect; // xy: centerPx, zw: halfPx
  uniform float u_chat_radius;
  uniform int u_has_header;
  uniform vec4 u_header_rect;
  #define MAX_POPOVERS 16
  uniform vec4 u_popovers[MAX_POPOVERS]; // xy: centerPx, zw: halfPx
  uniform float u_popover_radii[MAX_POPOVERS];
  uniform int u_popover_count;
  uniform float u_l1_blur;
  uniform float u_modal_blur;
  uniform float u_l1_opacity;
  uniform float u_l1_border;

  // Layer 2: 多透镜物理液态阵列 (所有 L2 层级元素: 0=背景透镜, 1=弹窗前台透镜)
  #define MAX_LENSES 64
  uniform vec4 u_lenses[MAX_LENSES]; // xy: centerPx, zw: halfPx
  uniform float u_lens_radii[MAX_LENSES];
  uniform float u_lens_layers[MAX_LENSES];
  uniform int u_lens_count;

  uniform float u_time;
  uniform float u_ior;
  uniform float u_bulge;
  uniform float u_dispersion;
  uniform float u_bevel_width;
  uniform float u_lens_blur;
  uniform float u_ref_thickness;
  uniform float u_fresnel_factor;
  uniform float u_glare_factor;
  uniform float u_darkening;
  uniform float u_rim_intensity;
  uniform float u_light_angle;
  uniform float u_vibrancy;
  uniform float u_ripple_amp;

  uniform float u_shadow_opacity;
  uniform float u_shadow_blur;
  uniform float u_shadow_offset_y;

  // Layer 0: 背景流体
  uniform int u_bg_liquid_enabled;
  uniform float u_bg_amp;
  uniform float u_bg_scale;
  uniform float u_bg_speed;
  uniform float u_bg_dispersion;

  uniform vec4 u_ripple0;
  uniform vec4 u_ripple1;

  float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
  }

  vec2 hash22(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
  }

  float snoise(vec2 p) {
    const float K1 = 0.366025404;
    const float K2 = 0.211324865;
    vec2 i = floor(p + (p.x + p.y) * K1);
    vec2 a = p - i + (i.x + i.y) * K2;
    vec2 o = step(a.yx, a.xy);
    vec2 b = a - o + K2;
    vec2 c = a - 1.0 + 2.0 * K2;
    vec3 h = max(0.5 - vec3(dot(a, a), dot(b, b), dot(c, c)), 0.0);
    vec3 n = h * h * h * h * vec3(dot(a, hash22(i)), dot(b, hash22(i + o)), dot(c, hash22(i + 1.0)));
    return dot(n, vec3(70.0));
  }

  // 大尺度低频稀疏流水域翘曲
  vec2 waterStreamTurbulence(vec2 uv, float t) {
    if (u_bg_amp <= 0.0001) return vec2(0.0);
    vec2 p = uv * max(u_bg_scale, 0.1) * 1.6;
    vec2 q = vec2(
      snoise(p * 0.85 + vec2(t * 0.35, t * 0.20)),
      snoise(p * 0.85 + vec2(-t * 0.25, t * 0.30))
    );
    vec2 r = vec2(
      snoise((p + q * 0.85) * 1.5 + vec2(t * 0.45, -t * 0.40)),
      snoise((p + q * 0.85) * 1.5 + vec2(-t * 0.35, t * 0.50))
    );
    vec2 s = vec2(
      snoise((p + r * 0.60) * 2.6 + vec2(-t * 0.65, t * 0.70)),
      snoise((p + r * 0.60) * 2.6 + vec2(t * 0.70, -t * 0.60))
    );
    return (q * 0.55 + r * 0.35 + s * 0.10) * 0.038 * u_bg_amp;
  }

  vec3 sampleTex(sampler2D tex, vec2 uv) {
    return texture2D(tex, vec2(uv.x, 1.0 - uv.y)).rgb;
  }

  // 16-Tap 高斯雾面（无预模糊纹理时的回退）
  vec3 sampleGaussianFrosted(vec2 baseUv, float blurPx, vec2 fragCoord) {
    if (blurPx <= 0.2) {
      return sampleTex(u_texture, baseUv);
    }
    vec2 step = vec2((blurPx * 3.5) / u_resolution.x, (blurPx * 3.5) / u_resolution.y);
    
    // 微表面毛玻璃微观漫散射微扰 (Micro-Roughness Diffusion)
    vec2 noise = hash22(fragCoord * 0.8) * step * 0.50;
    vec2 centerUv = baseUv + noise;

    vec3 acc = vec3(0.0);
    float totalW = 0.0;

    // 中心权重
    acc += sampleTex(u_texture, centerUv) * 0.2270;
    totalW += 0.2270;

    // 第 1 环 (0.38 * radius, 4 采样)
    vec2 s1 = step * 0.38;
    acc += texture2D(u_texture, vec2(centerUv.x + s1.x, 1.0 - (centerUv.y))).rgb * 0.0790;
    acc += texture2D(u_texture, vec2(centerUv.x - s1.x, 1.0 - (centerUv.y))).rgb * 0.0790;
    acc += texture2D(u_texture, vec2(centerUv.x, 1.0 - (centerUv.y + s1.y))).rgb * 0.0790;
    acc += texture2D(u_texture, vec2(centerUv.x, 1.0 - (centerUv.y - s1.y))).rgb * 0.0790;
    totalW += 0.3160;

    // 第 2 环对角 (0.75 * radius, 4 采样)
    vec2 s2 = step * 0.53;
    acc += texture2D(u_texture, vec2(centerUv.x + s2.x, 1.0 - (centerUv.y + s2.y))).rgb * 0.0700;
    acc += texture2D(u_texture, vec2(centerUv.x - s2.x, 1.0 - (centerUv.y + s2.y))).rgb * 0.0700;
    acc += texture2D(u_texture, vec2(centerUv.x - s2.x, 1.0 - (centerUv.y - s2.y))).rgb * 0.0700;
    acc += texture2D(u_texture, vec2(centerUv.x + s2.x, 1.0 - (centerUv.y - s2.y))).rgb * 0.0700;
    totalW += 0.2800;

    // 第 3 环外沿 (1.00 * radius, 4 采样)
    vec2 s3 = step * 0.92;
    acc += texture2D(u_texture, vec2(centerUv.x + s3.x * 0.924, 1.0 - (centerUv.y + s3.y * 0.383))).rgb * 0.0442;
    acc += texture2D(u_texture, vec2(centerUv.x - s3.x * 0.924, 1.0 - (centerUv.y + s3.y * 0.383))).rgb * 0.0442;
    acc += texture2D(u_texture, vec2(centerUv.x - s3.x * 0.383, 1.0 - (centerUv.y - s3.y * 0.924))).rgb * 0.0442;
    acc += texture2D(u_texture, vec2(centerUv.x + s3.x * 0.383, 1.0 - (centerUv.y - s3.y * 0.924))).rgb * 0.0442;
    totalW += 0.1770;

    return acc / totalW;
  }

  vec3 sampleBackdrop(vec2 uvSample, vec2 fragPxSample, float blurPx) {
    vec3 sharp = sampleTex(u_texture, uvSample);
    vec3 color = sharp;
    if (u_has_blurred == 1 && blurPx > 0.2) {
      vec3 blurred = sampleTex(u_blurred_texture, uvSample);
      float blurMix = clamp(blurPx / 28.0, 0.55, 1.0);
      color = mix(sharp, blurred, blurMix);
    } else if (blurPx > 0.2) {
      color = sampleGaussianFrosted(uvSample, blurPx, fragPxSample);
    }
    if (u_l1_opacity > 0.001) {
      color = mix(color, vec3(0.04, 0.07, 0.12), clamp(u_l1_opacity, 0.0, 0.88));
    }
    return color;
  }

  vec3 sampleDispersed(vec2 uv, vec2 offset, float dispersion) {
    vec2 uvR = clamp(uv + offset * (1.0 - dispersion), 0.001, 0.999);
    vec2 uvG = clamp(uv + offset, 0.001, 0.999);
    vec2 uvB = clamp(uv + offset * (1.0 + dispersion), 0.001, 0.999);
    return vec3(
      sampleTex(u_texture, uvR).r,
      sampleTex(u_texture, uvG).g,
      sampleTex(u_texture, uvB).b
    );
  }

  vec3 sampleDispersedMixed(vec2 uv, vec2 offset, float dispersion, float blurMix) {
    if (u_has_blurred != 1 || blurMix <= 0.001) {
      return sampleDispersed(uv, offset, dispersion);
    }
    vec2 uvR = clamp(uv + offset * (1.0 - dispersion), 0.001, 0.999);
    vec2 uvG = clamp(uv + offset, 0.001, 0.999);
    vec2 uvB = clamp(uv + offset * (1.0 + dispersion), 0.001, 0.999);
    vec3 sharp = vec3(
      sampleTex(u_texture, uvR).r,
      sampleTex(u_texture, uvG).g,
      sampleTex(u_texture, uvB).b
    );
    vec3 blurred = vec3(
      sampleTex(u_blurred_texture, uvR).r,
      sampleTex(u_blurred_texture, uvG).g,
      sampleTex(u_blurred_texture, uvB).b
    );
    return mix(sharp, blurred, clamp(blurMix, 0.0, 1.0));
  }

  void main() {
    vec2 fragPx = gl_FragCoord.xy;
    vec2 uv = fragPx / u_resolution;
    vec2 flowOffset = vec2(0.0);
    if (u_bg_liquid_enabled == 1 && u_bg_amp > 0.0001) {
      flowOffset = waterStreamTurbulence(uv, u_time * u_bg_speed);
    }
    vec2 backdropUv = clamp(uv + flowOffset, 0.001, 0.999);

    vec3 color = sampleDispersed(backdropUv, flowOffset, u_bg_dispersion);
    float bestD = 10000.0;
    vec2 bestCenter = vec2(0.0);
    vec2 bestHalf = vec2(0.0);
    float bestRadius = 0.0;

    for (int i = 0; i < MAX_LENSES; i++) {
      if (i >= u_lens_count) break;
      float d = sdRoundedBox(fragPx - u_lenses[i].xy, u_lenses[i].zw, u_lens_radii[i]);
      if (d < bestD) {
        bestD = d;
        bestCenter = u_lenses[i].xy;
        bestHalf = u_lenses[i].zw;
        bestRadius = u_lens_radii[i];
      }
    }

    float chatDist = u_has_chat == 1 ? sdRoundedBox(fragPx - u_chat_rect.xy, u_chat_rect.zw, u_chat_radius) : 10000.0;
    float headerDist = u_has_header == 1 ? sdRoundedBox(fragPx - u_header_rect.xy, u_header_rect.zw, 0.0) : 10000.0;
    float modalDist = u_has_modal == 1 ? sdRoundedBox(fragPx - u_modal_rect.xy, u_modal_rect.zw, u_modal_radius) : 10000.0;
    if (u_sidebar_width_px > 10.0 && fragPx.x <= u_sidebar_width_px) {
      color = sampleBackdrop(backdropUv, fragPx, u_l1_blur);
    } else if (headerDist <= 0.0 || chatDist <= 0.0) {
      color = sampleBackdrop(backdropUv, fragPx, u_l1_blur);
    } else if (modalDist <= 0.0) {
      color = sampleBackdrop(backdropUv, fragPx, u_modal_blur * u_modal_progress);
    } else {
      for (int i = 0; i < MAX_POPOVERS; i++) {
        if (i >= u_popover_count) break;
        float frostDist = sdRoundedBox(fragPx - u_popovers[i].xy, u_popovers[i].zw, u_popover_radii[i]);
        if (frostDist <= 0.0) {
          color = sampleBackdrop(backdropUv, fragPx, u_l1_blur);
          break;
        }
      }
    }

    // Layer 2 is the top optical surface. Compose it after Layer 1/3 backdrops
    // so the chat or modal base cannot overwrite the composer refraction.
    if (bestD <= 0.0) {
      vec2 p = fragPx - bestCenter;
      float eps = 2.0;
      vec2 grad = vec2(
        sdRoundedBox(p + vec2(eps, 0.0), bestHalf, bestRadius) - sdRoundedBox(p - vec2(eps, 0.0), bestHalf, bestRadius),
        sdRoundedBox(p + vec2(0.0, eps), bestHalf, bestRadius) - sdRoundedBox(p - vec2(0.0, eps), bestHalf, bestRadius)
      );
      vec2 edgeDir = length(grad) > 0.0001 ? normalize(grad) : vec2(0.0);
      vec2 normPos = clamp(p / max(bestHalf, vec2(1.0)), -1.0, 1.0);
      vec2 internalBulge = normPos * (1.0 - length(normPos) * 0.35) * 0.28 * u_bulge;
      float bevelPx = max(u_bevel_width * u_resolution.y, 8.0);
      float edgeSlope = sin(clamp(-bestD / bevelPx, 0.0, 1.0) * 3.14159265);
      vec2 edgeOffset = edgeDir * (edgeSlope * 0.28 + exp(-(-bestD) * 0.08) * 0.14);

      // Snell 折射（liquid-glass-studio 思路）
      float thickness = max(u_ref_thickness, 6.0);
      float nmerged = max(-bestD, 0.0);
      float xRatio = 1.0 - clamp(nmerged / thickness, 0.0, 1.0);
      float thetaI = asin(clamp(xRatio * xRatio, 0.0, 1.0));
      float refFactor = max(u_ior, 1.05);
      float thetaT = asin(clamp(sin(thetaI) / refFactor, 0.0, 1.0));
      float snellFactor = max(-tan(thetaT - thetaI), 0.0);
      vec2 snellOffset = edgeDir * snellFactor * 0.034;

      vec2 lensOffset = snellOffset + internalBulge + edgeOffset + flowOffset;

      // Pointer ripples use the same aspect-correct coordinate space as the
      // pointerdown handler. Their damped wave changes the sampled scene
      // position, so ripple tension is visible as actual lens refraction.
      vec2 scenePos = vec2(
        (fragPx.x / u_resolution.x - 0.5) * (u_resolution.x / u_resolution.y),
        0.5 - fragPx.y / u_resolution.y
      );
      vec2 rippleOffset = vec2(0.0);
      float rippleTime0 = u_time - u_ripple0.z;
      if (rippleTime0 > 0.0 && rippleTime0 < 2.5 && u_ripple0.w > 0.0) {
        vec2 delta0 = scenePos - u_ripple0.xy;
        float radius0 = length(delta0);
        vec2 direction0 = radius0 > 0.0001 ? delta0 / radius0 : vec2(0.0);
        float wave0 = sin(radius0 * 35.0 - rippleTime0 * 14.0)
          * exp(-radius0 * 5.0 - rippleTime0 * 2.0);
        rippleOffset += direction0 * wave0 * 0.02 * u_ripple0.w * u_ripple_amp;
      }
      float rippleTime1 = u_time - u_ripple1.z;
      if (rippleTime1 > 0.0 && rippleTime1 < 2.5 && u_ripple1.w > 0.0) {
        vec2 delta1 = scenePos - u_ripple1.xy;
        float radius1 = length(delta1);
        vec2 direction1 = radius1 > 0.0001 ? delta1 / radius1 : vec2(0.0);
        float wave1 = sin(radius1 * 35.0 - rippleTime1 * 14.0)
          * exp(-radius1 * 5.0 - rippleTime1 * 2.0);
        rippleOffset += direction1 * wave1 * 0.02 * u_ripple1.w * u_ripple_amp;
      }
      lensOffset += rippleOffset;

      float disp = u_dispersion * 9.0 * mix(0.55, 2.6, edgeSlope);
      float edgeDepth = clamp(nmerged / thickness, 0.0, 1.0);
      float blurMix = mix(0.18, 0.92, edgeDepth);
      color = sampleDispersedMixed(uv, lensOffset, disp, blurMix);
      if (u_lens_blur > 0.2 && u_has_blurred != 1) {
        color = mix(color, sampleGaussianFrosted(clamp(uv + lensOffset, 0.001, 0.999), u_lens_blur, fragPx), clamp(u_lens_blur / 20.0, 0.0, 0.65));
      }
      float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(lum), color, u_vibrancy);
      color = mix(color, vec3(0.04, 0.07, 0.12), clamp(u_darkening * 0.85, 0.0, 0.72));

      float fresnel = pow(1.0 - edgeDepth, 2.2) * u_fresnel_factor;
      color += vec3(0.92, 0.96, 1.0) * fresnel * edgeSlope * 1.35;

      if (u_rim_intensity > 0.001 || u_glare_factor > 0.001) {
        float angle = radians(u_light_angle);
        float specular = max(dot(edgeDir, vec2(cos(angle), sin(angle))), 0.0);
        float rim = pow(specular, 9.0) * edgeSlope * u_rim_intensity;
        float glare = pow(specular, 4.2) * edgeSlope * u_glare_factor;
        color += vec3(0.98, 1.0, 1.0) * (rim + glare * 2.2);
      }
    }

    gl_FragColor = vec4(color, 1.0);
  }
`