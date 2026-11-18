#!/usr/bin/env bash
# Download MIMIC-CXR-JPG files straight from their PhysioNet URLs with wget or
# aria2. The credential comes from ~/.netrc and is never written anywhere else:
#
#   machine physionet.org login YOUR_USER password YOUR_PASSWORD
#
# Keep ~/.netrc at chmod 600. Files go to data/mimic/, which git ignores.
# Do not commit MIMIC files, PhysioNet credentials or .env.
#
#   backend/scripts/mimic-download.sh metadata          # the metadata CSV
#   backend/scripts/mimic-download.sh jpg    [aria2]    # ~2,000 frontal JPEGs
#   backend/scripts/mimic-download.sh reports [aria2]   # their report text files
#   backend/scripts/mimic-download.sh reports-zip       # one 135 MB zip of every report
#   backend/scripts/mimic-download.sh dicom  [aria2]    # a few DICOM files only
#
# Do not download the 4.7 TB DICOM tree. A chest history is the report text.
#
# Run `import-mimic.js plan` between "metadata" and the others.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA="${MIMIC_DATA_DIR:-$ROOT/data/mimic}"
PLAN="$DATA/plan"
NETRC="${NETRC:-$HOME/.netrc}"
BASE="https://physionet.org/files/mimic-cxr-jpg/2.1.0"

what="${1:-}"
tool="${2:-wget}"

if [[ -z "$what" ]]; then
  sed -n '2,15p' "${BASH_SOURCE[0]}"
  exit 1
fi

if ! grep -q "physionet.org" "$NETRC" 2>/dev/null; then
  echo "No physionet.org entry in $NETRC. Add:  machine physionet.org login USER password PASSWORD" >&2
  exit 1
fi
if [[ "$(stat -f '%Lp' "$NETRC" 2>/dev/null || stat -c '%a' "$NETRC")" != "600" ]]; then
  echo "Run: chmod 600 $NETRC" >&2
  exit 1
fi

# Refuse to download into a folder git would pick up.
mkdir -p "$DATA"
if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse >/dev/null 2>&1; then
  case "$DATA" in
    "$ROOT"/*)
      if [[ "$(git -C "$ROOT" check-ignore -q "$DATA/.probe"; echo $?)" == "1" ]]; then
        echo "$DATA is not git-ignored. Add data/ to .gitignore first." >&2
        exit 1
      fi
      ;;
  esac
fi

# Drop the dataset prefix so files/pNN/pSUBJECT/... lands under $dest.
rel_of() {
  local url="$1" rest
  rest="${url#https://physionet.org/}"
  printf '%s' "$rest" | cut -d/ -f4-
}

curl_one() {
  local url="$1" dest="$2" rel out
  rel="$(rel_of "$url")"
  out="$dest/$rel"
  mkdir -p "$(dirname "$out")"
  if [[ -s "$out" ]]; then
    echo "have $rel"
    return 0
  fi
  curl --netrc-file "$NETRC" --fail --location --retry 5 --retry-delay 3 --continue-at - --output "$out" "$url"
}

# One list of URLs into one folder, keeping the files/pNN/pSUBJECT/... layout.
# wget:  --cut-dirs=3 drops files/mimic-cxr-jpg/2.1.0 (or mimic-cxr/2.1.0).
fetch_list() {
  local list="$1" dest="$2" url
  if [[ ! -s "$list" ]]; then
    echo "Missing $list. Run: node backend/scripts/import-mimic.js plan" >&2
    exit 1
  fi
  mkdir -p "$dest"
  if [[ "$tool" == "aria2" ]]; then
    # aria2 reads ~/.netrc by itself. -c resumes. It saves flat into $dest,
    # and the import step finds the files there too.
    aria2c --netrc-path="$NETRC" -c -j 8 -x 2 --auto-file-renaming=false -d "$dest" -i "$list"
  elif command -v wget >/dev/null 2>&1; then
    # wget reads ~/.netrc by itself when no --user is given.
    wget -c -N -x -nH --cut-dirs=3 --no-verbose -P "$dest" -i "$list"
  else
    while IFS= read -r url; do
      [[ -z "$url" || "$url" == \#* ]] && continue
      curl_one "$url" "$dest"
    done < "$list"
  fi
}

fetch_url() {
  local url="$1" dest="$2"
  mkdir -p "$dest"
  if command -v wget >/dev/null 2>&1; then
    wget -c -N --no-verbose -P "$dest" "$url"
  else
    curl_one "$url" "$dest"
  fi
}

case "$what" in
  metadata)
    fetch_url "$BASE/mimic-cxr-2.0.0-metadata.csv.gz" "$DATA/metadata"
    ;;
  jpg)      fetch_list "$PLAN/urls-jpg.txt" "$DATA/jpg" ;;
  reports)  fetch_list "$PLAN/urls-reports.txt" "$DATA/reports" ;;
  reports-zip)
    fetch_url "https://physionet.org/files/mimic-cxr/2.1.0/mimic-cxr-reports.zip" "$DATA"
    unzip -n -q "$DATA/mimic-cxr-reports.zip" -d "$DATA/reports"
    ;;
  dicom)    fetch_list "$PLAN/urls-dicom.txt" "$DATA/dicom" ;;
  *) echo "unknown target: $what" >&2; exit 1 ;;
esac
