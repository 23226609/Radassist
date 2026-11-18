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
| Optional | Azure OpenAI: film boxes after the CURV draft, work-list label after a manual edit, patient-chart findings after endorse | env flags |

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
                         patient-chart findings from the endorsed report
```

**On booking** (`POST /api/cases/request`), the referring doctor picks a calendar day and a free 30-minute slot, within the per-slot and daily quota. The case is `status: requested`, with `scheduledAt` and no film. The chart button shows the booked day and time until a technician saves the film.

**On registration of the film** (`POST /api/cases`), the image is stored in GridFS and CURV starts in the background. There is no Use AI click. The API returns immediately; the radiologist work list shows **Generating**, then **Pending approve**. If CURV is down, the case stays stored so the radiologist can write the report by hand. **Re-run AI** is available after a draft exists.

**After the draft is stored**, Azure reads the CURV report and places boxes on the film (`boxesState: running` → `done` / `failed`). Azure does not rewrite the report or the work-list label at this step; the report text is CURV’s alone.

**On review**, the page shows the film and the report side by side, the way a hospital viewer does. The report is a **list of sentence tags**, one per finding sentence, under a header of the Radiology Examination fields this demo can fill (modality, examination name, examination date/time, report title, report date, reported by, referring doctor). The radiologist edits a tag's words, deletes it, switches it between normal and abnormal, and drags tags to reorder them. A new finding is added at the end. COMMENT stays under the list and is the one conclusive line. Each abnormal tag has one box on the film; a normal sentence has none. **Save draft** stores the tags and the assembled report, and Azure places a box only for an abnormal tag that has none. **Thinking** (the model’s reasoning) is kept in the stored draft but never shown to anyone and never exported. **Endorse** locks the report. The date, reporting doctor, and signature stay on the report and in both downloads.

**After endorse**, Azure reads the clean endorsed report (text only, no Thinking) in the background and writes the **Findings** shown on the patient chart (`chartFindingsState: running` → `done` / `failed`). The chart updates on its own when they land.

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

The chart lists **X-ray requests** separately from completed studies. **Book chest X-ray** opens the calendar with day status, times and quota. While a request is still open, the button reads **X-ray booked <day · time>**.

Deleting a **patient** removes the chart, every study for that ID, and GridFS images. Deleting a **case** removes that study and its image; the patient chart stays.

### Case

Stored in `cases`. One study / one film.

- Identity: `caseId`, `patientId`, name parts + `patientName`
- Clinical: `age`, `sex`, `history`, `diagnosis`, `diagnosisSource` (`azure` or `local`)
- Report: `reportText` (assembled from the tags, always what readers see), `remarks`, `findingTags[]` (one per FINDINGS sentence, in order), `comment` (the COMMENT line), `view` (`''` \| `PA` \| `AP` \| `AP supine`), `examinedAt`, `findings[]` (the film boxes, each with the `tagKey` of its sentence), `measurements[]`
- Imported MIMIC cases only: `sourceReport` (`label: "MIMIC report"`, `source`, `text`, `subjectId`, `studyId`, `dicomId`). The official report, kept as source text and never used as this system's draft
- AI: `analysisState` (`none` \| `running` \| `done`), `boxesState` (`''` not requested \| `running` \| `done` \| `failed`)
- Draft provenance: `editLog[]` (`kind`: `ai` \| `manual`). Shown on Review while drafting; **not** included in endorsed / shared / exported report text. API responses add `clinicianEdited` (true once a `manual` row exists)
- Workflow: `status` (`requested` no film yet \| `pending` outstanding or generating \| `pending_approve` draft ready \| `finalized` endorsed) and `urgent`. Old documents may still say `completed` — the UI treats that as pending approve
- Image: `imageId` (GridFS), filename / type / size. Hidden from technician responses. `registeredAt` is the day the technician saved the film; the work list **Reg. Date** uses that, not the request day. `pixelSpacingMm` is `[row, column]` in millimetres on the film when the DICOM file had it. Both DICOM tags are kept when present (`imagerPixelSpacingMm` from Imager Pixel Spacing (0018,1164), `dicomPixelSpacingMm` from Pixel Spacing (0028,0030)) with `pixelSpacingSource` saying which one `pixelSpacingMm` came from
- Booking: `scheduledAt`
- People: `requestedBy`, `requestedByName`, `createdBy`, `createdByName` (uploader), `finalizedBy`, `finalizedByName`, `finalizedAt`
- Share: `shareToken` (set when someone shares an endorsed report)
- Patient-chart findings (endorsed cases only): `chartFindings[]` (`label`, `detail`, `location`, `severity` `normal` \| `minor` \| `significant`), `chartFindingsState` (`''` not requested \| `running` \| `done` \| `failed` \| `unavailable` Azure not configured), `chartFindingsAt`, `chartFindingsError`. These are separate from `findings[]` (the film boxes) and are never written into the report

Work-list labels: **Requested**, **Generating**, **Pending approve**, **Endorsed**. The left queue calls a draft **Partially endorsed** and a locked report **Fully endorsed**, matching the RIS slide. Stored status for an endorsed report is still `finalized`.

A **finding** is one box on the film: `label`, `bbox` `[left, top, width, height]` in percent, `sentence`, `severity` (`normal` boxes are not drawn), `status`, `source` (`Azure` or `manual`), and `bboxSource`:

- `vision` / `zone` — Azure placed it from the image or from an anatomical zone
- `manual` — a box the radiologist drew (`source: manual`), or an Azure box they moved or resized
- `status: rejected` — an Azure box the radiologist deleted. It stays stored, hidden, so the next Azure pass does not bring it back. A deleted drawn box is removed outright

A **tag** is `key` (`t1`, `t2`, …), `text` (one sentence), `abnormal`, `manual` (typed or drawn by the radiologist), `kind` (`''` or `ctr` for the cardiothoracic-ratio sentence) and `boxDeclined` (the radiologist removed its box, so Azure must not add it again). A sentence is **normal** when it only states a negative or a normal appearance (“No pleural effusion.”, “Heart size is normal.”). A sentence naming an abnormality, hedged ones included (“Pneumonia cannot be excluded.”), is abnormal. The rules are one shared file, `shared/reportTags.js`, used by the browser and the API. A sentence that says nothing either way counts as abnormal, so it gets a box that can be switched off rather than no box.

A **measurement** is a line on the film: `x1`, `y1`, `x2`, `y2` (percent of the film), `kind` (`lesion`, `ctr-heart`, `ctr-thorax`), `tagKey`, `dxPx`, `dyPx`, `lengthPx`, `lengthMm` (null with no spacing), `spacingTag` (`ImagerPixelSpacing` or `PixelSpacing`, the tag that supplied the number), `text` and an optional `label`.

**Locking:** after endorse, diagnosis, report text, boxes, and measurements cannot change. Remarks and the urgent flag still can. Referring doctors never receive `editLog` or source tags. Technicians never receive the film, report, findings, or chart findings.

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

The full Master Index table has a **Monitor** column with **Sepsis** and **Notes** buttons for each patient. Admins tick rows there to bulk-delete.

The chart shows prior medicines, heart rate, lab results, health metrics, and the review state from the latest observations. A referring doctor can order labs. A technician or radiologist cannot.

**Findings.** Written by Azure AI only after a radiologist endorses a report, one block per endorsed study (case, date, **Endorsed by …**), each finding with a **Significant** / **Minor** / **Normal** tag. Draft reports never appear here.

- Endorse queues a text-only Azure call on the clean report (no Thinking). The chart shows “Azure AI is reading the endorsed report…” and checks every 4 seconds until the findings land.
- Reports endorsed before this feature, or while Azure was down, get theirs the first time the chart is opened. Two people opening the chart at once start only one Azure call.
- If Azure fails, or a run was lost (still running after 3 minutes), a radiologist or admin sees **Retry Azure AI** (`POST /api/cases/:id/chart-findings`). With no Azure configured the block says so.
- Technicians do not see this section.

**Care notes.** Shown only when the patient has notes: the 3 newest first (author · role, category · time, note), with **Show all N notes**.

**Sepsis monitor and Care notes windows.** **Sepsis monitor** and **Care notes** in the chart header (or **Sepsis** / **Notes** on a Master Index row, or **Open Nursing / Care Notes** in the Care notes section) open that patient in a separate browser window: `?view=sepsis&patientId=…` or `?view=notes&patientId=…`. Each window shows one patient only, with no worklist or patient picker, so it can sit beside the chart or on another screen.

- The two use different windows, so both can be open with the chart. Opening either for another patient reuses its window.
- Vitals or notes saved in a window are posted back to the chart that opened it, which updates without a reload. Drafts you are still typing on the chart are left alone.
- If the browser blocks pop-ups, the same view opens as a floating, draggable, resizable panel on the page (no backdrop). The panel closes when you leave Patient Master.

**Patient chart window from the report.** On the review page, **Patient chart** (first button in the toolbar) opens the whole chart for that patient in its own window (`?view=patient&patientId=…`). The radiologist can read history, labs, vitals, earlier findings and care notes while the report stays open. The window has no **Delete**, **New case** or back-to-list button. Clicking a study in it opens that study in the main window. If pop-ups are blocked, the chart opens as a floating panel on the review page instead.

### 3. Doctor: book the exam

On the patient chart, **Book chest X-ray** opens a month calendar that loads availability from `GET /api/cases/availability?from=&to=`. Each day shows its status: **N left** (green), **few left** (amber, 4 or fewer), **Full** (red), **Closed** (Sundays), or grey for days that have passed. Drag the **Chest X-ray** chip onto a day, or click the day, then pick a time. Times run every 30 minutes from 09:00–12:30 and 14:00–16:30, and each one shows how many places are free (**2 of 2 free**, **Full**, or **Passed**). **Confirm booking** calls `POST /api/cases/request` with `{ patientId, day, time }`.

- **Quota.** Each 30-minute slot takes `XRAY_SLOT_CAPACITY` X-rays (default 2), and each day takes `XRAY_DAILY_QUOTA` (default 20). The server checks both when a booking is made. If two doctors take the last place at the same moment, the later booking is removed and the doctor is asked to choose another time.
- **Time zone.** Days and times are hospital local time (`BOOKING_UTC_OFFSET`, default `+08:00`), whatever the server's own time zone is.
- **Status.** The case is `status: requested`, diagnosis “Chest X-ray requested”, with no image. A second open request for the same patient is refused. The header button reads **X-ray booked <day · time>** until the technician saves the film. **X-ray requests** shows **Booked for <day · time>** with **Booked · waiting for film**, which changes to **Due · waiting for film** once the time has passed. The technician's **Requested case** queue shows a **Booked for** column, with the soonest booking first.

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

Open **X-ray Worklist**. **Reg. Date** is the day the technician saved the film. A request with no film yet shows **—**. Films that are still running show **Generating**, and the list updates on its own when the draft is ready. When CURV finishes they show **Pending approve**. Click **Reg. Date** to sort newest or oldest first. The left queue filters All work, Partially endorsed, Fully endorsed, Requested, and Urgent attention.

`POST /api/cases/:id/analyze` is the re-run path after a draft exists. It is not required to produce the first draft.

If CURV fails, the radiologist can complete the report by hand. Manual edits append `kind: manual` rows to `editLog`.

Referring **doctors** use the same grid as **Examination enquiry**. They only receive **requested** and **endorsed** rows.

- **View** → case chart
- **Edit report** / **Enquiry** → film + findings (doctors read the endorsed report; generating drafts stay closed)

Admins tick rows and use **Delete (n)** beside the search box. It stays greyed out until a row is ticked.

### 6. Report review

Left: the film. Right: the report (editable while drafting), remarks, and the draft log.

**The report as sentence tags**

```
XRAY CHEST (PA)
FINDINGS
one sentence per line
COMMENT
– one conclusive line
Thank you for your referral.
the endorsing radiologist's name
```

- Each finding is a **tag**: edit its words, **Delete** it, switch it **normal / abnormal**, or drag it by its handle to a new place. Type a new finding in the box under the list and it is appended at the end.
- **COMMENT** stays under the list. It is not part of the drag order, it is the conclusive line (eHR Content Standards Guidebook 8.17.5), and it never has a film box.
- A CURV draft is split into sentences, one tag per sentence in order, and its Impression becomes COMMENT. An older case that has only `reportText` is split once when it is opened and saved on the next **Save draft**.
- `reportText` is assembled from the tags and COMMENT every time they change, so the referring doctor, the share link and both downloads match the screen.
- Click a tag to select its box, and click a box to select its tag. A normal sentence is still in the report and both downloads, but has no box. **Remove box** takes a box away from an abnormal tag and Azure will not put it back.
- **View** (blank, PA, AP, AP supine) sets the report title and what a cardiothoracic ratio means.
- The header shows modality **XRAY**, examination name (Chest plus the view when known), examination date/time, report title, report date (the endorse date), reported by and the referring doctor. This is only the Appendix A-XVI (Radiology Examination) fields this demo can fill; no eHR submission is built, and a chest X-ray is not filed under Appendix A-XVII.

**Film toolbar**

- **Zoom in** / **Zoom out** (or the mouse wheel)
- **Measure** — drag a line across a lesion. The film centimetres come from Imager Pixel Spacing (0018,1164), else from Pixel Spacing (0028,0030). The label also shows the **magnification** and the **size in the body** when the file itself records one of these, in this order: Pixel Spacing smaller than Imager Pixel Spacing (the vendor's patient-plane calibration, DICOM CP-586), Estimated Radiographic Magnification Factor (0018,1114), Distance Source to Detector with Body Part Thickness (a mid-chest estimate), or Distance Source to Detector with Distance Source to Patient (the plane against the detector). A tube distance is never guessed from a missing tag. Without a calibration the label stays film size and says body size is unavailable, with the reason: AP and AP supine do not use the 180 cm erect-PA geometry, and an unrecorded view has no projection to correct. An erect PA film may also show a separate experimental estimate (180 cm and an unmeasured 11 cm depth), labelled as not DICOM-calibrated. If the selected view is PA erect but the DICOM view, patient position, or description says portable or supine, body-size estimation is disabled and the page asks for the projection to be checked. The dropdown is not changed automatically. With no spacing the length is in pixels. The measurement is written into the selected abnormal sentence, or starts a new finding when nothing is selected
- **Heart size** — draw the greatest transverse cardiac diameter, then the greatest inner thoracic diameter. The ratio comes from the two lengths with the same row and column spacing, and the sentence reads like “Cardiothoracic ratio is normal, 10.5 : 27.5.” (each diameter rounded to one decimal). On an erect **PA** view a ratio of 0.50 or less is normal and has no box; above 0.50 the sentence says the ratio is increased and gets one box on the heart line. On AP, supine or unknown the ratio is written with “this is not a formal PA measurement”, is not called normal, and has no box. Removing one diameter removes the ratio sentence
- **Draw box** — drag on the film. With an abnormal tag without a box selected, the box belongs to that tag; otherwise it starts a new finding at the end
- **Hide boxes** / **Hide lines** — show the boxes and the measurements separately

**Editing boxes.** Click a box to select it (it fills and shows four corner handles). Drag inside to move it, or drag a corner to resize it. Unselected boxes are outlines only. Each box has its own colour; measurements are always white so they never match a box. Box editing is closed while Azure is placing boxes and after endorse.

**Saving.** Edits stay on the page until **Save draft** or **Save remarks**. A Save draft that changes a sentence, or switches a tag to abnormal, asks Azure (`POST /summarise-findings`) for a box for each abnormal tag that has none: one box per tag, and none for a normal tag. The merge in `backend/utils/findingsMerge.js` (`mergeTagBoxes`) keeps the boxes the radiologist drew, moved or removed. Reordering, COMMENT, remarks, boxes and measurements alone do not call Azure. Thinking is hidden; saving puts the stored Thinking back, so it is not lost and does not show up in the draft log.

While drafting, the page shows an **attribution log** (AI vs manual). Open a row to see the added, removed, and edited lines, boxes, and measurements. **Endorse report** issues a clean report: no Thinking section and no source tags for the referring doctor.

Radiologist / admin can:

- Edit tags, boxes, and measurements on non-endorsed cases
- **Re-run AI** — after a draft exists (clears the old tags, boxes and measurements; the new draft is split into tags and Azure places new boxes)
- **Save draft** / **Endorse report**
- **Share** / **Copy share link** — after endorse
- **Mark urgent** / **Remove urgent** (allowed after endorse)
- Save remarks (allowed after endorse; does **not** rewrite an endorsed report)
- **Word** / **PDF**, and **Word with finding films** / **PDF with finding films**

**Two downloads, Word and PDF** (`src/lib/reportExport.js`; both are built from the same list of blocks):

- **Plain report** — the header, the report in the layout above, the endorsing name and date, and one clean film with no boxes and no measurement lines.
- **Report with finding films** — the same text, then for each **abnormal** tag only, the whole film again with only that tag's box. When that tag has a measurement, the whole film is repeated once more with only the measurement line, followed by a short description. The line is not drawn on the box film. A normal sentence is in the text and gets no extra picture.
  - Heart size description: the two film-size diameters, the ratio, the PA threshold of 0.50, and the sentence that these centimetres are the size on the film, not inside the body.
  - Lesion description: the film-size length (or that centimetres are unavailable) and the same limitation.
  - Each description names the spacing tag that supplied the number.

Downloads save unsaved edits first. The finding films are drawn in the browser; the PDF writer embeds JPEG, so a PNG film is re-encoded first.

### 7. Endorse

`POST /api/cases/:id/finalize` sets `status: finalized` and records who signed and when (`finalizedAt`). The screen calls this **Endorse**. It is refused while AI is still `running`. After endorse, boxes, measurements, and the stored report stay locked.

Endorse also queues the patient-chart findings (`backend/utils/chartFindings.js`). The response comes back at once with `chartFindingsState: running`, and the radiologist sees “Report endorsed. Azure AI is writing the findings on the patient chart.” A result is dropped if the report changed in the meantime.

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
| `?view=sepsis&patientId=` / `?view=notes&patientId=` | `src/lib/chartWindow.js` → `clinical.js` | One patient's Sepsis Monitor / Care Notes in its own window |
| `?view=patient&patientId=` | `src/lib/chartWindow.js` → `patients.js` | Patient chart window opened from the review page |

Shared pieces:

- `src/api.js` — `fetch` wrapper, Bearer token
- `src/lib/roles.js` — technician / radiologist / doctor / admin
- `src/lib/patientName.js` — first / middle / last
- `src/lib/tags.js` — urgent chip, patient name
- `shared/reportText.js`, `shared/reportTags.js` — plain ES modules used by **both** the browser and the API (`backend/utils/tagReport.js` loads them with `import()`): remarks and Thinking handling, sentence splitting, normal/abnormal, tags, and the assembled report
- `src/lib/findingTags.js` — add, edit, delete, flip, reorder; box and measurement edits as pure functions on a case
- `src/lib/measure.js` — spacing tags, film-size wording, cardiothoracic ratio, the measurement descriptions
- `src/lib/reportExport.js` — header fields, the report layout, and the plain and finding-films Word / PDF
- `src/lib/diagnosis.js` — when the work-list label may be refreshed by Azure
- `backend/utils/findingsMerge.js` — merge a fresh Azure pass with the radiologist’s box edits (`mergeTagBoxes`: one box per abnormal tag, never one for a normal tag)
- `backend/utils/mimic.js`, `backend/scripts/import-mimic.js` — the MIMIC-CXR cohort import (below)
- `backend/utils/editDiff.js` — draft-log lines for report, box, remark, and measurement changes
- `src/lib/ui.js` — search, chips, empty states, urgent sort
- `src/lib/caseStatus.js` — requested / outstanding / generating / pending approve / endorsed
- `src/lib/analysisJob.js` — poll while a report is generating
- `src/lib/chartWindow.js` — Sepsis / Care notes windows, the blocked-pop-up panel, and the buttons that open them
- `src/lib/bulkSelect.js` — admin row checkboxes and the **Delete (n)** button
- `backend/utils/chartFindings.js` — queue, claim, and save the patient-chart findings after endorse
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
| `GET` | `/api/cases/availability?from=&to=` | any signed-in user | per-day and per-slot booking status, quota and places left (up to 62 days) |
| `POST` | `/api/cases/request` | doctor, admin | book a chest X-ray for `{ patientId, day, time }` within the slot and daily quota; no film |
| `POST` | `/api/cases` | technician, admin | multipart PNG, JPG, WebP, or uncompressed DICOM; **starts CURV** |
| `GET` | `/api/cases/:id` | any | Doctors: requested or endorsed. Technicians: requested only |
| `PUT` | `/api/cases/:id` | radiologist, admin | `findingTags`, `comment`, `view` (the server re-assembles `reportText` from them) / remarks / urgent; `findings` (boxes) and `measurements` only when sent |
| `POST` | `/api/cases/:id/analyze` | radiologist, admin | re-run AI after a draft exists |
| `POST` | `/api/cases/:id/finalize` | radiologist, admin | endorse; stores `status: finalized` |
| `POST` | `/api/cases/:id/share` | radiologist, admin | public token for an endorsed report |
| `DELETE` | `/api/cases/:id/share` | radiologist, admin | revoke the share link |
| `POST` | `/api/cases/:id/summarise-findings` | radiologist, admin | Azure re-places boxes for the stored report, keeping manual edits |
| `POST` | `/api/cases/:id/summarise-diagnosis` | radiologist, admin | Work-list label; no-op until the radiologist has edited the draft |
| `POST` | `/api/cases/:id/chart-findings` | radiologist, admin | endorsed cases only; ask Azure again for the patient-chart findings (Retry) |
| `POST` | `/api/cases/bulk-delete` | admin | |
| `DELETE` | `/api/cases/:id` | admin | |
| `GET` | `/api/share/:token` | public | endorsed case for a share link |
| `GET` | `/api/share/:token/image` | public | film for that share link |
| `GET` | `/api/patients` | any | includes patients with no studies |
| `POST` | `/api/patients` | technician, radiologist, admin | demo new patient |
| `GET`/`PUT` | `/api/patients/:id` | GET any; PUT as noted | doctors may save lab orders. GET returns each endorsed case's `chartFindings` (not to technicians) and starts any that are missing |
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

- **Film boxes** after CURV stores the draft, and again when a Save draft changes a sentence or switches a tag to abnormal. Azure gets only the **abnormal** sentence tags (with their keys) and the film, and returns **one box per tag** (`placeTagBoxes`). A normal tag is never sent, so it never gains a box; a tag whose box the radiologist removed is not sent either; the cardiothoracic-ratio sentence is boxed by the heart-size tool. Boxes the radiologist drew, moved or removed are kept (`mergeTagBoxes`). If Azure gives no usable box for a tag, it falls back to an anatomical-zone box (`bboxSource: zone`) that the radiologist can move, resize or remove.
- A short **diagnosis** on the work list, but only after the radiologist has edited the draft. Until then the label is picked locally from CURV’s report text, with no Azure call (`diagnosisSource: local`).
- **Patient-chart findings** after endorse (`summariseChartFindings`). Text only, Thinking removed, at most 6 grouped findings with a severity. Stored in `chartFindings[]` on the case.

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

That runs the suite in `scripts/test-*` (`.mjs` and `.cjs`): sentence tags and the normal/abnormal rules, measurement and the cardiothoracic ratio, the tag edit functions, the report layout and the two downloads, the API side of tags (`test-tag-backend.cjs`), the MIMIC import (`test-mimic-import.cjs`), report unwrap/parse, the review page, automatic box placement, Azure bbox, confidence, export, report popup, diagnosis, patients, new patient, cases, pagination, new-case drop zone, DICOM, audit bulk-delete, users page, share page, analysis job, shell menu.

`scripts/test-patient-page.mjs` covers the chart: Azure findings only for endorsed reports, the running / failed / Retry states, hiding findings from technicians, the Care notes section, the Sepsis and Care notes windows (URL, separate windows, window reuse, saves posted back to the chart), and the blocked-pop-up panel.

`scripts/test-review-page.mjs` clicks every control on the review page against a mocked API. That covers one tag per sentence, drag to reorder, add at the end, edit and delete a tag, normal/abnormal, tag and box selection, a normal sentence having no box, Azure being asked for one box per abnormal tag only, the heart-size flow on PA and AP views, a lesion line written into its sentence, hidden Thinking, drawing, moving, resizing and deleting boxes, Endorse, Share, Word, PDF and the finding-films downloads, an older case split once, and read-only roles.

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

## MIMIC-CXR cohort (about 2,000 histories)

For realistic histories, the repo can load about 2,000 distinct MIMIC-CXR subjects as cases that are **waiting for AI**. Images come from **MIMIC-CXR-JPG 2.1.0** and the history from the official **MIMIC-CXR** report text files. You need PhysioNet credentialed access.

**Never commit MIMIC files, PhysioNet credentials, or `.env`.** Downloads go in `data/mimic/`, which `.gitignore` covers (as it does `.env`, `.netrc`, `*.dcm`). The scripts refuse a data folder that git does not ignore.

1. Put the credential in `~/.netrc` (and `chmod 600 ~/.netrc`):

   ```
   machine physionet.org login YOUR_USER password YOUR_PASSWORD
   ```

2. Download the metadata, straight from its file URL with wget (or `aria2` as the second argument):

   ```sh
   backend/scripts/mimic-download.sh metadata
   ```

3. Choose the subjects. No image is downloaded and no database is opened here:

   ```sh
   npm run mimic:plan -- --count 2000 --dicom 20
   ```

   It picks distinct subjects who have a frontal view, **PA before AP**, one film each, by a seeded shuffle (repeatable), with about 15% spare in case a report has no indication. It writes `data/mimic/plan/` with `urls-jpg.txt`, `urls-reports.txt` and, for `--dicom N`, `urls-dicom.txt` (a small set of PA films only).

4. Download the JPEGs and the report text files. Do **not** download 2,000 DICOM files:

   ```sh
   backend/scripts/mimic-download.sh jpg
   backend/scripts/mimic-download.sh reports
   backend/scripts/mimic-download.sh dicom      # only the small set, for the measurement demo
   ```

5. Import. **Dry run by default**: it reads the files, counts what it would load and writes nothing.

   ```sh
   npm run mimic:import                 # dry run
   npm run mimic:import -- --apply      # writes the cases
   ```

What each case is:

- Patient id `PT-MIMIC-{subject_id}` and case id `CASE-MIMIC-{study_id}`, which cannot collide with demo ids. One frontal JPEG each, stored as downloaded.
- **History** is the report's INDICATION (or else CLINICAL HISTORY) section, verbatim. A report with neither, or only de-identification blanks, is skipped rather than filled in.
- No medicines, heart rate, lab results, age or sex are invented. The JPEG has no pixel spacing, so measurements show pixels only.
- `sourceReport` keeps the official report as source text labelled **MIMIC report**, separate from this system's draft (`reportText` stays empty). The case page shows it as its own card.
- Status is `pending` with `analysisState: none` (the work list says **Awaiting AI**). The import never calls CURV or Azure and never endorses; a radiologist runs the AI later from the review page.

The DICOM films are for the measurement demo: upload one as a new case (the existing DICOM path) to get Imager Pixel Spacing and Pixel Spacing from its header.

---

## Recommendations

### For the demo / viva

1. Start backend, Vite, and `start_server.sh` before the session. Confirm `/api/health` says `mongo: "up"` and `:8001/health` is OK. Wait until the model has finished loading.
2. Make sure only one backend owns port 5002 (`lsof -ti:5002`) and that it started after your last backend edit. Restart `start_server.sh` (or the middleware LaunchAgent) after any `middleware.py` edit.
3. Walk: doctor **Book chest X-ray** on the calendar → technician **Requested case** → save the film (draft generates on its own) → radiologist work list moves from **Generating** to **Pending approve** → Azure boxes appear on the film → edit the report, resize a box, draw one, measure a lesion → **Save draft** → download the PDF to show the measurement → **Endorse report** → open the patient chart and watch Azure write the **Findings** → doctor login reads the report without Thinking, with the signature → Share copies a public link.
4. Show Patient Master, an X-ray request on the chart, and Sepsis / labs / notes for a doctor. Open **Sepsis monitor** and **Care notes** from the chart so both windows sit beside it, record a vital and a note, and show the chart update. Show that a technician and a radiologist do not have labs or the audit log.
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

It is not a PACS, not a CE/FDA device, and not a substitute for a radiologist. Azure’s boxes are approximate and come from the report wording, not from CURV. Every centimetre is the size of the shadow on the film, not inside the body, and is only as good as the DICOM pixel spacing. The normal/abnormal split is a rule-based reading of one sentence, and the radiologist can switch it.

---

## Security

- Never commit `.env`, `node_modules`, `uploads`, or `dist`.
- Seed accounts are for local/demo use only.
- Helmet is on; CORS is intentionally loose for local Vite ports.
- GridFS images under `/api/images/:id` require a valid JWT. A **share link** is the exception: `GET /api/share/:token` and `.../image` are public for that one endorsed case.
- Technician API responses omit the film, report text, findings, and patient-chart findings.
- The Sepsis / Care notes windows only accept chart updates posted from the same origin.

---

## Repo layout

```
src/                  UI (Vite) — CMS shell + X-ray + clinical modules
backend/              Express API, models, seed, Azure/CURV helpers
middleware.py         FastAPI wrapper around mlx_vlm (started by start_server.sh)
shared/               ES modules used by both the browser and the API (report text and sentence-tag rules)
scripts/              Tests (frontend, API helpers, MIMIC import) + e2e
data/                 (git-ignored) MIMIC downloads; never committed
docs/                 FYP plan, initial analysis, Azure findings setup
```
