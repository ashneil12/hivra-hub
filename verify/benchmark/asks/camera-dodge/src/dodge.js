// Which way a dodge goes. `keys` holds the lowercase movement keys held this frame; `cameraYaw` is how far the camera
// has turned, in radians, clockwise from looking down -Z, so at 0 the camera looks toward -Z and its right is +X.
// The result is a unit vector in world space.
export function dodgeDirection(keys, cameraYaw = 0) {
  const forward = keys.includes("w") ? -1 : keys.includes("s") ? 1 : 0;
  const right = keys.includes("d") ? 1 : keys.includes("a") ? -1 : 0;
  return normalise({ x: right, z: forward });
}

export function normalise(vector) {
  const length = Math.hypot(vector.x, vector.z);
  return length === 0 ? { x: 0, z: 0 } : { x: vector.x / length, z: vector.z / length };
}
