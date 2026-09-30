"""The joker-card layer: turning judge logits into geometry.

Every card is read as logits and enters a least-squares / log-linear model:
  Eq.1  P(h|k) ∝ exp(λ ℓ_{k,h} − E_{k,h} / 2σ²)          (hypothesis weights)
  Eq.2  logit P(i closer than j) = β (z_i − z_j) + b     (Bradley–Terry depth)
  Eq.3  final energy, solved by physics.SfS with the joker target t.
"""
import numpy as np
from scipy import ndimage

from . import geometry as G


def plane_residual_convexity(z, parts, mask, ring=6):
    """Per-part protrusion: mean height of the part above a plane fitted to the ring
    of pixels around it. > 0 bulges toward the camera, < 0 is a dent."""
    K = parts.max() + 1
    out = np.zeros(K)
    rr, cc = np.indices(mask.shape)
    for k in range(K):
        pk = parts == k
        rg = ndimage.binary_dilation(pk, iterations=ring) & mask & ~pk
        if rg.sum() < 6:
            continue
        A = np.stack([rr[rg], cc[rg], np.ones(rg.sum())], 1).astype(float)
        coef, *_ = np.linalg.lstsq(A, z[rg], rcond=None)
        Ap = np.stack([rr[pk], cc[pk], np.ones(pk.sum())], 1).astype(float)
        out[k] = float(np.mean(z[pk] - Ap @ coef))
    return out


def part_means(z, parts):
    K = parts.max() + 1
    m = parts >= 0
    return np.bincount(parts[m], z[m], K) / np.maximum(np.bincount(parts[m], minlength=K), 1)


def bradley_terry(pairs, logits, K, ridge=1e-2):
    """Least squares for z from pair logits (β absorbed into z's scale)."""
    if len(pairs) == 0:
        return np.zeros(K)
    A = np.zeros((len(pairs), K))
    for r, (i, j) in enumerate(pairs):
        A[r, i], A[r, j] = 1, -1
    y = np.asarray(logits, float)
    z = np.linalg.solve(A.T @ A + ridge * np.eye(K), A.T @ y)
    return z - z.mean()


def soft_sign(x):
    s = np.median(np.abs(x)) + 1e-9
    return np.tanh(x / s)


def posterior(ell, E, lam=1.0, tau=0.25):
    """Eq.1 per part. ell, E: [K, H]. σ² is set relative to each part's best fit so a
    part whose candidates all re-render equally well hands the decision to the judge."""
    Emin = E.min(1, keepdims=True)
    sig2 = tau * np.maximum(Emin, 1e-6) + 1e-6
    s = lam * ell - (E - Emin) / (2 * sig2)
    s -= s.max(1, keepdims=True)
    P = np.exp(s)
    return P / P.sum(1, keepdims=True)


def joker_target(cands, P, parts, mask):
    """n̄^joker: posterior mix of the candidate fields, per part."""
    t = np.zeros(mask.shape + (3,))
    w = P[np.maximum(parts, 0)]  # HxWxH
    for h, n in enumerate(cands):
        t += w[..., h:h + 1] * n
    t = G.normalize(t)
    t[~mask] = 0
    return t
