"""DiLiGenT loading. Ground truth is only returned by `load_gt`, which the
pipeline never calls; scoring scripts do."""
import os
import numpy as np
import cv2

OBJECTS = ["ball", "bear", "buddha", "cat", "cow", "goblet", "harvest", "pot1", "pot2", "reading"]
TEST_IDS = list(range(21, 31))  # RoSE protocol: images 21..30, one at a time

# RoSE single-image numbers from the plan (degrees)
ROSE = {"harvest": 28.62, "mean": 16.36}


def root():
    return os.environ.get("DILIGENT", os.path.join(os.path.dirname(__file__), "..", "data", "DiLiGenT", "pmsData"))


def obj_dir(obj):
    return os.path.join(root(), f"{obj}PNG")


def load_input(obj, i):
    """What the model is allowed to see: one image and the mask."""
    d = obj_dir(obj)
    img = cv2.imread(os.path.join(d, f"{i:03d}.png"), cv2.IMREAD_UNCHANGED)
    img = img[..., ::-1].astype(np.float64)  # RGB
    mask = cv2.imread(os.path.join(d, "mask.png"), 0) > 0
    gray = img.mean(-1)
    scale = np.percentile(gray[mask], 99.5)
    sat = (img.max(-1) >= 65000) & mask
    return gray / max(scale, 1e-6), img / max(scale, 1e-6), mask, sat


def load_gt(obj, i=None):
    import scipy.io as sio
    d = obj_dir(obj)
    N = sio.loadmat(os.path.join(d, "Normal_gt.mat"))["Normal_gt"].astype(np.float64)
    L = np.loadtxt(os.path.join(d, "light_directions.txt"))
    return N, (L[i - 1] if i is not None else L)
