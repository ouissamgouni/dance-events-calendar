import os
import sys
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool
from sqlmodel import SQLModel

# Add backend parent to path so imports work
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))

# Import all models so metadata is populated
from backend.db.models import CalendarSetting, CachedEvent, EventView  # noqa: F401
from backend.config.loader import get_database_url

config = context.config

# Override sqlalchemy.url from environment
# Escape literal "%" (e.g. from URL-encoded query params like "%3D") since
# configparser's default interpolation treats "%" as a special character.
config.set_main_option("sqlalchemy.url", get_database_url().replace("%", "%%"))

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = SQLModel.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
