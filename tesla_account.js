const tesla = require("teslajs");
const events = require('events');

module.exports = {
    TeslaAccount: class extends events.EventEmitter {
        constructor(tokens) {
            super();
            this.authenticated = false;
            this.tokens = tokens;
        }

        checkAuthenticated() {
            if( this.authenticated ) {
                return true;
            }

            return this.tokensValid() > 0;
        }

        tokensValid() {
            return 0 /* TODO: check validity */
        }

        async login(username, password, mfa) {
            try {
                var tokens = await tesla.loginAsync({
                    username: username,
                    password: password,
                    mfaPassCode: mfa
                })
            }
            catch (e) {
                this.authenticated = false;
                this.tokens = null;
                return this.emit('error', 'login failed: ' + e.toString());
            }
            this.tokens = JSON.parse(tokens.body);
            return this.emit('login', this.tokens);
        }

        async refresh() {
            if(this.tokens === null) {
                return this.emit('error', "can't refresh without tokens");
            }
            if( this.tokensValid() > 15 ) {
                return null;
            }

            try {
                var tokens = await tesla.refreshTokenAsync(this.tokens.refresh_token);
            }
            catch (e) {
                return this.emit('error', 'refresh failed: ' + e.toString());
            }

            this.tokens = JSON.parse(tokens.body);
            return this.emit('login', this.tokens);
        }
    }
}
