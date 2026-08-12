"""
Email notifications via Gmail API (OAuth2).

Environment variable required:
  GOOGLE_TOKEN_JSON – contents of the OAuth2 token.json file for seojobisrael@gmail.com

Email addresses are configured via environment variables:
  OR_EMAIL        (default: seojobisrael@gmail.com)
  PUBLISHER_EMAIL (default: edenlee@greenlamp.co)
  DENISE_EMAIL    (default: denise@greenlamp.co)
  RETAINER_EMAIL  (default: office@greenlamp.co)
"""
import os
import base64
import sys
import traceback
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

APP_URL = "https://greenlamp-publisher-psi.vercel.app"

DEFAULT_OR_EMAIL        = "seojobisrael@gmail.com"
DEFAULT_PUBLISHER_EMAIL = "edenlee@greenlamp.co"
DEFAULT_DENISE_EMAIL    = "denise@greenlamp.co"
DEFAULT_RETAINER_EMAIL  = "office@greenlamp.co"


def _env(name: str, default: str) -> str:
    """Read an email from the environment, ignoring unset/blank values."""
    return (os.environ.get(name) or "").strip() or default


ROLES = ("or", "publisher", "denise")

# Role → (env var, hardcoded default) used for the fallback chain.
_ROLE_FALLBACKS: dict[str, tuple[str, str]] = {
    "or":        ("OR_EMAIL",        DEFAULT_OR_EMAIL),
    "publisher": ("PUBLISHER_EMAIL", DEFAULT_PUBLISHER_EMAIL),
    "denise":    ("DENISE_EMAIL",    DEFAULT_DENISE_EMAIL),
}


def env_role_email(role: str) -> str:
    """
    The single env/default address for a role, ignoring the profiles table.

    Used by the user switcher, which must keep pointing at the three original
    accounts rather than following dynamic user management.
    """
    env_var, default = _ROLE_FALLBACKS[role]
    return _env(env_var, default)


def _profiles_emails_by_role() -> dict[str, list[str]] | None:
    """
    Read every profile and group the emails by role.

    Returns None if the table is unavailable for ANY reason (missing env config,
    network error, RLS refusal). Never raises — callers fall back to env/default.
    """
    try:
        url = os.environ.get("SUPABASE_URL")
        # Service-role key bypasses RLS, so backend reads see every profile.
        svc = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not url or not svc:
            return None

        from supabase import create_client

        resp = (
            create_client(url, svc)
            .table("profiles")
            .select("email, role")
            .execute()
        )
        rows = resp.data or []

        grouped: dict[str, list[str]] = {r: [] for r in ROLES}
        for row in rows:
            role  = (row.get("role")  or "").strip()
            email = (row.get("email") or "").strip()
            if role in grouped and email and email not in grouped[role]:
                grouped[role].append(email)
        return grouped
    except Exception as e:
        print(f"[roles] could not read profiles table: {e}")
        return None


def resolve_role_emails() -> tuple[dict[str, list[str]], dict[str, str]]:
    """
    Resolve every role to a LIST of recipients, in priority order per role:
      1. all profiles rows with that role   (managed from the Users page)
      2. the role's environment variable    (OR_EMAIL / PUBLISHER_EMAIL / …)
      3. the hardcoded default

    Returns (role -> [emails], role -> source). Never raises.

    A role with no profiles rows falls back to env/default rather than resolving
    to nobody, so deleting users can never silently black-hole notifications.
    """
    try:
        grouped = _profiles_emails_by_role()
    except Exception as e:
        print(f"[roles] profiles lookup failed, falling back: {e}")
        grouped = None

    resolved: dict[str, list[str]] = {}
    sources:  dict[str, str] = {}

    for role in ROLES:
        from_table = (grouped or {}).get(role) or []
        if from_table:
            resolved[role] = from_table
            sources[role]  = "from profiles table"
            continue

        env_var, default = _ROLE_FALLBACKS[role]
        try:
            env_value = (os.environ.get(env_var) or "").strip()
        except Exception:
            env_value = ""

        if env_value:
            resolved[role] = [env_value]
            sources[role]  = "from env"
        else:
            resolved[role] = [default]
            sources[role]  = "from default"

    return resolved, sources


def role_emails() -> dict[str, list[str]]:
    """Resolved role → list of recipient addresses, logging the source per role."""
    resolved, sources = resolve_role_emails()
    for role in ROLES:
        print(f"[roles] {role} = {', '.join(resolved[role])} ({sources[role]})")
    return resolved


SETTINGS_RETAINER_KEY = "retainer_email"


def _setting_from_supabase(key: str) -> str | None:
    """
    Read a single value from the public.settings table.

    Returns the trimmed value, or None if it is unavailable for ANY reason
    (missing env config, network error, absent row, RLS refusal, blank value).
    Never raises — callers rely on falling back to env/default.
    """
    try:
        url = os.environ.get("SUPABASE_URL")
        # Service-role key bypasses RLS, so backend reads are unaffected by policies.
        svc = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not url or not svc:
            return None

        from supabase import create_client

        resp = (
            create_client(url, svc)
            .table("settings")
            .select("value")
            .eq("key", key)
            .limit(1)
            .execute()
        )
        rows = resp.data or []
        if not rows:
            return None
        return (rows[0].get("value") or "").strip() or None
    except Exception as e:
        print(f"[settings] could not read {key!r} from settings table: {e}")
        return None


def resolve_retainer_email() -> tuple[str, str]:
    """
    Resolve the retainer recipient, in priority order:
      1. public.settings row where key = 'retainer_email'  (editable from the UI)
      2. RETAINER_EMAIL environment variable
      3. hardcoded DEFAULT_RETAINER_EMAIL

    Returns (address, source). Never raises — a failure here would otherwise
    stop retainer emails from being sent at all.
    """
    # Belt-and-braces: _setting_from_supabase already swallows its own errors,
    # but this outer guard means no future change in that path can ever stop a
    # retainer email from being addressed.
    try:
        value = _setting_from_supabase(SETTINGS_RETAINER_KEY)
        if value:
            return value, "from settings table"
    except Exception as e:
        print(f"[retainer] settings lookup failed, falling back: {e}")

    try:
        env_value = (os.environ.get("RETAINER_EMAIL") or "").strip()
        if env_value:
            return env_value, "from env"
    except Exception as e:
        print(f"[retainer] env lookup failed, falling back: {e}")

    return DEFAULT_RETAINER_EMAIL, "from default"


def retainer_email() -> str:
    """Resolved retainer recipient, logging which source supplied it."""
    addr, source = resolve_retainer_email()
    print(f"[retainer] email = {addr} ({source})")
    return addr


def sender_email() -> str:
    return _env("OR_EMAIL", DEFAULT_OR_EMAIL)


def _gmail_service():
    # Import here so the module loads even if google libs aren't installed yet
    sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
    from google_client import get_credentials
    from googleapiclient.discovery import build
    creds = get_credentials()
    return build("gmail", "v1", credentials=creds)


def send_email_to_roles(
    roles: list[str],
    subject: str,
    body_text: str,
    extra_links: list[dict] | None = None,
    deep_link: str | None = None,
) -> None:
    """
    Send an email to every address mapped from `roles` using the Gmail API.
    Silently skips if GOOGLE_TOKEN_JSON is not configured.

    deep_link:   if provided, the main CTA button links directly to the article
                 instead of the generic app URL.
    extra_links: optional list of {"url": str, "label": str} rendered as
                 additional link buttons in the HTML email and plain-text URLs.
    """
    if not os.environ.get("GOOGLE_TOKEN_JSON"):
        print("[email] GOOGLE_TOKEN_JSON not set — skipping")
        return

    resolved = role_emails()
    # Every user holding a requested role gets the email. Dedupe across roles so
    # an address appearing under two roles is not mailed twice.
    to_emails: list[str] = []
    for r in roles:
        for addr in resolved.get(r, []):
            if addr not in to_emails:
                to_emails.append(addr)
    if not to_emails:
        print(f"[email] no addresses mapped for roles {roles!r} — skipping")
        return
    print(f"[email] roles {roles!r} → {len(to_emails)} recipient(s): {', '.join(to_emails)}")

    # Build extra link buttons for HTML
    extra_html = ""
    extra_plain = ""
    if extra_links:
        for link in extra_links:
            url   = link.get("url",   "")
            label = link.get("label", url)
            if url:
                extra_html  += (
                    f'<a href="{url}" style="display:inline-block;margin-top:10px;'
                    f'background:#1d4ed8;color:#fff;text-decoration:none;'
                    f'padding:10px 20px;border-radius:6px;font-size:14px;font-weight:500">'
                    f'{label} →</a><br>\n'
                )
                extra_plain += f"\n{label}: {url}"

    cta_url   = deep_link or APP_URL
    cta_label = "View Article →" if deep_link else "Open Greenlamp Publisher →"

    html = f"""\
<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a">
  <p style="font-size:16px;margin:0 0 20px">{body_text}</p>
  <a href="{cta_url}"
     style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;
            padding:10px 20px;border-radius:6px;font-size:14px;font-weight:500">
    {cta_label}
  </a><br>
  {extra_html}
</div>
"""
    plain_text = body_text
    if deep_link:
        plain_text += f"\n\nView Article: {deep_link}"
    plain_text += extra_plain

    try:
        service = _gmail_service()
        for to_addr in to_emails:
            msg = MIMEMultipart("alternative")
            msg["From"]    = sender_email()
            msg["To"]      = to_addr
            msg["Subject"] = subject
            msg.attach(MIMEText(plain_text, "plain", "utf-8"))
            msg.attach(MIMEText(html,       "html",  "utf-8"))

            raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
            service.users().messages().send(
                userId="me",
                body={"raw": raw},
            ).execute()
            print(f"[email] sent to {to_addr!r}: {subject!r}")
    except Exception as e:
        print(f"[email] error sending to {to_emails!r}: {e}")


def send_retainer_email(
    client_name: str,
    magazine_url: str,
    google_doc_url: str | None,
) -> None:
    """
    Notify office@greenlamp.co to add this publication to the client retainer.
    Called when an article is marked as published.
    """
    if not os.environ.get("GOOGLE_TOKEN_JSON"):
        print("[email/retainer] GOOGLE_TOKEN_JSON not set — skipping")
        return

    # Normalise: ensure full URL with trailing slash
    mag = magazine_url.strip()
    if not mag.startswith("http"):
        mag = "https://www." + mag
    if not mag.endswith("/"):
        mag = mag + "/"

    to_addr = retainer_email()
    subject = f"Please add to retainer — {client_name} | {mag}"

    doc_line_html  = (
        f'<a href="{google_doc_url}" style="display:inline-block;margin-top:10px;'
        f'background:#1d4ed8;color:#fff;text-decoration:none;'
        f'padding:10px 20px;border-radius:6px;font-size:14px;font-weight:500">'
        f'Google Doc (Pricing) →</a><br>'
    ) if google_doc_url else ""
    doc_line_plain = f"\nGoogle Doc (Pricing): {google_doc_url}" if google_doc_url else ""

    html = f"""\
<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a">
  <p style="font-size:16px;margin:0 0 12px">A new article has been published and should be added to the retainer.</p>
  <p><strong>Client:</strong> {client_name}</p>
  <p><strong>Magazine:</strong> <a href="{mag}">{mag}</a></p>
  {doc_line_html}
</div>"""

    plain = (
        f"A new article has been published and should be added to the retainer.\n\n"
        f"Client:  {client_name}\n"
        f"Magazine: {mag}"
        f"{doc_line_plain}"
    )

    print(f"[email/retainer] building email — to={to_addr!r} subject={subject!r}")
    try:
        service = _gmail_service()
        print("[email/retainer] Gmail service acquired")
        msg = MIMEMultipart("alternative")
        msg["From"]    = sender_email()
        msg["To"]      = to_addr
        msg["Subject"] = subject
        msg.attach(MIMEText(plain, "plain", "utf-8"))
        msg.attach(MIMEText(html,  "html",  "utf-8"))
        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
        print("[email/retainer] calling Gmail API send…")
        result = service.users().messages().send(userId="me", body={"raw": raw}).execute()
        print(f"[email/retainer] sent OK — message_id={result.get('id')!r} to={to_addr!r}")
    except Exception as e:
        print(f"[email/retainer] ERROR: {e}")
        traceback.print_exc()
