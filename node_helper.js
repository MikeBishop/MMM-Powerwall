/* Magic Mirror
 * Node Helper: MMM-Powerwall
 *
 * By Mike Bishop
 * MIT Licensed.
 */

var NodeHelper = require("node_helper");
var fs = require("fs").promises;
var Https = require("https");
var unauthenticated_agent = new Https.Agent({
	rejectUnauthorized: false,
});
var fetch = require("node-fetch");
if (!globalThis.fetch) {
	globalThis.fetch = fetch;
}


module.exports = NodeHelper.create({

	start: function() {
		this.powerwallEndpoints = {};
		this.twcManagerEndpoints = {};
		this.teslaApiAccounts = {};
		this.filenames = [];
		this.lastUpdate = 0;
	},

	// Override socketNotificationReceived method.

	/* socketNotificationReceived(notification, payload)
	 * This method is called when a socket notification arrives.
	 *
	 * argument notification string - The identifier of the noitication.
	 * argument payload mixed - The payload of the notification.
	 */
	socketNotificationReceived: async function(notification, payload) {
		
		let powerwallEndpoints = this.powerwallEndpoints;
		let twcManagerEndpoints = this.twcManagerEndpoints;
		var self = this;
		if (notification === "MMM-Powerwall-Configure-Powerwall") {
			let updateInterval = payload.updateInterval;
			let powerwallIP = payload.powerwallIP;
			let powerwallPassword = payload.powerwallPassword;

			if( powerwallEndpoints[powerwallIP] ) {
				powerwallEndpoints[powerwallIP].password = powerwallPassword;
				powerwallEndpoints[powerwallIP].updateInterval = Math.min(
					powerwallEndpoints[powerwallIP].updateInterval,
					updateInterval
				);
			}
			else {
				// First configuration for this Powerwall; update immediately
				powerwallEndpoints[powerwallIP] = {
					password: powerwallPassword,
					aggregates: null,
					lastUpdate: 0,
					updateInterval: updateInterval
				};
			}
		}
		else if (notification === "MMM-Powerwall-Configure-TWCManager") {
			let ip = payload.twcManagerIP;
			if( twcManagerEndpoints[ip] ) {
				twcManagerEndpoints[ip].port = payload.port;
			}
			else {
				twcManagerEndpoints[ip] = {
					updateInterval: payload.updateInterval,
					status: null,
					port: payload.port,
					lastUpdate: 0
				}
			}
		}
		else if (notification === "MMM-Powerwall-Configure-TeslaAPI") {
			let username = payload.teslaAPIUsername;
			let password = payload.teslaAPIPassword;
			let filename = payload.tokenFile;

			if( !this.filenames.includes(filename) ) {
				this.filenames.push(filename)
			}

			if( !this.teslaApiAccounts[username] ) {
				try {
					let fileContent = JSON.parse(
						await fs.readFile(filename)
					);
					this.teslaApiAccounts =  {
						...this.teslaApiAccounts,
						...fileContent
					};
					console.log("Read Tesla API tokens from file");
					await self.doTeslaApiTokenUpdate();
				}
				catch(e) {
					if( password ) {
						self.doTeslaApiLogin(username,password, filename);
					}
					else {
						console.log("Missing both Tesla password and access tokens");
					}
				}
			}
		}
		else if (notification === "MMM-Powerwall-UpdateLocal") {
			let ip = payload.powerwallIP;
			if( powerwallEndpoints[ip] ) {
				if( powerwallEndpoints[ip].lastUpdate + powerwallEndpoints[ip].updateInterval < Date.now() ) {
					self.updatePowerwall(ip, powerwallEndpoints[ip].password);
				}
				else {
					if (powerwallEndpoints[ip].aggregates) {
						this.sendSocketNotification("MMM-Powerwall-Aggregates", {
							ip: ip,
							aggregates: powerwallEndpoints[ip].aggregates
						});
					}	
				}
			}
			ip = payload.twcManagerIP
			if( ip && twcManagerEndpoints[ip] ) {
				if( twcManagerEndpoints[ip].lastUpdate + twcManagerEndpoints[ip].updateInterval < Date.now() ) {
					self.updateTWCManager(ip, twcManagerEndpoints[ip].port)
				}
				else {
					this.sendSocketNotification("MMM-Powerwall-ChargeStatus", {
						ip: ip,
						status: twcManagerEndpoints[ip].status
					});
				}
			}
		}
	},

	updatePowerwall: async function(powerwallIP, powerwallPassword) {
		this.powerwallEndpoints[powerwallIP].lastUpdate = Date.now();
		let url = "https://" + powerwallIP + "/api/meters/aggregates";
		let result = await fetch(url, {agent: unauthenticated_agent});

		if( result.ok ) {
			var aggregates = await result.json();
			this.powerwallEndpoints[powerwallIP].aggregates = aggregates;
			// Send notification
			this.sendSocketNotification("MMM-Powerwall-Aggregates", {
				ip: powerwallIP,
				aggregates: aggregates
			});
		}
		else {
			console.log("Powerwall fetch failed")
		}
	},

	updateTWCManager: async function(twcManagerIP) {
		this.twcManagerEndpoints[twcManagerIP].lastUpdate = Date.now();
		let port = this.twcManagerEndpoints[twcManagerIP].port;
		let url = "http://" + twcManagerIP + ":" + port + "/api/getStatus";
		let result = await fetch(url);

		if( result.ok ) {
			var status = await result.json();
			this.twcManagerEndpoints[twcManagerIP].status = status;
			// Send notification
			this.sendSocketNotification("MMM-Powerwall-ChargeStatus", {
				ip: twcManagerIP,
				status: status
			});
		}
		else {
			console.log("TWCManager fetch failed")
		}
	},

	doTeslaApiLogin: async function(username, password, filename) {
		url = "https://owner-api.teslamotors.com/oauth/token";
		let result = await fetch(url, {
			method: "POST",
			body: JSON.stringify({
				email: username,
				password: password,
				grant_type: "password",
				client_secret: "c7257eb71a564034f9419ee651c7d0e5f7aa6bfbd18bafb5c5c033b093bb2fa3",
				client_id: "81527cff06843c8634fdc09e8ac0abefb46ac849f38fe1e431c2ef2106796384"
			}),
			headers: {
				"content-type": "application/json"
			}
		});

		if( result.ok ) {
			console.log("Got Tesla API tokens")
			this.teslaApiAccounts[username] = await result.json();
			await fs.writeFile(filename, JSON.stringify(this.teslaApiAccounts));
		}
	},

	doTeslaApiTokenUpdate: async function() {
		let anyUpdates = false;

		if( new Date() < this.lastUpdate + 3600 ) {
			// Only check for expired tokens hourly
			return;
		}

		// We don't actually track which tokens came from which file.
		// If there are multiple, write all to all.
		for( const username in this.teslaApiAccounts ) {
			let tokens = this.teslaApiAccounts[username];
			if( new Date() > tokens.created_at + (tokens.expires_in / 3)) {
				url = "https://owner-api.teslamotors.com/oauth/token";
				let result = await fetch(url, {
					method: "POST",
					body: JSON.stringify({
						email: username,
						grant_type: "refresh_token",
						client_secret: "c7257eb71a564034f9419ee651c7d0e5f7aa6bfbd18bafb5c5c033b093bb2fa3",
						client_id: "81527cff06843c8634fdc09e8ac0abefb46ac849f38fe1e431c2ef2106796384",
						refresh_token: tokens.refresh_token
					}),
					headers: {
						"content-type": "application/json",
					}
				});
		
				if( result.ok ) {
					console.log("Updated Tesla API token");
					anyUpdates = true;
					this.teslaApiAccounts[username] = await result.json();
				}
		
			}
		}

		if( anyUpdates ) {
			for( const filename of this.filenames ) {
				await fs.writeFile(filename, JSON.stringify(this.teslaApiAccounts));
			}
		}
	}
});
