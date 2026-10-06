from alembic import context

from wortlaut.database import get_engine
from wortlaut.models import Base

if context.is_offline_mode():
    raise RuntimeError("Run wortlaut migrations against the configured PostgreSQL database")

with get_engine().connect() as connection:
    context.configure(connection=connection, target_metadata=Base.metadata)
    with context.begin_transaction():
        context.run_migrations()
