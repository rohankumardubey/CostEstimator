from __future__ import annotations

from app.calculations import (
    build_scenario_comparison,
    build_estimate_warnings,
    calculate_confidence,
    calculate_ai_bi_cost,
    calculate_job_compute_cost,
    calculate_sql_compute_cost,
    calculate_storage_cost,
    calculate_total_estimate,
)
from app.models import (
    AIBIInput,
    DatasetInput,
    EstimateRequest,
    JobComputeInput,
    SQLComputeInput,
    StorageInput,
)
from app.pricing import load_pricing_config


def pricing() -> dict:
    return load_pricing_config()


def test_storage_cost_includes_growth_environment_replication_and_monitoring() -> None:
    dataset = DatasetInput(
        total_data_size_gb=100,
        file_count=2000,
        annual_growth_percentage=20,
        number_of_environments=2,
        replication_factor=3,
    )
    storage = StorageInput(storage_class="s3_intelligent_tiering")

    component = calculate_storage_cost(dataset, storage, pricing())

    assert component.monthly_cost == 15.21
    assert component.assumptions["effective_gb_with_growth"] == 110


def test_sql_compute_formula_without_concurrency_multiplier() -> None:
    sql = SQLComputeInput(
        warehouse_size="small",
        queries_per_month=120,
        average_query_runtime_minutes=5,
        concurrent_users=25,
        apply_concurrency_multiplier=False,
    )

    component = calculate_sql_compute_cost(sql, pricing())

    assert component.assumptions["monthly_query_hours"] == 10
    assert component.monthly_cost == 14


def test_sql_compute_allows_zero_concurrent_users_for_storage_only() -> None:
    sql = SQLComputeInput(
        warehouse_size="xs",
        queries_per_month=0,
        average_query_runtime_minutes=0,
        concurrent_users=0,
        auto_stop_minutes=0,
    )

    component = calculate_sql_compute_cost(sql, pricing())

    assert component.assumptions["concurrent_users"] == 0
    assert component.monthly_cost == 0


def test_sql_compute_formula_with_concurrency_multiplier() -> None:
    sql = SQLComputeInput(
        warehouse_size="small",
        queries_per_month=120,
        average_query_runtime_minutes=5,
        concurrent_users=25,
        apply_concurrency_multiplier=True,
    )

    component = calculate_sql_compute_cost(sql, pricing())

    assert component.assumptions["concurrency_multiplier"] == 2.5
    assert component.monthly_cost == 35


def test_job_compute_formula() -> None:
    job = JobComputeInput(
        job_cluster_size="medium",
        job_runs_per_month=30,
        average_job_runtime_minutes=20,
        number_of_jobs=2,
    )

    component = calculate_job_compute_cost(job, pricing())

    assert component.assumptions["monthly_job_hours"] == 20
    assert component.monthly_cost == 41.6


def test_ai_bi_disabled_excludes_cost() -> None:
    component = calculate_ai_bi_cost(
        AIBIInput(
            enabled=False,
            expected_users=20,
            questions_per_user_per_month=30,
            average_runtime_minutes_per_question=2,
            dbu_per_hour=16,
        ),
        pricing(),
    )

    assert component.monthly_cost == 0


def test_ai_bi_enabled_formula() -> None:
    component = calculate_ai_bi_cost(
        AIBIInput(
            enabled=True,
            expected_users=20,
            questions_per_user_per_month=30,
            average_runtime_minutes_per_question=2,
            dbu_per_hour=16,
        ),
        pricing(),
    )

    assert component.assumptions["monthly_question_hours"] == 20
    assert component.monthly_cost == 224


def test_total_estimate_applies_buffer() -> None:
    request = EstimateRequest(
        scenario_key="basic_query",
        dataset=DatasetInput(total_data_size_gb=100, file_count=1000),
        storage=StorageInput(storage_class="s3_standard"),
        sql_compute=SQLComputeInput(
            warehouse_size="xs",
            queries_per_month=60,
            average_query_runtime_minutes=1,
        ),
        job_compute=JobComputeInput(
            job_cluster_size="small",
            job_runs_per_month=1,
            average_job_runtime_minutes=30,
        ),
        buffer_percentage=10,
    )

    estimate = calculate_total_estimate(request, pricing())

    assert estimate.total_monthly_estimate == 3.52
    assert estimate.estimate_with_buffer_monthly == 3.87
    assert estimate.cost_per_gb_monthly == 0.04


def test_scenario_comparison_calculates_all_configured_scenarios() -> None:
    request = EstimateRequest(
        scenario_key="archive_only",
        dataset=DatasetInput(total_data_size_gb=100, file_count=1000),
        storage=StorageInput(storage_class="s3_standard"),
        sql_compute=SQLComputeInput(
            warehouse_size="xs",
            queries_per_month=0,
            average_query_runtime_minutes=0,
        ),
        job_compute=JobComputeInput(
            job_cluster_size="small",
            job_runs_per_month=1,
            average_job_runtime_minutes=30,
        ),
        ai_bi=AIBIInput(enabled=False),
    )

    comparison = build_scenario_comparison(request, pricing())

    keys = [estimate.scenario_key for estimate in comparison.estimates]
    assert keys == [
        "archive_only",
        "basic_query",
        "scheduled_reporting",
        "self_service_analytics",
        "future_ai_bi",
    ]
    future_ai_bi = next(estimate for estimate in comparison.estimates if estimate.scenario_key == "future_ai_bi")
    assert future_ai_bi.monthly_ai_bi_cost > 0


def test_warning_engine_flags_missing_dataset_metadata() -> None:
    request = EstimateRequest(
        scenario_key="archive_only",
        dataset=DatasetInput(total_data_size_gb=0, file_count=0, annual_growth_percentage=0),
        storage=StorageInput(storage_class="s3_standard"),
        sql_compute=SQLComputeInput(),
        job_compute=JobComputeInput(average_job_runtime_minutes=0),
        ai_bi=AIBIInput(enabled=False),
        buffer_percentage=5,
    )

    warnings = build_estimate_warnings(request)
    score, level = calculate_confidence(warnings)

    assert any(warning.field == "total_data_size_gb" for warning in warnings)
    assert any(warning.field == "buffer_percentage" for warning in warnings)
    assert score < 80
    assert level in {"Medium", "Low"}


def test_total_estimate_contains_confidence_metadata() -> None:
    request = EstimateRequest(
        scenario_key="archive_only",
        dataset=DatasetInput(total_data_size_gb=100, file_count=1000),
        storage=StorageInput(storage_class="s3_standard"),
        sql_compute=SQLComputeInput(),
        job_compute=JobComputeInput(average_job_runtime_minutes=30),
        ai_bi=AIBIInput(enabled=False),
    )

    estimate = calculate_total_estimate(request, pricing())

    assert 0 <= estimate.confidence_score <= 100
    assert estimate.confidence_level in {"High", "Medium", "Low"}
