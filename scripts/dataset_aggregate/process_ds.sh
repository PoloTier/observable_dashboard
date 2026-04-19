#!/bin/bash

# Thin wrapper for scripts/dataset_aggregate/aggregate_pkl.py
# Recommended usage:
#   bash scripts/dataset_aggregate/process_ds.sh run0
#   bash scripts/dataset_aggregate/process_ds.sh run0 dump_all.pkl
# Backward-compatible usage:
#   bash scripts/dataset_aggregate/process_ds.sh run0 0 31

set -u

usage() {
    echo "Usage:"
    echo "  $0 <BASEROOT>"
    echo "  $0 <BASEROOT> <OUTPUT_FILENAME>"
    echo "  $0 <BASEROOT> <START_INDEX> <END_INDEX>"
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGGREGATOR="${SCRIPT_DIR}/aggregate_pkl.py"

if [ ! -f "${AGGREGATOR}" ]; then
    echo "[ERROR] Aggregator script not found: ${AGGREGATOR}"
    exit 1
fi

if [ $# -eq 1 ]; then
    BASEROOT="$1"
    echo "--- Starting one-step DS aggregation ---"
    echo "Base Directory: ${BASEROOT}"
    python3 "${AGGREGATOR}" -b "${BASEROOT}"
    exit $?
elif [ $# -eq 2 ]; then
    BASEROOT="$1"
    OUTPUT_FILENAME="$2"
    echo "--- Starting one-step DS aggregation ---"
    echo "Base Directory: ${BASEROOT}"
    echo "Output File: ${OUTPUT_FILENAME}"
    python3 "${AGGREGATOR}" -b "${BASEROOT}" -o "${OUTPUT_FILENAME}"
    exit $?
elif [ $# -eq 3 ]; then
    BASEROOT="$1"
    START_INDEX="$2"
    END_INDEX="$3"
    echo "--- Starting DS aggregation (range compatibility mode) ---"
    echo "Base Directory: ${BASEROOT}"
    echo "Range: ${START_INDEX}-${END_INDEX}"
    python3 "${AGGREGATOR}" -b "${BASEROOT}" -s "${START_INDEX}" -e "${END_INDEX}"
    exit $?
else
    usage
    exit 1
fi
