#!/usr/bin/env bash
#
# Provisions the Azure OpenAI resource used by "Summarise with Azure AI"
# and prints the three values that go into backend/.env.
#
# Safe to re-run: every step is skipped if the resource already exists.
#
#   az login
#   ./scripts/setup-azure-openai.sh
#
# Override any of these before running if you like:
#   RESOURCE_GROUP=my-rg REGION=swedencentral ./scripts/setup-azure-openai.sh

set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-radassist-rg}"
REGION="${REGION:-eastus}"
MODEL="${MODEL:-gpt-4o-mini}"
MODEL_VERSION="${MODEL_VERSION:-2024-07-18}"
DEPLOYMENT="${DEPLOYMENT:-gpt-4o-mini}"
CAPACITY="${CAPACITY:-10}"   # thousands of tokens per minute

# The resource name becomes part of the hostname, so it must be globally
# unique and lowercase.
ACCOUNT="${ACCOUNT:-radassist-openai-$(whoami | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]')}"

info() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m    %s\033[0m\n' "$1"; }
die()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

command -v az >/dev/null || die "Azure CLI not found. Install with: brew install azure-cli"

info "Checking you are signed in"
if ! az account show >/dev/null 2>&1 || ! az account list-locations --query "[0].name" -o tsv >/dev/null 2>&1; then
  die "Not signed in (or your token expired). Run:  az login"
fi
SUB_NAME=$(az account show --query name -o tsv)
SUB_ID=$(az account show --query id -o tsv)
echo "    subscription: $SUB_NAME"
echo "    region:       $REGION"
echo "    resource:     $ACCOUNT"

# A student or free subscription is often granted 0 tokens-per-minute, in which
# case the deployment below fails with an unhelpful error. Check up front.
info "Checking $MODEL quota in $REGION"
QUOTA=$(az cognitiveservices usage list -l "$REGION" \
  --query "[?contains(name.value, 'gpt-4o-mini')].{name:name.value,used:currentValue,limit:limit}" \
  -o tsv 2>/dev/null || true)

if [ -z "$QUOTA" ]; then
  warn "Could not read quota for this region. Continuing; the deploy step will tell us."
else
  echo "$QUOTA" | while read -r line; do echo "    $line"; done
  AVAILABLE=$(echo "$QUOTA" | awk -F'\t' '{ if ($3 - $2 > max) max = $3 - $2 } END { print max+0 }')
  if [ "${AVAILABLE:-0}" -le 0 ]; then
    warn "No spare $MODEL quota in $REGION."
    warn "Try another region, e.g.  REGION=swedencentral $0"
    warn "Regions to try: eastus2, swedencentral, westus3, northcentralus"
    die  "Stopping before creating resources you cannot use."
  fi
  if [ "$AVAILABLE" -lt "$CAPACITY" ]; then
    warn "Only ${AVAILABLE}K TPM spare; reducing capacity from ${CAPACITY} to ${AVAILABLE}."
    CAPACITY="$AVAILABLE"
  fi
fi

info "Resource group: $RESOURCE_GROUP"
if [ "$(az group exists --name "$RESOURCE_GROUP")" = "true" ]; then
  echo "    already exists"
else
  az group create --name "$RESOURCE_GROUP" --location "$REGION" -o none
  echo "    created"
fi

info "Azure OpenAI resource: $ACCOUNT"
if az cognitiveservices account show --name "$ACCOUNT" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  echo "    already exists"
else
  az cognitiveservices account create \
    --name "$ACCOUNT" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$REGION" \
    --kind OpenAI \
    --sku s0 \
    --custom-domain "$ACCOUNT" \
    --yes -o none
  echo "    created"
fi

info "Model deployment: $DEPLOYMENT ($MODEL $MODEL_VERSION, ${CAPACITY}K TPM)"
if az cognitiveservices account deployment show \
     --name "$ACCOUNT" --resource-group "$RESOURCE_GROUP" \
     --deployment-name "$DEPLOYMENT" >/dev/null 2>&1; then
  echo "    already exists"
else
  az cognitiveservices account deployment create \
    --name "$ACCOUNT" \
    --resource-group "$RESOURCE_GROUP" \
    --deployment-name "$DEPLOYMENT" \
    --model-name "$MODEL" \
    --model-version "$MODEL_VERSION" \
    --model-format OpenAI \
    --sku-name Standard \
    --sku-capacity "$CAPACITY" -o none
  echo "    created"
fi

ENDPOINT=$(az cognitiveservices account show \
  --name "$ACCOUNT" --resource-group "$RESOURCE_GROUP" \
  --query properties.endpoint -o tsv)
KEY=$(az cognitiveservices account keys list \
  --name "$ACCOUNT" --resource-group "$RESOURCE_GROUP" \
  --query key1 -o tsv)

info "Done. Put these three lines in backend/.env"
cat <<EOF

AZURE_OPENAI_ENDPOINT=${ENDPOINT%/}
AZURE_OPENAI_KEY=$KEY
AZURE_OPENAI_DEPLOYMENT=$DEPLOYMENT

EOF
echo "Then restart the backend and open a case — summarisation runs on page open."
echo
echo "To delete everything later (stops all charges):"
echo "  az group delete --name $RESOURCE_GROUP --yes"
echo
echo "Subscription used: $SUB_NAME ($SUB_ID)"
