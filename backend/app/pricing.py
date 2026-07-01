from __future__ import annotations

from functools import lru_cache
import os
from pathlib import Path
from typing import Any

import yaml
from fastapi import HTTPException

from .live_pricing import clear_live_pricing_cache, load_live_pricing_config


DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[2] / "config" / "pricing.yaml"


@lru_cache
def load_pricing_config(config_path: str | None = None) -> dict[str, Any]:
    env_path = os.getenv("PRICING_CONFIG_PATH")
    path = Path(config_path or env_path) if (config_path or env_path) else DEFAULT_CONFIG_PATH
    if not path.exists():
        container_path = Path(__file__).resolve().parents[1] / "config" / "pricing.yaml"
        if container_path.exists():
            path = container_path
    if not path.exists():
        raise FileNotFoundError(f"Pricing config not found at {path}")
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    return data


def load_effective_pricing_config(config_path: str | None = None) -> dict[str, Any]:
    return load_live_pricing_config(load_pricing_config(config_path))


def load_effective_pricing_config_for_region(
    cloud_provider: str,
    region: str,
    config_path: str | None = None,
) -> dict[str, Any]:
    return load_live_pricing_config(
        load_pricing_config(config_path),
        selected_region=(cloud_provider, region),
    )


def refresh_effective_pricing_config() -> dict[str, Any]:
    clear_live_pricing_cache()
    return load_effective_pricing_config()


def get_cloud_storage_config(
    pricing: dict[str, Any],
    cloud_provider: str,
    region: str,
    storage_class: str,
) -> dict[str, Any]:
    try:
        return pricing["cloud"][cloud_provider]["regions"][region]["storage"][storage_class]
    except KeyError as exc:
        raise HTTPException(
            status_code=400,
            detail=(
                "Storage pricing is not configured for "
                f"{cloud_provider}/{region}/{storage_class}."
            ),
        ) from exc


def get_sql_dbu_per_hour(pricing: dict[str, Any], warehouse_size: str, custom: float | None) -> float:
    if warehouse_size == "custom":
        return float(custom or 0)
    try:
        return float(pricing["databricks"]["sql_warehouses"][warehouse_size]["dbu_per_hour"])
    except KeyError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"SQL warehouse size '{warehouse_size}' is not configured.",
        ) from exc


def get_sql_dbu_rate(pricing: dict[str, Any], warehouse_type: str) -> float:
    databricks = pricing.get("databricks", {})
    sql_rates = databricks.get("dbu_rates", {}).get("sql", {})
    return float(sql_rates.get(warehouse_type, databricks.get("default_dbu_rate", 0)))


def get_job_dbu_per_hour(pricing: dict[str, Any], cluster_size: str, custom: float | None) -> float:
    if cluster_size == "custom":
        return float(custom or 0)
    try:
        return float(pricing["databricks"]["jobs"][cluster_size]["dbu_per_hour"])
    except KeyError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Job cluster size '{cluster_size}' is not configured.",
        ) from exc


def get_job_dbu_rate(pricing: dict[str, Any], workload_type: str = "classic") -> float:
    databricks = pricing.get("databricks", {})
    job_rates = databricks.get("dbu_rates", {}).get("jobs", {})
    return float(job_rates.get(workload_type, job_rates.get("classic", databricks.get("default_dbu_rate", 0))))


def get_ai_bi_dbu_rate(pricing: dict[str, Any]) -> float:
    databricks = pricing.get("databricks", {})
    ai_bi_rates = databricks.get("dbu_rates", {}).get("ai_bi", {})
    return float(ai_bi_rates.get("default", databricks.get("default_dbu_rate", 0)))


def list_scenarios(pricing: dict[str, Any]) -> dict[str, Any]:
    return pricing.get("scenario_defaults", {})
