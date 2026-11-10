from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="WORTLAUT_")

    database_url: SecretStr
    api_token: SecretStr
    oidc_issuer: str = ""
    oidc_internal_issuer: str = ""
    oidc_client_id: str = "wortlaut"
    oidc_allowed_domains: list[str] = []
    oidc_admin_emails: list[str] = []
    webex_service_token: SecretStr | None = None
    enable_webex_browser: bool = False
    enable_webex_refresh: bool = False
    enable_google_meet: bool = False
    enable_teams: bool = False
    teams_locale: str = "en-US"
    enable_zoom: bool = False
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
    privacy_url: str | None = None
    allowed_webex_hosts: list[str] = ["*.webex.com"]
    sdk_page_url: str = "https://wortlaut.example.org/sdk/"
    bootstrap_lifetime_seconds: int = Field(default=0, ge=0)
    enable_controller: bool = False
    controller_backend: Literal["kubernetes", "docker", "local"] = "kubernetes"
    docker_host: str = "unix:///var/run/docker.sock"
    docker_network: str = "wortlaut"
    local_worker_dir: Path = Path("worker")
    runtime_state_dir: Path = Path("/tmp/wortlaut-runtime")
    namespace: str = "wortlaut-dev"
    api_url: str = "https://wortlaut.example.org/"
    worker_image: str = "wortlaut-worker:dev"
    max_active_meetings: int = Field(default=15, ge=1)
    join_lead_seconds: int = Field(default=60, ge=0)
    lobby_timeout_seconds: int = Field(default=600, ge=1)
    empty_room_timeout_seconds: int = Field(default=300, ge=5, le=7200)
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
    asr_timeout_seconds: int = 120
    asr_lease_seconds: int = 180
    asr_max_permanent_failures: int = 3
    enable_llm_summary: bool = False
    ollama_url: str = "http://ollama.ollama.svc.cluster.local:11434"
    ollama_model: str = "qwen3.8:latest"
    ollama_timeout_seconds: int = 120


@lru_cache
def get_settings() -> Settings:
    return Settings()
