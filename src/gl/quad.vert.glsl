#version 300 es

// One full-screen triangle pair. There is no camera, no scene, and no geometry
// beyond this: the surface is a 2D effect and every pixel is the fragment
// shader's problem.

in vec2 aPosition;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
