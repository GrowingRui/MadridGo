"""Application settings, loaded from environment variables (never hard-coded secrets)."""

from functools import lru_cache

from pydantic import Field, SecretStr
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


@lru_cache
def get_settings() -> Settings:
    return Settings()
