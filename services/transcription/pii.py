"""PII redaction for transcript text.

What counts as PII here is deliberately narrow. Personal contact details and government or
financial identifiers are redacted. Street addresses, pole/asset numbers and work-order ids
are *kept*: the job location is safety-relevant (emergency services, muster point) and is
recorded on the form anyway.

* ``RegexPiiRedactor``: offline, deterministic (local mode, and the fallback when the Azure
  call fails, so redaction never silently turns off).
* ``AzurePiiRedactor``: Azure AI Language ``recognize_pii_entities`` restricted to the
  categories above.
"""

from __future__ import annotations

import logging
import re
from typing import Protocol

from packages.common.config import Provider, Settings, get_settings
from packages.schemas import TranscriptSegment

log = logging.getLogger(__name__)


class PiiRedactor(Protocol):
    async def redact(self, text: str) -> str: ...

    async def aclose(self) -> None: ...


def _luhn_ok(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = int(ch)
        if i % 2:
            n = n * 2 - 9 if n > 4 else n * 2
        total += n
    return total % 10 == 0


_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b")
# AU mobiles and landlines, national or +61 form, with optional spaces/dashes/brackets.
_PHONE = re.compile(r"(?<![\w+])(?:\+?61[\s-]?\(?0?\)?|\(?0)[2-478]\)?(?:[\s-]?\d){8}(?!\d)")
# Identifier introduced by a keyword: "licence number 12345678", "medicare 2123 45670 1".
_KEYED_ID = re.compile(
    r"\b(licen[cs]e|medicare|tax file|tfn|passport|employee number)((?:\s*(?:number|no\.?|is|:))*\s*)"
    r"((?:[A-Z]{1,3}\s?)?\d(?:[\s-]?\w){5,12})",
    re.IGNORECASE,
)
# Medicare-shaped run without a keyword: 10 digits starting 2-6, optional IRN, usual grouping.
_MEDICARE = re.compile(r"(?<!\d)[2-6]\d{3}\s?\d{5}\s?\d(?:\s?\d)?(?!\d)")
_CARD = re.compile(r"(?<!\d)(?:\d[\s-]?){12,18}\d(?!\d)")


class RegexPiiRedactor:
    async def redact(self, text: str) -> str:
        return redact_text(text)

    async def aclose(self) -> None:
        return None


def redact_text(text: str) -> str:
    text = _EMAIL.sub("[EMAIL]", text)
    text = _PHONE.sub("[PHONE]", text)
    text = _KEYED_ID.sub(lambda m: f"{m.group(1)}{m.group(2)}[ID]", text)

    def _card(m: re.Match[str]) -> str:
        digits = re.sub(r"\D", "", m.group(0))
        return "[CARD]" if 13 <= len(digits) <= 19 and _luhn_ok(digits) else m.group(0)

    text = _CARD.sub(_card, text)
    return _MEDICARE.sub("[ID]", text)


class AzurePiiRedactor:
    """Azure AI Language PII detection. Falls back to regex redaction on any failure."""

    CATEGORIES = (
        "PhoneNumber", "Email", "CreditCardNumber", "AUMedicareNumber", "AUDriversLicenseNumber",
        "AUTaxFileNumber", "AUPassportNumber", "AUBankAccountNumber",
    )

    def __init__(self, settings: Settings):
        from azure.ai.textanalytics.aio import TextAnalyticsClient  # type: ignore[import-not-found]

        if not Settings.is_dummy(settings.language_key):
            from azure.core.credentials import AzureKeyCredential  # type: ignore[import-not-found]

            credential = AzureKeyCredential(settings.language_key.get_secret_value())
        else:
            from azure.identity.aio import DefaultAzureCredential  # type: ignore[import-not-found]

            credential = DefaultAzureCredential()
        self._client = TextAnalyticsClient(endpoint=settings.language_endpoint, credential=credential)
        self._fallback = RegexPiiRedactor()

    async def redact(self, text: str) -> str:
        try:
            results = await self._client.recognize_pii_entities(
                [text], language="en", categories_filter=list(self.CATEGORIES))
            result = results[0]
            if result.is_error:
                raise RuntimeError(result.error)
            # Azure masks with '*'; normalise to the same placeholders as the local redactor.
            redacted = text
            for entity in sorted(result.entities, key=lambda e: e.offset, reverse=True):
                label = "[EMAIL]" if entity.category == "Email" else (
                    "[PHONE]" if entity.category == "PhoneNumber" else "[ID]")
                redacted = redacted[:entity.offset] + label + redacted[entity.offset + entity.length:]
            return redact_text(redacted)
        except Exception as exc:  # noqa: BLE001 - redaction must degrade, never fail open
            log.warning("pii_redaction_azure_failed", extra={"error": str(exc)})
            return await self._fallback.redact(text)

    async def aclose(self) -> None:
        await self._client.close()


def build_redactor(settings: Settings | None = None) -> PiiRedactor | None:
    """``None`` when ``PII_REDACTION=false``."""
    s = settings or get_settings()
    if not s.pii_redaction:
        return None
    if s.provider("pii") == Provider.AZURE:
        return AzurePiiRedactor(s)
    return RegexPiiRedactor()


async def redact_segment(segment: TranscriptSegment, redactor: PiiRedactor | None) -> TranscriptSegment:
    """``redacted=True`` means PII was found and replaced in this segment's text."""
    if redactor is None or not segment.text:
        return segment
    text = await redactor.redact(segment.text)
    if text == segment.text:
        return segment
    return segment.model_copy(update={"text": text, "redacted": True})
