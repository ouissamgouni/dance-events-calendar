import os


def get_database_url() -> str:
    explicit = os.getenv("DATABASE_URL")
    if explicit:
        return explicit

    user = os.getenv("POSTGRES_USER", "calendar_user")
    password = os.getenv("POSTGRES_PASSWORD")
    if not password:
        raise RuntimeError(
            "POSTGRES_PASSWORD environment variable must be set when DATABASE_URL is not provided."
        )
    host = os.getenv("POSTGRES_HOST", "localhost")
    port = os.getenv("POSTGRES_PORT", "5432")
    db = os.getenv("POSTGRES_DB", "calendar_db_dev")
    return f"postgresql://{user}:{password}@{host}:{port}/{db}"


def get_calendar_service_type() -> str:
    return os.getenv("CALENDAR_SERVICE", "mock")


def get_cors_origins() -> list[str]:
    origins = os.getenv("CORS_ORIGINS", "http://localhost:5173")
    return [o.strip() for o in origins.split(",")]


def get_sync_interval_minutes() -> int:
    return int(os.getenv("SYNC_INTERVAL_MINUTES", "15"))


def _parse_bool(value: str | bool | None) -> bool | None:
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    normalized = str(value).strip().lower()
    if normalized in ("1", "true", "yes", "on"):
        return True
    if normalized in ("0", "false", "no", "off"):
        return False
    return None


def get_auto_sync_enabled() -> bool:
    """Return whether automatic background sync is enabled.

    Priority order: env var AUTO_SYNC_ENABLED -> SCENARIO_DIR/config.yaml -> default False.
    """
    from_env = _parse_bool(os.getenv("AUTO_SYNC_ENABLED"))
    if from_env is not None:
        return from_env

    scenario_dir = os.getenv("SCENARIO_DIR")
    if scenario_dir:
        config_path = os.path.join(scenario_dir, "config.yaml")
        if os.path.exists(config_path):
            import yaml

            with open(config_path) as f:
                data = yaml.safe_load(f)
            if data and "auto_sync_enabled" in data:
                val = _parse_bool(data["auto_sync_enabled"])
                if val is not None:
                    return val

    return False


def get_admin_email() -> str:
    return os.getenv("ADMIN_EMAIL", "")


def get_session_secret() -> str:
    secret = os.getenv("SESSION_SECRET")
    if not secret:
        raise RuntimeError(
            "SESSION_SECRET environment variable is not set. "
            "Generate a strong secret (e.g. `openssl rand -hex 32`) and set it before starting."
        )
    if secret == "change-me":
        raise RuntimeError(
            "SESSION_SECRET is still set to the insecure default 'change-me'. "
            "Set a strong, unique secret before starting."
        )
    return secret


def get_google_client_id() -> str:
    return os.getenv("GOOGLE_CLIENT_ID", "")


def get_dev_auth_enabled() -> bool:
    """True when the dev sign-in bypass is enabled.

    Reads DEV_AUTH first; falls back to the legacy MOCK_ADMIN_AUTH for
    backward compatibility (with a one-time deprecation warning) so existing
    .env / secrets files keep working until they're migrated.
    """
    val = os.getenv("DEV_AUTH")
    if val is None:
        legacy = os.getenv("MOCK_ADMIN_AUTH")
        if legacy is not None:
            import logging

            logging.getLogger(__name__).warning(
                "MOCK_ADMIN_AUTH is deprecated; rename it to DEV_AUTH."
            )
            val = legacy
    return (val or "").lower() in ("true", "1")


def get_env_name() -> str:
    return os.getenv("ENV_NAME", "unknown")


def get_app_version() -> str:
    return os.getenv("APP_VERSION", "1.0.0")


def get_trusted_proxies() -> list[str]:
    raw = os.getenv("TRUSTED_PROXIES", "")
    if not raw.strip():
        return []
    return [p.strip() for p in raw.split(",") if p.strip()]


def get_smtp_config() -> dict:
    return {
        "host": os.getenv("SMTP_HOST", ""),
        "port": int(os.getenv("SMTP_PORT", "587")),
        "user": os.getenv("SMTP_USER", ""),
        "password": os.getenv("SMTP_PASSWORD", ""),
        "from_addr": os.getenv("SMTP_FROM", ""),
    }
