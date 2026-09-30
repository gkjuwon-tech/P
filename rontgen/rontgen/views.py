"""Axis-aligned orthographic cameras, mesh normalisation and a CPU ray-cast renderer.

World: +Y up. Each view has right `r`, up `u` and `f` pointing from the object towards the
camera, with r x u = f (OpenGL camera space: x right, y up, z towards the viewer).
The image plane covers [-EXTENT, EXTENT]^2 in world units; row 0 is the top of the image.
"""
import numpy as np
import trimesh

EXTENT = 1.0

VIEWS = {
    "front":  dict(f=(0, 0, 1),  u=(0, 1, 0),  r=(1, 0, 0)),
    "right":  dict(f=(1, 0, 0),  u=(0, 1, 0),  r=(0, 0, -1)),
    "back":   dict(f=(0, 0, -1), u=(0, 1, 0),  r=(-1, 0, 0)),
    "left":   dict(f=(-1, 0, 0), u=(0, 1, 0),  r=(0, 0, 1)),
    "top":    dict(f=(0, 1, 0),  u=(0, 0, -1), r=(1, 0, 0)),
    "bottom": dict(f=(0, -1, 0), u=(0, 0, 1),  r=(1, 0, 0)),
}
for _v in VIEWS.values():
    for _k in "fur":
        _v[_k] = np.asarray(_v[_k], dtype=np.float64)
    assert np.allclose(np.cross(_v["r"], _v["u"]), _v["f"])


def normalize_mesh(mesh, radius=0.9):
    """Centre the bounding box at the origin and scale the bounding sphere to `radius`."""
    mesh = mesh.copy()
    mesh.apply_translation(-mesh.bounds.mean(0))
    mesh.apply_scale(radius / np.linalg.norm(mesh.vertices, axis=1).max())
    return mesh


def pixel_grid(res):
    """Image-plane coordinates (x right, y up) of pixel centres, shape (res, res)."""
    c = (np.arange(res) + 0.5) / res * 2 - 1
    x, y = np.meshgrid(c * EXTENT, -c * EXTENT)
    return x, y


def pixel_size(res):
    return 2 * EXTENT / res


def to_pixels(points, view, res):
    """World points -> (col, row, height along f) in continuous pixel units."""
    v = VIEWS[view]
    x, y, d = points @ v["r"], points @ v["u"], points @ v["f"]
    col = (x / EXTENT + 1) / 2 * res - 0.5
    row = (1 - y / EXTENT) / 2 * res - 0.5
    return col, row, d


def world_to_cam(n, view):
    v = VIEWS[view]
    return np.stack([n @ v["r"], n @ v["u"], n @ v["f"]], -1)


def cam_to_world(n, view):
    v = VIEWS[view]
    return n[..., :1] * v["r"] + n[..., 1:2] * v["u"] + n[..., 2:3] * v["f"]


def raycast(mesh, view, res):
    """Orthographic ray cast. Returns mask, height map along f, world normals (smooth)."""
    v = VIEWS[view]
    x, y = pixel_grid(res)
    origins = (x[..., None] * v["r"] + y[..., None] * v["u"] + 3.0 * v["f"]).reshape(-1, 3)
    dirs = np.broadcast_to(-v["f"], origins.shape)
    loc, ray_idx, tri_idx = mesh.ray.intersects_location(origins, dirs, multiple_hits=False)
    mask = np.zeros(res * res, bool)
    height = np.full(res * res, -np.inf)
    normal = np.zeros((res * res, 3))
    mask[ray_idx] = True
    height[ray_idx] = loc @ v["f"]
    bary = trimesh.triangles.points_to_barycentric(mesh.triangles[tri_idx], loc)
    vn = mesh.vertex_normals[mesh.faces[tri_idx]]
    n = (vn * bary[..., None]).sum(1)
    normal[ray_idx] = n / np.linalg.norm(n, axis=1, keepdims=True)
    return mask.reshape(res, res), height.reshape(res, res), normal.reshape(res, res, 3)


def shade_clay(mask, normal_world, view, albedo=0.72):
    """Studio-ish clay shading with lights fixed in camera space; white background, RGBA."""
    n = world_to_cam(normal_world, view)
    lights = [(np.array([-0.5, 0.6, 0.65]), 0.75), (np.array([0.6, 0.2, 0.5]), 0.30),
              (np.array([0.0, -0.3, 1.0]), 0.15)]
    diff = sum(w * np.clip(n @ (l / np.linalg.norm(l)), 0, None) for l, w in lights)
    h = np.array([-0.5, 0.6, 0.65]); h = h / np.linalg.norm(h) + np.array([0, 0, 1.0])
    spec = 0.12 * np.clip(n @ (h / np.linalg.norm(h)), 0, None) ** 32
    rim = 0.10 * (1 - np.clip(n[..., 2], 0, 1)) ** 3
    c = np.clip(0.18 * albedo + albedo * diff + spec + rim, 0, 1)
    rgb = np.repeat(c[..., None], 3, -1) * np.array([1.0, 0.97, 0.93])
    rgba = np.concatenate([np.where(mask[..., None], rgb, 1.0), mask[..., None] * 1.0], -1)
    return (rgba * 255).round().astype(np.uint8)
