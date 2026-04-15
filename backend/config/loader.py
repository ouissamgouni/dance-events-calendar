import os


def get_database_url() -> str:
    explicit = os.getenv("DATABASE_URL")
    if explicit:
        return explicit

    user = os.getenv("POSTGRES_USER", "calendar_user")
    password = os.getenv("POSTGRES_PASSWORD", "calendar_password")
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


def get_admin_email() -> str:
    return os.getenv("ADMIN_EMAIL", "")


def get_session_secret() -> str:
    return os.getenv("SESSION_SECRET", "change-me")


def get_google_client_id() -> str:
    return os.getenv("GOOGLE_CLIENT_ID", "")


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
