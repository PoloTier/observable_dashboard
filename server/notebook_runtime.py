from __future__ import annotations

import builtins as py_builtins
import contextlib
from dataclasses import dataclass, field
import io
import pickle
from pathlib import Path
from threading import Lock
import time
import traceback
from typing import Any, Literal
import uuid

import numpy as np

from .dataset_store import DatasetStore

try:
    import pandas as pd
except Exception:  # noqa: BLE001
    pd = None


SeriesKind = Literal["scalar", "matrix"]


class NotebookRuntimeError(ValueError):
    pass


class NotebookSessionNotFoundError(KeyError):
    pass


def _traj_sort_key(value: str) -> tuple[int, int | str]:
    text = str(value)
    if text.isdigit():
        return (0, int(text))
    return (1, text)


def _base_globals() -> dict[str, Any]:
    return {
        "__builtins__": py_builtins.__dict__,
        "__name__": "__notebook__",
        "__package__": None,
    }


def _as_sanitized_float_array(value: Any) -> tuple[np.ndarray, tuple[int, ...], str]:
    arr_raw = np.asarray(value)
    original_shape = tuple(arr_raw.shape)
    original_dtype = str(arr_raw.dtype)

    if np.iscomplexobj(arr_raw):
        raise NotebookRuntimeError("publish() does not support complex data. Convert first, e.g. np.abs(x).")

    try:
        arr = np.asarray(arr_raw, dtype=float)
    except Exception as exc:  # noqa: BLE001
        raise NotebookRuntimeError(f"publish() value is not convertible to float: {exc}") from exc

    if arr.size > 0:
        arr = np.asarray(arr, dtype=float)
        arr[~np.isfinite(arr)] = np.nan

    return arr, original_shape, original_dtype


def _normalize_time_axis(
    *,
    time_value: Any | None,
    n_points: int,
    default_time: np.ndarray | None,
) -> np.ndarray:
    if time_value is not None:
        try:
            out = np.asarray(time_value, dtype=float).reshape(-1)
        except Exception as exc:  # noqa: BLE001
            raise NotebookRuntimeError(f"publish() time axis is not numeric: {exc}") from exc
        if int(out.shape[0]) != int(n_points):
            raise NotebookRuntimeError(
                (
                    "publish() time axis length mismatch: "
                    f"time_len={out.shape[0]}, n_points={n_points}."
                )
            )
        return out

    if n_points <= 0:
        return np.asarray([], dtype=float)

    if default_time is not None:
        fallback = np.asarray(default_time, dtype=float).reshape(-1)
        if int(fallback.shape[0]) == int(n_points):
            return fallback

    if n_points == 1:
        return np.asarray([0.0], dtype=float)

    raise NotebookRuntimeError(
        (
            "publish() could not infer time axis. "
            "Provide time=... explicitly or publish data with length equal to trajectory time length."
        )
    )


def _normalize_component_labels(component_labels: Any, n_components: int) -> list[str] | None:
    if component_labels is None:
        return None
    if not isinstance(component_labels, list):
        raise NotebookRuntimeError("publish() component_labels must be a list of strings.")
    if len(component_labels) != int(n_components):
        raise NotebookRuntimeError(
            (
                "publish() component_labels length mismatch: "
                f"len(labels)={len(component_labels)}, n_components={n_components}."
            )
        )

    out: list[str] = []
    for idx, value in enumerate(component_labels):
        text = str(value).strip()
        if not text:
            raise NotebookRuntimeError(f"publish() component_labels[{idx}] must be non-empty.")
        out.append(text)
    return out


@dataclass(slots=True)
class PublishedSeries:
    series_kind: SeriesKind
    time: np.ndarray
    value: np.ndarray | None
    values: np.ndarray | None
    n_points: int
    n_components: int | None
    component_labels: list[str] | None
    dtype: str
    shape: tuple[int, ...]
    nan_count: int

    def to_payload(self) -> dict[str, Any]:
        return {
            "series_kind": str(self.series_kind),
            "time": np.asarray(self.time, dtype=float).tolist(),
            "value": None if self.value is None else np.asarray(self.value, dtype=float).tolist(),
            "values": None if self.values is None else np.asarray(self.values, dtype=float).tolist(),
            "n_points": int(self.n_points),
            "n_components": None if self.n_components is None else int(self.n_components),
            "component_labels": None if self.component_labels is None else list(self.component_labels),
        }


@dataclass(slots=True)
class PublishedVariable:
    name: str
    by_traj: dict[str, PublishedSeries] = field(default_factory=dict)
    updated_at: float = field(default_factory=time.time)

    def summary(self) -> dict[str, Any]:
        traj_ids = sorted(self.by_traj.keys(), key=_traj_sort_key)
        if not traj_ids:
            return {
                "name": self.name,
                "series_kind": "scalar",
                "traj_count": 0,
                "n_points": 0,
                "n_components": None,
                "component_labels": None,
                "preview_traj_id": None,
                "dtype": "float64",
                "shape": [],
                "nan_count": 0,
                "updated_at": float(self.updated_at),
            }

        preview_traj_id = str(traj_ids[0])
        ref = self.by_traj[preview_traj_id]
        return {
            "name": str(self.name),
            "series_kind": str(ref.series_kind),
            "traj_count": len(traj_ids),
            "n_points": int(ref.n_points),
            "n_components": None if ref.n_components is None else int(ref.n_components),
            "component_labels": None if ref.component_labels is None else list(ref.component_labels),
            "preview_traj_id": preview_traj_id,
            "dtype": str(ref.dtype),
            "shape": [int(v) for v in ref.shape],
            "nan_count": int(ref.nan_count),
            "updated_at": float(self.updated_at),
        }


@dataclass(slots=True)
class NotebookSession:
    session_id: str
    dataset_revision: int
    source_pkl: str
    traj_ids: list[str]
    globals_ns: dict[str, Any] = field(default_factory=_base_globals)
    published: dict[str, PublishedVariable] = field(default_factory=dict)
    session_version: int = 1
    created_at: float = field(default_factory=time.time)
    last_used_at: float = field(default_factory=time.time)
    lock: Lock = field(default_factory=Lock)

    def bump_version(self) -> None:
        self.session_version += 1
        self.last_used_at = time.time()

    def reset(self) -> None:
        self.globals_ns = _base_globals()
        self.published = {}
        self.bump_version()


@dataclass(slots=True)
class NotebookExecutionResult:
    ok: bool
    stdout: str
    stderr: str
    error_message: str | None
    traceback: str | None
    published_updates: list[str]
    run_ms: float
    session_version: int


class NotebookSessionManager:
    def __init__(self) -> None:
        self._lock = Lock()
        self._sessions: dict[str, NotebookSession] = {}

    def create_session(
        self,
        *,
        dataset_revision: int,
        source_pkl: str,
        traj_ids: list[str],
    ) -> NotebookSession:
        session = NotebookSession(
            session_id=uuid.uuid4().hex,
            dataset_revision=int(dataset_revision),
            source_pkl=str(source_pkl),
            traj_ids=[str(v) for v in traj_ids],
        )
        with self._lock:
            self._sessions[session.session_id] = session
        return session

    def get_session(self, session_id: str) -> NotebookSession:
        key = str(session_id or "").strip()
        if not key:
            raise NotebookSessionNotFoundError("Notebook session_id is empty.")
        with self._lock:
            session = self._sessions.get(key)
        if session is None:
            raise NotebookSessionNotFoundError(f"Notebook session not found: {key}")
        return session

    def delete_session(self, session_id: str) -> bool:
        key = str(session_id or "").strip()
        if not key:
            return False
        with self._lock:
            return self._sessions.pop(key, None) is not None

    def clear(self) -> int:
        with self._lock:
            count = len(self._sessions)
            self._sessions = {}
        return int(count)


def validate_session_revision(session: NotebookSession, dataset_revision: int) -> None:
    if int(session.dataset_revision) != int(dataset_revision):
        raise NotebookRuntimeError(
            (
                "Notebook session is stale due to dataset refresh. "
                f"session_revision={session.dataset_revision}, dataset_revision={dataset_revision}."
            )
        )


def _publish_series_for_traj(
    *,
    session: NotebookSession,
    traj_id: str,
    name: str,
    value: Any,
    time_value: Any | None,
    component_labels: Any,
    default_time: np.ndarray | None,
) -> PublishedSeries:
    variable_name = str(name or "").strip()
    if not variable_name:
        raise NotebookRuntimeError("publish() variable name must be a non-empty string.")

    arr, original_shape, original_dtype = _as_sanitized_float_array(value)
    if arr.ndim == 0:
        scalar_values = np.asarray([float(arr)], dtype=float)
        time_axis = _normalize_time_axis(time_value=time_value, n_points=1, default_time=default_time)
        keep_mask = time_axis != 0.0
        time_axis = time_axis[keep_mask]
        scalar_values = scalar_values[keep_mask]
        n_points = int(time_axis.shape[0])
        series = PublishedSeries(
            series_kind="scalar",
            time=time_axis,
            value=scalar_values,
            values=None,
            n_points=n_points,
            n_components=None,
            component_labels=None,
            dtype=original_dtype,
            shape=original_shape,
            nan_count=int(np.isnan(scalar_values).sum()),
        )
    elif arr.ndim == 1:
        scalar_values = np.asarray(arr, dtype=float).reshape(-1)
        n_points = int(scalar_values.shape[0])
        time_axis = _normalize_time_axis(time_value=time_value, n_points=n_points, default_time=default_time)
        keep_mask = time_axis != 0.0
        time_axis = time_axis[keep_mask]
        scalar_values = scalar_values[keep_mask]
        n_points = int(time_axis.shape[0])
        series = PublishedSeries(
            series_kind="scalar",
            time=time_axis,
            value=scalar_values,
            values=None,
            n_points=n_points,
            n_components=None,
            component_labels=None,
            dtype=original_dtype,
            shape=original_shape,
            nan_count=int(np.isnan(scalar_values).sum()),
        )
    else:
        n_points = int(arr.shape[0])
        matrix = np.asarray(arr, dtype=float).reshape(n_points, -1)
        n_components = int(matrix.shape[1]) if matrix.ndim == 2 else 0
        if n_components <= 0:
            raise NotebookRuntimeError("publish() produced a matrix with zero components.")
        labels = _normalize_component_labels(component_labels, n_components)
        time_axis = _normalize_time_axis(time_value=time_value, n_points=n_points, default_time=default_time)
        keep_mask = time_axis != 0.0
        time_axis = time_axis[keep_mask]
        matrix = matrix[keep_mask, :]
        n_points = int(time_axis.shape[0])
        series = PublishedSeries(
            series_kind="matrix",
            time=time_axis,
            value=None,
            values=matrix,
            n_points=n_points,
            n_components=n_components,
            component_labels=labels,
            dtype=original_dtype,
            shape=original_shape,
            nan_count=int(np.isnan(matrix).sum()),
        )

    variable = session.published.get(variable_name)
    if variable is None:
        variable = PublishedVariable(name=variable_name)
        session.published[variable_name] = variable
    variable.by_traj[str(traj_id)] = series
    variable.updated_at = time.time()
    return series


def list_published_variable_summaries(session: NotebookSession) -> list[dict[str, Any]]:
    with session.lock:
        names = sorted(session.published.keys())
        return [session.published[name].summary() for name in names]


def get_published_series_payload(session: NotebookSession, variable: str, traj_id: str) -> dict[str, Any]:
    name = str(variable or "").strip()
    tid = str(traj_id or "").strip()
    if not name:
        raise NotebookRuntimeError("variable must be a non-empty string.")
    if not tid:
        raise NotebookRuntimeError("traj_id must be a non-empty string.")

    with session.lock:
        item = session.published.get(name)
        if item is None:
            raise NotebookRuntimeError(f"Notebook variable not found: {name}")
        series = item.by_traj.get(tid)
        if series is None:
            raise NotebookRuntimeError(f"Notebook variable '{name}' has no data for trajectory '{tid}'.")
        payload = series.to_payload()
        payload["variable"] = name
        payload["traj_id"] = tid
        return payload


def get_published_variable(session: NotebookSession, variable: str) -> PublishedVariable:
    name = str(variable or "").strip()
    if not name:
        raise NotebookRuntimeError("variable must be a non-empty string.")
    with session.lock:
        item = session.published.get(name)
        if item is None:
            raise NotebookRuntimeError(f"Notebook variable not found: {name}")
        return item


def snapshot_published_variable_records(
    session: NotebookSession,
    variable: str,
) -> tuple[int, list[tuple[str, dict[str, Any]]]]:
    name = str(variable or "").strip()
    if not name:
        raise NotebookRuntimeError("variable must be a non-empty string.")

    with session.lock:
        item = session.published.get(name)
        if item is None:
            raise NotebookRuntimeError(f"Notebook variable not found: {name}")
        traj_ids = sorted(item.by_traj.keys(), key=_traj_sort_key)
        records = [(traj_id, item.by_traj[traj_id].to_payload()) for traj_id in traj_ids]
        return int(session.session_version), records


def execute_notebook_code(
    *,
    session: NotebookSession,
    store: DatasetStore,
    code: str,
    mode: Literal["current", "all"],
    traj_id: str | None,
) -> NotebookExecutionResult:
    code_text = str(code or "")
    if not code_text.strip():
        raise NotebookRuntimeError("code must be a non-empty string.")

    run_mode = str(mode)
    if run_mode not in {"current", "all"}:
        raise NotebookRuntimeError(f"Unsupported notebook execute mode: {mode}")

    if run_mode == "current":
        target = str(traj_id or "").strip()
        if not target:
            raise NotebookRuntimeError("mode='current' requires a non-empty traj_id.")
        traj_ids = [target]
    else:
        traj_ids = [str(v) for v in store.traj_ids]
        if not traj_ids:
            raise NotebookRuntimeError("No trajectories are available for mode='all'.")

    compiled = compile(code_text, "<notebook-cell>", "exec")
    stdout_buffer = io.StringIO()
    stderr_buffer = io.StringIO()
    published_updates: set[str] = set()
    error_message: str | None = None
    error_traceback: str | None = None
    started = time.perf_counter()

    with session.lock:
        globals_ns = session.globals_ns

        for tid in traj_ids:
            traj = store.get_trajectory(tid)
            if traj is None:
                raise NotebookRuntimeError(f"Trajectory not found: {tid}")
            raw_record = store.raw_records_by_traj.get(str(tid))
            default_publish_time = np.asarray(traj.time, dtype=float).reshape(-1)
            if isinstance(raw_record, dict):
                raw_time_value = raw_record.get(store.time_key)
                if raw_time_value is not None:
                    try:
                        raw_time_axis = np.asarray(raw_time_value, dtype=float).reshape(-1)
                    except Exception:  # noqa: BLE001
                        raw_time_axis = np.asarray([], dtype=float)
                    if int(raw_time_axis.shape[0]) > 0:
                        default_publish_time = raw_time_axis

            context: dict[str, Any] = {"traj_id": tid, "mode": run_mode}

            def load_pkl(path: str | Path | None = None) -> Any:
                target_path = Path(session.source_pkl if path is None else path).expanduser()
                try:
                    with target_path.open("rb") as f:
                        return pickle.load(f)  # noqa: S301
                except Exception as exc:  # noqa: BLE001
                    raise NotebookRuntimeError(f"load_pkl() failed for '{target_path}': {exc}") from exc

            def get_raw(key: str, traj_id: str | None = None) -> Any:
                raw_key = str(key or "").strip()
                if not raw_key:
                    raise NotebookRuntimeError("get_raw() key must be a non-empty string.")
                target_traj = str(context["traj_id"] if traj_id is None else traj_id).strip()
                if not target_traj:
                    raise NotebookRuntimeError("get_raw() traj_id resolved to empty string.")
                raw_record = store.raw_records_by_traj.get(target_traj)
                if raw_record is None:
                    raise NotebookRuntimeError(f"Raw record not found for trajectory: {target_traj}")
                if raw_key not in raw_record:
                    raise NotebookRuntimeError(
                        f"Raw key not found for trajectory {target_traj}: {raw_key}"
                    )
                return raw_record[raw_key]

            def publish(
                name: str,
                value: Any,
                *,
                time: Any | None = None,
                component_labels: list[str] | None = None,
            ) -> None:
                series = _publish_series_for_traj(
                    session=session,
                    traj_id=str(context["traj_id"]),
                    name=name,
                    value=value,
                    time_value=time,
                    component_labels=component_labels,
                    default_time=default_publish_time,
                )
                _ = series
                published_updates.add(str(name).strip())

            globals_ns["np"] = np
            globals_ns["pd"] = pd
            globals_ns["pickle"] = pickle
            globals_ns["Path"] = Path
            globals_ns["ctx"] = context
            globals_ns["traj_id"] = str(context["traj_id"])
            globals_ns["traj_ids"] = [str(v) for v in store.traj_ids]
            globals_ns["source_pkl"] = str(session.source_pkl)
            globals_ns["load_pkl"] = load_pkl
            globals_ns["get_raw"] = get_raw
            globals_ns["publish"] = publish

            try:
                with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(stderr_buffer):
                    exec(compiled, globals_ns, globals_ns)
            except Exception as exc:  # noqa: BLE001
                error_message = f"Execution failed on trajectory '{tid}': {exc}"
                error_traceback = traceback.format_exc()
                break

        session.bump_version()

    elapsed_ms = max(0.0, (time.perf_counter() - started) * 1000.0)
    return NotebookExecutionResult(
        ok=error_message is None,
        stdout=stdout_buffer.getvalue(),
        stderr=stderr_buffer.getvalue(),
        error_message=error_message,
        traceback=error_traceback,
        published_updates=sorted((name for name in published_updates if name)),
        run_ms=float(elapsed_ms),
        session_version=int(session.session_version),
    )
