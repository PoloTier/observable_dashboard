import argparse
import numpy as np
import sys
import struct
import pickle
from typing import Dict, Any


DTYPE_MAP = {
    0: ('i4', 4),
    1: ('f8', 8),
    2: ('c16', 16),
}


def filter_hidden_keys(data: Dict[str, Any]) -> Dict[str, Any]:
    """Drop internal keys that start with _.1 or _.2."""
    return {
        key: value
        for key, value in data.items()
        if not (key.startswith('_.1') or key.startswith('_.2'))
    }


def parse_ds_binary(path: str, verbose: bool = False) -> Dict[str, Any]:
    """Loads a dataset from the custom binary .ds file format."""
    dataset: Dict[str, Any] = {}

    if verbose:
        print(f"DEBUG: Starting binary read process for {path}")

    try:
        with open(path, 'rb') as f:
            count_bytes = f.read(4)
            if len(count_bytes) < 4:
                raise EOFError("Unexpected EOF while reading entry count.")
            entry_count = struct.unpack('<I', count_bytes)[0]

            if verbose:
                print(f"DEBUG: Expecting {entry_count} data entries.")

            for _ in range(entry_count):
                klen_bytes = f.read(4)
                if len(klen_bytes) < 4:
                    raise EOFError("Unexpected EOF while reading key length.")
                klen = struct.unpack('<I', klen_bytes)[0]

                key_bytes = f.read(klen)
                if len(key_bytes) < klen:
                    raise EOFError("Unexpected EOF while reading key bytes.")
                key = key_bytes.decode('utf-8')

                dtype_bytes = f.read(1)
                if len(dtype_bytes) < 1:
                    raise EOFError(f"Unexpected EOF while reading dtype for key '{key}'.")
                dtype_code = struct.unpack('<B', dtype_bytes)[0]

                if dtype_code not in DTYPE_MAP:
                    raise ValueError(f"Unknown dtype code: {dtype_code} for key '{key}'.")

                rank_bytes = f.read(4)
                if len(rank_bytes) < 4:
                    raise EOFError(f"Unexpected EOF while reading rank for key '{key}'.")
                rank = struct.unpack('<I', rank_bytes)[0]

                dims = []
                for r in range(rank):
                    dim_bytes = f.read(8)
                    if len(dim_bytes) < 8:
                        raise EOFError(f"Unexpected EOF while reading dimension {r+1} for key '{key}'.")
                    dim = struct.unpack('<Q', dim_bytes)[0]
                    dims.append(dim)

                np_dtype_str, item_size = DTYPE_MAP[dtype_code]
                cnt = int(np.prod(dims)) if dims else 0
                total_bytes = cnt * item_size

                data_bytes = f.read(total_bytes)
                if len(data_bytes) < total_bytes:
                    raise EOFError(f"Unexpected EOF while reading data for key '{key}'.")

                data_array = np.frombuffer(data_bytes, dtype=f'<{np_dtype_str}')

                if dims:
                    data_array = data_array.reshape(dims)

                dataset[key] = data_array

                if verbose:
                    print(f"DEBUG: Loaded key '{key}' | Shape: {data_array.shape}")

    except Exception as e:
        raise Exception(f"Binary parse error: {e}")

    return dataset


def parse_ds_text(filepath: str, verbose: bool = False) -> Dict[str, Any]:
    """Parses a .ds text file block by block using a state machine."""
    data_dict: Dict[str, Any] = {}

    STATE_EXPECT_KEY = 0
    STATE_EXPECT_META = 1
    STATE_READ_DATA = 2

    current_state = STATE_EXPECT_KEY
    current_key = None
    current_dtype = None
    current_total = 0
    current_shape: list = []
    collected_values: list = []

    if verbose:
        print(f"DEBUG: Starting text read process for {filepath}")

    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue

                if current_state == STATE_EXPECT_KEY:
                    current_key = line
                    current_state = STATE_EXPECT_META

                elif current_state == STATE_EXPECT_META:
                    parts = line.split()
                    if len(parts) < 2:
                        print(f"[Warning] Line {line_num}: Metadata format incorrect. Skipping block.")
                        current_state = STATE_EXPECT_KEY
                        continue

                    current_dtype = parts[0]
                    current_total = int(parts[1])
                    current_shape = [int(x) for x in parts[2:]]

                    collected_values = []
                    current_state = STATE_READ_DATA

                elif current_state == STATE_READ_DATA:
                    tokens = line.split()
                    collected_values.extend(tokens)

                    if len(collected_values) >= current_total:
                        final_values = collected_values[:current_total]

                        try:
                            if current_dtype == '_real':
                                np_data = np.array(final_values, dtype=np.float64)
                            elif current_dtype == '_int':
                                np_data = np.array(final_values, dtype=np.int64)
                            elif current_dtype == '_complex':
                                complex_list = []
                                for v in final_values:
                                    v_clean = v.replace('(', '').replace(')', '')
                                    r_str, i_str = v_clean.split(',')
                                    complex_list.append(complex(float(r_str), float(i_str)))
                                np_data = np.array(complex_list, dtype=np.complex128)
                            else:
                                if verbose:
                                    print(f"[Warning] Unknown dtype '{current_dtype}'")
                                np_data = np.array(final_values)

                            if current_shape:
                                if np.prod(current_shape) == current_total:
                                    np_data = np_data.reshape(current_shape)

                            data_dict[current_key] = np_data

                            if verbose:
                                print(f"DEBUG: Parsed key '{current_key}'")

                        except Exception as e:
                            print(f"[Error] Failed to process key '{current_key}': {e}")

                        current_state = STATE_EXPECT_KEY

    except Exception as e:
        raise Exception(f"Text parse error: {e}")

    return data_dict


def main() -> None:
    examples = """
Examples:
  # 1. Read text format and print detailed summary:
  python scripts/dataset_aggregate/read_ds.py -i data.ds -t txt -v

  # 2. Read binary format and save filtered dict (drops _.1 / _.2 keys):
  python scripts/dataset_aggregate/read_ds.py -i data.bin -t bin -o filtered_data.pkl

  # 3. Read binary format and only print success message:
  python scripts/dataset_aggregate/read_ds.py -i large_data.bin -t bin
"""
    parser = argparse.ArgumentParser(
        description="Parse a single DS file (text or binary) into a dictionary.",
        formatter_class=argparse.RawTextHelpFormatter,
        epilog=examples,
    )
    parser.add_argument("-i", "--input", required=True, help="Path to the input file")
    parser.add_argument("-t", "--type", required=True, choices=['txt', 'bin'],
                        help="Format type: 'txt' for text-based .ds, 'bin' for binary .ds")
    parser.add_argument("-o", "--output", required=False,
                        help="Optional path to save the dictionary as a .pkl file")
    parser.add_argument("-v", "--verbose", action='store_true',
                        help="Enable detailed printing of the loading process.")

    args = parser.parse_args()

    print(f"Reading file: {args.input} (Mode: {args.type.upper()})...")

    result: Dict[str, Any] = {}

    try:
        if args.type == 'txt':
            result = parse_ds_text(args.input, args.verbose)
        elif args.type == 'bin':
            result = parse_ds_binary(args.input, args.verbose)

        print("\n--- Parsing Successful ---")

        if args.output:
            filtered_data = filter_hidden_keys(result)
            exclusion_count = len(result) - len(filtered_data)

            if exclusion_count > 0:
                print(f"[Info] Excluded {exclusion_count} keys starting with '_.1' or '_.2' before saving.")

            with open(args.output, 'wb') as pkl_file:
                pickle.dump(filtered_data, pkl_file)
            print(f"Data saved to: {args.output} (Contains {len(filtered_data)} keys).")

        if args.verbose and result:
            print("\n--- Dataset Summary ---")
            print(f"{'Key Name':<25} | {'Type':<10} | {'Shape':<15}")
            print("-" * 55)
            for k, v in result.items():
                shape_str = str(v.shape)
                type_str = str(v.dtype)

                if 'complex' in type_str:
                    type_str = 'complex'
                elif 'float' in type_str:
                    type_str = 'float'
                elif 'int' in type_str:
                    type_str = 'int'

                print(f"{k:<25} | {type_str:<10} | {shape_str:<15}")
            print("-" * 55)
        elif not args.verbose:
            print(f"Loaded {len(result)} keys. Use -v to see details.")

    except Exception as e:
        print(f"\n[Error] Failed to load file: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
