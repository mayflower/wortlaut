# meeting

## Overview
Meeting coordination service subsystem housing the `wortlaut` FastAPI service source package (including the integrated operator and transcript Web-UI and manual per-source speaker labeling) and its Alembic PostgreSQL database migrations.

## Subdirectories & Boundaries
- `migrations`: [./migrations/README.md](./migrations/README.md) - Alembic migration environment runner and schema revision history (`0001` through `0022`).
- `src`: [./src/README.md](./src/README.md) - Python source tree containing the `wortlaut` package.
