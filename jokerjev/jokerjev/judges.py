"""Judges answer the five cards as logits.

- NoJudge:     all-zero logits (physics decides alone)            -> ablation "조커 없음"
- RandomJudge: random logits                                        -> ablation "조커 무작위"
- OracleJudge: correct answers from GT; LOCAL SCORING ONLY          -> G0 / "조커 오라클"
- FileJudge:   logits produced by the Gemma kernel on Kaggle        -> the real thing

Card signatures (all return numpy logits):
  j1(ctx)                    [16]  light azimuth bins
  j2(ctx, ks)                [len] logit(part k protrudes)
  j3(ctx, pairs)             [len] logit(part i closer than part j), already A/B-debiased
  j4(ctx, regions)           [len] logit(region is a mirror-like highlight)
  j5(ctx, k, nA, nB)         float logit(A matches the photo better than B)
"""
import json
import numpy as np

from . import geometry as G
from .joker import plane_residual_convexity, part_means
from .physics import AZ_BINS


class NoJudge:
    name = "none"

    def j1(self, ctx): return np.zeros(AZ_BINS)
    def j2(self, ctx, ks): return np.zeros(len(ks))
    def j3(self, ctx, pairs): return np.zeros(len(pairs))
    def j4(self, ctx, regions): return np.zeros(len(regions))
    def j5(self, ctx, k, nA, nB): return 0.0


class RandomJudge(NoJudge):
    name = "random"

    def __init__(self, seed=0, scale=3.0):
        self.rng = np.random.default_rng(seed)
        self.s = scale

    def j1(self, ctx): return self.rng.normal(0, self.s, AZ_BINS)
    def j2(self, ctx, ks): return self.rng.normal(0, self.s, len(ks))
    def j3(self, ctx, pairs): return self.rng.normal(0, self.s, len(pairs))
    def j4(self, ctx, regions): return self.rng.normal(0, self.s, len(regions))
    def j5(self, ctx, k, nA, nB): return float(self.rng.normal(0, self.s))


class OracleJudge(NoJudge):
    """Perfect answers. Uses GT normals and the GT light, so it may only run locally."""
    name = "oracle"

    def __init__(self, gt_normal, gt_light, conf=6.0, cards=("J1", "J2", "J3", "J4", "J5")):
        self.N, self.l, self.c = gt_normal, gt_light, conf
        self.cards = set(cards)
        self._z = None

    def _depth(self, ctx):
        if self._z is None:
            self._z = G.integrate(self.N, ctx["mask"])
        return self._z

    def j1(self, ctx):
        if "J1" not in self.cards:
            return super().j1(ctx)
        az = np.degrees(np.arctan2(self.l[1], self.l[0])) % 360
        k = int(np.round(az / (360 / AZ_BINS))) % AZ_BINS
        out = np.full(AZ_BINS, -self.c); out[k] = self.c
        return out

    def j2(self, ctx, ks):
        if "J2" not in self.cards:
            return super().j2(ctx, ks)
        conv = plane_residual_convexity(self._depth(ctx), ctx["parts"], ctx["mask"])
        return np.array([self.c * np.sign(conv[k]) for k in ks])

    def j3(self, ctx, pairs):
        if "J3" not in self.cards:
            return super().j3(ctx, pairs)
        zm = part_means(self._depth(ctx), ctx["parts"])
        return np.array([self.c * np.sign(zm[i] - zm[j]) for i, j in pairs])

    def j4(self, ctx, regions):
        if "J4" not in self.cards:
            return super().j4(ctx, regions)
        h = G.normalize(self.l + np.array([0, 0, 1.0]))
        out = []
        for m in regions:
            ang = np.degrees(np.arccos(np.clip(self.N[m] @ h, -1, 1)))
            out.append(self.c if np.median(ang) < 20 else -self.c)
        return np.array(out)

    def j5(self, ctx, k, nA, nB):
        if "J5" not in self.cards:
            return 0.0
        m = ctx["parts"] == k
        eA = G.angular_error(nA, self.N, m)[1]
        eB = G.angular_error(nB, self.N, m)[1]
        return self.c if eA < eB else -self.c


class FileJudge(NoJudge):
    """Logits written by kaggle/judge_kernel.py, keyed '<obj>/<idx>'."""
    name = "gemma"

    def __init__(self, path, obj, i):
        self.d = json.load(open(path)).get(f"{obj}/{i:03d}", {})

    def j1(self, ctx):
        return np.asarray(self.d["J1"]) if "J1" in self.d else super().j1(ctx)

    def j2(self, ctx, ks):
        v = self.d.get("J2")
        return np.array([v[str(k)] for k in ks]) if v else super().j2(ctx, ks)

    def j3(self, ctx, pairs):
        v = self.d.get("J3")
        return np.array([v[f"{i},{j}"] for i, j in pairs]) if v else super().j3(ctx, pairs)
