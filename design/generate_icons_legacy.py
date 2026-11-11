"""Generate DeepMeta Never Sleep extension icons — 3 states x 3 sizes."""
import math
import os
from PIL import Image, ImageDraw

SIZES = [16, 48, 128]

STATES = {
    'idle':   '#9E9E9E',
    'active': '#2D7A0A',
    'error':  '#E53935',
}


def hex_to_rgba(h, a=255):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4)) + (a,)


def draw_clock(draw, cx, cy, r, fg, bg):
    """Solid alarm clock: bells → body ring → face → details."""
    lw = max(1, round(r * 0.07))

    # ── Bell ears ──────────────────────────────────────────────────
    # Large filled half-circles at top-left and top-right.
    # Drawn first so clock body overlaps their inner edge cleanly.
    bell_r   = r * 0.42
    bell_ox  = r * 0.68
    bell_oy  = r * 0.52
    for sign in (-1, 1):
        bx = cx + sign * bell_ox
        by = cy - bell_oy
        draw.ellipse([bx - bell_r, by - bell_r,
                      bx + bell_r, by + bell_r], fill=fg)

    # ── Top stem / button ──────────────────────────────────────────
    sw = max(1, round(r * 0.11))
    sh = round(r * 0.22)
    draw.rounded_rectangle(
        [cx - sw, cy - r - sh, cx + sw, cy - r + round(r * 0.05)],
        radius=sw, fill=fg
    )

    # ── Clock body (thick outer ring = filled circle) ──────────────
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fg)

    # ── Clock face (hollow interior) ──────────────────────────────
    ir = r * 0.76
    draw.ellipse([cx - ir, cy - ir, cx + ir, cy + ir], fill=bg)

    # ── Tick marks at 12 / 3 / 6 / 9 ─────────────────────────────
    tick_outer = ir * 0.94
    tick_inner = ir * 0.76
    tick_w = max(1, round(r * 0.07))
    for deg in (0, 90, 180, 270):
        a = math.radians(deg - 90)
        draw.line([
            cx + tick_inner * math.cos(a), cy + tick_inner * math.sin(a),
            cx + tick_outer * math.cos(a), cy + tick_outer * math.sin(a),
        ], fill=fg, width=tick_w)

    # ── Hands ──────────────────────────────────────────────────────
    hand_w = max(1, round(r * 0.09))
    # Hour hand → ~10 o'clock
    ha = math.radians(-120)
    draw.line([cx, cy,
               cx + ir * 0.48 * math.cos(ha),
               cy + ir * 0.48 * math.sin(ha)],
              fill=fg, width=hand_w)
    # Minute hand → ~2 o'clock
    ma = math.radians(60)
    draw.line([cx, cy,
               cx + ir * 0.62 * math.cos(ma),
               cy + ir * 0.62 * math.sin(ma)],
              fill=fg, width=max(1, round(hand_w * 0.75)))

    # ── Centre dot ────────────────────────────────────────────────
    dr = max(1, round(r * 0.09))
    draw.ellipse([cx - dr, cy - dr, cx + dr, cy + dr], fill=fg)

    # ── Feet (two small rounded bumps at bottom) ───────────────────
    fr = max(1, round(r * 0.13))
    fy = cy + r
    for fx in (cx - r * 0.38, cx + r * 0.38):
        draw.ellipse([fx - fr, fy - fr * 0.6,
                      fx + fr, fy + fr * 1.1], fill=fg)


def make_icon(size, bg_hex):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    pad = max(1, size // 14)
    corner = size // 5
    bg_rgba = hex_to_rgba(bg_hex)
    draw.rounded_rectangle(
        [pad, pad, size - pad - 1, size - pad - 1],
        radius=corner, fill=bg_rgba
    )

    cx = cy = size / 2
    r = size * 0.30

    draw_clock(draw, cx, cy, r, fg=(255, 255, 255, 255), bg=bg_rgba)

    return img


os.makedirs('icons', exist_ok=True)

for state, color in STATES.items():
    for size in SIZES:
        img = make_icon(size, color)
        path = f'icons/icon-{state}-{size}.png'
        img.save(path)
        print(f'  {path}')

print('Done.')
