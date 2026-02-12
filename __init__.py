def main() -> None:
    # Delay importing serve.py to avoid module re-import warnings when using
    # `python -m tools.observable_dashboard.serve`.
    from .serve import main as _main
    _main()

__all__ = ["main"]
