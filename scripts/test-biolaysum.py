#!/usr/bin/env python3
"""
scripts/test-biolaysum.py: EXPERIMENT ONLY. Not part of npm test, not used by the app.

Tries the open-source lay-summary model Phi-2 BioLaySum (Hugging Face: sank29mane/LayBioSum, LoRA adapter on
microsoft/phi-2) on ONE endorsed chest X-ray report and writes what it says next to the Azure lay summary that
is already stored for the same case. English only. It changes nothing: no database write, no Azure call, no
production file. It reads /tmp/biolaysum/case.json (made by scripts/test-biolaysum-export.cjs) and writes
/tmp/biolaysum/result.json.

The model is loaded exactly as its model card shows (AutoModelForCausalLM + PeftModel, fp16, device_map="auto",
adapter "sank29mane/phi-2-biolaysum", which Hugging Face redirects to sank29mane/LayBioSum).

  /tmp/biolaysum/venv/bin/python scripts/test-biolaysum.py
"""

import json
import re
import sys
import time

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

CASE = sys.argv[1] if len(sys.argv) > 1 else "/tmp/biolaysum/case.json"
OUT = "/tmp/biolaysum/result.json"
case = json.load(open(CASE))
report = case["endorsedReport"]  # the same text the Azure lay summary is given, and nothing else

result = {"caseId": case["caseId"], "input": report, "azure": case["azureEnglish"], "runs": []}

# ----------------------------------------------------------------- load, as the model card shows
t = time.time()
base_model_name = "microsoft/phi-2"
model = AutoModelForCausalLM.from_pretrained(base_model_name, torch_dtype=torch.float16, device_map="auto")
tokenizer = AutoTokenizer.from_pretrained(base_model_name)
t_base = time.time() - t

ADAPTER = "sank29mane/phi-2-biolaysum"


def convert_old_adapter(adapter_id):
    """COMPATIBILITY STEP, not in the model card.

    The card's own call fails on current libraries (see the error recorded in result.json): the adapter was
    trained on the first release of phi-2, whose layers are named transformer.h.N.mixer.Wqkv / .out_proj, and
    microsoft/phi-2 now ships in the standard layout (model.layers.N.self_attn.q_proj/k_proj/v_proj/dense).
    LoRA on the fused Wqkv (3 x 2560 outputs: q, then k, then v) is exactly the same as three LoRAs that share
    A and take the matching third of B, so this rewrites the adapter's tensors into the new names with no
    change in what it adds to the weights. Nothing is trained; the numbers are the author's.
    """
    import os
    import tempfile
    from huggingface_hub import hf_hub_download
    from safetensors.torch import load_file, save_file

    src = load_file(hf_hub_download(adapter_id, "adapter_model.safetensors"))
    cfg = json.load(open(hf_hub_download(adapter_id, "adapter_config.json")))
    out = {}
    hidden = 2560
    for key, tensor in src.items():
        m = re.match(r"base_model\.model\.transformer\.h\.(\d+)\.mixer\.(Wqkv|out_proj)\.lora_([AB])\.weight", key)
        assert m, f"unexpected adapter key {key}"
        n, name, ab = m.groups()
        prefix = f"base_model.model.model.layers.{n}.self_attn"
        if name == "out_proj":
            out[f"{prefix}.dense.lora_{ab}.weight"] = tensor
        elif ab == "A":
            for proj in ("q_proj", "k_proj", "v_proj"):
                out[f"{prefix}.{proj}.lora_A.weight"] = tensor.clone()
        else:
            assert tensor.shape[0] == 3 * hidden
            for i, proj in enumerate(("q_proj", "k_proj", "v_proj")):
                out[f"{prefix}.{proj}.lora_B.weight"] = tensor[i * hidden:(i + 1) * hidden].clone().contiguous()
    cfg["target_modules"] = ["q_proj", "k_proj", "v_proj", "dense"]
    folder = tempfile.mkdtemp(prefix="biolaysum-adapter-")
    save_file(out, os.path.join(folder, "adapter_model.safetensors"))
    json.dump(cfg, open(os.path.join(folder, "adapter_config.json"), "w"), indent=2)
    return folder


t = time.time()
card_error = None
try:
    model = PeftModel.from_pretrained(model, ADAPTER)  # exactly as the model card shows
except Exception as err:  # noqa: BLE001
    card_error = f"{type(err).__name__}: {err}"
    print("model card loading call failed:", card_error, flush=True)
    model = PeftModel.from_pretrained(model, convert_old_adapter(ADAPTER))
if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token
t_adapter = time.time() - t

device = str(next(model.parameters()).device)
result["load"] = {
    "base_seconds": round(t_base, 1), "adapter_seconds": round(t_adapter, 1), "device": device,
    "mps_available": torch.backends.mps.is_available(), "cuda_available": torch.cuda.is_available(),
    "torch": torch.__version__, "model_card_loading_error": card_error, "adapter_converted": bool(card_error),
}
print(f"loaded: base {t_base:.1f}s, adapter {t_adapter:.1f}s, device {device}", flush=True)


# ----------------------------------------------------------------- generate
def generate(prompt, label, seed, card_exact=False, max_new_tokens=None, sample=True):
    """card_exact=True is the model card's generate_lay_summary(), unchanged (max_length=150, sampling 0.7)."""
    torch.manual_seed(seed)
    inputs = tokenizer(prompt, return_tensors="pt", truncation=True, max_length=512)
    inputs = {k: v.to(model.device) for k, v in inputs.items()}
    n_in = inputs["input_ids"].shape[1]
    kwargs = dict(temperature=0.7, do_sample=True, pad_token_id=tokenizer.eos_token_id) if sample else dict(do_sample=False, pad_token_id=tokenizer.eos_token_id)
    if card_exact:
        kwargs["max_length"] = 150
    else:
        kwargs["max_new_tokens"] = max_new_tokens
    t0 = time.time()
    try:
        with torch.no_grad():
            outputs = model.generate(**inputs, **kwargs)
    except Exception as err:  # noqa: BLE001  (the model card's own call is rejected: the prompt is longer than max_length)
        run = {"label": label, "seed": seed, "prompt_tokens": n_in, "error": f"{type(err).__name__}: {err}"}
        result["runs"].append(run)
        print(f"\n=== {label}: FAILED ===\n{run['error']}", flush=True)
        return run
    secs = time.time() - t0
    full = tokenizer.decode(outputs[0], skip_special_tokens=True)
    new_only = tokenizer.decode(outputs[0][n_in:], skip_special_tokens=True).strip()
    run = {
        "label": label, "seed": seed, "prompt_tokens": n_in, "new_tokens": int(outputs.shape[1] - n_in),
        "seconds": round(secs, 1), "card_extract": full.split(":")[-1].strip(), "new_text": new_only,
    }
    result["runs"].append(run)
    print(f"\n=== {label} (seed {seed}): {n_in} prompt tokens, {run['new_tokens']} new, {secs:.1f}s ===\n{new_only or '(nothing generated)'}", flush=True)
    return run


# A. The model card's own prompt and call, unchanged.
prompt_card = f"Summarize the following medical text for a general audience: {report}"
generate(prompt_card, "A. model card prompt + model card call (max_length=150)", 0, card_exact=True)

# A2. Same prompt, but room to write (max_length=150 counts the prompt, which is already longer than that).
for seed in (0, 1):
    generate(prompt_card, "A2. model card prompt, max_new_tokens=160", seed, max_new_tokens=160)

# B. The task as asked: plain English, under 120 words, the four parts.
ask = (
    "Write a plain-language summary of this chest X-ray report for a patient, in plain English, "
    "under 120 words, with exactly these four parts: "
    "What we found / What it means / What happens next / When to seek help sooner. "
    "Use only what is in the report."
)
prompt_four = f"Summarize the following medical text for a general audience: {ask}\n\nReport:\n{report}\n\nSummary:\n"
for seed in (0, 1, 2):
    generate(prompt_four, "B. four-part instruction", seed, max_new_tokens=200)


# C. Repeatable run (no sampling) of the same four-part request.
generate(prompt_four, "C. four-part instruction, greedy (no sampling)", 0, max_new_tokens=200, sample=False)

# Is the adapter really doing something? Same prompt, adapter on and off: the next-word scores must differ.
inputs = tokenizer(prompt_card, return_tensors="pt", truncation=True, max_length=512)
inputs = {k: v.to(model.device) for k, v in inputs.items()}
with torch.no_grad():
    on = model(**inputs).logits[0, -1].float().cpu()
    with model.disable_adapter():
        off = model(**inputs).logits[0, -1].float().cpu()
result["adapter_check"] = {"max_abs_logit_difference_adapter_on_vs_off": round(float((on - off).abs().max()), 3),
                           "same_top_word": bool(on.argmax() == off.argmax())}
print("adapter check:", result["adapter_check"], flush=True)

# ----------------------------------------------------------------- simple readability numbers
def syllables(word):
    word = re.sub(r"[^a-z]", "", word.lower())
    if not word:
        return 0
    groups = re.findall(r"[aeiouy]+", word)
    n = len(groups) - (1 if word.endswith("e") and len(groups) > 1 else 0)
    return max(1, n)


def stats(text):
    words = re.findall(r"[A-Za-z][A-Za-z'-]*", text)
    sentences = max(1, len(re.findall(r"[.!?]+(\s|$)", text)))
    syl = sum(syllables(w) for w in words)
    fk = 0.39 * len(words) / sentences + 11.8 * syl / max(1, len(words)) - 15.59 if words else 0
    return {"words": len(words), "fk_grade": round(fk, 1)}


azure_text = " ".join(case["azureEnglish"][k] for k in ("found", "meaning", "next", "help"))
result["azure_stats"] = stats(azure_text)
for run in result["runs"]:
    if "new_text" in run:
        run["stats"] = stats(run["new_text"])
json.dump(result, open(OUT, "w"), ensure_ascii=False, indent=2)
print("\nwrote", OUT)
print("azure:", result["azure_stats"])
