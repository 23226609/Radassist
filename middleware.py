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

# CURV-main trains on this system text plus the user line below.
# An image with no text makes this checkpoint reply that it cannot see a film.
CURV_SYSTEM_PROMPT = """You are a medical expert tasked with generating a detailed radiology report based on the provided medical image. Analyze the image carefully and produce a structured report using the following tagged sections: <findings>, <thinking>, and <impression>. Follow these guidelines for each section:

- <findings>: Describe only observable features in the image, such as abnormalities, anatomical structures, or notable patterns. Be precise and avoid speculation.

- <thinking>: Provide a logical reasoning process based on the findings, considering possible diagnoses or clinical implications.

- <impression>: Summarize the key takeaways and suggest next steps or potential diagnoses in a concise manner.


Output Format:

<findings>  Detailed description of image observations </findings>

<thinking> Reasoning based on findings </thinking>

<impression> Concise summary and recommendations </impression>"""

CURV_USER_TEXT = (
    "Please analyze this chest X-ray image and generate a detailed radiology report "
    "following the specified format."
)

_CURV_SECTION = re.compile(
    r"<(findings|thinking|impression)>\s*(.*?)\s*</\1>",
    re.IGNORECASE | re.DOTALL,
)


def _format_curv_report(text: str) -> str:
    """Turn CURV's tagged reply into the three sections the review page shows."""
    found = {}
    for match in _CURV_SECTION.finditer(text or ""):
        body = _plain_text(match.group(2))
        if body:
            found[match.group(1).lower()] = body
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


def _ai_analyze(image_path: str) -> dict:
    """Send the official CURV system text, the user line, and the resized film.

    Returns {"report": str, "findings": list}. `findings` is always empty:
    the review page parses cards from the report text.
    """
    payload = {
        "model": MODEL_PATH,
        "messages": [
            {"role": "system", "content": CURV_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": CURV_USER_TEXT},
                    {"type": "input_image", "image_url": image_path},
                ],
            },
        ],
        "max_tokens": 1536,
        # mlx_vlm defaults to greedy decoding with no repetition penalty, which
        # lets this 3B model fall into "No Evidence of X" loops that run to the
        # token cap. A mild penalty keeps it stopping on its own.
        "temperature": 0.2,
        "top_p": 0.9,
        "repetition_penalty": 1.12,
        "repetition_context_size": 512,
    }
    response = requests.post(MLX_VLM_SERVER, json=payload, timeout=180)
    response.raise_for_status()
    result = response.json()
    content = result["choices"][0]["message"]["content"]
    deduped = _dedupe_report(content)
    report = _format_curv_report(deduped) or _tidy_report(_plain_text(deduped))
    return {"report": report, "findings": []}


# Sentence boundary: a ., ! or ? followed by whitespace.
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")
# Leading list marker / bullet on a line, captured so we can re-attach it.
_LINE_PREFIX = re.compile(r"^(\s*(?:[-+*\u2022]\s+|\d+[.)]\s+)?)")


def _compare_key(text: str) -> str:
    """Collapse a sentence to a comparable form: no markdown, casing or numbering."""
    key = re.sub(r"^\s*\d+[.)]\s*", "", text.lower())
    key = re.sub(r"[#*_`]", "", key)
    key = re.sub(r"[^a-z0-9 ]", " ", key)
    return re.sub(r"\s+", " ", key).strip()


def _is_heading(line: str) -> bool:
    """True for markdown headings and label-only lines such as `**Lungs:**`."""
    stripped = line.strip()
    if stripped.startswith("#"):
        return True
    return stripped.endswith(":") and len(stripped) < 100


def _dedupe_report(text: str) -> str:
    """Drop sentences the model already emitted.

    A repetition penalty stops most loops at generation time, but a truncated
    or partially looping response can still reach us. Keeping the first
    occurrence of each sentence preserves reading order and never invents text.
    Headings are dropped when everything beneath them was a duplicate.
    """
    text = (text or "").strip()
    if not text:
        return ""

    seen = set()
    lines = []
    headings = []      # headings waiting for surviving content beneath them
    all_dropped = False  # every body line since the last heading was a duplicate

    for raw in text.splitlines():
        if not raw.strip():
            if lines and lines[-1] != "":
                lines.append("")
            continue

        if _is_heading(raw):
            # The previous heading introduced nothing but duplicates, so it
            # would otherwise be emitted with no body under it.
            if all_dropped and headings:
                headings.pop()
                all_dropped = False
            headings.append(raw)
            continue

        prefix = _LINE_PREFIX.match(raw).group(1)
        body = raw[len(prefix):]

        kept = []
        for sentence in _SENTENCE_SPLIT.split(body):
            key = _compare_key(sentence)
            # Very short fragments carry too little signal to call duplicates.
            if len(key) < 12:
                kept.append(sentence)
                continue
            if key in seen:
                continue
            seen.add(key)
            kept.append(sentence)

        if not kept:
            all_dropped = True
            continue

        for pending in headings:
            heading_key = _compare_key(pending)
            if heading_key not in seen:
                seen.add(heading_key)
                lines.append(pending)
        headings.clear()
        all_dropped = False

        lines.append(prefix + " ".join(kept))

    return "\n".join(lines).strip()


# A markdown horizontal rule: "---", "***", "___" and friends.
_HORIZONTAL_RULE = re.compile(r"^\s*(?:[-*_]\s*){3,}$")
# Emphasis wrapping a run of text, e.g. *stat* — guarded so it ignores a
# leading "* " bullet and any stray asterisk inside a word.
_EMPHASIS = re.compile(r"(?<![\w*])([*_])(\S(?:[^*_]*\S)?)\1(?![\w*])")


def _plain_text(text: str) -> str:
    """Turn the model's markdown into clean prose for the stored report.

    Clinicians read and edit this in a plain textarea, so `#` and `**` would
    show up literally. Numbering and `-` bullets are deliberately kept: they
    carry the report's structure and the review page parses them into finding
    cards (see parseFindingsFromReport in review.js).
    """
    stripped = []
    for raw in (text or "").splitlines():
        if _HORIZONTAL_RULE.match(raw):
            continue
        line = raw.replace("**", "").replace("__", "")
        line = re.sub(r"^(\s*)#{1,6}\s*", r"\1", line)   # heading marks
        line = _EMPHASIS.sub(r"\2", line)
        line = line.replace("`", "")
        line = re.sub(r"^(\s*)[*+]\s+", r"\1- ", line)   # normalise bullets to "-"
        stripped.append(line.rstrip())

    # Removing rules and headings can leave runs of blank lines behind.
    out = []
    for line in stripped:
        if not line.strip() and out and not out[-1].strip():
            continue
        out.append(line)
    return "\n".join(out).strip()


_SCAFFOLD_HEAD = re.compile(
    r"(?i)^(?:header|radiology report|frontal chest x-?ray)\s*:?\s*$"
)
_COMPARISON_HEAD = re.compile(
    r"(?i)^(?:frontal chest x-?ray\s*)?(?:comparison of (?:the )?two hemithoraces)\s*:?\s*$"
)
_HEMI_LINE = re.compile(
    r"(?i)^(?:[-*]\s*)?(?:left|right)\s+hemithorax\s*:"
)
_FINDING_SIGNAL = re.compile(
    r"(?i)\b(?:opacif|white-?out|opaque (?:right|left) hemithorax|"
    r"consolidation|pneumonia|atelectasis)\b"
)
_NO_ACUTE = re.compile(
    r"(?i)\b(?:no (?:evidence|signs?) of acute cardiopulmonary|"
    r"no acute cardiopulmonary|"
    r"(?:the )?lungs? (?:are|appear) (?:clear|normal))\b"
)
_NO_ACUTE_TAIL = re.compile(
    r"(?i)\s*,?\s*(?:and\s+)?there is no (?:evidence|signs?) of acute cardiopulmonary.*$"
)
_PRIOR_CLAUSE = re.compile(
    r"(?i)(?:\s*,?\s*)?(?:given its location and appearance )?on prior studies"
    r"|(?:\s*,?\s*)?(?:compared with|compared to) previous "
    r"(?:imaging|studies|films|examinations)[^.]*"
)


def _tidy_report(text: str) -> str:
    """Drop prompt scaffolding and a stock 'no acute disease' closer.

    The left/right check is only to stop a normal-chest template. If it leaks
    into the saved report, clinicians see a worksheet instead of a draft.
    The 3B model also names an opacity and then denies acute disease in the
    next sentence; keep the finding, drop the contradiction.
    """
    text = (text or "").strip()
    if not text:
        return ""

    kept = []
    skip_hemi = False
    for raw in text.splitlines():
        line = raw.rstrip()
        if _COMPARISON_HEAD.match(line.strip()) or _SCAFFOLD_HEAD.match(line.strip()):
            if _COMPARISON_HEAD.match(line.strip()):
                skip_hemi = True
            continue
        if skip_hemi:
            if not line.strip() or _HEMI_LINE.match(line.strip()):
                continue
            skip_hemi = False
            if _is_heading(line):
                kept.append(line)
                continue
        kept.append(line)

    body = "\n".join(kept)
    cleaned = []
    drop_no_acute = bool(_FINDING_SIGNAL.search(body))
    for raw in body.splitlines():
        prefix = _LINE_PREFIX.match(raw).group(1)
        parts = []
        for sentence in _SENTENCE_SPLIT.split(raw[len(prefix):]):
            clipped = _PRIOR_CLAUSE.sub("", sentence)
            clipped = _NO_ACUTE_TAIL.sub("", clipped).strip(" ,")
            if not clipped:
                continue
            if drop_no_acute and _NO_ACUTE.search(clipped):
                continue
            parts.append(clipped)
        if not parts:
            if _is_heading(raw) and not _SCAFFOLD_HEAD.match(raw.strip()):
                cleaned.append(raw)
            continue
        cleaned.append(prefix + " ".join(parts))

    out = []
    for line in cleaned:
        if not line.strip() and out and not out[-1].strip():
            continue
        out.append(line)
    return "\n".join(out).strip()


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
        model_path = _resize_for_curv(save_path)
        ai_result = _ai_analyze(model_path)
        report_text = ai_result.get("report", "")
        findings = ai_result.get("findings", [])
    except requests.exceptions.RequestException as e:
        ai_error = f"AI server error: {e}"
    except Exception as e:  # noqa: BLE001
        ai_error = f"Unexpected AI error: {e}"
    finally:
        for path in (model_path, save_path):
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