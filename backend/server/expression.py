from __future__ import annotations

import abc
from dataclasses import dataclass
import re
from typing import Any, Callable, Literal

import numpy as np

from .dataset_store import DatasetStore

InternalScope = Literal["trajectory", "dataset", "literal"]
PublicScope = Literal["trajectory", "dataset"]

REMOVED_FUNCTION_HINTS: dict[str, str] = {
    "cmean": "Cross-trajectory operations are disabled; use /expression-series with a traj_id.",
    "csum": "Cross-trajectory operations are disabled; use /expression-series with a traj_id.",
    "mean": "Use reduce{X,[...]} for within-trajectory axis reductions.",
    "sum": "Use reduce{X,[...]} for within-trajectory axis reductions.",
}

ERR_FUNC_ARITY = "Function '{func}' expects {expected} args, got {actual}."
ERR_UNSUPPORTED_FUNC = "Unsupported function '{func}'. Supported functions: {supported}."
ERR_COMPLEX_UNSUPPORTED = "Function '{func}' does not support complex-valued input; wrap with tabs{{...}} first."


class ExpressionEvaluationError(ValueError):
    pass


@dataclass(slots=True)
class _Token:
    kind: str
    text: str
    pos: int


@dataclass(slots=True)
class _LiteralNode:
    value: float


@dataclass(slots=True)
class _KeyNode:
    key: str


@dataclass(slots=True)
class _CallNode:
    func: str
    args: list["_ExprNode"]


@dataclass(slots=True)
class _AxisListNode:
    values: list[int]


_ExprNode = _LiteralNode | _KeyNode | _CallNode | _AxisListNode


@dataclass(slots=True)
class _ExprValue:
    data: np.ndarray
    scope: InternalScope
    has_time: bool
    time: np.ndarray | None
    sample_count: np.ndarray | None = None


@dataclass(slots=True)
class ExpressionPayload:
    scope: PublicScope
    series_kind: Literal["scalar", "matrix"]
    time: list[float]
    value: list[float] | None
    values: list[list[float]] | None
    n_points: int
    n_components: int | None
    n_trajectories: int
    sample_count: list[int] | None


_SCOPE_MERGE_TABLE: dict[tuple[InternalScope, InternalScope], InternalScope] = {
    ("trajectory", "trajectory"): "trajectory",
    ("trajectory", "dataset"): "trajectory",
    ("trajectory", "literal"): "trajectory",
    ("dataset", "trajectory"): "trajectory",
    ("dataset", "dataset"): "dataset",
    ("dataset", "literal"): "dataset",
    ("literal", "trajectory"): "trajectory",
    ("literal", "dataset"): "dataset",
    ("literal", "literal"): "literal",
}


def _public_scope(scope: InternalScope) -> PublicScope:
    if scope == "trajectory":
        return "trajectory"
    return "dataset"


def _combine_scopes(scopes: list[InternalScope]) -> InternalScope:
    if not scopes:
        return "dataset"
    out = scopes[0]
    for nxt in scopes[1:]:
        out = _SCOPE_MERGE_TABLE[(out, nxt)]
    return out


def _safe_divide(lhs: np.ndarray, rhs: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        out = np.divide(lhs, rhs)
    out = np.asarray(out, dtype=float)
    out[~np.isfinite(out)] = np.nan
    return out


def _safe_inverse(data: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        out = 1.0 / data
    out = np.asarray(out, dtype=float)
    out[~np.isfinite(out)] = np.nan
    return out


def _safe_nansum_over_axes(data: np.ndarray, axes: tuple[int, ...]) -> np.ndarray:
    out = np.nansum(data, axis=axes)
    out = np.asarray(out, dtype=float)
    all_nan_mask = np.all(np.isnan(data), axis=axes)
    if out.ndim == 0:
        return np.asarray(np.nan, dtype=float) if bool(all_nan_mask) else out
    out[np.asarray(all_nan_mask, dtype=bool)] = np.nan
    return out


def _normalize_axes(axes: list[int], ndim: int) -> tuple[int, ...]:
    if not axes:
        raise ExpressionEvaluationError("Function 'reduce' requires a non-empty axis list, e.g. reduce{X,[-1]}.")

    normalized: list[int] = []
    seen: set[int] = set()
    for axis in axes:
        idx = int(axis)
        if idx < 0:
            idx += int(ndim)
        if idx < 0 or idx >= int(ndim):
            raise ExpressionEvaluationError(f"Function 'reduce' axis {axis} is out of bounds for ndim={ndim}.")
        if idx in seen:
            raise ExpressionEvaluationError(
                f"Function 'reduce' has duplicate axis {axis} (normalized={idx})."
            )
        seen.add(idx)
        normalized.append(idx)
    return tuple(sorted(normalized))


def _parse_axis_list_literal(text: str, pos: int) -> list[int]:
    stripped = str(text).strip()
    if not (stripped.startswith("[") and stripped.endswith("]")):
        raise ExpressionEvaluationError(
            f"Invalid axis list literal '{text}' at position {pos}; expected bracket form like [-1,0]."
        )
    inner = stripped[1:-1].strip()
    if not inner:
        return []
    parts = [chunk.strip() for chunk in inner.split(",")]
    values: list[int] = []
    for chunk in parts:
        if not chunk:
            raise ExpressionEvaluationError(
                f"Invalid axis list literal '{text}' at position {pos}; empty axis token is not allowed."
            )
        try:
            values.append(int(chunk, 10))
        except ValueError as exc:
            raise ExpressionEvaluationError(
                f"Invalid axis value '{chunk}' in axis list literal '{text}' at position {pos}."
            ) from exc
    return values


class BaseOp(abc.ABC):
    def __init__(self, name: str, arity: int) -> None:
        self.name = str(name)
        self.arity = int(arity)

    @abc.abstractmethod
    def __call__(self, evaluator: "_Evaluator", args: list[_ExprNode], traj_id: str | None) -> _ExprValue:
        raise NotImplementedError


class ElementwiseOp(BaseOp):
    def __init__(
        self,
        name: str,
        np_func: Callable[..., Any],
        *,
        arity: int,
        sanitize_non_finite: bool = False,
    ) -> None:
        super().__init__(name=name, arity=arity)
        self._np_func = np_func
        self._sanitize_non_finite = bool(sanitize_non_finite)

    def __call__(self, evaluator: "_Evaluator", args: list[_ExprNode], traj_id: str | None) -> _ExprValue:
        eval_args = [evaluator.visit(arg, traj_id) for arg in args]
        scopes = [value.scope for value in eval_args]

        has_time = any(value.has_time for value in eval_args)
        ref_time: np.ndarray | None = None
        data_args: list[np.ndarray] = []

        for value in eval_args:
            arr_raw = np.asarray(value.data)
            if np.iscomplexobj(arr_raw):
                raise ExpressionEvaluationError(ERR_COMPLEX_UNSUPPORTED.format(func=self.name))
            arr = np.asarray(arr_raw, dtype=float)
            if has_time:
                if value.has_time:
                    if value.time is None:
                        raise ExpressionEvaluationError(
                            f"Function '{self.name}' encountered missing time metadata."
                        )
                    if ref_time is None:
                        ref_time = np.asarray(value.time, dtype=float).reshape(-1)
                else:
                    arr = np.expand_dims(arr, axis=0)
            data_args.append(arr)

        if has_time and ref_time is None:
            raise ExpressionEvaluationError(f"Function '{self.name}' could not establish a time axis.")

        try:
            with np.errstate(divide="ignore", invalid="ignore"):
                out = self._np_func(*data_args)
        except ValueError as exc:
            shapes = [tuple(np.asarray(v).shape) for v in data_args]
            raise ExpressionEvaluationError(
                f"Broadcast failed in '{self.name}' with argument shapes={shapes}: {exc}"
            ) from exc

        out_arr = np.asarray(out, dtype=float)
        if self._sanitize_non_finite:
            out_arr[~np.isfinite(out_arr)] = np.nan

        return _ExprValue(
            data=out_arr,
            scope=_combine_scopes(scopes),
            has_time=has_time,
            time=(None if not has_time else np.asarray(ref_time, dtype=float)),
        )


class TabsOp(BaseOp):
    def __init__(self) -> None:
        super().__init__(name="tabs", arity=1)

    def __call__(self, evaluator: "_Evaluator", args: list[_ExprNode], traj_id: str | None) -> _ExprValue:
        value = evaluator.visit(args[0], traj_id)
        data = np.asarray(value.data)
        out = np.asarray(np.abs(data), dtype=float)
        out[~np.isfinite(out)] = np.nan

        if value.has_time and value.time is None:
            raise ExpressionEvaluationError("Function 'tabs' encountered missing time metadata.")

        return _ExprValue(
            data=out,
            scope=value.scope,
            has_time=value.has_time,
            time=None if not value.has_time else np.asarray(value.time, dtype=float),
        )


class ReduceByAxesOp(BaseOp):
    def __init__(self) -> None:
        super().__init__(name="reduce", arity=2)

    def __call__(self, evaluator: "_Evaluator", args: list[_ExprNode], traj_id: str | None) -> _ExprValue:
        value = evaluator.visit(args[0], traj_id)
        axes_expr = args[1]
        if not isinstance(axes_expr, _AxisListNode):
            raise ExpressionEvaluationError(
                "Function 'reduce' expects an axis list literal as second argument, e.g. reduce{X,[-1]}."
            )

        data_raw = np.asarray(value.data)
        if np.iscomplexobj(data_raw):
            raise ExpressionEvaluationError(ERR_COMPLEX_UNSUPPORTED.format(func=self.name))
        data = np.asarray(data_raw, dtype=float)

        axes = _normalize_axes(axes_expr.values, data.ndim)
        if value.has_time:
            if value.time is None:
                raise ExpressionEvaluationError("Function 'reduce' encountered missing time metadata.")
            if 0 in axes:
                raise ExpressionEvaluationError(
                    "Function 'reduce' cannot reduce over time axis 0 for timed input."
                )

        reduced = _safe_nansum_over_axes(data, axes)
        return _ExprValue(
            data=np.asarray(reduced, dtype=float),
            scope=value.scope,
            has_time=value.has_time,
            time=None if not value.has_time else np.asarray(value.time, dtype=float),
            sample_count=None,
        )


OPERATORS: dict[str, BaseOp] = {
    "tadd": ElementwiseOp("tadd", np.add, arity=2),
    "tminus": ElementwiseOp("tminus", np.subtract, arity=2),
    "tprod": ElementwiseOp("tprod", np.multiply, arity=2),
    "tdiv": ElementwiseOp("tdiv", _safe_divide, arity=2, sanitize_non_finite=True),
    "tneg": ElementwiseOp("tneg", np.negative, arity=1),
    "tinv": ElementwiseOp("tinv", _safe_inverse, arity=1, sanitize_non_finite=True),
    "tabs": TabsOp(),
    "reduce": ReduceByAxesOp(),
}


def _supported_functions_text() -> str:
    return ", ".join(sorted(OPERATORS.keys()))


def _operator_arity(func: str) -> int | None:
    op = OPERATORS.get(str(func))
    if op is None:
        return None
    return int(op.arity)


_FUNC_NAME_PATTERN = "|".join(sorted((re.escape(name) for name in OPERATORS.keys()), key=len, reverse=True))
_TOKEN_RE = re.compile(
    r"(?P<WS>\s+)"
    + rf"|(?P<FUNC>(?:{_FUNC_NAME_PATTERN})(?=\s*\{{))"
    + r"|(?P<FLOAT>[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?)"
    + r"|(?P<LBRACE>\{)"
    + r"|(?P<RBRACE>\})"
    + r"|(?P<COMMA>,)"
    + r"|(?P<AXES>\[\s*(?:[+-]?\d+(?:\s*,\s*[+-]?\d+)*)?\s*\])"
    + r"|(?P<KEY>[^{}\s,]+)"
)


class _Parser:
    def __init__(self, expression: str) -> None:
        self.expression = str(expression or "")
        self.tokens = self._tokenize(self.expression)
        self.idx = 0

    @staticmethod
    def _tokenize(expression: str) -> list[_Token]:
        out: list[_Token] = []
        pos = 0
        length = len(expression)
        while pos < length:
            match = _TOKEN_RE.match(expression, pos)
            if match is None:
                bad_char = expression[pos]
                raise ExpressionEvaluationError(f"Unexpected character '{bad_char}' at position {pos}.")
            kind = str(match.lastgroup or "")
            text = str(match.group(0))
            if kind != "WS":
                out.append(_Token(kind=kind, text=text, pos=pos))
            pos = int(match.end())
        return out

    def parse(self) -> _ExprNode:
        if not self.tokens:
            raise ExpressionEvaluationError("Expression must be a non-empty string.")
        node = self._parse_expr()
        if self.idx != len(self.tokens):
            token = self.tokens[self.idx]
            raise ExpressionEvaluationError(
                f"Unexpected token '{token.text}' at position {token.pos}; expected end of expression."
            )
        return node

    def _peek(self) -> _Token | None:
        if self.idx >= len(self.tokens):
            return None
        return self.tokens[self.idx]

    def _consume(self, kind: str) -> _Token:
        token = self._peek()
        if token is None:
            raise ExpressionEvaluationError(f"Expected token '{kind}' but expression ended early.")
        if token.kind != kind:
            raise ExpressionEvaluationError(
                f"Expected token '{kind}' at position {token.pos}, got '{token.text}'."
            )
        self.idx += 1
        return token

    def _parse_expr(self) -> _ExprNode:
        token = self._peek()
        if token is None:
            raise ExpressionEvaluationError("Unexpected end of expression.")

        if token.kind == "FLOAT":
            self.idx += 1
            try:
                value = float(token.text)
            except ValueError as exc:
                raise ExpressionEvaluationError(
                    f"Failed to parse numeric literal '{token.text}' at position {token.pos}."
                ) from exc
            if not np.isfinite(value):
                raise ExpressionEvaluationError(
                    f"Numeric literal '{token.text}' at position {token.pos} is not finite."
                )
            return _LiteralNode(value=value)

        if token.kind == "FUNC":
            return self._parse_call()

        if token.kind == "AXES":
            self.idx += 1
            return _AxisListNode(values=_parse_axis_list_literal(token.text, token.pos))

        if token.kind == "KEY":
            next_token = self.tokens[self.idx + 1] if self.idx + 1 < len(self.tokens) else None
            if next_token is not None and next_token.kind == "LBRACE":
                hint = REMOVED_FUNCTION_HINTS.get(token.text)
                if hint is not None:
                    raise ExpressionEvaluationError(
                        f"Function '{token.text}' is not supported. {hint}"
                    )
                raise ExpressionEvaluationError(
                    ERR_UNSUPPORTED_FUNC.format(
                        func=token.text,
                        supported=_supported_functions_text(),
                    )
                )
            self.idx += 1
            return _KeyNode(key=token.text)

        raise ExpressionEvaluationError(f"Unexpected token '{token.text}' at position {token.pos}.")

    def _parse_call(self) -> _CallNode:
        func_token = self._consume("FUNC")
        func = func_token.text
        self._consume("LBRACE")

        args: list[_ExprNode] = []
        while True:
            token = self._peek()
            if token is None:
                raise ExpressionEvaluationError(
                    f"Function '{func}' opened at position {func_token.pos} is missing closing '}}'."
                )
            if token.kind == "RBRACE":
                break
            args.append(self._parse_expr())
            token = self._peek()
            if token is None:
                raise ExpressionEvaluationError(
                    f"Function '{func}' opened at position {func_token.pos} is missing closing '}}'."
                )
            if token.kind == "COMMA":
                self.idx += 1
                continue
            if token.kind != "RBRACE":
                raise ExpressionEvaluationError(
                    f"Expected ',' or '}}' at position {token.pos}, got '{token.text}'."
                )
            break

        self._consume("RBRACE")

        expected_arity = _operator_arity(func)
        if expected_arity is None:
            raise ExpressionEvaluationError(
                ERR_UNSUPPORTED_FUNC.format(func=func, supported=_supported_functions_text())
            )
        if len(args) != expected_arity:
            raise ExpressionEvaluationError(
                ERR_FUNC_ARITY.format(func=func, expected=expected_arity, actual=len(args))
            )
        return _CallNode(func=func, args=args)


class _Evaluator:
    def __init__(self, store: DatasetStore) -> None:
        self.store = store

    def evaluate(self, node: _ExprNode, traj_id: str | None) -> _ExprValue:
        return self.visit(node, traj_id)

    def visit(self, node: _ExprNode, traj_id: str | None) -> _ExprValue:
        match node:
            case _LiteralNode(value=value):
                return _ExprValue(
                    data=np.asarray(value, dtype=float),
                    scope="literal",
                    has_time=False,
                    time=None,
                )
            case _KeyNode(key=key):
                return self._visit_key(key, traj_id)
            case _CallNode(func=func_name, args=args):
                return self._visit_call(func_name, args, traj_id)
            case _AxisListNode():
                raise ExpressionEvaluationError(
                    "Axis list literal can only be used as the second argument of reduce{...}."
                )
            case _:
                raise ExpressionEvaluationError(f"Internal expression node type is unsupported: {type(node)!r}")

    def _visit_key(self, key: str, traj_id: str | None) -> _ExprValue:
        if traj_id is None:
            raise ExpressionEvaluationError(
                f"Raw key '{key}' requires trajectory context; use /expression-series with a traj_id."
            )

        payload = self.store.build_raw_key_expression_value(traj_id, key)
        data = np.asarray(payload["data"])
        has_time = bool(payload["has_time"])
        time_axis = payload.get("time")
        time = None if not has_time else np.asarray(time_axis, dtype=float).reshape(-1)

        if has_time and data.ndim >= 1 and int(data.shape[0]) != int(time.shape[0]):
            raise ExpressionEvaluationError(
                (
                    f"Raw key '{key}' on trajectory '{traj_id}' has mismatched time axis: "
                    f"data.shape[0]={data.shape[0]}, time.shape[0]={time.shape[0]}."
                )
            )

        return _ExprValue(
            data=data,
            scope="trajectory",
            has_time=has_time,
            time=time,
        )

    def _visit_call(self, func_name: str, args: list[_ExprNode], traj_id: str | None) -> _ExprValue:
        op = OPERATORS.get(func_name)
        if op is None:
            hint = REMOVED_FUNCTION_HINTS.get(func_name)
            if hint is not None:
                raise ExpressionEvaluationError(
                    f"Function '{func_name}' is not supported. {hint}"
                )
            raise ExpressionEvaluationError(
                ERR_UNSUPPORTED_FUNC.format(func=func_name, supported=_supported_functions_text())
            )

        if len(args) != int(op.arity):
            raise ExpressionEvaluationError(
                ERR_FUNC_ARITY.format(func=func_name, expected=int(op.arity), actual=len(args))
            )

        return op(self, args, traj_id)


def _serialize_value(value: _ExprValue) -> dict[str, object]:
    scope: PublicScope = _public_scope(value.scope)
    data_raw = np.asarray(value.data)
    if np.iscomplexobj(data_raw):
        raise ExpressionEvaluationError(
            "Expression result is complex-valued; wrap with tabs{...} to convert to real values."
        )
    data = np.asarray(data_raw, dtype=float)
    sample_count: list[int] | None = None
    if value.sample_count is not None:
        sample_count = np.asarray(value.sample_count, dtype=int).reshape(-1).astype(int).tolist()

    if value.has_time:
        if value.time is None:
            raise ExpressionEvaluationError("Timed expression result is missing time metadata.")
        time_axis = np.asarray(value.time, dtype=float).reshape(-1)
        n_points = int(time_axis.shape[0])
        if data.ndim == 0:
            data = np.full((n_points,), float(data), dtype=float)
        if int(data.shape[0]) != n_points:
            raise ExpressionEvaluationError(
                (
                    "Timed expression result has inconsistent shape: "
                    f"data.shape[0]={data.shape[0]}, time.shape[0]={n_points}."
                )
            )
        matrix = np.asarray(data, dtype=float).reshape(n_points, -1)
        if int(matrix.shape[1]) == 1:
            return {
                "scope": scope,
                "series_kind": "scalar",
                "time": time_axis.astype(float).tolist(),
                "value": matrix[:, 0].astype(float).tolist(),
                "values": None,
                "n_points": n_points,
                "n_components": None,
                "sample_count": sample_count,
            }
        return {
            "scope": scope,
            "series_kind": "matrix",
            "time": time_axis.astype(float).tolist(),
            "value": None,
            "values": matrix.astype(float).tolist(),
            "n_points": n_points,
            "n_components": int(matrix.shape[1]),
            "sample_count": sample_count,
        }

    if data.ndim == 0:
        return {
            "scope": scope,
            "series_kind": "scalar",
            "time": [0.0],
            "value": [float(data)],
            "values": None,
            "n_points": 1,
            "n_components": None,
            "sample_count": sample_count,
        }

    flat = np.asarray(data, dtype=float).reshape(-1)
    if int(flat.shape[0]) == 1:
        return {
            "scope": scope,
            "series_kind": "scalar",
            "time": [0.0],
            "value": [float(flat[0])],
            "values": None,
            "n_points": 1,
            "n_components": None,
            "sample_count": sample_count,
        }
    return {
        "scope": scope,
        "series_kind": "matrix",
        "time": [0.0],
        "value": None,
        "values": [flat.astype(float).tolist()],
        "n_points": 1,
        "n_components": int(flat.shape[0]),
        "sample_count": sample_count,
    }


def evaluate_expression_payload(
    *,
    store: DatasetStore,
    expression: str,
    traj_id: str | None,
) -> ExpressionPayload:
    parser = _Parser(expression)
    node = parser.parse()
    evaluator = _Evaluator(store)
    value = evaluator.visit(node, traj_id)
    payload = _serialize_value(value)
    return ExpressionPayload(
        scope=str(payload["scope"]),  # type: ignore[arg-type]
        series_kind=str(payload["series_kind"]),  # type: ignore[arg-type]
        time=list(payload["time"]),  # type: ignore[arg-type]
        value=payload["value"],  # type: ignore[arg-type]
        values=payload["values"],  # type: ignore[arg-type]
        n_points=int(payload["n_points"]),
        n_components=payload["n_components"],  # type: ignore[arg-type]
        n_trajectories=len(store.traj_ids),
        sample_count=payload["sample_count"],  # type: ignore[arg-type]
    )
