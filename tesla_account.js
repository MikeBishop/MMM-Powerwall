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
            await new Promise(resolve => {
                tesla.login({
                    username: username,
                    password: password,
                    mfaPassCode: mfa
                }, (e, tokens) => {
                    if( e ) {
                        this.authenticated = false;
                        this.tokens = null;
                        this.emit('error', 'login failed: ' + e.toString());
                    }
                    else {
                        processTokens(tokens);
                    }
                    resolve();
                });
            });
        }

        processTokens(tokens) {
            let body = JSON.parse(tokens.body);
            this.tokens = {
                "created_at": body.created_at,
                "expires_in": body.expires_in,
                "refresh_token": tokens.refresh_token,
                "access_token": tokens.auth_token
            }
            this.emit('login', this.tokens);
        }

        async refresh() {
            if(this.tokens === null) {
                return this.emit('error', "can't refresh without tokens");
            }
            if( this.tokensValid() > 15 ) {
                return null;
            }

            await new Promise(resolve =>
                tesla.refreshToken(this.tokens.refresh_token, (e, tokens) => {
                    if( e ) {
                        this.emit('error', 'refresh failed: ' + e.toString());
                    }
                    else {
                        this.processTokens(tokens);
                    }
                    resolve();
                })
            );
        }
    }
}
