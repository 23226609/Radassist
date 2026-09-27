# RadAssist AI — Backend

Express + Mongoose + Cosmos DB (Mongo API) backend for the FYP system.

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
npm run reset-demo-passwords    # re-hash tech123 / priya123 / doctor123 / admin123
```

Demo users: `tech` / `tech123` (technician), `priya` / `priya123` (radiologist), `doctor` / `doctor123` (referring doctor), `admin` / `admin123`.

Upload (`POST /api/cases`) stores the film only. Radiologists start AI with `POST /api/cases/:id/analyze`.

## Endpoints

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| `GET`  | `/api/health` | public | Pings MongoDB |
| `POST` | `/api/auth/login` | public | Returns JWT + user |
| `POST` | `/api/auth/register` | public | Demo signup |
| `GET`  | `/api/auth/me` | auth | Current user |
| `GET`  | `/api/users` | admin | List all users |
| `PUT`  | `/api/users/:id/active` | admin | Enable / disable |
| `GET`  | `/api/cases` | auth | Doctors only see finalized |
| `POST` | `/api/cases` | technician, admin | Upload; no AI |
| `POST` | `/api/cases/:id/analyze` | radiologist, admin | One-click AI |
| `GET`  | `/api/cases/:id` | auth | Single case |
| `PUT`  | `/api/cases/:id` | radiologist, admin | Edit findings / remarks |
| `POST` | `/api/cases/:id/finalize` | radiologist, admin | Sign off |
| `DELETE`| `/api/cases/:id` | admin | Hard delete |
| `GET`  | `/api/images/:id` | auth | Stream GridFS image |
| `GET`  | `/api/audit-logs` | radiologist, admin | Audit trail |
| `GET`  | `/api/stats` | auth | Dashboard counters |
| `GET`/`POST`/`PUT` | `/api/patients` | see root README | Chart + vitals / labs / meds / notes |

See the root `README.md` for the full API table, roles, and CMS layout.
