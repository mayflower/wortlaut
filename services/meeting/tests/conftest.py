import os
import uuid
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

os.environ.setdefault("WORTLAUT_API_TOKEN", "fixture-api-token")
os.environ.setdefault("WORTLAUT_DATABASE_URL", "postgresql+psycopg://unused@localhost/unused")
os.environ.setdefault("WORTLAUT_ENABLE_PROCESSING", "false")


@pytest.fixture
def database(monkeypatch):
    """Real PostgreSQL, separate schema; never truncate application tables."""
    from wortlaut import database as database_module

    configured = os.getenv("WORTLAUT_TEST_DATABASE_URL")
    local_file = Path(__file__).resolve().parents[3] / ".dev/runtime.env"
    if not configured and local_file.exists():
        values = dict(line.split("=", 1) for line in local_file.read_text().splitlines())
        url = make_url(values["WORTLAUT_DATABASE_URL"])
        configured = url.set(host="127.0.0.1", port=34632).render_as_string(hide_password=False)
    if not configured:
        pytest.skip("Real PostgreSQL requires make dev or WORTLAUT_TEST_DATABASE_URL")
    admin = create_engine(configured, connect_args={"connect_timeout": 3})
    schema = "test_" + uuid.uuid4().hex
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_engine(configured, connect_args={"options": f"-csearch_path={schema}"})
    monkeypatch.setattr(database_module, "get_engine", lambda: engine)
    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    try:
        command.upgrade(config, "head")
        yield engine
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


@pytest.fixture
def client(database, monkeypatch):
    from wortlaut import app as app_module

    monkeypatch.setattr(app_module, "get_engine", lambda: database)
    with TestClient(app_module.app) as client:
        yield client


@pytest.fixture
def storage(client, monkeypatch):
    from wortlaut.settings import get_settings
    from wortlaut.storage import get_storage

    local = Path(__file__).resolve().parents[3] / ".dev/storage.env"
    if local.exists():
        for line in local.read_text().splitlines():
            name, value = line.split("=", 1)
            monkeypatch.setenv(name, value)
    elif not os.getenv("WORTLAUT_S3_ACCESS_KEY"):
        pytest.skip("Real S3 requires make dev or configured WORTLAUT_S3 credentials")
    monkeypatch.setenv(
        "WORTLAUT_S3_ENDPOINT", os.getenv("WORTLAUT_TEST_S3_ENDPOINT", "http://127.0.0.1:34609")
    )
    monkeypatch.setenv("WORTLAUT_S3_BUCKET", "wortlaut-test-" + uuid.uuid4().hex)
    monkeypatch.setenv("WORTLAUT_S3_CREATE_BUCKET", "true")
    get_settings.cache_clear()
    get_storage.cache_clear()
    instance = get_storage()
    try:
        yield instance
    finally:
        objects = instance.client.list_objects_v2(Bucket=instance.bucket).get("Contents", [])
        for item in objects:
            instance.client.delete_object(Bucket=instance.bucket, Key=item["Key"])
        instance.client.delete_bucket(Bucket=instance.bucket)
        get_storage.cache_clear()
        get_settings.cache_clear()


@pytest.fixture
def signed_invite(monkeypatch, tmp_path):
    import base64
    import subprocess

    import dkim
    from test_calendar import mail

    from wortlaut import calendar as intake
    from wortlaut.settings import get_settings

    key = tmp_path / "signing.pem"
    subprocess.run(
        ["openssl", "genrsa", "-traditional", "-out", str(key), "2048"],
        check=True, capture_output=True,
    )
    public = subprocess.run(
        ["openssl", "rsa", "-in", str(key), "-pubout", "-outform", "DER"],
        check=True, capture_output=True,
    ).stdout
    record = b"v=DKIM1; k=rsa; p=" + base64.b64encode(public)
    monkeypatch.setattr(intake, "dkim_dns", lambda name, timeout=5: record)
    monkeypatch.setenv("WORTLAUT_MAIL_SENDER_AUTH", "dkim")
    monkeypatch.setenv("WORTLAUT_MAIL_ALLOWED_SENDER_DOMAINS", '["mayflower.de"]')
    monkeypatch.setenv("WORTLAUT_MAIL_REPLY_TO_SENDER", "true")
    get_settings.cache_clear()

    def sign(raw=None, domain=b"mayflower.de", length=False, headers=None, **kwargs):
        raw = raw or mail(sender="owner@mayflower.de", organizer="owner@mayflower.de", **kwargs)
        signature = dkim.sign(
            raw, b"test", domain, key.read_bytes(), length=length,
            include_headers=headers or [b"from", b"content-type", b"mime-version"],
        )
        return signature + raw

    yield sign
    get_settings.cache_clear()
