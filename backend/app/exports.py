from __future__ import annotations

import csv
import io
from html import escape
from typing import Any

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
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
    writer.writerow(["estimate", "monthly_discount_amount", estimate.monthly_discount_amount])
    writer.writerow(["estimate", "monthly_support_cost", estimate.monthly_support_cost])
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
        fontSize=18,
        leading=20,
        textColor=colors.white,
        alignment=TA_LEFT,
    )
    subtitle_style = ParagraphStyle(
        "ReportSubtitle",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=7.2,
        leading=9,
        textColor=colors.HexColor("#D0D5DD"),
        alignment=TA_LEFT,
    )
    header_meta_style = ParagraphStyle(
        "HeaderMeta",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=6.6,
        leading=8,
        textColor=colors.HexColor("#D0D5DD"),
        alignment=TA_RIGHT,
    )
    section_style = ParagraphStyle(
        "Section",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=8.4,
        leading=9.4,
        textColor=colors.HexColor("#101828"),
        spaceBefore=4,
        spaceAfter=2,
    )
    body_style = ParagraphStyle(
        "Body",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=6.5,
        leading=7.6,
        textColor=colors.HexColor("#344054"),
        alignment=TA_LEFT,
    )
    small_style = ParagraphStyle(
        "Small",
        parent=body_style,
        fontSize=5.9,
        leading=7,
        textColor=colors.HexColor("#475467"),
    )
    card_label_style = ParagraphStyle(
        "CardLabel",
        parent=body_style,
        fontName="Helvetica-Bold",
        fontSize=5.8,
        leading=6.6,
        textColor=colors.HexColor("#667085"),
        alignment=TA_CENTER,
    )
    card_value_style = ParagraphStyle(
        "CardValue",
        parent=body_style,
        fontName="Helvetica-Bold",
        fontSize=11.4,
        leading=12.4,
        textColor=colors.HexColor("#101828"),
        alignment=TA_CENTER,
    )

    doc = SimpleDocTemplate(
        buffer,
        pagesize=landscape(letter),
        rightMargin=0.28 * inch,
        leftMargin=0.28 * inch,
        topMargin=0.22 * inch,
        bottomMargin=0.2 * inch,
    )

    story: list[Any] = [
        _report_header(estimate.generated_at, title_style, subtitle_style, header_meta_style),
        Spacer(1, 6),
    ]

    compute_monthly = (
        estimate.monthly_sql_compute_cost
        + estimate.monthly_job_compute_cost
        + estimate.monthly_ai_bi_cost
    )
    card_rows = [
        ["Monthly estimate", _money(estimate.total_monthly_estimate, estimate.currency)],
        ["Buffered annual", _money(estimate.estimate_with_buffer_annual, estimate.currency)],
        ["Storage", _money(estimate.monthly_storage_cost, estimate.currency)],
        ["Compute", _money(compute_monthly, estimate.currency)],
        ["Support / discounts", f"{_money(estimate.monthly_support_cost, estimate.currency)} / -{_money(estimate.monthly_discount_amount, estimate.currency)}"],
        ["Confidence", f"{estimate.confidence_level} {estimate.confidence_score}/100"],
    ]
    story.append(_kpi_cards(card_rows, card_label_style, card_value_style))
    story.append(Spacer(1, 6))

    dataset_rows = [
        ["Team", request.dataset.team_name],
        ["Dataset", request.dataset.brand_or_dataset_name],
        ["Scenario", estimate.scenario_title],
        ["Cloud / region", f"{request.dataset.cloud_provider.value.upper()} / {request.dataset.region}"],
        ["Data size", f"{request.dataset.total_data_size_gb:,.2f} GB"],
        ["Files", f"{request.dataset.file_count:,}"],
        ["Archive / structured / document", f"{request.dataset.zip_archive_file_count:,} / {request.dataset.structured_file_count:,} / {request.dataset.document_file_count:,}"],
        ["Growth / environments", f"{request.dataset.annual_growth_percentage:g}% / {request.dataset.number_of_environments}"],
        ["Redundancy", f"{request.dataset.redundancy_model.value.replace('_', ' ')} ({request.dataset.replication_factor:g}x)"],
    ]

    kpi_rows = [
        ["Storage", _money(estimate.monthly_storage_cost, estimate.currency), _money(estimate.monthly_storage_cost * 12, estimate.currency)],
        ["SQL compute", _money(estimate.monthly_sql_compute_cost, estimate.currency), _money(estimate.monthly_sql_compute_cost * 12, estimate.currency)],
        ["Job compute", _money(estimate.monthly_job_compute_cost, estimate.currency), _money(estimate.monthly_job_compute_cost * 12, estimate.currency)],
        ["AI/BI optional", _money(estimate.monthly_ai_bi_cost, estimate.currency), _money(estimate.monthly_ai_bi_cost * 12, estimate.currency)],
        ["Cross-region DR", _money(estimate.monthly_cross_region_transfer_cost, estimate.currency), _money(estimate.monthly_cross_region_transfer_cost * 12, estimate.currency)],
        ["Discount adjustment", f"-{_money(estimate.monthly_discount_amount, estimate.currency)}", f"-{_money(estimate.monthly_discount_amount * 12, estimate.currency)}"],
        ["Support uplift", _money(estimate.monthly_support_cost, estimate.currency), _money(estimate.monthly_support_cost * 12, estimate.currency)],
        ["Total", _money(estimate.total_monthly_estimate, estimate.currency), _money(estimate.total_annual_estimate, estimate.currency)],
        [f"With {estimate.buffer_percentage:g}% buffer", _money(estimate.estimate_with_buffer_monthly, estimate.currency), _money(estimate.estimate_with_buffer_annual, estimate.currency)],
    ]

    story.append(
        _two_column_panels(
            _section_block("Dataset and scope", dataset_rows, body_style, col_widths=[1.55 * inch, 3.45 * inch]),
            _cost_breakdown_block("Cost breakdown", kpi_rows, body_style),
        )
    )
    story.append(Spacer(1, 5))

    recommendation_rows = [["Recommended scenario", "No recommendation supplied"]]
    if export_request.recommendation:
        recommendation_rows = [
            ["Recommended scenario", export_request.recommendation.title],
            ["Summary", _clip_text(export_request.recommendation.summary, 150)],
            ["Reasons", _clip_text("; ".join(export_request.recommendation.reasons[:3]), 260)],
        ]

    confidence_summary = _confidence_explanation(export_request)
    confidence_rows = [
        ["Confidence", f"{estimate.confidence_level} ({estimate.confidence_score})"],
        ["Explanation", _clip_text(confidence_summary, 240)],
        ["Warnings", _clip_text(_warning_summary(estimate), 220)],
    ]
    story.append(
        _two_column_panels(
            _section_block("Scenario recommendation", recommendation_rows, body_style, col_widths=[1.65 * inch, 3.35 * inch]),
            _section_block("Confidence explanation", confidence_rows, body_style, col_widths=[1.45 * inch, 3.55 * inch]),
        )
    )
    story.append(Spacer(1, 5))

    source_rows = [
        ["Pricing mode", str((export_request.pricing_source or {}).get("mode", "Not available"))],
        ["Pricing refresh", _short_timestamp(str((export_request.pricing_source or {}).get("updated_at", "Not available")))],
        ["Storage source", str(_component_assumption(estimate, "Storage", "pricing_source"))],
        ["Storage status", str(_component_assumption(estimate, "Storage", "pricing_status"))],
        ["SQL DBU source", str(_component_assumption(estimate, "Databricks SQL compute", "dbu_rate_source"))],
        ["Job DBU source", str(_component_assumption(estimate, "Job/ingestion compute", "dbu_rate_source"))],
    ]
    workload_rows = [
        ["Storage class", str(_component_assumption(estimate, "Storage", "storage_display_name"))],
        ["Storage price/GB-month", str(_component_assumption(estimate, "Storage", "price_per_gb_month"))],
        ["Effective GB with growth", str(_component_assumption(estimate, "Storage", "effective_gb_with_growth"))],
        ["SQL warehouse", f"{request.sql_compute.warehouse_type.value} / {request.sql_compute.warehouse_size}"],
        ["SQL DBU/hour", str(_component_assumption(estimate, "Databricks SQL compute", "dbu_per_hour"))],
        ["SQL DBU rate", str(_component_assumption(estimate, "Databricks SQL compute", "dbu_rate"))],
        ["Queries/month", f"{request.sql_compute.queries_per_month:,}"],
        ["Job runs/month", f"{request.job_compute.job_runs_per_month:,}"],
    ]
    commercial_rows = [
        ["AI/BI enabled", "Yes" if request.ai_bi.enabled else "No"],
        ["Cross-region DR", "Enabled" if request.cross_region_transfer.enabled else "Disabled"],
        ["DR route", f"{request.dataset.region} -> {request.cross_region_transfer.destination_region or 'not selected'}"],
        ["Support cost %", f"{request.support_cost.support_cost_percentage:g}%"],
        ["Databricks discount %", f"{request.support_cost.databricks_discount_percentage:g}%"],
        ["Cloud discount %", f"{request.support_cost.cloud_discount_percentage:g}%"],
        ["Cost per GB/month", _money(estimate.cost_per_gb_monthly, estimate.currency)],
        ["Cost per 1,000 files/month", _money(estimate.cost_per_1000_files_monthly, estimate.currency)],
    ]
    assumptions_table = Table(
        [
            [
                _section_block("Pricing sources", source_rows, body_style, col_widths=[1.45 * inch, 1.85 * inch]),
                _section_block("Workload assumptions", workload_rows, body_style, col_widths=[1.55 * inch, 1.85 * inch]),
                _section_block("Commercial / scope", commercial_rows, body_style, col_widths=[1.45 * inch, 1.85 * inch]),
            ]
        ],
        colWidths=[3.42 * inch, 3.52 * inch, 3.42 * inch],
    )
    assumptions_table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )
    story.append(assumptions_table)
    story.append(Spacer(1, 4))
    story.append(_validation_strip(body_style))
    story.append(Spacer(1, 4))

    footer_text = (
        "Metadata only - do not include raw source files, sensitive documents, or business content. "
        "Not included unless entered: negotiated discounts, committed-use discounts, support contracts, "
        "network charges outside configured DR inputs, and final workspace configuration. "
        f"{estimate.disclaimer}"
    )
    story.append(_footer_notice(footer_text, small_style))

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
        ("cloud_discount_percentage", _component_assumption(estimate, "Discount adjustment", "cloud_discount_percentage")),
        ("databricks_discount_percentage", _component_assumption(estimate, "Discount adjustment", "databricks_discount_percentage")),
        ("monthly_discount_amount", estimate.monthly_discount_amount),
        ("support_cost_percentage", _component_assumption(estimate, "Support cost uplift", "support_cost_percentage")),
        ("support_cost_method", _component_assumption(estimate, "Support cost uplift", "calculation_method")),
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
    subtitle_style: ParagraphStyle,
    header_meta_style: ParagraphStyle,
) -> Table:
    table = Table(
        [
            [
                [
                    Paragraph("Databricks Cost Estimator", title_style),
                    Paragraph("Indicative scenario estimate for cloud storage and Databricks workloads", subtitle_style),
                ],
                Paragraph(
                    "Generated<br/>"
                    f"{_safe(_short_timestamp(generated_at))}",
                    header_meta_style,
                ),
            ]
        ],
        colWidths=[7.05 * inch, 3.3 * inch],
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


def _kpi_cards(rows: list[list[str]], label_style: ParagraphStyle, value_style: ParagraphStyle) -> Table:
    table_rows: list[list[Any]] = [
        [
            [
                Paragraph(_safe(label), label_style),
                Paragraph(_safe(value), value_style),
            ]
            for label, value in rows
        ]
    ]
    table = Table(table_rows, colWidths=[1.73 * inch] * 6)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.white),
                ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#D8E2F7")),
                ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#D8E2F7")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ]
        )
    )
    return table


def _two_column_panels(left: Table, right: Table) -> Table:
    table = Table([[left, right]], colWidths=[5.12 * inch, 5.25 * inch])
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (0, 0), 7),
                ("RIGHTPADDING", (1, 0), (1, 0), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )
    return table


def _section_block(
    title: str,
    rows: list[list[str]],
    body_style: ParagraphStyle,
    col_widths: list[float] | None = None,
) -> Table:
    widths = col_widths or [1.8 * inch, 3.05 * inch]
    table_rows: list[list[Any]] = [[Paragraph(f"<b>{_safe(title)}</b>", body_style), ""]]
    for label, value, *rest in rows:
        values = [value, *rest]
        table_rows.append([Paragraph(f"<b>{_safe(label)}</b>", body_style), Paragraph(_safe(values[0]), body_style)])

    table = Table(table_rows, colWidths=widths)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EFF6FF")),
                ("SPAN", (0, 0), (-1, 0)),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#101828")),
                ("BOX", (0, 0), (-1, -1), 0.65, colors.HexColor("#D8E2F7")),
                ("INNERGRID", (0, 1), (-1, -1), 0.35, colors.HexColor("#E4E7EC")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 2.4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2.4),
            ]
        )
    )
    return table


def _cost_breakdown_block(title: str, rows: list[list[str]], body_style: ParagraphStyle) -> Table:
    table_rows: list[list[Any]] = [[Paragraph(f"<b>{_safe(title)}</b>", body_style), "", ""]]
    table_rows.append([Paragraph("<b>Cost line</b>", body_style), Paragraph("<b>Monthly</b>", body_style), Paragraph("<b>Annual</b>", body_style)])
    for label, monthly, annual in rows:
        table_rows.append([Paragraph(_safe(label), body_style), Paragraph(_safe(monthly), body_style), Paragraph(_safe(annual), body_style)])

    table = Table(table_rows, colWidths=[2.1 * inch, 1.45 * inch, 1.55 * inch])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EFF6FF")),
                ("SPAN", (0, 0), (-1, 0)),
                ("BACKGROUND", (0, 1), (-1, 1), colors.HexColor("#F2F4F7")),
                ("BOX", (0, 0), (-1, -1), 0.65, colors.HexColor("#D8E2F7")),
                ("INNERGRID", (0, 1), (-1, -1), 0.35, colors.HexColor("#E4E7EC")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 2.3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2.3),
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


def _footer_notice(text: str, small_style: ParagraphStyle) -> Table:
    table = Table([[Paragraph(_safe(_clip_text(text, 540)), small_style)]], colWidths=[10.35 * inch])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#FFFBEB")),
                ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#FEDF89")),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    return table


def _validation_strip(body_style: ParagraphStyle) -> Table:
    rows = [
        [
            Paragraph("<b>Included in this estimate</b><br/>Metadata volume, selected storage tier, Databricks SQL, jobs, optional AI/BI, DR inputs, support uplift, discounts, and buffer when populated.", body_style),
            Paragraph("<b>Validate before approval</b><br/>Internal DBU rate card, enterprise cloud discounts, workspace configuration, DR scope, access pattern, and final FinOps ownership.", body_style),
            Paragraph("<b>Not included unless entered</b><br/>Negotiated discounts, committed-use discounts, support contracts, non-DR network charges, migration project effort, and operational run costs.", body_style),
        ]
    ]
    table = Table(rows, colWidths=[3.42 * inch, 3.42 * inch, 3.42 * inch])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F8FAFC")),
                ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#D8E2F7")),
                ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#D8E2F7")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return table


def _confidence_explanation(export_request: ExportRequest) -> str:
    estimate = export_request.estimate
    request = export_request.request
    if not estimate.warnings:
        parts = ["No active warnings are present."]
    else:
        parts = [f"{len(estimate.warnings)} validation item(s) are active."]

    if request.dataset.total_data_size_gb > 0 and request.dataset.file_count > 0:
        parts.append("Dataset size and file count are populated.")
    if estimate.buffer_percentage > 0:
        parts.append(f"{estimate.buffer_percentage:g}% buffer is included.")
    if request.dataset.replication_factor > 1:
        parts.append(f"Storage copies are modelled at {request.dataset.replication_factor:g}x.")
    if request.cross_region_transfer.enabled:
        parts.append("Cross-region DR is included.")
    else:
        parts.append("Cross-region DR is not included.")
    parts.append("DBU rates and final rates require FinOps/platform validation.")
    return " ".join(parts)


def _short_timestamp(value: str) -> str:
    if value == "Not available":
        return value
    return value.replace("T", " ")[:19]


def _safe(value: Any) -> str:
    return escape(str(value), quote=False)


def _component_assumption(estimate: Any, label: str, key: str) -> Any:
    for component in estimate.components:
        if component.label == label:
            return component.assumptions.get(key, "")
    return ""
