"""Event publishing to clients (crew device + review portal).

* local: POST the envelope to the gateway's ``/internal/events``; the gateway fans it out
  over its WebSocket connections.
* azure: send to the Azure Web PubSub group ``session.<id>`` (managed identity).

Publishing is best-effort: a dropped live update must never fail the write that caused it.
Clients resync with ``GET /api/sessions/{id}`` on reconnect.
"""

from __future__ import annotations

import logging
from typing import Protocol

from packages.schemas import EventEnvelope, group_name

from .config import Provider, Settings, get_settings
from .http import InternalClient

log = logging.getLogger(__name__)


class EventPublisher(Protocol):
    async def publish(self, event: EventEnvelope) -> None: ...
    async def aclose(self) -> None: ...


class GatewayPublisher:
    def __init__(self, gateway_url: str):
        self._client = InternalClient(gateway_url, timeout=3.0, retries=1, name="gateway")

    async def publish(self, event: EventEnvelope) -> None:
        try:
            await self._client.post("/internal/events", json=event.model_dump(mode="json"))
        except Exception as exc:  # noqa: BLE001
            log.warning("event_publish_failed", extra={"type": event.type, "error": str(exc)})

    async def aclose(self) -> None:
        await self._client.aclose()


class WebPubSubPublisher:
    def __init__(self, settings: Settings):
        from azure.messaging.webpubsubservice.aio import (  # type: ignore[import-not-found]
            WebPubSubServiceClient,
        )

        if settings.webpubsub_key.get_secret_value() and not Settings.is_dummy(settings.webpubsub_key):
            from azure.core.credentials import AzureKeyCredential  # type: ignore[import-not-found]

            credential = AzureKeyCredential(settings.webpubsub_key.get_secret_value())
        else:
            from azure.identity.aio import DefaultAzureCredential  # type: ignore[import-not-found]

            credential = DefaultAzureCredential()
        self._client = WebPubSubServiceClient(endpoint=settings.webpubsub_endpoint,
                                              hub=settings.webpubsub_hub, credential=credential)

    async def publish(self, event: EventEnvelope) -> None:
        try:
            await self._client.send_to_group(group_name(event.session_id),
                                             event.model_dump(mode="json"), content_type="application/json")
        except Exception as exc:  # noqa: BLE001
            log.warning("event_publish_failed", extra={"type": event.type, "error": str(exc)})

    async def aclose(self) -> None:
        await self._client.close()


def build_publisher(settings: Settings | None = None) -> EventPublisher:
    s = settings or get_settings()
    if s.provider("pubsub") == Provider.AZURE:
        return WebPubSubPublisher(s)
    return GatewayPublisher(s.gateway_url)
