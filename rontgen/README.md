# RÖNTGEN

Normal maps (6 views) → intermediate field → mesh.

## Baseline data (`kaggle/rontgen-baseline`)

Single image → MV-Adapter SDXL (6 orthographic views) → BiRefNet mask → NiRNE normals.
Runs as a Kaggle GPU script (T4, ~4 min per asset for MV-Adapter, peak 12.0 GB).

```bash
export KAGGLE_API_TOKEN=...            # never commit this
kaggle kernels push -p rontgen/kaggle/rontgen-baseline
kaggle kernels output juuwon/rontgen-baseline -p rontgen/data/baseline_v1   # data/ is gitignored
```

### Per-asset output (`out/<asset>/`)

| file | content |
|---|---|
| `input_original.png`, `input_reference.png` | source image; 768² gray-bg reference fed to MV-Adapter |
| `view_azXXX_rgb.png` | MV-Adapter view, gray (0.5) background |
| `view_azXXX_rgba.png` | same with BiRefNet alpha |
| `view_azXXX_normal.npy` | NiRNE normals, float16 768×768×3, unit length, 0 outside mask |
| `view_azXXX_normal.png` | visualisation, white background |
| `input_reference_normal.*` | NiRNE on the original input (the "real" front view) |
| `meta.json` | cameras; `sheet.jpg` RGB/normal contact sheet |

### Cameras

MV-Adapter defaults: azimuth `[0, 45, 90, 180, 270, 315]`, elevation 0, orthographic,
bounds ±0.55, distance 1.8, 768 px. Cameras are built with `azimuth - 90`
(`get_orthogonal_camera`). Opposite pairs: 0/180 and 90/270 only; 45 and 315 have no partner.
No top/bottom view.

### Normal convention (measured, all 56 maps agree)

Camera space with **+x = image left, +y = image up, +z = towards the camera**.
This is OpenGL camera space with x flipped: use `n_gl = (-nx, ny, nz)` before rotating to world.
Checked by correlating normals with the outward silhouette direction at mask edges.

### Assets and first observations

| asset | what goes wrong in the views |
|---|---|
| phonograph | horn shape changes between views; back views (180/270) turn the horn into a closed blob |
| robot crab | number and placement of legs/claws differs per view; az045 has a floating claw |
| pirate ship | rigging and sails are re-invented per view; thin ropes partly survive in normals |
| biplane | az090 splits the upper wing into two blocks; struts inconsistent |
| dragon | wings shrink or vanish in side views (az090/270) |
| mech | back is invented, plausible but unrelated to front details |
| dragonborn | most consistent of the set; tail and horns stable |
| anime figurine | face/hair consistent, normals smooth; fine detail (flowers, bow) varies |

Takeaway for the engine: NiRNE normals are sharp and detailed *within* each view; the dominant
error is cross-view inconsistency from MV-Adapter (topology-level, not just noise), which is
what the confidence / winding-field fusion has to arbitrate.
