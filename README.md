# RadAssist AI Frontend Prototype

Frontend-only Final Year Project prototype built with React, Vite, Tailwind CSS, and mock browser data.

## Run locally

1. Install Node.js 18 or newer.
2. Open a terminal in this folder.
3. Run `npm install`.
4. Run `npm run dev`.
5. Open the local URL shown by Vite, usually `http://localhost:5173`.

## Demo sign-in

- Doctor: `doctor@demo.com` (username `doctor`, password `doctor123`)
- Nurse: `nurse@demo.com` (username `nurse`, password `nurse123`)
- Admin: `admin` / `admin123`

The backend verifies passwords with bcrypt, so the exact seeded values above
are required. If the database is empty, run `npm run seed` from the
`backend/` folder first (this populates users, sample cases, and audit
log entries).

## Scope

This download is frontend-only. It does not connect to Express, MongoDB, Cosmos DB, Multer, or a real AI model. Data resets when the page reloads.

## Security reminder

Never commit a future `.env` file. `.env`, `node_modules`, and `uploads` are already included in `.gitignore`.
# Radassist
