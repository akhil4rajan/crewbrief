"""Typed configuration for every service (12-factor).

Values come from the environment, then ``.env.local`` (real secrets, never committed),
then ``.env`` (committed, dummy values for local development). In Azure, configuration
is injected by Container Apps and secrets are resolved from Key Vault; credentials use
managed identity (``DefaultAzureCredential``) and the ``*_KEY`` settings stay empty.
"""

from __future__ import annotations

from enum import StrEnum
from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]

DUMMY_MARKER = "dummy"


class Mode(StrEnum):
    LOCAL = "local"  # everything runs offline with deterministic stand-ins
    AZURE = "azure"  # real Azure services


class Provider(StrEnum):
    LOCAL = "local"
    AZURE = "azure"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", REPO_ROOT / ".env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- General ---
    environment: str = Field(default="local", alias="CREWBRIEF_ENV")  # local | dev | test | prod
    mode: Mode = Field(default=Mode.LOCAL, alias="CREWBRIEF_MODE")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    log_format: str = Field(default="json", alias="LOG_FORMAT")  # json | console
    data_dir: Path = Field(default=REPO_ROOT / "var", alias="DATA_DIR")

    # --- Per-integration provider overrides (default to CREWBRIEF_MODE) ---
    stt_provider: Provider | None = Field(default=None, alias="STT_PROVIDER")
    llm_provider: Provider | None = Field(default=None, alias="LLM_PROVIDER")
    search_provider: Provider | None = Field(default=None, alias="SEARCH_PROVIDER")
    store_provider: Provider | None = Field(default=None, alias="STORE_PROVIDER")
    pubsub_provider: Provider | None = Field(default=None, alias="PUBSUB_PROVIDER")
    voice_provider: Provider | None = Field(default=None, alias="VOICE_PROVIDER")
    pii_provider: Provider | None = Field(default=None, alias="PII_PROVIDER")

    # --- Service URLs (internal) ---
    gateway_url: str = Field(default="http://localhost:8000", alias="GATEWAY_URL")
    form_api_url: str = Field(default="http://localhost:8001", alias="FORM_API_URL")
    orchestrator_url: str = Field(default="http://localhost:8002", alias="ORCHESTRATOR_URL")
    roles_url: str = Field(default="http://localhost:8003", alias="ROLES_URL")
    # When true the orchestrator imports the roles in-process instead of calling ROLES_URL.
    roles_in_process: bool = Field(default=False, alias="ROLES_IN_PROCESS")
    public_gateway_ws_url: str = Field(default="ws://localhost:8000", alias="PUBLIC_GATEWAY_WS_URL")
    cors_origins: Annotated[list[str], NoDecode] = Field(
        default=["http://localhost:3000"],
        alias="CORS_ORIGINS",
    )

    # --- Auth ---
    auth_mode: str = Field(default="dev", alias="AUTH_MODE")  # dev | entra
    dev_jwt_secret: SecretStr = Field(default=SecretStr("dummy-dev-jwt-secret-change-me-0000000000"),
                                      alias="DEV_JWT_SECRET")
    dev_token_ttl_minutes: int = Field(default=720, alias="DEV_TOKEN_TTL_MINUTES")
    internal_service_token: SecretStr = Field(default=SecretStr("dummy-internal-service-token"),
                                              alias="INTERNAL_SERVICE_TOKEN")
    entra_tenant_id: str = Field(default="", alias="ENTRA_TENANT_ID")
    entra_api_client_id: str = Field(default="", alias="ENTRA_API_CLIENT_ID")

    # --- Azure AI Speech ---
    azure_speech_endpoint: str = Field(default="", alias="AZURE_SPEECH_ENDPOINT")
    azure_speech_region: str = Field(default="australiaeast", alias="AZURE_SPEECH_REGION")
    azure_speech_key: SecretStr = Field(default=SecretStr(""), alias="AZURE_SPEECH_KEY")
    speech_language: str = Field(default="en-AU", alias="SPEECH_LANGUAGE")
    custom_speech_endpoint_id: str = Field(default="", alias="CUSTOM_SPEECH_ENDPOINT_ID")
    stt_min_confidence: float = Field(default=0.55, alias="STT_MIN_CONFIDENCE")

    # --- Azure OpenAI (Foundry) ---
    azure_openai_endpoint: str = Field(default="", alias="AZURE_OPENAI_ENDPOINT")
    azure_openai_api_key: SecretStr = Field(default=SecretStr(""), alias="AZURE_OPENAI_API_KEY")
    azure_openai_api_version: str = Field(default="2024-10-21", alias="AZURE_OPENAI_API_VERSION")
    extractor_deployment: str = Field(default="gpt-4o-mini", alias="EXTRACTOR_DEPLOYMENT")
    verifier_deployment: str = Field(default="gpt-4o", alias="VERIFIER_DEPLOYMENT")
    llm_timeout_seconds: float = Field(default=20.0, alias="LLM_TIMEOUT_SECONDS")
    # If the LLM call fails, fall back to the deterministic heuristic role (degraded mode).
    llm_fallback_to_heuristic: bool = Field(default=True, alias="LLM_FALLBACK_TO_HEURISTIC")

    # --- Voice Live API ---
    voice_live_endpoint: str = Field(default="", alias="VOICE_LIVE_ENDPOINT")
    voice_live_api_key: SecretStr = Field(default=SecretStr(""), alias="VOICE_LIVE_API_KEY")
    voice_name: str = Field(default="en-AU-NatashaNeural", alias="VOICE_NAME")

    # --- Azure AI Search ---
    search_endpoint: str = Field(default="", alias="SEARCH_ENDPOINT")
    search_index: str = Field(default="hazards", alias="SEARCH_INDEX")
    search_api_key: SecretStr = Field(default=SecretStr(""), alias="SEARCH_API_KEY")

    # --- Cosmos DB ---
    cosmos_endpoint: str = Field(default="", alias="COSMOS_ENDPOINT")
    cosmos_key: SecretStr = Field(default=SecretStr(""), alias="COSMOS_KEY")
    cosmos_database: str = Field(default="crewbrief", alias="COSMOS_DATABASE")
    sqlite_path: Path | None = Field(default=None, alias="SQLITE_PATH")

    # --- Azure Web PubSub ---
    webpubsub_endpoint: str = Field(default="", alias="WEBPUBSUB_ENDPOINT")
    webpubsub_hub: str = Field(default="crewbrief", alias="WEBPUBSUB_HUB")
    webpubsub_key: SecretStr = Field(default=SecretStr(""), alias="WEBPUBSUB_KEY")

    # --- Azure AI Language (PII redaction) ---
    language_endpoint: str = Field(default="", alias="AZURE_LANGUAGE_ENDPOINT")
    language_key: SecretStr = Field(default=SecretStr(""), alias="AZURE_LANGUAGE_KEY")

    # --- Downstream safety system ---
    downstream_submission_url: str = Field(default="", alias="DOWNSTREAM_SUBMISSION_URL")

    # --- Observability ---
    applicationinsights_connection_string: str = Field(default="",
                                                       alias="APPLICATIONINSIGHTS_CONNECTION_STRING")

    # --- Behaviour ---
    extraction_interval_seconds: float = Field(default=8.0, alias="EXTRACTION_INTERVAL_SECONDS")
    verifier_every_n_extractions: int = Field(default=3, alias="VERIFIER_EVERY_N_EXTRACTIONS")
    voice_prompt_cooldown_seconds: float = Field(default=20.0, alias="VOICE_PROMPT_COOLDOWN_SECONDS")
    retain_raw_audio: bool = Field(default=False, alias="RETAIN_RAW_AUDIO")
    pii_redaction: bool = Field(default=True, alias="PII_REDACTION")
    hazard_library_path: Path | None = Field(default=None, alias="HAZARD_LIBRARY_PATH")
    prompt_version: str = Field(default="v1", alias="PROMPT_VERSION")

    @field_validator("stt_provider", "llm_provider", "search_provider", "store_provider",
                     "pubsub_provider", "voice_provider", "pii_provider", "sqlite_path",
                     "hazard_library_path", mode="before")
    @classmethod
    def _empty_is_none(cls, v: object) -> object:
        return None if v == "" else v

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_csv(cls, v: object) -> object:
        if isinstance(v, str) and not v.startswith("["):
            return [s.strip() for s in v.split(",") if s.strip()]
        return v

    def provider(self, name: str) -> Provider:
        """Resolve e.g. ``provider("llm")``: explicit override, else the global mode."""
        override = getattr(self, f"{name}_provider")
        return override or Provider(self.mode.value)

    @property
    def sqlite_file(self) -> Path:
        return self.sqlite_path or (self.data_dir / "crewbrief.db")

    @staticmethod
    def is_dummy(value: str | SecretStr) -> bool:
        raw = value.get_secret_value() if isinstance(value, SecretStr) else value
        return not raw or DUMMY_MARKER in raw.lower()


@lru_cache
def get_settings() -> Settings:
    return Settings()
