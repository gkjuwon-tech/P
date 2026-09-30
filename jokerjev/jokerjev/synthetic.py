"""Synthetic scenes for fixing hyperparameters without touching DiLiGenT."""
import numpy as np
from . import geometry as G
from .physics import light_from


def scene(seed=0, H=256, W=256, spec=0.3):
    rng = np.random.default_rng(seed)
    rr, cc = np.indices((H, W)).astype(float)
    # a lumpy silhouette
    th = np.arctan2(rr - H / 2, cc - W / 2)
    rad = 0.36 * H * (1 + 0.12 * np.sin(3 * th + rng.uniform(0, 6)) + 0.06 * np.sin(5 * th + rng.uniform(0, 6)))
    mask = np.hypot(rr - H / 2, cc - W / 2) < rad
    z = G.inflation(mask) * rng.uniform(0.8, 1.2)
    for _ in range(rng.integers(6, 12)):
        r0, c0 = rng.uniform(0.25, 0.75, 2) * [H, W]
        s = rng.uniform(6, 20)
        amp = rng.choice([-1, 1]) * rng.uniform(0.4, 1.0) * s
        z += amp * np.exp(-((rr - r0) ** 2 + (cc - c0) ** 2) / (2 * s * s)) * mask
    n = G.depth_to_normals(z, mask)
    alb = np.ones((H, W))
    for _ in range(3):
        r0, c0 = rng.uniform(0.2, 0.8, 2) * [H, W]
        alb[np.hypot(rr - r0, cc - c0) < rng.uniform(15, 40)] = rng.uniform(0.4, 0.9)
    l = light_from(rng.uniform(0, 360), rng.uniform(18, 35))
    h = G.normalize(l + np.array([0, 0, 1.0]))
    I = alb * np.maximum(n @ l, 0) + spec * np.maximum(n @ h, 0) ** 60
    I = I + rng.normal(0, 0.01, I.shape)
    I[~mask] = 0
    scale = np.percentile(I[mask], 99.5)
    I = I / scale
    sat = mask & (I > 1.0)
    return np.clip(I, 0, 1), mask, sat, n, l
