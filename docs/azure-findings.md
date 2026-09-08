# Summarising findings with Azure AI

The review page shows findings as cards in a carousel. By default those cards
come from a regex parser in `src/components/review.js`, which splits the report
on numbered sections. That works, but it is literal: it produces one card per
sentence and the card titles are whole sentences.

This page sets up Azure OpenAI to do the summarising instead, so the carousel
shows a handful of grouped cards with short clinical titles.

Azure is **optional**. With nothing configured the app keeps using the local
parser, so the project still runs on a laptop with no Azure account.

---

## How the pieces fit together

```
Chest X-ray  ──►  Qwen2.5-VL (local, port 8080)  ──►  free-text report
                                                            │
                                                            ▼
                                        Azure OpenAI gpt-4o-mini  (this doc)
                                                            │
                                                            ▼
                                          6 findings as JSON  ──►  carousel
```

The local model writes the report. Azure only reads that **text** — it never
sees the X-ray image. That matters for three reasons:

- It is cheap. A report is roughly 700 tokens, so a summary costs a fraction of
  a cent with `gpt-4o-mini`.
- It needs no GPU quota, unlike hosting a vision model on Azure.
- It cannot draw bounding boxes, because it never sees the image. The boxes on
  Azure findings are placeholders for the clinician to drag into place.

Relevant files:

| File | Role |
| --- | --- |
| `backend/utils/azureFindings.js` | Builds the prompt, calls Azure, validates the JSON |
| `backend/controllers/caseController.js` | `summariseFindings` — saves the result to the case |
| `backend/routes/cases.js` | `POST /api/cases/:id/summarise-findings` |
| `src/components/review.js` | "Summarise with Azure AI" button and the carousel |
| `scripts/setup-azure-openai.sh` | Creates the Azure resources for you |

---

## Setup

### 1. Sign in

```bash
az login
```

This opens a browser. Your `Azure for Students` subscription is picked up
automatically. Tokens expire after 90 days of inactivity, so if things stop
working later, run this again.

### 2. Create the resources

```bash
./scripts/setup-azure-openai.sh
```

The script checks your `gpt-4o-mini` quota **before** creating anything, then
creates a resource group, an Azure OpenAI resource, and a `gpt-4o-mini`
deployment. It is safe to re-run; existing resources are left alone.

If it reports no spare quota in the default region, try another:

```bash
REGION=swedencentral ./scripts/setup-azure-openai.sh
```

Regions worth trying: `eastus2`, `swedencentral`, `westus3`, `northcentralus`.

### 3. Paste the output into `backend/.env`

The script finishes by printing three lines. Copy them into `backend/.env`:

```
AZURE_OPENAI_ENDPOINT=https://radassist-openai-xxx.openai.azure.com
AZURE_OPENAI_KEY=<your key>
AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini
```

`backend/.env` is gitignored, so the key stays off GitHub.

### 4. Restart and try it

```bash
./start-all.sh
```

Open a case, then click **Summarise with Azure AI** under the findings
carousel. Existing findings you have already accepted, rejected or typed in
by hand are kept; only the untouched machine-generated ones are replaced.

---

## What the prompt asks for

The full prompt lives in `SYSTEM_PROMPT` in `backend/utils/azureFindings.js`.
It asks for strict JSON:

```json
{"findings": [
  {"label": "Clear lung fields",
   "detail": "The lungs are clear bilaterally without consolidation.",
   "location": "Both lungs",
   "size": "",
   "pattern": "Other",
   "confidence": 0.92,
   "severity": "normal"}
]}
```

Two settings keep the output stable:

- `response_format: {type: "json_object"}` — Azure guarantees valid JSON, so
  the backend never has to scrape prose for a JSON blob.
- `temperature: 0.1` — near-deterministic, so the same report gives
  effectively the same cards each time.

The backend does not trust the response. `normalise()` in `azureFindings.js`
caps the list at 6, forces `pattern` to one of the allowed values, clamps
`confidence` into 0–1 (models often answer `92` when asked for `0.92`), and
drops any finding with no label.

### Tuning the cards

To change what the cards say, edit `SYSTEM_PROMPT`. Some examples:

- Fewer, broader cards: change `At most 6 findings` to `At most 3 findings`.
- Plain-language cards for patients: add `Write each label so a patient with
  no medical training can understand it.`
- Skip normal findings: add `Only include abnormal findings. If the study is
  normal, return one finding saying so.`

No restart of the model is needed, just restart the backend.

---

## Cost and cleanup

`gpt-4o-mini` is billed per token. A report of ~700 tokens in and ~300 out is
well under a cent, so a demo of a few hundred summaries costs pennies against
the student credit.

Check what you have spent:

```bash
az consumption usage list --top 5 -o table
```

Delete everything when the project is finished:

```bash
az group delete --name radassist-rg --yes
```

---

## Troubleshooting

**"Azure OpenAI is not configured on the server."**
The three `AZURE_OPENAI_*` values are missing or blank in `backend/.env`, or
the backend was not restarted after editing it.

**"Azure OpenAI 401"**
The key is wrong. Re-read it with:

```bash
az cognitiveservices account keys list --name <resource> --resource-group radassist-rg --query key1 -o tsv
```

**"Azure OpenAI 404"**
`AZURE_OPENAI_DEPLOYMENT` must be the *deployment* name you chose, not the
model name — they are only the same because the setup script uses
`gpt-4o-mini` for both. List your deployments:

```bash
az cognitiveservices account deployment list --name <resource> --resource-group radassist-rg -o table
```

**"Azure OpenAI 429"**
You are over the tokens-per-minute limit. Wait a moment, or raise capacity:

```bash
az cognitiveservices account deployment create --name <resource> \
  --resource-group radassist-rg --deployment-name gpt-4o-mini \
  --model-name gpt-4o-mini --model-version 2024-07-18 \
  --model-format OpenAI --sku-name Standard --sku-capacity 30
```

**The token expired again**
`az login`. Azure CLI refresh tokens die after 90 days of inactivity, and
`az account show` still prints cached details even when the token is dead —
which is why the setup script makes a real API call to check.
