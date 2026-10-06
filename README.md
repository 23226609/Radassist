# RadAssist AI

Clinician-in-the-loop chest X-ray reporting for a final-year project, presented in a hospital CMS-style shell.

A referring **doctor** requests a chest X-ray on a patient already in the master index. A **technician** opens **Requested case**, saves the film, and CURV starts on its own. A **radiologist** opens the work list, sees **Generating** then **Pending approve**, edits the draft, and **endorses** it. The referring doctor then reads that endorsed report from **Examination enquiry**. An **admin** can do radiologist work plus user, audit, and bulk-delete administration.

This is a **demonstration system**, not a clinical product. Findings and reports are decision support. A human must always review them before they go back to the ward.

The browser chrome follows the COMP4126 CMS mock (navy title bar, permanent **MODULES** column, gray Windows-style inner windows). The X-ray work list follows the RIS worklist in the same lecture: a **My work** queue and a dense blue grid. Bed management, HKID, pay codes, and appointment booking are not included.

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
        ├─ Patients, clinical chart, exam requests, cases, remarks, urgent flags
        ├─ Audit log (admin)
        ├─ GridFS images
        │
        ├──────────────► Cosmos DB (Mongo API)
        │
        ├──────────────► FastAPI middleware (:8001)   [starts when the film is saved]
        │                      │
        │                      ▼
        │                 mlx_vlm CURV server (:8080)
        │
        └──────────────► Azure OpenAI (optional)
                         diagnosis + finding boxes
```

**On request** (`POST /api/cases/request`), the referring doctor creates a case with `status: requested` and no film. The patient chart button stays **Requested** until a technician saves the film.

**On registration of the film** (`POST /api/cases`), the image is stored in GridFS and CURV starts in the background. There is no Use AI click. The API returns immediately; the radiologist work list shows **Generating**, then **Pending approve**. If CURV is down, the case stays stored so the radiologist can write the report by hand. **Re-run AI** is available after a draft exists.

**On review**, the page shows stored findings as a **point-form list**, with the selected row opened as an editable card bound to the box on the film. While the report is still a draft, an **AI vs manual attribution log** is visible. **Endorse** locks the report. After that, the log stays in the system but is **stripped from the report body** the referring doctor and share/export views see. A sign-off (date, reporting doctor, signature line) sits under the report and in Word/PDF, outside the editable body.

---

## Roles

| Action | Technician | Radiologist | Doctor (referring) | Admin |
| --- | --- | --- | --- | --- |
| Sign in, browse Patient Master | yes | yes | yes | yes |
| Request a chest X-ray | no | no | yes | yes |
| See requested cases (no film, no report) | yes | on the work list | yes | yes |
| Save the film on a request | yes | no | no | yes |
| See draft / pending-approve cases and films | no | yes | no | yes |
| Order labs / prescribe on the chart | no | no | yes | yes |
| Edit the rest of the patient chart | yes | yes | no | yes |
| Edit findings, re-run AI, endorse | no | yes | no | yes |
| Mark or remove **Urgent** | no | yes | no | yes |
| Share an endorsed report (public link) | no | yes | no | yes |
| Read an endorsed report / export Word or PDF | no | yes | yes | yes |
| Browse audit log | no | no | no | yes |
| Add, enable, disable, or delete users | no | no | no | yes |
| Delete cases, patients, audit rows | no | no | no | yes |

Lab Orders and the Medication Chart are hidden from technicians and radiologists. The audit log is admin-only. Legacy `nurse` accounts are treated as **technician**.

Public `POST /api/auth/register` exists for demo signup. Treat that as demo-only.

---

## Data model

### Patient

Stored in `patients`. A patient can exist **before** any X-ray. In a hospital the master index already holds patients; **New patient** in this demo is only for seeding a chart.

- Identity: `patientId` (e.g. `PT-2026-0018`), `firstName`, `middleName`, `lastName`, `name`
- Demographics: `age`, `sex`, `history`, `remarks` (chart notes, never copied into a case report)
- Chart extras: `medicines`, `heartRate`, `labResults`
- Ward context (display only; no bed-management UI): `ward`, `bed`, `admissionStatus`
- Clinical sub-records: `observations[]`, `labOrders[]`, `medOrders[]`, `careNotes[]`

The chart lists **X-ray requests** separately from completed studies. **Request chest X-ray** becomes **Requested** while a request is still open.

Deleting a **patient** removes the chart, every study for that ID, and GridFS images. Deleting a **case** removes that study and its image; the patient chart stays.

### Case

Stored in `cases`. One study / one film.

- Identity: `caseId`, `patientId`, name parts + `patientName`
- Clinical: `age`, `sex`, `history`, `diagnosis`, `diagnosisSource` (`azure` or `local`)
- Report: `reportText`, `remarks`, `findings[]`
- AI: `analysisState` (`none` \| `running` \| `done`)
- Draft provenance: `editLog[]` (`kind`: `ai` \| `manual`). Shown on Review while drafting; **not** included in endorsed / shared / exported report text
- Workflow: `status` (`requested` no film yet \| `pending` outstanding or generating \| `pending_approve` draft ready \| `finalized` endorsed) and `urgent`. Old documents may still say `completed` — the UI treats that as pending approve
- Image: `imageId` (GridFS), filename / type / size. Hidden from technician responses
- People: `requestedBy`, `requestedByName`, `createdBy`, `createdByName` (uploader), `finalizedBy`, `finalizedByName`
- Share: `shareToken` (set when someone shares an endorsed report)

Work-list labels: **Requested**, **Outstanding**, **Generating**, **Pending approve**, **Endorsed**. The left queue calls a draft **Partially endorsed** and a locked report **Fully endorsed**, matching the RIS slide. Stored status for an endorsed report is still `finalized`.

A **finding** has `label`, `confidence`, `bbox` `[left, top, width, height]` in percent, `location`, `size`, `pattern`, `sentence`, `status`, `source` (`AI` / `Azure` / `manual`), plus optional calibration fields.

**Locking:** after endorse, diagnosis, report text, and findings cannot change. Remarks and the urgent flag still can. Referring doctors never receive `editLog` or source tags on the report body. Technicians never receive the film, report, or findings.

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

### 2. Patient chart

**Patient Master** lists patients. **New patient** (technician, radiologist, admin) is a demo shortcut: required first name, last name, age, and sex. Middle name and patient ID are optional. Empty ID → next `PT-{year}-{nnnn}`.

The chart shows prior medicines, heart rate, and lab results, plus Sepsis Monitor, labs, eMAR, and care notes where that role can open them. A referring doctor can order labs and prescribe. A technician or radiologist cannot.

### 3. Doctor: request the exam

On the patient chart, **Request chest X-ray** calls `POST /api/cases/request`. The case is `status: requested`, diagnosis “Chest X-ray requested”, with no image. A second open request for the same patient is refused. The button reads **Requested** until the technician saves the film, then it returns to **Request chest X-ray**. The request also appears under **X-ray requests** on the chart.

### 4. Technician: receive the request and save the film

**Requested case** lists only `status: requested` rows: patient, who requested it, when, and **Register film**. There is no film and no report on this page.

Saving the film posts `FormData` to `POST /api/cases` with `requestCaseId`. The backend attaches the image to that request and queues CURV. The technician goes back to **Requested case**. They do not open the work list or the report.

Backend:

1. Require the image and an open request (or, for a direct admin upload, patient identity).
2. Stream the file into GridFS.
3. Set `analysisState: running` and return immediately.
4. In the background, resize the whole frame to the CURV pixel budget, call the middleware, then set `pending_approve` on success. The review page keeps the original film.
5. Write `CASE_CREATED` / `AI_ANALYZED` as appropriate.

### 5. Radiologist: work list and endorse

Open **X-ray Worklist**. Outstanding films that are still running show **Generating**. When CURV finishes they show **Pending approve**. The left queue filters All work, Outstanding, Partially endorsed, Fully endorsed, Requested, and Urgent attention.

`POST /api/cases/:id/analyze` is the re-run path after a draft exists. It is not required to produce the first draft.

If CURV fails, the radiologist can complete the report by hand. Manual edits append `kind: manual` rows to `editLog`.

Referring **doctors** use the same grid as **Examination enquiry**. They only receive **requested** and **endorsed** rows.

- **View** → case chart
- **Edit report** / **Enquiry** → film + findings (doctors read the endorsed report; generating drafts stay closed)

Admins can tick rows and bulk-delete.

### 6. Report review

Left: original film from GridFS with bbox overlays. Right: findings list, selected editable card, remarks. The report body is Findings, Thinking, and Impression. Thinking is the model’s reasoning trace. The sign-off is separate from that body.

While drafting, the page shows an **attribution log** (AI vs manual). **Endorse report** issues a clean report: no source badges in the body the doctor, share page, Word, or PDF see.

Radiologist / admin can:

- Edit label / location / size / pattern on non-endorsed cases
- **+ Add manually** — new card (`source: "manual"`)
- **Re-run AI** — after a draft exists
- **Save draft** / **Endorse report**
- **Share** / **Copy share link** — after endorse
- **Mark urgent** / **Remove urgent** (allowed after endorse)
- Save remarks (allowed after endorse; does **not** rewrite an endorsed report)
- **Report** / **Word** / **PDF**

Export composition (`src/lib/reportExport.js`) is the clean CURV/clinician report plus the sign-off.

### 7. Endorse

`POST /api/cases/:id/finalize` sets `status: finalized` and records who signed. The screen calls this **Endorse**. It is refused while AI is still `running`. After endorse, findings and the stored report stay locked.

### 8. Share (public link)

After endorse, Review shows **Share**. That creates a token (`POST /api/cases/:id/share`) and copies `#/share/<token>`. Anyone with the link can open the film and the **clean** report without signing in. Shared images come from `GET /api/share/:token/image` (no JWT). `DELETE /api/cases/:id/share` revokes it.

### 9. Referring doctor

Sees requested exams and endorsed reports. Enquiry, share, and export of an endorsed report are read-only. No re-run, no draft log, no save, no endorse.

### 10. Users (admin)

Search accounts. **Add user** takes name, email, and role. The username is the email local part. A temporary password is shown once and is not emailed. Enable, disable, or delete an account. You cannot disable or delete your own account, and you cannot remove the last active administrator.

### 11. Audit

Filterable log of logins, case and patient mutations, AI runs, endorsements, deletions, share links, and user changes. Only an admin can open or delete it.

---

## Frontend map

| Page (`state.page`) | Module | Purpose |
| --- | --- | --- |
| `login` / `register` | `src/components/login.js` | Auth |
| `dashboard` | `dashboard.js` | RIS-style X-ray work list / examination enquiry |
| `requests` | `cases.js` | Technician requested-case queue |
| `patients` / `patient` / `new-patient` | `patients.js`, `newPatient.js` | Patient Master and exam request |
| `monitor` / `labs` / `meds` / `notes` | `clinical.js` | Sepsis, labs, eMAR, care notes |
| `cases` / `case` | `cases.js` | Study records |
| `new` | `newCase.js` | Save the film for a request (starts CURV) |
| `review` | `review.js` | Film, draft, re-run AI, endorse |
| `share` | `shareView.js` | Public endorsed report (`#/share/<token>`) |
| `audit` | `audit.js` | Admin trail |
| `users` | `users.js` | Admin add / enable / disable / delete |
| `?view=report&caseId=` | `reportView.js` | Report popup and sign-off |

Shared pieces:

- `src/api.js` — `fetch` wrapper, Bearer token
- `src/lib/roles.js` — technician / radiologist / doctor / admin
- `src/lib/patientName.js` — first / middle / last
- `src/lib/tags.js` — urgent chip, patient name
- `src/lib/findingsSync.js` — merge Azure / parsed / manual cards
- `src/lib/ui.js` — search, chips, empty states, urgent sort
- `src/lib/caseStatus.js` — requested / outstanding / generating / pending approve / endorsed
- `src/lib/analysisJob.js` — poll while a report is generating
- `src/components/header.js` — CMS shell (title bar + MODULES + request badge + footer)
- `src/components/patientFields.js` — labeled name controls, sex pills

`setPage()` remounts the current page. Toasts and in-page drafts bypass `setState` so typing is not wiped. The request-count badge updates without remounting the page.

---

## API (authenticated unless noted)

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/health` | public | `{ mongo: "up"\|"down" }` |
| `POST` | `/api/auth/login` | public | JWT |
| `POST` | `/api/auth/register` | public | Demo signup |
| `GET` | `/api/auth/me` | any | Session user |
| `POST` | `/api/auth/logout` | any | Audit only |
| `GET` | `/api/cases` | any | Doctors: `finalized` and `requested`. Technicians: `requested` only, film and report stripped |
| `POST` | `/api/cases/request` | doctor, admin | chest X-ray request, no film |
| `POST` | `/api/cases` | technician, admin | multipart film; **starts CURV** |
| `GET` | `/api/cases/:id` | any | Doctors: requested or endorsed. Technicians: requested only |
| `PUT` | `/api/cases/:id` | radiologist, admin | findings / report / remarks / urgent |
| `POST` | `/api/cases/:id/analyze` | radiologist, admin | re-run AI after a draft exists |
| `POST` | `/api/cases/:id/finalize` | radiologist, admin | endorse; stores `status: finalized` |
| `POST` | `/api/cases/:id/share` | radiologist, admin | public token for an endorsed report |
| `DELETE` | `/api/cases/:id/share` | radiologist, admin | revoke the share link |
| `POST` | `/api/cases/:id/summarise-findings` | radiologist, admin | Azure cards |
| `POST` | `/api/cases/:id/summarise-diagnosis` | radiologist, admin | Worklist label |
| `POST` | `/api/cases/bulk-delete` | admin | |
| `DELETE` | `/api/cases/:id` | admin | |
| `GET` | `/api/share/:token` | public | endorsed case for a share link |
| `GET` | `/api/share/:token/image` | public | film for that share link |
| `GET` | `/api/patients` | any | includes patients with no studies |
| `POST` | `/api/patients` | technician, radiologist, admin | demo new patient |
| `GET`/`PUT` | `/api/patients/:id` | GET any; PUT as noted | doctors may save labs and medicines only |
| `POST`/`DELETE` | `/api/patients/bulk-delete`, `.../:id` | admin | also deletes studies + images |
| `GET` | `/api/images/:id` | any | GridFS stream (JWT) |
| `GET` | `/api/audit-logs` | admin | |
| `POST`/`DELETE` | `/api/audit-logs/bulk-delete`, `.../:id` | admin | |
| `GET` | `/api/stats` | any | dashboard counters |
| `GET` | `/api/users` | admin | |
| `POST` | `/api/users` | admin | create; returns a one-time temporary password |
| `PUT` | `/api/users/:id/active` | admin | enable / disable |
| `DELETE` | `/api/users/:id` | admin | not self, not the last active admin |

The Express process is **plain `node server.js`** unless you use `npm run dev` (nodemon). After changing controllers or routes, restart it. `./start_server.sh` does not reload `middleware.py` either.

---

## AI pipeline (detail)

### CURV / mlx_vlm

`./start_server.sh` starts:

1. `mlx_vlm.server --model ~/CURV-mlx --port 8080`
2. `uvicorn middleware:app --port 8001` from this repo

`backend/utils/aiService.js` posts the image to `POST {AI_BASE_URL}/analyze`. The middleware resizes the **whole frame** (no crop) to the CURV preprocessor budget (`max_pixels` 50176, about 224×224) and sends the official CURV conversation from `CURV-main`: the system prompt in `training/prompts/prompt_cxr.txt`, the user line “Please analyze this chest X-ray image and generate a detailed radiology report following the specified format.”, and that resized film. Patient age, sex, and history stay on the chart. CURV answers with `<findings>`, `<thinking>`, and `<impression>`. Those are saved as Findings, Thinking, and Impression. The review page parses finding cards from the Findings section and still displays the original image.

Calling the model with an image and no user text makes this checkpoint say it cannot see an image. The official prompt is required.

### Azure OpenAI (optional)

Set in `backend/.env`:

- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_KEY`
- `AZURE_OPENAI_DEPLOYMENT`
- optional `AZURE_OPENAI_API_VERSION` (default `2024-10-21`)

Used for:

- A short **diagnosis** on the work list after a report exists
- **Finding cards** during generate: groups the report, scores wording vs image support, clamps boxes. If vision boxes are missing, anatomical **zones** are used.

If those env vars are absent, the app runs on CURV + the local parser only.

### Confidence

`backend/utils/confidence.js` blends report wording with image support so the model’s `1.0` is not shown as the clinical score. Hedged language scores lower than a definite negative.

---

## Run locally

Three processes. Seed once if the database is empty. Start CURV before a technician saves a film, or the draft will say the analysis was unavailable until someone re-runs it.

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

### 3. AI

```sh
./start_server.sh
```

The script waits about 20 seconds for the model to load before uvicorn listens on 8001. Needs Python 3.12 with `mlx_vlm`, the CURV weights at `~/CURV-mlx`, and `middleware.py` in this repo. Health: http://localhost:8001/health

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

1. Start backend, Vite, and `start_server.sh` before the session. Confirm `/api/health` says `mongo: "up"` and `:8001/health` is OK. Wait until the model has finished loading.
2. Restart Express after any backend edit (`node server.js` does not hot-reload). Restart `start_server.sh` after any `middleware.py` edit.
3. Walk: doctor **Request chest X-ray** → technician **Requested case** → save the film (draft generates on its own) → radiologist work list moves from **Generating** to **Pending approve** → edit a card → **Endorse report** → doctor login reads the clean report → Share copies a public link.
4. Show Patient Master, an X-ray request on the chart, and Sepsis / labs / eMAR / notes for a doctor. Show that a technician and a radiologist do not have labs, medicines, or the audit log.
5. Show admin **Users** (add by email, temporary password once) and bulk-delete on a throwaway row, not on the last demo case.

### Product / clinical

- Keep the human in the loop. Do not auto-endorse. The first draft starts when the film is saved, not from a separate click.
- Urgent should mean **triage**, not a legal priority.
- Patient names are structured; do not collect extra identifiers (HKID, address) in this FYP unless you have an ethics plan.
- Chart medicines, heart rate, and labs are **synthetic demo data**. MIMIC-CXR does not contain those; they live in MIMIC-IV and are not loaded here.
- The resized film is what CURV sees. Fine detail is lost at about 224 pixels on the long side. The review screen keeps the original.
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
- GridFS images under `/api/images/:id` require a valid JWT. A **share link** is the exception: `GET /api/share/:token` and `.../image` are public for that one endorsed case.
- Technician API responses omit the film, report text, and findings.

---

## Repo layout

```
src/                  UI (Vite) — CMS shell + X-ray + clinical modules
backend/              Express API, models, seed, Azure/CURV helpers
middleware.py         FastAPI wrapper around mlx_vlm (started by start_server.sh)
scripts/              Frontend tests + e2e
docs/                 FYP plan and initial analysis
```
