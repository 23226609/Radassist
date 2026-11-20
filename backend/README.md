# RadAssist AI — Backend

Express + Mongoose + Cosmos DB (Mongo API) backend for the FYP system. The root `README.md` is the full reference for roles, the data model, the AI pipeline and the UI; this file is the short backend summary.

## Run locally

```bash
cd backend
npm install
npm run dev          # nodemon on :5002
# or
npm start            # plain node on :5002
```

## Seed / migrate

```bash
npm run seed                    # demo users + sample cases (idempotent)
npm run migrate-workflow        # roles, analysisState, patient chart fields
npm run reset-demo-passwords    # set the demo accounts' passwords from backend/.env
```

Demo users: `tech` (technician), `priya` and `marcus` (radiologists), `doctor` (referring doctor), `admin`. Their passwords are not in the code. Set `SEED_TECH_PASSWORD`, `SEED_PRIYA_PASSWORD`, `SEED_MARCUS_PASSWORD`, `SEED_DOCTOR_PASSWORD` and `SEED_ADMIN_PASSWORD` in `backend/.env` (copy `backend/.env.example`). `seed` and `reset-demo-passwords` stop before connecting to the database, and change nothing, if one is missing, shorter than 6 characters, or still `CHANGE_ME`.

## Settings that protect the API

- `ALLOWED_ORIGINS` — comma-separated browser origins that may call the API from another origin. With nothing set, only `http://localhost:5173`, `5174`, `3000` and `http://127.0.0.1:5173` are allowed. `*` is ignored. The frontend reaches the API through the Vite proxy (`/api`), which does not depend on CORS. Code: `config/cors.js`.
- `JWT_SECRET` — signs login tokens. Use a long random value.
- Self-signup is closed: `POST /api/auth/register` needs an administrator's token.

## How a case moves

1. A doctor books a chest X-ray (`POST /api/cases/request`). The case is `requested`, with a day and a 30-minute slot and no film. The booking assigns a room, equipment, radiographer and preparation note.
2. A technician checks the patient in (`POST /api/cases/:id/arrive`) and saves the film (`POST /api/cases` with `requestCaseId`). A PNG, JPG, WebP or **uncompressed DICOM** is accepted. A `.dcm` film is rendered to a PNG with its pixel spacing kept. **Compressed DICOM transfer syntaxes are not supported**: the API answers 400 with “This DICOM uses a compressed transfer syntax. Please export it as uncompressed film or PNG.”
3. **AI starts automatically** when the film is saved. There is no Use AI click. The API answers at once with `analysisState: running`. In the background the whole frame is resized and sent to the CURV middleware, and the reply (`Findings`, `Thinking`, `Impression`) is stored as **sentence tags** plus a COMMENT line. The status becomes `pending_approve`. If CURV is down, a placeholder is stored and the radiologist completes the report by hand.
4. If Azure OpenAI is configured, it places **one film box per abnormal tag** (`boxesState`). CURV writes the text only; Azure never edits the report.
5. A radiologist reviews and edits the tags, boxes and measurements, then endorses (`POST /api/cases/:id/finalize`, stored as `status: finalized`). `POST /api/cases/:id/analyze` is the **re-run** path once a draft exists. It is not needed for the first draft.
6. After endorse, Azure writes the patient-chart findings from the clean report in the background.

Doctors see **requested and endorsed** cases only, never drafts. Technicians get **requested** cases only, with the film and report stripped.

## Endpoints

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| `GET`  | `/api/health` | public | Pings MongoDB |
| `POST` | `/api/auth/login` | public | Returns JWT + user |
| `POST` | `/api/auth/register` | admin | Create an account (clinical roles only). Not open to the public |
| `GET`  | `/api/auth/me` | auth | Current user |
| `POST` | `/api/auth/logout` | auth | Audit only |
| `GET`  | `/api/users` | admin | List all users |
| `POST` | `/api/users` | admin | Create an account; returns a one-time temporary password |
| `PUT`  | `/api/users/:id/active` | admin | Enable / disable |
| `DELETE`| `/api/users/:id` | admin | Not yourself, not the last active admin |
| `GET`  | `/api/cases` | auth | Doctors: `requested` and `finalized`. Technicians: `requested` only |
| `GET`  | `/api/cases/availability?from=&to=` | auth | Per-day and per-slot booking status |
| `POST` | `/api/cases/request` | doctor, admin | Book a chest X-ray `{ patientId, day, time, clinicalReason }` |
| `POST` | `/api/cases/:id/arrive` | technician, admin | Check-in: identity, patient number, request, body part, appointment |
| `POST` | `/api/cases` | technician, admin | Save the film for a request; **starts AI automatically** |
| `GET`  | `/api/cases/:id` | auth | Single case (doctors: requested or endorsed; technicians: requested only) |
| `PUT`  | `/api/cases/:id` | radiologist, admin | Edit tags, COMMENT, view, boxes, measurements, remarks, urgent |
| `POST` | `/api/cases/:id/analyze` | radiologist, admin | Re-run AI after a draft exists |
| `POST` | `/api/cases/:id/finalize` | radiologist, admin | Endorse |
| `POST`/`DELETE` | `/api/cases/:id/share` | radiologist, admin | Create / revoke a public link for an endorsed report |
| `POST` | `/api/cases/:id/summarise-findings` | radiologist, admin | Azure re-places boxes, keeping manual edits |
| `POST` | `/api/cases/:id/summarise-diagnosis` | radiologist, admin | Work-list label after a manual edit |
| `POST` | `/api/cases/:id/chart-findings` | radiologist, admin | Retry the patient-chart findings (endorsed cases) |
| `POST` | `/api/cases/bulk-delete` | admin | |
| `DELETE`| `/api/cases/:id` | admin | Hard delete |
| `GET`  | `/api/share/:token`, `/api/share/:token/image` | public | An endorsed case, by share link |
| `GET`  | `/api/images/:id` | auth | Stream GridFS image |
| `GET`  | `/api/audit-logs` | admin | Audit trail |
| `POST`/`DELETE` | `/api/audit-logs/bulk-delete`, `/api/audit-logs/:id` | admin | |
| `GET`  | `/api/stats` | auth | Dashboard counters |
| `GET`/`POST`/`PUT`/`DELETE` | `/api/patients` | see root README | Chart + vitals / labs / meds / notes. Doctors may save lab orders |

See the root `README.md` for the full API table, roles, and CMS layout.
