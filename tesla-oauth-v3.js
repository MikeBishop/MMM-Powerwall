/* eslint-disable camelcase */
var axios = require('axios').default;
const Https = require("https");
const keepalive_agent = new Https.Agent({
    keepAlive: true,
});
var crypto = require('crypto');
var qs = require('querystring');
var urlsafebase64 = require('urlsafe-base64');
var cryptoRandomString = require('crypto-random-string');
var toughcookie = require('tough-cookie');
var events = require('events');
const CLIENT_ID = '81527cff06843c8634fdc09e8ac0abefb46ac849f38fe1e431c2ef2106796384';

module.exports = {
    Authenticator: class extends events.EventEmitter {
        constructor() {
            super();
            this.jar = new toughcookie.CookieJar();
            this.http = axios.create({
                maxRedirects: 0,
                validateStatus: (status) => {
                    return (status >= 200 && status < 300) || status === 302;
                },
                httpsAgent: keepalive_agent,
                timeout: 5000,
                headers: {
                    "User-Agent": "hackney/1.17.0"
                }
            });
            this.http.interceptors.request.use(config => {
                this.jar.getCookies(config.url, {}, (err, cookies) => {
                    if (err)
                        return;
                    config.headers.cookie = cookies.join('; ');
                });
                return config;
            });
            this.http.interceptors.response.use(response => {
                if (response.headers['set-cookie'] instanceof Array) {
                    response.headers['set-cookie'].forEach(c => {
                        this.jar.setCookie(toughcookie.Cookie.parse(c), response.config.url, () => { });
                    });
                }
                return response;
            });
        }
        async login(username, password, mfaCode) {
            var _a;
            if (!this.parameters)
                this.generateParameters();
            let body;
            try {
                const hidden = await this.scrapeOauthForm();
                body = {
                    _csrf: hidden.csrf,
                    _phase: hidden.phase,
                    _process: hidden.process,
                    transaction_id: hidden.transactionId,
                    cancel: hidden.cancel,
                    identity: username,
                    credential: password
                };
            }
            catch (e) {
                return this.emit('error', 'scraping oauth form failed');
            }
            let res;
            try {
                res = await this.http.post(this.oauth2url, qs.stringify(body), {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                });
            }
            catch (e) {
                return this.emit('error', 'invalid credentials');
            }
            if (res.status === 200 && ((_a = res.data) === null || _a === void 0 ? void 0 : _a.includes('/mfa/verify'))) {
                if (!mfaCode)
                    return this.emit('mfa');
                else
                    return await this.mfaCode(mfaCode);
            }
            else {
                this.parseCallback(res.headers.location);
                return await this.exchangeCode();
            }
        }
        async mfaCode(mfaCode) {
            var _a, _b, _c, _d;
            try {
                const url = `https://auth.tesla.com/oauth2/v3/authorize/mfa/factors?transaction_id=${this.transactionId}`;
                var res1 = await this.http.get(url);
            }
            catch (e) {
                return this.emit("error", e.toString());
            }
            const factorId = res1.data.data[0].id;
            const mfaPayload = {
                transaction_id: this.transactionId, factor_id: factorId, passcode: mfaCode
            };
            try {
                const res = await this.http.post('https://auth.tesla.com/oauth2/v3/authorize/mfa/verify', mfaPayload);
                if (!((_a = res === null || res === void 0 ? void 0 : res.data) === null || _a === void 0 ? void 0 : _a.data.valid))
                    return this.emit('error', 'invalid mfaCode');
            }
            catch (e) {
                return this.emit('error', (_d = (_c = (_b = e === null || e === void 0 ? void 0 : e.response) === null || _b === void 0 ? void 0 : _b.data) === null || _c === void 0 ? void 0 : _c.error) === null || _d === void 0 ? void 0 : _d.code);
            }
            const res2 = await this.http.post(this.oauth2url, { transaction_id: this.transactionId });
            this.parseCallback(res2.headers.location);
            return await this.exchangeCode();
        }
        async refresh(refreshToken) {
            const payload = {
                grant_type: 'refresh_token',
                client_id: 'ownerapi',
                refresh_token: refreshToken,
                scope: 'openid email offline_access'
            };
            try {
                var res = await this.http.post('https://auth.tesla.com/oauth2/v3/token', payload);
                var ownerApi = await this.ownerApiToken(res.data.access_token);
            }
            catch(e) {
                return this.emit("error", e.toString());
            }
            const tokens = {
                auth: res.data,
                ownerApi
            };
            this.emit('ready', tokens);
            return tokens;
        }
        async ownerApiToken(accessToken) {
            const payload = {
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                client_id: CLIENT_ID
            };
            const res = await this.http.post('https://owner-api.teslamotors.com/oauth/token', payload, {
                headers: {
                    Authorization: `Bearer ${accessToken}`
                }
            });
            return res.data;
        }
        async exchangeCode() {
            const payload = {
                grant_type: 'authorization_code',
                client_id: 'ownerapi',
                code_verifier: this.codeVerifier,
                code: this.code,
                redirect_uri: 'https://auth.tesla.com/void/callback'
            };
            const res = await this.http.post('https://auth.tesla.com/oauth2/v3/token', payload);
            const ownerApi = await this.ownerApiToken(res.data.access_token);
            const tokens = {
                auth: res.data,
                ownerApi
            };
            this.emit('ready', tokens);
            return tokens;
        }
        generateParameters() {
            this.codeVerifier = urlsafebase64.encode(Buffer.from(cryptoRandomString({ length: 86 }), 'utf-8')).trim();
            const hash = crypto.createHash('sha256').update(this.codeVerifier).digest('hex');
            const codeChallenge = urlsafebase64.encode(Buffer.from(hash, 'utf8')).trim();
            const state = urlsafebase64.encode(crypto.randomBytes(16));
            this.parameters = {
                client_id: 'ownerapi',
                code_challenge: codeChallenge,
                code_challenge_method: 'S256',
                redirect_uri: encodeURIComponent('https://auth.tesla.com/void/callback'),
                response_type: 'code',
                scope: encodeURIComponent('openid email offline_access'),
                state: state
            };
        }
        async scrapeOauthForm() {
            const res = await this.http.get(this.oauth2url);
            const match = (data, regex) => {
                const m = data.match(regex);
                return m ? m[1] : '';
            };
            const csrf = match(res.data, /name="_csrf".+value="([^"]+)"/);
            const transactionId = match(res.data, /name="transaction_id".+value="([^"]+)"/);
            const phase = match(res.data, /name="_phase".+value="([^"]+)"/);
            const process = match(res.data, /name="_process".+value="([^"]+)"/);
            const cancel = match(res.data, /name="cancel".+value="([^"]+)"/);
            this.transactionId = transactionId;
            return { csrf, transactionId, phase, process, cancel };
        }
        parseCallback(location) {
            const url = new URL(location);
            this.code = url.searchParams.get('code');
        }
        get oauth2url() {
            return `https://auth.tesla.com/oauth2/v3/authorize?client_id=${this.parameters.client_id}&code_challenge=${this.parameters.code_challenge}&code_challenge_method=${this.parameters.code_challenge_method}&redirect_uri=${this.parameters.redirect_uri}&response_type=${this.parameters.response_type}&scope=${this.parameters.scope}&state=${this.parameters.state}`;
        }
    }
}
