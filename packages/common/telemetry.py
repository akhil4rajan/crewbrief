"""OpenTelemetry → Azure Monitor (Application Insights). No-op when not configured."""

from __future__ import annotations

import logging

from .config import Settings

log = logging.getLogger(__name__)
_configured = False


def configure_telemetry(service: str, settings: Settings) -> None:
    global _configured
    conn = settings.applicationinsights_connection_string
    if _configured or not conn or Settings.is_dummy(conn):
        return
    try:
        from azure.monitor.opentelemetry import configure_azure_monitor  # type: ignore[import-not-found]
    except ImportError:
        log.warning("azure-monitor-opentelemetry not installed; telemetry disabled")
        return
    configure_azure_monitor(connection_string=conn, logger_name="", resource_attributes={
        "service.name": f"crewbrief-{service}", "deployment.environment": settings.environment})
    _configured = True
