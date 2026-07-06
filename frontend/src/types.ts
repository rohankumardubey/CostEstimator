export type CloudProvider = "aws" | "azure" | "gcp";
export type WarehouseType = "serverless" | "pro" | "classic";
export type UsagePattern = "rare" | "occasional" | "frequent" | "high";
export type IngestionFrequency = "one-time" | "daily" | "weekly" | "monthly";
export type RedundancyModel = "single_copy" | "backup_copy" | "custom";
export type BatchComputeType = "classic_jobs" | "serverless_jobs" | "dlt_triggered";
export type StreamingSourceType = "kafka" | "pulsar" | "kinesis" | "event_hubs" | "cdc_database" | "saas_connector" | "api_webhook" | "other";
export type StreamingIngestionProduct = "structured_streaming" | "dlt_continuous" | "lakeflow_connect" | "zerobus_ingest";
export type StreamingRuntimePattern = "always_on" | "business_hours" | "custom";

export interface DatasetInput {
  team_name: string;
  brand_or_dataset_name: string;
  cloud_provider: CloudProvider;
  region: string;
  total_data_size_gb: number;
  file_count: number;
  zip_archive_file_count: number;
  structured_file_count: number;
  document_file_count: number;
  annual_growth_percentage: number;
  number_of_environments: number;
  redundancy_model: RedundancyModel;
  replication_factor: number;
}

export interface StorageInput {
  storage_class: string;
  monthly_read_requests: number;
  monthly_write_requests: number;
}

export interface SQLComputeInput {
  warehouse_type: WarehouseType;
  warehouse_size: string;
  custom_dbu_per_hour?: number | null;
  dbu_rate?: number | null;
  queries_per_month: number;
  average_query_runtime_minutes: number;
  concurrent_users: number;
  auto_stop_minutes: number;
  usage_pattern: UsagePattern;
  apply_concurrency_multiplier: boolean;
}

export interface JobComputeInput {
  enabled: boolean;
  ingestion_frequency: IngestionFrequency;
  batch_type: string;
  data_volume_per_run_gb: number;
  compute_type: BatchComputeType;
  job_runs_per_month: number;
  average_job_runtime_minutes: number;
  job_cluster_size: string;
  custom_dbu_per_hour?: number | null;
  dbu_rate?: number | null;
  number_of_jobs: number;
}

export interface StreamingIngestionInput {
  enabled: boolean;
  source_type: StreamingSourceType;
  ingestion_product: StreamingIngestionProduct;
  daily_data_gb: number;
  monthly_data_gb?: number | null;
  runtime_pattern: StreamingRuntimePattern;
  hours_per_day: number;
  days_per_month: number;
  number_of_streams: number;
  dbu_per_hour: number;
  dbu_rate?: number | null;
  include_ec2_cost: boolean;
  ec2_hourly_cost: number;
  free_tier_already_consumed: boolean;
  photon_enabled: boolean;
}

export interface AIBIInput {
  enabled: boolean;
  expected_users: number;
  questions_per_user_per_month: number;
  average_runtime_minutes_per_question: number;
  dbu_per_hour: number;
  dbu_rate?: number | null;
}

export interface CrossRegionTransferInput {
  enabled: boolean;
  destination_region: string;
  include_dr_storage_copy: boolean;
  initial_replication_gb: number;
  monthly_changed_data_gb: number;
  monthly_cross_region_read_gb: number;
  amortize_initial_months: number;
  transfer_price_per_gb_override?: number | null;
}

export interface SupportCostInput {
  support_cost_percentage: number;
  databricks_discount_percentage: number;
  cloud_discount_percentage: number;
}

export interface EstimateRequest {
  scenario_key: string;
  dataset: DatasetInput;
  storage: StorageInput;
  sql_compute: SQLComputeInput;
  job_compute: JobComputeInput;
  streaming_ingestion: StreamingIngestionInput;
  ai_bi: AIBIInput;
  cross_region_transfer: CrossRegionTransferInput;
  support_cost: SupportCostInput;
  buffer_percentage?: number | null;
}

export interface CostComponent {
  label: string;
  monthly_cost: number;
  assumptions: Record<string, unknown>;
}

export interface EstimateWarning {
  severity: "high" | "medium" | "low";
  message: string;
  field?: string | null;
}

export interface EstimateResponse {
  currency: string;
  scenario_key: string;
  scenario_title: string;
  components: CostComponent[];
  monthly_storage_cost: number;
  monthly_sql_compute_cost: number;
  monthly_job_compute_cost: number;
  monthly_streaming_compute_cost: number;
  one_time_batch_compute_cost: number;
  monthly_ai_bi_cost: number;
  monthly_cross_region_transfer_cost: number;
  one_time_cross_region_transfer_cost: number;
  monthly_discount_amount: number;
  monthly_support_cost: number;
  total_monthly_estimate: number;
  total_annual_estimate: number;
  estimate_with_buffer_monthly: number;
  estimate_with_buffer_annual: number;
  buffer_percentage: number;
  cost_per_gb_monthly: number;
  cost_per_1000_files_monthly: number;
  assumptions: Record<string, unknown>;
  confidence_score: number;
  confidence_level: string;
  warnings: EstimateWarning[];
  disclaimer: string;
  generated_at: string;
}

export interface ScenarioComparisonResponse {
  estimates: EstimateResponse[];
}

export interface ScenarioConfig {
  title: string;
  description: string;
  storage_class_by_cloud: Record<CloudProvider, string>;
  sql: Partial<SQLComputeInput>;
  jobs: Partial<JobComputeInput>;
  streaming_ingestion?: Partial<StreamingIngestionInput>;
  ai_bi: Partial<AIBIInput>;
}

export interface PricingConfig {
  currency: string;
  default_buffer_percentage: number;
  pricing_source?: {
    mode: string;
    updated_at: string;
    cache_seconds: number;
    notes: string[];
  };
  cloud: Record<
    CloudProvider,
    {
      display_name: string;
      default_region: string;
      regions: Record<
        string,
        {
          display_name: string;
          storage: Record<
            string,
            {
              display_name: string;
              price_per_gb_month: number;
              pricing_source?: string;
              pricing_status?: string;
              pricing_note?: string;
            }
          >;
        }
      >;
    }
  >;
  databricks: {
    default_dbu_rate: number;
    dbu_rates?: {
      sql?: Partial<Record<WarehouseType, number>>;
      jobs?: {
        classic?: number;
        serverless?: number;
        default?: number;
      };
      dlt?: {
        core?: number;
        pro?: number;
        advanced?: number;
      };
      ai_bi?: {
        default?: number;
      };
    };
    lakeflow_connect?: {
      managed_connectors_dbu_rate?: number;
      free_dbu_per_workspace_day?: number;
      zerobus_ingest_price_per_gb?: number;
    };
    sql_warehouses: Record<string, { display_name: string; dbu_per_hour: number }>;
    jobs: Record<string, { display_name: string; dbu_per_hour: number }>;
  };
  scenario_defaults: Record<string, ScenarioConfig>;
  sample_dataset: Partial<DatasetInput> & {
    dominant_category?: string;
    suggested_scenarios?: string[];
  };
  disclaimer: string;
}
