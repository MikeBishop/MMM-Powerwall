#!/bin/env python3

import argparse
import base64
import hashlib
import os
import re
import time
import json
from urllib.parse import parse_qs
import sys
import requests

MAX_ATTEMPTS = 7
CLIENT_ID = "81527cff06843c8634fdc09e8ac0abefb46ac849f38fe1e431c2ef2106796384"
# UA = "Mozilla/5.0 (Linux; Android 10; Pixel 3 Build/QQ2A.200305.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/85.0.4183.81 Mobile Safari/537.36"
# X_TESLA_USER_AGENT = "TeslaApp/3.10.9-433/adff2e065/android/10"
UA = "PostmanRuntime/7.26.10"


def gen_params():
    verifier_bytes = os.urandom(86)
    code_verifier = base64.urlsafe_b64encode(verifier_bytes).rstrip(b"=")
    code_challenge = base64.urlsafe_b64encode(
        hashlib.sha256(code_verifier).digest()
    ).rstrip(b"=")
    state = base64.urlsafe_b64encode(os.urandom(16)).rstrip(b"=").decode("utf-8")
    return code_verifier, code_challenge, state


def vprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)


def login(args):
    email, password = args.email, args.password
    session, resp, params, code_verifier = (None,) * 4

    headers = {
        "User-Agent": UA,
        # "x-tesla-user-agent": X_TESLA_USER_AGENT,
        "X-Requested-With": "com.teslamotors.tesla",
    }

    # Step 1: Obtain the login page
    code_verifier, code_challenge, state = gen_params()

    params = (
        ("audience", ""),
        ("client_id", "ownerapi"),
        ("code_challenge", code_challenge),
        ("code_challenge_method", "S256"),
        ("locale", "en"),
        ("prompt", "login"),
        ("redirect_uri", "https://auth.tesla.com/void/callback"),
        ("response_type", "code"),
        ("scope", "openid email offline_access"),
        ("state", state),
    )

    session = requests.Session()
    resp = session.get(
        "https://auth.tesla.com/oauth2/v3/authorize", headers=headers, params=params
    )

    if "<title>" not in resp.text:
        vprint("JS in login page")
        sys.exit(1)
    else:
        # response is ok, contains csrf and transaction_id
        csrf = re.search(r'name="_csrf".+value="([^"]+)"', resp.text).group(1)
        transaction_id = re.search(
            r'name="transaction_id".+value="([^"]+)"', resp.text
        ).group(1)

    # Step 2: Obtain an authorization code
    data = {
        "_csrf": csrf,
        "_phase": "authenticate",
        "_process": "1",
        "transaction_id": transaction_id,
        "cancel": "",
        "identity": email,
        "credential": password,
    }

    for attempt in range(MAX_ATTEMPTS):
        resp = session.post(
            "https://auth.tesla.com/oauth2/v3/authorize",
            headers=headers,
            params=params,
            data=data,
            allow_redirects=False,
        )

        if "We could not sign you in" in resp.text and resp.status_code == 401:
            vprint("Invalid credentials.")
            sys.exit(2)

        if resp.ok and (resp.status_code == 302 or "<title>" in resp.text):
            vprint(f"Post auth form success - {attempt + 1} attempt(s).")
            break
        elif resp.ok and (resp.status_code == 200 and "/mfa/verify" in resp.text):
            # break here itself, if mfa is detected. No need to keep the loop running
            break

        time.sleep(3)
    else:
        vprint("Failed to post auth form.")
        sys.exit(3)

    # Determine if user has MFA enabled
    # In that case there is no redirect to `https://auth.tesla.com/void/callback` and app shows new form with Passcode / Backup Passcode field
    is_mfa = True if resp.status_code == 200 and "/mfa/verify" in resp.text else False

    if is_mfa:
        resp = session.get(
            f"https://auth.tesla.com/oauth2/v3/authorize/mfa/factors?transaction_id={transaction_id}",
            headers=headers,
        )
        # {
        #     "data": [
        #         {
        #             "dispatchRequired": false,
        #             "id": "41d6c32c-b14a-4cef-9834-36f819d1fb4b",
        #             "name": "Device #1",
        #             "factorType": "token:software",
        #             "factorProvider": "TESLA",
        #             "securityLevel": 1,
        #             "activatedAt": "2020-12-07T14:07:50.000Z",
        #             "updatedAt": "2020-12-07T06:07:49.000Z",
        #         }
        #     ]
        # }
        vprint(resp.text)

        # Can use Passcode
        if args.passcode:
            factor_id = resp.json()["data"][0]["id"]

            data = {
                "transaction_id": transaction_id,
                "factor_id": factor_id,
                "passcode": args.passcode,
            }
            resp = session.post(
                "https://auth.tesla.com/oauth2/v3/authorize/mfa/verify",
                headers=headers,
                json=data,
            )
            vprint(resp.text)
            # {
            #     "data": {
            #         "id": "63375dc0-3a11-11eb-8b23-75a3281a8aa8",
            #         "challengeId": "c7febba0-3a10-11eb-a6d9-2179cb5bc651",
            #         "factorId": "41d6c32c-b14a-4cef-9834-36f819d1fb4b",
            #         "passCode": "985203",
            #         "approved": true,
            #         "flagged": false,
            #         "valid": true,
            #         "createdAt": "2020-12-09T03:26:31.000Z",
            #         "updatedAt": "2020-12-09T03:26:31.000Z",
            #     }
            # }
            if (
                "error" in resp.text
                or not resp.json()["data"]["approved"]
                or not resp.json()["data"]["valid"]
            ):
                vprint("Invalid MFA passcode")
                sys.exit(4)

        if not args.passcode:
            vprint("MFA passcode needed")
            sys.exit(5)

        data = {"transaction_id": transaction_id}

        for attempt in range(MAX_ATTEMPTS):
            resp = session.post(
                "https://auth.tesla.com/oauth2/v3/authorize",
                headers=headers,
                params=params,
                data=data,
                allow_redirects=False,
            )
            if resp.headers.get("location"):
                vprint(f"Got location in {attempt + 1} attempt(s).")
                break
        else:
            vprint("Didn't get location in {MAX_ATTEMPTS} attempts.")
            sys.exit(3)

    # Step 3: Exchange authorization code for bearer token
    code = parse_qs(resp.headers["location"])[
        "https://auth.tesla.com/void/callback?code"
    ]
    vprint("Code -", code)

    headers = {
        "user-agent": UA,
        #"x-tesla-user-agent": X_TESLA_USER_AGENT
    }
    payload = {
        "grant_type": "authorization_code",
        "client_id": "ownerapi",
        "code_verifier": code_verifier.decode("utf-8"),
        "code": code,
        "redirect_uri": "https://auth.tesla.com/void/callback",
    }

    resp = session.post(
        "https://auth.tesla.com/oauth2/v3/token", headers=headers, json=payload
    )
    access_token = resp.json()["access_token"]
    refresh_token = resp.json()["refresh_token"]

    # Step 4: Exchange bearer token for access token
    headers["authorization"] = "bearer " + access_token
    payload = {
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "client_id": CLIENT_ID,
    }
    resp = session.post(
        "https://owner-api.teslamotors.com/oauth/token", headers=headers, json=payload
    )

    # Return tokens
    tokens = resp.json()
    tokens["refresh_token"] = refresh_token
    print(json.dumps(tokens))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("email", type=str, help="Tesla account email")
    parser.add_argument("password", type=str, help="Tesla account password")
    parser.add_argument(
        "passcode",
        type=str,
        default=None,
        nargs="?",
        help="Passcode generated by your authenticator app",
    )

    args = parser.parse_args()
    login(args)
