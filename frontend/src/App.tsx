import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  BarChart3,
  Cloud,
  Copy,
  Database,
  Download,
  FolderOpen,
  FileJson,
  FileText,
  FileSpreadsheet,
  Layers,
  Loader2,
  LogOut,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { deleteSavedEstimate, exportBlob, getPricingConfig, getSavedEstimate, getSavedEstimates, getScenarios, postEstimate, postSavedEstimate, postScenarioComparison } from "./api";
import type {
  AIBIInput,
  CloudProvider,
  CrossRegionTransferInput,
  DatasetInput,
  EstimateRequest,
  EstimateResponse,
  JobComputeInput,
  PricingConfig,
  RedundancyModel,
  SavedEstimateDetail,
  SavedEstimateSummary,
  SQLComputeInput,
  StreamingIngestionInput,
  ScenarioConfig,
  StorageInput,
  SupportCostInput
} from "./types";

const COLORS = ["#2563eb", "#059669", "#dc6803", "#7c3aed", "#475467"];
const AUTH_SESSION_KEY = "databricks-cost-estimator-authenticated";
const LOGIN_USERNAME = import.meta.env.VITE_APP_USERNAME ?? "admin";
const LOGIN_PASSWORD = import.meta.env.VITE_APP_PASSWORD ?? "databricks";
const REDUNDANCY_OPTIONS: Array<{ value: RedundancyModel; label: string; multiplier: number; description: string }> = [
  {
    value: "single_copy",
    label: "Single copy",
    multiplier: 1,
    description: "One storage copy only. Use for early estimates when backup or disaster recovery is not in scope."
  },
  {
    value: "backup_copy",
    label: "Backup copy",
    multiplier: 2,
    description: "Primary storage plus one backup or retained copy."
  },
  {
    value: "custom",
    label: "Custom multiplier",
    multiplier: 1,
    description: "Use when platform or FinOps gives a specific storage replication multiplier."
  }
];

const defaultDataset: DatasetInput = {
  team_name: "Example Data Team",
  brand_or_dataset_name: "Legacy collaboration archive",
  cloud_provider: "aws",
  region: "eu-west-1",
  total_data_size_gb: 31.13,
  file_count: 7497,
  zip_archive_file_count: 4771,
  structured_file_count: 12,
  document_file_count: 2714,
  annual_growth_percentage: 10,
  number_of_environments: 1,
  redundancy_model: "single_copy",
  replication_factor: 1
};

const defaultStorage: StorageInput = {
  storage_class: "s3_intelligent_tiering",
  monthly_read_requests: 0,
  monthly_write_requests: 0
};

const defaultSql: SQLComputeInput = {
  warehouse_type: "serverless",
  warehouse_size: "xs",
  custom_dbu_per_hour: null,
  dbu_rate: null,
  queries_per_month: 0,
  average_query_runtime_minutes: 0,
  concurrent_users: 0,
  auto_stop_minutes: 0,
  usage_pattern: "rare",
  apply_concurrency_multiplier: false
};

const defaultJob: JobComputeInput = {
  enabled: false,
  ingestion_frequency: "one-time",
  batch_type: "one_time_archive_load",
  data_volume_per_run_gb: 0,
  compute_type: "classic_jobs",
  dlt_tier: "core",
  use_instance_sizing: false,
  worker_instance_type: "m5.xlarge",
  worker_count: 2,
  driver_instance_type: "m5.xlarge",
  driver_count: 1,
  photon_enabled: false,
  include_ec2_cost: false,
  job_runs_per_month: 0,
  average_job_runtime_minutes: 0,
  job_cluster_size: "small",
  custom_dbu_per_hour: null,
  dbu_rate: null,
  number_of_jobs: 0,
  compaction_runs_per_month: 0,
  average_compaction_runtime_minutes: 0
};

const defaultStreamingIngestion: StreamingIngestionInput = {
  enabled: false,
  source_type: "kafka",
  ingestion_product: "structured_streaming",
  source_location: "same_region_cross_az",
  trigger_interval: "continuous",
  daily_data_gb: 0,
  monthly_data_gb: null,
  runtime_pattern: "always_on",
  hours_per_day: 24,
  days_per_month: 30,
  monthly_runtime_hours: 730,
  number_of_streams: 1,
  dlt_tier: "core",
  use_instance_sizing: true,
  worker_instance_type: "m5.xlarge",
  worker_count: 2,
  driver_instance_type: "m5.xlarge",
  driver_count: 1,
  dbu_per_hour: 4.5,
  dbu_rate: null,
  include_ec2_cost: true,
  ec2_hourly_cost: 0,
  source_transfer_gb_per_month: null,
  source_transfer_price_per_gb_override: null,
  free_tier_already_consumed: true,
  photon_enabled: false
};

const defaultAiBi: AIBIInput = {
  enabled: false,
  expected_users: 0,
  questions_per_user_per_month: 0,
  average_runtime_minutes_per_question: 0,
  dbu_per_hour: 0,
  dbu_rate: null
};

const defaultCrossRegionTransfer: CrossRegionTransferInput = {
  enabled: false,
  destination_region: "",
  include_dr_storage_copy: true,
  initial_replication_gb: 0,
  monthly_changed_data_gb: 0,
  monthly_cross_region_read_gb: 0,
  amortize_initial_months: 0,
  transfer_price_per_gb_override: null
};

const defaultSupportCost: SupportCostInput = {
  support_cost_percentage: 0,
  databricks_discount_percentage: 0,
  cloud_discount_percentage: 0
};

type LoadedEstimateState = {
  label: string;
  savedAt?: string;
  id?: string;
  action: "loaded" | "saved" | "copied" | "reset";
};

type EstimatorSection = "scenario" | "results" | "dataset" | "storage" | "compute" | "recommendation" | "assumptions";

const ESTIMATOR_SECTIONS: EstimatorSection[] = [
  "scenario",
  "results",
  "dataset",
  "storage",
  "compute",
  "recommendation",
  "assumptions"
];

function App() {
  const activeSectionLockRef = useRef<EstimatorSection | null>(null);
  const activeSectionLockTimeoutRef = useRef<number | null>(null);
  const loadedPermalinkRef = useRef<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(() => window.sessionStorage.getItem(AUTH_SESSION_KEY) === "true");
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginIsSubmitting, setLoginIsSubmitting] = useState(false);
  const [pricing, setPricing] = useState<PricingConfig | null>(null);
  const [scenarios, setScenarios] = useState<Record<string, ScenarioConfig>>({});
  const [selectedScenario, setSelectedScenario] = useState("archive_only");
  const [dataset, setDataset] = useState<DatasetInput>(defaultDataset);
  const [storage, setStorage] = useState<StorageInput>(defaultStorage);
  const [sqlCompute, setSqlCompute] = useState<SQLComputeInput>(defaultSql);
  const [jobCompute, setJobCompute] = useState<JobComputeInput>(defaultJob);
  const [batchDataVolumeManuallyEdited, setBatchDataVolumeManuallyEdited] = useState(false);
  const [streamingIngestion, setStreamingIngestion] = useState<StreamingIngestionInput>(defaultStreamingIngestion);
  const [streamingNetworkPriceManuallyEdited, setStreamingNetworkPriceManuallyEdited] = useState(false);
  const [aiBi, setAiBi] = useState<AIBIInput>(defaultAiBi);
  const [crossRegionTransfer, setCrossRegionTransfer] = useState<CrossRegionTransferInput>(defaultCrossRegionTransfer);
  const [supportCost, setSupportCost] = useState<SupportCostInput>(defaultSupportCost);
  const [bufferPercentage, setBufferPercentage] = useState<number | null>(null);
  const [currentPage, setCurrentPage] = useState<"estimator" | "knowledge">("knowledge");
  const [activeSection, setActiveSection] = useState<EstimatorSection>("scenario");
  const [estimate, setEstimate] = useState<EstimateResponse | null>(null);
  const [scenarioEstimates, setScenarioEstimates] = useState<EstimateResponse[]>([]);
  const [loadingEstimate, setLoadingEstimate] = useState(false);
  const [pricingRefreshStatus, setPricingRefreshStatus] = useState<"idle" | "refreshing" | "live" | "fallback">("idle");
  const [loadedEstimate, setLoadedEstimate] = useState<LoadedEstimateState | null>(null);
  const [savedEstimateId, setSavedEstimateId] = useState<string | null>(null);
  const [savedEstimateShareUrl, setSavedEstimateShareUrl] = useState<string | null>(null);
  const [savedEstimates, setSavedEstimates] = useState<SavedEstimateSummary[]>([]);
  const [savedEstimateSearch, setSavedEstimateSearch] = useState("");
  const [savedEstimateModalOpen, setSavedEstimateModalOpen] = useState(false);
  const [loadingSavedEstimates, setLoadingSavedEstimates] = useState(false);
  const [savingEstimate, setSavingEstimate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    Promise.all([getPricingConfig(), getScenarios()])
      .then(([pricingConfig, scenarioConfig]) => {
        setPricing(pricingConfig);
        setScenarios(scenarioConfig);
        setPricingRefreshStatus(getPricingRefreshStatus(pricingConfig));
        setBufferPercentage(pricingConfig.default_buffer_percentage);
        setDataset((current) => ({
          ...current,
          ...pricingConfig.sample_dataset
        }));
      })
      .catch((err: Error) => setError(err.message));
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    if (!pricing || !isBackgroundPricingRefreshPending(pricing)) {
      return;
    }

    let attempts = 0;
    let cancelled = false;
    const maxAttempts = 15;
    setPricingRefreshStatus("refreshing");

    const interval = window.setInterval(() => {
      attempts += 1;
      getPricingConfig()
        .then((nextPricing) => {
          if (cancelled) {
            return;
          }
          setPricing(nextPricing);
          setPricingRefreshStatus(getPricingRefreshStatus(nextPricing));
          if (!isBackgroundPricingRefreshPending(nextPricing) || attempts >= maxAttempts) {
            window.clearInterval(interval);
          }
        })
        .catch(() => {
          if (attempts >= maxAttempts) {
            window.clearInterval(interval);
          }
        });
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [isAuthenticated, pricing?.pricing_source?.updated_at]);

  useEffect(() => {
    if (!isAuthenticated || !pricing) {
      return;
    }
    const permalinkId = getEstimateIdFromPath();
    if (!permalinkId || loadedPermalinkRef.current === permalinkId) {
      return;
    }
    loadedPermalinkRef.current = permalinkId;
    void handleLoadSavedEstimate(permalinkId, { updateUrl: false, closeModal: true });
  }, [isAuthenticated, pricing]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    if (currentPage !== "estimator") {
      return;
    }

    const updateActiveSection = () => {
      if (activeSectionLockRef.current) {
        return;
      }
      setActiveSection(getVisibleEstimatorSection());
    };

    updateActiveSection();
    window.addEventListener("scroll", updateActiveSection, { passive: true });
    window.addEventListener("resize", updateActiveSection);
    return () => {
      window.removeEventListener("scroll", updateActiveSection);
      window.removeEventListener("resize", updateActiveSection);
    };
  }, [currentPage, isAuthenticated]);

  useEffect(() => {
    return () => {
      if (activeSectionLockTimeoutRef.current) {
        window.clearTimeout(activeSectionLockTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (jobCompute.batch_type !== "one_time_archive_load" || batchDataVolumeManuallyEdited) {
      return;
    }
    const datasetVolume = roundEstimatorInput(dataset.total_data_size_gb);
    if (jobCompute.data_volume_per_run_gb === datasetVolume) {
      return;
    }
    setJobCompute((current) => {
      if (current.batch_type !== "one_time_archive_load") {
        return current;
      }
      return {
        ...current,
        data_volume_per_run_gb: datasetVolume
      };
    });
  }, [batchDataVolumeManuallyEdited, dataset.total_data_size_gb, jobCompute.batch_type, jobCompute.data_volume_per_run_gb]);

  const requestPayload = useMemo<EstimateRequest>(
    () => ({
      scenario_key: selectedScenario,
      dataset,
      storage,
      sql_compute: sqlCompute,
      job_compute: jobCompute,
      streaming_ingestion: streamingIngestion,
      ai_bi: aiBi,
      cross_region_transfer: crossRegionTransfer,
      support_cost: supportCost,
      buffer_percentage: bufferPercentage
    }),
    [selectedScenario, dataset, storage, sqlCompute, jobCompute, streamingIngestion, aiBi, crossRegionTransfer, supportCost, bufferPercentage]
  );

  useEffect(() => {
    if (!isAuthenticated || !pricing) {
      return;
    }
    const timer = window.setTimeout(() => {
      setLoadingEstimate(true);
      Promise.all([postEstimate(requestPayload), postScenarioComparison(requestPayload)])
        .then(([nextEstimate, comparison]) => {
          setEstimate(nextEstimate);
          setScenarioEstimates(comparison.estimates);
          setError(null);
        })
        .catch((err: Error) => setError(err.message))
        .finally(() => setLoadingEstimate(false));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [isAuthenticated, pricing, requestPayload]);

  const cloudConfig = pricing?.cloud[dataset.cloud_provider];
  const regionConfig = cloudConfig?.regions[dataset.region];
  const storageOptions = regionConfig?.storage ?? {};
  const destinationRegionOptions = Object.entries(cloudConfig?.regions ?? {})
    .filter(([key]) => key !== dataset.region)
    .map(([key, region]) => ({ value: key, label: region.display_name }));
  const crossRegionEffectiveTransferPrice = getCrossRegionTransferPricePerGb(
    estimate,
    pricing,
    dataset.cloud_provider,
    dataset.region,
    crossRegionTransfer.destination_region
  );
  const filteredSavedEstimates = savedEstimates.filter((savedEstimate) => {
    const search = savedEstimateSearch.trim().toLowerCase();
    if (!search) {
      return true;
    }
    return [
      savedEstimate.title,
      savedEstimate.team_name,
      savedEstimate.dataset_name,
      savedEstimate.scenario_title,
      savedEstimate.id
    ].some((value) => value.toLowerCase().includes(search));
  });

  function applyScenario(key: string) {
    const scenario = scenarios[key];
    if (!scenario) {
      return;
    }
    setSelectedScenario(key);
    setStorage((current) => ({
      ...current,
      storage_class: scenario.storage_class_by_cloud[dataset.cloud_provider] ?? current.storage_class
    }));
    setSqlCompute((current) => ({ ...current, ...scenario.sql }));
    setBatchDataVolumeManuallyEdited(false);
    setJobCompute((current) => ({ ...current, ...scenario.jobs }));
    setStreamingNetworkPriceManuallyEdited(false);
    setStreamingIngestion((current) => ({ ...current, ...(scenario.streaming_ingestion ?? {}) }));
    setAiBi((current) => ({ ...defaultAiBi, ...current, ...scenario.ai_bi }));
  }

  function updateCloud(nextCloud: CloudProvider) {
    if (!pricing) {
      setDataset((current) => ({ ...current, cloud_provider: nextCloud }));
      return;
    }
    const defaultRegion = pricing.cloud[nextCloud].default_region;
    const scenario = scenarios[selectedScenario];
    setDataset((current) => ({ ...current, cloud_provider: nextCloud, region: defaultRegion }));
    setCrossRegionTransfer((current) => ({
      ...current,
      destination_region: "",
      transfer_price_per_gb_override: null
    }));
    setStorage((current) => ({
      ...current,
      storage_class: scenario?.storage_class_by_cloud[nextCloud] ?? Object.keys(pricing.cloud[nextCloud].regions[defaultRegion].storage)[0]
    }));
  }

  function updateRedundancyModel(nextModel: RedundancyModel) {
    const option = getRedundancyOption(nextModel);
    setDataset((current) => ({
      ...current,
      redundancy_model: nextModel,
      replication_factor: nextModel === "custom" ? current.replication_factor : option.multiplier
    }));
  }

  async function handleExport(
    path: "/export/json" | "/export/csv" | "/export/pdf",
    filename: string,
    recommendation = scenarioRecommendation
  ) {
    if (!estimate) {
      return;
    }
    const blob = await exportBlob(path, {
      request: requestPayload,
      estimate,
      recommendation,
      pricing_source: pricing?.pricing_source ?? null
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleSaveEstimate() {
    setSavingEstimate(true);
    try {
      const saved = await postSavedEstimate({
        request: requestPayload,
        title: buildSavedEstimateTitle(requestPayload),
        pricing_source: pricing?.pricing_source ?? null
      });
      applySavedEstimateMetadata(saved, "saved");
      setEstimate(saved.estimate);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this estimate.");
    } finally {
      setSavingEstimate(false);
    }
  }

  async function handleOpenSavedEstimateModal() {
    setSavedEstimateModalOpen(true);
    setLoadingSavedEstimates(true);
    try {
      const response = await getSavedEstimates();
      setSavedEstimates(response.estimates);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load saved estimates.");
    } finally {
      setLoadingSavedEstimates(false);
    }
  }

  async function handleLoadSavedEstimate(
    estimateId: string,
    options: { updateUrl?: boolean; closeModal?: boolean } = {}
  ) {
    setLoadingSavedEstimates(true);
    try {
      const saved = await getSavedEstimate(estimateId);
      restoreEstimateRequest(saved.request);
      setEstimate(saved.estimate);
      applySavedEstimateMetadata(saved, "loaded");
      if (options.updateUrl !== false) {
        window.history.replaceState(null, "", buildSharePath(saved.id));
      }
      if (options.closeModal !== false) {
        setSavedEstimateModalOpen(false);
      }
      setError(null);
      navigateToEstimator("scenario");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the saved estimate.");
    } finally {
      setLoadingSavedEstimates(false);
    }
  }

  async function handleCopySavedEstimateLink(estimateId = savedEstimateId) {
    if (!estimateId) {
      return;
    }
    const shareUrl = buildShareUrl(estimateId);
    try {
      await navigator.clipboard.writeText(shareUrl);
      setLoadedEstimate({
        label: "Permalink copied",
        action: "copied",
        savedAt: new Date().toISOString(),
        id: estimateId
      });
      setSavedEstimateShareUrl(shareUrl);
    } catch {
      setError(`Copy failed. Use this link: ${shareUrl}`);
    }
  }

  async function handleDeleteSavedEstimate(savedEstimate: SavedEstimateSummary) {
    const confirmed = window.confirm(
      `Delete saved estimate "${savedEstimate.title}"?\n\nThis removes it from the saved library and its permalink will no longer open.`
    );
    if (!confirmed) {
      return;
    }

    setLoadingSavedEstimates(true);
    try {
      await deleteSavedEstimate(savedEstimate.id);
      setSavedEstimates((current) => current.filter((estimateItem) => estimateItem.id !== savedEstimate.id));
      if (savedEstimateId === savedEstimate.id) {
        setSavedEstimateId(null);
        setSavedEstimateShareUrl(null);
        window.history.replaceState(null, "", "/");
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the saved estimate.");
    } finally {
      setLoadingSavedEstimates(false);
    }
  }

  function applySavedEstimateMetadata(saved: SavedEstimateDetail, action: "loaded" | "saved") {
    const shareUrl = buildShareUrl(saved.id);
    setSavedEstimateId(saved.id);
    setSavedEstimateShareUrl(shareUrl);
    setLoadedEstimate({
      label: saved.title,
      action,
      savedAt: saved.updated_at,
      id: saved.id
    });
  }

  function restoreEstimateRequest(nextRequest: EstimateRequest) {
    setSelectedScenario(nextRequest.scenario_key);
    setDataset(nextRequest.dataset);
    setStorage(nextRequest.storage);
    setSqlCompute(nextRequest.sql_compute);
    setBatchDataVolumeManuallyEdited(true);
    setJobCompute(nextRequest.job_compute);
    setStreamingNetworkPriceManuallyEdited(Boolean(nextRequest.streaming_ingestion?.source_transfer_price_per_gb_override));
    setStreamingIngestion(nextRequest.streaming_ingestion ?? defaultStreamingIngestion);
    setAiBi(nextRequest.ai_bi);
    setCrossRegionTransfer(nextRequest.cross_region_transfer ?? defaultCrossRegionTransfer);
    setSupportCost(nextRequest.support_cost ?? defaultSupportCost);
    setBufferPercentage(nextRequest.buffer_percentage ?? pricing?.default_buffer_percentage ?? null);
  }

  function resetToSampleData() {
    const defaultCloud = defaultDataset.cloud_provider;
    const defaultRegion = pricing?.cloud[defaultCloud]?.default_region ?? defaultDataset.region;
    const scenario = scenarios.archive_only;
    setSelectedScenario("archive_only");
    setDataset({
      ...defaultDataset,
      ...pricing?.sample_dataset,
      cloud_provider: defaultCloud,
      region: defaultRegion
    });
    setStorage({
      ...defaultStorage,
      storage_class:
        scenario?.storage_class_by_cloud[defaultCloud] ??
        Object.keys(pricing?.cloud[defaultCloud]?.regions[defaultRegion]?.storage ?? {})[0] ??
        defaultStorage.storage_class
    });
    setSqlCompute(defaultSql);
    setBatchDataVolumeManuallyEdited(false);
    setJobCompute(defaultJob);
    setStreamingNetworkPriceManuallyEdited(false);
    setStreamingIngestion(defaultStreamingIngestion);
    setAiBi(defaultAiBi);
    setCrossRegionTransfer(defaultCrossRegionTransfer);
    setSupportCost(defaultSupportCost);
    setBufferPercentage(pricing?.default_buffer_percentage ?? null);
    setSavedEstimateId(null);
    setSavedEstimateShareUrl(null);
    window.history.replaceState(null, "", "/");
    setLoadedEstimate({ label: "Sample defaults", action: "reset" });
    setError(null);
    navigateToEstimator("dataset");
  }

  function navigateToEstimator(sectionId?: string) {
    const nextSection = sectionId && isEstimatorSection(sectionId) ? sectionId : "scenario";
    setCurrentPage("estimator");
    activeSectionLockRef.current = nextSection;
    setActiveSection(nextSection);

    if (activeSectionLockTimeoutRef.current) {
      window.clearTimeout(activeSectionLockTimeoutRef.current);
    }
    activeSectionLockTimeoutRef.current = window.setTimeout(() => {
      activeSectionLockRef.current = null;
      setActiveSection(getVisibleEstimatorSection());
      activeSectionLockTimeoutRef.current = null;
    }, 1300);

    window.setTimeout(() => {
      if (sectionId) {
        document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    }, 0);
  }

  function navigateToKnowledgeBase() {
    activeSectionLockRef.current = null;
    if (activeSectionLockTimeoutRef.current) {
      window.clearTimeout(activeSectionLockTimeoutRef.current);
      activeSectionLockTimeoutRef.current = null;
    }
    setCurrentPage("knowledge");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loginUsername.trim() === LOGIN_USERNAME && loginPassword === LOGIN_PASSWORD) {
      setLoginError(null);
      setLoginIsSubmitting(true);
      window.setTimeout(() => {
        window.sessionStorage.setItem(AUTH_SESSION_KEY, "true");
        setIsAuthenticated(true);
        setCurrentPage("knowledge");
        setLoginPassword("");
        setLoginIsSubmitting(false);
        window.scrollTo({ top: 0 });
      }, 900);
      return;
    }
    setLoginIsSubmitting(false);
    setLoginError("Invalid username or password.");
  }

  function handleLogout() {
    window.sessionStorage.removeItem(AUTH_SESSION_KEY);
    setIsAuthenticated(false);
    setCurrentPage("knowledge");
    setLoginUsername("");
    setLoginPassword("");
    setLoginError(null);
  }

  const breakdownData = estimate?.components.filter((component) => component.monthly_cost > 0) ?? [];
  const annualData = estimate
    ? [
        { name: "Monthly estimate", label: "Monthly", value: estimate.total_monthly_estimate },
        { name: "Annual estimate", label: "Annual", value: estimate.total_annual_estimate },
        { name: "Buffered annual estimate", label: "Buffered", value: estimate.estimate_with_buffer_annual }
      ]
    : [];
  const scenarioComparison = scenarioEstimates.map((scenarioEstimate) => ({
    name: shortScenarioName(scenarioEstimate.scenario_key, scenarioEstimate.scenario_title),
    label: shorterScenarioLabel(scenarioEstimate.scenario_key, scenarioEstimate.scenario_title),
    value: scenarioEstimate.total_monthly_estimate
  }));
  const scenarioRecommendation = useMemo(
    () => buildScenarioRecommendation(requestPayload, scenarios),
    [requestPayload, scenarios]
  );

  if (!isAuthenticated) {
    return (
      <LoginPage
        username={loginUsername}
        password={loginPassword}
        error={loginError}
        isSubmitting={loginIsSubmitting}
        onUsernameChange={setLoginUsername}
        onPasswordChange={setLoginPassword}
        onSubmit={handleLogin}
      />
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <Database aria-hidden="true" />
          <div>
            <p className="eyebrow">Internal platform tool</p>
            <h1>Databricks Cost Estimator</h1>
          </div>
        </div>
        <p className="sidebar-copy">
          Indicative cloud storage and Databricks estimates using live storage prices where available.
        </p>
        <nav className="step-list" aria-label="Application sections">
          <button type="button" className={currentPage === "knowledge" ? "active" : ""} onClick={navigateToKnowledgeBase}>
            <FileText size={17} />
            <span>Knowledge Base</span>
          </button>
          <button type="button" className={currentPage === "estimator" && activeSection === "scenario" ? "active" : ""} onClick={() => navigateToEstimator("scenario")}>
            <Layers size={17} />
            <span>Scenario</span>
          </button>
          <button type="button" className={currentPage === "estimator" && activeSection === "dataset" ? "active" : ""} onClick={() => navigateToEstimator("dataset")}>
            <Database size={17} />
            <span>Dataset</span>
          </button>
          <button
            type="button"
            className={currentPage === "estimator" && (activeSection === "storage" || activeSection === "compute") ? "active" : ""}
            onClick={() => navigateToEstimator("compute")}
          >
            <Cloud size={17} />
            <span>Storage &amp; compute</span>
          </button>
          <button type="button" className={currentPage === "estimator" && activeSection === "recommendation" ? "active" : ""} onClick={() => navigateToEstimator("recommendation")}>
            <BadgeCheck size={17} />
            <span>Recommendation</span>
          </button>
          <button type="button" className={currentPage === "estimator" && activeSection === "assumptions" ? "active" : ""} onClick={() => navigateToEstimator("assumptions")}>
            <ShieldAlert size={17} />
            <span>Assumptions</span>
          </button>
        </nav>
        <button type="button" className="logout-button" onClick={handleLogout}>
          <LogOut size={17} />
          <span>Sign out</span>
        </button>
        <div className="sidebar-footer-logo" aria-label="Flutter Entertainment">
          <div className="footer-logo-mark">FE</div>
          <div>
            <span>Flutter</span>
            <strong>Entertainment</strong>
          </div>
        </div>
      </aside>

      <section className="content">
        {currentPage === "knowledge" ? (
          <KnowledgeBasePage onBack={() => navigateToEstimator()} />
        ) : (
          <>
        <header className="topbar">
          <div>
            <p className="eyebrow">Databricks cost estimator</p>
            <h2>Databricks and storage planning</h2>
          </div>
          <div className="topbar-actions">
            <button className="ghost-button" onClick={handleOpenSavedEstimateModal}>
              <FolderOpen size={16} /> Load
            </button>
            <button className="ghost-button" onClick={handleSaveEstimate} disabled={savingEstimate}>
              {savingEstimate ? <Loader2 size={16} className="spin" /> : <Download size={16} />} Save
            </button>
            <button className="ghost-button" onClick={() => handleCopySavedEstimateLink()} disabled={!savedEstimateId}>
              <Copy size={16} /> Copy link
            </button>
            <button className="ghost-button" onClick={resetToSampleData}>
              <RefreshCw size={16} /> Reset
            </button>
            <button className="ghost-button" onClick={() => handleExport("/export/json", "databricks-cost-estimate.json")} disabled={!estimate}>
              <FileJson size={16} /> JSON
            </button>
            <button className="ghost-button" onClick={() => handleExport("/export/csv", "databricks-cost-estimate.csv")} disabled={!estimate}>
              <FileSpreadsheet size={16} /> CSV
            </button>
            <button className="primary-button" onClick={() => handleExport("/export/pdf", "databricks-cost-estimate.pdf")} disabled={!estimate}>
              <FileText size={16} /> PDF
            </button>
          </div>
        </header>

        <div className="warning-strip">
          <AlertTriangle aria-hidden="true" />
          <span>
            Storage pricing uses live provider list prices for the selected region where available. Databricks DBU rates and final costs must still be validated against internal enterprise rate cards.
          </span>
        </div>

        {pricingRefreshStatus === "refreshing" ? (
          <div className="pricing-status-strip">
            <Loader2 size={14} className="spin" />
            <span>Live storage pricing is refreshing in the background. Estimates will update automatically when it lands.</span>
          </div>
        ) : null}

        {loadedEstimate ? (
          <div className="success-strip">
            <BadgeCheck aria-hidden="true" />
            <span>{formatLoadedEstimateMessage(loadedEstimate)}</span>
            {savedEstimateShareUrl ? (
              <button className="inline-link-button" onClick={() => handleCopySavedEstimateLink()}>
                Copy permalink
              </button>
            ) : null}
          </div>
        ) : null}

        {savedEstimateModalOpen ? (
          <SavedEstimatesModal
            estimates={filteredSavedEstimates}
            loading={loadingSavedEstimates}
            search={savedEstimateSearch}
            currency={estimate?.currency ?? pricing?.currency ?? "USD"}
            onSearchChange={setSavedEstimateSearch}
            onClose={() => setSavedEstimateModalOpen(false)}
            onOpen={(estimateId) => handleLoadSavedEstimate(estimateId)}
            onCopy={(estimateId) => handleCopySavedEstimateLink(estimateId)}
            onDelete={(savedEstimate) => handleDeleteSavedEstimate(savedEstimate)}
          />
        ) : null}

        {error ? <div className="error-banner">{error}</div> : null}

        <section id="scenario" className="section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Scenarios</p>
              <h3>Select a starting point</h3>
            </div>
            {loadingEstimate ? (
              <span className="loading-pill">
                <Loader2 size={14} className="spin" /> Updating
              </span>
            ) : null}
          </div>
          <div className="scenario-grid">
            {Object.entries(scenarios).map(([key, scenario]) => (
              <button
                key={key}
                className={`scenario-card ${selectedScenario === key ? "active" : ""}`}
                onClick={() => applyScenario(key)}
              >
                {key === "future_ai_bi" ? <Sparkles aria-hidden="true" /> : <Layers aria-hidden="true" />}
                <span>{scenario.title}</span>
                <small>{scenario.description}</small>
              </button>
            ))}
          </div>

        </section>

        <section id="results" className="section results-section">
          <div className="kpi-grid">
            <KpiCard label="Monthly storage" value={money(estimate?.monthly_storage_cost, estimate?.currency)} />
            <KpiCard label="SQL compute" value={money(estimate?.monthly_sql_compute_cost, estimate?.currency)} />
            <KpiCard label="Batch compute" value={money(estimate?.monthly_job_compute_cost, estimate?.currency)} />
            <KpiCard label="Streaming compute" value={money(estimate?.monthly_streaming_compute_cost, estimate?.currency)} />
            <KpiCard label="One-time load" value={money(estimate?.one_time_batch_compute_cost, estimate?.currency)} />
            <KpiCard label="AI/BI optional" value={money(estimate?.monthly_ai_bi_cost, estimate?.currency)} />
            <KpiCard label="Cross-region DR" value={money(estimate?.monthly_cross_region_transfer_cost, estimate?.currency)} />
            <KpiCard label="Discounts" value={estimate ? `-${money(estimate.monthly_discount_amount, estimate.currency)}` : "--"} />
            <KpiCard label="Support uplift" value={money(estimate?.monthly_support_cost, estimate?.currency)} />
            <KpiCard label="Monthly estimate" value={money(estimate?.total_monthly_estimate, estimate?.currency)} strong />
            <KpiCard label="Annual estimate" value={money(estimate?.total_annual_estimate, estimate?.currency)} />
            <KpiCard label="With buffer" value={money(estimate?.estimate_with_buffer_annual, estimate?.currency)} />
            <KpiCard label="Cost per GB" value={money(estimate?.cost_per_gb_monthly, estimate?.currency)} />
            <KpiCard label="Cost per 1,000 files" value={money(estimate?.cost_per_1000_files_monthly, estimate?.currency)} />
            <KpiCard label="Confidence" value={estimate ? `${estimate.confidence_level} (${estimate.confidence_score})` : "--"} />
          </div>

          {estimate && estimate.warnings.length > 0 ? (
            <div className="warning-panel">
              <div className="warning-panel-heading">
                <AlertTriangle size={18} />
                <h4>Estimate warnings</h4>
              </div>
              <div className="warning-list">
                {estimate.warnings.map((warning, index) => (
                  <article key={`${warning.field ?? "warning"}-${index}`} className={`warning-item ${warning.severity}`}>
                    <strong>{titleCase(warning.severity)}</strong>
                    <span>{warning.message}</span>
                    {warning.field ? <small>{labelize(warning.field)}</small> : null}
                  </article>
                ))}
              </div>
            </div>
          ) : estimate ? (
            <div className="success-panel">No estimate warnings found for the current inputs.</div>
          ) : null}

          {estimate ? <ConfidenceExplanationCard estimate={estimate} request={requestPayload} pricing={pricing} /> : null}

          <div className="chart-grid">
            <ChartPanel title="Cost breakdown" icon={<BarChart3 size={18} />}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={breakdownData} dataKey="monthly_cost" nameKey="label" innerRadius={54} outerRadius={86} paddingAngle={2}>
                    {breakdownData.map((_, index) => (
                      <Cell key={index} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => money(Number(value), estimate?.currency)} />
                </PieChart>
              </ResponsiveContainer>
            </ChartPanel>

            <ChartPanel title="Scenario comparison" icon={<Layers size={18} />}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={scenarioComparison} margin={{ top: 8, right: 14, left: 10, bottom: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} height={34} tickMargin={8} />
                  <YAxis tickFormatter={(value) => shortMoney(value, estimate?.currency)} />
                  <Tooltip formatter={(value) => money(Number(value), estimate?.currency)} labelFormatter={(_, payload) => String(payload?.[0]?.payload?.name ?? "")} />
                  <Bar dataKey="value" radius={[6, 6, 0, 0]} fill="#2563eb" />
                </BarChart>
              </ResponsiveContainer>
            </ChartPanel>

            <ChartPanel title="Storage, compute, support" icon={<Cloud size={18} />}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  margin={{ top: 8, right: 14, left: 10, bottom: 32 }}
                  data={[
                    { name: "Storage", value: estimate?.monthly_storage_cost ?? 0 },
                    {
                      name: "Compute",
                      value:
                        (estimate?.monthly_sql_compute_cost ?? 0) +
                        (estimate?.monthly_job_compute_cost ?? 0) +
                        (estimate?.monthly_streaming_compute_cost ?? 0) +
                        (estimate?.monthly_ai_bi_cost ?? 0)
                    },
                    { name: "Support", value: estimate?.monthly_support_cost ?? 0 }
                  ]}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" height={42} tickMargin={8} />
                  <YAxis tickFormatter={(value) => shortMoney(value, estimate?.currency)} />
                  <Tooltip formatter={(value) => money(Number(value), estimate?.currency)} />
                  <Bar dataKey="value" radius={[6, 6, 0, 0]} fill="#059669" />
                </BarChart>
              </ResponsiveContainer>
            </ChartPanel>

            <ChartPanel title="Annualized estimate" icon={<Download size={18} />}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={annualData} margin={{ top: 8, right: 14, left: 10, bottom: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} height={34} tickMargin={8} />
                  <YAxis tickFormatter={(value) => shortMoney(value, estimate?.currency)} />
                  <Tooltip formatter={(value) => money(Number(value), estimate?.currency)} labelFormatter={(_, payload) => String(payload?.[0]?.payload?.name ?? "")} />
                  <Bar dataKey="value" radius={[6, 6, 0, 0]} fill="#7c3aed" />
                </BarChart>
              </ResponsiveContainer>
            </ChartPanel>
          </div>
        </section>

        <div className="form-layout">
          <section id="dataset" className="panel">
            <PanelHeading title="Dataset inputs" subtitle="Manual metadata and sizing details" />
            <div className="field-grid">
              <TextField label="Team name" value={dataset.team_name} onChange={(value) => setDataset({ ...dataset, team_name: value })} />
              <TextField
                label="Brand or dataset name"
                value={dataset.brand_or_dataset_name}
                onChange={(value) => setDataset({ ...dataset, brand_or_dataset_name: value })}
              />
              <SelectField
                label="Cloud provider"
                value={dataset.cloud_provider}
                onChange={(value) => updateCloud(value as CloudProvider)}
                options={["aws", "azure", "gcp"].map((key) => ({ value: key, label: pricing?.cloud[key as CloudProvider].display_name ?? key }))}
              />
              <SelectField
                label="Region"
                value={dataset.region}
                onChange={(value) => {
                  setDataset({ ...dataset, region: value });
                  if (crossRegionTransfer.destination_region === value) {
                    setCrossRegionTransfer({
                      ...crossRegionTransfer,
                      destination_region: "",
                      transfer_price_per_gb_override: null
                    });
                  } else {
                    setCrossRegionTransfer({
                      ...crossRegionTransfer,
                      transfer_price_per_gb_override: null
                    });
                  }
                }}
                options={Object.entries(cloudConfig?.regions ?? {}).map(([key, region]) => ({ value: key, label: region.display_name }))}
              />
              <NumberField label="Total data size GB" value={dataset.total_data_size_gb} onChange={(value) => setDataset({ ...dataset, total_data_size_gb: value })} />
              <NumberField label="File count" value={dataset.file_count} onChange={(value) => setDataset({ ...dataset, file_count: value })} />
              <NumberField
                label="ZIP/archive files"
                value={dataset.zip_archive_file_count}
                onChange={(value) => setDataset({ ...dataset, zip_archive_file_count: value })}
              />
              <NumberField
                label="Structured files"
                value={dataset.structured_file_count}
                onChange={(value) => setDataset({ ...dataset, structured_file_count: value })}
              />
              <NumberField
                label="Document files"
                value={dataset.document_file_count}
                onChange={(value) => setDataset({ ...dataset, document_file_count: value })}
              />
              <NumberField
                label="Annual growth %"
                value={dataset.annual_growth_percentage}
                onChange={(value) => setDataset({ ...dataset, annual_growth_percentage: value })}
              />
              <NumberField
                label="Environments"
                value={dataset.number_of_environments}
                onChange={(value) => setDataset({ ...dataset, number_of_environments: value })}
              />
              <SelectField
                label="Redundancy model"
                value={dataset.redundancy_model}
                onChange={(value) => updateRedundancyModel(value as RedundancyModel)}
                options={REDUNDANCY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
              />
              <NumberField
                label="Storage copy multiplier"
                value={dataset.replication_factor}
                onChange={(value) => setDataset({ ...dataset, redundancy_model: "custom", replication_factor: value })}
              />
            </div>
            <div className="enterprise-note-card">
              <BadgeCheck size={18} />
              <div>
                <strong>{getRedundancyOption(dataset.redundancy_model).label}</strong>
                <span>{getRedundancyOption(dataset.redundancy_model).description}</span>
                <small>
                  Applied storage copy multiplier: {dataset.replication_factor}x
                </small>
              </div>
            </div>
            <p className="empty-note">Sample defaults are loaded as a starting point. Replace them with the dataset metadata you want to estimate.</p>
          </section>

          <section id="storage" className="panel">
            <PanelHeading title="Storage estimator" subtitle={`Cloud object storage assumptions${pricing?.pricing_source ? ` - ${pricing.pricing_source.mode} pricing mode` : ""}`} />
            <div className="field-grid compact">
              <SelectField
                label="Storage class"
                value={storage.storage_class}
                onChange={(value) => setStorage({ ...storage, storage_class: value })}
                options={Object.entries(storageOptions).map(([key, value]) => ({ value: key, label: value.display_name }))}
              />
              <NumberField
                label="Monthly read requests"
                value={storage.monthly_read_requests}
                onChange={(value) => setStorage({ ...storage, monthly_read_requests: value })}
              />
              <NumberField
                label="Monthly write requests"
                value={storage.monthly_write_requests}
                onChange={(value) => setStorage({ ...storage, monthly_write_requests: value })}
              />
              <NumberField label="Buffer %" value={bufferPercentage ?? 0} onChange={(value) => setBufferPercentage(value)} />
            </div>
            <div className="cross-region-section">
              <PanelHeading title="Cross-region DR" subtitle="Optional replication, transfer, and access charges" />
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={crossRegionTransfer.enabled}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    const autoDefaults = getCrossRegionAutoDefaults(dataset);
                    setCrossRegionTransfer({
                      ...crossRegionTransfer,
                      enabled,
                      include_dr_storage_copy: true,
                      initial_replication_gb: enabled ? autoDefaults.initialReplicationGb : crossRegionTransfer.initial_replication_gb,
                      monthly_changed_data_gb: enabled ? autoDefaults.monthlyChangedDataGb : crossRegionTransfer.monthly_changed_data_gb,
                      amortize_initial_months: enabled ? autoDefaults.amortizeInitialMonths : crossRegionTransfer.amortize_initial_months
                    });
                  }}
                />
                <span>Estimate cross-region DR transfer/access cost</span>
              </label>
              <div className="field-grid compact">
                <SelectField
                  label="Destination region"
                  value={crossRegionTransfer.destination_region}
                  onChange={(value) => setCrossRegionTransfer({ ...crossRegionTransfer, destination_region: value, transfer_price_per_gb_override: null })}
                  options={[{ value: "", label: "Select destination" }, ...destinationRegionOptions]}
                  disabled={!crossRegionTransfer.enabled}
                />
                <NumberField
                  label="Initial replication GB"
                  value={crossRegionTransfer.initial_replication_gb}
                  onChange={(value) => setCrossRegionTransfer({ ...crossRegionTransfer, initial_replication_gb: value })}
                  disabled={!crossRegionTransfer.enabled}
                />
                <NumberField
                  label="Monthly changed data GB"
                  value={crossRegionTransfer.monthly_changed_data_gb}
                  onChange={(value) => setCrossRegionTransfer({ ...crossRegionTransfer, monthly_changed_data_gb: value })}
                  disabled={!crossRegionTransfer.enabled}
                />
                <NumberField
                  label="Monthly cross-region read GB"
                  value={crossRegionTransfer.monthly_cross_region_read_gb}
                  onChange={(value) => setCrossRegionTransfer({ ...crossRegionTransfer, monthly_cross_region_read_gb: value })}
                  disabled={!crossRegionTransfer.enabled}
                />
                <NumberField
                  label="Amortize initial over months"
                  value={crossRegionTransfer.amortize_initial_months}
                  onChange={(value) => setCrossRegionTransfer({ ...crossRegionTransfer, amortize_initial_months: value })}
                  disabled={!crossRegionTransfer.enabled}
                />
                <NumberField
                  label="Network transfer price/GB"
                  value={crossRegionTransfer.transfer_price_per_gb_override ?? crossRegionEffectiveTransferPrice}
                  onChange={(value) => setCrossRegionTransfer({ ...crossRegionTransfer, transfer_price_per_gb_override: value > 0 ? value : null })}
                  disabled={!crossRegionTransfer.enabled}
                  hint={
                    crossRegionTransfer.transfer_price_per_gb_override !== null && crossRegionTransfer.transfer_price_per_gb_override !== undefined
                      ? "Custom route price entered. Change destination region to reset to live/configured route pricing."
                      : "Auto-filled from selected route when available. Enter a value only to override."
                  }
                />
              </div>
              <div className="enterprise-note-card compact">
                <Cloud size={18} />
                <div>
                  <strong>{crossRegionTransfer.enabled ? "Cross-region DR enabled" : "Cross-region DR disabled"}</strong>
                  <span>
                    {crossRegionTransfer.enabled
                      ? "Storage is costed with a minimum 2x DR copy and transfer/access volume is added as a separate cost line."
                      : "Leave disabled when DR, replicated copies, and cross-region reads are not in scope."}
                  </span>
                  <small>
                    Current route: {dataset.region} to {crossRegionTransfer.destination_region || "destination not selected"}
                  </small>
                </div>
              </div>
            </div>
          </section>

          <section id="compute" className="panel">
            <PanelHeading title="Databricks SQL/query compute" subtitle="Warehouse and interactive query assumptions" />
            <div className="field-grid">
              <SelectField
                label="Warehouse type"
                value={sqlCompute.warehouse_type}
                onChange={(value) => setSqlCompute({ ...sqlCompute, warehouse_type: value as SQLComputeInput["warehouse_type"] })}
                options={["serverless", "pro", "classic"].map((value) => ({ value, label: titleCase(value) }))}
              />
              <SelectField
                label="Warehouse size"
                value={sqlCompute.warehouse_size}
                onChange={(value) => setSqlCompute({ ...sqlCompute, warehouse_size: value })}
                options={[
                  ...Object.entries(pricing?.databricks.sql_warehouses ?? {}).map(([key, value]) => ({ value: key, label: value.display_name })),
                  { value: "custom", label: "Custom" }
                ]}
              />
              {sqlCompute.warehouse_size === "custom" ? (
                <NumberField
                  label="Custom DBU/hour"
                  value={sqlCompute.custom_dbu_per_hour ?? 0}
                  onChange={(value) => setSqlCompute({ ...sqlCompute, custom_dbu_per_hour: value })}
                />
              ) : null}
              <NumberField label="DBU rate (internal or public list)" value={sqlCompute.dbu_rate ?? getDefaultSqlDbuRate(pricing, sqlCompute.warehouse_type)} onChange={(value) => setSqlCompute({ ...sqlCompute, dbu_rate: value })} />
              <NumberField label="Queries/month" value={sqlCompute.queries_per_month} onChange={(value) => setSqlCompute({ ...sqlCompute, queries_per_month: value })} />
              <NumberField
                label="Avg query runtime minutes"
                value={sqlCompute.average_query_runtime_minutes}
                onChange={(value) => setSqlCompute({ ...sqlCompute, average_query_runtime_minutes: value })}
              />
              <NumberField label="Concurrent users" value={sqlCompute.concurrent_users} onChange={(value) => setSqlCompute({ ...sqlCompute, concurrent_users: value })} />
              <NumberField label="Auto-stop minutes" value={sqlCompute.auto_stop_minutes} onChange={(value) => setSqlCompute({ ...sqlCompute, auto_stop_minutes: value })} />
              <SelectField
                label="Usage pattern"
                value={sqlCompute.usage_pattern}
                onChange={(value) => setSqlCompute({ ...sqlCompute, usage_pattern: value as SQLComputeInput["usage_pattern"] })}
                options={["rare", "occasional", "frequent", "high"].map((value) => ({ value, label: titleCase(value) }))}
              />
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={sqlCompute.apply_concurrency_multiplier}
                onChange={(event) => setSqlCompute({ ...sqlCompute, apply_concurrency_multiplier: event.target.checked })}
              />
              <span>Apply concurrency multiplier where relevant</span>
            </label>
          </section>

          <section className="panel" data-nav-section="compute">
            <PanelHeading title="Batch ingestion compute" subtitle="One-time archive loads, scheduled batches, scans, and refreshes" />
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={jobCompute.enabled}
                onChange={(event) => setJobCompute({ ...jobCompute, enabled: event.target.checked })}
              />
              <span>Enable batch ingestion</span>
            </label>
            <div className="field-grid">
              <SelectField
                label="Batch type"
                value={jobCompute.batch_type}
                onChange={(value) => {
                  const isOneTimeArchiveLoad = value === "one_time_archive_load";
                  setBatchDataVolumeManuallyEdited(false);
                  setJobCompute({
                    ...jobCompute,
                    batch_type: value,
                    ingestion_frequency: isOneTimeArchiveLoad ? "one-time" : jobCompute.ingestion_frequency,
                    data_volume_per_run_gb: isOneTimeArchiveLoad
                      ? roundEstimatorInput(dataset.total_data_size_gb)
                      : jobCompute.data_volume_per_run_gb
                  });
                }}
                options={[
                  { value: "one_time_archive_load", label: "One-time archive load" },
                  { value: "scheduled_batch", label: "Scheduled batch" },
                  { value: "metadata_scan", label: "Metadata scan" },
                  { value: "dashboard_refresh", label: "Dashboard refresh" }
                ]}
                disabled={!jobCompute.enabled}
              />
              <SelectField
                label="Batch frequency"
                value={jobCompute.ingestion_frequency}
                onChange={(value) => setJobCompute({ ...jobCompute, ingestion_frequency: value as JobComputeInput["ingestion_frequency"] })}
                options={["one-time", "daily", "weekly", "monthly"].map((value) => ({ value, label: titleCase(value) }))}
                disabled={!jobCompute.enabled}
              />
              <NumberField
                label="Data volume/run GB"
                value={jobCompute.data_volume_per_run_gb}
                onChange={(value) => {
                  setBatchDataVolumeManuallyEdited(true);
                  setJobCompute({ ...jobCompute, data_volume_per_run_gb: value });
                }}
                disabled={!jobCompute.enabled}
              />
              <SelectField
                label="Compute type"
                value={jobCompute.compute_type}
                onChange={(value) => setJobCompute({ ...jobCompute, compute_type: value as JobComputeInput["compute_type"] })}
                options={[
                  { value: "classic_jobs", label: "Classic Jobs" },
                  { value: "jobs_photon", label: "Classic Jobs + Photon" },
                  { value: "serverless_jobs", label: "Serverless Jobs" },
                  { value: "dlt_triggered", label: "DLT triggered" }
                ]}
                disabled={!jobCompute.enabled}
              />
              {jobCompute.compute_type === "dlt_triggered" ? (
                <SelectField
                  label="DLT tier"
                  value={jobCompute.dlt_tier}
                  onChange={(value) => setJobCompute({ ...jobCompute, dlt_tier: value as JobComputeInput["dlt_tier"] })}
                  options={[
                    { value: "core", label: "Core" },
                    { value: "pro", label: "Pro" },
                    { value: "advanced", label: "Advanced" }
                  ]}
                  disabled={!jobCompute.enabled}
                />
              ) : null}
              <SelectField
                label="Batch sizing mode"
                value={jobCompute.use_instance_sizing ? "instance" : "simple"}
                onChange={(value) => setJobCompute({ ...jobCompute, use_instance_sizing: value === "instance", include_ec2_cost: value === "instance" ? jobCompute.include_ec2_cost : false })}
                options={[
                  { value: "simple", label: "Manual DBU/hour" },
                  { value: "instance", label: "Instance-based sizing" }
                ]}
                disabled={!jobCompute.enabled || jobCompute.compute_type === "serverless_jobs"}
              />
              {jobCompute.use_instance_sizing && jobCompute.compute_type !== "serverless_jobs" ? (
                <>
                  <SelectField
                    label="Worker instance"
                    value={jobCompute.worker_instance_type}
                    onChange={(value) => setJobCompute({ ...jobCompute, worker_instance_type: value })}
                    options={getInstanceOptions(pricing)}
                    disabled={!jobCompute.enabled}
                  />
                  <NumberField label="Worker count" value={jobCompute.worker_count} onChange={(value) => setJobCompute({ ...jobCompute, worker_count: value })} disabled={!jobCompute.enabled} />
                  <SelectField
                    label="Driver instance"
                    value={jobCompute.driver_instance_type}
                    onChange={(value) => setJobCompute({ ...jobCompute, driver_instance_type: value })}
                    options={getInstanceOptions(pricing)}
                    disabled={!jobCompute.enabled}
                  />
                  <NumberField label="Driver count" value={jobCompute.driver_count} onChange={(value) => setJobCompute({ ...jobCompute, driver_count: value })} disabled={!jobCompute.enabled} />
                </>
              ) : null}
              <NumberField label="Runs/month" value={jobCompute.job_runs_per_month} onChange={(value) => setJobCompute({ ...jobCompute, job_runs_per_month: value })} disabled={!jobCompute.enabled} />
              <NumberField
                label="Avg runtime minutes"
                value={jobCompute.average_job_runtime_minutes}
                onChange={(value) => setJobCompute({ ...jobCompute, average_job_runtime_minutes: value })}
                disabled={!jobCompute.enabled}
              />
              <SelectField
                label="Batch cluster size"
                value={jobCompute.job_cluster_size}
                onChange={(value) => setJobCompute({ ...jobCompute, job_cluster_size: value })}
                options={[
                  ...Object.entries(pricing?.databricks.jobs ?? {}).map(([key, value]) => ({ value: key, label: value.display_name })),
                  { value: "custom", label: "Custom" }
                ]}
                disabled={!jobCompute.enabled}
              />
              {jobCompute.job_cluster_size === "custom" ? (
                <NumberField
                  label="Custom batch DBU/hour"
                  value={jobCompute.custom_dbu_per_hour ?? 0}
                  onChange={(value) => setJobCompute({ ...jobCompute, custom_dbu_per_hour: value })}
                  disabled={!jobCompute.enabled}
                />
              ) : null}
              <NumberField label="Batch DBU rate" value={jobCompute.dbu_rate ?? getDefaultBatchDbuRate(pricing, jobCompute.compute_type, jobCompute.dlt_tier)} onChange={(value) => setJobCompute({ ...jobCompute, dbu_rate: value })} disabled={!jobCompute.enabled} />
              <NumberField label="Pipelines/jobs" value={jobCompute.number_of_jobs} onChange={(value) => setJobCompute({ ...jobCompute, number_of_jobs: value })} disabled={!jobCompute.enabled} />
              <NumberField label="OPTIMIZE / compaction runs" value={jobCompute.compaction_runs_per_month} onChange={(value) => setJobCompute({ ...jobCompute, compaction_runs_per_month: value })} disabled={!jobCompute.enabled} />
              <NumberField label="Avg compaction runtime minutes" value={jobCompute.average_compaction_runtime_minutes} onChange={(value) => setJobCompute({ ...jobCompute, average_compaction_runtime_minutes: value })} disabled={!jobCompute.enabled || jobCompute.compaction_runs_per_month === 0} />
            </div>
            {jobCompute.use_instance_sizing && jobCompute.compute_type !== "serverless_jobs" ? (
              <div className="streaming-toggles">
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={jobCompute.include_ec2_cost}
                    onChange={(event) => setJobCompute({ ...jobCompute, include_ec2_cost: event.target.checked })}
                    disabled={!jobCompute.enabled}
                  />
                  <span>Include EC2 cost from selected driver/workers</span>
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={jobCompute.photon_enabled || jobCompute.compute_type === "jobs_photon"}
                    onChange={(event) => setJobCompute({ ...jobCompute, photon_enabled: event.target.checked, compute_type: event.target.checked ? "jobs_photon" : "classic_jobs" })}
                    disabled={!jobCompute.enabled || jobCompute.compute_type === "dlt_triggered"}
                  />
                  <span>Use Photon DBU mapping where supported</span>
                </label>
              </div>
            ) : null}
            <div className="enterprise-note-card compact">
              <Database size={18} />
              <div>
                <strong>{jobCompute.ingestion_frequency === "one-time" ? "One-time load is not annualized" : "Recurring batch workload"}</strong>
                <span>
                  {jobCompute.ingestion_frequency === "one-time"
                    ? "Useful for archive migration or initial backfill. The cost appears as a one-time load card, not monthly recurring spend."
                    : "Use this for scheduled file ingestion, table refreshes, scans, compaction, or reporting jobs."}
                </span>
                <small>Batch data volume: {jobCompute.data_volume_per_run_gb} GB/run</small>
              </div>
            </div>
          </section>

          <section className="panel streaming-panel" data-nav-section="compute">
            <PanelHeading title="Streaming ingestion compute" subtitle="Kafka, Pulsar, CDC, Lakeflow, DLT, and API ingestion" />
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={streamingIngestion.enabled}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  setStreamingIngestion({
                    ...streamingIngestion,
                    enabled,
                    monthly_data_gb: enabled && streamingIngestion.monthly_data_gb === null
                      ? roundEstimatorInput(streamingIngestion.daily_data_gb * streamingIngestion.days_per_month)
                      : streamingIngestion.monthly_data_gb
                  });
                }}
              />
              <span>Enable streaming ingestion</span>
            </label>
            <div className="field-grid">
              <SelectField
                label="Source type"
                value={streamingIngestion.source_type}
                onChange={(value) => {
                  const nextSource = value as StreamingIngestionInput["source_type"];
                  setStreamingIngestion({
                    ...streamingIngestion,
                    source_type: nextSource,
                    ingestion_product:
                      nextSource === "api_webhook"
                        ? "zerobus_ingest"
                        : nextSource === "object_store"
                          ? "structured_streaming"
                        : nextSource === "saas_connector" || nextSource === "cdc_database"
                          ? "lakeflow_connect"
                          : streamingIngestion.ingestion_product === "zerobus_ingest"
                            ? "structured_streaming"
                            : streamingIngestion.ingestion_product
                  });
                }}
                options={[
                  { value: "kafka", label: "Kafka" },
                  { value: "pulsar", label: "Pulsar" },
                  { value: "kinesis", label: "Kinesis" },
                  { value: "event_hubs", label: "Event Hubs" },
                  { value: "cdc_database", label: "CDC database" },
                  { value: "saas_connector", label: "SaaS connector" },
                  { value: "object_store", label: "Object store / Auto Loader" },
                  { value: "api_webhook", label: "API / webhook" },
                  { value: "on_prem_system", label: "On-premises system" },
                  { value: "other", label: "Other" }
                ]}
                disabled={!streamingIngestion.enabled}
              />
              <SelectField
                label="Streaming compute type"
                value={streamingIngestion.ingestion_product}
                onChange={(value) => {
                  const nextProduct = value as StreamingIngestionInput["ingestion_product"];
                  setStreamingIngestion({
                    ...streamingIngestion,
                    ingestion_product: nextProduct,
                    use_instance_sizing: nextProduct === "structured_streaming" || nextProduct === "dlt_continuous",
                    include_ec2_cost: nextProduct === "structured_streaming" ? streamingIngestion.include_ec2_cost : false
                  });
                }}
                options={[
                  { value: "structured_streaming", label: "Spark Structured Streaming" },
                  { value: "dlt_continuous", label: "DLT continuous" },
                  { value: "lakeflow_connect", label: "Lakeflow Connect" },
                  { value: "zerobus_ingest", label: "Zerobus Ingest" }
                ]}
                disabled={!streamingIngestion.enabled}
              />
              <SelectField
                label="Source location"
                value={streamingIngestion.source_location}
                onChange={(value) => {
                  setStreamingNetworkPriceManuallyEdited(false);
                  setStreamingIngestion({
                    ...streamingIngestion,
                    source_location: value as StreamingIngestionInput["source_location"],
                    source_transfer_price_per_gb_override: null
                  });
                }}
                options={[
                  { value: "same_az", label: "Same AZ" },
                  { value: "same_region_cross_az", label: "Same region, cross-AZ" },
                  { value: "different_region", label: "Different region" },
                  { value: "on_prem_internet", label: "On-prem / internet" }
                ]}
                disabled={!streamingIngestion.enabled}
              />
              <SelectField
                label="Trigger interval"
                value={streamingIngestion.trigger_interval}
                onChange={(value) => setStreamingIngestion({ ...streamingIngestion, trigger_interval: value })}
                options={[
                  { value: "continuous", label: "Continuous" },
                  { value: "processing_time", label: "processingTime" },
                  { value: "available_now", label: "availableNow" }
                ]}
                disabled={!streamingIngestion.enabled}
              />
              {streamingIngestion.ingestion_product === "dlt_continuous" ? (
                <SelectField
                  label="DLT tier"
                  value={streamingIngestion.dlt_tier}
                  onChange={(value) => setStreamingIngestion({ ...streamingIngestion, dlt_tier: value as StreamingIngestionInput["dlt_tier"] })}
                  options={[
                    { value: "core", label: "Core" },
                    { value: "pro", label: "Pro" },
                    { value: "advanced", label: "Advanced" }
                  ]}
                  disabled={!streamingIngestion.enabled}
                />
              ) : null}
              <NumberField
                label="Daily data ingested GB"
                value={streamingIngestion.daily_data_gb}
                onChange={(value) => setStreamingIngestion({
                  ...streamingIngestion,
                  daily_data_gb: value,
                  monthly_data_gb: roundEstimatorInput(value * streamingIngestion.days_per_month)
                })}
                disabled={!streamingIngestion.enabled}
              />
              <NumberField
                label="Monthly data ingested GB"
                value={streamingIngestion.monthly_data_gb ?? streamingIngestion.daily_data_gb * streamingIngestion.days_per_month}
                onChange={(value) => setStreamingIngestion({ ...streamingIngestion, monthly_data_gb: value })}
                disabled={!streamingIngestion.enabled}
              />
              <SelectField
                label="Runtime pattern"
                value={streamingIngestion.runtime_pattern}
                onChange={(value) => {
                  const pattern = value as StreamingIngestionInput["runtime_pattern"];
                  setStreamingIngestion({
                    ...streamingIngestion,
                    runtime_pattern: pattern,
                    hours_per_day: pattern === "always_on" ? 24 : pattern === "business_hours" ? 10 : streamingIngestion.hours_per_day,
                    monthly_runtime_hours: pattern === "always_on" ? 730 : pattern === "business_hours" ? 220 : streamingIngestion.monthly_runtime_hours
                  });
                }}
                options={[
                  { value: "always_on", label: "24/7 always-on" },
                  { value: "business_hours", label: "Business hours" },
                  { value: "custom", label: "Custom" }
                ]}
                disabled={!streamingIngestion.enabled}
              />
              <NumberField label="Hours/day" value={streamingIngestion.hours_per_day} onChange={(value) => setStreamingIngestion({ ...streamingIngestion, hours_per_day: value })} disabled={!streamingIngestion.enabled} />
              <NumberField label="Days/month" value={streamingIngestion.days_per_month} onChange={(value) => setStreamingIngestion({
                ...streamingIngestion,
                days_per_month: value,
                monthly_data_gb: roundEstimatorInput(streamingIngestion.daily_data_gb * value)
              })} disabled={!streamingIngestion.enabled} />
              <NumberField
                label="Runtime hours/month"
                value={streamingIngestion.monthly_runtime_hours ?? streamingIngestion.hours_per_day * streamingIngestion.days_per_month}
                onChange={(value) => setStreamingIngestion({ ...streamingIngestion, monthly_runtime_hours: value })}
                disabled={!streamingIngestion.enabled}
              />
              <NumberField label="Streams/pipelines" value={streamingIngestion.number_of_streams} onChange={(value) => setStreamingIngestion({ ...streamingIngestion, number_of_streams: value })} disabled={!streamingIngestion.enabled} />
              {streamingIngestion.ingestion_product === "structured_streaming" || streamingIngestion.ingestion_product === "dlt_continuous" ? (
                <SelectField
                  label="Streaming sizing mode"
                  value={streamingIngestion.use_instance_sizing ? "instance" : "simple"}
                  onChange={(value) => setStreamingIngestion({ ...streamingIngestion, use_instance_sizing: value === "instance" })}
                  options={[
                    { value: "instance", label: "Instance-based sizing" },
                    { value: "simple", label: "Manual DBU/hour" }
                  ]}
                  disabled={!streamingIngestion.enabled}
                />
              ) : null}
              {streamingIngestion.use_instance_sizing && (streamingIngestion.ingestion_product === "structured_streaming" || streamingIngestion.ingestion_product === "dlt_continuous") ? (
                <>
                  <SelectField
                    label="Worker instance"
                    value={streamingIngestion.worker_instance_type}
                    onChange={(value) => setStreamingIngestion({ ...streamingIngestion, worker_instance_type: value })}
                    options={getInstanceOptions(pricing)}
                    disabled={!streamingIngestion.enabled}
                  />
                  <NumberField label="Worker count" value={streamingIngestion.worker_count} onChange={(value) => setStreamingIngestion({ ...streamingIngestion, worker_count: value })} disabled={!streamingIngestion.enabled} />
                  <SelectField
                    label="Driver instance"
                    value={streamingIngestion.driver_instance_type}
                    onChange={(value) => setStreamingIngestion({ ...streamingIngestion, driver_instance_type: value })}
                    options={getInstanceOptions(pricing)}
                    disabled={!streamingIngestion.enabled}
                  />
                  <NumberField label="Driver count" value={streamingIngestion.driver_count} onChange={(value) => setStreamingIngestion({ ...streamingIngestion, driver_count: value })} disabled={!streamingIngestion.enabled} />
                </>
              ) : null}
              {streamingIngestion.ingestion_product !== "zerobus_ingest" ? (
                <>
                  <NumberField label="Streaming DBU/hour" value={streamingIngestion.dbu_per_hour} onChange={(value) => setStreamingIngestion({ ...streamingIngestion, dbu_per_hour: value })} disabled={!streamingIngestion.enabled || streamingIngestion.use_instance_sizing} />
                  <NumberField label="Streaming DBU rate" value={streamingIngestion.dbu_rate ?? getDefaultStreamingDbuRate(pricing, streamingIngestion.ingestion_product, streamingIngestion.dlt_tier, streamingIngestion.photon_enabled)} onChange={(value) => setStreamingIngestion({ ...streamingIngestion, dbu_rate: value })} disabled={!streamingIngestion.enabled} />
                  <NumberField label="EC2 hourly cost" value={streamingIngestion.ec2_hourly_cost} onChange={(value) => setStreamingIngestion({ ...streamingIngestion, ec2_hourly_cost: value })} disabled={!streamingIngestion.enabled || !streamingIngestion.include_ec2_cost || streamingIngestion.use_instance_sizing} />
                </>
              ) : (
                <NumberField label="Zerobus price/GB" value={pricing?.databricks.lakeflow_connect?.zerobus_ingest_price_per_gb ?? 0.072} onChange={() => undefined} disabled />
              )}
              <NumberField
                label="Source transfer GB/month"
                value={streamingIngestion.source_transfer_gb_per_month ?? streamingIngestion.monthly_data_gb ?? streamingIngestion.daily_data_gb * streamingIngestion.days_per_month}
                onChange={(value) => setStreamingIngestion({ ...streamingIngestion, source_transfer_gb_per_month: value })}
                disabled={!streamingIngestion.enabled}
              />
              <NumberField
                label="Network transfer price/GB"
                value={
                  streamingIngestion.source_transfer_price_per_gb_override ??
                  getSourceTransferPricePerGb(pricing, streamingIngestion.source_location)
                }
                onChange={(value) => {
                  setStreamingNetworkPriceManuallyEdited(true);
                  setStreamingIngestion({ ...streamingIngestion, source_transfer_price_per_gb_override: value });
                }}
                disabled={!streamingIngestion.enabled}
                hint={
                  streamingNetworkPriceManuallyEdited
                    ? "Custom value entered. Change Source location to reset back to the configured network rate."
                    : "Auto-filled from Source location. Typical values: 0 same AZ, 0.01 same-region cross-AZ, 0.02 different region."
                }
              />
            </div>
            <div className="streaming-toggles">
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={streamingIngestion.include_ec2_cost}
                  onChange={(event) => setStreamingIngestion({ ...streamingIngestion, include_ec2_cost: event.target.checked })}
                  disabled={!streamingIngestion.enabled || streamingIngestion.ingestion_product === "zerobus_ingest"}
                />
                <span>Include classic cluster EC2 cost</span>
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={streamingIngestion.photon_enabled}
                  onChange={(event) => setStreamingIngestion({ ...streamingIngestion, photon_enabled: event.target.checked })}
                  disabled={!streamingIngestion.enabled || streamingIngestion.ingestion_product === "lakeflow_connect" || streamingIngestion.ingestion_product === "zerobus_ingest"}
                />
                <span>Use Photon DBU mapping where supported</span>
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={!streamingIngestion.free_tier_already_consumed}
                  onChange={(event) => setStreamingIngestion({ ...streamingIngestion, free_tier_already_consumed: !event.target.checked })}
                  disabled={!streamingIngestion.enabled || streamingIngestion.ingestion_product !== "lakeflow_connect"}
                />
                <span>Apply Lakeflow free DBU tier</span>
              </label>
            </div>
            <div className="enterprise-note-card compact">
              <Cloud size={18} />
              <div>
                <strong>{streamingProductTitle(streamingIngestion.ingestion_product)}</strong>
                <span>{streamingProductGuidance(streamingIngestion.source_type, streamingIngestion.ingestion_product)}</span>
                <small>
                  Runtime: {streamingIngestion.monthly_runtime_hours ?? streamingIngestion.hours_per_day * streamingIngestion.days_per_month}h/month x {streamingIngestion.number_of_streams} stream(s)
                </small>
              </div>
            </div>
          </section>

          <section className="panel ai-panel" data-nav-section="compute">
            <PanelHeading title="Optional AI/BI layer" subtitle="Future Genie-style natural-language question workload" />
            <label className="toggle-row">
              <input type="checkbox" checked={aiBi.enabled} onChange={(event) => setAiBi({ ...aiBi, enabled: event.target.checked })} />
              <span>Enable AI/BI/Genie-style scenario</span>
            </label>
            <div className="field-grid">
              <NumberField label="Expected users" value={aiBi.expected_users} onChange={(value) => setAiBi({ ...aiBi, expected_users: value })} disabled={!aiBi.enabled} />
              <NumberField
                label="Questions/user/month"
                value={aiBi.questions_per_user_per_month}
                onChange={(value) => setAiBi({ ...aiBi, questions_per_user_per_month: value })}
                disabled={!aiBi.enabled}
              />
              <NumberField
                label="Avg runtime/question minutes"
                value={aiBi.average_runtime_minutes_per_question}
                onChange={(value) => setAiBi({ ...aiBi, average_runtime_minutes_per_question: value })}
                disabled={!aiBi.enabled}
              />
              <NumberField label="AI/BI DBU/hour" value={aiBi.dbu_per_hour} onChange={(value) => setAiBi({ ...aiBi, dbu_per_hour: value })} disabled={!aiBi.enabled} />
              <NumberField label="AI/BI DBU rate (internal or public list)" value={aiBi.dbu_rate ?? getDefaultAiBiDbuRate(pricing)} onChange={(value) => setAiBi({ ...aiBi, dbu_rate: value })} disabled={!aiBi.enabled} />
            </div>
            <div className="support-panel embedded-support-panel">
              <PanelHeading title="Support and discounts" subtitle="Optional commercial adjustments" />
              <div className="field-grid compact">
                <NumberField
                  label="Support cost %"
                  value={supportCost.support_cost_percentage}
                  onChange={(value) => setSupportCost({ ...supportCost, support_cost_percentage: value })}
                />
                <NumberField
                  label="Databricks discount %"
                  value={supportCost.databricks_discount_percentage}
                  onChange={(value) => setSupportCost({ ...supportCost, databricks_discount_percentage: value })}
                />
                <NumberField
                  label="Cloud discount %"
                  value={supportCost.cloud_discount_percentage}
                  onChange={(value) => setSupportCost({ ...supportCost, cloud_discount_percentage: value })}
                />
              </div>
              <div className="enterprise-note-card compact">
                <ShieldAlert size={18} />
                <div>
                  <strong>Discounts default to 0%</strong>
                  <span>
                    Discounts are not included unless entered here. Databricks discount applies to DBU compute; cloud discount applies to storage and cross-region DR.
                  </span>
                  <small>
                    Support uplift: {supportCost.support_cost_percentage}% after discounts, before buffer
                  </small>
                </div>
              </div>
            </div>
          </section>

          <section id="recommendation" className="panel recommendation-panel">
            <div className="recommendation-layout">
              <div className="recommendation-main">
                <p className="eyebrow">Scenario recommendation</p>
                <h3>{scenarioRecommendation.title}</h3>
                <p>{scenarioRecommendation.summary}</p>
                <div className="recommendation-actions">
                  <span className={`source-badge ${scenarioRecommendation.key === selectedScenario ? "live" : "manual"}`}>
                    {scenarioRecommendation.key === selectedScenario ? "Currently selected" : "Suggested scenario"}
                  </span>
                  <button
                    className="primary-button"
                    onClick={() => applyScenario(scenarioRecommendation.key)}
                    disabled={scenarioRecommendation.key === selectedScenario || !scenarios[scenarioRecommendation.key]}
                  >
                    Apply recommendation <ArrowRight size={16} />
                  </button>
                </div>
              </div>
              <div className="recommendation-reasons">
                {scenarioRecommendation.reasons.map((reason) => (
                  <div key={reason}>
                    <BadgeCheck size={16} />
                    <span>{reason}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section id="assumptions" className="panel assumptions-panel">
            <PanelHeading title="Assumptions and notes" subtitle="Pricing inputs used in this estimate" />
            {estimate ? (
              <>
                <PricingSourcePanel estimate={estimate} pricing={pricing} />
                <dl className="assumption-list">
                  {Object.entries(estimate.assumptions).map(([key, value]) => (
                    <div key={key}>
                      <dt>{labelize(key)}</dt>
                      <dd>{String(value)}</dd>
                    </div>
                  ))}
                </dl>
                <div className="component-assumptions">
                  {estimate.components.map((component) => (
                    <details key={component.label}>
                      <summary>{component.label}</summary>
                      <dl className="assumption-list dense">
                        {Object.entries(component.assumptions).map(([key, value]) => (
                          <div key={key}>
                            <dt>{labelize(key)}</dt>
                            <dd>{String(value)}</dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  ))}
                </div>
                <p className="disclaimer">{estimate.disclaimer}</p>
                <p className="timestamp">Generated {new Date(estimate.generated_at).toLocaleString()}</p>
              </>
            ) : (
              <p className="empty-note">Complete the required inputs to generate an assumptions summary.</p>
            )}
          </section>
        </div>
          </>
        )}
      </section>
    </main>
  );
}

function LoginPage({
  username,
  password,
  error,
  isSubmitting,
  onUsernameChange,
  onPasswordChange,
  onSubmit
}: {
  username: string;
  password: string;
  error: string | null;
  isSubmitting: boolean;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <main className={`login-shell ${isSubmitting ? "signing-in" : ""}`}>
      <div className="login-experience">
        <section className="login-visual" aria-label="Databricks cost planning illustration">
          <div className="night-sky" aria-hidden="true">
            <span className="star star-one" />
            <span className="star star-two" />
            <span className="star star-three" />
            <span className="moon" />
            <span className="cloud cloud-one" />
            <span className="cloud cloud-two" />
          </div>
          <div className="blueprint-scene" aria-hidden="true">
            <div className="platform-tower tower-small">
              <span />
              <span />
              <span />
            </div>
            <div className="platform-tower tower-large">
              <span />
              <span />
              <span />
              <span />
            </div>
            <div className="mountain ridge-back" />
            <div className="mountain ridge-front" />
            <div className="water-plane" />
            <div className="data-light light-one" />
            <div className="data-light light-two" />
            <div className="data-light light-three" />
          </div>
        </section>

        <section className="login-panel">
          <div className="login-brand">
            <Database aria-hidden="true" />
            <div>
              <p className="eyebrow">Internal platform tool</p>
              <h1>Databricks Cost Estimator</h1>
            </div>
          </div>
          <div className="login-copy">
            <h2>Sign in</h2>
            <p>Continue to the Knowledge Base and scenario planner.</p>
          </div>
          <form className="login-form" onSubmit={onSubmit}>
            <label className="field">
              <span>Username</span>
              <input
                type="text"
                autoComplete="username"
                value={username}
                onChange={(event) => onUsernameChange(event.target.value)}
                disabled={isSubmitting}
              />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => onPasswordChange(event.target.value)}
                disabled={isSubmitting}
              />
            </label>
            {error ? <div className="login-error">{error}</div> : null}
            <button type="submit" className="primary-button login-submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 size={16} className="spin-icon" /> Preparing estimator
                </>
              ) : (
                "Sign in"
              )}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}

function KnowledgeBasePage({ onBack }: { onBack: () => void }) {
  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">Knowledge Base</p>
          <h2>Estimator field guide</h2>
        </div>
        <div className="topbar-actions">
          <button className="primary-button" onClick={onBack}>
            Open estimator
          </button>
        </div>
      </header>

      <section className="section knowledge-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Before you estimate</p>
            <h3>What each input means</h3>
          </div>
        </div>
        <div className="knowledge-grid">
          <KnowledgeCard
            title="Scenario"
            rows={[
              ["Archive-only", "Storage-led estimate with no persistent SQL warehouse."],
              ["Basic query", "Low query volume for occasional ad hoc access."],
              ["Scheduled reporting", "Recurring jobs, report refreshes, and light SQL usage."],
              ["Self-service analytics", "Higher user count, query frequency, and compute footprint."],
              ["Future AI/BI", "Optional future natural-language question workload. Disabled unless enabled."]
            ]}
          />
          <KnowledgeCard
            title="Dataset"
            rows={[
              ["Team name", "Owning team or cost center for the estimate."],
              ["Brand or dataset name", "A business-friendly dataset label."],
              ["Cloud provider and region", "Determines which live storage pricing source or fallback is used."],
              ["Total data size GB", "Metadata-derived size of the dataset, not raw file upload."],
              ["File counts", "Used for object monitoring, per-file metrics, and archive/document split."],
              ["Annual growth %", "Models average storage growth over the year."],
              ["Environments", "Multiplier for dev, test, prod, or other deployed copies."],
              ["Redundancy model", "Business-friendly choice for single-copy, backup-copy, or custom storage assumptions."],
              ["Storage copy multiplier", "Numeric backup or replication multiplier applied to storage."]
            ]}
          />
          <KnowledgeCard
            title="Storage"
            rows={[
              ["Storage class", "Cloud object storage tier such as S3 Standard, ADLS Hot, or GCP Nearline. AWS and Azure storage prices are fetched live where available."],
              ["Read/write requests", "Optional request volume for request-based storage charges."],
              ["Buffer %", "Contingency added to the total estimate for uncertainty."],
              ["Cross-region DR", "Optional destination-region copy plus changed-data transfer and cross-region read assumptions."]
            ]}
          />
          <KnowledgeCard
            title="Databricks SQL"
            rows={[
              ["Warehouse type", "Serverless, Pro, or Classic warehouse assumption."],
              ["Warehouse size", "Configured DBU/hour size, or custom DBU/hour when needed."],
              ["DBU rate", "Editable price per DBU from an internal rate card or public Databricks list-pricing reference."],
              ["Queries/month", "Expected monthly interactive or dashboard query count."],
              ["Runtime minutes", "Average active compute time per query."],
              ["Concurrent users", "Use 0 for storage-only/archive estimates with no SQL access; otherwise enter expected concurrent users."],
              ["Auto-stop minutes", "Recorded as an operating assumption for warehouse behavior."]
            ]}
          />
          <KnowledgeCard
            title="Batch ingestion"
            rows={[
              ["Enable toggle", "Keeps batch migration or scheduled pipeline cost out unless it is in scope."],
              ["Batch type", "One-time archive load, scheduled batch, metadata scan, or dashboard refresh."],
              ["Frequency", "One-time, daily, weekly, or monthly cadence."],
              ["Data volume/run", "GB processed in each batch run. For one-time archive loads this should usually match Total data size GB."],
              ["Batch sizing mode", "Manual DBU/hour uses a directly entered DBU/hour or named job size. Instance-based sizing uses worker/driver instances and can include EC2."],
              ["Runs/month", "How many batch executions happen in a typical month."],
              ["Runtime minutes", "Average active job cluster runtime per execution."],
              ["Compute type", "Classic Jobs, Serverless Jobs, or DLT triggered pipeline."],
              ["Cluster size", "Configured batch cluster DBU/hour size, or custom DBU/hour."],
              ["Pipelines/jobs", "Multiplier for multiple ingestion or refresh pipelines."],
              ["OPTIMIZE / compaction runs", "Optional Delta maintenance after ingest. Use 0 for archive-only storage; use 1 when converting many files into queryable Delta tables."]
            ]}
          />
          <KnowledgeCard
            title="Streaming ingestion"
            rows={[
              ["Enable toggle", "Adds a separate always-on or long-running streaming cost line."],
              ["Source type", "Kafka, Pulsar, Kinesis, Event Hubs, CDC, SaaS connector, API/webhook, or other."],
              ["Streaming compute type", "Spark Structured Streaming, DLT continuous, Lakeflow Connect, or Zerobus Ingest."],
              ["Daily/monthly GB", "Approximate ingested data volume used for throughput and per-GB products."],
              ["Runtime pattern", "24/7, business hours, or custom active hours per day."],
              ["Streams/pipelines", "Multiplier for multiple independent streaming jobs."],
              ["EC2 cost", "Optional classic cluster infrastructure cost when it should be shown separately."]
            ]}
          />
          <KnowledgeCard
            title="AI/BI optional layer"
            rows={[
              ["Enable toggle", "Keeps AI/BI out of the baseline unless explicitly selected."],
              ["Expected users", "Users who may ask natural-language questions."],
              ["Questions/user/month", "Monthly question volume per user."],
              ["Runtime/question", "Average compute runtime for each AI/BI question."],
              ["DBU/hour and DBU rate", "Compute and pricing assumptions for the optional layer."]
            ]}
          />
          <KnowledgeCard
            title="Support and discounts"
            rows={[
              ["Support cost %", "Optional percentage applied after discounts and before buffer."],
              ["Databricks discount %", "Optional discount applied to SQL, jobs, and AI/BI compute costs."],
              ["Cloud discount %", "Optional discount applied to storage and cross-region DR costs."],
              ["Default", "All values default to 0%, so discounts are not included unless populated."]
            ]}
          />
          <KnowledgeCard
            title="Results"
            rows={[
              ["Monthly estimate", "Storage, SQL compute, jobs, optional AI/BI, DR, and support combined."],
              ["Annual estimate", "Monthly estimate multiplied by 12."],
              ["With buffer", "Estimate after applying the selected buffer percentage."],
              ["Cost per GB", "Monthly total divided by dataset size."],
              ["Cost per 1,000 files", "Monthly total normalized by file count."]
            ]}
          />
        </div>
      </section>

      <section className="section knowledge-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Scenario examples</p>
            <h3>What values should I enter?</h3>
          </div>
        </div>
        <div className="scenario-guide-grid">
          <ScenarioGuideCard
            title="Only archive"
            subtitle="Store legacy data, no Databricks processing"
            intent="Use when the requirement is retention or migration into object storage only."
            values={[
              ["Scenario", "Archive-only"],
              ["Batch ingestion", "Disabled"],
              ["SQL queries/month", "0"],
              ["Streaming ingestion", "Disabled"],
              ["Storage copy multiplier", "1x or 2x depending on backup requirement"],
              ["OPTIMIZE / compaction", "0"]
            ]}
            outcome="Costs are mostly storage, request, environment, backup, and buffer assumptions."
          />
          <ScenarioGuideCard
            title="Archive plus batch"
            subtitle="One-time load, backfill, conversion, or scheduled refresh"
            intent="Use when Databricks is needed to copy, convert, register, validate, scan, or refresh data."
            values={[
              ["Scenario", "Basic query or Scheduled reporting"],
              ["Batch ingestion", "Enabled"],
              ["Batch type", "One-time archive load for migration; Scheduled batch for recurring work"],
              ["Data volume/run GB", "For one-time load, use Total data size GB. For recurring jobs, use changed data per run."],
              ["Runs/month", "1 for one-time estimate; daily is about 30, weekly about 4, monthly is 1"],
              ["Avg runtime minutes", "30-60 for light jobs; 120+ for heavy conversion or validation"],
              ["Pipelines/jobs", "1 unless multiple brand or source pipelines run separately"],
              ["OPTIMIZE / compaction", "0 for raw archive; 1 if creating/querying Delta tables"]
            ]}
            outcome="Costs include storage plus one-time or recurring Databricks Jobs compute."
          />
          <ScenarioGuideCard
            title="Archive plus batch plus streaming"
            subtitle="Historical backfill plus long-running ingestion"
            intent="Use when there is an initial archive/backfill and an ongoing Kafka, Pulsar, CDC, Event Hubs, or Kinesis feed."
            values={[
              ["Scenario", "Scheduled reporting or Self-service analytics"],
              ["Batch ingestion", "Enabled for initial backfill or recurring file jobs"],
              ["Streaming ingestion", "Enabled"],
              ["Source type", "Kafka/Pulsar/Kinesis/Event Hubs/CDC based on the actual source"],
              ["Runtime pattern", "24/7 always-on for continuous streams; business hours or custom for limited windows"],
              ["Daily data ingested GB", "Expected daily feed volume, not historical archive size"],
              ["Streams/pipelines", "Number of independent streaming pipelines"],
              ["Sizing mode", "Use instance-based sizing when driver/worker shape is known"]
            ]}
            outcome="Costs include storage, batch compute, streaming compute, optional EC2, support uplift, discounts, and buffer."
          />
        </div>
      </section>

      <section className="section knowledge-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Formula examples</p>
            <h3>How the estimator turns inputs into costs</h3>
          </div>
        </div>
        <div className="formula-grid">
          <FormulaExampleCard
            title="Storage monthly cost"
            formula="GB x price/GB-month x replication x environments"
            example="100 GB x $0.023 x 1.5 x 2 = $6.90/month"
            note="Annual growth is averaged into effective GB before this storage calculation."
          />
          <FormulaExampleCard
            title="SQL warehouse compute"
            formula="DBU/hour x DBU rate x query hours"
            example="2 DBU/hour x $0.70 x (300 queries x 4 min / 60) = $28/month"
            note="If the concurrency multiplier is enabled, query hours are multiplied by the configured concurrency factor."
          />
          <FormulaExampleCard
            title="Cross-region DR"
            formula="transfer GB x transfer price/GB + optional initial replication amortization"
            example="(30 changed GB + 20 read GB) x $0.02 + ($6 initial / 12 months) = $1.50/month"
            note="When enabled, DR storage is also costed at a minimum 2x storage copy multiplier."
          />
          <FormulaExampleCard
            title="Batch ingestion compute"
            formula="DBU/hour x DBU rate x job hours x number of jobs"
            example="4 DBU/hour x $0.26 x (30 runs x 20 min / 60) x 2 jobs = $20.80/month"
            note="One-time archive loads are shown separately and are not annualized as recurring monthly spend."
          />
          <FormulaExampleCard
            title="Streaming ingestion compute"
            formula="DBU/hour x DBU rate x hours/day x days/month x streams"
            example="4 DBU/hour x $0.26 x 24 x 30 x 1 = $748.80/month"
            note="Use this for Kafka, Pulsar, CDC, and continuously running ingestion pipelines. Zerobus uses GB ingested instead."
          />
          <FormulaExampleCard
            title="Optional AI/BI layer"
            formula="DBU/hour x DBU rate x question hours"
            example="16 DBU/hour x $0.70 x (25 users x 20 questions x 2 min / 60) = $186.67/month"
            note="This layer is excluded from baseline estimates unless the AI/BI toggle is enabled."
          />
          <FormulaExampleCard
            title="Support uplift"
            formula="discounted subtotal x support %"
            example="$1,000 x 10% = $100/month"
            note="Support is percentage-only and is added after discount adjustment but before buffer."
          />
          <FormulaExampleCard
            title="Buffer"
            formula="total monthly estimate x (1 + buffer %)"
            example="$1,000 x 1.15 = $1,150/month with a 15% buffer"
            note="The buffer is a contingency for uncertainty. It is not a replacement for FinOps validation."
          />
          <FormulaExampleCard
            title="Unit metrics"
            formula="total monthly estimate / dataset size or file count"
            example="$1,000 / 100 GB = $10 per GB/month; $1,000 / 50 = $20 per 1,000 files"
            note="Cost per 1,000 files divides the monthly total by file count expressed in thousands."
          />
        </div>
      </section>
    </>
  );
}

function ScenarioGuideCard({
  title,
  subtitle,
  intent,
  values,
  outcome
}: {
  title: string;
  subtitle: string;
  intent: string;
  values: Array<[string, string]>;
  outcome: string;
}) {
  return (
    <article className="scenario-guide-card">
      <header>
        <span>{subtitle}</span>
        <h4>{title}</h4>
      </header>
      <p>{intent}</p>
      <dl>
        {values.map(([label, description]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{description}</dd>
          </div>
        ))}
      </dl>
      <footer>{outcome}</footer>
    </article>
  );
}

function KpiCard({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <article className={`kpi-card ${strong ? "strong" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function SavedEstimatesModal({
  estimates,
  loading,
  search,
  currency,
  onSearchChange,
  onClose,
  onOpen,
  onCopy,
  onDelete
}: {
  estimates: SavedEstimateSummary[];
  loading: boolean;
  search: string;
  currency: string;
  onSearchChange: (value: string) => void;
  onClose: () => void;
  onOpen: (estimateId: string) => void;
  onCopy: (estimateId: string) => void;
  onDelete: (savedEstimate: SavedEstimateSummary) => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="saved-estimates-modal" role="dialog" aria-modal="true" aria-labelledby="saved-estimates-title">
        <header>
          <div>
            <p className="eyebrow">Saved estimates</p>
            <h3 id="saved-estimates-title">Load a saved estimate</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close saved estimates">
            <X size={18} />
          </button>
        </header>
        <label className="saved-search">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search team, dataset, scenario, or ID"
          />
        </label>
        <div className="saved-estimates-list">
          {loading ? (
            <div className="saved-empty-state">
              <Loader2 size={18} className="spin" />
              <span>Loading saved estimates...</span>
            </div>
          ) : estimates.length === 0 ? (
            <div className="saved-empty-state">
              <Database size={18} />
              <span>No saved estimates found. Save the current estimate to create the first one.</span>
            </div>
          ) : (
            estimates.map((savedEstimate) => (
              <article className="saved-estimate-row" key={savedEstimate.id}>
                <div>
                  <strong>{savedEstimate.title}</strong>
                  <span>{savedEstimate.team_name} / {savedEstimate.dataset_name}</span>
                  <small>
                    {savedEstimate.scenario_title} / Updated {new Date(savedEstimate.updated_at).toLocaleString()} / ID {savedEstimate.id}
                  </small>
                </div>
                <div className="saved-estimate-cost">
                  <strong>{money(savedEstimate.total_monthly_estimate, currency)}</strong>
                  <span>{money(savedEstimate.estimate_with_buffer_annual, currency)} buffered annual</span>
                </div>
                <div className="saved-estimate-actions">
                  <button className="ghost-button compact" onClick={() => onCopy(savedEstimate.id)}>
                    <Copy size={14} /> Copy link
                  </button>
                  <button className="primary-button compact" onClick={() => onOpen(savedEstimate.id)}>
                    Open
                  </button>
                  <button
                    className="icon-button danger"
                    onClick={() => onDelete(savedEstimate)}
                    aria-label={`Delete saved estimate ${savedEstimate.title}`}
                    title="Delete saved estimate"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function ConfidenceExplanationCard({
  estimate,
  request,
  pricing
}: {
  estimate: EstimateResponse;
  request: EstimateRequest;
  pricing: PricingConfig | null;
}) {
  const explanation = buildConfidenceExplanation(estimate, request, pricing);

  return (
    <article className="confidence-card">
      <header>
        <div>
          <p className="eyebrow">Confidence explanation</p>
          <h4>{estimate.confidence_level} confidence ({estimate.confidence_score}/100)</h4>
        </div>
        <span className={`confidence-badge ${estimate.confidence_level.toLowerCase()}`}>{estimate.confidence_level}</span>
      </header>
      <p>{explanation.summary}</p>
      <div className="confidence-grid">
        <div>
          <h5>What supports this estimate</h5>
          <ul>
            {explanation.strengths.map((item) => (
              <li key={item}>
                <BadgeCheck size={15} />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h5>Validate before sharing</h5>
          <ul>
            {explanation.watchItems.map((item) => (
              <li key={item}>
                <AlertTriangle size={15} />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </article>
  );
}

function ChartPanel({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <article className="chart-panel">
      <header>
        {icon}
        <h4>{title}</h4>
      </header>
      <div className="chart-body">{children}</div>
    </article>
  );
}

function PricingSourcePanel({ estimate, pricing }: { estimate: EstimateResponse; pricing: PricingConfig | null }) {
  const storage = getComponentAssumptions(estimate, "Storage");
  const crossRegion = getComponentAssumptions(estimate, "Cross-region DR");
  const support = getComponentAssumptions(estimate, "Support cost uplift");
  const sql = getComponentAssumptions(estimate, "Databricks SQL compute");
  const jobs = getComponentAssumptions(estimate, "Batch ingestion compute");
  const streaming = getComponentAssumptions(estimate, "Streaming ingestion compute");
  const aiBi = getComponentAssumptions(estimate, "AI/BI optional layer");
  const storageStatus = String(storage.pricing_status ?? "fallback");
  const storageSource = String(storage.pricing_source ?? "config_fallback");
  const pricingUpdatedAt = pricing?.pricing_source?.updated_at
    ? new Date(pricing.pricing_source.updated_at).toLocaleString()
    : "Not available";

  return (
    <div className="pricing-source-panel">
      <div className="pricing-source-header">
        <div>
          <p className="eyebrow">Pricing source transparency</p>
          <h4>Where these rates came from</h4>
        </div>
        <span className={`source-badge ${storageStatus === "live" ? "live" : "fallback"}`}>
          {storageStatus === "live" ? <BadgeCheck size={14} /> : <RefreshCw size={14} />}
          {storageStatus === "live" ? "Live storage rate" : "Fallback storage rate"}
        </span>
      </div>

      <div className="pricing-source-grid">
        <SourceCard
          title="Cloud storage"
          status={storageStatus === "live" ? "live" : "fallback"}
          rows={[
            ["Provider/region", `${titleCase(String(estimate.assumptions.cloud_provider ?? ""))} / ${String(estimate.assumptions.region ?? "")}`],
            ["Storage class", String(storage.storage_display_name ?? storage.storage_class ?? "Not selected")],
            ["GB-month rate", formatUnitPrice(storage.price_per_gb_month, estimate.currency)],
            ["Source", labelize(storageSource)],
            ["Last refresh", pricingUpdatedAt]
          ]}
          note={String(storage.pricing_note ?? "")}
        />
        <SourceCard
          title="Storage requests"
          status={storageStatus === "live" ? "live" : "fallback"}
          rows={[
            ["Read / 1,000", formatUnitPrice(storage.read_request_per_1000, estimate.currency)],
            ["Write / 1,000", formatUnitPrice(storage.write_request_per_1000, estimate.currency)],
            ["Monitoring / 1,000 objects", formatUnitPrice(storage.monitoring_per_1000_objects, estimate.currency)],
            ["Monthly reads", String(storage.monthly_read_requests ?? 0)],
            ["Monthly writes", String(storage.monthly_write_requests ?? 0)]
          ]}
        />
        <SourceCard
          title="Cross-region DR"
          status={String(crossRegion.pricing_status ?? "fallback") === "manual" ? "manual" : String(crossRegion.pricing_status ?? "fallback") === "live" ? "live" : "fallback"}
          rows={[
            ["Enabled", String(crossRegion.enabled ?? false)],
            ["Route", `${String(crossRegion.source_region ?? "")} -> ${String(crossRegion.destination_region ?? "")}`],
            ["DR storage copy", String(crossRegion.include_dr_storage_copy ?? true)],
            ["Transfer price/GB", formatUnitPrice(crossRegion.price_per_gb, estimate.currency)],
            ["Monthly transfer GB", String(crossRegion.monthly_transfer_gb ?? 0)],
            ["One-time replication", money(Number(crossRegion.one_time_initial_replication_cost ?? 0), estimate.currency)],
            ["Source", labelize(String(crossRegion.price_source ?? "config_fallback"))]
          ]}
          note={String(crossRegion.pricing_note ?? "")}
        />
        <SourceCard
          title="Support uplift"
          status="manual"
          badgeLabel="Editable"
          rows={[
            ["Method", labelize(String(support.calculation_method ?? "percentage"))],
            ["Support cost %", `${String(support.support_cost_percentage ?? 0)}%`],
            ["Cloud discount %", `${String(getComponentAssumptions(estimate, "Discount adjustment").cloud_discount_percentage ?? 0)}%`],
            ["Databricks discount %", `${String(getComponentAssumptions(estimate, "Discount adjustment").databricks_discount_percentage ?? 0)}%`],
            ["Discount amount", `-${money(estimate.monthly_discount_amount, estimate.currency)}`],
            ["Subtotal before support", money(Number(support.monthly_subtotal_after_discounts_before_support ?? 0), estimate.currency)]
          ]}
          note={String(support.note ?? "")}
        />
        <SourceCard
          title="Databricks SQL"
          status="manual"
          badgeLabel="Manual / public ref"
          rows={[
            ["Rate source", "Editable DBU assumption"],
            ["Reference", "Internal rate card or public Databricks list price"],
            ["Applied source", labelize(String(sql.dbu_rate_source ?? "configured_sql_workload_rate"))],
            ["Warehouse type", labelize(String(sql.warehouse_type ?? ""))],
            ["Warehouse size", labelize(String(sql.warehouse_size ?? ""))],
            ["DBU/hour", String(sql.dbu_per_hour ?? 0)],
            ["DBU rate", formatUnitPrice(sql.dbu_rate, estimate.currency)]
          ]}
          note={
            <>
              Validate DBU rates against the internal Databricks rate card before stakeholder sign-off. Public reference:{" "}
              <a href="https://www.databricks.com/product/pricing" target="_blank" rel="noreferrer">
                Databricks pricing
              </a>
              .
            </>
          }
        />
        <SourceCard
          title="Batch, streaming, optional AI/BI"
          status={String(streaming.instance_pricing_status ?? jobs.instance_pricing_status ?? "fallback") === "live" ? "live" : "manual"}
          badgeLabel={String(streaming.instance_pricing_status ?? jobs.instance_pricing_status ?? "fallback") === "live" ? "Live EC2 + DBU ref" : "DBU ref / EC2 fallback"}
          rows={[
            ["Batch rate source", "Editable DBU assumption"],
            ["DBU reference", "Internal rate card or public Databricks list price"],
            ["Applied source", labelize(String(jobs.dbu_rate_source ?? "configured_classic_jobs_rate"))],
            ["Batch DBU/hour", String(jobs.dbu_per_hour ?? 0)],
            ["Batch DBU rate", formatUnitPrice(jobs.dbu_rate, estimate.currency)],
            ["Batch EC2/hr", formatUnitPrice(jobs.cluster_ec2_cost_per_hour, estimate.currency)],
            ["Batch EC2 source", labelize(String(jobs.instance_pricing_source ?? "not_applicable"))],
            ["Streaming compute type", labelize(String(streaming.ingestion_product ?? "disabled"))],
            ["Streaming DBU/hour", String(streaming.dbu_per_hour ?? 0)],
            ["Streaming monthly hours", String(streaming.monthly_streaming_hours ?? 0)],
            ["Streaming EC2/hr", formatUnitPrice(streaming.cluster_ec2_cost_per_hour, estimate.currency)],
            ["Streaming EC2 source", labelize(String(streaming.instance_pricing_source ?? "not_applicable"))],
            ["AI/BI enabled", String(aiBi.enabled ?? false)],
            ["AI/BI DBU rate", formatUnitPrice(aiBi.dbu_rate, estimate.currency)]
          ]}
          note="Databricks DBU rates remain explicit assumptions. AWS EC2 instance prices are refreshed from the AWS Price List API in live mode and fall back to bundled config values otherwise."
        />
      </div>
    </div>
  );
}

function SourceCard({
  title,
  status,
  badgeLabel,
  rows,
  note
}: {
  title: string;
  status: "live" | "fallback" | "manual";
  badgeLabel?: string;
  rows: Array<[string, string]>;
  note?: ReactNode;
}) {
  return (
    <article className="source-card">
      <div className="source-card-topline">
        <h5>{title}</h5>
        <span className={`source-badge ${status}`}>{badgeLabel ?? labelize(status)}</span>
      </div>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {note ? <p>{note}</p> : null}
    </article>
  );
}

function KnowledgeCard({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <article className="knowledge-card">
      <h4>{title}</h4>
      <dl>
        {rows.map(([term, description]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{description}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

function FormulaExampleCard({
  title,
  formula,
  example,
  note
}: {
  title: string;
  formula: string;
  example: string;
  note: string;
}) {
  return (
    <article className="formula-card">
      <h4>{title}</h4>
      <div>
        <span>Formula</span>
        <code>{formula}</code>
      </div>
      <div>
        <span>Example</span>
        <code>{example}</code>
      </div>
      <p>{note}</p>
    </article>
  );
}

function PanelHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="panel-heading">
      <h3>{title}</h3>
      <p>{subtitle}</p>
    </div>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  disabled = false,
  hint
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const [draftValue, setDraftValue] = useState(() => formatNumberInputValue(value));
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    if (!isEditing) {
      setDraftValue(formatNumberInputValue(value));
    }
  }, [isEditing, value]);

  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={draftValue}
        disabled={disabled}
        onChange={(event) => {
          const nextValue = normalizeNumberInputDraft(event.target.value);
          if (!isValidNumberInputDraft(nextValue)) {
            return;
          }
          setDraftValue(nextValue);
          if (nextValue === "" || nextValue === ".") {
            return;
          }
          const parsed = parseNumberInputValue(nextValue);
          if (Number.isFinite(parsed)) {
            onChange(parsed);
          }
        }}
        onFocus={(event) => {
          setIsEditing(true);
          event.currentTarget.select();
        }}
        onBlur={() => {
          setIsEditing(false);
          const parsed = parseNumberInputValue(draftValue);
          const normalized = Number.isFinite(parsed) ? parsed : 0;
          onChange(normalized);
          setDraftValue(formatNumberInputValue(normalized));
        }}
      />
      {hint ? <small className="field-hint">{hint}</small> : null}
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  disabled = false
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function money(value: number | undefined, currency = "USD") {
  if (value === undefined) {
    return "--";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: value < 100 ? 2 : 0
  }).format(value);
}

function shortMoney(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

function titleCase(value: string) {
  return value
    .replace(/[-_]/g, " ")
    .replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function labelize(value: string) {
  return titleCase(value);
}

function getRedundancyOption(value: RedundancyModel) {
  return REDUNDANCY_OPTIONS.find((option) => option.value === value) ?? REDUNDANCY_OPTIONS[0];
}

function getCrossRegionAutoDefaults(dataset: DatasetInput) {
  return {
    initialReplicationGb: roundEstimatorInput(dataset.total_data_size_gb),
    monthlyChangedDataGb: roundEstimatorInput((dataset.total_data_size_gb * dataset.annual_growth_percentage) / 100 / 12),
    amortizeInitialMonths: 12
  };
}

function roundEstimatorInput(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 100) / 100;
}

function getComponentAssumptions(estimate: EstimateResponse, label: string) {
  return estimate.components.find((component) => component.label === label)?.assumptions ?? {};
}

function buildConfidenceExplanation(estimate: EstimateResponse, request: EstimateRequest, pricing: PricingConfig | null) {
  const strengths: string[] = [];
  const watchItems: string[] = [];
  const warningCount = estimate.warnings.length;
  const highestSeverity = estimate.warnings.find((warning) => warning.severity === "high")?.severity ??
    estimate.warnings.find((warning) => warning.severity === "medium")?.severity ??
    estimate.warnings.find((warning) => warning.severity === "low")?.severity;

  if (request.dataset.total_data_size_gb > 0 && request.dataset.file_count > 0) {
    strengths.push("Dataset size and file count are populated, so unit-cost metrics are grounded in actual volume inputs.");
  }

  if (pricing?.pricing_source?.mode === "live") {
    strengths.push("Cloud storage pricing is using live provider list pricing where available.");
  } else {
    strengths.push("Pricing source and fallback assumptions are visible for review in the assumptions section.");
  }

  if (estimate.buffer_percentage > 0) {
    strengths.push(`${estimate.buffer_percentage}% buffer is included to absorb planning uncertainty.`);
  }

  if (request.dataset.replication_factor > 1) {
    strengths.push(`Storage redundancy is explicitly modelled at ${request.dataset.replication_factor}x copies.`);
  }

  if (request.cross_region_transfer.enabled) {
    strengths.push("Cross-region DR transfer/access is explicitly included instead of hidden in storage assumptions.");
  }

  if (request.support_cost.support_cost_percentage > 0) {
    strengths.push(`Support uplift is included at ${request.support_cost.support_cost_percentage}%.`);
  }

  if (request.support_cost.databricks_discount_percentage > 0 || request.support_cost.cloud_discount_percentage > 0) {
    strengths.push("Discount inputs are separated between Databricks and cloud charges.");
  }

  const warningsForReview = estimate.warnings.slice(0, 3).map((warning) => `${titleCase(warning.severity)}: ${warning.message}`);
  watchItems.push(...warningsForReview);

  if (request.streaming_ingestion.enabled) {
    strengths.push(`Streaming ingestion is modelled separately using ${streamingProductTitle(request.streaming_ingestion.ingestion_product)}.`);
  }

  if (request.job_compute.enabled) {
    strengths.push(
      request.job_compute.ingestion_frequency === "one-time"
        ? "One-time batch load is separated from recurring monthly compute."
        : "Batch ingestion is separated from streaming and SQL query workloads."
    );
  }

  if (request.sql_compute.dbu_rate !== null || request.job_compute.dbu_rate !== null || request.streaming_ingestion.dbu_rate !== null || request.ai_bi.dbu_rate !== null) {
    watchItems.push("Manual DBU rates should be validated against the current Databricks/internal rate card.");
  } else {
    watchItems.push("DBU rates come from configured defaults and should still be validated before budget approval.");
  }

  if (!request.streaming_ingestion.enabled) {
    watchItems.push("Streaming ingestion is disabled; enable it for Kafka, Pulsar, CDC, or always-on pipelines.");
  }

  if (request.support_cost.databricks_discount_percentage === 0 && request.support_cost.cloud_discount_percentage === 0) {
    watchItems.push("Discounts are set to 0%, so final negotiated rates may reduce the actual cost.");
  }

  if (!request.cross_region_transfer.enabled) {
    watchItems.push("Cross-region DR is disabled; enable it if replicated regional access or disaster recovery is in scope.");
  }

  if (watchItems.length === 0) {
    watchItems.push("No major validation gaps detected, but final numbers still need FinOps/platform approval.");
  }

  const summary =
    warningCount === 0
      ? "This estimate has no active warnings, so the score is mainly limited by the fact that it is still a planning estimate."
      : `This score reflects ${warningCount} active validation ${warningCount === 1 ? "item" : "items"}${highestSeverity ? `, with ${highestSeverity} severity being the highest current concern` : ""}.`;

  return {
    summary,
    strengths: strengths.slice(0, 5),
    watchItems: dedupeStrings(watchItems).slice(0, 5)
  };
}

function dedupeStrings(values: string[]) {
  return Array.from(new Set(values));
}

function formatUnitPrice(value: unknown, currency = "USD") {
  const numericValue = Number(value ?? 0);
  if (!Number.isFinite(numericValue)) {
    return "--";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: numericValue < 0.01 && numericValue > 0 ? 4 : 2,
    maximumFractionDigits: numericValue < 0.01 && numericValue > 0 ? 6 : 4
  }).format(numericValue);
}

function buildSavedEstimateTitle(request: EstimateRequest) {
  const team = request.dataset.team_name.trim() || "Untitled team";
  const dataset = request.dataset.brand_or_dataset_name.trim() || "Untitled dataset";
  return `${team} - ${dataset}`;
}

function buildSharePath(estimateId: string) {
  return `/estimate/${encodeURIComponent(estimateId)}`;
}

function buildShareUrl(estimateId: string) {
  return `${window.location.origin}${buildSharePath(estimateId)}`;
}

function getEstimateIdFromPath() {
  const match = window.location.pathname.match(/^\/estimate\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function formatLoadedEstimateMessage(state: LoadedEstimateState) {
  if (state.action === "reset") {
    return "Sample defaults restored. You can start a fresh estimate.";
  }
  const savedAt = state.savedAt ? ` Saved ${new Date(state.savedAt).toLocaleString()}.` : "";
  if (state.action === "saved") {
    return `${state.label} saved to the estimate library.${savedAt}`;
  }
  if (state.action === "copied") {
    return `Permalink copied for ${state.id ?? "saved estimate"}.`;
  }
  return `Loaded saved estimate: ${state.label}.${savedAt}`;
}

function normalizeEstimateRequest(payload: unknown): EstimateRequest {
  if (!isRecord(payload)) {
    throw new Error("The estimate file does not contain editable inputs.");
  }
  if (!isRecord(payload.dataset) || !isRecord(payload.storage) || !isRecord(payload.sql_compute) || !isRecord(payload.job_compute)) {
    throw new Error("This JSON does not include the editable estimator inputs.");
  }
  return {
    scenario_key: asString(payload.scenario_key, "archive_only"),
    dataset: {
      ...defaultDataset,
      ...(isRecord(payload.dataset) ? payload.dataset : {})
    } as DatasetInput,
    storage: {
      ...defaultStorage,
      ...(isRecord(payload.storage) ? payload.storage : {})
    } as StorageInput,
    sql_compute: {
      ...defaultSql,
      ...(isRecord(payload.sql_compute) ? payload.sql_compute : {})
    } as SQLComputeInput,
    job_compute: {
      ...defaultJob,
      ...(isRecord(payload.job_compute) ? payload.job_compute : {})
    } as JobComputeInput,
    streaming_ingestion: {
      ...defaultStreamingIngestion,
      ...(isRecord(payload.streaming_ingestion) ? payload.streaming_ingestion : {})
    } as StreamingIngestionInput,
    ai_bi: {
      ...defaultAiBi,
      ...(isRecord(payload.ai_bi) ? payload.ai_bi : {})
    } as AIBIInput,
    cross_region_transfer: {
      ...defaultCrossRegionTransfer,
      ...(isRecord(payload.cross_region_transfer) ? payload.cross_region_transfer : {})
    } as CrossRegionTransferInput,
    support_cost: {
      ...defaultSupportCost,
      ...(isRecord(payload.support_cost) ? payload.support_cost : {})
    } as SupportCostInput,
    buffer_percentage: typeof payload.buffer_percentage === "number" ? payload.buffer_percentage : null
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback: string) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function formatNumberInputValue(value: number) {
  return Number.isFinite(value) ? String(value) : "0";
}

function normalizeNumberInputDraft(value: string) {
  return value.replace(/,/g, "").trim();
}

function isValidNumberInputDraft(value: string) {
  return /^\d*(?:\.\d*)?$/.test(value);
}

function parseNumberInputValue(value: string) {
  const cleaned = normalizeNumberInputDraft(value).replace(/[^\d.]/g, "");
  const parts = cleaned.split(".");
  const normalized = parts.length > 1 ? `${parts[0]}.${parts.slice(1).join("")}` : parts[0];
  if (normalized === "" || normalized === ".") {
    return 0;
  }
  return Number(normalized);
}

function isEstimatorSection(value: string): value is EstimatorSection {
  return ESTIMATOR_SECTIONS.includes(value as EstimatorSection);
}

function getVisibleEstimatorSection() {
  const viewportAnchor = 150;
  let nextSection = ESTIMATOR_SECTIONS[0];
  let closestDistance = Number.POSITIVE_INFINITY;
  const candidates = Array.from(document.querySelectorAll<HTMLElement>("[id], [data-nav-section]"))
    .map((element) => ({
      element,
      section: element.dataset.navSection ?? element.id
    }))
    .filter((candidate): candidate is { element: HTMLElement; section: EstimatorSection } => isEstimatorSection(candidate.section));

  for (const { element, section } of candidates) {
    const rect = element.getBoundingClientRect();
    if (rect.bottom < viewportAnchor) {
      continue;
    }
    const distance = Math.abs(rect.top - viewportAnchor);
    if (distance < closestDistance) {
      closestDistance = distance;
      nextSection = section;
    }
  }
  return nextSection;
}

function shortScenarioName(key: string, fallback: string) {
  const names: Record<string, string> = {
    archive_only: "Archive",
    basic_query: "Basic",
    scheduled_reporting: "Reporting",
    self_service_analytics: "Analytics",
    future_ai_bi: "AI/BI"
  };
  return names[key] ?? fallback;
}

function shorterScenarioLabel(key: string, fallback: string) {
  const names: Record<string, string> = {
    archive_only: "Arch.",
    basic_query: "Basic",
    scheduled_reporting: "Report",
    self_service_analytics: "Analytics",
    future_ai_bi: "AI/BI"
  };
  return names[key] ?? fallback;
}

function buildScenarioRecommendation(
  request: EstimateRequest,
  scenarios: Record<string, ScenarioConfig>
) {
  const dataset = request.dataset;
  const sql = request.sql_compute;
  const jobs = request.job_compute;
  const streaming = request.streaming_ingestion;
  const aiBi = request.ai_bi;
  const fileCount = Math.max(dataset.file_count, 1);
  const archiveDocumentShare =
    (dataset.zip_archive_file_count + dataset.document_file_count) / fileCount;
  const queries = sql.queries_per_month;
  const dailyOrFrequentJobs =
    jobs.enabled && (jobs.ingestion_frequency === "daily" || jobs.job_runs_per_month >= 20 || jobs.number_of_jobs >= 2);

  let key = "archive_only";
  const reasons: string[] = [];

  if (streaming.enabled) {
    key = "scheduled_reporting";
    reasons.push("Streaming ingestion is enabled, so this needs a compute-aware scenario rather than archive-only storage.");
    if (streaming.source_type === "kafka" || streaming.source_type === "pulsar") {
      reasons.push("Kafka/Pulsar workloads should use Spark Structured Streaming or DLT continuous, with driver/worker instance sizing and EC2 included for classic clusters.");
    } else if (streaming.source_type === "saas_connector" || streaming.source_type === "cdc_database") {
      reasons.push("SaaS and CDC sources are usually best modelled with Lakeflow Connect unless a custom pipeline is required.");
    } else if (streaming.source_type === "api_webhook") {
      reasons.push("Push-capable API/webhook sources can use Zerobus-style GB ingestion pricing.");
    } else if (streaming.source_type === "object_store") {
      reasons.push("Object-store ingestion should usually be modelled as Auto Loader or COPY INTO style batch/streaming file ingestion.");
    }
    if (streaming.use_instance_sizing) {
      reasons.push(`Streaming is using ${streaming.worker_count} worker(s) plus ${streaming.driver_count} driver(s) on ${streaming.worker_instance_type}.`);
    } else {
      reasons.push("Streaming is using simple DBU/hour input; use instance-based sizing for closer parity with the pricing reference.");
    }
  } else if (aiBi.enabled) {
    key = "future_ai_bi";
    reasons.push("AI/BI is enabled, so the future AI/BI scenario is the best match.");
  } else if (
    queries >= 1000 ||
    sql.concurrent_users >= 15 ||
    sql.usage_pattern === "high" ||
    sql.apply_concurrency_multiplier
  ) {
    key = "self_service_analytics";
    reasons.push("Query demand or concurrency is high enough for a self-service analytics pattern.");
  } else if (dailyOrFrequentJobs || queries >= 150 || sql.usage_pattern === "frequent") {
    key = "scheduled_reporting";
    reasons.push("Recurring jobs or moderate query volume point to scheduled reporting.");
  } else if (queries > 0 || sql.concurrent_users > 1 || sql.usage_pattern === "occasional") {
    key = "basic_query";
    reasons.push("Some interactive SQL access is expected, but usage is still relatively light.");
  } else {
    reasons.push("No meaningful SQL query workload is currently configured.");
  }

  if (archiveDocumentShare >= 0.6) {
    reasons.push("The dataset appears archive/document-heavy based on the file split.");
  }
  if (dataset.total_data_size_gb < 100) {
    reasons.push("Dataset size is modest, so compute assumptions drive more of the estimate than storage.");
  }
  if (dailyOrFrequentJobs && key !== "scheduled_reporting" && key !== "self_service_analytics") {
    reasons.push("Job cadence is configured, so validate whether scheduled reporting should be selected.");
  }
  if (!aiBi.enabled) {
    reasons.push("AI/BI is disabled, so it is kept out of the baseline recommendation.");
  }

  const scenario = scenarios[key];
  return {
    key,
    title: scenario ? `Recommended: ${scenario.title}` : "Recommended scenario",
    summary: scenario?.description ?? "Recommendation will appear once scenarios are loaded.",
    reasons: reasons.slice(0, 4)
  };
}

function isBackgroundPricingRefreshPending(pricing: PricingConfig) {
  return pricing.pricing_source?.notes.some((note) => note.toLowerCase().includes("background")) ?? false;
}

function getPricingRefreshStatus(pricing: PricingConfig): "refreshing" | "live" | "fallback" {
  if (isBackgroundPricingRefreshPending(pricing)) {
    return "refreshing";
  }
  return hasAnyLiveStoragePricing(pricing) ? "live" : "fallback";
}

function getDefaultSqlDbuRate(pricing: PricingConfig | null, warehouseType: SQLComputeInput["warehouse_type"]) {
  return pricing?.databricks.dbu_rates?.sql?.[warehouseType] ?? pricing?.databricks.default_dbu_rate ?? 0;
}

function getDefaultJobDbuRate(pricing: PricingConfig | null) {
  return pricing?.databricks.dbu_rates?.jobs?.classic ?? pricing?.databricks.dbu_rates?.jobs?.default ?? pricing?.databricks.default_dbu_rate ?? 0;
}

function getDefaultBatchDbuRate(
  pricing: PricingConfig | null,
  computeType: JobComputeInput["compute_type"],
  dltTier: JobComputeInput["dlt_tier"] = "core"
) {
  if (computeType === "serverless_jobs") {
    return pricing?.databricks.dbu_rates?.jobs?.serverless ?? pricing?.databricks.default_dbu_rate ?? 0;
  }
  if (computeType === "dlt_triggered") {
    return pricing?.databricks.dbu_rates?.dlt?.[dltTier] ?? pricing?.databricks.dbu_rates?.dlt?.core ?? pricing?.databricks.default_dbu_rate ?? 0;
  }
  if (computeType === "jobs_photon") {
    return pricing?.databricks.dbu_rates?.jobs?.photon ?? pricing?.databricks.dbu_rates?.jobs?.classic ?? pricing?.databricks.default_dbu_rate ?? 0;
  }
  return getDefaultJobDbuRate(pricing);
}

function getDefaultStreamingDbuRate(
  pricing: PricingConfig | null,
  product: StreamingIngestionInput["ingestion_product"],
  dltTier: StreamingIngestionInput["dlt_tier"] = "core",
  photonEnabled = false
) {
  if (product === "dlt_continuous") {
    return pricing?.databricks.dbu_rates?.dlt?.[dltTier] ?? pricing?.databricks.dbu_rates?.dlt?.core ?? pricing?.databricks.default_dbu_rate ?? 0;
  }
  if (product === "lakeflow_connect") {
    return pricing?.databricks.lakeflow_connect?.managed_connectors_dbu_rate ?? pricing?.databricks.default_dbu_rate ?? 0;
  }
  if (product === "zerobus_ingest") {
    return 0;
  }
  if (photonEnabled) {
    return pricing?.databricks.dbu_rates?.jobs?.photon ?? pricing?.databricks.dbu_rates?.jobs?.classic ?? pricing?.databricks.default_dbu_rate ?? 0;
  }
  return getDefaultJobDbuRate(pricing);
}

function getSourceTransferPricePerGb(
  pricing: PricingConfig | null,
  sourceLocation: StreamingIngestionInput["source_location"]
) {
  return pricing?.network?.source_transfer?.[sourceLocation]?.price_per_gb ?? 0;
}

function getCrossRegionTransferPricePerGb(
  estimate: EstimateResponse | null,
  pricing: PricingConfig | null,
  cloudProvider: CloudProvider,
  sourceRegion: string,
  destinationRegion: string
) {
  if (!destinationRegion) {
    return 0;
  }

  const estimatedPrice = estimate?.components.find((component) => component.label === "Cross-region DR")?.assumptions.price_per_gb;
  const parsedEstimatedPrice = typeof estimatedPrice === "number" ? estimatedPrice : Number(estimatedPrice);
  if (Number.isFinite(parsedEstimatedPrice)) {
    return parsedEstimatedPrice;
  }

  const transferConfig = pricing?.network?.cross_region_transfer;
  const providerConfig = transferConfig?.[cloudProvider];
  return (
    providerConfig?.routes?.[sourceRegion]?.[destinationRegion]?.price_per_gb ??
    providerConfig?.default_price_per_gb ??
    transferConfig?.default_price_per_gb ??
    0
  );
}

function getInstanceOptions(pricing: PricingConfig | null) {
  const instances = pricing?.databricks.instance_types ?? {};
  const options = Object.entries(instances).map(([key, value]) => ({
    value: key,
    label: value.display_name || key
  }));
  return options.length > 0 ? options : [{ value: "m5.xlarge", label: "m5.xlarge" }];
}

function getDefaultAiBiDbuRate(pricing: PricingConfig | null) {
  return pricing?.databricks.dbu_rates?.ai_bi?.default ?? pricing?.databricks.default_dbu_rate ?? 0;
}

function streamingProductTitle(product: StreamingIngestionInput["ingestion_product"]) {
  const titles: Record<StreamingIngestionInput["ingestion_product"], string> = {
    structured_streaming: "Spark Structured Streaming",
    dlt_continuous: "DLT continuous pipeline",
    lakeflow_connect: "Lakeflow Connect",
    zerobus_ingest: "Zerobus Ingest"
  };
  return titles[product];
}

function streamingProductGuidance(
  sourceType: StreamingIngestionInput["source_type"],
  product: StreamingIngestionInput["ingestion_product"]
) {
  if ((sourceType === "kafka" || sourceType === "pulsar") && product === "zerobus_ingest") {
    return "Kafka/Pulsar usually need Spark Structured Streaming or DLT. Zerobus is a push/API ingestion pattern.";
  }
  if (product === "zerobus_ingest") {
    return "Priced by GB ingested and useful when the source can push events to Databricks.";
  }
  if (product === "lakeflow_connect") {
    return "Use for managed SaaS, JDBC, and CDC-style ingestion where connector DBUs are the billing basis.";
  }
  if (product === "dlt_continuous") {
    return "Use for governed streaming pipelines where DLT continuous runtime is the sizing driver.";
  }
  return "Use for broker-based streams such as Kafka or Pulsar where a long-running Spark job pulls data continuously.";
}

function hasAnyLiveStoragePricing(pricing: PricingConfig) {
  return Object.values(pricing.cloud).some((cloud) =>
    Object.values(cloud.regions).some((region) =>
      Object.values(region.storage).some((storage) => storage.pricing_status === "live")
    )
  );
}

export default App;
