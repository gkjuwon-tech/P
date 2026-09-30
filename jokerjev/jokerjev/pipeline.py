"""JokerJev: DINO parts -> physics candidates -> joker cards only where physics is torn."""
from dataclasses import dataclass, field
import numpy as np

from . import geometry as G
from . import parts as P
from . import physics as PH
from . import joker as J


@dataclass
class Config:
    # fixed on synthetic scenes (scripts/tune_synthetic.py), never on DiLiGenT
    alpha: float = 0.05     # smoothness
    beta: float = 0.5       # occluding contour
    gamma: float = 0.1      # pull toward the joker target
    lam: float = 1.0        # judge weight in Eq.1
    tau: float = 0.25       # σ² as a fraction of a part's best re-render error
    light_tau: float = 0.05
    n_parts: int = 40
    parts: str = "slic"     # slic | grid | feature
    iters: int = 200
    ambiguous_margin: float = 0.3  # J5 fires when top-2 posterior gap is below this
    cands: tuple = ("sfs", "flip", "sfs_flip", "inflate")
    cards: tuple = ("J1", "J2", "J3", "J4", "J5")


@dataclass
class Result:
    normal: np.ndarray
    light: np.ndarray
    parts: np.ndarray
    cands: list
    post: np.ndarray
    info: dict = field(default_factory=dict)


def run(I, mask, sat, judge, cfg=Config(), feat=None, pick_best=None):
    """pick_best: optional callable(k, cands) -> h, used only for the 'best of H' bound."""
    info = {}
    ctx = {"I": I, "mask": mask}
    n_inf, _ = G.inflation_normals(mask)

    # parts
    if cfg.parts == "grid":
        parts = P.grid_parts(mask)
    elif cfg.parts == "feature" and feat is not None:
        parts = P.feature_parts(feat, mask, cfg.n_parts)
    else:
        parts = P.slic_parts(I, mask, cfg.n_parts)
    ctx["parts"] = parts
    K = parts.max() + 1
    a, b = G.neighbor_pairs(mask)
    w = P.edge_weights(parts, a, b, mask, feat)

    # J1: light. Physics votes via re-render error of the silhouette prior.
    El = PH.light_energy(I, mask, n_inf, ~sat)
    Eaz = El.min(1)
    ell1 = judge.j1(ctx) if "J1" in cfg.cards else np.zeros(PH.AZ_BINS)
    s = cfg.lam * ell1 - (Eaz - Eaz.min()) / (2 * cfg.light_tau * Eaz.min() + 1e-9)
    az_bin = int(np.argmax(s))
    light = PH.light_from(PH.bin_center(az_bin), PH.elevation_for(El, az_bin))
    info.update(az_bin=az_bin, j1=ell1.tolist(), light_E=Eaz.tolist())

    # J4: which bright blobs are mirror highlights (excluded from the shading term)
    shade_ok = mask & ~sat
    reg = PH.bright_regions(I, mask)
    regions = [reg == r for r in range(reg.max() + 1)]
    if regions and "J4" in cfg.cards:
        l4 = judge.j4(ctx, regions)
        for m, v in zip(regions, l4):
            if v > 0:
                shade_ok &= ~m
        info["j4"] = np.asarray(l4).tolist()

    # physics candidates
    sfs = PH.SfS(I, mask, parts, light, w, cfg.alpha, cfg.beta, shade_ok)
    fields = {"inflate": n_inf}
    fields["sfs"] = sfs.solve(n_inf, cfg.iters)
    fields["flip"] = PH.flip_detail(fields["sfs"], n_inf, mask)
    if "sfs_flip" in cfg.cands:
        fields["sfs_flip"] = sfs.solve(fields["flip"], cfg.iters)
    cands = [fields[c] for c in cfg.cands]
    H = len(cands)

    E = np.stack([PH.part_shade_energy(I, n, mask, parts, light, shade_ok) for n in cands], 1)

    # card logits per (part, hypothesis)
    ell = np.zeros((K, H))
    depths = [G.integrate(n, mask) for n in cands]
    if "J2" in cfg.cards:
        l2 = judge.j2(ctx, list(range(K)))
        conv = np.stack([J.plane_residual_convexity(z, parts, mask) for z in depths], 1)
        ell += 0.5 * l2[:, None] * np.sign(conv)
        info["j2"] = np.asarray(l2).tolist()
    if "J3" in cfg.cards:
        pairs = list(P.adjacency(parts).keys())
        l3 = judge.j3(ctx, pairs)
        zJ = J.bradley_terry(pairs, l3, K)
        for h, z in enumerate(depths):
            zm = J.part_means(z, parts)
            for (i, j), v in zip(pairs, l3):
                agree = np.sign(v) * np.sign(zm[i] - zm[j])
                # a pair vote belongs to both of its parts
                ell[i, h] += 0.25 * abs(zJ[i] - zJ[j]) * agree
                ell[j, h] += 0.25 * abs(zJ[i] - zJ[j]) * agree
        info["j3_n"] = len(pairs)

    post = J.posterior(ell, E, cfg.lam, cfg.tau)

    # J5: referee between the top two where the posterior is still split
    if "J5" in cfg.cards:
        top = np.argsort(-post, 1)
        n5 = 0
        for k in range(K):
            h1, h2 = top[k, 0], top[k, 1]
            if post[k, h1] - post[k, h2] < cfg.ambiguous_margin:
                v = judge.j5(ctx, k, cands[h1], cands[h2])
                if v != 0:
                    win = h1 if v > 0 else h2
                    post[k] = 0; post[k, win] = 1; n5 += 1
        info["j5_n"] = n5

    if pick_best is not None:
        post = np.zeros((K, H))
        for k in range(K):
            post[k, pick_best(k, cands)] = 1

    t = J.joker_target(cands, post, parts, mask)
    final = PH.SfS(I, mask, parts, light, w, cfg.alpha, cfg.beta, shade_ok)
    n = final.solve(t, cfg.iters, t=t[mask], gamma=cfg.gamma)
    info["E"] = E.tolist()
    return Result(n, light, parts, cands, post, info)
