/* eslint-disable camelcase */
var axios = require('axios');
const Https = require("https");
const unauthenticated_agent = new Https.Agent({
    rejectUnauthorized: false,
    keepAlive: true,
});
var toughcookie = require('tough-cookie');
var events = require('events');

module.exports = {
    Powerwall: class extends events.EventEmitter {
        constructor(host) {
            super();
            this.urlBase = "https://" + host;
            this.jar = new toughcookie.CookieJar();
            this.http = axios.create({
                httpsAgent: unauthenticated_agent,
                timeout: 5000,
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
            this.lastUpdate = 0;
            this.history = {};
            this.password = null;
            this.cookieTimeout = 0;
            this.loginTask = null;
            this.delayTask = Promise.resolve();
            this.updateTask = null;
        }

        login(password) {
            let self = this;
            if (!this.loginTask || this.password != password) {
                this.loginTask = this.loginInner(password).then(
                    () => {
                        self.loginTask = null;
                        self.delayTask = new Promise(resolve => setTimeout(resolve, 30000));
                    }
                );
            }
            else {
                this.emit("debug", "Login already in progress; deferring to that attempt");
            }
            return this.loginTask;
        }

        async loginInner(password) {
            let res;
            await this.delayTask;
            try {
                this.emit("debug", "Beginning login attempt");
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
                this.password = null;
                if (e.response && e.response.status === 429) {
                    this.delayTask = new Promise(resolve => setTimeout(resolve, 30000));
                    return await this.loginInner(password);
                }
                return this.emit('error', 'login failed: ' + e.toString());
            }
            if (res.status === 200) {
                let foundCookie = false;
                if (res.headers['set-cookie'] instanceof Array) {
                    res.headers['set-cookie'].forEach(c => {
                        this.jar.setCookie(toughcookie.Cookie.parse(c), res.config.url, () => { });
                        foundCookie = true;
                    });
                }
                else {
                    this.emit("debug", "Login response Set-Cookie header is a " + typeof res.headers["set-cookie"]);
                }
                if (foundCookie) {
                    this.authenticated = true;
                    this.password = password;
                    this.cookieTimeout = Date.now() + (60 * 60 * 1000);
                    return this.emit('login');
                }
            }

            this.password = null;
            return this.emit("error", "login failed; " + JSON.stringify(res.headers));
        }

        update(interval) {
            if (!this.updateTask) {
                this.updateTask = this.updateInner(interval).then(
                    () => {
                        this.updateTask = null;
                    }
                );
            }
            else {
                this.emit("debug", "Update already in progress; deferring to that attempt");
            }
            return this.updateTask;
        }

        async updateInner(interval) {
            if (!this.authenticated && this.password) {
                await this.login(this.password);
            }
            if (!this.authenticated) {
                return this.emit('error', 'not authenticated');
            }

            let now = Date.now();
            if (now > this.cookieTimeout && this.password) {
                this.login(this.password)
            }

            const requestTypes = [
                ["aggregates", this.urlBase + '/api/meters/aggregates', result => result.data],
                ["soe", this.urlBase + "/api/system_status/soe", result => (result.data.percentage - 5) / .95],
                ["grid", this.urlBase + "/api/system_status/grid_status", result => result.data.grid_status],
                ["operation", this.urlBase + "/api/operation", result => result.data]
            ];

            if (now - this.lastUpdate < interval) {
                this.emit("debug", "Using cached data");
                for (const [name, url, mapping] of requestTypes) {
                    this.emit(name, this.history[name]);
                }
                return;
            }

            let requests = {};
            for (const [name, url, mapping] of requestTypes) {
                try {
                    this.emit("debug", "Requesting " + name);
                    requests[name] = this.http.get(url);
                }
                catch (e) {
                    return this.emit("error", "requests failed to initialize");
                }
            }

            let needAuth = false;
            for (const [name, url, mapping] of requestTypes) {
                try {
                    let result = await requests[name];
                    let data = mapping(result);
                    this.emit(name, data);
                    this.history[name] = data;
                }
                catch (e) {
                    if (e.response && [401, 403].includes(e.response.status) && this.password) {
                        needAuth = true;
                        this.authenticated = false;
                    }
                    else {
                        this.emit("error", name + " failed: " + e.toString());
                    }
                }
            }

            if (needAuth) {
                this.emit("debug", "Tokens rejected; need to log in again");
                await this.login(this.password);
                await this.updateInner(interval);
            }
        }
    }
}
