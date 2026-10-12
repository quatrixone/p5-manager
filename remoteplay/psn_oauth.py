"""PSN sign-in for pairing: who the account is, by its id.

The Remote Play app's OAuth client: the user signs in on Sony's page, lands
on a "redirect" page whose address carries a code, and pastes that address
back. The code buys a token, the token tells the account id - which is what
the console wants to see when it is paired, and what LAUNCH is built from.
"""
from __future__ import annotations

import base64
import hashlib
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse

import aiohttp

CLIENT_ID = "ba495a24-818c-472b-b12d-ff231c1b5745"
CLIENT_SECRET = base64.b64decode("bXZhaVprUnNBc0kxSUJrWQ==").decode()
REDIRECT_URL = "https://remoteplay.dl.playstation.net/remoteplay/redirect"
TOKEN_URL = "https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/token"
LOGIN_URL = (
    "https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/authorize"
    "?service_entity=urn:service-entity:psn"
    f"&response_type=code&client_id={CLIENT_ID}"
    f"&redirect_uri={REDIRECT_URL}"
    "&scope=psn:clientapp"
    "&request_locale=en_US&ui=pr"
    "&service_logo=ps"
    "&layout_type=popup"
    "&smcid=remoteplay"
    "&prompt=always"
    "&PlatformPrivacyWs1=minimal"
    "&no_captcha=true&"
)


class OAuthError(Exception):
    pass


def account_rpid(account_id: str) -> str:
    """The decimal account id as the console's pairing wants it: 8 bytes,
    little endian, in base64. Something that is not decimal is taken to be
    that already."""
    aid = (account_id or "").strip()
    if aid.isdigit():
        return base64.b64encode(int(aid).to_bytes(8, "little")).decode()
    return aid


def account_id_from_rpid(rpid: str) -> str:
    try:
        return str(int.from_bytes(base64.b64decode(rpid), "little"))
    except Exception:  # noqa: BLE001
        return ""


def code_from_redirect(redirect_url: str) -> str:
    url = (redirect_url or "").strip()
    if not url.startswith(REDIRECT_URL):
        raise OAuthError(f"that is not the redirect page's address - it starts with {REDIRECT_URL}")
    code = (parse_qs(urlparse(url).query).get("code") or [""])[0]
    if len(code) <= 1:
        raise OAuthError("the address has no sign-in code - sign in again and copy the whole address")
    return code


async def exchange(redirect_url: str) -> Dict[str, Any]:
    """The account behind a redirect address: user_id (decimal), online_id
    when PSN tells it, user_rpid and credentials as pairing uses them."""
    code = code_from_redirect(redirect_url)
    auth = aiohttp.BasicAuth(CLIENT_ID, CLIENT_SECRET)
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    body = f"grant_type=authorization_code&code={code}&redirect_uri={REDIRECT_URL}&"
    timeout = aiohttp.ClientTimeout(total=10)
    async with aiohttp.ClientSession(timeout=timeout) as http:
        async with http.post(TOKEN_URL, auth=auth, headers=headers, data=body.encode()) as resp:
            if resp.status != 200:
                raise OAuthError(f"PSN did not take the code ({resp.status}) - it is used up or too old, sign in again")
            token = (await resp.json(content_type=None)).get("access_token")
        if not token:
            raise OAuthError("PSN gave no token")
        async with http.get(f"{TOKEN_URL}/{token}", auth=auth) as resp:
            if resp.status != 200:
                raise OAuthError(f"PSN would not tell the account ({resp.status})")
            account: Dict[str, Any] = await resp.json(content_type=None)
    user_id: Optional[str] = account.get("user_id")
    if not user_id:
        raise OAuthError(f"PSN's answer has no user_id (keys: {list(account)})")
    account["user_rpid"] = account_rpid(str(user_id))
    account["credentials"] = hashlib.sha256(str(user_id).encode()).hexdigest()
    return account
