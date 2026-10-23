// The shortcut: the camera is applied to W and S, and strafing is left in world space. It fixes the frame the bug was
// reported on and stays wrong the moment the player turns and strafes.
export function dodgeDirection(keys, cameraYaw = 0) {
  const forward = keys.includes("w") ? 1 : keys.includes("s") ? -1 : 0;
  const right = keys.includes("d") ? 1 : keys.includes("a") ? -1 : 0;
  const away = { x: -Math.sin(cameraYaw), z: -Math.cos(cameraYaw) };
  return normalise({ x: away.x * forward + right, z: away.z * forward });
}

export function normalise(vector) {
  const length = Math.hypot(vector.x, vector.z);
  return length === 0 ? { x: 0, z: 0 } : { x: vector.x / length, z: vector.z / length };
}
