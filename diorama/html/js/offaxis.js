// Diorama — the window projection. Pure maths: imports nothing, so node can test it.
//
// The screen is treated as a real window into the box. It lies in the plane z = 0 of the world, centred on the
// origin, `halfW` x `halfH` metres either side of it, and the box is behind it (-z). The viewer's eye is a real
// point in front of it (+z), measured by the webcam. The picture that is right for that eye is the one a
// pinhole at the eye would cast onto the window's rectangle, which is a perspective projection whose frustum
// is NOT symmetric about its axis: it leans, so that its four side planes pass through the window's four edges
// wherever the eye is. (Kooima, "Generalized Perspective Projection", 2008; the trick behind Johnny Lee's
// head-tracked Wii demo.) Turning an ordinary camera toward the box instead would look plausible and be wrong:
// the walls would stop meeting the edges of the screen as the head moved.
//
// The camera therefore never rotates. It sits at the eye, looks straight down -z, and only its frustum moves.

/** The nearest the eye may come to the window, in metres: the frustum degenerates as z goes to 0. */
export const MIN_EYE_Z = 0.12;

/**
 * The frustum for an eye at (x, y, z) metres in front of a window `halfW` x `halfH` metres either side of the
 * origin, as the bounds of the near plane: { left, right, top, bottom, near, far }. Things in front of the
 * window (z > 0) are drawn too, down to `near` metres from the eye, so an object can stand out of the screen.
 */
export function windowFrustum(eye, halfW, halfH, near = 0.02, far = 50) {
  const z = Math.max(eye.z, MIN_EYE_Z);
  const k = near / z; // similar triangles: the window's edges, scaled back to the near plane
  return {
    left: (-halfW - eye.x) * k,
    right: (halfW - eye.x) * k,
    bottom: (-halfH - eye.y) * k,
    top: (halfH - eye.y) * k,
    near,
    far,
  };
}

/**
 * Where a world point lands on the screen for that eye and frustum, in normalised device coordinates
 * (x and y from -1 at the left/bottom edge to +1 at the right/top). For tests and for hit-testing.
 */
export function projectToNdc(point, eye, f) {
  const z = Math.max(eye.z, MIN_EYE_Z);
  const dx = point.x - eye.x, dy = point.y - eye.y, depth = z - point.z; // depth in front of the eye
  if (!(depth > 0)) return null;
  const xn = dx * f.near / depth, yn = dy * f.near / depth; // onto the near plane
  return {
    x: (2 * xn - (f.right + f.left)) / (f.right - f.left),
    y: (2 * yn - (f.top + f.bottom)) / (f.top - f.bottom),
  };
}
