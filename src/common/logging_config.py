from __future__ import annotations

import logging
import os
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path


def setup_logging() -> None:
    # Idempotent setup (FastAPI/uvicorn import paths can call this more than once).
    root = logging.getLogger()
    if getattr(root, "_scheduler_logging_configured", False):
        return

    level_name = os.getenv("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)

    log_dir = os.getenv("LOG_DIR", "logs").strip() or "logs"
    log_file = os.getenv("LOG_FILE", "app.log").strip() or "app.log"
    Path(log_dir).mkdir(parents=True, exist_ok=True)

    formatter = logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s")

    console_handler = logging.StreamHandler()
    console_handler.setLevel(level)
    console_handler.setFormatter(formatter)

    file_path = str(Path(log_dir) / log_file)
    file_handler = TimedRotatingFileHandler(
        filename=file_path,
        when="H",
        interval=1,
        backupCount=int(os.getenv("LOG_BACKUP_COUNT", "168")),  # default: 7 days
        encoding="utf-8",
        utc=False,
    )
    # Rotated file naming: app.log.2026-04-21_18
    file_handler.suffix = "%Y-%m-%d_%H"
    file_handler.setLevel(level)
    file_handler.setFormatter(formatter)

    root.setLevel(level)
    root.addHandler(console_handler)
    root.addHandler(file_handler)
    root._scheduler_logging_configured = True  # type: ignore[attr-defined]


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)

