import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  BarChart3,
  Cloud,
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
  ShieldAlert,
  Sparkles
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
import { exportBlob, getPricingConfig, getScenarios, postEstimate, postScenarioComparison } from "./api";
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
  SQLComputeInput,
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
  ingestion_frequency: "monthly",
  job_runs_per_month: 0,
  average_job_runtime_minutes: 0,
  job_cluster_size: "small",
  custom_dbu_per_hour: null,
  dbu_rate: null,
  number_of_jobs: 0
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
  filename: string;
  savedAt?: string;
  action: "loaded" | "saved" | "reset";
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
  const loadEstimateInputRef = useRef<HTMLInputElement | null>(null);
  const activeSectionLockRef = useRef<EstimatorSection | null>(null);
  const activeSectionLockTimeoutRef = useRef<number | null>(null);
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

  const requestPayload = useMemo<EstimateRequest>(
    () => ({
      scenario_key: selectedScenario,
      dataset,
      storage,
      sql_compute: sqlCompute,
      job_compute: jobCompute,
      ai_bi: aiBi,
      cross_region_transfer: crossRegionTransfer,
      support_cost: supportCost,
      buffer_percentage: bufferPercentage
    }),
    [selectedScenario, dataset, storage, sqlCompute, jobCompute, aiBi, crossRegionTransfer, supportCost, bufferPercentage]
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
    setJobCompute((current) => ({ ...current, ...scenario.jobs }));
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
      destination_region: ""
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

  function handleSaveEditableEstimate() {
    const filename = buildEditableEstimateFilename(dataset);
    const payload = {
      version: 1,
      type: "databricks-cost-estimator-editable",
      saved_at: new Date().toISOString(),
      request: requestPayload
    };
    downloadJson(payload, filename);
    setLoadedEstimate({ filename, action: "saved", savedAt: payload.saved_at });
    setError(null);
  }

  async function handleLoadEditableEstimate(file: File | undefined) {
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const request = extractEditableEstimateRequest(parsed);
      restoreEstimateRequest(request);
      setLoadedEstimate({
        filename: file.name,
        action: "loaded",
        savedAt: extractSavedAt(parsed)
      });
      setError(null);
      navigateToEstimator("dataset");
    } catch (err) {
      setLoadedEstimate(null);
      setError(err instanceof Error ? err.message : "Could not load estimate file. Select a JSON file saved from this estimator.");
    } finally {
      if (loadEstimateInputRef.current) {
        loadEstimateInputRef.current.value = "";
      }
    }
  }

  function restoreEstimateRequest(nextRequest: EstimateRequest) {
    setSelectedScenario(nextRequest.scenario_key);
    setDataset(nextRequest.dataset);
    setStorage(nextRequest.storage);
    setSqlCompute(nextRequest.sql_compute);
    setJobCompute(nextRequest.job_compute);
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
    setJobCompute(defaultJob);
    setAiBi(defaultAiBi);
    setCrossRegionTransfer(defaultCrossRegionTransfer);
    setSupportCost(defaultSupportCost);
    setBufferPercentage(pricing?.default_buffer_percentage ?? null);
    setLoadedEstimate({ filename: "Sample defaults", action: "reset" });
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
            <input
              ref={loadEstimateInputRef}
              className="sr-only"
              type="file"
              accept="application/json,.json"
              onChange={(event) => handleLoadEditableEstimate(event.target.files?.[0])}
            />
            <button className="ghost-button" onClick={() => loadEstimateInputRef.current?.click()}>
              <FolderOpen size={16} /> Load
            </button>
            <button className="ghost-button" onClick={handleSaveEditableEstimate}>
              <Download size={16} /> Save
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
          </div>
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
            <KpiCard label="Job compute" value={money(estimate?.monthly_job_compute_cost, estimate?.currency)} />
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
                      destination_region: ""
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
                  onChange={(value) => setCrossRegionTransfer({ ...crossRegionTransfer, destination_region: value })}
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
                  label="Transfer price/GB override"
                  value={crossRegionTransfer.transfer_price_per_gb_override ?? 0}
                  onChange={(value) => setCrossRegionTransfer({ ...crossRegionTransfer, transfer_price_per_gb_override: value > 0 ? value : null })}
                  disabled={!crossRegionTransfer.enabled}
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
            <PanelHeading title="Job and ingestion compute" subtitle="Scheduled pipelines, scans, and refreshes" />
            <div className="field-grid">
              <SelectField
                label="Ingestion frequency"
                value={jobCompute.ingestion_frequency}
                onChange={(value) => setJobCompute({ ...jobCompute, ingestion_frequency: value as JobComputeInput["ingestion_frequency"] })}
                options={["one-time", "daily", "weekly", "monthly"].map((value) => ({ value, label: titleCase(value) }))}
              />
              <NumberField label="Job runs/month" value={jobCompute.job_runs_per_month} onChange={(value) => setJobCompute({ ...jobCompute, job_runs_per_month: value })} />
              <NumberField
                label="Avg job runtime minutes"
                value={jobCompute.average_job_runtime_minutes}
                onChange={(value) => setJobCompute({ ...jobCompute, average_job_runtime_minutes: value })}
              />
              <SelectField
                label="Job cluster size"
                value={jobCompute.job_cluster_size}
                onChange={(value) => setJobCompute({ ...jobCompute, job_cluster_size: value })}
                options={[
                  ...Object.entries(pricing?.databricks.jobs ?? {}).map(([key, value]) => ({ value: key, label: value.display_name })),
                  { value: "custom", label: "Custom" }
                ]}
              />
              {jobCompute.job_cluster_size === "custom" ? (
                <NumberField
                  label="Custom job DBU/hour"
                  value={jobCompute.custom_dbu_per_hour ?? 0}
                  onChange={(value) => setJobCompute({ ...jobCompute, custom_dbu_per_hour: value })}
                />
              ) : null}
              <NumberField label="Job DBU rate (internal or public list)" value={jobCompute.dbu_rate ?? getDefaultJobDbuRate(pricing)} onChange={(value) => setJobCompute({ ...jobCompute, dbu_rate: value })} />
              <NumberField label="Pipelines/jobs" value={jobCompute.number_of_jobs} onChange={(value) => setJobCompute({ ...jobCompute, number_of_jobs: value })} />
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
          </section>

          <section className="panel support-panel" data-nav-section="compute">
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
            title="Jobs and ingestion"
            rows={[
              ["Frequency", "One-time, daily, weekly, or monthly job cadence."],
              ["Runs/month", "How many job executions happen in a typical month."],
              ["Runtime minutes", "Average active job cluster runtime per execution."],
              ["Cluster size", "Configured job cluster DBU/hour size, or custom DBU/hour."],
              ["Pipelines/jobs", "Multiplier for multiple ingestion or refresh pipelines."]
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
            title="Job and ingestion compute"
            formula="DBU/hour x DBU rate x job hours x number of jobs"
            example="4 DBU/hour x $0.26 x (30 runs x 20 min / 60) x 2 jobs = $20.80/month"
            note="Use this for scheduled ingestion, metadata scans, refresh jobs, or recurring report pipelines."
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

function KpiCard({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <article className={`kpi-card ${strong ? "strong" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
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
  const jobs = getComponentAssumptions(estimate, "Job/ingestion compute");
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
          title="Jobs and optional AI/BI"
          status="manual"
          badgeLabel="Manual / public ref"
          rows={[
            ["Job rate source", "Editable DBU assumption"],
            ["Reference", "Internal rate card or public Databricks list price"],
            ["Applied source", labelize(String(jobs.dbu_rate_source ?? "configured_classic_jobs_rate"))],
            ["Job DBU/hour", String(jobs.dbu_per_hour ?? 0)],
            ["Job DBU rate", formatUnitPrice(jobs.dbu_rate, estimate.currency)],
            ["AI/BI enabled", String(aiBi.enabled ?? false)],
            ["AI/BI DBU rate", formatUnitPrice(aiBi.dbu_rate, estimate.currency)]
          ]}
          note="These DBU rates are not treated as guaranteed enterprise prices. Use your internal committed-use or discount-adjusted rate where available."
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
  disabled = false
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={formatNumberInputValue(value)}
        disabled={disabled}
        onChange={(event) => onChange(parseNumberInputValue(event.target.value))}
        onFocus={(event) => event.currentTarget.select()}
      />
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

  if (request.sql_compute.dbu_rate !== null || request.job_compute.dbu_rate !== null || request.ai_bi.dbu_rate !== null) {
    watchItems.push("Manual DBU rates should be validated against the current Databricks/internal rate card.");
  } else {
    watchItems.push("DBU rates come from configured defaults and should still be validated before budget approval.");
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

function downloadJson(payload: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function buildEditableEstimateFilename(dataset: DatasetInput) {
  const label = dataset.brand_or_dataset_name || dataset.team_name || "estimate";
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `databricks-cost-estimate-${safeLabel || "estimate"}-editable.json`;
}

function extractEditableEstimateRequest(payload: unknown): EstimateRequest {
  if (!isRecord(payload)) {
    throw new Error("The selected file is not valid JSON for this estimator.");
  }
  const candidate = isRecord(payload.request) ? payload.request : payload;
  return normalizeEstimateRequest(candidate);
}

function extractSavedAt(payload: unknown) {
  if (!isRecord(payload) || typeof payload.saved_at !== "string") {
    return undefined;
  }
  return payload.saved_at;
}

function formatLoadedEstimateMessage(state: LoadedEstimateState) {
  if (state.action === "reset") {
    return "Sample defaults restored. You can start a fresh estimate.";
  }
  const savedAt = state.savedAt ? ` Saved ${new Date(state.savedAt).toLocaleString()}.` : "";
  if (state.action === "saved") {
    return `Editable estimate saved as ${state.filename}.${savedAt}`;
  }
  return `Loaded editable estimate: ${state.filename}.${savedAt}`;
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

function parseNumberInputValue(value: string) {
  const cleaned = value.replace(/[^\d.]/g, "");
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
  const aiBi = request.ai_bi;
  const fileCount = Math.max(dataset.file_count, 1);
  const archiveDocumentShare =
    (dataset.zip_archive_file_count + dataset.document_file_count) / fileCount;
  const queries = sql.queries_per_month;
  const dailyOrFrequentJobs =
    jobs.ingestion_frequency === "daily" || jobs.job_runs_per_month >= 20 || jobs.number_of_jobs >= 2;

  let key = "archive_only";
  const reasons: string[] = [];

  if (aiBi.enabled) {
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

function getDefaultAiBiDbuRate(pricing: PricingConfig | null) {
  return pricing?.databricks.dbu_rates?.ai_bi?.default ?? pricing?.databricks.default_dbu_rate ?? 0;
}

function hasAnyLiveStoragePricing(pricing: PricingConfig) {
  return Object.values(pricing.cloud).some((cloud) =>
    Object.values(cloud.regions).some((region) =>
      Object.values(region.storage).some((storage) => storage.pricing_status === "live")
    )
  );
}

export default App;
