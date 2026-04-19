from backend.server.routers.dataset import build_dataset_router
from backend.server.routers.distributions import build_distributions_router
from backend.server.routers.health import build_health_router
from backend.server.routers.md import build_md_router
from backend.server.routers.mol3d import build_mol3d_router
from backend.server.routers.normal_modes import build_normal_modes_router
from backend.server.routers.pages import build_pages_router
from backend.server.routers.series import build_series_router

__all__ = [
    "build_dataset_router",
    "build_distributions_router",
    "build_health_router",
    "build_md_router",
    "build_mol3d_router",
    "build_normal_modes_router",
    "build_pages_router",
    "build_series_router",
]
