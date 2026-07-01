from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_pricing_config_includes_pricing_source() -> None:
    response = client.get("/pricing-config")

    assert response.status_code == 200
    assert response.json()["pricing_source"]["mode"] in {"config", "live"}


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


def test_scenario_comparison_endpoint() -> None:
    response = client.post("/scenario-comparison", json=_estimate_payload())

    assert response.status_code == 200
    body = response.json()
    assert len(body["estimates"]) == 5
    assert body["estimates"][0]["scenario_key"] == "archive_only"


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
            "concurrent_users": 1,
            "auto_stop_minutes": 10,
            "usage_pattern": "rare",
        },
        "job_compute": {
            "ingestion_frequency": "monthly",
            "job_runs_per_month": 1,
            "average_job_runtime_minutes": 20,
            "job_cluster_size": "small",
            "number_of_jobs": 1,
        },
        "ai_bi": {"enabled": False},
    }
