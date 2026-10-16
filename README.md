# RadAssist AI

Clinician-in-the-loop chest X-ray reporting for a final-year project, presented in a hospital CMS-style shell.

A referring **doctor** books a chest X-ray on a calendar. A **technician** opens **Requested case**, saves the film, and CURV starts on its own. A **radiologist** opens the work list, sees **Generating** then **Pending approve**, edits the draft, and **endorses** it. The referring doctor then reads that endorsed report from **Examination enquiry**. An **admin** can do radiologist work plus user, audit, and bulk-delete administration.

This is a **demonstration system**, not a clinical product. Findings and reports are decision support. A human must always review them before they go back to the ward.

The shell has a beige title bar (`#ece9da`) and a gray **MODULES** column. The X-ray work list follows the RIS worklist in the COMP4126 lecture: a **My work** queue and a dense examination grid. Bed management, HKID, and pay codes are not included. There is no medication chart.

---

## What you get

| Layer | Stack | Default URL |
| --- | --- | --- |
| UI | Vanilla JS, Vite 8, Tailwind 3 | http://localhost:5173 |
| API | Express 4, Mongoose 8, JWT | http://localhost:5002 |
| Database | Azure Cosmos DB (Mongo API) + GridFS | `MONGODB_URI` |
| Local vision model | FastAPI middleware → `mlx_vlm` (CURV) | http://localhost:8001 → :8080 |
| Optional | Azure OpenAI: film boxes after the CURV draft, work-list label after a manual edit | env flags |

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
                         boxes on the film (never edits the report)
```

**On booking** (`POST /api/cases/request`), the referring doctor drops **Chest X-ray** on a calendar day. The case is `status: requested`, with `scheduledAt` and no film. The chart button stays **Requested** until a technician saves the film.

**On registration of the film** (`POST /api/cases`), the image is stored in GridFS and CURV starts in the background. There is no Use AI click. The API returns immediately; the radiologist work list shows **Generating**, then **Pending approve**. If CURV is down, the case stays stored so the radiologist can write the report by hand. **Re-run AI** is available after a draft exists.

**After the draft is stored**, Azure reads the CURV report and places boxes on the film (`boxesState: running` → `done` / `failed`). Azure does not rewrite the report or the work-list label at this step; the report text is CURV’s alone.

**On review**, the page shows the report and the film side by side, the way a hospital viewer does. There are no finding cards. The report box is directly editable. The radiologist can draw, move, resize, and delete boxes, and **Measure** lines are saved with the report. **Save draft** stores everything; if the report wording changed, Azure re-places boxes for the new wording and keeps the boxes the radiologist drew, adjusted, or deleted. **Thinking** (the model’s reasoning) is kept in the stored draft but never shown to anyone and never exported. **Endorse** locks the report. The date, reporting doctor, and signature stay on the report and in both downloads.

---

## Roles

| Action | Technician | Radiologist | Doctor (referring) | Admin |
| --- | --- | --- | --- | --- |
| Sign in, browse Patient Master | yes | yes | yes | yes |
| Request a chest X-ray | no | no | yes | yes |
| See requested cases (no film, no report) | yes | on the work list | yes | yes |
| Save the film on a request | yes | no | no | yes |
| See draft / pending-approve cases and films | no | yes | no | yes |
| Order labs on the chart | no | no | yes | yes |
| Edit the rest of the patient chart | yes | yes | no | yes |
| Edit report, boxes, measurements; re-run AI; endorse | no | yes | no | yes |
| Mark or remove **Urgent** | no | yes | no | yes |
| Share an endorsed report (public link) | no | yes | no | yes |
| Read an endorsed report / export Word or PDF | no | yes | yes | yes |
| Browse audit log | no | no | no | yes |
| Add, enable, disable, or delete users | no | no | no | yes |
| Delete cases, patients, audit rows | no | no | no | yes |

Lab Orders are hidden from technicians and radiologists. The medication chart is not part of this system. The audit log is admin-only. Legacy `nurse` accounts are treated as **technician**.

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

The chart lists **X-ray requests** separately from completed studies. **Book chest X-ray** opens the calendar. The button reads **Requested** while a request is still open.

Deleting a **patient** removes the chart, every study for that ID, and GridFS images. Deleting a **case** removes that study and its image; the patient chart stays.

### Case

Stored in `cases`. One study / one film.

- Identity: `caseId`, `patientId`, name parts + `patientName`
- Clinical: `age`, `sex`, `history`, `diagnosis`, `diagnosisSource` (`azure` or `local`)
- Report: `reportText`, `remarks`, `findings[]` (the film boxes), `measurements[]`
- AI: `analysisState` (`none` \| `running` \| `done`), `boxesState` (`''` not requested \| `running` \| `done` \| `failed`)
- Draft provenance: `editLog[]` (`kind`: `ai` \| `manual`). Shown on Review while drafting; **not** included in endorsed / shared / exported report text. API responses add `clinicianEdited` (true once a `manual` row exists)
- Workflow: `status` (`requested` no film yet \| `pending` outstanding or generating \| `pending_approve` draft ready \| `finalized` endorsed) and `urgent`. Old documents may still say `completed` — the UI treats that as pending approve
- Image: `imageId` (GridFS), filename / type / size. Hidden from technician responses. `registeredAt` is the day the technician saved the film; the work list **Reg. Date** uses that, not the request day. `pixelSpacingMm` is `[row, column]` in millimetres when the DICOM file had it
- Booking: `scheduledAt`
- People: `requestedBy`, `requestedByName`, `createdBy`, `createdByName` (uploader), `finalizedBy`, `finalizedByName`
- Share: `shareToken` (set when someone shares an endorsed report)

Work-list labels: **Requested**, **Outstanding**, **Generating**, **Pending approve**, **Endorsed**. The left queue calls a draft **Partially endorsed** and a locked report **Fully endorsed**, matching the RIS slide. Stored status for an endorsed report is still `finalized`.

A **finding** is one box on the film: `label`, `bbox` `[left, top, width, height]` in percent, `sentence`, `severity` (`normal` boxes are not drawn), `status`, `source` (`Azure` or `manual`), and `bboxSource`:

- `vision` / `zone` — Azure placed it from the image or from an anatomical zone
- `manual` — a box the radiologist drew (`source: manual`), or an Azure box they moved or resized
- `status: rejected` — an Azure box the radiologist deleted. It stays stored, hidden, so the next Azure pass does not bring it back. A deleted drawn box is removed outright

A **measurement** is `x1`, `y1`, `x2`, `y2` (percent of the film), `text` (e.g. `14.29 cm`, or pixels when the film has no spacing), and an optional `label`.

**Locking:** after endorse, diagnosis, report text, boxes, and measurements cannot change. Remarks and the urgent flag still can. Referring doctors never receive `editLog` or source tags. Technicians never receive the film, report, or findings.

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

The chart shows prior medicines, heart rate, and lab results, plus Sepsis Monitor, labs, and care notes where that role can open them. A referring doctor can order labs. A technician or radiologist cannot.

### 3. Doctor: book the exam

On the patient chart, **Book chest X-ray** opens a month calendar. Drag the **Chest X-ray** chip onto a day, or click the day, then **Confirm booking**. That calls `POST /api/cases/request` with `scheduledAt`. The case is `status: requested`, diagnosis “Chest X-ray requested”, with no image. A second open request for the same patient is refused. The button reads **Requested** until the technician saves the film, then it returns to **Book chest X-ray**. The booked day appears under **X-ray requests**.

### 4. Technician: receive the request and save the film

**Requested case** lists only `status: requested` rows: patient, who requested it, when, and **Register film**. There is no film and no report on this page.

Saving the film posts `FormData` to `POST /api/cases` with `requestCaseId`. The backend attaches the image to that request and queues CURV. The technician goes back to **Requested case**. They do not open the work list or the report.

Backend:

1. Require the image and an open request (or, for a direct admin upload, patient identity).
2. A DICOM (`.dcm`) film is rendered to a PNG first. CURV cannot read the DICOM container. Uncompressed grayscale or RGB films are accepted; compressed DICOM needs to be exported as an uncompressed film or a PNG.
3. Stream that film into GridFS.
4. Set `analysisState: running` and return immediately.
5. In the background, resize the whole frame to the CURV pixel budget, call the middleware, then set `pending_approve` on success. The review page shows that rendered film.
6. If Azure is configured, ask it to place boxes for that draft (`boxesState: running`). The result is dropped if the report was edited or endorsed in the meantime.
7. Write `CASE_CREATED` / `AI_ANALYZED` as appropriate.

### 5. Radiologist: work list and endorse

Open **X-ray Worklist**. **Reg. Date** is the day the technician saved the film. A request with no film yet shows **—**. Outstanding films that are still running show **Generating**, and the list updates on its own when the draft is ready. When CURV finishes they show **Pending approve**. The left queue filters All work, Outstanding, Partially endorsed, Fully endorsed, Requested, and Urgent attention.

`POST /api/cases/:id/analyze` is the re-run path after a draft exists. It is not required to produce the first draft.

If CURV fails, the radiologist can complete the report by hand. Manual edits append `kind: manual` rows to `editLog`.

Referring **doctors** use the same grid as **Examination enquiry**. They only receive **requested** and **endorsed** rows.

- **View** → case chart
- **Edit report** / **Enquiry** → film + findings (doctors read the endorsed report; generating drafts stay closed)

Admins can tick rows and bulk-delete.

### 6. Report review

Left: the film. Right: the report box (editable while drafting), remarks, and the draft log.

**Film toolbar**

- **Zoom in** / **Zoom out** (or the mouse wheel)
- **Measure** — drag a line. Centimetres need `pixelSpacingMm` from the DICOM file; otherwise the length is in pixels. For a radiologist on a draft, each line is kept on the film in white, numbered, and listed under **Measurements (in the report)** with an optional name and **Delete**. A click without a drag adds nothing. Boxes fade while measuring
- **Draw box** — drag on the film. The new box is called “Marked area” and can be renamed in **Boxes on the film**
- **Hide boxes** / **Hide lines** — show the boxes and the measurements separately

**Editing boxes.** Click a box to select it (it fills and shows four corner handles). Drag inside to move it, or drag a corner to resize it. Unselected boxes are outlines only. Each box has its own colour; measurements are always white so they never match a box. The list tags each box **AI**, **AI · adjusted**, or **Manual**. Box editing is closed while Azure is placing boxes and after endorse.

**Report text.** The report box shows Findings and Impression. Thinking is hidden; saving an edit puts the stored Thinking back, so it is not lost and does not show up in the draft log. Edits stay on the page until **Save draft** or **Save remarks**. A Save draft that changes the report wording asks Azure to re-place boxes (`POST /summarise-findings`); the merge in `backend/utils/findingsMerge.js` keeps drawn boxes, adjusted boxes, and deleted boxes as the radiologist left them. Saving only boxes, measurements, or remarks does not call Azure. An older report with no boxes says so and gets boxes on the next Save draft.

While drafting, the page shows an **attribution log** (AI vs manual). Open a row to see the added, removed, and edited lines, boxes, and measurements. **Endorse report** issues a clean report: no Thinking section and no source tags for the referring doctor. Word and PDF include the date, reporting doctor, and signature.

Radiologist / admin can:

- Edit the report text, boxes, and measurements on non-endorsed cases
- **Re-run AI** — after a draft exists (clears the old boxes; Azure places new ones)
- **Save draft** / **Endorse report**
- **Share** / **Copy share link** — after endorse
- **Mark urgent** / **Remove urgent** (allowed after endorse)
- Save remarks (allowed after endorse; does **not** rewrite an endorsed report)
- **Report** / **Word** / **PDF**

Export composition (`src/lib/reportExport.js`): the report without Thinking, any **Measurements** section (`1. length: 14.29 cm`), remarks, and the sign-off. The film image in Word and PDF has the measurement lines and their numbered tags drawn on it. Downloads save unsaved edits first.

### 7. Endorse

`POST /api/cases/:id/finalize` sets `status: finalized` and records who signed. The screen calls this **Endorse**. It is refused while AI is still `running`. After endorse, boxes, measurements, and the stored report stay locked.

### 8. Share (public link)

After endorse, Review shows **Share**. That creates a token (`POST /api/cases/:id/share`) and copies `#/share/<token>`. Anyone with the link can open the film and the **clean** report without signing in. Shared images come from `GET /api/share/:token/image` (no JWT). `DELETE /api/cases/:id/share` revokes it.

### 9. Referring doctor

Sees requested exams and endorsed reports. Enquiry, share, and export of an endorsed report are read-only. The endorsed report has Findings, Impression, any measurements, the signature, and no Thinking section. The film shows the boxes and measurements; **Measure** works but nothing is saved. No re-run, no draft log, no save, no endorse.

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
| `monitor` / `labs` / `notes` | `clinical.js` | Sepsis, labs, care notes |
| `cases` / `case` | `cases.js` | Study records |
| `new` | `newCase.js` | Save the film for a request (starts CURV) |
| `review` | `review.js` | Film (boxes, measurements), editable draft, re-run AI, endorse |
| `share` | `shareView.js` | Public endorsed report (`#/share/<token>`) |
| `audit` | `audit.js` | Admin trail |
| `users` | `users.js` | Admin add / enable / disable / delete |
| `?view=report&caseId=` | `reportView.js` | Report popup and sign-off |

Shared pieces:

- `src/api.js` — `fetch` wrapper, Bearer token
- `src/lib/roles.js` — technician / radiologist / doctor / admin
- `src/lib/patientName.js` — first / middle / last
- `src/lib/tags.js` — urgent chip, patient name
- `src/lib/reportExport.js` — Word / PDF, hide and restore Thinking, measurements section
- `src/lib/diagnosis.js` — when the work-list label may be refreshed by Azure
- `backend/utils/findingsMerge.js` — merge a fresh Azure pass with the radiologist’s box edits
- `backend/utils/editDiff.js` — draft-log lines for report, box, remark, and measurement changes
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
| `POST` | `/api/cases/request` | doctor, admin | book a chest X-ray; optional `scheduledAt`, no film |
| `POST` | `/api/cases` | technician, admin | multipart PNG, JPG, WebP, or uncompressed DICOM; **starts CURV** |
| `GET` | `/api/cases/:id` | any | Doctors: requested or endorsed. Technicians: requested only |
| `PUT` | `/api/cases/:id` | radiologist, admin | report / remarks / urgent; `findings` (boxes) and `measurements` only when sent |
| `POST` | `/api/cases/:id/analyze` | radiologist, admin | re-run AI after a draft exists |
| `POST` | `/api/cases/:id/finalize` | radiologist, admin | endorse; stores `status: finalized` |
| `POST` | `/api/cases/:id/share` | radiologist, admin | public token for an endorsed report |
| `DELETE` | `/api/cases/:id/share` | radiologist, admin | revoke the share link |
| `POST` | `/api/cases/:id/summarise-findings` | radiologist, admin | Azure re-places boxes for the stored report, keeping manual edits |
| `POST` | `/api/cases/:id/summarise-diagnosis` | radiologist, admin | Work-list label; no-op until the radiologist has edited the draft |
| `POST` | `/api/cases/bulk-delete` | admin | |
| `DELETE` | `/api/cases/:id` | admin | |
| `GET` | `/api/share/:token` | public | endorsed case for a share link |
| `GET` | `/api/share/:token/image` | public | film for that share link |
| `GET` | `/api/patients` | any | includes patients with no studies |
| `POST` | `/api/patients` | technician, radiologist, admin | demo new patient |
| `GET`/`PUT` | `/api/patients/:id` | GET any; PUT as noted | doctors may save lab orders |
| `POST`/`DELETE` | `/api/patients/bulk-delete`, `.../:id` | admin | also deletes studies + images |
| `GET` | `/api/images/:id` | any | GridFS stream (JWT) |
| `GET` | `/api/audit-logs` | admin | |
| `POST`/`DELETE` | `/api/audit-logs/bulk-delete`, `.../:id` | admin | |
| `GET` | `/api/stats` | any | dashboard counters |
| `GET` | `/api/users` | admin | |
| `POST` | `/api/users` | admin | create; returns a one-time temporary password |
| `PUT` | `/api/users/:id/active` | admin | enable / disable |
| `DELETE` | `/api/users/:id` | admin | not self, not the last active admin |

On the dev Mac the API runs under the `com.radassist.nodebackend` LaunchAgent (nodemon), so backend edits reload on their own. Do **not** also start `node server.js` by hand: it grabs port 5002 and keeps serving the old code, and the LaunchAgent cannot take the port. If you run without the LaunchAgent, use `npm run dev` or restart `node server.js` after backend edits. `./start_server.sh` does not reload `middleware.py`.

---

## AI pipeline (detail)

### CURV / mlx_vlm

`./start_server.sh` starts:

1. `mlx_vlm.server --model ~/CURV-mlx --port 8080`
2. `uvicorn middleware:app --port 8001` from this repo

`backend/utils/aiService.js` posts the image to `POST {AI_BASE_URL}/analyze`. A `.dcm` upload is rendered to PNG before that call. If the file has pixel spacing, that spacing is kept so **Measure** can report centimetres. The middleware can render a DICOM file itself if one is posted directly. It resizes the **whole frame** (no crop) to the CURV preprocessor budget (`max_pixels` 50176, about 224×224). The call matches `CURV-main`: the system text in `training/prompts/prompt_cxr.txt`, then one user turn with the film and the line “Please analyze this chest X-ray image and generate a detailed radiology report following the specified format.” No file path is sent as text. Decoding follows `~/CURV-mlx/generation_config.json` (greedy, repetition penalty 1.05) with up to 1536 tokens, the CURV-main completion length. Patient age, sex, and history stay on the chart. CURV answers with `<findings>`, `<thinking>`, and `<impression>`. The text inside each tag is saved as Findings, Thinking, and Impression without rewording; a reply with no tags is saved as written. Thinking is stored with the draft but hidden on every page and in Word and PDF. No extra prompt or guidance is added on top of the training prompt, so CURV runs as it was trained. The review page shows the original image, not the resized one.

The middleware LaunchAgent (`com.radassist.middleware`) must point at this repo. An older copy elsewhere (for example `~/Desktop/fyp`) carries a different prompt and will silently change the reports.

### Azure OpenAI (optional)

Set in `backend/.env`:

- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_KEY`
- `AZURE_OPENAI_DEPLOYMENT`
- optional `AZURE_OPENAI_API_VERSION` (default `2024-10-21`)

Used for (`backend/utils/azureFindings.js`):

- **Film boxes** after CURV stores the draft, and again when a Save draft changes the report wording. Azure gets the report text and the film, and returns boxes with a severity; `normal` findings are not drawn. If vision boxes are missing, anatomical **zones** are used and the page says the boxes are approximate.
- A short **diagnosis** on the work list, but only after the radiologist has edited the draft. Until then the label is picked locally from CURV’s report text, with no Azure call (`diagnosisSource: local`).

Azure never writes `reportText`. If those env vars are absent, the app runs on CURV alone and the film has only the boxes the radiologist draws.

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
npm run dev            # nodemon on :5002 (or: node server.js)
```

If the `com.radassist.*` LaunchAgents are installed, they already run the backend, frontend, middleware, and model server. Restart one with `launchctl kickstart -k gui/$(id -u)/com.radassist.nodebackend` instead of starting a second copy.

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

That runs the suite in `scripts/test-*.mjs`: report unwrap/parse, the review page, automatic box placement, Azure bbox, confidence, export, report popup, diagnosis, patients, new patient, cases, pagination, new-case drop zone, DICOM, audit bulk-delete, users page, share page, analysis job, shell menu.

`scripts/test-review-page.mjs` clicks every control on the review page against a mocked API. That covers inline report edits, hidden Thinking, drawing, moving, resizing, and deleting boxes, the Azure merge after a report edit, measurements (saved, named, deleted, in the PDF), Endorse, Share, Word, PDF, and read-only roles.

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
2. Make sure only one backend owns port 5002 (`lsof -ti:5002`) and that it started after your last backend edit. Restart `start_server.sh` (or the middleware LaunchAgent) after any `middleware.py` edit.
3. Walk: doctor **Book chest X-ray** on the calendar → technician **Requested case** → save the film (draft generates on its own) → radiologist work list moves from **Generating** to **Pending approve** → Azure boxes appear on the film → edit the report, resize a box, draw one, measure a lesion → **Save draft** → download the PDF to show the measurement → **Endorse report** → doctor login reads the report without Thinking, with the signature → Share copies a public link.
4. Show Patient Master, an X-ray request on the chart, and Sepsis / labs / notes for a doctor. Show that a technician and a radiologist do not have labs or the audit log.
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
| Full DICOM viewer | Uncompressed `.dcm` is rendered to PNG. Compressed transfer syntaxes and a PACS viewer are still out of scope |
| Structured logs / request IDs | Helps debug CURV timeouts (180s) |

### Deployment sketch (if asked)

- Frontend: `npm run build` → static host; set the API origin or keep a reverse proxy `/api` → Express.
- Backend: Node 20+ on a VM or container; Cosmos connection string in a secret store.
- CURV: Apple Silicon (or a GPU box) close to the API; do not call mlx_vlm from the browser.
- Azure OpenAI: private endpoint if this ever leaves a student subscription.

### What this project is *not*

It is not a PACS, not a CE/FDA device, and not a substitute for a radiologist. Azure’s boxes are approximate and come from the report wording, not from CURV. Measurements are only as accurate as the DICOM pixel spacing.

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
