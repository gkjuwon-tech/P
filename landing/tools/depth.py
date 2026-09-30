"""Depth Anything V2 on keyed RGBA frames -> 16-bit + 8-bit depth PNGs (white = near, 0 outside the matte)."""
import cv2, numpy as np, glob, os, sys, time, torch
from transformers import AutoModelForDepthEstimation

MODEL = os.environ.get('DA_MODEL', 'depth-anything/Depth-Anything-V2-Base-hf')
torch.set_num_threads(int(os.environ.get('THREADS', '4')))
src, dst = sys.argv[1], sys.argv[2]
limit = int(sys.argv[3]) if len(sys.argv) > 3 else None
os.makedirs(dst, exist_ok=True)
files = sorted(glob.glob(f'{src}/*.png'))[:limit]

# union bbox of the matte over the whole clip -> fixed crop, so the figure fills the model input
x0 = y0 = 10**9; x1 = y1 = 0
for f in files[::6]:
    a = cv2.imread(f, cv2.IMREAD_UNCHANGED)[..., 3]
    ys, xs = np.where(a > 20)
    x0, x1, y0, y1 = min(x0, xs.min()), max(x1, xs.max()), min(y0, ys.min()), max(y1, ys.max())
H, W = a.shape
pad = 24
x0, y0, x1, y1 = max(x0 - pad, 0), max(y0 - pad, 0), min(x1 + pad, W), min(y1 + pad, H)
cw, ch = x1 - x0, y1 - y0
ih = 700 // 14 * 14
iw = max(14, round(cw * ih / ch / 14) * 14)
print('crop', (x0, y0, x1, y1), 'model input', iw, ih, flush=True)

model = AutoModelForDepthEstimation.from_pretrained(MODEL).eval()
mean = np.array([0.485, 0.456, 0.406], np.float32); std = np.array([0.229, 0.224, 0.225], np.float32)
lo_s = hi_s = None
t = time.time()
for i, f in enumerate(files):
    rgba = cv2.imread(f, cv2.IMREAD_UNCHANGED).astype(np.float32) / 255
    a = rgba[..., 3]
    # subject over mid-grey: neutral context for the model
    rgb = rgba[..., 2::-1] * a[..., None] + 0.5 * (1 - a[..., None])
    crop = cv2.resize(rgb[y0:y1, x0:x1], (iw, ih), interpolation=cv2.INTER_AREA)
    x = torch.from_numpy(((crop - mean) / std).transpose(2, 0, 1)[None].copy())
    with torch.no_grad():
        d = model(pixel_values=x).predicted_depth[0].numpy()  # relative disparity, larger = nearer
    d = cv2.resize(d, (cw, ch), interpolation=cv2.INTER_CUBIC)
    m = a[y0:y1, x0:x1] > 0.5
    lo, hi = np.percentile(d[m], [1, 98])
    # smooth the normalisation over time to avoid per-frame pumping
    lo_s = lo if lo_s is None else 0.8 * lo_s + 0.2 * lo
    hi_s = hi if hi_s is None else 0.8 * hi_s + 0.2 * hi
    dn = np.clip((d - lo_s) / max(hi_s - lo_s, 1e-6), 0, 1)
    full = np.zeros((H, W), np.float32)
    full[y0:y1, x0:x1] = dn
    full *= a  # 0 outside the subject, soft at the edge
    name = os.path.basename(f)
    cv2.imwrite(os.path.join(dst, name), (full * 65535).astype(np.uint16))
    if i % 20 == 0:
        print(f'{i}/{len(files)} {(time.time()-t)/(i+1):.2f}s/frame', flush=True)
