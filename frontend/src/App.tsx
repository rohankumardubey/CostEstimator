import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
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
  DatasetInput,
  EstimateRequest,
  EstimateResponse,
  JobComputeInput,
  PricingConfig,
  SQLComputeInput,
  ScenarioConfig,
  StorageInput
} from "./types";

const COLORS = ["#2563eb", "#059669", "#dc6803", "#7c3aed", "#475467"];

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
  replication_factor: 1,
  mask_names_in_report: false
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
  concurrent_users: 1,
  auto_stop_minutes: 10,
  usage_pattern: "rare",
  apply_concurrency_multiplier: false
};

const defaultJob: JobComputeInput = {
  ingestion_frequency: "monthly",
  job_runs_per_month: 1,
  average_job_runtime_minutes: 20,
  job_cluster_size: "small",
  custom_dbu_per_hour: null,
  dbu_rate: null,
  number_of_jobs: 1
};

const defaultAiBi: AIBIInput = {
  enabled: false,
  expected_users: 0,
  questions_per_user_per_month: 0,
  average_runtime_minutes_per_question: 0,
  dbu_per_hour: 0,
  dbu_rate: null
};

type LoadedEstimateState = {
  filename: string;
  savedAt?: string;
  action: "loaded" | "saved" | "reset";
};

type EstimatorSection = "scenario" | "dataset" | "storage" | "compute" | "recommendation" | "results" | "assumptions";

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
  const [pricing, setPricing] = useState<PricingConfig | null>(null);
  const [scenarios, setScenarios] = useState<Record<string, ScenarioConfig>>({});
  const [selectedScenario, setSelectedScenario] = useState("archive_only");
  const [dataset, setDataset] = useState<DatasetInput>(defaultDataset);
  const [storage, setStorage] = useState<StorageInput>(defaultStorage);
  const [sqlCompute, setSqlCompute] = useState<SQLComputeInput>(defaultSql);
  const [jobCompute, setJobCompute] = useState<JobComputeInput>(defaultJob);
  const [aiBi, setAiBi] = useState<AIBIInput>(defaultAiBi);
  const [bufferPercentage, setBufferPercentage] = useState<number | null>(null);
  const [currentPage, setCurrentPage] = useState<"estimator" | "knowledge">("estimator");
  const [activeSection, setActiveSection] = useState<EstimatorSection>("scenario");
  const [estimate, setEstimate] = useState<EstimateResponse | null>(null);
  const [scenarioEstimates, setScenarioEstimates] = useState<EstimateResponse[]>([]);
  const [loadingEstimate, setLoadingEstimate] = useState(false);
  const [pricingRefreshStatus, setPricingRefreshStatus] = useState<"idle" | "refreshing" | "live" | "fallback">("idle");
  const [loadedEstimate, setLoadedEstimate] = useState<LoadedEstimateState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getPricingConfig(), getScenarios()])
      .then(([pricingConfig, scenarioConfig]) => {
        setPricing(pricingConfig);
        setScenarios(scenarioConfig);
        setPricingRefreshStatus(getPricingRefreshStatus(pricingConfig));
        setBufferPercentage(pricingConfig.default_buffer_percentage);
        setDataset((current) => ({
          ...current,
          ...pricingConfig.sample_dataset,
          mask_names_in_report: false
        }));
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
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
  }, [pricing?.pricing_source?.updated_at]);

  useEffect(() => {
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
  }, [currentPage]);

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
      buffer_percentage: bufferPercentage
    }),
    [selectedScenario, dataset, storage, sqlCompute, jobCompute, aiBi, bufferPercentage]
  );

  useEffect(() => {
    if (!pricing) {
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
  }, [pricing, requestPayload]);

  const cloudConfig = pricing?.cloud[dataset.cloud_provider];
  const regionConfig = cloudConfig?.regions[dataset.region];
  const storageOptions = regionConfig?.storage ?? {};

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
    setStorage((current) => ({
      ...current,
      storage_class: scenario?.storage_class_by_cloud[nextCloud] ?? Object.keys(pricing.cloud[nextCloud].regions[defaultRegion].storage)[0]
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
      region: defaultRegion,
      mask_names_in_report: false
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
    }, 900);

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

  const breakdownData = estimate?.components.filter((component) => component.monthly_cost > 0) ?? [];
  const annualData = estimate
    ? [
        { name: "Monthly", value: estimate.total_monthly_estimate },
        { name: "Annual", value: estimate.total_annual_estimate },
        { name: "Buffered annual", value: estimate.estimate_with_buffer_annual }
      ]
    : [];
  const scenarioComparison = scenarioEstimates.map((scenarioEstimate) => ({
    name: shortScenarioName(scenarioEstimate.scenario_key, scenarioEstimate.scenario_title),
    value: scenarioEstimate.total_monthly_estimate
  }));
  const scenarioRecommendation = useMemo(
    () => buildScenarioRecommendation(requestPayload, scenarios),
    [requestPayload, scenarios]
  );

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
          <button type="button" className={currentPage === "estimator" && activeSection === "storage" ? "active" : ""} onClick={() => navigateToEstimator("storage")}>
            <Cloud size={17} />
            <span>Storage</span>
          </button>
          <button type="button" className={currentPage === "estimator" && activeSection === "compute" ? "active" : ""} onClick={() => navigateToEstimator("compute")}>
            <BarChart3 size={17} />
            <span>Compute</span>
          </button>
          <button type="button" className={currentPage === "estimator" && activeSection === "recommendation" ? "active" : ""} onClick={() => navigateToEstimator("recommendation")}>
            <BadgeCheck size={17} />
            <span>Recommendation</span>
          </button>
          <button type="button" className={currentPage === "estimator" && activeSection === "results" ? "active" : ""} onClick={() => navigateToEstimator("results")}>
            <Download size={17} />
            <span>Results</span>
          </button>
          <button type="button" className={currentPage === "estimator" && activeSection === "assumptions" ? "active" : ""} onClick={() => navigateToEstimator("assumptions")}>
            <ShieldAlert size={17} />
            <span>Assumptions</span>
          </button>
        </nav>
        <div className="privacy-callout">
          <ShieldAlert aria-hidden="true" />
          <span>Enter metadata only. Do not enter sensitive source content or raw dataset details.</span>
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
            Storage pricing uses live provider list prices where available. Databricks DBU rates and final costs must still be validated against internal enterprise rate cards.
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
                <BarChart data={scenarioComparison} margin={{ top: 8, right: 14, left: 10, bottom: 32 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} height={42} tickMargin={8} />
                  <YAxis tickFormatter={(value) => shortMoney(value, estimate?.currency)} />
                  <Tooltip formatter={(value) => money(Number(value), estimate?.currency)} />
                  <Bar dataKey="value" radius={[6, 6, 0, 0]} fill="#2563eb" />
                </BarChart>
              </ResponsiveContainer>
            </ChartPanel>

            <ChartPanel title="Storage vs compute" icon={<Cloud size={18} />}>
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
                    }
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
                <BarChart data={annualData} margin={{ top: 8, right: 14, left: 10, bottom: 32 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" height={42} tickMargin={8} />
                  <YAxis tickFormatter={(value) => shortMoney(value, estimate?.currency)} />
                  <Tooltip formatter={(value) => money(Number(value), estimate?.currency)} />
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
                onChange={(value) => setDataset({ ...dataset, region: value })}
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
              <NumberField
                label="Replication/backup factor"
                value={dataset.replication_factor}
                onChange={(value) => setDataset({ ...dataset, replication_factor: value })}
              />
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={dataset.mask_names_in_report}
                onChange={(event) => setDataset({ ...dataset, mask_names_in_report: event.target.checked })}
              />
              <span>Mask file and folder names in generated report views</span>
            </label>
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
              <NumberField label="DBU rate (internal rate card)" value={sqlCompute.dbu_rate ?? pricing?.databricks.default_dbu_rate ?? 0} onChange={(value) => setSqlCompute({ ...sqlCompute, dbu_rate: value })} />
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

          <section className="panel">
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
              <NumberField label="Job DBU rate (internal rate card)" value={jobCompute.dbu_rate ?? pricing?.databricks.default_dbu_rate ?? 0} onChange={(value) => setJobCompute({ ...jobCompute, dbu_rate: value })} />
              <NumberField label="Pipelines/jobs" value={jobCompute.number_of_jobs} onChange={(value) => setJobCompute({ ...jobCompute, number_of_jobs: value })} />
            </div>
          </section>

          <section className="panel ai-panel">
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
              <NumberField label="AI/BI DBU rate (internal rate card)" value={aiBi.dbu_rate ?? pricing?.databricks.default_dbu_rate ?? 0} onChange={(value) => setAiBi({ ...aiBi, dbu_rate: value })} disabled={!aiBi.enabled} />
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
              ["Replication factor", "Backup or replication multiplier applied to storage."]
            ]}
          />
          <KnowledgeCard
            title="Storage"
            rows={[
              ["Storage class", "Cloud object storage tier such as S3 Standard, ADLS Hot, or GCP Nearline. AWS and Azure storage prices are fetched live where available."],
              ["Read/write requests", "Optional request volume for request-based storage charges."],
              ["Buffer %", "Contingency added to the total estimate for uncertainty."]
            ]}
          />
          <KnowledgeCard
            title="Databricks SQL"
            rows={[
              ["Warehouse type", "Serverless, Pro, or Classic warehouse assumption."],
              ["Warehouse size", "Configured DBU/hour size, or custom DBU/hour when needed."],
              ["DBU rate", "Configured price per DBU from the internal rate card. Public DBU rates are not fetched automatically in this version."],
              ["Queries/month", "Expected monthly interactive or dashboard query count."],
              ["Runtime minutes", "Average active compute time per query."],
              ["Concurrent users", "Used when applying the optional concurrency multiplier."],
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
            title="Results"
            rows={[
              ["Monthly estimate", "Storage, SQL compute, jobs, and optional AI/BI combined."],
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
            example="8 DBU/hour x $0.70 x (300 queries x 4 min / 60) = $112/month"
            note="If the concurrency multiplier is enabled, query hours are multiplied by the configured concurrency factor."
          />
          <FormulaExampleCard
            title="Job and ingestion compute"
            formula="DBU/hour x DBU rate x job hours x number of jobs"
            example="4 DBU/hour x $0.70 x (30 runs x 20 min / 60) x 2 jobs = $56/month"
            note="Use this for scheduled ingestion, metadata scans, refresh jobs, or recurring report pipelines."
          />
          <FormulaExampleCard
            title="Optional AI/BI layer"
            formula="DBU/hour x DBU rate x question hours"
            example="16 DBU/hour x $0.70 x (25 users x 20 questions x 2 min / 60) = $186.67/month"
            note="This layer is excluded from baseline estimates unless the AI/BI toggle is enabled."
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
          title="Databricks SQL"
          status="manual"
          rows={[
            ["Rate source", "Internal/manual DBU assumption"],
            ["Warehouse type", labelize(String(sql.warehouse_type ?? ""))],
            ["Warehouse size", labelize(String(sql.warehouse_size ?? ""))],
            ["DBU/hour", String(sql.dbu_per_hour ?? 0)],
            ["DBU rate", formatUnitPrice(sql.dbu_rate, estimate.currency)]
          ]}
          note="Validate DBU rates against the internal Databricks rate card before stakeholder sign-off."
        />
        <SourceCard
          title="Jobs and optional AI/BI"
          status="manual"
          rows={[
            ["Job rate source", "Internal/manual DBU assumption"],
            ["Job DBU/hour", String(jobs.dbu_per_hour ?? 0)],
            ["Job DBU rate", formatUnitPrice(jobs.dbu_rate, estimate.currency)],
            ["AI/BI enabled", String(aiBi.enabled ?? false)],
            ["AI/BI DBU rate", formatUnitPrice(aiBi.dbu_rate, estimate.currency)]
          ]}
        />
      </div>
    </div>
  );
}

function SourceCard({
  title,
  status,
  rows,
  note
}: {
  title: string;
  status: "live" | "fallback" | "manual";
  rows: Array<[string, string]>;
  note?: string;
}) {
  return (
    <article className="source-card">
      <div className="source-card-topline">
        <h5>{title}</h5>
        <span className={`source-badge ${status}`}>{labelize(status)}</span>
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
  options
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
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

function getComponentAssumptions(estimate: EstimateResponse, label: string) {
  return estimate.components.find((component) => component.label === label)?.assumptions ?? {};
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
  const viewportAnchor = window.scrollY + 140;
  let nextSection = ESTIMATOR_SECTIONS[0];
  for (const section of ESTIMATOR_SECTIONS) {
    const element = document.getElementById(section);
    if (element && element.offsetTop <= viewportAnchor) {
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

function hasAnyLiveStoragePricing(pricing: PricingConfig) {
  return Object.values(pricing.cloud).some((cloud) =>
    Object.values(cloud.regions).some((region) =>
      Object.values(region.storage).some((storage) => storage.pricing_status === "live")
    )
  );
}

export default App;
