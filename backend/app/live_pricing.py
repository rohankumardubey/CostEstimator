from __future__ import annotations

import copy
import json
import os
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from typing import Any

import certifi


AWS_S3_PRICE_URL = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/{region}/index.json"
AZURE_RETAIL_PRICE_URL = "https://prices.azure.com/api/retail/prices"
GCP_CATALOG_URL = "https://cloudbilling.googleapis.com/v1/services"

AZURE_REGION_NAMES = {
    "uk-south": "uksouth",
    "west-europe": "westeurope",
    "east-us": "eastus",
}

AZURE_STORAGE_TIERS = {
    "adls_hot": "Hot",
    "adls_cool": "Cool",
    "adls_archive": "Archive",
}

AWS_STORAGE_CLASSES = {
    "s3_standard": "standard",
    "s3_intelligent_tiering": "intelligent_tiering",
}

_CACHE: dict[str, Any] | None = None
_CACHE_EXPIRES_AT = 0.0


def load_live_pricing_config(
    base_config: dict[str, Any],
    selected_region: tuple[str, str] | None = None,
    selected_transfer_route: tuple[str, str, str | None] | None = None,
) -> dict[str, Any]:
    global _CACHE, _CACHE_EXPIRES_AT

    mode = os.getenv("PRICING_SOURCE", "config").lower()
    ttl_seconds = int(os.getenv("LIVE_PRICING_CACHE_SECONDS", "21600"))
    now = time.time()

    if _CACHE is None or now >= _CACHE_EXPIRES_AT:
        note = (
            "Live storage pricing is fetched only for the selected estimate region; "
            "configured fallback prices are used for unselected regions."
            if mode == "live"
            else "Using repository or mounted pricing configuration."
        )
        _CACHE = _build_fallback_config(base_config, ttl_seconds, mode, note)
        _CACHE_EXPIRES_AT = now + ttl_seconds

    config = copy.deepcopy(_CACHE)

    needs_storage = (
        bool(selected_region)
        and not _selected_region_has_live_storage(config, *selected_region)
    )
    needs_transfer = (
        bool(selected_transfer_route)
        and not _selected_route_has_live_transfer(config, *selected_transfer_route)
    )
    if mode == "live" and (needs_storage or needs_transfer):
        config = _build_live_config(
            base_config,
            ttl_seconds,
            selected_region,
            selected_transfer_route,
            config,
        )

    _CACHE = copy.deepcopy(config)
    _CACHE_EXPIRES_AT = now + ttl_seconds
    return config


def _build_live_config(
    base_config: dict[str, Any],
    ttl_seconds: int,
    selected_region: tuple[str, str] | None,
    selected_transfer_route: tuple[str, str, str | None] | None,
    current_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    config = copy.deepcopy(current_config or base_config)
    _mark_all_storage_as_config_fallback(config)
    notes: list[str] = []
    timeout = float(os.getenv("LIVE_PRICING_TIMEOUT_SECONDS", "8"))
    if selected_region:
        cloud_provider, region_key = selected_region
        _apply_selected_storage_prices(config, timeout, notes, cloud_provider, region_key)
    if selected_transfer_route:
        cloud_provider, source_region, destination_region = selected_transfer_route
        if cloud_provider == "aws" and destination_region:
            _apply_aws_transfer_price(config, timeout, notes, source_region, destination_region)
        elif destination_region:
            notes.append(f"Live transfer pricing is not enabled for cloud provider '{cloud_provider}'; using configured fallback.")
    config["pricing_source"] = {
        "mode": "live",
        "updated_at": datetime.now(UTC).isoformat(),
        "cache_seconds": ttl_seconds,
        "notes": notes,
    }
    return config


def _build_fallback_config(
    base_config: dict[str, Any],
    ttl_seconds: int,
    mode: str,
    note: str,
) -> dict[str, Any]:
    config = copy.deepcopy(base_config)
    _mark_all_storage_as_config_fallback(config)
    config["pricing_source"] = {
        "mode": mode,
        "updated_at": datetime.now(UTC).isoformat(),
        "cache_seconds": ttl_seconds,
        "notes": [note],
    }
    return config


def clear_live_pricing_cache() -> None:
    global _CACHE, _CACHE_EXPIRES_AT
    _CACHE = None
    _CACHE_EXPIRES_AT = 0


def _mark_all_storage_as_config_fallback(config: dict[str, Any]) -> None:
    for cloud_key, cloud in config.get("cloud", {}).items():
        for region_key, region in cloud.get("regions", {}).items():
            for storage_key, storage in region.get("storage", {}).items():
                storage.setdefault("pricing_source", "config_fallback")
                storage.setdefault("pricing_status", "fallback")
                storage.setdefault("pricing_source_url", "")
                storage.setdefault(
                    "pricing_note",
                    f"Fallback value from config for {cloud_key}/{region_key}/{storage_key}.",
                )


def _selected_region_has_live_storage(config: dict[str, Any], cloud_provider: str, region_key: str) -> bool:
    region = config.get("cloud", {}).get(cloud_provider, {}).get("regions", {}).get(region_key, {})
    return any(storage.get("pricing_status") == "live" for storage in region.get("storage", {}).values())


def _selected_route_has_live_transfer(
    config: dict[str, Any],
    cloud_provider: str,
    source_region: str,
    destination_region: str | None,
) -> bool:
    if not destination_region:
        return True
    route = (
        config.get("network", {})
        .get("cross_region_transfer", {})
        .get(cloud_provider, {})
        .get("routes", {})
        .get(source_region, {})
        .get(destination_region, {})
    )
    return route.get("pricing_status") == "live"


def _apply_selected_storage_prices(
    config: dict[str, Any],
    timeout: float,
    notes: list[str],
    cloud_provider: str,
    region_key: str,
) -> None:
    if cloud_provider == "aws":
        _apply_aws_storage_prices(config, timeout, notes, region_key)
    elif cloud_provider == "azure":
        _apply_azure_storage_prices(config, timeout, notes, region_key)
    elif cloud_provider == "gcp":
        _apply_gcp_storage_prices(config, timeout, notes, region_key)
    else:
        notes.append(f"Live pricing is not supported for cloud provider '{cloud_provider}'.")


def _apply_aws_storage_prices(
    config: dict[str, Any],
    timeout: float,
    notes: list[str],
    region_key: str,
) -> None:
    aws_regions = config.get("cloud", {}).get("aws", {}).get("regions", {})
    region = aws_regions.get(region_key)
    if not region:
        notes.append(f"AWS S3 live pricing skipped: region '{region_key}' is not configured.")
        return

    try:
        offer = _fetch_aws_json(AWS_S3_PRICE_URL.format(region=region_key), timeout)
    except Exception as exc:
        notes.append(f"AWS S3 live pricing failed for {region_key}: {exc}")
        return

    for storage_key, aws_class in AWS_STORAGE_CLASSES.items():
        storage = region.get("storage", {}).get(storage_key)
        if not storage:
            continue
        price = _extract_aws_s3_storage_price(offer, aws_class)
        if price is None:
            notes.append(f"AWS S3 live price not found for {region_key}/{storage_key}.")
            continue
        storage["price_per_gb_month"] = price
        storage["pricing_source"] = "aws_price_list_api"
        storage["pricing_status"] = "live"
        storage["pricing_source_url"] = AWS_S3_PRICE_URL.format(region=region_key)
        storage["pricing_note"] = "AWS public Price List API for the selected estimate region."


def _apply_aws_transfer_price(
    config: dict[str, Any],
    timeout: float,
    notes: list[str],
    source_region: str,
    destination_region: str,
) -> None:
    try:
        offer = _fetch_aws_json(AWS_S3_PRICE_URL.format(region=source_region), timeout)
    except Exception as exc:
        notes.append(f"AWS S3 transfer live pricing failed for {source_region} -> {destination_region}: {exc}")
        return

    price = _extract_aws_s3_inter_region_transfer_price(offer, destination_region)
    if price is None:
        notes.append(f"AWS S3 transfer live price not found for {source_region} -> {destination_region}; using configured fallback.")
        return

    routes = (
        config.setdefault("network", {})
        .setdefault("cross_region_transfer", {})
        .setdefault("aws", {})
        .setdefault("routes", {})
    )
    route = routes.setdefault(source_region, {}).setdefault(destination_region, {})
    route["price_per_gb"] = price
    route["pricing_source"] = "aws_price_list_api"
    route["pricing_status"] = "live"
    route["pricing_note"] = "AWS public Price List API route-level inter-region transfer for the selected estimate route."


def _extract_aws_s3_inter_region_transfer_price(offer: dict[str, Any], destination_region: str) -> float | None:
    destination_tokens = {
        destination_region.lower(),
        destination_region.replace("-", "").lower(),
    }
    for sku, product in offer.get("products", {}).items():
        attributes = product.get("attributes", {})
        combined = " ".join(str(value).lower() for value in attributes.values())
        usage_type = attributes.get("usagetype", "").lower()
        transfer_type = attributes.get("transferType", "").lower()

        looks_like_inter_region = (
            "interregion" in combined
            or "inter-region" in combined
            or "regional" in usage_type
            or "data transfer" in transfer_type
        )
        looks_like_outbound = "out" in combined or "outbound" in combined
        mentions_destination = any(token in combined for token in destination_tokens)
        if not (looks_like_inter_region and looks_like_outbound and mentions_destination):
            continue
        price = _first_price_dimension(offer, sku, "GB")
        if price is not None:
            return price
    return None


def _extract_aws_s3_storage_price(offer: dict[str, Any], aws_class: str) -> float | None:
    for sku, product in offer.get("products", {}).items():
        attributes = product.get("attributes", {})
        usage_type = attributes.get("usagetype", "")
        storage_class = attributes.get("storageClass", "")
        volume_type = attributes.get("volumeType", "")

        is_standard = (
            aws_class == "standard"
            and storage_class == "General Purpose"
            and volume_type == "Standard"
            and "TimedStorage-ByteHrs" in usage_type
            and "INT" not in usage_type
        )
        is_intelligent_tiering = (
            aws_class == "intelligent_tiering"
            and storage_class == "Intelligent-Tiering"
            and volume_type == "Intelligent-Tiering Frequent Access"
            and "TimedStorage-INT-FA-ByteHrs" in usage_type
        )
        if not (is_standard or is_intelligent_tiering):
            continue
        price = _first_price_dimension(offer, sku, "GB-Mo")
        if price is not None:
            return price
    return None


def _first_price_dimension(offer: dict[str, Any], sku: str, unit: str) -> float | None:
    terms = offer.get("terms", {}).get("OnDemand", {}).get(sku, {})
    for term in terms.values():
        for dimension in term.get("priceDimensions", {}).values():
            if dimension.get("unit") == unit and dimension.get("beginRange") == "0":
                return float(dimension.get("pricePerUnit", {}).get("USD", 0))
    return None


def _apply_azure_storage_prices(config: dict[str, Any], timeout: float, notes: list[str], region_key: str) -> None:
    azure_regions = config.get("cloud", {}).get("azure", {}).get("regions", {})
    region = azure_regions.get(region_key)
    if not region:
        notes.append(f"Azure live pricing skipped: region '{region_key}' is not configured.")
        return

    arm_region = AZURE_REGION_NAMES.get(region_key, region_key.replace("-", ""))
    try:
        items = _fetch_azure_storage_items(arm_region, timeout)
    except Exception as exc:
        notes.append(f"Azure Retail Prices API failed for {region_key}: {exc}")
        return

    for storage_key, tier in AZURE_STORAGE_TIERS.items():
        storage = region.get("storage", {}).get(storage_key)
        if not storage:
            continue
        price = _extract_azure_adls_price(items, tier)
        if price is None:
            notes.append(f"Azure ADLS Gen2 live price not found for {region_key}/{storage_key}.")
            continue
        storage["price_per_gb_month"] = price
        storage["pricing_source"] = "azure_retail_prices_api"
        storage["pricing_status"] = "live"
        storage["pricing_source_url"] = AZURE_RETAIL_PRICE_URL
        storage["pricing_note"] = "Azure Retail Prices API for the selected estimate region."


def _fetch_azure_storage_items(arm_region: str, timeout: float) -> list[dict[str, Any]]:
    filter_query = (
        "serviceName eq 'Storage' "
        f"and armRegionName eq '{arm_region}' "
        "and priceType eq 'Consumption'"
    )
    url = f"{AZURE_RETAIL_PRICE_URL}?{urllib.parse.urlencode({'$filter': filter_query})}"
    items: list[dict[str, Any]] = []
    while url and len(items) < 5000:
        data = _fetch_json(url, timeout)
        items.extend(data.get("Items", []))
        url = data.get("NextPageLink")
    return items


def _extract_azure_adls_price(items: list[dict[str, Any]], tier: str) -> float | None:
    expected_meter = f"{tier} LRS Data Stored"
    for item in items:
        if (
            "Azure Data Lake Storage Gen2 Hierarchical Namespace" in item.get("productName", "")
            and f"{tier} LRS" in item.get("skuName", "")
            and item.get("meterName") == expected_meter
            and item.get("unitOfMeasure") == "1 GB/Month"
        ):
            return float(item.get("retailPrice", 0))
    return None


def _apply_gcp_storage_prices(config: dict[str, Any], timeout: float, notes: list[str], region_key: str) -> None:
    api_key = os.getenv("GCP_BILLING_API_KEY")
    gcp_regions = config.get("cloud", {}).get("gcp", {}).get("regions", {})
    region = gcp_regions.get(region_key)
    if not region:
        notes.append(f"GCP live pricing skipped: region '{region_key}' is not configured.")
        return
    if not api_key:
        notes.append(f"GCP live pricing requires GCP_BILLING_API_KEY; using config fallback for {region_key}.")
        for storage in region.get("storage", {}).values():
            storage["pricing_note"] = "GCP live pricing requires GCP_BILLING_API_KEY."
        return
    notes.append(f"GCP live pricing API key detected, but SKU mapping is not enabled yet; using config fallback for {region_key}.")
    _ = timeout
    _ = GCP_CATALOG_URL


def _fetch_json(url: str, timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"User-Agent": "CostEstimator/1.0"})
    context = ssl.create_default_context(cafile=certifi.where())
    with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
        return json.loads(response.read().decode("utf-8"))


def _fetch_aws_json(url: str, timeout: float) -> dict[str, Any]:
    try:
        return _fetch_json(url, timeout)
    except urllib.error.URLError as exc:
        if "pricing.us-east-1.amazonaws.com" not in url:
            raise
        ssl_reason = str(exc.reason) if getattr(exc, "reason", None) is not None else str(exc)
        if "CERTIFICATE_VERIFY_FAILED" not in ssl_reason:
            raise
        request = urllib.request.Request(url, headers={"User-Agent": "CostEstimator/1.0"})
        context = ssl._create_unverified_context()
        with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
            return json.loads(response.read().decode("utf-8"))
