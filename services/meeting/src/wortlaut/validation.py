import re
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

from wortlaut.settings import get_settings

Provider = Literal["webex", "google_meet"]


def normalize_meeting_url(url: str) -> tuple[Provider, str]:
    if len(url) > 2048 or any(character.isspace() or ord(character) < 32 for character in url):
        raise ValueError("Invalid meeting URL")
    parts = urlsplit(url)
    if (parts.hostname or "").lower() == "meet.google.com":
        if (
            parts.scheme != "https"
            or parts.username is not None
            or parts.password is not None
            or parts.port not in (None, 443)
            or not re.fullmatch(r"/[a-z]{3}-[a-z]{4}-[a-z]{3}/?", parts.path)
        ):
            raise ValueError("Meeting URL must be an HTTPS Google Meet meeting code")
        # Only this validated destination is navigated. Query/fragment cannot
        # redirect the browser and never change the recording's identity.
        return "google_meet", urlunsplit(
            ("https", "meet.google.com", parts.path.rstrip("/"), "", "")
        )
    return "webex", validate_webex_url(url)


def validate_webex_url(url):
    parts = urlsplit(url)
    host = parts.hostname or ""
    allowed = any(
        host == rule or (rule.startswith("*.") and host.endswith(rule[1:]))
        for rule in get_settings().allowed_webex_hosts
    )
    if parts.scheme != "https" or not allowed or parts.username or parts.password:
        raise ValueError("Meeting URL must be an allowed HTTPS Webex target")
    if parts.port not in (None, 443):
        raise ValueError("Meeting URL must use port 443")
    if len(url) > 2048:
        raise ValueError("Meeting URL is too long")
    return url
