"""RÖNTGEN baseline data: single image -> MV-Adapter (6 ortho views) -> NiRNE normals.

Runs on Kaggle GPU. Stage 1 and stage 2 run as separate processes so each gets
the full GPU and can use its own package versions if needed.
"""
import os, subprocess, sys, textwrap

W = "/kaggle/working"
T = "/kaggle/tmp"
os.makedirs(T, exist_ok=True)


def sh(cmd, check=True):
    print("$", cmd, flush=True)
    return subprocess.run(cmd, shell=True, check=check).returncode


sh("nvidia-smi")
sh(f"{sys.executable} -m pip install -q einops omegaconf kornia timm peft trimesh jaxtyping typeguard")
sh(f"{sys.executable} -c 'import torch, diffusers, transformers; print(torch.__version__, diffusers.__version__, transformers.__version__)'")
sh(f"git clone -q --depth 1 https://github.com/huanngzh/MV-Adapter {T}/mva")
sh(f"git clone -q --depth 1 https://github.com/hugoycj/StableNormal {T}/sn")

# MV-Adapter inference only needs the camera helpers; skip the mesh/render stack
# (nvdiffrast, cvcuda, open3d, pymeshlab).
open(f"{T}/mva/mvadapter/utils/mesh_utils/__init__.py", "w").write(
    "from .camera import Camera, get_c2w, get_camera, get_orthogonal_camera, "
    "get_orthogonal_projection_matrix, get_projection_matrix\n")
sh(f"sed -i 's/^import nvdiffrast.torch as dr$/dr = None/' {T}/mva/mvadapter/utils/mesh_utils/utils.py")
# T4 (14.5GB) OOMs at 6 views x CFG. The reference-attention cache is passed as a clone while the
# original is still alive, doubling ~1GB of activations; the processors never modify it in place.
sh(f"sed -i 's/{{k: v.clone() for k, v in ref_hidden_states.items()}}/ref_hidden_states/' "
   f"{T}/mva/mvadapter/pipelines/pipeline_mvadapter_i2mv_sdxl.py")
sh(f"grep -n '\"ref_hidden_states\": ref_hidden_states' {T}/mva/mvadapter/pipelines/pipeline_mvadapter_i2mv_sdxl.py")
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"

INPUTS = {
    "anime_figurine": "https://raw.githubusercontent.com/huanngzh/MV-Adapter/main/assets/demo/i2mv/A_decorative_figurine_of_a_young_anime-style_girl.png",
}
TR = "https://raw.githubusercontent.com/microsoft/TRELLIS/main/assets/example_image/"
for n in ["typical_creature_robot_crab", "typical_vehicle_biplane", "typical_humanoid_mech",
          "typical_misc_phonograph", "typical_creature_dragon", "typical_vehicle_pirate_ship",
          "typical_humanoid_dragonborn"]:
    INPUTS[n] = TR + n + ".png"
os.makedirs(f"{T}/inputs", exist_ok=True)
for n, u in INPUTS.items():
    sh(f"curl -sSfL -o {T}/inputs/{n}.png '{u}'")

STAGE1 = textwrap.dedent(r'''
import glob, json, os, sys, time
import numpy as np, torch
from PIL import Image
from torchvision import transforms
from transformers import AutoModelForImageSegmentation
sys.path.insert(0, "/kaggle/tmp/mva"); sys.path.insert(0, "/kaggle/tmp/mva/scripts")
from inference_i2mv_sdxl import prepare_pipeline, run_pipeline, preprocess_image

OUT = "/kaggle/working/out"
AZ = [0, 45, 90, 180, 270, 315]
dev = "cuda"
bir = AutoModelForImageSegmentation.from_pretrained("ZhengPeng7/BiRefNet", trust_remote_code=True).to(dev).eval().float()
tf = transforms.Compose([transforms.Resize((1024, 1024)), transforms.ToTensor(),
                         transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])])

def alpha_of(img):
    with torch.no_grad():
        p = bir(tf(img.convert("RGB")).unsqueeze(0).to(dev))[-1].sigmoid().cpu()[0, 0]
    return transforms.ToPILImage()(p).resize(img.size)

refs = {}
for f in sorted(glob.glob("/kaggle/tmp/inputs/*.png")):
    name = os.path.basename(f)[:-4]
    img = Image.open(f)
    os.makedirs(f"{OUT}/{name}", exist_ok=True)
    img.save(f"{OUT}/{name}/input_original.png")
    if img.mode != "RGBA":
        img = img.convert("RGB"); img.putalpha(alpha_of(img))
    refs[name] = preprocess_image(img, 768, 768)
    refs[name].save(f"{OUT}/{name}/input_reference.png")
bir.to("cpu"); torch.cuda.empty_cache()

pipe = prepare_pipeline(base_model="stabilityai/stable-diffusion-xl-base-1.0",
                        vae_model="madebyollin/sdxl-vae-fp16-fix", unet_model=None, lora_model=None,
                        adapter_path="huanngzh/mv-adapter", scheduler=None, num_views=6,
                        device=dev, dtype=torch.float16)
# The prompt is the same for every asset: encode it once, then park both text encoders
# (~1.6GB fp16) on the CPU for the rest of the run.
_encode, _cache = pipe.encode_prompt, {}
def encode_once(*a, **k):
    if "r" not in _cache:
        _cache["r"] = _encode(*a, **k)
        pipe.text_encoder.to("cpu"); pipe.text_encoder_2.to("cpu"); torch.cuda.empty_cache()
    return _cache["r"]
pipe.encode_prompt = encode_once

views = {}
for name, ref in refs.items():
    t = time.time()
    torch.cuda.reset_peak_memory_stats()
    ims, _ = run_pipeline(pipe, num_views=6, text="high quality", image=ref, height=768, width=768,
                          num_inference_steps=50, guidance_scale=3.0, seed=42, device=dev, azimuth_deg=AZ)
    views[name] = ims
    print(f"[mv] {name} {time.time()-t:.1f}s peak={torch.cuda.max_memory_allocated()/2**30:.1f}GB", flush=True)
del pipe; torch.cuda.empty_cache()

bir.to(dev)
for name, ims in views.items():
    d = f"{OUT}/{name}"
    ref = refs[name].copy(); ref.putalpha(alpha_of(refs[name])); ref.save(f"{d}/input_reference_rgba.png")
    for az, im in zip(AZ, ims):
        im.save(f"{d}/view_az{az:03d}_rgb.png")
        a = alpha_of(im); rgba = im.copy(); rgba.putalpha(a)
        rgba.save(f"{d}/view_az{az:03d}_rgba.png")
    json.dump({"azimuth_deg": AZ, "elevation_deg": [0]*6, "camera": "orthographic",
               "ortho_bounds": [-0.55, 0.55, -0.55, 0.55], "distance": 1.8, "resolution": 768,
               "mvadapter_azimuth_offset": "cameras built with azimuth-90 as in MV-Adapter",
               "background": "gray 0.5 in *_rgb.png; alpha from BiRefNet in *_rgba.png",
               "seed": 42, "steps": 50, "cfg": 3.0}, open(f"{d}/meta.json", "w"), indent=1)
print("stage1 done", flush=True)
''')

STAGE2 = textwrap.dedent(r'''
import glob, json, os, sys, time
import numpy as np, torch
from PIL import Image
pred = torch.hub.load("/kaggle/tmp/sn", "StableNormal_turbo", source="local",
                      yoso_version="yoso-normal-v1-8-1")
pipe = pred.model
OUT = "/kaggle/working/out"

def on_white(rgba):
    bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255)); bg.alpha_composite(rgba)
    return bg.convert("RGB")

for f in sorted(glob.glob(f"{OUT}/*/*_rgba.png")):
    t = time.time()
    rgba = Image.open(f).convert("RGBA")
    rgb = on_white(rgba); mask = np.array(rgba.split()[-1]) > 127
    with torch.no_grad():
        out = pipe(rgb, match_input_resolution=True, processing_resolution=768)
    n = np.asarray(out.prediction[0], dtype=np.float32)  # HxWx3 in [-1,1], camera space
    n = n / np.clip(np.linalg.norm(n, axis=-1, keepdims=True), 1e-6, None)
    n[~mask] = 0
    stem = f[:-len("_rgba.png")]
    np.save(stem + "_normal.npy", n.astype(np.float16))
    vis = ((n + 1) / 2 * 255).clip(0, 255).astype(np.uint8)
    vis[~mask] = 255
    Image.fromarray(vis).save(stem + "_normal.png")
    print(f"[nirne] {os.path.relpath(f, OUT)} {n.shape} {time.time()-t:.1f}s", flush=True)
print("stage2 done", flush=True)
''')

open(f"{T}/stage1.py", "w").write(STAGE1)
open(f"{T}/stage2.py", "w").write(STAGE2)
sh(f"{sys.executable} {T}/stage1.py")
# StableNormal's remote code imports diffusers.models.controlnet (gone in newer diffusers);
# this combination was verified to load and run yoso-normal-v1-8-1.
sh(f"{sys.executable} -m pip install -q 'diffusers==0.31.0' 'transformers==4.46.3' 'huggingface_hub<0.26'")
sh(f"{sys.executable} {T}/stage2.py")

# contact sheets
from PIL import Image
import glob
for d in sorted(glob.glob(f"{W}/out/*/")):
    rows = []
    for kind in ["rgb", "normal"]:
        fs = sorted(glob.glob(f"{d}view_az*_{kind}.png"))
        if fs:
            ims = [Image.open(x).convert("RGB").resize((384, 384)) for x in fs]
            r = Image.new("RGB", (384 * len(ims), 384), "white")
            for i, im in enumerate(ims):
                r.paste(im, (384 * i, 0))
            rows.append(r)
    if rows:
        s = Image.new("RGB", (rows[0].width, 384 * len(rows)), "white")
        for i, r in enumerate(rows):
            s.paste(r, (0, 384 * i))
        s.save(f"{d}sheet.jpg", quality=90)
print("ALL DONE", flush=True)
