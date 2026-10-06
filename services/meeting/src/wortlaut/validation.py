from urllib.parse import urlsplit

from wortlaut.settings import get_settings


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
