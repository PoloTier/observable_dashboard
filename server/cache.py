from __future__ import annotations

from collections import OrderedDict
from threading import Lock
from typing import Any, Hashable

CacheKey = tuple[Hashable, ...]


class SeriesLRUCache:
    def __init__(self, max_entries: int = 512) -> None:
        max_entries = int(max_entries)
        if max_entries < 1:
            raise ValueError("max_entries must be >= 1")
        self.max_entries = max_entries
        self._items: OrderedDict[CacheKey, dict[str, Any]] = OrderedDict()
        self._lock = Lock()

    def get(self, key: CacheKey) -> dict[str, Any] | None:
        with self._lock:
            value = self._items.get(key)
            if value is None:
                return None
            self._items.move_to_end(key)
            return dict(value)

    def put(self, key: CacheKey, value: dict[str, Any]) -> None:
        with self._lock:
            if key in self._items:
                self._items.move_to_end(key)
            self._items[key] = dict(value)
            while len(self._items) > self.max_entries:
                self._items.popitem(last=False)

    def size(self) -> int:
        with self._lock:
            return len(self._items)
