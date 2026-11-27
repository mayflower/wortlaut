import json
import re
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

from wortlaut.languages import normalize_asr_language


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="WORTLAUT_")

    database_url: SecretStr
    api_token: SecretStr
    encryption_key: SecretStr | None = None
    oidc_issuer: str = ""
    oidc_internal_issuer: str = ""
    oidc_authorization_endpoint: str = ""
    oidc_token_endpoint: str = ""
    oidc_jwks_uri: str = ""
    oidc_client_id: str = "wortlaut"
    oidc_client_secret: SecretStr | None = None
    oidc_display_name: str = ""
    google_auth_client_id: str | None = None
    google_auth_client_secret: SecretStr | None = None
    entra_auth_client_id: str | None = None
    entra_auth_client_secret: SecretStr | None = None
    entra_auth_tenant_id: str = ""
    entra_auth_allowed_tenants: list[str] = []
    oidc_allowed_domains: list[str] = []
    oidc_admin_emails: list[str] = []
    mcp_allowed_origins: list[str] = []
    webex_service_token: SecretStr | None = None
    enable_webex_browser: bool = True
    enable_webex_refresh: bool = False
    enable_google_meet: bool = True
    enable_teams: bool = True
    teams_locale: str = "en-US"
    enable_zoom: bool = True
    zoom_locale: str = "en-US"
    zoom_storage_state_secret: str | None = None
    meet_storage_state_secret: str | None = None
    meet_locale: str = "de-DE"
    enable_imap: bool = False
    imap_host: str | None = None
    imap_port: int = 993
    imap_username: str | None = None
    imap_password: SecretStr | None = None
    imap_folder: str = "INBOX"
    mailbox_context: str = "wortlaut"
    trusted_sender_header: str | None = None
    mail_sender_auth: Literal["gateway", "dkim"] = "gateway"
    mail_allowed_sender_domains: list[str] = []
    mail_reply_to_sender: bool = False
    instant_invite_minutes: int = Field(default=120, ge=1, le=1440)
    organizer_permissions: dict[str, list[str]] = {}
    max_mail_bytes: int = Field(default=1024 * 1024, ge=1)
    calendar_horizon_days: int = Field(default=14, ge=1, le=90)
    max_occurrences_per_series: int = Field(default=256, ge=1)
    enable_calendar_oauth_sync: bool = True
    google_calendar_client_id: str | None = None
    google_calendar_client_secret: SecretStr | None = None
    microsoft_calendar_client_id: str | None = None
    microsoft_calendar_client_secret: SecretStr | None = None
    microsoft_calendar_tenant_id: str = "common"
    enable_smtp: bool = False
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_tls: Literal["starttls", "implicit", "none"] = "starttls"
    smtp_username: str | None = None
    smtp_password: SecretStr | None = None
    smtp_from: str = "wortlaut@localhost"
    result_recipients: dict[str, list[str]] = {}
    mail_attachment_limit_bytes: int = Field(default=10 * 1024**2, ge=1)
    mail_max_attempts: int = Field(default=3, ge=1)
    assistant_name: str = "wortlaut"
    default_locale: Literal["de", "en"] = "de"
    enable_chat_intro: bool = True
    enable_keyframes: bool = True
    redact_keyframe_faces: bool = True
    privacy_url: str | None = None
    allowed_webex_hosts: list[str] = ["*.webex.com"]
    sdk_page_url: str = "https://wortlaut.example.org/sdk/"
    bootstrap_lifetime_seconds: int = Field(default=0, ge=0)
    enable_controller: bool = False
    controller_backend: Literal["kubernetes", "docker", "local"] = "kubernetes"
    docker_host: str = "unix:///var/run/docker.sock"
    docker_network: str = "wortlaut"
    local_worker_dir: Path = Path("worker")
    runtime_state_dir: Path = Field(
        default_factory=lambda: Path(tempfile.gettempdir()) / "wortlaut-runtime"
    )
    namespace: str = "wortlaut-dev"
    api_url: str = "https://wortlaut.example.org/"
    public_url: str | None = None

    def public_base_url(self) -> str:
        raw = (self.public_url or "").strip() or self.api_url
        return raw.rstrip("/")

    worker_image: str = "wortlaut-worker:dev"
    max_active_meetings: int = Field(default=15, ge=1)
    join_lead_seconds: int = Field(default=60, ge=0)
    lobby_timeout_seconds: int = Field(default=600, ge=1)
    empty_room_timeout_seconds: int = Field(default=300, ge=5, le=7200)
    max_overtime_seconds: int = Field(default=3600, ge=0, le=14400)
    late_start_tolerance_seconds: int = Field(default=300, ge=0)
    heartbeat_timeout_seconds: int = Field(default=45, ge=10)
    otlp_endpoint: str | None = None
    worker_cpu_request: str = "250m"
    worker_cpu_limit: str = "2"
    worker_memory_request: str = "512Mi"
    worker_memory_limit: str = "2Gi"
    worker_seccomp_type: Literal["Unconfined", "Localhost"] = "Unconfined"
    worker_seccomp_profile: str | None = None
    sdk_directory: Path = Path("/app/sdk")
    site_directory: Path = Path("/app/site")
    s3_endpoint: str = "http://rustfs:9000"
    s3_bucket: str = "wortlaut-audio"
    s3_access_key: SecretStr | None = None
    s3_secret_key: SecretStr | None = None
    s3_create_bucket: bool = False
    max_pending_samples_per_attempt: int = Field(default=16000 * 60 * 120, ge=1)
    max_pending_samples_total: int = Field(default=16000 * 60 * 1800, ge=1)
    max_stored_audio_bytes: int = Field(default=8 * 1024**3, ge=1)
    max_open_asr_jobs: int = Field(default=8192, ge=1)
    audio_retention_hours: int = Field(default=24, ge=0)
    failed_audio_retention_hours: int = Field(default=24, ge=0)
    processing_max_age_hours: int = Field(default=72, ge=1)
    transcript_retention_days: int = Field(default=30, ge=1)
    enable_processing: bool = True
    asr_url: str = "http://wortlaut-asr:8000"
    asr_token: SecretStr | None = None
    asr_languages: str = "*"
    asr_glossary: Annotated[list[str], NoDecode] = []
    asr_timeout_seconds: int = 120
    asr_lease_seconds: int = 180
    asr_max_permanent_failures: int = 3
    enable_llm_summary: bool = False
    ollama_url: str = "http://ollama.ollama.svc.cluster.local:11434"
    ollama_model: str = "qwen3.8:latest"
    ollama_timeout_seconds: int = 180
    openai_base_url: str | None = None
    openai_api_key: SecretStr | None = None
    openai_model: str = "gpt-4o-mini"
    openai_timeout_seconds: int = Field(default=120, ge=5, le=600)
    rag_query_expansion_timeout_seconds: float = Field(default=1.5, ge=0.2, le=10.0)
    embedding_model_dir: Path = Path("/app/models/multilingual-e5-small-int8")

    def openai_chat_configured(self) -> bool:
        return bool((self.openai_base_url or "").strip())

    def llm_summary_configured(self) -> bool:
        return bool(
            self.enable_llm_summary
            and (self.openai_chat_configured() or bool((self.ollama_url or "").strip()))
        )

    def active_llm_model(self) -> str:
        return self.openai_model if self.openai_chat_configured() else self.ollama_model

    def llm_summary_timeout_seconds(self) -> int:
        return (
            self.openai_timeout_seconds
            if self.openai_chat_configured()
            else self.ollama_timeout_seconds
        )

    @field_validator("asr_languages", mode="before")
    @classmethod
    def _parse_asr_languages(cls, value):
        if value is None or value == "":
            return "*"
        norm = normalize_asr_language(str(value))
        return "*" if not norm or norm == "auto" else norm

    @field_validator("asr_glossary", mode="before")
    @classmethod
    def _parse_asr_glossary(cls, value):
        if value is None or value == "":
            return []
        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                return []
            if stripped.startswith("["):
                parsed = json.loads(stripped)
                if not isinstance(parsed, list):
                    raise ValueError("WORTLAUT_ASR_GLOSSARY JSON value must be a list")
                raw_items = parsed
            else:
                raw_items = re.split(r"[,;\n]+", stripped)
        elif isinstance(value, (list, tuple, set)):
            raw_items = list(value)
        else:
            raise ValueError("Invalid asr_glossary format")
        cleaned: list[str] = []
        seen: set[str] = set()
        for item in raw_items:
            term = " ".join(str(item).split())[:80]
            if term and term.lower() not in seen and len(cleaned) < 128:
                seen.add(term.lower())
                cleaned.append(term)
        return cleaned


def get_public_base_url(settings_obj=None) -> str:
    s = settings_obj if settings_obj is not None else get_settings()
    pub = (getattr(s, "public_url", None) or "").strip()
    raw = pub or str(getattr(s, "api_url", "") or "")
    return raw.rstrip("/")


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


def derive_subkey(purpose: bytes, *, use_encryption_secret: bool = False) -> bytes:
    """Derive a domain-separated 32-byte key via HKDF-SHA256."""
    s = get_settings()
    if use_encryption_secret and s.encryption_key is not None:
        raw = s.encryption_key.get_secret_value().encode("utf-8")
    else:
        raw = s.api_token.get_secret_value().encode("utf-8")
    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b"wortlaut-kdf-salt-v1",
        info=b"wortlaut:" + purpose,
    )
    return hkdf.derive(raw)
