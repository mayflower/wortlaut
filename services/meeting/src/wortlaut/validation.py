import html
import re
from typing import Literal
from urllib.parse import parse_qs, unquote, urlencode, urlsplit, urlunsplit

from wortlaut.settings import get_settings

Provider = Literal["webex", "google_meet", "teams", "zoom"]

_TEAMS_HOSTS = ("teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft")
_TEAMS_PATH_RE = re.compile(r"/(?:meet/[0-9]+|l/meetup-join/[A-Za-z0-9_%.:@+=~-]+/[0-9]+)/?")


def unwrap_conference_redirect(url: str) -> str:
    """Unwrap Outlook SafeLinks and Google redirect wrappers to their HTTPS target URL."""
    parts = urlsplit(url)
    if parts.scheme != "https":
        return url
    host = (parts.hostname or "").lower()
    if host == "safelinks.protection.outlook.com" or host.endswith(
        ".safelinks.protection.outlook.com"
    ):
        qs = parse_qs(parts.query, keep_blank_values=False)
        target = (qs.get("url") or [""])[0].strip()
        if target.startswith("https://"):
            return target
    if host in ("www.google.com", "google.com") and parts.path == "/url":
        qs = parse_qs(parts.query, keep_blank_values=False)
        target = (qs.get("q") or qs.get("url") or [""])[0].strip()
        if target.startswith("https://"):
            return target
    return url


def _extract_teams_path_and_query(parts) -> tuple[str, str] | None:
    """Extract canonical Teams /meet/... or /l/meetup-join/... path and query."""
    if _TEAMS_PATH_RE.fullmatch(parts.path):
        return parts.path.rstrip("/"), parts.query
    # Outlook calendar wrapper: /dl/launcher/launcher.html?url=%2F_%23%2Fl%2Fmeetup-join%2F...
    if parts.path == "/dl/launcher/launcher.html":
        raw_inner = (parse_qs(parts.query, keep_blank_values=False).get("url") or [""])[0].strip()
        if raw_inner:
            inner = unquote(raw_inner)
            if inner.startswith("/_#"):
                inner = inner[3:]
            elif inner.startswith("https://"):
                inner_parts = urlsplit(inner)
                if (inner_parts.hostname or "").lower() not in _TEAMS_HOSTS:
                    return None
                if _TEAMS_PATH_RE.fullmatch(inner_parts.path):
                    return inner_parts.path.rstrip("/"), inner_parts.query
                return None
            if inner.startswith("/"):
                inner_parts = urlsplit(inner)
                if _TEAMS_PATH_RE.fullmatch(inner_parts.path):
                    return inner_parts.path.rstrip("/"), inner_parts.query
    # Teams web v2 hash link: /v2/?...#/l/meetup-join/...
    if parts.fragment and "/l/meetup-join/" in parts.fragment:
        frag = parts.fragment[parts.fragment.index("/l/meetup-join/") :]
        frag_parts = urlsplit(frag)
        if _TEAMS_PATH_RE.fullmatch(frag_parts.path):
            return frag_parts.path.rstrip("/"), frag_parts.query
    return None


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
        return "google_meet", urlunsplit(("https", "meet.google.com", f"/{code}", "", ""))
    if host in _TEAMS_HOSTS:
        if (
            parts.scheme != "https"
            or parts.username is not None
            or parts.password is not None
            or parts.port not in (None, 443)
        ):
            raise ValueError("Meeting URL must be an HTTPS Teams meeting link")
        extracted = _extract_teams_path_and_query(parts)
        if extracted is None:
            raise ValueError("Meeting URL must be an HTTPS Teams meeting link")
        teams_path, teams_query = extracted
        return "teams", urlunsplit(("https", host, teams_path, teams_query, ""))
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
        return "zoom", urlunsplit(("https", "app.zoom.us", f"/wc/{meeting_id}/join", query, ""))
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


MAX_CALENDAR_AGENDA_LEN = 240

_HTML_SKIP_BLOCK_RE = re.compile(r"<(?:style|script)\b[^>]*>.*?</(?:style|script)>", re.I | re.S)
_HTML_BREAK_TAG_RE = re.compile(r"</?(?:br|p|div|li|tr|h[1-6]|section|article|hr)\b[^>]*>", re.I)
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_AGENDA_SECTION_CUT_RE = re.compile(
    r"(?:"
    r"-::~:~::"
    r"|_{10,}"
    r"|\bmicrosoft\s+teams\b"
    r"|\bjoin\s+the\s+meeting\s+now\b"
    r"|\bjetzt\s+an\s+der\s+besprechung\s+teilnehmen\b"
    r"|\bjoin\s+with\s+google\s+meet\b"
    r"|\bmit\s+google\s+meet\s+teilnehmen\b"
    r"|\bjoin\s+zoom\s+meeting\b"
    r"|\bzoom-?meeting\s+beitreten\b"
    r"|\bjoin\s+webex\b"
    r"|\bwebex-?meeting\s+beitreten\b"
    r"|\bplease\s+do\s+not\s+edit\s+this\s+section\b"
    r"|\bbitte\s+bearbeiten\s+sie\s+diesen\s+abschnitt\s+nicht\b"
    r"|---\s*wortlaut\b"
    r"|\bwortlaut-?protokoll\b"
    r"|\bwortlaut\s+protocol\b"
    r")",
    re.I,
)
_AGENDA_CREDENTIAL_LINE_RE = re.compile(
    r"(?:"
    r"\b(?:passcode|passwort|password|kenncode|kennung|access\s+code|zugangscode)\b"
    r"|\b(?:meeting[\s-]?id|besprechungs-?id|meeting\s+number|meeting-?nummer)\b"
    r"|\b(?:pin|einwahl|dial[\s-]?in|one\s+tap\s+mobile|schnelleinwahl)\s*:?"
    r"|\b(?:benötigen\s+sie\s+hilfe|need\s+help|besprechungsoptionen|meeting\s+options)\b"
    r"|\b(?:für\s+organisatoren|for\s+organizers|more\s+phone\s+numbers|weitere\s+telefonnummern)\b"
    r"|\b(?:per\s+telefon\s+teilnehmen|join\s+by\s+phone|telefonisch\s+einwählen)\b"
    r")",
    re.I,
)
_AGENDA_URL_RE = re.compile(r"(?:https?://|www\.|mailto:|tel:)\S+", re.I)
_AGENDA_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b")
_AGENDA_PHONE_RE = re.compile(r"(?<!\w)(?:\+\d{1,3}[\s().-]*)?(?:\d[\s().-]*){7,}\d(?!\w)")
_AGENDA_LEADING_NOISE_RE = re.compile(r"^[\s\-*•·=_~|>#:]+")


def extract_calendar_agenda(
    raw_text: str | None, *, max_chars: int = MAX_CALENDAR_AGENDA_LEN
) -> str | None:
    """Extract clean agenda context from a calendar description without URLs or credentials."""
    if not raw_text or not isinstance(raw_text, str):
        return None
    text = _HTML_SKIP_BLOCK_RE.sub(" ", raw_text)
    text = _HTML_BREAK_TAG_RE.sub("\n", text)
    text = _HTML_TAG_RE.sub(" ", text)
    text = html.unescape(text).replace("\r\n", "\n").replace("\r", "\n")

    kept: list[str] = []
    seen: set[str] = set()
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if _AGENDA_SECTION_CUT_RE.search(line):
            break
        if _AGENDA_CREDENTIAL_LINE_RE.search(line):
            continue
        line = _AGENDA_URL_RE.sub(" ", line)
        line = _AGENDA_EMAIL_RE.sub(" ", line)
        line = _AGENDA_PHONE_RE.sub(" ", line)
        line = _AGENDA_LEADING_NOISE_RE.sub("", line)
        line = " ".join(line.split()).strip(" |·;-")
        if len(line) < 3 or not any(ch.isalpha() for ch in line):
            continue
        if line.rstrip(":").strip().lower() in (
            "agenda",
            "tagesordnung",
            "themen",
            "topics",
            "beschreibung",
            "description",
        ):
            continue
        low = line.lower()
        if low in seen:
            continue
        seen.add(low)
        kept.append(line)
        if sum(len(item) + 3 for item in kept) >= max_chars + 40:
            break
    if not kept:
        return None
    joined = " · ".join(kept)
    if len(joined) > max_chars:
        cut = joined[:max_chars].rsplit(" ", 1)[0].rstrip(" ·,;:-")
        joined = cut if len(cut) >= max_chars // 2 else joined[:max_chars].rstrip(" ·,;:-")
    return joined or None
