"""One-shot: replace inherited mobile glyphs with a placeholder H, same pixel sizes."""
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "assets"


def read_ihdr(path: Path):
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"not a png: {path}")
    tag = data[12:16]
    if tag != b"IHDR":
        raise SystemExit(f"no ihdr: {path}")
    w, h, _bit, color = struct.unpack(">IIBB", data[16:26])
    return w, h, color


def chunk(tag: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + tag
        + payload
        + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )


def write_png(path: Path, w: int, h: int, samples: bytes, color: int) -> None:
    channels = 4 if color == 6 else 3
    ihdr = struct.pack(">IIBBBBB", w, h, 8, color, 0, 0, 0)
    raw = b"".join(
        b"\x00" + samples[y * w * channels : (y + 1) * w * channels] for y in range(h)
    )
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def h_mask(w: int, h: int, inset: float):
    left = int(w * inset)
    right = w - left
    top = int(h * inset)
    bottom = h - top
    stroke = max(1, int(round(min(w, h) * 0.16)))
    if right - left <= stroke * 2:
        stroke = max(1, (right - left) // 3)
    mid0 = (h - stroke) // 2
    mid1 = mid0 + stroke
    mask = [0] * (w * h)
    for y in range(max(0, top), min(h, bottom)):
        for x in range(max(0, left), min(w, left + stroke)):
            mask[y * w + x] = 1
        for x in range(max(0, right - stroke), min(w, right)):
            mask[y * w + x] = 1
    for y in range(max(0, mid0), min(h, mid1)):
        for x in range(max(0, left), min(w, right)):
            mask[y * w + x] = 1
    return mask


def paint(w, h, mask, on, off, channels) -> bytes:
    out = bytearray(w * h * channels)
    for i, bit in enumerate(mask):
        pixel = on if bit else off
        out[i * channels : (i + 1) * channels] = bytes(pixel)
    return bytes(out)


WHITE = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)
WHITE_RGB = (255, 255, 255)
BLACK_RGB = (0, 0, 0)


def replace(rel: str, kind: str) -> None:
    path = ROOT / rel
    w, h, color = read_ihdr(path)
    print(f"{rel}: {w}x{h} color={color} -> {kind}")
    if kind == "app":
        mask = h_mask(w, h, 0.22)
        write_png(path, w, h, paint(w, h, mask, WHITE_RGB, BLACK_RGB, 3), 2)
    elif kind == "mark":
        mask = h_mask(w, h, 0.18)
        write_png(path, w, h, paint(w, h, mask, WHITE, CLEAR, 4), 6)
    elif kind == "mark-black":
        mask = h_mask(w, h, 0.18)
        write_png(path, w, h, paint(w, h, mask, (0, 0, 0, 255), CLEAR, 4), 6)
    elif kind == "inverse":
        mask = h_mask(w, h, 0.18)
        write_png(path, w, h, paint(w, h, mask, CLEAR, WHITE, 4), 6)
    elif kind == "foreground":
        mask = h_mask(w, h, 0.31)
        write_png(path, w, h, paint(w, h, mask, WHITE, CLEAR, 4), 6)
    elif kind == "background":
        mask = [0] * (w * h)
        write_png(path, w, h, paint(w, h, mask, WHITE_RGB, BLACK_RGB, 3), 2)
    else:
        raise SystemExit(kind)


JOBS = [
    ("images/icon.png", "app"),
    ("app.icon/Assets/icon.png", "app"),
    ("images/splash-icon.png", "mark"),
    ("images/favicon.png", "app"),
    ("images/monocode-mark.png", "mark"),
    ("images/monocode-mark-inverse.png", "inverse"),
    ("images/monocode-mark-black.png", "mark-black"),
    ("images/android-icon-foreground.png", "foreground"),
    ("images/android-icon-background.png", "background"),
    ("images/android-icon-monochrome.png", "foreground"),
]

if __name__ == "__main__":
    for rel, kind in JOBS:
        replace(rel, kind)
