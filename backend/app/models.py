from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, model_validator


class CloudProvider(str, Enum):
    aws = "aws"
    azure = "azure"
    gcp = "gcp"


class WarehouseType(str, Enum):
    serverless = "serverless"
    pro = "pro"
    classic = "classic"


class UsagePattern(str, Enum):
    rare = "rare"
    occasional = "occasional"
    frequent = "frequent"
    high = "high"


class IngestionFrequency(str, Enum):
    one_time = "one-time"
    daily = "daily"
    weekly = "weekly"
    monthly = "monthly"


class DatasetInput(BaseModel):
    team_name: str = Field(default="", max_length=120)
    brand_or_dataset_name: str = Field(default="", max_length=160)
    cloud_provider: CloudProvider = CloudProvider.aws
    region: str = Field(default="eu-west-1", min_length=1, max_length=80)
    total_data_size_gb: float = Field(default=0, ge=0)
    file_count: int = Field(default=0, ge=0)
    zip_archive_file_count: int = Field(default=0, ge=0)
    structured_file_count: int = Field(default=0, ge=0)
    document_file_count: int = Field(default=0, ge=0)
    annual_growth_percentage: float = Field(default=0, ge=0, le=1000)
    number_of_environments: int = Field(default=1, ge=1, le=20)
    replication_factor: float = Field(default=1, ge=1, le=20)
    mask_names_in_report: bool = False


class StorageInput(BaseModel):
    storage_class: str = Field(default="s3_standard", min_length=1)
    monthly_read_requests: int = Field(default=0, ge=0)
    monthly_write_requests: int = Field(default=0, ge=0)


class SQLComputeInput(BaseModel):
    warehouse_type: WarehouseType = WarehouseType.serverless
    warehouse_size: str = Field(default="xs", min_length=1)
    custom_dbu_per_hour: float | None = Field(default=None, ge=0)
    dbu_rate: float | None = Field(default=None, ge=0)
    queries_per_month: int = Field(default=0, ge=0)
    average_query_runtime_minutes: float = Field(default=0, ge=0)
    concurrent_users: int = Field(default=1, ge=1)
    auto_stop_minutes: int = Field(default=10, ge=0, le=240)
    usage_pattern: UsagePattern = UsagePattern.rare
    apply_concurrency_multiplier: bool = False

    @model_validator(mode="after")
    def validate_custom_size(self) -> "SQLComputeInput":
        if self.warehouse_size == "custom" and self.custom_dbu_per_hour is None:
            raise ValueError("custom_dbu_per_hour is required when warehouse_size is custom")
        return self


class JobComputeInput(BaseModel):
    ingestion_frequency: IngestionFrequency = IngestionFrequency.monthly
    job_runs_per_month: int = Field(default=1, ge=0)
    average_job_runtime_minutes: float = Field(default=0, ge=0)
    job_cluster_size: str = Field(default="small", min_length=1)
    custom_dbu_per_hour: float | None = Field(default=None, ge=0)
    dbu_rate: float | None = Field(default=None, ge=0)
    number_of_jobs: int = Field(default=1, ge=0)

    @model_validator(mode="after")
    def validate_custom_size(self) -> "JobComputeInput":
        if self.job_cluster_size == "custom" and self.custom_dbu_per_hour is None:
            raise ValueError("custom_dbu_per_hour is required when job_cluster_size is custom")
        return self


class AIBIInput(BaseModel):
    enabled: bool = False
    expected_users: int = Field(default=0, ge=0)
    questions_per_user_per_month: int = Field(default=0, ge=0)
    average_runtime_minutes_per_question: float = Field(default=0, ge=0)
    dbu_per_hour: float = Field(default=0, ge=0)
    dbu_rate: float | None = Field(default=None, ge=0)


class EstimateRequest(BaseModel):
    scenario_key: str = Field(default="archive_only", min_length=1)
    dataset: DatasetInput
    storage: StorageInput
    sql_compute: SQLComputeInput
    job_compute: JobComputeInput
    ai_bi: AIBIInput = Field(default_factory=AIBIInput)
    buffer_percentage: float | None = Field(default=None, ge=0, le=1000)


class CostComponent(BaseModel):
    label: str
    monthly_cost: float
    assumptions: dict[str, Any] = Field(default_factory=dict)


class EstimateWarning(BaseModel):
    severity: str
    message: str
    field: str | None = None


class EstimateResponse(BaseModel):
    currency: str
    scenario_key: str
    scenario_title: str
    components: list[CostComponent]
    monthly_storage_cost: float
    monthly_sql_compute_cost: float
    monthly_job_compute_cost: float
    monthly_ai_bi_cost: float
    total_monthly_estimate: float
    total_annual_estimate: float
    estimate_with_buffer_monthly: float
    estimate_with_buffer_annual: float
    buffer_percentage: float
    cost_per_gb_monthly: float
    cost_per_1000_files_monthly: float
    assumptions: dict[str, Any]
    confidence_score: int
    confidence_level: str
    warnings: list[EstimateWarning] = Field(default_factory=list)
    disclaimer: str
    generated_at: str


class ScenarioComparisonResponse(BaseModel):
    estimates: list[EstimateResponse]


class ScenarioRecommendation(BaseModel):
    key: str
    title: str
    summary: str
    reasons: list[str] = Field(default_factory=list)


class ExportRequest(BaseModel):
    request: EstimateRequest
    estimate: EstimateResponse
    recommendation: ScenarioRecommendation | None = None
    pricing_source: dict[str, Any] | None = None
