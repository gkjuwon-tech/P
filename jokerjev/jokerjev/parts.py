"""Part segmentation. DINOv3 features (computed on Kaggle) are the intended source;
SLIC on the image and a plain grid are the local stand-in and the ablation."""
import numpy as np
from scipy import ndimage


def _relabel(lab, mask, min_size=30):
    lab = np.where(mask, lab, -1)
    out = -np.ones_like(lab)
    k = 0
    for v in np.unique(lab[lab >= 0]):
        cc, n = ndimage.label(lab == v)
        for c in range(1, n + 1):
            m = cc == c
            if m.sum() >= min_size:
                out[m] = k; k += 1
    # absorb orphans into the nearest labelled pixel
    orphan = mask & (out < 0)
    if orphan.any() and k > 0:
        _, (ir, ic) = ndimage.distance_transform_edt(out < 0, return_indices=True)
        out[orphan] = out[ir[orphan], ic[orphan]]
    return out


def grid_parts(mask, cell=48):
    r, c = np.indices(mask.shape)
    lab = (r // cell) * 10000 + (c // cell)
    return _relabel(lab, mask)


def slic_parts(img, mask, n=40, compactness=0.1):
    from skimage.segmentation import slic
    g = img / max(img[mask].max(), 1e-6)
    lab = slic(g, n_segments=n, compactness=compactness, mask=mask, channel_axis=None, start_label=0)
    return _relabel(lab, mask)


def feature_parts(feat, mask, n=40, xy_weight=0.5, seed=0):
    """k-means on (DINO feature, xy). feat: HxWxC already upsampled to the image."""
    from scipy.cluster.vq import kmeans2
    rr, cc = np.nonzero(mask)
    f = feat[mask]
    f = (f - f.mean(0)) / (f.std(0).mean() + 1e-6)
    s = max(mask.shape)
    xy = np.stack([rr, cc], 1) / s * np.sqrt(f.shape[1]) * xy_weight * 4
    _, lab = kmeans2(np.concatenate([f, xy], 1), n, seed=seed, minit="++")
    out = -np.ones(mask.shape, np.int64)
    out[mask] = lab
    return _relabel(out, mask)


def adjacency(parts):
    """Neighbouring part pairs with their shared boundary length."""
    pairs = {}
    for a, b in [(parts[:, :-1], parts[:, 1:]), (parts[:-1, :], parts[1:, :])]:
        ok = (a >= 0) & (b >= 0) & (a != b)
        for x, y in zip(a[ok], b[ok]):
            key = (min(x, y), max(x, y))
            pairs[key] = pairs.get(key, 0) + 1
    return pairs


def centroids(parts):
    K = parts.max() + 1
    out = np.zeros((K, 2))
    for k in range(K):
        rr, cc = np.nonzero(parts == k)
        # the member pixel closest to the centroid, so the marker lands on the part
        r0, c0 = rr.mean(), cc.mean()
        j = np.argmin((rr - r0) ** 2 + (cc - c0) ** 2)
        out[k] = rr[j], cc[j]
    return out.astype(int)


def edge_weights(parts, a_idx, b_idx, mask, feat=None, cross=0.2, tau=None):
    """w^DINO: 1 inside a part, `cross` across a part boundary; with features, a Gaussian
    of feature distance instead."""
    pa, pb = parts[mask][a_idx], parts[mask][b_idx]
    if feat is None:
        return np.where(pa == pb, 1.0, cross)
    f = feat[mask]
    d = ((f[a_idx] - f[b_idx]) ** 2).sum(-1)
    tau = tau or np.median(d) + 1e-9
    return np.exp(-d / (4 * tau))
