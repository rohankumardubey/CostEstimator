from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from .models import EstimateRequest, EstimateResponse, SavedEstimateDetail, SavedEstimateSummary


DEFAULT_DB_PATH = Path(__file__).resolve().parents[2] / "data" / "estimates.sqlite3"


def get_database_path() -> Path:
    return Path(os.getenv("ESTIMATES_DB_PATH", DEFAULT_DB_PATH))


def initialize_database() -> None:
    path = get_database_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with _connect() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS estimates (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                team_name TEXT NOT NULL,
                dataset_name TEXT NOT NULL,
                scenario_key TEXT NOT NULL,
                scenario_title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                total_monthly_estimate REAL NOT NULL,
                estimate_with_buffer_annual REAL NOT NULL,
                request_json TEXT NOT NULL,
                estimate_json TEXT NOT NULL,
                pricing_source_json TEXT
            )
            """
        )
        connection.execute("CREATE INDEX IF NOT EXISTS idx_estimates_updated_at ON estimates(updated_at DESC)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_estimates_team_name ON estimates(team_name)")


def save_estimate(
    request: EstimateRequest,
    estimate: EstimateResponse,
    pricing_source: dict[str, Any] | None = None,
    title: str | None = None,
) -> SavedEstimateDetail:
    initialize_database()
    now = datetime.now(UTC).isoformat()
    estimate_id = uuid.uuid4().hex[:12]
    display_title = _build_title(request, title)
    row = {
        "id": estimate_id,
        "title": display_title,
        "team_name": request.dataset.team_name or "Untitled team",
        "dataset_name": request.dataset.brand_or_dataset_name or "Untitled dataset",
        "scenario_key": request.scenario_key,
        "scenario_title": estimate.scenario_title,
        "created_at": now,
        "updated_at": now,
        "total_monthly_estimate": estimate.total_monthly_estimate,
        "estimate_with_buffer_annual": estimate.estimate_with_buffer_annual,
        "request_json": request.model_dump_json(),
        "estimate_json": estimate.model_dump_json(),
        "pricing_source_json": json.dumps(pricing_source or {}, separators=(",", ":")),
    }
    with _connect() as connection:
        connection.execute(
            """
            INSERT INTO estimates (
                id, title, team_name, dataset_name, scenario_key, scenario_title,
                created_at, updated_at, total_monthly_estimate, estimate_with_buffer_annual,
                request_json, estimate_json, pricing_source_json
            )
            VALUES (
                :id, :title, :team_name, :dataset_name, :scenario_key, :scenario_title,
                :created_at, :updated_at, :total_monthly_estimate, :estimate_with_buffer_annual,
                :request_json, :estimate_json, :pricing_source_json
            )
            """,
            row,
        )
    return get_saved_estimate(estimate_id)


def list_saved_estimates(limit: int = 100) -> list[SavedEstimateSummary]:
    initialize_database()
    with _connect() as connection:
        rows = connection.execute(
            """
            SELECT id, title, team_name, dataset_name, scenario_key, scenario_title,
                   created_at, updated_at, total_monthly_estimate, estimate_with_buffer_annual
            FROM estimates
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [SavedEstimateSummary(**dict(row)) for row in rows]


def get_saved_estimate(estimate_id: str) -> SavedEstimateDetail:
    initialize_database()
    with _connect() as connection:
        row = connection.execute(
            """
            SELECT id, title, team_name, dataset_name, scenario_key, scenario_title,
                   created_at, updated_at, total_monthly_estimate, estimate_with_buffer_annual,
                   request_json, estimate_json, pricing_source_json
            FROM estimates
            WHERE id = ?
            """,
            (estimate_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"Saved estimate '{estimate_id}' was not found.")
    data = dict(row)
    return SavedEstimateDetail(
        id=data["id"],
        title=data["title"],
        team_name=data["team_name"],
        dataset_name=data["dataset_name"],
        scenario_key=data["scenario_key"],
        scenario_title=data["scenario_title"],
        created_at=data["created_at"],
        updated_at=data["updated_at"],
        total_monthly_estimate=data["total_monthly_estimate"],
        estimate_with_buffer_annual=data["estimate_with_buffer_annual"],
        request=EstimateRequest.model_validate_json(data["request_json"]),
        estimate=EstimateResponse.model_validate_json(data["estimate_json"]),
        pricing_source=json.loads(data["pricing_source_json"] or "{}"),
    )


def delete_saved_estimate(estimate_id: str) -> None:
    initialize_database()
    with _connect() as connection:
        cursor = connection.execute("DELETE FROM estimates WHERE id = ?", (estimate_id,))
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail=f"Saved estimate '{estimate_id}' was not found.")


def _connect() -> sqlite3.Connection:
    connection = sqlite3.connect(get_database_path())
    connection.row_factory = sqlite3.Row
    return connection


def _build_title(request: EstimateRequest, title: str | None) -> str:
    if title and title.strip():
        return title.strip()[:180]
    team = request.dataset.team_name.strip() or "Untitled team"
    dataset = request.dataset.brand_or_dataset_name.strip() or "Untitled dataset"
    return f"{team} - {dataset}"[:180]
