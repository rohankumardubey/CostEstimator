# Databricks Cost Estimator

A reusable internal web app for indicative Databricks and cloud storage cost estimation. It is designed for teams moving legacy data or analytical datasets into cloud storage plus Databricks architecture.

The app is deterministic in its calculations and uses live public storage pricing where available. Databricks DBU rates remain explicit assumptions because enterprise rate cards and committed discounts vary by account.

## Use cases

- Archive-only storage estimates.
- Basic query access for occasional business users.
- Scheduled reporting and dashboard refreshes.
- Self-service analytics with higher query volume.
- Optional future AI/BI or Genie-style usage.
- Manual metadata-based estimation without uploading raw dataset files.
- Optional cross-region DR estimates for replicated storage, changed-data transfer, and cross-region reads.
- Optional support cost uplift and optional Databricks/cloud discount percentages.

## Architecture

- Frontend: React, TypeScript, Vite, Recharts, lucide-react.
- Backend: Python FastAPI with Pydantic validation.
- Config: `config/pricing.yaml`.
- Tests: pytest unit and API tests for backend calculation behavior.
- Containers: Dockerfiles for frontend and backend plus `docker-compose.yml`.

## Run locally without Docker

Use the local runner when you want to start the FastAPI backend and Vite frontend directly on your machine:

```bash
./run.sh
```

Then open:

- Frontend: http://127.0.0.1:5173
- Backend API docs: http://127.0.0.1:8000/docs
- Health check: http://127.0.0.1:8000/health

The script creates or reuses the root `.venv`, installs backend dependencies when `backend/requirements.txt` changes, installs frontend dependencies when needed, starts both services, and stops both when you press `Ctrl+C`.

You can also run:

```bash
make local
```

## Run locally with Docker

```bash
docker-compose up --build
```

Then open:

- Frontend: http://localhost:5173
- Backend API docs: http://localhost:8000/docs
- Health check: http://localhost:8000/health

Docker remains useful when you want the containerized setup, closer deployment parity, or a clean isolated environment.

## Simple login

The frontend includes a lightweight login gate for internal demos. By default:

- Username: `admin`
- Password: `databricks`

Override these at frontend build time with:

```bash
VITE_APP_USERNAME=my-user VITE_APP_PASSWORD=my-password npm run build
```

This is not a replacement for production SSO. For a company deployment, put the app behind the internal SSO/VPN/gateway and use these credentials only as a simple first-pass gate.

## Tests

```bash
cd backend
PYTHONPATH=. pytest
```

Or from the repository root:

```bash
make test
```

## Pricing configuration and live pricing

Scenario defaults, warehouse sizes, DBU/hour assumptions, fallback prices, and non-price defaults live in `config/pricing.yaml`.

When `PRICING_SOURCE=live`, the backend overlays live public storage list prices for the selected estimate region where possible:

- AWS S3 storage pricing from the AWS public Price List API.
- Azure ADLS Gen2 storage pricing from the Azure Retail Prices API.
- GCP storage pricing currently uses fallback config unless `GCP_BILLING_API_KEY` is provided and SKU mapping is enabled.

Databricks DBU rates remain configured/manual assumptions. The default config separates SQL warehouse, jobs, and AI/BI DBU rates using public list-price references, but these should be replaced with internal Databricks enterprise rate-card values before stakeholder use.

AWS includes a broad set of commercial regions in the dropdown. Config-mode fallback values are indicative placeholders; live mode fetches AWS public Price List values only for the currently selected estimate region and caches them.

The config includes:

- Currency and default buffer percentage.
- Cross-region DR fallback transfer prices by cloud/provider route.
- Cloud providers, regions, and storage classes.
- Storage price per GB-month.
- Optional object monitoring costs per 1,000 objects.
- Optional read and write request prices per 1,000 requests.
- Databricks fallback DBU rate plus workload-specific SQL, jobs, and AI/BI DBU rates.
- SQL warehouse sizes and DBU/hour assumptions.
- Job cluster defaults and DBU/hour assumptions.
- Scenario defaults for archive, query, reporting, analytics, and future AI/BI.

Update this file when FinOps, platform, or data engineering teams refresh DBU rates, scenario defaults, or fallback assumptions. No backend code changes should be required for standard assumption updates.

## Formula summary

Storage uses an average-year growth adjustment:

```text
effective_gb = data_size_gb * (1 + annual_growth_percentage / 100 / 2)

monthly_storage_cost =
  effective_gb
  * storage_price_per_gb_month
  * storage_copy_multiplier
  * environment_multiplier
  + object_monitoring_cost
  + request_cost
```

The UI exposes this as a redundancy model plus the numeric storage copy multiplier:

- Single copy: `1x`
- Backup copy: `2x`
- Custom multiplier: user-entered multiplier from platform or FinOps.

Cross-region DR is optional and disabled by default. When enabled, storage is costed at a minimum of `2x` copies if the DR storage copy option is enabled, and transfer/access cost is added separately:

```text
one_time_replication_cost =
  initial_replication_gb * transfer_price_per_gb

monthly_cross_region_dr_cost =
  (monthly_changed_data_gb + monthly_cross_region_read_gb)
  * transfer_price_per_gb
  + optional_initial_replication_amortization
```

AWS route-level transfer pricing is attempted from the public AWS Price List API when live pricing is enabled. If the route cannot be matched cleanly, configured fallback values are used and shown in the assumptions panel.

SQL compute:

```text
monthly_query_hours =
  queries_per_month * average_query_runtime_minutes / 60

monthly_sql_compute_cost =
  warehouse_dbu_per_hour
  * dbu_rate
  * monthly_query_hours
  * optional_concurrency_multiplier
```

Job compute:

```text
monthly_job_hours =
  job_runs_per_month
  * average_job_runtime_minutes / 60
  * number_of_jobs

monthly_job_compute_cost =
  job_cluster_dbu_per_hour
  * job_dbu_rate
  * monthly_job_hours
```

AI/BI is disabled by default:

```text
monthly_ai_bi_hours =
  expected_users
  * questions_per_user_per_month
  * average_runtime_minutes_per_question / 60

monthly_ai_bi_cost =
  dbu_per_hour * dbu_rate * monthly_ai_bi_hours
```

Support uplift defaults to zero and is visible in the UI:

```text
monthly_support_cost =
  monthly_subtotal_after_discounts_before_support
  * support_cost_percentage / 100
```

Discounts default to zero and are not included unless entered:

```text
monthly_discount_amount =
  cloud_monthly_subtotal * cloud_discount_percentage / 100
  + databricks_monthly_subtotal * databricks_discount_percentage / 100
```

Cloud discount applies to storage and cross-region DR. Databricks discount applies to SQL, jobs, and AI/BI compute. Support uplift is added after discounts and before the buffer is applied.

Buffered estimate:

```text
estimate_with_buffer = total_estimate * (1 + buffer_percentage / 100)
```

## Dataset metadata entry

The app is designed for manual entry of aggregate dataset metadata:

- Total data size in GB.
- Total file count.
- Archive, structured, and document file counts.
- Annual growth percentage.
- Environment count.
- Redundancy model and storage copy multiplier.
- Optional cross-region DR destination, initial replication GB, monthly changed-data GB, and monthly cross-region read GB.
- Optional support cost percentage, Databricks discount percentage, and cloud discount percentage.

Do not enter raw file contents, source document text, or sensitive business data.

## Save and load estimates

Use the UI `Save` button to download an editable JSON file that contains the current inputs and selected scenario. Use `Load` to restore that file later and continue editing in the app.

After loading or saving, the UI shows a confirmation message. Use `Reset` to restore the sample defaults and start a fresh estimate.

This is local-only. The app does not store saved estimates on the backend, and no database or user account is required.

## Security and privacy

- Do not upload actual source documents, raw dataset files, or sensitive business content.
- Enter aggregate metadata only.

## API endpoints

- `GET /health`
- `GET /pricing-config`
- `POST /pricing-config/refresh`
- `GET /scenarios`
- `POST /estimate`
- `POST /scenario-comparison`
- `POST /export/json`
- `POST /export/csv`
- `POST /export/pdf`

## Sample default data

The UI loads sample defaults for:

- Dataset: Legacy collaboration archive
- Total size: 31.13 GB
- Total files: 7,497
- ZIP files: 4,771
- Structured files: 12
- Dominant category: archive/document-heavy
- Suggested scenarios: Archive-only or Basic query

These are placeholders only. The estimator remains generic for platform, analytics, operations, product, and other data teams.

## Limitations

- Estimates are indicative, not invoices or official quotes.
- Databricks DBU rates are assumptions until replaced with internal rate cards.
- Auto-stop behavior is captured as an assumption but not simulated as idle warehouse runtime.
- No user authentication or persistence is included in this first version.

## Deployment notes

- Replace DBU rates and fallback assumptions in `config/pricing.yaml` before stakeholder use.
- Put the backend behind standard internal authentication and network controls.
- Set `PRICING_CONFIG_PATH` if pricing config is mounted outside the container image.
- Set `PRICING_SOURCE=live` to enable live public storage pricing overlay.
- Add durable persistence only if teams need saved estimates or audit history.
- Add CI for `pytest`, frontend build, and container image scanning.

## Screenshots

Screenshots can be added here after deployment in the target internal environment.
