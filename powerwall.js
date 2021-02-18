/* eslint-disable camelcase */
var axios = require('axios');
const Https = require("https");
const unauthenticated_agent = new Https.Agent({
	rejectUnauthorized: false,
    keepAlive: true,
});
var toughcookie = require('tough-cookie');
var events = require('events');
const CLIENT_ID = '81527cff06843c8634fdc09e8ac0abefb46ac849f38fe1e431c2ef2106796384';

module.exports = {
    Powerwall: class extends events.EventEmitter {
        constructor(host) {
            super();
            this.urlBase = "https://" + host;
            this.jar = new toughcookie.CookieJar();
            this.http = axios.create({
                maxRedirects: 0,
                validateStatus: (status) => {
                    return (status >= 200 && status < 300) || status === 302;
                },
                httpsAgent: unauthenticated_agent,
            });
            this.authenticated = false;
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
            this.lastUpdate = 0;
            this.lastAggregate = null;
            this.lastSOE = null;
            this.lastGrid = null;
        }

        async login(password) {
            let res;
            try {
                res = await this.http.post(this.urlBase + '/api/login/Basic',
                    {
                        username: "customer",
                        password: password,
                        "force_sm_off": false
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    }
                );
            }
            catch (e) {
                this.authenticated = false;
                return this.emit('error', 'login failed: ' + e.toString());
            }
            if (res.status === 200) {
                this.authenticated = true;
                return this.emit('login');
            }
            else {
                return this.emit("error", "login failed; " + res.toString());
            }
        }

        getCookies() {
            return this.jar.serializeSync();
        }

        loadCookie(cookies) {
            this.jar = toughcookie.CookieJar.deserializeSync(cookies);
            this.jar.getCookies(this.urlBase, {}).then(cookies => {
                if( cookies && cookies.length > 0 ) {
                    // Assume loaded cookies are good without testing; we'll discover if they're not.
                    this.authenticated = true;
                }
            });
        }

        async update(interval) {
            if( this.authenticated == false ) {
                return this.emit('error', 'not authenticated');
            }

            let now = Date.now();
            if( now - this.lastUpdate < interval ) {
                this.emit('aggregates', this.lastAggregate);
                this.emit('soe', this.lastSOE);
                this.emit('grid', this.lastGrid);
                return;
            }

            try {
                var aggregate = this.http.get(this.urlBase + '/api/meters/aggregates');
                var soe = this.http.get(this.urlBase + "/api/system_status/soe");
                var grid = this.http.get(this.urlBase + "/api/system_status/grid_status");
            }
            catch (e) {
                return this.emit("error", "requests failed to initialize");
            }

            let result, success = true;
            try {
                result = await aggregate;
                this.emit("aggregates", result.data);
                this.lastAggregate = result.data;
            }
            catch (e) {
                this.emit("error", "aggregates failed: " + e.toString());
                success = false;
            }

            try {
                result = await soe;
                let adjusted = (result.data.percentage - 5) / .95;
                this.emit("soe", adjusted);
                this.lastSOE = adjusted;
            }
            catch (e) {
                this.emit("error", "soe failed: " + e.toString());
                success = false;
            }

            try {
                result = await grid;
                this.emit("grid", result.data.grid_status);
                this.lastGrid = result.data.grid_status;
            }
            catch (e) {
                this.emit("error", "grid failed: " + e.toString());
                success = false;
            }

            if( success ) {
                this.lastUpdate = now;
            }
        }
    }
}
