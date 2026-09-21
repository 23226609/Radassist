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

def _opaque_side_hint(image_path: str) -> str:
    """Cheap left/right brightness check so a white-out film cannot be ignored.

    CURV often never 'sees' a complete hemithorax white-out and emits the same
    bilateral-consolidation template for every chest film. If one lung field is
    much brighter (more white) than the other, tell the model which patient
    side that is. Standard PA/AP: the patient's RIGHT is on the VIEWER'S LEFT.
    """
    try:
        from PIL import Image
    except ImportError:
        return ""
    try:
        im = Image.open(image_path).convert("L")
    except Exception:
        return ""
    im.thumbnail((320, 320))
    w, h = im.size
    if w < 40 or h < 40:
        return ""
    field = im.crop((int(w * 0.08), int(h * 0.16), int(w * 0.92), int(h * 0.88)))
    fw, fh = field.size
    third = max(8, fw // 3)
    left_px = list(field.crop((0, 0, third, fh)).getdata())
    right_px = list(field.crop((fw - third, 0, fw, fh)).getdata())
    if not left_px or not right_px:
        return ""
    left_mean = sum(left_px) / len(left_px)
    right_mean = sum(right_px) / len(right_px)
    if abs(left_mean - right_mean) < 32:
        return ""
    if left_mean > right_mean:
        viewer, patient = "left", "right"
    else:
        viewer, patient = "right", "left"
    return (
        f"This image file is not symmetric: the viewer's {viewer} lung field is "
        f"much more opaque (white) than the other side. On a standard chest "
        f"X-ray that is the patient's {patient} hemithorax. Report a white-out / "
        f"complete opacification of the patient's {patient} hemithorax. Do not "
        f"call this bilateral lower-lobe consolidation."
    )


def _build_prompt(patient_id: str = "", age: str = "", sex: str = "",
                  history: str = "", film_hint: str = "") -> str:
    """The plain report instruction the CURV fine-tune was trained to answer.

    Asking this model for JSON pushes it outside its training distribution and
    it starts looping, so we ask for the report in its native form and let the
    frontend derive findings from the text. Real patient details are supplied
    so the model fills the header instead of inventing a clinical history.

    A bare "write a radiology report" cue makes this 3B checkpoint emit a stock
    "bilateral lower lobe consolidations" template for every film, including a
    complete hemithorax white-out. The first Findings sentence must name both
    sides or that template wins.
    """
    prompt = (
        "Look at this frontal chest X-ray. The patient's RIGHT is on YOUR LEFT. "
        "Write a standard radiology report for THIS film only. Start with the "
        "patient details, then Findings, then Conclusion. Do not add a section "
        "titled Header.\n\n"
        "The first sentence of Findings must say, for each side, whether the "
        "lung is DARK (air) or WHITE (opaque). "
        "If one whole hemithorax is white and the other is dark, that is a "
        "WHITE-OUT. Name the patient's side (right or left) in Findings and "
        "again in the Conclusion. "
        "Do not write 'bilateral lower lobe consolidations' unless BOTH lungs "
        "really show the same basal finding. "
        "Do not reuse a stock report from another patient."
    )
    if film_hint:
        prompt += "\n\n" + film_hint

    details = [
        ("Patient ID", patient_id),
        ("Age", age),
        ("Sex", sex),
        ("Clinical History", history),
    ]
    known = [f"{label}: {value.strip()}" for label, value in details if value and value.strip()]
    if known:
        prompt += (
            "\n\nUse exactly these patient details as the first lines of the report. "
            "Do not invent any other patient details, clinical history, "
            "or comparison with previous imaging.\n"
            + "\n".join(known)
        )

    prompt += (
        "\n\nAnswer the clinical history in Findings. If the history mentions "
        "a fall, trauma, or rib pain, comment on the ribs and bony thorax and "
        "say whether a pneumothorax is present. If you cannot see a fracture, "
        "say the ribs are not clearly fractured on this frontal film; do not "
        "replace that with a lung-only report. "
        "Never mention prior studies, old films, or comparison with previous imaging. "
        "Do not write that the lungs are clear or that there is no acute "
        "cardiopulmonary disease if you have named an opacity, white-out, "
        "consolidation, or pneumonia. "
        "End the report after the conclusion. Do not add a signature, date or "
        "any placeholder written in square brackets."
    )
    return prompt


def _ai_analyze(image_path: str, patient_id: str = "", age: str = "",
                sex: str = "", history: str = "") -> dict:
    """Send the image to the local mlx_vlm server.

    Returns {"report": str, "findings": list}. `findings` is always empty:
    the model cannot localise findings, so the review page parses them out of
    the report text instead (see parseFindingsFromReport in review.js).
    """
    payload = {
        "model": MODEL_PATH,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": _build_prompt(
                            patient_id, age, sex, history,
                            film_hint=_opaque_side_hint(image_path),
                        ),
                    },
                    {"type": "input_image", "image_url": image_path},
                ],
            }
        ],
        "max_tokens": 800,
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

    return {"report": _tidy_report(_plain_text(_dedupe_report(content))), "findings": []}


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
    try:
        ai_result = _ai_analyze(save_path, patient_id=patientId, age=age, sex=sex, history=history)
        report_text = ai_result.get("report", "")
        findings = ai_result.get("findings", [])
    except requests.exceptions.RequestException as e:
        ai_error = f"AI server error: {e}"
    except Exception as e:  # noqa: BLE001
        ai_error = f"Unexpected AI error: {e}"
    finally:
        if os.path.exists(save_path):
            try:
                os.remove(save_path)
            except OSError:
                pass

    if ai_error and not report_text:
        raise HTTPException(status_code=500, detail=ai_error)

    return {
        "report": report_text,
        "findings": findings,
    }