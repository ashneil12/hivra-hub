// Which way a dodge goes. `keys` holds the lowercase movement keys held this frame; `cameraYaw` is how far the camera
// has turned, in radians, clockwise from looking down -Z, so at 0 the camera looks toward -Z and its right is +X.
// The result is a unit vector in world space.
export function dodgeDirection(keys, cameraYaw = 0) {
  const forward = keys.includes("w") ? 1 : keys.includes("s") ? -1 : 0;
  const right = keys.includes("d") ? 1 : keys.includes("a") ? -1 : 0;
  // Away from the camera and to its right, each turned by the camera; at yaw 0 that is -Z and +X.
  const away = { x: -Math.sin(cameraYaw), z: -Math.cos(cameraYaw) };
  const side = { x: Math.cos(cameraYaw), z: -Math.sin(cameraYaw) };
  return normalise({
    x: away.x * forward + side.x * right,
    z: away.z * forward + side.z * right,
  });
}

export function normalise(vector) {
  const length = Math.hypot(vector.x, vector.z);
  return length === 0 ? { x: 0, z: 0 } : { x: vector.x / length, z: vector.z / length };
}
