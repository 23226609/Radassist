# middleware.py
"""
RadAssist AI middleware

Called only by the Express backend (`POST {AI_BASE_URL}/analyze`).
Runs CURV via the local mlx_vlm server and returns `{ report, findings }`.

Does not write Mongo/GridFS — Express owns patients, cases, and images.
Legacy `/cases` and `/images` routes were removed so this process cannot
insert UUID `_id` documents that the dashboard then 404s on.
"""

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import math
import os
import uuid
import re
import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Local mlx_vlm server (see start_server.sh)
MLX_VLM_SERVER = "http://localhost:8080/chat/completions"
MODEL_PATH = "/Users/PHY/CURV-mlx"

# Temporary scratch dir for the file we hand to the AI server
UPLOAD_DIR = os.path.expanduser("~/curv_uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# Same budget as ~/CURV-mlx/preprocessor_config.json.
# The whole film is scaled to fit. Nothing is cropped.
CURV_MAX_PIXELS = 50176
CURV_MIN_PIXELS = 784
CURV_FACTOR = 28  # patch_size 14 * merge_size 2

# CURV-main/training/prompts/prompt_cxr.txt plus the user line in cxr_prompts.py.
# The film goes on the same user turn as an image, not as a file path in text.
# Age, sex, and history are not sent.
CURV_PROMPT_FILE = os.environ.get(
    "CURV_PROMPT_FILE",
    "/Users/PHY/Downloads/CURV-main/training/prompts/prompt_cxr.txt",
)
CURV_USER_TEXT = (
    "Please analyze this chest X-ray image and generate a detailed radiology report "
    "following the specified format."
)

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI()

# Permit the Vite dev server (any port) to call us during development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_CURV_SECTION = re.compile(
    r"<(findings|thinking|impression)>\s*(.*?)\s*</\1>",
    re.IGNORECASE | re.DOTALL,
)


def _format_curv_report(text: str) -> str:
    """Turn CURV's tagged reply into the three sections the review page shows."""
    found = {}
    for match in _CURV_SECTION.finditer(text or ""):
        key = match.group(1).lower()
        body = match.group(2).strip()
        if body and key not in found:
            found[key] = body
    if not found.get("findings") and not found.get("impression"):
        return ""
    parts = []
    for key, title in (("findings", "Findings"), ("thinking", "Thinking"), ("impression", "Impression")):
        if found.get(key):
            parts.append(f"{title}:\n{found[key]}")
    return "\n\n".join(parts)


def _curv_target_size(width: int, height: int) -> tuple:
    """Size the whole frame down to CURV's pixel budget, keeping the aspect ratio."""
    factor = CURV_FACTOR
    h_bar = round(height / factor) * factor
    w_bar = round(width / factor) * factor
    if h_bar * w_bar > CURV_MAX_PIXELS:
        beta = math.sqrt((height * width) / CURV_MAX_PIXELS)
        h_bar = max(factor, math.floor(height / beta / factor) * factor)
        w_bar = max(factor, math.floor(width / beta / factor) * factor)
    elif h_bar * w_bar < CURV_MIN_PIXELS:
        beta = math.sqrt(CURV_MIN_PIXELS / (height * width))
        h_bar = math.ceil(height * beta / factor) * factor
        w_bar = math.ceil(width * beta / factor) * factor
    return int(w_bar), int(h_bar)


def _looks_like_dicom(image_path: str) -> bool:
    if image_path.lower().endswith(".dcm"):
        return True
    try:
        with open(image_path, "rb") as handle:
            handle.seek(128)
            return handle.read(4) == b"DICM"
    except OSError:
        return False


def _first_float(value, default=None):
    if value is None or value == "":
        return default
    if isinstance(value, (list, tuple)):
        return _first_float(value[0], default) if value else default
    text = str(value).split("\\")[0]
    try:
        return float(text)
    except (TypeError, ValueError):
        return default


def _render_dicom(image_path: str) -> str:
    """Render DICOM pixels to a PNG. CURV cannot read a DICOM container."""
    import numpy as np
    import pydicom
    from PIL import Image

    dataset = pydicom.dcmread(image_path)
    if not hasattr(dataset, "PixelData"):
        raise ValueError("This DICOM has no pixel data.")
    try:
        arr = np.asarray(dataset.pixel_array)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(
            "This DICOM uses compressed pixels. Export an uncompressed chest film, or upload a PNG."
        ) from exc
    if arr.ndim == 3 and arr.shape[-1] not in (3, 4):
        arr = arr[0]
    elif arr.ndim == 4:
        arr = arr[0]
    rgb = arr.ndim == 3 and arr.shape[-1] in (3, 4)
    if not rgb:
        arr = arr.astype("float32")
        slope = _first_float(getattr(dataset, "RescaleSlope", 1), 1.0)
        intercept = _first_float(getattr(dataset, "RescaleIntercept", 0), 0.0)
        arr = arr * slope + intercept
        center = _first_float(getattr(dataset, "WindowCenter", None), None)
        width = _first_float(getattr(dataset, "WindowWidth", None), None)
        if center is not None and width is not None and width > 0:
            low = center - width / 2
            high = center + width / 2
            arr = (arr - low) / (high - low)
        else:
            low = float(arr.min())
            high = float(arr.max())
            arr = (arr - low) / (high - low) if high > low else np.zeros_like(arr)
        arr = np.clip(arr, 0, 1)
        if str(getattr(dataset, "PhotometricInterpretation", "")).upper() == "MONOCHROME1":
            arr = 1 - arr
        frame = Image.fromarray((arr * 255).astype("uint8"), mode="L").convert("RGB")
    else:
        frame = Image.fromarray(arr[:, :, :3].astype("uint8")).convert("RGB")
    out_path = os.path.splitext(image_path)[0] + "-film.png"
    frame.save(out_path, format="PNG")
    return out_path


def _resize_for_curv(image_path: str) -> str:
    """Write a resized copy of the whole film. The caller's original file is left as-is."""
    from PIL import Image

    with Image.open(image_path) as im:
        frame = im.convert("RGB")
        width, height = frame.size
        target_w, target_h = _curv_target_size(width, height)
        if (width, height) != (target_w, target_h):
            frame = frame.resize((target_w, target_h), Image.Resampling.BICUBIC)
        out_path = os.path.splitext(image_path)[0] + "-curv.png"
        frame.save(out_path, format="PNG")
    return out_path


def _curv_system_prompt() -> str:
    with open(CURV_PROMPT_FILE, "r", encoding="utf-8") as handle:
        text = handle.read().strip()
    if not text:
        raise RuntimeError(f"CURV prompt file is empty: {CURV_PROMPT_FILE}")
    return text


def _ai_analyze(image_path: str) -> dict:
    """Send the CURV-main conversation: system text, user line, and the film.

    Returns {"report": str, "findings": list}. `findings` is always empty:
    the review page parses cards from the report text.
    """
    payload = {
        "model": MODEL_PATH,
        "messages": [
            {"role": "system", "content": _curv_system_prompt()},
            {
                "role": "user",
                "content": [
                    {"type": "input_image", "image_url": image_path},
                    {"type": "text", "text": CURV_USER_TEXT},
                ],
            },
        ],
        # CURV-main GRPO max_completion_length.
        "max_tokens": 1536,
        # ~/CURV-mlx/generation_config.json: greedy, repetition_penalty 1.05.
        "temperature": 0.0,
        "repetition_penalty": 1.05,
    }
    response = requests.post(MLX_VLM_SERVER, json=payload, timeout=180)
    response.raise_for_status()
    result = response.json()
    content = result["choices"][0]["message"]["content"] or ""
    report = _format_curv_report(content) or content.strip()
    return {"report": report, "findings": []}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    mlx_ok = False
    try:
        response = requests.get("http://localhost:8080/", timeout=2)
        mlx_ok = response.status_code < 500
    except requests.RequestException:
        pass
    return {"status": "middleware running", "mlx_vlm": mlx_ok}


@app.post("/analyze")
async def analyze_xray(
    file: UploadFile = File(...),
    patientId: str = Form(""),
    age: str = Form(""),
    sex: str = Form(""),
    history: str = Form(""),
):
    file_ext = os.path.splitext(file.filename or "")[1] or ".jpg"
    unique_name = f"{uuid.uuid4().hex}{file_ext}"
    save_path = os.path.join(UPLOAD_DIR, unique_name)
    contents = await file.read()
    with open(save_path, "wb") as f:
        f.write(contents)

    report_text = ""
    findings = []
    ai_error = None
    model_path = None
    try:
        # The official CURV template does not take age, sex, or history.
        # Those stay on the patient chart. The form fields are still accepted.
        _ = (patientId, age, sex, history)
        film_path = _render_dicom(save_path) if _looks_like_dicom(save_path) else save_path
        model_path = _resize_for_curv(film_path)
        ai_result = _ai_analyze(model_path)
        report_text = ai_result.get("report", "")
        findings = ai_result.get("findings", [])
    except requests.exceptions.RequestException as e:
        ai_error = f"AI server error: {e}"
    except Exception as e:  # noqa: BLE001
        ai_error = f"Unexpected AI error: {e}"
    finally:
        for path in (model_path, locals().get("film_path"), save_path):
            if path and os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass

    if ai_error and not report_text:
        raise HTTPException(status_code=500, detail=ai_error)

    return {
        "report": report_text,
        "findings": findings,
    }