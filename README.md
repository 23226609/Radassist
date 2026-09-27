# RadAssist AI

Clinician-in-the-loop chest X-ray reporting for a final-year project, presented in a hospital CMS-style shell.

A **technician** uploads the film. A **radiologist** opens the case, clicks **Use AI**, reviews and edits finding cards, then finalizes. A referring **doctor** can only read finalized reports. An **admin** can do radiologist work plus user, audit, and bulk-delete administration.

This is a **demonstration system**, not a clinical product. Findings and reports are decision support. A human must always review them.

The browser chrome follows the COMP4126 CMS mock (navy title bar, permanent **MODULES** column, gray Windows-style inner windows). Bed management is not included. The X-ray workflow is unchanged: upload does **not** start AI.

---

## What you get

| Layer | Stack | Default URL |
| --- | --- | --- |
| UI | Vanilla JS, Vite 8, Tailwind 3 | http://localhost:5173 |
| API | Express 4, Mongoose 8, JWT | http://localhost:5002 |
| Database | Azure Cosmos DB (Mongo API) + GridFS | `MONGODB_URI` |
| Local vision model | FastAPI middleware → `mlx_vlm` (CURV) | http://localhost:8001 → :8080 |
| Optional NLP | Azure OpenAI for diagnosis labels + finding cards | env flags |

The UI is **not React**. Pages are plain modules that build DOM with `src/dom.js` and re-render through a small pub/sub store in `src/state.js`.

---

## Architecture

```
 Browser (Vite :5173)
        │  relative /api  (proxied in dev)
        ▼
 Express API (:5002)
        │
        ├─ JWT auth / role checks
        ├─ Patients, clinical chart, cases, remarks, urgent flags
        ├─ Audit log
        ├─ GridFS images
        │
        ├──────────────► Cosmos DB (Mongo API)
        │
        ├──────────────► FastAPI middleware (:8001)   [only after Use AI]
        │                      │
        │                      ▼
        │                 mlx_vlm CURV server (:8080)
        │
        └──────────────► Azure OpenAI (optional)
                         diagnosis + finding boxes
```

**On upload** (`POST /api/cases`), the backend stores the image in GridFS and saves the case with `analysisState: none`. AI is **not** started.

**On Use AI** (`POST /api/cases/:id/analyze`), a radiologist (or admin) starts CURV in the background. The API returns immediately; the worklist/review overlay polls until `analysisState: done`. If CURV is down, the case stays stored so the radiologist can write the report by hand.

**On review**, the page shows stored findings as a **point-form list**, with the selected row opened as an editable card bound to the box on the film. While the report is still a draft, an **AI vs manual attribution log** is visible. After finalize, that log is kept in the system but **stripped from the report body** the referring doctor and share/export views see.

---

## Roles

| Action | Technician | Radiologist | Doctor (referring) | Admin |
| --- | --- | --- | --- | --- |
| Sign in, browse patients / finalized cases | yes | yes | yes | yes |
| See draft / pending-approve cases | own uploads | yes | no | yes |
| Upload X-ray (`POST /api/cases`) | yes | no | no | yes |
| Add / edit patient chart (vitals, labs, meds, notes) | yes | yes | read-only | yes |
| Click **Use AI**, edit findings / remarks, finalize | no | yes | no | yes |
| Mark or remove **Urgent** | no (can see the tag) | yes | no | yes |
| Share a finalized report (public link) | no | yes | no | yes |
| Read finalized report / export Word or PDF | no | yes | yes | yes |
| Browse audit log | no | yes | no | yes |
| Enable / disable user accounts | no | no | no | yes |
| Delete cases, patients, audit rows | no | no | no | yes |

Legacy `nurse` accounts are treated as **technician**.

Public `POST /api/auth/register` exists for demo signup. Treat that as demo-only.

---

## CMS layout

Modelled on [COMP4126 CMS mock](https://ug-cs-hkbu.github.io/COMP4126_CMS_mock/):

- Navy title bar (`#003366`) — “Clinical Management System · RadAssist”, user, role, department, Sign out
- Permanent **MODULES** sidebar (gray `#d4d0c8` / `#ece9d8` inner windows)
- Status footer with “demonstration data only”

| Sidebar group | Module | Page |
| --- | --- | --- |
| Index | Patient Master | `patients` |
| Ward | Sepsis Monitor | `monitor` |
| Ward | Lab Orders & Results | `labs` |
| Ward | Medication Chart (eMAR) | `meds` |
| Ward | Nursing / Care Notes | `notes` |
| Imaging | X-ray Worklist | `dashboard` |
| Imaging | Upload X-ray | `new` (technician / admin) |
| Imaging | Case archive | `cases` |
| Admin | Audit log | `audit` (radiologist / admin) |
| Admin | Users | `users` (admin) |

Bed management is intentionally omitted.

---

## Data model

### Patient

Stored in `patients`. A patient can exist **before** any X-ray.

- Identity: `patientId` (e.g. `PT-2026-0018`), `firstName`, `middleName`, `lastName`, `name`
- Demographics: `age`, `sex`, `history`, `remarks` (chart notes, never copied into a case report)
- Chart extras: `medicines`, `heartRate`, `labResults`
- Ward context (display only; no bed-management UI): `ward`, `bed`, `admissionStatus`
- Clinical sub-records: `observations[]`, `labOrders[]`, `medOrders[]`, `careNotes[]`

Deleting a **patient** removes the chart, every study for that ID, and GridFS images. Deleting a **case** removes that study and its image; the patient chart stays.

### Case

Stored in `cases`. One study / one film.

- Identity: `caseId`, `patientId`, name parts + `patientName`
- Clinical: `age`, `sex`, `history`, `diagnosis`, `diagnosisSource` (`azure` or `local`)
- Report: `reportText`, `remarks`, `findings[]`
- AI: `analysisState` (`none` \| `running` \| `done`)
- Draft provenance: `editLog[]` (`kind`: `ai` \| `manual`). Shown on Review while drafting; **not** included in finalized / shared / exported report text
- Workflow: `status` (`pending` awaiting or generating \| `pending_approve` draft ready \| `finalized`) and `urgent`. Old documents may still say `completed` — the UI treats that as pending approve
- Image: `imageId` (GridFS), filename / type / size
- People: `createdBy`, `createdByName` (uploader), `finalizedBy`, `finalizedByName`
- Share: `shareToken` (set when someone shares a finalized report)

A **finding** has `label`, `confidence`, `bbox` `[left, top, width, height]` in percent, `location`, `size`, `pattern`, `sentence`, `status`, `source` (`AI` / `Azure` / `manual`), plus optional calibration fields.

**Locking:** after `finalized`, diagnosis, report text, and findings cannot change. Remarks and the urgent flag still can. Referring doctors never receive `editLog` or source tags on the report body.

### Other collections

- `users` — bcrypt passwords, roles `technician` \| `radiologist` \| `doctor` \| `admin`, `isActive`
- `auditlogs` — login, create/update/finalize/delete, AI analyse
- GridFS bucket `images`

---

## How people move through the app

### 1. Sign in

Open http://localhost:5173. JWT is stored in `localStorage` as `radassist.auth`. Vite proxies `/api` to port 5002.

Demo users (seeded):

| Role | Username | Password | Name |
| --- | --- | --- | --- |
| Technician | `tech` | `tech123` | Jamie Lee |
| Radiologist | `priya` | `priya123` | Dr. Priya Nair |
| Radiologist | `marcus` | `marcus123` | Dr. Marcus Chen |
| Referring doctor | `doctor` | `doctor123` | Dr. Alex Wong |
| Admin | `admin` | `admin123` | System Admin |

If a live Cosmos account still has old hashes, run `npm run reset-demo-passwords` in `backend/`.

Press `/` on list pages to focus search.

### 2. Add a patient (optional but recommended)

**Patient Master → New patient** (technician, radiologist, admin)

Required: first name, last name, age, sex. Middle name and patient ID are optional. Empty ID → next `PT-{year}-{nnnn}`.

The chart shows prior medicines, heart rate, and lab results, plus the ward modules (Sepsis Monitor, labs, eMAR, care notes).

### 3. Technician: upload only

**Upload X-ray** (or from the patient chart)

1. Patient ID + Lookup, or fill name / age / sex / history.
2. Drop or pick a PNG / JPG / JPEG / WebP.
3. Submit posts `FormData` to `POST /api/cases`. The film is stored; you return to the worklist. **AI is not started.**

Backend:

1. Require image, `patientId`, first name, last name.
2. Stream the file into GridFS.
3. Save the case as `analysisState: none`, `status: pending` (awaiting AI).
4. Upsert the Patient document from the case.
5. Write `CASE_CREATED`.

Technicians see their own uploads. They cannot open Review to edit or run AI.

### 4. Radiologist: one-click AI

Open **X-ray Worklist** or **Review**. Status is **Awaiting AI** until someone clicks **Use AI**.

`POST /api/cases/:id/analyze` sets `analysisState: running` and returns immediately. In the background:

1. Write a temp file and `POST` it to `AI_BASE_URL/analyze` (CURV middleware, 180s timeout).
2. Map `{ report, findings }` onto the case and set `analysisState: done`, `status: pending_approve`.
3. If Azure is configured, write a short worklist diagnosis and finding cards with boxes.
4. Append an `editLog` row with `kind: ai`.
5. Write `AI_ANALYZED` when CURV succeeded.

If CURV fails, the radiologist can complete the report by hand. Manual edits append `kind: manual` rows to `editLog`.

### 5. Worklist (X-ray Worklist)

Shows stats (total, urgent, finalized, pending approve). Tiles and chips filter the table. Urgent rows sort to the top.

Referring **doctors** only see **finalized** rows.

- **View** → case chart
- **Review** → film + findings (blocked for technicians; read-only for doctors on finalized cases)

Admins can tick rows and bulk-delete.

### 6. Report review

Left: film from GridFS with bbox overlays. Right: findings list, selected editable card, remarks.

While drafting, the page shows an **attribution log** (AI vs manual). **Finalize** issues a clean report: no source badges in the body the doctor, share page, Word, or PDF see.

Radiologist / admin can:

- Edit label / location / size / pattern on non-finalized cases
- **+ Add manually** — new card (`source: "manual"`)
- **Use AI** / **Re-run AI**
- **Save draft** / **Finalize & approve**
- **Share** / **Copy share link** — after finalize
- **Mark urgent** / **Remove urgent** (allowed after finalize)
- Save remarks (allowed after finalize; does **not** rewrite a finalized report)
- **Report** / **Word** / **PDF**

Export composition (`src/lib/reportExport.js`) is the clean CURV/clinician report only.

### 7. Finalize

`POST /api/cases/:id/finalize` sets `status: finalized` and records who signed. Finalize is refused while AI is still `running`. After finalize, findings and the stored report stay locked.

### 8. Share (public link)

After finalize, Review shows **Share**. That creates a token (`POST /api/cases/:id/share`) and copies `#/share/<token>`. Anyone with the link can open the film and the **clean** report without signing in. Shared images come from `GET /api/share/:token/image` (no JWT). `DELETE /api/cases/:id/share` revokes it.

### 9. Referring doctor

Sees only finalized cases. Review / share / export are read-only. No Use AI, no draft log, no save, no finalize.

### 10. Users (admin)

Search accounts; enable or disable them. You cannot disable your own account or the last active administrator.

### 11. Audit

Filterable log of logins, case and patient mutations, AI runs, finalizations, deletions, share links, and user enable/disable. Radiologists may read; technicians and referring doctors do not see this page; only admins delete.

---

## Frontend map

| Page (`state.page`) | Module | Purpose |
| --- | --- | --- |
| `login` / `register` | `src/components/login.js` | Auth |
| `dashboard` | `dashboard.js` | X-ray worklist |
| `patients` / `patient` / `new-patient` | `patients.js`, `newPatient.js` | Patient Master |
| `monitor` / `labs` / `meds` / `notes` | `clinical.js` | Sepsis, labs, eMAR, care notes |
| `cases` / `case` | `cases.js` | Study records |
| `new` | `newCase.js` | Technician upload (no AI) |
| `review` | `review.js` | Film + Use AI + findings + draft log |
| `share` | `shareView.js` | Public finalized report (`#/share/<token>`) |
| `audit` | `audit.js` | Trail |
| `users` | `users.js` | Admin enable / disable |
| `?view=report&caseId=` | `reportView.js` | Report popup |

Shared pieces:

- `src/api.js` — `fetch` wrapper, Bearer token
- `src/lib/roles.js` — technician / radiologist / doctor / admin
- `src/lib/patientName.js` — first / middle / last
- `src/lib/tags.js` — urgent chip, patient name
- `src/lib/findingsSync.js` — merge Azure / parsed / manual cards
- `src/lib/ui.js` — search, chips, empty states, urgent sort
- `src/lib/caseStatus.js` — awaiting AI / generating / pending approve / finalized
- `src/lib/analysisJob.js` — overlay + poll after **Use AI**
- `src/components/header.js` — CMS shell (title bar + MODULES + footer)
- `src/components/patientFields.js` — labeled name controls, sex pills

`setPage()` remounts the current page. Toasts and in-page drafts bypass `setState` so typing is not wiped.

---

## API (authenticated unless noted)

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/health` | public | `{ mongo: "up"\|"down" }` |
| `POST` | `/api/auth/login` | public | JWT |
| `POST` | `/api/auth/register` | public | Demo signup |
| `GET` | `/api/auth/me` | any | Session user |
| `POST` | `/api/auth/logout` | any | Audit only |
| `GET` | `/api/cases` | any | Doctors only receive `status=finalized` |
| `POST` | `/api/cases` | technician, admin | multipart upload; **no AI** |
| `GET` | `/api/cases/:id` | any | Doctors get a clean public view |
| `PUT` | `/api/cases/:id` | radiologist, admin | findings / report / remarks / urgent |
| `POST` | `/api/cases/:id/analyze` | radiologist, admin | one-click AI |
| `POST` | `/api/cases/:id/finalize` | radiologist, admin | |
| `POST` | `/api/cases/:id/share` | radiologist, admin | public token for a finalized report |
| `DELETE` | `/api/cases/:id/share` | radiologist, admin | revoke the share link |
| `POST` | `/api/cases/:id/summarise-findings` | radiologist, admin | Azure cards |
| `POST` | `/api/cases/:id/summarise-diagnosis` | radiologist, admin | Worklist label |
| `POST` | `/api/cases/bulk-delete` | admin | |
| `DELETE` | `/api/cases/:id` | admin | |
| `GET` | `/api/share/:token` | public | finalized case for a share link |
| `GET` | `/api/share/:token/image` | public | film for that share link |
| `GET` | `/api/patients` | any | includes patients with no studies |
| `POST` | `/api/patients` | technician, radiologist, admin | |
| `GET`/`PUT` | `/api/patients/:id` | GET any; PUT technician/radiologist/admin | chart + clinical arrays |
| `POST`/`DELETE` | `/api/patients/bulk-delete`, `.../:id` | admin | also deletes studies + images |
| `GET` | `/api/images/:id` | any | GridFS stream (JWT) |
| `GET` | `/api/audit-logs` | radiologist, admin | |
| `POST`/`DELETE` | `/api/audit-logs/bulk-delete`, `.../:id` | admin | |
| `GET` | `/api/stats` | any | dashboard counters |
| `GET` | `/api/users` | admin | |
| `PUT` | `/api/users/:id/active` | admin | enable / disable |

The Express process is **plain `node server.js`** unless you use `npm run dev` (nodemon). After changing controllers or routes, restart it.

---

## AI pipeline (detail)

### CURV / mlx_vlm

`./start_server.sh` starts:

1. `mlx_vlm.server --model ~/CURV-mlx --port 8080`
2. `uvicorn middleware:app --port 8001` from this repo

`backend/utils/aiService.js` posts the image plus age/sex/history to `POST {AI_BASE_URL}/analyze`. The middleware should return `{ report, findings }`. Findings should already include bbox / confidence / location / size / pattern when the model provides them.

### Azure OpenAI (optional)

Set in `backend/.env`:

- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_KEY`
- `AZURE_OPENAI_DEPLOYMENT`
- optional `AZURE_OPENAI_API_VERSION` (default `2024-10-21`)

Used for:

- A short **diagnosis** after **Use AI**
- **Finding cards** during generate: groups the report, scores wording vs image support, clamps boxes. If vision boxes are missing, anatomical **zones** are used.

If those env vars are absent, the app runs on CURV + the local parser only.

### Confidence

`backend/utils/confidence.js` blends report wording with image support so the model’s `1.0` is not shown as the clinical score. Hedged language scores lower than a definite negative.

---

## Run locally

Three processes. Seed once if the database is empty.

### 1. Backend

```sh
cd backend
npm install
cp .env.example .env   # if you have an example; otherwise edit .env
npm run seed           # users + demo cases (idempotent)
node server.js         # :5002
# or: npm run dev      # nodemon
```

`backend/.env` needs at least `PORT`, `MONGODB_URI`, `MONGODB_DB`, `JWT_SECRET`, `FRONTEND_URL`, `AI_BASE_URL` (usually `http://localhost:8001`). Never commit it.

Useful scripts:

- `npm run migrate-workflow` — backfill roles (`nurse` → technician), `analysisState`, chart fields
- `npm run reset-demo-passwords` — re-hash `tech123` / `priya123` / `doctor123` / `admin123` on a live Cosmos DB

### 2. Frontend

```sh
npm install
npm run dev            # :5173, proxies /api → :5002
```

### 3. AI (only required when a radiologist clicks Use AI)

```sh
./start_server.sh
```

Needs Python 3.12 with `mlx_vlm`, the CURV weights at `~/CURV-mlx`, and `middleware.py` in this repo. Health: http://localhost:8001/health

### Demo data

Seeded cases include structured names. Henry Wong’s rib-fracture case is **urgent** so the tag is visible on Patient Master.

Re-running seed skips existing users/cases but will patch missing name / urgent / chart fields on the demo records.

---

## Tests

Frontend (jsdom via linkedom, no browser):

```sh
npm test
```

That runs the suite in `scripts/test-*.mjs`: report unwrap/parse, findings list, Azure bbox, confidence, export, review popup, diagnosis, patients, new patient, cases, pagination, new-case drop zone, audit bulk-delete, users page, share page, analysis job, shell menu.

Against a **running** backend:

```sh
node scripts/test-e2e-case.mjs
```

Logs in as admin and checks each case: GET 200, clean `reportText`, findings array, image URL if `imageId` is set.

### Maintenance scripts (`backend/`)

Dry-run by default; pass `--apply` to write.

- `node scripts/fix-legacy-reports.js` — unwrap `{"report":"..."}` `reportText`
- `node scripts/fix-data-issues.js` — empty findings arrays; drop missing GridFS `imageId`s
- `node scripts/dump-cases.js` — print case health
- `node scripts/migrate-workflow.js` — roles + `analysisState` + patient chart
- `node scripts/reset-demo-passwords.js` — demo account hashes
- `node scripts/inspect-roles.js` — print stored user roles

---

## Recommendations

### For the demo / viva

1. Start backend, Vite, and `start_server.sh` before the session. Confirm `/api/health` says `mongo: "up"` and `:8001/health` is OK.
2. Restart Express after any backend edit (`node server.js` does not hot-reload).
3. Walk: Technician upload → radiologist **Use AI** → edit a card (draft log shows AI vs manual) → Finalize → doctor login sees only the clean report → Share copies a public link.
4. Show Patient Master + Sepsis / labs / eMAR / notes on a demo chart.
5. Show admin bulk-delete on a throwaway row, not on the last demo case. Show **Users**: disable a throwaway account, not `admin`.

### Product / clinical

- Keep the human in the loop. Do not auto-finalize. Do not start AI on upload.
- Urgent should mean **triage**, not a legal priority.
- Patient names are structured; do not collect extra identifiers (HKID, address) in this FYP unless you have an ethics plan.
- Chart medicines, heart rate, and labs are **synthetic demo data**.
- Reports should stay in the system of record you present (Mongo), not only in a downloaded Word file.

### Engineering (highest value next)

| Item | Why |
| --- | --- |
| Use `npm run dev` (nodemon) in `backend/` | Avoids “route not found” after adding APIs |
| Tighten CORS | `server.js` currently allows every origin “for FYP demo” |
| Disable or lock down `/api/auth/register` | Anyone can mint an account |
| Rotate seed passwords for any shared Cosmos account | `admin123` is public in this repo |
| Backend tests | UI tests do not cover Express or Mongo |
| Patient ID allocation | `PT-2026-0007` is max+1; two concurrent creates can collide |
| Do not store JWT in `localStorage` for a real hospital deploy | XSS can steal it; httpOnly cookies are safer |
| DICOM | Today only raster images; real PACS would need a DICOM store and viewer |
| Structured logs / request IDs | Helps debug CURV timeouts (180s) |

### Deployment sketch (if asked)

- Frontend: `npm run build` → static host; set the API origin or keep a reverse proxy `/api` → Express.
- Backend: Node 20+ on a VM or container; Cosmos connection string in a secret store.
- CURV: Apple Silicon (or a GPU box) close to the API; do not call mlx_vlm from the browser.
- Azure OpenAI: private endpoint if this ever leaves a student subscription.

### What this project is *not*

It is not a PACS, not a CE/FDA device, and not a substitute for a radiologist. Bounding boxes are approximate. Confidence is a UI hint, not a calibrated probability.

---

## Security

- Never commit `.env`, `node_modules`, `uploads`, or `dist`.
- Seed accounts are for local/demo use only.
- Helmet is on; CORS is intentionally loose for local Vite ports.
- GridFS images under `/api/images/:id` require a valid JWT. A **share link** is the exception: `GET /api/share/:token` and `.../image` are public for that one finalized case.

---

## Repo layout

```
src/                  UI (Vite) — CMS shell + X-ray + clinical modules
backend/              Express API, models, seed, Azure/CURV helpers
middleware.py         FastAPI wrapper around mlx_vlm (started by start_server.sh)
scripts/              Frontend tests + e2e
docs/                 FYP plan and initial analysis
```
