#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_PATH="$SCRIPT_DIR/run_workspace_batch.py"

workspace=""
batch_count=""
python_exe="python"
cpus_per_task=""
mem=""
time_limit=""
partition=""
account=""
qos=""
job_name=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace)
      workspace="${2:-}"
      shift 2
      ;;
    --batch-count)
      batch_count="${2:-}"
      shift 2
      ;;
    --python-exe)
      python_exe="${2:-}"
      shift 2
      ;;
    --cpus-per-task)
      cpus_per_task="${2:-}"
      shift 2
      ;;
    --mem)
      mem="${2:-}"
      shift 2
      ;;
    --time)
      time_limit="${2:-}"
      shift 2
      ;;
    --partition)
      partition="${2:-}"
      shift 2
      ;;
    --account)
      account="${2:-}"
      shift 2
      ;;
    --qos)
      qos="${2:-}"
      shift 2
      ;;
    --job-name)
      job_name="${2:-}"
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
Usage:
  bash scripts/electronic_structure/submit_workspace_array.sh \
    --workspace PATH \
    --batch-count K \
    [--cpus-per-task N] \
    [--mem 16G] \
    [--time 02:00:00] \
    [--partition NAME] \
    [--account NAME] \
    [--qos NAME] \
    [--job-name NAME] \
    [--python-exe PYTHON]
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$workspace" ]]; then
  echo "--workspace is required" >&2
  exit 2
fi
if [[ -z "$batch_count" ]]; then
  echo "--batch-count is required" >&2
  exit 2
fi
if ! [[ "$batch_count" =~ ^[0-9]+$ ]] || [[ "$batch_count" -lt 1 ]]; then
  echo "--batch-count must be an integer >= 1" >&2
  exit 2
fi
if [[ ! -f "$RUNNER_PATH" ]]; then
  echo "Missing batch runner: $RUNNER_PATH" >&2
  exit 2
fi

workspace="$("$python_exe" -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$workspace")"
if [[ ! -d "$workspace" ]]; then
  echo "Workspace directory does not exist: $workspace" >&2
  exit 2
fi

sbatch_args=()
sbatch_args+=("--array=0-$((batch_count - 1))")
if [[ -n "$cpus_per_task" ]]; then
  sbatch_args+=("--cpus-per-task=$cpus_per_task")
fi
if [[ -n "$mem" ]]; then
  sbatch_args+=("--mem=$mem")
fi
if [[ -n "$time_limit" ]]; then
  sbatch_args+=("--time=$time_limit")
fi
if [[ -n "$partition" ]]; then
  sbatch_args+=("--partition=$partition")
fi
if [[ -n "$account" ]]; then
  sbatch_args+=("--account=$account")
fi
if [[ -n "$qos" ]]; then
  sbatch_args+=("--qos=$qos")
fi
if [[ -n "$job_name" ]]; then
  sbatch_args+=("--job-name=$job_name")
fi

printf -v wrap_cmd '%q %q --workspace %q --batch-count %q' \
  "$python_exe" \
  "$RUNNER_PATH" \
  "$workspace" \
  "$batch_count"

echo "Submitting Slurm array with $batch_count batch(es) for workspace $workspace"
exec sbatch "${sbatch_args[@]}" --wrap "$wrap_cmd"
