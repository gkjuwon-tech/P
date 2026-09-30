"""Image-sequence version of the packed videos, for browsers that will not feed <video> to WebGL
(iOS in Low Power Mode, in-app browsers without inline playback).

  python tools/seq.py assets/video assets/seq

Writes assets/seq/<name>/NNN.jpg (12 fps, 0.8x, packed rows colour/alpha/depth) and a manifest.
"""
import json, os, subprocess, sys, glob

src, dst = sys.argv[1], sys.argv[2]
FPS = 12
SIZES = {'hero-turntable': 232, 'hero-clay-turntable': 232, 'hero-rig-grip': 564}  # 0.8x, even widths
manifest = {'fps': FPS, 'clips': {}}
for name, w in SIZES.items():
    out = os.path.join(dst, name)
    os.makedirs(out, exist_ok=True)
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', os.path.join(src, name, f'{name}_packed.mp4'),
                    '-vf', f'fps={FPS},scale={w}:1728:flags=lanczos', '-q:v', '3', '-start_number', '0',
                    os.path.join(out, '%03d.jpg')], check=True)
    n = len(glob.glob(os.path.join(out, '*.jpg')))
    manifest['clips'][name] = {'frames': n, 'width': w, 'height': 1728}
    print(name, n, 'frames')
json.dump(manifest, open(os.path.join(dst, 'manifest.json'), 'w'), indent=2)
