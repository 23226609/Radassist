"""Remove markdown (# and *) from reports already stored in MongoDB.

New uploads are cleaned by middleware._plain_text before they are saved, so
this only exists to bring older cases in line. The original text is kept in
`reportTextMarkdown` so the change can be undone.

Usage, from the repo root:

    /usr/local/bin/python3.12 scripts/strip-report-markdown.py           # dry-run
    /usr/local/bin/python3.12 scripts/strip-report-markdown.py --apply
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import middleware as m  # noqa: E402  (path set up above)

APPLY = "--apply" in sys.argv

targets = []
for doc in m.cases_col.find({}):
    raw = doc.get("reportText") or ""
    if not raw.strip():
        continue
    clean = m._plain_text(raw)
    if clean and clean != raw:
        targets.append((doc, raw, clean))

print(f"mode = {'APPLY' if APPLY else 'DRY-RUN'}")
print(f"cases still containing markdown: {len(targets)}\n")

for doc, raw, clean in targets:
    marks = sum(raw.count(c) for c in "#*")
    print(f"  {str(doc.get('caseId') or doc['_id'])[:26]:28} "
          f"patient={str(doc.get('patientId')):16} status={str(doc.get('status')):10} "
          f"{len(raw):>6} -> {len(clean):<6} chars  ({marks} markdown chars removed)")

if not targets:
    print("Nothing to do.")
    sys.exit(0)

if not APPLY:
    print("\nDRY-RUN. Re-run with --apply to write.")
    sys.exit(0)

updated = 0
for doc, raw, clean in targets:
    update = {"reportText": clean}
    # Snapshot the original only once so re-running cannot clobber it.
    if not doc.get("reportTextMarkdown"):
        update["reportTextMarkdown"] = raw
    updated += m.cases_col.update_one({"_id": doc["_id"]}, {"$set": update}).modified_count

print(f"\nupdated {updated}/{len(targets)} cases (original kept in reportTextMarkdown)")
