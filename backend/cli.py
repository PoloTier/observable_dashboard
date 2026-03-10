import sys


def main() -> None:
    print(
        "[REMOVED] Static export mode has been removed.\n"
        "Use `python -m tools.observable_dashboard.serve` to run the dashboard API server.",
        file=sys.stderr,
    )
    raise SystemExit(2)


if __name__ == "__main__":
    main()
