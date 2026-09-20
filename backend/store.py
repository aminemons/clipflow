from __future__ import annotations

import json
import copy
import logging
import os
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    """Small atomic JSON store: suitable for a single local Clipflow process."""

    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.projects = self.root / "projects"
        self.files = self.root / "files"
        self.projects.mkdir(parents=True, exist_ok=True)
        self.files.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    @staticmethod
    def _read(path: Path) -> dict | None:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else None
        except (OSError, ValueError):
            return None

    @staticmethod
    def _atomic_write(path: Path, value: dict) -> None:
        temporary = path.with_name(path.name + ".tmp")
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)

    @staticmethod
    def _upgrade(project: dict) -> dict:
        """Additive migration: unknown fields and existing media references survive."""
        result = copy.deepcopy(project)
        version = result.get("schema_version", 1)
        if not isinstance(version, int) or version > 2:
            raise ValueError("This project requires a newer version of Clipflow.")
        result["schema_version"] = 2
        result.setdefault("edit_revision", 0)
        for clip in result.get("clips", []):
            if isinstance(clip, dict):
                clip.setdefault("reviewed", False)
                clip.setdefault("subject", "auto")
                if clip.get("reason"):
                    clip.setdefault("suggestion_status", "pending")
        return result

    def _path(self, project_id: str) -> Path:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", project_id):
            raise ValueError("Invalid project identifier")
        return self.projects / f"{project_id}.json"

    def create_id(self) -> str:
        return uuid.uuid4().hex[:12]

    def save(self, project: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            p = self._path(project["id"])
            previous = self._read(p)
            if previous is not None:
                # Keep an original schema snapshot and one last valid save. A
                # corrupt current file must never replace a healthy backup.
                original = p.with_suffix(".json.v1.bak")
                if previous.get("schema_version", 1) < 2 and not original.exists():
                    self._atomic_write(original, previous)
                self._atomic_write(p.with_suffix(".json.bak"), previous)
            upgraded = self._upgrade(project)
            self._atomic_write(p, upgraded)
            project.update(upgraded)
        return project

    def get(self, project_id: str) -> dict[str, Any] | None:
        try:
            p = self._path(project_id)
        except ValueError:
            return None
        with self._lock:
            value = self._read(p)
            if value is None:
                value = self._read(p.with_suffix(".json.bak"))
                if value is not None:
                    logging.getLogger(__name__).warning("Recovered project %s from its last valid save", project_id)
            if value is None or value.get("id") != project_id or not isinstance(value.get("clips", []), list):
                return None
            return self._upgrade(value)

    def list(self) -> list[dict[str, Any]]:
        out = []
        for p in self.projects.glob("*.json"):
            value = self.get(p.stem)
            if value is not None:
                out.append(value)
        return sorted(out, key=lambda x: x.get("created_at", ""), reverse=True)

    @property
    def jobs_path(self) -> Path:
        return self.root / "jobs.json"

    def load_jobs(self) -> dict[str, dict[str, Any]]:
        """Load job summaries so a restart does not make active work invisible."""
        with self._lock:
            value = self._read(self.jobs_path)
            if value is None:
                value = self._read(self.jobs_path.with_suffix(".json.bak")) or {}
            return {key: row for key, row in value.items()
                    if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", key) and isinstance(row, dict)}

    def save_jobs(self, jobs: dict[str, dict[str, Any]]) -> None:
        with self._lock:
            previous = self._read(self.jobs_path)
            if previous is not None:
                self._atomic_write(self.jobs_path.with_suffix(".json.bak"), previous)
            self._atomic_write(self.jobs_path, jobs)
