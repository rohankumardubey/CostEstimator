from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, Response

from .calculations import build_scenario_comparison, build_scenario_estimate
from .exports import build_csv_summary, build_pdf_report
from .models import EstimateRequest, ExportRequest
from .pricing import (
    list_scenarios,
    load_effective_pricing_config,
    load_effective_pricing_config_for_region,
    refresh_effective_pricing_config,
)


app = FastAPI(
    title="Databricks Cost Estimator API",
    version="0.1.0",
    description="Config-driven indicative estimator for Databricks and cloud storage costs.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/pricing-config")
def pricing_config() -> dict:
    return load_effective_pricing_config()


@app.post("/pricing-config/refresh")
def refresh_pricing_config() -> dict:
    return refresh_effective_pricing_config()


@app.get("/scenarios")
def scenarios() -> dict:
    return list_scenarios(load_effective_pricing_config())


@app.post("/estimate")
def estimate(request: EstimateRequest):
    pricing = load_effective_pricing_config_for_region(
        request.dataset.cloud_provider.value,
        request.dataset.region,
        request.cross_region_transfer.destination_region
        if request.cross_region_transfer.enabled
        else None,
    )
    return build_scenario_estimate(request, pricing)


@app.post("/scenario-comparison")
def scenario_comparison(request: EstimateRequest):
    pricing = load_effective_pricing_config_for_region(
        request.dataset.cloud_provider.value,
        request.dataset.region,
        request.cross_region_transfer.destination_region
        if request.cross_region_transfer.enabled
        else None,
    )
    return build_scenario_comparison(request, pricing)


@app.post("/export/json")
def export_json(export_request: ExportRequest):
    return JSONResponse(
        content=export_request.model_dump(mode="json"),
        headers={"Content-Disposition": "attachment; filename=databricks-cost-estimate.json"},
    )


@app.post("/export/csv")
def export_csv(export_request: ExportRequest):
    return PlainTextResponse(
        content=build_csv_summary(export_request),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=databricks-cost-estimate.csv"},
    )


@app.post("/export/pdf")
def export_pdf(export_request: ExportRequest):
    return Response(
        content=build_pdf_report(export_request),
        media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename=databricks-cost-estimate.pdf"},
    )
