from functools import lru_cache

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from wortlaut.settings import get_settings


@lru_cache
def get_engine():
    return create_engine(
        get_settings().database_url.get_secret_value(),
        pool_pre_ping=True,
        pool_size=20,
        max_overflow=30,
    )


def session():
    with Session(get_engine()) as db:
        yield db
