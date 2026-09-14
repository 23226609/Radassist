# RadAssist AI

Clinician-in-the-loop chest X-ray reporting for a final-year project.

A doctor (or admin) registers a patient, uploads a film, and gets a draft report plus structured findings. They edit findings, add remarks, mark urgency, and finalize. Nurses can read charts and reports but cannot change clinical content. Admins can also bulk-delete records and manage the audit log.

This is a **demonstration system**, not a clinical product. Findings and reports are decision support. A human must always review them.

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
        ├─ Patients, cases, remarks, urgent flags
        ├─ Audit log
        ├─ GridFS images
        │
        ├──────────────► Cosmos DB (Mongo API)
        │
        ├──────────────► FastAPI middleware (:8001)
        │                      │
        │                      ▼
        │                 mlx_vlm CURV server (:8080)
        │
        └──────────────► Azure OpenAI (optional)
                         diagnosis + finding boxes
```

**On upload**, the backend stores the image in GridFS, asks the CURV middleware for a free-text report and structured findings, then optionally asks Azure for a short worklist diagnosis. If CURV is down, the case is still saved with a placeholder report.

**On review**, a doctor/admin opening a non-finalized case asks Azure to turn the report (+ image) into a few finding cards with boxes. If Azure is not configured, a local markdown parser fills the cards instead.

---

## Roles

| Action | Nurse | Doctor | Admin |
| --- | --- | --- | --- |
| Sign in, browse worklist / patients / cases / audit | yes | yes | yes |
| Add patient, new case, edit findings / remarks | no | yes | yes |
| Mark or remove **Urgent** | no (can see the tag) | yes | yes |
| Finalize a report | no | yes | yes |
| Delete cases, patients, audit rows | no | no | yes |

Public `POST /api/auth/register` exists and defaults new accounts to **doctor**. Treat that as demo-only.

---

## Data model

### Patient

Stored in `patients`. A patient can exist **before** any X-ray.

- `patientId` — e.g. `PT-2026-0018` (typed, or assigned as `PT-{year}-{nnnn}`)
- `firstName`, `middleName` (optional), `lastName`
- `name` — composed full name, kept for search and older records
- `age`, `sex`, `history`, `remarks` (chart notes, never copied into a case report)

The patients list **merges** Patient documents with cases grouped by `patientId`. If any case is urgent, the patient row shows **Urgent**.

### Case

Stored in `cases`. One study / one film.

- Identity: `caseId`, `patientId`, name parts + `patientName`
- Clinical: `age`, `sex`, `history`, `diagnosis`, `diagnosisSource` (`azure` or `local`)
- Report: `reportText`, `remarks`, `findings[]`
- Workflow: `status` (`pending` \| `completed` \| `finalized`), `urgent`
- Image: `imageId` (GridFS), filename / type / size
- Audit: `createdBy`, `finalizedBy`, timestamps

A **finding** has `label`, `confidence`, `bbox` `[left, top, width, height]` in percent, `location`, `size`, `pattern`, `sentence`, `status`, `source` (`AI` / `Azure` / `manual`), plus optional calibration fields (`bboxSource`, `languageScore`, `imageSupport`).

**Locking:** after `finalized`, diagnosis, report text, and findings cannot change. Remarks and the urgent flag still can.

### Other collections

- `users` — bcrypt passwords, roles `doctor` \| `nurse` \| `admin`
- `auditlogs` — login, create/update/finalize/delete, AI analyse
- GridFS bucket `images`

---

## How people move through the app

### 1. Sign in

Open http://localhost:5173. JWT is stored in `localStorage` as `radassist.auth`. Vite proxies `/api` to port 5002.

Demo users (seeded):

| Role | Username | Password |
| --- | --- | --- |
| Admin | `admin` | `admin123` |
| Doctor | `doctor` | `doctor123` |
| Nurse | `nurse` | `nurse123` |

After login, a dark **sidebar** stays on the left (drawer on small screens): Dashboard, Patients, Cases, Audit log, plus New case / New patient for doctors and admins. Press `/` on list pages to focus search.

### 2. Add a patient (optional but recommended)

**Patients → New patient**

Required: first name, last name, age, sex. Middle name and patient ID are optional. Empty ID → next `PT-{year}-{nnnn}`.

Submit creates a Patient with no studies. The chart opens. **New case** on that chart starts an upload with the person already filled in.

Lookup on New Case uses the same records, so you can also type an existing ID there.

### 3. New case (upload + AI)

**New case** (or from the patient chart)

1. Patient ID + Lookup, or fill first / middle / last name, age, sex, history.
2. Drop or pick a PNG / JPG / JPEG / WebP.
3. **Analyse X-Ray** posts `FormData` to `POST /api/cases`.

Backend:

1. Require image, `patientId`, first name, last name.
2. Stream the file into GridFS.
3. Write a temp file and `POST` it to `AI_BASE_URL/analyze` (CURV middleware, 180s timeout).
4. Map middleware `{ report, findings }` onto the case (`status: completed`).
5. If Azure is configured, replace the first-sentence diagnosis with a short worklist label.
6. Upsert the Patient document from the case.
7. Write `CASE_CREATED` (+ `AI_ANALYZED` when CURV succeeded).

If CURV fails, the case is still stored with a placeholder report. The clinician can complete it by hand.

### 4. Worklist (Dashboard)

Shows stats (total, urgent, finalized, pending). Tiles and chips filter the table. Urgent rows sort to the top. Search is live (debounced); `/` focuses it.

- **View** → case chart (history, diagnosis, findings list, remarks)
- **Review** → X-ray + finding carousel (the reporting screen)

Admins can tick rows and bulk-delete.

### 5. Report review (the main clinical screen)

Left: film from GridFS with bbox overlays. Right: one finding at a time (prev/next/dots), then remarks.

On open (doctor/admin, not finalized):

1. Load the case and unwrap any legacy `{"report":"..."}` `reportText`.
2. Call `POST /api/cases/:id/summarise-findings` (Azure). Skip if cards are already calibrated Azure findings.
3. On Azure miss/failure, parse the markdown report locally into up to six cards.

Clinician can:

- Edit label / location / size / pattern on non-finalized cases
- **+ Add manually** — jumps to a new card (`source: "manual"`)
- **Save draft** / **Finalize & approve**
- **Mark urgent** / **Remove urgent** (allowed after finalize)
- Save remarks (allowed after finalize; does **not** rewrite a finalized report)
- **Report** — popup editor of stored `reportText`
- **Word** / **PDF** — persist unsaved edits first, then download

Export composition (`src/lib/reportExport.js`):

1. Body of `reportText`
2. **Clinician-added findings** (manual cards)
3. **Radiologist remarks**

Nurses see the film and cards read-only. They cannot save, finalize, or toggle urgent.

### 6. Finalize

`POST /api/cases/:id/finalize` sets `status: finalized` and records who signed. After that, findings and the stored report stay locked. Remarks and urgent remain editable so follow-up notes and triage tags are still possible.

### 7. Patients and cases lists

Same search / pagination / admin bulk-delete pattern. Patient rows show full name and an **Urgent** chip if any study is urgent. Opening a patient shows history, latest diagnosis, findings from studies, and chart remarks (`PUT /api/patients/:id` — these remarks are **not** copied into reports).

### 8. Audit

Filterable log of logins, case and patient mutations, AI runs, finalizations, deletions. Doctors may read; only admins delete.

---

## Frontend map

| Page (`state.page`) | Module | Purpose |
| --- | --- | --- |
| `login` / `register` | `src/components/login.js` | Auth |
| `dashboard` | `dashboard.js` | Worklist |
| `patients` / `patient` / `new-patient` | `patients.js`, `newPatient.js` | Charts |
| `cases` / `case` | `cases.js` | Study records |
| `new` | `newCase.js` | Upload |
| `review` | `review.js` | Film + findings |
| `audit` | `audit.js` | Trail |
| `?view=report&caseId=` | `reportView.js` | Report popup |

Shared pieces:

- `src/api.js` — `fetch` wrapper, Bearer token
- `src/lib/patientName.js` — first / middle / last
- `src/lib/ui.js` — search, chips, empty states, urgent sort
- `src/components/header.js` — sidebar shell
- `src/components/patientFields.js` — labeled name controls, sex pills, name preview

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
| `GET` | `/api/cases` | any | `status`, `q`, `patientId` |
| `POST` | `/api/cases` | doctor, admin | multipart upload |
| `GET` | `/api/cases/:id` | any | `caseId` or Mongo `_id` |
| `PUT` | `/api/cases/:id` | doctor, admin | findings / report / remarks / urgent |
| `POST` | `/api/cases/:id/finalize` | doctor, admin | |
| `POST` | `/api/cases/:id/summarise-findings` | doctor, admin | Azure cards |
| `POST` | `/api/cases/:id/summarise-diagnosis` | doctor, admin | Worklist label |
| `POST` | `/api/cases/bulk-delete` | admin | |
| `DELETE` | `/api/cases/:id` | admin | |
| `GET` | `/api/patients` | any | includes patients with no studies |
| `POST` | `/api/patients` | doctor, admin | |
| `GET`/`PUT` | `/api/patients/:id` | GET any; PUT doctor/admin | |
| `POST`/`DELETE` | `/api/patients/bulk-delete`, `.../:id` | admin | also deletes studies + images |
| `GET` | `/api/images/:id` | any | GridFS stream |
| `GET` | `/api/audit-logs` | any | |
| `POST`/`DELETE` | `/api/audit-logs/bulk-delete`, `.../:id` | admin | |
| `GET` | `/api/stats` | any | dashboard counters |
| `GET` | `/api/users` | admin | |

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

- A short **diagnosis** on create (and dashboard backfill for leftover first-sentence labels)
- **Finding cards** on review: groups the report, scores wording vs image support, clamps boxes. If vision boxes are missing, anatomical **zones** are used.

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
npm run seed           # users + demo cases (idempotent; also backfills names / urgent)
node server.js         # :5002
# or: npm run dev      # nodemon
```

`backend/.env` needs at least `PORT`, `MONGODB_URI`, `MONGODB_DB`, `JWT_SECRET`, `FRONTEND_URL`, `AI_BASE_URL` (usually `http://localhost:8001`). Never commit it.

### 2. Frontend

```sh
npm install
npm run dev            # :5173, proxies /api → :5002
```

### 3. AI (only required for new uploads)

```sh
./start_server.sh
```

Needs Python 3.12 with `mlx_vlm`, the CURV weights at `~/CURV-mlx`, and `middleware.py` in this repo. Health: http://localhost:8001/health

### Demo data

Seeded cases include names (first / last; James **Wei** Tan has a middle name). Henry Wong’s rib-fracture case is **urgent** so the tag is visible on Patients.

Re-running seed skips existing users/cases but will patch missing `firstName` / `lastName` / `urgent` on the demo cases.

---

## Tests

Frontend (jsdom via linkedom, no browser):

```sh
npm test
```

That runs the suite in `scripts/test-*.mjs`: report unwrap/parse, findings carousel, Azure bbox, confidence, export, review popup, diagnosis, patients, new patient, cases, pagination, new-case drop zone, audit bulk-delete.

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

---

## Recommendations

### For the demo / viva

1. Start backend, Vite, and `start_server.sh` before the session. Confirm `/api/health` says `mongo: "up"` and `:8001/health` is OK.
2. Restart Express after any backend edit (`node server.js` does not hot-reload).
3. Walk: New patient → New case → Review (carousel, add manual finding, remarks, urgent) → Patients list shows the name and Urgent chip → Finalize → remarks still save.
4. Show nurse login: read-only review, no Mark urgent / Save.
5. Show admin bulk-delete on a throwaway row, not on the last demo case.

### Product / clinical

- Keep the human in the loop. Do not auto-finalize. Keep Azure/CURV copy labeled as draft.
- Urgent should mean **triage**, not a legal priority. Agree a definition with the supervisor (e.g. suspected pneumothorax).
- Patient names are now structured; do not collect extra identifiers (HKID, address) in this FYP unless you have an ethics plan.
- Reports should stay in the system of record you present (Mongo), not only in a downloaded Word file.

### Engineering (highest value next)

| Item | Why |
| --- | --- |
| Use `npm run dev` (nodemon) in `backend/` | Avoids “route not found” after adding APIs |
| Tighten CORS | `server.js` currently allows every origin “for FYP demo” |
| Disable or lock down `/api/auth/register` | Anyone can mint a doctor account |
| Rotate seed passwords for any shared Cosmos account | `admin123` is public in this repo |
| Backend tests | UI tests do not cover Express or Mongo |
| Idempotent Azure summarise | Avoid double-write if two tabs open the same case |
| Patient ID allocation | `PT-2026-0007` is max+1; two concurrent creates can collide |
| Do not store JWT in `localStorage` for a real hospital deploy | XSS can steal it; httpOnly cookies are safer |
| DICOM | Today only raster images; real PACS would need a DICOM store and viewer |
| Structured logs / request IDs | Helps debug CURV timeouts (180s) |

### UX follow-ups

- The whole page remounts on `setPage`. Fine at this size; painful if you add complex forms.
- Sidebar is the right IA; next polish is keyboard focus order and visible focus rings.
- Dashboard diagnosis backfill hits Azure per leftover row (capped at 6). Cache or batch if the worklist grows.
- Consider a dedicated “urgent worklist” saved filter in the URL.

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
- GridFS images require a valid JWT.

---

## Repo layout

```
src/                  UI (Vite)
backend/              Express API, models, seed, Azure/CURV helpers
middleware.py         FastAPI wrapper around mlx_vlm (started by start_server.sh)
scripts/              Frontend tests + e2e
```
