from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, Response

from .calculations import build_scenario_comparison, build_scenario_estimate
from .exports import build_csv_summary, build_pdf_report
from .models import EstimateRequest, ExportRequest, SavedEstimateCreate, SavedEstimateListResponse
from .persistence import delete_saved_estimate, get_saved_estimate, initialize_database, list_saved_estimates, save_estimate
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


@app.on_event("startup")
def startup() -> None:
    initialize_database()

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


@app.get("/estimates", response_model=SavedEstimateListResponse)
def saved_estimates() -> SavedEstimateListResponse:
    return SavedEstimateListResponse(estimates=list_saved_estimates())


@app.post("/estimates")
def create_saved_estimate(payload: SavedEstimateCreate):
    pricing = load_effective_pricing_config_for_region(
        payload.request.dataset.cloud_provider.value,
        payload.request.dataset.region,
        payload.request.cross_region_transfer.destination_region
        if payload.request.cross_region_transfer.enabled
        else None,
    )
    estimate_response = build_scenario_estimate(payload.request, pricing)
    return save_estimate(
        payload.request,
        estimate_response,
        pricing_source=payload.pricing_source or pricing.get("pricing_source"),
        title=payload.title,
    )


@app.get("/estimates/{estimate_id}")
def saved_estimate(estimate_id: str):
    return get_saved_estimate(estimate_id)


@app.delete("/estimates/{estimate_id}")
def delete_estimate(estimate_id: str) -> dict[str, str]:
    delete_saved_estimate(estimate_id)
    return {"status": "deleted", "id": estimate_id}


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
