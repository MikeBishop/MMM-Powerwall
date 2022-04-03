#!/bin/env python3

import argparse
import os
import json
import sys
import requests

MAX_ATTEMPTS = 7
CLIENT_ID = "81527cff06843c8634fdc09e8ac0abefb46ac849f38fe1e431c2ef2106796384"
UA = "PostmanRuntime/7.26.10" #"Mozilla/5.0 (Linux; Android 10; Pixel 3 Build/QQ2A.200305.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/85.0.4183.81 Mobile Safari/537.36"
X_TESLA_USER_AGENT = "TeslaApp/3.10.9-433/adff2e065/android/10"

def vprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)

def refresh(args):
    token = args.token
    session = requests.Session()

    headers = {"user-agent": UA} #"x-tesla-user-agent": X_TESLA_USER_AGENT}
    payload = {
        "grant_type": 'refresh_token',
        "client_id": 'ownerapi',
        "refresh_token": token,
        "scope": 'openid email offline_access'
    }

    resp = session.post("https://auth.tesla.com/oauth2/v3/token", headers=headers, json=payload)

    if not resp.ok:
        vprint("Refresh failed")
        sys.exit(1)    

    # Return tokens
    tokens = resp.json()
    print(json.dumps(tokens))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("token", type=str, help="Tesla refresh token")

    args = parser.parse_args()
    refresh(args)
