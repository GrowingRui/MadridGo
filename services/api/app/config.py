"""Application settings, loaded from environment variables (never hard-coded secrets)."""

from functools import lru_cache

from pydantic import AliasChoices, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MADRIDGO_", env_file=".env", extra="ignore")

    environment: str = "development"
    database_url: SecretStr = Field(
        default=SecretStr("postgresql://madridgo:madridgo@127.0.0.1:5432/madridgo")
    )
    redis_url: SecretStr = Field(default=SecretStr("redis://127.0.0.1:6379/0"))
    # Per-dependency timeout for health checks, in seconds.
    health_check_timeout_s: float = 2.0
    # Comma-separated origins allowed by CORS (Expo web dev server).
    cors_origins: str = "http://localhost:8081"
    # Where downloaded feeds and OTP inputs live. Empty: the repo's data/ folder.
    data_dir: str = ""

    # --- Real-time (Phase 3) ---
    # EMT MobilityLabs application credentials. Read from EMT_CLIENT_ID / EMT_PASS_KEY as
    # written in .env.example. Empty: EMT live data is reported as not configured.
    emt_client_id: SecretStr = Field(
        default=SecretStr(""),
        validation_alias=AliasChoices("MADRIDGO_EMT_CLIENT_ID", "EMT_CLIENT_ID"),
    )
    emt_pass_key: SecretStr = Field(
        default=SecretStr(""),
        validation_alias=AliasChoices("MADRIDGO_EMT_PASS_KEY", "EMT_PASS_KEY"),
    )
    # Reference of CRTM's written authorization for real-time data. While empty, no CRTM
    # real-time adapter may run (ADR 002).
    crtm_authorization_ref: str = Field(
        default="",
        validation_alias=AliasChoices("MADRIDGO_CRTM_AUTHORIZATION_REF", "CRTM_AUTHORIZATION_REF"),
    )
    # Worker cadence. Renfe serves its feeds with Cache-Control max-age=30.
    renfe_poll_s: float = 30.0
    alerts_poll_s: float = 120.0

    @property
    def emt_configured(self) -> bool:
        return bool(self.emt_client_id.get_secret_value() and self.emt_pass_key.get_secret_value())


@lru_cache
def get_settings() -> Settings:
    return Settings()
