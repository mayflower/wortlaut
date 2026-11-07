# migrations

## Overview
Alembic migration environment runner connecting `wortlaut.models.Base.metadata` and `wortlaut.database.get_engine()` to apply schema revisions against PostgreSQL.

## Interface
- `[env.py]`: Alembic environment script configuring `alembic.context` with `get_engine()` and `Base.metadata` and running migrations inside a transaction.
- [versions](./versions/README.md): Linear chain of Alembic schema migration scripts (`0001` through `0023`).

## Invariants
- `[env.py]`: Offline migration mode (`context.is_offline_mode()`) is forbidden and raises `RuntimeError("Run wortlaut migrations against the configured PostgreSQL database")`.

## Side Effects
- `[env.py]`: Establishes a live PostgreSQL connection via `get_engine().connect()` and executes pending Alembic migration transactions.

## Verification
- Run: `uv run --directory services/meeting pytest`
