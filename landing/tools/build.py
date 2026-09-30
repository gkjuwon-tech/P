"""Apply timing edits (seamless loop / ease-out + hold) and export web assets.

Per clip writes to OUT/<name>/:
  <name>.webm            VP9 + alpha            (Chrome/Edge/Firefox, DOM <video>)
  <name>_stacked.mp4     H.264, colour over alpha (all browsers, WebGL)
  <name>_packed.mp4      H.264, colour / alpha / depth rows (WebGL particles)
  <name>_depth.mp4       H.264, depth only (white = near)
  <name>_poster.webp     first frame, RGBA
  <name>_master_green.mp4  full-frame 1280x720 on clean green, watermark removed, edits applied
"""
import cv2, numpy as np, os, subprocess, sys, tempfile, json

S = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1]
FPS = 24
CLIPS = {
    # src, web name, timing edit
    'rotB': dict(name='hero-turntable', loop=(211, 12)),
    'rotA': dict(name='hero-clay-turntable', loop=(222, 12)),
    'grip': dict(name='hero-rig-grip', hold=dict(ease_from=228, ease_frames=24, hold_frames=24)),
}

def load(kind, clip, i):
    p = f'{S}/{kind}/{clip}/{i + 1:04d}.png'
    im = cv2.imread(p, cv2.IMREAD_UNCHANGED).astype(np.float32)
    if kind == 'depth':
        im = im / 65535.0 * 255.0
    return im

def timeline(cfg, n):
    """List of (i0, i1, w) -> frame = lerp(src[i0], src[i1], w)."""
    if 'loop' in cfg:
        L, N = cfg['loop']
        assert L + N <= n
        tl = []
        for i in range(L):
            if i < N:  # crossfade the loop seam: head blends in from the frames after L
                tl.append((L + i, i, i / N))
            else:
                tl.append((i, i, 0.0))
        return tl
    h = cfg['hold']
    s = h['ease_from']; last = n - 1
    tl = [(i, i, 0.0) for i in range(s)]
    for j in range(h['ease_frames']):  # ease-out: remaining motion slowed to a stop
        u = (j + 1) / h['ease_frames']
        t = s + (last - s) * (1 - (1 - u) ** 2)
        i0 = int(np.floor(t)); i1 = min(i0 + 1, last)
        tl.append((i0, i1, t - i0))
    tl += [(last, last, 0.0)] * h['hold_frames']
    return tl

def ffmpeg(args):
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y'] + args, check=True)

for clip, cfg in CLIPS.items():
    name = cfg['name']; d = os.path.join(OUT, name); os.makedirs(d, exist_ok=True)
    n = len(os.listdir(f'{S}/rgba/{clip}'))
    tl = timeline(cfg, n)
    cache = {}
    def get(kind, i):
        k = (kind, i)
        if k not in cache:
            cache[k] = load(kind, clip, i)
        return cache[k]
    def frame(kind, i0, i1, w):
        a = get(kind, i0)
        return a if w == 0 else a * (1 - w) + get(kind, i1) * w

    # fixed crop, horizontally centred on the frame, full height (keeps every clip aligned)
    xs = []
    for i in range(0, n, 4):
        al = get('rgba', i)[..., 3]; c = np.where(al.max(0) > 2)[0]; xs += [c.min(), c.max()]
    W = 1280; half = max(640 - min(xs), max(xs) - 640) + 32
    half = int(np.ceil(half / 16) * 16)
    cx0, cx1 = 640 - half, 640 + half
    cw = cx1 - cx0

    tmp = tempfile.mkdtemp(dir=S)
    for k, (i0, i1, w) in enumerate(tl):
        rgba = frame('rgba', i0, i1, w)
        dep = frame('depth', i0, i1, w)
        green = frame('green', i0, i1, w)
        rgba_c = rgba[:, cx0:cx1]
        a = rgba_c[..., 3:4] / 255.0
        col = rgba_c[..., :3] * a  # premultiplied (black outside) - clean edges when sampling in shaders
        alpha3 = np.repeat(rgba_c[..., 3:4], 3, 2)
        dep3 = np.repeat(dep[:, cx0:cx1, None], 3, 2)
        cv2.imwrite(f'{tmp}/rgba_{k:04d}.png', np.clip(rgba_c, 0, 255).astype(np.uint8))
        cv2.imwrite(f'{tmp}/stk_{k:04d}.png', np.clip(np.vstack([col, alpha3]), 0, 255).astype(np.uint8))
        cv2.imwrite(f'{tmp}/pck_{k:04d}.png', np.clip(np.vstack([col, alpha3, dep3]), 0, 255).astype(np.uint8))
        cv2.imwrite(f'{tmp}/dep_{k:04d}.png', np.clip(dep3, 0, 255).astype(np.uint8))
        cv2.imwrite(f'{tmp}/grn_{k:04d}.png', np.clip(green, 0, 255).astype(np.uint8))
        for key in [kk for kk in cache if kk[1] < i0 - 2]:
            del cache[key]

    x264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'slow', '-movflags', '+faststart',
            '-bf', '0', '-g', '12']  # short GOP: cheap seeking for scroll-scrubbing
    inp = lambda p: ['-framerate', str(FPS), '-i', f'{tmp}/{p}_%04d.png']
    ffmpeg(inp('rgba') + ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30',
                          '-row-mt', '1', '-g', '12', '-auto-alt-ref', '0', f'{d}/{name}.webm'])
    ffmpeg(inp('stk') + x264 + ['-crf', '18', f'{d}/{name}_stacked.mp4'])
    ffmpeg(inp('pck') + x264 + ['-crf', '18', f'{d}/{name}_packed.mp4'])
    ffmpeg(inp('dep') + x264 + ['-crf', '20', f'{d}/{name}_depth.mp4'])
    ffmpeg(inp('grn') + ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'slow', '-crf', '14',
                         '-movflags', '+faststart', f'{d}/{name}_master_green.mp4'])
    ffmpeg(['-i', f'{tmp}/rgba_0000.png', '-c:v', 'libwebp', '-lossless', '0', '-quality', '90', f'{d}/{name}_poster.webp'])
    meta = dict(name=name, fps=FPS, frames=len(tl), duration=round(len(tl) / FPS, 3),
                width=cw, height=720, crop_x_in_source=[int(cx0), int(cx1)], source_frame=[1280, 720],
                loop=('loop' in cfg), stacked_layout='rows: [colour(premultiplied), alpha]',
                packed_layout='rows: [colour(premultiplied), alpha, depth(white=near)]')
    json.dump(meta, open(f'{d}/{name}.json', 'w'), indent=2)
    subprocess.run(['rm', '-rf', tmp])
    print(name, meta['frames'], 'frames', cw, 'px wide', flush=True)
