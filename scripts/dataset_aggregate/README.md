# Dataset Aggregate Scripts

Aggregate per-run `dump-calc*.bin.ds` binary dumps into a single master pickle.

The input layout expected under a base directory (for example `run0/`) is:

```text
run0/
  0/
    dump-calc0.bin.ds
  1/
    dump-calc1.bin.ds
  ...
  31/
    dump-calc31.bin.ds
```

Every immediate subdirectory whose name is a non-negative integer is treated as
a run; any other directory is ignored.

## Files

- `read_ds.py` — Parser library (plus standalone CLI) for the custom `.ds`
  binary and text formats. `parse_ds_binary`, `parse_ds_text`, and
  `filter_hidden_keys` are the public entry points.
- `aggregate_pkl.py` — Main CLI. Walks the base directory, parses each run's
  `dump-calc<id>.bin.ds`, drops hidden `_.1` / `_.2` keys, and writes a single
  pickle keyed by the run-id string.
- `process_ds.sh` — Thin shell wrapper around `aggregate_pkl.py`. Kept for
  backward compatibility with the old `tools/process_ds.sh` call sites.

## Aggregating One Run Directory

```bash
# All runs under run0 → run0/dump_all.pkl
bash scripts/dataset_aggregate/process_ds.sh run0

# Or directly with Python
python scripts/dataset_aggregate/aggregate_pkl.py -b run0
```

## Custom Output Filename

```bash
bash scripts/dataset_aggregate/process_ds.sh run0 my_dump_all.pkl

# Equivalent
python scripts/dataset_aggregate/aggregate_pkl.py -b run0 -o my_dump_all.pkl
```

The output is always written as `<baseroot>/<output_filename>`.

## Aggregating A Run Range

```bash
# Runs 0..31 inclusive
bash scripts/dataset_aggregate/process_ds.sh run0 0 31

# Or directly
python scripts/dataset_aggregate/aggregate_pkl.py -b run0 -s 0 -e 31

# A single run (end defaults to start)
python scripts/dataset_aggregate/aggregate_pkl.py -b run0 -s 7
```

## Output Format

The pickle contains a single `dict[str, dict[str, numpy.ndarray]]`:

```python
{
    "0":  {"energies": np.ndarray, "dipole": np.ndarray, ...},
    "1":  {...},
    ...
}
```

Keys prefixed with `_.1` or `_.2` are dropped from each inner dict before
pickling. Runs with a missing, empty, or unparseable `.bin.ds` file are
skipped with a warning; the summary line at the end reports the counts.

## Parsing A Single `.ds` File

`read_ds.py` is also usable on its own:

```bash
# Binary → pickle (hidden keys filtered out)
python scripts/dataset_aggregate/read_ds.py -i data.bin.ds -t bin -o filtered.pkl

# Text format with verbose summary
python scripts/dataset_aggregate/read_ds.py -i data.ds -t txt -v
```

## Notes

- The binary format is little-endian: uint32 entry count, per-entry
  uint32 key length + UTF-8 key + uint8 dtype code + uint32 rank +
  rank × uint64 dims + raw data block. Supported dtype codes are
  `0 → int32`, `1 → float64`, `2 → complex128`.
- This workflow replaces the older standalone copies under
  `jctc_examples/tools/` (`process_ds.sh`, `aggregate_pkl.py`,
  `read_ds2.py`); prefer the in-repo path above.
