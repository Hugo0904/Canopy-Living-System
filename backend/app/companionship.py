from __future__ import annotations

import hashlib
import json
import ssl
import threading
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

import certifi


MAX_RESPONSE_BYTES = 256 * 1024
TAIPEI_TZ = ZoneInfo("Asia/Taipei")
OPEN_METEO_DOCS = "https://open-meteo.com/en/docs"
WIKIMEDIA_FEED_ROOT = "https://api.wikimedia.org/feed/v1/wikipedia"
USER_AGENT = "Canopy-Living-System/0.1 (local optional companion)"
TLS_CONTEXT = ssl.create_default_context(cafile=certifi.where())


def _fetch_json(url: str, *, timeout: float = 4.0) -> dict[str, Any]:
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    with urlopen(  # noqa: S310 - fixed HTTPS sources only.
        request,
        timeout=timeout,
        context=TLS_CONTEXT,
    ) as response:
        payload = response.read(MAX_RESPONSE_BYTES + 1)
    if len(payload) > MAX_RESPONSE_BYTES:
        raise ValueError("companion response exceeded the bounded payload size")
    decoded = json.loads(payload.decode("utf-8"))
    if not isinstance(decoded, dict):
        raise ValueError("companion response must be a JSON object")
    return decoded


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return round(float(value), 1)


def _first_number(value: Any) -> float | None:
    if not isinstance(value, list) or not value:
        return None
    return _number(value[0])


def _weather_condition(code: int, locale: str) -> str:
    category = (
        "clear"
        if code in {0, 1}
        else "cloudy"
        if code in {2, 3, 45, 48}
        else "rain"
        if code in {51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82}
        else "storm"
        if code in {95, 96, 99}
        else "snow"
        if code in {71, 73, 75, 77, 85, 86}
        else "mixed"
    )
    labels = {
        "zh-TW": {"clear": "晴朗", "cloudy": "多雲", "rain": "有雨", "storm": "雷雨", "snow": "降雪", "mixed": "天氣多變"},
        "zh-CN": {"clear": "晴朗", "cloudy": "多云", "rain": "有雨", "storm": "雷雨", "snow": "降雪", "mixed": "天气多变"},
        "en": {"clear": "clear", "cloudy": "cloudy", "rain": "rainy", "storm": "stormy", "snow": "snowy", "mixed": "changeable"},
    }
    return labels.get(locale, labels["en"])[category]


def weather_briefings(
    payload: dict[str, Any],
    *,
    location: str,
    observed_at: str,
) -> list[dict[str, Any]]:
    current = payload.get("current") if isinstance(payload.get("current"), dict) else {}
    daily = payload.get("daily") if isinstance(payload.get("daily"), dict) else {}
    temperature = _number(current.get("temperature_2m"))
    apparent = _number(current.get("apparent_temperature"))
    maximum = _first_number(daily.get("temperature_2m_max"))
    minimum = _first_number(daily.get("temperature_2m_min"))
    precipitation = _first_number(daily.get("precipitation_probability_max"))
    raw_code = current.get("weather_code")
    code = int(raw_code) if isinstance(raw_code, (int, float)) and not isinstance(raw_code, bool) else -1
    date_values = daily.get("time")
    date = str(date_values[0]) if isinstance(date_values, list) and date_values else observed_at[:10]
    current_time = str(current.get("time", ""))[-5:]
    if None in {temperature, apparent, maximum, minimum, precipitation} or not date:
        return []

    briefings: list[dict[str, Any]] = []
    for locale in ("zh-TW", "zh-CN", "en"):
        condition = _weather_condition(code, locale)
        if locale == "en":
            title = f"Today's {location} weather: {condition}, {temperature:g}°C"
            body = (
                f"It feels like {apparent:g}°C. Today's range is {minimum:g}–{maximum:g}°C "
                f"with up to {precipitation:g}% precipitation probability. This is a model forecast, "
                f"not an on-site measurement. Source: Open-Meteo · updated {current_time or 'today'}."
            )
        elif locale == "zh-CN":
            title = f"今天的{location}：{condition}，{temperature:g}°C"
            body = (
                f"体感约 {apparent:g}°C；今天 {minimum:g}–{maximum:g}°C，最高降雨机率 {precipitation:g}%。"
                f"这是模型预报，不是现场实测。来源：Open-Meteo · 更新 {current_time or '今天'}。"
            )
        else:
            title = f"今天的{location}：{condition}，{temperature:g}°C"
            body = (
                f"體感約 {apparent:g}°C；今天 {minimum:g}–{maximum:g}°C，最高降雨機率 {precipitation:g}%。"
                f"這是模型預報，不是現場實測。來源：Open-Meteo · 更新 {current_time or '今天'}。"
            )
        briefings.append(
            {
                "id": f"weather:{date}:{locale}",
                "category": "weather",
                "locale": locale,
                "title": title,
                "body": body,
                "source_owner": "open_meteo",
                "source_name": "Open-Meteo",
                "source_url": OPEN_METEO_DOCS,
                "observed_at": observed_at,
                "claim_status": "external_verified",
                "facts": {
                    "location": location,
                    "date": date,
                    "temperature_c": temperature,
                    "apparent_temperature_c": apparent,
                    "minimum_c": minimum,
                    "maximum_c": maximum,
                    "precipitation_probability": precipitation,
                    "weather_code": code,
                },
                "priority": 6,
            }
        )
    return briefings


def _safe_wikipedia_url(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith("wikipedia.org"):
        return ""
    return value[:600]


def history_briefing(
    payload: dict[str, Any],
    *,
    language: str,
    locale: str,
    date: str,
    observed_at: str,
) -> dict[str, Any] | None:
    selected = payload.get("selected")
    records = [item for item in selected if isinstance(item, dict)] if isinstance(selected, list) else []
    if not records:
        return None
    digest = hashlib.sha256(f"{date}:{language}".encode("utf-8")).hexdigest()
    record = records[int(digest[:8], 16) % len(records)]
    text = str(record.get("text", "")).strip()[:700]
    year = record.get("year")
    pages = record.get("pages")
    first_page = pages[0] if isinstance(pages, list) and pages and isinstance(pages[0], dict) else {}
    content_urls = first_page.get("content_urls") if isinstance(first_page.get("content_urls"), dict) else {}
    desktop = content_urls.get("desktop") if isinstance(content_urls.get("desktop"), dict) else {}
    source_url = _safe_wikipedia_url(desktop.get("page"))
    if not text or not isinstance(year, int) or not source_url:
        return None
    if locale == "en":
        title = f"A small world story from {year}"
        body = f"{text} Source: Wikipedia On this day · checked today."
    elif locale == "zh-CN":
        title = f"今天的世界小故事 · {year}"
        body = f"{text} 来源：维基百科历史上的今天 · 今日取得。"
    else:
        title = f"今天的世界小故事 · {year}"
        body = f"{text} 來源：維基百科歷史上的今天 · 今日取得。"
    return {
        "id": f"history:{date}:{locale}",
        "category": "world_history",
        "locale": locale,
        "title": title,
        "body": body,
        "source_owner": "wikimedia",
        "source_name": "Wikipedia",
        "source_url": source_url,
        "observed_at": observed_at,
        "claim_status": "external_verified",
        "facts": {"date": date, "year": year, "language": language},
        "priority": 12,
    }


class CompanionBriefingCache:
    """One replace-in-place, fail-open cache owned only by the optional UI."""

    def __init__(
        self,
        *,
        latitude: float = 25.033,
        longitude: float = 121.5654,
        location: str = "臺北",
    ) -> None:
        self.latitude = latitude
        self.longitude = longitude
        self.location = location[:80] or "臺北"
        self._lock = threading.Lock()
        self._messages: list[dict[str, Any]] = []
        self._last_attempt_at = ""
        self._last_error = ""

    def refresh(
        self,
        *,
        now: datetime | None = None,
        fetch_json: Callable[[str], dict[str, Any]] = _fetch_json,
    ) -> dict[str, Any]:
        current = (now or datetime.now(timezone.utc)).astimezone(TAIPEI_TZ)
        observed_at = current.isoformat(timespec="seconds")
        date = current.date().isoformat()
        month = f"{current.month:02d}"
        day = f"{current.day:02d}"
        messages: list[dict[str, Any]] = []
        errors: list[str] = []

        weather_query = urlencode(
            {
                "latitude": f"{self.latitude:.4f}",
                "longitude": f"{self.longitude:.4f}",
                "current": "temperature_2m,apparent_temperature,weather_code",
                "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
                "timezone": "Asia/Taipei",
                "forecast_days": "1",
            }
        )
        try:
            weather = fetch_json(f"https://api.open-meteo.com/v1/forecast?{weather_query}")
            messages.extend(
                weather_briefings(
                    weather,
                    location=self.location,
                    observed_at=observed_at,
                )
            )
        except Exception as exc:  # noqa: BLE001 - optional source fails open.
            errors.append(f"weather:{type(exc).__name__}")

        for language, locales in (("zh", ("zh-TW", "zh-CN")), ("en", ("en",))):
            try:
                history = fetch_json(
                    f"{WIKIMEDIA_FEED_ROOT}/{language}/onthisday/selected/{month}/{day}"
                )
                for locale in locales:
                    message = history_briefing(
                        history,
                        language=language,
                        locale=locale,
                        date=date,
                        observed_at=observed_at,
                    )
                    if message is not None:
                        messages.append(message)
            except Exception as exc:  # noqa: BLE001 - optional source fails open.
                errors.append(f"history-{language}:{type(exc).__name__}")

        # One weather and one history item per locale is the hard payload bound.
        messages = messages[:6]
        with self._lock:
            self._messages = messages
            self._last_attempt_at = observed_at
            self._last_error = ",".join(errors)[:240]
        return self.status()

    def messages(self, locale: str = "zh-TW") -> list[dict[str, Any]]:
        with self._lock:
            return [dict(item) for item in self._messages if item.get("locale") == locale]

    def all_messages(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(item) for item in self._messages]

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "status": "available" if self._messages else "unavailable",
                "count": len(self._messages),
                "last_attempt_at": self._last_attempt_at,
                "last_error": self._last_error,
            }
