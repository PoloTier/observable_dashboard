from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from backend.config import ALLOWED_OBSERVABLES
from backend.server.app_helpers import (
    as_scalar_series_record,
    build_ensemble_component_payload,
    build_matrix_ensemble_component_payloads,
    effective_scalar_stat_mode,
    json_safe_float_list,
    json_safe_matrix,
    normalize_indices,
    validate_request,
)
from backend.server.app_state import AppState
from backend.server.compute import compute_observable_series
from backend.server.expression import ExpressionEvaluationError, evaluate_expression_payload
from backend.server.models import (
    EnsembleSeriesRequest,
    EnsembleSeriesResponse,
    ExpressionDatasetRequest,
    ExpressionEnsembleRequest,
    ExpressionEnsembleResponse,
    ExpressionSeriesRequest,
    ExpressionSeriesResponse,
    HoppingEventsRequest,
    HoppingEventsResponse,
    RawKeySeriesRequest,
    RawKeySeriesResponse,
    SeriesRequest,
    SeriesResponse,
)


def build_series_router(state: AppState) -> APIRouter:
    router = APIRouter(prefix=state.api_base)
    cache = state.cache

    @router.post("/series", response_model=SeriesResponse)
    def get_series(req: SeriesRequest) -> SeriesResponse:
        traj_id = str(req.traj_id)
        observable = str(req.observable)
        indices = normalize_indices(req.indices)

        current_store, _, _ = state.get_runtime_snapshot()
        traj = current_store.get_trajectory(traj_id)
        if traj is None:
            raise HTTPException(status_code=404, detail=f"Trajectory not found: {traj_id}")

        validate_request(
            observable=observable,
            indices=indices,
            n_atoms=traj.n_atoms,
            de_nac_state_count=int(traj.de_nac_state_count),
        )

        cache_key = (traj_id, observable, tuple(indices))
        cached_value = cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return SeriesResponse(**payload)

        try:
            series = compute_observable_series(traj, observable, indices)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to compute series: {exc}") from exc

        response_payload: dict[str, Any] = {
            "traj_id": traj_id,
            "observable": observable,
            "indices": indices,
            **series,
        }
        cache.put(cache_key, response_payload)

        out = dict(response_payload)
        out["cached"] = False
        return SeriesResponse(**out)

    @router.post("/raw-key-series", response_model=RawKeySeriesResponse)
    def get_raw_key_series(req: RawKeySeriesRequest) -> RawKeySeriesResponse:
        traj_id = str(req.traj_id)
        raw_key = str(req.raw_key).strip()
        if not raw_key:
            raise HTTPException(status_code=422, detail="raw_key must be a non-empty string.")

        cache_key = ("raw_key_series", traj_id, raw_key)
        cached_value = cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return RawKeySeriesResponse(**payload)

        current_store, _, _ = state.get_runtime_snapshot()
        try:
            series = current_store.build_raw_key_series(traj_id, raw_key)
        except KeyError as exc:
            detail = str(exc.args[0]) if exc.args else str(exc)
            raise HTTPException(status_code=404, detail=detail) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to compute raw-key series: {exc}") from exc

        response_payload: dict[str, Any] = {
            "traj_id": traj_id,
            "raw_key": raw_key,
            **series,
        }
        cache.put(cache_key, response_payload)
        out = dict(response_payload)
        out["cached"] = False
        return RawKeySeriesResponse(**out)

    @router.post("/expression-series", response_model=ExpressionSeriesResponse)
    def get_expression_series(req: ExpressionSeriesRequest) -> ExpressionSeriesResponse:
        traj_id = str(req.traj_id)
        expression = str(req.expression).strip()
        if not expression:
            raise HTTPException(status_code=422, detail="expression must be a non-empty string.")

        cache_key = ("expression_series", traj_id, expression)
        cached_value = cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return ExpressionSeriesResponse(**payload)

        current_store, _, _ = state.get_runtime_snapshot()
        try:
            payload = evaluate_expression_payload(
                store=current_store,
                expression=expression,
                traj_id=traj_id,
            )
        except KeyError as exc:
            detail = str(exc.args[0]) if exc.args else str(exc)
            raise HTTPException(status_code=404, detail=detail) from exc
        except (ExpressionEvaluationError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to evaluate expression series: {exc}") from exc

        response_payload: dict[str, Any] = {
            "traj_id": traj_id,
            "expression": expression,
            "scope": str(payload.scope),
            "series_kind": str(payload.series_kind),
            "time": [float(v) for v in payload.time],
            "value": json_safe_float_list(payload.value),
            "values": json_safe_matrix(payload.values),
            "n_points": int(payload.n_points),
            "n_components": (None if payload.n_components is None else int(payload.n_components)),
            "n_trajectories": int(payload.n_trajectories),
            "sample_count": (None if payload.sample_count is None else [int(v) for v in payload.sample_count]),
        }
        cache.put(cache_key, response_payload)

        out = dict(response_payload)
        out["cached"] = False
        return ExpressionSeriesResponse(**out)

    @router.post("/expression-ensemble", response_model=ExpressionEnsembleResponse)
    def get_expression_ensemble(req: ExpressionEnsembleRequest) -> ExpressionEnsembleResponse:
        expression = str(req.expression).strip()
        stat_mode = str(req.stat_mode)
        if not expression:
            raise HTTPException(status_code=422, detail="expression must be a non-empty string.")

        cache_key = ("expression_ensemble", expression, stat_mode)
        cached_value = cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return ExpressionEnsembleResponse(**payload)

        current_store, _, _ = state.get_runtime_snapshot()
        traj_ids = list(current_store.traj_ids)

        try:
            series_records: list[dict[str, Any]] = []
            series_kind: str | None = None
            for traj_id in traj_ids:
                payload = evaluate_expression_payload(
                    store=current_store,
                    expression=expression,
                    traj_id=traj_id,
                )
                record_kind = str(payload.series_kind)
                if series_kind is None:
                    series_kind = record_kind
                elif record_kind != series_kind:
                    raise HTTPException(
                        status_code=422,
                        detail=(
                            f"Expression '{expression}' has mixed series kinds across trajectories "
                            "(scalar and matrix), which is unsupported for ensemble statistics."
                        ),
                    )
                series_records.append(
                    {
                        "series_kind": record_kind,
                        "time": [float(v) for v in payload.time],
                        "value": json_safe_float_list(payload.value),
                        "values": json_safe_matrix(payload.values),
                        "n_components": (None if payload.n_components is None else int(payload.n_components)),
                    }
                )

            if not series_records or series_kind is None:
                raise HTTPException(
                    status_code=422,
                    detail=f"No ensemble data is available for expression '{expression}'.",
                )

            component_series: list[dict[str, Any]] = []
            n_components: int | None = None
            if series_kind == "scalar":
                effective_stat_mode = effective_scalar_stat_mode(stat_mode, n_components=1)
                scalar_series = [as_scalar_series_record(record) for record in series_records]
                component_series.append(
                    build_ensemble_component_payload(
                        scalar_series_list=scalar_series,
                        stat_mode=effective_stat_mode,
                        context_key=f"expression:{expression}",
                        component_index=0,
                    )
                )
            else:
                component_series, max_components = build_matrix_ensemble_component_payloads(
                    matrix_series_records=series_records,
                    stat_mode=stat_mode,
                    context_key=f"expression:{expression}",
                )
                n_components = int(max_components)
        except HTTPException:
            raise
        except KeyError as exc:
            detail = str(exc.args[0]) if exc.args else str(exc)
            raise HTTPException(status_code=404, detail=detail) from exc
        except (ExpressionEvaluationError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to evaluate expression ensemble: {exc}") from exc

        response_payload: dict[str, Any] = {
            "expression": expression,
            "series_kind": series_kind,
            "n_components": n_components,
            "stat_mode": stat_mode,
            "component_series": component_series,
            "n_trajectories": len(traj_ids),
        }
        cache.put(cache_key, response_payload)

        out = dict(response_payload)
        out["cached"] = False
        return ExpressionEnsembleResponse(**out)

    @router.post("/expression-dataset")
    def get_expression_dataset(req: ExpressionDatasetRequest) -> None:
        expression = str(req.expression).strip()
        if not expression:
            raise HTTPException(status_code=422, detail="expression must be a non-empty string.")
        raise HTTPException(
            status_code=422,
            detail=(
                "Dataset-scoped expression evaluation is disabled. "
                "Expression only supports single-trajectory mode; use /expression-series with a traj_id."
            ),
        )

    @router.post("/hopping-events", response_model=HoppingEventsResponse)
    def get_hopping_events(req: HoppingEventsRequest) -> HoppingEventsResponse:
        traj_ids = []
        seen_ids: set[str] = set()
        for raw_traj_id in req.traj_ids:
            traj_id = str(raw_traj_id).strip()
            if not traj_id or traj_id in seen_ids:
                continue
            traj_ids.append(traj_id)
            seen_ids.add(traj_id)
        if not traj_ids:
            raise HTTPException(status_code=422, detail="At least one traj_id is required for hopping detection.")

        algorithm = str(req.algorithm)
        time_rule = str(req.time_rule)
        transitions = [
            {
                "from_state": int(item.from_state),
                "to_state": int(item.to_state),
            }
            for item in req.transitions
        ]
        cache_key = (
            "hopping_events",
            tuple(traj_ids),
            algorithm,
            time_rule,
            tuple((int(item["from_state"]), int(item["to_state"])) for item in transitions),
        )
        cached_value = cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return HoppingEventsResponse(**payload)

        current_store, _, _ = state.get_runtime_snapshot()
        try:
            payload = current_store.build_hopping_events(
                traj_ids,
                algorithm=algorithm,
                time_rule=time_rule,
                transitions=transitions,
            )
        except KeyError as exc:
            detail = str(exc.args[0]) if exc.args else str(exc)
            raise HTTPException(status_code=404, detail=detail) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to compute hopping events: {exc}") from exc

        cache.put(cache_key, payload)
        out = dict(payload)
        out["cached"] = False
        return HoppingEventsResponse(**out)

    @router.post("/ensemble-series", response_model=EnsembleSeriesResponse)
    def get_ensemble_series(req: EnsembleSeriesRequest) -> EnsembleSeriesResponse:
        observable = str(req.observable)
        indices = normalize_indices(req.indices)
        raw_key = str(req.raw_key or "").strip()
        stat_mode = str(req.stat_mode)

        if observable == "raw_key":
            if indices:
                raise HTTPException(status_code=422, detail="Observable 'raw_key' does not accept indices.")
            if not raw_key:
                raise HTTPException(status_code=422, detail="Observable 'raw_key' requires a non-empty raw_key.")
        else:
            if observable not in ALLOWED_OBSERVABLES:
                raise HTTPException(status_code=400, detail=f"Unsupported observable: {observable}")
            if raw_key:
                raise HTTPException(
                    status_code=422,
                    detail="raw_key must be empty unless observable is 'raw_key'.",
                )

        cache_key = ("ensemble", observable, tuple(indices), raw_key, stat_mode)
        cached_value = cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return EnsembleSeriesResponse(**payload)

        current_store, _, _ = state.get_runtime_snapshot()
        traj_ids = list(current_store.traj_ids)
        component_series: list[dict[str, Any]] = []

        try:
            if observable == "raw_key":
                raw_series_records: list[dict[str, Any]] = []
                series_kind: str | None = None
                component_labels: list[str] | None = None
                labels_mismatch = False

                for traj_id in traj_ids:
                    series = current_store.build_raw_key_series(traj_id, raw_key)
                    record_kind = str(series.get("series_kind", "scalar"))
                    if series_kind is None:
                        series_kind = record_kind
                    elif record_kind != series_kind:
                        raise HTTPException(
                            status_code=422,
                            detail=(
                                f"Raw key '{raw_key}' has mixed series kinds across trajectories "
                                "(scalar and matrix), which is unsupported for ensemble statistics."
                            ),
                        )
                    if record_kind == "matrix":
                        labels = series.get("component_labels")
                        if isinstance(labels, list):
                            labels_text = [str(v) for v in labels]
                            if component_labels is None:
                                component_labels = labels_text
                            elif labels_text != component_labels:
                                labels_mismatch = True
                        elif component_labels is not None:
                            labels_mismatch = True
                    raw_series_records.append(series)

                if not raw_series_records or series_kind is None:
                    raise HTTPException(
                        status_code=422,
                        detail=f"No ensemble data is available for raw key '{raw_key}'.",
                    )

                if series_kind == "scalar":
                    effective_stat_mode = effective_scalar_stat_mode(stat_mode, n_components=1)
                    scalar_series = [as_scalar_series_record(record) for record in raw_series_records]
                    component_series.append(
                        build_ensemble_component_payload(
                            scalar_series_list=scalar_series,
                            stat_mode=effective_stat_mode,
                            context_key=f"raw_key:{raw_key}",
                            component_index=0,
                        )
                    )
                else:
                    if labels_mismatch:
                        component_labels = None
                    matrix_component_series, _ = build_matrix_ensemble_component_payloads(
                        matrix_series_records=raw_series_records,
                        stat_mode=stat_mode,
                        context_key=f"raw_key:{raw_key}",
                        component_labels=component_labels,
                    )
                    component_series.extend(matrix_component_series)
            else:
                series_records: list[dict[str, Any]] = []
                series_kind: str | None = None
                for traj_id in traj_ids:
                    traj = current_store.get_trajectory(traj_id)
                    if traj is None:
                        raise HTTPException(status_code=404, detail=f"Trajectory not found: {traj_id}")
                    validate_request(
                        observable=observable,
                        indices=indices,
                        n_atoms=int(traj.n_atoms),
                        de_nac_state_count=int(traj.de_nac_state_count),
                    )
                    series = compute_observable_series(traj, observable, indices)
                    record_kind = str(series.get("series_kind", "scalar"))
                    if series_kind is None:
                        series_kind = record_kind
                    elif record_kind != series_kind:
                        raise HTTPException(
                            status_code=422,
                            detail=f"Observable '{observable}' has mixed series kinds across trajectories.",
                        )
                    series_records.append(series)

                if not series_records or series_kind is None:
                    raise HTTPException(
                        status_code=422,
                        detail=f"No ensemble data is available for observable '{observable}'.",
                    )

                if series_kind == "scalar":
                    effective_stat_mode = effective_scalar_stat_mode(stat_mode, n_components=1)
                    scalar_series = [as_scalar_series_record(record) for record in series_records]
                    component_series.append(
                        build_ensemble_component_payload(
                            scalar_series_list=scalar_series,
                            stat_mode=effective_stat_mode,
                            context_key=observable,
                            component_index=0,
                        )
                    )
                else:
                    matrix_component_series, _ = build_matrix_ensemble_component_payloads(
                        matrix_series_records=series_records,
                        stat_mode=stat_mode,
                        context_key=observable,
                    )
                    component_series.extend(matrix_component_series)
        except HTTPException:
            raise
        except KeyError as exc:
            detail = str(exc.args[0]) if exc.args else str(exc)
            raise HTTPException(status_code=404, detail=detail) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to compute ensemble series: {exc}") from exc

        response_payload: dict[str, Any] = {
            "observable": observable,
            "indices": indices,
            "raw_key": (raw_key if observable == "raw_key" else None),
            "stat_mode": stat_mode,
            "component_series": component_series,
            "n_trajectories": len(traj_ids),
        }
        cache.put(cache_key, response_payload)

        out = dict(response_payload)
        out["cached"] = False
        return EnsembleSeriesResponse(**out)

    return router
