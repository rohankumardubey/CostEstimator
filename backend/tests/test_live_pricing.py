from __future__ import annotations

from typing import Any

from app import live_pricing


def test_pricing_config_does_not_start_global_live_refresh(monkeypatch) -> None:
    monkeypatch.setenv("PRICING_SOURCE", "live")
    live_pricing.clear_live_pricing_cache()

    def fail_fetch(*_: Any) -> dict[str, Any]:
        raise AssertionError("No network fetch should run without a selected region")

    monkeypatch.setattr(live_pricing, "_fetch_aws_json", fail_fetch)

    config = live_pricing.load_live_pricing_config(_base_config())

    notes = config["pricing_source"]["notes"]
    assert config["pricing_source"]["mode"] == "live"
    assert not any("background" in note.lower() for note in notes)
    assert config["cloud"]["aws"]["regions"]["eu-west-1"]["storage"]["s3_standard"]["pricing_status"] == "fallback"

    live_pricing.clear_live_pricing_cache()


def test_live_pricing_fetches_only_selected_aws_region(monkeypatch) -> None:
    monkeypatch.setenv("PRICING_SOURCE", "live")
    live_pricing.clear_live_pricing_cache()
    fetched_urls: list[str] = []

    def fake_fetch(url: str, _: float) -> dict[str, Any]:
        fetched_urls.append(url)
        return {}

    def fake_extract(_: dict[str, Any], aws_class: str) -> float:
        return 0.123 if aws_class == "standard" else 0.234

    monkeypatch.setattr(live_pricing, "_fetch_aws_json", fake_fetch)
    monkeypatch.setattr(live_pricing, "_extract_aws_s3_storage_price", fake_extract)

    config = live_pricing.load_live_pricing_config(_base_config(), selected_region=("aws", "us-west-2"))

    assert fetched_urls == [
        "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-west-2/index.json"
    ]
    aws_regions = config["cloud"]["aws"]["regions"]
    assert aws_regions["us-west-2"]["storage"]["s3_standard"]["pricing_status"] == "live"
    assert aws_regions["us-west-2"]["storage"]["s3_standard"]["price_per_gb_month"] == 0.123
    assert aws_regions["eu-west-1"]["storage"]["s3_standard"]["pricing_status"] == "fallback"

    live_pricing.clear_live_pricing_cache()


def _base_config() -> dict[str, Any]:
    return {
        "currency": "USD",
        "cloud": {
            "aws": {
                "regions": {
                    "eu-west-1": {"storage": _aws_storage()},
                    "us-west-2": {"storage": _aws_storage()},
                }
            }
        },
    }


def _aws_storage() -> dict[str, Any]:
    return {
        "s3_standard": {
            "display_name": "S3 Standard",
            "price_per_gb_month": 0.023,
        },
        "s3_intelligent_tiering": {
            "display_name": "S3 Intelligent-Tiering",
            "price_per_gb_month": 0.023,
        },
    }
