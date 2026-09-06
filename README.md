# RadAssist AI Frontend

AI-assisted X-ray reporting app for radiologists. The frontend is React + Vite
+ Tailwind. The backend is Express + Mongoose against Azure Cosmos DB, with a
FastAPI middleware (in `~/Desktop/fyp/`) that wraps `mlx_vlm` for the actual
image → report generation.

## Run locally

Two processes, two terminals:

### Terminal 1 — backend

```sh
cd backend
npm install            # only first time
npm run seed           # only if MongoDB is empty (populates users + demo cases)
node server.js         # or `npm run dev` for nodemon auto-reload
```

Backend listens on **port 5002** by default (see `backend/.env`).

### Terminal 2 — frontend

```sh
npm install            # only first time
npm run dev
```

Open the Vite URL (usually `http://localhost:5173`).

### Terminal 3 — AI middleware (optional, only needed for new uploads)

The backend POSTs uploaded X-rays to `AI_BASE_URL` (from `backend/.env`).
Start the FastAPI server that wraps `mlx_vlm` separately.  See
`~/Desktop/fyp/start_server.sh`.

## Demo sign-in

Backend verifies passwords with bcrypt, so the exact seeded values are
required. If the database is empty, run `npm run seed` from the `backend/`
folder first (this populates users, sample cases, and audit log entries).

- **Admin:** `admin` / `admin123`
- **Doctor:** `doctor` / `doctor123`
- **Nurse:** `nurse` / `nurse123`

## Architecture

```
┌──────────────┐    X-ray + metadata    ┌──────────────────────┐
│   React UI   │ ─────────────────────► │   Express backend    │
│  (Vite dev)  │                        │   (Node, Mongoose)   │
│  port 5173   │ ◄───── case JSON ───── │   port 5002          │
└──────────────┘                        └──────────┬───────────┘
                                                   │ store + load
                                                   ▼
                                        ┌──────────────────────┐
                                        │   Azure Cosmos DB    │
                                        │   (MONGODB_URI)      │
                                        └──────────────────────┘
                                                   ▲
                                        ┌──────────┴───────────┐
                                        │   AI report fetcher  │
                                        │   (FastAPI / mlx_vlm)│
                                        │   AI_BASE_URL        │
                                        └──────────────────────┘
```

- **`src/components/review.js`** — the "View" page. Renders the X-ray, AI
  findings as cards, and the editable Final report textarea. See "How the AI
  report is rendered" below.
- **`backend/controllers/caseController.js`** — CRUD for cases. `getCase`,
  `updateCase`, `finalizeCase`, `deleteCase` all fall back to a raw Mongo
  `_id` lookup when the `caseId` lookup misses, so legacy/orphan records are
  still retrievable from the UI.
- **`backend/utils/aiService.js`** — talks to the FastAPI middleware,
  validates the response, and unwraps the `{"report": "..."}` envelope.

## How the AI report is rendered (the "View" page)

`renderReviewPage` in `src/components/review.js` does:

1. **`unwrapLegacyReport(localCase)`** — strips the `{"report": "..."}`
   wrapper if the stored `reportText` is still in the legacy shape. (Only
   matters for cases created before the AI service fix; the fix-legacy-reports
   script migrated all of them.)
2. **`parseFindingsFromReport(reportText, existingCount)`** — splits the
   markdown report into individual finding cards with `label`, `confidence`,
   `bbox`, `location`, `size`, `pattern`, `sentence`, `status: "pending"`,
   `source: "AI"`. Heuristics: numbered headers (`1. ...`, `**Finding N:**`),
   section headers (`###FINDINGS###`), sentence fallback. De-dups near-identical
   blocks. Caps at 6 AI findings.
3. **`maybeAutoFillFromReport(...)`** — runs once per page-open. If the case
   has 0 user findings yet, parses the report and seeds the list with AI
   findings (pending status; the doctor still has to accept/reject each one).
4. Renders: left = X-ray image (with loading / no-image placeholder), right
   = findings cards (each with accept/reject buttons), bottom = Final report
   textarea (editable, `<textarea value={localCase.reportText} />`).

## One-shot data-fix scripts

Run from `backend/`. Both default to **dry-run**; pass `--apply` to write.

- **`node scripts/fix-legacy-reports.js`** — finds cases whose `reportText`
  is the legacy `{"report":"..."}` shape and strips the wrapper, leaving
  clean markdown. (Already run against this DB: 6 cases migrated.)
- **`node scripts/fix-data-issues.js`** — (a) sets `findings: []` on cases
  where the field is missing/null; (b) clears `imageId` on cases whose
  GridFS file is missing (orphan references). (Already run: 3 + 7 cases
  normalized.)
- **`node scripts/dump-cases.js`** — read-only diagnostic. Prints every
  case's `caseId`, `patientId`, status, finding count, report length, and
  the first 80 chars of the report (with a ⚠️ flag for any remaining legacy
  JSON wrapper).

## Tests

```sh
# Pure-function unit tests for the view page's AI-report handling.
# Covers unwrapLegacyReport, parseFindingsFromReport, de-dup, confidence,
# sentence fallback, end-to-end pipeline.
node scripts/test-review-logic.mjs           # 14 tests, all pass

# End-to-end test against the running backend on port 5002.
# Logs in as admin, lists every case via /api/cases, then for each case:
#   - GET /api/cases/:id returns 200
#   - reportText is clean (no JSON wrapper)
#   - findings is a valid array
#   - image URL is reachable (or correctly skipped when no imageId)
node scripts/test-e2e-case.mjs               # 16 cases × 4 checks = 64 pass
```

## Environment

- `backend/.env` — `PORT`, `MONGODB_URI`, `MONGODB_DB`, `AI_BASE_URL`,
  `JWT_SECRET`, `FRONTEND_URL`. Never commit this file.
- `.env`, `node_modules`, `uploads`, and `dist` are in `.gitignore`.

## Security reminder

Never commit `.env`. The seed users above (`admin/admin123`, etc.) are for
local development only; rotate them in any deployed environment.
