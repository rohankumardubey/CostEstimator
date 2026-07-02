from __future__ import annotations

from app.calculations import (
    build_scenario_comparison,
    build_estimate_warnings,
    calculate_confidence,
    calculate_ai_bi_cost,
    calculate_cross_region_transfer_cost,
    calculate_discount_adjustment,
    calculate_job_compute_cost,
    calculate_sql_compute_cost,
    calculate_storage_cost,
    calculate_support_cost,
    calculate_total_estimate,
)
from app.models import (
    AIBIInput,
    CrossRegionTransferInput,
    DatasetInput,
    EstimateRequest,
    JobComputeInput,
    SQLComputeInput,
    StorageInput,
    SupportCostInput,
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
        redundancy_model="backup_copy",
        replication_factor=3,
    )
    storage = StorageInput(storage_class="s3_intelligent_tiering")

    component = calculate_storage_cost(dataset, storage, pricing())

    assert component.monthly_cost == 15.21
    assert component.assumptions["effective_gb_with_growth"] == 110
    assert component.assumptions["redundancy_model"] == "backup_copy"


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


def test_cross_region_transfer_formula_with_one_time_and_amortization() -> None:
    dataset = DatasetInput(cloud_provider="aws", region="eu-west-1", total_data_size_gb=300)
    transfer = CrossRegionTransferInput(
        enabled=True,
        destination_region="eu-west-2",
        initial_replication_gb=300,
        monthly_changed_data_gb=30,
        monthly_cross_region_read_gb=20,
        amortize_initial_months=12,
    )

    component = calculate_cross_region_transfer_cost(dataset, transfer, pricing())

    assert component.assumptions["price_per_gb"] == 0.02
    assert component.assumptions["one_time_initial_replication_cost"] == 6
    assert component.assumptions["recurring_monthly_transfer_cost"] == 1
    assert component.assumptions["amortized_initial_monthly_cost"] == 0.5
    assert component.monthly_cost == 1.5


def test_support_cost_percentage_formula() -> None:
    component = calculate_support_cost(
        SupportCostInput(support_cost_percentage=12.5),
        monthly_subtotal=1000,
    )

    assert component.monthly_cost == 125
    assert component.assumptions["calculation_method"] == "percentage"
    assert component.assumptions["monthly_subtotal_after_discounts_before_support"] == 1000


def test_discount_adjustment_splits_cloud_and_databricks_discounts() -> None:
    component = calculate_discount_adjustment(
        SupportCostInput(
            cloud_discount_percentage=5,
            databricks_discount_percentage=10,
        ),
        cloud_monthly_subtotal=100,
        databricks_monthly_subtotal=200,
    )

    assert component.monthly_cost == -25
    assert component.assumptions["cloud_discount_amount"] == 5
    assert component.assumptions["databricks_discount_amount"] == 20
    assert component.assumptions["discounts_included"] is True


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


def test_total_estimate_includes_support_percentage_before_buffer() -> None:
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
        support_cost=SupportCostInput(support_cost_percentage=10),
        buffer_percentage=10,
    )

    estimate = calculate_total_estimate(request, pricing())

    assert estimate.monthly_support_cost == 0.35
    assert estimate.total_monthly_estimate == 3.87
    assert estimate.estimate_with_buffer_monthly == 4.26


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


def test_total_estimate_exposes_redundancy_assumptions() -> None:
    request = EstimateRequest(
        scenario_key="archive_only",
        dataset=DatasetInput(
            total_data_size_gb=100,
            file_count=1000,
            redundancy_model="backup_copy",
            replication_factor=2,
        ),
        storage=StorageInput(storage_class="s3_standard"),
        sql_compute=SQLComputeInput(),
        job_compute=JobComputeInput(average_job_runtime_minutes=0),
        ai_bi=AIBIInput(enabled=False),
    )

    estimate = calculate_total_estimate(request, pricing())

    assert estimate.assumptions["redundancy_model"] == "backup_copy"
    assert estimate.assumptions["replication_factor"] == 2


def test_cross_region_dr_storage_copy_sets_minimum_two_storage_copies() -> None:
    request = EstimateRequest(
        scenario_key="archive_only",
        dataset=DatasetInput(
            total_data_size_gb=100,
            file_count=1000,
            redundancy_model="single_copy",
            replication_factor=1,
        ),
        storage=StorageInput(storage_class="s3_standard"),
        sql_compute=SQLComputeInput(),
        job_compute=JobComputeInput(average_job_runtime_minutes=0),
        ai_bi=AIBIInput(enabled=False),
        cross_region_transfer=CrossRegionTransferInput(
            enabled=True,
            include_dr_storage_copy=True,
            destination_region="eu-west-2",
        ),
    )

    estimate = calculate_total_estimate(request, pricing())
    storage = next(component for component in estimate.components if component.label == "Storage")

    assert estimate.assumptions["configured_replication_factor"] == 1
    assert estimate.assumptions["replication_factor"] == 2
    assert storage.assumptions["replication_factor"] == 2
