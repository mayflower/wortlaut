import re
from typing import Literal
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

from wortlaut.settings import get_settings

Provider = Literal["webex", "google_meet", "teams", "zoom"]


def normalize_meeting_url(url: str) -> tuple[Provider, str]:
    if len(url) > 2048 or any(character.isspace() or ord(character) < 32 for character in url):
        raise ValueError("Invalid meeting URL")
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if host == "meet.google.com":
        if (
            parts.scheme != "https"
            or parts.username is not None
            or parts.password is not None
            or parts.port not in (None, 443)
            or not re.fullmatch(r"/(?:meet/)?[a-z]{3}-[a-z]{4}-[a-z]{3}/?", parts.path)
        ):
            raise ValueError("Meeting URL must be an HTTPS Google Meet meeting code")
        # Only this validated destination is navigated. Query/fragment cannot
        # redirect the browser and never change the recording's identity.
        code = parts.path.strip("/").removeprefix("meet/")
        return "google_meet", urlunsplit(
            ("https", "meet.google.com", f"/{code}", "", "")
        )
    if host in ("teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"):
        if (
            parts.scheme != "https" or parts.username is not None
            or parts.password is not None or parts.port not in (None, 443)
            or not re.fullmatch(
                r"/(?:meet/[0-9]+|l/meetup-join/[A-Za-z0-9_%.-]+/[0-9]+)/?", parts.path
            )
        ):
            raise ValueError("Meeting URL must be an HTTPS Teams meeting link")
        return "teams", urlunsplit(
            ("https", host, parts.path.rstrip("/"), parts.query, "")
        )
    if host == "zoom.us" or host.endswith(".zoom.us"):
        match = re.fullmatch(r"/(?:j|wc)/([0-9]{9,11})(?:/(?:join|start))?/?", parts.path)
        if (
            parts.scheme != "https"
            or parts.username is not None
            or parts.password is not None
            or parts.port not in (None, 443)
            or not match
        ):
            raise ValueError("Meeting URL must be an HTTPS Zoom meeting link")
        meeting_id = match.group(1)
        pwd_values = parse_qs(parts.query, keep_blank_values=False).get("pwd", [])
        query = ""
        if pwd_values:
            pwd = pwd_values[0]
            if not re.fullmatch(r"[A-Za-z0-9._-]+", pwd) or len(pwd) > 256:
                raise ValueError("Meeting URL has an invalid Zoom passcode")
            query = urlencode({"pwd": pwd})
        return "zoom", urlunsplit(
            ("https", "app.zoom.us", f"/wc/{meeting_id}/join", query, "")
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
