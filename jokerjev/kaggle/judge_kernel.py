"""JokerJev judge kernel v2 (Kaggle, T4). Gemma 4 E4B read as a logit instrument.

Inputs: an input-only dataset (<obj>/<idx>.png + <obj>/mask.png, optional
<obj>/<idx>_parts.npz). No GT ever reaches this kernel.

v2 changes over the smoke kernel:
  - fan-out: every question about one photo is answered from one prompt prefix
    batch, the image is prepared once per (photo, view)
  - image token budget raised when the processor exposes a knob (logged either way)
  - J1 is debiased by the 8 dihedral views (rotate/mirror the photo, rotate the
    answer back, average log-probs): a fixed "upper-right" lean cancels out
    without looking at any answer
Output: /kaggle/working/judge_logits.json keyed '<obj>/<idx>'.
"""
import glob, json, os, subprocess, sys, time

subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-U", "transformers", "accelerate"], check=False)
import numpy as np, torch, cv2, transformers
from PIL import Image

TASKS = os.environ.get("JOKER_TASKS", "J1").split(",")
OUT = "/kaggle/working/judge_logits.json"
print("tf", transformers.__version__, "torch", torch.__version__, "gpus", torch.cuda.device_count(), flush=True)

cfgs = glob.glob("/kaggle/input/**/config.json", recursive=True)
MP = os.path.dirname([c for c in cfgs if "e4b" in c.lower()][0])
masks = sorted(glob.glob("/kaggle/input/**/mask.png", recursive=True))
print("model", MP, "objects", len(masks), flush=True)

proc = transformers.AutoProcessor.from_pretrained(MP)
tok = proc.tokenizer
ip = getattr(proc, "image_processor", None)
print("image processor:", type(ip).__name__, {k: v for k, v in vars(ip).items()
      if any(s in k for s in ("token", "size", "patch", "resol", "pixel"))} if ip else None, flush=True)
# raise the image token budget where the processor lets us (names differ across versions)
for k in ("max_soft_tokens", "image_seq_length", "max_num_tokens"):
    if ip is not None and hasattr(ip, k):
        old = getattr(ip, k)
        try:
            setattr(ip, k, max(int(old) * 2, 560)); print(f"budget {k}: {old} -> {getattr(ip, k)}", flush=True)
        except Exception as e:
            print("budget", k, "fail", e, flush=True)

model = None
for cls in ["AutoModelForImageTextToText", "AutoModelForMultimodalLM", "AutoModelForCausalLM"]:
    if not hasattr(transformers, cls):
        continue
    try:
        model = getattr(transformers, cls).from_pretrained(MP, torch_dtype=torch.bfloat16, device_map="auto")
        print("loaded", cls, flush=True); break
    except Exception as e:
        print(cls, "fail", repr(e)[:300], flush=True)
model.eval()
dev = model.get_input_embeddings().weight.device


def tid(s):
    return tok.encode(s, add_special_tokens=False)[0]


LETTERS = "ABCDEFGHIJKLMNOP"
LET = [tid(c) for c in LETTERS]
YES, NO = tid("Yes"), tid("No")
print("letter ids", LET[:4], [tok.decode([i]) for i in LET[:4]], flush=True)


def enc(img, q):
    msgs = [{"role": "user", "content": [{"type": "image", "image": img}, {"type": "text", "text": q}]}]
    kw = dict(add_generation_prompt=True, tokenize=True, return_dict=True, return_tensors="pt")
    try:
        return proc.apply_chat_template(msgs, enable_thinking=False, **kw)
    except TypeError:
        return proc.apply_chat_template(msgs, **kw)


@torch.no_grad()
def last_logits(img, q):
    x = enc(img, q).to(dev)
    return model(**x).logits[0, -1].float().cpu(), int(x["input_ids"].shape[1])


def photo(path, mask, pad=12, side=768):
    I = cv2.imread(path, -1).astype(np.float64)[..., ::-1]
    s = np.percentile(I[mask].mean(-1), 99.5)
    g = np.clip(I / max(s, 1e-6), 0, 1) ** (1 / 2.2)
    g[~mask] = 0
    ys, xs = np.nonzero(mask)
    y0, y1 = max(ys.min() - pad, 0), min(ys.max() + pad, mask.shape[0])
    x0, x1 = max(xs.min() - pad, 0), min(xs.max() + pad, mask.shape[1])
    g = (g[y0:y1, x0:x1] * 255).astype(np.uint8)
    f = side / max(g.shape[:2])
    return cv2.resize(g, None, fx=f, fy=f, interpolation=cv2.INTER_AREA), (y0, x0, f)


# ---- J1: light direction, 16 bins, bin k = azimuth k*22.5 deg (0 = right, 90 = up) ----
DIR16 = ["the right", "the right, slightly above", "the upper right", "above, slightly right",
         "directly above", "above, slightly left", "the upper left", "the left, slightly above",
         "the left", "the left, slightly below", "the lower left", "below, slightly left",
         "directly below", "below, slightly right", "the lower right", "the right, slightly below"]
Q1 = ("This photo shows one object lit by a single small lamp, in front of a black background. "
      "Look at which sides of the object are bright and which are in shadow. "
      "From which direction does the lamp shine onto the object, as seen in this image?\n"
      + "\n".join(f"{LETTERS[k]}) from {d}" for k, d in enumerate(DIR16))
      + "\nAnswer with a single letter.")


def dihedral(img, t):
    """t = (rot90 count, mirror). Returns the view and a map view-bin -> photo-bin."""
    r, m = t
    v = np.ascontiguousarray(np.rot90(img, r))  # counter-clockwise: azimuth + 90*r
    if m:
        v = np.ascontiguousarray(v[:, ::-1])    # mirror left-right: azimuth -> 180 - azimuth
    back = []
    for b in range(16):
        a = b
        if m:
            a = (8 - a) % 16
        a = (a - 4 * r) % 16
        back.append(a)
    return v, back


def j1(img):
    acc = np.zeros(16); raw = None; ntok = None
    for r in range(4):
        for m in (0, 1):
            v, back = dihedral(img, (r, m))
            lg, ntok = last_logits(Image.fromarray(v).convert("RGB"), Q1)
            lp = torch.log_softmax(lg[LET], 0).numpy()
            if r == 0 and m == 0:
                raw = lp.copy()
            out = np.zeros(16)
            for b in range(16):
                out[back[b]] = lp[b]
            acc += out
    return (acc / 8).tolist(), raw.tolist(), ntok


res = json.load(open(OUT)) if os.path.exists(OUT) else {}
t0 = time.time()
for mp in masks:
    d = os.path.dirname(mp); obj = os.path.basename(d)
    mask = cv2.imread(mp, 0) > 0
    for f in sorted(glob.glob(f"{d}/[0-9][0-9][0-9].png")):
        key = f"{obj}/{os.path.basename(f)[:3]}"
        img, _ = photo(f, mask)
        r = res.setdefault(key, {})
        if "J1" in TASKS and "J1" not in r:
            r["J1"], r["J1_raw"], r["ntok"] = j1(img)
            print(key, "J1 argmax", int(np.argmax(r["J1"])), "raw", int(np.argmax(r["J1_raw"])),
                  "ntok", r["ntok"], "t=%.0fs" % (time.time() - t0), flush=True)
        json.dump(res, open(OUT, "w"))
print("done %.0fs" % (time.time() - t0), flush=True)
