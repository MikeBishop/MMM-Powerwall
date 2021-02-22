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
            this.history = {};
            this.password = null;
            this.cookieTimeout = 0;
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
                this.password = password;
                this.cookieTimeout = Date.now() + (60 * 60 * 1000);
                return this.emit('login');
            }
            else {
                this.password = null;
                return this.emit("error", "login failed; " + res.toString());
            }
        }

        async update(interval) {
            if( this.authenticated == false ) {
                return this.emit('error', 'not authenticated');
            }

            let now = Date.now();
            if( now > this.cookieTimeout && this.password ) {
                this.login(this.password)
            }

            const requestTypes = [
                ["aggregates", this.urlBase + '/api/meters/aggregates', result => result.data],
                ["soe", this.urlBase + "/api/system_status/soe", result => (result.data.percentage - 5) / .95],
                ["grid", this.urlBase + "/api/system_status/grid_status", result => result.data.grid_status]
            ];

            if( now - this.lastUpdate < interval ) {
                for( const [name, url, mapping] of requestTypes ) {
                    this.emit(name, this.history[name]);
                }
                return;
            }

            let requests = {};
            for( const [name, url, mapping] of requestTypes ) {
                try {
                    requests[name] = this.http.get(url);
                }
                catch (e) {
                    return this.emit("error", "requests failed to initialize");
                }
            }

            let needAuth = false;
            for( const [name, url, mapping] of requestTypes) {
                try {
                    let result = await requests[name];
                    let data = mapping(result);
                    this.emit(name, data);
                    this.history[name] = data;
                }
                catch (e) {
                    if( e.response != undefined && e.response.status == 401 && this.password ) {
                        needAuth = true;
                    }
                    else {
                        this.emit("error", "aggregates failed: " + e.toString());
                        success = false;
                    }
                }
            }

            if( needAuth ) {
                this.login(this.password);
                this.update(interval);
            }
        }
    }
}
