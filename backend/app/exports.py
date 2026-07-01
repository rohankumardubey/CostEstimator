from __future__ import annotations

import csv
import io
from typing import Any

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import landscape, letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from .models import ExportRequest


def build_csv_summary(export_request: ExportRequest) -> str:
    output = io.StringIO()
    writer = csv.writer(output)
    estimate = export_request.estimate
    request = export_request.request

    writer.writerow(["section", "metric", "value"])
    writer.writerow(["dataset", "team_name", request.dataset.team_name])
    writer.writerow(["dataset", "brand_or_dataset_name", request.dataset.brand_or_dataset_name])
    writer.writerow(["dataset", "cloud_provider", request.dataset.cloud_provider.value])
    writer.writerow(["dataset", "region", request.dataset.region])
    writer.writerow(["dataset", "total_data_size_gb", request.dataset.total_data_size_gb])
    writer.writerow(["dataset", "file_count", request.dataset.file_count])
    writer.writerow(["scenario", "selected_scenario", estimate.scenario_title])
    writer.writerow(["estimate", "monthly_storage_cost", estimate.monthly_storage_cost])
    writer.writerow(["estimate", "monthly_sql_compute_cost", estimate.monthly_sql_compute_cost])
    writer.writerow(["estimate", "monthly_job_compute_cost", estimate.monthly_job_compute_cost])
    writer.writerow(["estimate", "monthly_ai_bi_cost", estimate.monthly_ai_bi_cost])
    writer.writerow(["estimate", "monthly_cross_region_dr_cost", estimate.monthly_cross_region_transfer_cost])
    writer.writerow(["estimate", "one_time_cross_region_dr_cost", estimate.one_time_cross_region_transfer_cost])
    writer.writerow(["estimate", "total_monthly_estimate", estimate.total_monthly_estimate])
    writer.writerow(["estimate", "total_annual_estimate", estimate.total_annual_estimate])
    writer.writerow(["estimate", "estimate_with_buffer_monthly", estimate.estimate_with_buffer_monthly])
    writer.writerow(["estimate", "estimate_with_buffer_annual", estimate.estimate_with_buffer_annual])
    writer.writerow(["estimate", "confidence_score", estimate.confidence_score])
    writer.writerow(["estimate", "confidence_level", estimate.confidence_level])
    writer.writerow(["estimate", "generated_at", estimate.generated_at])
    if export_request.recommendation:
        writer.writerow(["recommendation", "scenario", export_request.recommendation.title])
        writer.writerow(["recommendation", "summary", export_request.recommendation.summary])
        for reason in export_request.recommendation.reasons:
            writer.writerow(["recommendation", "reason", reason])
    for warning in estimate.warnings:
        writer.writerow(["warning", warning.severity, warning.message])
    writer.writerow([])
    writer.writerow(["pricing_source", "name", "value"])
    for key, value in _pricing_source_rows(export_request):
        writer.writerow(["pricing_source", key, value])
    writer.writerow([])
    writer.writerow(["assumption", "name", "value"])
    for key, value in _flatten_dict(estimate.assumptions).items():
        writer.writerow(["assumption", key, value])
    for component in estimate.components:
        for key, value in _flatten_dict(component.assumptions).items():
            writer.writerow([component.label, key, value])
    writer.writerow(["disclaimer", "text", estimate.disclaimer])
    return output.getvalue()


def build_pdf_report(export_request: ExportRequest) -> bytes:
    buffer = io.BytesIO()
    estimate = export_request.estimate
    request = export_request.request
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "ReportTitle",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=16,
        leading=18,
        textColor=colors.white,
        alignment=TA_LEFT,
    )
    header_meta_style = ParagraphStyle(
        "HeaderMeta",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=6.8,
        leading=8,
        textColor=colors.HexColor("#D0D5DD"),
        alignment=TA_RIGHT,
    )
    section_style = ParagraphStyle(
        "Section",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=9,
        leading=10,
        textColor=colors.HexColor("#101828"),
        spaceBefore=4,
        spaceAfter=2,
    )
    body_style = ParagraphStyle(
        "Body",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=6.9,
        leading=8.1,
        textColor=colors.HexColor("#344054"),
        alignment=TA_LEFT,
    )
    small_style = ParagraphStyle(
        "Small",
        parent=body_style,
        fontSize=6.2,
        leading=7.3,
        textColor=colors.HexColor("#475467"),
    )

    doc = SimpleDocTemplate(
        buffer,
        pagesize=landscape(letter),
        rightMargin=0.32 * inch,
        leftMargin=0.32 * inch,
        topMargin=0.24 * inch,
        bottomMargin=0.24 * inch,
    )

    story: list[Any] = [
        _report_header(estimate.generated_at, title_style, header_meta_style),
        Spacer(1, 5),
    ]

    dataset_rows = [
        ["Team", request.dataset.team_name],
        ["Dataset", request.dataset.brand_or_dataset_name],
        ["Scenario", estimate.scenario_title],
        ["Cloud / region", f"{request.dataset.cloud_provider.value.upper()} / {request.dataset.region}"],
        ["Data size", f"{request.dataset.total_data_size_gb:,.2f} GB"],
        ["Files", f"{request.dataset.file_count:,}"],
        ["Archive / structured / document files", f"{request.dataset.zip_archive_file_count:,} / {request.dataset.structured_file_count:,} / {request.dataset.document_file_count:,}"],
        ["Growth / envs / redundancy", f"{request.dataset.annual_growth_percentage:g}% / {request.dataset.number_of_environments} / {request.dataset.redundancy_model.value.replace('_', ' ')} ({request.dataset.replication_factor:g}x)"],
    ]

    kpi_rows = [
        ["Metric", "Monthly", "Annual"],
        ["Storage", _money(estimate.monthly_storage_cost, estimate.currency), _money(estimate.monthly_storage_cost * 12, estimate.currency)],
        ["SQL compute", _money(estimate.monthly_sql_compute_cost, estimate.currency), _money(estimate.monthly_sql_compute_cost * 12, estimate.currency)],
        ["Job compute", _money(estimate.monthly_job_compute_cost, estimate.currency), _money(estimate.monthly_job_compute_cost * 12, estimate.currency)],
        ["AI/BI optional", _money(estimate.monthly_ai_bi_cost, estimate.currency), _money(estimate.monthly_ai_bi_cost * 12, estimate.currency)],
        ["Cross-region DR", _money(estimate.monthly_cross_region_transfer_cost, estimate.currency), _money(estimate.monthly_cross_region_transfer_cost * 12, estimate.currency)],
        ["One-time DR transfer", _money(estimate.one_time_cross_region_transfer_cost, estimate.currency), "-"],
        ["Total", _money(estimate.total_monthly_estimate, estimate.currency), _money(estimate.total_annual_estimate, estimate.currency)],
        [f"With {estimate.buffer_percentage:g}% buffer", _money(estimate.estimate_with_buffer_monthly, estimate.currency), _money(estimate.estimate_with_buffer_annual, estimate.currency)],
    ]

    top_table = Table(
        [
            [
                _section_block("Dataset and scenario", dataset_rows, body_style),
                _kpi_block("Cost summary", kpi_rows, body_style),
            ]
        ],
        colWidths=[4.95 * inch, 5.25 * inch],
    )
    top_table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ]
        )
    )
    story.append(top_table)

    if export_request.recommendation:
        story.append(Paragraph("Scenario recommendation", section_style))
        recommendation_rows = [
            ["Recommended scenario", export_request.recommendation.title],
            ["Summary", _clip_text(export_request.recommendation.summary, 130)],
            ["Reasons", _clip_text("; ".join(export_request.recommendation.reasons[:3]), 230)],
        ]
        story.append(_dense_table(recommendation_rows, body_style))

    story.append(Paragraph("Confidence and pricing sources", section_style))
    confidence_rows = [
        ["Confidence", f"{estimate.confidence_level} ({estimate.confidence_score})"],
        ["Warnings", _clip_text(_warning_summary(estimate), 190)],
        ["Pricing refresh", str((export_request.pricing_source or {}).get("updated_at", "Not available"))],
        ["Storage source", str(_component_assumption(estimate, "Storage", "pricing_source"))],
        ["Storage status", str(_component_assumption(estimate, "Storage", "pricing_status"))],
        ["Storage note", _clip_text(str(_component_assumption(estimate, "Storage", "pricing_note")), 95)],
        ["SQL DBU source", str(_component_assumption(estimate, "Databricks SQL compute", "dbu_rate_source"))],
        ["Job DBU source", str(_component_assumption(estimate, "Job/ingestion compute", "dbu_rate_source"))],
        ["AI/BI DBU source", str(_component_assumption(estimate, "AI/BI optional layer", "dbu_rate_source"))],
        ["DR source", str(_component_assumption(estimate, "Cross-region DR", "price_source"))],
        ["DR status", str(_component_assumption(estimate, "Cross-region DR", "pricing_status"))],
    ]
    story.append(_dense_table(confidence_rows, body_style))

    story.append(Paragraph("Pricing assumptions used", section_style))
    assumptions_rows = [
        ["Storage class", str(_component_assumption(estimate, "Storage", "storage_display_name"))],
        ["Storage price/GB-month", str(_component_assumption(estimate, "Storage", "price_per_gb_month"))],
        ["Effective GB with growth", str(_component_assumption(estimate, "Storage", "effective_gb_with_growth"))],
        ["SQL warehouse", f"{request.sql_compute.warehouse_type.value} / {request.sql_compute.warehouse_size}"],
        ["SQL DBU/hour", str(_component_assumption(estimate, "Databricks SQL compute", "dbu_per_hour"))],
        ["SQL DBU rate", str(_component_assumption(estimate, "Databricks SQL compute", "dbu_rate"))],
        ["Queries/month", f"{request.sql_compute.queries_per_month:,}"],
        ["Avg query runtime", f"{request.sql_compute.average_query_runtime_minutes:g} minutes"],
        ["Job cluster", request.job_compute.job_cluster_size],
        ["Job DBU/hour", str(_component_assumption(estimate, "Job/ingestion compute", "dbu_per_hour"))],
        ["Job DBU rate", str(_component_assumption(estimate, "Job/ingestion compute", "dbu_rate"))],
        ["Job runs/month", f"{request.job_compute.job_runs_per_month:,}"],
        ["AI/BI enabled", "Yes" if request.ai_bi.enabled else "No"],
        ["Cross-region DR enabled", "Yes" if request.cross_region_transfer.enabled else "No"],
        ["Cross-region DR route", f"{request.dataset.region} -> {request.cross_region_transfer.destination_region or 'not selected'}"],
        ["Cross-region transfer price/GB", str(_component_assumption(estimate, "Cross-region DR", "price_per_gb"))],
        ["Cost per GB/month", _money(estimate.cost_per_gb_monthly, estimate.currency)],
        ["Cost per 1,000 files/month", _money(estimate.cost_per_1000_files_monthly, estimate.currency)],
    ]
    story.append(_dense_table(assumptions_rows, body_style))

    story.append(Paragraph("Notes and disclaimer", section_style))
    story.append(
        Paragraph(
            "This report is generated from metadata-level inputs only. It should not include raw source files, "
            "sensitive documents, or business content.",
            small_style,
        )
    )
    story.append(Paragraph(estimate.disclaimer, small_style))

    doc.build(story)
    buffer.seek(0)
    return buffer.getvalue()


def _flatten_dict(data: dict[str, Any], prefix: str = "") -> dict[str, Any]:
    flattened: dict[str, Any] = {}
    for key, value in data.items():
        next_key = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            flattened.update(_flatten_dict(value, next_key))
        else:
            flattened[next_key] = value
    return flattened


def _pricing_source_rows(export_request: ExportRequest) -> list[tuple[str, Any]]:
    estimate = export_request.estimate
    pricing_source = export_request.pricing_source or {}
    return [
        ("pricing_mode", pricing_source.get("mode", "Not available")),
        ("pricing_refresh_timestamp", pricing_source.get("updated_at", "Not available")),
        ("storage_source", _component_assumption(estimate, "Storage", "pricing_source")),
        ("storage_status", _component_assumption(estimate, "Storage", "pricing_status")),
        ("storage_note", _component_assumption(estimate, "Storage", "pricing_note")),
        ("storage_price_per_gb_month", _component_assumption(estimate, "Storage", "price_per_gb_month")),
        ("storage_read_request_per_1000", _component_assumption(estimate, "Storage", "read_request_per_1000")),
        ("storage_write_request_per_1000", _component_assumption(estimate, "Storage", "write_request_per_1000")),
        ("storage_monitoring_per_1000_objects", _component_assumption(estimate, "Storage", "monitoring_per_1000_objects")),
        ("cross_region_dr_enabled", _component_assumption(estimate, "Cross-region DR", "enabled")),
        ("cross_region_dr_route", f"{_component_assumption(estimate, 'Cross-region DR', 'source_region')} -> {_component_assumption(estimate, 'Cross-region DR', 'destination_region')}"),
        ("cross_region_dr_price_per_gb", _component_assumption(estimate, "Cross-region DR", "price_per_gb")),
        ("cross_region_dr_price_source", _component_assumption(estimate, "Cross-region DR", "price_source")),
        ("cross_region_dr_pricing_status", _component_assumption(estimate, "Cross-region DR", "pricing_status")),
        ("sql_dbu_rate_source", _component_assumption(estimate, "Databricks SQL compute", "dbu_rate_source")),
        ("job_dbu_rate_source", _component_assumption(estimate, "Job/ingestion compute", "dbu_rate_source")),
        ("ai_bi_dbu_rate_source", _component_assumption(estimate, "AI/BI optional layer", "dbu_rate_source")),
    ]


def _warning_summary(estimate: Any) -> str:
    if not estimate.warnings:
        return "No warnings"
    return "; ".join(f"{warning.severity}: {warning.message}" for warning in estimate.warnings[:3])


def _money(value: float, currency: str) -> str:
    return f"{currency} {value:,.2f}"


def _clip_text(value: str, max_length: int) -> str:
    if len(value) <= max_length:
        return value
    return f"{value[: max_length - 3].rstrip()}..."


def _report_header(
    generated_at: str,
    title_style: ParagraphStyle,
    header_meta_style: ParagraphStyle,
) -> Table:
    table = Table(
        [
            [
                Paragraph("Databricks Cost Estimator", title_style),
                Paragraph(
                    "Indicative estimate based on configurable pricing assumptions.<br/>"
                    f"Generated {generated_at}",
                    header_meta_style,
                ),
            ]
        ],
        colWidths=[4.6 * inch, 5.6 * inch],
    )
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#101828")),
                ("BOX", (0, 0), (-1, -1), 1.0, colors.HexColor("#101828")),
                ("LINEBELOW", (0, 0), (-1, -1), 2.0, colors.HexColor("#2563EB")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ]
        )
    )
    return table


def _section_block(title: str, rows: list[list[str]], body_style: ParagraphStyle) -> Table:
    table_rows: list[list[Any]] = [[Paragraph(f"<b>{title}</b>", body_style), ""]]
    for label, value, *rest in rows:
        values = [value, *rest]
        table_rows.append([Paragraph(f"<b>{label}</b>", body_style), Paragraph(str(values[0]), body_style)])

    table = Table(table_rows, colWidths=[1.8 * inch, 3.05 * inch])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EAF2FF")),
                ("SPAN", (0, 0), (-1, 0)),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#101828")),
                ("BOX", (0, 0), (-1, -1), 0.75, colors.HexColor("#98A2B3")),
                ("INNERGRID", (0, 1), (-1, -1), 0.4, colors.HexColor("#D0D5DD")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 2.7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2.7),
            ]
        )
    )
    return table


def _kpi_block(title: str, rows: list[list[str]], body_style: ParagraphStyle) -> Table:
    table_rows: list[list[Any]] = [[Paragraph(f"<b>{title}</b>", body_style), "", ""]]
    table_rows.extend(
        [Paragraph(str(cell), body_style) for cell in row]
        for row in rows
    )
    table = Table(table_rows, colWidths=[1.9 * inch, 1.45 * inch, 1.7 * inch])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EAF2FF")),
                ("SPAN", (0, 0), (-1, 0)),
                ("BACKGROUND", (0, 1), (-1, 1), colors.HexColor("#F2F4F7")),
                ("BOX", (0, 0), (-1, -1), 0.75, colors.HexColor("#98A2B3")),
                ("INNERGRID", (0, 1), (-1, -1), 0.4, colors.HexColor("#D0D5DD")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 2.7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2.7),
            ]
        )
    )
    return table


def _dense_table(rows: list[list[str]], body_style: ParagraphStyle) -> Table:
    paired_rows = []
    for index in range(0, len(rows), 3):
        chunk = rows[index : index + 3]
        row: list[Any] = []
        for label, value in chunk:
            row.extend([Paragraph(f"<b>{label}</b>", body_style), Paragraph(value, body_style)])
        while len(row) < 6:
            row.extend(["", ""])
        paired_rows.append(row)

    table = Table(
        paired_rows,
        colWidths=[1.35 * inch, 2.05 * inch, 1.25 * inch, 1.85 * inch, 1.55 * inch, 2.15 * inch],
    )
    table.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.75, colors.HexColor("#98A2B3")),
                ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#D0D5DD")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 2.5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
            ]
        )
    )
    return table


def _component_assumption(estimate: Any, label: str, key: str) -> Any:
    for component in estimate.components:
        if component.label == label:
            return component.assumptions.get(key, "")
    return ""
