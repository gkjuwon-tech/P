"""Chroma-key a green-screen frame sequence -> RGBA PNGs (despilled, watermark removed)."""
import cv2, numpy as np, glob, os, sys

WM_BOX = (1115, 555, 1215, 650)  # x0,y0,x1,y1 - Flow/Gemini sparkle watermark (static, bottom-right)

def key_frame(bgr):
    im = bgr.astype(np.float32)
    b, g, r = im[..., 0], im[..., 1], im[..., 2]
    # background reference from the frame border
    border = np.concatenate([im[:8].reshape(-1, 3), im[-8:].reshape(-1, 3), im[:, :8].reshape(-1, 3)])
    bgc = np.median(border, 0)
    bg_green = bgc[1] - max(bgc[0], bgc[2])
    greenness = g - np.maximum(r, b)
    t0, t1 = 0.18 * bg_green, 0.75 * bg_green
    alpha = 1.0 - np.clip((greenness - t0) / (t1 - t0), 0, 1)
    # watermark: always background
    x0, y0, x1, y1 = WM_BOX
    alpha[y0:y1, x0:x1] = 0
    # drop specks: keep components that are big
    m = (alpha > 0.5).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    keep = np.zeros(n, bool); keep[1:] = stats[1:, cv2.CC_STAT_AREA] > 3000  # figure only; drops logo sparkles (~1k px)
    solid = keep[lab]
    near = cv2.dilate(solid.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
    alpha = np.where(near, alpha, 0)
    # fill pin-holes inside the body, then a light 1px choke + soften
    alpha = cv2.morphologyEx(alpha, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    alpha = cv2.erode(alpha, np.ones((2, 2), np.uint8))
    alpha = cv2.GaussianBlur(alpha, (3, 3), 0.6)
    # un-mix background from edge pixels, then despill
    a3 = np.maximum(alpha, 1e-3)[..., None]
    fg = (im - (1 - alpha[..., None]) * bgc) / a3
    fg = np.where(alpha[..., None] > 0.02, fg, 0)
    fb, fgg, fr = fg[..., 0], fg[..., 1], fg[..., 2]
    fg[..., 1] = np.minimum(fgg, np.maximum(fr, fb) * 1.02 + 2)  # kill green spill
    # edge pixels: fade toward neutral grey to remove any remaining colour fringe
    lum = (0.114 * fg[..., 0] + 0.587 * fg[..., 1] + 0.299 * fg[..., 2])[..., None]
    w = (alpha ** 2)[..., None]
    fg = lum + (fg - lum) * w
    fg = np.clip(fg, 0, 255)
    rgba = np.dstack([fg, alpha * 255]).astype(np.uint8)
    return rgba

def clean_green(bgr, alpha):
    """Original frame, but everything away from the figure repainted flat green (removes any logo)."""
    border = np.concatenate([bgr[:8].reshape(-1, 3), bgr[-8:].reshape(-1, 3), bgr[:, :8].reshape(-1, 3)])
    bgc = np.median(border, 0)
    near = cv2.dilate((alpha > 0).astype(np.uint8), np.ones((9, 9), np.uint8)).astype(np.float32)
    near = cv2.GaussianBlur(near, (9, 9), 3)[..., None]
    return (bgr * near + bgc * (1 - near)).astype(np.uint8)

if __name__ == '__main__':
    src, dst, greendst = sys.argv[1:4]
    os.makedirs(dst, exist_ok=True); os.makedirs(greendst, exist_ok=True)
    for f in sorted(glob.glob(f'{src}/*.png')):
        bgr = cv2.imread(f)
        rgba = key_frame(bgr)
        cv2.imwrite(os.path.join(dst, os.path.basename(f)), rgba)
        cv2.imwrite(os.path.join(greendst, os.path.basename(f)), clean_green(bgr, rgba[..., 3]))
