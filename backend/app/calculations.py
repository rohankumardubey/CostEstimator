from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from .models import (
    AIBIInput,
    CostComponent,
    CrossRegionTransferInput,
    DatasetInput,
    EstimateRequest,
    EstimateResponse,
    EstimateWarning,
    JobComputeInput,
    SQLComputeInput,
    ScenarioComparisonResponse,
    StreamingIngestionInput,
    StreamingIngestionProduct,
    StorageInput,
    SupportCostInput,
)
from .pricing import (
    get_ai_bi_dbu_rate,
    get_cloud_storage_config,
    get_cross_region_transfer_config,
    get_dlt_dbu_rate,
    get_job_dbu_per_hour,
    get_job_dbu_rate,
    get_lakeflow_connect_dbu_rate,
    get_lakeflow_connect_free_dbu_per_day,
    get_sql_dbu_per_hour,
    get_sql_dbu_rate,
    get_zerobus_price_per_gb,
)


def _round_money(value: float) -> float:
    return round(value + 1e-12, 2)


def _effective_gb_with_growth(dataset: DatasetInput) -> float:
    return dataset.total_data_size_gb * (1 + (dataset.annual_growth_percentage / 100 / 2))


def calculate_storage_cost(
    dataset: DatasetInput,
    storage: StorageInput,
    pricing: dict[str, Any],
    minimum_replication_factor: float | None = None,
) -> CostComponent:
    storage_config = get_cloud_storage_config(
        pricing,
        dataset.cloud_provider.value,
        dataset.region,
        storage.storage_class,
    )
    effective_gb = _effective_gb_with_growth(dataset)
    environment_multiplier = dataset.number_of_environments
    configured_replication_factor = dataset.replication_factor
    replication_factor = max(configured_replication_factor, minimum_replication_factor or 0)

    gb_month_cost = (
        effective_gb
        * float(storage_config.get("price_per_gb_month", 0))
        * replication_factor
        * environment_multiplier
    )
    monitoring_cost = (
        float(storage_config.get("monitoring_per_1000_objects", 0))
        * dataset.file_count
        / 1000
        * replication_factor
        * environment_multiplier
    )
    read_request_cost = (
        float(storage_config.get("read_request_per_1000", 0))
        * storage.monthly_read_requests
        / 1000
        * environment_multiplier
    )
    write_request_cost = (
        float(storage_config.get("write_request_per_1000", 0))
        * storage.monthly_write_requests
        / 1000
        * environment_multiplier
    )
    monthly_cost = gb_month_cost + monitoring_cost + read_request_cost + write_request_cost

    return CostComponent(
        label="Storage",
        monthly_cost=_round_money(monthly_cost),
        assumptions={
            "storage_class": storage.storage_class,
            "storage_display_name": storage_config.get("display_name", storage.storage_class),
            "price_per_gb_month": storage_config.get("price_per_gb_month", 0),
            "effective_gb_with_growth": round(effective_gb, 4),
            "annual_growth_percentage": dataset.annual_growth_percentage,
            "redundancy_model": dataset.redundancy_model.value,
            "configured_replication_factor": configured_replication_factor,
            "minimum_replication_factor": minimum_replication_factor or 0,
            "replication_factor": replication_factor,
            "environment_multiplier": environment_multiplier,
            "monitoring_per_1000_objects": storage_config.get("monitoring_per_1000_objects", 0),
            "read_request_per_1000": storage_config.get("read_request_per_1000", 0),
            "write_request_per_1000": storage_config.get("write_request_per_1000", 0),
            "monthly_read_requests": storage.monthly_read_requests,
            "monthly_write_requests": storage.monthly_write_requests,
            "pricing_source": storage_config.get("pricing_source", "config_fallback"),
            "pricing_status": storage_config.get("pricing_status", "fallback"),
            "pricing_note": storage_config.get("pricing_note", ""),
        },
    )


def calculate_cross_region_transfer_cost(
    dataset: DatasetInput,
    transfer: CrossRegionTransferInput,
    pricing: dict[str, Any],
) -> CostComponent:
    destination_region = transfer.destination_region
    transfer_config = (
        get_cross_region_transfer_config(
            pricing,
            dataset.cloud_provider.value,
            dataset.region,
            destination_region,
        )
        if destination_region
        else {}
    )
    price_per_gb = float(
        transfer.transfer_price_per_gb_override
        if transfer.transfer_price_per_gb_override is not None
        else transfer_config.get("price_per_gb", 0)
    )
    monthly_transfer_gb = transfer.monthly_changed_data_gb + transfer.monthly_cross_region_read_gb
    recurring_monthly_cost = monthly_transfer_gb * price_per_gb if transfer.enabled else 0
    one_time_initial_replication_cost = transfer.initial_replication_gb * price_per_gb if transfer.enabled else 0
    amortized_initial_monthly_cost = (
        one_time_initial_replication_cost / transfer.amortize_initial_months
        if transfer.enabled and transfer.amortize_initial_months > 0
        else 0
    )
    monthly_cost = recurring_monthly_cost + amortized_initial_monthly_cost

    return CostComponent(
        label="Cross-region DR",
        monthly_cost=_round_money(monthly_cost),
        assumptions={
            "enabled": transfer.enabled,
            "source_region": dataset.region,
            "destination_region": destination_region,
            "include_dr_storage_copy": transfer.include_dr_storage_copy,
            "price_per_gb": price_per_gb,
            "price_source": "user_input"
            if transfer.transfer_price_per_gb_override is not None
            else transfer_config.get("pricing_source", "config_fallback"),
            "pricing_status": "manual"
            if transfer.transfer_price_per_gb_override is not None
            else transfer_config.get("pricing_status", "fallback"),
            "pricing_note": "User-entered transfer price override."
            if transfer.transfer_price_per_gb_override is not None
            else transfer_config.get("pricing_note", ""),
            "initial_replication_gb": transfer.initial_replication_gb if transfer.enabled else 0,
            "monthly_changed_data_gb": transfer.monthly_changed_data_gb if transfer.enabled else 0,
            "monthly_cross_region_read_gb": transfer.monthly_cross_region_read_gb if transfer.enabled else 0,
            "monthly_transfer_gb": monthly_transfer_gb if transfer.enabled else 0,
            "recurring_monthly_transfer_cost": _round_money(recurring_monthly_cost),
            "one_time_initial_replication_cost": _round_money(one_time_initial_replication_cost),
            "amortized_initial_monthly_cost": _round_money(amortized_initial_monthly_cost),
            "amortize_initial_months": transfer.amortize_initial_months,
        },
    )


def calculate_sql_compute_cost(
    sql_compute: SQLComputeInput,
    pricing: dict[str, Any],
) -> CostComponent:
    dbu_per_hour = get_sql_dbu_per_hour(
        pricing,
        sql_compute.warehouse_size,
        sql_compute.custom_dbu_per_hour,
    )
    dbu_rate = float(
        sql_compute.dbu_rate
        if sql_compute.dbu_rate is not None
        else get_sql_dbu_rate(pricing, sql_compute.warehouse_type.value)
    )
    query_hours = sql_compute.queries_per_month * sql_compute.average_query_runtime_minutes / 60
    divisor = float(pricing["databricks"].get("concurrency_user_divisor", 10))
    concurrency_multiplier = (
        max(1, sql_compute.concurrent_users / divisor)
        if sql_compute.apply_concurrency_multiplier
        else 1
    )
    monthly_cost = dbu_per_hour * dbu_rate * query_hours * concurrency_multiplier

    return CostComponent(
        label="Databricks SQL compute",
        monthly_cost=_round_money(monthly_cost),
        assumptions={
            "warehouse_type": sql_compute.warehouse_type.value,
            "warehouse_size": sql_compute.warehouse_size,
            "dbu_per_hour": dbu_per_hour,
            "dbu_rate": dbu_rate,
            "dbu_rate_source": "user_input" if sql_compute.dbu_rate is not None else "configured_sql_workload_rate",
            "queries_per_month": sql_compute.queries_per_month,
            "average_query_runtime_minutes": sql_compute.average_query_runtime_minutes,
            "monthly_query_hours": round(query_hours, 4),
            "concurrent_users": sql_compute.concurrent_users,
            "auto_stop_minutes": sql_compute.auto_stop_minutes,
            "usage_pattern": sql_compute.usage_pattern.value,
            "apply_concurrency_multiplier": sql_compute.apply_concurrency_multiplier,
            "concurrency_multiplier": round(concurrency_multiplier, 4),
        },
    )


def calculate_job_compute_cost(
    job_compute: JobComputeInput,
    pricing: dict[str, Any],
) -> CostComponent:
    dbu_per_hour = get_job_dbu_per_hour(
        pricing,
        job_compute.job_cluster_size,
        job_compute.custom_dbu_per_hour,
    )
    dbu_rate = float(
        job_compute.dbu_rate
        if job_compute.dbu_rate is not None
        else _get_batch_dbu_rate(job_compute, pricing)
    )
    job_hours = (
        job_compute.job_runs_per_month
        * job_compute.average_job_runtime_minutes
        / 60
        * job_compute.number_of_jobs
    )
    compute_cost = dbu_per_hour * dbu_rate * job_hours if job_compute.enabled else 0
    is_one_time = job_compute.ingestion_frequency.value == "one-time"
    monthly_cost = 0 if is_one_time else compute_cost
    one_time_cost = compute_cost if is_one_time else 0

    return CostComponent(
        label="Batch ingestion compute",
        monthly_cost=_round_money(monthly_cost),
        assumptions={
            "enabled": job_compute.enabled,
            "ingestion_frequency": job_compute.ingestion_frequency.value,
            "batch_type": job_compute.batch_type,
            "data_volume_per_run_gb": job_compute.data_volume_per_run_gb,
            "compute_type": job_compute.compute_type.value,
            "job_runs_per_month": job_compute.job_runs_per_month,
            "average_job_runtime_minutes": job_compute.average_job_runtime_minutes,
            "number_of_jobs": job_compute.number_of_jobs,
            "job_cluster_size": job_compute.job_cluster_size,
            "dbu_per_hour": dbu_per_hour,
            "dbu_rate": dbu_rate,
            "dbu_rate_source": "user_input" if job_compute.dbu_rate is not None else f"configured_{job_compute.compute_type.value}_rate",
            "monthly_job_hours": round(job_hours, 4),
            "one_time_batch_cost": _round_money(one_time_cost),
            "recurring_monthly_batch_cost": _round_money(monthly_cost),
            "note": "One-time batch loads are shown separately and are not annualized as recurring monthly cost."
            if is_one_time
            else "Scheduled batch jobs are treated as recurring monthly Databricks compute.",
        },
    )


def _get_batch_dbu_rate(job_compute: JobComputeInput, pricing: dict[str, Any]) -> float:
    if job_compute.compute_type.value == "serverless_jobs":
        return get_job_dbu_rate(pricing, "serverless")
    if job_compute.compute_type.value == "dlt_triggered":
        return get_dlt_dbu_rate(pricing, "core")
    return get_job_dbu_rate(pricing, "classic")


def calculate_streaming_ingestion_cost(
    streaming: StreamingIngestionInput,
    pricing: dict[str, Any],
) -> CostComponent:
    monthly_data_gb = (
        streaming.monthly_data_gb
        if streaming.monthly_data_gb is not None
        else streaming.daily_data_gb * streaming.days_per_month
    )
    monthly_stream_hours = (
        streaming.hours_per_day
        * streaming.days_per_month
        * streaming.number_of_streams
        if streaming.enabled
        else 0
    )
    product = streaming.ingestion_product
    dbu_rate = float(
        streaming.dbu_rate
        if streaming.dbu_rate is not None
        else _get_streaming_dbu_rate(streaming, pricing)
    )
    billable_dbus = streaming.dbu_per_hour * monthly_stream_hours
    free_dbus = 0.0
    ec2_cost = 0.0
    unit_price_per_gb = 0.0

    if product == StreamingIngestionProduct.zerobus_ingest:
        unit_price_per_gb = get_zerobus_price_per_gb(pricing)
        monthly_cost = monthly_data_gb * unit_price_per_gb if streaming.enabled else 0
        billable_dbus = 0
    else:
        if product == StreamingIngestionProduct.lakeflow_connect and not streaming.free_tier_already_consumed:
            free_dbus = get_lakeflow_connect_free_dbu_per_day(pricing) * streaming.days_per_month
        chargeable_dbus = max(0, billable_dbus - free_dbus)
        dbu_cost = chargeable_dbus * dbu_rate
        ec2_cost = (
            streaming.ec2_hourly_cost * monthly_stream_hours
            if streaming.enabled and streaming.include_ec2_cost
            else 0
        )
        monthly_cost = dbu_cost + ec2_cost if streaming.enabled else 0

    return CostComponent(
        label="Streaming ingestion compute",
        monthly_cost=_round_money(monthly_cost),
        assumptions={
            "enabled": streaming.enabled,
            "source_type": streaming.source_type.value,
            "ingestion_product": product.value,
            "daily_data_gb": streaming.daily_data_gb,
            "monthly_data_gb": round(monthly_data_gb, 4) if streaming.enabled else 0,
            "runtime_pattern": streaming.runtime_pattern.value,
            "hours_per_day": streaming.hours_per_day if streaming.enabled else 0,
            "days_per_month": streaming.days_per_month if streaming.enabled else 0,
            "number_of_streams": streaming.number_of_streams if streaming.enabled else 0,
            "monthly_streaming_hours": round(monthly_stream_hours, 4),
            "dbu_per_hour": streaming.dbu_per_hour,
            "dbu_rate": dbu_rate,
            "dbu_rate_source": "user_input" if streaming.dbu_rate is not None else f"configured_{product.value}_rate",
            "billable_dbus_before_free_tier": round(billable_dbus, 4),
            "free_dbus_applied": round(free_dbus, 4),
            "include_ec2_cost": streaming.include_ec2_cost,
            "ec2_hourly_cost": streaming.ec2_hourly_cost,
            "monthly_ec2_cost": _round_money(ec2_cost),
            "unit_price_per_gb": unit_price_per_gb,
            "photon_enabled": streaming.photon_enabled,
            "note": _streaming_note(product),
        },
    )


def _get_streaming_dbu_rate(streaming: StreamingIngestionInput, pricing: dict[str, Any]) -> float:
    product = streaming.ingestion_product
    if product == StreamingIngestionProduct.dlt_continuous:
        return get_dlt_dbu_rate(pricing, "core")
    if product == StreamingIngestionProduct.lakeflow_connect:
        return get_lakeflow_connect_dbu_rate(pricing)
    if product == StreamingIngestionProduct.zerobus_ingest:
        return 0
    return get_job_dbu_rate(pricing, "classic")


def _streaming_note(product: StreamingIngestionProduct) -> str:
    if product == StreamingIngestionProduct.zerobus_ingest:
        return "Zerobus is priced per GB ingested and is suitable for push/API ingestion, not Kafka or Pulsar pull-based streams."
    if product == StreamingIngestionProduct.lakeflow_connect:
        return "Lakeflow Connect is intended for managed SaaS/JDBC/CDC connectors and can consume a workspace-level free DBU tier."
    if product == StreamingIngestionProduct.dlt_continuous:
        return "DLT continuous pipelines are modelled as always-on streaming DBU usage."
    return "Spark Structured Streaming is modelled as long-running Jobs Compute; include EC2 cost when classic cluster infrastructure should be visible."


def calculate_ai_bi_cost(ai_bi: AIBIInput, pricing: dict[str, Any]) -> CostComponent:
    dbu_rate = float(
        ai_bi.dbu_rate
        if ai_bi.dbu_rate is not None
        else get_ai_bi_dbu_rate(pricing)
    )
    question_count = ai_bi.expected_users * ai_bi.questions_per_user_per_month
    question_hours = question_count * ai_bi.average_runtime_minutes_per_question / 60
    monthly_cost = ai_bi.dbu_per_hour * dbu_rate * question_hours if ai_bi.enabled else 0

    return CostComponent(
        label="AI/BI optional layer",
        monthly_cost=_round_money(monthly_cost),
        assumptions={
            "enabled": ai_bi.enabled,
            "expected_users": ai_bi.expected_users,
            "questions_per_user_per_month": ai_bi.questions_per_user_per_month,
            "average_runtime_minutes_per_question": ai_bi.average_runtime_minutes_per_question,
            "monthly_question_count": question_count if ai_bi.enabled else 0,
            "monthly_question_hours": round(question_hours, 4) if ai_bi.enabled else 0,
            "dbu_per_hour": ai_bi.dbu_per_hour,
            "dbu_rate": dbu_rate,
            "dbu_rate_source": "user_input" if ai_bi.dbu_rate is not None else "configured_ai_bi_rate",
        },
    )


def calculate_discount_adjustment(
    support_cost: SupportCostInput,
    cloud_monthly_subtotal: float,
    databricks_monthly_subtotal: float,
) -> CostComponent:
    cloud_discount = cloud_monthly_subtotal * support_cost.cloud_discount_percentage / 100
    databricks_discount = (
        databricks_monthly_subtotal
        * support_cost.databricks_discount_percentage
        / 100
    )
    total_discount = cloud_discount + databricks_discount

    return CostComponent(
        label="Discount adjustment",
        monthly_cost=-_round_money(total_discount),
        assumptions={
            "cloud_discount_percentage": support_cost.cloud_discount_percentage,
            "databricks_discount_percentage": support_cost.databricks_discount_percentage,
            "cloud_monthly_subtotal": _round_money(cloud_monthly_subtotal),
            "databricks_monthly_subtotal": _round_money(databricks_monthly_subtotal),
            "cloud_discount_amount": _round_money(cloud_discount),
            "databricks_discount_amount": _round_money(databricks_discount),
            "discounts_included": total_discount > 0,
            "note": "Discounts default to 0% and are not included unless entered.",
        },
    )


def calculate_support_cost(support_cost: SupportCostInput, monthly_subtotal: float) -> CostComponent:
    percentage = support_cost.support_cost_percentage
    monthly_cost = monthly_subtotal * percentage / 100

    return CostComponent(
        label="Support cost uplift",
        monthly_cost=_round_money(monthly_cost),
        assumptions={
            "support_cost_percentage": percentage,
            "calculation_method": "percentage",
            "monthly_subtotal_after_discounts_before_support": _round_money(monthly_subtotal),
            "note": "Support defaults to 0% and is applied after discounts but before buffer.",
        },
    )


def calculate_total_estimate(
    request: EstimateRequest,
    pricing: dict[str, Any],
) -> EstimateResponse:
    minimum_replication_factor = (
        2
        if request.cross_region_transfer.enabled
        and request.cross_region_transfer.include_dr_storage_copy
        else None
    )
    storage = calculate_storage_cost(
        request.dataset,
        request.storage,
        pricing,
        minimum_replication_factor=minimum_replication_factor,
    )
    sql = calculate_sql_compute_cost(request.sql_compute, pricing)
    jobs = calculate_job_compute_cost(request.job_compute, pricing)
    streaming = calculate_streaming_ingestion_cost(request.streaming_ingestion, pricing)
    ai_bi = calculate_ai_bi_cost(request.ai_bi, pricing)
    cross_region_dr = calculate_cross_region_transfer_cost(
        request.dataset,
        request.cross_region_transfer,
        pricing,
    )
    subtotal_components = [storage, sql, jobs, streaming, ai_bi, cross_region_dr]
    cloud_monthly_subtotal = storage.monthly_cost + cross_region_dr.monthly_cost
    databricks_monthly_subtotal = sql.monthly_cost + jobs.monthly_cost + streaming.monthly_cost + ai_bi.monthly_cost
    discount = calculate_discount_adjustment(
        request.support_cost,
        cloud_monthly_subtotal,
        databricks_monthly_subtotal,
    )
    monthly_subtotal_after_discounts = sum(component.monthly_cost for component in subtotal_components) + discount.monthly_cost
    support = calculate_support_cost(
        request.support_cost,
        monthly_subtotal_after_discounts,
    )

    components = [*subtotal_components, discount, support]
    total_monthly = sum(component.monthly_cost for component in components)
    buffer_percentage = float(
        request.buffer_percentage
        if request.buffer_percentage is not None
        else pricing.get("default_buffer_percentage", 0)
    )
    estimate_with_buffer_monthly = total_monthly * (1 + buffer_percentage / 100)
    total_annual = total_monthly * 12
    scenario = pricing.get("scenario_defaults", {}).get(request.scenario_key, {})
    file_unit = request.dataset.file_count / 1000 if request.dataset.file_count > 0 else 0

    assumptions = {
        "cloud_provider": request.dataset.cloud_provider.value,
        "region": request.dataset.region,
        "buffer_percentage": buffer_percentage,
        "currency": pricing.get("currency", "USD"),
        "environment_multiplier": request.dataset.number_of_environments,
        "redundancy_model": request.dataset.redundancy_model.value,
        "configured_replication_factor": request.dataset.replication_factor,
        "replication_factor": storage.assumptions["replication_factor"],
        "cross_region_dr_enabled": request.cross_region_transfer.enabled,
        "batch_ingestion_enabled": request.job_compute.enabled,
        "streaming_ingestion_enabled": request.streaming_ingestion.enabled,
        "support_cost_percentage": request.support_cost.support_cost_percentage,
        "databricks_discount_percentage": request.support_cost.databricks_discount_percentage,
        "cloud_discount_percentage": request.support_cost.cloud_discount_percentage,
        "dataset_size_gb": request.dataset.total_data_size_gb,
        "file_count": request.dataset.file_count,
        "scenario_description": scenario.get("description", ""),
    }
    warnings = build_estimate_warnings(request)
    confidence_score, confidence_level = calculate_confidence(warnings)

    return EstimateResponse(
        currency=pricing.get("currency", "USD"),
        scenario_key=request.scenario_key,
        scenario_title=scenario.get("title", request.scenario_key),
        components=components,
        monthly_storage_cost=storage.monthly_cost,
        monthly_sql_compute_cost=sql.monthly_cost,
        monthly_job_compute_cost=jobs.monthly_cost,
        monthly_streaming_compute_cost=streaming.monthly_cost,
        one_time_batch_compute_cost=float(jobs.assumptions.get("one_time_batch_cost", 0)),
        monthly_ai_bi_cost=ai_bi.monthly_cost,
        monthly_cross_region_transfer_cost=cross_region_dr.monthly_cost,
        one_time_cross_region_transfer_cost=float(
            cross_region_dr.assumptions.get("one_time_initial_replication_cost", 0)
        ),
        monthly_discount_amount=abs(discount.monthly_cost),
        monthly_support_cost=support.monthly_cost,
        total_monthly_estimate=_round_money(total_monthly),
        total_annual_estimate=_round_money(total_annual),
        estimate_with_buffer_monthly=_round_money(estimate_with_buffer_monthly),
        estimate_with_buffer_annual=_round_money(estimate_with_buffer_monthly * 12),
        buffer_percentage=buffer_percentage,
        cost_per_gb_monthly=_round_money(total_monthly / request.dataset.total_data_size_gb)
        if request.dataset.total_data_size_gb > 0
        else 0,
        cost_per_1000_files_monthly=_round_money(total_monthly / file_unit) if file_unit > 0 else 0,
        assumptions=assumptions,
        confidence_score=confidence_score,
        confidence_level=confidence_level,
        warnings=warnings,
        disclaimer=pricing.get("disclaimer", ""),
        generated_at=datetime.now(UTC).isoformat(),
    )


def build_scenario_estimate(request: EstimateRequest, pricing: dict[str, Any]) -> EstimateResponse:
    return calculate_total_estimate(request, pricing)


def build_scenario_comparison(
    request: EstimateRequest,
    pricing: dict[str, Any],
) -> ScenarioComparisonResponse:
    estimates: list[EstimateResponse] = []
    for scenario_key, scenario in pricing.get("scenario_defaults", {}).items():
        scenario_request = _apply_scenario_defaults(request, scenario_key, scenario)
        estimates.append(calculate_total_estimate(scenario_request, pricing))
    return ScenarioComparisonResponse(estimates=estimates)


def _apply_scenario_defaults(
    request: EstimateRequest,
    scenario_key: str,
    scenario: dict[str, Any],
) -> EstimateRequest:
    cloud_provider = request.dataset.cloud_provider.value
    storage_class = scenario.get("storage_class_by_cloud", {}).get(
        cloud_provider,
        request.storage.storage_class,
    )
    sql_defaults = scenario.get("sql", {})
    job_defaults = scenario.get("jobs", {})
    streaming_defaults = scenario.get("streaming_ingestion", {})
    ai_bi_defaults = scenario.get("ai_bi", {})

    return request.model_copy(
        update={
            "scenario_key": scenario_key,
            "storage": StorageInput.model_validate(
                {**request.storage.model_dump(), "storage_class": storage_class}
            ),
            "sql_compute": SQLComputeInput.model_validate(
                {**request.sql_compute.model_dump(), **sql_defaults}
            ),
            "job_compute": JobComputeInput.model_validate(
                {**request.job_compute.model_dump(), **job_defaults}
            ),
            "streaming_ingestion": StreamingIngestionInput.model_validate(
                {**request.streaming_ingestion.model_dump(), **streaming_defaults}
            ),
            "ai_bi": AIBIInput.model_validate(
                {**request.ai_bi.model_dump(), **ai_bi_defaults}
            ),
        }
    )


def build_estimate_warnings(request: EstimateRequest) -> list[EstimateWarning]:
    warnings: list[EstimateWarning] = []
    dataset = request.dataset
    sql_compute = request.sql_compute
    job_compute = request.job_compute
    streaming = request.streaming_ingestion
    ai_bi = request.ai_bi
    cross_region_transfer = request.cross_region_transfer

    if dataset.total_data_size_gb <= 0:
        warnings.append(
            EstimateWarning(
                severity="high",
                field="total_data_size_gb",
                message="Dataset size is zero, so storage and cost-per-GB outputs will be incomplete.",
            )
        )
    if dataset.file_count <= 0:
        warnings.append(
            EstimateWarning(
                severity="medium",
                field="file_count",
                message="File count is zero, so object-related and cost-per-file outputs will be incomplete.",
            )
        )
    if dataset.total_data_size_gb > 0 and dataset.file_count > 0:
        average_mb = dataset.total_data_size_gb * 1024 / dataset.file_count
        if average_mb < 0.05:
            warnings.append(
                EstimateWarning(
                    severity="medium",
                    field="file_count",
                    message="Average file size is very small. Request and object-count costs may matter more than this estimate suggests.",
                )
            )
        elif average_mb > 1024:
            warnings.append(
                EstimateWarning(
                    severity="medium",
                    field="total_data_size_gb",
                    message="Average file size is very large. Validate size and file-count inputs before using the estimate.",
                )
            )
    if dataset.number_of_environments == 1:
        warnings.append(
            EstimateWarning(
                severity="low",
                field="number_of_environments",
                message="Only one environment is included. Add dev/test/prod copies if they will exist.",
            )
        )
    if dataset.replication_factor == 1:
        warnings.append(
            EstimateWarning(
                severity="low",
                field="replication_factor",
                message="Single-copy storage is selected. Confirm backup, redundancy, and DR expectations with platform owners.",
            )
        )
    if cross_region_transfer.enabled:
        if not cross_region_transfer.destination_region:
            warnings.append(
                EstimateWarning(
                    severity="medium",
                    field="destination_region",
                    message="Cross-region DR is enabled but no destination region is selected.",
                )
            )
        if cross_region_transfer.destination_region == dataset.region:
            warnings.append(
                EstimateWarning(
                    severity="medium",
                    field="destination_region",
                    message="Cross-region DR destination matches the source region.",
                )
            )
        if (
            cross_region_transfer.monthly_changed_data_gb == 0
            and cross_region_transfer.monthly_cross_region_read_gb == 0
            and cross_region_transfer.initial_replication_gb == 0
        ):
            warnings.append(
                EstimateWarning(
                    severity="low",
                    field="cross_region_transfer",
                    message="Cross-region DR is enabled but replication and transfer volumes are zero.",
                )
            )
    if dataset.redundancy_model == "custom" and dataset.replication_factor <= 1:
        warnings.append(
            EstimateWarning(
                severity="medium",
                field="redundancy_model",
                message="Custom redundancy is selected but the storage copy multiplier is not above 1.",
            )
        )
    if dataset.annual_growth_percentage == 0:
        warnings.append(
            EstimateWarning(
                severity="low",
                field="annual_growth_percentage",
                message="Annual growth is zero. Add expected growth if the dataset will expand.",
            )
        )
    if request.buffer_percentage is not None and request.buffer_percentage < 10:
        warnings.append(
            EstimateWarning(
                severity="medium",
                field="buffer_percentage",
                message="Buffer is below 10%. Consider a higher contingency for early-stage estimates.",
            )
        )
    if sql_compute.queries_per_month > 1000 and sql_compute.warehouse_size in {"xs", "small"}:
        warnings.append(
            EstimateWarning(
                severity="medium",
                field="warehouse_size",
                message="High query volume is paired with a small SQL warehouse. Validate runtime and concurrency assumptions.",
            )
        )
    if sql_compute.concurrent_users >= 20 and not sql_compute.apply_concurrency_multiplier:
        warnings.append(
            EstimateWarning(
                severity="medium",
                field="apply_concurrency_multiplier",
                message="Many concurrent users are configured but the concurrency multiplier is disabled.",
            )
        )
    if job_compute.enabled and job_compute.number_of_jobs > 0 and job_compute.average_job_runtime_minutes == 0:
        warnings.append(
            EstimateWarning(
                severity="medium",
                field="average_job_runtime_minutes",
                message="Batch ingestion is enabled but job runtime is zero.",
            )
        )
    if (
        job_compute.enabled
        and job_compute.ingestion_frequency.value == "one-time"
        and job_compute.data_volume_per_run_gb == 0
    ):
        warnings.append(
            EstimateWarning(
                severity="low",
                field="data_volume_per_run_gb",
                message="One-time batch load is enabled but data volume per run is zero.",
            )
        )
    if streaming.enabled:
        if streaming.number_of_streams == 0:
            warnings.append(
                EstimateWarning(
                    severity="high",
                    field="number_of_streams",
                    message="Streaming is enabled but number of streams is zero.",
                )
            )
        if streaming.daily_data_gb == 0 and (streaming.monthly_data_gb is None or streaming.monthly_data_gb == 0):
            warnings.append(
                EstimateWarning(
                    severity="medium",
                    field="daily_data_gb",
                    message="Streaming is enabled but daily/monthly ingested data volume is zero.",
                )
            )
        if streaming.hours_per_day == 0 or streaming.days_per_month == 0:
            warnings.append(
                EstimateWarning(
                    severity="high",
                    field="streaming_runtime",
                    message="Streaming is enabled but runtime hours or active days are zero.",
                )
            )
        if streaming.ingestion_product.value == "zerobus_ingest" and streaming.source_type.value in {"kafka", "pulsar"}:
            warnings.append(
                EstimateWarning(
                    severity="medium",
                    field="ingestion_product",
                    message="Kafka/Pulsar streams usually need Spark Structured Streaming or DLT; Zerobus is for push/API ingestion.",
                )
            )
        if streaming.ingestion_product.value == "structured_streaming" and not streaming.include_ec2_cost:
            warnings.append(
                EstimateWarning(
                    severity="low",
                    field="include_ec2_cost",
                    message="Structured Streaming is selected without EC2 infrastructure cost. Add EC2 hourly cost if classic cluster charges should be visible.",
                )
            )
    if ai_bi.enabled and (
        ai_bi.expected_users == 0
        or ai_bi.questions_per_user_per_month == 0
        or ai_bi.average_runtime_minutes_per_question == 0
        or ai_bi.dbu_per_hour == 0
    ):
        warnings.append(
            EstimateWarning(
                severity="high",
                field="ai_bi",
                message="AI/BI is enabled but one or more AI/BI workload inputs are zero.",
            )
        )
    return warnings


def calculate_confidence(warnings: list[EstimateWarning]) -> tuple[int, str]:
    score = 100
    for warning in warnings:
        if warning.severity == "high":
            score -= 25
        elif warning.severity == "medium":
            score -= 12
        else:
            score -= 5
    score = max(0, min(100, score))
    if score >= 80:
        return score, "High"
    if score >= 55:
        return score, "Medium"
    return score, "Low"
