#version 300 es

// Still — the surface.
//
// A layered gradient-noise height field, folded through two levels of domain
// warp so it flows rather than scrolls, lit with a soft specular term so it
// reads as liquid rather than as a blurred gradient.
//
// The noise is hand-written: a 32-bit integer hash (WebGL2 gives us integer
// ops, so there is no need for the sin-based hash that falls apart at large
// coordinates) feeding a quintic-interpolated gradient noise that returns its
// own analytic derivative. Carrying the derivative means the surface normal
// costs nothing extra — the alternative, central differences, would triple the
// number of noise evaluations per pixel for the same picture.

precision highp float;

uniform float uTime;       // seconds, monotonic, paused with the tab
uniform vec2  uResolution; // drawing-buffer pixels
uniform float uPressure;   // 0..1  how much is on the plate
uniform float uHeat;       // 0..1  how much of it is late
uniform vec4  uRipples[8]; // xy = origin in aspect-corrected clip space, z = start, w = strength
uniform float uStill;      // 0..1  master damping; 1 = reduced-effects stillness

// Palette stops, uploaded from palette.ts: deep, mid, light, foam. Heat walks
// cool -> dusk -> warm; the middle ramp is there because teal mixed straight
// into oxblood goes through grey. See palette.ts.
uniform vec3 uCool[4];
uniform vec3 uDusk[4];
uniform vec3 uWarm[4];

out vec4 fragColor;

const int   RIPPLE_SLOTS    = 8;
const float RIPPLE_LIFETIME = 1.2;   // seconds; mirrored in ripples.ts
const float RIPPLE_SPEED    = 0.55;  // clip-space units per second
const float RIPPLE_WIDTH    = 0.055; // ring thickness

// ---------------------------------------------------------------- noise ----

uint hash(uvec2 p) {
  uint h = p.x * 0x8da6b343u + p.y * 0xd8163841u;
  h ^= h >> 15; h *= 0x2c1b3c6du;
  h ^= h >> 13; h *= 0x297a2d39u;
  h ^= h >> 16;
  return h;
}

// Unit vector per lattice cell. Negative cells are fine: int-to-uint keeps the
// low bits, so the hash is defined across the whole plane.
vec2 gradientAt(ivec2 cell) {
  float a = float(hash(uvec2(cell)) & 0xffffu) * (6.28318530718 / 65536.0);
  return vec2(cos(a), sin(a));
}

// Gradient noise returning vec3(value, d/dx, d/dy), value roughly in -1..1.
vec3 noised(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;

  vec2 u  = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);

  ivec2 c = ivec2(i);
  vec2 ga = gradientAt(c);
  vec2 gb = gradientAt(c + ivec2(1, 0));
  vec2 gc = gradientAt(c + ivec2(0, 1));
  vec2 gd = gradientAt(c + ivec2(1, 1));

  float va = dot(ga, f);
  float vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0));
  float vd = dot(gd, f - vec2(1.0, 1.0));

  float k1 = vb - va;
  float k2 = vc - va;
  float k3 = va - vb - vc + vd;

  float value = va + u.x * k1 + u.y * k2 + u.x * u.y * k3;
  vec2  deriv = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
              + du * vec2(k1 + u.y * k3, k2 + u.x * k3);

  return vec3(value, deriv) * 1.4142;
}

// Rotate between octaves so the lattice never lines up with itself and the
// field stops looking like a grid.
const mat2 ROT = mat2(0.80, 0.60, -0.60, 0.80);

// fBm carrying its derivative. Octave i samples ROT^i * 2^i * p, so the chain
// rule needs that map's transpose, accumulated in m.
vec3 fbm(vec2 p, int octaves) {
  float amp = 0.55;
  float sum = 0.0;
  vec2  der = vec2(0.0);
  mat2  m   = mat2(1.0, 0.0, 0.0, 1.0);

  for (int i = 0; i < 4; i++) {
    if (i >= octaves) break;
    vec3 n = noised(p);
    sum += amp * n.x;
    der += amp * (m * n.yz);
    p = ROT * p * 2.0;
    m = 2.0 * m * transpose(ROT);
    amp *= 0.5;
  }
  return vec3(sum, der);
}

// -------------------------------------------------------------- surface ----

// Two levels of warp: the field is read through a coordinate that is itself
// displaced by noise, which is what turns a scrolling texture into something
// that folds and circulates.
//
// The returned derivative ignores the warp's Jacobian — strictly it should be
// chained through dq/dp and dr/dp, which costs four more fBm evaluations. At
// these warp amplitudes the difference is a slight softening of the specular
// and nothing else, so the approximation is deliberate, not an oversight.
vec3 surface(vec2 p, float t, float freq, float warpAmp, float flow) {
  vec2 base = p * freq;

  vec2 q = vec2(
    fbm(base + vec2(0.00, t * flow), 2).x,
    fbm(base + vec2(4.70, 2.10) - t * flow * 0.8, 2).x
  );

  vec2 r = vec2(
    fbm(base + warpAmp * q + vec2(1.70, 9.20), 2).x,
    fbm(base + warpAmp * q + vec2(8.30, 2.80) + t * flow * 0.5, 2).x
  );

  vec3 h = fbm(base + warpAmp * r, 4);
  return vec3(h.x, h.yz * freq);
}

// Expanding rings, height and slope together so the specular catches them.
vec3 ripples(vec2 p, float t, float damp) {
  vec3 acc = vec3(0.0);

  for (int i = 0; i < RIPPLE_SLOTS; i++) {
    vec4 r = uRipples[i];
    if (r.w <= 0.0) continue;

    float age = t - r.z;
    if (age < 0.0 || age > RIPPLE_LIFETIME) continue;

    vec2  delta  = p - r.xy;
    float dist   = length(delta) + 1e-5;
    float radius = age * RIPPLE_SPEED;
    float x      = (dist - radius) / RIPPLE_WIDTH;
    float g      = exp(-x * x);

    float decay = 1.0 - age / RIPPLE_LIFETIME;
    float amp   = r.w * decay * decay * damp;

    acc.x  += amp * g;
    acc.yz += (delta / dist) * (-2.0 * x / RIPPLE_WIDTH) * amp * g;
  }

  return acc;
}

// -------------------------------------------------------------- palette ----

vec3 shade(vec3 deep, vec3 mid, vec3 light, float t) {
  return t < 0.5 ? mix(deep, mid, t * 2.0) : mix(mid, light, (t - 0.5) * 2.0);
}

// One stop of the heat ramp, mirroring rampFor() in palette.ts.
vec3 stopAt(int i, float heat) {
  return heat < 0.5
    ? mix(uCool[i], uDusk[i], heat * 2.0)
    : mix(uDusk[i], uWarm[i], (heat - 0.5) * 2.0);
}

// ----------------------------------------------------------------- main ----

void main() {
  // Aspect-corrected, origin at centre, one unit from centre to top edge.
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;

  float still  = clamp(uStill, 0.0, 1.0);
  float motion = 1.0 - still;

  // Stillness removes movement, not information. Flow and warp are damped by
  // uStill; frequency, relief and palette are not, so a reduced-effects user
  // still gets a surface that is denser when they are busy and warmer when
  // they are late — it simply holds still. This is the same bargain the CSS
  // fallback makes.
  //
  // The low end of the frequency range is bounded away from zero on purpose:
  // below about one cycle per screen the whole viewport falls inside a single
  // noise lobe, so an empty list would render as an arbitrarily bright or dark
  // wash depending on where the field happened to be. Calm has to be reliably
  // calm — it is the state this app is trying to get you to.
  float agitation = clamp(uPressure, 0.0, 1.0);
  float freq      = mix(1.30, 5.00, agitation);
  float warpAmp   = mix(0.20, 1.30, agitation) * (1.0 - 0.85 * still);
  float flow      = mix(0.05, 0.45, agitation) * motion;
  float relief    = mix(0.18, 1.00, agitation);

  vec3 field = surface(p, uTime, freq, warpAmp, flow);
  vec3 ring  = ripples(p, uTime, motion);

  // Relief scales height as well as slope: a calm surface is not just slower,
  // it is shallower, so it sits near the bottom of the ramp instead of showing
  // the same crests at a lower frequency.
  float height = (field.x + ring.x * 0.55) * relief;
  vec2  slope  = (field.yz + ring.yz * 0.55) * relief * 0.55;

  vec3 n = normalize(vec3(-slope, 1.0));

  vec3 lightDir = normalize(vec3(-0.32, 0.55, 0.77));
  vec3 halfway  = normalize(lightDir + vec3(0.0, 0.0, 1.0));

  float heat = clamp(uHeat, 0.0, 1.0);
  vec3 deep  = stopAt(0, heat);
  vec3 mid   = stopAt(1, heat);
  vec3 light = stopAt(2, heat);
  vec3 foam  = stopAt(3, heat);

  // Lateness sharpens the highlight as well as warming it, so heat is legible
  // in the surface's texture and not by hue alone.
  float shininess = mix(20.0, 96.0, heat);
  float specular  = pow(max(dot(n, halfway), 0.0), shininess) * mix(0.35, 0.75, heat);
  float diffuse   = clamp(dot(n, lightDir) * 0.5 + 0.5, 0.0, 1.0);
  float fresnel   = pow(1.0 - clamp(n.z, 0.0, 1.0), 3.0);

  // Where the surface sits on its ramp before the height field moves it. A
  // calm list rests near the deep end and stays there; a busy one rests at the
  // mid stop and swings both ways. Without this, clearing your list would make
  // the screen brighter, which is exactly backwards.
  float level = mix(0.18, 0.54, agitation);

  vec3 color = shade(deep, mid, light, clamp(level + height * 0.5, 0.0, 1.0));
  color *= 0.72 + 0.46 * diffuse;
  color += foam * specular;
  color += foam * fresnel * 0.10;
  color += foam * clamp(ring.x, 0.0, 1.0) * 0.06;

  // Hold the corners down so the header and sidebar always sit on the darker
  // end of the ramp, whatever the surface is doing in the middle.
  float vignette = 1.0 - 0.28 * dot(p, p);
  color *= vignette;

  // A quarter-LSB of noise. Large smooth gradients band badly on 8-bit output
  // and the banding moves, which is far more distracting than the dither.
  float dither = (float(hash(uvec2(gl_FragCoord.xy)) & 0xffffu) / 65535.0 - 0.5) / 255.0;

  fragColor = vec4(color + dither, 1.0);
}
