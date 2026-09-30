"""Normals, gradients, integration and error metrics.

Camera convention (DiLiGenT): x right, y up, z toward the camera. Image rows grow
downward, so d/dy = -d/drow.
"""
import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla
from scipy import ndimage


def normalize(v, axis=-1, eps=1e-8):
    return v / np.maximum(np.linalg.norm(v, axis=axis, keepdims=True), eps)


def angular_error(n, gt, mask):
    """Per-pixel angle in degrees and the mean over the mask."""
    c = np.clip((normalize(n) * gt).sum(-1), -1, 1)
    ang = np.degrees(np.arccos(c))
    return ang, float(ang[mask].mean())


def index_map(mask):
    idx = -np.ones(mask.shape, np.int64)
    idx[mask] = np.arange(mask.sum())
    return idx


def neighbor_pairs(mask):
    """4-neighbour edges (a, b) between mask pixels, as flat mask indices."""
    idx = index_map(mask)
    a1, b1 = idx[:, :-1], idx[:, 1:]
    a2, b2 = idx[:-1, :], idx[1:, :]
    a = np.concatenate([a1.ravel(), a2.ravel()])
    b = np.concatenate([b1.ravel(), b2.ravel()])
    ok = (a >= 0) & (b >= 0)
    return a[ok], b[ok]


def boundary(mask):
    return mask & ~ndimage.binary_erosion(mask)


def contour_normals(mask, sigma=2.0):
    """Outward 2D normals of the silhouette (occluding contour: n_z = 0)."""
    s = ndimage.gaussian_filter(mask.astype(np.float64), sigma)
    gr, gc = np.gradient(s)
    n = np.stack([-gc, gr, np.zeros_like(s)], -1)  # outward = -grad(mask); y up
    return normalize(n)


def _laplace_system(mask):
    idx = index_map(mask)
    n = int(mask.sum())
    rows, cols, vals = [], [], []
    rr, cc = np.nonzero(mask)
    diag = np.full(n, 4.0)
    for dr, dc in [(0, 1), (0, -1), (1, 0), (-1, 0)]:
        r2, c2 = rr + dr, cc + dc
        inside = (r2 >= 0) & (r2 < mask.shape[0]) & (c2 >= 0) & (c2 < mask.shape[1])
        j = np.full(n, -1)
        j[inside] = idx[r2[inside], c2[inside]]
        ok = j >= 0
        rows.append(np.arange(n)[ok]); cols.append(j[ok]); vals.append(-np.ones(ok.sum()))
    A = sp.csr_matrix((np.concatenate(vals + [diag]),
                       (np.concatenate(rows + [np.arange(n)]), np.concatenate(cols + [np.arange(n)]))),
                      shape=(n, n))
    return A


def inflation(mask):
    """Silhouette balloon: sqrt of the Poisson solution. A disk becomes a hemisphere."""
    A = _laplace_system(mask)
    zp = spla.spsolve(A.tocsc(), np.ones(A.shape[0]))
    z = np.zeros(mask.shape)
    z[mask] = 2.0 * np.sqrt(np.maximum(zp, 0))
    return z


def depth_to_normals(z, mask):
    zz = z.copy()
    # replicate edge values outward so the one-sided difference at the rim stays inside
    zr = np.gradient(zz, axis=0)
    zc = np.gradient(zz, axis=1)
    n = np.stack([-zc, zr, np.ones_like(z)], -1)  # z_y = -z_row
    n = normalize(n)
    n[~mask] = 0
    return n


def inflation_normals(mask):
    z = inflation(mask)
    n = depth_to_normals(z, mask)
    b = boundary(mask)
    c = contour_normals(mask)
    n[b] = normalize(0.15 * np.array([0, 0, 1.0]) + c[b])
    return n, z


def normals_to_grad(n, nz_min=0.1):
    nz = np.maximum(n[..., 2], nz_min)
    return -n[..., 0] / nz, n[..., 1] / nz  # dz/dcol, dz/drow


def grad_to_normals(p, q):
    return normalize(np.stack([-p, q, np.ones_like(p)], -1))


def integrate(n, mask, nz_min=0.1):
    """Least-squares depth from normals inside the mask (relative, mean zero)."""
    p, q = normals_to_grad(n, nz_min)
    idx = index_map(mask)
    N = int(mask.sum())
    eqs_r, eqs_c, eqs_v, rhs = [], [], [], []
    k = 0
    for (a, b, g) in [(idx[:, :-1], idx[:, 1:], 0.5 * (p[:, :-1] + p[:, 1:])),
                      (idx[:-1, :], idx[1:, :], 0.5 * (q[:-1, :] + q[1:, :]))]:
        ok = (a >= 0) & (b >= 0)
        a, b, g = a[ok], b[ok], g[ok]
        m = len(a)
        r = np.arange(k, k + m)
        eqs_r += [r, r]; eqs_c += [b, a]; eqs_v += [np.ones(m), -np.ones(m)]; rhs.append(g)
        k += m
    A = sp.csr_matrix((np.concatenate(eqs_v), (np.concatenate(eqs_r), np.concatenate(eqs_c))), shape=(k, N))
    AtA = (A.T @ A + 1e-6 * sp.eye(N)).tocsc()
    zv = spla.spsolve(AtA, A.T @ np.concatenate(rhs))
    z = np.zeros(mask.shape)
    z[mask] = zv - zv.mean()
    return z


def laplacian(z, mask):
    """Masked 5-point Laplacian (missing neighbours treated as reflective)."""
    out = np.zeros_like(z)
    cnt = np.zeros_like(z)
    for dr, dc in [(0, 1), (0, -1), (1, 0), (-1, 0)]:
        zs = np.roll(z, (dr, dc), (0, 1))
        ms = np.roll(mask, (dr, dc), (0, 1))
        out += np.where(ms, zs - z, 0)
        cnt += ms
    return np.where(mask, out, 0)


def az_of(v):
    return np.degrees(np.arctan2(v[..., 1], v[..., 0]))


def ang_diff(a, b):
    d = (np.asarray(a) - np.asarray(b) + 180) % 360 - 180
    return np.abs(d)
