#!/usr/bin/env python3
"""
Gera todos os arquivos de ícones/miniaturas do app a partir:
  - das exportações PNG do Figma (design/figma-export/*.png)
  - da fonte vetorial design/icons.js (SVG dos ícones de categoria e vetores Android)

Uso: python3 design/build_assets.py
"""
import json
import os
import subprocess
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORT = os.path.join(ROOT, 'design', 'figma-export')
ASSETS = os.path.join(ROOT, 'assets')
RES = os.path.join(ROOT, 'android-app', 'app', 'src', 'main', 'res')
KEYS = ['alongamentos', 'manicure', 'blindagem', 'nailart', 'spa', 'geral']


def save_png(img, path, size):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.resize((size, size), Image.LANCZOS).save(path, optimize=True)


def round_mask(img, size):
    small = img.resize((size, size), Image.LANCZOS).convert('RGBA')
    big = size * 4
    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, big - 1, big - 1), fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(small, (0, 0), mask)
    return out


def main():
    app = Image.open(os.path.join(EXPORT, 'app-icon.png')).convert('RGBA')

    # Web / PWA
    save_png(app, os.path.join(ROOT, 'icon-512.png'), 512)
    save_png(app, os.path.join(ROOT, 'icon-192.png'), 192)
    save_png(app, os.path.join(ASSETS, 'icons', 'apple-touch-icon.png'), 180)
    save_png(app, os.path.join(ASSETS, 'icons', 'favicon-64.png'), 64)

    # Android (ícones legados para Android < 8)
    for folder, size in {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}.items():
        d = os.path.join(RES, 'mipmap-' + folder)
        save_png(app, os.path.join(d, 'ic_launcher.png'), size)
        round_mask(app, size).save(os.path.join(d, 'ic_launcher_round.png'), optimize=True)

    # Miniaturas de serviço (JPEG leve, 480 px)
    for k in KEYS:
        im = Image.open(os.path.join(EXPORT, f'thumb-{k}.png')).convert('RGB')
        os.makedirs(os.path.join(ASSETS, 'thumbs'), exist_ok=True)
        im.resize((480, 480), Image.LANCZOS).save(os.path.join(ASSETS, 'thumbs', f'{k}.jpg'), quality=86, optimize=True, progressive=True)

    # Ícones de categoria (SVG, mesma fonte usada no Figma)
    data = json.loads(subprocess.check_output(['node', os.path.join(ROOT, 'design', 'icons.js')]))
    os.makedirs(os.path.join(ASSETS, 'icons'), exist_ok=True)
    for k, svg in data['tiles'].items():
        with open(os.path.join(ASSETS, 'icons', f'cat-{k}.svg'), 'w', encoding='utf-8') as f:
            f.write(svg.replace('\n', '') + '\n')

    write_android_vectors()
    print('✅ Assets gerados em assets/, raiz (icon-*.png) e android-app/res/')


# ----------------------------------------------------------------- Android vetores
S = 72 / 1024  # o ícone 1024 vira 72dp no centro da tela adaptativa de 108dp
T = 18


def rr(x, y, w, h, r):
    r = min(r, w / 2, h / 2)
    return (f'M{x + r},{y}h{w - 2 * r}a{r},{r} 0 0 1 {r},{r}v{h - 2 * r}a{r},{r} 0 0 1 -{r},{r}'
            f'h-{w - 2 * r}a{r},{r} 0 0 1 -{r},-{r}v-{h - 2 * r}a{r},{r} 0 0 1 {r},-{r}z')


def circle(cx, cy, r):
    return f'M{cx - r},{cy}a{r},{r} 0 1 0 {2 * r},0a{r},{r} 0 1 0 -{2 * r},0z'


def ellipse(cx, cy, rx, ry):
    return f'M{cx - rx},{cy}a{rx},{ry} 0 1 0 {2 * rx},0a{rx},{ry} 0 1 0 -{2 * rx},0z'


def star(cx, cy, r, k=0.16):
    f = lambda n: round(n, 2)
    return (f'M{f(cx)},{f(cy - r)}Q{f(cx + k * r)},{f(cy - k * r)} {f(cx + r)},{f(cy)}'
            f'Q{f(cx + k * r)},{f(cy + k * r)} {f(cx)},{f(cy + r)}Q{f(cx - k * r)},{f(cy + k * r)} {f(cx - r)},{f(cy)}'
            f'Q{f(cx - k * r)},{f(cy - k * r)} {f(cx)},{f(cy - r)}z')


def grad(x1, y1, x2, y2, stops):
    items = ''.join(f'<item android:color="{c}" android:offset="{o}"/>' for o, c in stops)
    return (f'<aapt:attr name="android:fillColor"><gradient android:type="linear" android:startX="{x1}" '
            f'android:startY="{y1}" android:endX="{x2}" android:endY="{y2}">{items}</gradient></aapt:attr>')


def path(d, fill=None, gradient=None):
    if gradient:
        return f'<path android:pathData="{d}">{gradient}</path>'
    return f'<path android:fillColor="{fill}" android:pathData="{d}"/>'


def vector(body, transformed=True):
    inner = (f'<group android:scaleX="{S}" android:scaleY="{S}" android:translateX="{T}" android:translateY="{T}">{body}</group>'
             if transformed else body)
    return ('<?xml version="1.0" encoding="utf-8"?>\n<!-- Gerado por design/build_assets.py a partir de design/icons.js (Figma: Nail Studio Pro — Ícones e Miniaturas) -->\n'
            '<vector xmlns:android="http://schemas.android.com/apk/res/android" xmlns:aapt="http://schemas.android.com/aapt" '
            'android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">'
            f'{inner}</vector>\n')


def write_android_vectors():
    bg = vector(
        path('M0,0h108v108h-108z', gradient=grad(0, 0, 108, 108, [(0, '#FFFF1675'), (0.55, '#FFFF5C97'), (1, '#FFF59E0B')])) +
        path(circle(91.7, 16.9, 28.5), '#1AFFFFFF') + path(circle(11.6, 99.1, 32.7), '#14FFFFFF'),
        transformed=False)
    fg_body = ''.join([
        path(ellipse(512, 826, 214, 30), '#29240C18'),
        path(rr(440, 196, 144, 236, 44), gradient=grad(440, 196, 584, 432, [(0, '#FF5A1238'), (1, '#FF240C18')])),
        path(rr(463, 224, 22, 168, 11), '#38FFFFFF'),
        path(rr(414, 420, 196, 64, 20), '#FFFFFFFF'),
        path(rr(322, 468, 380, 342, 106), '#FFFFFFFF'),
        path(rr(356, 540, 312, 236, 82), gradient=grad(356, 540, 668, 776, [(0, '#FFFF1675'), (1, '#FFB8004B')])),
        path(rr(390, 566, 32, 124, 16), '#80FFFFFF'),
        path(star(748, 300, 92), '#FFFFFFFF'),
        path(star(276, 330, 48), '#EBFFFFFF'),
        path(circle(790, 470, 14), '#D9FFFFFF'),
    ])
    mono_body = ''.join([
        path(rr(440, 196, 144, 236, 44), '#FFFFFFFF'),
        path(rr(414, 420, 196, 64, 20), '#FFFFFFFF'),
        path(rr(322, 468, 380, 342, 106), '#FFFFFFFF'),
        path(star(748, 300, 92), '#FFFFFFFF'),
        path(star(276, 330, 48), '#FFFFFFFF'),
    ])
    d = os.path.join(RES, 'drawable')
    for name, content in {'ic_launcher_background.xml': bg, 'ic_launcher_foreground.xml': vector(fg_body),
                          'ic_launcher_monochrome.xml': vector(mono_body)}.items():
        with open(os.path.join(d, name), 'w', encoding='utf-8') as f:
            f.write(content)
    adaptive = ('<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
                '    <background android:drawable="@drawable/ic_launcher_background" />\n'
                '    <foreground android:drawable="@drawable/ic_launcher_foreground" />\n'
                '    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />\n</adaptive-icon>\n')
    for n in ['ic_launcher.xml', 'ic_launcher_round.xml']:
        with open(os.path.join(RES, 'mipmap-anydpi-v26', n), 'w', encoding='utf-8') as f:
            f.write(adaptive)


if __name__ == '__main__':
    main()
