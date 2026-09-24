#!/usr/bin/env python3
"""Regenerate every cli-jaw brand asset from the mascot master.

Maintainer tool, not part of the build. Requires Pillow; icon.icns also needs macOS iconutil.
Usage: python3 scripts/brand/generate-brand-assets.py [--skip-icns] [--og-card]
--og-card recomposes docs/assets/og-card.jpg in place, so run it only against the original card.
"""
import math
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
MASTER = os.path.join(ROOT, 'scripts', 'brand', 'mascot-master.png')
PLATE_TOP = (22, 36, 58, 255)
PLATE_BOTTOM = (11, 18, 32, 255)
CYAN = (31, 213, 243)


def path(*parts):
    return os.path.join(ROOT, *parts)


def load_master():
    im = Image.open(MASTER).convert('RGBA')
    return im.crop(im.getchannel('A').getbbox())


def fit(im, width):
    return im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)


def rounded_mask(size, box, radius, scale=4):
    big = Image.new('L', (size * scale, size * scale), 0)
    ImageDraw.Draw(big).rounded_rectangle([c * scale for c in box], radius=radius * scale, fill=255)
    return big.resize((size, size), Image.LANCZOS)


def gradient(size, top, bottom):
    g = Image.new('RGBA', (size, size))
    d = ImageDraw.Draw(g)
    for y in range(size):
        t = y / max(1, size - 1)
        d.line([(0, y), (size, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    return g


def glow(canvas_size, center, radius, strength=60):
    g = Image.new('RGBA', canvas_size, (0, 0, 0, 0))
    ImageDraw.Draw(g).ellipse([center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius],
                              fill=CYAN + (strength,))
    return g.filter(ImageFilter.GaussianBlur(radius * 0.45))


def place_mascot(canvas, mascot, width, center, shadow=True):
    m = fit(mascot, width)
    x = round(center[0] - m.width / 2)
    y = round(center[1] - m.height / 2)
    if shadow:
        sh = Image.new('RGBA', m.size, (0, 0, 0, 255))
        sh.putalpha(m.getchannel('A').point(lambda v: v * 0.35))
        layer = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
        layer.alpha_composite(sh, (x, y + round(width * 0.025)))
        canvas.alpha_composite(layer.filter(ImageFilter.GaussianBlur(width * 0.02)))
    canvas.alpha_composite(m, (x, y))
    return canvas


def app_icon(mascot, size=1024):
    """macOS-grid app icon: 824/1024 rounded plate, mascot about 76% of the plate width."""
    s = size / 1024
    plate_box = (100 * s, 100 * s, 924 * s, 924 * s)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    sh = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((plate_box[0], plate_box[1] + 10 * s, plate_box[2], plate_box[3] + 10 * s),
                                         radius=185 * s, fill=(0, 0, 0, 90))
    canvas.alpha_composite(sh.filter(ImageFilter.GaussianBlur(14 * s)))
    plate = gradient(size, PLATE_TOP, PLATE_BOTTOM)
    plate.alpha_composite(glow((size, size), (size / 2, size * 0.47), 300 * s, strength=55))
    plate.putalpha(rounded_mask(size, plate_box, 185 * s))
    canvas.alpha_composite(plate)
    return place_mascot(canvas, mascot, round(626 * s), (size / 2, size * 0.515))


def maskable_icon(mascot, size=512):
    """Full-bleed plate; the mascot stays inside the central safe zone."""
    canvas = gradient(size, PLATE_TOP, PLATE_BOTTOM)
    canvas.alpha_composite(glow((size, size), (size / 2, size / 2), size * 0.3, strength=55))
    return place_mascot(canvas, mascot, round(size * 0.62), (size / 2, size * 0.52))


def transparent_mark(mascot, size, pad=0.04):
    inner = round(size * (1 - 2 * pad))
    m = fit(mascot, inner)
    if m.height > inner:
        m = m.resize((round(m.width * inner / m.height), inner), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(m, ((size - m.width) // 2, (size - m.height) // 2))
    return canvas


# Menu bar template glyph on an 18-unit grid. macOS template images use alpha only.
TRAY_SHAPES = {
    'body': ('ellipse', (3, 4, 15, 16.8)),
    'fin': ('polygon', [(6.4, 5.2), (9, 0.4), (11.6, 5.2)]),
    'fin_l': ('polygon', [(3.6, 10.8), (0.2, 14.2), (3.8, 15)]),
    'fin_r': ('polygon', [(14.4, 10.8), (17.8, 14.2), (14.2, 15)]),
}
TRAY_HOLES = {
    'eye_l': ('ellipse', (6, 7.9, 8, 9.9)),
    'eye_r': ('ellipse', (10, 7.9, 12, 9.9)),
    'smile': ('chord', (5.6, 9.6, 12.4, 15.2), 0, 180),
}


def tray_template(px, oversample=16):
    unit = px * oversample / 18
    big = Image.new('L', (px * oversample, px * oversample), 0)
    d = ImageDraw.Draw(big)

    def draw(spec, fill):
        kind = spec[0]
        if kind == 'polygon':
            d.polygon([(x * unit, y * unit) for x, y in spec[1]], fill=fill)
        elif kind == 'ellipse':
            d.ellipse([v * unit for v in spec[1]], fill=fill)
        else:
            d.chord([v * unit for v in spec[1]], spec[2], spec[3], fill=fill)

    for spec in TRAY_SHAPES.values():
        draw(spec, 255)
    for spec in TRAY_HOLES.values():
        draw(spec, 0)
    out = Image.new('RGBA', (px, px), (0, 0, 0, 255))
    out.putalpha(big.resize((px, px), Image.LANCZOS))
    return out


def tray_svg():
    def el(spec, fill):
        kind = spec[0]
        if kind == 'polygon':
            pts = ' '.join(f'{x:g},{y:g}' for x, y in spec[1])
            return f'<polygon points="{pts}" fill="{fill}"/>'
        x0, y0, x1, y1 = spec[1]
        cx, cy, rx, ry = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2
        if kind == 'ellipse':
            return f'<ellipse cx="{cx:g}" cy="{cy:g}" rx="{rx:g}" ry="{ry:g}" fill="{fill}"/>'
        return f'<path d="M{x0:g},{cy:g} A{rx:g},{ry:g} 0 0 0 {x1:g},{cy:g} Z" fill="{fill}"/>'

    body = '\n    '.join(el(s, '#fff') for s in TRAY_SHAPES.values())
    holes = '\n    '.join(el(s, '#000') for s in TRAY_HOLES.values())
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18">\n'
            '  <!-- Source for trayTemplate.png; generated by scripts/brand/generate-brand-assets.py -->\n'
            '  <mask id="m">\n    ' + body + '\n    ' + holes + '\n  </mask>\n'
            '  <rect width="18" height="18" fill="#000" mask="url(#m)"/>\n</svg>\n')


def runner_sprite(mascot, frames=10, fw=47, fh=32):
    """Ten-frame mascot swim cycle; geometry matches .shark-runner in public/css/orc-state.css."""
    scale = 4
    strip = Image.new('RGBA', (fw * frames, fh), (0, 0, 0, 0))
    base = fit(mascot, 25 * scale)
    for i in range(frames):
        t = i / frames * 2 * math.pi
        m = base.rotate(math.sin(t) * 7, resample=Image.BICUBIC, expand=True)
        frame = Image.new('RGBA', (fw * scale, fh * scale), (0, 0, 0, 0))
        y = (fh * scale - m.height) / 2 + math.cos(t) * 1.6 * scale
        frame.alpha_composite(m, (round((fw * scale - m.width) / 2), round(y)))
        strip.alpha_composite(frame.resize((fw, fh), Image.LANCZOS), (i * fw, 0))
    return strip


def og_card(mascot):
    card = Image.open(path('docs', 'assets', 'og-card.jpg')).convert('RGBA')
    center = (930, 300)
    card.alpha_composite(glow(card.size, center, 220))
    place_mascot(card, mascot, 330, center)
    return card.convert('RGB')


def write_icns(icon1024, out_path):
    if shutil.which('iconutil') is None:
        print('skip icon.icns: iconutil not found (macOS only)')
        return
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, 'icon.iconset')
        os.mkdir(iconset)
        for pt in (16, 32, 128, 256, 512):
            icon1024.resize((pt, pt), Image.LANCZOS).save(os.path.join(iconset, f'icon_{pt}x{pt}.png'))
            icon1024.resize((pt * 2, pt * 2), Image.LANCZOS).save(os.path.join(iconset, f'icon_{pt}x{pt}@2x.png'))
        subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', out_path], check=True)


def main():
    mascot = load_master()
    icon = app_icon(mascot)
    icon.save(path('electron', 'build', 'icon.png'), optimize=True)
    if '--skip-icns' not in sys.argv:
        write_icns(icon, path('electron', 'build', 'icon.icns'))
    tray_template(18).save(path('electron', 'build', 'trayTemplate.png'))
    tray_template(36).save(path('electron', 'build', 'trayTemplate@2x.png'))
    with open(path('electron', 'build', 'tray-mascot.svg'), 'w', encoding='utf-8') as fh:
        fh.write(tray_svg())

    icon.resize((192, 192), Image.LANCZOS).save(path('public', 'icons', 'icon-192.png'), optimize=True)
    icon.resize((512, 512), Image.LANCZOS).save(path('public', 'icons', 'icon-512.png'), optimize=True)
    maskable_icon(mascot).save(path('public', 'icons', 'icon-512-maskable.png'), optimize=True)
    transparent_mark(mascot, 32, pad=0.02).save(path('public', 'icons', 'favicon-32.png'), optimize=True)
    transparent_mark(mascot, 256).save(path('public', 'icons', 'mascot.png'), optimize=True)
    runner_sprite(mascot).save(path('public', 'img', 'shark-sprite.png'), optimize=True)

    icon.resize((512, 512), Image.LANCZOS).save(path('docs', 'assets', 'app-icon.png'), optimize=True)
    transparent_mark(mascot, 256).save(path('docs', 'assets', 'mascot.png'), optimize=True)
    if '--og-card' in sys.argv:
        og_card(mascot).save(path('docs', 'assets', 'og-card.jpg'), quality=90, optimize=True)
    print('brand assets regenerated')


if __name__ == '__main__':
    main()
