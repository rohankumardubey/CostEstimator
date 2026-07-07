from __future__ import annotations

import re

from fastapi.testclient import TestClient

from app.main import app
from app.persistence import initialize_database


client = TestClient(app)


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_pricing_config_includes_pricing_source() -> None:
    response = client.get("/pricing-config")

    assert response.status_code == 200
    assert response.json()["pricing_source"]["mode"] in {"config", "live"}


def test_pricing_config_includes_common_aws_regions() -> None:
    response = client.get("/pricing-config")

    assert response.status_code == 200
    aws_regions = response.json()["cloud"]["aws"]["regions"]
    assert len(aws_regions) > 20
    for region in ["eu-west-1", "eu-west-2", "eu-central-1", "us-east-1", "us-west-2", "ap-south-1"]:
        assert region in aws_regions


def test_estimate_endpoint() -> None:
    payload = _estimate_payload()

    response = client.post("/estimate", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["scenario_title"] == "Archive-only"
    assert body["monthly_storage_cost"] > 0


def test_pdf_export_endpoint() -> None:
    payload = _estimate_payload()
    estimate_response = client.post("/estimate", json=payload)
    export_response = client.post(
        "/export/pdf",
        json={"request": payload, "estimate": estimate_response.json()},
    )

    assert export_response.status_code == 200
    assert export_response.headers["content-type"] == "application/pdf"
    assert export_response.content.startswith(b"%PDF")


def test_pdf_export_stays_single_page_for_full_workload() -> None:
    payload = _full_workload_estimate_payload()
    estimate_response = client.post("/estimate", json=payload)
    export_response = client.post(
        "/export/pdf",
        json={
            "request": payload,
            "estimate": estimate_response.json(),
            "recommendation": {
                "key": "scheduled_reporting",
                "title": "Recommended: Scheduled reporting",
                "summary": "Storage, recurring jobs, dashboard refreshes, and light warehouse usage.",
                "reasons": [
                    "Streaming ingestion is enabled, so this needs a compute-aware scenario rather than archive-only storage.",
                    "Kafka/Pulsar workloads should use Spark Structured Streaming or DLT continuous.",
                    "Streaming is using 2 workers plus 1 driver on m5.xlarge.",
                ],
            },
            "pricing_source": {
                "mode": "live",
                "updated_at": "2026-07-06T19:15:27+00:00",
                "cache_seconds": 21600,
                "notes": [],
            },
        },
    )

    assert export_response.status_code == 200
    assert len(re.findall(rb"/Type\s*/Page\b", export_response.content)) == 1


def test_scenario_comparison_endpoint() -> None:
    response = client.post("/scenario-comparison", json=_estimate_payload())

    assert response.status_code == 200
    body = response.json()
    assert len(body["estimates"]) == 5
    assert body["estimates"][0]["scenario_key"] == "archive_only"


def test_saved_estimate_round_trip(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("ESTIMATES_DB_PATH", str(tmp_path / "estimates.sqlite3"))
    initialize_database()
    payload = _estimate_payload()

    save_response = client.post(
        "/estimates",
        json={
            "request": payload,
            "title": "Team - Dataset saved estimate",
            "pricing_source": {"mode": "test"},
        },
    )

    assert save_response.status_code == 200
    saved = save_response.json()
    assert saved["id"]
    assert saved["title"] == "Team - Dataset saved estimate"
    assert saved["request"]["dataset"]["team_name"] == "Team"
    assert saved["estimate"]["monthly_storage_cost"] > 0

    list_response = client.get("/estimates")
    assert list_response.status_code == 200
    summaries = list_response.json()["estimates"]
    assert summaries[0]["id"] == saved["id"]
    assert "request" not in summaries[0]

    load_response = client.get(f"/estimates/{saved['id']}")
    assert load_response.status_code == 200
    loaded = load_response.json()
    assert loaded["request"]["dataset"]["brand_or_dataset_name"] == "Dataset"
    assert loaded["estimate"]["scenario_title"] == "Archive-only"

    delete_response = client.delete(f"/estimates/{saved['id']}")
    assert delete_response.status_code == 200
    assert delete_response.json() == {"status": "deleted", "id": saved["id"]}

    deleted_load_response = client.get(f"/estimates/{saved['id']}")
    assert deleted_load_response.status_code == 404

    deleted_list_response = client.get("/estimates")
    assert deleted_list_response.status_code == 200
    assert all(item["id"] != saved["id"] for item in deleted_list_response.json()["estimates"])


def _estimate_payload() -> dict:
    return {
        "scenario_key": "archive_only",
        "dataset": {
            "team_name": "Team",
            "brand_or_dataset_name": "Dataset",
            "cloud_provider": "aws",
            "region": "eu-west-1",
            "total_data_size_gb": 31.13,
            "file_count": 7497,
            "zip_archive_file_count": 4771,
            "structured_file_count": 12,
            "document_file_count": 2714,
            "annual_growth_percentage": 10,
            "number_of_environments": 1,
            "replication_factor": 1,
        },
        "storage": {"storage_class": "s3_intelligent_tiering"},
        "sql_compute": {
            "warehouse_type": "serverless",
            "warehouse_size": "xs",
            "queries_per_month": 0,
            "average_query_runtime_minutes": 0,
            "concurrent_users": 0,
            "auto_stop_minutes": 0,
            "usage_pattern": "rare",
        },
        "job_compute": {
            "ingestion_frequency": "monthly",
            "job_runs_per_month": 0,
            "average_job_runtime_minutes": 0,
            "job_cluster_size": "small",
            "number_of_jobs": 0,
        },
        "ai_bi": {"enabled": False},
    }


def _full_workload_estimate_payload() -> dict:
    payload = _estimate_payload()
    payload["scenario_key"] = "scheduled_reporting"
    payload["dataset"] = {
        **payload["dataset"],
        "team_name": "Example Data Team",
        "brand_or_dataset_name": "Legacy collaboration archive",
        "number_of_environments": 3,
        "redundancy_model": "backup_copy",
        "replication_factor": 2,
    }
    payload["storage"] = {
        "storage_class": "s3_standard",
        "monthly_read_requests": 1500,
        "monthly_write_requests": 1500,
    }
    payload["sql_compute"] = {
        **payload["sql_compute"],
        "queries_per_month": 150,
        "average_query_runtime_minutes": 3,
        "concurrent_users": 2,
        "auto_stop_minutes": 5,
        "usage_pattern": "occasional",
    }
    payload["job_compute"] = {
        "enabled": True,
        "ingestion_frequency": "one-time",
        "batch_type": "one_time_archive_load",
        "data_volume_per_run_gb": 31.13,
        "compute_type": "classic_jobs",
        "dlt_tier": "core",
        "use_instance_sizing": False,
        "worker_instance_type": "m5.xlarge",
        "worker_count": 2,
        "driver_instance_type": "m5.xlarge",
        "driver_count": 1,
        "photon_enabled": False,
        "include_ec2_cost": False,
        "job_runs_per_month": 1,
        "average_job_runtime_minutes": 20,
        "job_cluster_size": "small",
        "dbu_rate": 0.26,
        "number_of_jobs": 1,
        "compaction_runs_per_month": 1,
        "average_compaction_runtime_minutes": 15,
    }
    payload["streaming_ingestion"] = {
        "enabled": True,
        "source_type": "kafka",
        "ingestion_product": "structured_streaming",
        "source_location": "same_az",
        "trigger_interval": "continuous",
        "daily_data_gb": 3,
        "monthly_data_gb": 90,
        "runtime_pattern": "always_on",
        "hours_per_day": 24,
        "days_per_month": 30,
        "monthly_runtime_hours": 730,
        "number_of_streams": 1,
        "dlt_tier": "core",
        "use_instance_sizing": True,
        "worker_instance_type": "m5.xlarge",
        "worker_count": 2,
        "driver_instance_type": "m5.xlarge",
        "driver_count": 1,
        "dbu_per_hour": 4.5,
        "dbu_rate": 0.26,
        "include_ec2_cost": True,
        "ec2_hourly_cost": 0,
        "source_transfer_gb_per_month": 90,
        "source_transfer_price_per_gb_override": None,
        "free_tier_already_consumed": True,
        "photon_enabled": False,
    }
    payload["cross_region_transfer"] = {
        "enabled": True,
        "destination_region": "eu-west-2",
        "include_dr_storage_copy": True,
        "initial_replication_gb": 31.13,
        "monthly_changed_data_gb": 3.11,
        "monthly_cross_region_read_gb": 0,
        "amortize_initial_months": 12,
        "transfer_price_per_gb_override": 0.02,
    }
    payload["support_cost"] = {
        "support_cost_percentage": 3,
        "databricks_discount_percentage": 0,
        "cloud_discount_percentage": 0,
    }
    payload["buffer_percentage"] = 15
    return payload
