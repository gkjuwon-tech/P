"""Physics layer: light hypotheses from shading, Lambertian shape-from-shading, and
per-part candidate interpretations.

Nothing here reads ground truth.
"""
import numpy as np
from scipy.optimize import minimize
from scipy import ndimage

from . import geometry as G

AZ_BINS = 16
POLARS = np.arange(5, 61, 5)


def light_from(az_deg, polar_deg):
    a, p = np.radians(az_deg), np.radians(polar_deg)
    return np.array([np.sin(p) * np.cos(a), np.sin(p) * np.sin(a), np.cos(p)])


def bin_center(k):
    return k * 360.0 / AZ_BINS


def light_energy(I, mask, n_prior, valid=None):
    """E[az_bin, polar]: best-albedo Lambertian residual of the silhouette prior.

    The prior is crude, so this is a weak physics vote; J1 is where the image content
    decides. Residuals are per-pixel means so they are comparable across objects."""
    v = mask if valid is None else (mask & valid)
    hi = np.percentile(I[v], 98)
    v = v & (I <= hi)  # drop the brightest 2% (likely specular)
    n = n_prior[v]
    y = I[v]
    E = np.zeros((AZ_BINS, len(POLARS)))
    for i in range(AZ_BINS):
        for j, p in enumerate(POLARS):
            r = np.maximum(n @ light_from(bin_center(i), p), 0)
            rho = (r @ y) / max(r @ r, 1e-9)
            E[i, j] = np.mean((rho * r - y) ** 2)
    return E


def elevation_for(E, az_bin):
    return float(POLARS[np.argmin(E[az_bin])])


class SfS:
    """min_n  sum_p s_p (rho_p max(n.l,0) - I_p)^2 + alpha sum_pq w_pq |n_p-n_q|^2
             + gamma sum_p |n_p - t_p|^2 + beta sum_{contour} |n_p - c_p|^2

    This is the plan's final energy (Eq. 3) plus the occluding-contour prior. With
    gamma = 0 it is plain SfS, used to generate candidates."""

    def __init__(self, I, mask, parts, light, weights, alpha=0.5, beta=2.0,
                 shade_ok=None, albedo_parts=True):
        self.mask = mask
        self.I = I[mask]
        self.l = light
        self.a, self.b = G.neighbor_pairs(mask)
        self.w = weights
        self.alpha, self.beta = alpha, beta
        self.N = int(mask.sum())
        self.s = np.ones(self.N) if shade_ok is None else shade_ok[mask].astype(float)
        bd = G.boundary(mask)[mask]
        self.bidx = np.nonzero(bd)[0]
        c = G.contour_normals(mask)[mask][self.bidx]
        self.c = G.normalize(c + np.array([0, 0, 0.15]))
        self.part = parts[mask]
        self.K = int(self.part.max()) + 1
        self.albedo_parts = albedo_parts
        self.rho = np.ones(self.N)

    def fit_albedo(self, n):
        r = np.maximum(n @ self.l, 0)
        ok = (r > 0.15) & (self.s > 0)
        if self.albedo_parts:
            num = np.bincount(self.part[ok], (r * self.I)[ok], self.K)
            den = np.bincount(self.part[ok], (r * r)[ok], self.K)
            glob = (r[ok] @ self.I[ok]) / max(r[ok] @ r[ok], 1e-9)
            rk = np.where(den > 1e-3, num / np.maximum(den, 1e-9), glob)
            rk = np.clip(rk, 0.2 * glob, 5 * glob)
            self.rho = rk[self.part]
        else:
            self.rho = np.full(self.N, (r[ok] @ self.I[ok]) / max(r[ok] @ r[ok], 1e-9))

    def energy(self, x, t=None, g=None, gamma=0.0):
        V = x.reshape(-1, 3)
        L = np.linalg.norm(V, axis=1, keepdims=True)
        n = V / L
        N = self.N
        dot = n @ self.l
        lit = dot > 0
        res = self.rho * np.maximum(dot, 0) - self.I
        E = np.sum(self.s * res ** 2)
        gn = (2 * self.s * res * self.rho * lit)[:, None] * self.l[None]

        d = n[self.a] - n[self.b]
        E += self.alpha * np.sum(self.w * (d ** 2).sum(1))
        gd = 2 * self.alpha * self.w[:, None] * d
        for k in range(3):
            gn[:, k] += np.bincount(self.a, gd[:, k], N) - np.bincount(self.b, gd[:, k], N)

        db = n[self.bidx] - self.c
        E += self.beta * np.sum(db ** 2)
        np.add.at(gn, self.bidx, 2 * self.beta * db)

        neg = np.minimum(n[:, 2], 0)
        E += 10 * np.sum(neg ** 2)
        gn[:, 2] += 20 * neg

        if gamma > 0 and t is not None:
            dt = n - t
            wt = g[:, None] if g is not None else 1.0
            E += gamma * np.sum(wt * dt ** 2)
            gn += 2 * gamma * wt * dt

        # back through the normalisation n = V/|V|
        gV = (gn - (gn * n).sum(1, keepdims=True) * n) / L
        return E / N, gV.ravel() / N

    def solve(self, n0, iters=300, outer=3, t=None, g=None, gamma=0.0):
        x = n0[self.mask].copy()
        for _ in range(outer):
            self.fit_albedo(G.normalize(x.reshape(-1, 3)))
            # energy is a per-pixel mean, so gradients are O(1/N): scale up for L-BFGS's tolerances
            f = lambda v: tuple(u * self.N for u in self.energy(v, t, g, gamma))
            r = minimize(f, x.ravel(), jac=True, method="L-BFGS-B",
                         options={"maxiter": iters, "maxcor": 20, "gtol": 1e-8, "ftol": 1e-12})
            x = r.x.reshape(-1, 3)
        n = np.zeros(self.mask.shape + (3,))
        n[self.mask] = G.normalize(x)
        return n


def flip_detail(n, base, mask):
    """Convex <-> concave: mirror the gradient of n about the gradient of base."""
    p, q = G.normals_to_grad(n)
    pb, qb = G.normals_to_grad(base)
    f = G.grad_to_normals(2 * pb - p, 2 * qb - q)
    f[~mask] = 0
    return f


def part_shade_energy(I, n, mask, parts, light, shade_ok):
    """E_{k,h}: per-part mean squared re-render error with the part's best albedo."""
    K = parts.max() + 1
    r = np.maximum((n * light).sum(-1), 0)
    E = np.zeros(K)
    for k in range(K):
        m = (parts == k) & shade_ok
        if m.sum() < 5:
            m = parts == k
        rr, y = r[m], I[m]
        rho = (rr @ y) / max(rr @ rr, 1e-9)
        E[k] = np.mean((rho * rr - y) ** 2)
    return E


def bright_regions(I, mask, pct=97, min_size=15):
    """Candidate highlight regions for J4: connected components of very bright pixels."""
    thr = np.percentile(I[mask], pct)
    lab, n = ndimage.label(mask & (I >= thr))
    out = -np.ones(mask.shape, np.int64)
    k = 0
    for c in range(1, n + 1):
        m = lab == c
        if m.sum() >= min_size:
            out[ndimage.binary_dilation(m, iterations=2) & mask] = k; k += 1
    return out
