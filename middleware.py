# middleware.py
"""
RadAssist AI middleware
- Receives X-Ray uploads from the React frontend
- Stores the image in MongoDB (Azure Cosmos DB) via GridFS
- Forwards the image to a local mlx_vlm server for AI analysis
- Persists the report text + structured findings alongside the image in MongoDB
- Serves stored images back to the frontend via /images/<id>
"""

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import shutil
import os
import io
import uuid
import re
import requests
from datetime import datetime
from pymongo import MongoClient
import gridfs

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MONGO_URI = (
    "mongodb://east-phy-23226609:XcEAYt3kDZJQszW2qjsxTXDfocYhDosxs2WKidgvVtcfebz3k8KwzNBTXwZaCU9U2k9rzZ3sTkzvACDbvYAR9Q=="
    "@east-phy-23226609.mongo.cosmos.azure.com:10255/?ssl=true&replicaSet=globaldb"
    "&retrywrites=false&maxIdleTimeMS=120000&appName=@east-phy-23226609@"
)
DB_NAME = "radassist"

# Local mlx_vlm server (see start_server.sh)
MLX_VLM_SERVER = "http://localhost:8080/chat/completions"
MODEL_PATH = "/Users/PHY/CURV-mlx"

# Temporary scratch dir for the file we hand to the AI server
UPLOAD_DIR = os.path.expanduser("~/curv_uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# Database wiring
# ---------------------------------------------------------------------------

mongo_client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
db = mongo_client[DB_NAME]
fs = gridfs.GridFS(db)
cases_col = db["cases"]

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

def _build_prompt(patient_id: str = "", age: str = "", sex: str = "", history: str = "") -> str:
    """The plain report instruction the CURV fine-tune was trained to answer.

    Asking this model for JSON pushes it outside its training distribution and
    it starts looping, so we ask for the report in its native form and let the
    frontend derive findings from the text. Real patient details are supplied
    so the model fills the header instead of inventing a clinical history.
    """
    prompt = "Generate a detailed radiology report for this chest X-ray."

    details = [
        ("Patient ID", patient_id),
        ("Age", age),
        ("Sex", sex),
        ("Clinical History", history),
    ]
    known = [f"{label}: {value.strip()}" for label, value in details if value and value.strip()]
    if known:
        prompt += (
            "\n\nUse exactly these patient details in the report header. "
            "Do not invent any other patient details or clinical history.\n"
            + "\n".join(known)
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
                    {"type": "text", "text": _build_prompt(patient_id, age, sex, history)},
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

    return {"report": _dedupe_report(content), "findings": []}


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


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    mongo_ok = False
    try:
        mongo_client.admin.command("ping")
        mongo_ok = True
    except Exception:
        pass
    return {"status": "middleware running", "mongo": mongo_ok}


@app.post("/analyze")
async def analyze_xray(
    file: UploadFile = File(...),
    # Optional so the standalone index.html test page, which posts only the
    # file, can still call this endpoint directly.
    patientId: str = Form(""),
    age: str = Form(""),
    sex: str = Form(""),
    history: str = Form(""),
):
    # 1. Save the upload to a scratch path so the AI server can read it
    file_ext = os.path.splitext(file.filename or "")[1] or ".jpg"
    unique_name = f"{uuid.uuid4().hex}{file_ext}"
    save_path = os.path.join(UPLOAD_DIR, unique_name)
    contents = await file.read()
    with open(save_path, "wb") as f:
        f.write(contents)

    # 2. Stash the image bytes in MongoDB GridFS
    file_id = fs.put(
        contents,
        filename=file.filename or unique_name,
        content_type=file.content_type or "image/jpeg",
        patientId=patientId,
    )

    # 3. Ask the AI for a report + structured findings
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

    # 4. Persist the case document
    case_id = str(uuid.uuid4())
    doc = {
        "_id": case_id,
        "patientId": patientId,
        "age": age,
        "sex": sex,
        "history": history,
        "reportText": report_text,
        "findings": findings,
        "imageId": str(file_id),
        "imageFilename": file.filename,
        "status": "completed",
        "createdAt": datetime.utcnow(),
    }
    cases_col.insert_one(doc)

    return {
        "id": case_id,
        "patientId": patientId,
        "report": report_text,
        "findings": findings,
        "imageId": str(file_id),
        "imageUrl": f"/images/{file_id}",
    }


@app.get("/images/{image_id}")
async def get_image(image_id: str):
    try:
        oid = __import__("bson").ObjectId(image_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid image id")
    if not fs.exists(oid):
        raise HTTPException(status_code=404, detail="Image not found")
    grid_out = fs.get(oid)
    return StreamingResponse(
        io.BytesIO(grid_out.read()),
        media_type=grid_out.content_type or "image/jpeg",
    )


@app.get("/cases")
async def list_cases():
    items = []
    # Cosmos DB requires an index for any sorted field; we instead fetch in
    # natural order and sort client-side by createdAt when present.
    for doc in cases_col.find():
        items.append(doc)
    items.sort(
        key=lambda d: d.get("createdAt") or __import__("datetime").datetime.min,
        reverse=True,
    )
    for doc in items:
        doc["_id"] = str(doc["_id"])
        if doc.get("createdAt"):
            doc["createdAt"] = doc["createdAt"].isoformat()
        if "imageId" in doc:
            doc["imageUrl"] = f"/images/{doc['imageId']}"
    return {"cases": items}


@app.get("/cases/{case_id}")
async def get_case(case_id: str):
    doc = cases_col.find_one({"_id": case_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Case not found")
    if "imageId" in doc:
        doc["imageUrl"] = f"/images/{doc['imageId']}"
    if "createdAt" in doc and doc["createdAt"]:
        doc["createdAt"] = doc["createdAt"].isoformat()
    return doc