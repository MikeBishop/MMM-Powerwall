#!/bin/env python3

import argparse
import os
import json
import sys
import requests

MAX_ATTEMPTS = 7
UA = "PostmanRuntime/7.26.10" #"Mozilla/5.0 (Linux; Android 10; Pixel 3 Build/QQ2A.200305.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/85.0.4183.81 Mobile Safari/537.36"

def vprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)

def refresh(args):
    token = args.token
    session = requests.Session()

    headers = {"user-agent": UA} #"x-tesla-user-agent": X_TESLA_USER_AGENT}
    payload = {
        "grant_type": 'refresh_token',
        "client_id": args.id,
        "refresh_token": token
    }

    resp = session.post("https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token", headers=headers, json=payload)

    if not resp.ok:
        vprint("Refresh failed")
        sys.exit(1)    

    # Return tokens
    tokens = resp.json()
    print(json.dumps(tokens))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("id", type=str, help="Fleet API client ID")
    parser.add_argument("token", type=str, help="Tesla refresh token")
    args = parser.parse_args()
    refresh(args)
