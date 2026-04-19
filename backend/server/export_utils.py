"""Shared utilities for building tar.gz export bundles.

Used by normal_modes_sampling, trajectory_sampling, and distribution_bundle.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import tarfile
from datetime import datetime, timezone
from typing import Any

import numpy as np


def utc_now_iso() -> str:
    """Return the current UTC time as an ISO-8601 string with 'Z' suffix."""
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def sanitize_filename_part(text: object, *, fallback: str = "export") -> str:
    """Sanitize *text* into a safe filename component."""
    raw = str(text or "").strip()
    sanitized = re.sub(r"[^A-Za-z0-9._-]+", "_", raw)
    sanitized = sanitized.strip("._-")
    return sanitized or fallback


def json_text(payload: Any) -> str:
    """Serialize *payload* to a pretty-printed JSON string with trailing newline."""
    return f"{json.dumps(payload, indent=2, sort_keys=True)}\n"


def npy_bytes(array: np.ndarray) -> bytes:
    """Serialize a numpy array to .npy format bytes (no pickle)."""
    buffer = io.BytesIO()
    np.save(buffer, np.asarray(array), allow_pickle=False)
    return buffer.getvalue()


def tar_gz_bytes_from_entries(entries: list[tuple[str, bytes]]) -> bytes:
    """Build a .tar.gz archive in memory from a list of (path, content) pairs."""
    buffer = io.BytesIO()
    modified_at = datetime.now(timezone.utc).timestamp()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for relative_path, content_bytes in entries:
            info = tarfile.TarInfo(name=str(relative_path))
            info.size = int(len(content_bytes))
            info.mtime = modified_at
            archive.addfile(info, io.BytesIO(content_bytes))
    return buffer.getvalue()


def build_topology_signature(atom_numbers: np.ndarray | list[int]) -> str:
    """Content-addressable signature for an atom-number sequence."""
    values = np.asarray(atom_numbers, dtype=int).reshape(-1)
    joined = ",".join(str(int(value)) for value in values.tolist())
    digest = hashlib.sha1(joined.encode("utf-8")).hexdigest()  # noqa: S324
    return f"atoms-{values.shape[0]}-{digest[:16]}"
