"""Self-contained operator and transcript web UI served directly by the meeting service."""

import json

from wortlaut.mail import FAILURE_REASONS

UI_HTML = """<!DOCTYPE html>
<html lang="de" class="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>wortlaut – Meeting-Transkription</title>
  <link rel="stylesheet" href="/sdk/ui/app.css">
</head>
<body class="bg-[#0b1120] text-slate-100 antialiased">
  <div id="root">
    <!-- Bot in ein Meeting schicken · title-search · participation-filter -->
    <!-- rejoin-rec-btn · copy-transcript-btn -->
  </div>
  <script>
    window.__WORTLAUT_BOOT__ = {
      failureReasons: __FAILURE_REASONS_JSON__
    };
  </script>
  <script type="module" src="/sdk/ui/app.js"></script>
</body>
</html>
"""


def render_ui() -> str:
    return UI_HTML.replace(
        "__FAILURE_REASONS_JSON__", json.dumps(FAILURE_REASONS, ensure_ascii=False)
    )
